import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, RenderChildren } from 'claude-code';

import type { Category, Link, Scope, Task, View } from '../types';
import { categories, categorySlug, change, create, findCommand, folderSlug, imagePaths, linkOf, list, projectFolder, remember } from './cli';
import type { Cli } from './cli';
import { details, fit, glyph, matching, nested, nextStatusVerb, shortId, STATUS_AFTER, workPrompt } from './tasks';
import type { StatusVerb } from './tasks';

const PANE = 'tasks';
/** `/tasks` is Claude Code's own background-tasks panel. */
const COMMAND = 'todo';
const PRIORITIES = [0, 1, 2, 3, 4];
const PRIORITY_COLORS = ['error', 'warning', 'success', 'suggestion', 'subtle'] as const;
const ACCENT = 'claude';
const GLYPH_COLORS = { in_progress: ACCENT, paused: 'warning' } as const;
/** Most rows the selected task's details take; fixed, so the footer stays put while the selection moves. */
const DETAIL_ROWS = 8;
/** From this width a row also shows its blockers and the first line of its description. */
const TWO_COLUMNS_FROM = 100;
/** The rows around the list and its details besides the help: header, blank and rule. */
const CHROME_ROWS = 3;
/** The hidden buttons behind the list's hotkeys. */
const KEYS = ['down', 'up', 'status', 'reopen', 'pause', ...PRIORITIES.map(priority => `p${priority}`), 'edit', 'create', 'child', 'insert', 'scope', 'find', 'reload', 'undo', 'category'];
/** The picker's rows besides the categories and the help: header, filter, rule, then the new and none choices. */
const PICKER_ROWS = 5;

const tasks = atom({ plugin: 'tasks', key: 'tasks' } as const, [] as Task[]);
const scope = atom({ plugin: 'tasks', key: 'scope' } as const, 'active' as Scope);
const view = atom({ plugin: 'tasks', key: 'view' } as const, { kind: 'list' } as View);
const search = atom({ plugin: 'tasks', key: 'search' } as const, '');
const searching = atom({ plugin: 'tasks', key: 'searching' } as const, false);
const selected = atom({ plugin: 'tasks', key: 'selected' } as const, '');
const field = atom({ plugin: 'tasks', key: 'field' } as const, 'title');
const link = atom({ plugin: 'tasks', key: 'link' } as const, { kind: 'unset' } as Link);
const known = atom({ plugin: 'tasks', key: 'categories' } as const, [] as Category[]);
const categoryQuery = atom({ plugin: 'tasks', key: 'categoryQuery' } as const, '');

/** Resolved once per session start: the CLI and this project's category, or why there is none. */
let setup: Promise<Cli | string> = Promise.resolve('Tasks is still starting.');
let isOpen = false;
let draft = { title: '', description: '' };
/** The first row the list shows; the list draws only what fits, so the arrows walk rows instead of scrolling. */
let top = 0;
/** The pane's status and priority changes, newest last, each with the task as it was and as the CLI left it. */
const undoable: { before: Task; after: Task }[] = [];

type RenderEvent = Parameters<EngineInterface['ui']['resolve']>[0];

