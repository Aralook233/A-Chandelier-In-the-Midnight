// /track/<id> —— 电台唯一的取音出口。
//
// 为什么要绕这一圈，而不是把存储的公开地址直接塞进 <audio>：
//   1. `public/_headers` 里 CSP 钉了 `media-src 'self' blob:`，外链地址浏览器根本
//      不会去取；同源路径才放得行。
//   2. 存储是私有的。访客只拿到 12 位 id，看不到里面的对象名，也拼不出别的键去捞
//      没上节目单的东西。
//   3. 顺带把 Range/206 这件事做对——没有断点续传的音频在手机上要么拖不动，
//      要么整首先下完才响。
//
// 后端是 KV 而不是 R2：开 R2 要挂银行卡，KV 在账号已有的免费额度里。代价是 KV 没有
// Range 读——一次 get 会把整个值拉回来，所以值按 PART_SIZE 切片存放，请求区间落在
// 哪几片就只读哪几片。文件总长从 src/data/music.mjs 的 bytes 拿（清单本身就是 key 的
// 来源），所以不需要 R2 那次 head 探测。
//
// 绑定：Cloudflare Pages → Settings → Functions → KV namespace bindings，变量名依次
// 必须是 MUSIC_A / MUSIC_B / MUSIC_C。三个 namespace 各 1 GiB 免费额度，装 1.84 GiB
// 的曲目库。少绑一个，落在它上面的曲目一律 503——没绑定是配置问题，和「这首歌不存在」
// 是两件事，所以不回 404。
//
// 只读 GET/HEAD；不做写操作，所以没有 CSRF/限流那一套（见 functions/_lib/security.js
// 的前提：会改状态的接口才需要）。
import { musicTracks } from '../../src/data/music.mjs';

// 一片 4 MiB：795 首里只有 57 首会被切开，平均一首读 1.11 片，最坏一次拖动进度条
// 拉回 4 MiB。再切小（2 MiB）会把 key 数从 886 推到 1322，超出 KV 每天 1000 次写的
// 免费额度，就得把上传分两天跑。
export const PART_SIZE = 4 * 1024 * 1024;

// 分流靠 id 的末位十六进制，纯函数，不查表。改这个数组等于全库重传。
export const SHARDS = ['MUSIC_A', 'MUSIC_B', 'MUSIC_C'];

// id 是 key 的 sha1 前 12 位（见 tools/music_manifest.py），形状固定。先按形状拒绝
// 再查表，免得把任意字符串当成键去敲存储。
const ID_SHAPE = /^[0-9a-f]{12}$/;

// 导出只为了让测试能塞一条假曲目进去打完整链路；生成物本身不该被手写。
export const TRACKS = new Map(
  musicTracks.map((track) => [track.id, { key: track.key, bytes: Number(track.bytes) }]),
);

export function shardOf(id) {
  return SHARDS[Number.parseInt(id.slice(-1), 16) % SHARDS.length];
}

export function partKey(key, part) {
  return `${key}/${part}`;
}

const CONTENT_TYPES = {
  aac: 'audio/aac',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  ape: 'audio/ape',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  // B 站缓存的音频就叫 audio.m4s：ftyp+moov 打头的分片 MP4，容器和 m4a 是同一个，
  // 实测 Chromium 直接吃（能出时长、能拖进度），所以不必先转成 m4a。
  m4s: 'audio/mp4',
  mka: 'audio/x-matroska',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg; codecs=opus',
  wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
  // mp4/m4v 也收：B 站缓存里到处混得到。统一按 audio/mp4 给，<audio> 元素会自己
  // 只取音轨；给 video/mp4 反而有内核直接拒绝这个源。
  mp4: 'audio/mp4',
  m4v: 'audio/mp4',
};

// 走到这里说明扩展名认不出来。octet-stream 之下浏览器仍会嗅探容器，比硬猜一个类型更安全。
const FALLBACK_TYPE = 'application/octet-stream';

function contentTypeFor(key) {
  const dot = key.lastIndexOf('.');
  const extension = dot < 0 ? '' : key.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[extension] || FALLBACK_TYPE;
}

/**
 * 解析 Range。返回三种结果之一：
 *   { offset, length }  单一区间，可满足
 *   null                没有 Range，或看不懂 / 是多区间 —— 按 RFC 9110 忽略，给整个文件
 *   'unsatisfiable'     起点已经在文件尾之后 —— 416
 * 忽略多区间而不是回 multipart：播放器只要单区间，multipart 的边界写错反而整首都
 * 放不出来。导出只为让测试能单独打到这段最容易算错的算术。
 */
