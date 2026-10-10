// 项目持久化：localStorage 里存的是「用户随时能改」的 JSON，
// 所以读出来一律当外部输入处理——逐条校验、钳制，不合格的直接丢掉。
// 不做这一步的话，一个 tempo: "abc" 就能让排程器算出 NaN，播放头直接卡死。

import {
  MAX_OCTAVE,
  MIN_OCTAVE,
  PPQ,
  RESOLUTION,
  ROLL_SNAPS,
  defaultProject,
  starterPattern,
  type Note,
  type Pattern,
  type Project,
  type Track,
} from './types';

export const PROJECT_KEY = 'chandelier-studio-project';

const MAX_TRACKS = 32;
const MAX_PATTERNS = 16;
const MAX_NOTES = 512;

const number = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const integer = (value: unknown, fallback: number, min: number, max: number): number =>
  Math.round(number(value, fallback, min, max));

const flag = (value: unknown): boolean => value === true;

// 吸附粒度只认 ROLL_SNAPS 这几档（下拉框里也是这几项）。别的值——包括手改存档来的 3、5——
// 都归到最近的一档，否则下拉框一个选项都选不中，显示成空白。
const snap = (value: unknown): number => {
  const candidate = integer(value, PPQ, ROLL_SNAPS[0], ROLL_SNAPS[ROLL_SNAPS.length - 1]);
  let best: number = PPQ;
  for (const option of ROLL_SNAPS) {
    if (Math.abs(option - candidate) < Math.abs(best - candidate)) best = option;
  }
  return best;
};

const text = (value: unknown, fallback: string, max = 40): string => {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[\u0000-\u001f<>]/g, '').trim();
  return (clean || fallback).slice(0, max);
};

function readTrack(value: unknown, index: number): Track | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (kind !== 'drum' && kind !== 'pitch' && kind !== 'sample') return null;
  const track: Track = {
    id: text(raw.id, `track-${index}`, 24),
    name: text(raw.name, `轨道 ${index + 1}`, 24),
    kind,
    gain: number(raw.gain, 0.85, 0, 1.3),
    muted: flag(raw.muted),
    solo: flag(raw.solo),
  };
  if (typeof raw.voice === 'string') track.voice = raw.voice as Track['voice'];
  if (typeof raw.sampleId === 'string') track.sampleId = text(raw.sampleId, '', 24) || undefined;
  if (kind === 'sample' && !track.sampleId) return null;
  if (kind === 'drum' && !track.voice) return null;
  return track;
}

function readNote(value: unknown, trackIds: Set<string>, seen: Set<string>): Note | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const trackId = text(raw.trackId, '', 24);
  if (!trackIds.has(trackId)) return null;
  const id = text(raw.id, `note-${seen.size}`, 24);
  if (seen.has(id)) return null;
  const note: Note = {
    id,
    trackId,
    start: integer(raw.start, 0, 0, RESOLUTION - 1),
    length: integer(raw.length, PPQ, 1, RESOLUTION),
    note: integer(raw.note, 60, 0, 127),
    velocity: integer(raw.velocity, 100, 1, 127),
  };
  // 越过小节终点的音符会被排程器永久跳过，钳回来比留着安全。
  if (note.start + note.length > RESOLUTION) note.length = RESOLUTION - note.start;
  seen.add(id);
  return note;
}

function readPattern(value: unknown, index: number, trackIds: Set<string>): Pattern {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const ids = new Set<string>();
  const notes = Array.isArray(raw.notes)
    ? (raw.notes.slice(0, MAX_NOTES).map((item) => readNote(item, trackIds, ids)).filter(Boolean) as Note[])
    : [];
  return {
    id: text(raw.id, `pattern-${index}`, 24),
    name: text(raw.name, `模式 ${index + 1}`, 24),
    notes,
  };
}

export function sanitizeProject(value: unknown): Project | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.tracks) || !Array.isArray(raw.patterns)) return null;

  const tracks = raw.tracks.slice(0, MAX_TRACKS).map(readTrack).filter(Boolean) as Track[];
  if (tracks.length === 0) return null;
  const trackIds = new Set(tracks.map((item) => item.id));
  const patterns = raw.patterns.slice(0, MAX_PATTERNS).map((item, index) => readPattern(item, index, trackIds));
  if (patterns.length === 0) return null;

  const patternId = text(raw.patternId, '', 24);
  return {
    version: 1,
    tempo: integer(raw.tempo, 120, 40, 240),
    swing: number(raw.swing, 0, 0, 0.6),
    tracks,
    patterns,
    patternId: patterns.some((item) => item.id === patternId) ? patternId : patterns[0].id,
    octave: integer(raw.octave, 3, MIN_OCTAVE, MAX_OCTAVE),
    masterGain: number(raw.masterGain, 0.9, 0, 1.3),
    // 老存档里没有这个字段，读不到就回到默认的「中」。
    gridVelocity: integer(raw.gridVelocity, 95, 1, 127),
    rollSnap: snap(raw.rollSnap),
  };
}

export type LoadResult = { project: Project; source: 'saved' | 'new' | 'broken' };

export function loadProject(storage: Storage | undefined): LoadResult {
  let stored: string | null = null;
  try {
    stored = storage?.getItem(PROJECT_KEY) ?? null;
  } catch {
    // 隐私模式或存储被禁用：当没有存档处理，别让整个页面打不开。
    return { project: freshProject(), source: 'broken' };
  }
  if (!stored) return { project: freshProject(), source: 'new' };
  try {
    const parsed = sanitizeProject(JSON.parse(stored));
    if (parsed) return { project: parsed, source: 'saved' };
  } catch {
    // JSON 坏了，走下面的新档
  }
  const project = freshProject();
  return { project, source: 'broken' };
}

export function freshProject(): Project {
  const project = defaultProject();
  project.patterns[0].notes = starterPattern(project);
  return project;
}

// 返回值用来让 UI 说「这次没存上」，而不是假装存好了。
export function saveProject(storage: Storage | undefined, project: Project): boolean {
  try {
    storage?.setItem(PROJECT_KEY, JSON.stringify(project));
    return true;
  } catch {
    return false;
  }
}

export function clearProject(storage: Storage | undefined): void {
  try {
    storage?.removeItem(PROJECT_KEY);
  } catch {
    // 存不了也就删不掉，忽略
  }
}
