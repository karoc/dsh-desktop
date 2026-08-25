#!/usr/bin/env node
// Audit the shell-bundled (preinstalled) plugins against the npm latest
// published version. Read-only: only reports what needs updating, never writes.
//
//   node scripts/audit-preinstalled.mjs
//
// Output (one line per plugin):
//   dsh-model-reasoning   bundled 0.1.4  latest 0.2.1  UPDATE
//   dsh-kanban            bundled 0.2.1  latest 0.2.1  up-to-date
//   dsh-turn-navigator    bundled 0.1.1  latest 0.1.1  up-to-date
//
// Baseline convention: sync target = npm latest (published) tarball, per
// .agents/notes/implemented/process/2026-08-25-preinstalled-plugin-sync-v038.md.
// Registry probes use plain fetch (no `npm view` subprocess — it prints E404
// blocks for unpublished versions and needs ~/.npm which the sandbox may deny).
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const preinstalledDir = join(root, 'plugins', 'preinstalled')

// Plugin package names are discovered from each bundle's own package.json
// (dir name may differ from the npm package name — e.g. dsh-turn-nav repo is
// packaged as dsh-turn-navigator). Skip non-bundle dirs (no package.json).
const bundles = []
for (const dir of readdirSync(preinstalledDir)) {
  const pkgJson = join(preinstalledDir, dir, 'package.json')
  try {
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'))
    bundles.push({ dir, name: pkg.name, bundled: pkg.version })
  } catch {
    // Not a plugin bundle — skip.
  }
}

const registryUrl = (name) => `https://registry.npmjs.org/${encodeURIComponent(name)}`

async function latestOf(name) {
  const res = await fetch(registryUrl(name), { headers: { accept: 'application/json' } })
  if (!res.ok) return { latest: null, error: `HTTP ${res.status}` }
  const doc = await res.json()
  return { latest: doc?.['dist-tags']?.latest ?? null, error: null }
}

const rows = await Promise.all(
  bundles.map(async ({ dir, name, bundled }) => {
    const { latest, error } = await latestOf(name)
    return { dir, name, bundled, latest, error }
  }),
)

// Sort: updates first (same order as the shell's preinstalled list otherwise).
rows.sort((a, b) => {
  const au = a.error ? 0 : a.latest !== a.bundled ? 1 : 2
  const bu = b.error ? 0 : b.latest !== b.bundled ? 1 : 2
  return au - bu || a.name.localeCompare(b.name)
})

let anyUpdate = false
for (const { dir, name, bundled, latest, error } of rows) {
  if (error) {
    console.log(`${name.padEnd(22)}  bundled ${bundled.padEnd(7)}  latest <unknown>  ⚠️ ${error}`)
    continue
  }
  const status = latest === bundled ? 'up-to-date' : (anyUpdate = true, 'UPDATE')
  console.log(`${name.padEnd(22)}  bundled ${bundled.padEnd(7)}  latest ${String(latest).padEnd(7)}  ${status}`)
}

if (rows.length === 0) {
  console.log('no preinstalled bundles found under plugins/preinstalled/')
}

const updates = rows.filter((r) => !r.error && r.latest !== r.bundled)
if (updates.length > 0) {
  console.log(`\n${updates.length} plugin(s) need syncing — see skills/dsh-preinstalled-plugin-sync/SKILL.md for the update flow.`)
} else {
  console.log('\nall preinstalled plugins are at the latest published version.')
}
process.exit(anyUpdate ? 0 : 0) // report-only; never a gate
