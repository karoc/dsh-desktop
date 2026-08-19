#!/usr/bin/env node
// DSH Desktop — server manager.
//
// Runs under the bundled Node 24 (process.execPath). Owns everything
// dsh-version-specific:
//   1. ensure the per-user runtime dir (package.json);
//   2. check npm for the latest @deepseek-ai/dsh — NOTIFY ONLY, never install
//      on its own (the user decides; see the `update-dsh` stdin command);
//   3. install the notification client plugin (copied from resources, no npm
//      needed — it has no runtime deps, only a peer typing);
//   4. spawn `dsh web --port 0 --patch <plugin roster>` (and re-spawn it on
//      request, without re-checking the registry or re-installing plugins);
//   5. emit machine-readable protocol lines on stdout:
//        {"t":"url","url":"http://127.0.0.1:<port>"}
//        {"t":"log","line":"..."}
//        {"t":"update-status","current":...,"latest":...,"updateAvailable":bool}
//   6. read JSON-line commands on stdin from the Rust shell:
//        {"cmd":"check-update"} / {"cmd":"update-dsh"} / {"cmd":"restart-dsh"}
//   7. on signal, kill the whole dsh tree (taskkill /T /F on Windows).

import { spawn } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, delimiter as pathDelimiter, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createForwardProxy, providerHostsFromSettings } from './proxy.mjs'

const PACKAGE = '@deepseek-ai/dsh'

// ── args ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { runtimeDir: null, resourceDir: null, patch: null, cwd: null, home: null, registry: undefined, bridgePort: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => argv[++i]
    if (a === '--runtime-dir') out.runtimeDir = val()
    else if (a === '--resource-dir') out.resourceDir = val()
    else if (a === '--patch') out.patch = val()
    else if (a === '--cwd') out.cwd = val()
    else if (a === '--home') out.home = val()
    else if (a === '--registry') out.registry = val()
    else if (a === '--bridge-port') out.bridgePort = val()
  }
  if (!out.runtimeDir || !out.resourceDir || !out.patch) {
    throw new Error('usage: server-manager.mjs --runtime-dir <dir> --resource-dir <dir> --patch <file> [--cwd <dir>] [--home <dir>] [--registry <url>] [--bridge-port <port>]')
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}
function log(line) {
  const s = String(line ?? '').replace(/\s+$/g, '')
  if (!s) return
  emit({ t: 'log', line: s.length > 2000 ? s.slice(0, 2000) + '…' : s })
  // Persistent side-channel: <runtime>/manager.log survives even if events
  // never reach the UI, so remote debugging works after the fact.
  try {
    if (args.runtimeDir) {
      appendFileSync(join(args.runtimeDir, 'manager.log'), `${new Date().toISOString()} ${s}\n`)
    }
  } catch { /* logging must never break the manager */ }
}

// ── node + npm resolution ──────────────────────────────────────────────────
const nodeDir = dirname(process.execPath)
const npmCli = join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
const npmViaCli = existsSync(npmCli)

// Registry: explicit --registry > env DSH_DESKTOP_REGISTRY > official. Users
// behind slow international links should set DSH_DESKTOP_REGISTRY (e.g. the
// npmmirror) so the cold 500-package install doesn't look like a hang.
const REGISTRY = args.registry ?? process.env.DSH_DESKTOP_REGISTRY ?? 'https://registry.npmjs.org/'

// 把 npm 的 "npm http fetch GET 200 <url>" 行精简成可读的包名，供滚动字幕显示。
// 不同 registry 的 URL 结构不同：npmmirror 用 /packages/<name>/<ver>/…，
// npmjs 用 /registry…/<name>/-/…。提取失败就返回 null（调用方原样处理）。
function npmLineToDisplay(raw) {
  const m = raw.match(/npm http fetch GET \d+ (\S+)/)
  if (!m) return null
  const url = m[1]
  let name = null
  const pkgs = url.match(/\/packages\/((?:@[^/]+\/)?[^/]+)\//) // npmmirror
  if (pkgs) name = pkgs[1]
  if (!name) {
    const reg = url.match(/\/registry\.[^/]+\/((?:@[^/]+\/)?[^/]+)\/-\//) // npmjs
    if (reg) name = reg[1]
  }
  if (!name) {
    const tgz = url.match(/\/([^/]+)-v?\d[^/]*\.tgz$/) // 最后手段：tgz 文件名去版本
    if (tgz) name = tgz[1]
  }
  if (!name) return null
  try { name = decodeURIComponent(name) } catch { /* keep as-is */ }
  return `⬇ 下载 ${name}`
}

function npm(argsList, { timeoutMs = 600_000, stream = false, quiet = true } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const cmd = npmViaCli ? process.execPath : 'npm'
    const cmdArgs = npmViaCli ? [npmCli, ...argsList] : argsList
    // Native deps (koffi, node-pty) run `node` from PATH during postinstall,
    // but the bundled Node is NOT on PATH — prepend its directory so
    // `sh -c node` resolves (Linux broke silently: "node: not found").
    const env = {
      ...process.env,
      PATH: `${dirname(process.execPath)}${process.env.PATH ? pathDelimiter + process.env.PATH : ''}`,
    }
    const child = spawn(cmd, cmdArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    let stdout = ''
    let stderr = ''
    let settled = false
    // 节流：下载行太多会刷屏导致滚动字幕看不清（像清空）。快速下载时
    // 每 PACK_LOG_MS 至多滚一条；窗口内缓冲最新一条，结束时 flush。
    const PACK_LOG_MS = 300
    let lastPackAt = 0
    let pendingPack = null
    const flushPending = () => {
      if (pendingPack) { log(pendingPack); pendingPack = null }
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree(child.pid)
      const e = new Error('npm 操作超时（可设 DSH_DESKTOP_REGISTRY 切换镜像加速）')
      e.stderr = stderr
      e.stdout = stdout
      rejectPromise(e)
    }, timeoutMs)
    const pump = (buf, isErr) => {
      const text = String(buf)
      if (isErr) stderr += text
      else stdout += text
      if (stream) {
        for (const line of text.split(/\r?\n/)) {
          const t = line.replace(/^\s+|\s+$/g, '')
          if (!t || /^npm (warn )/i.test(t)) continue
          const display = npmLineToDisplay(t)
          if (display) {
            const now = Date.now()
            if (now - lastPackAt >= PACK_LOG_MS) {
              flushPending()
              log(display)
              lastPackAt = now
            } else {
              pendingPack = display
            }
          } else {
            // 非下载行（summary、错误等）即时输出，不节流。
            flushPending()
            log(t.slice(0, 500))
          }
        }
      }
    }
    child.stdout.on('data', (b) => pump(b, false))
    child.stderr.on('data', (b) => pump(b, true))
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      flushPending()
      rejectPromise(e)
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      flushPending()
      if (code === 0) resolvePromise(stdout)
      else {
        const e = new Error(`npm 退出码 ${code}: ${stderr.trim().split('\n').pop() ?? ''}`)
        e.stderr = stderr
        e.stdout = stdout
        rejectPromise(e)
      }
    })
  })
}

