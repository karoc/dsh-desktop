# dsh-kanban

[![npm version](https://img.shields.io/npm/v/dsh-kanban.svg)](https://www.npmjs.com/package/dsh-kanban)
[![license MIT](https://img.shields.io/npm/l/dsh-kanban.svg)](LICENSE)

An **external** DeepSeek Harness plugin: a cross-session, cross-branch, persistent **plan / todo kanban board**.

When you chat with an agent (in dsh, Codex, Claude Code, …) you produce lots of plans and todos — and the pain is that once you switch to another branch or open a new session, those plans and todos become invisible: they still live in the long conversation, but you can't find them or remember them.

`dsh-kanban` sinks plans and todos into a **`KANBAN.json` file at the workspace root** (git-trackable, human-editable, survives sessions) and gives you two ways to maintain it:

- **Model entry**: 4 model-facing tools (`board_list` / `board_add` / `board_update` / `board_remove`) so the model records plan steps and todos while talking.
- **Web entry**: a new 「看板」 button in the dsh Web GUI sidebar that opens a **full-screen three-column board page** (To do / In progress / Done) with view, status move (incl. mark done), add, and delete.

The same `KANBAN.json` is shared by the model tools and the Web page, so **what the model writes, the page shows; what you check off on the page, the model reads next time.**

## What it adds

### Proactive model maintenance (host half, the core)

A **system-prompt guidance section** tells the model to actually use the board on
its own — record plans/todos as they appear, move cards as work progresses,
without waiting to be asked:

- When the user states a multi-step plan or task list → the model `board_add`s
  one card per step;
- As work progresses → the model `board_update`s cards to `in_progress` / `done`;
- Switching branches or opening a new session → the model `board_list`s first to
  pick up the durable record;
- Division of labor vs `todo_write`: `todo_write` is the transient in-turn task
  list; the board is the durable cross-session record — anything the user should
  still see after switching branches belongs on the board.

**What makes the model "proactively" use the board?** Two mechanisms, both in
dsh's **system prompt** and visible to the user:

1. **Board usage guidance** (`ctx.systemPrompt.section`): a fixed guidance
   section telling the model what the board is, when to record, and how it
   differs from `todo_write`.
2. **Session-start auto-injection** (`ctx.systemPrompt.context`): on every
   prompt assembly, the plugin reads the current session's workspace
   `KANBAN.json` and **injects an "open items" summary** (todo + in_progress)
   into the model's context. With no session / no cwd / an empty board it
   contributes nothing. Trade-off: the summary adds per-request token overhead
   and board changes alter the request prefix (KV-cache reuse impact).

**Data-safety commitment**: the plugin **only writes** board/note files; there
is no startup, scheduled, or install-time cleanup. Cards are removed only by an
explicit `board_remove` / the Web delete button; excess done cards are
**archived** (moved to `.agents/notes/archive.json`), never deleted. All data
lives inside your **workspace directory** (git-trackable, hand-editable).

### Model tools

| Tool | Purpose |
|---|---|
| `board_list` | Read the current workspace board (all cards with status, tags, timestamps). Call it before any update to get real ids. |
| `board_add` | Add a card (title required; optional summary/what, rationale/why, rejected/gave-up, description, status, tags). |
| `board_update` | Update a card by id (status / title / summary / rationale / rejected / description / tags). |
| `board_remove` | Remove a card by id. |
| `note_add` | Write an Agent Note (replication of the DSH repo discipline) to `.agents/notes/implemented/<class>/<date>-<topic>.md`. |
| `note_list` | List existing Agent Notes in the current workspace. |

The board is scoped to the **current session's working directory (cwd)**: every session under the same project directory shares one `KANBAN.json` — that's what makes it survive across sessions and branches.

### `/kanban` command

`/kanban` shows the current workspace board; `/kanban done <card-id>` marks a card done quickly.

### Web board page (client half)

- A 「看板」 entry in the sidebar footer (`sidebar.footer.action`);
- A full-screen three-column board: **To do / In progress / Done**, each column with a card count;
- Per card: a status dropdown (including "done"), and delete; an add form (title + optional description, Enter to submit) at the bottom;
- The page reads/writes the same `KANBAN.json` through the host-registered `/kanban/api` webServer route (GET read, POST add/update/remove) — independent of built-in dsh RPC, so official upgrades don't touch it.

### Data file

```
<workspace root>/KANBAN.json
```

```json
{
  "version": 1,
  "cards": [
    { "id": "card-xxxx", "title": "implement kanban tools", "description": "…", "status": "todo", "tags": ["dsh"], "createdAt": 1234567890, "updatedAt": 1234567890 }
  ]
}
```

The file shape is validated: a missing file reads as an empty board; a structurally broken file fails loud instead of being silently repaired (so a hand edit gone wrong never loses data quietly).

## Install

**Prereq:** a DeepSeek Harness with the `dsh` CLI, plus [pnpm](https://pnpm.io). This is an installable **bundle** — loaded by `dsh`, not imported as a library.

```sh
dsh plugin --profile web add dsh-kanban
```

**You must restart `dsh web` after installing** for both the host tools and the Web page to load.

## Usage

1. Install, restart `dsh web`; the sidebar footer shows the 「看板」 button.
2. Ask the model to record plan steps with `board_add` (e.g. "put xxx on the board"); it writes the current workspace's `KANBAN.json`.
3. Open 「看板」 anytime for the three-column view; mark done / move / add / delete directly on the page.
4. After switching branches or opening new sessions the board is still there — it's just a file in the workspace.

## Why an external plugin

dsh's official updates only touch the bundled in-repo packages. An **external bundle** is installed into the user profile via `dsh plugin` and is never touched by official upgrades (same pattern as `dsh-model-reasoning`). The plugin only uses dsh's externally stable capability surface: tool registration (`ctx.tools`), webServer route registration, and the Web sidebar/overlay slots.

## Known limitations (v1)

- **dsh only**: aggregating Codex / Claude Code todos is future work (the `KANBAN.json` file is plain, so any tool can read it later).
- **No auto-extraction**: model-driven writes plus manual page maintenance keep the data clean and controllable.
- **One board per workspace**: a flat card list; plans are expressed via tags or card groups (no multi-board / nested columns).
- **JSON first**: machine-friendly and diff-friendly; a `KANBAN.md` render view can come later.

## License

[MIT](LICENSE)
