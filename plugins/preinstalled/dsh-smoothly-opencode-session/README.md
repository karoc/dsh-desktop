# Smoothly OpenCode Session (Smoothly OCS)

**思磨力 OpenCode 会话头** — an external [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH) **host plugin** that attaches the OpenCode-required `x-opencode-session`
request header to model calls routed to **OpenCode / OpenCode Go** provider
routes, using a stable per-conversation id.

Since **2026-09-05** OpenCode's relay rejects any inference request that lacks
this header (`400 MissingSessionID`); the value is what pins a conversation to
one upstream backend and keeps OpenCode's prompt cache warm across its turns
(tracked upstream in [deepseek-harness discussion #5495](https://github.com/deepseek-ai/deepseek-harness/discussions/5495)).

## What it does

- **Fixes the 400** by always attaching `x-opencode-session` to requests that
  are routed to a configured OpenCode(Go) provider.
- **Keeps the cache/affinity benefit** by using a value that is unique **per
  conversation** and stable across that conversation's turns, compaction,
  retries and process restarts (by default the DSH session id itself — the
  same identity the official DeepSeek adapter already sends as
  `x-deepseek-harness-session-id`).
- **Leaves everything else untouched**: a request whose **initial URL** is not
  an allowed host is never modified (host gate, default `https://opencode.ai`),
  as are requests that already carry the header, other providers, and calls
  without a session id. See [hosts](#hosts).

## How it works

The plugin listens on the **`llm/stream` waterfall** — a documented DSH
extension seam ("Waterfall around every streaming model call"). LOOP-built
request options are deep-frozen (mutation throws), so the header cannot be
added by rewriting options; instead the plugin:

1. reads `provider` + `sessionId` off the waterfall options for each call;
2. drives the downstream stream's pulls inside an `AsyncLocalStorage` store;
3. patches `globalThis.fetch` once, and while such a store is active merges
   `x-opencode-session: <value>` onto the outgoing request (unless the request
   already carries the header — an existing value always wins).

Both registrations are fiber-scoped (`ctx.on` listener + `ctx.effect`
disposer), so stopping / updating / unloading the plugin restores the original
`fetch` and removes the listener.

### Why the fetch-level injection

There is no official seam for an external plugin to add per-request headers to
adapter requests (options are deep-frozen; provider `headers` config is static
and deployment-owned). The fetch shim is the only external-plugin mechanism
that can attach a **per-conversation** value. The correct long-term fix lives
in the provider adapter itself (pi-ai); this plugin is the stopgap until that
ships. See [Notes / limitations](#notes--limitations).

## Configuration

The row's `config` (in the bundle's `cordis.patch.yml`, or overridden per
profile) is entirely optional — the code fills defaults for missing keys.

```yaml
- insert:
    - id: dsh-smoothly-opencode-session
      name: '@karoc/dsh-smoothly-opencode-session'
      config:
        providers: [opencode, opencode-go]
        mode: session-id
        debug: false
```

### providers

**Optional narrowing — you normally need no configuration here.** The
authoritative discriminator is the request HOST (see [hosts](#hosts)): leave
`providers` unset and every provider whose target host passes the gate is
covered, so a custom route key (for example `opencode-go-self`) works without
being listed and cannot break silently when it is renamed. Set it only to
restrict injection to specific provider ROUTE KEYS (the pi-ai catalog ids
`opencode` / `opencode-go` are then just two ordinary entries). Matching uses
the route key — a provider's display name (for example a UI label such as
"OC Go") is never visible here. When you do set a list, the plugin compares it
against the registered routes at the first model call and warns once about any
key no adapter registered (also written to `debugFile` when configured, since a
service deployment may not capture the console). The ` /ocgo ` command prints
the effective policy — gate, narrowing, mode, registered routes — with no client
UI involved.

### hosts

The host gate: a request is only modified when its target host is allowed
(default `['https://opencode.ai']`, subdomains included). Entries are `host`
(implicitly `https`) or `scheme://host[:port]`; a leading `*.` is ignored; IDN
entries normalize to punycode; unusable entries are reported in the startup log
instead of being ignored silently. `['*']` disables the gate entirely — use it
only for a mirror you fully trust. If you reach OpenCode through a reverse
proxy or a mirror, list that host here (write the full scheme, and note that a
bare `host` entry means `https`) or the header will silently not be attached;
the plugin warns once per blocked provider/host pair.

### mode

- `session-id` (default) — header value = the DSH session id of the model
  call. Unique per conversation, stable across turns, compaction, retries and
  restarts.
- `uuid` — a process-stable random UUID derived once per DSH session id
  (opaque; resets when the process restarts).

### debug / debugFile

- `debug: true` — log every streamed call that **enters the injection flow**
  via `ctx.logger` (the dsh process console), and reveal raw values in
  request-level records.
- `debugFile: <absolute path>` — append one JSON line per streamed call
  (`kind: "stream"`, with `provider`/`model`/`session`/`value`) and, when
  `debugRequests` is on, per injected or host-blocked request
  (`kind: "inject" | "skip"`). The stream-level record only means the call
  entered the injection flow; the request-level records are what prove what was
  actually attached. **The stream-level record carries the raw session id and
  value (its 0.1.0 format, kept for compatibility); only the request-level
  records are hashed by default.** The file is append-only (no rotation;
  roughly one record per injected request) and written fire-and-forget, so a
  short-lived process can lose its tail.

### debugRequests

`debugRequests: true` writes one request-level record **at the real fetch
moment**: `{"ts","kind","reason","host","provider","valueHash","valueLen"}`
with `reason` in `session` / `discovery` / `host-not-allowed` /
`already-present`. These records are hashed by default: the value is reduced to
a 12-hex-character SHA-256 prefix, and the raw value appears only when
`debug: true` is set as well. (The separate stream-level record described above
keeps the raw session id — see its note.)

### discoveryFallback

`discoveryFallback: true` (default off) attaches a **process-stable UUID** to
bare discovery requests that carry no session id: only `GET` requests whose
path ends in `/models` and whose host passes the gate. The Models page listing
works without this today; enable it only if your OpenCode endpoint starts
rejecting that listing.

To override configuration in a profile without editing this package, add a
patch entry with the **same id** to the profile's own `cordis.patch.yml` (it
replaces the whole `config`, so restate every key you need). The patch entry
form is id-targeted, not `insert` — see [Install](#install).

## Install

### From npm (recommended)

```sh
dsh plugin --profile web add @karoc/dsh-smoothly-opencode-session
```

Then **fully restart** your dsh profile (bundle layers are read at startup).
The startup log shows:

```
[dsh-smoothly-opencode-session] active for providers [opencode, opencode-go] with mode session-id
```

If you run DSH from a source checkout instead, load it as an overlay:
`pnpm dsh web --patch ./cordis.patch.yml`.

### From git

```sh
dsh plugin --profile web add git+https://github.com/karoc/dsh-smoothly-opencode-session.git
```

### Updating

```sh
dsh plugin --profile web update @karoc/dsh-smoothly-opencode-session
```

Restart `dsh web` afterwards.

### Removing

```sh
dsh plugin --profile web remove @karoc/dsh-smoothly-opencode-session
```

Restart `dsh web` afterwards. Removal is safe: the original `fetch` is
restored on unload, so no other provider is affected.

## Layout

```
src/index.ts            host plugin: llm/stream listener + fetch shim
cordis.patch.yml        bundle layer (inserts the plugin row with defaults)
scripts/                release gate + post-publish verification
tests/                  node --test unit + fake-cordis integration tests
lib/                    built output (npm package entry)
```

## Build & test

```sh
npm install       # installs dev deps (tsdown, @deepseek-ai/cordis types, @types/node)
npm run bundle    # emits lib/index.js
npm test          # node --test tests/*.test.ts (runs TypeScript directly)
```

`pnpm` works too (`pnpm bundle`, `pnpm test`); this checkout documents the npm
path because pnpm is not always on PATH.

## Notes / limitations

- **Scope:** only chat/streaming requests inside an `llm/stream` call receive
  the header. The one-shot model listing used by the Models page
  (`GET <baseURL>/models`) is a separate flow and does not receive it; if your
  OpenCode endpoint rejects that listing too, that is a separate issue.
- **Implementation dependency:** injection rides on Node's global `fetch`. If
  a future DSH version swaps its network stack, the header silently stops
  being sent (the 400 comes back) — uninstall then. This is an external-plugin
  stopgap until the provider adapter itself (pi-ai) sends the header.
- **Redirects are not re-gated:** the gate applies to the initial request URL.
  Node's fetch follows redirects and (measured on Node 24) keeps custom headers
  across origins, so a request that starts on an allowed host and redirects
  elsewhere carries the header to the redirect target.
- **Not the official fix:** the DSH maintainers' position is that provider
  particularities belong in the pi-ai package (see discussion #5495 and
  earendil-works/pi #9326). This plugin is the stopgap until that ships — see
  the retirement procedure below before removing it.
- **Discovery probes are untouched** unless `discoveryFallback` is enabled.

### Retirement (verifiable procedure)

Do not retire this plugin on faith; verify, in this order:

1. Read the version DSH actually loads — under pnpm's strict layout the real
   path is `<dsh-root>/packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/package.json`
   (a flat `<dsh-root>/node_modules/@earendil-works/pi-ai/package.json` is the
   fallback; the package does not export `package.json`, so `require.resolve`
   will not find it). If the path cannot be located, keep the plugin and
   re-check after the next DSH upgrade.
2. If that version's `dist/` contains `x-opencode-session`
   (`grep -rl x-opencode-session <that package>/dist`), determine what its
   injection is keyed on: the provider id (`opencode` / `opencode-go`) or the
   base URL (`opencode.ai`).
3. Outcomes: keyed on the base URL → this plugin is redundant, uninstall it;
   keyed on the provider id only → a custom route such as `opencode-go-self` is
   still not covered, so either keep the plugin or migrate that route to the
   built-in `opencode-go` provider first.
4. No new version / not found yet → keep the plugin, and re-run this procedure
   after DSH bumps its `@earendil-works/pi-ai` dependency
   (`npm view "@earendil-works/pi-ai@<declared-range>" version` reports the
   newest version that range allows).

## License

MIT

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
