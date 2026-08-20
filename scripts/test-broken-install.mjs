#!/usr/bin/env node
// Test the broken-install auto-repair in server-manager.mjs end-to-end:
//   * runtime has a HALF-EXTRACTED dsh (package.json present, lib/bin.js
//     missing — a killed reify, exactly the 0.3.1 bug);
//   * a fake registry serves the packument for `npm view`; the dsh install
//     itself runs through the bundled pnpm, which is stubbed to copy a
//     pre-built fake dsh package (lib/bin.js included) into the runtime;
//   * the manager must detect "installed but broken", remove it, reinstall,
//     and successfully LAUNCH dsh.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const NODE = process.env.TEST_NODE || process.execPath
const MANAGER = resolve(process.cwd(), 'scripts/server-manager.mjs')
const RESOURCES = resolve(process.cwd(), 'src-tauri/resources')

const tmp = mkdtempSync(join(tmpdir(), 'dsh-broken-test-'))
const fakeHome = join(tmp, 'home')
mkdirSync(fakeHome, { recursive: true })

// ── pre-built fake @deepseek-ai/dsh package (what the fake pnpm installs) ────
const fakeDshDir = join(tmp, 'fakedsh')
mkdirSync(join(fakeDshDir, 'lib'), { recursive: true })
writeFileSync(join(fakeDshDir, 'package.json'), JSON.stringify({
  name: '@deepseek-ai/dsh',
  version: '9.9.9-new',
  type: 'module',
  bin: { dsh: 'lib/bin.js' },
}, null, 2))
writeFileSync(join(fakeDshDir, 'lib', 'bin.js'), `console.log('dsh web: http://127.0.0.1:12345')\nsetInterval(() => {}, 1000)\n`)

// ── fake pnpm: `pnpm install @deepseek-ai/dsh@X` copies the fake package ─────
// Seeded at the runtime pnpm entry so ensurePnpm skips its npm bootstrap.
const FAKE_PNPM = `
const { cpSync } = require('node:fs')
const { join } = require('node:path')
const i = process.argv.indexOf('install')
const spec = i >= 0 ? process.argv[i + 1] : ''
if (spec && spec.startsWith('@deepseek-ai/dsh')) {
  const src = process.env.DSH_TEST_FAKE_DSH_PKG
  if (src) cpSync(src, join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
  console.log('fake pnpm installed ' + spec)
}
process.exit(0)
`

// ── fake registry: valid packument (for npm view) ────────────────────────────
const registry = createServer((req, res) => {
  const url = req.url || ''
  if (url.includes('/@deepseek-ai%2fdsh') && !url.endsWith('.tgz')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      name: '@deepseek-ai/dsh',
      'dist-tags': { latest: '9.9.9-new' },
      versions: {
        '9.9.9-new': {
          name: '@deepseek-ai/dsh',
          version: '9.9.9-new',
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

// ── runtime with a BROKEN dsh: package.json yes, lib/bin.js no ──────────────
const runtime = join(tmp, 'runtime')
mkdirSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
writeFileSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9-broken' }))
writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: 'dsh-runtime', private: true, version: '0.0.0' }))
// Seed the fake pnpm at the runtime pnpm entry (ensurePnpm detects it and
// skips its npm bootstrap; the pnpm install is then our stub).
mkdirSync(join(runtime, 'node_modules', 'pnpm', 'bin'), { recursive: true })
writeFileSync(join(runtime, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), FAKE_PNPM)
writeFileSync(join(tmp, 'patch.json'), '{}')
if (existsSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib'))) {
  console.error('test setup broken: lib must be absent for a broken install')
  process.exit(2)
}

await new Promise((r) => registry.listen(0, '127.0.0.1', r))

const child = spawn(NODE, [
  MANAGER,
  '--runtime-dir', runtime,
  '--resource-dir', RESOURCES,
  '--patch', join(tmp, 'patch.json'),
  '--cwd', tmp,
  '--home', fakeHome,
  '--registry', `http://127.0.0.1:${registry.address().port}`,
  '--bridge-port', '0',
], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: fakeHome, DSH_DESKTOP_NO_UPDATE: '1', DSH_TEST_FAKE_DSH_PKG: fakeDshDir } })

let output = ''
child.stdout.on('data', (b) => { output += String(b) })
child.stderr.on('data', (b) => { output += String(b) })

// Wait long enough for: gate → remove → pnpm install → launch → dsh "running".
await new Promise((r) => setTimeout(r, 30_000))
try { child.kill('SIGKILL') } catch {}
registry.close()

let pass = true
const show = (k, v) => console.log(`${k}: ${v}`)
show('gate fired (dsh missing or broken)', /dsh missing or broken — installing automatically/.test(output))
show('repair log (broken entry detected)', /dsh 安装不完整（缺启动入口），将重新安装/.test(output))
show('reinstall succeeded (updated to 9.9.9-new)', /updated to 9\.9\.9-new/.test(output))
show('fake pnpm ran', /fake pnpm installed/.test(output))
show('lib/bin.js re-extracted', existsSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')))
show('no launch failure', !/launch failed:/.test(output))
show('dsh stays running (URL reached)', /dsh web: http:\/\/127\.0\.0\.1:12345/.test(output))

if (!/dsh missing or broken — installing automatically/.test(output)) { pass = false; console.error('FAIL: broken install was NOT treated as missing') }
if (!/dsh 安装不完整（缺启动入口），将重新安装/.test(output)) { pass = false; console.error('FAIL: no repair log') }
if (!/updated to 9\.9\.9-new/.test(output)) { pass = false; console.error('FAIL: reinstall did not succeed') }
if (!/fake pnpm installed/.test(output)) { pass = false; console.error('FAIL: pnpm install stub never ran') }
if (!existsSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) { pass = false; console.error('FAIL: lib/bin.js not re-extracted') }
if (/launch failed:/.test(output)) { pass = false; console.error('FAIL: launch still failed after repair') }

if (pass) console.log('\nPASS: broken install auto-repairs (pnpm) and dsh launches')
else console.error('\n--- manager output (tail) ---\n' + output.slice(-2500))
process.exit(pass ? 0 : 1)
