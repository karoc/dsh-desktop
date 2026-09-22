#!/usr/bin/env node
// Fetch the pinned Node 24 runtime for the currently running platform into
// src-tauri/resources/node/<platform>/ so `tauri build` can bundle it.
// Idempotent: skips when the binary already exists. Verifies SHA-256 against
// the official SHASUMS256.txt.
//
// Transport: `curl` (with the proxy npm itself uses) when available, else
// `fetch`. Node's fetch ignores npm's `.npmrc` proxy settings and the proxy
// variables are sampled at process start, so a fetch-only downloader cannot
// reach nodejs.org on a network where it is only reachable through the proxy —
// on this machine nodejs.org answers 200 in ~4.6s through the proxy and times
// out direct (2026-09-22). The failure was invisible until now because the
// binary was already cached and the script exits early ("node already present").

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, createReadStream, rmSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = 'https://nodejs.org/dist'
const PINNED_VERSION = process.env.DSH_DESKTOP_NODE_VERSION || 'v24.18.0'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The proxy npm itself would use, as an environment overlay for curl.
 *
 * npm's configured proxy WINS over an inherited variable: an inherited one may
 * point at a proxy that does not route nodejs.org (the desktop shell's own
 * forward proxy does not). `NO_PROXY` keeps loopback direct.
 * @returns an env overlay, empty when npm has no proxy configured.
 */
function npmProxyEnv() {
  const overlay = {}
  for (const [envKey, configKey] of [['HTTPS_PROXY', 'https-proxy'], ['HTTP_PROXY', 'proxy']]) {
    let configured = ''
    try {
      const value = spawnSync('npm', ['config', 'get', configKey], { cwd: root, encoding: 'utf8', timeout: 10_000 }).stdout?.trim() ?? ''
      if (value !== '' && value !== 'null' && value !== 'undefined') configured = value
    } catch { /* npm unavailable: no overlay */ }
    if (configured !== '') overlay[envKey] = configured
  }
  if (Object.keys(overlay).length === 0) return {}
  const noProxy = (process.env.NO_PROXY ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
  for (const host of ['127.0.0.1', 'localhost', '::1']) if (!noProxy.includes(host)) noProxy.push(host)
  overlay.NO_PROXY = noProxy.join(',')
  return overlay
}

const proxyEnv = npmProxyEnv()
if (Object.keys(proxyEnv).length > 0) {
  console.log(`fetch-node: using npm's proxy ${proxyEnv.HTTPS_PROXY ?? proxyEnv.HTTP_PROXY} for downloads`)
}

/** curl exits 127 / ENOENT when it is not installed at all. */
const curlMissing = (result) => result.error?.code === 'ENOENT' || result.status === 127

/** Download a URL to a file with curl. Returns 'ok' | 'no-curl' | an error string. */
function curlDownload(url, dest) {
  const result = spawnSync(
    'curl',
    ['-fsSL', '--max-time', '900', '-o', dest, url],
    { env: { ...process.env, ...proxyEnv }, encoding: 'utf8', maxBuffer: 1024 * 1024 },
  )
  if (curlMissing(result)) return 'no-curl'
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim().split('\n').pop() ?? ''
    return `curl exit ${result.status}${detail === '' ? '' : `: ${detail}`}`
  }
  return 'ok'
}

