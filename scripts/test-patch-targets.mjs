#!/usr/bin/env node
// 壳 overlay 补丁的"目标行"契约门禁（S1）。
//
// 背景（实测）：`dsh web --patch <file>` 的 overlay 允许用
// `- id: <row>` 覆盖已存在的 loader 行；但**目标行不存在时没有任何日志**
// （stdout/stderr 全静默，服务照常启动）——上游一旦改名，我们的覆盖会
// 静默失效。所以这里做**离线**断言：
//
//   1. overlay 里每个 `- id: <x>` 都必须在 @deepseek-ai/dsh-web-app 的
//      cordis.patch.yml 的 id 集合里（上游改名 → 本门禁变红）；
//   2. 关键覆盖仍存在且语义正确：`ui-sidebar-browser` 必须是 `disabled: false`
//      （0.1.7-rc.2 起上游把它门控到 profile 'desktop'，我们只能用 profile
//      'web'，见 packages/client/ui-sidebar-browser/README.md）。
//
// 上游 id 的来源两种：
//   - 真实模式：`--runtime <dir>` 或环境变量 `DSH_TEST_RUNTIME` 指向一个已安装
//     dsh 的 runtime 目录（本地/真机验证用，最权威）；
//   - fixture 模式（CI 默认）：`scripts/fixtures/dsh-web-app-patch-ids.json`，
//     由 `--update-fixture --runtime <dir>` 从真实安装生成。**抬 dsh 地板时
//     必须刷新它**（fixture 记录了采集来源与版本）。
//
// 负向对照（必须变红）：① overlay 里加一个不存在的 id；② 把
// `disabled: false` 改成 `disabled: true` 或删掉该覆盖。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OVERLAY = join(root, 'src-tauri', 'resources', 'patch', 'dsh-desktop.patch.yml')
const FIXTURE = join(root, 'scripts', 'fixtures', 'dsh-web-app-patch-ids.json')
const UPSTREAM_REL = join('node_modules', '@deepseek-ai', 'dsh-web-app', 'cordis.patch.yml')

const argv = process.argv.slice(2)
const argValue = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const runtimeDir = argValue('--runtime') ?? process.env.DSH_TEST_RUNTIME
const updateFixture = argv.includes('--update-fixture')

/** 从 patch yaml 文本里取所有 `- id: <x>` 的顶层 id（缩进 2 空格的项）。 */
function idsFromPatchYaml(text) {
  const ids = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^- id:\s*([^\s#]+)\s*$/)
    if (m) ids.push(m[1])
  }
  return ids
}

const overlayText = readFileSync(OVERLAY, 'utf8')
const overlayIds = idsFromPatchYaml(overlayText)

// ── 采集/刷新 fixture ──────────────────────────────────────────────────────
if (updateFixture) {
  assert.ok(runtimeDir, '--update-fixture 需要 --runtime <dir>（或 DSH_TEST_RUNTIME）')
  const dshPkg = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const dshVersion = existsSync(dshPkg) ? JSON.parse(readFileSync(dshPkg, 'utf8')).version : null
  // id 集合取自 `--dump-config` 的**扁平化**结果，而不是 package 里的 YAML：
  // 上游很多行是嵌在 group 里的（如 ui-sidebar-browser 缩进 4 空格），而 overlay
  // 的 id 定向覆盖作用于扁平化后的树 —— dump 才是权威口径。
  const dump = execFileSync(process.execPath, [
    join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    '--profile', 'web', '--dump-config',
  ], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, DSH_HOME: mkdtempSync(join(tmpdir(), 'dsh-dump-')) } })
  const payload = {
    note: '由 scripts/test-patch-targets.mjs --update-fixture 生成；抬 dsh 地板时刷新',
    dshVersion,
    capturedFrom: '@deepseek-ai/dsh-web-app/cordis.patch.yml',
    ids: [...new Set(idsFromPatchYaml(dump))].sort(),
  }
  mkdirSync(dirname(FIXTURE), { recursive: true })
  writeFileSync(FIXTURE, JSON.stringify(payload, null, 2) + '\n')
  console.log(`fixture 已更新: ${FIXTURE}（dsh ${dshVersion ?? '?'}，${payload.ids.length} 个 id）`)
  process.exit(0)
}

// ── 取上游 id 集合 ─────────────────────────────────────────────────────────
let upstreamIds
let source
if (runtimeDir !== undefined) {
  const upstreamFile = join(runtimeDir, UPSTREAM_REL)
  assert.ok(existsSync(upstreamFile), `找不到上游 patch 文件: ${upstreamFile}`)
  upstreamIds = new Set(idsFromPatchYaml(readFileSync(upstreamFile, 'utf8')))
  source = `真实安装 ${upstreamFile}`
} else {
  assert.ok(existsSync(FIXTURE), `缺少 fixture: ${FIXTURE}（用 --update-fixture --runtime <dir> 生成）`)
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  upstreamIds = new Set(fixture.ids)
  source = `fixture（采集自 dsh ${fixture.dshVersion ?? '?'}）`
}

let failures = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}\n     ${error.message}`)
  }
}

check('overlay 结构完整（无粘连行、以换行结尾）', () => {
  // 实测教训：`printf >> patch.yml` 时若文件缺末尾换行，会把两个条目粘成一行
  // （`  disabled: false- id: bogus`）→ 解析器少收 id、门禁静默变绿。
  assert.ok(overlayText.endsWith('\n'), 'overlay 必须以换行结尾（否则后续追加会粘成一行）')
  const joined = overlayText.split(/\r?\n/).filter(line => /[^\s#]\s*-\s+id:/.test(line))
  assert.equal(joined.length, 0, `疑似粘连/格式异常的行: ${joined.slice(0, 2).join(' | ')}`)
})

check(`overlay 的 ${overlayIds.length} 个 id 都存在于上游 web-app patch（来源：${source}）`, () => {
  assert.ok(overlayIds.length > 0, 'overlay 里没有 `- id:` 条目（解析失败或文件被清空）')
  const missing = overlayIds.filter(id => !upstreamIds.has(id))
  assert.equal(missing.length, 0,
    `overlay 引用了上游不存在的 id: ${missing.join(', ')} —— 上游可能改名；更新 overlay 或刷新 fixture`)
})

check('关键覆盖 ui-sidebar-browser 仍为 disabled: false', () => {
  const block = overlayText.split(/^\s*-\s+id:/m).find(b => b.startsWith(' ui-sidebar-browser')) ?? ''
  assert.ok(block !== '', 'overlay 里找不到 ui-sidebar-browser 覆盖')
  assert.match(block, /^\s*disabled:\s*false\s*$/m,
    'ui-sidebar-browser 覆盖必须显式 disabled: false（0.1.7 上游默认在 profile web 下停用该页）')
})

if (failures > 0) {
  console.error(`\nFAILED: ${failures} 项`)
  process.exit(1)
}
console.log('\nPASS: overlay 目标行契约')
