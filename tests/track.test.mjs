// /track/<id> 与 /music/tracks.json 的测试。跑法：
//   node tests/track.test.mjs
// 用内存 KV 假 namespace（按 key 回整片 ArrayBuffer）打真实 handler，重点是三件事：
// Range 算术、4 MiB 分片的拼接与「只读了需要的那几片」的读放大、以及
// 「库内对象名不能出现在客户端」。

import { PART_SIZE, TRACKS, onRequestGet, parseRange, partKey, shardOf } from '../functions/track/[id].js';
import { musicTracks } from '../src/data/music.mjs';

const results = [];
let failures = 0;

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures += 1;
}

// 一段可辨识的假音频：第 n 个字节是 n % 251，切片的偏移一读就知道对不对。
const SIZE = 4096;
const DATA = new Uint8Array(SIZE);
for (let index = 0; index < SIZE; index += 1) DATA[index] = index % 251;

// 一首大到要切三片的：验证跨片拼接，顺便盯住尾片比 PART_SIZE 短的情况。
const BIG = 4 * PART_SIZE + 1234;
const BIG_DATA = new Uint8Array(BIG);
for (let index = 0; index < BIG; index += 1) BIG_DATA[index] = index % 251;

const GiB = 1024 ** 3;

/** 假 namespace：store 是 KV key -> 该片完整字节。hits 记录读了哪几片。 */
function makeNamespace(store = new Map(), { fail = false } = {}) {
  const hits = [];
  return {
    hits,
    async get(key, type) {
      hits.push(key);
      if (fail) throw new Error('namespace down');
      const value = store.get(key);
      // 真 KV 每次都给一块新缓冲，这里也不共享，免得 handler 里的越界写被测试藏住。
      return value ? value.slice().buffer : null;
    },
  };
}

/** 把一段字节按 PART_SIZE 切成 KV 里的若干片。 */
function splitParts(key, bytes) {
  const store = new Map();
  for (let part = 0; part * PART_SIZE < bytes.length; part += 1) {
    store.set(partKey(key, part), bytes.slice(part * PART_SIZE, (part + 1) * PART_SIZE));
  }
  return store;
}

function envWith(namespace) {
  return { MUSIC_A: namespace, MUSIC_B: namespace, MUSIC_C: namespace };
}

function makeContext({ id, method = 'GET', range, env = envWith(makeNamespace()) }) {
  const headers = {};
  if (range) headers.range = range;
  const request = new Request(`https://example.pages.dev/track/${id}`, { method, headers });
  return { request, env, params: { id }, waitUntil() {}, next: async () => {} };
}

const ID = 'a'.repeat(12);
const KEY = 'B 站缓存/第一卷/12345678_1_1.mp3';
const BIG_ID = 'd'.repeat(11) + '0';
const BIG_KEY = '1000842485/c_1443580533/80/audio.m4s';

async function sliceOf(response) {
  const buffer = new Uint8Array(await response.arrayBuffer());
  return { bytes: buffer, text: new TextDecoder().decode(buffer) };
}

// 1. parseRange 的算术
{
  check('无 Range 视为整文件', parseRange(null, SIZE) === null);
  check('非 bytes 单位被忽略', parseRange('items=0-10', SIZE) === null);
  check('空值被忽略', parseRange('bytes=', SIZE) === null);
  check('垃圾值被忽略', parseRange('bytes=abc-def', SIZE) === null);
  check('多区间不硬撑 multipart', parseRange('bytes=0-99,200-299', SIZE) === null);

  const head100 = parseRange('bytes=0-99', SIZE);
  check('明确区间按闭区间算长度', head100.offset === 0 && head100.length === 100, JSON.stringify(head100));

  const tail = parseRange('bytes=1000-', SIZE);
  check('开区间补到文件尾', tail.offset === 1000 && tail.length === SIZE - 1000, JSON.stringify(tail));

  const suffix = parseRange('bytes=-50', SIZE);
  check('后缀区间从尾部数', suffix.offset === SIZE - 50 && suffix.length === 50, JSON.stringify(suffix));

  const longSuffix = parseRange(`bytes=-${SIZE * 3}`, SIZE);
  check('后缀超过文件长度时取整首', longSuffix.offset === 0 && longSuffix.length === SIZE, JSON.stringify(longSuffix));

  const clamped = parseRange(`bytes=10-${SIZE + 500}`, SIZE);
  check('终点越界夹回文件尾', clamped.length === SIZE - 10, JSON.stringify(clamped));

  check('起点越界判 416', parseRange(`bytes=${SIZE}-`, SIZE) === 'unsatisfiable');
  check('终点小于起点算无效', parseRange('bytes=5-3', SIZE) === null);
  check('零长文件不除零', parseRange('bytes=0-', 0) === null);
  check('单字节区间长度为一', parseRange('bytes=7-7', SIZE).length === 1);
}