export const register: Register = (on, options) => {
  const configured = (name: string) => (typeof options[name] === 'string' ? (options[name] as string).trim() : '');

  on('session.start', async ($, e, next) => {
    setup = connect($, configured('cli'), e.cwd).then(async cli => {
      if (typeof cli !== 'string') await update($, link, () => cli.link);
      return cli;
    });
    await $.command.register({ name: COMMAND, description: "Show or hide this project's tasks from the Tasks app" });

    return next(e);
  });

  on('command.run', { command: COMMAND }, async $ => {
    if (isOpen) {
      await $.ui.close({ id: PANE });
      return { text: 'Tasks closed.' };
    }
    const cli = await setup;
    isOpen = true;
    await $.ui.open({ id: PANE, title: 'Tasks', focus: true, closeOnEscape: true, rows: 30, columns: 120 });
    if (typeof cli === 'string') return { text: 'Tasks opened.' };
    if ((await read($, link)).kind === 'unset') void choose($, cli);
    else void act($, cli, async () => {});

    return { text: 'Tasks opened.' };
  });

  // Escape steps back like pi-tasks: form to list, then clears the search, then closes.
  // Escape also hands the keys to the prompt, so a step back takes them again.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person' && (await stepBack($))) {
      void $.ui.open({ id: PANE, focus: true, closeOnEscape: true });
      return { value: undefined };
    }
    isOpen = false;

    return next(e);
  });

  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const element = e.element;
    if (element === undefined) return next(e);
    if (element === 'title' || element === 'description') {
      await update($, field, () => element);
      return next(e);
    }
    if ((await read($, tasks)).some(task => task.id === element)) {
      await update($, selected, () => element);
      return next(e);
    }
    if (e.origin.kind !== 'person' || !KEYS.includes(element)) return next(e);
    // The hidden `up` sits just before the rows and `down` just after, so an arrow past
    // the shown rows lands there: step the list instead. Any other key button holds the ring.
    if (element === 'down' || element === 'up') void step($, element === 'down' ? 1 : -1);
    return {};

    return next(e);
  });

  // The model learns how to reach the same tasks, so "add a task for that" works from the chat.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e);
    const cli = await setup;
    const linked = await read($, link);
    if (typeof cli === 'string' || linked.kind === 'unset') return composed;

    return { sections: [...composed.sections, { id: 'tasks:cli', text: modelContext(cli, linked.slug), scope: 'session' }] };
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Text } = $.ui.resolve(e);
    const cli = await setup;
    if (typeof cli === 'string') {
      return <Text color="warning">{cli}</Text>;
    }
    const width = e.props.bodyColumns;
    const [shown, linked] = await Promise.all([read($, view), read($, link)]);
    if (shown.kind === 'pick' || linked.kind === 'unset') return renderPicker($, e, width, e.props.scroll.bodyRows, cli);
    const category = linked.slug;

    return shown.kind === 'edit' ? renderForm($, e, width, cli, category, shown) : renderList($, e, width, e.props.scroll.bodyRows, cli, category);
  });
};

/** Leaves the form, the picker or the search; false when the list is already as plain as it gets, or no category is picked yet. */
async function stepBack($: EngineInterface): Promise<boolean> {
  if ((await read($, view)).kind !== 'list') {
    if ((await read($, link)).kind === 'unset') return false;
    await update($, view, (): View => ({ kind: 'list' }));
    return true;
  }
  if ((await read($, searching)) || (await read($, search)) !== '') {
    await update($, searching, () => false);
    await update($, search, () => '');
    return true;
  }

  return false;
}

/** Moves the selection, wrapping at the ends, and the ring with it once the row is drawn. */
async function step($: EngineInterface, delta: number): Promise<void> {
  const rows = nested(matching(await read($, tasks), await read($, search)));
  const now = await read($, selected);
  const at = Math.max(0, rows.findIndex(row => row.task.id === now));
  const next = rows[(at + delta + rows.length) % rows.length];
  if (next === undefined) return;
  await update($, selected, () => next.task.id);
  await $.ui.focus({ requestId: PANE, key: next.task.id });
}

async function connect($: EngineInterface, configuredCli: string, cwd: string): Promise<(Cli & { link: Link }) | string> {
  const command = await findCommand($, configuredCli);
  if (command === undefined) {
    return 'tasks-cli was not found. Install the Tasks app, put tasks-cli on PATH, or set the cli option in /config.';
  }
  const cli = { command, folder: await projectFolder($, cwd) };

  return { ...cli, link: await linkOf($, cli).catch((): Link => ({ kind: 'unset' })) };
}

/** Opens the category picker with the home's categories. */
async function choose($: EngineInterface, cli: Cli): Promise<void> {
  await update($, categoryQuery, () => '');
  await update($, view, (): View => ({ kind: 'pick' }));
  const found = await categories($, cli).catch(error => {
    void $.ui.toast(error instanceof Error ? error.message : String(error));
    return [];
  });
  await update($, known, () => found);
}

