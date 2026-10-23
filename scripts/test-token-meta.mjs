#!/usr/bin/env node
// A4（PAT 过期元数据）的可失败门禁。
//
// 为什么需要它：`scripts/lib/token-meta.mjs` 的分级、退出码、每日门控、跃迁式通知全是"看起来对就行"
// 的软逻辑 —— 而这条链的价值恰恰在于**边界**（14 天到底算 warn 还是 ok？warn 该不该让 cron 红？）。
// 所以这里不是"再跑一次看有没有崩"，而是把每个边界钉成可失败断言：
//
//   ① **纯函数**：日期解析（拒绝 2026-02-30）、剩余天数口径（UTC 当日结束）、五级边界、
//      秘密形状守卫。
//   ② **CLI 五级实测**（`set --expires` 造数据 + `--now` 钉住"现在"，可确定性回放）：
//      15 天 ⇒ ok/0、14 天 ⇒ warn/0、7 天 ⇒ urgent/0、1 天 ⇒ critical/**非零**、已过期 ⇒ expired/**非零**。
//      **只有后两级非零**是刻意的：warn 也非零 ⇒ 天天红 ⇒ 人开始忽略 ⇒ 告警失效。
//   ③ **缺失 / 损坏**：`check` 必须输出"未知"且 **exit 0**（没启用功能不是故障），doctor 那行同理。
//   ④ **不含 token**：meta 只有三个字段、mode 600、按 token 形状 grep 计数为 0；`--note` 里粘 token
//      **直接被拒**（exit 2）—— 不是靠"人会记得别粘"。
//   ⑤ **每日门控**：`--if-due` 同日第二次跑 ⇒ `not due`、不重判；隔天恢复判定。
//   ⑥ **通知（gh 桩）**：只在级别跃迁时评论、建单只建一条、不可写时**只打印不重试**、
//      未知不建 issue、回到 ok 评论"已解除"并关闭。
//   ⑦ **变异自证（2 条）**：把退出码表与 warn 边界改坏的**临时副本**必须给出不同的结论 ——
//      证明 ② 的断言真的能失败（恒真断言按缺陷处理）。锚点漂移即失败，不做静默跳过。
//
// 用法：node scripts/test-token-meta.mjs [--keep]（--keep 保留临时目录排障）
// exit：0 全绿；1 任一断言失败。

import { spawnSync } from 'node:child_process'
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EXIT_FOR_LEVEL, LEVEL_UNKNOWN, THRESHOLDS, containsSecretLike, daysLeft, evaluate, expiryEndMs, grade,
  isDue, parseExpiresDate, utcDate,
} from './lib/token-meta.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'scripts', 'dsh-token-meta.mjs')
const LIB = join(ROOT, 'scripts', 'lib', 'token-meta.mjs')
const KEEP = process.argv.includes('--keep')
const TMP = mkdtempSync(join(tmpdir(), 'dsh-token-meta-test-'))
const POSIX = process.platform !== 'win32'

