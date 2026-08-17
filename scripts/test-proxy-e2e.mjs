#!/usr/bin/env node
// End-to-end proxy chain test: spawn the REAL manager (fake @deepseek-ai/dsh,
// no network) and verify the built-in forward proxy end to end with a real
// undici fetch:
//   1. a proxied host's HTTPS request lands on the fake upstream proxy
//      (CONNECT e2e.example:443 via the manager's loopback proxy);
//   2. loopback traffic stays DIRECT (NO_PROXY) and never reaches upstream.
// Uses only 127.0.0.1 servers — sandbox-safe.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..')
const manager = join(repoRoot, 'scripts', 'server-manager.mjs')
const resources = join(repoRoot, 'src-tauri', 'resources')

const work = mkdtempSync(join(tmpdir(), 'dsh-e2e-'))
const runtime = join(work, 'runtime')

// ── fake dsh (prints a url line, stays alive) ───────────────────────────────
const dshDir = join(runtime, 'node_modules', '@deepseek-ai', 'dsh')
mkdirSync(join(dshDir, 'lib'), { recursive: true })
writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9-e2e' }))
writeFileSync(join(dshDir, 'lib', 'bin.js'), `process.stdout.write(JSON.stringify({t:'url',url:'http://127.0.0.1:19999'})+'\\n'); setInterval(()=>{},1000)\n`)
writeFileSync(join(work, 'patch.yml'), '- insert:\n    - id: x\n      name: "@dsh-desktop/client-notifications"\n')

// ── fake upstream proxy: records CONNECT, answers tunneled data ─────────────
const upSeen = []
const up = createServer((req, res) => { res.writeHead(200); res.end('u:' + req.url) })
up.on('connect', (req, socket) => {
  upSeen.push(req.url)
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  socket.on('data', () => socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK'))
})
await new Promise((r) => up.listen(0, '127.0.0.1', r))
const upPort = up.address().port

// ── local origin (for the loopback-direct assertion) ────────────────────────
const localSeen = []
const origin = createServer((req, res) => { localSeen.push(req.url); res.writeHead(200); res.end('local:' + req.url) })
await new Promise((r) => origin.listen(0, '127.0.0.1', r))
const originPort = origin.address().port

// ── spawn the manager ───────────────────────────────────────────────────────
const child = spawn(process.execPath, [
  manager, '--runtime-dir', runtime, '--resource-dir', resources,
  '--patch', join(work, 'patch.yml'), '--cwd', work,
], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DSH_DESKTOP_NO_UPDATE: '1' }, windowsHide: true })

const events = []
let buf = ''
child.stdout.on('data', (c) => {
  buf += String(c)
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    try { events.push(JSON.parse(line)) } catch {}
  }
})
const waitFor = (pred, what, ms = 15000) => new Promise((res, rej) => {
  const d = Date.now() + ms
  const tick = () => { const h = events.find(pred); if (h) return res(h); if (Date.now() > d) return rej(new Error(`timeout ${what} seen=${JSON.stringify(events)}`)); setTimeout(tick, 50) }
  tick()
})

const ps = await waitFor((e) => e.t === 'proxy-status', 'proxy-status')
const proxyPort = ps.port
assert.ok(proxyPort > 0, 'manager reports its built-in proxy port')

// Route host `e2e.example` through the fake upstream (live config read).
writeFileSync(join(runtime, 'proxy.json'), JSON.stringify({
  upstream: { enabled: true, host: '127.0.0.1', port: upPort, username: '', password: '' },
  proxiedHosts: ['e2e.example'],
  knownHosts: [],
}, null, 2))

// helper: run one undici fetch under the manager's proxy env
const fetchChild = (script) => new Promise((res) => {
  const c = spawn(process.execPath, ['-e', script], {
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      NO_PROXY: '127.0.0.1,localhost',
    },
  })
  let out = ''
  c.stdout.on('data', (d) => { out += d })
  c.on('exit', (code) => res({ code, out }))
})

// ── scenario 1: proxied host rides manager proxy -> fake upstream ───────────
// (undici's env proxy tunnels even plain http via CONNECT; the fake upstream
// answers tunneled bytes with a canned 200 OK — the full chain still proves
// the request left through the manager's proxy to the configured upstream.)
const proxied = await fetchChild(`fetch('http://e2e.example/chat/completions', { signal: AbortSignal.timeout(4000) }).then(r=>r.text().then(t=>{console.log('BODY='+t); process.exit(0)})).catch(e=>{console.log(e.message); process.exit(1)})`)
assert.equal(proxied.code, 0, 'proxied fetch succeeds end to end')
assert.match(proxied.out, /BODY=OK/, 'response came back through the tunnel (from the fake upstream)')
await new Promise((r) => setTimeout(r, 300)) // let the CONNECT land
assert.ok(upSeen.some((u) => u.startsWith('e2e.example:')), `upstream saw a CONNECT for e2e.example (got ${JSON.stringify(upSeen)})`)

// ── scenario 2: loopback stays direct (never reaches the upstream) ──────────
upSeen.length = 0
const direct = await fetchChild(`fetch('http://127.0.0.1:${originPort}/loop', { signal: AbortSignal.timeout(4000) }).then(r=>r.text().then(t=>{console.log('BODY='+t); process.exit(0)})).catch(e=>{console.log(e.message); process.exit(1)})`)
assert.match(direct.out, /BODY=local:\/loop/, 'loopback fetch reached the local origin directly')
assert.equal(upSeen.length, 0, 'upstream never saw the loopback request')

console.log('PASS — manager proxy chain e2e')
child.kill('SIGTERM')
up.close()
origin.close()
rmSync(work, { recursive: true, force: true })
process.exit(0)
