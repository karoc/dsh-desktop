#!/usr/bin/env node
// Windows runtime smoke test — release gate.
//
// Boots the REAL manager on an EMPTY runtime (the exact cold-install path from
// the 0.3.x bug reports), lets it install @deepseek-ai/dsh via the bundled
// pnpm from a real registry, then asserts dsh web reports its URL. Catches
// the "install hangs / launch failed: not installed" bug class before release.
//
// Run anywhere the bundled node exists (Windows CI or a local checkout):
//   node scripts/smoke-windows.mjs            # registry default npmjs
//   DSH_SMOKE_REGISTRY=https://registry.npmmirror.com node scripts/smoke-windows.mjs
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(process.cwd())
const BUNDLED_NODE = process.platform === 'win32'
  ? join(repo, 'src-tauri', 'resources', 'node', 'win32-x64', 'node.exe')
  : join(repo, 'src-tauri', 'resources', 'node', 'linux-x64', 'node')
const REGISTRY = process.env.DSH_SMOKE_REGISTRY || 'https://registry.npmjs.org'

if (!(await import('node:fs')).existsSync(BUNDLED_NODE)) {
  console.error(`bundled node missing at ${BUNDLED_NODE} — run 'npm run bundle' (or scripts/fetch-node.mjs) first`)
  process.exit(2)
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
const runtime = join(tmp, 'runtime')
mkdirSync(runtime, { recursive: true })
writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: 'dsh-runtime', private: true, version: '0.0.0' }))
writeFileSync(join(runtime, 'proxy.json'), JSON.stringify({
  upstream: { enabled: false, protocol: 'http', host: '', port: 0, username: '', password: '' },
  proxiedHosts: [], knownHosts: [],
}))
const cacheHome = join(tmp, 'cache-home')
mkdirSync(cacheHome, { recursive: true })
// The REAL overlay patch — dsh rejects anything that is not a top-level YAML
// array of loader patch entries.
const PATCH = join(repo, 'src-tauri', 'resources', 'patch', 'dsh-desktop.patch.yml')

console.log(`smoke: bundled node = ${BUNDLED_NODE}`)
console.log(`smoke: registry = ${REGISTRY}`)
console.log(`smoke: runtime = ${runtime}`)

const child = spawn(BUNDLED_NODE, [
  'scripts/server-manager.mjs',
  '--runtime-dir', runtime,
  '--resource-dir', join(repo, 'src-tauri', 'resources'),
  '--patch', PATCH,
  '--cwd', runtime, // dsh resolves modules from its cwd; runtime dir is proven to work
  // NO --home: manager defaults DSH_HOME to <runtime>/dsh-home, which sits
  // INSIDE the runtime so the profile's module walk-up reaches
  // <runtime>/node_modules and finds the injected plugins (like the real app).
  '--registry', REGISTRY,
  '--bridge-port', '0',
], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: cacheHome, DSH_DESKTOP_NO_UPDATE: '1' } })

let output = ''
let url = null
const onData = (b) => {
  output += String(b)
  const m = String(b).match(/https?:\/\/127\.0\.0\.1:\d+/)
  if (m && !url) url = m[0]
}
child.stdout.on('data', onData)
child.stderr.on('data', onData)

const deadline = Date.now() + 8 * 60_000 // generous: cold install + 590 pkgs
let childExited = false
child.on('exit', () => { childExited = true })
while (!url && !childExited && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000))
}
const elapsed = ((Date.now() - (deadline - 8 * 60_000)) / 1000).toFixed(0)
try { child.kill('SIGKILL') } catch {}

const updated = /updated to /.test(output)
const failed = /auto-install dsh failed|install-status.*"phase":"error"/.test(output)
console.log(`\nsmoke: elapsed ${elapsed}s | dsh installed: ${updated} | URL: ${url} | failed: ${failed}`)
console.log('--- manager tail ---')
console.log(output.split('\n').filter(Boolean).slice(-40).join('\n'))

if (url && updated && !failed) {
  console.log('\nSMOKE PASS: manager cold-installed dsh (pnpm) and dsh web is serving')
  process.exit(0)
}
console.error('\nSMOKE FAIL')
process.exit(1)
