import type { Task } from '../types';

const GLYPHS: Record<Task['status'], string> = {
  open: '○',
  in_progress: '◑',
  paused: '⏸',
  done: '✓',
  canceled: '✗',
};

/** The status symbol pi-tasks draws; an open task waiting on another reads as blocked. */
export function glyph(task: Task): string {
  return task.status === 'open' && task.blockedByIds.length > 0 ? '✖' : GLYPHS[task.status];
}

/** Cuts `text` to `width` columns, an ellipsis marking the cut. */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

/** The status each CLI verb leaves a task in. */
export const STATUS_AFTER = { start: 'in_progress', complete: 'done', reopen: 'open', pause: 'paused' } as const satisfies Record<string, Task['status']>;
export type StatusVerb = keyof typeof STATUS_AFTER;

/** The CLI verb `s` applies: open and paused start, a started task completes, a closed one reopens. */
export function nextStatusVerb(status: Task['status']): StatusVerb {
  switch (status) {
    case 'open':
    case 'paused':
      return 'start';
    case 'in_progress':
      return 'complete';
    case 'done':
    case 'canceled':
      return 'reopen';
  }
}

/** Each task after its parent, one level deeper; a task whose parent is not listed is a root. */
export function nested(tasks: readonly Task[]): { task: Task; depth: number }[] {
  const listed = new Set(tasks.map(task => task.id));
  const children = new Map<string | null, Task[]>();
  for (const task of tasks) {
    const parent = task.parentId !== null && listed.has(task.parentId) ? task.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), task]);
  }

  const rows: { task: Task; depth: number }[] = [];
  const visit = (parent: string | null, depth: number) => {
    for (const task of children.get(parent) ?? []) {
      rows.push({ task, depth });
      visit(task.id, depth + 1);
    }
  };
  visit(null, 0);

  return rows;
}

/** A search keeps the matches and the parents that lead to them. */
export function matching(tasks: readonly Task[], search: string): Task[] {
  const needle = search.trim().toLowerCase();
  if (needle === '') return [...tasks];

  const byId = new Map(tasks.map(task => [task.id, task]));
  const kept = new Set<string>();
  for (const task of tasks) {
    if (!`${task.title}\n${task.description}`.toLowerCase().includes(needle)) continue;
    for (let at: Task | undefined = task; at !== undefined && !kept.has(at.id); at = byId.get(at.parentId ?? '')) {
      kept.add(at.id);
    }
  }

  return tasks.filter(task => kept.has(task.id));
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function details(task: Task, images: readonly string[]): string {
  const lines = [`Task ${task.id} (p${task.priority}, ${task.status}): ${task.title}`];
  if (task.description.trim() !== '') lines.push('', task.description.trim());
  if (task.blockedByIds.length > 0) lines.push('', `Blocked by: ${task.blockedByIds.join(', ')}`);
  if (images.length > 0) lines.push('', 'Images (open each with Read):', ...images.map(path => `- ${path}`));

  return lines.join('\n');
}

export function workPrompt(task: Task, images: readonly string[]): string {
  return [
    'Work on this task from the Tasks app; the pane has marked it in progress.',
    'Complete it yourself only once it is clearly done: the change works and is committed, or the user says so. Otherwise leave it in progress and say what is left.',
    '',
    details(task, images),
  ].join('\n');
}
