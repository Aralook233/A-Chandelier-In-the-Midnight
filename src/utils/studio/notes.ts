// 音符的增删改。步进网格和钢琴卷帘共用这一份，
// 否则两边的边界条件（吸附、跨小节、同音高重叠）会各写一套、各错一处。

import { PPQ, RESOLUTION, STEPS, type Note, type Pattern, type Project } from './types';

export const stepOf = (note: Note): number => Math.floor(note.start / PPQ);

export function currentPattern(project: Project): Pattern {
  return project.patterns.find((pattern) => pattern.id === project.patternId) ?? project.patterns[0];
}

const clampStart = (start: number): number => Math.max(0, Math.min(RESOLUTION - PPQ, Math.round(start)));
const clampPitch = (note: number): number => Math.max(0, Math.min(127, Math.round(note)));

// 同一条轨道上，一个整步只允许一个鼓点：网格语义如此，卷帘里也一样。
export function stepNotes(project: Project, trackId: string, step: number): Note[] {
  const pattern = currentPattern(project);
  return pattern.notes.filter((note) => note.trackId === trackId && stepOf(note) === step);
}

export function trackNotes(project: Project, trackId: string): Note[] {
  return currentPattern(project).notes.filter((note) => note.trackId === trackId);
}

export function addNote(project: Project, input: { trackId: string; start: number; length?: number; note?: number; velocity?: number }): Note | null {
  const pattern = currentPattern(project);
  const start = clampStart(input.start);
  const note: Note = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    trackId: input.trackId,
    start,
    length: Math.max(1, Math.min(RESOLUTION - start, Math.round(input.length ?? PPQ))),
    note: clampPitch(input.note ?? 60),
    velocity: Math.max(1, Math.min(127, Math.round(input.velocity ?? 100))),
  };
  pattern.notes.push(note);
  return note;
}

export function removeNotes(project: Project, ids: Set<string>): number {
  const pattern = currentPattern(project);
  const before = pattern.notes.length;
  pattern.notes = pattern.notes.filter((note) => !ids.has(note.id));
  return before - pattern.notes.length;
}

export const removeNote = (project: Project, id: string): number => removeNotes(project, new Set([id]));

// 越界的移动直接忽略：与其把音符悄悄吸回小节内让人找不到，不如保持原样。
export function moveNote(project: Project, id: string, patch: { start?: number; note?: number }): boolean {
  const note = currentPattern(project).notes.find((item) => item.id === id);
  if (!note) return false;
  const nextStart = patch.start === undefined ? note.start : Math.round(patch.start);
  if (nextStart < 0 || nextStart > RESOLUTION - PPQ) return false;
  if (patch.note !== undefined) note.note = clampPitch(patch.note);
  const stretch = nextStart + note.length - RESOLUTION;
  if (stretch > 0) note.length -= stretch;
  note.start = nextStart;
  return true;
}

export function resizeNote(project: Project, id: string, length: number): boolean {
  const note = currentPattern(project).notes.find((item) => item.id === id);
  if (!note) return false;
  note.length = Math.max(1, Math.min(RESOLUTION - note.start, Math.round(length)));
  return true;
}

export function clearTrack(project: Project, trackId: string): number {
  return removeNotes(
    project,
    new Set(trackNotes(project, trackId).map((note) => note.id))
  );
}

// 力度分四档上色，网格和卷帘共用这一把尺子：同一个音在两边看着是同一个亮度。
// 阈值要罩得住网格力度选择框的三挡（64 / 95 / 127），改那边的值记得改这里。
export const velocityLevel = (velocity: number): 0 | 1 | 2 | 3 =>
  (velocity < 43 ? 0 : velocity < 86 ? 1 : velocity < 112 ? 2 : 3) as 0 | 1 | 2 | 3;

// 网格的一格只管开关：有音就整格清掉，没音就按当前力度放一个。
// 之前是点同格叠三层力度、第四下才清空，循环四格太隐蔽，手机上数不清自己点到第几下。
export function toggleCell(project: Project, trackId: string, step: number, defaultNote: number, velocity: number): 'added' | 'removed' {
  const existing = stepNotes(project, trackId, step);
  if (existing.length > 0) {
    removeNotes(project, new Set(existing.map((note) => note.id)));
    return 'removed';
  }
  addNote(project, { trackId, start: step * PPQ, length: PPQ, note: defaultNote, velocity });
  return 'added';
}

// 卷帘可能往同一格塞了好几个音，取最响的那个决定这一格的颜色；
// 但只要有音就至少给一档，否极轻的那格会画成空的，看着像没放进去。
export function cellStrength(project: Project, trackId: string, step: number): 0 | 1 | 2 | 3 {
  const notes = stepNotes(project, trackId, step);
  if (notes.length === 0) return 0;
  return Math.max(1, velocityLevel(Math.max(...notes.map((note) => note.velocity)))) as 1 | 2 | 3;
}

export const barSteps = (): number => STEPS;
