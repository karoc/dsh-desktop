#!/usr/bin/env node
// A6（三态 + 指数退避 + 只在跃迁时通知）的可失败门禁。
//
// 两半：
//   ① **纯函数单测**：`scripts/lib/backoff-state.mjs` 的退避序列/封顶、三态跃迁、不可重试错误、
//      状态文件损坏 fail-open、心跳有界 —— 不需要网络、gh、GitHub。
//   ② **8 轮实测（集成）**：同一个失败连续发生 8 轮，用 gh/curl **桩**（临时目录 + PATH/GH_BIN 注入）
//      断言"噪声式降级"真的没了：
//        · 第 1–2 轮：仍打印完整错误（degraded 的诊断窗口）；
//        · 第 3 轮：进入 broken，评论**只**有 2 条跃迁（degraded、broken）；
//        · 第 4–8 轮：stdout **只有一行** `still broken (attempt k, next retry in Xm)`，且退避按
//          5 → 10 → 20 → 40 分钟放大、跳过的轮次 exit 0（不与 systemd 的 restart 叠成热循环）；
//        · 恢复：只多 1 条 `broken → healthy` 跃迁评论，状态清零；
//        · `--reset-state`：回到 healthy，且**不写 GitHub**；
//        · 心跳文件每轮一行（`skipped=yes/no`）—— 反向心跳据此区分"在退避"与"死了"。
//   ③ **负向对照（必须能红）**：同一串失败加 `--no-backoff` ⇒ 8 轮全都重印完整错误、0 条跃迁评论、
//      不产生状态文件。如果这条对照变绿，说明上面 ② 的断言已经无法失败（假门禁）。
//
// 用法：node scripts/test-backoff-state.mjs [--keep]（--keep 保留临时目录排障）
// exit：0 全绿；1 任一断言失败。

import { spawnSync } from 'node:child_process'
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BACKOFF_SCHEDULE_MIN, DEFAULT_THRESHOLD, MAX_BACKOFF_MIN, SCHEMA, appendHeartbeat, backoffMinutes,
  createState, decide, heartbeatFileFor, isRetryable, loadState, normalizeState, recordOutcome,
  renderBrokenEntry, renderHeartbeat, renderStillBroken, renderTransitionComment, resetStateFile, saveState,
} from './lib/backoff-state.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WATCH = join(ROOT, 'scripts', 'dsh-watch.mjs')
const KEEP = process.argv.includes('--keep')
const TMP = mkdtempSync(join(tmpdir(), 'dsh-backoff-'))
const BIN = join(TMP, 'bin')
mkdirSync(BIN, { recursive: true })

let nOk = 0
let nFail = 0
const failures = []
function check(name, expected, actual) {
  const ok = String(expected) === String(actual)
  if (ok) {
    nOk += 1
    console.log(`  ok   ${name}`)
  } else {
    nFail += 1
    failures.push(`${name}：期望 ${JSON.stringify(String(expected))}，实际 ${JSON.stringify(String(actual))}`)
    console.log(`  FAIL ${name} —— 期望 ${JSON.stringify(String(expected))}，实际 ${JSON.stringify(String(actual))}`)
  }
  return ok
}
const T0 = Date.parse('2026-10-24T00:00:00Z')
const at = (minutes) => new Date(T0 + minutes * 60000).toISOString()

