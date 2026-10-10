// 工作室的装配层：DOM ↔ 状态 ↔ 声音。
//
// 状态只有 project 一个对象，改完一律走 commit()：重绘 + 去抖保存。
// 不引框架、不做撤销栈——Astro 已经把脚本打成同源模块，一个 render 函数够用，
// 多引一层响应式只会让 CSP 的立场变复杂。
//
// 所有插进 innerHTML 的用户可控文本（轨道名、采样名、模式名）一律过 escapeHtml，
// 和留言区同一套规矩。

import { escapeHtml } from '../sanitize';
import { createEngine } from './engine';
import { createTransport, type Transport } from './scheduler';
import { createSamples } from './samples';
import { createRoll } from './piano-roll';
import { renderWav } from './wav-export';
import { clearTrack, currentPattern, toggleCell, trackNotes, trackStrengths } from './notes';
import { loadProject, saveProject, clearProject } from './store';
import {
  DRUM_VOICES,
  MAX_OCTAVE,
  MAX_PATTERNS,
  MAX_TRACKS,
  MIN_OCTAVE,
  STEPS,
  SYNTH_VOICES,
  defaultProject,
  newId,
  rollSnapTicks,
  type DrumKind,
  type SynthKind,
  type Track,
  type TrackKind,
  type VoiceKind,
} from './types';

const SAVE_DEBOUNCE_MS = 500;

const need = <T extends HTMLElement>(root: ParentNode, selector: string): T | null =>
  root.querySelector<T>(selector);

const options = (items: { kind: string; label: string }[], selected: string | undefined): string =>
  items
    .map((item) => `<option value="${escapeHtml(item.kind)}"${item.kind === selected ? ' selected' : ''}>${escapeHtml(item.label)}</option>`)
    .join('');

