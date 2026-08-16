# dsh-model-reasoning

[![npm version](https://img.shields.io/npm/v/dsh-model-reasoning.svg)](https://www.npmjs.com/package/dsh-model-reasoning)
[![npm downloads](https://img.shields.io/npm/dm/dsh-model-reasoning.svg)](https://www.npmjs.com/package/dsh-model-reasoning)
[![license MIT](https://img.shields.io/npm/l/dsh-model-reasoning.svg)](LICENSE)

An **external** DeepSeek Harness web client plugin: a Settings page that configures
**per-model thinking levels (reasoning efforts)** for third-party (pi-ai)
providers. It writes the same `llm-pi-ai.providers.<route>.models[].reasoningEfforts`
(and route-level `reasoning`) fields the `llm-pi-ai` adapter reads, so the
composer's 「推理等级」 picker and route defaults pick the values up with no other
change.

Why an external plugin: the built-in **Models** settings form deliberately does
not expose reasoning effort (it is a per-model capability), and adding a field
to the built-in `ui-settings-models` package would be overwritten by the next
official release. This package ships as an installable **bundle** that never
touches repository source, so official updates cannot clobber it.

## What it adds

A new Settings section, **「模型思考等级 / Model reasoning」**, placed after the
built-in **Models** page. For each third-party provider that carries an explicit
`models` list you can:

- set the **route default thinking level** (`providers.<route>.reasoning`), and
- per model, choose **inherit / non-reasoning (`false`) / reasoning with a level
  set** (`reasoningEfforts`), ticking the canonical levels
  `off minimal low medium high xhigh max`.

### Custom wire spelling (adapt to any upstream vocabulary)

Each selected level has a **wire-spelling** field (defaults to the level name).
Change it to remap what that level sends — e.g. `max → ultra` for a model that
calls its top level Ultra, or `high → turbo`. `off` can either send nothing
(default) or a custom value of its own. This is the supported way to adapt a
model's thinking vocabulary **without waiting for an adapter update**.

> ⚠️ DSH does **not** support inventing new level names. The pi-ai schema pins
> `reasoningEfforts` keys to the seven levels above (`z.dict(..., z.union(levels))`)
> and resolution only reads those keys, so a bare `ultra:` key is rejected at
> write and ignored at request time. "Ultra" is expressed by remapping an
> existing level's wire spelling (`max: ultra`), not by adding an `ultra` key.

The write path uses the official `settings.mutate` RPC with revision fencing, so
a concurrent change is refused rather than silently overwritten.

## Install

**Prerequisites:** a DeepSeek Harness install with the `dsh` CLI, plus [pnpm](https://pnpm.io) (the `dsh plugin` command runs pnpm under the hood). This is an installable **bundle** — it is loaded by `dsh`, not imported as a library.

### From npm (recommended)

The package is published to npm as `dsh-model-reasoning`:

```sh
dsh plugin --profile web add dsh-model-reasoning
```

This installs the prebuilt bundle and appends it to the `web` profile. Then **restart `dsh web`** and open **Settings → 模型思考等级 / Model reasoning**.

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
cordis.patch.yml      # bundle layer: mounts the row that the client-modules
                      # service discovers (dsh.client manifest)
package.json          # dsh.bundle (patch) + dsh.client (web) + exports["./client"]
tsdown.config.ts      # self-contained build: node half + module-table client bundle
src/index.ts          # host apply (no-op)
src/client/index.ts   # client apply: settingsScope.bind(llm-pi-ai) + register settings.section
src/client/ReasoningSection.tsx  # the settings page (route → model → effort editor)
src/client/styles.ts   # design-token styles (--dsw-alias-*) + injection
src/client/locales.ts # en/zh copy
```

## Build

```sh
pnpm install
pnpm bundle          # emits lib/index.js + lib/client.js
```

The bundle leaves the platform packages (`react`, `@deepseek-ai/cordis`,
`@deepseek-ai/dsh-client-*`) external — they resolve at runtime from the loader's
module table; everything else is inlined.

## Notes / limitations

- Only routes that carry an explicit `models` list are enumerable here (the
  installed catalog is not reachable from the client). Catalog-only providers
  keep their levels from the installed catalog and use the composer picker.
- Wire spellings default to the level name; to rename a level on the wire (e.g.
  `max: ultra`) edit `settings.yaml` for that model.
- **Section nav icon is shell-assigned, not plugin-assigned.** The built-in
  `ui-settings-general` `SettingsRoot.tsx` `navIcon(id)` maps known ids
  (`models`, `agent-presets`, `plugins`) and falls back to a gear for every
  other id — including this section's `model-reasoning`. The `settings.section`
  registration has no icon field, so an external plugin cannot set it without
  patching the shell. When DSH exposes a per-section icon (e.g. an icon option
  on the registration), use `IconThinkOutline16` from `dsh-client-ui-primitives`
  for this section.

## License

[MIT](LICENSE)

