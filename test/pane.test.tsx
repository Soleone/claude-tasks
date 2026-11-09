import { expect, test } from 'claude-code/testing';
import type { On } from 'claude-code';

const ID = '90583df4-1077-4916-9c6e-adb6422388df';
const TASK = {
  id: ID,
  title: 'Ship the pane',
  description: 'with tests',
  status: 'open',
  priority: 1,
  category: 'demo',
  parentId: null,
  blockedByIds: [],
  attachments: [],
  version: 7,
};

const PANE = {
  plugin: 'tasks',
  component: 'Pane',
  requestId: 'tasks',
  surface: 'terminal',
  props: {
    title: 'Tasks @demo',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const;

/** A fake tasks-cli on PATH that records each call, and the mod's store; returns the store. */
function fakeCli(on: On, calls: string[][]) {
  const stored = new Map<string, unknown>();
  on('store.get', (_, e) => ({ value: stored.get(e.key) }));
  on('store.set', (_, e) => {
    stored.set(e.key, e.value);
    return { value: undefined };
  });
  on('process.run', (_, e) => {
    calls.push([...e.argv]);
    const [command, verb] = e.argv;
    if (command === 'git') return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
    const reply =
      verb === 'list' ? { tasks: [TASK] }
      : verb === 'info' ? { writeContext: 'ctx' }
      : verb === 'categories' ? { categories: [{ slug: 'demo', taskCount: 1 }, { slug: 'life', taskCount: 6 }] }
      : { task: TASK };

    return { value: { exitCode: 0, stdout: JSON.stringify(reply), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
  });
  on('command.register', () => ({ value: { command: 'todo' } }));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('ui.close', () => ({ value: undefined }));
  on('ui.focus', () => ({}));
  on('session.start', (_, e) => ({ cwd: e.cwd }));

  return stored;
}

test('the pane lists the project category and starts a task with its version', async ($, on) => {
  const calls: string[][] = [];
  fakeCli(on, calls);
  on('command.run', () => ({ text: '' }));

  await $.session.start({ cwd: '/src/demo', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'todo', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } });

  const ui = await $.ui.mount(PANE);
  await ui.press({ key: 'reload' });
  expect((await ui.find({ type: 'Button', key: ID }))?.text).toContain('Ship the pane');
  expect(calls.find(argv => argv[1] === 'list')).toContain('demo');

  await ui.press({ key: 'status' });
  const start = calls.find(argv => argv[1] === 'start');
  expect(start?.slice(0, 3)).toEqual(['tasks-cli', 'start', ID]);
  expect(start).toContain('ctx');
  expect(start?.[start.indexOf('--expected-version') + 1]).toBe('7');
  await ui.unmount();
});

test('enter hands the task to Claude and marks it in progress', async ($, on) => {
  const calls: string[][] = [];
  const filled: string[] = [];
  fakeCli(on, calls);
  on('command.run', () => ({ text: '' }));
  on('prompt.fill', (_, e) => {
    filled.push(e.text);
    return { isFilled: true };
  });

  await $.session.start({ cwd: '/src/demo', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'todo', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } });

  const ui = await $.ui.mount(PANE);
  await ui.press({ key: 'reload' });
  await ui.press({ key: ID });
  expect(filled[0]).toContain('Ship the pane');
  expect(calls.find(argv => argv[1] === 'start')?.slice(0, 3)).toEqual(['tasks-cli', 'start', ID]);
  await ui.unmount();
});

test('u undoes the last change through the CLI', async ($, on) => {
  const calls: string[][] = [];
  fakeCli(on, calls);
  on('command.run', () => ({ text: '' }));

  await $.session.start({ cwd: '/src/demo', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'todo', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } });

  const ui = await $.ui.mount(PANE);
  await ui.press({ key: 'reload' });
  await ui.press({ key: 'status' });
  await ui.press({ key: 'undo' });
  expect(calls.find(argv => argv[1] === 'undo')?.slice(0, 3)).toEqual(['tasks-cli', 'undo', ID]);
  await ui.unmount();
});

test('a folder with no category of its name asks for one and remembers it', async ($, on) => {
  const calls: string[][] = [];
  const stored = fakeCli(on, calls);
  on('command.run', () => ({ text: '' }));

  await $.session.start({ cwd: '/src/odd.name', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'todo', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } });

  const ui = await $.ui.mount(PANE);
  expect(await ui.find({ type: 'Button', key: 'pick:new' })).toBeDefined();
  expect(calls.some(argv => argv[1] === 'list')).toBe(false);

  await ui.press({ key: 'pick:@life' });
  expect(calls.find(argv => argv[1] === 'list')).toContain('life');
  expect(stored.get('category:/src/odd.name')).toBe('life');
  await ui.unmount();
});

test('a narrow pane wraps the help between entries instead of cutting it off', async ($, on) => {
  fakeCli(on, []);
  on('command.run', () => ({ text: '' }));

  await $.session.start({ cwd: '/src/demo', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'todo', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 40 } });

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 } });
  await ui.press({ key: 'reload' });
  const lines = (await ui.findAll({ type: 'Text', text: / • / })).map(found => found.text);
  expect(lines.some(line => line.endsWith('n child'))).toBe(true);
  expect(lines.every(line => line.length <= 40)).toBe(true);
  await ui.unmount();
});
