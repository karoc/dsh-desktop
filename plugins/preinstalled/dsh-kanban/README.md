# dsh-kanban

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

> Verified with a real model (user only said "build a Markdown-to-HTML tool and
> make a plan", no mention of the board): the model proactively `board_list`'d,
> `board_add`'d all 7 plan steps, then `board_update`'d each to done as it went.

### How it works & transparency

**What makes the model "proactively" use the board?** Two mechanisms, both in
dsh's **system prompt** and visible to the user:

1. **Board usage guidance** (`ctx.systemPrompt.section`): a fixed guidance
   section telling the model what the board is, when to record, and how it
   differs from `todo_write`. Updated with plugin releases.
2. **Session-start auto-injection** (`ctx.systemPrompt.context`): on every
   prompt assembly, the plugin reads the current session's workspace
   `KANBAN.json` and **injects an "open items" summary** (todo + in_progress)
   into the model's context — so the model sees the board immediately, without
   having to remember to `board_list`. With no session / no cwd / an empty
   board it contributes nothing.

**Trade-offs of the auto-injection (stated openly):**

| Aspect | Notes |
|---|---|
| ✅ Pro | The model **always sees** the current workspace's open items — no "remember to check"; cross-session continuity is guaranteed by the system, not the model's diligence |
| ⚠️ Cost 1 | Every request carries the board summary, adding **fixed token overhead** (grows with the board) |
| ⚠️ Cost 2 | Board changes **alter the request prefix**, which can affect **KV-cache reuse**. To limit this, **only open items are injected** (todo + in_progress) — done cards churn would worsen prefix instability |
| ⚠️ Trade-off | "System pushes" vs "model queries" — injection guarantees visibility at the price of per-request overhead |

**The full "make the model use it" mechanism:**
1. **Board usage guidance** (`ctx.systemPrompt.section`): what the board is,
   when to record, how it differs from `todo_write`.
2. **Session-start auto-injection** (`ctx.systemPrompt.context`): open items
   are pushed into the model's context (see above).
3. **Wrap-up discipline**: the guidance requires that at the end of every work
   session the model moves completed cards to done, adds follow-ups as todos,
   updates summaries, and **never leaves stale `in_progress` cards** — the
   board stays an honest cross-session hand-off.
4. **User-side visibility**: the sidebar 「看板」 entry shows an **open-item
   count badge** (backed by the `/kanban/counts` route; workspace resolved from
   the most-recent workspace, subscribes to workspace-list changes so it
   appears as soon as data is ready); the board page **auto-refreshes every
   15s** while open, so model/other-session writes appear without a manual
   refresh.

**Data-safety commitment**: the plugin **only writes** board/note files; there
is no startup, scheduled, or install-time cleanup. Cards are removed only by an
explicit `board_remove` / the Web delete button (which requires a confirmation
Modal — no accidental one-click loss); excess done cards are **archived**
(moved to `.agents/notes/archive.json`), never deleted. All data lives inside
your **workspace directory** (git-trackable, hand-editable).

### Model tools

| Tool | Purpose |
|---|---|
| `board_list` | Read the current workspace board (all cards with status, tags, timestamps). Call it before any update to get real ids. |
| `board_add` | Add a card (title required; optional summary/what, rationale/why, rejected/gave-up, description, status, tags). |
| `board_update` | Update a card by id (status / title / summary / rationale / rejected / description / tags). |
| `board_remove` | Remove a card by id. |
| `note_add` | Write an Agent Note (full replication of the DSH repo discipline) to `.agents/notes/implemented/<class>/<date>-<topic>.md`. |
| `note_list` | List existing Agent Notes in the current workspace. |

The board is scoped to the **current session's working directory (cwd)**: every session under the same project directory shares one `KANBAN.json` — that's what makes it survive across sessions and branches.

### Editable Agent Note spec (reuse, not re-invention; synced via overrides)

`note_add`'s output format, classes, and "non-trivial change" definition are
**replicated from the deepseek-harness repo** (no re-inventing the wheel):

| Item | Upstream source |
|---|---|
| Note classes | `scripts/agent-note-tree.ts` → `AGENT_NOTE_CLASSES` |
| Note format | `scripts/verify-agent-note-format.ts` |
| Non-trivial definition | root `AGENTS.md` ("Non-trivial changes MUST include an Agent Note…") |

- **Plugin ships defaults** (updated per release): `src/note-spec.ts` fixes the
  default classes, format template, and definition — works out of the box;
- **User overrides**: the Web board page's **Agent Note spec** section has three
  inputs to paste newer upstream content over the defaults; overrides are stored
  at the workspace's `.agents/notes/overrides.json`;
- **Source hints**: each input states which dsh source file to copy from;
- **Update warning**: when the plugin ships a newer spec version than a workspace
  with custom overrides, the page warns that updating the plugin resets overrides
  to the new defaults (custom content is lost). "Save overrides" acknowledges the
  current version; "Reset to defaults" clears them.

> Why not `import` dsh directly: `verify-agent-note-format.ts` is a dsh repo
> internal script — not published, not installable, unreachable from an external
> plugin. The spec is fixed as constants and synced via "input-box overrides +
> plugin releases".

#### Sync mechanism (dev-time check + releases)

- **Source anchor**: `src/note-spec.ts` states it is replicated from
  deepseek-harness (upstream commit `47f943859bef60e4160492346772ded9b24f765a`);
- **Dev-time check**: `pnpm check:spec` (`scripts/check-note-spec.mjs`) reads the
  local dsh checkout's spec constants (classes from `agent-note-tree.ts`, format
  from `verify-agent-note-format.ts`, non-trivial rule from `AGENTS.md`) and
  diffs them against the plugin defaults — when upstream changes, one run reports
  the difference and tells you to update `src/note-spec.ts` and bump
  `NOTE_SPEC_VERSION`;
