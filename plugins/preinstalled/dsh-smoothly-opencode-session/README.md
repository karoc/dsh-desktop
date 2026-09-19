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
- **Leaves everything else untouched**: other providers, requests that already
  carry the header, and requests without a session id pass through exactly as
  before.

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

Provider route keys whose requests receive the header. Defaults to the pi-ai
catalog ids `opencode` and `opencode-go`. If you serve OpenCode under a custom
provider route key (e.g. `opencode-go-self` in `llm-pi-ai`), add that key.

### mode

- `session-id` (default) — header value = the DSH session id of the model
  call. Unique per conversation, stable across turns, compaction, retries and
  restarts.
- `uuid` — a process-stable random UUID derived once per DSH session id
  (opaque; resets when the process restarts).

### debug / debugFile

- `debug: true` — log every streamed call that receives the header via
  `ctx.logger` (the dsh process console).
- `debugFile: <absolute path>` — append one JSON line
  (`{"ts","provider","model","session","header","value"}`) per streamed call
  that receives the header. Handy when the dsh console is not visible.

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
tests/                  node --test unit tests for the pure helpers
lib/                    built output (npm package entry)
```

## Build & test

```sh
pnpm install      # installs dev deps (tsdown, @deepseek-ai/cordis types, @types/node)
pnpm bundle       # emits lib/index.js
npm test          # node --test tests/*.test.ts (runs TypeScript directly)
```

## Notes / limitations

- **Scope:** only chat/streaming requests inside an `llm/stream` call receive
  the header. The one-shot model listing used by the Models page
  (`GET <baseURL>/models`) is a separate flow and does not receive it; if your
  OpenCode endpoint rejects that listing too, that is a separate issue.
- **Implementation dependency:** injection rides on Node's global `fetch`. If
  a future DSH version swaps its network stack, the header silently stops
  being sent (the 400 comes back) — uninstall then. This is an external-plugin
  stopgap until the provider adapter itself (pi-ai) sends the header.
- **Not the official fix:** the DSH maintainers' position is that provider
  particularities belong in the pi-ai package (see discussion #5495 and
  earendil-works/pi #9326). Once that ships and DSH upgrades to it, this
  plugin can be removed.
- **Discovery probes are untouched** (requests without a session id pass
  through).

## License

MIT

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
