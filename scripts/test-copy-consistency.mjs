#!/usr/bin/env node
// Copy-consistency gate: every "source → bundled copy" pair in this repo must be
// byte-identical, because tauri packages ONLY the copies under src-tauri/resources.
// A source edit that is not followed by `npm run sync:resources` ships a stale
// asset inside the installer, while every source-side check stays green — that is
// exactly how the plugin-console copy lagged unnoticed (2026-09-06) and why the
// sync discipline used to live in prose only.
//
// Pairs checked (all documented in skills/dsh-preinstalled-plugin-sync and
// ENGINEERING-NOTES.md):
//   1. scripts/server-manager.mjs, scripts/proxy.mjs → src-tauri/resources/manager/
//   2. plugins/<dir>            → src-tauri/resources/plugin/@dsh-desktop/<rel>
//      where <rel> comes from the bundle's own package.json `name` (the source
//      directory name is NOT the package name) — same rule sync-resources.mjs uses
//   3. plugins/preinstalled/<pkg> → src-tauri/resources/preinstalled/<pkg>
//      plus set equality between both directories, so a plugin that was added to
//      plugins/preinstalled but forgotten in the ship list is caught here instead
//      of silently never shipping.
//
// It also guards the SKILL.md frontmatter rule: an UNQUOTED `description` value
// containing an ASCII ": " is parsed by YAML as a nested mapping inside a compact
// mapping, and DSH's skill-filesystem provider then drops the whole file with only
// a server-side warning — the skill disappears from the model's catalog and from
// the user-facing one with no visible error (2026-09-20 incident, two skills).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const fail = (message) => failures.push(message)
const rel = (p) => relative(root, p)

/** Every file under `dir`, relative to it, skipping node_modules. */
function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, base, out)
    else out.push(relative(base, full))
  }
  return out.sort()
}

/** Assert two individual files exist and hold the same bytes. */
function assertSameFile(srcFile, destFile, hint) {
  if (!existsSync(srcFile)) { fail(`${rel(srcFile)} is missing (the source itself is gone)`) ; return }
  if (!existsSync(destFile)) { fail(`${rel(destFile)} is missing (${hint})`); return }
  if (!readFileSync(srcFile).equals(readFileSync(destFile))) {
    fail(`${rel(destFile)} differs from ${rel(srcFile)} (${hint})`)
  }
}

/** Assert `src` and `dest` directories hold the same files with the same bytes. */
function assertIdentical(src, dest, hint) {
  if (!existsSync(dest)) {
    fail(`${rel(dest)} is missing (${hint})`)
    return
  }
  const srcFiles = walk(src)
  const destFiles = walk(dest)
  const onlySrc = srcFiles.filter((f) => !destFiles.includes(f))
  const onlyDest = destFiles.filter((f) => !srcFiles.includes(f))
  if (onlySrc.length) fail(`${rel(dest)} is missing: ${onlySrc.join(', ')} (${hint})`)
  if (onlyDest.length) fail(`${rel(dest)} has extra files not in the source: ${onlyDest.join(', ')} (${hint})`)
  for (const file of srcFiles) {
    if (!destFiles.includes(file)) continue
    const a = readFileSync(join(src, file))
    const b = readFileSync(join(dest, file))
    if (!a.equals(b)) fail(`${rel(dest)}/${file} differs from ${rel(src)}/${file} (${hint})`)
  }
}

// ── 1. manager 真源 → resources/manager 副本 ────────────────────────────────
// 只比这两个文件：sync-resources.mjs 只把 manager 真源拷进 resources/manager，
// scripts/ 下的其它脚本（测试、诊断）本来就不随包。
// 只按"文件清单"比是不够的：manager 的**模块图**里新增一个 helper（如
// upgrade-marker.mjs）而 sync-resources 没带上，源码侧一切绿、打包出来的 manager
// 却在启动 1 秒内 ERR_MODULE_NOT_FOUND 退出（2026-09-25 dev 实机：launcher 直接
// 显示 code:'ERR_MODULE_NOT_FOUND'，shellVersion 0.11.0）。所以这里改成：
//   ① 从 server-manager.mjs 出发做**相对导入闭包**，每个模块都必须在副本里且字节一致；
//   ② 副本里不允许出现闭包之外的 .mjs（防止残留旧模块）。
const managerSrcDir = join(root, 'scripts')
const managerCopyDir = join(root, 'src-tauri', 'resources', 'manager')
const managerModules = new Set()
const collectModules = (file) => {
  if (managerModules.has(file)) return
  managerModules.add(file)
  const text = readFileSync(join(managerSrcDir, file), 'utf8')
  for (const m of text.matchAll(/from\s+'(\.\/[^']+\.mjs)'/g)) collectModules(m[1].slice(2))
}
collectModules('server-manager.mjs')
for (const name of managerModules) {
  assertSameFile(join(managerSrcDir, name), join(managerCopyDir, name),
    `manager 模块图成员 ${name} 必须在 resources/manager 里且字节一致（跑 npm run sync:resources）`)
}
for (const name of readdirSync(managerCopyDir)) {
  if (!name.endsWith('.mjs')) continue
  if (!managerModules.has(name)) fail(`resources/manager/${name} 不在 manager 模块图里（残留副本，应删除）`)
}
// 兼容旧清单：这两个是本仓长期存在的 manager 文件（模块图已覆盖，保留断言语义）
for (const name of ['server-manager.mjs', 'proxy.mjs']) {
  assertSameFile(join(root, 'scripts', name), join(root, 'src-tauri', 'resources', 'manager', name),
    `run: npm run sync:resources (scripts/${name} is the source)`)
}

