#!/usr/bin/env node
// dsh:adapt —— 把"抬 dsh 地板"的机械动作收成一条命令（自动化方案 P1）。
//
//   node scripts/dsh-adapt.mjs --version 0.2.1-rc.2 [--runtime <dir>] [--dry-run]
//                              [--allow-yellow] [--canary] [--canary-timeout 180]
//
// 每步都有可失败的判据，任一步失败**立即停下**（fail-closed，不静默通过）：
//   1 runtime 里装的 dsh 版本 == 目标版本（安装由产品自身路径完成，见方案 §3.1）
//   2 两份 MIN_DSH_VERSION 同步抬高 + 适配记录写进注释块**内部** + `node --check` 校验（不通过则回滚）
//   3 README 里的地板数值同步（CI 有「改了 manager 必改 README」门禁）
//   4 patch 夹具重采（--update-fixture --runtime）并核对采集版本
//   5 预装插件 peer 兼容（test-plugin-dsh-compat）—— 地板与 bundle 必须同批
//   6 探针非 RED（红色即停；yellow 需显式 --allow-yellow）
//   7 全量门禁（按 package.json 的 test 链逐条跑，等价 CI；本机 npm CLI 不可用，故直接跑 node）
//   8 汇总 + 剩余人工步骤（dev 实机验收 / PR / 发布 / 装机）
//
// **刻意不做**：装候选版本（走 manager 的安装路径，实测 31.9s）、建 PR、发版、装机 —— 这些有对外副作用，
// 由人和产品流程执行。`--canary` 只**读取** dev 实例日志做验收断言，不启动/不杀任何进程。
//
// 幂等：目标版本与地板已一致时，2/3 步报 skip，其余步骤照常校验。

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANAGER_SRC = join(ROOT, 'scripts/server-manager.mjs')
const MANAGER_COPY = join(ROOT, 'src-tauri/resources/manager/server-manager.mjs')
const README = join(ROOT, 'README.md')
const FIXTURE = join(ROOT, 'scripts/fixtures/dsh-web-app-patch-ids.json')
const PATCH_GATE = join(ROOT, 'scripts/test-patch-targets.mjs')
const PLUGIN_GATE = join(ROOT, 'scripts/test-plugin-dsh-compat.mjs')
const PROBE = join(ROOT, 'scripts/dsh-compat-probe.mjs')
const DEFAULT_DEV_RUNTIME = join(process.env.APPDATA ?? '', 'dsh.smoothly.desktop.dev', 'runtime')
const DEFAULT_DEV_LOG = join(process.env.APPDATA ?? '', 'dsh.smoothly.desktop.dev', 'dsh-desktop-session.log')

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}
const TARGET = arg('--version')
const RUNTIME = arg('--runtime', existsSync(DEFAULT_DEV_RUNTIME) ? DEFAULT_DEV_RUNTIME : null)
const DRY = argv.includes('--dry-run')
const ALLOW_YELLOW = argv.includes('--allow-yellow')
const CANARY = argv.includes('--canary')
const CANARY_TIMEOUT = Number(arg('--canary-timeout', '180'))
const DEV_LOG = arg('--dev-log', DEFAULT_DEV_LOG)

if (!TARGET || !RUNTIME) {
  console.error('usage: dsh-adapt.mjs --version <x.y.z[-pre]> [--runtime <dir>] [--dry-run] [--allow-yellow] [--canary]')
  console.error(`  （--runtime 缺省尝试 dev 实例：${DEFAULT_DEV_RUNTIME}）`)
  process.exit(2)
}

