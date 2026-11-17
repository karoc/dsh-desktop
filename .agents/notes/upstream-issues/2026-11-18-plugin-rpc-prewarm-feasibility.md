# Agent Note: plugin-rpc-prewarm-feasibility

Status: evaluated — **not implemented** (report only; decision: do not add manager-side prewarm this round)

## Problem

Could the manager prewarm the expensive dsh-web plugin metadata work over HTTP (with the launch token)
inside the startup grace, so the user's first Plugins-page open costs milliseconds instead of 2–22s?
The question matters because the true fix (server-side metadata cache) is upstream, and a shell-side
prewarm would be a cheap local workaround if it existed.

## Findings (dsh 0.2.2-rc.3 runtime on the user's machine + rc.3 source)

1. **The page does not use HTTP for the expensive reads.** On mount the plugin page fires three
   **Remote (WebSocket)** calls: `pluginInventory/list`, `pluginManager/listBundles`,
   `pluginManager/listPlugins` (client `manager-store.ts:1119`, `:1131-1132`). There is no HTTP
   equivalent for them.
2. **The only HTTP route that touches plugin metadata is** `GET /api/plugin-manager/detail-file`
   (plugin-manager registers it with `connection.fetch`; `serveDetailFile` → `listedBundle(name)` →
   `listBundles()` → the full `readBundles()` sweep). So one HTTP GET could warm **one of the three**
   sweeps; the other two stay WS-only. A bogus `document`/`path` still triggers the sweep before the
   image lookup fails.
3. **Auth is cookie-only.** `/api/*` routes and the `/api/remote.mux` upgrade authenticate through
   `connection.trust` → `authentication-token.authenticateApi`, which accepts **only** the signed,
   authority-bound `dsh-auth-<hash(host:port)>` cookie. A `?token=` query is **not** accepted on those
   paths; the launch token is exchanged only by `GET /?token=<launchToken>` (exact path `/`, exactly one
   token), which returns `Set-Cookie` for that authority (random port ⇒ per-restart cookie name). A
   manager-side caller would have to do that exchange first and carry the cookie itself (Node's `fetch`
   has no cookie jar), never logging it.
4. **WS mux shape:** `/api/remote.mux`; client sends `{"type":"open","streamId","endpoint","payload":{"args":{}}}`;
   server answers `item` / `end` / `error`; the server pings and terminates clients that miss
   heartbeats; after auth the peer is `owner`. Driving this from the manager is feasible but couples to
   the typert stream protocol and its version-specific frames.
5. **Idempotence:** all of the above are read-only (profile + package metadata; document/image streams).
   Repeating is safe. Caveat: `readBundleImage` for an *uninstalled* official bundle goes to the npm file
   CDNs (network, slow) — an installed bundle avoids that.
6. **Failure is ignorable:** yes — best-effort, inside the existing 30s startup mute; a failed prewarm must
   never block boot or surface as an error.
7. **The decisive limit — there is no host-side cache to warm.** `metaOf` → `readPluginMeta` re-reads
   and re-resolves everything on every call (the upstream issue draft documents this). A prewarm therefore
   does not shorten the page's own calls except through the **OS file cache**. Measured on the dev host:
   cold first open 5201–6680ms vs a full page reload + open right afterwards (same process, warm OS cache)
   2110–3124ms — i.e. roughly **half**, not milliseconds. HTTP-only prewarm warms even less (one sweep's
   files, bundle-level, not every Loader entry's locale dir).

## Verdict

- **HTTP prewarm: partially possible, low value.** One of three sweeps, requires the cookie exchange,
  and cannot approach ms-level. **Not recommended / not implemented.**
- **Full prewarm** would need either (a) an upstream server-side cache for `readPluginMeta` (the real fix)
  or (b) a manager WS client speaking the typert protocol (fragile, version-coupled, token handling risk).
- **Cheapest safe approximation** (also not implemented): warm the OS file cache by reading the same
  `locale/*.json` + `package.json` files at startup — no auth, no protocol, ~2–3s saved by the measured
  cold/warm gap, at the cost of ~2–4s of extra startup I/O. Only worth it if we accept startup cost.
- **Verdict could change** if a future dsh exposes an HTTP RPC for the list methods, or if upstream adds
  caching (then neither is needed).

## Evidence

- Runtime route inventory: `grep -rn "fetch.register" …/node_modules/@deepseek-ai` (rc.3) — only
  `/api/plugin-manager/detail-file` and `/api/plugin-market/detail-file` are plugin-metadata routes.
- Auth: `packages/host/authentication-token/src/browser-auth.ts:367` (`authenticateApi` → cookie only),
  `:267-285` (token exchange mints the cookie), `src/index.ts:51-59` (only `pathname === '/'` with
  `token` is exchanged).
- Protocol: `packages/api/gateway/src/stream-protocol.ts:7` (`REMOTE_STREAM_MUX_PATH = '/api/remote.mux'`),
  `:237` (`open` frame); server frames in `stream-server.ts`.
- Cold/warm measurement and the upstream profile: see
  `.agents/notes/upstream-issues/2026-11-17-plugin-page-first-open-blocks-event-loop.md`.