// 2. 入口拦截
{
  const shapes = ['', 'short', 'zzzzzzzzzzzz', '../etc/passwd', 'A'.repeat(11), 'id with spaces'];
  for (const id of shapes) {
    const response = await onRequestGet(makeContext({ id }));
    check(`形状不对的 id 一律 404：${id || '(空)'}`, response.status === 404, String(response.status));
  }

  const unknown = await onRequestGet(makeContext({ id: 'f'.repeat(12) }));
  check('表里没有的 id 也是 404（不泄露库）', unknown.status === 404, String(unknown.status));
  check('拒绝响应不提对象名也不提 key', !(await unknown.text()).includes(KEY), KEY);
}

// 3. 分流：id 末位决定进哪个 namespace
{
  check('末位 a(10) 落 B 架', shardOf('00000000000a') === 'MUSIC_B');
  check('末位 f(15) 落 A 架', shardOf('00000000000f') === 'MUSIC_A');
  check('末位 2 落 C 架', shardOf('000000000002') === 'MUSIC_C');
  check('三个架都用得上', new Set(['0', '1', '2'].map((d) => shardOf('00000000000' + d))).size === 3);

  // 得用清单里真有的 id：假 id 会先撞上 404，测不到绑定这一层。
  const onC = musicTracks.find((track) => shardOf(track.id) === 'MUSIC_C');
  check('清单里确实有落在 C 架的曲目', Boolean(onC));
  const missingShard = await onRequestGet(makeContext({
    id: onC.id,
    env: { MUSIC_A: makeNamespace(), MUSIC_B: makeNamespace() },
  }));
  check('少绑一个 namespace 时该架 503，不误判成 404', missingShard.status === 503, String(missingShard.status));
}

// 4. 完整取音（单曲一片）
{
  const store = splitParts(KEY, DATA);
  TRACKS.set(ID, { key: KEY, bytes: SIZE });
  try {
    const unbound = await onRequestGet(makeContext({ id: ID, env: {} }));
    check('有曲目但没绑 KV 时回 503，不回 404', unbound.status === 503, String(unbound.status));

    const ns = makeNamespace(store);
    const full = await onRequestGet(makeContext({ id: ID, env: envWith(ns) }));
    const body = await sliceOf(full);
    check('无 Range 回 200', full.status === 200, String(full.status));
    check('整个文件都在', full.headers.get('content-length') === String(SIZE) && body.bytes.length === SIZE);
    check('不带 Content-Range', full.headers.get('content-range') === null);
    check('声明支持断点', full.headers.get('accept-ranges') === 'bytes');
    check('类型按扩展名推断', full.headers.get('content-type') === 'audio/mpeg', full.headers.get('content-type'));
    check('偏移可读回真字节', body.bytes[0] === 0 && body.bytes[100] === 100);
    check('一片就够时只读一次', ns.hits.length === 1, JSON.stringify(ns.hits));

    const part = await onRequestGet(makeContext({ id: ID, range: 'bytes=2000-2999', env: envWith(ns) }));
    const partBody = await sliceOf(part);
    check('区间请求回 206', part.status === 206, String(part.status));
    check('206 带正确的 Content-Range', part.headers.get('content-range') === `bytes 2000-2999/${SIZE}`, part.headers.get('content-range'));
    check('206 只送这一段', partBody.bytes.length === 1000 && part.headers.get('content-length') === '1000');
    check('切片偏移没搞错', partBody.bytes[0] === 2000 % 251 && partBody.bytes[999] === 2999 % 251);

    const upper = await onRequestGet(makeContext({ id: ID.toUpperCase(), range: 'bytes=0-15', env: envWith(ns) }));
    check('大写 id 也一样取到', upper.status === 206, String(upper.status));

    const suffixPart = await onRequestGet(makeContext({ id: ID, range: 'bytes=-10', env: envWith(ns) }));
    const suffixBody = await sliceOf(suffixPart);
    check('后缀区间真的从尾部切', suffixBody.bytes[0] === (SIZE - 10) % 251 && suffixBody.bytes.length === 10);

    const unsatisfied = await onRequestGet(makeContext({ id: ID, range: `bytes=${SIZE + 1}-`, env: envWith(ns) }));
    check('越界区间回 416', unsatisfied.status === 416, String(unsatisfied.status));
    check('416 报总长', unsatisfied.headers.get('content-range') === `bytes */${SIZE}`, unsatisfied.headers.get('content-range'));

    const multi = await onRequestGet(makeContext({ id: ID, range: 'bytes=0-9,20-29', env: envWith(ns) }));
    check('多区间退回整首而不是报错', multi.status === 200, String(multi.status));

    const head = await onRequestGet(makeContext({ id: ID, method: 'HEAD', range: 'bytes=0-99', env: envWith(ns) }));
    check('HEAD 回 206 且不塞 body', head.status === 206 && (await head.arrayBuffer()).byteLength === 0, String(head.status));

    const empty = await onRequestGet(makeContext({ id: ID, env: envWith(makeNamespace()) }));
    check('库里没有这个对象时 404', empty.status === 404, String(empty.status));

    const boom = await onRequestGet(makeContext({ id: ID, env: envWith(makeNamespace(store, { fail: true })) }));
    check('namespace 故障回 502 且不抛异常', boom.status === 502, String(boom.status));
    check('故障响应不带堆栈', (await boom.text()).includes('Error') === false);

    TRACKS.set(ID, { key: KEY, bytes: undefined });
    const noSize = await onRequestGet(makeContext({ id: ID, env: envWith(ns) }));
    check('清单缺 bytes 时回 503 而不是当成没这首歌', noSize.status === 503, String(noSize.status));
  } finally {
    TRACKS.delete(ID);
  }
}

