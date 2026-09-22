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
// Two levels of comparison, because the version check alone has a blind spot:
//
//   1. VERSION — bundled package.json version vs registry `dist-tags.latest`.
//      A version-gated flow ("don't touch a plugin that is already latest")
//      never revisits a same-version bundle, so a hand-edited or partially
//      copied bundle stays invisible here.
//   2. CONTENT — for the assets the shell copies VERBATIM from the tarball
//      (`lib/*.js`, `cordis.patch.yml`, `skills/*/SKILL.md`), compare sha256
//      against the published tarball for the same version. This guards the
//      manual copy step itself: a wrong or partial copy is reported as
//      `content DRIFT` even when the version matches.
//
// It also reports a bundled `skills/*/SKILL.md` whose YAML frontmatter cannot be
// parsed (an unquoted `description` containing ": " is read as a nested mapping,
// and DSH then drops the whole skill with only a server-side warning — 2026-09-20
// incident). That is an UPSTREAM package defect, not a sync gap: syncing cannot
// fix it, only a new package release can.
//
// Baseline convention: sync target = npm latest (published) tarball, per
// .agents/notes/implemented/process/2026-08-25-preinstalled-plugin-sync-v038.md.
//
// Registry access goes through the **npm CLI** (`npm view` / `npm pack`), not
// `fetch`. Node's fetch ignores npm's `.npmrc` proxy settings, and the proxy
// variables plus `NODE_USE_ENV_PROXY` are sampled when the process starts, so a
// fetch-based probe goes DIRECT: on a network where registry.npmjs.org is only
// reachable through the configured proxy every probe failed, `latest` came back
// `<unknown>` for all four bundles, and the script still printed "all
// preinstalled plugins are at the latest published version, with matching
// content" — a pass derived from NO data (2026-09-22). npm's own transport uses
// the same registry, proxy and auth as the `npm publish` that produces the
// baseline. The cache is pinned inside the workspace (`~/.npm` may be denied)
// and the tarball is read through a temp dir that is always removed.
// `DSH_PREINSTALLED_REGISTRY` overrides the registry (default npmjs) and is the
// seam the negative-control test uses to prove an unreachable registry can no
// longer produce a green verdict.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

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
    bundles.push({ dir, path: join(preinstalledDir, dir), name: pkg.name, bundled: pkg.version })
  } catch {
    // Not a plugin bundle — skip.
  }
}

/** The registry this audit checks against (npmjs unless overridden). */
const REGISTRY = (process.env.DSH_PREINSTALLED_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '')
/** npm needs a writable cache; keep it inside the workspace (`~/.npm` may be denied). */
const NPM_CACHE = join(root, '.tmp-investigate', '.npm-cache')

/** First non-empty line of an npm failure — the audit's one-line error surface. */
function firstErrorLine(error) {
  const text = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join('\n')
  return text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? String(error)
}

