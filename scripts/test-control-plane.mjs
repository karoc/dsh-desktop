#!/usr/bin/env node
// Process-level integration test for the manager control plane:
//   - startup reports `update-status` and NEVER auto-installs (D2);
//   - stdin JSON commands: `restart-dsh` kills+respawns dsh (D5);
//     `check-update` re-reports; unknown commands are ignored safely.
//
// Uses a FAKE @deepseek-ai/dsh package (a bin.js that prints a url event and
// stays alive) so no real install / network is involved. DSH_DESKTOP_NO_UPDATE=1
// keeps the registry check off.
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(root, '..')
const manager = join(repoRoot, 'scripts', 'server-manager.mjs')
const resources = join(repoRoot, 'src-tauri', 'resources')
// Expected preinstalled versions come from the actual bundled packages, so
// this test tracks version bumps instead of pinning a hardcoded string.
const bundledVersion = (name) =>
  JSON.parse(readFileSync(join(resources, 'preinstalled', name, 'package.json'), 'utf8')).version

const work = mkdtempSync(join(tmpdir(), 'dsh-ctrl-'))
const runtime = join(work, 'runtime')
const marker = join(work, 'boots.log')
const envProbe = join(work, 'env.probe')

// ── fake dsh package ────────────────────────────────────────────────────────
const dshDir = join(runtime, 'node_modules', '@deepseek-ai', 'dsh')
mkdirSync(join(dshDir, 'lib'), { recursive: true })
writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9-test' }, null, 2))
writeFileSync(join(dshDir, 'lib', 'bin.js'), `
import { appendFileSync, writeFileSync } from 'node:fs'
const m = process.env.DSH_TEST_MARKER
if (m) appendFileSync(m, 'boot ' + process.pid + '\\n')
// Probe the env the shell injected (forward-proxy choke point) plus the Node
// header budget the manager must hand to dsh web (cookie-431 fix, P1).
const ep = process.env.DSH_TEST_ENV_PROBE
if (ep) writeFileSync(ep, JSON.stringify({
  http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY,
  nodeEnvProxy: process.env.NODE_USE_ENV_PROXY, noProxy: process.env.NO_PROXY,
  nodeOptions: process.env.NODE_OPTIONS,
  maxHeaderSize: process.getBuiltinModule('node:http').maxHeaderSize,
  path: process.env.PATH,
}))
const port = 18000 + (process.pid % 1000)
process.stdout.write(JSON.stringify({ t: 'url', url: 'http://127.0.0.1:' + port }) + '\\n')
setInterval(() => {}, 1000)
`)
// Pre-seed pnpm (the sandbox npm cache is read-only; a real install would fail
// here). ensurePnpm must accept the seeded entry and still write the shim.
const pnpmDir = join(runtime, 'node_modules', 'pnpm', 'bin')
mkdirSync(pnpmDir, { recursive: true })
writeFileSync(join(pnpmDir, 'pnpm.cjs'), '// pnpm stub\n')

// ── minimal patch file (manager passes it through; fake dsh ignores it) ─────
writeFileSync(join(work, 'patch.yml'), '- insert:\n    - id: test\n      name: "@dsh-desktop/client-notifications"\n')
// Pre-write a shell manifest with devMode: ensurePreinstalled must preserve it.
writeFileSync(join(runtime, 'dsh.json'), JSON.stringify({ devMode: true }))

// ── spawn the manager ───────────────────────────────────────────────────────
const child = spawn(process.execPath, [
  manager,
  '--runtime-dir', runtime,
  '--resource-dir', resources,
  '--patch', join(work, 'patch.yml'),
  '--cwd', work,
], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DSH_DESKTOP_NO_UPDATE: '1',
    DSH_TEST_MARKER: marker,
    DSH_TEST_ENV_PROBE: envProbe,
  },
  windowsHide: true,
})

const events = []
let stderr = ''
child.stderr.on('data', (b) => { stderr += String(b) })
const waitFor = (pred, what, timeoutMs = 15_000) =>
  new Promise((resolvePromise, rejectPromise) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      const hit = events.find(pred)
      if (hit) return resolvePromise(hit)
      if (Date.now() > deadline) return rejectPromise(new Error(`timeout waiting for ${what}\nstderr: ${stderr}\nseen: ${JSON.stringify(events)}`))
      setTimeout(tick, 50)
    }
    tick()
  })

