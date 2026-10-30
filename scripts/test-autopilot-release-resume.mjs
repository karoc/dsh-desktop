#!/usr/bin/env node
// 负向/正向对照：`scripts/dsh-release-autopilot.mjs` 的「停摆版本 PR」兜底（2026-10-30）。
//
// 背景（实录）：autopilot 的入口恒为「本轮检测到新版」；适配 PR 合并后地板==target，dsh-watch 不再报它，
// ⑥–⑧ 就不会自动续走。一次无关 fix 合并留下的 release-please 版本 PR 会一直挂到下一次上游发版
// （#234 从 2026-10-24 停到 10-30，v0.21.0 之后 5 天没有任何新壳）。
//
// 本套件证明「无新版 / 预发布跳过」这两条早退路径上的兜底：
//   正向前置（用 GH_BIN 桩 + DSH_AUTOPILOT_WATCH_JSON 回放探测结果，全程不碰真仓库、不调真 gh）：
//     1. 无新版 + 停摆版本 PR（bot PR 无 check、写域合规）⇒ 合并 → 无构建运行才派发 build.yml → 资产 ≥3，exit 0
//     2. 无新版 + 没有版本 PR ⇒ 什么都不做，exit 0
//     3. 无新版 + 预发布通道目标（alpha 不能自动适配）+ 停摆版本 PR ⇒ 仍然收尾发布（预发布挡住的是适配，不是发布）
//     4. 无新版 + 已有构建运行 ⇒ 不重复派发（避免 cancel-in-progress 取消在跑的构建）
//     5. `--no-release-resume` ⇒ 不合并、不派发
//   负向对照（必须变红/不写）：
//     6. 版本 PR 写域越界（含 scripts/*）⇒ exit 1，绝不合并
//     7. 版本 PR 冲突 ⇒ exit 1，绝不合并
//     8. 查询版本 PR 时 gh 抖动 ⇒ 本轮按无操作处理（exit 0），**不**把无新版轮次记成失败
//     9. `--dry-run` ⇒ 只报告「会做什么」，不合并、不派发
//
// 退出码：0 = 全部断言通过；1 = 有断言失败。
// 只读仓库文件；所有桩、状态、日志都写在临时目录（`--keep` 保留现场）。

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'dsh-release-autopilot.mjs')
const KEEP = process.argv.includes('--keep')
const TMP = mkdtempSync(join(tmpdir(), 'dsh-auto-resume-'))
const STUB = join(TMP, 'gh-stub.mjs')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const eq = (name, expected, actual) => check(name, JSON.stringify(expected) === JSON.stringify(actual), `expected ${JSON.stringify(expected)} / actual ${JSON.stringify(actual)}`)