// ── 2. 桌面客户端插件 → resources/plugin/@dsh-desktop/<rel> ─────────────────
const pluginsDir = join(root, 'plugins')
const clientDestRoot = join(root, 'src-tauri', 'resources', 'plugin', '@dsh-desktop')
for (const dir of readdirSync(pluginsDir)) {
  if (dir === 'preinstalled') continue
  const src = join(pluginsDir, dir)
  if (!statSync(src).isDirectory()) continue
  const pkgPath = join(src, 'package.json')
  if (!existsSync(pkgPath)) {
    fail(`plugins/${dir} has no package.json — sync-resources.mjs would throw on it`)
    continue
  }
  const name = JSON.parse(readFileSync(pkgPath, 'utf8')).name ?? dir
  if (!name.startsWith('@dsh-desktop/')) {
    fail(`plugins/${dir} declares unexpected package name ${name} (expected @dsh-desktop/*)`)
    continue
  }
  const dest = join(clientDestRoot, name.slice('@dsh-desktop/'.length))
  assertIdentical(src, dest, `run: npm run sync:resources (plugins/${dir} is the source)`)
}

// ── 3. 预装插件 → resources/preinstalled/<pkg>（含 ship-list 完整性）────────
const preinstalledSrc = join(pluginsDir, 'preinstalled')
const preinstalledDest = join(root, 'src-tauri', 'resources', 'preinstalled')
if (!existsSync(preinstalledSrc)) fail('plugins/preinstalled is missing')
else {
  const srcNames = readdirSync(preinstalledSrc).filter((n) => statSync(join(preinstalledSrc, n)).isDirectory()).sort()
  const destNames = existsSync(preinstalledDest)
    ? readdirSync(preinstalledDest).filter((n) => statSync(join(preinstalledDest, n)).isDirectory()).sort()
    : []
  for (const name of srcNames) {
    assertIdentical(join(preinstalledSrc, name), join(preinstalledDest, name),
      `run: npm run sync:resources (and check the ship list in scripts/sync-resources.mjs)`)
  }
  for (const name of destNames) {
    if (!srcNames.includes(name)) fail(`src-tauri/resources/preinstalled/${name} has no source under plugins/preinstalled/`)
  }
  for (const name of srcNames) {
    if (!destNames.includes(name)) {
      fail(`plugins/preinstalled/${name} never reached src-tauri/resources/preinstalled/ — is it in the ship list in scripts/sync-resources.mjs?`)
    }
  }
}

// ── 4. SKILL.md frontmatter：未加引号的 description 不得含 ASCII ": " ───────
// 这是上面那套"文件一致"检查查不到的类别：文件本身一致，但 YAML 解析失败 →
// DSH 静默丢弃整个技能。规则与 YAML 规范一致：只有未加引号的标量才会把 ": "
// 读成嵌套 mapping。
const skillsRoot = join(root, '.dsh', 'skills')
if (existsSync(skillsRoot)) {
  for (const dir of readdirSync(skillsRoot)) {
    const file = join(skillsRoot, dir, 'SKILL.md')
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    if (!text.startsWith('---\n')) { fail(`.dsh/skills/${dir}/SKILL.md has no YAML frontmatter block`); continue }
    const end = text.indexOf('\n---', 3)
    const block = end === -1 ? text : text.slice(0, end)
    const line = block.split('\n').find((l) => l.startsWith('description:'))
    if (line === undefined) { fail(`.dsh/skills/${dir}/SKILL.md frontmatter has no description`); continue }
    const value = line.slice('description:'.length).trim()
    const quoted = value.startsWith('"') || value.startsWith("'")
    if (!quoted && value.includes(': ')) {
      fail(`.dsh/skills/${dir}/SKILL.md has an unquoted description containing ": " — `
        + 'YAML reads it as a nested mapping and DSH silently drops the whole skill. '
        + 'Quote the value (escaping inner double quotes as \\") or use a full-width colon.')
    }
  }
}

if (failures.length) {
  console.error(`FAIL — copy consistency (${failures.length} problem${failures.length === 1 ? '' : 's'}):`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log('PASS — copy consistency (manager, client plugins, preinstalled ship list, SKILL.md frontmatter)')
process.exit(0)