async function latestRemoteVersion() {
  const out = await npm(['view', PACKAGE, 'dist-tags.latest', '--json', '--registry', REGISTRY], { timeoutMs: 60_000 })
  const parsed = JSON.parse(out)
  return typeof parsed === 'string' ? parsed : parsed?.latest ?? null
}

function installedVersion(runtimeDir) {
  const pkgPath = join(runtimeDir, 'node_modules', PACKAGE, 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? null
  } catch {
    return null
  }
}

// ── update status ──────────────────────────────────────────────────────────
let latestVersion = null
// Shell manifest (<runtime>/dsh.json) snapshot: preinstalled list, devMode, …
let shellManifest = {}

/** Emit the current update status to the shell (Rust mirrors it to the tray). */
function emitUpdateStatus(updateAvailable) {
  emit({
    t: 'update-status',
    current: installedVersion(args.runtimeDir),
    latest: latestVersion,
    updateAvailable: updateAvailable ?? (latestVersion !== null && installedVersion(args.runtimeDir) !== latestVersion),
  })
}

/**
 * Startup / on-demand check: query the registry and REPORT, never install.
 * The user decides via the `update-dsh` command. Dev mode (dsh.json devMode)
 * freezes the check entirely — no registry round-trip at all.
 */
async function checkDshUpdate({ frozen = false } = {}) {
  const current = installedVersion(args.runtimeDir)
  log(`installed ${PACKAGE}: ${current ?? 'none'}`)
  if (frozen || process.env.DSH_DESKTOP_NO_UPDATE === '1') {
    emitUpdateStatus(false)
    if (frozen) log('dev mode: dsh 更新已冻结')
    return
  }
  try {
    latestVersion = await latestRemoteVersion()
    log(`npm latest ${PACKAGE}: ${latestVersion ?? 'unknown'}`)
  } catch (err) {
    latestVersion = null
    log(`update check failed (offline?): ${err.message}`)
    return
  }
  const available = latestVersion !== null && current !== latestVersion
  emitUpdateStatus(available)
  if (available) log(`update available: ${current ?? '(none)'} -> ${latestVersion} (user decides)`)
}

/**
 * Install the newest dsh into the runtime dir. Must run while dsh is STOPPED:
 * on Windows a live dsh locks the native modules (node-pty/koffi) npm has to
 * replace. The caller kills dsh first (see `updateDshAndRestart`).
 * @returns true when a new version was installed.
 */
async function installDshUpdate() {
  const current = installedVersion(args.runtimeDir)
  try {
    latestVersion = await latestRemoteVersion()
  } catch (err) {
    throw new Error(`无法查询最新版本：${err.message}`)
  }
  if (!latestVersion) throw new Error('无法获取最新版本')
  if (current === latestVersion) {
    log(`dsh 已是最新 ${latestVersion}`)
    return false
  }
  log(`updating ${PACKAGE} ${current ?? '(none)'} -> ${latestVersion}`)
  // Progress feedback for the launcher: explicit phase events + a heartbeat
  // so the user can tell "still working" from "stuck" during a long install.
  emit({ t: 'install-status', phase: 'start', version: latestVersion })
  const startedAt = Date.now()
  const heartbeat = setInterval(() => {
    emit({ t: 'install-status', phase: 'running', seconds: Math.round((Date.now() - startedAt) / 1000) })
  }, 5000)

  // `npm install --prefix <runtime>` prunes packages not listed in
  // runtime/package.json — the copied-only @dsh-desktop/* plugins and the
  // preinstalled bundles (incl. user-updated versions). COPY them aside first
  // and restore afterwards so they survive the install. Copy (not rename): if
  // the process is killed mid-install (user retries), the originals stay in
  // place and main()'s startup recovery restores from the backup dir.
  const nodeModules = join(args.runtimeDir, 'node_modules')
  mkdirSync(nodeModules, { recursive: true }) // may not exist on fresh runtime
  const backupDir = join(args.runtimeDir, '.plugin-backup')
  rmSync(backupDir, { recursive: true, force: true })
  mkdirSync(backupDir, { recursive: true })
  const PROTECTED = ['@dsh-desktop', 'dsh-model-reasoning', 'dsh-kanban', 'dsh-turn-navigator']
  // node_modules may not exist yet on a first install (fresh runtime) — treat
  // as empty instead of crashing on readdirSync(ENOENT).
  const protectedEntries = existsSync(nodeModules)
    ? (readdirSync(nodeModules)).filter((e) => PROTECTED.includes(e))
    : []
  for (const entry of protectedEntries) {
    cpSync(join(nodeModules, entry), join(backupDir, entry), { recursive: true, force: true })
  }
  let installError = null
  try {
    // Registry fallback chain: mirrors can lag on freshly-published deps, so
    // retry with the other default if the primary install fails.
    const fallback = REGISTRY === 'https://registry.npmjs.org/'
      ? 'https://registry.npmmirror.com'
      : 'https://registry.npmjs.org/'
    let lastErr = null
    for (const reg of [REGISTRY, fallback]) {
      try {
        await npm(['install', `${PACKAGE}@${latestVersion}`, '--prefix', args.runtimeDir, '--no-audit', '--no-fund', '--no-progress', '--loglevel=http', '--registry', reg], { stream: true, timeoutMs: 600_000 })
        log(`updated to ${latestVersion}`)
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        log(`registry ${reg} 安装失败：${err.message}`)
      }
    }
    // Restore the protected plugins (whatever npm pruned comes back as-is,
    // preserving user-updated versions).
    for (const entry of readdirSync(backupDir)) {
      const to = join(nodeModules, entry)
      rmSync(to, { recursive: true, force: true })
      cpSync(join(backupDir, entry), to, { recursive: true, force: true })
    }
    rmSync(backupDir, { recursive: true, force: true })
    installError = lastErr
  } finally {
    // Safety net: if anything above threw before the restore loop, put the
    // protected plugins back so they are never lost.
    if (existsSync(backupDir)) {
      for (const entry of readdirSync(backupDir)) {
        const to = join(nodeModules, entry)
        rmSync(to, { recursive: true, force: true })
        cpSync(join(backupDir, entry), to, { recursive: true, force: true })
      }
      rmSync(backupDir, { recursive: true, force: true })
    }
    clearInterval(heartbeat)
    emit({
      t: 'install-status',
      phase: installError ? 'error' : 'done',
      version: latestVersion,
      error: installError ? installError.message : undefined,
    })
  }
  if (installError) throw new Error(`所有 registry 安装失败：${installError.message}`)
  emitUpdateStatus(false)
  return true
}

