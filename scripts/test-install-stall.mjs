#!/usr/bin/env node
// Test the install-stall hardening in server-manager.mjs against a REAL
// manager process, exercising the EXACT bug-report path:
//   * runtime dir is empty (user chose "delete local data" during upgrade) →
//     main() auto-installs @deepseek-ai/dsh on launch;
//   * a fake registry serves the packument but its tarball endpoint ACCEPTS
//     the connection then never sends data (a stalled download);
//   * we assert the manager recovers FAST (npm fetch idle-timeout + registry
//     failover) and emits a clear install-status error — instead of the old
//     silent 600s-per-registry (20 min) hang.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const NODE = process.env.TEST_NODE || process.execPath
const MANAGER = resolve(process.cwd(), 'scripts/server-manager.mjs')
const RESOURCES = resolve(process.cwd(), 'src-tauri/resources')
const HOST = '127.0.0.1'
let tarballRequests = 0

// ── fake registry: packument ok, tarball stalls (no more bytes) ─────────────
const registry = createServer((req, res) => {
  const url = req.url || ''
  if (url.includes('/@deepseek-ai%2fdsh') && !url.endsWith('.tgz')) {
    const port = registry.address().port
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      name: '@deepseek-ai/dsh',
      'dist-tags': { latest: '0.0.0-test' },
      versions: {
        '0.0.0-test': {
          name: '@deepseek-ai/dsh',
          version: '0.0.0-test',
          dist: { tarball: `http://${HOST}:${port}/dsh.tgz` },
        },
      },
    }))
    return
  }
  if (url.endsWith('/dsh.tgz')) {
    tarballRequests++
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '100000' })
    res.write(Buffer.alloc(64, 0)) // a few bytes, then silence — idle fetch-timeout must abort
    return
  }
  res.writeHead(404)
  res.end('not found')
})

// ── EMPTY runtime dir: simulates "delete local data" → cold auto-install ────
const tmp = mkdtempSync(join(tmpdir(), 'dsh-stall-test-'))
const runtime = join(tmp, 'runtime')
mkdirSync(runtime, { recursive: true })
writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: 'dsh-runtime', private: true, version: '0.0.0' }))
writeFileSync(join(tmp, 'patch.json'), '{}')
// npm's cacache lives under $HOME/.npm; give it a writable dir (sandbox homes
// are read-only → npm would fail EROFS before even fetching).
const fakeHome = join(tmp, 'fake-home')
mkdirSync(fakeHome, { recursive: true })

await new Promise((r) => registry.listen(0, HOST, r))
console.log(`fake registry on http://${HOST}:${registry.address().port} (tarball stalls)`)

const startMs = Date.now()
const child = spawn(NODE, [
  MANAGER,
  '--runtime-dir', runtime,
  '--resource-dir', RESOURCES,
  '--patch', join(tmp, 'patch.json'),
  '--cwd', tmp,
  '--home', join(tmp, 'home'),
  '--registry', `http://${HOST}:${registry.address().port}`,
  '--bridge-port', '0',
], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: fakeHome } })

const events = []
const logLines = []
child.stdout.on('data', (b) => {
  for (const raw of String(b).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    logLines.push(line)
    if (line.startsWith('{')) {
      try {
        const ev = JSON.parse(line)
        events.push(ev)
        if (ev.t === 'install-status') console.log(`[event] ${ev.t} ${ev.phase}`, JSON.stringify(ev).slice(0, 200))
      } catch { /* log line */ }
    }
  }
})
child.stderr.on('data', () => {}) // capture nothing; protocol lines go to stdout

// Watch for the terminal install-status (done/error) — the hardening must
// produce an ERROR quickly, not the old 20-minute silent hang.
const verdict = await new Promise((resolvePromise) => {
  const watch = setInterval(() => {
    const terminal = events.find((e) => e.t === 'install-status' && (e.phase === 'done' || e.phase === 'error'))
    if (terminal) { clearInterval(watch); resolvePromise(terminal) }
    else if (Date.now() - startMs > 240_000) { clearInterval(watch); resolvePromise(null) }
  }, 500)
})

let pass = true
const fail = (msg) => { console.error('FAIL: ' + msg); pass = false }

if (!verdict) {
  fail(`no install-status error within 240s — still hanging (tarball requests: ${tarballRequests})`)
} else {
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
  console.log(`install-status ${verdict.phase} after ${elapsed}s: ${verdict.error || ''}`)
  if (verdict.phase !== 'error') fail(`expected error phase, got ${verdict.phase}`)
  if (!verdict.error) fail('error payload missing')
}
if (tarballRequests === 0) fail('tarball was never requested — fake-registry setup broken')

const failover = logLines.find((l) => /切换备用镜像/.test(l))
if (failover) console.log('failover log present: ' + failover.slice(0, 160))
else fail('missing failover log line (registry X 安装失败 — 正在切换备用镜像)')

console.log(`\n--- summary ---`)
console.log(`tarball fetch attempts (stalled): ${tarballRequests}`)
console.log(`time to install-status error: ${((Date.now() - startMs) / 1000).toFixed(1)}s (old behavior: up to 600s per registry, silently)`)
console.log(pass ? 'PASS: stalled cold install now fails fast with a clear error + failover messaging'
                 : 'FAILED — see above')

child.kill('SIGKILL')
registry.close()
try { child.stdin.destroy() } catch {}
if (!pass) console.log('tmp runtime dir for inspection: ' + runtime)
process.exit(pass ? 0 : 1)
