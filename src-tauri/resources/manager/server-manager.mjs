#!/usr/bin/env node
// DSH Smoothly Desktop — server manager.
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

// npm fetch 快失败策略：@npmcli/agent 把 fetch-timeout 映射为 socket 的
// IDLE 超时（一段时间没收到任何字节就中止），所以慢速但持续流式的下载不受
// 影响，而"连接挂着不出数据"（冷安装/升级时最常见的卡死形态）会在 ~30s 内
// 报错并走 registry 降级，而不是让用户对着 10 分钟硬超时发呆。
const NPM_FETCH_FLAGS = [
  '--fetch-timeout=30000',
  '--fetch-retries=2',
  '--fetch-retry-mintimeout=2000',
  '--fetch-retry-maxtimeout=10000',
]

// dsh 的原生依赖：postinstall 需要跑构建/下载二进制。npm 11 用 .npmrc
// allow-scripts 放行；pnpm 11.22 用 pnpm-workspace.yaml 的 allowBuilds 放行。
const NATIVE_BUILD_PKGS = [
  '@deepseek-ai/dsh-subprocess-local',
  'koffi',
  'node-pty',
  '@google/genai',
  'protobufjs',
]

/**
 * 壳要求的最低 dsh 版本。0.1.6-alpha.2 起 dsh 自带插件管理（Web 侧边栏
 * Plugins 页 + @deepseek-ai/dsh-plugin-manager），壳内自建插件管理已整体移除，
 * 因此低于该版本的 dsh 会让用户彻底失去插件管理入口。npm 的 latest tag 目前仍是
 * 0.1.5-rc.2（不含插件管理），所以安装/升级目标取 max(latest, 地板)。
 */
const MIN_DSH_VERSION = '0.1.6-alpha.2'

