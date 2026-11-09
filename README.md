# claude-tasks

The project's tasks from the [Tasks](https://github.com/Soleone/tasks) app in a Claude Code pane: browse them, change status and priority, edit or create one, and hand one to Claude. It is the Tasks backend of [pi-tasks](https://github.com/soleone/pi-tasks), ported to Claude Code's mod API.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install tasks --marketplace Soleone/claude-tasks
```

Answer `y` to add the marketplace, then pick a scope (user is first). From a shell: `claude plugin install tasks --marketplace Soleone/claude-tasks`. In the desktop app, click + next to the prompt box, then Plugins, Add marketplace with `Soleone/claude-tasks`, then Add plugin.

It needs the [Tasks](https://github.com/Soleone/tasks) app installed, for its `tasks-cli`.

Open and close the pane with `/todo` (`/tasks` is Claude Code's own background-tasks panel). To use a key, bind it to the command in `~/.claude/keybindings.json`:

```json
{ "context": "Chat", "bindings": { "alt+x": "command:todo" } }
```

## The pane

It follows pi-tasks' layout: a header (`Tasks • @category • active • 4 tasks`), one row per task (`→ ○ P2 90583df4 title`, children indented under their parent), the selected task's details under the list, and two lines of keyboard help. The list draws only the rows that fit, so the frame never scrolls and the arrows always move the selection. From 100 columns a row also shows its blockers and the first line of its description, as pi-tasks' second column.

Claude Code docks the pane beside the transcript in fullscreen from 110 columns and puts it above the prompt otherwise; a mod cannot draw an overlay.

| Key | Does |
| --- | --- |
| up / down, `j` / `k` | move between tasks, wrapping at the ends; a long list scrolls with the selection |
| Enter | work on the task: marks it in progress, fills the prompt with it and closes the pane; press Enter again to send. Claude completes it once the work is clearly done, such as committed |
| `s` | next status: open or paused starts, started completes, closed reopens |
| `o` | back to open: undoes a start, a pause or a close |
| `p` | pause |
| `0` - `4` | priority |
| `u` | undo the pane's last status or priority change, also one that closed the task and hid it from the list; repeat to go further back |
| `d` | edit title and description (Enter saves, Tab switches field, Esc goes back) |
| `c` / `n` | new task / new child of the selected task |
| `i` | put the task's details into the prompt |
| `x` | switch between active and closed tasks |
| `g` | link the folder to another category |
| `f` | search title and description as you type; Enter keeps the filter, Esc clears it |
| `r` | reload |
| Esc | back: leaves the form, clears the filter, then closes |

Enter and `i` add the task's images as file paths for Claude to open with Read, since a mod can put only text in the prompt; on WSL the Windows paths become `/mnt/...` paths.

Children are listed under their parent. A task waiting on open blockers shows `✖` and, when wide, `← blocker`.

## Which tasks

The tasks of the `@category` linked to the project's folder; for a git checkout the main repository's folder, so worktrees share it. New tasks get that category.

- A folder named like an existing category uses it: `My.App` reads as `@my-app`.
- Any other folder opens a picker the first time: the existing categories, the closest to the folder's name first, then a new one named after the folder (type to name it otherwise), then "none" for the tasks without a category. The pick is remembered for that folder on this computer.
- `g` opens the picker again to change the link.

Once a category is linked, Claude gets a short note in its system prompt naming the CLI and the category, so "add a task for that" works from the chat. It may read tasks whenever they help, but creates or changes one only when asked; otherwise it suggests the task and waits for a yes.

## Where the CLI comes from

Everything goes through `tasks-cli --json`, the same command path the app uses, so the app and the pane stay in sync and the app's lock applies. The mod never reads the Tasks files or database itself.

1. The `cli` option in `/config`, when set. On WSL you can paste the Windows path as Explorer copies it (`"D:\apps\Tasks\tasks-cli.exe"`); it becomes `/mnt/d/...`.
2. `tasks-cli` on `PATH` (Linux packages put it in `/usr/bin`).
3. On WSL: the Windows install's `tasks-cli.exe`, found through the registry (`HKCU\...\Uninstall\Tasks`, `InstallLocation`) and run through WSL interop. The Tasks home lives on the Windows side, and its SQLite cache must never be opened from WSL, so the Windows CLI does the work and uses the home the Windows app opens.

Status and priority changes show in the pane at once and are undone by the reload if the CLI refuses them; each CLI call takes about a quarter second through WSL. Edits to existing tasks carry the version the pane read, so a change made in the app meanwhile fails with `STALE_TASK_VERSION` instead of being overwritten; `r` reloads.

## Not ported from pi-tasks

The other backends (sq, tq, beads, TODO.md), the flat list mode with collapsing, and the parent and blocker pickers. Claude Code mods take hotkeys as single letters or digits, so pi-tasks' `space` (status), `Tab` (insert) and `Delete` (close) moved to `s`, `i` and the status key, and `w`/`s` navigation to `j`/`k`.

## Tests

```bash
claude plugin validate .
claude plugin test .
```
