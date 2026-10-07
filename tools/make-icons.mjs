#!/usr/bin/env node
// 生成 PWA 图标：public/icons/*.png
//
// 图标不是设计稿，是被安装程序硬约束的资产：Chrome 要求 192 与 512、Apple 要求
// 180×180 且不透明，Android 启动器会把图标裁成圆/方/squircle，所以 maskable 版
// 必须自带满幅底色并把图形压进中央 80% 安全区。
//
// 复用 public/favicon.svg 的吊灯轮廓 + 站内构成主义配色（纸 #f5f0ea / 墨 #1b1b1b /
// 红旗红 #a8271b），由 sharp（Astro 的可选依赖，已在 node_modules 里）光栅化。
// 改了配色或轮廓之后重跑一次即可：node tools/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(repoRoot, 'public', 'icons');

const PAPER = '#f5f0ea';
const INK = '#1b1b1b';
const ACCENT = '#a8271b';

// Outline copied from public/favicon.svg.
const GLYPH =
  'M50.4 78.5a75.1 75.1 0 0 0-28.5 6.9l24.2-65.7c.7-2 1.9-3.2 3.4-3.2h29c1.5 0 2.7 1.2 3.4 3.2l24.2 65.7s-11.6-7-28.5-7L67 45.5c-.4-1.7-1.6-2.8-2.9-2.8-1.3 0-2.5 1.1-2.9 2.7L50.4 78.5Zm-1.1 28.2Zm-4.2-20.2c-2 6.6-.6 15.8 4.2 20.2a17.5 17.5 0 0 1 .2-.7 5.5 5.5 0 0 1 5.7-4.5c2.8.1 4.3 1.5 4.7 4.7.2 1.1.2 2.3.2 3.5v.4c0 2.7.7 5.2 2.2 7.4a13 13 0 0 0 5.7 4.9v-.3l-.2-.3c-1.8-5.6-.5-9.5 4.4-12.8l1.5-1a73 73 0 0 0 3.2-2.2 16 16 0 0 0 6.8-11.4c.3-2 .1-4-.6-6l-.8.6-1.6 1a37 37 0 0 1-22.4 2.7c-5-.7-9.7-2-13.2-6.2Z';

/**
 * `scale` shrinks the glyph, `bar` draws the red base rule. Maskable passes a
 * smaller scale because the launcher crops the outer 20%.
 */
function iconSvg({ scale, bar }) {
  const offset = 64 - 64 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 128 128">
  <rect width="128" height="128" fill="${PAPER}"/>
  <path d="${GLYPH}" fill="${INK}" transform="translate(${offset} ${offset}) scale(${scale})"/>
  ${bar ? `<rect x="18" y="118" width="92" height="5" fill="${ACCENT}"/>` : ''}
</svg>`;
}

const TARGETS = [
  { name: 'icon-192.png', size: 192, scale: 0.86, bar: true },
  { name: 'icon-512.png', size: 512, scale: 0.86, bar: true },
  { name: 'maskable-512.png', size: 512, scale: 0.62, bar: true },
  { name: 'apple-touch-icon.png', size: 180, scale: 0.8, bar: false },
];

mkdirSync(outDir, { recursive: true });

for (const target of TARGETS) {
  const png = await sharp(Buffer.from(iconSvg(target)))
    .resize(target.size, target.size, { fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(join(outDir, target.name), png);
  console.log(`public/icons/${target.name}  ${target.size}×${target.size}  ${(png.length / 1024).toFixed(1)} KB`);
}