// ── args ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { runtimeDir: null, resourceDir: null, patch: null, cwd: null, home: null, registry: undefined, bridgePort: null, shellVersion: null, shellIdentifier: null }
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
    else if (a === '--shell-version') out.shellVersion = val()
    else if (a === '--shell-identifier') out.shellIdentifier = val()
  }
  if (!out.runtimeDir || !out.resourceDir || !out.patch) {
    throw new Error('usage: server-manager.mjs --runtime-dir <dir> --resource-dir <dir> --patch <file> [--cwd <dir>] [--home <dir>] [--registry <url>] [--bridge-port <port>] [--shell-version <v>] [--shell-identifier <id>]')
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

// ── fatal-exception forensics ──────────────────────────────────────────────
// 退出码 1 有两种在壳侧无法区分的成因：被外部 TerminateProcess（taskkill /F）
// 杀掉，或 manager 自己因未捕获异常退出（`manager_guard::describe_exit` 亦如此
// 如实并列）。没有处理器时，后者只把栈写 stderr——Windows 上 stderr 是管道
// （异步写），`process.exit` 一到这行栈常常整段丢失，现场就只剩一个 code=1。
// 2026-09-15 02:11 的正式版事故正是这种"零证据"形态：manager.log 停在死亡前
// 49 秒、无 fatal 行、无 WER、无 node report。
// 因此显式接管：同步落一份证据再按原语义退出 1。区分规则——
//   有 manager-exception-*.txt = 自身异常崩溃（栈可读）；
//   没有任何标记文件而退出码为 1 = 被外部强制结束。
function recordFatalException(kind, err) {
  const text = [
    `kind: ${kind}`,
    `at: ${new Date().toISOString()}`,
    `pid: ${process.pid}`,
    `node: ${process.version}`,
    `uptimeSec: ${Math.round(process.uptime())}`,
    '',
    err?.stack ?? String(err),
  ].join('\n')
  let file = null
  let reports = '.'
  try {
    reports = join(args.runtimeDir ?? '.', 'reports')
    mkdirSync(reports, { recursive: true })
    file = join(reports, `manager-exception-${Math.floor(Date.now() / 1000)}.txt`)
    writeFileSync(file, text)
  } catch { /* 取证失败不得改变退出语义 */ }
  try {
    log(`fatal(${kind}) 未捕获异常 → 证据 ${file ?? '(落盘失败)'}`)
    for (const line of text.split('\n').slice(5, 9)) log(`fatal(${kind}) ${line}`)
  } catch { /* stdout 可能已断（壳退出），继续落盘 */ }
  // 完整 node 诊断报告（栈 + 句柄/资源 + libuv 状态），best-effort。
  // writeReport 收的是**文件名**（传目录会 EISDIR 并在 stderr 留噪音）。
  try {
    process.report?.writeReport?.(join(reports, `manager-report-${process.pid}-${Math.floor(Date.now() / 1000)}.json`))
  } catch { /* optional */ }
}

process.on('uncaughtException', (err) => {
  recordFatalException('uncaughtException', err)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  recordFatalException('unhandledRejection', reason)
  process.exit(1)
})

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
  const pkgs = url.match(/\/packages\/((?:@[^/]+\/)?[^/]+)\//) // npmmirror tarball
  if (pkgs) name = pkgs[1]
  if (!name) {
    // 包元数据文档：<registry>/<name>（npmmirror 的 scoped 元数据是
    // /@scope%2fname，npmjs 是 /@scope/name）。对 tarball URL 也能给出
    // 带 scope 的名字（.../@scope/name/-/name-x.y.z.tgz）。
    const meta = url.match(/\/\/[^/]+\/((?:@[^/]+%2f|@[^/]+\/)?[^/]+)/)
    if (meta) name = meta[1]
  }
  if (!name) {
    const reg = url.match(/\/registry\.[^/]+\/((?:@[^/]+\/)?[^/]+)\/-\//) // npmjs tarball
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

/**
 * Run a Node CLI child (npm / pnpm) under the bundled Node, with output
 * streaming (throttled for the launcher marquee), a hard timeout and a
 * no-output stall detector. All settle paths funnel through a single
 * `finish` so the promise resolves/rejects exactly once.
 * @param {string[]} cmdArgs args for `process.execPath` (e.g. [npmCli, ...])
 * @param {{cwd?: string, timeoutMs?: number, stream?: boolean,
 *          throttleAll?: boolean, tool?: string}} opts
 */
function runChild(cmdArgs, { cwd, timeoutMs = 600_000, stream = false, throttleAll = false, tool = 'npm' } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    // Native deps (koffi, node-pty) run `node` from PATH during postinstall,
    // but the bundled Node is NOT on PATH — prepend its directory so
    // `sh -c node` resolves (Linux broke silently: "node: not found").
    const env = {
      ...process.env,
      PATH: `${dirname(process.execPath)}${process.env.PATH ? pathDelimiter + process.env.PATH : ''}`,
    }
    const child = spawn(process.execPath, cmdArgs, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
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
    // 无输出卡死检测：只要子进程活着且在干活就会持续吐输出；连续 STALL_MS
    // 没有任何输出 = 卡死（悬挂连接、cacache 锁、postinstall 挂起等）。
    // 中止并报清晰错误，让 installDshUpdate 的 registry 降级链接上。阈值取
    // 180s：远高于磁盘慢时的静默解包期，又远低于 600s 硬超时。
    const STALL_MS = 180_000
    let lastOutputAt = Date.now()
    // 单一落定路径：定时器/卡死检测/子进程错误/退出 四者只允许第一个触发。
    const finish = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(stallTimer)
      fn()
    }
    const timer = setTimeout(() => {
      finish(() => {
        killTree(child.pid)
        const e = new Error(`${tool} 操作超时（可设 DSH_DESKTOP_REGISTRY 切换镜像加速）`)
        e.stderr = stderr
        e.stdout = stdout
        rejectPromise(e)
      })
    }, timeoutMs)
    const stallTimer = setInterval(() => {
      if (settled) return
      if (Date.now() - lastOutputAt >= STALL_MS) {
        finish(() => {
          killTree(child.pid)
          const e = new Error(`${tool} 已 ${Math.round(STALL_MS / 1000)} 秒无任何输出（疑似网络或安装卡住），已中止`)
          e.stderr = stderr
          e.stdout = stdout
          rejectPromise(e)
        })
      }
    }, 5000)
    const pump = (buf, isErr) => {
      lastOutputAt = Date.now()
      const text = String(buf)
      if (isErr) stderr += text
      else stdout += text
      if (stream) {
        for (const line of text.split(/\r?\n/)) {
          const t = line.replace(/^\s+|\s+$/g, '')
          if (!t || /^npm (warn )/i.test(t)) continue
          const now = Date.now()
          if (throttleAll) {
            // pnpm：没有可提炼的包名，所有行统一走节流（最新一条优先）。
            if (now - lastPackAt >= PACK_LOG_MS) { flushPending(); log(t.slice(0, 500)); lastPackAt = now }
            else pendingPack = t
          } else {
            const display = npmLineToDisplay(t)
            if (display) {
              if (now - lastPackAt >= PACK_LOG_MS) { flushPending(); log(display); lastPackAt = now }
              else pendingPack = display
            } else {
              // 非下载行（summary、错误等）即时输出，不节流。
              flushPending()
              log(t.slice(0, 500))
            }
          }
        }
      }
    }
    child.stdout.on('data', (b) => pump(b, false))
    child.stderr.on('data', (b) => pump(b, true))
    child.on('error', (e) => {
      finish(() => {
        flushPending()
        rejectPromise(e)
      })
    })
    child.on('exit', (code) => {
      finish(() => {
        flushPending()
        if (code === 0) resolvePromise(stdout)
        else {
          const e = new Error(`${tool} 退出码 ${code}: ${stderr.trim().split('\n').pop() ?? ''}`)
          e.stderr = stderr
          e.stdout = stdout
          rejectPromise(e)
        }
      })
    })
  })
}

function npm(argsList, { timeoutMs = 600_000, stream = false, quiet = true } = {}) {
  const cmdArgs = npmViaCli ? [npmCli, ...argsList, ...NPM_FETCH_FLAGS] : [...argsList, ...NPM_FETCH_FLAGS]
  return runChild(cmdArgs, { timeoutMs, stream, tool: 'npm' })
}

/**
 * Run the bundled pnpm (installed into the runtime by ensurePnpm) with the
 * given cwd. Used for the dsh install: npm's dependency resolver hangs on the
 * @deepseek-ai monorepo-shaped tree (hundreds of interdependent packages),
 * while pnpm — which dsh itself is developed with — installs it fine.
 */
function pnpm(argsList, { cwd, timeoutMs = 600_000, stream = false } = {}) {
  const entry = pnpmEntry(args.runtimeDir)
  const cmdArgs = [entry, ...argsList, '--reporter=append-only']
  return runChild(cmdArgs, { cwd, timeoutMs, stream, throttleAll: true, tool: 'pnpm' })
}

/**
 * 查询远端版本：latest（稳定 tag）+ 全部预发布 tag（next/alpha/beta 等）。
 * dsh 团队常把新 rc/alpha 标在 next/alpha 而非 latest；只读 latest 会漏更新，
 * 只读 next 会漏 alpha 等其它预发布 tag。规则：latest 取 dist-tags.latest；
 * nextVersion 取"所有 tag 版本中高于当前版本的最高者"（允许任意预发布 tag）。
 */
async function resolveRemoteVersions() {
  const out = await npm(['view', PACKAGE, 'dist-tags', '--json', '--registry', REGISTRY], { timeoutMs: 60_000 })
  let parsed = null
  try { parsed = JSON.parse(out) } catch { parsed = null }
  if (typeof parsed === 'string') {
    latestVersion = parsed
    nextVersion = null
    return
  }
  // npm view 返回 {"dist-tags": {latest, next, alpha, ...}}；解析失败时兜底为 null。
  const tags = (parsed && typeof parsed === 'object') ? (parsed['dist-tags'] ?? parsed) : null
  const current = installedVersion(args.runtimeDir)
  latestVersion = tags && typeof tags.latest === 'string' ? tags.latest : null
  let best = null
  nextTag = null
  if (tags && typeof tags === 'object') {
    for (const [tagName, v] of Object.entries(tags)) {
      if (typeof v !== 'string' || !v || v === latestVersion || v === current) continue
      // 预发布通道只提示"高于稳定线的新预发布"（如 0.1.3-alpha.1 > latest
      // rc.1）；比 latest 旧的 alpha/beta 不应引导用户"升级"。
      if (latestVersion !== null && !versionGt(v, latestVersion)) continue
      if (versionGt(v, current) && (best === null || versionGt(v, best))) { best = v; nextTag = tagName }
    }
  }
  nextVersion = best
}

/** 预发布排序值：无 pre 最高（正式版）；alpha < beta < rc；数字越大越高。 */
function preOrder(v) {
  const pre = String(v).split('-')[1]
  if (!pre) return 999
  const m = /^([a-z]+)\.?(\d+)?/.exec(pre)
  const rank = { alpha: 0, beta: 1, rc: 2 }[m ? m[1] : ''] ?? 0
  return rank * 1000 + Number(m && m[2] ? m[2] : 0)
}

/** 极简预发布感知比较：0.1.2-rc.1 > 0.1.2-alpha.5；正式版 > 任何预发布。 */
function versionGt(a, b) {
  const pa = String(a).split('-')[0].split('.').map(Number)
  const pb = String(b).split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return preOrder(a) > preOrder(b)
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

/** The dsh launch entry the manager spawns (package.json `bin.dsh`). */
function dshEntry(runtimeDir) {
  return join(runtimeDir, 'node_modules', PACKAGE, 'lib', 'bin.js')
}

/**
 * True only when dsh is FULLY installed: manifest present AND the launch entry
 * exists. A half-extracted install (npm killed mid-reify writes package.json
 * but not lib/bin.js) must NOT count as installed — otherwise the auto-install
 * gate skips and the launcher fails with "not installed" forever.
 */
function dshInstalled(runtimeDir) {
  return installedVersion(runtimeDir) !== null && existsSync(dshEntry(runtimeDir))
}

/**
 * 0.3.3 的 pnpm isolated 布局特征：node_modules 下有 .pnpm 虚拟仓库，且 dsh 的
 * 内部包（dsh-base 等）没有提升到 node_modules 根。这种布局下复制到根目录的
 * 预装插件（dsh-kanban 等）和 host bundle（dsh-base/dsh-web-app）import dsh
 * 内部包时会 ERR_MODULE_NOT_FOUND → dsh web 启动崩溃 → 黑屏。hoisted 布局
 * 把所有包提升到根，恢复解析。存在该布局时强制重装为 hoisted。
 */
function isIsolatedPnpmLayout(runtimeDir) {
  const root = join(runtimeDir, 'node_modules')
  return existsSync(join(root, '.pnpm')) && !existsSync(join(root, '@deepseek-ai', 'dsh-base'))
}

// ── update status ──────────────────────────────────────────────────────────
let latestVersion = null
let nextVersion = null
let nextTag = null // 预发布候选所在 dist-tag（alpha/beta/next…）
// Shell manifest (<runtime>/dsh.json) snapshot: preinstalled list, devMode, …
let shellManifest = {}

/** Emit the current update status to the shell (Rust mirrors it to the tray). */
function emitUpdateStatus(updateAvailable) {
  const current = installedVersion(args.runtimeDir)
  emit({
    t: 'update-status',
    current,
    latest: latestVersion,
    // 只在 latest 严格新于当前时才算"有更新"——用户在 next 预发布（如 rc.8）
    // 上时 latest（rc.7）反而更旧，绝不能提示降级。
    updateAvailable: updateAvailable ?? (latestVersion !== null && versionGt(latestVersion, current)),
    next: nextVersion,
    nextTag: nextVersion ? nextTag : null,
    nextAvailable: nextVersion !== null && nextVersion !== latestVersion && current !== nextVersion && versionGt(nextVersion, current),
  })
}

/**
 * 壳自更新检查（A-1 一期）：**只报告，不下载、不安装**。
 *
 * 设计要点（方案 v2 + 审计修订）：
 *   - 数据源直接用 GitHub `/releases/latest` 响应（含 tag_name + assets），
 *     **不产出也不依赖 latest.json**（避免"移 tag 后遗留旧文件"整类回归）；
 *   - 只有 prerelease 时 `/releases/latest` 返回 404 → 回退 `/releases` 取第一个
 *     非 draft；
 *   - 未认证 GitHub API 限流 60 次/小时/IP → 结果**缓存 6 小时**；
 *   - 版本比较复用 versionGt（semver 语义 + 预发布感知）；**低于或等于当前一律
 *     不提示**（防降级）；
 *   - dev 构建不检查（dev 与正式版同一份代码，靠 identifier 区分）；
 *   - 走 Node 内置 fetch（继承用户代理环境变量），与 dsh 更新检查互不影响。
 */
const SHELL_REPO = 'karoc/dsh-desktop'
const SHELL_UPDATE_TTL_MS = 6 * 60 * 60 * 1000
let shellUpdateCache = null // { at, payload }

async function checkShellUpdate({ force = false } = {}) {
  // 壳版本/身份由壳启动 manager 时经 --shell-version / --shell-identifier 传入
  // （dsh.json 只有 devMode/preinstalled/webview，不含这两项）。
  const identifier = args.shellIdentifier ?? null
  // dev 版不检查壳更新：dev 与正式版同版本号（同一份代码 --config 构建），
  // 检查出来会把正式版的版本号当作"可升级"，误导开发验证。
  if (identifier !== null && String(identifier).endsWith('.dev')) {
    emit({ t: 'shell-update', dev: true, current: args.shellVersion ?? null, latest: null, hasUpdate: false, url: null })
    log('shell update check skipped (dev build)')
    return
  }
  const now = Date.now()
  if (!force && shellUpdateCache !== null && now - shellUpdateCache.at < SHELL_UPDATE_TTL_MS) {
    emit({ t: 'shell-update', cached: true, ...shellUpdateCache.payload })
    return
  }
  const current = args.shellVersion ?? null
  const headers = { 'User-Agent': 'dsh-desktop-shell-update-check', Accept: 'application/vnd.github+json' }
  let release = null
  try {
    const res = await fetch(`https://api.github.com/repos/${SHELL_REPO}/releases/latest`, {
      headers, signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) release = await res.json()
    else if (res.status === 404) {
      // 只有预发布时 latest 为 404：退回列表取第一个非 draft 的 release。
      const list = await fetch(`https://api.github.com/repos/${SHELL_REPO}/releases?per_page=10`, {
        headers, signal: AbortSignal.timeout(10_000),
      })
      if (list.ok) {
        const arr = await list.json()
        release = Array.isArray(arr) ? arr.find((r) => r && r.draft !== true) ?? null : null
      }
    }
  } catch (err) {
    log(`shell update check failed: ${err.message}`)
    emit({ t: 'shell-update', current, latest: null, hasUpdate: false, url: null, error: String(err.message ?? err) })
    return
  }
  if (release === null) {
    emit({ t: 'shell-update', current, latest: null, hasUpdate: false, url: null, error: 'no release found' })
    return
  }
  const tag = String(release.tag_name ?? '').replace(/^v/, '')
  // 版本比较：semver 语义；低于或等于当前一律不提示（防降级/误标）。
  const hasUpdate = tag !== '' && current !== null && versionGt(tag, current)
  const payload = {
    current,
    latest: tag || null,
    hasUpdate,
    url: typeof release.html_url === 'string' ? release.html_url : null,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
  }
  shellUpdateCache = { at: now, payload }
  emit({ t: 'shell-update', ...payload })
  log(`shell update: current=${current ?? '?'} latest=${tag || '?'} hasUpdate=${hasUpdate}`)
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
    await resolveRemoteVersions()
    log(`npm latest ${PACKAGE}: ${latestVersion ?? 'unknown'}${nextVersion ? ` (${nextTag ?? '?'} ${nextVersion})` : ''}`)
  } catch (err) {
    latestVersion = null
    nextVersion = null
    log(`update check failed (offline?): ${err.message}`)
    return
  }
  const available = latestVersion !== null && versionGt(latestVersion, current)
  emitUpdateStatus(available)
  if (available) log(`update available: ${current ?? '(none)'} -> ${latestVersion} (user decides)`)
  else if (nextVersion && nextVersion !== latestVersion && current !== nextVersion && versionGt(nextVersion, current)) {
    log(`pre-release update available: ${current ?? '(none)'} -> ${nextVersion} (next tag, user decides)`)
  }
}

/**
 * Install the newest dsh into the runtime dir. Must run while dsh is STOPPED:
 * on Windows a live dsh locks the native modules (node-pty/koffi) npm has to
 * replace. The caller kills dsh first (see `updateDshAndRestart`).
 * @returns true when a new version was installed.
 */
/**
 * 迁移修复（幂等）：pnpm 在 node_modules/.modules.yaml 里记录 storeDir /
 * virtualStoreDir 的绝对路径；0.3.x→0.4.x 标识迁移整体 rename 了 runtime 目录，
 * 旧路径失配会让 pnpm 报 ERR_PNPM_UNEXPECTED_STORE——升级安装必然失败，而 UI
 * 只看 update-status（远端版本），用户会误以为"升级成功"，重启后仍是旧版。
 * 任何 pnpm 安装前调用：把两个字段重写为当前 runtime 的绝对路径。
 */
function ensureStorePathsMatch(runtimeDir) {
  const modulesYaml = join(runtimeDir, 'node_modules', '.modules.yaml')
  if (!existsSync(modulesYaml)) return
  let doc = null
  try {
    doc = JSON.parse(readFileSync(modulesYaml, 'utf8'))
  } catch {
    return
  }
  const norm = (p) => resolve(p).replaceAll('\\', '/')
  const actualStore = norm(join(runtimeDir, '.pnpm-store'))
  const actualVirtual = norm(join(runtimeDir, 'node_modules', '.pnpm'))
  let changed = false
  if (typeof doc.storeDir === 'string' && norm(doc.storeDir) !== actualStore) {
    // 保留末端版本段（v11 等），只替换根前缀
    const m = /(v\d+)\s*$/.exec(norm(doc.storeDir))
    doc.storeDir = join(runtimeDir, '.pnpm-store', m ? m[1] : 'v11')
    changed = true
  }
  if (typeof doc.virtualStoreDir === 'string' && norm(doc.virtualStoreDir) !== actualVirtual) {
    doc.virtualStoreDir = join(runtimeDir, 'node_modules', '.pnpm')
    changed = true
  }
  if (changed) {
    try {
      writeFileSync(modulesYaml, JSON.stringify(doc, null, 2))
      log('ensureStorePathsMatch: rewrote store dirs in .modules.yaml (legacy path after migration)')
    } catch (err) {
      log(`ensureStorePathsMatch: rewrite failed: ${err.message}`)
    }
  }
}

async function installDshUpdate({ force = false, version } = {}) {
  const current = installedVersion(args.runtimeDir)
  const fullyInstalled = dshInstalled(args.runtimeDir)
  // 升级前快照 web profile 的 bundle 启用状态（2026-09-07 实测故障：升级
  // 期间 profiles/web/package.json 缺失 → dsh web 启动时 initProfile 用模板
  // 重建 → 用户启用的预装插件（dsh-kanban 等）从 bundles 全部丢失。升级后
  // 必须校验并补回，不能升级了就丢升级前的状态）。
  const profileBundlesBefore = snapshotWebProfileBundles(args.runtimeDir)
  if (profileBundlesBefore !== null) {
    log(`profile bundles snapshot: ${profileBundlesBefore.join(', ')}`)
  }
  try {
    await resolveRemoteVersions()
  } catch (err) {
    throw new Error(`无法查询最新版本：${err.message}`)
  }
  // 目标版本：显式指定（壳菜单/托盘的「立即更新」可传具体版本）> max(npm latest, 地板)。
  // 地板保证装完一定有 dsh 自带插件管理（npm latest 目前仍是 0.1.5-rc.2）。
  const target = version ?? (latestVersion === null ? MIN_DSH_VERSION
    : (versionGt(MIN_DSH_VERSION, latestVersion) ? MIN_DSH_VERSION : latestVersion))
  // A half-extracted install (package.json written, lib/bin.js missing) must
  // be REPAIRED even when the recorded version already matches latest — npm
  // may consider the package current and skip re-extraction, leaving the
  // launcher stuck on "not installed". Remove it so npm re-extracts fresh.
  if (current !== null && !fullyInstalled) {
    rmSync(join(args.runtimeDir, 'node_modules', PACKAGE), { recursive: true, force: true })
    log(`dsh 安装不完整（缺启动入口），将重新安装`)
  }
  if (!force && current === target && dshInstalled(args.runtimeDir)) {
    log(`dsh 已是最新 ${target}`)
    return false
  }
  if (force) log(`强制重装 dsh ${current ?? '(none)'} -> ${target}（布局迁移/修复）`)
  log(`updating ${PACKAGE} ${current ?? '(none)'} -> ${target}`)
  // Progress feedback for the launcher: explicit phase events + a heartbeat
  // so the user can tell "still working" from "stuck" during a long install.
  emit({ t: 'install-status', phase: 'start', version: target })
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
  // Top-level node_modules entries preserved across the install: the
  // copied-only @dsh-desktop/* client plugins, plus one entry per preinstalled
  // bundle — DERIVED from the bundles, never a second hardcoded list. Deriving
  // matters for scoped packages: a bundle installs under its own package name
  // (@karoc/dsh-smoothly-opencode-session), so the entry to back up is the
  // scope dir `@karoc`, not anything spelled in a list here.
  const PROTECTED = ['@dsh-desktop', ...preinstalledTopLevelEntries(args.resourceDir)]
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
    // npm's dependency resolver HANGS on the @deepseek-ai monorepo-shaped tree
    // (hundreds of interdependent packages) — reproducible across npm 10/11,
    // Node 22/24, both registries, proxy or direct. dsh itself is developed
    // with pnpm, which installs the same package fine. So the dsh install runs
    // through the bundled pnpm (node-linker isolated, verified end-to-end:
    // launch + injected plugins + URL all work with the pnpm layout).
    ensurePnpmWorkspace(args.runtimeDir)
    await ensurePnpm(args.runtimeDir)
    // 迁移后 store 路径失配修复：必须在任何 pnpm install 前执行。
    ensureStorePathsMatch(args.runtimeDir)
    // Registry fallback chain: mirrors can lag on freshly-published deps, so
    // retry with the other default if the primary install fails.
    const fallback = REGISTRY === 'https://registry.npmjs.org/'
      ? 'https://registry.npmmirror.com'
      : 'https://registry.npmjs.org/'
    const pnpmStore = join(args.runtimeDir, '.pnpm-store')
    let lastErr = null
    for (const reg of [REGISTRY, fallback]) {
      try {
        // node-linker=hoisted: 让 runtime 的 node_modules 回到 npm 平铺兼容布局。
        // pnpm 默认 isolated 布局只把直接依赖符号链接到根，dsh 的内部包
        // （如 @deepseek-ai/dsh-tools）收在 .pnpm 里，导致复制到根目录的
        // 预装插件（dsh-kanban 等）import '@deepseek-ai/dsh-tools' 时
        // ERR_MODULE_NOT_FOUND → dsh web 启动崩溃 → 黑屏。hoisted 布局
        // 把所有包提升到根，插件恢复可解析（等价旧 npm 布局）。
        // 注意：pnpm 11.22 只在 CLI flag 上认 node-linker，放配置文件不生效。
        await pnpm(['install', `${PACKAGE}@${target}`, '--registry', reg, '--store-dir', pnpmStore, '--node-linker=hoisted'],
          { cwd: args.runtimeDir, stream: true, timeoutMs: 600_000 })
        log(`updated to ${target}`)
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        // 明说下一步：失败会自动切到另一个默认镜像重试，用户不用干等。
        log(`registry ${reg} 安装失败：${err.message} — 正在切换备用镜像 ${fallback} 重试`)
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
      version: target,
      error: installError ? installError.message : undefined,
    })
  }
  if (installError) throw new Error(`所有 registry 安装失败：${installError.message}`)
  // 升级完成校验：pnpm install / dsh web 重建 manifest 可能让用户升级前
  // 启用的 bundle（预装插件、自定义插件）从 profiles/web/package.json 丢失
  // （2026-09-07 dev 实测：manifest 缺失 → initProfile 模板重建 → 插件全丢）。
  // 用升级前快照补回，保证"升级不丢升级前状态"。自动安装/布局迁移也走这里。
  try {
    restoreProfileBundlesAfterUpdate(args.runtimeDir, profileBundlesBefore)
  } catch (err) {
    log(`profile bundles restore threw: ${err.message}`)
  }
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
    const allow = NATIVE_BUILD_PKGS.map((p) => `allow-scripts[]=${p}`).join('\n')
    writeFileSync(npmrcPath, allow + '\n')
  }
}

/**
 * pnpm 11.22 gates postinstall scripts behind pnpm-workspace.yaml `allowBuilds`
 * (npm's allow-scripts equivalent). Without this file the native deps
 * (koffi/node-pty/dsh-subprocess-local) would be skipped and dsh would fail to
 * load them at runtime. The runtime dir acts as a small pnpm workspace root,
 * so pnpm installs into <runtime>/node_modules with an isolated .pnpm store.
 */
function ensurePnpmWorkspace(runtimeDir) {
  const wsPath = join(runtimeDir, 'pnpm-workspace.yaml')
  if (existsSync(wsPath)) return
  const lines = ['allowBuilds:']
  for (const p of NATIVE_BUILD_PKGS) lines.push(`  ${JSON.stringify(p)}: true`)
  writeFileSync(wsPath, lines.join('\n') + '\n')
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

/** Web profile manifest 路径（dsh-home/profiles/web/package.json）。 */
function webProfileManifestPath(runtimeDir) {
  return join(runtimeDir, 'dsh-home', 'profiles', 'web', 'package.json')
}

/**
 * 读 web profile 的 bundles（dsh.profile.bundles）。manifest 缺失/损坏返回
 * null（与"空列表"区分：null = 快照不可用，调用方跳过校验恢复）。
 */
function snapshotWebProfileBundles(runtimeDir) {
  const p = webProfileManifestPath(runtimeDir)
  if (!existsSync(p)) return null
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'))
    const bundles = doc?.dsh?.profile?.bundles
    return Array.isArray(bundles) ? bundles : null
  } catch {
    return null
  }
}

/**
 * 升级后校验恢复：pnpm install / dsh web 重建 manifest 时，如果用户升级前
 * 启用的 bundle（预装插件 dsh-kanban 等，以及自定义插件）从 bundles 丢失，
 * 补回并写回（保留 manifest 其它字段）。2026-09-07 dev 实测：升级期间
 * profiles/web/package.json 缺失 → initProfile 用模板重建 → 预装插件全丢；
 * 本函数让"升级前已启用"的插件在升级后依然启用。
 *
 * 只恢复"升级前快照里有、升级后没有"的条目——不触碰模板自带 bundle
 * （@deepseek-ai/*）与升级后新增的条目，避免覆盖升级意图。
 */
function restoreProfileBundlesAfterUpdate(runtimeDir, before) {
  if (before === null) return false
  const p = webProfileManifestPath(runtimeDir)
  let afterDoc = null
  let after = []
  if (existsSync(p)) {
    try {
      afterDoc = JSON.parse(readFileSync(p, 'utf8'))
      const b = afterDoc?.dsh?.profile?.bundles
      after = Array.isArray(b) ? b : []
    } catch {
      afterDoc = null // 损坏：整体重建
    }
  }
  const missing = before.filter((name) => !after.includes(name))
  if (missing.length === 0) return false
  // 写回：保留现有 doc 的其它字段（dependencies / patchReload / name 等），
  // 只补 bundles。manifest 缺失/损坏时从快照重建完整 doc。
  const doc = afterDoc ?? { name: 'dsh-profile-web', private: true, dependencies: {} }
  doc.dsh = doc.dsh ?? {}
  doc.dsh.profile = doc.dsh.profile ?? {}
  doc.dsh.profile.bundles = [...after, ...missing]
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(doc, null, 2) + '\n')
    log(`profile bundles restored after update: ${missing.join(', ')}`)
    return true
  } catch (err) {
    log(`profile bundles restore FAILED: ${err.message}`)
    return false
  }
}