// ── built-in forward proxy (shell egress point; see proxy.mjs) ─────────────
// The manager runs a loopback forward proxy and points EVERY child (dsh undici
// fetch, npm, pnpm, git, subagent CLIs) at it via *PROXY env vars +
// NODE_USE_ENV_PROXY=1. Routing (which hosts go through the optional upstream
// proxy) is decided LIVE inside the proxy from <runtime>/proxy.json, so
// toggling a host in the settings panel takes effect immediately (no dsh
// restart). The proxy is shell code — @deepseek-ai/dsh is never modified.
let forwardProxy = null
let proxyHosts = []
let proxyProviders = []
let persistHostsTimer = null
let providersTimer = null

function proxyConfigFile() {
  return join(args.runtimeDir, 'proxy.json')
}

function schedulePersistKnownHosts() {
  clearTimeout(persistHostsTimer)
  persistHostsTimer = setTimeout(() => {
    try { forwardProxy?.persistKnownHosts() } catch { /* best-effort */ }
  }, 2000)
}

async function refreshProxyProviders() {
  const dshHome = args.home ?? join(args.runtimeDir, 'dsh-home')
  const providers = providerHostsFromSettings(join(dshHome, 'settings.yaml'))
  if (JSON.stringify(providers) !== JSON.stringify(proxyProviders)) {
    proxyProviders = providers
    return true // changed — caller emits
  }
  return false
}

/**
 * Start the loopback forward proxy and re-point every child at it. MUST run
 * before any npm/dsh child is spawned so the fresh install/update already
 * rides the choke point.
 */
async function startForwardProxy() {
  forwardProxy = createForwardProxy({
    configFile: proxyConfigFile(),
    onHosts: (hosts) => {
      proxyHosts = hosts
      emit({ t: 'proxy-hosts', hosts })
      schedulePersistKnownHosts()
    },
    log,
  })
  const port = await forwardProxy.port
  log(`forward proxy on 127.0.0.1:${port}`)
  // The shell's single egress point: NODE_USE_ENV_PROXY makes undici's global
  // fetch honor the *PROXY vars (all of dsh's model/web-search requests ride
  // undici); npm/git/pnpm/child CLIs inherit them natively. NO_PROXY keeps the
  // local web server and notification bridge on loopback.
  process.env.NODE_USE_ENV_PROXY = '1'
  process.env.HTTP_PROXY = `http://127.0.0.1:${port}`
  process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`
  process.env.ALL_PROXY = `http://127.0.0.1:${port}`
  process.env.NO_PROXY = ['127.0.0.1', 'localhost', '::1', process.env.NO_PROXY].filter(Boolean).join(',')
  const cfg = forwardProxy.config()
  emit({ t: 'proxy-status', port, upstreamEnabled: cfg.upstream?.enabled === true, proxiedHosts: cfg.proxiedHosts ?? [] })
  // Provider host list for the settings panel; re-polled so edits to
  // settings.yaml (adding a provider) land without a dsh restart.
  await refreshProxyProviders().catch(() => {})
  emit({ t: 'proxy-providers', providers: proxyProviders })
  emit({ t: 'proxy-hosts', hosts: forwardProxy.hosts() })
  providersTimer = setInterval(() => {
    void (async () => {
      try {
        if (await refreshProxyProviders()) emit({ t: 'proxy-providers', providers: proxyProviders })
      } catch { /* keep polling */ }
    })()
  }, 15000)
  providersTimer.unref?.()
}

// ── steps ──────────────────────────────────────────────────────────────────
function ensureRuntimeDir(runtimeDir) {
  mkdirSync(runtimeDir, { recursive: true })
  const pkgJson = join(runtimeDir, 'package.json')
  if (!existsSync(pkgJson)) {
    writeFileSync(pkgJson, JSON.stringify({ name: 'dsh-runtime', private: true, version: '0.0.0' }, null, 2))
  }
  // npm 11 gates native install scripts behind allowScripts; without these the
  // dsh runtime would be missing node-pty / koffi / the spawn helper on Windows.
  const npmrcPath = join(runtimeDir, '.npmrc')
  if (!existsSync(npmrcPath)) {
    const allow = [
      '@deepseek-ai/dsh-subprocess-local',
      'koffi',
      'node-pty',
      '@google/genai',
      'protobufjs',
    ].map((p) => `allow-scripts[]=${p}`).join('\n')
    writeFileSync(npmrcPath, allow + '\n')
  }
}

