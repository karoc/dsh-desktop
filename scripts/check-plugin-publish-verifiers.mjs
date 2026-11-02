#!/usr/bin/env node
/**
 * Fleet parity gate for the publish verifiers.
 *
 * The four plugin repos vendored `scripts/post-publish-check.mjs`,
 * `scripts/test-post-publish.mjs` and `scripts/publish.mjs`. They drifted before
 * (model-reasoning/opencode kept a tarball-404-fatal copy for weeks) because
 * nothing compared them. This gate hashes each copy against a checked-in pin
 * file, so changing one repo without syncing the others turns red.
 *
 *   node scripts/check-plugin-publish-verifiers.mjs            # verify
 *   node scripts/check-plugin-publish-verifiers.mjs --update   # re-pin after a
 *                                                              # deliberate sync
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pinsPath = join(root, 'scripts/publish-verifier-pins.json')
const REPOS = ['dsh-turn-nav', 'dsh-model-reasoning', 'dsh-kanban', 'dsh-smoothly-opencode-session', 'dsh-proxy']
const FILES = ['scripts/post-publish-check.mjs', 'scripts/test-post-publish.mjs', 'scripts/publish.mjs']
const update = process.argv.includes('--update')

const pins = {}
const problems = []
for (const repo of REPOS) {
  const repoRoot = resolve(root, '..', repo)
  if (!existsSync(repoRoot)) {
    if (update) continue
    problems.push(`${repo}: checkout not found at ${repoRoot} (sibling checkout required)`)
    continue
  }
  for (const file of FILES) {
    const path = join(repoRoot, file)
    if (!existsSync(path)) {
      problems.push(`${repo}/${file}: missing`)
      continue
    }
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
    if (update) pins[`${repo}/${file}`] = hash
  }
}

if (update) {
  writeFileSync(pinsPath, `${JSON.stringify(pins, null, 2)}\n`)
  console.log(`updated ${pinsPath} (${Object.keys(pins).length} files)`)
  process.exit(0)
}

let pinnedFiles
try {
  pinnedFiles = JSON.parse(readFileSync(pinsPath, 'utf8'))
} catch {
  console.error(`❌ ${pinsPath} is missing — run --update after the deliberate sync`)
  process.exit(1)
}
for (const [key, expected] of Object.entries(pinnedFiles)) {
  const [repo, ...rest] = key.split('/')
  const path = join(resolve(root, '..', repo), rest.join('/'))
  if (!existsSync(path)) {
    problems.push(`${key}: pinned file is gone`)
    continue
  }
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (hash !== expected) problems.push(`${key}: sha256 ${hash.slice(0, 12)}… != pinned ${expected.slice(0, 12)}…`)
}

if (problems.length > 0) {
  console.error('❌ plugin publish verifiers drifted from the pinned canonical copy:')
  for (const problem of problems) console.error(`   - ${problem}`)
  console.error('   sync the canonical copy (dsh-turn-nav) into every repo, then run --update')
  process.exit(1)
}
console.log(`✅ plugin publish verifiers match the pins (${Object.keys(pinnedFiles).length} files across ${REPOS.length} repos)`)
