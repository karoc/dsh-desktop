# dsh web: first Plugins-page open blocks the event loop 2–12 s (three uncached metadata sweeps)

Status: draft — filed against `deepseek-ai/dsh` 0.2.2-rc.1 (observed on Windows 11, also present in 0.2.2-rc.3 source).
Found while debugging karoc/dsh-desktop (Tauri shell, bundled dsh runtime). Desktop-side mitigation: see PR (link once opened).

## TL;DR

Opening the sidebar **Plugins** page for the first time after a dsh web start blocks the
**whole HTTP server** (not just the page) for **2–12 s**. The blocker is synchronous file I/O:

`pluginManager/listBundles` + `pluginManager/listPlugins` + `pluginInventory/list` each run a
full `metaOf()` sweep over every Loader entry → `readPluginMeta()` → `dictionariesOf()`,
which does `readdirSync(locale dir)` and for **every** `locale/*.json` a full ESM
`resolveSync()` + `readFileSync()` + `JSON.parse()`. Nothing is cached between the three
sweeps, so the same hundreds-to-thousands of file reads happen three times, on the event loop.

A desktop supervisor that probes `/` with a short timeout sees a "hang" and may restart dsh;
here it produced a 357 MB full-memory dump and a restart, dropping the user's session.

## Environment

- dsh 0.2.2-rc.1 (runtime), Windows 11, Node bundled with the desktop shell (v24.18.0), hoisted node_modules (712 pkgs, 262 of them ship `locale/en.json`; 2090 `locale/*.json` total).
- Same code in 0.2.2-rc.3: `git diff dsh-v0.2.2-rc.1..dsh-v0.2.2-rc.3 -- packages/boot/app-boot/src/package-meta.ts packages/boot/app-boot/src/profile-resolution/service.ts` is empty.