let nOk = 0
let nFail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) {
    nOk += 1
    console.log(`  ok   ${name}`)
  } else {
    nFail += 1
    failures.push(`${name}${detail ? `：${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`)
  }
  return cond
}
const eq = (name, expected, actual) => check(name, String(expected) === String(actual), `期望 ${JSON.stringify(String(expected))}，实际 ${JSON.stringify(String(actual))}`)

// 钉住"现在"：2026-10-24T07:00:00Z。取整天的边界断言都依赖它。
const NOW = '2026-10-24T07:00:00Z'
const NOW_MS = Date.parse(NOW)

// ── gh 桩（只做 --notify 会用到的四个动作 + 有状态记账） ─────────────────────
const STUB_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs')
const argv = process.argv.slice(2)
const file = process.env.STUB_STATE
const st = JSON.parse(fs.readFileSync(file, 'utf8'))
const save = () => fs.writeFileSync(file, JSON.stringify(st, null, 2))
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1) }
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
st.calls.push(argv)
save()   // 先记账再判失败：否则 403 那次的调用会随 die 一起丢掉（本套件要靠它证明"不重试"）
const fail = st.fail || {}
if (!argv.length) die('stub: no args')
if (argv[0] === 'issue' && argv[1] === 'list') {
  if (fail.list) die('HTTP 403: Resource not accessible by personal access token (issues)')
  process.stdout.write(JSON.stringify(st.issues)); save(); process.exit(0)
}
if (argv[0] === 'issue' && argv[1] === 'create') {
  if (fail.create) die('Resource not accessible by personal access token (createIssue)')
  const n = st.nextNumber++
  st.issues.push({ number: n, title: flag('--title'), state: 'OPEN', body: flag('--body'), comments: [] })
  save(); process.stdout.write('https://github.com/o/r/issues/' + n + '\\n'); process.exit(0)
}
if (argv[0] === 'issue' && (argv[1] === 'comment' || argv[1] === 'close' || argv[1] === 'reopen')) {
  const n = Number(argv[2])
  const it = st.issues.find((i) => i.number === n) || die('stub: no such issue ' + n)
  if (argv[1] === 'comment') {
    if (fail.comment) die('Resource not accessible by personal access token (addComment)')
    it.comments.push(flag('--body'))
  }
  if (argv[1] === 'close') it.state = 'CLOSED'
  if (argv[1] === 'reopen') it.state = 'OPEN'
  save(); process.exit(0)
}
die('stub: unsupported command: ' + argv.join(' '))
`
const BIN = join(TMP, 'gh')
const STUB_STATE = join(TMP, 'gh-state.json')
const writeStubState = (extra = {}) => {
  const st = { issues: [], nextNumber: 1, calls: [], fail: {}, ...extra }
  writeFileSync(STUB_STATE, JSON.stringify(st, null, 2))
  return st
}
const readStubState = () => JSON.parse(readFileSync(STUB_STATE, 'utf8'))
if (POSIX) {
  writeFileSync(BIN, STUB_SOURCE)
  chmodSync(BIN, 0o755)
}

// CLI 跑法：隔离 HOME / 显式 --meta-file / --state-file，绝不碰真实 ~/.dsh。
const HOME = join(TMP, 'home')
mkdirSync(HOME, { recursive: true })
let seq = 0
const freshDir = () => {
  seq += 1
  const d = join(TMP, `case-${seq}`)
  mkdirSync(d, { recursive: true })
  return d
}
function run(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env, HOME, GH_TOKEN: '', GITHUB_TOKEN: '', GH_REPO: '', GITHUB_REPOSITORY: '',
      DSH_TOKEN_META: '', DSH_TOKEN_META_STATE: '', GH_BIN: POSIX ? BIN : 'gh', STUB_STATE, ...extraEnv,
    },
    timeout: 60_000,
  })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
}
const metaIn = (dir) => join(dir, 'token.meta.json')
const stateIn = (dir) => join(dir, 'state.json')
const setExpires = (dir, date, extra = []) => run(['set', '--expires', date, '--meta-file', metaIn(dir), ...extra])
const checkAt = (dir, extra = [], env = {}) => run(['check', '--meta-file', metaIn(dir), '--now', NOW, ...extra], env)

