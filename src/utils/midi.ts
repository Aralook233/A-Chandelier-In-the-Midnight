// 极简 Standard MIDI File 读取 + WebAudio 合成。
//
// 为什么自己写：`<audio>` 元素解不了 .mid，而现成的 MIDI 播放库要么带几十 MB 的
// SoundFont，要么把 Tone.js 整包拖进来。电台这里只需要「按下播放能听见这首歌」，
// 所以只解析 SMF 的 note on/off、program change 和 tempo meta，用振荡器按 GM
// 音色族近似发声。
//
// 输入是用户随手选的文件，属于系统边界：解析失败一律返回 null，不做猜测。

export type MidiNote = {
  start: number;
  end: number;
  note: number;
  velocity: number;
  program: number;
  drum: boolean;
};

export type MidiSong = {
  notes: MidiNote[];
  duration: number;
};

type RawNote = {
  startTick: number;
  endTick: number;
  note: number;
  velocity: number;
  program: number;
  drum: boolean;
};

const midiNamePattern = /\.(mid|midi)$/i;
// 一次排满几万个振荡器会把手机卡死，宁可只弹前一段。
const maxNotes = 2500;
const defaultTempoMicroseconds = 500000;

export function isMidiName(name: string): boolean {
  return midiNamePattern.test(name);
}