export function parseRange(header, size) {
  if (typeof header !== 'string' || !header.startsWith('bytes=') || !(size > 0)) return null;
  const spec = header.slice('bytes='.length).trim();
  if (spec.includes(',')) return null;
  const parts = spec.split('-');
  if (parts.length !== 2) return null;

  // '' 表示这一头省略；负数、小数、`bytes=x-` 一律算 -1，交给上面的 null。
  const number = (value) => (value === '' ? null : /^\d+$/.test(value) ? Number(value) : -1);
  const start = number(parts[0].trim());
  const end = number(parts[1].trim());
  if (start === -1 || end === -1) return null;

  if (start === null) {
    // `bytes=-N`：末尾 N 个字节；N 比文件还长就取整个文件。
    if (end === null) return null;
    const length = Math.min(end, size);
    return { offset: size - length, length };
  }
  if (start >= size) return 'unsatisfiable';
  const stop = end === null || end >= size ? size - 1 : end;
  if (stop < start) return null;
  return { offset: start, length: stop - start + 1 };
}

function refuse(status, note) {
  return new Response(note, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}

/**
 * 把 [offset, offset+length) 这段拼出来，只读它压到的那几片。
 * 返回 null 表示第一片就不在库里（当成「没有这首歌」）；中途缺片则回已拿到的部分，
 * 让调用方发一个长度诚实的 206，而不是撒谎说整段都在。
 */
async function readSlice(namespace, key, offset, length) {
  const first = Math.floor(offset / PART_SIZE);
  const last = Math.floor((offset + length - 1) / PART_SIZE);
  const chunks = [];
  let got = 0;
  for (let part = first; part <= last; part += 1) {
    const value = await namespace.get(partKey(key, part), 'arrayBuffer');
    if (!value) break;
    const from = Math.max(offset, part * PART_SIZE) - part * PART_SIZE;
    const want = Math.min(length - got, value.byteLength - from);
    if (want <= 0) break;
    chunks.push(new Uint8Array(value, from, want));
    got += want;
    if (got >= length) break;
  }
  if (!chunks.length) return null;
  if (chunks.length === 1) return chunks[0];
  const merged = new Uint8Array(got);
  let at = 0;
  for (const chunk of chunks) {
    merged.set(chunk, at);
    at += chunk.length;
  }
  return merged;
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const id = typeof params.id === 'string' ? params.id.toLowerCase() : '';

  // 形状不对、表里没有，都回同一个 404：不告诉探测的人哪一步把它拦下了。
  if (!ID_SHAPE.test(id)) return refuse(404, 'no such programme');
  const track = TRACKS.get(id);
  if (!track) return refuse(404, 'no such programme');

  const namespace = env && env[shardOf(id)];
  if (!namespace) return refuse(503, 'audio vault not bound');
  // 清单是长度的唯一来源，所以它缺 bytes 就是生成物出了问题，不能当成「没有这首歌」。
  if (!(track.bytes > 0)) return refuse(503, 'programme entry has no size');
  const size = track.bytes;

  const range = parseRange(request.headers.get('range'), size);
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' },
    });
  }

  const slice = range || { offset: 0, length: size };
  let body;
  try {
    body = await readSlice(namespace, track.key, slice.offset, slice.length);
  } catch {
    return refuse(502, 'audio vault unreachable');
  }
  if (!body) return refuse(404, 'no such programme');

  const headers = new Headers({
    'content-type': contentTypeFor(track.key),
    'accept-ranges': 'bytes',
    // 一天：同名覆盖上传时不至于长期还在放旧版本，又足够让热门曲目留在边缘。
    'cache-control': 'public, max-age=86400',
    'content-length': String(body.byteLength),
    // 音频不该进搜索索引；写在响应里而不是 _headers，因为 _headers 不一定覆盖
    // Functions 的响应。
    'x-robots-tag': 'noindex',
  });
  if (range) {
    headers.set('content-range', `bytes ${slice.offset}-${slice.offset + body.byteLength - 1}/${size}`);
  }

  return new Response(request.method === 'HEAD' ? null : body, {
    status: range ? 206 : 200,
    headers,
  });
}

// Pages 的路由按方法找导出：HEAD 不复用 GET，得单独点名。行为一样，只是 body 不塞。
export const onRequestHead = onRequestGet;