// ══ 1. 纯函数单测 ═══════════════════════════════════════════════════════════
function unit() {
  console.log('\n── 1. 纯函数：退避序列 / 三态跃迁 / fail-open ─────────────────')
  check('退避序列 5→10→20→40，第 5 次起封顶 60', '5,10,20,40,60,60', [1, 2, 3, 4, 5, 6].map(backoffMinutes).join(','))
  check('退避坏输入按第 1 次处理（不返回 NaN）', '5,5', `${backoffMinutes(0)},${backoffMinutes('garbage')}`)
  check('默认阈值 N=3', '3', String(DEFAULT_THRESHOLD))
  check('封顶 = 60 分钟', '60', String(MAX_BACKOFF_MIN))
  check('序列基线与文档一致', '5,10,20,40', BACKOFF_SCHEDULE_MIN.join(','))

  // 三态跃迁：healthy → degraded(1,2) → broken(3)
  let st = createState('dsh-watch', T0)
  let out = recordOutcome(st, { ok: false, error: 'curl: (28) timeout', nowMs: T0 + 60000 })
  check('第 1 次连续失败 ⇒ degraded（并通知）', 'degraded|healthy→degraded|true', `${out.state.state}|${out.transition?.from}→${out.transition?.to}|${out.transition?.notify}`)
  st = out.state
  out = recordOutcome(st, { ok: false, error: 'curl: (28) timeout', nowMs: T0 + 2 * 60000 })
  check('第 2 次连续失败 ⇒ 仍 degraded，**不通知**', 'degraded|true', `${out.state.state}|${out.transition === null}`)
  st = out.state
  out = recordOutcome(st, { ok: false, error: 'curl: (28) timeout', nowMs: T0 + 3 * 60000 })
  check('第 3 次连续失败 ⇒ broken（只通知一次）', 'broken|degraded→broken|true|5', `${out.state.state}|${out.transition?.from}→${out.transition?.to}|${out.transition?.notify}|${out.transition?.retryInMinutes}`)
  check('broken 的 nextAttemptAt = now + 5 分钟', at(8), out.state.nextAttemptAt)
  st = out.state
  check('broken 未到 nextAttemptAt ⇒ 跳过实际工作（并算出还剩几分钟）', 'true|1', `${decide(st, T0 + 7 * 60000).skip}|${decide(st, T0 + 7 * 60000).minutesLeft}`)
  check('broken 到点 ⇒ 允许重试', 'false|retry-due', `${decide(st, T0 + 8 * 60000).skip}|${decide(st, T0 + 8 * 60000).reason}`)

  // 重试轮仍失败：仍 broken，但**不通知**；退避放大
  const r4 = recordOutcome(st, { ok: false, error: 'curl: (28) timeout', nowMs: T0 + 8 * 60000 })
  check('重试仍失败 ⇒ 仍 broken、不通知、下一档 10 分钟', 'broken|true|10', `${r4.state.state}|${r4.transition?.notify === false}|${r4.transition?.retryInMinutes}`)
  let retryState = r4.state
  for (let k = 0; k < 6; k++) retryState = recordOutcome(retryState, { ok: false, error: 'boom', nowMs: T0 + 60 * 60000 * (k + 1) }).state
  check('连续重试退避封顶 60 分钟', '60', String(backoffMinutes(retryState.backoffRetries)))

  // 成功即 Forget
  const rec = recordOutcome(st, { ok: true, nowMs: T0 + 20 * 60000 })
  check('broken → healthy：只通知一次，计数清零', 'healthy|broken→healthy|true|0|', `${rec.state.state}|${rec.transition?.from}→${rec.transition?.to}|${rec.transition?.notify}|${rec.state.consecutiveFailures}|${rec.state.nextAttemptAt ?? ''}`)
  const deg = recordOutcome(createState('t', T0), { ok: false, error: 'timeout', nowMs: T0 }).state
  const silent = recordOutcome(deg, { ok: true, nowMs: T0 + 60000 })
  check('degraded → healthy：恢复但**静默**（没通知过任何人）', 'healthy|false', `${silent.state.state}|${silent.transition?.notify}`)

  // 不可重试错误：403 第一次就 broken
  const nonRetry = recordOutcome(createState('t', T0), { ok: false, error: 'GraphQL: Resource not accessible by personal access token (updateIssue)', nowMs: T0 })
  check('403/权限错误 ⇒ 第一次就 broken（不空等 N 次）', 'broken|true|1', `${nonRetry.state.state}|${nonRetry.transition?.notify}|${nonRetry.state.consecutiveFailures}`)
  check('可重试/不可重试的判定', 'true|false|true', `${isRetryable('curl: (28) timed out')}|${isRetryable('HTTP 403: not accessible')}|${isRetryable('429 Too Many Requests')}`)

  // 状态文件的 fail-open
  const file = join(TMP, 'state', 'unit.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '{ not json')
  const corrupt = loadState(file, { tool: 'unit', nowMs: T0 })
  const backups = readdirSync(dirname(file)).filter((n) => n.includes('.corrupt-'))
  check('状态文件损坏 ⇒ 重建 healthy（fail-open，不静默停机）', 'healthy|true|false', `${corrupt.state.state}|${corrupt.corrupt !== null}|${corrupt.existed}`)
  check('  （损坏文件已备份，可事后取证）', 'true', String(backups.length >= 1))
  saveState(file, { schema: SCHEMA + 1, state: 'broken' })
  check('未知 schema ⇒ 备份并重建 healthy', 'healthy|true', `${loadState(file, { tool: 'unit' }).state.state}|${loadState(file, { tool: 'unit' }).corrupt !== null}`)

  // damaged-but-plausible 状态：broken 却没 nextAttemptAt ⇒ 立即允许重试（不能变成静默停机）
  const brokenNoNext = normalizeState({ schema: SCHEMA, state: 'broken', consecutiveFailures: 4 }, 'unit', T0)
  check('broken 缺 nextAttemptAt ⇒ 立即可重试（不把字段丢失变成永久跳过）', 'false', String(decide(brokenNoNext, T0).skip))
  check('healthy 状态不保留退避字段', 'null|0', `${normalizeState({ schema: SCHEMA, state: 'healthy', nextAttemptAt: at(9) }, 'unit', T0).nextAttemptAt}|${normalizeState({ schema: SCHEMA, state: 'healthy', nextAttemptAt: at(9) }, 'unit', T0).backoffRetries}`)

  // 渲染契约（输出形状是门禁的一部分：反向心跳脚本按这些串解析）
  check('仍 broken 的一行格式', 'still broken (attempt 3, next retry in 5m) — heartbeat 2026-10-24T00:00:00.000Z',
    renderStillBroken({ attempt: 3, minutesLeft: 5, nowIso: at(0) }))
  check('broken 入口一行摘要', 'true', String(/^broken: 连续 3 次失败（阈值 3），进入退避 —— 下次重试 5m 后/.test(renderBrokenEntry({ attempt: 3, minutesLeft: 5, error: 'x' }))))
  const comment = renderTransitionComment({ tool: 'dsh-watch', transition: { from: 'degraded', to: 'broken', attempt: 3, retryInMinutes: 5, notify: true }, error: 'curl: (28) timeout', digestToken: 'abc123', nowIso: at(3) })
  check('跃迁评论带 state= 机器标记与 digest', 'true|true', `${/<!-- dsh-watch-backoff: state=broken/.test(comment.body)}|${comment.body.includes('digest=abc123')}`)
  check('跃迁评论正文说明"只在跃迁时通知"', 'true', String(comment.body.includes('只在跃迁时通知')))

  // 心跳有界
  const hb = join(TMP, 'hb.heartbeat')
  for (let i = 0; i < 12; i++) appendHeartbeat(hb, renderHeartbeat({ tool: 't', state: 'broken', nowIso: at(i), attempt: i, skipped: true }), { maxLines: 5 })
  const hbLines = readFileSync(hb, 'utf8').trim().split('\n')
  check('心跳文件有界（只留最近 maxLines 行）', '5', String(hbLines.length))
  check('心跳行含 state/skipped（反向心跳据此判"在退避"）', 'true|true', `${hbLines.at(-1).includes('state=broken')}|${hbLines.at(-1).includes('skipped=yes')}`)
  check('心跳路径与状态文件同目录', 'true', String(heartbeatFileFor('/x/state/dsh-watch.json') === '/x/state/dsh-watch.heartbeat'))
}

// ══ 2. 8 轮实测（gh / curl 桩；只在临时目录里跑）════════════════════════════
function stubs() {
  const gh = join(BIN, 'gh')
  writeFileSync(gh, `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (process.env.GH_CALLS) appendFileSync(process.env.GH_CALLS, args.join(' ') + '\\n')
if (args[0] === 'label') process.exit(0)
if (args[0] === 'issue' && args[1] === 'list') {
  const p = process.env.FAKE_GH_ISSUES || ''
  process.stdout.write(existsSync(p) ? readFileSync(p, 'utf8') : '[]')
  process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'view') {
  const p = process.env.FAKE_GH_COMMENTS || ''
  process.stdout.write(JSON.stringify({ comments: existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [] }))
  process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'comment') {
  const i = args.indexOf('--body')
  const body = i >= 0 ? args[i + 1] : ''
  if (process.env.FAKE_GH_COMMENTS) {
    const p = process.env.FAKE_GH_COMMENTS
    const list = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : []
    list.push({ body })
    writeFileSync(p, JSON.stringify(list))
  }
  process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'create') { process.stdout.write('https://github.com/karoc/dsh-desktop/issues/999\\n'); process.exit(0) }
process.exit(0)
`)
  chmodSync(gh, 0o755)
  const curl = join(BIN, 'curl')
  writeFileSync(curl, `#!/usr/bin/env node
const { readFileSync } = require('node:fs')
if (process.env.FAKE_CURL_FAIL === '1' || !process.env.FAKE_PACKUMENT) {
  process.stderr.write('curl: (7) 假 curl：按测试要求失败\\n')
  process.exit(7)
}
process.stdout.write(readFileSync(process.env.FAKE_PACKUMENT, 'utf8'))
`)
  chmodSync(curl, 0o755)
  return { gh, curl }
}

function integration() {
  console.log('\n── 2. 8 轮实测：同一个失败连续 8 轮 ⇒ 只在跃迁时通知、之后每轮一行 ──')
  const { gh } = stubs()
  const W = join(TMP, 'e2e')
  mkdirSync(W, { recursive: true })
  const sd = join(W, 'sd')
  const issues = join(W, 'issues.json')
  const comments = join(W, 'comments.json')
  const calls = join(W, 'calls.log')
  const fb = join(W, 'fail.json')          // 一直失败的 curl 桩（不需要 packument 内容）
  const okPkg = join(W, 'ok.json')
  writeFileSync(fb, '{}')
  writeFileSync(okPkg, JSON.stringify({ 'dist-tags': { latest: '0.1.0' }, time: { '0.1.0': '2026-10-01T00:00:00Z' } }))
  writeFileSync(comments, '[]')
  writeFileSync(calls, '')
  // 注意：这里的 seed issue 目标版本刻意用 9.9.9（**高于任何真实壳地板**）。A12（2026-10-30 起）
  // 会在"地板 >= issue 目标版本"时关闭跟踪单并补一条"已适配"评论 —— 那会污染本套件对
  // "跃迁评论条数"的计数（恢复轮期望只多 1 条）。用不可能被地板覆盖的版本，让本套件只测退避。
  writeFileSync(issues, JSON.stringify([{
    number: 42,
    title: '[dsh-watch][best-effort 24h（预发布通道）] dsh 9.9.9 比地板 0.1.0 新',
    body: '', labels: [], assignees: [], createdAt: '2026-10-23T08:00:00Z',
  }]))

  const run = ({ minutes, extra = [], fail = true, stateDir = sd }) => {
    const r = spawnSync(process.execPath, [WATCH, '--state-dir', stateDir, '--now', at(minutes), ...extra], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${BIN}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
        GH_BIN: gh,
        FAKE_PACKUMENT: okPkg,
        FAKE_CURL_FAIL: fail ? '1' : '0',
        FAKE_GH_ISSUES: issues,
        FAKE_GH_COMMENTS: comments,
        GH_CALLS: calls,
        DSH_STATE_DIR: '',
      },
    })
    const commentList = JSON.parse(readFileSync(comments, 'utf8'))
    const stateFile = join(stateDir, 'state', 'dsh-watch.json')
    return {
      status: r.status,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
      lines: (r.stdout ?? '').split('\n').filter((s) => s.trim() !== ''),
      comments: commentList,
      state: existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null,
      commentCalls: readFileSync(calls, 'utf8').split('\n').filter((l) => l.startsWith('issue comment')).length,
    }
  }

  // 第 1–2 轮：完整错误（degraded 诊断窗口，只有第 1 轮发跃迁评论）
  let r = run({ minutes: 0 })
  check('第 1 轮：exit 1 + 完整错误进 stderr（degraded 仍要细节）', '1|true|degraded',
    `${r.status}|${r.stderr.includes('拿不到 npm packument')}|${r.state?.state}`)
  check('第 1 轮：恰好 1 条跃迁评论（healthy→degraded，带 state=degraded）', '1|true',
    `${r.comments.length}|${String(r.comments[0]?.body ?? '').includes('state=degraded')}`)
  r = run({ minutes: 10 })
  check('第 2 轮：仍是完整错误、**不加评论**', '1|true|1|degraded',
    `${r.status}|${r.stderr.includes('拿不到 npm packument')}|${r.comments.length}|${r.state?.state}`)

  // 第 3 轮：进入 broken，第 2 条跃迁评论
  r = run({ minutes: 20 })
  check('第 3 轮：进入 broken（连续 3 次失败）', '1|broken|3', `${r.status}|${r.state?.state}|${r.state?.consecutiveFailures}`)
  check('第 3 轮：输出是"一行摘要"而不是每轮重印的完整段', 'true', String(/^broken: 连续 3 次失败/.test(r.lines.find((l) => l.startsWith('broken')) ?? '')))
  check('第 3 轮：第 2 条（也是最后一条）跃迁评论 = degraded→broken', '2|true',
    `${r.comments.length}|${String(r.comments[1]?.body ?? '').includes('state=broken')}`)
  check('第 3 轮：nextAttemptAt = now + 5 分钟', at(25), r.state?.nextAttemptAt)

  // 第 4–8 轮：每轮只有一行；退避 5→10→20→40
  const expected = [
    { round: 4, attempt: 4, retry: 10, status: 1 },
    { round: 5, attempt: 5, retry: 20, status: 1 },
    { round: 6, attempt: 5, retry: 10, status: 0 },   // 未到 nextAttemptAt ⇒ 跳过（不干活）
    { round: 7, attempt: 6, retry: 40, status: 1 },
    { round: 8, attempt: 6, retry: 30, status: 0 },
  ]
  for (const e of expected) {
    r = run({ minutes: (e.round - 1) * 10 })
    const line = r.lines[0] ?? ''
    check(`第 ${e.round} 轮：**只有一行** still broken（attempt ${e.attempt}, next retry in ${e.retry}m）`,
      `1|true|${e.status}`, `${r.lines.length}|${new RegExp(`^still broken \\(attempt ${e.attempt}, next retry in ${e.retry}m\\)`).test(line)}|${r.status}`)
    check(`第 ${e.round} 轮：详细错误不再进 stderr（只进 .detail.log）、不再加评论`, 'false|2',
      `${r.stderr.includes('拿不到 npm packument')}|${r.comments.length}`)
  }
  check('8 轮结束：状态仍是 broken（跳过轮不得把它改成 healthy）', 'broken', r.state?.state)
  check('8 轮结束：评论总数 == 2（degraded、broken 各一次）', '2', String(r.commentCalls))

  // 恢复：broken → healthy 只多一条
  r = run({ minutes: 100, fail: false })
  check('恢复轮：exit 0、退避清零、回到 healthy', '0|healthy|0', `${r.status}|${r.state?.state}|${r.state?.consecutiveFailures}`)
  check('恢复轮：只多 1 条跃迁评论（broken→healthy）', '3|true', `${r.comments.length}|${String(r.comments[2]?.body ?? '').includes('state=healthy')}`)
  check('恢复后不再退避（下一轮立刻干活）', 'false', String(decide(r.state, T0 + 101 * 60000).skip))
  check('恢复轮之前 broken 的失败明细留了证据（.detail.log 存在且含完整错误）', 'true|true',
    `${existsSync(join(sd, 'state', 'dsh-watch.json.detail.log'))}|${readFileSync(join(sd, 'state', 'dsh-watch.json.detail.log'), 'utf8').includes('拿不到 npm packument')}`)

  // 心跳：每轮一行，跳过轮 skipped=yes
  const hb = readFileSync(join(sd, 'state', 'dsh-watch.heartbeat'), 'utf8').trim().split('\n')
  check('心跳每轮一行（8 轮失败 + 1 轮恢复 = 9 行）', '9', String(hb.length))
  check('心跳区分"退避跳过"与"真的干了活"', 'true|true',
    `${hb.some((l) => l.includes('skipped=yes'))}|${hb.some((l) => l.includes('skipped=no'))}`)
  check('心跳最后一行是恢复后的 healthy', 'true', String(hb.at(-1).includes('state=healthy')))

  // --reset-state：人工恢复，不写 GitHub
  const sd2 = join(W, 'sd2')
  cpSync(sd, sd2, { recursive: true })
  // 先把 sd2 造成 broken（用一次失败轮），再 reset
  r = run({ minutes: 90, stateDir: sd2 })
  r = run({ minutes: 100, stateDir: sd2 })
  r = run({ minutes: 110, stateDir: sd2 })
  check('准备：另一份状态被再次打成 broken', 'broken', r.state?.state)
  const before = readFileSync(calls, 'utf8').length
  r = run({ minutes: 120, stateDir: sd2, extra: ['--reset-state'], fail: false })
  const stateAfterReset = JSON.parse(readFileSync(join(sd2, 'state', 'dsh-watch.json'), 'utf8'))
  check('--reset-state：exit 0、状态回 healthy、不写 GitHub', '0|healthy|true',
    `${r.status}|${stateAfterReset.state}|${readFileSync(calls, 'utf8').length === before}`)
  check('--reset-state：输出明说"不写 GitHub"', 'true', String(r.stdout.includes('不写 GitHub')))
  r = run({ minutes: 130, stateDir: sd2 })
  check('reset 之后失败轮重新从 degraded 计数（不是被永久跳过）', 'degraded|1', `${r.state?.state}|${r.state?.consecutiveFailures}`)
}

