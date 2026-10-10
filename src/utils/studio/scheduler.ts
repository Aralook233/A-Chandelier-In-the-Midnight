// 传输层：lookahead 排程器。
//
// 为什么不能用 setTimeout 直接驱动发声：定时器抖动几十毫秒，节奏就会抖。
// 浏览器的标准做法是「往前排一小段」——用 setTimeout 只管醒来，
// 真正的时间一律用 AudioContext.currentTime 绝对定时，声音之间才不会漂。
//
// 排程按「整步」而不是「整首」：播放中改网格、改音量、加采样，
// 播放头一走到下一步就立刻生效，和 FL 的操作手感一致。

import { PPQ, STEPS, type EngineNote, type Note, type Track } from './types';

const LOOKAHEAD_SECONDS = 0.14;
const WAKE_MS = 25;

export const stepSeconds = (tempo: number): number => 60 / tempo / 4;
export const tickSeconds = (tempo: number): number => stepSeconds(tempo) / PPQ;

// 独奏优先：只要有任何一条在独奏，其他轨道一律静音。
export function audibleTracks(tracks: Track[]): Map<string, Track> {
  const solos = tracks.filter((item) => item.solo);
  const audible = solos.length > 0 ? solos : tracks.filter((item) => !item.muted);
  return new Map(audible.map((item) => [item.id, item]));
}

export const notesAtStep = (notes: Note[], step: number): Note[] =>
  notes.filter((note) => Math.floor(note.start / PPQ) === step);

//  swing 只推整步落在后半拍的音；卷帘里画的细分音不受影响，
//  否则旋律会被一起推歪——这是有意的取舍。
export function swingDelay(step: number, offsetTicks: number, swing: number, secondsOfStep: number): number {
  if (offsetTicks !== 0 || swing <= 0) return 0;
  return step % 2 === 1 ? swing * secondsOfStep : 0;
}

export function engineNote(note: Note, track: Track, gain: number, secondsOfTick: number): EngineNote {
  return {
    kind: track.kind,
    voice: track.voice,
    sampleId: track.sampleId,
    gain,
    start: note.start * secondsOfTick,
    length: Math.max(0.02, note.length * secondsOfTick),
    note: note.note,
    velocity: note.velocity,
  };
}

export type Transport = {
  playing: () => boolean;
  start: () => void;
  stop: () => void;
  step: () => number;
};

export type TransportOptions = {
  context: BaseAudioContext;
  tracks: () => Track[];
  notes: () => Note[];
  tempo: () => number;
  swing: () => number;
  play: (note: EngineNote, when: number) => void;
  // 停止时让已经排期的长音（铺垫这类）迅速收掉，不然按下停止还会响完一小节。
  silence: () => void;
  // 播放头所在步，从 UI 传进来；没有就当 0。
  stepOffset?: () => number;
  onPlay?: () => void;
  onStop?: () => void;
};

export function createTransport(options: TransportOptions): Transport {
  const { context } = options;
  let cursorStep = 0;
  let nextTime = 0;
  // 当前小节第 0 步对应的绝对时间，换小节时按当时的速度累加。
  let barOrigin = 0;
  let timer = 0;

  const scheduleStep = (step: number, at: number) => {
    const ofTick = tickSeconds(options.tempo());
    const audible = audibleTracks(options.tracks());
    for (const note of notesAtStep(options.notes(), step)) {
      const track = audible.get(note.trackId);
      if (!track) continue;
      const offsetTicks = note.start - step * PPQ;
      options.play(
        engineNote(note, track, track.gain, ofTick),
        at + offsetTicks * ofTick + swingDelay(step, offsetTicks, options.swing(), stepSeconds(options.tempo()))
      );
    }
  };

  const wake = () => {
    const horizon = context.currentTime + LOOKAHEAD_SECONDS;
    const secondsOfStep = stepSeconds(options.tempo());
    // 速度被改过之后排期窗口可能整个跑到前面去了，这里补一次对齐而不是空转。
    if (nextTime < context.currentTime) nextTime = context.currentTime + 0.02;
    while (nextTime < horizon) {
      scheduleStep(cursorStep, nextTime);
      cursorStep += 1;
      if (cursorStep >= STEPS) {
        cursorStep = 0;
        barOrigin += STEPS * secondsOfStep;
      }
      nextTime += secondsOfStep;
    }
  };

  return {
    playing: () => timer !== 0,
    start: () => {
      if (timer !== 0) return;
      cursorStep = Math.max(0, Math.min(STEPS - 1, Math.floor(options.stepOffset?.() ?? 0)));
      nextTime = context.currentTime + 0.06;
      barOrigin = nextTime;
      timer = window.setInterval(wake, WAKE_MS);
      wake();
      options.onPlay?.();
    },
    stop: () => {
      if (timer !== 0) window.clearInterval(timer);
      timer = 0;
      options.silence();
      options.onStop?.();
    },
    step: () => {
      if (timer === 0) return 0;
      const elapsed = context.currentTime - barOrigin;
      const index = Math.floor(elapsed / stepSeconds(options.tempo()));
      return Math.max(0, Math.min(STEPS - 1, index));
    },
  };
}