// ══ 1. 纯函数 ═══════════════════════════════════════════════════════════════
function unit() {
  console.log('\n── 1. 纯函数：日期解析 / 天数口径 / 五级边界 ───────────────────')
  check('合法日期被接受并归一', parseExpiresDate('2026-11-07').ok && parseExpiresDate('2026-11-07').value === '2026-11-07')
  check('拒绝 2026-02-30（不是合法日历日，不是"格式对就算"）', parseExpiresDate('2026-02-30').ok === false, JSON.stringify(parseExpiresDate('2026-02-30')))
  check('拒绝 2026-13-01 / 2026-1-1 / 空 / 时间戳', ['2026-13-01', '2026-1-1', '', '2026-11-07T00:00:00Z'].every((s) => parseExpiresDate(s).ok === false))
  eq('过期端点 = 该 UTC 日次日 00:00', Date.parse('2026-11-08T00:00:00Z'), expiryEndMs('2026-11-07'))
  check('非法日期的过期端点是 NaN（调用方必须按未知处理）', Number.isNaN(expiryEndMs('nope')))

  // 天数口径：expires 当日的**结束**才算过期
  eq('2026-11-08 ⇒ 剩余 15 整天', 15, daysLeft('2026-11-08', NOW_MS))
  eq('2026-11-07 ⇒ 剩余 14 整天', 14, daysLeft('2026-11-07', NOW_MS))
  eq('2026-10-31 ⇒ 剩余 7 整天', 7, daysLeft('2026-10-31', NOW_MS))
  eq('2026-10-25 ⇒ 剩余 1 整天', 1, daysLeft('2026-10-25', NOW_MS))
  eq('2026-10-24（今天到期，仍有效）⇒ 0 天', 0, daysLeft('2026-10-24', NOW_MS))
  eq('2026-10-23 ⇒ -1（过期 1 天）', -1, daysLeft('2026-10-23', NOW_MS))

  // 五级边界：>14 ok / 8..14 warn / 2..7 urgent / 0..1 critical / <0 expired
  eq('边界 15 ⇒ ok', 'ok', grade(15))
  eq('边界 14 ⇒ warn（用 > 而不是 >=：文档口径就是 14）', 'warn', grade(14))
  eq('边界 8 ⇒ warn', 'warn', grade(8))
  eq('边界 7 ⇒ urgent', 'urgent', grade(7))
  eq('边界 2 ⇒ urgent', 'urgent', grade(2))
  eq('边界 1 ⇒ critical', 'critical', grade(1))
  eq('边界 0 ⇒ critical', 'critical', grade(0))
  eq('边界 -1 ⇒ expired', 'expired', grade(-1))
  eq('阈值常量与文档一致（14/7/1）', '14,7,1', `${THRESHOLDS.warn},${THRESHOLDS.urgent},${THRESHOLDS.critical}`)
  eq('退出码表：只有 critical/expired 非零，unknown 为 0', '0,0,0,1,1,0', ['ok', 'warn', 'urgent', 'critical', 'expired', LEVEL_UNKNOWN].map((l) => EXIT_FOR_LEVEL[l]).join(','))

  check('秘密形状守卫：认得 ghp_ / github_pat_', containsSecretLike('ghp_' + 'A'.repeat(36)) && containsSecretLike('github_pat_' + 'B'.repeat(30)))
  check('秘密形状守卫：不误伤普通备注', !containsSecretLike('创建于 2026-10-01，仓库管理员轮换'))
}

// ══ 2. 五级实测（CLI） ══════════════════════════════════════════════════════
function levels() {
  console.log('\n── 2. 五级实测：set 造数据 + --now 钉住"现在" ──────────────────')
  const cases = [
    ['2026-11-08', 15, 'ok', 0],
    ['2026-11-07', 14, 'warn', 0],
    ['2026-10-31', 7, 'urgent', 0],
    ['2026-10-25', 1, 'critical', 1],
    ['2026-10-23', -1, 'expired', 1],
  ]
  for (const [date, days, level, code] of cases) {
    const dir = freshDir()
    const s = setExpires(dir, date)
    eq(`set ${date} ⇒ exit 0`, 0, s.status)
    const r = checkAt(dir)
    eq(`${days} 天 ⇒ ${level}`, level, r.out.match(/→ (\w+)（/)?.[1] ?? '（没解析出级别）')
    eq(`${date} ⇒ 退出码 ${code}`, code, r.status)
  }
}