function ensurePlugin(runtimeDir, resourceDir) {
  // Copy every desktop client plugin under resources/plugin/@dsh-desktop/*.
  // The true package name comes from each package.json (source dir names are
  // not the package name), so the runtime copy lands at the resolvable path.
  const scopeRoot = resolve(resourceDir, 'plugin', '@dsh-desktop')
  if (!existsSync(scopeRoot)) throw new Error(`plugin resources missing: ${scopeRoot}`)
  for (const rel of readdirSync(scopeRoot)) {
    const src = join(scopeRoot, rel)
    if (!statSync(src).isDirectory()) continue
    const pkgJson = join(src, 'package.json')
    if (!existsSync(pkgJson)) continue
    const pkgName = JSON.parse(readFileSync(pkgJson, 'utf8')).name ?? `@dsh-desktop/${rel}`
    const dest = join(runtimeDir, 'node_modules', pkgName)
    // Copy (and upgrade) whenever source differs: an old runtime copy must
    // not pin the app to outdated client code forever.
    const updating = existsSync(dest) && !sameTree(src, dest)
    if (!existsSync(dest) || updating) {
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(src, dest, { recursive: true })
      log(updating ? `updated client plugin ${pkgName}` : `installed client plugin ${pkgName}`)
    }
    // Bake the live bridge port into the served client.js (idempotent: skips
    // the write when the port is unchanged, so sameTree stays stable).
    bakeBridgePort(dest)
  }
}

// ── preinstalled plugins (D3: shell-shipped, default OFF, version-locked) ──
// Each directory under resources/preinstalled/<pkg> is a self-contained dsh
// bundle. Copies land in <runtime>/node_modules/<pkg> — NEVER in the profile's
// dependencies, so `dsh plugin` reconcile (which only manages dependency
// names) can neither auto-enable nor remove them. "Enable" = the Rust shell
// appends the package name to dsh.profile.bundles; module resolution finds it
// via the installation-anchor parent walk. The preinstalled list is recorded
// in <runtime>/dsh.json for the shell's plugin console.
const SHELL_MANIFEST = 'dsh.json'

function readShellManifest(runtimeDir) {
  const path = join(runtimeDir, SHELL_MANIFEST)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

function writeShellManifest(runtimeDir, manifest) {
  writeFileSync(join(runtimeDir, SHELL_MANIFEST), JSON.stringify(manifest, null, 2) + '\n')
}

/** Installed version of a package dir, or null. */
function installedVersionOf(pkgDir) {
  const p = join(pkgDir, 'package.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')).version ?? null
  } catch {
    return null
  }
}

function ensurePreinstalled(runtimeDir, resourceDir) {
  const srcRoot = resolve(resourceDir, 'preinstalled')
  if (!existsSync(srcRoot)) {
    log('no preinstalled bundles in resources')
    return
  }
  const manifest = readShellManifest(runtimeDir)
  // User-chosen updates (dsh.json `updates`): keep the runtime copy at the
  // user's version instead of overwriting it with the shell's bundled copy.
  const userUpdated = manifest.updates ?? {}
  const names = []
  for (const name of readdirSync(srcRoot)) {
    const src = join(srcRoot, name)
    if (!statSync(src).isDirectory()) continue
    // The package's true name comes from its manifest, not the dir name.
    const pkgJson = join(src, 'package.json')
    if (!existsSync(pkgJson)) continue
    const pkgName = JSON.parse(readFileSync(pkgJson, 'utf8')).name ?? name
    names.push(pkgName)
    const dest = join(runtimeDir, 'node_modules', pkgName)
    if (userUpdated[pkgName] !== undefined) {
      const installed = installedVersionOf(dest)
      if (installed === userUpdated[pkgName]) {
        log(`keeping user-updated ${pkgName}@${installed}`)
        continue
      }
      // Stale record (runtime missing or version mismatch): fall through and
      // restore the bundled copy below.
    }
    const updating = existsSync(dest) && !sameTree(src, dest)
    if (!existsSync(dest) || updating) {
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(src, dest, { recursive: true })
      log(updating ? `updated preinstalled ${pkgName}` : `installed preinstalled ${pkgName}`)
    }
  }
  if (names.length === 0) return
  // Preserve other shell fields (devMode, updates) while recording the list.
  manifest.preinstalled = names
  writeShellManifest(runtimeDir, manifest)
  log(`preinstalled bundles: ${names.join(', ')}`)
}

// ── preinstalled plugin updates (user-gated, npm source, reset available) ──
// Preinstalled bundles are NOT profile dependencies, so `dsh plugin` cannot
// manage them. Updates fetch the package from npm into a TEMP prefix and copy
// the extracted package over the runtime copy — never `npm install --prefix
// <runtime>`, which would prune the copied-only plugin packages (notifications
// / console / other preinstalled) not listed in runtime/package.json.
let preinstalledUpdates = {}

function emitPreinstalledUpdates() {
  emit({ t: 'preinstalled-updates', updates: preinstalledUpdates })
}

/** Latest version of a package on the registry (npm view), or null. */
async function npmViewVersion(name) {
  const out = await npm(['view', name, 'version', '--json', '--registry', REGISTRY], { timeoutMs: 60_000 })
  const parsed = JSON.parse(out)
  return typeof parsed === 'string' ? parsed : parsed?.version ?? null
}

