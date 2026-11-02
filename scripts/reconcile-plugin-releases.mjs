#!/usr/bin/env node
/**
 * Release-record reconciliation: every local plugin tag / CHANGELOG version must
 * exist on the registry. The 2026-11-01 audit found SEVEN tags whose content
 * shipped under a later version but whose version never reached npm.
 *
 *   node scripts/reconcile-plugin-releases.mjs          # report
 *   node scripts/reconcile-plugin-releases.mjs --fail   # exit 1 on any gap
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failMode = process.argv.includes('--fail')
const REPOS = ['dsh-turn-nav', 'dsh-model-reasoning', 'dsh-kanban', 'dsh-smoothly-opencode-session']
let gaps = 0

for (const repo of REPOS) {
  const repoRoot = resolve(root, '..', repo)
  const pkgPath = join(repoRoot, 'package.json')
  if (!existsSync(pkgPath)) { console.log(`${repo}: (no checkout)`); continue }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  let registry = []
  try {
    registry = JSON.parse(execFileSync('npm', ['view', pkg.name, 'versions', '--json'], {
      encoding: 'utf8', env: { ...process.env, npm_config_logs_max: '100' }, timeout: 60000,
    }))
  } catch (error) {
    console.log(`${repo}: registry unreachable (${String(error.message).split('\n')[0]}) — not comparable`)
    continue
  }
  if (!Array.isArray(registry)) registry = [registry]
  const tags = []
  try {
    for (const tag of execFileSync('git', ['tag', '--list', 'v*'], { cwd: repoRoot, encoding: 'utf8' }).split('\n')) {
      const match = /^v(\d+\.\d+\.\d+(?:-[\w.]+)?)$/.exec(tag.trim())
      if (match) tags.push(match[1])
    }
  } catch { /* not a git checkout */ }
  const changelog = join(repoRoot, 'CHANGELOG.md')
  const headings = existsSync(changelog)
    ? [...readFileSync(changelog, 'utf8').matchAll(/^## \[(\d+\.\d+\.\d+(?:-[\w.]+)?)\]/gm)].map((m) => m[1])
    : []
  const missingTags = tags.filter((v) => !registry.includes(v))
  const missingHeadings = headings.filter((v) => !registry.includes(v) && !missingTags.includes(v))
  console.log(`${repo}: registry ${registry.length} versions | tags ${tags.length} | CHANGELOG ${headings.length}`)
  if (missingTags.length > 0) console.log(`   never published (tags): ${missingTags.join(', ')}`)
  if (missingHeadings.length > 0) console.log(`   never published (CHANGELOG): ${missingHeadings.join(', ')}`)
  gaps += missingTags.length + missingHeadings.length
}
console.log(gaps === 0 ? '✅ every tagged/CHANGELOG version exists on npm' : `⚠️ ${gaps} version(s) never reached npm`)
if (failMode && gaps > 0) process.exit(1)
