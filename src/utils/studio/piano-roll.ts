// 钢琴卷帘：单轨、按整小节（16 步 × PPQ 细分）铺开。
//
// 行列尺寸由两个 CSS 变量决定（--roll-row-h 行高、--roll-tick-w 每细分宽），
// JS 只读不写死——小屏要放大触控目标，写死就会和样式打架。
// 第三个变量 --roll-snap-ticks 反过来由 JS 写（吸附粒度），样式那边只拿它当兜底值。
// 音符块的几何用 CSSOM 单属性赋值（el.style.left）：CSP 的 style-src 不含
// 'unsafe-inline'，浏览器只拦「解析 style 字符串」，不拦逐条属性赋值；
// 全站已有两处同样的写法（阅读进度条、收音机指针）在线上跑着。
//
// 指针事件统一处理鼠标/触屏/手写笔；setPointerCapture 让拖出网格后仍能继续跟踪。

import { escapeHtml } from '../sanitize';
import { PPQ, RESOLUTION, noteLabel, type Project } from './types';
import { addNote, currentPattern, moveNote, removeNote, resizeNote, trackNotes, velocityLevel } from './notes';

const ROLL_ROWS = 25;
const BLACK_PITCHES = [1, 3, 6, 8, 10];

// 吸附只作用在「写进数据」的那一刻，point() 里不吸：命中测试要是也吸，
// 按住音符的第一帧就会被弹走一格，手感像是音符自己跑了。
// 下落（floor）用于新建——音符一定罩住手指按的那一点，连点两下才删得掉；
// 就近（round）用于拖动和拉伸——那是要把音对齐到格上，往哪边吸都行。
const snapDown = (tick: number, snap: number): number => Math.floor(tick / snap) * snap;
const snapNear = (tick: number, snap: number): number => Math.round(tick / snap) * snap;

export type RollState = {
  project: Project;
  trackId: string | null;
  // 可见区最高的音（MIDI 编号），由八度控件决定。
  topNote: number;
};

export type RollOptions = {
  root: HTMLElement;
  state: () => RollState;
  changed: () => void;
  preview: (note: number) => void;
  selected: () => Set<string>;
  select: (ids: Set<string>) => void;
};

export type Roll = {
  render: () => void;
  destroy: () => void;
};

const drumTrack = (state: RollState) =>
  state.project.tracks.find((item) => item.id === state.trackId && item.kind === 'drum');