/**
 * Top-level node_modules entries under which the preinstalled bundles install.
 * A bundle lands at `<runtime>/node_modules/<package.json name>`, so a scoped
 * package contributes its scope dir (`@karoc`) and an unscoped one its own
 * name. Used to build the install-survival PROTECTED list — deriving it keeps
 * that list from drifting when a bundle is added or renamed.
 */
function preinstalledTopLevelEntries(resourceDir) {
  const srcRoot = resolve(resourceDir, 'preinstalled')
  if (!existsSync(srcRoot)) return []
  const entries = []
  for (const dir of readdirSync(srcRoot)) {
    const pkgJson = join(srcRoot, dir, 'package.json')
    if (!existsSync(pkgJson)) continue
    try {
      const name = JSON.parse(readFileSync(pkgJson, 'utf8')).name
      if (typeof name === 'string' && name) entries.push(name.startsWith('@') ? name.split('/')[0] : name)
    } catch {
      // Malformed bundle manifest: ensurePreinstalled skips it too.
    }
  }
  return entries
}

function ensurePreinstalled(runtimeDir, resourceDir) {
  const srcRoot = resolve(resourceDir, 'preinstalled')
  if (!existsSync(srcRoot)) {
    log('no preinstalled bundles in resources')
    return
  }
  const manifest = readShellManifest(runtimeDir)
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
    const updating = existsSync(dest) && !sameTree(src, dest)
    if (!existsSync(dest) || updating) {
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(src, dest, { recursive: true })
      log(updating ? `updated preinstalled ${pkgName}` : `installed preinstalled ${pkgName}`)
    }
  }
  if (names.length === 0) return
  // Preserve other shell fields (devMode) while recording the list.
  manifest.preinstalled = names
  writeShellManifest(runtimeDir, manifest)
  log(`preinstalled bundles: ${names.join(', ')}`)
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
// 0.1.2-rc.1 起 dsh web URL 带 token（?token=...）：URL 快照必须保留尾部，
// 否则 watchdog / 壳导航拿到的是无 token 地址（401），被误判为服务不响应。
const URL_RE = /(https?:\/\/127\.0\.0\.1:\d+[^\s]*)/

