# Smoothly Turn Nav (Smoothly TN)

**Smoothly · 思磨力** — brand · 中文名：**思磨力轮次胶囊条**

**Every turn of your conversation, one glance away.**

Smoothly Turn Nav (**Smoothly TN**) — 思磨力轮次胶囊条 — is an external plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) that puts a **piano-key turn rail** on the right edge of every conversation — a vertical column of tiny capsules, one per turn. It gives you a full minimap of the conversation: **every turn ever made** (not just the ones currently loaded), hover previews, click-to-jump to any turn's start, and follow-scroll highlighting. It can also **replace the official built-in turn rail**, which has no off-switch of its own.

![Turn navigation rail](docs/turn-nav-rail.png)

## Why

In the default DSH web UI, the official turn rail historically showed only the **currently loaded window** of turns — in a long conversation, most turns are invisible until you scroll and load more. As of dsh **0.1.3-alpha.1** the built-in rail also gained full-session scope and out-of-window jumps through a host-side `turnOutline` projection, but it still **cannot be switched off**. Smoothly TN solves the long-session problem and stays fully replaceable:

- **Full history at a glance** — every persisted turn is shown as plain data, including turns far outside the loaded window. No scrolling, no loading, no waiting.
- **Hover to preview** — the capsule glows with the theme color and widens in a wave ripple; a DSH-style tooltip shows the turn's number, time, and user-message summary.
- **Click to jump anywhere** — jumps to any turn's start, even turns not yet loaded (the window is extended on demand with instant feedback).
- **Know where you are** — the current turn is highlighted as you scroll.

## Features

| | |
|---|---|
| 🗺️ **Full-history minimap** | All turns visible immediately — read from the persisted session log as data, **zero prepends** into the conversation flow on open (long sessions stay responsive) |
| 🎹 **Piano-key design** | One capsule per turn, ~3px tall, right-aligned on the right edge; auto-sizing (up to 30vh) with an internal hidden scrollbar |
| 🌊 **Wave hover** | Hovered capsule glows with the theme color and widens 150% leftward; its two neighbours widen 125% — a ripple across the rail |
| 💬 **Rich tooltip** | Turn **number, timestamp, and full user-message summary**, always fully inside the viewport |
| 🎯 **Jump to any turn** | Precise `scrollTop` targeting (no `scrollIntoView` fights); out-of-window jumps extend the window on demand with a "Locating turn N…" pulse + bubble; the oldest-turn jump loads to the **true first turn** (`hasMore = false`) |
| 👁️ **Follow-scroll highlight** | The capsule of the turn at the reading line is tinted as you scroll — and the rail's own viewport keeps the active turn in view |
| ⬆️⬇️ **Scroll buttons** | Click or hover-hold to scroll the rail; greyed out when there is nothing to scroll |
| 🎛️ **Rail mode switch** | Settings → General → *Turn navigation*: `DSH official` / `Smoothly TN` (default) / `Hide all` — persisted across reloads, so the official rail can finally be **turned off** |
| 🔌 **Pure external plugin** | No DSH source code modified; no host changes; no new dependencies; read-only DOM access |

## vs. the official DSH turn rail

The official built-in `TurnNavigator` has **no off-switch** and is always rendered in the chat view. The table below compares it at **dsh 0.1.3-alpha.1** (the current DSH web `TurnNavigator`, which re-added full-session scope via its own host projection) against this plugin, **Smoothly TN v0.4.3**:

| Capability | DSH official rail (0.1.3-alpha.1) | Smoothly TN (v0.4.3) |
|---|---|---|
| Turns shown | **Every turn** — host `turnOutline` projection (0.1.3+) | Every persisted turn — **client-side** journal read |
| How full history is read | Host-side projection embedded in the snapshot | Client pages the persisted journal (`session/page`); older dsh falls back to `sessions.history` RPC — **zero host changes** |
| Jump to a turn outside the window | ✅ (0.1.3+ unloaded anchor pages history by seq) | ✅ on-demand window extension + "Locating turn N…" pulse/bubble |
| Long-session open performance | Reads the projection | **Zero prepend** — plain data, no flow re-render, no stall |
| Follow-scroll highlight | ✅ (0.1.3+ keeps the active mark in the rail viewport, with a pointer guard) | ✅ (v0.4.1+, same pointer-guarded follow) |
| Hover preview | Prompt + response (≤3 lines each), no timestamp | Turn number + **timestamp** + full user-message summary |
| Wave ripple animation | ❌ (fixed-pitch ticks widen instead) | ✅ wave ripple |
| Scroll buttons (click / hover-hold) | ❌ (wheel + gradient fade) | ✅ click / hover-hold |
| Rail height | Dynamic band (natural height … 420px) | Auto-sized (≤30vh), internal hidden scrollbar |
| Narrow viewport (<900px) | Auto-hidden | Auto-hidden (mirrors official) |
| **Hide / switch rail** | ❌ no off-switch | ✅ Settings → General → 3 modes; `Hide all` hides both |
| Keyboard accessibility | ✅ focus ring + `aria-current`/`aria-busy`/`aria-describedby` | ✅ focusable buttons (`Turn N — time — summary` aria-label) |
| Source | Built-in, cannot be disabled | External plugin, **can be replaced/disabled** |