// 5. 分片：跨片拼接与读放大
{
  const store = splitParts(BIG_KEY, BIG_DATA);
  const ns = makeNamespace(store);
  TRACKS.set(BIG_ID, { key: BIG_KEY, bytes: BIG });
  const second = PART_SIZE + 1000;
  try {
    check('大文件被切成 5 片', store.size === 5, String(store.size));

    const whole = await onRequestGet(makeContext({ id: BIG_ID, env: envWith(ns) }));
    const wholeBody = await sliceOf(whole);
    check('整首跨片拼接长度对', whole.status === 200 && wholeBody.bytes.length === BIG, String(wholeBody.bytes.length));
    check('跨片拼接的字节是连续的',
      wholeBody.bytes[PART_SIZE] === PART_SIZE % 251 && wholeBody.bytes[BIG - 1] === (BIG - 1) % 251);
    check('整首时读了全部 5 片', ns.hits.length === 5, JSON.stringify(ns.hits.map((k) => k.slice(-1))));

    const inside = await onRequestGet(makeContext({ id: BIG_ID, range: `bytes=${second}-${second + 99}`, env: envWith(ns) }));
    ns.hits.length = 0;
    const seek = await onRequestGet(makeContext({ id: BIG_ID, range: `bytes=${second}-${second + 99}`, env: envWith(ns) }));
    const seekBody = await sliceOf(seek);
    check('落在单片内的拖动只读那一片', ns.hits.length === 1 && ns.hits[0] === partKey(BIG_KEY, 1), JSON.stringify(ns.hits));
    check('单片内偏移正确', seekBody.bytes[0] === second % 251 && seekBody.bytes.length === 100, String(seekBody.bytes.length));
    check('跨片文件的 Content-Range 用清单里的总长',
      seek.headers.get('content-range') === `bytes ${second}-${second + 99}/${BIG}`, seek.headers.get('content-range'));
    check('m4s 的 Content-Type 是 audio/mp4', inside.headers.get('content-type') === 'audio/mp4', inside.headers.get('content-type'));

    const straddle = PART_SIZE - 50;
    const cross = await onRequestGet(makeContext({ id: BIG_ID, range: `bytes=${straddle}-${straddle + 99}`, env: envWith(ns) }));
    const crossBody = await sliceOf(cross);
    check('跨片区间读了相邻两片', cross.status === 206 && crossBody.bytes.length === 100, String(crossBody.bytes.length));
    check('跨片区间两端字节都来自正确的片',
      crossBody.bytes[0] === straddle % 251 && crossBody.bytes[99] === (straddle + 99) % 251);

    const tail = await onRequestGet(makeContext({ id: BIG_ID, range: `bytes=${BIG - 20}-`, env: envWith(ns) }));
    const tailBody = await sliceOf(tail);
    check('尾片短于 PART_SIZE 时后缀区间照样切对',
      tailBody.bytes.length === 20 && tailBody.bytes[19] === (BIG - 1) % 251, String(tailBody.bytes.length));

    // 这段区间压着第 0 片的尾和第 1 片的头，抽掉第 1 片就只剩开头那 10 个字节。
    store.delete(partKey(BIG_KEY, 1));
    const partial = await onRequestGet(makeContext({ id: BIG_ID, range: `bytes=${PART_SIZE - 10}-${PART_SIZE + 5000}`, env: envWith(ns) }));
    const partialBody = await sliceOf(partial);
    check('中间缺片时回一个长度诚实的短 206',
      partial.status === 206 && partialBody.bytes.length === 10 &&
        Number(partial.headers.get('content-length')) === partialBody.bytes.length,
      `${partialBody.bytes.length}/${partial.headers.get('content-length')}`);
  } finally {
    TRACKS.delete(BIG_ID);
  }
}