let currentChild = null
let currentChildPid = null
let currentUrl = null // 最近一次 dsh web URL（含 token），report-url 重发用
let restartRequested = false
let pendingTask = null

// ── liveness watchdog ──────────────────────────────────────────────────────
// dsh web can EVENT-LOOP HANG (black page, refresh dead) without exiting, so
// the supervisor's normal child-exit path never fires. Poll the reported URL:
// after WATCHDOG_MISS_LIMIT silent misses the child gets a best-effort memory
// dump and is killed + re-spawned (same recovery as the tray's 重启服务), so
// the next hang recovers by itself AND leaves a dump for diagnosis. Evidence
// lands in <runtime>/reports (same dir as node --report crash reports).
let watchdogUrl = null
let watchdogArmed = false
let watchdogArmedAt = 0
let watchdogMisses = 0
let watchdogTimer = null
let watchdogRecovering = false
const WATCHDOG_MS = 3000
const WATCHDOG_MISS_LIMIT = 3
// 启动/重载宽限：URL 刚出现时 dsh web 可能仍在加载插件/建索引，慢响应不算
// 挂起（2026-09-05 重启风暴的同类误判）。
const WATCHDOG_STARTUP_GRACE_MS = 30000
// 触发后先请壳抓现场，最多等这么久再重启（壳不在时按上限继续）。
const WATCHDOG_DUMP_WAIT_MS = 30000