/** Links the project's folder to `slug` (`null`: the uncategorized tasks) for every later session, and lists its tasks. */
async function pick($: EngineInterface, cli: Cli, slug: string | null): Promise<void> {
  await remember($, cli, slug);
  await update($, link, (): Link => ({ kind: 'linked', slug }));
  await update($, view, (): View => ({ kind: 'list' }));
  await update($, selected, () => '');
  await act($, cli, async () => {});
}

/** Runs one pane action, then reloads the list, which also undoes a refused optimistic change; failures show as toasts. */
async function act($: EngineInterface, cli: Cli, action: () => Promise<unknown>): Promise<void> {
  const toast = (error: unknown) => $.ui.toast(error instanceof Error ? error.message : String(error));
  await action().catch(toast);
  const linked = await read($, link);
  if (linked.kind === 'unset') return;
  await list($, cli, linked.slug, await read($, scope))
    .then(({ tasks: listed }) => update($, tasks, () => listed))
    .catch(toast);
}

async function renderList($: EngineInterface, e: RenderEvent, width: number, height: number, cli: Cli, category: string | null) {
  const { Box, Button, Input, Text } = $.ui.resolve(e);
  const [all, shownScope, query, isSearching, remembered] = await Promise.all([
    read($, tasks),
    read($, scope),
    read($, search),
    read($, searching),
    read($, selected),
  ]);
  const rows = nested(matching(all, query));
  const selectedId = rows.some(row => row.task.id === remembered) ? remembered : rows[0]?.task.id;
  const current = all.find(task => task.id === selectedId);

  // Each CLI call takes about a quarter second through WSL, so the row shows the change before the CLI confirms it.
  const apply = (task: Task, patch: Partial<Task>, argv: string[]) => {
    if (Object.entries(patch).every(([key, value]) => task[key as keyof Task] === value)) return;
    void act($, cli, async () => {
      await update($, tasks, list => list.map(one => (one.id === task.id ? { ...one, ...patch } : one)));
      undoable.push({ before: task, after: (await change($, cli, task, argv)).task });
    });
  };
  // The CLI's own undo, checked against the version the pane's change left, so a later edit in the app is not reverted.
  const undo = () => {
    const last = undoable.pop();
    if (last === undefined) return void $.ui.toast('Nothing to undo.');
    const { before, after } = last;
    void act($, cli, async () => {
      await update($, tasks, list => (list.some(one => one.id === before.id) ? list.map(one => (one.id === before.id ? before : one)) : [...list, before]));
      await update($, selected, () => before.id);
      await change($, cli, after, ['undo', after.id]);
    });
  };
  const write = (patch: (task: Task) => Partial<Task>, argv: (task: Task) => string[]) => () => current && apply(current, patch(current), argv(current));
  const work = (task: Task) => {
    void handOff(task, workPrompt, 'replace');
    if (task.status === 'open' || task.status === 'paused') apply(task, { status: 'in_progress' }, ['start', task.id]);
  };
  const toStatus = (verb: (task: Task) => StatusVerb) => write(task => ({ status: STATUS_AFTER[verb(task)] }), task => [verb(task), task.id]);
  const handOff = async (task: Task, toText: typeof details, mode: 'replace' | 'insert') => {
    await $.prompt.fill({ text: toText(task, await imagePaths($, cli, task)), mode });
    await $.ui.close({ id: PANE });
  };
  const edit = async (next: View) => {
    const task = next.kind === 'edit' && next.id !== undefined ? current : undefined;
    draft = { title: task?.title ?? '', description: task?.description ?? '' };
    await update($, field, () => 'title');
    await update($, view, () => next);
    await $.ui.focus({ requestId: PANE, key: 'title' });
  };
  const find = async () => {
    await update($, searching, () => true);
    await $.ui.focus({ requestId: PANE, key: 'search' });
  };
  const footer = help(Text, width, [
    [['enter', 'work'], ['i', 'insert'], ['d', 'edit'], ['f', 'find'], ['x', shownScope === 'active' ? 'closed' : 'active'], ['g', 'category'], ['esc', query === '' ? 'close' : 'clear filter']],
    [['0-4', 'priority'], ['s', 'status'], ['o', 'open'], ['p', 'pause'], ['u', 'undo'], ['c', 'new'], ['n', 'child']],
  ]);
  // A short pane splits its room between the list and the details, so all of it fits and the arrows walk rows.
  const room = height - CHROME_ROWS - footer.length - (isSearching ? 1 : 0);
  const detailRows = Math.min(DETAIL_ROWS, Math.floor(room / 2));
  const fits = Math.max(1, room - detailRows);
  const at = Math.max(0, rows.findIndex(row => row.task.id === selectedId));
  top = Math.max(0, Math.min(top, at, rows.length - fits), at - fits + 1);
  const endSearch = async () => {
    await update($, searching, () => false);
    if (selectedId !== undefined) await $.ui.focus({ requestId: PANE, key: selectedId });
  };

  // Columns: marker, status, priority, id, the title indented under its parent, then (wide) blockers and summary.
  const label = (task: Task, depth: number) => `${'  '.repeat(depth)}${task.title}`;
  const fixed = '→ ○ P2 12345678 '.length;
  const twoColumns = width >= TWO_COLUMNS_FROM;
  const titleWidth = twoColumns
    ? Math.min(Math.max(0, ...rows.map(row => label(row.task, row.depth).length)), Math.floor(width * 0.6) - fixed)
    : width - fixed - 1;
  const metaWidth = width - fixed - titleWidth - 3;
  const isCut = (task: Task) => {
    const shown = label(task, rows.find(row => row.task.id === task.id)?.depth ?? 0);
    return fit(shown, titleWidth) !== shown;
  };

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color="subtle">
          Tasks
        </Text>
        <Text dimColor>
          {' '}
          • {named(category)} • {shownScope} • {rows.length} {rows.length === 1 ? 'task' : 'tasks'}
        </Text>
        {query !== '' && !isSearching && <Text color="warning"> [filter: {query}]</Text>}
      </Text>
      {isSearching && (
        <Input key="search" label="Search" value={query} onInput={value => void update($, search, () => value)} onSubmit={() => void endSearch()} />
      )}
      {rows.length === 0 && (
        <Text dimColor>{query === '' ? `  No ${shownScope} tasks in ${named(category)}. Press c to create one.` : `  No task matches "${query}".`}</Text>
      )}
      <Box display="none">
        <Button key="status" hotkey="s" label="status" onPress={toStatus(task => nextStatusVerb(task.status))} />
        <Button key="reopen" hotkey="o" label="reopen" onPress={toStatus(() => 'reopen')} />
        <Button key="pause" hotkey="p" label="pause" onPress={toStatus(() => 'pause')} />
        {PRIORITIES.map(priority => (
          <Button key={`p${priority}`} hotkey={String(priority)} label={`P${priority}`} onPress={write(() => ({ priority }), task => ['update', task.id, '--priority', String(priority)])} />
        ))}
        <Button key="edit" hotkey="d" label="details" onPress={() => current && void edit({ kind: 'edit', id: current.id })} />
        <Button key="create" hotkey="c" label="create" onPress={() => void edit({ kind: 'edit' })} />
        <Button key="child" hotkey="n" label="child" onPress={() => current && void edit({ kind: 'edit', parentId: current.id })} />
        <Button key="insert" hotkey="i" label="insert" onPress={() => current && void handOff(current, details, 'insert')} />
        <Button key="scope" hotkey="x" label="scope" onPress={() => void act($, cli, () => update($, scope, (now): Scope => (now === 'active' ? 'closed' : 'active')))} />
        <Button key="find" hotkey="f" label="find" onPress={() => void find()} />
        <Button key="undo" hotkey="u" label="undo" onPress={undo} />
        <Button key="category" hotkey="g" label="category" onPress={() => void choose($, cli)} />
        <Button key="reload" hotkey="r" label="reload" onPress={() => void act($, cli, async () => {})} />
        <Button key="up" hotkey="k" label="up" onPress={() => void step($, -1)} />
      </Box>
      {rows.slice(top, top + fits).map(({ task, depth }) => {
        const isSelected = task.id === selectedId;
        const meta = [task.blockedByIds.length > 0 ? `← ${task.blockedByIds.map(shortId).join(',')}` : '', firstLine(task.description)]
          .filter(Boolean)
          .join('  ');
        const title = fit(label(task, depth), titleWidth);

        return (
          <Button key={task.id} plain autoFocus={isSelected ? true : undefined} onPress={() => work(task)}>
            {isSelected ? (
              // The focus inverts the row; padded to the width, it reads as one even bar.
              <Text color={ACCENT}>{`→ ${glyph(task)} P${task.priority} ${shortId(task.id)} ${title.padEnd(titleWidth)}${twoColumns && meta !== '' ? `  ${fit(meta, metaWidth)}` : ''}`.padEnd(width - 1)}</Text>
            ) : (
              <Text>
                <Text color={GLYPH_COLORS[task.status as keyof typeof GLYPH_COLORS] ?? 'subtle'}>{`  ${glyph(task)} `}</Text>
                <Text color={PRIORITY_COLORS[task.priority]}>P{task.priority}</Text>
                <Text dimColor> {shortId(task.id)} </Text>
                {twoColumns ? title.padEnd(titleWidth) : title}
              </Text>
            )}
            {!isSelected && twoColumns && meta !== '' && <Text dimColor>{`  ${fit(meta, metaWidth)}`}</Text>}
          </Button>
        );
      })}
      <Box display="none">
        <Button key="down" hotkey="j" label="down" onPress={() => void step($, 1)} />
      </Box>
      <Text> </Text>
      <Box flexDirection="column" height={Math.max(0, detailRows)} overflow="hidden">
        {current !== undefined && detailsOf(Box, Text, current, all, isCut(current) ? (detailRows >= 3 ? 2 : 1) : 0, detailRows, width)}
      </Box>
      {rule(Text, width)}
      {footer}
    </Box>
  );
}