/** Refresh the cached update state for every preinstalled bundle. */
async function checkPreinstalledUpdates() {
  const names = shellManifest.preinstalled ?? []
  // Query the registry in PARALLEL: N bundles must not serialize N registry
  // round-trips (offline each npm view can take seconds — serialized this
  // delayed the preinstalled-updates event past the shell's patience).
  const entries = await Promise.all(
    names.map(async (name) => {
      const installed = installedVersionOf(join(args.runtimeDir, 'node_modules', name))
      let latest = null
      try {
        latest = await npmViewVersion(name)
      } catch {
        latest = null
      }
      return [name, {
        installed,
        latest,
        updateAvailable: Boolean(latest && installed && latest !== installed),
        userUpdated: (shellManifest.updates ?? {})[name] !== undefined,
      }]
    }),
  )
  const next = Object.fromEntries(entries)
  preinstalledUpdates = next
  emitPreinstalledUpdates()
}

/** Update one preinstalled bundle from npm (user-gated). */
async function updatePreinstalled(name) {
  if (!(shellManifest.preinstalled ?? []).includes(name)) {
    log(`update-preinstalled: ${name} is not a preinstalled bundle`)
    return
  }
  if (activeOp && activeOp.op && !activeOp.done) {
    log(`update-preinstalled ignored: another op is running`)
    return
  }
  emitOpStatus({ op: 'update-preinstalled', spec: name, done: false })
  log(`updating preinstalled ${name}`)
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-pre-'))
  try {
    const latest = await npmViewVersion(name)
    if (!latest) throw new Error('无法获取最新版本')
    const dest = join(args.runtimeDir, 'node_modules', name)
    const installed = installedVersionOf(dest)
    if (installed !== latest) {
      await npm(['install', `${name}@${latest}`, '--prefix', tmp, '--no-audit', '--no-fund', '--no-progress', '--loglevel=http', '--registry', REGISTRY], { stream: true, timeoutMs: 600_000 })
      const src = join(tmp, 'node_modules', name)
      if (!existsSync(src)) throw new Error(`npm 未产出 ${name}@${latest}`)
      rmSync(dest, { recursive: true, force: true })
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(src, dest, { recursive: true })
      log(`preinstalled ${name} updated to ${latest}`)
    } else {
      log(`preinstalled ${name} already at ${latest}`)
    }
    const manifest = readShellManifest(args.runtimeDir)
    manifest.updates = { ...(manifest.updates ?? {}), [name]: latest }
    writeShellManifest(args.runtimeDir, manifest)
    shellManifest = manifest
    await checkPreinstalledUpdates()
    emitOpStatus({ op: 'update-preinstalled', spec: name, done: true, ok: true, nextAction: 'restart' })
  } catch (err) {
    log(`update-preinstalled ${name} failed: ${err.message}`)
    emitOpStatus({ op: 'update-preinstalled', spec: name, done: true, ok: false, error: err.message })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** Reset one preinstalled bundle back to the shell-shipped (bundled) version. */
async function resetPreinstalled(name) {
  if (!(shellManifest.preinstalled ?? []).includes(name)) {
    log(`reset-preinstalled: ${name} is not a preinstalled bundle`)
    return
  }
  if (activeOp && activeOp.op && !activeOp.done) {
    log(`reset-preinstalled ignored: another op is running`)
    return
  }
  emitOpStatus({ op: 'reset-preinstalled', spec: name, done: false })
  log(`resetting preinstalled ${name}`)
  try {
    const manifest = readShellManifest(args.runtimeDir)
    if (manifest.updates) delete manifest.updates[name]
    writeShellManifest(args.runtimeDir, manifest)
    shellManifest = manifest
    // Re-copy the bundled copy over the user's version (byte-compare detects
    // the difference and replaces it).
    ensurePreinstalled(args.runtimeDir, args.resourceDir)
    shellManifest = readShellManifest(args.runtimeDir)
    await checkPreinstalledUpdates()
    emitOpStatus({ op: 'reset-preinstalled', spec: name, done: true, ok: true, nextAction: 'restart' })
  } catch (err) {
    log(`reset-preinstalled ${name} failed: ${err.message}`)
    emitOpStatus({ op: 'reset-preinstalled', spec: name, done: true, ok: false, error: err.message })
  }
}

function bakeBridgePort(dest) {
  if (!args.bridgePort) return
  const p = join(dest, 'client.js')
  const raw = readFileSync(p, 'utf8')
  // Replace ONLY the quoted literal `'__DSH_BRIDGE_PORT__'` — the unquoted
  // `globalThis.__DSH_BRIDGE_PORT__` read path must survive (replacing it
  // produced `globalThis.12345`, a SyntaxError that killed plugin loading).
  const next = raw.split("'__DSH_BRIDGE_PORT__'").join(`'${args.bridgePort}'`)
  if (next !== raw) {
    writeFileSync(p, next)
    log(`bridge port baked: ${args.bridgePort}`)
  }
}

// Cheap tree comparison: same file set, byte-identical contents. (Plugin is a
// few small files, so content compare is fine; mtimes are NOT usable because
// cpSync stamps dest with the copy time.)
function sameTree(a, b) {
  const fa = readdirRecursive(a)
  const fb = readdirRecursive(b)
  if (fa.length !== fb.length) return false
  for (const rel of fa.keys()) {
    if (!fb.has(rel)) return false
    if (!readFileSync(join(a, rel)).equals(readFileSync(join(b, rel)))) return false
  }
  return true
}

function readdirRecursive(dir) {
  const out = new Map()
  if (!existsSync(dir)) return out
  const walk = (base) => {
    for (const name of readdirSync(base)) {
      const p = join(base, name)
      const rel = relative(dir, p)
      if (statSync(p).isDirectory()) walk(p)
      else out.set(rel, true)
    }
  }
  walk(dir)
  return out
}

// ── dsh process ────────────────────────────────────────────────────────────
const URL_RE = /(https?:\/\/127\.0\.0\.1:\d+)/

let currentChild = null
let restartRequested = false
let pendingTask = null

function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      // windowsHide: taskkill is a console app — without it every restart /
      // shutdown flashes a cmd window on the user's desktop.
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(pid, 'SIGTERM')
    }
  } catch { /* child already gone */ }
}