// 6. 免费额度装得下这份节目单（KV 每个 namespace 1 GiB）
{
  const load = new Map();
  let total = 0;
  let oversized = 0;
  for (const track of musicTracks) {
    const shard = shardOf(track.id);
    load.set(shard, (load.get(shard) || 0) + Number(track.bytes));
    total += Number(track.bytes);
    if (track.bytes > GiB / 4) oversized += 1;
  }
  for (const [shard, bytes] of load) {
    check(`${shard} 的占用低于 1 GiB 免费上限`, bytes < GiB, `${(bytes / GiB).toFixed(2)} GiB`);
  }
  check('三个架都分到了曲目', load.size === 3, JSON.stringify([...load.keys()]));
  check('没有单曲超过 4 MiB 分片上限的 6 倍', oversized === 0, String(oversized));
}

// 6b. 风格标签是分类器猜出来的，所以这里只守它的形状，不守它猜得对不对
{
  const genres = musicTracks.map((track) => track.genre);
  check('每首都带风格标签', genres.every((genre) => typeof genre === 'string' && genre.length > 0));
  const labels = [...new Set(genres)];
  check('风格不超过 20 格', labels.length <= 20, String(labels.length));
  check('标签短到塞得进下拉框', labels.every((label) => label.length <= 8), labels.join('/'));
  const other = genres.filter((genre) => genre === '其他').length;
  check('落到「其他」的不到四成', other / genres.length < 0.4,
    `${((other / genres.length) * 100).toFixed(1)}%`);
}

// 7. 客户端节目单不得泄露库内对象名
{
  const sample = {
    id: 'b'.repeat(12),
    key: KEY,
    title: '夜色流淌',
    artist: '某电台',
    album: '未命名',
    year: 2026,
    track: 3,
    side: '第一卷',
    genre: '电子',
    duration: 213.5,
    bytes: 8888,
    format: 'mp3',
  };
  musicTracks.push(sample);
  try {
    const { GET } = await import('../src/pages/music/tracks.json.js');
    const response = await GET();
    const payload = JSON.parse(await response.text());
    const entry = payload.tracks.find((track) => track.id === sample.id);
    check('节目单里有这首歌', Boolean(entry), JSON.stringify(payload.tracks.length));
    check('电台要的字段齐全', entry && entry.title === '夜色流淌' && entry.duration === 213.5
      && entry.format === 'mp3' && entry.genre === '电子');
    check('节目单不含 key', entry && !('key' in entry), JSON.stringify(entry));
    check('节目单不含 bytes/album/year/track', entry && !('bytes' in entry) && !('album' in entry) && !('year' in entry) && !('track' in entry));
    const body = JSON.stringify(payload);
    check('整份 JSON 里搜不到库内对象名', !body.includes(KEY) && !body.includes('B 站缓存'), body.slice(0, 120));
    check('content-type 是 JSON', (response.headers.get('content-type') || '').startsWith('application/json'), response.headers.get('content-type'));
  } finally {
    musicTracks.length = 0;
  }
}

console.log('\nTrack route tests');
console.log('-----------------');
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok || !item.detail ? '' : `\n        ${item.detail}`}`);
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures === 0 ? 0 : 1);