async function renderForm($: EngineInterface, e: RenderEvent, width: number, cli: Cli, category: string | null, form: Extract<View, { kind: 'edit' }>) {
  const { Box, Input, Text } = $.ui.resolve(e);
  const [all, focused] = await Promise.all([read($, tasks), read($, field)]);
  const task = all.find(one => one.id === form.id);
  // pi-tasks' fields: the label and the frame in the accent color while the field has the keys.
  const framed = (key: string, label: string, input: RenderChildren) => (
    <Box flexDirection="column">
      <Text bold color={focused === key ? ACCENT : 'subtle'}>
        {label}
      </Text>
      <Box borderStyle="round" borderColor={focused === key ? ACCENT : 'subtle'} paddingX={1}>
        {input}
      </Box>
    </Box>
  );
  const parent = all.find(one => one.id === (task?.parentId ?? form.parentId));

  const save = () =>
    void act($, cli, async () => {
      const title = draft.title.trim();
      if (title === '') throw new Error('A task needs a title.');
      if (task === undefined) await create($, cli, category, title, draft.description, form.parentId);
      else await change($, cli, task, ['update', task.id, '--title', title, '--description', draft.description]);
      await update($, view, (): View => ({ kind: 'list' }));
    });

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color="subtle">
          Tasks
        </Text>
        <Text dimColor> • {named(category)} • </Text>
        <Text color={ACCENT}>{task === undefined ? 'new task' : 'editing'}</Text>
      </Text>
      <Text>
        <Text color={ACCENT}>› </Text>
        {task === undefined ? (
          <Text dimColor>P2 new</Text>
        ) : (
          <Text>
            <Text color="subtle">{glyph(task)} </Text>
            <Text color={PRIORITY_COLORS[task.priority]}>P{task.priority}</Text>
            <Text dimColor> {shortId(task.id)}</Text>
          </Text>
        )}
      </Text>
      <Text> </Text>
      {framed('title', 'Title', <Input key="title" value={draft.title} autoFocus onInput={value => { draft.title = value; }} onSubmit={save} />)}
      {parent !== undefined && (
        <Text dimColor>
          Parent: {parent.title} ({shortId(parent.id)})
        </Text>
      )}
      {task !== undefined && task.blockedByIds.length > 0 && (
        <Text>
          <Text color="warning">Blocked by: </Text>
          <Text dimColor>{task.blockedByIds.map(id => all.find(one => one.id === id)?.title ?? shortId(id)).join(', ')}</Text>
        </Text>
      )}
      {framed('description', 'Description', <Input key="description" value={draft.description} rows={8} onInput={value => { draft.description = value; }} onSubmit={save} />)}
      {rule(Text, width)}
      {help(Text, width, [[['enter', 'save'], ['tab', 'next field'], ['esc', 'back']]])}
    </Box>
  );
}

