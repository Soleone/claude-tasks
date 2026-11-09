import { expect, test } from 'claude-code/testing';

import { categorySlug } from '../hooks/cli';
import { details, matching, nested, nextStatusVerb } from '../hooks/tasks';
import type { Task } from '../types';

const task = (id: string, title: string, parentId: string | null = null): Task => ({
  id,
  title,
  description: '',
  status: 'open',
  priority: 2,
  category: 'demo',
  parentId,
  blockedByIds: [],
  attachments: [],
  version: 1,
});

test('children follow their parent one level deeper, orphans are roots', async () => {
  const rows = nested([task('c', 'child', 'p'), task('p', 'parent'), task('o', 'orphan', 'gone')]);

  expect(rows.map(row => `${row.depth}:${row.task.id}`)).toEqual(['0:p', '1:c', '0:o']);
});

test('a search keeps the path to each match', async () => {
  const kept = matching([task('p', 'parent'), task('c', 'fix login', 'p'), task('x', 'other')], 'LOGIN');

  expect(kept.map(one => one.id)).toEqual(['p', 'c']);
});

test('status steps open to started to done, and back to open', async () => {
  expect(nextStatusVerb('open')).toBe('start');
  expect(nextStatusVerb('paused')).toBe('start');
  expect(nextStatusVerb('in_progress')).toBe('complete');
  expect(nextStatusVerb('done')).toBe('reopen');
  expect(nextStatusVerb('canceled')).toBe('reopen');
});

test('folder names become category slugs', async () => {
  expect(categorySlug('My.App')).toBe('my-app');
  expect(categorySlug('claude-tasks')).toBe('claude-tasks');
});

test('inserted details list the images for Claude to open', async () => {
  const text = details(task('a', 'squished circle'), ['/mnt/d/data/tasks/sync/attachments/shot.png']);

  expect(text).toContain('- /mnt/d/data/tasks/sync/attachments/shot.png');
});