- **Release sync**: the author updates the defaults and ships a new version;
  `dsh plugin update dsh-kanban` delivers the new defaults (if the user had
  custom overrides, the update warning explains they get reset).

`check:spec` needs the local dsh source path — it is a **dev-time tool** (not
shipped, not part of the user-facing `test` chain).

### `/kanban` command

`/kanban` shows the current workspace board; `/kanban done <card-id>` marks a card done quickly.

### Web board page (client half)

- A 「看板」 entry in the sidebar footer (`sidebar.footer.action`), showing an
  **open-item count badge** (number when there are todo/in_progress cards,
  "99+" cap);
- A full-screen three-column board: **To do / In progress / Done**, each
  column with a card count;
- **Workspace switcher**: switch between any registered workspace at the top
  (each workspace owns its KANBAN.json); defaults to the current session's
  workspace;
- Per card: a status dropdown (including "done"), and **delete with a
  confirmation Modal** (no accidental one-click loss); cards show the
  what/why/rejected fields the model filled, and model-created cards carry an
  "Open source session" button (jump to the handling session);
- An add form at the bottom: title + the three what/why/rejected inputs laid
  out in one row of three columns;
- **Auto-refresh**: while open, the page refreshes every 15s so
  model/other-session writes appear without a manual refresh;
- The page reads/writes the same `KANBAN.json` through the host-registered
  `/kanban/api` and `/kanban/counts` webServer routes (GET read, POST
  add/update/remove) — independent of built-in dsh RPC, so official upgrades
  don't touch it.

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

### From a local dev checkout

```sh
dsh plugin --profile web add /home/karoc/dsh-kanban
```

### From npm (after publishing)

```sh
dsh plugin --profile web add dsh-kanban
```

### From git

```sh
dsh plugin --profile web add github:karoc/dsh-kanban#<sha>
```

