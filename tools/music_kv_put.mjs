// 把 music-stage 里的音频按 4 MiB 切片写进三个 KV namespace，供 /track/<id> 读取。
//
// 分片大小、分流函数、key 形状全部从 functions/track/[id].js 里 import，所以这个脚本
// 和线上路由不可能算歪；改了那边不用记得改这里。
//
// 凭证只从环境变量读，别写进任何文件：
//   PowerShell:
//     $env:CF_ACCOUNT_ID = '...'   # 控制台右上角头像下面
//     $env:CF_KV_TOKEN   = '...'   # My Profile → API Tokens，权限只给 KV / Edit
//     $env:CF_KV_A = '...'         # 三个 namespace 的 ID（KV 页面 → 点进去 → Details）
//     $env:CF_KV_B = '...'
//     $env:CF_KV_C = '...'
//   然后：
//     node tools/music_kv_put.mjs --stage F:\BilibiliCache\music-stage --dry-run
//     node tools/music_kv_put.mjs --stage F:\BilibiliCache\music-stage
//
// 断点续传：开跑前列一遍每个 namespace 已有的 key，已存在的跳过，所以中途断了直接重跑
// 同一条命令。KV 免费档每天 1000 次写，本库约 886 个 key，一趟够；超了就自动只写前
// 1000 个，第二天再跑同一条命令接着传。

import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PART_SIZE, partKey, shardOf } from '../functions/track/[id].js';
import { musicTracks } from '../src/data/music.mjs';

const API = 'https://api.cloudflare.com/client/v4';
const WRITE_BUDGET = 1000; // KV 免费档每天的写次数
const GiB = 1024 ** 3;
const CONCURRENCY = 3;

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : true;
}

function need(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`缺少环境变量 ${name}（脚本头部注释里写了它从哪来）。`);
    process.exit(2);
  }
  return value;
}

function die(message) {
  console.error(message);
  process.exit(2);
}

const stage = String(arg('stage', 'F:\\BilibiliCache\\music-stage'));
const dryRun = Boolean(arg('dry-run'));
const filter = typeof arg('only') === 'string' ? String(arg('only')) : null;
const budget = Math.min(Number(arg('limit', WRITE_BUDGET)) || WRITE_BUDGET, WRITE_BUDGET);

// ---------------------------------------------------------------- 任务表

const jobs = [];
const problems = [];
for (const track of musicTracks) {
  if (filter && !track.key.includes(filter) && !track.id.includes(filter)) continue;
  const bytes = Number(track.bytes);
  if (!(bytes > 0)) {
    problems.push(`${track.id} 清单里没有 bytes：${track.key}`);
    continue;
  }
  const binding = shardOf(track.id); // MUSIC_A / MUSIC_B / MUSIC_C
  const parts = Math.ceil(bytes / PART_SIZE);
  for (let part = 0; part < parts; part += 1) {
    const position = part * PART_SIZE;
    jobs.push({
      key: partKey(track.key, part),
      binding,
      file: path.join(stage, ...track.key.split('/')),
      position,
      length: Math.min(PART_SIZE, bytes - position),
    });
  }
}

if (!jobs.length) {
  console.error(`一条都没匹配上。检查 --stage（当前 ${stage}）与 --only。`);
  process.exit(2);
}

const shards = new Map();
for (const job of jobs) {
  const bucket = shards.get(job.binding) || { binding: job.binding, keys: 0, bytes: 0 };
  bucket.keys += 1;
  bucket.bytes += job.length;
  shards.set(job.binding, bucket);
}

console.log(`暂存目录 ${stage}`);
console.log(`待写 ${jobs.length} 个 key，共 ${(jobs.reduce((a, j) => a + j.length, 0) / GiB).toFixed(3)} GiB，分片 ${PART_SIZE / 1048576} MiB`);
for (const bucket of shards.values()) {
  const share = bucket.bytes / GiB;
  console.log(`  ${bucket.binding}  ${bucket.keys} 个 key  ${share.toFixed(2)} GiB / 1 GiB${share > 0.95 ? '   ← 快满了' : ''}`);
}
if (problems.length) console.log(`问题 ${problems.length} 条：\n  ${problems.slice(0, 10).join('\n  ')}`);

if (dryRun) {
  console.log('\n--dry-run：什么都没读也没写。');
  process.exit(0);
}