/** Fetch a small text resource with curl, or null when curl is unavailable. */
function curlText(url) {
  const result = spawnSync(
    'curl',
    ['-fsSL', '--max-time', '120', url],
    { env: { ...process.env, ...proxyEnv }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  )
  if (curlMissing(result)) return null
  if (result.status !== 0) throw new Error(`curl exit ${result.status} for ${url}`)
  return result.stdout
}

async function download(url, dest) {
  const viaCurl = curlDownload(url, dest)
  if (viaCurl === 'ok') return
  if (viaCurl !== 'no-curl') throw new Error(`download failed (${viaCurl}) ${url}`)
  // No curl on PATH: fetch works only when the network needs no proxy.
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

async function fetchText(url) {
  const viaCurl = curlText(url)
  if (viaCurl !== null) return viaCurl
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch failed ${res.status} ${url}`)
  return await res.text()
}

/** The pinned archive for the platform this process runs on. */
function target() {
  const p = process.platform
  const a = process.arch
  if (p === 'win32' && a === 'x64') return { dir: 'win32-x64', name: `node-${PINNED_VERSION}-win-x64.zip`, type: 'zip', bin: 'node.exe' }
  if (p === 'win32' && a === 'arm64') return { dir: 'win32-arm64', name: `node-${PINNED_VERSION}-win-arm64.zip`, type: 'zip', bin: 'node.exe' }
  if (p === 'linux' && a === 'x64') return { dir: 'linux-x64', name: `node-${PINNED_VERSION}-linux-x64.tar.xz`, type: 'tarxz', bin: 'node' }
  if (p === 'linux' && a === 'arm64') return { dir: 'linux-arm64', name: `node-${PINNED_VERSION}-linux-arm64.tar.xz`, type: 'tarxz', bin: 'node' }
  if (p === 'darwin' && a === 'arm64') return { dir: 'darwin-arm64', name: `node-${PINNED_VERSION}-darwin-arm64.tar.gz`, type: 'targz', bin: 'node' }
  if (p === 'darwin' && a === 'x64') return { dir: 'darwin-x64', name: `node-${PINNED_VERSION}-darwin-x64.tar.gz`, type: 'targz', bin: 'node' }
  throw new Error(`unsupported platform: ${p}-${a}`)
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function main() {
  const t = target()
  const outDir = join(root, 'src-tauri', 'resources', 'node', t.dir)
  const binPath = join(outDir, t.bin)
  if (existsSync(binPath)) {
    console.log(`node already present: ${binPath}`)
    return
  }
  mkdirSync(outDir, { recursive: true })

  const downloadDir = join(root, 'src-tauri', 'resources', 'node', '.downloads')
  mkdirSync(downloadDir, { recursive: true })
  const archive = join(downloadDir, t.name)
  const sumUrl = `${SERVER}/${PINNED_VERSION}/SHASUMS256.txt`

  console.log(`downloading ${t.name} …`)
  await download(`${SERVER}/${PINNED_VERSION}/${t.name}`, archive)
  const sums = await fetchText(sumUrl)
  const expected = sums
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.endsWith(` ${t.name}`))
    ?.split(/\s+/)[0]
  if (!expected) throw new Error(`no checksum for ${t.name}`)
  const actual = await sha256(archive)
  if (actual !== expected.toLowerCase()) {
    throw new Error(`sha256 mismatch for ${t.name}: ${actual} != ${expected}`)
  }
  console.log('sha256 verified')

  // Extract. Windows CI has PowerShell; POSIX has tar (tar.xz/.gz).
  if (t.type === 'zip') {
    if (process.platform === 'win32') {
      const ps = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${archive}' -DestinationPath '${downloadDir}' -Force`], { stdio: 'inherit' })
      if (ps.status !== 0) throw new Error('Expand-Archive failed')
      const inner = join(downloadDir, t.name.replace(/\.zip$/, ''))
      cpSync(inner, outDir, { recursive: true, force: true })
      rmSync(inner, { recursive: true, force: true })
    } else {
      // POSIX fallback: p7zip if available, else error with guidance.
      const st = spawnSync('unzip', ['-q', archive, '-d', downloadDir], { stdio: 'inherit' })
      if (st.status !== 0) throw new Error('unzip failed (need unzip for node zip on POSIX)')
      const inner = join(downloadDir, t.name.replace(/\.zip$/, ''))
      cpSync(inner, outDir, { recursive: true, force: true })
      rmSync(inner, { recursive: true, force: true })
    }
  } else {
    const inner = join(downloadDir, t.name.replace(/\.(tar\.xz|tar\.gz)$/, ''))
    const st = spawnSync('tar', [t.type === 'tarxz' ? '-xJf' : '-xzf', archive, '-C', downloadDir], { stdio: 'inherit' })
    if (st.status !== 0) throw new Error('tar extraction failed')
    // Normalize the POSIX layout to the same shape the Windows zip has at its
    // root: <outDir>/node plus <outDir>/node_modules (npm). The tar tree puts
    // the binary at bin/node and npm at lib/node_modules.
    const bin = join(inner, 'bin', t.bin)
    if (existsSync(bin)) {
      cpSync(bin, join(outDir, t.bin), { force: true })
      const npmTree = join(inner, 'lib', 'node_modules')
      if (existsSync(npmTree)) cpSync(npmTree, join(outDir, 'node_modules'), { recursive: true, force: true })
    } else {
      cpSync(inner, outDir, { recursive: true, force: true })
    }
    rmSync(inner, { recursive: true, force: true })
  }
  rmSync(archive, { force: true })
  console.log(`node runtime ready: ${binPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})