const floorOf = (file) => /MIN_DSH_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(file, 'utf8'))?.[1] ?? null
const RUNTIME_PKG = join(RUNTIME, 'node_modules/@deepseek-ai/dsh/package.json')
const PREV_FLOOR = /MIN_DSH_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(MANAGER_SRC, 'utf8'))?.[1] ?? null
const steps = []
const note = (name, status, detail) => {
  steps.push({ name, status, detail })
  const tag = { ok: ' ok ', skip: 'skip', fail: 'FAIL' }[status]
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}`)
}
const abort = (name, detail) => {
  note(name, 'fail', detail)
  summary(1)
}
const summary = (code) => {
  console.log('\n—— 汇总 ——')
  for (const s of steps) console.log(`  ${s.status === 'ok' ? '✓' : s.status === 'skip' ? '·' : '✗'} ${s.name}${s.detail ? `：${s.detail}` : ''}`)
  if (code === 0) {
    console.log('\n下一步（人工/产品流程，脚本刻意不做）：')
    console.log('  1) dev 实机验收：启动 dev 壳后跑 `node scripts/dsh-adapt.mjs --version ' + TARGET + ' --canary`')
    console.log('  2) 提交 + PR（注意：本仓任何提交合并都会触发 release-please 版本 PR）')
    console.log('  3) 合并 → tag 构建 → 装到正式版')
  }
  process.exit(code)
}

console.log(`dsh:adapt 目标 ${TARGET}${DRY ? '（dry-run，不写文件）' : ''}`)
console.log(`  runtime = ${RUNTIME}`)
console.log(`  地板 = ${floorOf(MANAGER_SRC)}（src）/ ${floorOf(MANAGER_COPY)}（随包副本）\n`)

// ── 1. 目标版本必须在 runtime 里真的装着（安装由产品路径完成）─────────────────
if (!existsSync(RUNTIME_PKG)) abort('1 runtime 已装版本', `${RUNTIME} 下没有 @deepseek-ai/dsh`)
const installed = JSON.parse(readFileSync(RUNTIME_PKG, 'utf8')).version
if (installed !== TARGET) {
  abort('1 runtime 已装版本', `runtime 装的是 ${installed}，不是目标 ${TARGET}。先用产品路径装（把地板写进随包 manager 后由 manager 安装），例如 --version ${installed} 可先验证现有版本`)
}
note('1 runtime 已装版本', 'ok', `${installed}`)

// ── 2. 两份地板 + 适配记录（插在注释块内部）+ 语法校验，失败回滚 ─────────────
const LOG_LINE = ` * ${new Date().toISOString().slice(0, 10)} 抬到 ${TARGET}：夹具重采（--update-fixture，runtime 实测 ${TARGET}），\n * README 地板数值同步，预装 bundle 的 peer 由 test-plugin-dsh-compat 校验（地板与 bundle 同批）。\n`
const patchManager = (file) => {
  const before = readFileSync(file, 'utf8')
  const floor = floorOf(file)
  if (floor === TARGET) return { changed: false, text: before }
  if (!floor) throw new Error(`读不到 ${file} 的 MIN_DSH_VERSION`)
  let text = before.replace(`const MIN_DSH_VERSION = '${floor}'`, `const MIN_DSH_VERSION = '${TARGET}'`)
  // 适配记录必须落在 `const MIN_DSH_VERSION` 之前那个注释块**内部**：
  // 插在 `*/` 外面会变成裸文本 ⇒ SyntaxError（本会话真实踩过，只有会执行 manager 的套件抓到）。
  const idx = text.indexOf('const MIN_DSH_VERSION =')
  const open = text.lastIndexOf('/*', idx)
  const close = text.lastIndexOf('*/', idx)
  if (open < 0 || close < 0 || close > idx) throw new Error(`${file} 的 MIN_DSH_VERSION 前找不到完整注释块`)
  text = text.slice(0, close) + LOG_LINE + ' ' + text.slice(close)
  return { changed: true, text }
}
try {
  const patched = [patchManager(MANAGER_SRC), patchManager(MANAGER_COPY)]
  if (!patched[0].changed) {
    note('2 地板（两份）+ 适配记录', 'skip', `已是 ${TARGET}`)
  } else if (DRY) {
    note('2 地板（两份）+ 适配记录', 'skip', `dry-run：将把两份地板改为 ${TARGET} 并追加适配记录`)
  } else {
    for (const [file, p] of [[MANAGER_SRC, patched[0]], [MANAGER_COPY, patched[1]]]) {
      const backup = readFileSync(file, 'utf8')
      writeFileSync(file, p.text)
      const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
      if (check.status !== 0) {
        writeFileSync(file, backup)
        abort('2 地板（两份）+ 适配记录', `node --check 失败已回滚 ${file}：${(check.stderr || '').split('\n')[0].slice(0, 160)}`)
      }
    }
    note('2 地板（两份）+ 适配记录', 'ok', `两份都改为 ${TARGET}，node --check 通过`)
  }
} catch (error) {
  abort('2 地板（两份）+ 适配记录', error.message)
}

// ── 3. README 地板数值同步（只替换**旧地板字符串**，不碰历史版本号与插件版本号）──
{
  const src = readFileSync(README, 'utf8')
  if (PREV_FLOOR === null) {
    note('3 README 地板数值', 'skip', '读不到旧地板，跳过')
  } else if (PREV_FLOOR === TARGET) {
    note('3 README 地板数值', 'skip', `README 已无旧地板 ${PREV_FLOOR}（或本来就一致）`)
  } else {
    const hits = src.split(PREV_FLOOR).length - 1
    if (hits === 0) {
      note('3 README 地板数值', 'skip', `README 里找不到旧地板 ${PREV_FLOOR}；CI 的文档同步门禁要求同 PR 改 README，请人工确认`)
    } else if (DRY) {
      note('3 README 地板数值', 'skip', `dry-run：将把 ${hits} 处 ${PREV_FLOOR} 换成 ${TARGET}`)
    } else {
      writeFileSync(README, src.split(PREV_FLOOR).join(TARGET))
      note('3 README 地板数值', 'ok', `替换 ${hits} 处 ${PREV_FLOOR} → ${TARGET}`)
    }
  }
}

// ── 4. 夹具重采 ───────────────────────────────────────────────────────────
if (DRY) {
  note('4 patch 夹具重采', 'skip', 'dry-run')
} else {
  const out = spawnSync(process.execPath, [PATCH_GATE, '--update-fixture', '--runtime', RUNTIME], { encoding: 'utf8' })
  const fixtureVersion = JSON.parse(readFileSync(FIXTURE, 'utf8')).dshVersion
  if (out.status !== 0 || fixtureVersion !== TARGET) {
    abort('4 patch 夹具重采', `失败或采集版本不对（status=${out.status}, fixture=${fixtureVersion}）：${(out.stdout ?? '').trim().split('\n').slice(-2).join(' | ').slice(0, 200)}`)
  }
  note('4 patch 夹具重采', 'ok', `夹具 dshVersion=${fixtureVersion}，${JSON.parse(readFileSync(FIXTURE, 'utf8')).ids.length} 个 id`)
}

// ── 5. 预装插件 peer 兼容 ──────────────────────────────────────────────────
{
  const out = spawnSync(process.execPath, [PLUGIN_GATE], { encoding: 'utf8' })
  if (out.status !== 0) abort('5 预装插件 peer 兼容', (out.stdout ?? '').trim().split('\n').slice(-2).join(' | ').slice(0, 200))
  note('5 预装插件 peer 兼容', 'ok', 'test-plugin-dsh-compat 通过（地板与四个 bundle 同批）')
}

// ── 6. 探针：RED 即停；yellow 需显式放行 ───────────────────────────────────
{
  const report = join(tmpdir(), `dsh-adapt-probe-${TARGET}.json`)
  const out = spawnSync(process.execPath, [PROBE, '--runtime', RUNTIME, '--json', report], { encoding: 'utf8' })
  const verdict = existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')).verdict : '(no report)'
  try { rmSync(report, { force: true }) } catch { /* ignore */ }
  if (verdict === 'red') abort('6 探针', `RED：${(out.stdout ?? '').split('\n').filter((l) => l.includes('[RED]')).slice(0, 3).join(' | ').slice(0, 240)}`)
  if (verdict === 'yellow' && !ALLOW_YELLOW) abort('6 探针', 'YELLOW：需人工看一眼再显式加 --allow-yellow 重跑')
  note('6 探针', 'ok', `verdict=${verdict.toUpperCase()}`)
}

// ── 7. 全量门禁（按 package.json 的 test 链逐条跑；npm CLI 本机不可用，故直接跑 node）──
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const entries = pkg.scripts.test.split(' && ').map((e) => e.trim())
  let failed = 0
  let ran = 0
  const skipped = []
  for (const raw of entries) {
    let cmd = raw
    const npmRun = /^npm\s+run\s+([\w:.-]+)$/.exec(cmd)
    if (npmRun) cmd = pkg.scripts[npmRun[1]] ?? ''   // 解析一层 npm run 间接
    if (!/^node\s+/.test(cmd)) { skipped.push(raw); continue }  // 非 node 命令（如 cargo 相关）本机跑不了，如实报跳过
    const out = spawnSync(process.execPath, cmd.replace(/^node\s+/, '').split(' '), { encoding: 'utf8', cwd: ROOT })
    ran += 1
    if (out.status !== 0) {
      failed += 1
      console.log(`      FAIL ${raw}`)
      console.log(`      ${(out.stdout ?? '').trim().split('\n').slice(-4).join('\n      ').slice(0, 400)}`)
    }
  }
  if (failed > 0) abort('7 全量门禁', `${failed}/${ran} 套失败`)
  note('7 全量门禁', 'ok', `${ran} 套通过（CI 等价：直接跑 node，不经 npm）${skipped.length ? `；本机跳过 ${skipped.length} 项非 node 命令（CI 覆盖）：${skipped.join(' / ')}` : ''}`)
}

// ── 8. canary 验收（只读 dev 实例日志，不启动/不杀进程）─────────────────────
if (CANARY) {
  if (!existsSync(DEV_LOG)) abort('8 canary 验收', `找不到 dev 日志 ${DEV_LOG}（先启动 dev 壳）`)
  const startSize = readFileSync(DEV_LOG, 'utf8').length
  const need = ['client/log chrome ready', 'client-ready (http)', 'preinstalled bundles:']
  const deadline = Date.now() + CANARY_TIMEOUT * 1000
  let missing = need
  while (Date.now() < deadline) {
    const fresh = readFileSync(DEV_LOG, 'utf8').slice(startSize)
    missing = need.filter((m) => !fresh.includes(m))
    if (missing.length === 0) break
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},5000)'])
  }
  if (missing.length) abort('8 canary 验收', `${CANARY_TIMEOUT}s 内没看到这些标记：${missing.join(' / ')}（确认 dev 壳真的在跑，且日志路径正确）`)
  note('8 canary 验收', 'ok', `chrome ready / client-ready / preinstalled bundles 三个标记齐全（新增行内）`)
} else {
  note('8 canary 验收', 'skip', '未加 --canary（dev 实机验收需 dev 壳在运行）')
}

summary(0)