const token = need('CF_KV_TOKEN');
const account = need('CF_ACCOUNT_ID');
for (const bucket of shards.values()) bucket.namespaceId = need(`CF_KV_${bucket.binding.slice(-1)}`);

// ---------------------------------------------------------------- API

async function call(pathname, init = {}, attempts = 4) {
  let response;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      response = await fetch(`${API}${pathname}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) },
      });
    } catch (error) {
      if (attempt === attempts - 1) throw Object.assign(new Error(`网络失败：${error.message}`), { retry: true });
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1500));
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      const wait = Number(response.headers.get('retry-after')) * 1000 || 2 ** attempt * 1500;
      console.log(`  HTTP ${response.status}，${Math.round(wait / 1000)}s 后重试`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) {
      const detail = (body.errors || []).map((e) => `${e.code}: ${e.message}`).join('；') || `HTTP ${response.status}`;
      throw Object.assign(new Error(detail), { fatal: response.status >= 400 && response.status < 500 });
    }
    return body; // 分页信息在 result 外面（result_info / result.cursors），不能只回 result
  }
  throw Object.assign(new Error(`重试 ${attempts} 次仍失败`), { retry: true });
}

/**
 * 列表接口有两种历史形状：result 直接是数组（配 result_info 分页），或 result 是
 * {keys, list_complete, cursors}（配游标分页）。2026-10-17 实测这个账号回的是前者，
 * 所以两种都认——只按一种写，下次换形状就是整批崩。
 */
function keyList(body) {
  const result = body.result;
  const list = Array.isArray(result) ? result : (result?.keys || []);
  return { names: list.map((entry) => (typeof entry === 'string' ? entry : entry.name)), result };
}

/**
 * 先确认账号和 token 认得、三个 namespace ID 真属于这个账号。不先问一句的话，编码探测
 * 会把「账号 ID 写错」报成「token 权限不够」，把人往错的方向引。
 */
async function verifyCredentials() {
  let body;
  try {
    body = await call(`/accounts/${account}/storage/kv/namespaces?per_page=100`);
  } catch (error) {
    die(`连不上 KV：${error.message}\n确认 CF_ACCOUNT_ID（控制台右上角头像下面能看到）和 CF_KV_TOKEN 是否有效。`);
  }
  const listed = Array.isArray(body.result) ? body.result : (body.result?.keys || body.namespaces || []);
  const mine = new Set(listed.map((ns) => ns.id));
  for (const bucket of shards.values()) {
    if (!mine.has(bucket.namespaceId)) {
      die(`CF_KV_${bucket.binding.slice(-1)} = ${bucket.namespaceId} 不在这个账号的 namespace 里。\n这个账号下有：${[...mine].join(', ') || '（一个也没有，先去 Storage & Databases → KV 建三个）'}`);
    }
  }
  console.log(`凭证可用，账号下有 ${mine.size} 个 KV namespace，本次用到 ${shards.size} 个。`);
}

/**
 * key 里带斜杠，而 API 路径里 {key} 是最后一段。到底是把斜杠写成 %2F 还是留明文，
 * 各家网关的处理并不一致，猜错就是整批失败。所以拿一个一次性 key 两种都试，
 * 认掉能用的那种再开跑。
 */
async function pickEncoding() {
  const namespaceId = [...shards.values()][0].namespaceId;
  const probe = `_kv_put_probe/${Date.now()}`;
  const failures = [];
  for (const encode of [(key) => encodeURIComponent(key), (key) => key.split('/').map(encodeURIComponent).join('/')]) {
    const pathSegment = encode(probe);
    const label = pathSegment.includes('%2F') ? '%2F' : '明文斜杠';
    try {
      await call(`/accounts/${account}/storage/kv/namespaces/${namespaceId}/values/${pathSegment}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('probe'),
      });
      await call(`/accounts/${account}/storage/kv/namespaces/${namespaceId}/values/${pathSegment}`, { method: 'DELETE' });
      console.log(`key 编码：${label}`);
      return encode;
    } catch (error) {
      failures.push(`${label}：${error.message}`);
    }
  }
  die(`两种 key 编码都没写进去：\n  ${failures.join('\n  ')}`);
}

