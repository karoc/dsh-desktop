#!/usr/bin/env node
// 负向/正向对照：`scripts/dsh-release-autopilot.mjs` 的「停摆版本 PR」兜底（2026-10-30）。
//
// 背景（实录）：autopilot 的入口恒为「本轮检测到新版」；适配 PR 合并后地板==target，dsh-watch 不再报它，
// ⑥–⑧ 就不会自动续走。一次无关 fix 合并留下的 release-please 版本 PR 会一直挂到下一次上游发版
// （#234 从 2026-10-24 停到 10-30，v0.21.0 之后 5 天没有任何新壳）。
//
// 本套件证明「无新版」早退路径上的兜底，以及「预发布目标不再早退」（2026-11-18 决策变更）的源码契约：
//   正向前置（用 GH_BIN 桩 + DSH_AUTOPILOT_WATCH_JSON 回放探测结果，全程不碰真仓库、不调真 gh）：
//     1. 无新版 + 停摆版本 PR（bot PR 无 check、写域合规）⇒ 合并 → 无构建运行才派发 build.yml → 资产 ≥3，exit 0
//     2. 无新版 + 没有版本 PR ⇒ 什么都不做，exit 0
//     3. 预发布通道目标（alpha）⇒ 通道解析为 alpha、不再出现「不自动适配」早退；源码契约断言跳过分支已移除
//     4. 无新版 + 已有构建运行 ⇒ 不重复派发（避免 cancel-in-progress 取消在跑的构建）
//     5. `--no-release-resume` ⇒ 不合并、不派发
//   负向对照（必须变红/不写）：
//     6. 版本 PR 写域越界（含 scripts/*）⇒ exit 1，绝不合并
//     7. 版本 PR 冲突 ⇒ exit 1，绝不合并
//     8. 查询版本 PR 时 gh 抖动 ⇒ 本轮按无操作处理（exit 0），**不**把无新版轮次记成失败
//     9. `--dry-run` ⇒ 只报告「会做什么」，不合并、不派发（且**不加 flock 锁**）
//   单实例锁 + 诊断（2026-11-16 新增：手工轮次与 timer 轮次并发 ⇒ 门禁假红；tail(3) 截掉根因首行）：
//    11. 另一个实例**真持锁** ⇒ 本轮打印「另一实例在跑」+ exit 0、零 gh 调用（不是失败、不写）
//    12. 子进程失败是多行 ssh 错误 ⇒ 文案含**首行**（旧实现只留末 3 行）、完整 stderr 落盘到
//        `<state-dir>/<tool>.detail.log` 并把路径打印出来
//
// 退出码：0 = 全部断言通过；1 = 有断言失败。
// 只读仓库文件；所有桩、状态、日志都写在临时目录（`--keep` 保留现场）。

import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
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
// 可选：本调用先同步睡 N 毫秒（并发 flock 用例要一个"持锁且正在干活"的实例）。
// 用 Atomics.wait 同步睡眠，不依赖事件循环/定时器。
if (scenario.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(scenario.sleepMs))
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
if (argv[0] === 'release' && argv[1] === 'view') out({ tagName: argv[2], assets: (scenario.assets ?? []).map((n) => ({ name: n, size: 1024, digest: 'sha256:' + 'a'.repeat(64) })) })
if (argv[0] === 'api') out({ total_count: Number(scenario.buildRuns ?? 0) })
if (argv[0] === 'workflow' && argv[1] === 'run') {
  // 诊断用例：派发构建失败时给一段多行 ssh 错误（首行是根因，末 3 行是"请确认权限"那类尾巴）。
  if (scenario.workflowRunStderr) die(scenario.workflowRunStderr)
  out({})
}
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
const ALPHA = {
  ...NO_TARGET,
  target: '0.2.2-alpha.2',
  channel: 'alpha',
  kind: 'SLA 6h（alpha 通道）',
  threshold: 6,
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
  assets: ['DSH.Smoothly.Desktop_0.21.3_x64-setup.exe', 'DSH.Smoothly.Desktop_0.21.3_amd64.AppImage', 'DSH.Smoothly.Desktop_0.21.3_amd64.deb'],
  buildRuns: 0,
  conflicting: false,
  ghListFails: false,
  ...over,
})