// ══ 3. 负向对照：关掉退避 ⇒ 上面"每轮一行 / 只有 2 条评论"必须变红 ═══════════
function negativeControl() {
  console.log('\n── 3. 负向对照（--no-backoff）：没有状态机时"每轮重印 + 0 条跃迁评论" ──')
  const { gh } = stubs()
  const W = join(TMP, 'neg')
  mkdirSync(W, { recursive: true })
  const sd = join(W, 'sd')
  const issues = join(W, 'issues.json')
  const comments = join(W, 'comments.json')
  const calls = join(W, 'calls.log')
  writeFileSync(issues, JSON.stringify([{ number: 42, title: '[dsh-watch] dsh 0.2.1-rc.3 比地板 0.2.1-rc.2 新', body: '', labels: [], assignees: [], createdAt: '2026-10-23T08:00:00Z' }]))
  writeFileSync(comments, '[]')
  writeFileSync(calls, '')
  const runs = []
  for (let i = 0; i < 8; i++) {
    const r = spawnSync(process.execPath, [WATCH, '--state-dir', sd, '--now', at(i * 10), '--no-backoff'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${BIN}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
        GH_BIN: gh,
        FAKE_PACKUMENT: join(W, 'x.json'),
        FAKE_CURL_FAIL: '1',
        FAKE_GH_ISSUES: issues,
        FAKE_GH_COMMENTS: comments,
        GH_CALLS: calls,
      },
    })
    runs.push(r)
  }
  check('负向对照：8 轮**全都**重印完整错误（≠ 第 4 轮起只一行）', '8',
    String(runs.filter((r) => (r.stderr ?? '').includes('拿不到 npm packument')).length))
  check('负向对照：0 条跃迁评论（没有状态机就发不出来）', '0', String(JSON.parse(readFileSync(comments, 'utf8')).length))
  check('负向对照：不产生状态文件', 'false', String(existsSync(join(sd, 'state', 'dsh-watch.json'))))
  check('负向对照：每轮 exit 1（这也是"噪音式降级"的原始行为）', '8', String(runs.filter((r) => r.status === 1).length))
}

