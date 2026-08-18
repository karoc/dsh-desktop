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

const work = mkdtempSync(join(tmpdir(), 'dsh-ctrl-'))
const runtime = join(work, 'runtime')
const marker = join(work, 'boots.log')
const pluginMarker = join(work, 'plugin.log')
const envProbe = join(work, 'env.probe')

// ── fake dsh package ────────────────────────────────────────────────────────
const dshDir = join(runtime, 'node_modules', '@deepseek-ai', 'dsh')
mkdirSync(join(dshDir, 'lib'), { recursive: true })
writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9-test' }, null, 2))
writeFileSync(join(dshDir, 'lib', 'bin.js'), `
import { appendFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const argv = process.argv.slice(2)
// dsh plugin --profile web <args> mode: record the call; on 'add', write the
// web profile manifest with the package as a PLAIN dependency (no dsh.bundle),
// so the manager's post-install bundle check has real data to read.
if (argv.includes('plugin')) {
  const pm = process.env.DSH_TEST_PLUGIN_MARKER
  if (pm) appendFileSync(pm, argv.join(' ') + '\\n')
  const addAt = argv.indexOf('add')
  if (addAt >= 0 && argv[addAt + 1]) {
    const spec = argv[addAt + 1]
    const name = spec.split(':').pop().split('/').pop()
    const home = process.env.DSH_HOME || '.'
    const dir = join(home, 'profiles', 'web')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'package.json')
    let m = { dependencies: {}, dsh: { profile: { bundles: [] } } }
    try { m = JSON.parse(readFileSync(p, 'utf8')) } catch {}
    m.dependencies = { ...(m.dependencies || {}), [name]: '0.0.0-git' }
    m.dsh = { profile: { bundles: m.dsh?.profile?.bundles || [] } }
    writeFileSync(p, JSON.stringify(m))
  }
  process.exit(0)
}
const m = process.env.DSH_TEST_MARKER
if (m) appendFileSync(m, 'boot ' + process.pid + '\\n')
// Probe the env the shell injected (forward-proxy choke point).
const ep = process.env.DSH_TEST_ENV_PROBE
if (ep) writeFileSync(ep, JSON.stringify({
  http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY,
  nodeEnvProxy: process.env.NODE_USE_ENV_PROXY, noProxy: process.env.NO_PROXY,
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
    DSH_TEST_PLUGIN_MARKER: pluginMarker,
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

// ── scenario 5 (P5): plugins-install routes through the dsh plugin CLI ───────
send({ cmd: 'plugins-install', spec: 'some-plugin@1.2.3' })
const opStart = await waitFor((e) => e.t === 'op-status' && e.op === 'install' && e.done === false, 'op-status start')
assert.equal(opStart.spec, 'some-plugin@1.2.3', 'op-status start carries the spec')
const opDone = await waitFor((e) => e.t === 'op-status' && e.op === 'install' && e.spec === 'some-plugin@1.2.3' && e.done === true, 'op-status done')
assert.equal(opDone.ok, true, 'install op reports success')
// The fake profile declares no dsh.bundle -> honest hint, no restart promised.
assert.equal(opDone.nextAction, null, 'non-bundle install does not ask for a restart')
assert.ok(opDone.hint && opDone.hint.includes('dsh.bundle'), 'non-bundle install emits a clear hint')
await new Promise((r) => setTimeout(r, 300))
const pluginCalls = existsSync(pluginMarker) ? readFileSync(pluginMarker, 'utf8').split('\n').filter(Boolean) : []
assert.equal(pluginCalls.length, 1, 'dsh plugin CLI invoked exactly once')
assert.ok(pluginCalls[0].includes('--profile web add some-plugin@1.2.3'), `CLI args routed correctly (got: ${pluginCalls[0]})`)
// ensurePnpm accepted the pre-seeded pnpm and wrote the shim.
const shim = join(runtime, 'bin', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
assert.ok(existsSync(shim), 'pnpm shim written for the bundled pnpm')

// ── scenario 6 (P5): preinstalled update check event + command routing ───────
const pu = await waitFor((e) => e.t === 'preinstalled-updates', 'preinstalled-updates event')
const entry = pu.updates?.['dsh-model-reasoning']
assert.ok(entry, 'preinstalled-updates covers the shipped bundle')
assert.equal(entry.installed, '0.1.1', 'installed version read from the copied package')
assert.equal(entry.userUpdated, false, 'not user-updated on a fresh runtime')
assert.equal(entry.updateAvailable, false, 'no registry in the sandbox -> not claimable as update')
const kbEntry = pu.updates?.['dsh-kanban']
assert.ok(kbEntry, 'preinstalled-updates also covers dsh-kanban')
assert.equal(kbEntry.installed, '0.1.0', 'dsh-kanban installed version read from the copied package')
assert.equal(kbEntry.userUpdated, false, 'dsh-kanban not user-updated on a fresh runtime')
assert.equal(kbEntry.updateAvailable, false, 'dsh-kanban not claimable as update without a registry')

send({ cmd: 'preinstalled-update', name: 'dsh-model-reasoning' })
const updStart = await waitFor((e) => e.t === 'op-status' && e.op === 'update-preinstalled' && e.done === false, 'update-preinstalled start')
assert.equal(updStart.spec, 'dsh-model-reasoning', 'op-status start carries the bundle name')
const updDone = await waitFor((e) => e.t === 'op-status' && e.op === 'update-preinstalled' && e.done === true, 'update-preinstalled done')
assert.equal(typeof updDone.ok, 'boolean', 'op reports an outcome (sandbox npm fails -> ok false)')

// ── scenario 6b: restart-dsh clears the op-status (no stale "restart to apply") ──
send({ cmd: 'restart-dsh' })
const opReset = await waitFor(
  (e) => e.t === 'op-status' && e.op === null && e.done === false,
  'op-status cleared after restart',
)
assert.ok(opReset, 'restart-dsh clears the op-status so the hint does not persist')
// And a subsequent op is NOT blocked by the cleared state (busy-guard).
send({ cmd: 'plugins-install', spec: 'after-restart@1.0.0' })
const afterStart = await waitFor((e) => e.t === 'op-status' && e.op === 'install' && e.spec === 'after-restart@1.0.0' && e.done === false, 'install op starts after the cleared restart')
assert.equal(afterStart.spec, 'after-restart@1.0.0', 'cleared state does not block new ops')
await waitFor((e) => e.t === 'op-status' && e.op === 'install' && e.spec === 'after-restart@1.0.0' && e.done === true, 'install op settles')

// ── scenario 6c: a raw GitHub URL is normalized before reaching pnpm ─────────
send({ cmd: 'plugins-install', spec: 'https://github.com/xiaobright/dsh-anchored-standard/' })
const ghDone = await waitFor((e) => e.t === 'op-status' && e.op === 'install' && e.spec === 'github:xiaobright/dsh-anchored-standard' && e.done === true, 'github install settles')
assert.equal(ghDone.ok, true, 'github install op reports success')
assert.ok(ghDone.hint && ghDone.hint.includes('dsh.bundle'), 'non-bundle github repo still gets the honest hint')
await new Promise((r) => setTimeout(r, 300))
const ghCalls = existsSync(pluginMarker) ? readFileSync(pluginMarker, 'utf8').split('\n').filter(Boolean) : []
assert.ok(
  ghCalls.some((l) => l.includes('add github:xiaobright/dsh-anchored-standard')),
  `raw github URL normalized to a pnpm spec (calls: ${JSON.stringify(ghCalls)})`,
)

// ── scenario 7: SIGTERM tears the whole tree down ───────────────────────────
child.kill('SIGTERM')
const code = await new Promise((resolvePromise) => child.on('exit', (c) => resolvePromise(c)))
assert.equal(code, 0, 'manager exits 0 on SIGTERM')

console.log('PASS — manager control plane (10 scenarios)')
rmSync(work, { recursive: true, force: true })
process.exit(0)