let buf = ''
child.stdout.on('data', (chunk) => {
  buf += String(chunk)
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    try { events.push(JSON.parse(line)) } catch { /* non-JSON noise */ }
  }
})

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n')
}
const boots = () => (existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').filter(Boolean) : [])

// ── scenario 1: startup reports update-status, NO auto-install ──────────────
const bootEvent = await waitFor((e) => e.t === 'url', 'first url event')
assert.ok(bootEvent.url.startsWith('http://127.0.0.1:'), 'url event carries the loopback url')

// ── scenario 1b: built-in forward proxy is up and injected into dsh ─────────
const ps = await waitFor((e) => e.t === 'proxy-status', 'proxy-status event')
assert.ok(typeof ps.port === 'number' && ps.port > 0, 'proxy-status carries a real loopback port')
assert.equal(ps.upstreamEnabled, false, 'fresh runtime: upstream disabled (all direct)')
await waitFor((e) => e.t === 'proxy-hosts', 'proxy-hosts event')
await waitFor((e) => e.t === 'proxy-providers', 'proxy-providers event')
// The fake dsh child runs under the manager's env — it must see the choke point.
await new Promise((r) => setTimeout(r, 400))
const probed = JSON.parse(readFileSync(envProbe, 'utf8'))
assert.equal(probed.nodeEnvProxy, '1', 'NODE_USE_ENV_PROXY=1 injected (undici honors *PROXY)')
assert.equal(probed.http, `http://127.0.0.1:${ps.port}`, 'HTTP_PROXY points at the built-in proxy')
assert.equal(probed.https, `http://127.0.0.1:${ps.port}`, 'HTTPS_PROXY points at the built-in proxy')
assert.ok(/127\.0\.0\.1/.test(probed.noProxy) && /localhost/.test(probed.noProxy), 'NO_PROXY keeps loopback direct')
// cookie-431 fix (P1): the dsh web child must run with a raised header budget —
// Node's default 16384 B is what made the 2.85 KB plugin batch URL answer 431.
assert.ok(
  typeof probed.nodeOptions === 'string' && probed.nodeOptions.includes('--max-http-header-size=65536'),
  `dsh web child gets --max-http-header-size=65536 (got: ${probed.nodeOptions})`,
)
assert.ok(
  probed.nodeOptions.includes('--report-on-fatalerror'),
  'the pre-existing crash-report flags are still appended',
)
assert.equal(probed.maxHeaderSize, 65_536, 'the child process really runs with a 64 KiB header budget')
// dsh 0.1.6 起插件管理在 dsh 内部（Web 侧边栏 Plugins 页），它按 PATH 找 pnpm
// （launcher facts 的 packageManager 只能由进程内调用方注入，CLI 路径拿不到）
// → dsh web 子进程的 PATH 必须以壳内置 pnpm 的 shim 目录开头，否则插件页装不了插件。
const shimDir = join(runtime, 'bin')
assert.ok(
  typeof probed.path === 'string' && probed.path.split(process.platform === 'win32' ? ';' : ':')[0] === shimDir,
  `dsh web child PATH starts with the bundled pnpm shim dir (got: ${probed.path})`,
)

const status1 = await waitFor((e) => e.t === 'update-status', 'initial update-status')
assert.equal(status1.current, '9.9.9-test', 'update-status reports the installed fake version')
assert.equal(status1.updateAvailable, false, 'NO_UPDATE mode must never claim an update is available')

// ── scenario 2: unknown command is ignored without crashing ─────────────────
send({ cmd: 'bogus-command' })
await new Promise((r) => setTimeout(r, 400))
assert.equal(child.exitCode, null, 'manager must still be alive after an unknown command')
assert.equal(boots().length, 1, 'dsh must not have restarted from the unknown command')

// ── scenario 3: restart-dsh kills and respawns dsh (D5) ────────────────────
send({ cmd: 'restart-dsh' })
const second = await waitFor((e) => e.t === 'url' && e.url !== bootEvent.url, 'second url event after restart-dsh')
assert.notEqual(second.url, bootEvent.url, 'dsh restarts on a fresh (random) port')
await new Promise((r) => setTimeout(r, 400))
const b = boots()
assert.equal(b.length, 2, `dsh must boot exactly twice (got ${b.length})`)
assert.notEqual(b[0], b[1], 'the two boots are distinct processes')

// ── scenario 4: check-update re-reports status without installing ───────────
send({ cmd: 'check-update' })
const status2 = await waitFor((e) => e.t === 'update-status' && e !== status1, 'reported update-status after check-update')
assert.equal(status2.updateAvailable, false, 're-check keeps updateAvailable false (no network)')

// ── scenario 4b: preinstalled bundles land in runtime + dsh.json (P2) ───────
await new Promise((r) => setTimeout(r, 400)) // let ensurePreinstalled finish
const dshJson = JSON.parse(readFileSync(join(runtime, 'dsh.json'), 'utf8'))
assert.ok(
  Array.isArray(dshJson.preinstalled) && dshJson.preinstalled.includes('dsh-model-reasoning'),
  'dsh.json records the preinstalled list',
)
assert.equal(dshJson.devMode, true, 'ensurePreinstalled preserves other shell manifest fields (devMode)')
const mr = join(runtime, 'node_modules', 'dsh-model-reasoning', 'package.json')
assert.ok(existsSync(mr), 'preinstalled bundle copied into runtime node_modules')
const mrPkg = JSON.parse(readFileSync(mr, 'utf8'))
assert.equal(mrPkg.name, 'dsh-model-reasoning', 'copied package keeps its real name')
// dsh-kanban ships alongside as a second preinstalled bundle.
assert.ok(
  Array.isArray(dshJson.preinstalled) && dshJson.preinstalled.includes('dsh-kanban'),
  'dsh.json records the dsh-kanban preinstalled bundle',
)
const kb = join(runtime, 'node_modules', 'dsh-kanban', 'package.json')
assert.ok(existsSync(kb), 'dsh-kanban preinstalled bundle copied into runtime node_modules')
const kbPkg = JSON.parse(readFileSync(kb, 'utf8'))
assert.equal(kbPkg.name, 'dsh-kanban', 'copied dsh-kanban package keeps its real name')
// dsh-turn-navigator ships alongside as a third preinstalled bundle.
assert.ok(
  Array.isArray(dshJson.preinstalled) && dshJson.preinstalled.includes('dsh-turn-navigator'),
  'dsh.json records the dsh-turn-navigator preinstalled bundle',
)
const tn = join(runtime, 'node_modules', 'dsh-turn-navigator', 'package.json')
assert.ok(existsSync(tn), 'dsh-turn-navigator preinstalled bundle copied into runtime node_modules')
const tnPkg = JSON.parse(readFileSync(tn, 'utf8'))
assert.equal(tnPkg.name, 'dsh-turn-navigator', 'copied dsh-turn-navigator package keeps its real name')
// @karoc/dsh-smoothly-opencode-session ships as a fourth preinstalled bundle
// and is the first SCOPED one: the source dir stays unscoped while the runtime
// copy must land under the scope dir (node_modules/@karoc/…) — i.e. the dir
// name must never be used as the install path.
const ocsName = '@karoc/dsh-smoothly-opencode-session'
assert.ok(
  Array.isArray(dshJson.preinstalled) && dshJson.preinstalled.includes(ocsName),
  'dsh.json records the scoped preinstalled bundle by its real (scoped) package name',
)
const ocs = join(runtime, 'node_modules', '@karoc', 'dsh-smoothly-opencode-session', 'package.json')
assert.ok(existsSync(ocs), 'scoped preinstalled bundle copied into runtime node_modules/@karoc')
assert.equal(JSON.parse(readFileSync(ocs, 'utf8')).name, ocsName, 'copied scoped package keeps its real name')

// ── scenario 6b: restart-dsh clears the op-status (no stale "restart to apply") ──
send({ cmd: 'restart-dsh' })
const opReset = await waitFor(
  (e) => e.t === 'op-status' && e.op === null && e.done === false,
  'op-status cleared after restart',
)
assert.ok(opReset, 'restart-dsh clears the op-status so the hint does not persist')

// ── scenario 7: SIGTERM tears the whole tree down ───────────────────────────
child.kill('SIGTERM')
const code = await new Promise((resolvePromise) => child.on('exit', (c) => resolvePromise(c)))
assert.equal(code, 0, 'manager exits 0 on SIGTERM')

// ── scenario 8: 低于最低版本地板时走兼容闸门，且失败不阻塞启动 ─────────────
// 壳依赖 dsh 0.1.6-alpha.2 起的自带插件管理（壳内自建管理已整体移除），且随壳
// 分发的预装插件要求 dsh ≥ 0.1.7-rc.1（可选 peer，由 dsh 的兼容门禁判定）→
// 低于地板的运行时必须被升级到地板。
// 沙箱里 registry 指向一个必然连不上的地址：升级会失败，但 dsh **必须照样被拉起**
// （失败只降级为"没有插件管理"，绝不能变成"起不来"）。
const oldRuntime = join(work, 'runtime-old')
const oldDsh = join(oldRuntime, 'node_modules', '@deepseek-ai', 'dsh')
mkdirSync(join(oldDsh, 'lib'), { recursive: true })
writeFileSync(join(oldDsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }))
writeFileSync(join(oldDsh, 'lib', 'bin.js'), `
import { appendFileSync } from 'node:fs'
const m = process.env.DSH_TEST_MARKER
if (m) appendFileSync(m, 'boot-old ' + process.pid + '\\n')
process.stdout.write(JSON.stringify({ t: 'url', url: 'http://127.0.0.1:19999' }) + '\\n')
setInterval(() => {}, 1000)
`)
mkdirSync(join(oldRuntime, 'node_modules', 'pnpm', 'bin'), { recursive: true })
// 这个桩**故意失败**：断言"升级失败时如实上报、且不阻塞启动"这条负向保证。
writeFileSync(
  join(oldRuntime, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
  "process.stderr.write('ERR_PNPM sandbox offline\\n'); process.exit(1)\n",
)
const oldMarker = join(work, 'boots-old.log')
const oldChild = spawn(process.execPath, [
  manager,
  '--runtime-dir', oldRuntime,
  '--resource-dir', resources,
  '--patch', join(work, 'patch.yml'),
  '--cwd', work,
], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DSH_DESKTOP_NO_UPDATE: '1',
    DSH_TEST_MARKER: oldMarker,
    // 连不上的 registry：闸门必须快速失败并继续启动，而不是挂在网络超时上。
    DSH_DESKTOP_REGISTRY: 'http://127.0.0.1:9/',
  },
  windowsHide: true,
})
// manager 的 log() 走 stdout 事件 + <runtime>/manager.log 旁路；用旁路断言，
// 因为它不受事件时序影响（壳崩了日志也还在）。
const oldLog = join(oldRuntime, 'manager.log')
const oldLogText = () => (existsSync(oldLog) ? readFileSync(oldLog, 'utf8') : '')
let gateDeadline = Date.now() + 90_000
const until = async (pred) => {
  while (Date.now() < gateDeadline && !pred()) await new Promise((r) => setTimeout(r, 200))
  return pred()
}
assert.ok(
  await until(() => oldLogText().includes('低于最低要求')),
  `the floor gate announces the upgrade (manager.log: ${oldLogText().slice(0, 400)})`,
)
assert.ok(
  await until(() => oldLogText().includes('兼容闸门升级失败')),
  `the gate reports the failure honestly instead of pretending success (manager.log: ${oldLogText().slice(0, 600)})`,
)
assert.ok(
  await until(() => existsSync(oldMarker) && readFileSync(oldMarker, 'utf8').includes('boot-old')),
  `dsh still starts after a failed gate upgrade (manager.log: ${oldLogText().slice(0, 600)})`,
)
oldChild.kill('SIGTERM')
await new Promise((resolvePromise) => oldChild.on('exit', resolvePromise))

