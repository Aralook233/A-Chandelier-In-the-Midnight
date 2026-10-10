// 工作室的数据模型与常量。UI 层、发声层、持久化层都从这里取类型，
// 免得各自复制一份「什么算一个项目」。

export const STEPS = 16;
// 一步 = 一个十六分音符；PPQ 是每步再细分几格，一格（1 tick）就是六十四分音符。
export const PPQ = 4;
export const RESOLUTION = STEPS * PPQ;
// 卷帘可选的吸附粒度（tick），和 studio.astro 里「自动对齐」下拉框的取值一一对应。
// 存档里读到表外的值（手改的）会被归到最近一档，否则下拉框会一个都选不中。
export const ROLL_SNAPS = [1, 2, 4, 8, 16, 32] as const;
export const MIN_OCTAVE = 0;
export const MAX_OCTAVE = 8;

export type DrumKind = 'kick' | 'snare' | 'closed-hat' | 'open-hat' | 'clap' | 'tom';
export type SynthKind = 'bass' | 'lead' | 'pad' | 'pluck';
export type VoiceKind = DrumKind | SynthKind;

export type TrackKind = 'drum' | 'pitch' | 'sample';

export type Track = {
  id: string;
  name: string;
  kind: TrackKind;
  voice?: VoiceKind;
  sampleId?: string;
  gain: number;
  muted: boolean;
  solo: boolean;
};

export type Note = {
  id: string;
  trackId: string;
  start: number;
  length: number;
  note: number;
  velocity: number;
};

export type Pattern = {
  id: string;
  name: string;
  notes: Note[];
};

export type Project = {
  version: 1;
  tempo: number;
  swing: number;
  tracks: Track[];
  patterns: Pattern[];
  patternId: string;
  octave: number;
  masterGain: number;
  // 网格里新放音符用的力度，选一次一直用，免得每格点四五下。
  gridVelocity: number;
  // 卷帘的吸附粒度（tick）：1 = 最细（六十四分音符），4 = 十六分音符，32 = 二分音符。
  rollSnap: number;
};

export type SampleMeta = {
  id: string;
  name: string;
  duration: number;
  bytes: number;
};

export type StoredSample = SampleMeta & { data: ArrayBuffer; type: string };

// 已经算好音量与通道路径的音符，交给发声层直接发声。
export type EngineNote = {
  kind: TrackKind;
  voice?: VoiceKind;
  sampleId?: string;
  gain: number;
  start: number;
  length: number;
  note: number;
  velocity: number;
};

export const DRUM_VOICES: { kind: DrumKind; label: string }[] = [
  { kind: 'kick', label: '底鼓' },
  { kind: 'snare', label: '军鼓' },
  { kind: 'closed-hat', label: '闭镲' },
  { kind: 'open-hat', label: '开镲' },
  { kind: 'clap', label: '拍手' },
  { kind: 'tom', label: '嗵鼓' },
];

export const SYNTH_VOICES: { kind: SynthKind; label: string }[] = [
  { kind: 'bass', label: '贝斯' },
  { kind: 'lead', label: '主音' },
  { kind: 'pad', label: '铺垫' },
  { kind: 'pluck', label: '拨弦' },
];

const PITCH_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export const noteLabel = (note: number): string =>
  `${PITCH_NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;

export const newId = (): string => {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random.slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
};

export function defaultProject(): Project {
  const track = (name: string, kind: TrackKind, voice?: VoiceKind): Track => ({
    id: newId(),
    name,
    kind,
    voice,
    gain: 0.85,
    muted: false,
    solo: false,
  });
  const tracks = [
    track('底鼓', 'drum', 'kick'),
    track('军鼓', 'drum', 'snare'),
    track('闭镲', 'drum', 'closed-hat'),
    track('开镲', 'drum', 'open-hat'),
    track('贝斯', 'pitch', 'bass'),
    track('主音', 'pitch', 'lead'),
    track('铺垫', 'pitch', 'pad'),
  ];
  const pattern: Pattern = { id: newId(), name: '模式 1', notes: [] };
  return {
    version: 1,
    tempo: 120,
    swing: 0,
    tracks,
    patterns: [pattern],
    patternId: pattern.id,
    octave: 3,
    masterGain: 0.9,
    gridVelocity: 95,
    rollSnap: PPQ,
  };
}

// 一个可听的开场循环：让空项目听起来不像坏了。
export function starterPattern(project: Project): Note[] {
  const [kick, snare, closed, open, bass] = project.tracks;
  const at = (track: Track | undefined, start: number, length = PPQ, note = 60, velocity = 108): Note | null =>
    track ? { id: newId(), trackId: track.id, start, length, note, velocity } : null;
  const notes: Note[] = [];
  for (let step = 0; step < STEPS; step += 1) {
    const push = (note: Note | null) => {
      if (note) notes.push(note);
    };
    if (step % 4 === 0) push(at(kick, step * PPQ, PPQ, 36, 120));
    if (step % 8 === 4) push(at(snare, step * PPQ, PPQ, 38, 104));
    push(at(closed, step * PPQ, PPQ, 42, step % 2 === 0 ? 92 : 58));
    if (step === 14) push(at(open, step * PPQ, PPQ, 46, 84));
  }
  for (const [step, degree] of [
    [0, 0], [4, 7], [8, 3], [12, 5], [13, 10],
  ] as const) {
    const note = at(bass, step * PPQ, PPQ * 3, 36 + degree, 100);
    if (note) notes.push(note);
  }
  return notes;
}
