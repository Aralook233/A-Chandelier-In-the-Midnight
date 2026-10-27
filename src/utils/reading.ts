export type ReadingMark = {
  ratio: number;
  at: number;
};

export type ReadingRecord = {
  last: string;
  seen: Record<string, ReadingMark>;
};

const storageKey = 'chandelier-reading';
const MAX_CHAPTERS_KEPT = 200;
const MAX_SLUG_LENGTH = 200;

/** 读到这个比例就认为本章读完，首页该推荐下一章了。 */
export const FINISHED_RATIO = 0.97;

/** 低于这个比例不值得滚动复原：刚点开的人本来就想从头看。 */
export const JUMP_MIN_RATIO = 0.03;

const emptyRecord = (): ReadingRecord => ({ last: '', seen: {} });

function isPrintableSlug(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_SLUG_LENGTH) return false;
  // 存进去的东西会被拼回 href，控制字符和引号一律拒绝。
  return !/[\u0000-\u001f"'>\\]/.test(value);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * localStorage 按外部输入处理：手改过的 JSON、别的版本写歪的结构、半截的字符串，
 * 都只让单条记录作废，不让整份记录读不出来。
 */
function normalize(raw: unknown): ReadingRecord {
  const record = emptyRecord();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return record;

  const source = raw as { last?: unknown; seen?: unknown };
  if (source.seen && typeof source.seen === 'object' && !Array.isArray(source.seen)) {
    for (const [slug, value] of Object.entries(source.seen as Record<string, unknown>)) {
      if (!isPrintableSlug(slug) || !value || typeof value !== 'object') continue;
      const { ratio, at } = value as { ratio?: unknown; at?: unknown };
      if (typeof ratio !== 'number' || !Number.isFinite(ratio)) continue;
      const timestamp = typeof at === 'number' && Number.isFinite(at) ? at : 0;
      record.seen[slug] = { ratio: clamp01(ratio), at: timestamp };
    }
  }

  if (isPrintableSlug(source.last) && Object.prototype.hasOwnProperty.call(record.seen, source.last)) {
    record.last = source.last;
  }
  return record;
}

function readRaw(): string | null {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

export function readRecord(): ReadingRecord {
  const raw = readRaw();
  if (!raw) return emptyRecord();
  try {
    return normalize(JSON.parse(raw));
  } catch {
    return emptyRecord();
  }
}

function writeRecord(record: ReadingRecord): void {
  const slugs = Object.keys(record.seen);
  if (slugs.length > MAX_CHAPTERS_KEPT) {
    for (const slug of slugs.sort((a, b) => record.seen[b].at - record.seen[a].at).slice(MAX_CHAPTERS_KEPT)) {
      delete record.seen[slug];
    }
    if (!Object.prototype.hasOwnProperty.call(record.seen, record.last)) record.last = '';
  }

  try {
    localStorage.setItem(storageKey, JSON.stringify(record));
  } catch {
    // 无痕模式或配额用满：这一趟照样能读，只是下次进来没有记录。
  }
}

export function chapterMark(slug: string, record: ReadingRecord = readRecord()): ReadingMark | null {
  return record.seen[slug] ?? null;
}

/**
 * 记下「这一章读到哪儿」。存的是当前所在位置而不是最远位置，回头重读的人 reopen
 * 才不会被弹到自己刚划走的地方。变化不到半行、章也没换，就不碰 localStorage——
 * 那是同步写盘，逐帧调用会卡住滚动。
 */
export function saveMark(slug: string, ratio: number): void {
  if (!isPrintableSlug(slug)) return;
  const record = readRecord();
  const previous = record.seen[slug];
  const next = clamp01(Number.isFinite(ratio) ? ratio : 0);
  if (record.last === slug && previous && Math.abs(previous.ratio - next) < 0.005) return;
  record.seen[slug] = { ratio: next, at: Date.now() };
  record.last = slug;
  writeRecord(record);
}

/** 首页「继续阅读」用：上次读到哪儿，以及读完了就顺延下一章。 */
export function resumeTarget(order: string[], record: ReadingRecord = readRecord()): string | null {
  const last = record.last && order.includes(record.last) ? record.last : null;
  if (!last) return null;
  const mark = record.seen[last];
  if (mark && mark.ratio >= FINISHED_RATIO) {
    const index = order.indexOf(last);
    return order[index + 1] ?? null;
  }
  return last;
}

/** 只属于这台设备的记录，清空只动这一个 key。 */
export function clearRecord(): void {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // 读不到也就写不掉，无所谓。
  }
}