/**
 * Which category the project's folder stands for: the home's categories, the closest to the folder's
 * name (or the filter) first, then a new one named so, then the uncategorized tasks. Picked once, remembered.
 */
async function renderPicker($: EngineInterface, e: RenderEvent, width: number, height: number, cli: Cli) {
  const { Box, Button, Input, Text } = $.ui.resolve(e);
  const [found, query, linked] = await Promise.all([read($, known), read($, categoryQuery), read($, link)]);
  const footer = help(Text, width, [[['type', 'filter'], ['enter', 'pick'], ['tab', 'move'], ['esc', linked.kind === 'linked' ? 'back' : 'close']]]);
  const typed = categorySlug(query);
  const target = typed || folderSlug(cli);
  const closeness = (slug: string) => (slug === target ? 0 : slug.includes(target) || target.includes(slug) ? 1 : 2);
  const ranked = found
    .filter(one => one.slug.includes(typed))
    .sort((a, b) => closeness(a.slug) - closeness(b.slug) || b.taskCount - a.taskCount)
    .slice(0, Math.max(1, height - PICKER_ROWS - footer.length));
  const fresh = target !== '' && !found.some(one => one.slug === target) ? target : undefined;
  const select = (slug: string | null) => () => void pick($, cli, slug);
  const first = ranked[0]?.slug ?? fresh;

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color="subtle">
          Tasks
        </Text>
        <Text dimColor> • which category is {cli.folder.split('/').filter(Boolean).pop()}?</Text>
        {linked.kind === 'linked' && <Text dimColor> now {named(linked.slug)}</Text>}
      </Text>
      <Input key="category-filter" label="Category" value={query} autoFocus onInput={value => void update($, categoryQuery, () => value)} onSubmit={() => first !== undefined && select(first)()} />
      {ranked.map(one => (
        <Button key={`pick:@${one.slug}`} plain onPress={select(one.slug)}>
          <Text>
            {`@${one.slug} `}
            <Text dimColor>{one.taskCount}</Text>
          </Text>
        </Button>
      ))}
      {fresh !== undefined && (
        <Button key="pick:new" plain onPress={select(fresh)}>
          <Text>
            new <Text color={ACCENT}>@{fresh}</Text>
          </Text>
        </Button>
      )}
      <Button key="pick:none" plain onPress={select(null)}>
        <Text dimColor>none: the tasks without a category</Text>
      </Button>
      {rule(Text, width)}
      {footer}
    </Box>
  );
}