export function mountStudio(root: HTMLElement): void {
  const gridHost = need<HTMLElement>(root, '#stepGrid');
  const rollHost = need<HTMLElement>(root, '#roll');
  const mixerHost = need<HTMLElement>(root, '#mixer');
  const sampleHost = need<HTMLElement>(root, '#sampleList');
  const patternHost = need<HTMLElement>(root, '#patterns');
  const statusHost = need<HTMLElement>(root, '#status');
  const playButton = need<HTMLButtonElement>(root, '#play');
  const tempoInput = need<HTMLInputElement>(root, '#tempo');
  const swingInput = need<HTMLInputElement>(root, '#swing');
  const masterInput = need<HTMLInputElement>(root, '#master');
  const octaveInput = need<HTMLSelectElement>(root, '#octave');
  const velocityInput = need<HTMLSelectElement>(root, '#gridVelocity');
  const rollSnapInput = need<HTMLSelectElement>(root, '#rollSnap');
  const rollPanel = need<HTMLDetailsElement>(root, '#rollPanel');
  const loopsInput = need<HTMLSelectElement>(root, '#loops');
  const exportButton = need<HTMLButtonElement>(root, '#exportWav');
  const sampleInput = need<HTMLInputElement>(root, '#sampleFiles');
  const stepReadout = need<HTMLElement>(root, '#stepReadout');
  const trackSelect = need<HTMLElement>(root, '#trackSelect');

  if (!gridHost || !rollHost || !mixerHost || !patternHost || !playButton) return;

  const storage = typeof localStorage === 'undefined' ? undefined : localStorage;
  const loaded = loadProject(storage);
  let project = loaded.project;
  let selectedTrackId = project.tracks[0]?.id ?? null;
  let selectedIds = new Set<string>();
  let saveTimer = 0;
  let lastBlob: Blob | null = null;

  const samples = createSamples();

  let context: AudioContext | null = null;
  let limiter: GainNode | null = null;
  let engine: ReturnType<typeof createEngine> | null = null;
  let transport: Transport = idleTransport();

  let headStep = 0;
  let headFrame = 0;
  let paintedStep = -1;

  const announce = (message: string) => {
    if (statusHost) statusHost.textContent = message;
  };

  // 八度 0 → 可见 C1–C3；卷帘显示 25 行，约两个八度。
  const topNote = (): number => Math.min(127, 24 + (project.octave + 1) * 12);

  function idleTransport(): Transport {
    return { playing: () => false, start: () => undefined, stop: () => undefined, step: () => 0 };
  }

  // 找一个能把这批音高整个装进 25 行窗口的八度，从低往高取第一个。
  const fitOctave = (pitches: { note: number }[]): number | null => {
    if (pitches.length === 0) return null;
    const low = Math.min(...pitches.map((item) => item.note));
    const high = Math.max(...pitches.map((item) => item.note));
    for (let value = MIN_OCTAVE; value <= MAX_OCTAVE; value += 1) {
      const top = 24 + (value + 1) * 12;
      if (high <= top && low >= top - 24) return value;
    }
    // 跨度超过两个八度：让最低的音落在底行，至少低的那半边看得见。
    return Math.max(MIN_OCTAVE, Math.min(MAX_OCTAVE, Math.floor(low / 12) - 3));
  };

  // 卷帘只显示两个八度，音符落在窗口外就一条都看不见，像是编辑区坏了
  // （默认工程的贝斯在 C2，网格给采样轨起的音是 C4，都会撞到这种情况）。
  // 只在「当前窗口已经装不下这条轨」时吸一次八度，装得下就不动用户自己拧的值。
  const fitViewToTrack = () => {
    const track = project.tracks.find((item) => item.id === selectedTrackId);
    if (!track || track.kind === 'drum') return;
    const notes = trackNotes(project, track.id);
    if (notes.length === 0) return;
    const top = topNote();
    if (notes.every((item) => item.note <= top && item.note >= top - 24)) return;
    const fitted = fitOctave(notes);
    if (fitted !== null) project.octave = fitted;
  };

  // ---- 渲染 ---------------------------------------------------------------

  const renderPatterns = () => {
    patternHost.innerHTML = project.patterns
      .map(
        (pattern) =>
          `<button type="button" class="pattern-tab${pattern.id === project.patternId ? ' is-active' : ''}" data-pattern="${escapeHtml(pattern.id)}">${escapeHtml(pattern.name)}</button>`
      )
      .join('');
  };

  const renderTracks = () => {
    if (!trackSelect) return;
    trackSelect.innerHTML = project.tracks
      .map(
        (track) =>
          `<button type="button" class="track-tab${track.id === selectedTrackId ? ' is-active' : ''}" data-track="${escapeHtml(track.id)}">${escapeHtml(track.name)}</button>`
      )
      .join('');
  };

  const renderGrid = () => {
    gridHost.innerHTML = project.tracks
      .map((track) => {
        const strengths = trackStrengths(project, track.id);
        const cells = strengths
          .map(
            (level, step) =>
              `<button type="button" class="grid-cell strength-${level}" data-step="${step}" data-cell="${escapeHtml(track.id)}:${step}" aria-pressed="${level > 0}" aria-label="${escapeHtml(track.name)} 第 ${step + 1} 步"></button>`
          )
          .join('');
        return `<div class="grid-row${track.id === selectedTrackId ? ' is-selected' : ''}" data-row="${escapeHtml(track.id)}">` +
          `<button type="button" class="grid-name" data-audition="${escapeHtml(track.id)}" title="单击试听 · 双击拿去卷帘改音高">${escapeHtml(track.name)}</button>` +
          `<div class="grid-cells">${cells}</div>` +
          '</div>';
      })
      .join('');
  };

  const renderMixer = () => {
    mixerHost.innerHTML = project.tracks
      .map((track) => {
        const control =
          `<input type="text" class="mix-name" data-field="name" value="${escapeHtml(track.name)}" aria-label="轨道名" maxlength="24" />` +
          `<select data-field="kind" aria-label="轨道类型">${options(
            [
              { kind: 'drum', label: '打击乐' },
              { kind: 'pitch', label: '旋律' },
              { kind: 'sample', label: '采样' },
            ],
            track.kind
          )}</select>`;
        const voice =
          track.kind === 'drum'
            ? `<select data-field="voice" aria-label="鼓音色">${options(DRUM_VOICES, track.voice)}</select>`
            : track.kind === 'pitch'
              ? `<select data-field="voice" aria-label="合成音色">${options(SYNTH_VOICES, track.voice)}</select>`
              : `<span class="mix-static">采样发声</span>`;
        const sample =
          track.kind === 'sample'
            ? `<select data-field="sampleId" aria-label="选用采样">${options(
                samples.metas().map((meta) => ({ kind: meta.id, label: meta.name })),
                track.sampleId
              )}</select>`
            : '';
        return `<div class="mix-row${track.id === selectedTrackId ? ' is-selected' : ''}" data-track="${escapeHtml(track.id)}">` +
          `<span class="mix-pick" data-pick="${escapeHtml(track.id)}" role="button" tabindex="0">选</span>` +
          control +
          voice +
          sample +
          `<input type="range" data-field="gain" min="0" max="1.3" step="0.01" value="${track.gain}" aria-label="音量" /><output class="mix-gain">${Math.round(track.gain * 100)}%</output>` +
          `<button type="button" data-action="mute" aria-pressed="${track.muted}">静</button>` +
          `<button type="button" data-action="solo" aria-pressed="${track.solo}">独</button>` +
          `<button type="button" data-action="audition">试听</button>` +
          `<button type="button" data-action="clear">清轨</button>` +
          '<button type="button" data-action="remove">删轨</button>' +
          '</div>';
      })
      .join('');
  };

  const renderSamples = () => {
    if (!sampleHost) return;
    const list = samples.metas();
    sampleHost.innerHTML = list.length === 0 ? '<p class="sample-empty">还没有采样。导入的都是本机文件，只存在这台浏览器的 IndexedDB 里。</p>' : '';
    for (const meta of list) {
      const row = document.createElement('div');
      row.className = 'sample-row';
      const label = document.createElement('span');
      label.textContent = `${meta.name} · ${meta.duration.toFixed(2)} 秒 · ${(meta.bytes / 1024 / 1024).toFixed(2)} MB`;
      const use = document.createElement('button');
      use.type = 'button';
      use.dataset.useSample = meta.id;
      use.textContent = '设为采样轨';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.dropSample = meta.id;
      remove.textContent = '删除';
      row.append(label, use, remove);
      sampleHost.append(row);
    }
  };

  const renderControls = () => {
    if (tempoInput) tempoInput.value = String(project.tempo);
    if (swingInput) swingInput.value = String(project.swing);
    if (masterInput) masterInput.value = String(project.masterGain);
    if (velocityInput) velocityInput.value = String(project.gridVelocity);
    if (rollSnapInput) rollSnapInput.value = String(project.rollSnap);
    if (octaveInput) {
      octaveInput.innerHTML = Array.from({ length: MAX_OCTAVE - MIN_OCTAVE + 1 }, (_, index) => {
        const value = MIN_OCTAVE + index;
        return `<option value="${value}"${value === project.octave ? ' selected' : ''}>第 ${value + 1} 组</option>`;
      }).join('');
    }
  };

  const render = () => {
    renderPatterns();
    renderTracks();
    renderGrid();
    renderMixer();
    renderControls();
    roll.render();
  };

  function commit(): void {
    fitViewToTrack();
    render();
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      if (!saveProject(storage, project)) announce('存档没写进去：浏览器拒绝了 localStorage');
    }, SAVE_DEBOUNCE_MS);
  }

  const roll = createRoll({
    root: rollHost,
    state: () => ({ project, trackId: selectedTrackId, topNote: topNote() }),
    changed: commit,
    preview: (note) => audition(note),
    selected: () => selectedIds,
    select: (ids) => {
      selectedIds = ids;
    },
  });

  // ---- 声音 ---------------------------------------------------------------

  // 第一次播放才建 AudioContext：浏览器在用户手势之前不让出声，
  // 提前建只会得到一个 suspended 的上下文和一条控制台警告。
  async function ensureAudio(): Promise<boolean> {
    if (context) {
      if (context.state === 'suspended') await context.resume();
      return true;
    }
    try {
      context = new AudioContext({ latencyHint: 'interactive' });
    } catch {
      announce('这台浏览器不让网页出声（AudioContext 不可用）');
      return false;
    }
    limiter = context.createGain();
    limiter.gain.value = 1;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -8;
    compressor.knee.value = 12;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.16;
    limiter.connect(compressor);
    compressor.connect(context.destination);

    engine = createEngine(context, (id) => samples.bufferFor(context as AudioContext, id));
    engine.output.connect(limiter);
    engine.setMaster(project.masterGain);

    transport = createTransport({
      context,
      tracks: () => project.tracks,
      notes: () => currentPattern(project).notes,
      tempo: () => project.tempo,
      swing: () => project.swing,
      play: (note, when) => engine?.playNote(note, when),
      // 停止时把已经排期的长音（铺垫这类）收掉，否则按下停止还会响完一小节。
      silence: () => {
        if (!context || !limiter) return;
        const now = context.currentTime;
        limiter.gain.cancelScheduledValues(now);
        limiter.gain.setValueAtTime(0, now);
        limiter.gain.setValueAtTime(0, now + 0.08);
        limiter.gain.linearRampToValueAtTime(1, now + 0.16);
      },
      stepOffset: () => headStep,
      onPlay: () => {
        playButton?.setAttribute('data-playing', 'true');
        startHeadLoop();
      },
      onStop: () => {
        playButton?.setAttribute('data-playing', 'false');
        stopHeadLoop();
      },
    });

    if (!samples.ready()) {
      const result = await samples.load(context);
      if (result.failed.length > 0) announce(`有 ${result.failed.length} 个采样读不出来，需要重新导入`);
      renderSamples();
      renderMixer();
    }
    return true;
  }

  // 单音试听：网格行名、卷帘键盘、混音器都靠它确认「这条轨就是这个声音」。
  function audition(note: number, trackId?: string): void {
    void ensureAudio().then((ready) => {
      if (!ready || !engine || !context) return;
      const track = project.tracks.find((item) => item.id === (trackId ?? selectedTrackId));
      if (!track) return;
      engine.playNote(
        {
          kind: track.kind,
          voice: track.voice,
          sampleId: track.sampleId,
          gain: track.gain,
          start: 0,
          length: 0.3,
          note,
          velocity: 112,
        },
        context.currentTime + 0.01
      );
    });
  }

  // ---- 播放头 -------------------------------------------------------------

  const paintHead = (step: number) => {
    if (step === paintedStep) return;
    paintedStep = step;
    for (const cell of Array.from(gridHost.querySelectorAll('.grid-cell.is-current'))) cell.classList.remove('is-current');
    for (const cell of Array.from(gridHost.querySelectorAll(`.grid-cell[data-step="${step}"]`))) cell.classList.add('is-current');
    if (stepReadout) stepReadout.textContent = String(step + 1);
    // 播放头只给比例，像素换算交给 CSS 的 calc（键名列宽度只有样式表知道）。
    rollHost.style.setProperty('--roll-head', String(step / STEPS));
  };

  function startHeadLoop(): void {
    if (headFrame) return;
    const tick = () => {
      if (!transport.playing()) {
        headFrame = 0;
        return;
      }
      headStep = transport.step();
      paintHead(headStep);
      headFrame = requestAnimationFrame(tick);
    };
    headFrame = requestAnimationFrame(tick);
  }

  function stopHeadLoop(): void {
    if (headFrame) cancelAnimationFrame(headFrame);
    headFrame = 0;
    paintedStep = -1;
    paintHead(0);
  }

  // ---- 轨道与模式操作 --------------------------------------------------------

  function addTrack(kind: TrackKind): void {
    if (project.tracks.length >= MAX_TRACKS) {
      announce(`轨道上限 ${MAX_TRACKS} 条`);
      return;
    }
    const voice: VoiceKind | undefined = kind === 'drum' ? 'tom' : kind === 'pitch' ? 'pluck' : undefined;
    const sample = kind === 'sample' ? samples.metas()[0] : undefined;
    if (kind === 'sample' && !sample) {
      announce('先导入一个采样，再建采样轨');
      return;
    }
    const track: Track = {
      id: newId(),
      name: `${kind === 'drum' ? '鼓' : kind === 'pitch' ? '旋律' : '采样'} ${project.tracks.length + 1}`,
      kind,
      voice,
      sampleId: sample?.id,
      gain: 0.85,
      muted: false,
      solo: false,
    };
    project.tracks.push(track);
    selectedTrackId = track.id;
    commit();
  }

  function patchTrack(id: string, patch: Partial<Track>): void {
    const track = project.tracks.find((item) => item.id === id);
    if (!track) return;
    Object.assign(track, patch);
    commit();
  }

  function newPattern(clone: boolean): void {
    if (project.patterns.length >= MAX_PATTERNS) {
      announce(`模式上限 ${MAX_PATTERNS} 个`);
      return;
    }
    const pattern = {
      id: newId(),
      name: `模式 ${project.patterns.length + 1}`,
      notes: clone ? currentPattern(project).notes.map((note) => ({ ...note, id: newId() })) : [],
    };
    project.patterns.push(pattern);
    project.patternId = pattern.id;
    commit();
  }

  // ---- 采样 ---------------------------------------------------------------

  async function importSamples(files: File[]): Promise<void> {
    if (files.length === 0) return;
    const ready = await ensureAudio();
    if (!ready || !context) return;
    announce(`正在解码 ${files.length} 个文件…`);
    const result = await samples.importFiles(context, files);
    if (result.added.length > 0) announce(`导入了 ${result.added.length} 个采样${result.rejected.length ? `，${result.rejected.length} 个被拒绝` : ''}`);
    else if (result.rejected.length > 0) announce(result.rejected[0]);
    renderSamples();
    renderMixer();
  }

  // ---- 导出 ---------------------------------------------------------------

  async function exportWav(): Promise<void> {
    if (!exportButton) return;
    const loops = Number(loopsInput?.value ?? 4);
    exportButton.disabled = true;
    announce('正在离线渲染…');
    try {
      const result = await renderWav(project, loops, samples);
      if ('error' in result) {
        announce(`导出失败：${result.error}`);
        return;
      }
      lastBlob = result.blob;
      announce(`渲染完成：约 ${result.seconds.toFixed(1)} 秒，点「保存 WAV」下载`);
    } catch (error) {
      announce(`导出失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      exportButton.disabled = false;
    }
  }

  function saveBlob(): void {
    if (!lastBlob) {
      announce('先点「导出 WAV」渲染一次');
      return;
    }
    const url = URL.createObjectURL(lastBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `chandelier-pattern-${project.patternId}.wav`;
    link.click();
    // 立刻 revoke 会让 Safari 拿不到文件，留个一秒的窗口。
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce('已开始下载');
  }

  // ---- 事件 ---------------------------------------------------------------

  playButton?.addEventListener('click', () => {
    void ensureAudio().then((ready) => {
      if (!ready) return;
      if (transport.playing()) transport.stop();
      else transport.start();
    });
  });

  // 旋律/采样轨在网格里落点时沿用这条轨最近画过的那个音高：
  // 网格只管把旋律排出形状，改音高是卷帘的事，不必每格都回卷帘拧八度。
  const gridNoteFor = (track: Track): number => {
    if (track.kind === 'drum') return 60;
    const notes = trackNotes(project, track.id);
    if (notes.length === 0) return topNote() - 12;
    return notes.reduce((latest, item) => (item.start >= latest.start ? item : latest), notes[0]).note;
  };

  const paintSelection = () => {
    for (const row of Array.from(gridHost.querySelectorAll<HTMLElement>('.grid-row'))) {
      row.classList.toggle('is-selected', row.dataset.row === selectedTrackId);
    }
    for (const tab of Array.from(trackSelect?.querySelectorAll<HTMLElement>('.track-tab') ?? [])) {
      tab.classList.toggle('is-active', tab.dataset.track === selectedTrackId);
    }
    for (const row of mixerHost.querySelectorAll<HTMLElement>('.mix-row')) {
      row.classList.toggle('is-selected', row.dataset.track === selectedTrackId);
    }
  };

  // 选中一条轨，但不重建网格。重建会把行名节点换成新的，双击的第二下就打在已经离开的
  // 节点上，浏览器发不出 dblclick——「双击行名进卷帘」这个手势正是这样丢的。
  function selectTrack(trackId: string): void {
    if (!project.tracks.some((item) => item.id === trackId)) return;
    selectedTrackId = trackId;
    fitViewToTrack();
    paintSelection();
    // 八度可能被 fitViewToTrack 吸过去了，下拉框得跟着走，不然显示的和卷帘画的不是一回事。
    renderControls();
    roll.render();
    scheduleSave();
  }

  gridHost.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const nameButton = target.closest<HTMLElement>('[data-audition]');
    if (nameButton) {
      const id = nameButton.dataset.audition ?? '';
      selectTrack(id);
      audition(60, id);
      return;
    }
    const cell = target.closest<HTMLElement>('.grid-cell');
    if (!cell) return;
    const [trackId, stepText] = (cell.dataset.cell ?? ':').split(':');
    const step = Number(stepText);
    if (!trackId || !Number.isFinite(step)) return;
    const track = project.tracks.find((item) => item.id === trackId);
    if (!track) return;
    selectedTrackId = trackId;
    const note = gridNoteFor(track);
    const result = toggleCell(project, trackId, step, note, project.gridVelocity);
    if (result === 'added') audition(note, trackId);
    commit();
  });

  // 双击行名 = 把这条轨送到卷帘里去改音高。单击仍然只试听，两者不冲突。
  gridHost.addEventListener('dblclick', (event) => {
    const nameButton = (event.target as HTMLElement).closest<HTMLElement>('[data-audition]');
    if (!nameButton) return;
    event.preventDefault();
    openRollFor(nameButton.dataset.audition ?? '');
  });

  function openRollFor(trackId: string): void {
    const track = project.tracks.find((item) => item.id === trackId);
    if (!track) return;
    selectedIds = new Set();
    selectTrack(trackId);
    if (rollPanel) rollPanel.open = true;
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    rollPanel?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    announce(
      track.kind === 'drum'
        ? `${track.name}：打击轨的音高就是音色，一般在网格里编排就行`
        : `卷帘里编辑的是「${track.name}」，拖音符改音高和长度`
    );
  }

  patternHost.addEventListener('click', (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>('[data-pattern]');
    if (!tab) return;
    project.patternId = tab.dataset.pattern ?? project.patternId;
    selectedIds = new Set();
    commit();
  });

  trackSelect?.addEventListener('click', (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>('[data-track]');
    if (!tab) return;
    selectedTrackId = tab.dataset.track ?? selectedTrackId;
    selectedIds = new Set();
    commit();
  });

  mixerHost.addEventListener('input', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.mix-row');
    const id = row?.dataset.track;
    if (!id) return;
    const field = (event.target as HTMLElement).getAttribute('data-field');
    const track = project.tracks.find((item) => item.id === id);
    if (!track || !field) return;
    const value = (event.target as HTMLInputElement).value;
    if (field === 'name') track.name = value.slice(0, 24);
    if (field === 'gain') track.gain = Math.max(0, Math.min(1.3, Number(value) || 0));
    if (field === 'voice') track.voice = value as VoiceKind;
    if (field === 'sampleId') track.sampleId = value;
    if (field === 'kind') {
      const kind = value as TrackKind;
      track.kind = kind;
      if (kind === 'drum') track.voice = (track.voice && DRUM_VOICES.some((item) => item.kind === track.voice) ? track.voice : 'kick') as DrumKind;
      if (kind === 'pitch') track.voice = (track.voice && SYNTH_VOICES.some((item) => item.kind === track.voice) ? track.voice : 'lead') as SynthKind;
      if (kind === 'sample') track.sampleId = track.sampleId ?? samples.metas()[0]?.id;
    }
    // 只有改名字以外的字段才整表重绘：重绘会把正在输入的框吹掉。
    if (field === 'kind') commit();
    else {
      renderGrid();
      const output = row.querySelector<HTMLElement>('.mix-gain');
      if (output && field === 'gain') output.textContent = `${Math.round(track.gain * 100)}%`;
      scheduleSave();
    }
  });

  mixerHost.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>('.mix-row');
    const id = row?.dataset.track;
    if (!id) return;
    const track = project.tracks.find((item) => item.id === id);
    if (!track) return;

    if (target.dataset.pick) {
      selectedTrackId = id;
      commit();
      return;
    }
    const action = target.getAttribute('data-action');
    if (action === 'mute') patchTrack(id, { muted: !track.muted });
    if (action === 'solo') patchTrack(id, { solo: !track.solo });
    if (action === 'audition') audition(60, id);
    if (action === 'clear') {
      const removed = clearTrack(project, id);
      announce(`清掉了 ${removed} 个音`);
      commit();
    }
    if (action === 'remove') {
      if (project.tracks.length <= 1) {
        announce('至少要留一条轨道');
        return;
      }
      project.tracks = project.tracks.filter((item) => item.id !== id);
      project.patterns.forEach((pattern) => {
        pattern.notes = pattern.notes.filter((note) => note.trackId !== id);
      });
      if (selectedTrackId === id) selectedTrackId = project.tracks[0]?.id ?? null;
      commit();
    }
  });

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const action = target.dataset.action;
    if (!action) return;
    if (action === 'add-drum') addTrack('drum');
    if (action === 'add-pitch') addTrack('pitch');
    if (action === 'add-sample') addTrack('sample');
    if (action === 'new-pattern') newPattern(false);
    if (action === 'clone-pattern') newPattern(true);
    if (action === 'clear-pattern') {
      currentPattern(project).notes = [];
      announce('当前模式已清空');
      commit();
    }
    if (action === 'clear-track') {
      if (selectedTrackId) announce(`清掉了 ${clearTrack(project, selectedTrackId)} 个音`);
      commit();
    }
    if (action === 'export-wav') void exportWav();
    if (action === 'save-wav') saveBlob();
    if (action === 'reset-project') {
      project = defaultProject();
      selectedTrackId = project.tracks[0]?.id ?? null;
      selectedIds = new Set();
      clearProject(storage);
      announce('回到初始状态（采样还在采样库里）');
      render();
    }
    if (action === 'velocity-up' || action === 'velocity-down') {
      const delta = action === 'velocity-up' ? 8 : -8;
      const pattern = currentPattern(project);
      let touched = 0;
      for (const note of pattern.notes) {
        if (!selectedIds.has(note.id)) continue;
        note.velocity = Math.max(1, Math.min(127, note.velocity + delta));
        touched += 1;
      }
      announce(touched > 0 ? `${touched} 个音符的力度已调整` : '先在卷帘里选中音符，再调力度');
      commit();
    }
  });

  sampleInput?.addEventListener('change', () => {
    const files = Array.from(sampleInput.files ?? []);
    sampleInput.value = '';
    void importSamples(files);
  });

  sampleHost?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const use = target.dataset.useSample;
    const drop = target.dataset.dropSample;
    if (use) {
      const track: Track = {
        id: newId(),
        name: samples.metas().find((meta) => meta.id === use)?.name.slice(0, 24) ?? '采样',
        kind: 'sample',
        sampleId: use,
        gain: 0.9,
        muted: false,
        solo: false,
      };
      project.tracks.push(track);
      selectedTrackId = track.id;
      commit();
    }
    if (drop) {
      void samples.drop(drop).then(() => {
        for (const track of project.tracks) {
          if (track.kind === 'sample' && track.sampleId === drop) {
            track.kind = 'pitch';
            track.voice = 'lead';
            track.sampleId = undefined;
          }
        }
        announce('采样已删除，引用它的轨道改回了合成器');
        renderSamples();
        renderMixer();
      });
    }
  });

  for (const control of [tempoInput, swingInput, masterInput]) {
    control?.addEventListener('input', () => {
      if (control === tempoInput) project.tempo = Math.max(40, Math.min(240, Math.round(Number(control.value) || 120)));
      if (control === swingInput) project.swing = Math.max(0, Math.min(0.6, Number(control.value) || 0));
      if (control === masterInput) {
        project.masterGain = Math.max(0, Math.min(1.3, Number(control.value) || 0));
        engine?.setMaster(project.masterGain);
      }
      // 速度一改就影响正在排的小节，传输层下一步会按新值继续，不用重启。
      scheduleSave();
    });
  }

  octaveInput?.addEventListener('change', () => {
    project.octave = Math.max(MIN_OCTAVE, Math.min(MAX_OCTAVE, Number(octaveInput.value) || 0));
    roll.render();
    scheduleSave();
  });

  // 力度框只管「接下来放进去的音」，已有的音不去动：那些要在卷帘里选中了调。
  velocityInput?.addEventListener('change', () => {
    project.gridVelocity = Math.max(1, Math.min(127, Math.round(Number(velocityInput.value) || 95)));
    renderGrid();
    scheduleSave();
  });

  // 吸附同理：改的是「接下来落在哪」，已经画歪的音要靠拖它一下自动吸正，不批量动数据。
  rollSnapInput?.addEventListener('change', () => {
    project.rollSnap = rollSnapTicks(rollSnapInput.value);
    roll.render();
    scheduleSave();
  });

  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((event.target as HTMLElement).tagName);
    if (event.code === 'Space' && !typing) {
      event.preventDefault();
      playButton?.click();
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !typing && selectedIds.size > 0) {
      const pattern = currentPattern(project);
      pattern.notes = pattern.notes.filter((note) => !selectedIds.has(note.id));
      selectedIds = new Set();
      commit();
    }
  });

  function scheduleSave(): void {
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      saveProject(storage, project);
    }, SAVE_DEBOUNCE_MS);
  }

  // ---- 起步 ---------------------------------------------------------------

  render();
  renderSamples();
  paintHead(0);
  // 采样轨可能在上次会话里就建好了：先把 IndexedDB 的记录读进内存，
  // 否则列表显示「还没有采样」，而混音台上明明白白挂着一条采样轨。
  void samples.hydrate().then((count) => {
    if (count > 0) {
      renderSamples();
      renderMixer();
    }
    const orphan = project.tracks.filter(
      (track) => track.kind === 'sample' && !samples.metas().some((meta) => meta.id === track.sampleId)
    ).length;
    // 清了站点数据采样就没了，但工程还在：不说一句，听起来就像软件坏了。
    if (orphan > 0) announce(`有 ${orphan} 条采样轨的采样文件不在了，需要重新导入`);
  });
  announce(
    loaded.source === 'saved'
      ? '已读回上次的工程'
      : loaded.source === 'broken'
        ? '存档读不出来，已用初始工程'
        : `新工程，${STEPS} 步一小节 · 空格键播放`
  );
}
