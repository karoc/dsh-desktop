# dsh-model-reasoning

[![npm version](https://img.shields.io/npm/v/dsh-model-reasoning.svg)](https://www.npmjs.com/package/dsh-model-reasoning)
[![npm downloads](https://img.shields.io/npm/dm/dsh-model-reasoning.svg)](https://www.npmjs.com/package/dsh-model-reasoning)
[![license MIT](https://img.shields.io/npm/l/dsh-model-reasoning.svg)](LICENSE)

An **external** DeepSeek Harness web client plugin: a Settings page that manages
the provider-route parameters the built-in **Models** page deliberately does not
expose — retry & backoff policy, timeouts, transport, caching, thinking budgets,
capacities, request image budgets — plus **per-model thinking levels (reasoning
efforts)** for third-party (pi-ai) providers. It writes the exact
`llm-pi-ai.providers.<route>.*` fields the adapter reads, so changes take effect
with no other configuration.

Why an external plugin: adding fields to the built-in `ui-settings-models`
package would be overwritten by the next official release. This package ships as
an installable **bundle** that never touches repository source, so official
updates cannot clobber it.

## What it manages

A new Settings section, **「提供方参数 / Provider parameters」**, placed after the
built-in Models page. Pick any provider route — every entry in the `llm-pi-ai`
`providers` dict is editable here, catalog routes included — and manage it in
five parameter groups:

- **Per model** — for routes carrying an explicit `models` list, edit the
  SELECTED model's own declaration: input modalities (`text`/`image`, so a
  text-only model stays text-only beside its vision siblings), context and
  output caps (`contextWindow`, `maxTokens`), and thinking levels
  (`reasoningEfforts`: inherit / non-reasoning / a level set over `off minimal
  low medium high xhigh max`) with custom wire spelling per level. The picker
  fuses search into the dropdown itself — open it and type to narrow long model
  lists by name / id (display-only; stored order and write path untouched).
  **Apply to all models** copies only
  the CHECKED dimensions from the editor to every model on the route, plus the
  route default thinking level (`providers.<route>.reasoning`) that unset
  models inherit.
- **Retry & backoff**: `retryPolicy.mode` (`normal` bounded transient retries vs
  `always` unbounded retries), `maxRetries`, `retryableCodes` (the five stable
  preset codes plus custom entries), and the shared exponential backoff
  (`initialDelayMs`, `maxDelayMs`, `jitterRatio`). Unset values fall back to the
  adapter defaults (5 retries, 500 ms initial, 10 s ceiling, 10% jitter).
- **Timeouts & transport**: `timeoutMs`, `websocketConnectTimeoutMs`,
  `streamIdleTimeoutMs` (default 300 000 ms), and `transport`
  (`auto/sse/websocket/websocket-cached`).
- **Caching & thinking budgets**: `cacheRetention`
  (`none/short/long`) and `thinkingBudgets` token budgets per level
  (`minimal/low/medium/high`).
- **Capacities & budgets**: `defaultContextWindow`,
  `defaultMaxTokens`, `defaultInput` modalities (`text/image`) — these three
  are FALLBACKS read only by models that declare nothing of their own (set the
  real values per model in the **Per model** tab) — plus the per-request image
  payload caps (`maxRequestImageBytes`,
  `requestImagePixelBudget`, `requestImageMaxBytes`).

Every group's panel opens with a **scope badge**: 「按模型 / Per model」 writes
into the selected model's own declaration, and a dimension you leave unset
inherits the route fallback or catalog value; the four other groups are 「整条
路由 / Whole route」 — those fields exist ONLY at route level in the llm-pi-ai
schema, so one shared value is the whole truth (the badge's hover tooltip says
so; no duplicate text sits beside it).

Every field shows the effective adapter default as its placeholder while unset;
clearing a field removes the override instead of writing an echo of the default.
Local validation mirrors the host's own resolution rules, so most mistakes are
caught before the write; anything the host still refuses surfaces verbatim from
`settings.mutate`. The write path uses revision fencing, so a concurrent change
is refused rather than silently overwritten. An **Apply to all models** action
copies the current model's reasoning declaration to every model on the route at
once.

### Custom wire spelling (adapt to any upstream vocabulary)

Each selected reasoning level has a **wire-spelling** field (defaults to the
level name). Change it to remap what that level sends — e.g. `max → ultra` for a
model that calls its top level Ultra, or `high → turbo`. `off` can either send
nothing (default) or a custom value of its own.

> ⚠️ DSH does **not** support inventing new level names. The pi-ai schema pins
> `reasoningEfforts` keys to the seven canonical levels and resolution only reads
> those keys, so a bare `ultra:` key is rejected at write time. "Ultra" is
> expressed by remapping an existing level's wire spelling (`max: ultra`).

### Empty state

With no third-party provider configured the page shows a friendly placeholder
pointing at **Settings → Models → Add a custom provider**. Selecting a catalog
route (no explicit `models` list) explains that its MODELS stay read-only here —
catalog reasoning levels remain selectable in the composer — while the route's
parameter groups above stay fully editable. Loading / unavailable states are
hinted while the settings document loads.

## Install

**Prerequisites:** a DeepSeek Harness install with the `dsh` CLI, plus [pnpm](https://pnpm.io) (the `dsh plugin` command runs pnpm under the hood). This is an installable **bundle** — it is loaded by `dsh`, not imported as a library.

### From npm (recommended)

The package is published to npm as `dsh-model-reasoning`:

```sh
dsh plugin --profile web add dsh-model-reasoning
```

This installs the prebuilt bundle and appends it to the `web` profile. Then **restart `dsh web`** and open **Settings → 提供方参数 / Provider parameters**.

### From git

```sh
dsh plugin --profile web add github:karoc/dsh-model-reasoning#<sha>
```

A git install runs the package's `prepare` script to build the bundle. pnpm ≥ 10 requires allowlisting that build once — copy the exact package key pnpm prints into the profile's `pnpm-workspace.yaml` under `allowBuilds`, then re-run `add` (see `docs/user/develop/basic/publish.md` in the DSH repo).

### Updating

Bump to the newest release with pnpm update (or re-add to pick up a newer git ref):

```sh
dsh plugin --profile web update dsh-model-reasoning
# or, if the dependency spec is pinned: dsh plugin --profile web add dsh-model-reasoning
```

Then **restart `dsh web`** so the new client bundle loads.

### Removing

```sh
dsh plugin --profile web remove dsh-model-reasoning
```

This removes both the dependency and its bundle layer from the `web` profile. Restart `dsh web` for the section to disappear.

## Layout

```
cordis.patch.yml                # bundle layer: mounts the row that the client-modules
                                # service discovers (dsh.client manifest)
package.json                    # dsh.bundle (patch) + dsh.client (web) + exports["./client"]
tsdown.config.ts                # self-contained build: node half + module-table client bundle
src/index.ts                    # host apply (no-op)
src/client/index.ts             # client apply: settingsScope.bind(llm-pi-ai) + register settings.section
src/client/ProviderParamsSection.tsx  # the settings page (route → group tabs → editors)
src/client/params.ts            # managed-field registry: domains, defaults, host-mirroring
                                # validators, draft model, minimal-op diff engine
src/client/styles.ts            # design-token styles (--dsw-alias-*) + injection
src/client/locales.ts           # en/zh copy
tests/params.test.ts            # unit tests for the pure registry logic
```

## Build & test

```sh
npm install
npm run bundle       # emits lib/index.js + lib/client.js
npm test             # unit tests for params.ts (node:test runs TypeScript directly)
pnpm release:check   # release gate: docs/changelog/tag/tree/build/registry must all pass
npm publish          # runs the gate (prepack/prepublishOnly), then postpublish verifies the live release
```

The bundle leaves the platform packages (`react`, `@deepseek-ai/cordis`,
`@deepseek-ai/dsh-client-*`) external — they resolve at runtime from the loader's
module table; everything else is inlined.

## Notes / limitations

- Only routes carrying an explicit `models` list expose per-MODEL editors here
  (the installed catalog is not reachable from the client); every route's
  route-level parameter groups are always editable. Catalog-only per-model
  customization via `modelOverrides` is future work.
- Credential management (`apiKeyEnv`), `displayName`, `baseURL`, protocol
  (`api`), and the models list structure stay on the built-in **Models** page;
  this plugin does not duplicate them.
- Wire spellings default to the level name; to rename a level on the wire (e.g.
  `max: ultra`) edit `settings.yaml` for that model.
- Legacy profile keys removed upstream (`provider`, `maxRetries`,
  `maxRetryDelayMs` at route level) are never written by this plugin.
- **Section nav icon is shell-assigned, not plugin-assigned.** The built-in
  `ui-settings-general` `SettingsRoot.tsx` `navIcon(id)` maps known ids and
  falls back to a gear for every other id — including this section's
  `provider-params`. When DSH exposes a per-section icon, use
  `IconThinkOutline16` from `dsh-client-ui-primitives` for this section.

## License

[MIT](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (development + release checklist) and
[CHANGELOG.md](CHANGELOG.md) for version history.
