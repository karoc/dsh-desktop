#!/usr/bin/env node
// dsh Desktop — server manager.
//
// Runs under the bundled Node 24 (process.execPath). Owns everything
// dsh-version-specific:
//   1. ensure the per-user runtime dir (package.json);
//   2. check npm for the latest @deepseek-ai/dsh and install it when newer;
//   3. install the notification client plugin (copied from resources, no npm
//      needed — it has no runtime deps, only a peer typing);
//   4. spawn `dsh web --port 0 --patch <plugin roster>`;
//   5. emit machine-readable protocol lines on stdout:
//        {"t":"url","url":"http://127.0.0.1:<port>"}
//        {"t":"log","line":"..."}
//   6. on signal, kill the whole dsh tree (taskkill /T /F on Windows).

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = '@deepseek-ai/dsh'
const PLUGIN_PACKAGE = '@dsh-desktop/client-notifications'

// ── args ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { runtimeDir: null, resourceDir: null, patch: null, cwd: null, home: null, registry: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => argv[++i]
    if (a === '--runtime-dir') out.runtimeDir = val()
    else if (a === '--resource-dir') out.resourceDir = val()
    else if (a === '--patch') out.patch = val()
    else if (a === '--cwd') out.cwd = val()
    else if (a === '--home') out.home = val()
    else if (a === '--registry') out.registry = val()
  }
  if (!out.runtimeDir || !out.resourceDir || !out.patch) {
    throw new Error('usage: server-manager.mjs --runtime-dir <dir> --resource-dir <dir> --patch <file> [--cwd <dir>] [--home <dir>] [--registry <url>]')
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

function npm(argsList, { timeoutMs = 600_000, stream = false, quiet = true } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const cmd = npmViaCli ? process.execPath : 'npm'
    const cmdArgs = npmViaCli ? [npmCli, ...argsList] : argsList
    const child = spawn(cmd, cmdArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    let stdout = ''
    let stderr = ''
    let settled = false
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
          if (t && !/^npm (warn )/i.test(t)) log(t.slice(0, 500))
        }
      }
    }
    child.stdout.on('data', (b) => pump(b, false))
    child.stderr.on('data', (b) => pump(b, true))
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(e)
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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

async function updateDsh(runtimeDir) {
  const current = installedVersion(runtimeDir)
  log(`installed ${PACKAGE}: ${current ?? 'none'}`)
  if (process.env.DSH_DESKTOP_NO_UPDATE === '1') return
  let latest = null
  try {
    latest = await latestRemoteVersion()
    log(`npm latest ${PACKAGE}: ${latest ?? 'unknown'}`)
  } catch (err) {
    log(`update check failed (offline?): ${err.message}`)
    return
  }
  if (!latest) return
  if (current === latest) return
  log(`updating ${PACKAGE} ${current ?? '(none)'} -> ${latest}`)
  if (!current) log('首次安装/更新 dsh：视网络需 1~10 分钟，进度会实时显示')
  // Registry fallback chain: mirrors can lag on freshly-published deps, so
  // retry with the other default if the primary install fails.
  const fallback = REGISTRY === 'https://registry.npmjs.org/'
    ? 'https://registry.npmmirror.com'
    : 'https://registry.npmjs.org/'
  let lastErr = null
  for (const reg of [REGISTRY, fallback]) {
    try {
      await npm(['install', `${PACKAGE}@${latest}`, '--prefix', runtimeDir, '--no-audit', '--no-fund', '--no-progress', '--registry', reg], { stream: true, timeoutMs: 600_000 })
      log(`updated to ${latest}`)
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      log(`registry ${reg} 安装失败：${err.message}`)
    }
  }
  if (lastErr) log(`update install failed on all registries, keeping ${current ?? 'existing'}`)
}

function ensurePlugin(runtimeDir, resourceDir) {
  const dest = join(runtimeDir, 'node_modules', PLUGIN_PACKAGE)
  if (existsSync(dest)) return
  const src = resolve(resourceDir, 'plugin', PLUGIN_PACKAGE)
  if (!existsSync(src)) throw new Error(`plugin resource missing: ${src}`)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest, { recursive: true })
  log(`installed client plugin ${PLUGIN_PACKAGE}`)
}

// ── dsh process ────────────────────────────────────────────────────────────
const URL_RE = /(https?:\/\/127\.0\.0\.1:\d+)/

function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGTERM')
    }
  } catch { /* child already gone */ }
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

// ── main ───────────────────────────────────────────────────────────────────
let currentChild

async function main() {
  log('dsh-desktop manager started')
  ensureRuntimeDir(args.runtimeDir)
  await updateDsh(args.runtimeDir)
  ensurePlugin(args.runtimeDir, args.resourceDir)

  const cwd = args.cwd && existsSync(args.cwd) ? args.cwd : process.env.HOME ?? process.cwd()
  log(`launching dsh web (runtime=${args.runtimeDir})`)

  const shutdown = () => {
    if (currentChild) killTree(currentChild.pid)
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  try {
    const { code } = await launchDsh(args.runtimeDir, args.patch, cwd)
    log(`dsh exited with code ${code}`)
    process.exitCode = code === 0 ? 0 : 2
  } catch (err) {
    log(`launch failed: ${err.message}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  log(`fatal: ${err.message}`)
  process.exit(1)
})