async function latestOf(name) {
  // A flaky registry must degrade to a report line, never crash the audit:
  // this script is a report tool (always exit 0), not a gate. It must however
  // never *claim* verification it did not do — see the verdict at the bottom.
  try {
    const doc = JSON.parse(execFileSync(
      'npm',
      ['view', name, 'dist-tags.latest', 'dist.tarball', '--json', '--registry', REGISTRY, '--cache', NPM_CACHE],
      { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    ))
    const latest = typeof doc?.['dist-tags.latest'] === 'string' ? doc['dist-tags.latest'] : null
    const tarball = typeof doc?.['dist.tarball'] === 'string' ? doc['dist.tarball'] : null
    if (latest === null) return { latest: null, tarball: null, error: 'registry answered no dist-tags.latest' }
    return { latest, tarball, error: null }
  } catch (error) {
    return { latest: null, tarball: null, error: firstErrorLine(error) }
  }
}

/**
 * Download a published tarball through npm (which honors `.npmrc` proxy/auth).
 * @param name - package name.
 * @param version - the version to fetch.
 * @returns the raw `.tgz` bytes; the temp dir is always removed.
 */
function packTarball(name, version) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-preinstalled-audit-'))
  try {
    execFileSync(
      'npm',
      ['pack', `${name}@${version}`, '--pack-destination', dir, '--registry', REGISTRY, '--cache', NPM_CACHE],
      { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const file = readdirSync(dir).find((entry) => entry.endsWith('.tgz'))
    if (file === undefined) throw new Error('npm pack produced no tarball')
    return readFileSync(join(dir, file))
  } catch (error) {
    throw new Error(firstErrorLine(error))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The assets the shell copies verbatim from the published tarball. */
function isVerbatimAsset(rel) {
  return /^lib\/[^/]+\.js$/.test(rel)
    || rel === 'cordis.patch.yml'
    || /^skills\/[^/]+\/SKILL\.md$/.test(rel)
}

/** Verbatim assets present in a bundle, as paths relative to the bundle. */
function localAssets(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) localAssets(full, base, out)
    else {
      const rel = relative(base, full)
      if (isVerbatimAsset(rel)) out.push(rel)
    }
  }
  return out.sort()
}

/** Read the regular files out of a gzipped npm tarball, keyed without `package/`. */
function untar(gz) {
  const buf = gunzipSync(gz)
  const files = new Map()
  // Field offsets are relative to each 512-byte header block, not to the buffer.
  const field = (header, start, len) => {
    const slice = header.subarray(start, start + len)
    const nul = slice.indexOf(0)
    return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8')
  }
  let offset = 0
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const size = Number.parseInt(field(header, 124, 12).trim(), 8) || 0
    const type = String.fromCharCode(header[156])
    const prefix = field(header, 345, 155)
    const name = prefix === '' ? field(header, 0, 100) : `${prefix}/${field(header, 0, 100)}`
    const dataStart = offset + 512
    if (type === '0' || type === '\0' || type === '') {
      files.set(name.replace(/^package\//, ''), buf.subarray(dataStart, dataStart + size))
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return files
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 12)

/** Report a bundled SKILL.md whose frontmatter DSH would refuse to parse. */
function frontmatterProblem(text) {
  if (!text.startsWith('---\n')) return 'no YAML frontmatter block'
  const end = text.indexOf('\n---', 3)
  const block = end === -1 ? text : text.slice(0, end)
  const line = block.split('\n').find((l) => l.startsWith('description:'))
  if (line === undefined) return 'frontmatter has no description'
  const value = line.slice('description:'.length).trim()
  if (!value.startsWith('"') && !value.startsWith("'") && value.includes(': ')) {
    return 'unquoted description containing ": " (invalid YAML — DSH drops the skill silently)'
  }
  return undefined
}

const rows = await Promise.all(
  bundles.map(async ({ dir, path, name, bundled }) => {
    const { latest, tarball, error } = await latestOf(name)
    const row = { dir, path, name, bundled, latest, tarball, error, content: null, contentError: null, skills: [] }
    // Content comparison runs whenever we know the published tarball — including
    // the same-version case, which is the blind spot this check exists for.
    if (tarball !== null) {
      try {
        const published = untar(packTarball(name, latest))
        row.content = localAssets(path).map((rel) => {
          const local = readFileSync(join(path, rel))
          const remote = published.get(rel)
          return {
            rel,
            status: remote === undefined ? 'not-in-tarball' : (sha(local) === sha(remote) ? 'match' : 'drift'),
          }
        })
      } catch (error) {
        row.contentError = error.message
      }
    }
    for (const rel of localAssets(path)) {
      if (!/^skills\/[^/]+\/SKILL\.md$/.test(rel)) continue
      const problem = frontmatterProblem(readFileSync(join(path, rel), 'utf8'))
      if (problem !== undefined) row.skills.push({ rel, problem })
    }
    return row
  }),
)

// Sort: updates first (same order as the shell's preinstalled list otherwise).
rows.sort((a, b) => {
  const rank = (r) => (r.error ? 0 : r.latest !== r.bundled ? 1 : 2)
  return rank(a) - rank(b) || a.name.localeCompare(b.name)
})

let versionUpdates = 0
let contentDrifts = 0
for (const { name, bundled, latest, error, content, contentError, skills } of rows) {
  if (error) {
    console.log(`${name.padEnd(22)}  bundled ${bundled.padEnd(7)}  latest <unknown>  ⚠️ ${error}`)
  } else {
    const status = latest === bundled ? 'up-to-date' : (versionUpdates++, 'UPDATE')
    console.log(`${name.padEnd(22)}  bundled ${bundled.padEnd(7)}  latest ${String(latest).padEnd(7)}  ${status}`)
  }
  if (contentError !== null) {
    console.log(`${' '.repeat(22)}  content: <unknown>  ⚠️ ${contentError}`)
  } else if (content !== null) {
    const drifted = content.filter((c) => c.status !== 'match')
    if (drifted.length === 0) {
      console.log(`${' '.repeat(22)}  content: ${content.length}/${content.length} verbatim assets match the published tarball`)
    } else {
      contentDrifts += drifted.length
      const detail = drifted.map((c) => (c.status === 'drift' ? `${c.rel} DRIFT` : `${c.rel} not in tarball`)).join(', ')
      console.log(`${' '.repeat(22)}  content: ⚠️ ${detail}`)
    }
  }
  for (const { rel, problem } of skills) {
    console.log(`${' '.repeat(22)}  skill: ⚠️ ${rel} — ${problem} (upstream package defect: needs a new release, not a sync)`)
  }
}

if (rows.length === 0) {
  console.log('no preinstalled bundles found under plugins/preinstalled/')
}

const unverifiable = rows.filter((row) => row.error !== null || row.contentError !== null)
const needsWork = versionUpdates > 0 || contentDrifts > 0
if (needsWork) {
  const parts = []
  if (versionUpdates > 0) parts.push(`${versionUpdates} version update(s)`)
  if (contentDrifts > 0) parts.push(`${contentDrifts} content drift(s)`)
  console.log(`\n${parts.join(' + ')} — see skills/dsh-preinstalled-plugin-sync/SKILL.md for the update flow.`)
} else if (rows.length > 0 && unverifiable.length === 0) {
  console.log('\nall preinstalled plugins are at the latest published version, with matching content.')
} else if (unverifiable.length > 0) {
  // A probe that could not run is a COVERAGE GAP, never a pass: "no updates and
  // no drifts found" is exactly what an unreachable registry produces too.
  console.log(`\n⚠️  NOT VERIFIED — ${unverifiable.length} of ${rows.length} bundle(s) could not be checked against the registry:`)
  for (const row of unverifiable) console.log(`   - ${row.name}: ${row.error ?? row.contentError}`)
  console.log('   Nothing above was compared against a published tarball. Fix registry access and re-run;')
  console.log('   do NOT read this run as "up to date".')
}
process.exit(0) // report-only; never a gate