// ══ 3. 缺失 / 损坏 ═════════════════════════════════════════════════════════
function unknownPaths() {
  console.log('\n── 3. 缺失 / 损坏 ⇒ 未知 + exit 0（没启用功能不是故障） ─────────')
  const dir = freshDir()
  const missing = checkAt(dir)
  eq('缺失 ⇒ exit 0', 0, missing.status)
  check('缺失 ⇒ 输出"未知（未录入）"', /未知（未录入）/.test(missing.out), missing.out.split('\n')[1])
  check('缺失 ⇒ 给出 set 建议', /dsh-token-meta\.mjs set --expires/.test(missing.out))
  const j1 = checkAt(dir, ['--json'])
  let parsed = null
  try { parsed = JSON.parse(j1.stdout) } catch { /* 下面断言会说 */ }
  eq('缺失 ⇒ --json 的 level = unknown', LEVEL_UNKNOWN, parsed?.level ?? '（JSON 解析失败）')
  eq('缺失 ⇒ --json 的 exitCode = 0', 0, parsed?.exitCode ?? '（JSON 解析失败）')

  for (const [name, body] of [
    ['不是 JSON', '{ this is not json'],
    ['顶层是数组', '[]'],
    ['expiresAt 缺失', '{"note":"x"}'],
    ['expiresAt 非法日期', '{"expiresAt":"2026-02-30"}'],
    ['expiresAt 是时间戳', '{"expiresAt":"2026-11-07T00:00:00Z"}'],
  ]) {
    const d = freshDir()
    writeFileSync(metaIn(d), body)
    const r = checkAt(d)
    eq(`${name} ⇒ 未知`, LEVEL_UNKNOWN, r.out.match(/未知/)?.[0] === '未知' ? LEVEL_UNKNOWN : '（没有"未知"）')
    eq(`${name} ⇒ exit 0`, 0, r.status)
    const j = checkAt(d, ['--json'])
    let p = null
    try { p = JSON.parse(j.stdout) } catch { /* 断言兜底 */ }
    eq(`  ${name} ⇒ --json reason 是 corrupt`, 'corrupt', p?.reason ?? '（JSON 解析失败）')
  }
}

// ══ 4. 文件契约：不含 token / 600 / 只写三个字段 ═════════════════════════════
function fileContract() {
  console.log('\n── 4. meta 文件契约：不含 token、600、只有三个字段 ─────────────')
  const dir = freshDir()
  const s = setExpires(dir, '2027-04-01', ['--note', '创建于 2026-10-24，按季度轮换'])
  eq('带 note 的 set ⇒ exit 0', 0, s.status)
  const raw = readFileSync(metaIn(dir), 'utf8')
  const json = JSON.parse(raw)
  eq('字段**恰好**是 expiresAt/note/recordedAt', 'expiresAt,note,recordedAt', Object.keys(json).sort().join(','))
  eq('token 形状计数为 0（grep -c 语义）', 0, (raw.match(/gh[pousr]_/g) ?? []).length + (raw.match(/github_pat_/g) ?? []).length)
  eq('没有 token 字样键（token/secret/pat）', 0, Object.keys(json).filter((k) => /token|secret|pat/i.test(k)).length)
  if (POSIX) {
    eq('文件权限 600', '600', (statSync(metaIn(dir)).mode & 0o777).toString(8))
    mkdirSync(join(dir, 'deep'), { recursive: true })
    run(['set', '--expires', '2027-01-01', '--meta-file', join(dir, 'deep/nested/meta.json')])
    eq('父目录不存在时自动创建 + 仍是 600', '600', (statSync(join(dir, 'deep/nested/meta.json')).mode & 0o777).toString(8))
  } else {
    console.log('  SKIP 文件权限断言（Windows 没有 POSIX 600）—— 这不是通过')
  }
  const d2 = freshDir()
  const bad = run(['set', '--expires', '2027-01-01', '--note', `token=${'ghp_'}${'Z'.repeat(36)}`, '--meta-file', metaIn(d2)])
  eq('note 里粘 token ⇒ exit 2', 2, bad.status)
  check('note 里粘 token ⇒ 说清"拒绝写入"', /拒绝写入/.test(bad.out), bad.out.trim().split('\n')[0])
  eq('note 里粘 token ⇒ 不落盘', false, existsSync(metaIn(d2)))
  eq('非法 expires ⇒ exit 2', 2, run(['set', '--expires', '2026-02-30', '--meta-file', metaIn(d2)]).status)
  eq('未知 flag ⇒ exit 2', 2, checkAt(freshDir(), ['--bogus']).status)
  eq('缺 --expires ⇒ exit 2', 2, run(['set', '--meta-file', metaIn(d2)]).status)
  eq('没有子命令 ⇒ exit 2', 2, run([]).status)
}

