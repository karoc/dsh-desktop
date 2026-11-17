# Smoothly Kanban

[![license MIT](https://img.shields.io/npm/l/dsh-kanban.svg)](LICENSE)

Smoothly Kanban（**思磨力看板**）is an **external** DeepSeek Harness plugin: a cross-session, cross-branch, persistent **plan / todo kanban board**.

When you chat with an agent (in dsh, Codex, Claude Code, …) you produce lots of plans and todos — and the pain is that once you switch to another branch or open a new session, those plans and todos become invisible: they still live in the long conversation, but you can't find them or remember them.

`dsh-kanban` sinks plans and todos into a **`KANBAN.json` file at the workspace root** (git-trackable, human-editable, survives sessions) and gives you two ways to maintain it:

- **Model entry**: 4 model-facing tools (`board_list` / `board_add` / `board_update` / `board_remove`) so the model records plan steps and todos while talking.
- **Web entry**: a 「思磨力看板」 entry in the dsh Web GUI sidebar's **global panels** section that renders a **three-column board page** (To do / In progress / Done) in the centre column, with search + status/tag filtering, view, status move (incl. mark done), add, and delete.

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
- Claiming shared work → the guidance says to move a card to `in_progress`
  before starting it, treat an `in_progress` card you did not claim as someone
  else's work, and split rather than race when two sessions need the same work;
- Closing a shipped card → cite verifiable coordinates (commit/PR id, command
  output, artifact path) in the summary when they exist;
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
   when to record, how it differs from `todo_write`, and the
   **card-completeness contract** — every card needs a rationale (why at
   creation); a done card must carry all three what/why/rejected fields.
2. **Session-start auto-injection** (`ctx.systemPrompt.context`): open items
   are pushed into the model's context (see above); cards missing fields are
   flagged `(缺:…)` so the model fills them when it picks the work up.
3. **Wrap-up discipline**: the guidance requires that at the end of every work
   session the model moves completed cards to done, adds follow-ups as todos,
   updates summaries, and **never leaves stale `in_progress` cards** — the
   board stays an honest cross-session hand-off.
4. **User-side visibility**: the sidebar's global-panels 「思磨力看板」 entry
   carries an **open-item count badge** on its glyph (backed by the
   `/kanban/counts` route; the workspace follows the current session, then the
   most recent one, and the badge subscribes to workspace-list changes so it
   appears as soon as data is ready); the board panel **auto-refreshes every
   15s** while shown, so model/other-session writes appear without a manual
   refresh.

**Data-safety commitment**: the plugin **only writes** board/note files (plus,
on a shell with no skill registry, the `~/.agents/skills/kanban-use/SKILL.md`
copy described below, and short-lived `KANBAN.json.lock` / `*.tmp` files next to
the board while a write is in flight); there is no startup, scheduled, or
install-time cleanup. Cards are removed only by an explicit `board_remove` / the
Web delete button (which requires a confirmation Modal — no accidental one-click
loss) and removal is permanent (not archived) — prefer moving finished work to
done; excess done cards (**beyond 100, oldest first**) are **archived** (moved to
`.agents/notes/archive.json`), never deleted. All board data lives inside your
**workspace directory** (git-trackable, hand-editable).

### Model tools

| Tool | Purpose |
|---|---|
| `board_list` | Read the current workspace board. By default returns **open cards only**, each rendered with its **exact id**, status, tags and missing-field flags; `status` / `tag` / `includeDone` / `order` / `limit` narrow and order the view, `detail: true` adds the card bodies. Counters (and the archive count/path when present) always describe the whole board. Call it before `board_update` / `board_remove` to get real ids; `board_add` needs no prior read. |
| `board_add` | Add a card (title + **rationale/why expected on every card** — a title-only card is incomplete and flagged 缺; rejected/gave-up when a decision was made; summary/what filled at completion; optional description, status, tags). Returns only the new card + counters. |
| `board_update` | Update a card by id (status / title / summary / rationale / rejected / description / tags). Returns only the touched card + counters. |
| `board_remove` | Remove a card by id. Returns the removed id + counters. |
| `note_add` | Write an Agent Note (full replication of the DSH repo discipline) to `.agents/notes/implemented/<class>/<date>-<topic>.md`. |
| `note_list` | List existing Agent Notes in the current workspace. |

The board is scoped to the **current session's working directory (cwd)**: every session under the same project directory shares one `KANBAN.json` — that's what makes it survive across sessions and branches. Because it is shared, every mutation runs under an advisory `KANBAN.json.lock` (O_EXCL; a 10 s bounded wait that fails loudly instead of overwriting; a same-host lock is only taken over once its recorded pid is gone, and release only removes the lock it owns) on top of the atomic tmp+rename write: two sessions/agents cannot silently overwrite each other's read-modify-write, and a crashed writer cannot wedge the board forever.

The `/kanban/*` HTTP routes are **fenced by the host's own trust check**: on DSH ≤ 0.1.x the plugin asks `Connection.requestRejection` (Host/Origin/browser auth), and on DSH 0.2.x — where that method was removed — the `webServer` enforces each route's `auth: 'required'` policy before dispatch and hands the handler the admitted Peer; a request with neither a fence nor a Peer is refused (401) and **no board read happens**. Untrusted requests get 401/403 before any filesystem work, the `cwd` must be an absolute existing directory (a route never creates one), and POST bodies must be `application/json`. The model tools are unaffected — they run inside the authenticated session.

### Editable Agent Note spec (reuse, not re-invention; synced via overrides)

`note_add`'s output format, classes, and "non-trivial change" definition are
**replicated from the deepseek-harness repo** (no re-inventing the wheel):

| Item | Upstream source |
|---|---|
| Note classes | `scripts/agent-note-tree.ts` → `AGENT_NOTE_CLASSES` |
| Note format | `scripts/verify-agent-note-format.ts` |
| Non-trivial definition | `.agents/notes/README.md` → "When to write one" (root `AGENTS.md` only points at it) |

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
  deepseek-harness (upstream commit `ddefc45fbc7f8e46dd73185e68295696d1297887`);
- **Dev-time check**: `pnpm check:spec` (`scripts/check-note-spec.mjs`) reads the
  local dsh checkout's spec constants (classes from `agent-note-tree.ts`, format
  from `verify-agent-note-format.ts`, note-scope rule from
  `.agents/notes/README.md` + the `AGENTS.md` pointer to it) and
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

![The three-column board page (To do / In progress / Done)](https://raw.githubusercontent.com/karoc/dsh-kanban/main/docs/screenshots/board-page.png)

- A 「思磨力看板」 entry in the sidebar's **global panels** section
  (`sidebar.panellist`) with an **open-item count badge** on the glyph (number
  when there are todo/in_progress cards, "99+" cap);
- The board is the `main` slot's occupant for that panel id: selecting the entry
  renders it in the centre column (the Conversation steps aside, exactly like
  the built-in Plugins page), and 「返回会话」/“Back to conversation” returns;
- A three-column board: **To do / In progress / Done**, each
  column with a card count;
- **Workspace switcher**: switch between any registered workspace at the top
  (each workspace owns its KANBAN.json); defaults to the current session's
  workspace;
- Per card: a status dropdown (including "done"), and **delete with a
  confirmation Modal** (no accidental one-click loss); cards show the
  what/why/rejected fields the model filled, and model-created cards carry an
  "Open source session" button (jump to the handling session);
- **Two-line clamped previews**: each of the three what/why/rejected fields on
  a card shows at most two lines, with an ellipsis (`...`) for the rest — cards
  stay compact and scannable; the description is clamped the same way (the
  longest real one carried 2,528 characters, a ~755px card); the full text is in
  the detail dialog;
- **Ordered by last change, not by creation**: within a column the most recently
  touched card comes first (`updatedAt`, then `createdAt`, then id). The done
  column used to be read in creation order, which on the audited 108-card board
  buried the cards finished most recently below row 20 (one at #99);
- **Search, status and tag filters**: the search box matches every rendered
  field (title, description, what/why/rejected, tags, id) and ANDs
  whitespace-separated terms; status pills narrow the board to one full-width
  column; a card's tag pills filter the board to that tag (they were decorative
  before). Filtering lifts the done column's page window, so a search hit is
  never left behind the "load more" button;
- **Done-column paging**: the done column renders the 20 most recently completed
  cards plus one "Load more" step at a time (the column badge still counts every
  match), so a 108-card board paints fast and the recent end stays on top;
- **Detail dialog**: clicking the card's title + what/why/rejected region
  (including the description) opens a detail Modal where the full content is
  laid out in labeled sections (icon + label + newline-preserving body), plus
  status, tags, source session and created/updated times — a comfortable
  reading view;
- An add form at the bottom: title + the three what/why/rejected inputs laid
  out in one row of three columns;
- **Silent auto-refresh**: while open, the page polls every 15s and diffs by a
  content signature — when nothing changed it leaves the card DOM completely
  untouched, so it never interrupts reading or drops the scroll position; the
  header shows "auto-refreshed at HH:mm:ss" so the poll's liveness is visible;
  a failed poll keeps the current view (no error flash);
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

1. Install, restart `dsh web`; the sidebar's global panels section shows the 「思磨力看板」 entry.
2. Ask the model to record plan steps with `board_add` (e.g. "put xxx on the board"); it writes the current workspace's `KANBAN.json`.
3. Open 「思磨力看板」 anytime for the three-column view; mark done / move / add / delete directly on the page.
4. After switching branches or opening new sessions the board is still there — it's just a file in the workspace.

## Card completeness & the kanban-use skill

Cards are the board's cross-session memory: the next session reads them **without asking you**. The plugin therefore enforces a completeness contract on every surface the model sees (same rule everywhere, `missingCardFields` in `board-core.ts`):

- **Every card needs `rationale` (为什么)** — why it exists and why now. A title-only card is incomplete and is flagged:
  - in **tool outputs** (`⚠️缺:…` after the card line, plus a summary line when any card is incomplete),
  - in the **session-start snapshot** (`(缺:…)` on open items, so a resuming session can fill them),
  - on the **Web board page** (a warning line under the card fields — `missing: …` in the English UI, `缺字段：…` in Chinese — humans see it too).
- **A `done` card must be self-explanatory**: `summary` (做了什么) + `rationale` + `rejected` (放弃了什么) all present, so the completed work is an honest hand-off.

**The kanban-use skill** (`skills/kanban-use/SKILL.md`) is the deep manual for this discipline — field semantics, good/bad card examples, the create → advance → close flow, a close checklist, and templates. The system-prompt guidance points the model at it. **Delivery has two paths, and neither asks the user for an extra step.** **Preferred (DSH ≥ 0.1.6, i.e. `ctx.skills` exists)**: the host half registers the packaged `skills/kanban-use/SKILL.md` straight into the shell's skill registry (`ctx.skills.register`, `source: 'runtime'`), so the shipped skill content and the plugin stay in lockstep — the separate `skill-version` fingerprint only drives the copy fallback, it is not the plugin version, and a frontmatter DSH cannot parse cannot silently hide it; by DSH's precedence (project > runtime > user) a copy in `~/.agents/skills` **cannot** shadow it, while a project-level `.agents/skills` (or `.dsh/skills`) copy still wins — the documented way to customize. **Fallback (an older shell, or a profile without the skill service)**: copy install — the skill ships inside the npm package (the tarball includes `skills/kanban-use/SKILL.md` and `scripts/install-skill.mjs`) and the host half checks `~/.agents/skills/kanban-use/SKILL.md` on every `dsh web` start. A `skill-version` fingerprint in the skill's frontmatter (bumped on content changes) drives that copy policy: missing → copies the shipped file in; identical → no-op; **same or newer version but different content → your local copy is kept** (that is your own edit of the current version) with a hint; **older version (or a copy with no fingerprint) → synced over** (that is stale package content from a previous install, the upgrade path). So `dsh plugin add/update dsh-kanban` + the required restart is all it takes, on any machine. The manual commands still exist for repo checkouts and forced syncs:

```sh
pnpm install:skill            # symlinks skills/kanban-use → ~/.agents/skills/kanban-use
node scripts/install-skill.mjs --copy   # materialize/overwrite a copy (works inside the installed package too)
```

The skill is **maintained in this repository alongside the plugin** — the release/dev gates (`pnpm check:cards` → `scripts/check-card-discipline.mjs`) assert that the skill's field semantics and tool names stay consistent with the plugin's schema, and `scripts/audit-cards.mjs <workspace> [--fail]` reports incomplete cards in any workspace's `KANBAN.json`.

## Directory layout

```
cordis.patch.yml        # bundle layer: mounts this package (host tools + client half)
package.json            # dsh.bundle (patch) + dsh.client (web) + exports["./client"]
tsdown.config.ts        # self-contained build: node half + module-table client bundle
src/board-core.ts       # KANBAN.json domain: read/write, validation, card CRUD,
                        #   missingCardFields completeness rule (shared)
src/index.ts            # host half: 4 model tools + /kanban/api webServer route
src/client/index.ts     # client apply: global panel (sidebar glyph + 'main' occupant)
src/client/BoardPage.tsx       # three-column board component (+ missing-field hints)
src/client/board-view.ts       # pure ordering / search / filter / done-window rules (unit-tested)
src/client/KanbanSurface.tsx   # panel glyph + the 'main' panel wrapper
src/client/workspace-pick.ts   # current-session + most-recently-active workspace derivations (pure, unit-tested)
src/client/board-counts.ts     # /kanban/counts poll behind the glyph badge
src/client/locales.ts          # zh/en copy
src/client/styles.ts           # --dsw-alias-* design-token styles
src/skill-register.ts          # host half: kanban-use served through ctx.skills (DSH ≥ 0.1.6)
src/skill-sync.ts              # host half: copy fallback for shells without the skill service
skills/kanban-use/SKILL.md     # the kanban-use skill (ships in the npm tarball)
scripts/check-card-discipline.mjs # dev gate: guidance/schema/skill agree on completeness
scripts/check-tokens.mjs         # dev gate: every --dsw-alias-* token exists in the installed DSH theme
scripts/check-client-wiring.mjs  # dev gate: panel id/key wiring survived the edit
scripts/audit-cards.mjs          # KANBAN.json completeness audit ([workspace] [--fail])
scripts/install-skill.mjs        # symlink/copy the skill into ~/.agents/skills (shipped too)
scripts/verify-skill-sync.mjs    # copy-fallback three-state verification (part of pnpm test)
scripts/verify-skill-runtime.mjs # runtime skill registration vs a real registry (part of pnpm test)
docs/screenshots/board-page.png  # Web board page screenshot (README figure)
```

## Why an external plugin

dsh's official updates only touch the bundled in-repo packages. An **external bundle** is installed into the user profile via `dsh plugin` and is never touched by official upgrades (same pattern as `dsh-model-reasoning`). The plugin only uses dsh's externally stable capability surface: tool registration (`ctx.tools`), webServer route registration, system-prompt guidance (`ctx.systemPrompt.section` / `.context`), the command registry (`ctx.commands`), the skill registry (`ctx.skills`), and the Web global-panel slots (`sidebar.panellist` + `main`).

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
- UI uses `--dsw-alias-*` design tokens, namespaced with the `kb-` prefix; `pnpm check:tokens` fails on any token the installed DSH theme does not define (an unknown custom property renders as *nothing*, silently).
- The board is a DSH **global panel**: `sidebar.panellist` draws the sidebar row, the keyed `main` slot hosts the page. `pnpm check:wiring` pins that wiring; the live-GUI scripts verify it in a browser.

## Verification

```sh
pnpm test       # tsc --noEmit typecheck + 56 unit tests (board domain 26, workspace pick 13,
                #   note naming 4, board view 13) + token-drift gate (with negative control)
                #   + panel-wiring gate + host tool smoke
                #   + skill runtime registration vs a real registry
                #   + 25 negative guarantee rows + 7 negative controls + the release gate
pnpm typecheck  # typecheck only (tsc --noEmit)
pnpm verify     # 4 board tools registered + board_add persisted end-to-end
pnpm accept     # GUI acceptance against a running dsh web (http://127.0.0.1:3080):
                #   sidebar global-panel row → board rendered in the centre column
                #   (opaque, row marked selected) → add / move / delete
node scripts/capture-board-page.mjs  # refresh the README figure from the live GUI
                #   (captures the board panel only — never the session sidebar)
```

Since DSH 0.1.2-alpha.2 the Web GUI protects its index with a browser-session
cookie ("dsh web authentication required"); the live-GUI scripts authenticate
themselves through the `/?token=` handshake. Point them at the token `dsh web`
printed on launch via `DSH_WEB_TOKEN`, or pass the full launch URL (including
`?token=...`) as `DSH_GUI_URL`; on instances where auth is off they run
unchanged.

Since DSH 0.1.3-alpha.1 the composer input is a contenteditable div (0.1.2 used
`<textarea>`); the live-GUI scripts match both (`textarea, [contenteditable="true"]`),
so the same scripts run against either version.

External plugins get no compile-time typechecking by default (tsdown only
transpiles); `tsc --noEmit` in `pnpm test` catches "used-but-not-imported"
mistakes that would otherwise crash at runtime (a missing `IconCheckOutline16`
import once took down the whole board page).

Since DSH 0.1.6-alpha.2 the client `SessionListState` no longer carries
`current`; the board derives the current session from main-view retention
(`retainedBy.mainView`), the same predicate the shell's own sidebar, session
binding, and Settings use — and still reads `current` when an older shell
provides it.

Since DSH 0.1.7-alpha.1 icons carry their stroke weight in the name
(`*Regular` = 1 px, `*Medium` = 1.3 px) and the size-suffixed names are gone;
the board imports the `*Regular` variants, with every rendered size unchanged
(the artwork defaults still carry the old sizes). **The client half therefore
requires DSH ≥ 0.1.7 since 0.2.9** — 0.2.8 is the release for 0.1.2–0.1.6. That
floor is also declared, since 0.2.10, as an optional
`@deepseek-ai/dsh-client-ui-slots` peer dependency, range `>=0.1.7-rc.1` (the
prerelease floor is load-bearing: a plain `>=0.1.7` does not match a
`0.1.7-rc.N` runtime). The peer gate itself shipped with **DSH 0.1.7-rc.1**:
from there on the loader evaluates every `@deepseek-ai/dsh*` peer against the
running runtime and skips an incompatible bundle with the exact
`dsh plugin allow-version` remedy (`dsh plugin add` refuses it outright) — so a
future plugin floor is enforced up front instead of failing later at render
time. Runtimes older than the gate — everything up to and including
0.1.7-alpha.2, hence all of 0.1.2–0.1.6 — do not evaluate peers at all: there
the plugin still loads and the client half is what breaks on render, which is
why 0.2.8 remains the release for those.

`scripts/verify-model-board.mjs` additionally verifies a **real model call**: it sends
the GUI agent an instruction to use `board_add`/`board_list`, then confirms the card
lands in `KANBAN.json` at the session cwd and is visible on the board page (the
model-writes ↔ Web-sees round trip).

## License

[MIT](LICENSE)
