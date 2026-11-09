import type { EngineInterface } from 'claude-code';

import type { Category, Link, Scope, Task } from '../types';

const ACTIVE = 'open,in_progress,paused';
const CLOSED = 'done,canceled';
/** Where Windows records the Tasks install; WSL reads it through interop. */
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Tasks';

export class CliError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

/**
 * Where the Tasks app's CLI is, and the project's folder: the main checkout, so
 * worktrees share it. Every change goes through that CLI, so the app's rules and
 * lock apply. On WSL it is the Windows tasks-cli.exe: the home lives on the
 * Windows side, and its SQLite cache must never be opened from WSL.
 */
export type Cli = { command: string; folder: string };

/** Authority for versioned writes, from `info`; dropped after any failure. */
let writeContext: string | undefined;

export function list($: EngineInterface, cli: Cli, category: string | null, scope: Scope): Promise<{ tasks: Task[] }> {
  const status = scope === 'active' ? ACTIVE : CLOSED;
  const sort = scope === 'active' ? ['--sort', 'priority', '--direction', 'asc'] : ['--sort', 'closed', '--direction', 'desc'];
  const filter = category === null ? ['--uncategorized'] : ['--category', category];

  return run($, cli, ['list', ...filter, '--status', status, '--limit', '1000', ...sort]);
}

export function create($: EngineInterface, cli: Cli, category: string | null, title: string, description: string, parentId: string | undefined): Promise<{ task: Task }> {
  const parent = parentId === undefined ? [] : ['--parent', parentId];
  const filed = category === null ? [] : ['--category', category];

  return run($, cli, ['add', '--title', title, '--description', description, ...filed, ...parent]);
}

export async function categories($: EngineInterface, cli: Cli): Promise<Category[]> {
  return (await run<{ categories: Category[] }>($, cli, ['categories'])).categories;
}

/** The category the folder was linked to; else the one named like the folder, when it exists; else none yet. */
export async function linkOf($: EngineInterface, cli: Cli): Promise<Link> {
  const stored = await $.store.get(linkKey(cli));
  if (typeof stored === 'string' || stored === null) return { kind: 'linked', slug: stored };
  const guess = folderSlug(cli);

  return (await categories($, cli)).some(one => one.slug === guess) ? { kind: 'linked', slug: guess } : { kind: 'unset' };
}

export async function remember($: EngineInterface, cli: Cli, slug: string | null): Promise<void> {
  await $.store.set(linkKey(cli), slug);
}

function linkKey(cli: Cli): string {
  return `category:${cli.folder}`;
}

/** The folder's name as a category: `My.App` reads as `my-app`. */
export function folderSlug(cli: Cli): string {
  return categorySlug(cli.folder.split('/').filter(Boolean).pop() ?? '');
}

/** A write on an existing task, refused as stale when the app changed it since `task` was read. */
export async function change($: EngineInterface, cli: Cli, task: Task, argv: readonly string[]): Promise<{ task: Task }> {
  writeContext ??= (await run<{ writeContext: string }>($, cli, ['info'])).writeContext;

  return run($, cli, [...argv, '--write-context', writeContext, '--expected-version', String(task.version)]);
}

/** Each image's path as this machine opens it. `show` prints them, as Windows paths from the Windows CLI. */
export async function imagePaths($: EngineInterface, cli: Cli, task: Task): Promise<string[]> {
  if (task.attachments.length === 0) return [];

  const shown = await $.process.run([cli.command, 'show', task.id]);
  const paths = [...shown.stdout.matchAll(/^image: (.+?)\r?$/gm)].map(([, path]) => path ?? '');
  if (!cli.command.endsWith('.exe')) return paths;

  return Promise.all(paths.map(async path => (await $.process.run(['wslpath', '-u', path])).stdout.trim()));
}

async function run<T>($: EngineInterface, cli: Cli, argv: readonly string[]): Promise<T> {
  const ran = await $.process.run([cli.command, ...argv, '--actor-kind', 'agent', '--actor-label', 'claude', '--json']);
  const reply = parseReply(ran.stdout);
  if (reply?.ok === false) {
    writeContext = undefined;
    throw new CliError(reply.error?.code ?? 'UNKNOWN', reply.error?.message ?? 'tasks-cli refused the request');
  }
  if (ran.exitCode !== 0 || reply === undefined) {
    writeContext = undefined;
    throw new Error(`tasks-cli ${argv[0]} exited ${ran.exitCode}: ${ran.stderr.trim().slice(-500)}`);
  }

  return reply as T;
}

function parseReply(stdout: string): { ok?: boolean; error?: { code?: string; message?: string } } | undefined {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** The configured command (a Windows path works on WSL), else tasks-cli on PATH, else on WSL the Windows install's tasks-cli.exe. */
export async function findCommand($: EngineInterface, configured: string): Promise<string | undefined> {
  // Windows' "Copy as path" quotes the path; on WSL a Windows path needs its /mnt form.
  const path = configured.trim().replace(/^"(.*)"$/, '$1');
  if (/^[a-z]:\\/i.test(path)) return (await attempt($, ['wslpath', '-u', path]))?.trim();
  if (path !== '') return path;
  if (await runs($, 'tasks-cli')) return 'tasks-cli';
  if ((await $.env.get('WSL_DISTRO_NAME')) === undefined) return undefined;

  const windows = await windowsInstall($);

  return windows !== undefined && (await runs($, windows)) ? windows : undefined;
}

async function windowsInstall($: EngineInterface): Promise<string | undefined> {
  const query = await attempt($, ['reg.exe', 'query', UNINSTALL_KEY, '/v', 'InstallLocation']);
  const folder = query?.match(/InstallLocation\s+REG_SZ\s+"?([^"\r\n]+?)"?\s*$/m)?.[1];
  if (folder === undefined) return undefined;

  return (await attempt($, ['wslpath', '-u', `${folder}\\tasks-cli.exe`]))?.trim();
}

async function runs($: EngineInterface, command: string): Promise<boolean> {
  return (await attempt($, [command, '--help'])) !== undefined;
}

/** stdout of a command that ran and succeeded; undefined when it is missing or failed. */
async function attempt($: EngineInterface, argv: readonly string[]): Promise<string | undefined> {
  try {
    const ran = await $.process.run(argv, { timeoutMs: 5_000 });
    return ran.exitCode === 0 ? ran.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** The project's folder; for a linked git worktree the main checkout's, so worktrees share its tasks. */
export async function projectFolder($: EngineInterface, cwd: string): Promise<string> {
  const common = await attempt($, ['git', '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir']);

  return common === undefined ? cwd : common.trim().replace(/\/\.git\/?$/, '');
}

/** Tasks slugs hold lowercase letters, digits, `-` and `_`, so `My.App` reads as `my-app`. */
export function categorySlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
}
