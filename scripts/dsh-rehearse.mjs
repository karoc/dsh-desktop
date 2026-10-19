#!/usr/bin/env node
// dsh:rehearse —— 把「装候选版本」这一步固化成**一条可重复执行的命令**（上游发版日全流程干跑，P1）。
//
//   node scripts/dsh-rehearse.mjs [--version <v>] [--keep] [--json <out>] [--timeout <sec>]
//                                 [--warm-store <dir>] [--registry <url>] [--help]
//
// 它做什么：建一个**空**临时 runtime（只把真实 dev runtime 的 `.pnpm-store` 与
// `node_modules/pnpm` 软链进去 = "热 store"），用生产同款参数启动随包的
// `scripts/server-manager.mjs`，**让它走自己的启动期自动安装路径**
//（main()：`if (!dshInstalled(...)) { log('dsh missing or broken — installing automatically'); await installDshUpdate() }`），
// 然后断言临时 runtime 里落地的 dsh 版本、对它跑 `scripts/dsh-compat-probe.mjs`、
// 打印每步耗时表，最后清理临时目录。**只读真实 runtime**：一切写操作都在临时目录内。
//
// 为什么不在本脚本里自己跑 pnpm/npm：那样演练的就不是产品路径了。发版日真正会跑的是
// manager 的安装链路（pnpm hoisted + registry 降级链 + 预装插件保护 + profile bundles 补回），
// 演练必须命中同一段代码。
//
// ── 与 2026-10-19 手工配方（.tmp-investigate/rehearsal-install.sh）的三处差异，都是有意为之 ──
//  1) **装完立刻杀**：手工配方让 manager 一路跑到 `supervise()`，真的在临时 runtime 里起了
//     一个带 token 的 dsh web（旧日志实录 `{"t":"url","url":"http://127.0.0.1:34643/?token=…"}`），
//     一直到 `timeout 300` 才被砍。本脚本在 `install-status done` 后 2s（或更早，见
//     `launching dsh web` 逃逸线）按**进程组**终止 manager —— 演练不该顺手起服务。
//  2) **不注入 `npm_config_offline`**：手工配方设了它，但旧日志里 pnpm 照样 `downloaded 36`
//     （并不是离线），线上壳也不会设它。默认按生产语义联网，环境里已有 `npm_config_offline`
//     原样继承（要复刻手工配方就在调用前 export 它）。
//  3) 失败保留现场：任何一步失败都**不清临时目录**（并打印路径），成功的默认清掉。
//
// ── `--version` 的语义（重要，别误读）──
// 启动期自动安装路径**结构上不接受外部指定版本**：`installDshUpdate()` 的目标版本是
// `max(MIN_DSH_VERSION, registry latest)`（见 manager 的 installDshUpdate）。所以 `--version`
// 是"**我期望落地的版本**"（默认 = 壳地板 `MIN_DSH_VERSION`），不是"让 manager 装这个版本"的开关。
// 落地版本 != 期望版本 ⇒ 如实报 `MISMATCH` 并以退出码 1 结束，**绝不强行判绿**。
// 想演练比地板新的版本：把 `--registry` 指向 latest 更高的镜像（或等上游把 latest 挪上去），
// 然后用 `--version <那个版本>` 表达期望。
//
// 退出码：0 = 全绿；1 = 演练失败（安装/版本/探针/自证任一步不达标）；2 = 用法错误；
//         3 = 前置不满足（热 runtime 不存在或缺 `.pnpm-store` / 随包 pnpm）。

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANAGER = join(ROOT, 'scripts/server-manager.mjs')
const PROBE = join(ROOT, 'scripts/dsh-compat-probe.mjs')
const RESOURCE_DIR = join(ROOT, 'src-tauri/resources')
const PATCH_FILE = join(RESOURCE_DIR, 'patch/dsh-desktop.patch.yml')
const DSH_PKG = '@deepseek-ai/dsh'
/** 真实（热）runtime 默认路径：dev 壳的数据目录。可用 --warm-store 覆盖。 */
const DEFAULT_WARM_RUNTIME = '/mnt/c/Users/qqwto/AppData/Roaming/dsh.smoothly.desktop.dev/runtime'
/** install-status done 之后额外等这么久，让收尾（profile bundles 补回 / 升级标记）走完；
 *  期间一旦看到 `launching dsh web` 立即终止（逃逸线，绝不让 supervise 起服务）。 */