// ══ 4. autopilot 同一套闸门（同一个模块，第二处接入点）══════════════════════
function autopilotGate() {
  console.log('\n── 4. dsh-release-autopilot：broken 时跳过整条流水线、只留一行 ──')
  const { gh } = stubs()
  const W = join(TMP, 'autopilot')
  const sd = join(W, 'sd')
  mkdirSync(join(sd, 'state'), { recursive: true })
  const calls = join(W, 'calls.log')
  writeFileSync(calls, '')
  const file = join(sd, 'state', 'dsh-release-autopilot.json')
  writeFileSync(file, JSON.stringify({
    schema: 1, tool: 'dsh-release-autopilot', state: 'broken', consecutiveFailures: 4, backoffRetries: 2,
    runsTotal: 9, lastError: 'curl (28) timeout', nextAttemptAt: '2099-01-01T00:00:00Z',
    enteredStateAt: '2026-10-24T00:00:00Z', notified: {},
  }))
  const run = (extra) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'dsh-release-autopilot.mjs'), '--state-dir', sd, ...extra], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, GH_BIN: gh, GH_CALLS: calls },
  })
  let r = run([])
  const lines = (r.stdout ?? '').split('\n').filter((x) => x.trim() !== '')
  check('autopilot：broken 未到点 ⇒ exit 0、只输出一行 still broken', '0|1|true',
    `${r.status}|${lines.length}|${/^still broken \(attempt 4, next retry in \d+m\)/.test(lines[0] ?? '')}`)
  check('autopilot：跳过轮不调任何 gh 写接口（没有 clone/push/评论）', 'true', String(readFileSync(calls, 'utf8').trim() === ''))
  r = run(['--reset-state'])
  check('autopilot --reset-state：回到 healthy、不写 GitHub', '0|healthy|true',
    `${r.status}|${JSON.parse(readFileSync(file, 'utf8')).state}|${readFileSync(calls, 'utf8').trim() === ''}`)
}

console.log('A6 退避/三态门禁（scripts/lib/backoff-state.mjs + scripts/dsh-watch.mjs + dsh-release-autopilot.mjs）')
unit()
integration()
negativeControl()
autopilotGate()

console.log(`\n汇总：${nOk} 条通过 / ${nFail} 条失败${nFail ? '' : '（全绿）'}`)
if (!KEEP) rmSync(TMP, { recursive: true, force: true })
else console.log(`临时目录保留：${TMP}`)
if (nFail) {
  console.error(`\n失败项：\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  process.exit(1)
}
process.exit(0)
