#!/usr/bin/env node
// scripts/release-body.mjs — generate the detailed GitHub Release body for a tag.
//
// Why: the previous release job used `gh release create --generate-notes`, which
// collapses a whole release into 2-3 PR-title lines ("What's Changed" 潦草).
// This script composes a body that always states the dsh runtime version (npm
// latest at release time) and the shipped preinstalled plugin versions, then
// appends the FULL changelog section for the tag (every commit, grouped).
//
// Usage: node scripts/release-body.mjs <version>            # prints markdown
//        node scripts/release-body.mjs <version> > body.md
//
// Deterministic parts come from the repo (CHANGELOG.md + plugins/preinstalled/*)
// and from the npm registry (@deepseek-ai/dsh dist-tags). Registry access goes
// through the **npm CLI**, not `fetch`: Node's fetch ignores npm's `.npmrc`
// proxy settings and the proxy variables are sampled at process start, so a
// fetch-based lookup goes direct and returns "unknown" on any proxied network
// (2026-09-22: the same blind spot blocked the turn-navigator publish and made
// audit-preinstalled.mjs report a pass on zero data). A registry failure still
// never fails the release, but the body then SAYS so instead of printing a bare
// `unknown` that reads like a real version.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = process.argv[2]
if (!version) {
  console.error('usage: node scripts/release-body.mjs <version>')
  process.exit(1)
}

// ── 1. the changelog section for this version ─────────────────────────────
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
const lines = changelog.split('\n')
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`))
let section = ''
let compareUrl = ''
if (start >= 0) {
  // The section header carries the compare link, e.g.
  // `## [0.8.0](https://github.com/karoc/dsh-desktop/compare/v0.7.0...v0.8.0) (2026-09-12)`.
  const headerMatch = lines[start].match(/\((\S+)\)/)
  compareUrl = headerMatch ? headerMatch[1] : ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('## ['))
  section = rest.slice(0, end >= 0 ? end : undefined).join('\n').trim()
} else {
  console.error(`[release-body] WARNING: CHANGELOG.md has no section for ${version}`)
}

// ── 2. preinstalled plugin versions shipped in this release ───────────────
const plugins = readdirSync(join(ROOT, 'plugins', 'preinstalled'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, 'plugins', 'preinstalled', d.name, 'package.json'), 'utf8'),
    )
    return [pkg.name, pkg.version]
  })
  .sort((a, b) => a[0].localeCompare(b[0]))

// ── 3. dsh runtime version (npm latest / next at release time) ─────────────
// `npm view` uses the same registry, proxy and auth as an install would.
const REGISTRY = (process.env.DSH_RELEASE_BODY_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '')
let dsh = { latest: 'unknown', next: 'unknown', error: null }
try {
  const tags = JSON.parse(execFileSync(
    'npm',
    ['view', '@deepseek-ai/dsh', 'dist-tags', '--json', '--registry', REGISTRY],
    { cwd: ROOT, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  ))
  dsh.latest = typeof tags?.latest === 'string' ? tags.latest : 'unknown'
  dsh.next = typeof tags?.next === 'string' ? tags.next : null
} catch (error) {
  const text = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join('\n')
  dsh.error = text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? String(error)
  console.error(`[release-body] WARNING: registry lookup failed — dsh version unknown (${dsh.error})`)
}

// ── compose ───────────────────────────────────────────────────────────────
const pluginLine = plugins.map(([n, v]) => `\`${n}\` **${v}**`).join('、')
const nextLine = dsh.next && dsh.next !== dsh.latest ? `（\`next\` 预发布 = ${dsh.next}）` : ''
// A degraded lookup must be visible in the body: a bare "unknown" reads like a
// version, and this text ends up in a permanent GitHub Release.
const dshLine = dsh.latest === 'unknown'
  ? '**内置 dsh**：不随包固定版本——运行时由 manager 从 npm 自动安装/更新（用户门控，见 README「dsh 更新由你决定」）。⚠️ **发版时未能查询 npm registry**，此处的版本号缺失（不影响安装包内容）。'
  : `**内置 dsh**：不随包固定版本——运行时由 manager 从 npm 自动安装/更新（用户门控，见 README「dsh 更新由你决定」）。发版时 npm \`latest\` = **${dsh.latest}**${nextLine}。`

const body = `## 版本概要

${dshLine}

**预装插件**（随包分发、与版本锁定，均为 npm 最新发布版）：${pluginLine}。安装本版本后即随包生效。

**安装包**：Windows NSIS（\`*-x64-setup.exe\`）+ Linux AppImage / deb，见下方 Assets。

## What's Changed

${section || '_（CHANGELOG.md 中未找到本版本的提交清单）_'}

${compareUrl ? `**Full Changelog**: ${compareUrl}` : ''}
`

process.stdout.write(body)