// ── scenario 9: 残留嵌套包被检测并**就地清理**，dsh 照常启动 ─────────────────
// 2026-09-21 实测：0.1.5-rc.2 → 0.1.6-alpha.2 升级后
// <runtime>/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/node_modules/
// @deepseek-ai/ 下留着 3 个 0.1.5-rc.2 的包（pnpm hoisted 不清理嵌套目录），而 Node
// 优先解析嵌套副本 → 子路径导出缺失 → dsh web 启动即 ERR_PACKAGE_PATH_NOT_EXPORTED。
// 断言：检测到 → 删掉那棵嵌套树 → dsh 仍然启动（修复不需要联网/pnpm，也不动主树）。
const staleRuntime = join(work, 'runtime-stale')
const staleDsh = join(staleRuntime, 'node_modules', '@deepseek-ai', 'dsh')
mkdirSync(join(staleDsh, 'lib'), { recursive: true })
writeFileSync(join(staleDsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.6-alpha.2' }))
writeFileSync(join(staleDsh, 'lib', 'bin.js'), `
import { appendFileSync } from 'node:fs'
const m = process.env.DSH_TEST_MARKER
if (m) appendFileSync(m, 'boot-stale ' + process.pid + '\\n')
process.stdout.write(JSON.stringify({ t: 'url', url: 'http://127.0.0.1:19998' }) + '\\n')
setInterval(() => {}, 1000)
`)
const staleParent = join(staleRuntime, 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl')
const staleNestedDir = join(staleParent, 'node_modules', '@deepseek-ai', 'dsh-session-format-catalog')
mkdirSync(staleNestedDir, { recursive: true })
writeFileSync(join(staleParent, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session-persistence-jsonl', version: '0.1.6-alpha.2' }))
writeFileSync(join(staleNestedDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session-format-catalog', version: '0.1.5-rc.2' }))
// 一个"本该被解析到"的提升副本，证明清理后解析会落到它上面。
const hoistedDir = join(staleRuntime, 'node_modules', '@deepseek-ai', 'dsh-session-format-catalog')
mkdirSync(hoistedDir, { recursive: true })
writeFileSync(join(hoistedDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session-format-catalog', version: '0.1.6-alpha.2' }))
mkdirSync(join(staleRuntime, 'node_modules', 'pnpm', 'bin'), { recursive: true })
writeFileSync(join(staleRuntime, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), '// pnpm stub\n')
const staleMarker = join(work, 'boots-stale.log')
const staleChild = spawn(process.execPath, [
  manager,
  '--runtime-dir', staleRuntime,
  '--resource-dir', resources,
  '--patch', join(work, 'patch.yml'),
  '--cwd', work,
], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DSH_DESKTOP_NO_UPDATE: '1',
    DSH_TEST_MARKER: staleMarker,
    // 连不上的 registry：清理型修复**不需要**联网，这条断言正是要证明这一点。
    DSH_DESKTOP_REGISTRY: 'http://127.0.0.1:9/',
  },
  windowsHide: true,
})
const staleLog = join(staleRuntime, 'manager.log')
const staleLogText = () => (existsSync(staleLog) ? readFileSync(staleLog, 'utf8') : '')
// 每个场景各自计时：共享一个 deadline 会让后面的场景被前面耗掉的时间挤成"立即超时"。
gateDeadline = Date.now() + 60_000
assert.ok(
  await until(() => staleLogText().includes('清理了 1 个残留嵌套包')),
  `the stale-nested repair fires and reports what it removed (manager.log: ${staleLogText().slice(0, 600)})`,
)
assert.ok(
  !existsSync(staleNestedDir),
  'the stale nested copy is gone (the parent still resolves the hoisted alpha.2 package)',
)
assert.ok(
  existsSync(join(hoistedDir, 'package.json')) && existsSync(join(staleDsh, 'package.json')),
  'the repair removes only the stale copies — the hoisted package and dsh itself stay',
)
assert.ok(
  await until(() => existsSync(staleMarker) && readFileSync(staleMarker, 'utf8').includes('boot-stale')),
  `dsh starts after the repair (manager.log: ${staleLogText().slice(0, 600)})`,
)
staleChild.kill('SIGTERM')
await new Promise((resolvePromise) => staleChild.on('exit', resolvePromise))

console.log('PASS — manager control plane (12 scenarios)')
rmSync(work, { recursive: true, force: true })
process.exit(0)