export function createRoll(options: RollOptions): Roll {
  // 一次拖拽的全部状态：pointerdown 建立，pointerup 清空。
  // deletePending = 按下去的时候这一格已经是选中状态，抬手又没挪动就删；
  // downTick/downIndex 用来判断这次到底算不算「挪动了」。
  let drag: {
    mode: 'move' | 'resize';
    id: string;
    grabTicks: number;
    deletePending: boolean;
    moved: boolean;
    downTick: number;
    downIndex: number;
  } | null = null;
  let gridSignature = '';

  const snap = (state: RollState) => Math.max(1, Math.min(RESOLUTION, Math.round(state.project.rollSnap) || PPQ));

  // 网格线全部用 repeating-linear-gradient 画，DOM 里只有 25 行 × 两个节点。
  // 每行都是一个 .roll-lane，于是「命中哪一行」由事件目标自己说明，
  // JS 不需要知道行高，行高完全归 CSS 管。
  const point = (event: PointerEvent) => {
    const state = options.state();
    const lane = (event.target as HTMLElement).closest<HTMLElement>('.roll-lane');
    if (!lane) return null;
    // 一行的结构是 .roll-row > .roll-key + .roll-lane，行号 = 本行之前的行数。
    let index = 0;
    for (let row = lane.parentElement?.previousElementSibling; row; row = row.previousElementSibling) index += 1;
    const rect = lane.getBoundingClientRect();
    const tick = Math.max(0, Math.min(RESOLUTION - 1, Math.floor(((event.clientX - rect.left) / rect.width) * RESOLUTION)));
    return { tick, index, note: drumTrack(state) ? 60 : state.topNote - index };
  };

  const noteAt = (tick: number, note: number) => {
    const state = options.state();
    return currentPattern(state.project).notes.find(
      (item) => item.trackId === state.trackId && item.note === note && tick >= item.start && tick < item.start + item.length
    );
  };

  // 骨架只在轨型/轨名变化时重建；拖动时每帧重建会把主线程吃光。
  const paintGrid = () => {
    const state = options.state();
    const track = state.project.tracks.find((item) => item.id === state.trackId);
    const drum = Boolean(track && track.kind === 'drum');
    const signature = `${state.trackId}|${drum}|${track?.name ?? ''}`;
    if (signature === gridSignature) return;
    gridSignature = signature;

    const rows = drum
      ? `<div class="roll-row"><button type="button" class="roll-key roll-key--drum" data-note="60"><span class="roll-key-name">${escapeHtml(track?.name ?? '打击乐')}</span></button><div class="roll-lane roll-lane--drum"></div></div>`
      : Array.from({ length: ROLL_ROWS }, (_, index) => {
          const note = state.topNote - index;
          const black = BLACK_PITCHES.includes(((note % 12) + 12) % 12);
          return `<div class="roll-row"><button type="button" class="roll-key${black ? ' roll-key--black' : ''}" data-note="${note}"><span class="roll-key-name">${noteLabel(note)}</span></button><div class="roll-lane"></div></div>`;
        }).join('');

    options.root.innerHTML = `<div class="roll-rows">${rows}</div><span class="roll-head" aria-hidden="true"></span>`;
  };

  const renderNotes = () => {
    const state = options.state();
    paintGrid();
    // 细网格线跟着吸附粒度走：画出来的格子就是音符会停下的地方，
    // 否则线是十六分、吸附是八分，人照着线摆还是摆不准。
    options.root.style.setProperty('--roll-snap-ticks', String(snap(state)));
    const lanes = options.root.querySelectorAll<HTMLElement>('.roll-lane');
    for (const lane of Array.from(lanes)) lane.replaceChildren();
    if (!state.trackId) return;

    const drum = Boolean(drumTrack(state));
    const selected = options.selected();
    for (const note of trackNotes(state.project, state.trackId)) {
      const index = drum ? 0 : state.topNote - note.note;
      const lane = lanes[index];
      // 超出可见八度的音符直接不画：把它们硬塞进边缘一行会造成假音符。
      if (!lane) continue;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `roll-note strength-${velocityLevel(note.velocity)}${selected.has(note.id) ? ' is-selected' : ''}`;
      chip.dataset.noteId = note.id;
      chip.setAttribute('aria-label', `${noteLabel(note.note)}，第 ${(note.start / PPQ + 1).toFixed(2)} 步，力度 ${note.velocity}`);
      chip.style.left = `${(note.start / RESOLUTION) * 100}%`;
      chip.style.width = `${(note.length / RESOLUTION) * 100}%`;
      lane.appendChild(chip);
    }
  };

  const onDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const state = options.state();
    const hitArea = point(event);
    if (!state.trackId || !hitArea) return;
    const { tick, index, note } = hitArea;
    options.root.setPointerCapture?.(event.pointerId);

    const existing = noteAt(tick, note);
    if (existing) {
      const lane = (event.target as HTMLElement).closest<HTMLElement>('.roll-lane');
      const rect = lane?.getBoundingClientRect();
      // 右端 14px 内且音符长于一个细分，就当拉伸把手。
      const edge = rect ? ((existing.start + existing.length) / RESOLUTION) * rect.width : 0;
      const localX = rect ? event.clientX - rect.left : 0;
      const mode = existing.length > PPQ && localX > edge - 14 ? 'resize' : 'move';
      drag = {
        mode,
        id: existing.id,
        grabTicks: tick - existing.start,
        // 已经选中了还再按一次 = 打算删它。拉伸把手不算，那里点下去是想改长度。
        deletePending: mode === 'move' && options.selected().has(existing.id),
        moved: false,
        downTick: tick,
        downIndex: index,
      };
      options.select(new Set([existing.id]));
      renderNotes();
      return;
    }

    // 力度跟着网格上那个选择框走：画旋律的人不想每根音符都再调一次响度。
    // 新音符至少给一格（PPQ），吸附更粗时用更粗的那档，免得点出一个看不见的音。
    const step = snap(state);
    const created = addNote(state.project, {
      trackId: state.trackId,
      start: snapDown(tick, step),
      length: Math.max(PPQ, step),
      note,
      velocity: state.project.gridVelocity,
    });
    if (created) {
      drag = { mode: 'resize', id: created.id, grabTicks: 0, deletePending: false, moved: false, downTick: tick, downIndex: index };
      options.select(new Set([created.id]));
      options.preview(note);
      options.changed();
    }
  };

  const onMove = (event: PointerEvent) => {
    if (!drag) return;
    const state = options.state();
    const hitArea = point(event);
    if (!hitArea) return;
    // 跨格才算挪动，同一格里的 1px 抖动还是「点了一下」——不然手机上根本删不掉。
    if (!hitArea) {
      drag.moved = true;
      return;
    }
    const target = currentPattern(state.project).notes.find((item) => item.id === drag?.id);
    if (!target) return;
    if (hitArea.tick !== drag.downTick || hitArea.index !== drag.downIndex) drag.moved = true;
    const step = snap(state);
    // 移和拉伸都吸「绝对位置」：起点本来就在格上时，按住的位置不会先跳一下再动。
    if (drag.mode === 'resize') resizeNote(state.project, target.id, Math.max(step, snapNear(hitArea.tick + 1, step) - target.start));
    else moveNote(state.project, target.id, { start: snapNear(hitArea.tick - drag.grabTicks, step), note: drumTrack(state) ? undefined : hitArea.note });
    renderNotes();
  };

  // 抬手分两种：pointerup 是用户真的松手，可以执行「再点一次就删」；
  // pointercancel 是浏览器把 gesture 拿走了（手机上是竖着滚了一下），这时不能删。
  const finish = (allowDelete: boolean) => {
    if (!drag) return;
    const { id, deletePending, moved } = drag;
    drag = null;
    if (allowDelete && deletePending && !moved) {
      removeNote(options.state().project, id);
      options.select(new Set());
    }
    options.changed();
  };

  const onUp = () => finish(true);
  const onCancel = () => finish(false);

  // 右键删除；触屏没有次键，长按同样会派发 contextmenu。
  const onContext = (event: MouseEvent) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>('.roll-note');
    if (!chip) return;
    event.preventDefault();
    const id = chip.dataset.noteId;
    if (id) {
      removeNote(options.state().project, id);
      options.select(new Set());
      options.changed();
    }
  };

  const onClick = (event: MouseEvent) => {
    const key = (event.target as HTMLElement).closest<HTMLElement>('.roll-key');
    if (key) {
      const note = Number(key.dataset.note);
      if (Number.isFinite(note)) options.preview(note);
      return;
    }
    const chip = (event.target as HTMLElement).closest<HTMLElement>('.roll-note');
    if (!chip?.dataset.noteId) return;
    // 音符被「第二次点击」删掉后，浏览器还会补发一个 click，目标已经是离开 DOM 的旧节点，
    // 再选一次就会留下一个指向不存在音符的选中态。正常单击也走这里：那时选中在 pointerdown
    // 里已经做好了，这里直接跳过。键盘进来的 click（Enter）节点还在 DOM 上，照常选中。
    if (!chip.isConnected) return;
    options.select(new Set([chip.dataset.noteId]));
    renderNotes();
  };

  options.root.addEventListener('pointerdown', onDown);
  options.root.addEventListener('pointermove', onMove);
  options.root.addEventListener('pointerup', onUp);
  options.root.addEventListener('pointercancel', onCancel);
  options.root.addEventListener('click', onClick);
  options.root.addEventListener('contextmenu', onContext);

  return {
    render: renderNotes,
    destroy: () => {
      options.root.removeEventListener('pointerdown', onDown);
      options.root.removeEventListener('pointermove', onMove);
      options.root.removeEventListener('pointerup', onUp);
      options.root.removeEventListener('pointercancel', onCancel);
      options.root.removeEventListener('click', onClick);
      options.root.removeEventListener('contextmenu', onContext);
    },
  };
}
