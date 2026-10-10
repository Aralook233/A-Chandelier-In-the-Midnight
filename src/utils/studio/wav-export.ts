// 导出：把当前模式离线渲染成 WAV 文件。
//
// 用 OfflineAudioContext 而不是麦克风录制：渲染按采样精确进行，不受主线程卡顿影响，
// 也不需要 MediaRecorder 或 getUserMedia 权限。CSP 里没有 worker-src，
// 所以编码（交错 PCM + RIFF 头）直接写在主线程——那点算术根本不值得开线程。
//
// 采样在离线上下文上要重新解码一次，AudioBuffer 不能跨上下文用。

import { createEngine } from './engine';
import { PPQ, RESOLUTION, STEPS, type EngineNote, type Project } from './types';
import { audibleTracks, engineNote, stepSeconds, swingDelay, tickSeconds } from './scheduler';
import type { Samples } from './samples';

const SAMPLE_RATE = 44100;
const TAIL_SECONDS = 1.6;
const MAX_LOOPS = 32;
const MAX_SCHEDULED_NOTES = 20000;

export function exportLimits(project: Project, loops: number): { ok: true; seconds: number } | { ok: false; message: string } {
  if (!Number.isInteger(loops) || loops < 1 || loops > MAX_LOOPS) {
    return { ok: false, message: `循环次数只能是 1 到 ${MAX_LOOPS}` };
  }
  const seconds = loops * STEPS * stepSeconds(project.tempo) + TAIL_SECONDS;
  if (seconds > 300) return { ok: false, message: '导出长度不能超过 5 分钟' };
  const scheduled = project.patterns
    .find((pattern) => pattern.id === project.patternId)
    ?.notes.filter((note) => note.start < RESOLUTION).length ?? 0;
  if (scheduled * loops > MAX_SCHEDULED_NOTES) {
    return { ok: false, message: `音符太多（约 ${(scheduled * loops).toLocaleString('zh-Hans-CN')} 个），减少循环次数或删掉一些音` };
  }
  return { ok: true, seconds };
}

function encodeWav(buffer: AudioBuffer): Blob {
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const bytesPerSample = 2;
  const dataSize = frames * channels * bytesPerSample;
  const view = new DataView(new ArrayBuffer(44 + dataSize));

  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };

  text(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  text(36, 'data');
  view.setUint32(40, dataSize, true);

  const sources: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel += 1) sources.push(buffer.getChannelData(channel));

  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (const channel of sources) {
      // 不削波的话 16 bit 会直接环绕成爆音，这里宁可压平。
      const sample = Math.max(-1, Math.min(1, channel[frame]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}

export type RenderResult = { blob: Blob; seconds: number } | { error: string };

// getSample 必须是同步的，所以调用方先 await prepareForRender 把采样解码好。
export async function renderWav(
  project: Project,
  loops: number,
  samples: Pick<Samples, 'prepare' | 'bufferFor'>
): Promise<RenderResult> {
  const limit = exportLimits(project, loops);
  if (!limit.ok) return { error: limit.message };

  const pattern = project.patterns.find((item) => item.id === project.patternId);
  if (!pattern || pattern.notes.length === 0) return { error: '这个模式还是空的' };

  const sampleIds = project.tracks
    .filter((track) => track.kind === 'sample' && track.sampleId)
    .map((track) => track.sampleId as string);

  const offline = new OfflineAudioContext(2, Math.ceil(limit.seconds * SAMPLE_RATE), SAMPLE_RATE);
  // 采样要在这个离线上下文上重解一次，然后引擎才能同步取到。
  await samples.prepare(offline, sampleIds);
  const engine = createEngine(offline, (id) => samples.bufferFor(offline, id));
  engine.setMaster(project.masterGain);

  const audible = audibleTracks(project.tracks);
  const secondsOfStep = stepSeconds(project.tempo);
  const secondsOfTick = tickSeconds(project.tempo);
  const barSeconds = STEPS * secondsOfStep;

  // 和实时播放同一套算法：逐整步排音符，swing 只推落在后半拍的整步。
  for (let loop = 0; loop < loops; loop += 1) {
    for (let step = 0; step < STEPS; step += 1) {
      const origin = loop * barSeconds + step * secondsOfStep;
      for (const note of pattern.notes) {
        if (Math.floor(note.start / PPQ) !== step) continue;
        const track = audible.get(note.trackId);
        if (!track) continue;
        const offsetTicks = note.start - step * PPQ;
        const play: EngineNote = engineNote(note, track, track.gain, secondsOfTick);
        engine.playNote(play, origin + offsetTicks * secondsOfTick + swingDelay(step, offsetTicks, project.swing, secondsOfStep));
      }
    }
  }

  const rendered = await offline.startRendering();
  return { blob: encodeWav(rendered), seconds: limit.seconds };
}