/** 列出 namespace 已有的 key，用于断点续传。 */
async function existingKeys(bucket) {
  const found = new Set();
  let cursor;
  let page = 1;
  for (;;) {
    const query = new URLSearchParams({ per_page: '1000', limit: '1000' });
    if (cursor) query.set('cursor', cursor);
    else query.set('page', String(page));
    const body = await call(`/accounts/${account}/storage/kv/namespaces/${bucket.namespaceId}/keys?${query}`);
    const { names, result } = keyList(body);
    for (const name of names) found.add(name);
    cursor = result?.cursors?.by;
    const total = Number(body.result_info?.total_count ?? names.length);
    if (!names.length || (!cursor && found.size >= total)) break;
    page += 1;
  }
  bucket.present = found;
}

async function put(encode, job) {
  const handle = await open(job.file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(job.length);
    const { bytesRead } = await handle.read(buffer, 0, job.length, job.position);
    if (bytesRead !== job.length) {
      throw Object.assign(new Error(`文件比清单短：${job.file} 要 ${job.length} 只读到 ${bytesRead}`), { fatal: true });
    }
    await call(`/accounts/${account}/storage/kv/namespaces/${job.namespaceId}/values/${encode(job.key)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: buffer,
    });
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------- 先验凭证与体积

await verifyCredentials();

// 宁可现在报错，也不要写完 300 个之后才发现暂存树和清单不是同一批。
const sizes = new Map();
for (const job of jobs) {
  const known = sizes.get(job.file);
  if (known !== undefined) continue;
  try {
    sizes.set(job.file, (await stat(job.file)).size);
  } catch {
    console.error(`读不到 ${job.file}\n先重跑生成器把暂存树建出来：\n  py -3 tools\\music_manifest.py <download 目录> --bili --stage ${stage}`);
    process.exit(2);
  }
}
for (const track of musicTracks) {
  if (filter && !track.key.includes(filter) && !track.id.includes(filter)) continue;
  const file = path.join(stage, ...track.key.split('/'));
  const size = sizes.get(file);
  if (size !== undefined && size !== Number(track.bytes)) {
    console.error(`${track.key} 体积不符：清单 ${track.bytes}，磁盘 ${size}。清单和暂存树不是同一批，重跑生成器。`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------- 开跑

const encode = await pickEncoding();

for (const bucket of shards.values()) {
  process.stdout.write(`列出 ${bucket.binding} 已有的 key… `);
  await existingKeys(bucket);
  console.log(`${bucket.present.size} 个`);
}

const pending = jobs.filter((job) => {
  const bucket = shards.get(job.binding);
  if (bucket.present.has(job.key)) {
    bucket.skipped = (bucket.skipped || 0) + 1;
    return false;
  }
  return true;
});

console.log(`已存在 ${jobs.length - pending.length} 个，本次要写 ${pending.length} 个`);
for (const job of pending) job.namespaceId = shards.get(job.binding).namespaceId;
if (pending.length > budget) {
  console.log(`超过每天 ${budget} 次写的免费额度，本次只写前 ${budget} 个；明天重跑同一条命令会自动续传。`);
  pending.length = budget;
}

let done = 0;
let bytesSent = 0;
let stopped = false;
const errors = [];
const total = pending.length;

async function worker() {
  for (;;) {
    if (stopped) return;
    const job = pending.pop();
    if (!job) return;
    try {
      await put(encode, job);
      done += 1;
      bytesSent += job.length;
      if (done % 20 === 0 || done === total) {
        process.stdout.write(`\r  ${done}/${total} 已写  ${(bytesSent / GiB).toFixed(2)} GiB   `);
      }
    } catch (error) {
      errors.push(`${job.key}：${error.message}`);
      if (error.fatal) {
        stopped = true; // 权限/容量/参数类错误重试不会变好，整批停下比刷 800 条错误有用
        console.error(`\n致命：${error.message}`);
        return;
      }
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log();

if (errors.length) {
  console.error(`失败 ${errors.length} 个：\n  ${errors.slice(0, 20).join('\n  ')}`);
  console.error('重跑同一条命令即可续传（已写成功的会跳过）。');
  process.exit(1);
}
console.log(`完成：本次写入 ${done} 个 key，${(bytesSent / GiB).toFixed(3)} GiB。`);
console.log('下一步：Pages → Settings → Functions → KV namespace bindings，绑上 MUSIC_A / MUSIC_B / MUSIC_C，然后 Retry deployment。');