// ══ 5. --quiet ═════════════════════════════════════════════════════════════
function quiet() {
  console.log('\n── 5. --quiet：只在非 ok 时开口 ────────────────────────────────')
  const okDir = freshDir()
  setExpires(okDir, '2027-04-01')
  const q1 = checkAt(okDir, ['--quiet'])
  eq('ok + --quiet ⇒ 退出码 0', 0, q1.status)
  eq('ok + --quiet ⇒ 零输出（安静是常态）', '', q1.stdout.trim())
  const badDir = freshDir()
  setExpires(badDir, '2026-10-25')
  const q2 = checkAt(badDir, ['--quiet'])
  eq('critical + --quiet ⇒ 退出码 1', 1, q2.status)
  check('critical + --quiet ⇒ 仍然打印（否则安静就掩盖了告警）', /critical/.test(q2.out), q2.out.trim().split('\n')[0])
  const unDir = freshDir()
  const q3 = checkAt(unDir, ['--quiet'])
  check('未知 + --quiet ⇒ 仍然打印', /未知/.test(q3.out), q3.out.trim().split('\n')[0])
}

// ══ 6. --if-due 每日门控 ═══════════════════════════════════════════════════
function ifDue() {
  console.log('\n── 6. --if-due：每日门控（同一天只判一次） ─────────────────────')
  const dir = freshDir()
  setExpires(dir, '2026-10-25')
  const r1 = run(['check', '--if-due', '--meta-file', metaIn(dir), '--state-file', stateIn(dir), '--now', NOW])
  eq('第一次跑：真的判了（critical ⇒ 1）', 1, r1.status)
  check('第一次跑：没有 not due', !/not due/.test(r1.out), r1.out.trim().split('\n')[0])
  const r2 = run(['check', '--if-due', '--meta-file', metaIn(dir), '--state-file', stateIn(dir), '--now', '2026-10-24T20:00:00Z'])
  eq('同日第二次跑 ⇒ exit 0（不重判）', 0, r2.status)
  check('同日第二次跑 ⇒ 打印 not due', /not due/.test(r2.out), r2.out.trim().split('\n')[0])
  const r3 = run(['check', '--if-due', '--meta-file', metaIn(dir), '--state-file', stateIn(dir), '--now', '2026-10-25T07:00:00Z'])
  eq('隔天又跑 ⇒ 重新判定（critical ⇒ 1）', 1, r3.status)
  check('隔天再跑：不再 not due', !/not due/.test(r3.out))
  const st = JSON.parse(readFileSync(stateIn(dir), 'utf8'))
  eq('状态文件记录 lastCheckedDate = 隔天', utcDate(Date.parse('2026-10-25T07:00:00Z')), st.lastCheckedDate)
  eq('isDue 的语义：同一天 false / 隔天 true', 'false,true', `${isDue({ lastCheckedDate: utcDate(NOW_MS) }, NOW_MS)},${isDue({ lastCheckedDate: utcDate(NOW_MS) }, NOW_MS + 86400000)}`)
  const fileState = freshDir()
  check('状态文件不存在也算 due（冷启动必须真的判）', isDue({ lastCheckedDate: null }, NOW_MS))
  eq('--dry-run 不写状态文件', false, true === (() => {
    run(['check', '--if-due', '--dry-run', '--meta-file', metaIn(fileState), '--state-file', stateIn(fileState), '--now', NOW])
    return existsSync(stateIn(fileState))
  })())
}