As of dsh 0.1.3 the built-in rail caught up on full-session scope and out-of-window jumps. What still sets Smoothly TN apart: you can **switch it off** (the official rail cannot), the tooltip carries the **timestamp + full summary**, there are **scroll buttons and wave hover**, and it remains an **external, read-only plugin with zero host changes**. And on dsh ≤ 0.1.2 the built-in rail is simpler still (loaded window only), so the gap Smoothly TN closes is even larger there.

## Version map

Which Smoothly TN release matches which dsh:

| Smoothly TN | dsh | Notes |
|---|---|---|
| v0.1.x | dsh ≤ 0.1.1 | Full history via the legacy `sessions.history` browser→host RPC |
| v0.2.x – v0.4.1 | dsh 0.1.2+ | Adapted to the `ui-chat` refactor; full history via the journal `session/page` channel; v0.4.1 fixed true turn numbers and rail-viewport follow |
| **v0.4.2** | dsh 0.1.2+, incl. **0.1.3-alpha.1** | Comparison/positioning updated against the 0.1.3 official rail (see above) |
| **v0.4.3** | dsh 0.1.2+, incl. **0.1.3-alpha.1** | This release: brand naming standardized to **Smoothly**（思磨力）/ **Smoothly Turn Nav**（**Smoothly TN**）/ **思磨力轮次胶囊条** — technical IDs (npm package `dsh-turn-navigator`, plugin/slot IDs, locale namespace, CSS prefix, localStorage key) unchanged |

The official-rail comparison in this README targets **dsh 0.1.3-alpha.1**; on older dsh the official rail is simpler, so Smoothly TN's advantage is larger there.

## Installation

```sh
dsh plugin --profile web add dsh-turn-navigator
```

Then restart `dsh web`:

```sh
dsh web
```

## Usage

0. **Choose which rail to show** (Settings → General → **Turn navigation**): `DSH official` (the built-in rail), `Smoothly TN` (this plugin's rail — **default**), or `Hide all`. The official rail has no off-switch, so choosing Smoothly TN hides it with a stylesheet override and our rail takes over the right-edge center position. The choice persists across reloads.
1. Open any conversation with at least one completed turn.
2. A vertical rail of grey capsules appears on the right edge (one per turn). It **auto-sizes** — short conversations get a short rail, long ones hit the 30vh cap and scroll internally (hidden scrollbar, no layout jitter).
3. **Hover** a capsule: it glows, widens in a wave, and shows the turn's **number, timestamp, and summary** in a tooltip to the left of the rail.
4. **Click** a capsule to jump to that turn's start. Out-of-window turns pulse the capsule and show a "Locating turn N…" bubble while the window is extended on demand; the target row is highlighted on arrival. The activated capsule centers in the rail (unless it is the first or last turn).
5. **Scroll** with the mouse wheel, the up/down buttons, or hover-hold on the buttons.

## How it works

The plugin registers **two additive slots** — **no DSH source code is modified**:

| Slot | Scope | Role |
|------|-------|------|
| `conversation.session.header.utilities` | session | The floating turn rail (renders `position: fixed`; reads the live chat snapshot via the framework `useChat`/`useSession` kit) |
| `settings.general.item` | root | The *Turn navigation* mode switch in Settings → General |

- **Full history as data**: on dsh 0.1.2+ the rail pages the same persisted log the official window reads, through the Typert Remote `session/page` channel (`ctx.remote.session` — mounted by the base web assembly; **no host changes, no new dependencies**). On older dsh it uses the `sessions.history` RPC. Every turn is derived from raw `turn/start` / `user/message` / `turn/end` events as plain data.
- **On-demand jumps**: clicking a turn already in the window scrolls directly; for a turn outside it, the rail extends the window page by page through the official session store (`loadOlder`, with the authoritative `hasMore` as the loop terminator) until the target is in view — the only path that touches the flow, and it runs only when you click.
- **Precise scrolling**: the rail locates the turn's first chat-node key, finds its DOM row via `data-chat-anchor-key`, and sets the scrollport's `scrollTop` directly (more predictable than `scrollIntoView`).
- **Replacing the official rail**: the official rail lives inside the conversation scroll container; a container-scoped stylesheet rule (driven by the mode switch) hides it, and the rail takes over its right-edge center position. Verified structurally against dsh 0.1.3-alpha.1 — the `[data-conversation-scroll] nav` hide rule still matches. If a future dsh changes that structure, the worst case is the official rail reappearing (side by side) — never a crash.
- **Read-only**: the plugin never writes to DSH state, never sends data anywhere, and only reads the DOM for targeting.

## Compatibility

- DeepSeek Harness (dsh) with the web client (`dsh web`); developed and verified against dsh 0.1.2+ and reviewed against dsh 0.1.3-alpha.1.
- Requires the `conversation.session.header.utilities` and `settings.general.item` slot declarations (present in current DSH).
- Default `Smoothly TN` mode hides the official rail (stylesheet override) and centers our rail in its place; `DSH official` mode shows the built-in rail instead; `Hide all` hides both. Both rails auto-hide below 900px width.
- Coexists with full-screen plugin pages (e.g. the kanban board): the rail sits below their overlay layer.

## Development

- `pnpm typecheck` / `pnpm test` — TypeScript check (tsdown does not typecheck).
- `pnpm bundle` — build the module-table client bundle into `lib/`.
- `scripts/verify-*.mjs` — Playwright acceptance scripts against a live `dsh web` (rail, full-history journal, mode switch, jump, feedback, overlay, sizing, UI).
- `pnpm release:check` — release gates (version, tag, tree, build, registry).

## License

MIT