## Symptom (desktop supervisor log, 2026-11-16, UTC)

    22:56:43  dsh web: http://127.0.0.1:51335/?token=<masked>
    22:59:51  watchdog: dsh web miss 1/3 (http://127.0.0.1:51335)
    22:59:54  watchdog: dsh web miss 2/3
    22:59:57  watchdog: dsh web miss 3/3
    22:59:57  watchdog: dsh web UNRESPONSIVE — asking the shell for a dump before restarting
    23:00:02  watchdog: dsh web still UNRESPONSIVE after dump (probe TimeoutError, 11685 ms, dump ready) — restarting dsh
    23:00:03  restarting dsh
    -> runtime/reports/dshweb-hang-73640-1794870000.dmp = 357,659,395 bytes

Second attempt after the restart: `miss 1/3` only, then recovered; the page rendered. User-visible:
the whole UI froze (all HTTP routes unresponsive), then the session was killed by the restart.

## Minimal reproduction (no desktop shell needed)

Against a plain `dsh web` instance, open the app URL in a Chromium and click the sidebar
Plugins entry (`button[aria-label="Plugins"]`), while polling `GET /` every ~100 ms:

| | first open (fresh dsh web) | reload + open again (host warm) |
|---|---|---|
| desktop-free Playwright run A | 6680 ms until the panel is ready | 73 ms (panel kept warm in the SPA) |
| run B (fresh process) | 5201 ms | 3124 ms after a full page reload |
| run C | 5944 ms | 2641 ms |

- Windows-side probe of `GET /` (PowerShell `Invoke-WebRequest`, 15 s timeout): idle latency
  p50 = 1 ms; during the first open single requests took **1732 / 2090 / 1334 / 991 / 2007 ms**,
  and the manager's own 1.5 s probes produced `miss 1/3 … 3/3`.
- A clean instance (fresh `DSH_HOME`, empty patch, **no** desktop preinstalled bundles):
  first open 6464 ms, reload + open 6129 ms — not faster, so this is not an artifact of the
  desktop's 4 bundled plugins.

## CPU profile (Node inspector, `Profiler.start` sampling 500 µs, first open)

2992 ms busy / 5000 ms profile. Self time by nearest JS frame:

| self ms | frame |
|---|---|
| **1485.8** | `readFileSync` (node:fs) |
| 197.8 | `readdirSync` (node:fs) |
| 194.6 | `getPackageJSONURL` (node:internal/modules/package_json_reader) |
| 105.2 | `URL` (node:internal/url) |
| 102.3 | `realpathSync` (node:fs) |
| 59.7 | `existsSync` (node:fs) |
| 51.0 | `dictionariesOf` (dsh-app-boot) |
| 33.2 | `readObject` (dsh-app-boot) |

Representative stacks (innermost first):

    readFileSync
      <- dictionariesOf                       (dsh-app-boot lib)
        <- readPluginMeta                     (dsh-app-boot lib)
          <- metaOf                           (dsh-app-boot lib)
            <- declaredRows                   (dsh-plugin-manager)
              <- readBundles -> listBundles   <- invokeRpc (api-gateway)

    readFileSync
      <- dictionariesOf -> readPluginMeta -> metaOf
        <- readPluginInventory               (dsh-host-plugin-inventory)
          <- list (pluginInventory/list) | listPlugins -> readPluginInventory

    getPackageJSONURL <- resolveSync (ESM loader) <- resolvePluginResource <- dictionariesOf ...

## Code pointers (0.2.2-rc.3 source; runtime rc.1 lib line numbers in parentheses)

- `packages/boot/app-boot/src/package-meta.ts:124-145` `dictionariesOf()` (runtime `lib/index.js:2954`):
  `readdirSync(dirname(englishPath))`, then **per file** `<specifier>/locale/<name>` →
  `resolvePluginResource()` (runtime `index.js:2913`, full ESM `resolveSync`) → `readObject()` →
  `JSON.parse`. One full ESM resolution per locale file, just to build a path (the code then only
  compares `dirname(file)` with the English dir).
- `packages/boot/app-boot/src/package-meta.ts:175` `readPluginMeta()` (runtime `index.js:3002`):
  re-resolves `<specifier>/locale/en.json` and `<specifier>/package.json` every call.
- `packages/boot/app-boot/src/profile-resolution/service.ts:137` `metaOf()` (runtime `index.js:4312`):
  `return readPluginMeta(specifier, parentURL)` — **no cache**, unlike `packageOf()` right above it
  which caches parsed manifests in `this.packages`.
- `packages/boot/plugin-manager/src/index.ts:480` `listPlugins()` and `:506` `listBundles()`
  (→ `:514` `readBundles()` → `:1191` `declaredRows()`), both calling `metaOf()` per entry.
- `packages/host/plugin-inventory/src/index.ts:82` `readPluginInventory()` calls `metaOf()` at
  `:88` and again at `:111` (per agent-preset row).
- Client: `packages/client/ui-plugin-manager/src/client/manager-store.ts:1119` calls
  `pluginInventory.list()` and, at `:1131-1132`, `Promise.all([listBundles(), listPlugins()])`.
  Three RPCs, three identical sweeps, same tick.

## Why it blocks the HTTP server

`dictionariesOf` / `readPluginMeta` / `metaOf` / `readBundles` / `readPluginInventory` are all
synchronous (fs sync APIs) inside async RPC handlers, so the Node event loop is busy for the whole
sweep. During that window even `GET /` (and auth callbacks, WS frames, …) cannot be served, which
is what a liveness probe observes as a hang.

## Suggested fixes (cheapest first)

1. **Cache `readPluginMeta` per `(specifier, parentURL)`** in `PluginPackages` (same lifetime/
   invalidation as the existing `packageOf()` cache, e.g. bump on `refresh()`/profile change).
   This alone removes 2 of the 3 sweeps and most repeat opens.
2. **Drop the per-locale ESM resolution**: join the already-resolved English locale dir with the
   file name (the `readdirSync` entry) after asserting package ownership once per entry. Removes
   ~200 ms of `resolveSync`/`getPackageJSONURL`/`realpathSync`/`URL` per sweep here.
3. **Read only the requested language** (the page needs one locale; `localizedText` builds every
   dictionary each time).
4. **Make the sweep async** (`node:fs/promises`) so a cold-cache sweep cannot freeze unrelated
   HTTP/WS traffic even if it is slow.
5. De-duplicate the three RPCs on the host (the page needs inventory + bundles + plugins; they
   recompute the same metadata three times).

## Workaround (desktop side)

karoc/dsh-desktop adds a bounded-stall tolerance to its supervisor: a miss streak no longer
immediately requests a multi-hundred-MB full-memory dump + restart; one 15 s patient probe must
also fail first, and the restart thresholds are relaxed for the first 120 s after the URL appears.
This is a **mitigation only** — the page is still slow (2–12 s) on first open, and the event loop
is still blocked while it happens.

## Extra

Node's `--report` / the shell's MiniDumpWriteDump evidence for this incident: a 357 MB full-memory
minidump was written while the process was blocked (`dshweb-hang-73640-1794870000.dmp`). Ping if a
symbolized stack from that dump would help.