// ══ 7. --notify（gh 桩） ═══════════════════════════════════════════════════
function notify() {
  console.log('\n── 7. --notify：跃迁式评论 / 建单唯一 / 不可写只打印 ───────────')
  if (!POSIX) {
    console.log('  SKIP --notify 组（需要有 shebang 可执行的 gh 桩；Windows 上未执行 —— 这不是通过）')
    return
  }
  const base = ['check', '--notify', '--repo', 'o/r', '--now', NOW]
  // 7.1 首次 warn ⇒ 建单一条，建单本身即通知（不再额外评论）
  const d1 = freshDir()
  writeStubState()
  setExpires(d1, '2026-11-07')
  const n1 = run([...base, '--meta-file', metaIn(d1), '--state-file', stateIn(d1)])
  eq('warn ⇒ 退出码 0（不天天红）', 0, n1.status)
  let st = readStubState()
  eq('warn ⇒ 建单 1 条', 1, st.issues.length)
  eq('warn ⇒ 建单即通知，不额外评论', 0, st.issues[0].comments.length)
  check('建单标题是固定身份', st.issues[0].title === '[automation] PAT 过期元数据（A4）', st.issues[0].title)
  check('建单正文带 marker + @owner', st.issues[0].body.includes('<!-- dsh-token-meta:level=warn -->') && st.issues[0].body.includes('@o '), st.issues[0].body.split('\n')[0])
  check('建单正文说清"为什么只能人工录入"', /没有可读的 REST 端点/.test(st.issues[0].body))

  // 7.2 同一级再跑 ⇒ 不重复建单、不重复评论
  const n2 = run([...base, '--meta-file', metaIn(d1), '--state-file', stateIn(d1)])
  eq('同一级再跑 ⇒ exit 0', 0, n2.status)
  st = readStubState()
  eq('同一级再跑 ⇒ 仍只有 1 条单', 1, st.issues.length)
  eq('同一级再跑 ⇒ 不新增评论', 0, st.issues[0].comments.length)
  check('同一级再跑 ⇒ 明说"不重复评论"', /不重复评论/.test(n2.out), n2.out.trim().split('\n')[0])

  // 7.3 升级 urgent ⇒ 只多一条评论
  setExpires(d1, '2026-10-31')
  const n3 = run([...base, '--meta-file', metaIn(d1), '--state-file', stateIn(d1)])
  st = readStubState()
  eq('跃迁到 urgent ⇒ 只多 1 条评论', 1, st.issues[0].comments.length)
  check('评论带 urgent 的 marker', /dsh-token-meta:level=urgent/.test(st.issues[0].comments[0]))
  eq('跃迁到 urgent ⇒ 仍只有 1 条单', 1, st.issues.length)

  // 7.4 不可写（403）⇒ 只打印、不重试、不建第二条
  const d2 = freshDir()
  writeStubState({ fail: { create: true } })
  setExpires(d2, '2026-10-25')
  const n4 = run([...base, '--meta-file', metaIn(d2), '--state-file', stateIn(d2)])
  eq('建单 403 ⇒ 退出码仍是级别给的 1（critical）', 1, n4.status)
  check('建单 403 ⇒ 打印 403 原因', /403|not accessible/i.test(n4.out), n4.out.trim().split('\n')[0])
  check('建单 403 ⇒ 打印提醒正文（不是静默）', /PAT 过期提醒/.test(n4.out))
  const calls4 = readStubState().calls.filter((c) => c[0] === 'issue' && c[1] === 'create')
  eq('建单 403 ⇒ 只试 1 次（不硬试）', 1, calls4.length)
  eq('建单 403 ⇒ 远端没有单', 0, readStubState().issues.length)

  // 7.5 未知 ⇒ 不建单、不评论
  const d3 = freshDir()
  writeStubState()
  const n5 = run([...base, '--meta-file', metaIn(d3), '--state-file', stateIn(d3)])
  eq('未知 ⇒ exit 0', 0, n5.status)
  eq('未知 ⇒ 远端零对象', 0, readStubState().issues.length)
  check('未知 ⇒ 明说"跳过"', /跳过/.test(n5.out), n5.out.trim().split('\n')[0])

  // 7.6 轮换后回到 ok ⇒ 评论"已解除" + 关闭跟踪单
  const d4 = freshDir()
  writeStubState()
  setExpires(d4, '2026-10-25')
  run([...base, '--meta-file', metaIn(d4), '--state-file', stateIn(d4)])
  setExpires(d4, '2027-04-01')
  const n6 = run([...base, '--meta-file', metaIn(d4), '--state-file', stateIn(d4)])
  eq('回到 ok ⇒ exit 0', 0, n6.status)
  st = readStubState()
  eq('回到 ok ⇒ 跟踪单被关闭', 'CLOSED', st.issues[0].state)
  eq('回到 ok ⇒ 多了一条"已解除"评论', 1, st.issues[0].comments.length)
  check('"已解除"评论带 level=ok marker', /dsh-token-meta:level=ok/.test(st.issues[0].comments[0]))
  const n7 = run([...base, '--meta-file', metaIn(d4), '--state-file', stateIn(d4)])
  eq('已关闭后再跑 ⇒ 不重复评论', 1, readStubState().issues[0].comments.length)
  eq('已关闭后再跑 ⇒ exit 0', 0, n7.status)

  // 7.7 读不到 issue 列表 ⇒ 检查器自身坏（exit 3），不改远端
  const d5 = freshDir()
  writeStubState({ fail: { list: true } })
  setExpires(d5, '2026-10-25')
  const n8 = run([...base, '--meta-file', metaIn(d5), '--state-file', stateIn(d5)])
  eq('读列表失败 ⇒ exit 3（"检查器坏了"≠"token 快过期"）', 3, n8.status)
  eq('读列表失败 ⇒ 零写调用', 0, readStubState().calls.filter((c) => c[1] !== 'list').length)
  check('读列表失败 ⇒ 打印提醒正文兜底', /PAT 过期提醒/.test(n8.out))
  const saved = JSON.parse(readFileSync(stateIn(d5), 'utf8'))
  check('读列表失败 ⇒ 状态文件记下 lastNotifyError（可事后取证）', typeof saved.lastNotifyError === 'string' && saved.lastNotifyError.length > 0, String(saved.lastNotifyError))
}