function runCase(name, { watch, scenario, extraArgs = [], stateDir = null }) {
  const dir = join(TMP, name)
  mkdirSync(dir, { recursive: true })
  // 状态 / 锁 / 失败明细一律收进临时目录：测试不碰 ~/.dsh，也不与真实 timer 抢真实锁。
  const sd = stateDir ?? join(dir, 'state')
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario, null, 2))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ merged: false }))
  writeFileSync(join(dir, 'watch.json'), JSON.stringify(watch))
  const jsonPath = join(dir, 'result.json')
  const r = spawnSync(process.execPath, [SCRIPT, '--repo', 'karoc/dsh-desktop', '--poll-seconds', '1',
    '--no-backoff', '--state-dir', sd, '--json', jsonPath, ...extraArgs], {
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

// 同步等待：主线程跑 spawnSync 时事件循环不转 ⇒ 用 Atomics.wait 而不是 setTimeout/Promise。
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms))
function waitFor(fn, timeoutMs = 15000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { if (fn()) return true } catch { /* 文件/行还没出现 */ }
    if (Date.now() >= deadline) return false
    sleepSync(stepMs)
  }
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

// 3. 预发布通道目标（alpha）⇒ 不再早退（2026-11-18：所有通道都适配）
{
  console.log('\n[3] 预发布通道目标（alpha）⇒ 不再早退')
  const c = runCase('case3', { watch: ALPHA, scenario: releasePr({ pr: null }), extraArgs: ['--dry-run'] })
  eq('exit 0', 0, c.status)
  check('dry-run 计划里通道解析为 alpha', /通道 alpha/.test(c.output), c.output.slice(-400))
  check('输出不再包含「不自动适配」早退', !/不自动适配|pre-release-skip/.test(c.output), c.output.slice(-300))
  const src = readFileSync(SCRIPT, 'utf8')
  check('源码契约：预发布跳过分支已移除', !/pre-release-skip/.test(src) && !/不自动适配/.test(src))
  check('源码契约：通道优先读 watch 的 channel 字段', /raw\.channel/.test(src))
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
  check('--dry-run 不加 flock 锁（输出里没有「已获取本机独占锁」）', !c.output.includes('已获取本机独占锁'), c.output.slice(-300))
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

// 11. 单实例 flock：另一个实例真持锁 ⇒ 打印「另一实例在跑」+ exit 0、零 gh 调用
{
  console.log('\n[11] 单实例 flock：另一个实例持锁 ⇒ 本轮打印跳过 + exit 0（不记失败）')
  const sd = join(TMP, 'case11-state')
  const aDir = join(TMP, 'case11-a')
  mkdirSync(aDir, { recursive: true })
  // A = 持锁实例：无新版 + `gh pr list` 桩里同步睡 4s ⇒ 整个 4s 都握着锁。
  writeFileSync(join(aDir, 'scenario.json'), JSON.stringify({ ...releasePr(), pr: null, sleepMs: 4000 }))
  writeFileSync(join(aDir, 'state.json'), JSON.stringify({ merged: false }))
  writeFileSync(join(aDir, 'watch.json'), JSON.stringify(NO_TARGET))
  const aOut = join(aDir, 'stdout.log')
  const aMarker = join(aDir, 'exit.code')
  const wrapper = join(aDir, 'run-and-mark.mjs')
  // A 是异步起的：主线程随后要跑 spawnSync(B)，等不到 'exit' 事件 ⇒ 用 wrapper 把退出码落到文件。
  writeFileSync(wrapper, "import { spawnSync } from 'node:child_process'\nimport { writeFileSync } from 'node:fs'\n"
    + "const [marker, ...rest] = process.argv.slice(2)\n"
    + "const r = spawnSync(process.execPath, rest, { stdio: 'inherit' })\n"
    + "writeFileSync(marker, String(r.status))\n")
  const fd = openSync(aOut, 'a')
  const holder = spawn(process.execPath, [wrapper, aMarker, SCRIPT, '--repo', 'karoc/dsh-desktop',
    '--poll-seconds', '1', '--no-backoff', '--state-dir', sd, '--json', join(aDir, 'result.json')], {
    cwd: ROOT,
    stdio: ['ignore', fd, fd],
    env: {
      ...process.env,
      GH_BIN: STUB,
      GIT_BIN: '/bin/false',
      DSH_AUTOPILOT_WATCH_JSON: join(aDir, 'watch.json'),
      AUTOPILOT_STUB_DIR: aDir,
      NO_COLOR: '1',
    },
  })
  // 判据是「A 真的在锁内」：那行只在 flock 子进程里打印。
  const gotLock = waitFor(() => readFileSync(aOut, 'utf8').includes('已获取本机独占锁'), 20000)
  const b = runCase('case11-b', { watch: NO_TARGET, scenario: { ...releasePr(), pr: null }, stateDir: sd })
  const aDone = waitFor(() => existsSync(aMarker), 30000)
  if (!aDone) holder.kill('SIGKILL')
  closeSync(fd)
  const aExit = aDone ? Number(readFileSync(aMarker, 'utf8')) : null
  const aText = readFileSync(aOut, 'utf8')
  eq('持锁实例 A 先拿到锁（flock 生效，不是测试假锁）', true, gotLock)
  eq('第二个实例 exit 0（锁被占不是失败，systemd 不该记红）', 0, b.status)
  check('第二个实例打印「另一实例在跑」+ skipped by lock', /skipped by lock/.test(b.output) && /另一实例在跑/.test(b.output), b.output.slice(-400))
  eq('第二个实例 stage = skipped-lock', 'skipped-lock', b.result?.stage)
  check('第二个实例零 gh 调用（没干活就没写）', b.calls.length === 0, JSON.stringify(b.calls.slice(0, 3)))
  eq('持锁实例 A 正常走完 exit 0', 0, aExit)
  check('A 明确打印持锁一行（证明走的是 flock 路径）', aText.includes('已获取本机独占锁'), aText.slice(0, 300))
}

// 12. 诊断不再截断：多行 ssh 错误 ⇒ 首行保留 + 完整 stderr 落 <state-dir>/<tool>.detail.log
{
  console.log('\n[12] 子进程失败诊断：首行保留 + 完整 stderr 落 <state-dir>/<tool>.detail.log')
  const sshErr = [
    'ssh: connect to host github.com port 22: Connection timed out',
    'debug1: Connecting to github.com [140.82.112.3] port 22.',
    'debug1: connect to address 140.82.112.3 port 22: Connection timed out',
    'fatal: Could not read from remote repository.',
    '',
    'Please make sure you have the correct access rights',
    'and the repository exists.',
  ].join('\n')
  const c = runCase('case12', { watch: NO_TARGET, scenario: releasePr({ workflowRunStderr: sshErr }) })
  eq('exit 1（派发构建真的失败了）', 1, c.status)
  check('错误文案含**首行**根因（旧实现只留末 3 行，正好把它截掉）', c.output.includes('ssh: connect to host github.com port 22'), c.output.slice(-600))
  check('中间省略用 … 标出（不假装这是全部输出）', c.output.includes('…'))
  check('末行仍在（末 3 行仍然保留）', c.output.includes('and the repository exists'))
  check('被省略的中间行不进摘要（证明是首行+末 3 行而不是全量）', !c.output.includes('debug1: connect to address'), c.output.slice(-600))
  const m = /完整输出：([^\s）]+)/.exec(c.output)
  check('错误文案打印了 detail.log 路径', Boolean(m), c.output.slice(-600))
  const detail = m ? m[1] : ''
  check('detail.log = <state-dir>/<tool>.detail.log（tool 取被调命令名）', /(^|[\\/])state[\\/]gh-stub\.detail\.log$/.test(detail), detail)
  const wrote = Boolean(detail) && existsSync(detail)
  check('detail.log 真的落盘了', wrote, detail)
  const text = wrote ? readFileSync(detail, 'utf8') : ''
  check('detail.log 含完整 stderr（含摘要省略掉的 debug1 行）',
    text.includes('debug1: connect to address 140.82.112.3 port 22')
      && text.includes('ssh: connect to host github.com port 22')
      && text.includes('and the repository exists'), text.slice(0, 300))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.log(`现场保留：${TMP}`)
  process.exit(1)
}
if (!KEEP) console.log('（临时目录随系统清理；--keep 可保留）')
console.log(`现场：${TMP}`)