/** Ask the supervisor to re-spawn dsh (kill the current child if any). */
function requestRestart() {
  restartRequested = true
  // A restart APPLIES whatever op asked for it, so the "restart to apply"
  // hint must not survive it. Clear the op-status and tell the shell, or the
  // console would re-show "✓ 完成 — 重启后生效" on the freshly loaded page.
  // Use null (not {op:null,done:false}): the busy guard `activeOp && !done`
  // must not mistake a cleared state for an op in progress.
  activeOp = null
  emit({ t: 'op-status', op: null, done: false })
  if (currentChild) killTree(currentChild.pid)
}

/** Register a task the supervisor must await before re-spawning (e.g. update install). */
function setPendingTask(task) {
  pendingTask = task
}

async function launchDsh(runtimeDir, patchPath, cwd) {
  const entry = join(runtimeDir, 'node_modules', PACKAGE, 'lib', 'bin.js')
  if (!existsSync(entry)) throw new Error(`${PACKAGE} not installed at ${entry}`)
  // Desktop-owned DSH_HOME (default <runtime>/dsh-home): keeps data
  // self-contained and — crucially — makes the profile's module resolver walk
  // up to <runtime>/node_modules so the injected plugin package resolves.
  // Ambient $DSH_HOME is deliberately NOT inherited, so the desktop app never
  // writes into the browser version's ~/.dsh. Pass --home to override.
  const dshHome = args.home ?? join(runtimeDir, 'dsh-home')
  const child = spawn(process.execPath, [entry, 'web', '--patch', patchPath, '--host', '127.0.0.1', '--port', '0'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: dshHome },
    windowsHide: true,
  })
  child.stdout.on('data', (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (!line) continue
      const m = line.match(URL_RE)
      if (m) emit({ t: 'url', url: m[1] })
      log(line)
    }
  })
  child.stderr.on('data', (buf) => {
    for (const line of String(buf).split(/\r?\n/)) if (line) log(line)
  })
  currentChild = child
  const code = await new Promise((resolvePromise) => child.on('exit', (c, s) => resolvePromise(c ?? (s === 'SIGKILL' ? 137 : 1))))
  if (currentChild === child) currentChild = undefined
  return { code, pid: child.pid }
}

/**
 * Supervisor loop: keep dsh alive across requested restarts. After a child
 * exit, an awaited pending task (update install) runs first, then a requested
 * restart re-spawns; otherwise the loop returns the exit code.
 */
async function supervise(runtimeDir, patchPath, cwd) {
  while (true) {
    restartRequested = false
    let code
    try {
      ({ code } = await launchDsh(runtimeDir, patchPath, cwd))
    } catch (err) {
      log(`launch failed: ${err.message}`)
      return 1
    }
    if (pendingTask) {
      await pendingTask
      pendingTask = null
    }
    if (restartRequested) {
      log('restarting dsh (requested)')
      continue
    }
    log(`dsh exited with code ${code}`)
    return code
  }
}

// ── command channel (Rust shell → manager) ──────────────────────────────────
async function updateDshAndRestart() {
  log('update requested by user')
  // Stop dsh first: a live dsh locks native modules npm must replace.
  requestRestart()
  const task = (async () => {
    try {
      const updated = await installDshUpdate()
      if (updated) {
        // `npm install @deepseek-ai/dsh --prefix <runtime>` reifies the runtime
        // tree and prunes the copied-only packages (@dsh-desktop/* plugins and
        // preinstalled bundles) not listed in runtime/package.json — restore
        // them before dsh restarts so the injected plugins still load.
        ensurePlugin(args.runtimeDir, args.resourceDir)
        ensurePreinstalled(args.runtimeDir, args.resourceDir)
        shellManifest = readShellManifest(args.runtimeDir)
        log('dsh updated — restarting service')
      }
    } catch (err) {
      log(`update failed: ${err.message}`)
      emitUpdateStatus(false)
    }
  })()
  setPendingTask(task)
  await task
}

function handleCommand(cmd) {
  switch (cmd?.cmd) {
    case 'check-update': void checkDshUpdate({ frozen: shellManifest.devMode === true }); break
    case 'update-dsh': void updateDshAndRestart(); break
    case 'restart-dsh': log('restart-dsh requested'); requestRestart(); break
    case 'plugins-install':
      if (cmd.spec) {
        const spec = normalizeGitHubSpec(cmd.spec)
        if (spec !== cmd.spec) log(`plugins-install: ${cmd.spec} -> ${spec}`)
        void runPluginOp(['add', spec], { op: 'install', spec })
      } else {
        log('plugins-install: missing spec')
      }
      break
    case 'plugins-remove':
      if (cmd.name) void runPluginOp(['remove', String(cmd.name)], { op: 'remove', spec: String(cmd.name) })
      else log('plugins-remove: missing name')
      break
    case 'plugins-update':
      void runPluginOp(
        cmd.name ? ['update', String(cmd.name)] : ['update'],
        { op: 'update', spec: cmd.name ? String(cmd.name) : '(all)' },
      )
      break
    case 'preinstalled-check': void checkPreinstalledUpdates(); break
    case 'preinstalled-update':
      if (cmd.name) void updatePreinstalled(String(cmd.name))
      else log('preinstalled-update: missing name')
      break
    case 'preinstalled-reset':
      if (cmd.name) void resetPreinstalled(String(cmd.name))
      else log('preinstalled-reset: missing name')
      break
    default: log(`unknown manager command: ${cmd?.cmd}`)
  }
}

function setupCommandChannel() {
  // Manual console runs have a TTY: keep the command channel off so typing
  // does not become commands. The real shell pipes stdin (JSON lines).
  if (process.stdin.isTTY) return
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let cmd = null
      try { cmd = JSON.parse(trimmed) } catch { log(`bad manager command: ${trimmed}`); continue }
      handleCommand(cmd)
    }
  })
  process.stdin.on('error', () => { /* stdin closed by the shell; ignore */ })
}