const POST_INSTALL_GRACE_MS = 2000
const KILL_GRACE_MS = 4000

const USAGE = `usage: node scripts/dsh-rehearse.mjs [--version <v>] [--keep] [--json <out>] [--timeout <sec>]
                                      [--warm-store <dir>] [--registry <url>]

  --version <v>      期望落地的 dsh 版本（默认 = 壳地板 MIN_DSH_VERSION）。不等于"指定安装版本"：
                     启动期路径的目标 = max(壳地板, registry latest)，不一致时如实报 MISMATCH。
  --keep             保留临时 runtime（默认成功即清理；失败一律保留现场）
  --json <out>       结构化结果写入 <out>
  --timeout <sec>    安装段超时（默认 300）
  --warm-store <dir> 热 runtime 目录（内含 .pnpm-store 与 node_modules/pnpm），也可直接给
                     .pnpm-store 目录本身。默认 ${DEFAULT_WARM_RUNTIME}
  --registry <url>   透传给 manager 的 --registry（默认取 DSH_DESKTOP_REGISTRY，再退官方源）
  --help             本帮助
`

// ── 参数 ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { version: null, keep: false, json: null, timeoutSec: 300, warmStore: null, registry: null, help: false }
  const val = (i, name) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} 需要值`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const eq = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : null
    const inline = eq ? a.slice(eq.length + 1) : null
    const take = () => (inline !== null ? inline : val(i++, a))
    if (a === '--keep') out.keep = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--version' || eq === '--version') out.version = take()
    else if (a === '--json' || eq === '--json') out.json = resolve(take())
    else if (a === '--timeout' || eq === '--timeout') out.timeoutSec = Number(take())
    else if (a === '--warm-store' || eq === '--warm-store') out.warmStore = take()
    else if (a === '--registry' || eq === '--registry') out.registry = take()
    else throw new Error(`未知参数 ${a}`)
  }
  if (!Number.isFinite(out.timeoutSec) || out.timeoutSec <= 0) throw new Error('--timeout 必须是正数（秒）')
  return out
}

let opts
try {
  opts = parseArgs(process.argv.slice(2))
} catch (err) {
  console.error(`dsh-rehearse: ${err.message}\n\n${USAGE}`)
  process.exit(2)
}
if (opts.help) {
  process.stdout.write(USAGE)
  process.exit(0)
}

// ── 小工具 ─────────────────────────────────────────────────────────────────
const steps = []
/** 本配方**结构上**覆盖不到的地方 —— 每次运行都打印，读"GREEN"的人必须同时看到这些边界。 */
const gaps = [
  '只演练「全新安装」分支（空 runtime ⇒ dshInstalled()=false）：已有 dsh 的**升级覆盖**分支、' +
  'isolated→hoisted 布局迁移分支、兼容闸门（已装版本 < 地板）分支都没走到。',
  '只演练到 install-status done + 探针（结构/兼容性判据）：**没有验证装完之后 dsh web 能否真起来**' +
  '（本脚本刻意在 launching dsh web 处终止）。这一步仍靠真机验收。',
  '安装目标版本不可注入：启动期路径的目标 = max(壳地板, registry latest)，--version 只能表达期望值。',
]
const t0 = Date.now()
const now = () => Date.now()
const fmtS = (ms) => `${(ms / 1000).toFixed(1)}s`
function step(name, status, ms, detail = '') {
  steps.push({ name, status, ms, detail })
  const mark = { ok: 'ok', skip: 'skip', fail: 'FAIL' }[status] ?? status
  console.log(`  [${String(steps.length).padStart(2)}] ${name.padEnd(22)} ${mark.padEnd(5)} ${fmtS(ms).padStart(7)}  ${detail}`)
}
function sha256(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}
/** 真实 runtime 的"未被改动"指纹：内容哈希 + mtime + size 三件套。 */
function fingerprint(file) {
  try {
    const st = statSync(file)
    return { path: file, exists: true, sha256: sha256(file), mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return { path: file, exists: false }
  }
}
function listProcsMatching(needle) {
  if (process.platform !== 'linux') return null // 非 Linux 不做进程枚举（报告里注明）
  const hits = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === process.pid) continue
    try {
      const cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').join(' ').trim()
      if (cmd.includes(needle)) hits.push({ pid, cmd: cmd.slice(0, 220) })
    } catch { /* 进程刚消失 / 无权限 —— 都不是残留证据 */ }
  }
  return hits
}
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// ── 前置：读壳地板 + 解析热 runtime + 快照（只读） ─────────────────────────
console.log('dsh:rehearse —— 在临时 runtime 里演练「装候选版本」（真实 runtime 只读）')
const managerSrc = readFileSync(MANAGER, 'utf8')
const floor = /MIN_DSH_VERSION\s*=\s*'([^']+)'/.exec(managerSrc)?.[1] ?? null
if (!floor) {
  console.error('dsh-rehearse: 无法从 scripts/server-manager.mjs 读到 MIN_DSH_VERSION（壳地板）')
  process.exit(3)
}
const targetVersion = opts.version ?? floor

const warmArg = opts.warmStore ?? DEFAULT_WARM_RUNTIME
const warmSource = opts.warmStore ? '--warm-store' : '默认'
// 允许两种给法：runtime 根目录，或 `.pnpm-store` 目录本身。
let warmRuntime = resolve(warmArg)
if (basename(warmRuntime) === '.pnpm-store') warmRuntime = dirname(warmRuntime)
const warmStore = join(warmRuntime, '.pnpm-store')
const warmPnpm = join(warmRuntime, 'node_modules/pnpm/bin/pnpm.cjs')

function preflightFail(msg) {
  console.error(`\ndsh-rehearse: ${msg}\n\n${USAGE}`)
  const result = {
    tool: 'dsh-rehearse', ok: false, phase: 'preflight', error: msg,
    warmRuntime, floor, targetVersion, startedAt: new Date(t0).toISOString(), steps,
  }
  if (opts.json) writeJson(opts.json, result)
  process.exit(3)
}
if (!existsSync(warmRuntime)) {
  preflightFail(`热 runtime 不存在：${warmRuntime}\n  用 --warm-store <dir> 指向本机真实的 dsh runtime（默认路径是 dev 壳数据目录）。`)
}
if (!existsSync(warmStore)) preflightFail(`热 runtime 里没有 .pnpm-store：${warmStore}（没有它就不是"热 store"，装一次要几分钟）`)
if (!existsSync(warmPnpm)) preflightFail(`热 runtime 里没有随包 pnpm：${warmPnpm}`)
for (const f of [MANAGER, PROBE, PATCH_FILE, join(RESOURCE_DIR, 'plugin/@dsh-desktop')]) {
  if (!existsSync(f)) preflightFail(`仓库资源缺失：${f}`)
}

// 真实 runtime 的对照指纹：跑前跑后各取一次，用来自证"没被改过"。
const warmProbeFiles = [
  join(warmRuntime, `node_modules/${DSH_PKG}/package.json`),
  join(warmRuntime, `node_modules/${DSH_PKG}/lib/bin.js`),
  join(warmRuntime, 'package.json'),
  join(warmRuntime, 'manager.log'),
]
const warmBefore = warmProbeFiles.map(fingerprint)

const registry = opts.registry ?? process.env.DSH_DESKTOP_REGISTRY ?? 'https://registry.npmjs.org/'
const registrySource = opts.registry ? '--registry' : (process.env.DSH_DESKTOP_REGISTRY ? 'DSH_DESKTOP_REGISTRY' : '默认（官方源）')
const offline = process.env.npm_config_offline ?? process.env.NPM_CONFIG_OFFLINE ?? null

console.log(`  仓库         ${ROOT}`)
console.log(`  期望版本     ${targetVersion}${opts.version ? '（--version）' : `（壳地板 MIN_DSH_VERSION）`}`)
console.log(`  热 runtime   ${warmRuntime}（${warmSource}；只读，仅软链 .pnpm-store + node_modules/pnpm）`)
console.log(`  registry     ${registry}（${registrySource}；manager 内部还会降级到备用镜像）`)
console.log(`  npm offline  ${offline ?? '(未设置)'}   timeout ${opts.timeoutSec}s`)
console.log('')

// ── 建临时 runtime ─────────────────────────────────────────────────────────
let tmp = null
let installMs = 0
let probeMs = 0
let cleanupMs = 0
let managerInfo = null
let installedVersion = null
let dshEntryOk = null
let registryLatest = null
let probeInfo = { verdict: null, exitCode: null, counts: null, blocking: [], stdoutTail: [] }
let tmpKept = false
let killInfo = { stopReason: null, exit: null, dshWebStarted: false }

const preflightMs = now() - t0
step('preflight', 'ok', preflightMs, `地板 ${floor}；真实 runtime 指纹 ${warmBefore.filter((f) => f.exists).length}/${warmProbeFiles.length} 已记录`)

tmp = mkdtempSync(join(tmpdir(), 'dsh-rehearse-'))
{
  const s = now()
  mkdirSync(join(tmp, 'node_modules'), { recursive: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(warmStore, join(tmp, '.pnpm-store'), linkType)
  symlinkSync(join(warmRuntime, 'node_modules/pnpm'), join(tmp, 'node_modules/pnpm'), linkType)
  step('temp-runtime', 'ok', now() - s, `${tmp}（空目录 + 2 条软链）`)
}
console.log(`      临时 runtime ${tmp}`)

// ── 启动 manager，走它自己的启动期自动安装路径 ─────────────────────────────
const managerArgv = [
  MANAGER,
  '--runtime-dir', tmp,
  '--resource-dir', RESOURCE_DIR,
  '--patch', PATCH_FILE,
  '--cwd', tmp, // 生产传的是用户 home；这里指向临时目录，保证任何子进程都不落在仓库/家目录
]
if (opts.registry) managerArgv.push('--registry', opts.registry)
const managerCmdLine = `${process.execPath} ${managerArgv.join(' ')}`
const stdoutLog = join(tmp, 'manager-stdout.jsonl')
const stderrLog = join(tmp, 'manager-stderr.txt')
// 先把两个日志文件建出来：stderr 常常一个字都没有，"保留现场"时也要能看到"空"这个事实，
// 而不是让读报告的人猜这个文件为什么不存在。
writeFileSync(stdoutLog, '')
writeFileSync(stderrLog, '')

/** 让脚本自己被杀时也别留下演练进程树（进程组成员与我们在同一组 ⇒ 连坐，用组杀）。 */
let liveChild = null
function killGroup(sig) {
  if (!liveChild || liveChild.exitCode !== null || liveChild.signalCode !== null) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(liveChild.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-liveChild.pid, sig)
  } catch { /* 已经死了 */ }
}
const selfCleanup = () => { killGroup('SIGKILL') }
process.on('exit', selfCleanup)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { killGroup('SIGKILL'); process.exit(1) })
}

const CURATED = /installing automatically|updating @deepseek-ai\/dsh|updated to |installed @deepseek-ai\/dsh|pnpm installed|installing bundled pnpm|launching dsh web|auto-install dsh failed|fatal|安装失败|Done in|npm latest/
const stdoutTail = []
const stderrTail = []
console.log(`      启动 ${managerCmdLine.replace(ROOT, '.')}`)
// 注意：这里**不能**写 `installMs = await new Promise(...)` —— executor 没有返回值，
// await 的结果是 undefined，会把 finish() 里算好的耗时冲掉（首轮实测打印出 NaNs）。
await new Promise((resolvePromise) => {
  const startedAt = now()
  const child = spawn(process.execPath, managerArgv, {
    cwd: tmp,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // 自成进程组：这样一次 `kill(-pid)` 能带走 manager + pnpm + 万一已经起来的 dsh web。
    detached: process.platform !== 'win32',
  })
  liveChild = child
  let settled = false
  let sawInstallDone = false
  let doneAt = null
  let graceTimer = null
  let lastBeat = 0
  const finish = (reason) => {
    if (settled) return
    settled = true
    killInfo.stopReason = reason
    killInfo.installDoneSeen = sawInstallDone
    clearTimeout(graceTimer)
    clearTimeout(hardTimer)
    installMs = now() - startedAt
    const ok = reason.startsWith('install-status done') || reason === 'launching dsh web'
    const detail = reason === 'launching dsh web'
      ? `install-status done 后 manager 继续走到 supervise —— 在 launching dsh web 处按进程组终止（不让它起服务）`
      : `${reason}；manager pid=${child.pid} 按进程组终止`
    step('install', ok ? 'ok' : 'fail', installMs, detail)
    resolvePromise()
  }
  const hardTimer = setTimeout(() => {
    console.log(`      ⏱ 超时 ${opts.timeoutSec}s —— 终止进程组，如实报失败`)
    killGroup('SIGKILL')
    if (settled) return
    settled = true
    killInfo.stopReason = `timeout ${opts.timeoutSec}s`
    installMs = now() - startedAt
    step('install', 'fail', installMs, `超时 ${opts.timeoutSec}s`)
    resolvePromise()
  }, opts.timeoutSec * 1000)

  const handleLog = (line) => {
    stdoutTail.push(line)
    if (stdoutTail.length > 400) stdoutTail.shift()
    if (CURATED.test(line)) console.log(`      +${fmtS(now() - startedAt)} ${line.slice(0, 200)}`)
    const m = /^npm latest @deepseek-ai\/dsh: (.+)$/.exec(line)
    if (m) registryLatest = m[1]
    if (/auto-install dsh failed/.test(line)) { killGroup('SIGKILL'); finish('auto-install dsh failed') ; return }
    // 逃逸线：manager 已经走到 supervise —— 立刻终止，绝不让它把 dsh web 真起起来。
    if (/launching dsh web/.test(line)) { killGroup('SIGTERM'); finish('launching dsh web') }
  }
  const handleEvent = (obj) => {
    if (obj.t === 'log') { handleLog(String(obj.line ?? '')); return }
    if (obj.t === 'install-status') {
      if (obj.phase === 'start') {
        console.log(`      +${fmtS(now() - startedAt)} install-status start → 目标 ${obj.version}`)
      } else if (obj.phase === 'running') {
        if (now() - lastBeat >= 15000) { lastBeat = now(); console.log(`      +${fmtS(now() - startedAt)} 安装中… ${obj.seconds}s`) }
      } else if (obj.phase === 'done') {
        doneAt = now()
        sawInstallDone = true
        console.log(`      +${fmtS(doneAt - startedAt)} install-status done → ${obj.version}`)
        // 收尾书briefly走完（profile bundles 补回 / 升级标记），但不给 supervise 起服务的机会。
        // 实测 manager 从 done 到 `launching dsh web` 只隔 ~20ms ⇒ 正常都由逃逸线先触发。
        graceTimer = setTimeout(() => { killGroup('SIGTERM'); finish('install-status done') }, POST_INSTALL_GRACE_MS)
      } else if (obj.phase === 'error') {
        killGroup('SIGKILL')
        finish(`install-status error: ${obj.error ?? ''}`.trim())
      }
    } else if (obj.t === 'url') {
      killInfo.dshWebStarted = true
      console.log(`      ⚠ 意外：manager 已起 dsh web（${String(obj.url).replace(/token=[^&]+/, 'token=***')}）—— 立即终止`)
      killGroup('SIGKILL')
      finish('dsh web started (killed)')
    }
  }
  let buf = ''
  child.stdout.on('data', (d) => {
    appendFileSync(stdoutLog, d)
    buf += String(d)
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let obj = null
      try { obj = JSON.parse(line) } catch { /* 非 JSON 行原样当日志 */ }
      if (obj && typeof obj === 'object' && obj.t) handleEvent(obj)
      else handleLog(line)
    }
  })
  child.stderr.on('data', (d) => {
    appendFileSync(stderrLog, d)
    for (const l of String(d).split(/\r?\n/)) if (l.trim()) { stderrTail.push(l); if (stderrTail.length > 200) stderrTail.shift() }
  })
  child.on('exit', (code, signal) => {
    killInfo.exit = { code, signal }
    if (!settled) finish(`manager 提前退出 rc=${code} signal=${signal ?? '-'}`)
  })
  child.stdin.on('error', () => { /* 进程已退 */ })
})

// 等它真的死掉（组杀后仍持有 stdio 的话会拖住日志落盘）。注意：被信号杀死的进程
// exitCode 恒为 null、只有 signalCode 有值 —— 两个都要看，否则会白等一个 grace。
await new Promise((r) => {
  const child = liveChild
  if (!child || child.exitCode !== null || child.signalCode !== null) return r()
  const timer = setTimeout(() => { killGroup('SIGKILL'); r() }, KILL_GRACE_MS)
  child.on('exit', () => { clearTimeout(timer); r() })
})

// ── 断言落地版本 ───────────────────────────────────────────────────────────
const installedPkg = join(tmp, `node_modules/${DSH_PKG}/package.json`)
installedVersion = readJson(installedPkg)?.version ?? null
dshEntryOk = existsSync(join(tmp, `node_modules/${DSH_PKG}/lib/bin.js`))
{
  const s = now()
  const ok = installedVersion === targetVersion && dshEntryOk
  step('version-assert', ok ? 'ok' : 'fail', now() - s,
    `落地 ${installedVersion ?? '(未装上)'} vs 期望 ${targetVersion}${dshEntryOk ? '' : '；且缺 lib/bin.js（半装）'}`)
}

// ── 探针 ───────────────────────────────────────────────────────────────────
{
  const s = now()
  const probeJson = join(tmp, 'probe.json')
  let exitCode = 0
  let wrote = false
  try {
    const out = execFileSync(process.execPath, [PROBE, '--runtime', tmp, '--json', probeJson],
      { encoding: 'utf8', timeout: Math.max(300_000, opts.timeoutSec * 1000), maxBuffer: 64 * 1024 * 1024 })
    probeInfo.stdoutTail = out.trim().split('\n').slice(-14)
    wrote = true
  } catch (err) {
    exitCode = typeof err.status === 'number' ? err.status : -1
    const out = `${err.stdout ?? ''}`
    probeInfo.stdoutTail = out.trim() ? out.trim().split('\n').slice(-14) : [`(探针无 stdout；${err.message}）`.slice(0, 200)]
    wrote = existsSync(probeJson)
  }
  const report = readJson(probeJson)
  probeInfo.exitCode = exitCode
  probeInfo.verdict = report?.verdict ?? (/verdict = (\w+)/.exec(probeInfo.stdoutTail.join('\n'))?.[1]?.toLowerCase() ?? null)
  probeInfo.counts = report?.counts ?? null
  probeInfo.blocking = (report?.findings ?? []).filter((f) => f.sev !== 'info').map((f) => ({ sev: f.sev, id: f.id, msg: f.msg }))
  probeMs = now() - s
  const greenExpected = targetVersion === floor
  const verdictOk = greenExpected ? probeInfo.verdict === 'green' : probeInfo.verdict !== 'red'
  step('probe', verdictOk ? 'ok' : 'fail', probeMs,
    `verdict=${(probeInfo.verdict ?? '?').toUpperCase()} exit=${exitCode}${greenExpected ? '' : '（期望版本≠地板 ⇒ 只要求非 RED，见下）'}`)
  for (const f of probeInfo.blocking) console.log(`        [${f.sev.toUpperCase()}] ${f.id}: ${f.msg}`)
}

// ── 真实 runtime 自证 + 残留进程自证 ───────────────────────────────────────
const warmAfter = warmProbeFiles.map(fingerprint)
const warmDiff = warmBefore.map((b, i) => ({
  path: b.path,
  same: b.exists === warmAfter[i].exists && b.sha256 === warmAfter[i].sha256 &&
    b.mtimeMs === warmAfter[i].mtimeMs && b.size === warmAfter[i].size,
  before: b, after: warmAfter[i],
}))
const warmUnchanged = warmDiff.every((d) => d.same)
step('warm-unchanged', warmUnchanged ? 'ok' : 'fail', 0,
  warmUnchanged ? `真实 runtime ${warmDiff.length} 处指纹（sha256+mtime+size）全部一致`
    : `被改动：${warmDiff.filter((d) => !d.same).map((d) => d.path).join(', ')}`)
const leftovers = listProcsMatching(tmp)
step('no-leftover-procs', leftovers === null ? 'skip' : (leftovers.length === 0 ? 'ok' : 'fail'), 0,
  leftovers === null ? '非 Linux，未做 /proc 枚举（请看报告里的 ps 证据）'
    : (leftovers.length === 0 ? '无进程引用临时 runtime（/proc/*/cmdline 全扫）' : `${leftovers.length} 个残留：${leftovers.map((p) => p.pid).join(', ')}`))

// ── 清理 ───────────────────────────────────────────────────────────────────
const failed = steps.some((s) => s.status === 'fail')
tmpKept = opts.keep || failed
{
  const s = now()
  if (tmpKept) {
    step('cleanup', 'skip', 0, `${opts.keep ? '--keep' : '失败保留现场'}：${tmp}`)
  } else {
    rmSync(tmp, { recursive: true, force: true }) // 只删临时目录；两条软链被 unlink，不跟随
    step('cleanup', existsSync(tmp) ? 'fail' : 'ok', now() - s, '临时目录已删（软链只删链、不跟随）')
  }
  cleanupMs = now() - s
}

// 清理后复检一次：确认 rm 没有跟着软链动到真实 runtime（最坏情况的兜底证据）。
const warmAfterCleanup = warmProbeFiles.map(fingerprint)
const warmStillOk = warmDiff.every((d, i) =>
  warmAfterCleanup[i].exists === d.before.exists && warmAfterCleanup[i].sha256 === d.before.sha256)

// ── 结论 ───────────────────────────────────────────────────────────────────
const mismatch = installedVersion !== targetVersion
// 版本不一致时补一次诊断：启动期路径的目标 = max(地板, registry latest)，把 latest 查出来
// 才能说清"为什么装成了这个版本"。best-effort：查不到就如实说查不到（不编数字）。
let registryLatestSource = registryLatest ? 'manager 日志（npm latest 行）' : null
if (mismatch && !registryLatest) {
  try {
    const out = execFileSync('npm', ['view', DSH_PKG, 'dist-tags', '--json', '--registry', registry],
      { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] })
    const parsed = JSON.parse(out)
    const latest = typeof parsed === 'string' ? parsed : parsed?.['dist-tags']?.latest ?? parsed?.latest ?? null
    if (typeof latest === 'string') { registryLatest = latest; registryLatestSource = `npm view（best-effort，${registry}）` }
  } catch { /* 查不到就留 null */ }
}
let status
if (!warmUnchanged || !warmStillOk) status = 'FAILED' // 真实 runtime 被动过 = 最严重，优先报
else if (mismatch && installedVersion) status = 'MISMATCH'
else if (failed) status = 'FAILED'
else if (probeInfo.verdict === 'green') status = 'GREEN'
else status = String(probeInfo.verdict ?? 'unknown').toUpperCase()
const totalMs = now() - t0

/** 诚实标注的边界（不是失败，但读结论时必须知道）。 */
const caveats = [
  `热 store 是**软链共享**的：pnpm 可能往真实 runtime 的 .pnpm-store 追加内容寻址条目（只增不删）；` +
  `已装树（node_modules/${DSH_PKG}/*）与 manager.log 的指纹已逐一自证未变。`,
  `启动期自动安装路径的目标版本 = max(壳地板 ${floor}, registry latest)——结构上不可注入任意版本，` +
  `--version 只是"期望值"（不一致即报 MISMATCH）。`,
]
if (killInfo.dshWebStarted) caveats.push('本次演练意外让 manager 走到了 supervise 并起了 dsh web（已立即杀掉；临时 runtime 内，未影响真实实例）。')

console.log('')
console.log('  ── 每步耗时 ─────────────────────────────────────────────')
console.log(`  install（manager 启动→装完）  ${fmtS(installMs).padStart(8)}`)
console.log(`  probe（dsh-compat-probe）    ${fmtS(probeMs).padStart(8)}`)
console.log(`  其它（前置/临时目录/清理）    ${fmtS(totalMs - installMs - probeMs).padStart(8)}`)
console.log(`  total                        ${fmtS(totalMs).padStart(8)}`)
for (const g of gaps) console.log(`  ⚠ ${g}`)
const conclusion = status === 'GREEN'
  ? `GREEN — 临时 runtime 装到 ${installedVersion}（== 期望 ${targetVersion}），探针 green(exit 0)，真实 runtime 指纹未变，无残留进程`
  : (status === 'MISMATCH'
    ? `MISMATCH — 期望 ${targetVersion}，实际落地 ${installedVersion}` +
      (registryLatest ? `；manager 的启动期路径目标 = max(地板 ${floor}, registry latest ${registryLatest})` : '') +
      `，该路径不接受外部指定版本；探针 verdict=${(probeInfo.verdict ?? '?').toUpperCase()}`
    : `FAILED — ${steps.filter((s) => s.status === 'fail').map((s) => `${s.name}(${s.detail})`).join('；')}`)
console.log(`  结论: ${conclusion}`)
for (const c of caveats) console.log(`  说明: ${c}`)
if (tmpKept) console.log(`  现场保留：${tmp}（manager-stdout.jsonl / manager-stderr.txt / manager.log / probe.json）`)
if (stderrTail.length) console.log(`  stderr 尾部：${stderrTail.slice(-3).join(' | ').slice(0, 300)}`)
if (stdoutTail.length && status !== 'GREEN') console.log(`  日志尾部：\n${stdoutTail.slice(-8).map((l) => `    ${String(l).slice(0, 220)}`).join('\n')}`)

const result = {
  tool: 'dsh-rehearse',
  ok: status === 'GREEN',
  status,
  conclusion,
  repo: ROOT,
  startedAt: new Date(t0).toISOString(),
  finishedAt: new Date().toISOString(),
  floorVersion: floor,
  targetVersion,
  targetSource: opts.version ? '--version' : 'MIN_DSH_VERSION',
  installedVersion,
  registryLatest,
  registryLatestSource,
  registry,
  registrySource,
  npmOffline: offline,
  timeoutSec: opts.timeoutSec,
  warmRuntime,
  warmRuntimeSource: warmSource,
  warmUnchanged,
  // 完整指纹（内容哈希 + mtime + size）留在 JSON 里：报告里的"没被改动"必须能被第三方复核，
  // 只写一个 same:true 等于自证。
  warmFingerprints: warmDiff.map((d) => ({ path: d.path, same: d.same, before: d.before, after: d.after })),
  warmStillOkAfterCleanup: warmStillOk,
  manager: { command: managerCmdLine, ...killInfo, stderrTail: stderrTail.slice(-10) },
  steps,
  timings: { preflightMs, installMs, probeMs, cleanupMs, totalMs },
  probe: probeInfo,
  tmpDir: tmp,
  kept: tmpKept,
  removed: !tmpKept && !existsSync(tmp),
  leftoverProcs: leftovers,
  logTail: stdoutTail.slice(-20),
  caveats,
  gaps,
}
writeJson(opts.json, result)
process.exit(status === 'GREEN' ? 0 : 1)

function writeJson(out, obj) {
  if (!out) return
  try {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(obj, null, 2))
    console.log(`  JSON 已写入 ${out}`)
  } catch (err) {
    console.error(`dsh-rehearse: 写 ${out} 失败：${err.message}`)
  }
}
