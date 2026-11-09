/** A task as `tasks-cli --json` returns it, trimmed to the fields the pane uses. */
export type Task = {
  id: string;
  title: string;
  description: string;
  status: 'open' | 'in_progress' | 'paused' | 'done' | 'canceled';
  priority: number;
  category: string | null;
  parentId: string | null;
  /** The open tasks this one waits on; closed blockers are not listed. */
  blockedByIds: string[];
  /** Image file names in the home's attachments folder; `show` prints their paths. */
  attachments: string[];
  version: number;
};

export type Scope = 'active' | 'closed';

export type Category = { slug: string; taskCount: number };

/** The category the project's folder is linked to: a slug, `null` for the uncategorized tasks, or not picked yet. */
export type Link = { kind: 'unset' } | { kind: 'linked'; slug: string | null };

/** The list, the category picker, or the form for one task: `id` edits it, no `id` creates one under `parentId`. */
export type View = { kind: 'list' } | { kind: 'pick' } | { kind: 'edit'; id?: string; parentId?: string };

declare module 'claude-code' {
  interface PluginState {
    'tasks': {
      tasks: Task[];
      scope: Scope;
      view: View;
      /** The filter applied to the list; `searching` while it is being typed. */
      search: string;
      searching: boolean;
      /** The task the focus ring is on: the row marked, the one shown below the list. */
      selected: string;
      /** The form field holding the keys, drawn in the accent color. */
      field: string;
      link: Link;
      /** The Tasks home's categories, read when the picker opens, and the picker's filter. */
      categories: Category[];
      categoryQuery: string;
    };
  }
}