let dumpDoneResolve = null
let dumpDoneAt = 0
function waitDumpDone(ms) {
  // 壳可能已经抓完并回过 dump-done（壳内 watchdog 与 manager 的相位不同），
  // 最近一次回执直接算数，不必再等满上限。
  if (Date.now() - dumpDoneAt < 60000) return Promise.resolve(true)
  return new Promise((resolve) => {
    dumpDoneResolve = resolve
    setTimeout(() => {
      if (dumpDoneResolve === resolve) { dumpDoneResolve = null; resolve(false) }
    }, ms)
  })
}

function watchdogStart() {
  if (watchdogTimer) return
  watchdogTimer = setInterval(() => { void watchdogTick() }, WATCHDOG_MS)
  watchdogTimer.unref?.()
}
async function watchdogTick() {
  if (!watchdogUrl || !watchdogArmed || watchdogRecovering) return
  let ok = false
  try {
    const res = await fetch(watchdogUrl, { signal: AbortSignal.timeout(1500) })
    // 存活判定：任何 HTTP 状态（含 401/404 等鉴权/路由响应）都说明服务在
    // 听并应答——只有连接失败/超时才算 miss。
    ok = res.status >= 200 && res.status < 500
  } catch { /* unresponsive */ }
  if (ok) { watchdogMisses = 0; return }
  if (Date.now() - watchdogArmedAt < WATCHDOG_STARTUP_GRACE_MS) return
  watchdogMisses += 1
  log(`watchdog: dsh web miss ${watchdogMisses}/${WATCHDOG_MISS_LIMIT} (${watchdogUrl})`)
  if (watchdogMisses >= WATCHDOG_MISS_LIMIT) {
    const stuckUrl = watchdogUrl
    watchdogRecovering = true
    watchdogArmed = false
    watchdogUrl = null
    watchdogMisses = 0
    // 现场由壳负责：壳用 MiniDumpWriteDump 直接抓（旧的 rundll32 comsvcs 路径
    // 在本机 20s 超时且零产出，既没证据又把一次挂起拖成重启风暴，已移除）。
    // 这里发一条 dump-web 协议行，等壳回 dump-done 再重启；壳不在则按上限继续。
    log('watchdog: dsh web UNRESPONSIVE — asking the shell for a dump before restarting')
    emit({ t: 'dump-web', pid: currentChildPid ?? 0, url: stuckUrl })
    const dumped = await waitDumpDone(WATCHDOG_DUMP_WAIT_MS)
    log(`watchdog: dump ${dumped ? 'ready' : 'not confirmed (shell unavailable?)'} — restarting dsh`)
    if (currentChildPid) { restartRequested = true; killTree(currentChildPid) }
    watchdogRecovering = false
  }
}

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
  const entry = dshEntry(runtimeDir)
  if (!existsSync(entry)) throw new Error(`${PACKAGE} not installed at ${entry}`)
  // dsh CLI regression（0.1.2-rc.1 起）：--patch 参数如果含空格（安装目录
  // "DSH Smoothly Desktop"），overlay 以空白切分导致路径截断、启动失败
  // （0.1.1-rc.2 正常）。兼容处理：把 patch 复制到无空格路径
  // <runtime>/dsh-desktop.patch.yml 再传参——新旧版本均适用，幂等。
  const SPACE_FREE_PATCH = 'dsh-desktop.patch.yml'
  let patchArg = patchPath
  if (/[\s]/.test(patchPath)) {
    const mirror = join(runtimeDir, SPACE_FREE_PATCH)
    try {
      cpSync(patchPath, mirror, { force: true })
      patchArg = mirror
      log(`patch overlay 路径含空格（dsh ${installedVersion(runtimeDir) ?? '?'} CLI 截断 regression）→ 改用无空格镜像 ${mirror}`)
    } catch (err) {
      log(`patch 无空格镜像失败（fallback 原路径）: ${err.message}`)
    }
  }
  // Desktop-owned DSH_HOME (default <runtime>/dsh-home): keeps data
  // self-contained and — crucially — makes the profile's module resolver walk
  // up to <runtime>/node_modules so the injected plugin package resolves.
  // Ambient $DSH_HOME is deliberately NOT inherited, so the desktop app never
  // writes into the browser version's ~/.dsh. Pass --home to override.
  // `--no-open`: dsh web would otherwise open the system default browser;
  // the shell has its own webview that navigates to the reported URL.
  const dshHome = args.home ?? join(runtimeDir, 'dsh-home')
  // `--patch` must come BEFORE any web-app flag: dsh's launcher consumes its
  // own options until the first token it does not recognize, then passes
  // everything after it to the booted app verbatim. `--no-open` is a web-app
  // flag, so it must trail `--patch` or the patch overlay would be handed to
  // the web app ("unknown option '--patch'").
  // dsh web 子进程的 NODE_OPTIONS（唯一注入点；manager 自身保持干净）：
  //  - --max-http-header-size=65536：Node 默认 16384B 且**请求行也计入**，
  //    而 dsh 的鉴权 cookie 名绑定端口、壳每轮新端口 → Cookie 头单调增长；
  //    页面上唯一 >1KB 的 URL（客户端插件批 bundle ≈2.85KB）会第一个被
  //    `431 Request Header Fields Too Large` 打掉 → 全部客户端插件
  //    import failed →「Failed to load plugins」。壳侧已在导航前清理陈旧
  //    cookie（src-tauri/src/lib.rs prune_stale_auth_cookies），此处把硬悬崖
  //    抬到 64KB 作纵深防御。顺序语义：追加在用户值之后（Node 取最后一个
  //    同名 flag），最终值写入 manager.log 便于取证与回滚。
  //  - --report-*：崩溃现场（OOM/fatal/uncaught）落到 <runtime>/reports。
  const childNodeOptions = [
    process.env.NODE_OPTIONS ?? '',
    '--max-http-header-size=65536',
    `--report-on-fatalerror --report-uncaught-exception --report-compact --report-dir=${join(runtimeDir, 'reports').replaceAll('\\', '/')}`,
  ].filter(Boolean).join(' ')
  log(`dsh web NODE_OPTIONS: ${childNodeOptions}`)
  const child = spawn(process.execPath, [entry, 'web', '--patch', patchArg, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Node crash reports (OOM / fatal / uncaught exception) land in
    // <runtime>/reports so a hard death of dsh web is diagnosable even without
    // WER. Only the dsh web child gets NODE_OPTIONS; the manager itself stays
    // clean.
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      NODE_OPTIONS: childNodeOptions,
      // dsh 0.1.6 起插件管理在 dsh 内部（Web 侧边栏 Plugins 页），它按 PATH 找
      // pnpm（launcher facts 的 packageManager 只能由进程内调用方注入，CLI 路径
      // 拿不到）→ 必须挂上壳内置的 pnpm shim，否则插件页装不了插件。
      PATH: `${pnpmShimDir(runtimeDir)}${delimiter()}${process.env.PATH ?? ''}`,
    },
    windowsHide: true,
  })
  mkdirSync(join(runtimeDir, 'reports'), { recursive: true })
  child.stdout.on('data', (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (!line) continue
      const m = line.match(URL_RE)
      if (m) {
        emit({ t: 'url', url: m[1] })
        // 记录最新 URL，供 report-url 重发（壳首启丢事件时主动索要）。
        currentUrl = m[1]
        // Watchdog: re-arm on every announced URL (a new URL = a respawn).
        watchdogUrl = m[1]
        watchdogMisses = 0
        watchdogArmed = true
        watchdogArmedAt = Date.now()
        watchdogStart()
      }
      log(line)
    }
  })
  child.stderr.on('data', (buf) => {
    for (const line of String(buf).split(/\r?\n/)) if (line) log(line)
  })
  currentChild = child
  currentChildPid = child.pid
  const code = await new Promise((resolvePromise) => child.on('exit', (c, s) => resolvePromise(c ?? (s === 'SIGKILL' ? 137 : 1))))
  if (currentChild === child) currentChild = undefined
  // Child gone: disarm the watchdog until a fresh URL is announced.
  watchdogUrl = null
  watchdogArmed = false
  watchdogMisses = 0
  currentChildPid = null
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
async function updateDshAndRestart(version) {
  log(`update requested by user${version ? ` -> ${version}` : ''}`)
  // Stop dsh first: a live dsh locks native modules npm must replace.
  requestRestart()
  const task = (async () => {
    try {
      const updated = await installDshUpdate({ version })
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
      // 如实回报 UI：op-status error 让「检查更新」弹窗显示失败原因，
      // 而不是让用户看着 update-status 的"可升级"误以为成功。
      emitOpStatus({ op: 'update-dsh', done: true, ok: false, error: err.message })
      emitUpdateStatus(false)
    }
  })()
  setPendingTask(task)
  await task
}