// ── user-installed plugins (P5, 方案 X: bundled pnpm + `dsh plugin` CLI) ────
// The upstream CLI already does the whole job: init the web profile, run
// pnpm add/remove/update in it, and reconcile dsh.profile.bundles against the
// installed state. The shell only has to (a) provide pnpm (bundled into the
// runtime dir on first use, exposed via a shim on PATH) and (b) stream the
// CLI's output back as log lines + op-status events.

/** Bundled pnpm's entry script (node_modules/pnpm/bin/pnpm.cjs). */
function pnpmEntry(runtimeDir) {
  return join(runtimeDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
}

/** Directory holding the platform pnpm shim (prepended to PATH). */
function pnpmShimDir(runtimeDir) {
  return join(runtimeDir, 'bin')
}

/** Install pnpm into the runtime dir (lazy: only on first plugin operation). */
async function ensurePnpm(runtimeDir) {
  if (existsSync(pnpmEntry(runtimeDir))) {
    // Pre-seeded pnpm (or a prior install): still make sure the shim exists.
    writePnpmShim(runtimeDir)
    return
  }
  log('installing bundled pnpm (plugin management)…')
  // CRITICAL: never `npm install --prefix <runtime>` — npm reifies the whole
  // runtime tree and PRUNES packages not listed in runtime/package.json
  // dependencies, deleting the copied-only plugins (@dsh-desktop/*) and
  // preinstalled bundles. Install into a temp prefix and copy the package in.
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-pnpm-'))
  const fallback = REGISTRY === 'https://registry.npmjs.org/'
    ? 'https://registry.npmmirror.com'
    : 'https://registry.npmjs.org/'
  let lastErr = null
  try {
    for (const reg of [REGISTRY, fallback]) {
      try {
        await npm(['install', 'pnpm', '--prefix', tmp, '--no-audit', '--no-fund', '--no-progress', '--loglevel=http', '--registry', reg], { stream: true, timeoutMs: 600_000 })
        const src = join(tmp, 'node_modules', 'pnpm')
        if (!existsSync(src)) throw new Error('npm 未产出 pnpm')
        const dest = join(runtimeDir, 'node_modules', 'pnpm')
        rmSync(dest, { recursive: true, force: true })
        mkdirSync(dirname(dest), { recursive: true })
        cpSync(src, dest, { recursive: true })
        log('pnpm installed')
        writePnpmShim(runtimeDir)
        return
      } catch (err) {
        lastErr = err
        log(`pnpm install failed (${reg}): ${err.message}`)
      }
    }
    throw new Error(`pnpm 安装失败：${lastErr?.message ?? 'unknown'}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** Create `pnpm` / `pnpm.cmd` shims that run the bundled pnpm under our Node. */
function writePnpmShim(runtimeDir) {
  const binDir = pnpmShimDir(runtimeDir)
  mkdirSync(binDir, { recursive: true })
  const node = process.execPath
  const entry = pnpmEntry(runtimeDir)
  const sh = `#!/bin/sh\nexec "${node}" "${entry}" "$@"\n`
  const exe = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const path = join(binDir, exe)
  if (existsSync(path)) return
  if (process.platform === 'win32') {
    writeFileSync(join(binDir, 'pnpm.cmd'), `@echo off\r\n"${node}" "${entry}" %*\r\n`)
    writeFileSync(join(binDir, 'pnpm'), sh)
  } else {
    writeFileSync(join(binDir, 'pnpm'), sh)
    chmodSync(join(binDir, 'pnpm'), 0o755)
  }
  log(`pnpm shim ready at ${join(binDir, exe)}`)
}

/** Run `dsh plugin --profile web <args...>` under the web profile's DSH_HOME. */
function runDshPlugin(runtimeDir, argsList, cwd) {
  const dshBin = join(runtimeDir, 'node_modules', PACKAGE, 'lib', 'bin.js')
  if (!existsSync(dshBin)) throw new Error(`dsh not installed at ${dshBin}`)
  const dshHome = args.home ?? join(runtimeDir, 'dsh-home')
  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    PATH: `${pnpmShimDir(runtimeDir)}${delimiter()}${process.env.PATH ?? ''}`,
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [dshBin, 'plugin', '--profile', 'web', ...argsList], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    })
    const pump = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        const t = line.replace(/^\s+|\s+$/g, '')
        if (t) log(t.slice(0, 500))
      }
    }
    child.stdout.on('data', pump)
    child.stderr.on('data', pump)
    child.on('error', rejectPromise)
    child.on('exit', (code) => resolvePromise(code ?? 1))
  })
}

// Active plugin op, mirrored to the shell via {t:'op-status'} and included in
// the bridge's /plugins/list so the console can show progress + nextAction.
let activeOp = null

function emitOpStatus(status) {
  activeOp = status
  emit({ t: 'op-status', ...status })
}

/**
 * Normalize common GitHub URL forms into a pnpm git spec. pnpm does NOT accept
 * a bare `https://github.com/...` as a dependency spec — it needs
 * `github:owner/repo` (or `git+https://...`). Users paste URLs, so we rewrite:
 *   https://github.com/owner/repo[/...][.git][#ref]  ->  github:owner/repo[#ref]
 * Other specs (npm names, github:, git+https://, paths) pass through untouched.
 */
function normalizeGitHubSpec(spec) {
  const s = String(spec).trim()
  const m = s.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+?)(?:\.git)?(?:\/.*)?(?:#([\w.-]+))?$/)
  if (m) {
    const [, owner, repo, ref] = m
    return `github:${owner}/${repo}${ref ? `#${ref}` : ''}`
  }
  return s
}

/** The web profile manifest path (same DSH_HOME the `dsh plugin` CLI uses). */
function profileManifestPath() {
  const home = args.home ?? join(args.runtimeDir, 'dsh-home')
  return join(home, 'profiles', 'web', 'package.json')
}