function named(category: string | null): string {
  return category === null ? 'uncategorized' : `@${category}`;
}

type Elements = ReturnType<EngineInterface['ui']['resolve']>;
type TextElement = Elements['Text'];
type BoxElement = Elements['Box'];

function rule(Text: TextElement, width: number) {
  return <Text dimColor>{'─'.repeat(width)}</Text>;
}

/**
 * pi-tasks' keyboard help: the key, then what it does, dimmer; ` • ` between. Each group starts a line and
 * wraps between entries when the pane is narrower, so a side panel such as tuios' sidebar cuts nothing off.
 */
function help(Text: TextElement, width: number, groups: [string, string][][]) {
  const lines: [string, string][][] = [];
  for (const group of groups) {
    let used = width;
    for (const entry of group) {
      const size = entry[0].length + 1 + entry[1].length;
      if (used + 3 + size > width) {
        lines.push([entry]);
        used = size;
      } else {
        lines.at(-1)!.push(entry);
        used += 3 + size;
      }
    }
  }

  return lines.map(line => (
    <Text key={line[0]?.[0]}>
      {line.map(([key, action], index) => (
        <Text key={key}>
          {index > 0 && <Text dimColor> • </Text>}
          <Text color="subtle">{key}</Text>
          <Text dimColor> {action}</Text>
        </Text>
      ))}
    </Text>
  ));
}

