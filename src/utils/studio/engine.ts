// 发声层：所有「声音怎么来」的代码只写在这一份里。
//
// 为什么没有采样文件：CSP 是 script-src 'self' 且站点没有音频仓，所以鼓和合成器
// 全部用振荡器与噪声缓冲现场合成；用户想用自己的声音就导入采样，走同一套声路。
//
// 实时播放与离线导出共用 playNote()，两边听到的东西才是同一个东西。
// 参数一律用 BaseAudioContext：AudioContext 和 OfflineAudioContext 都满足它，
// 而 createGain/createOscillator/createBuffer 这些方法本来就在基类上。

import type { EngineNote } from './types';

export const hzOf = (note: number): number => 440 * 2 ** ((note - 69) / 12);

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

function noiseBuffer(context: BaseAudioContext): AudioBuffer {
  const cached = noiseCache.get(context);
  if (cached) return cached;
  const length = Math.floor(context.sampleRate * 2);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) channel[index] = Math.random() * 2 - 1;
  noiseCache.set(context, buffer);
  return buffer;
}

type ToneOptions = {
  when: number;
  dest: AudioNode;
  type: OscillatorType;
  hz: number;
  dropTo?: number;
  dropTime?: number;
  peak: number;
  attack: number;
  decay: number;
  sustain?: number;
  hold?: number;
  release?: number;
  filter?: { type: BiquadFilterType; hz: number; q?: number };
  detune?: number[];
};

// 一次（或一组失谐的）振荡器 + 可选滤波 + 一条 AD(SR) 包络。
// 指数斜坡的目标一律用 0.0001：Web Audio 规定指数变化不能落到 0，写 0 会抛错。
function tone(options: ToneOptions, context: BaseAudioContext): void {
  const { when, dest, type, hz, peak, attack, decay } = options;
  const sustain = options.sustain ?? 0;
  const hold = options.hold ?? 0;
  const release = options.release ?? 0.05;
  const sustainLevel = Math.max(0.0001, sustain > 0 ? peak * sustain : 0.0001);

  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.linearRampToValueAtTime(peak, when + attack);
  let end = when + attack + decay;
  if (sustain > 0) {
    gain.gain.exponentialRampToValueAtTime(sustainLevel, when + attack + decay);
    end = when + attack + Math.max(decay, hold);
    gain.gain.setValueAtTime(sustainLevel, end);
    gain.gain.exponentialRampToValueAtTime(0.0001, end + release);
    end += release;
  }
  end += 0.02;

  let node: AudioNode = gain;
  if (options.filter) {
    const filter = context.createBiquadFilter();
    filter.type = options.filter.type;
    filter.frequency.value = options.filter.hz;
    if (options.filter.q) filter.Q.value = options.filter.q;
    filter.connect(gain);
    node = filter;
  }

  for (const cents of options.detune ?? [0]) {
    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.detune.value = cents;
    oscillator.frequency.setValueAtTime(hz, when);
    if (options.dropTo) oscillator.frequency.exponentialRampToValueAtTime(options.dropTo, when + (options.dropTime ?? 0.1));
    oscillator.connect(node);
    oscillator.start(when);
    oscillator.stop(end);
  }
  gain.connect(dest);
}

type NoiseOptions = {
  when: number;
  dest: AudioNode;
  peak: number;
  decay: number;
  filter?: { type: BiquadFilterType; hz: number; q?: number };
};

function noiseBurst(options: NoiseOptions, context: BaseAudioContext): void {
  const source = context.createBufferSource();
  source.buffer = noiseBuffer(context);
  source.loop = true;
  // 噪声是 2 秒循环缓冲，起点不偏移的话每次听起来一模一样。
  const offset = Math.random() * 1.5;

  const filter = context.createBiquadFilter();
  filter.type = options.filter?.type ?? 'highpass';
  filter.frequency.value = options.filter?.hz ?? 4000;
  filter.Q.value = options.filter?.q ?? 0.7;

  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, options.when);
  gain.gain.linearRampToValueAtTime(options.peak, options.when + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, options.when + options.decay);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(options.dest);
  source.start(options.when, offset);
  source.stop(options.when + options.decay + 0.02);
}

