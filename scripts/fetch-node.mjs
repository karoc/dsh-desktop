#!/usr/bin/env node
// Fetch the pinned Node 24 runtime for the currently running platform into
// src-tauri/resources/node/<platform>/ so `tauri build` can bundle it.
// Idempotent: skips when the binary already exists. Verifies SHA-256 against
// the official SHASUMS256.txt.

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

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
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
  const sums = await (await fetch(sumUrl)).text()
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