function hzOf(midiNote: number): number {
  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

function waveFor(note: MidiNote): OscillatorType {
  if (note.drum) return 'triangle';
  const family = Math.floor(note.program / 8);
  // GM 每 8 个程序一族：4 是贝斯，5-7 是弦乐/铜管/木管，8-11 是合成器。
  if (family === 4) return 'sine';
  if (family >= 5 && family <= 7) return 'sawtooth';
  if (family >= 8 && family <= 11) return 'square';
  return 'triangle';
}

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

function readVarInt(view: DataView, at: number): { value: number; next: number } {
  let value = 0;
  let cursor = at;
  for (;;) {
    const byte = view.getUint8(cursor);
    cursor += 1;
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return { value, next: cursor };
  }
}

export function parseMidi(buffer: ArrayBuffer): MidiSong | null {
  try {
    const view = new DataView(buffer);
    if (buffer.byteLength < 14 || readTag(view, 0) !== 'MThd') return null;

    const division = view.getUint16(12);
    // SMPTE 时间轴（division 高位为 1）的 tick 不是「每拍多少分」，不做换算。
    if (division & 0x8000) return null;

    const tempos: { tick: number; microseconds: number }[] = [];
    const notes: RawNote[] = [];
    const programs = new Array<number>(16).fill(0);
    const held = new Map<number, { tick: number; note: number; velocity: number; channel: number }>();
    let maxTick = 0;

    let cursor = 8 + view.getUint32(4);
    while (cursor + 8 <= buffer.byteLength) {
      const chunkType = readTag(view, cursor);
      const chunkEnd = Math.min(cursor + 8 + view.getUint32(cursor + 4), buffer.byteLength);

      if (chunkType === 'MTrk') {
        let tick = 0;
        let runningStatus = 0;
        let at = cursor + 8;

        while (at < chunkEnd) {
          const delta = readVarInt(view, at);
          at = delta.next;
          tick += delta.value;
          if (tick > maxTick) maxTick = tick;

          let status = view.getUint8(at);
          if (status < 0x80) {
            status = runningStatus;
          } else {
            at += 1;
            if (status < 0xf0) runningStatus = status;
          }

          if (status === 0xff) {
            const metaType = view.getUint8(at);
            at += 1;
            const meta = readVarInt(view, at);
            at = meta.next;
            if (metaType === 0x51) {
              const microseconds = (view.getUint8(at) << 16) | (view.getUint8(at + 1) << 8) | view.getUint8(at + 2);
              tempos.push({ tick, microseconds: microseconds || defaultTempoMicroseconds });
            }
            at += meta.value;
            if (metaType === 0x2f) break;
            continue;
          }

          if (status === 0xf0 || status === 0xf7) {
            const sys = readVarInt(view, at);
            at = sys.next + sys.value;
            continue;
          }

          const kind = status & 0xf0;
          const channel = status & 0x0f;

          if (kind === 0x90) {
            const key = view.getUint8(at);
            const velocity = view.getUint8(at + 1);
            at += 2;
            const lane = channel * 128 + key;
            if (velocity > 0) {
              const previous = held.get(lane);
              if (previous) {
                notes.push({ startTick: previous.tick, endTick: tick, note: previous.note, velocity: previous.velocity, program: programs[previous.channel], drum: previous.channel === 9 });
              }
              held.set(lane, { tick, note: key, velocity, channel });
            } else {
              const started = held.get(lane);
              if (started) {
                notes.push({ startTick: started.tick, endTick: tick, note: started.note, velocity: started.velocity, program: programs[started.channel], drum: started.channel === 9 });
                held.delete(lane);
              }
            }
            continue;
          }

          if (kind === 0x80) {
            const key = view.getUint8(at);
            at += 2;
            const lane = channel * 128 + key;
            const started = held.get(lane);
            if (started) {
              notes.push({ startTick: started.tick, endTick: tick, note: started.note, velocity: started.velocity, program: programs[started.channel], drum: started.channel === 9 });
              held.delete(lane);
            }
            continue;
          }

          if (kind === 0xc0 || kind === 0xd0) {
            if (kind === 0xc0) programs[channel] = view.getUint8(at);
            at += 1;
            continue;
          }

          if (kind === 0xb0 || kind === 0xe0) {
            at += 2;
            continue;
          }

          // 认不出的事件：再往下读只会读到噪声，收在这条轨道的末尾。
          break;
        }
      }

      cursor = chunkEnd;
    }

    for (const started of held.values()) {
      notes.push({ startTick: started.tick, endTick: maxTick, note: started.note, velocity: started.velocity, program: programs[started.channel], drum: started.channel === 9 });
    }
    if (notes.length === 0) return null;

    const marks = [{ tick: 0, seconds: 0, microseconds: defaultTempoMicroseconds }, ...tempos.sort((a, b) => a.tick - b.tick)];
    for (let index = 1; index < marks.length; index += 1) {
      const previous = marks[index - 1];
      const current = marks[index];
      current.seconds = previous.seconds + ((current.tick - previous.tick) / division) * (previous.microseconds / 1e6);
    }
    const secondsAt = (tick: number) => {
      let segment = marks[0];
      for (let index = 1; index < marks.length; index += 1) {
        if (marks[index].tick > tick) break;
        segment = marks[index];
      }
      return segment.seconds + ((tick - segment.tick) / division) * (segment.microseconds / 1e6);
    };

    const timed = notes
      .map((raw) => ({
        start: secondsAt(raw.startTick),
        end: secondsAt(raw.endTick),
        note: raw.note,
        velocity: raw.velocity,
        program: raw.program,
        drum: raw.drum,
      }))
      .filter((note) => note.end > note.start && note.note >= 0 && note.note < 128)
      .sort((a, b) => a.start - b.start)
      .slice(0, maxNotes);

    if (timed.length === 0) return null;

    return {
      notes: timed,
      duration: timed.reduce((latest, note) => Math.max(latest, note.end), 0),
    };
  } catch {
    return null;
  }
}

export type MidiPlayer = {
  duration: number;
  start: (from?: number) => void;
  pause: () => void;
  seek: (seconds: number) => void;
  position: () => number;
};

export function createMidiPlayer(context: AudioContext, output: AudioNode, song: MidiSong): MidiPlayer {
  // startedAt > 0 表示正在排期；offset 是那一段起点相对歌曲的时间。
  let startedAt = 0;
  let offset = 0;
  let pausedAt = 0;
  let voices: { oscillator: OscillatorNode; gain: GainNode }[] = [];

  const silence = () => {
    const now = context.currentTime;
    for (const voice of voices) {
      try {
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setTargetAtTime(0, now, 0.01);
        voice.oscillator.stop(now + 0.05);
      } catch {
        // 已经停掉的音符不需要第二次停止。
      }
    }
    voices = [];
    startedAt = 0;
  };

  const schedule = (from: number) => {
    const origin = context.currentTime + 0.05;
    startedAt = origin;
    offset = from;

    for (const note of song.notes) {
      if (note.end <= from) continue;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const at = origin + Math.max(0, note.start - from);
      const length = Math.max(0.05, note.end - Math.max(note.start, from));
      const peak = (note.drum ? 0.5 : 0.2) * (0.25 + (0.75 * note.velocity) / 127);

      oscillator.type = waveFor(note);
      oscillator.frequency.value = hzOf(note.note);

      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(peak, at + Math.min(0.02, length * 0.2));
      // 打击族一路衰减到静音，持续族落到保持音量等下一次包络。
      gain.gain.setTargetAtTime(note.drum ? 0.0001 : peak * 0.6, at + Math.min(0.05, length * 0.4), note.drum ? 0.06 : 0.3);
      gain.gain.setTargetAtTime(0.0001, at + length, 0.04);

      oscillator.connect(gain);
      gain.connect(output);
      oscillator.start(at);
      oscillator.stop(at + length + 0.14);
      voices.push({ oscillator, gain });
    }
  };

  const position = () => {
    // 排期比 currentTime 早 50ms，刚按下播放时这段差值会是负的，别让仪表读到负数。
    if (startedAt > 0) return Math.max(0, Math.min(offset + (context.currentTime - startedAt), song.duration));
    return pausedAt;
  };

  return {
    duration: song.duration,
    start: (from?: number) => {
      silence();
      schedule(Math.max(0, Math.min(from ?? pausedAt, song.duration)));
    },
    pause: () => {
      pausedAt = position();
      silence();
    },
    seek: (seconds: number) => {
      const target = Math.max(0, Math.min(seconds, song.duration));
      const wasPlaying = startedAt > 0;
      // 先掐掉旧音色，否则已经排期的音符会继续按老位置响。
      silence();
      if (wasPlaying) {
        schedule(target);
      } else {
        pausedAt = target;
      }
    },
    position,
  };
}