Git installs run the package `prepare` script to build the bundle; pnpm ≥ 10 asks you to allowlist the build once in the profile's `pnpm-workspace.yaml` (`allowBuilds`), then re-run `add`.

**You must restart `dsh web` after installing** for both the host tools and the Web page to load.

### Update / remove

```sh
dsh plugin --profile web update dsh-kanban
dsh plugin --profile web remove dsh-kanban   # removes dependency + bundle layer; entry disappears after restart
```

## Usage

1. Install, restart `dsh web`; the sidebar footer shows the 「看板」 button.
2. Ask the model to record plan steps with `board_add` (e.g. "put xxx on the board"); it writes the current workspace's `KANBAN.json`.
3. Open 「看板」 anytime for the three-column view; mark done / move / add / delete directly on the page.
4. After switching branches or opening new sessions the board is still there — it's just a file in the workspace.

## Directory layout

```
cordis.patch.yml        # bundle layer: mounts this package (host tools + client half)
package.json            # dsh.bundle (patch) + dsh.client (web) + exports["./client"]
tsdown.config.ts        # self-contained build: node half + module-table client bundle
src/board-core.ts       # KANBAN.json domain: read/write, validation, card CRUD (shared)
src/index.ts            # host half: 4 model tools + /kanban/api webServer route
src/client/index.ts     # client apply: sidebar entry + full-screen board page
src/client/BoardPage.tsx       # three-column board component
src/client/KanbanSurface.tsx   # sidebar button + overlay wrapper
src/client/board-state.ts      # module-level page visibility observable
src/client/locales.ts          # zh/en copy
src/client/styles.ts           # --dsw-alias-* design-token styles
```

## Why an external plugin

dsh's official updates only touch the bundled in-repo packages. An **external bundle** is installed into the user profile via `dsh plugin` and is never touched by official upgrades (same pattern as `dsh-model-reasoning`). The plugin only uses dsh's externally stable capability surface: tool registration (`ctx.tools`), webServer route registration, and the Web sidebar/overlay slots.

## Known limitations (v1)

- **dsh only**: aggregating Codex / Claude Code todos is future work (the `KANBAN.json` file is plain, so any tool can read it later).
- **No auto-extraction**: model-driven writes plus manual page maintenance keep the data clean and controllable.
- **One board per workspace**: a flat card list; plans are expressed via tags or card groups (no multi-board / nested columns).
- **JSON first**: machine-friendly and diff-friendly; a `KANBAN.md` render view can come later.

## Development

```sh
pnpm install   # build deps (tsdown, react)
pnpm bundle    # emits lib/index.js + lib/client.js
```

- `src/client/` is the browser plugin; the client bundle keeps `@deepseek-ai/*` + `react` external (resolved from the loader module table at runtime) and inlines everything else.
- UI uses `--dsw-alias-*` design tokens, namespaced with the `kb-` prefix.

## Verification

```sh
pnpm test       # tsc --noEmit typecheck + 14 KANBAN.json domain unit tests + host tool smoke
pnpm typecheck  # typecheck only (tsc --noEmit)
pnpm verify     # 4 board tools registered + board_add persisted end-to-end
pnpm accept     # GUI acceptance against a running dsh web (http://127.0.0.1:3080):
                #   native-DSH sidebar entry → opaque full-screen three-column page
                #   → add / move / delete
```

External plugins get no compile-time typechecking by default (tsdown only
transpiles); `tsc --noEmit` in `pnpm test` catches "used-but-not-imported"
mistakes that would otherwise crash at runtime (a missing `IconCheckOutline16`
import once took down the whole board page).

`scripts/verify-model-board.mjs` additionally verifies a **real model call**: it sends
the GUI agent an instruction to use `board_add`/`board_list`, then confirms the card
lands in `KANBAN.json` at the session cwd and is visible on the board page (the
model-writes ↔ Web-sees round trip).

## License

[MIT](LICENSE)