function readProfileManifest() {
  try {
    return JSON.parse(readFileSync(profileManifestPath(), 'utf8'))
  } catch {
    return { dependencies: {}, dsh: { profile: { bundles: [] } } }
  }
}

async function runPluginOp(argsList, opInfo) {
  if (activeOp && activeOp.op && !activeOp.done) {
    log(`plugin ${opInfo.op} ignored: another op is already running`)
    return
  }
  // Capture the dependency set before, so an install can tell whether the
  // added package actually became a plugin layer (dsh.profile.bundles) or was
  // just a plain dependency (no dsh.bundle) — the honest "did it take effect".
  const beforeDeps = new Set(Object.keys(readProfileManifest().dependencies ?? {}))
  const cwd = args.cwd && existsSync(args.cwd) ? args.cwd : process.env.HOME ?? process.cwd()
  emitOpStatus({ op: opInfo.op, spec: opInfo.spec, done: false })
  log(`plugin ${opInfo.op}: ${opInfo.spec}`)
  try {
    // The `dsh plugin` CLI spawns `pnpm` — make sure the bundled one + shim
    // are in place first (lazy install on the first plugin operation).
    await ensurePnpm(args.runtimeDir)
    const code = await runDshPlugin(args.runtimeDir, argsList, cwd)
    const ok = code === 0
    log(`plugin ${opInfo.op} ${opInfo.spec}: ${ok ? 'ok' : `failed (code ${code})`}`)
    let hint
    let hintKey
    let hintPlugins
    let nextAction = ok ? 'restart' : null
    if (ok && opInfo.op === 'install') {
      const after = readProfileManifest()
      const afterDeps = Object.keys(after.dependencies ?? {})
      const bundles = after.dsh?.profile?.bundles ?? []
      const added = afterDeps.filter((n) => !beforeDeps.has(n))
      const notLoaded = added.filter((n) => !bundles.includes(n))
      if (notLoaded.length > 0) {
        // Installed as a dependency but declares no dsh.bundle — it will never
        // load as a plugin; no restart needed and the user deserves to know.
        // hintKey + hintPlugins let the console render this in the UI language.
        hint = `已安装：${notLoaded.join(', ')} 未声明 dsh.bundle，不会作为插件加载`
        hintKey = 'not-a-bundle'
        hintPlugins = notLoaded
        nextAction = null
      }
    }
    emitOpStatus({
      op: opInfo.op,
      spec: opInfo.spec,
      done: true,
      ok,
      nextAction,
      hint,
      hintKey,
      hintPlugins,
    })
  } catch (err) {
    log(`plugin ${opInfo.op} failed: ${err.message}`)
    emitOpStatus({ op: opInfo.op, spec: opInfo.spec, done: true, ok: false, error: err.message })
  }
}

function delimiter() {
  return process.platform === 'win32' ? ';' : ':'
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  log('dsh-desktop manager started')
  ensureRuntimeDir(args.runtimeDir)
  shellManifest = readShellManifest(args.runtimeDir)
  // The built-in forward proxy must be up BEFORE the first npm/dsh child:
  // the fresh install/update and every later request ride the choke point.
  try {
    await startForwardProxy()
  } catch (err) {
    log(`forward proxy start failed (continuing without it): ${err.message}`)
  }
  // Auto-install dsh when missing (fresh install, or the runtime copy was
  // removed) — without this the launcher hangs on "dsh 服务已退出" forever.
  if (!installedVersion(args.runtimeDir)) {
    try {
      log('dsh missing — installing automatically')
      await installDshUpdate()
    } catch (err) {
      log(`auto-install dsh failed: ${err.message}`)
    }
  }
  // Launch dsh FIRST; the update check runs in the background (it must never
  // delay the UI — a slow registry lookup used to block dsh startup for
  // seconds behind a dark/white launcher). It reports via update-status events.
  void checkDshUpdate({ frozen: shellManifest.devMode === true }).catch(() => {})
  ensurePlugin(args.runtimeDir, args.resourceDir)
  // Recover a plugin backup left by a killed install (user retried mid-install,
  // or the app was closed): restore the protected plugins before they are
  // re-ensured, so user-updated versions are not lost.
  const leftoverBackup = join(args.runtimeDir, '.plugin-backup')
  if (existsSync(leftoverBackup)) {
    try {
      const nodeModules = join(args.runtimeDir, 'node_modules')
      for (const entry of readdirSync(leftoverBackup)) {
        const to = join(nodeModules, entry)
        rmSync(to, { recursive: true, force: true })
        cpSync(join(leftoverBackup, entry), to, { recursive: true, force: true })
      }
      rmSync(leftoverBackup, { recursive: true, force: true })
      log('restored interrupted-install plugin backup')
    } catch (err) {
      log(`plugin backup recovery failed: ${err.message}`)
    }
  }
  ensurePreinstalled(args.runtimeDir, args.resourceDir)
  shellManifest = readShellManifest(args.runtimeDir)
  // Preinstalled update badges (npm view per bundle) — background, never blocks.
  void checkPreinstalledUpdates().catch(() => {})

  const cwd = args.cwd && existsSync(args.cwd) ? args.cwd : process.env.HOME ?? process.cwd()
  log(`launching dsh web (runtime=${args.runtimeDir})`)
  setupCommandChannel()

  const shutdown = () => {
    clearTimeout(persistHostsTimer)
    clearInterval(providersTimer)
    try { forwardProxy?.close() } catch { /* already closed */ }
    if (currentChild) killTree(currentChild.pid)
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  try {
    const code = await supervise(args.runtimeDir, args.patch, cwd)
    // Explicit exit: the open stdin pipe would otherwise keep the process
    // alive after dsh has gone, and the shell needs the stdout EOF (server-down).
    process.exit(code === 0 ? 0 : 2)
  } catch (err) {
    log(`fatal: ${err.message}`)
    process.exit(1)
  }
}

main().catch((err) => {
  log(`fatal: ${err.message}`)
  process.exit(1)
})
