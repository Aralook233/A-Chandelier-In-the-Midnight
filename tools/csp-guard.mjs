#!/usr/bin/env node
// Build-time CSP guard.
//
// The site ships a header-based CSP (`public/_headers`) with `script-src 'self'`
// and `style-src 'self'` — no 'unsafe-inline', no hashes, no nonces. That is the
// strictest option this stack allows: a static build cannot mint per-request
// nonces, and there is nothing to hash because Astro bundles every page script
// and stylesheet into /_astro. This script is what keeps that promise: if a page
// ever regains inline markup, CSP breaks it silently in production, so fail the
// build here instead.
//
// Usage: node tools/csp-guard.mjs [distDir]

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const distDir = process.argv[2] || 'dist';

if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
  console.error(`[csp-guard] 找不到构建目录 ${distDir}/，请先运行 npm run build。`);
  process.exit(1);
}

const CHECKS = [
  { name: '内联 <script>（无 src）', re: /<script(?![^>]*\ssrc=)[^>]*>/gi },
  { name: '内联 <style>', re: /<style[^>]*>/gi },
  { name: 'style= 属性', re: /\sstyle\s*=\s*["'][^"']*["']/gi },
  { name: 'on* 事件属性', re: /\son[a-z-]+\s*=\s*["']/gi },
  { name: 'javascript: / data: URL', re: /(?:href|src)\s*=\s*["']\s*(?:javascript|data)\s*:/gi },
  { name: '<base href>', re: /<base\s[^>]*href=/gi },
  { name: '跨域 script/link（绝对 URL）', re: /<(?:script|link)[^>]*\s(?:src|href)\s*=\s*["']https?:\/\//gi },
];

function htmlFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...htmlFiles(path));
    else if (entry.name.endsWith('.html')) found.push(path);
  }
  return found;
}

function lineOf(html, index) {
  return html.slice(0, index).split('\n').length;
}

const violations = [];
const files = htmlFiles(distDir);

for (const file of files) {
  const html = readFileSync(file, 'utf8');
  for (const check of CHECKS) {
    check.re.lastIndex = 0;
    let match;
    while ((match = check.re.exec(html)) !== null) {
      violations.push({
        file: relative(distDir, file).replace(/\\/g, '/'),
        line: lineOf(html, match.index),
        check: check.name,
        snippet: html.slice(match.index, match.index + 120).replace(/\s+/g, ' ').trim(),
      });
    }
  }
}

const headersPath = join(distDir, '_headers');
const headerProblems = [];
if (!existsSync(headersPath)) {
  headerProblems.push('dist/_headers 缺失：CSP 与所有安全响应头都不会生效。');
} else {
  const headers = readFileSync(headersPath, 'utf8');
  const cspLine = headers.split('\n').find((line) => /^\s*Content-Security-Policy:/i.test(line));
  if (!cspLine) {
    headerProblems.push('_headers 中没有 Content-Security-Policy 行。');
  } else {
    for (const directive of ["script-src 'self'", "style-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'"]) {
      if (!cspLine.includes(directive)) headerProblems.push(`CSP 缺少 ${directive}。`);
    }
    for (const forbidden of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "'strict-dynamic'"]) {
      if (cspLine.includes(forbidden)) headerProblems.push(`CSP 含 ${forbidden}：本文件的立场是完全不需要内联授权。`);
    }
  }
}

if (violations.length === 0 && headerProblems.length === 0) {
  console.log(`[csp-guard] 通过：${files.length} 个 HTML 页面零内联脚本/样式，CSP 保持 script-src/style-src 'self'。`);
  process.exit(0);
}

for (const problem of headerProblems) console.error(`[csp-guard] _headers: ${problem}`);
for (const item of violations) {
  console.error(`[csp-guard] ${item.file}:${item.line} — ${item.check} — ${item.snippet}`);
}

console.error(
  `\n[csp-guard] 失败：${violations.length} 处内联内容 / ${headerProblems.length} 处头配置问题。\n` +
    '两种修法：① 把这段内容改成外部文件或 <script> 的非内联写法（推荐，CSP 无需放宽）；' +
    "② 确实必须内联时，改为对该内容计算 sha256 并写进 CSP —— 但静态构建里没有 nonce 可用，且每次改动都要重新计算，属于额外维护成本。",
);
process.exit(1);