/**
 * The selected task under the list: its title when the row cuts it, parent, blockers and description.
 * A shown title keeps its rows whether it wraps or not; a description longer than the room ends in an ellipsis.
 */
function detailsOf(Box: BoxElement, Text: TextElement, task: Task, all: readonly Task[], titleRows: number, rows: number, width: number) {
  const parent = all.find(one => one.id === task.parentId);
  const blockers = task.blockedByIds.map(id => all.find(one => one.id === id)?.title ?? shortId(id));
  const description = clip(task.description.trim(), rows - titleRows - (parent ? 1 : 0) - (blockers.length > 0 ? 1 : 0), width);

  return (
    <Box flexDirection="column">
      {titleRows > 0 && (
        <Box height={titleRows} flexShrink={0} overflow="hidden">
          <Text bold color={ACCENT}>
            {task.title}
          </Text>
        </Box>
      )}
      {parent !== undefined && (
        <Text dimColor>
          Parent: {parent.title} ({shortId(parent.id)})
        </Text>
      )}
      {blockers.length > 0 && (
        <Text>
          <Text color="warning">Blocked by: </Text>
          <Text dimColor>{blockers.join(', ')}</Text>
        </Text>
      )}
      <Text dimColor={description === ''}>{description === '' ? '(no description)' : description}</Text>
    </Box>
  );
}

/** The lines of `text` that fit in `rows` rows `width` wide, the last row an ellipsis when some are left out. */
function clip(text: string, rows: number, width: number): string {
  const lines = text.split(/\r?\n/);
  const rowsOf = (line: string) => Math.max(1, Math.ceil(line.length / width));
  if (lines.reduce((sum, line) => sum + rowsOf(line), 0) <= rows) return text;
  const kept: string[] = [];
  let used = 1;
  for (const line of lines) {
    if (used + rowsOf(line) > rows) break;
    kept.push(line);
    used += rowsOf(line);
  }

  return [...kept, '…'].join('\n');
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? '';
}

function modelContext(cli: Cli, category: string | null): string {
  const filter = category === null ? '--uncategorized' : `--category ${category}`;

  return [
    category === null ? "This project's tasks are the Tasks app's tasks without a category." : `This project's tasks live in the Tasks app under the @${category} category.`,
    `Read them whenever they help, with \`${cli.command} --json\`: \`list ${filter}\` and \`show ID\` (without \`--json\` it also prints each image's path, which you may Read).`,
    'Create, change or close a task only when the user asks you to, or to complete the task the user handed you once it is clearly done. Do not file your own steps or short-lived to-dos there; that is what your own todo list is for.',
    'When something looks worth keeping as a task, suggest it in one line and wait for a yes.',
    `When asked, add \`--actor-label claude\` and use \`add --title TITLE${category === null ? '' : ` --category ${category}`} [--description TEXT] [--priority 0-4] [--parent ID]\`,`,
    '`update ID [--title T] [--description D] [--priority N]`, `start|pause|complete|reopen|cancel|undo ID`, `dep-add ID BLOCKER_ID` or `move ID --parent ID`.',
    'Ids are full UUIDs. Priority 0 is the most urgent, 2 the default. Never open the Tasks database directly.',
  ].join(' ');
}