// ── gh 桩：行为由 <case>/scenario.json 驱动，合并状态存 <case>/state.json，所有调用记进 calls.log ──
writeFileSync(STUB, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.AUTOPILOT_STUB_DIR
const scenario = JSON.parse(readFileSync(join(DIR, 'scenario.json'), 'utf8'))
const statePath = join(DIR, 'state.json')
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const argv = process.argv.slice(2)
appendFileSync(join(DIR, 'calls.log'), JSON.stringify({ argv }) + '\\n')
const out = (obj) => { process.stdout.write(JSON.stringify(obj) + '\\n'); process.exit(0) }
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1) }
const pr = scenario.pr ?? null
const files = (scenario.files ?? []).map((p) => ({ path: p }))
const checks = scenario.checks ?? []
if (argv[0] === 'pr' && argv[1] === 'list') {
  if (scenario.ghListFails) die('gh: Server Error (HTTP 502)')
  if (state.merged || !pr) out([])
  out([{ number: pr.number, title: pr.title, headRefName: pr.headRefName,
    mergeable: scenario.conflicting ? 'CONFLICTING' : 'MERGEABLE', statusCheckRollup: checks, url: pr.url ?? '',
    labels: (scenario.labels ?? []).map((name) => ({ name })) }])
}
if (argv[0] === 'pr' && argv[1] === 'view') {
  const n = Number(argv[2])
  if (!pr || n !== pr.number) die('gh: Not Found (HTTP 404)')
  out({ number: pr.number, title: pr.title, state: state.merged ? 'MERGED' : 'OPEN',
    mergeable: scenario.conflicting ? 'CONFLICTING' : 'MERGEABLE',
    mergeStateStatus: scenario.conflicting ? 'DIRTY' : 'CLEAN',
    statusCheckRollup: checks, url: pr.url ?? '', headRefName: pr.headRefName, files, body: '' })
}
if (argv[0] === 'pr' && argv[1] === 'merge') {
  if (scenario.conflicting) die('gh: pull request is not mergeable')
  state.merged = true
  writeFileSync(statePath, JSON.stringify(state))
  out({ merged: true })
}
if (argv[0] === 'release' && argv[1] === 'list') out(state.merged ? [{ tagName: scenario.tag }] : [])
if (argv[0] === 'release' && argv[1] === 'view') out({ tagName: argv[2], assets: (scenario.assets ?? []).map((n) => ({ name: n })) })
if (argv[0] === 'api') out({ total_count: Number(scenario.buildRuns ?? 0) })
if (argv[0] === 'workflow' && argv[1] === 'run') out({})
if (argv[0] === 'issue' && argv[1] === 'view') out({ comments: [] })
if (argv[0] === 'issue' && argv[1] === 'comment') out({})
die('stub: unsupported gh call: ' + argv.join(' '))
`, 'utf8')
chmodSync(STUB, 0o755)

const NO_TARGET = {
  target: null,
  floor: '0.2.1-rc.5',
  tags: { latest: '0.2.1-rc.5', next: '0.2.1-rc.5', alpha: '0.2.2-alpha.2' },
  kind: 'no-update',
  breached: false,
  threshold: null,
  deadline: null,
}
const BEST_EFFORT = {
  ...NO_TARGET,
  target: '0.2.2-alpha.2',
  kind: 'best-effort 24h（预发布通道）',
  breached: true,
}
const OK_FILES = ['package.json', 'CHANGELOG.md', '.release-please-manifest.json', 'src-tauri/Cargo.toml']
const releasePr = (over = {}) => ({
  pr: {
    number: 900,
    title: 'chore(main): release 0.21.2',
    headRefName: 'release-please--branches--main',
    url: 'https://example.invalid/pr/900',
  },
  files: OK_FILES,
  checks: [],
  tag: 'v0.21.2',
  assets: ['setup.exe', 'app.AppImage', 'app.deb'],
  buildRuns: 0,
  conflicting: false,
  ghListFails: false,
  ...over,
})

function runCase(name, { watch, scenario, extraArgs = [] }) {
  const dir = join(TMP, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario, null, 2))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ merged: false }))
  writeFileSync(join(dir, 'watch.json'), JSON.stringify(watch))
  const jsonPath = join(dir, 'result.json')
  const r = spawnSync(process.execPath, [SCRIPT, '--repo', 'karoc/dsh-desktop', '--poll-seconds', '1',
    '--no-backoff', '--json', jsonPath, ...extraArgs], {
    encoding: 'utf8',
    timeout: 120 * 1000,
    env: {
      ...process.env,
      GH_BIN: STUB,
      GIT_BIN: '/bin/false',
      DSH_AUTOPILOT_WATCH_JSON: join(dir, 'watch.json'),
      AUTOPILOT_STUB_DIR: dir,
      NO_COLOR: '1',
    },
  })
  let result = null
  try { result = JSON.parse(readFileSync(jsonPath, 'utf8')) } catch { /* 留空，由断言报 */ }
  const calls = existsSync(join(dir, 'calls.log'))
    ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  const has = (cmd, sub) => calls.some((c) => c.argv[0] === cmd && (sub === undefined || c.argv[1] === sub))
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  return { status: r.status, output, result, calls, has }
}

console.log(`test-autopilot-release-resume：仓库 ${ROOT}\n临时目录 ${TMP}\n`)

// 1. 无新版 + 停摆版本 PR ⇒ 合并 → 派发构建 → 资产核验
{
  console.log('[1] 无新版 + 停摆版本 PR ⇒ 续走 ⑥–⑧')
  const c = runCase('case1', { watch: NO_TARGET, scenario: releasePr() })
  eq('exit 0', 0, c.status)
  eq('stage = release-resumed', 'release-resumed', c.result?.stage)
  eq('resumed.version', '0.21.2', c.result?.resumed?.version)
  eq('resumed.tag', 'v0.21.2', c.result?.resumed?.tag)
  eq('资产 3 个', 3, c.result?.assets?.length)
  check('合并了版本 PR（pr merge --squash --admin）', c.has('pr', 'merge'))
  check('派发了 build.yml @ v0.21.2', c.calls.some((x) => x.argv[0] === 'workflow' && x.argv.includes('v0.21.2')))
  check('没有回帖 issue（无 target 可归因）', !c.has('issue', 'comment'))
  check('输出里说明是「停摆版本 PR」兜底', /停摆的版本 PR|续走 ⑥–⑧/.test(c.output), c.output.slice(-400))
}

// 2. 无新版 + 没有版本 PR ⇒ 无操作
{
  console.log('\n[2] 无新版 + 没有停摆版本 PR ⇒ 无操作')
  const c = runCase('case2', { watch: NO_TARGET, scenario: { ...releasePr(), pr: null } })
  eq('exit 0', 0, c.status)
  eq('stage = no-update', 'no-update', c.result?.stage)
  eq('resumed = null', null, c.result?.resumed ?? null)
  check('没有合并任何 PR', !c.has('pr', 'merge'))
  check('没有派发构建', !c.has('workflow', 'run'))
  check('输出里写明没有版本 PR', /没有 open 的 release-please 版本 PR/.test(c.output), c.output.slice(-300))
}

// 3. 预发布通道目标 + 停摆版本 PR ⇒ 仍收尾发布（挡住的是适配，不是发布）
{
  console.log('\n[3] 预发布通道目标 + 停摆版本 PR ⇒ 仍收尾发布')
  const c = runCase('case3', { watch: BEST_EFFORT, scenario: releasePr({
    tag: 'v0.21.3',
    pr: { number: 901, title: 'chore(main): release 0.21.3', headRefName: 'release-please--branches--main', url: 'https://example.invalid/pr/901' },
  }) })
  eq('exit 0', 0, c.status)
  eq('stage = release-resumed', 'release-resumed', c.result?.stage)
  eq('resumed.version', '0.21.3', c.result?.resumed?.version)
  check('预发布适配确实被跳过', /预发布通道目标 0\.2\.2-alpha\.2：不自动适配/.test(c.output))
  check('版本 PR 仍被合并', c.has('pr', 'merge'))
}

// 4. 已有构建运行 ⇒ 不重复派发
{
  console.log('\n[4] 已有构建运行 ⇒ 不重复派发')
  const c = runCase('case4', { watch: NO_TARGET, scenario: releasePr({ buildRuns: 1 }) })
  eq('exit 0', 0, c.status)
  check('没有 workflow run', !c.has('workflow', 'run'))
  check('派发步骤如实报「已有构建运行」', /已有 1 次构建运行/.test(c.output), c.output.slice(-300))
  eq('资产仍核验到 3 个', 3, c.result?.assets?.length)
}

// 5. --no-release-resume ⇒ 不合并、不派发
{
  console.log('\n[5] --no-release-resume ⇒ 不合并、不派发')
  const c = runCase('case5', { watch: NO_TARGET, scenario: releasePr(), extraArgs: ['--no-release-resume'] })
  eq('exit 0', 0, c.status)
  eq('stage = no-update', 'no-update', c.result?.stage)
  check('没有合并', !c.has('pr', 'merge'))
  check('开关被如实报告', /--no-release-resume/.test(c.output), c.output.slice(-300))
}

// 6. 写域越界 ⇒ 必须拒绝合并（负向对照）
{
  console.log('\n[6] 版本 PR 写域越界 ⇒ exit 1，绝不合并')
  const c = runCase('case6', { watch: NO_TARGET, scenario: releasePr({ files: [...OK_FILES, 'scripts/evil.mjs'] }) })
  eq('exit 1', 1, c.status)
  check('没有合并', !c.has('pr', 'merge'))
  check('失败原因点名写域', /超出 release-please 写域/.test(c.output), c.output.slice(-400))
}

// 7. 冲突 ⇒ 必须拒绝合并（负向对照）
{
  console.log('\n[7] 版本 PR 冲突 ⇒ exit 1，绝不合并')
  const c = runCase('case7', { watch: NO_TARGET, scenario: releasePr({ conflicting: true }) })
  eq('exit 1', 1, c.status)
  check('没有合并', !c.has('pr', 'merge'))
  check('失败原因点名冲突', /冲突/.test(c.output), c.output.slice(-400))
}

// 8. gh 抖动 ⇒ 无新版轮次按无操作处理（不记失败）
{
  console.log('\n[8] 查询版本 PR 时 gh 抖动 ⇒ exit 0（不把无新版轮次记成失败）')
  const c = runCase('case8', { watch: NO_TARGET, scenario: releasePr({ ghListFails: true }) })
  eq('exit 0', 0, c.status)
  eq('stage = no-update', 'no-update', c.result?.stage)
  check('告警写明查询失败', /查询停摆版本 PR 失败/.test(c.output), c.output.slice(-300))
  check('没有合并/派发', !c.has('pr', 'merge') && !c.has('workflow', 'run'))
}

// 9. --dry-run ⇒ 只报告计划
{
  console.log('\n[9] --dry-run ⇒ 只报告「会做什么」')
  const c = runCase('case9', { watch: NO_TARGET, scenario: releasePr(), extraArgs: ['--dry-run'] })
  eq('exit 0', 0, c.status)
  check('没有合并', !c.has('pr', 'merge'))
  check('没有派发', !c.has('workflow', 'run'))
  check('dry-run 报告会合并版本 PR', /会合并它/.test(c.output), c.output.slice(-400))
}

// 10. release-hold 标签 ⇒ 不合并（人工批次刹车）
{
  console.log('\n[10] release-hold 标签 ⇒ 不合并、不派发（人工决定何时发版）')
  const c = runCase('case10', { watch: NO_TARGET, scenario: releasePr({ labels: ['release-hold'] }) })
  eq('exit 0', 0, c.status)
  eq('stage = no-update', 'no-update', c.result?.stage)
  check('没有合并', !c.has('pr', 'merge'))
  check('没有派发', !c.has('workflow', 'run'))
  check('输出点名 release-hold', /release-hold/.test(c.output), c.output.slice(-300))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.log(`现场保留：${TMP}`)
  process.exit(1)
}
if (!KEEP) console.log('（临时目录随系统清理；--keep 可保留）')
console.log(`现场：${TMP}`)