function handleCommand(cmd) {
  switch (cmd?.cmd) {
    case 'check-update': void checkDshUpdate({ frozen: shellManifest.devMode === true }); break
    case 'check-shell-update': void checkShellUpdate(); break
    case 'update-dsh': void updateDshAndRestart(cmd?.version); break
    case 'restart-dsh': log('restart-dsh requested'); requestRestart(); break
    case 'report-url':
      // 壳启动早期可能丢首个 URL 事件（stdout reader 未就绪）→ 黑屏。
      // 壳主动索要：重发当前 dsh web 地址（带 token），让导航兜底能工作。
      if (currentUrl) { emit({ t: 'url', url: currentUrl }); log('report-url: re-emitted current url') }
      else { log('report-url: no current url yet') }
      break
    case 'dump-done':
      // 壳已抓完挂起现场（或该 URL 早已抓过）：立刻允许 watchdog 重启 dsh。
      dumpDoneAt = Date.now()
      if (dumpDoneResolve) { const resolve = dumpDoneResolve; dumpDoneResolve = null; resolve(true) }
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
        // 固定 pnpm 版本（11.24.0 在 node 24 全链路验证过；pnpm 12.x 在
        // node 24.18 上 cjs loader 启动崩溃——2026-09-06 smoke 踩到，且
        // 不固定会导致用户机器升级/装插件时被上游新版本带崩）。
        await npm(['install', 'pnpm@11.24.0', '--prefix', tmp, '--no-audit', '--no-fund', '--no-progress', '--loglevel=http', '--registry', reg], { stream: true, timeoutMs: 600_000 })
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

// Active manager op, mirrored to the shell via {t:'op-status'} (the shell's
// check-update dialog renders progress and the failure reason).
let activeOp = null

function emitOpStatus(status) {
  activeOp = status
  emit({ t: 'op-status', ...status })
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
  // Auto-install dsh when missing OR broken (fresh install, the runtime copy
  // was removed, or a killed install left package.json without lib/bin.js) —
  // without this the launcher hangs on "dsh 服务已退出" forever.
  if (!dshInstalled(args.runtimeDir)) {
    try {
      log('dsh missing or broken — installing automatically')
      await installDshUpdate()
    } catch (err) {
      log(`auto-install dsh failed: ${err.message}`)
    }
  }
  // 0.3.4 migration: 0.3.3 的 pnpm isolated 布局会让预装插件/host bundle 解析
  // dsh 内部包失败（黑屏）。检测到该布局就删掉 node_modules 并全新安装为
  // hoisted（warm store 下 ~6s；原地 re-link 反而慢且可能留半转换状态）。
  if (dshInstalled(args.runtimeDir) && isIsolatedPnpmLayout(args.runtimeDir)) {
    try {
      log('检测到 pnpm isolated 布局（0.3.3）— 重建为 hoisted 布局以修复插件加载')
      rmSync(join(args.runtimeDir, 'node_modules'), { recursive: true, force: true })
      await installDshUpdate()
    } catch (err) {
      log(`isolated→hoisted 布局迁移失败：${err.message}`)
    }
  }
  // 兼容闸门：壳依赖 dsh 0.1.6-alpha.2 起的自带插件管理（壳内自建管理已移除）。
  // 已装版本低于地板时先升到地板（npm latest 仍是 0.1.5-rc.2，全新安装/老用户
  // 都可能落在没有插件管理的版本上）。失败不阻塞启动——用户仍可用壳菜单的
  // 「停用全部第三方插件…」自救。devMode（dsh.json）是"别动我的 dsh"的显式
  // 开关，与更新检查同语义：冻结时只告警，不擅自升级。
  if (dshInstalled(args.runtimeDir)) {
    const gateCurrent = installedVersion(args.runtimeDir)
    if (gateCurrent !== null && versionGt(MIN_DSH_VERSION, gateCurrent)) {
      if (shellManifest.devMode === true) {
        log(`dsh ${gateCurrent} 低于最低要求 ${MIN_DSH_VERSION}，但 devMode 冻结了 dsh 升级 — 保持原样（插件管理不可用）`)
      } else {
        log(`dsh ${gateCurrent} 低于最低要求 ${MIN_DSH_VERSION}（该版本没有插件管理）— 升级到地板版本`)
        try {
          await installDshUpdate({ version: MIN_DSH_VERSION })
        } catch (err) {
          log(`兼容闸门升级失败（继续启动，插件管理不可用）: ${err.message}`)
        }
      }
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
