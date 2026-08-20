#!/usr/bin/env node
// Test the install-stall safety net in server-manager.mjs against a REAL
// manager process, exercising the reported scenario (empty runtime = cold
// install) with a package manager that STALLS (no output) mid-install:
//   * fake registry serves the packument for `npm view`;
//   * the dsh install runs through the bundled pnpm, stubbed to stall silent
//     on the first attempt and fail fast on the registry-fallback retry;
//   * the manager's no-output stall detector must kill the stuck child and
//     emit a clear install-status error — instead of hanging forever.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const NODE = process.env.TEST_NODE || process.execPath
const MANAGER = resolve(process.cwd(), 'scripts/server-manager.mjs')
const RESOURCES = resolve(process.cwd(), 'src-tauri/resources')

const tmp = mkdtempSync(join(tmpdir(), 'dsh-stall-test-'))
const fakeHome = join(tmp, 'home')
mkdirSync(fakeHome, { recursive: true })

// ── fake pnpm: stall silent on first attempt, fail fast on the retry ─────────
const FAKE_PNPM = `
const { writeFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const marker = join(process.cwd(), '.stall-seen')
console.log('fake pnpm starting')
if (!existsSync(marker)) {
  writeFileSync(marker, '1')
  console.log('fake pnpm stalling (no more output)...')
  setTimeout(() => {}, 1000000)
} else {
  console.error('fake pnpm fail-fast on retry')
  process.exit(1)
}
`

// ── fake registry: valid packument (for npm view) ────────────────────────────
const registry = createServer((req, res) => {
  const url = req.url || ''
  if (url.includes('/@deepseek-ai%2fdsh') && !url.endsWith('.tgz')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      name: '@deepseek-ai/dsh',
      'dist-tags': { latest: '9.9.9-test' },
      versions: {
        '9.9.9-test': {
          name: '@deepseek-ai/dsh',
          version: '9.9.9-test',
          bin: { dsh: 'lib/bin.js' },
          dist: { tarball: `http://127.0.0.1:${registry.address().port}/dsh.tgz` },
        },
      },
    }))
    return
  }
  res.writeHead(404)
  res.end('not found')
})

// ── EMPTY runtime dir: cold install path ─────────────────────────────────────
const runtime = join(tmp, 'runtime')
mkdirSync(runtime, { recursive: true })
writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: 'dsh-runtime', private: true, version: '0.0.0' }))
// Seed the fake pnpm so ensurePnpm skips its npm bootstrap.
mkdirSync(join(runtime, 'node_modules', 'pnpm', 'bin'), { recursive: true })
writeFileSync(join(runtime, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), FAKE_PNPM)
writeFileSync(join(tmp, 'patch.json'), '{}')

await new Promise((r) => registry.listen(0, '127.0.0.1', r))

const startMs = Date.now()
const child = spawn(NODE, [
  MANAGER,
  '--runtime-dir', runtime,
  '--resource-dir', RESOURCES,
  '--patch', join(tmp, 'patch.json'),
  '--cwd', tmp,
  '--home', fakeHome,
  '--registry', `http://127.0.0.1:${registry.address().port}`,
  '--bridge-port', '0',
], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: fakeHome, DSH_DESKTOP_NO_UPDATE: '1' } })

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
        if (ev.t === 'install-status') console.log(`[event] ${ev.t} ${ev.phase}`, JSON.stringify(ev).slice(0, 160))
      } catch { /* log line */ }
    }
  }
})
child.stderr.on('data', () => {})

// Watch for the terminal install-status (done/error). The stall detector fires
// at 180s; the fallback then fails fast — expect error well under the old
// 600s-per-registry silent hang.
const verdict = await new Promise((resolvePromise) => {
  const watch = setInterval(() => {
    const terminal = events.find((e) => e.t === 'install-status' && (e.phase === 'done' || e.phase === 'error'))
    if (terminal) { clearInterval(watch); resolvePromise(terminal) }
    else if (Date.now() - startMs > 260_000) { clearInterval(watch); resolvePromise(null) }
  }, 500)
})

let pass = true
const fail = (msg) => { console.error('FAIL: ' + msg); pass = false }

if (!verdict) {
  fail(`no install-status error within 260s — still hanging`)
} else {
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
  console.log(`install-status ${verdict.phase} after ${elapsed}s: ${verdict.error || ''}`)
  if (verdict.phase !== 'error') fail(`expected error phase, got ${verdict.phase}`)
  if (!verdict.error) fail('error payload missing')
}
const stallMsg = logLines.find((l) => /无任何输出/.test(l))
if (stallMsg) console.log('stall detector fired: ' + stallMsg.slice(0, 120))
else fail('missing the stall-detection message (npm/pnpm 已 N 秒无任何输出)')
if (!/fake pnpm starting/.test(logLines.join('\n'))) fail('fake pnpm never ran')
const failover = logLines.find((l) => /切换备用镜像/.test(l))
if (failover) console.log('failover log present')
else fail('missing failover log line')

console.log(`\n--- summary ---`)
console.log(`time to install-status error: ${((Date.now() - startMs) / 1000).toFixed(1)}s (old behavior: up to 600s per registry, silently)`)
console.log(pass ? 'PASS: stalled install fails fast with a clear error + failover'
                 : 'FAILED — see above')

child.kill('SIGKILL')
registry.close()
try { child.stdin.destroy() } catch {}
if (!pass) console.log('tmp runtime dir for inspection: ' + runtime)
process.exit(pass ? 0 : 1)