// ══ 8. 变异自证 ════════════════════════════════════════════════════════════
function mutations() {
  console.log('\n── 8. 变异自证：把判据改坏的副本必须给出不同结论 ───────────────')
  const mutate = (name, file, from, to) => {
    const dir = join(TMP, `mut-${name}`)
    mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true })
    for (const rel of ['lib/token-meta.mjs', 'dsh-token-meta.mjs']) {
      copyFileSync(join(ROOT, 'scripts', rel), join(dir, 'scripts', rel))
    }
    const target = join(dir, 'scripts', file)
    const src = readFileSync(target, 'utf8')
    const n = src.split(from).length - 1
    if (n !== 1) {
      check(`变异锚点在 ${file} 里唯一（锚点漂移 = 门禁失效）`, false, `命中 ${n} 次：${JSON.stringify(from)}`)
      return { dir: null }
    }
    writeFileSync(target, src.replace(from, to))
    return { dir }
  }
  const runIn = (dir, args) => {
    const r = spawnSync(process.execPath, [join(dir, 'scripts', 'dsh-token-meta.mjs'), ...args], {
      encoding: 'utf8', env: { ...process.env, HOME, GH_TOKEN: '', GITHUB_TOKEN: '' }, timeout: 60_000,
    })
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  }

  // M1：把"critical 也非零"改坏 ⇒ 1 天必须变成 exit 0（证明 ② 的退出码断言能失败）
  const m1 = mutate('exit-map', 'lib/token-meta.mjs', "ok: 0, warn: 0, urgent: 0, critical: 1, expired: 1, [LEVEL_UNKNOWN]: 0,", "ok: 0, warn: 0, urgent: 0, critical: 0, expired: 1, [LEVEL_UNKNOWN]: 0,")
  if (m1.dir) {
    const dir = freshDir()
    const set = runIn(m1.dir, ['set', '--expires', '2026-10-25', '--meta-file', metaIn(dir)])
    const r = runIn(m1.dir, ['check', '--meta-file', metaIn(dir), '--now', NOW])
    eq('M1 计数：1 天仍被识别为 critical', 'critical', r.out.match(/→ (\w+)（/)?.[1] ?? '（没解析出级别）')
    check('M1（退出码表被改坏）⇒ 副本对 1 天给出 exit 0 —— 证明本套件的"非零"断言能失败', r.status === 0, `副本 exit ${r.status}`)
    check('M1 对照：真实实现同输入是 exit 1', checkAt(dir).status === 1)
  }

  // M2：把 warn 边界从 `>` 改成 `>=` ⇒ 14 天必须变成 ok（证明边界断言能失败）
  const m2 = mutate('warn-boundary', 'lib/token-meta.mjs', 'if (days > THRESHOLDS.warn) return \'ok\'', 'if (days >= THRESHOLDS.warn) return \'ok\'')
  if (m2.dir) {
    const dir = freshDir()
    runIn(m2.dir, ['set', '--expires', '2026-11-07', '--meta-file', metaIn(dir)])
    const r = runIn(m2.dir, ['check', '--meta-file', metaIn(dir), '--now', NOW])
    check('M2（14 天边界被 >= 吞掉）⇒ 副本给出 ok —— 证明"14 天 ⇒ warn"能失败', /→ ok（/.test(r.out), r.out.split('\n')[1])
    check('M2 对照：真实实现对 14 天给出 warn', /→ warn（/.test(checkAt(dir).out))
  }

  // M3：把"未知也非零"改坏 ⇒ 缺失 meta 必须变成 exit 1（证明"缺失不判红"能失败）
  const m3 = mutate('unknown-exit', 'lib/token-meta.mjs', 'ok: 0, warn: 0, urgent: 0, critical: 1, expired: 1, [LEVEL_UNKNOWN]: 0,', 'ok: 0, warn: 0, urgent: 0, critical: 1, expired: 1, [LEVEL_UNKNOWN]: 1,')
  if (m3.dir) {
    const dir = freshDir()
    const r = runIn(m3.dir, ['check', '--meta-file', metaIn(dir), '--now', NOW])
    check('M3（未知被改成非零）⇒ 副本对缺失 meta 给出 exit 1 —— 证明"缺失不判红"能失败', r.status === 1, `副本 exit ${r.status}`)
    check('M3 对照：真实实现缺失 meta 是 exit 0', checkAt(dir).status === 0)
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────────
console.log('dsh-token-meta 门禁（A4：PAT 过期元数据；零网络、零 gh 真调用）')
console.log(`  临时目录：${TMP}`)
unit()
levels()
unknownPaths()
fileContract()
quiet()
ifDue()
notify()
mutations()

const total = nOk + nFail
console.log(`\n结果：${nOk}/${total} 通过，${nFail} 失败`)
if (nFail > 0) {
  for (const f of failures) console.error(`  - ${f}`)
  console.error(`临时目录（保留供排障）：${TMP}`)
  process.exit(1)
}
if (!KEEP) rmSync(TMP, { recursive: true, force: true })
process.exit(0)