function drumVoice(kind: string, when: number, dest: AudioNode, level: number, context: BaseAudioContext): void {
  switch (kind) {
    case 'kick':
      tone({ when, dest, type: 'sine', hz: 152, dropTo: 46, dropTime: 0.085, peak: level, attack: 0.002, decay: 0.34 }, context);
      noiseBurst({ when, dest, peak: level * 0.22, decay: 0.006, filter: { type: 'highpass', hz: 1400 } }, context);
      return;
    case 'tom':
      tone({ when, dest, type: 'sine', hz: 232, dropTo: 112, dropTime: 0.18, peak: level * 0.8, attack: 0.002, decay: 0.27 }, context);
      return;
    case 'snare':
      tone({ when, dest, type: 'triangle', hz: 196, peak: level * 0.42, attack: 0.002, decay: 0.075 }, context);
      noiseBurst({ when, dest, peak: level * 0.7, decay: 0.16, filter: { type: 'bandpass', hz: 1800, q: 0.9 } }, context);
      return;
    case 'clap':
      for (const [index, gap] of [0, 0.011, 0.023].entries()) {
        noiseBurst(
          {
            when: when + gap,
            dest,
            peak: level * (index === 2 ? 0.55 : 0.38),
            decay: index === 2 ? 0.14 : 0.03,
            filter: { type: 'bandpass', hz: 1150, q: 1.2 },
          },
          context
        );
      }
      return;
    case 'closed-hat':
      noiseBurst({ when, dest, peak: level * 0.36, decay: 0.04, filter: { type: 'highpass', hz: 7500 } }, context);
      return;
    case 'open-hat':
      noiseBurst({ when, dest, peak: level * 0.34, decay: 0.3, filter: { type: 'highpass', hz: 6800 } }, context);
      return;
    default:
      return;
  }
}

// 持续类音色按音符长度发声：包络保持到 length 再释放。
function synthVoice(kind: string, when: number, length: number, frequency: number, dest: AudioNode, level: number, context: BaseAudioContext): void {
  const hold = Math.max(0.06, length);
  switch (kind) {
    case 'bass':
      tone({ when, dest, type: 'sawtooth', hz: frequency / 2, peak: level * 0.5, attack: 0.006, decay: 0.1, sustain: 0.7, hold, release: 0.06, filter: { type: 'lowpass', hz: Math.min(2400, frequency * 4), q: 1.1 } }, context);
      tone({ when, dest, type: 'sine', hz: frequency / 4, peak: level * 0.34, attack: 0.008, decay: 0.06, sustain: 0.8, hold, release: 0.05 }, context);
      return;
    case 'pad':
      tone({ when, dest, type: 'sawtooth', hz: frequency, peak: level * 0.2, attack: 0.14, decay: 0.2, sustain: 0.85, hold, release: 0.24, filter: { type: 'lowpass', hz: 1300, q: 0.8 }, detune: [-7, 0, 7] }, context);
      return;
    case 'pluck':
      tone({ when, dest, type: 'triangle', hz: frequency, peak: level * 0.5, attack: 0.003, decay: Math.min(0.3, hold) }, context);
      tone({ when, dest, type: 'square', hz: frequency * 2, peak: level * 0.09, attack: 0.003, decay: Math.min(0.12, hold) }, context);
      return;
    case 'lead':
    default:
      tone({ when, dest, type: 'square', hz: frequency, peak: level * 0.3, attack: 0.006, decay: 0.08, sustain: 0.75, hold, release: 0.08, filter: { type: 'lowpass', hz: 2800, q: 0.9 }, detune: [-5, 5] }, context);
      return;
  }
}

export type Engine = {
  output: GainNode;
  setMaster: (value: number) => void;
  playNote: (note: EngineNote, when: number) => void;
};

// getSample 同步返回已解码的缓冲：离线上下文里没法 await 一次解码，
// 所以采样必须在调用方就先解码好。取不到就静默跳过，让导出不至于整体失败。
export function createEngine(context: BaseAudioContext, getSample: (id: string) => AudioBuffer | undefined): Engine {
  const output = context.createGain();
  output.gain.value = 1;

  return {
    output,
    setMaster: (value: number) => {
      output.gain.value = Math.max(0, Math.min(1.4, value));
    },
    playNote: (note: EngineNote, when: number) => {
      const level = Math.max(0.05, Math.min(1, note.velocity / 127)) * note.gain;
      if (level <= 0.001) return;

      if (note.kind === 'sample') {
        const buffer = note.sampleId ? getSample(note.sampleId) : undefined;
        if (!buffer) return;
        const source = context.createBufferSource();
        source.buffer = buffer;
        const length = note.length > 0 ? Math.min(note.length, buffer.duration) : buffer.duration;
        const gain = context.createGain();
        // 短起短落，避免连续触发时在拼接处爆音。
        gain.gain.setValueAtTime(0.0001, when);
        gain.gain.linearRampToValueAtTime(level, when + 0.004);
        gain.gain.setValueAtTime(level, when + length);
        gain.gain.linearRampToValueAtTime(0.0001, when + length + 0.02);
        source.connect(gain);
        gain.connect(output);
        source.start(when);
        source.stop(when + length + 0.03);
        return;
      }

      if (note.kind === 'drum') {
        if (note.voice) drumVoice(note.voice, when, output, level, context);
        return;
      }

      synthVoice(note.voice ?? 'lead', when, note.length, hzOf(note.note), output, level, context);
    },
  };
}
