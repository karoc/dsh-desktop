#!/usr/bin/env node
// dsh-token-meta —— PAT 过期元数据（采用清单 A4）：**人工录一次**，之后由工具分级检查 / 每日提醒。
//
// 为什么需要它（docs/2026-10-24-alerting-and-idempotency-patterns.md §4.2 / 采用清单 A4）：
// 个人 fine-grained PAT 的过期时间**没有可读的 REST 端点**（`GET /user` 不返回 `expires_at`；
// classic token 能读 `X-OAuth-Scopes`，fine-grained PAT 连这个头都没有）⇒ "token 哪天过期"这个事实
// 机器拿不到，只能**创建/轮换时人工录一次**，之后靠本脚本检查。这是防错清单里唯一"不需要用户动作
// 之外的新权限"的那一项：不申请新 scope、不读 secret、不联网（除非显式 `--notify`）。
//
// 用法：
//   node scripts/dsh-token-meta.mjs set --expires YYYY-MM-DD [--note "…"] [--meta-file <path>]
//      写入 `~/.dsh/token.meta.json`（**600、原子写、不含 token**，只有 expiresAt / note / recordedAt）。
//      `--note` 里出现 token 形状（ghp_… / github_pat_…）⇒ 拒绝写入（exit 2，防止把凭据粘进元数据）。
//
//   node scripts/dsh-token-meta.mjs check [--json] [--quiet] [--now <iso>] [--if-due]
//                                         [--meta-file <path>] [--state-file <path>]
//      计算剩余天数并分级：>14 天 ok / ≤14 天 warn / ≤7 天 urgent / ≤1 天 critical / 已过期 expired。
//      **退出码：只有 critical 与 expired 非零**（ok/warn/urgent = 0）；**未知（meta 缺失或损坏）= 0**
//      —— 没启用这个功能不该把门禁判红，但输出必须明说"未知"。
//      `--quiet` 只在"非 ok"时输出（给 cron / systemd timer 用，安静是常态）。
//      `--if-due`：今天（UTC）已经跑过 ⇒ 打印一行 `not due` 后 exit 0（**每日门控**：可以安全地挂在
//      10 分钟的主循环上，而不必把检查塞进主循环；见 README「PAT 过期元数据」）。
//      `--json`：把结果打成一整块 JSON（含 level / daysLeft / expiresAt / exitCode）。
//
//   node scripts/dsh-token-meta.mjs check --notify [--if-due] [--dry-run] [--quiet]
//                                         [--repo <owner/name>] [--assignee <login>]
//                                         [--meta-file <path>] [--state-file <path>] [--now <iso>]
//      非 ok 时在专门的**跟踪 issue**（标题 `[automation] PAT 过期元数据（A4）`，全仓只允许一条）里
//      评论提醒 + `@owner` 提及；**只在级别跃迁时**评论（warn→urgent→critical→expired 各一条），
//      回到 ok 时评论"已解除"并**关闭**该 issue。写失败（403 / 权限不足）⇒ **只打印提醒文本 + 一条可
//      复制的命令，不重试**，本轮不再追加写请求；退出码仍按级别给（critical/expired ⇒ 1）。
//      "元数据未知"**不建 issue、不评论**（那是"没启用功能"，不是"token 要过期"）。
//
// 退出码：0 = 正常/提醒（ok/warn/urgent）或未知/今日已检查；1 = critical / expired（"该动手了"）；
//         2 = 用法错误 / note 里带 token 形状 / expires 非法；3 = `--notify` 的检查自身坏了
//         （读不到 issue 列表 —— 这是"检查器坏了"，不是"token 快过期"）。
//
// 测试注入点：`--meta-file` / `DSH_TOKEN_META`、`--state-file` / `DSH_TOKEN_META_STATE`、
// `--now`（钉住"现在"，五级分级全靠它可确定性回放）、`GH_BIN`（默认 `scripts/gh`，**不要**用裸 gh）、
// `--repo` / `GH_REPO` / `GITHUB_REPOSITORY`。
//
// 负面保证（写在这里，防止后来者"顺手优化掉"）：
//   · meta 文件里**永远不写 token**（只写三个字段；`--note` 带 token 形状直接被拒）；
//   · **不联网、不调 gh**，除非显式 `--notify`；`--dry-run` 下不写 issue、不写状态文件；
//   · 写权失败**不重试**、不刷评论、不因为写不进去就改成非零（critical/expired 除外 —— 那是级别）；
//   · **不猜测**过期日：读不到 / 读坏了 ⇒ "未知"，绝不当成"永久有效"或"已过期"；
//   · **不把 warn/urgent 变成非零退出**（天天红 = 人开始忽略 = 告警失效）。

import { execFileSync } from 'node:child_process'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_META_FILE, DEFAULT_STATE_FILE, LEVEL_LABEL, LEVEL_UNKNOWN, TRACKING_MARK, TRACKING_TITLE,
  containsSecretLike, evaluate, isDue, loadCheckState, parseExpiresDate, renderCheckLines,
  renderRecovery, renderReminder, saveCheckState, utcDate, writeMetaFile,
} from './lib/token-meta.mjs'

const SELF = fileURLToPath(import.meta.url)
const ROOT = join(dirname(SELF), '..')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valOf = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] ?? d : d }

const COMMANDS = new Set(['set', 'check'])
const VALUE_FLAGS = new Set(['--expires', '--note', '--now', '--meta-file', '--state-file', '--repo', '--assignee'])
const KNOWN_FLAGS = new Set([
  '--expires', '--note', '--json', '--quiet', '--now', '--if-due', '--notify', '--dry-run',
  '--meta-file', '--state-file', '--repo', '--assignee', '--help', '-h',
])

// 参数先校验一遍：宁可 exit 2，也不要带着拼错的 flag 静默跑出"未知"。
// 注意取值不是 flag：`--expires 2026-11-07` 的第二个 token 必须被"跳过"，不能被当成多余参数。
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '-h') continue
  if (!a.startsWith('-')) {
    if (!COMMANDS.has(a)) {
      console.error(`未知参数：${a}\n用法见 --help（退出码 2 = 用法错误，不写任何东西）`)
      process.exit(2)
    }
    continue
  }
  if (!KNOWN_FLAGS.has(a)) {
    console.error(`未知参数：${a}\n用法见 --help（退出码 2 = 用法错误，不写任何东西）`)
    process.exit(2)
  }
  if (VALUE_FLAGS.has(a)) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) {
      console.error(`${a} 需要一个值（当前是 ${JSON.stringify(v ?? '')}）`)
      process.exit(2)
    }
    i += 1
  }
}

if (has('--help') || has('-h')) {
  // 头注释即 help（与前几个脚本一致）：只打印文件头，避免第二个"文档"漂移。
  console.log(execFileSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(SELF)},'utf8'))`], { encoding: 'utf8', maxBuffer: 4 << 20 })
    .split('\n').slice(0, 42).join('\n'))
  process.exit(0)
}

const CMD = argv.find((a) => COMMANDS.has(a))
if (!CMD) {
  console.error('缺少子命令：set | check（用 --help 看用法）')
  process.exit(2)
}

const META_FILE = valOf('--meta-file') ?? process.env.DSH_TOKEN_META ?? DEFAULT_META_FILE()
const STATE_FILE = valOf('--state-file') ?? process.env.DSH_TOKEN_META_STATE ?? DEFAULT_STATE_FILE()
const NOW_ARG = valOf('--now')
const NOW = NOW_ARG ? new Date(NOW_ARG) : new Date()
if (Number.isNaN(NOW.getTime())) {
  console.error(`--now 不是合法时间：${NOW_ARG}（要 ISO 8601，例如 2026-10-24T04:00:00Z）`)
  process.exit(2)
}
const NOW_MS = NOW.getTime()
const DRY = has('--dry-run')
const QUIET = has('--quiet')
const NOTIFY = has('--notify')
const IF_DUE = has('--if-due')
const JSON_OUT = has('--json')

// 仓库 / 属主解析顺序与 dsh-watch / dsh-doctor 一致（--repo > GH_REPO > GITHUB_REPOSITORY > git remote > 默认）。
const GIT_SLUG = (() => {
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: ROOT, encoding: 'utf8' }).trim()
    const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url)
    return m ? `${m[1]}/${m[2]}` : null
  } catch { return null }
})()
const REPO_ARG = valOf('--repo')
const REPO = REPO_ARG || process.env.GH_REPO || process.env.GITHUB_REPOSITORY || GIT_SLUG || 'karoc/dsh-desktop'
const OWNER = String(valOf('--assignee') || process.env.DSH_ISSUE_ASSIGNEE || REPO.split('/')[0]).trim().replace(/^@/, '')
const GH_RAW = process.env.GH_BIN ?? 'scripts/gh'
const GH_BIN = (GH_RAW.includes('/') || GH_RAW.includes('\\')) && !isAbsolute(GH_RAW) ? join(ROOT, GH_RAW) : GH_RAW

const say = (line) => { if (!QUIET) console.log(line) }
// `--quiet` 只压"一切正常"的噪音：**写不进去时的提醒文本**必须照常出现在日志里，
// 否则 cron/timer 的安静正好掩盖了"提醒没发出去"。
const always = (line) => console.log(line)
const emitJSON = (payload) => {
  const { exitCode, ...rest } = payload
  process.stdout.write(`${JSON.stringify({ ...rest, exitCode }, null, 2)}\n`)
}

// ── gh 薄封装（只给 --notify 用；失败一律转成 {ok:false,...}，不抛） ───────────────
function runGH(args) {
  try {
    const out = execFileSync(GH_BIN, args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, stdout: String(out ?? ''), status: 0, error: null }
  } catch (e) {
    const stderr = e?.stderr != null ? String(e.stderr) : ''
    const msg = stderr.trim() || e?.message || String(e)
    return { ok: false, stdout: e?.stdout != null ? String(e.stdout) : '', status: typeof e?.status === 'number' ? e.status : null, error: msg.split('\n')[0].slice(0, 240) }
  }
}

/** 读不到 issue 列表 = 检查器坏了（exit 3），不是"token 快过期"。 */
function issueList() {
  const r = runGH(['issue', 'list', '--state', 'all', '--limit', '100', '--json', 'number,title,state,body'])
  if (!r.ok) return { ok: false, error: r.error }
  try {
    const list = JSON.parse(r.stdout)
    if (!Array.isArray(list)) return { ok: false, error: '返回的不是数组' }
    return { ok: true, issues: list }
  } catch (e) {
    return { ok: false, error: `返回的不是 JSON：${String(e?.message ?? e).slice(0, 120)}` }
  }
}

const isTracking = (i) => String(i?.title ?? '') === TRACKING_TITLE || String(i?.body ?? '').includes(TRACKING_MARK)
const isOpen = (i) => String(i?.state ?? 'OPEN').toUpperCase() === 'OPEN'

/**
 * 通知一轮。**只在跃迁时评论**；任何写失败立即停手（不重试、不刷评论）。
 * @returns {{performed: boolean, reason: string, error?: string, exitCode?: number}}
 */
function notify(result, state) {
  if (result.level === LEVEL_UNKNOWN) {
    // 没录入不建 issue：那是"没启用功能"，不是"token 要过期"（否则每天一条噪音）。
    say('通知：跳过（元数据未知 —— 先跑 `set --expires` 录入；未知不建 issue、不评论）')
    return { performed: false, reason: 'unknown' }
  }
  const listing = issueList()
  if (!listing.ok) {
    always(`通知：读不到 issue 列表（${listing.error}）—— 检查器自身故障，不改远端、不猜。`)
    always(renderReminder(result, { owner: OWNER, repo: REPO }))
    return { performed: false, reason: 'read-failed', error: listing.error, exitCode: 3 }
  }
  const trackings = listing.issues.filter(isTracking).sort((a, b) => Number(a.number) - Number(b.number))
  const tracking = trackings[0] ?? null
  if (trackings.length > 1) {
    say(`通知：⚠️ 检测到 ${trackings.length} 条跟踪单（#${trackings.map((i) => i.number).join('、#')}）—— 只用最早那条 #${tracking.number}，其余需人工关闭。`)
  }

  // 回到 ok：只有"上一级已提醒过"或"跟踪单还开着"才动作（避免每天关闭一条已关的）。
  if (result.level === 'ok') {
    if (!tracking || !isOpen(tracking)) {
      say('通知：级别 ok，无开着的跟踪单 —— 无事可做。')
      return { performed: false, reason: 'ok-no-issue' }
    }
    if (state.lastNotifiedLevel === 'ok') {
      say(`通知：级别 ok，跟踪单 #${tracking.number} 已处理过 —— 不重复评论。`)
      return { performed: false, reason: 'already-ok' }
    }
    if (DRY) {
      say(`通知（dry-run）：将评论并关闭跟踪单 #${tracking.number}。`)
      return { performed: false, reason: 'dry-run' }
    }
    const c = runGH(['issue', 'comment', String(tracking.number), '--body', renderRecovery(result, { repo: REPO })])
    if (!c.ok) {
      always(`通知：评论失败（${c.error}）—— 权限不足就只打印，不重试。`)
      always(renderRecovery(result, { repo: REPO }))
      return { performed: false, reason: 'comment-failed', error: c.error }
    }
    const cl = runGH(['issue', 'close', String(tracking.number), '--reason', 'completed'])
    if (!cl.ok) {
      say(`通知：评论成功但关闭失败（${cl.error}）—— 下轮会自愈（级别 ok 且跟踪单还开着）。`)
      return { performed: false, reason: 'close-failed', error: cl.error }
    }
    say(`通知：已评论"已解除"并关闭跟踪单 #${tracking.number}。`)
    return { performed: true, reason: 'recovered' }
  }

  // 非 ok：需要一条开着的跟踪单 + 一次跃迁评论。
  const body = renderReminder(result, { owner: OWNER, repo: REPO })
  if (!tracking) {
    if (DRY) {
      say('通知（dry-run）：将新建跟踪单（dry-run 不写）。')
      return { performed: false, reason: 'dry-run' }
    }
    const c = runGH(['issue', 'create', '--title', TRACKING_TITLE, '--body', body])
    if (!c.ok) {
      always(`通知：建跟踪单失败（${c.error}）—— 权限不足就只打印，不硬试。`)
      always(body)
      always(`手工建单：./scripts/gh issue create --title ${JSON.stringify(TRACKING_TITLE)} --body-file <上述文本> 后重跑 --notify`)
      return { performed: false, reason: 'create-failed', error: c.error }
    }
    const num = /\/issues\/(\d+)/.exec(c.stdout)?.[1]
    if (!num) {
      say(`通知：建单成功但解析不出 issue 号（${c.stdout.trim().slice(0, 120)}）—— 不重复建。`)
      return { performed: false, reason: 'create-unknown-number' }
    }
    // 建单本身就是这一级的通知 ⇒ 记 lastNotifiedLevel，不再额外评论一条。
    state.lastNotifiedLevel = result.level
    state.lastNotifiedAt = result.at
    say(`通知：已建跟踪单 #${Number(num)}（${result.level}）。`)
    return { performed: true, reason: 'created' }
  }

  if (state.lastNotifiedLevel === result.level && isOpen(tracking)) {
    say(`通知：级别仍是 ${result.level}，跟踪单 #${tracking.number} 已提醒过 —— 不重复评论。`)
    return { performed: false, reason: 'already-notified' }
  }
  if (DRY) {
    say(`通知（dry-run）：将在 #${tracking.number} 评论 ${result.level} 的提醒（dry-run 不写）。`)
    return { performed: false, reason: 'dry-run' }
  }
  // 跟踪单被关过（上次 ok 自动关闭），这一级又回来了 ⇒ 先重开再评论（保持"全仓一条"）。
  if (!isOpen(tracking)) {
    const re = runGH(['issue', 'reopen', String(tracking.number)])
    if (!re.ok) {
      always(`通知：重开跟踪单 #${tracking.number} 失败（${re.error}）—— 只打印，不新建第二条。`)
      always(body)
      return { performed: false, reason: 'reopen-failed', error: re.error }
    }
  }
  const c = runGH(['issue', 'comment', String(tracking.number), '--body', body])
  if (!c.ok) {
    always(`通知：评论失败（${c.error}）—— 只打印提醒文本，不重试、不刷评论。`)
    always(body)
    return { performed: false, reason: 'comment-failed', error: c.error }
  }
  state.lastNotifiedLevel = result.level
  state.lastNotifiedAt = result.at
  say(`通知：已在 #${tracking.number} 评论 ${result.level} 的提醒。`)
  return { performed: true, reason: 'commented' }
}

// ── set ─────────────────────────────────────────────────────────────────────
function cmdSet() {
  const expiresArg = valOf('--expires')
  if (!expiresArg) {
    console.error('set 需要 --expires YYYY-MM-DD（token 页面上的 Expiration 日期）')
    process.exit(2)
  }
  const parsed = parseExpiresDate(expiresArg)
  if (!parsed.ok) {
    console.error(`--expires 非法：${parsed.error}`)
    process.exit(2)
  }
  const note = valOf('--note')
  if (note != null && containsSecretLike(note)) {
    console.error('拒绝写入：--note 里出现了 token 形状（ghp_… / github_pat_…）。meta 文件只存过期日与备注，绝不存凭据。')
    process.exit(2)
  }
  const recordedAt = NOW.toISOString()
  if (DRY) {
    say(`set（dry-run）：将写入 ${META_FILE}（expiresAt=${parsed.value}，note=${note ?? 'null'}）—— 不落盘。`)
    return 0
  }
  const payload = writeMetaFile(META_FILE, { expiresAt: parsed.value, note: note ?? null, recordedAt })
  const result = evaluate({ file: META_FILE, nowMs: NOW_MS })
  say(`已写入 ${META_FILE}（600、原子写、不含 token）`)
  say(`  expiresAt=${payload.expiresAt}  note=${payload.note ?? 'null'}  recordedAt=${payload.recordedAt}`)
  say(`  当前分级：${result.level}（${result.daysLeft == null ? '未知' : `剩余 ${result.daysLeft} 天`}）`)
  if (JSON_OUT) emitJSON({ command: 'set', metaFile: META_FILE, ...payload, level: result.level, daysLeft: result.daysLeft, exitCode: 0 })
  return 0
}

// ── check ───────────────────────────────────────────────────────────────────
function cmdCheck() {
  // 每日门控：今天（UTC）已经跑过 ⇒ 什么都不做（可以安全地挂在 10 分钟循环上）。
  let state = loadCheckState(STATE_FILE, NOW_MS).state
  if (IF_DUE && !isDue(state, NOW_MS)) {
    say(`not due（上次检查 ${state.lastCheckedDate}，今天 ${utcDate(NOW_MS)} 已检查过）`)
    if (JSON_OUT) {
      emitJSON({ command: 'check', at: NOW.toISOString(), metaFile: META_FILE, due: false, lastCheckedAt: state.lastCheckedAt, exitCode: 0 })
    }
    return 0
  }

  const result = evaluate({ file: META_FILE, nowMs: NOW_MS })

  // 只在"作为定时任务跑"（--if-due / --notify）时写状态；单纯的 check 保持只读。
  const persist = !DRY && (IF_DUE || NOTIFY)
  if (persist) {
    state = { ...state, lastCheckedAt: result.at, lastCheckedDate: utcDate(NOW_MS), lastLevel: result.level }
  }

  let notifyOutcome = null
  if (NOTIFY) notifyOutcome = notify(result, state)

  if (persist) {
    state.lastNotifyError = notifyOutcome?.error ?? null
    saveCheckState(STATE_FILE, state, NOW_MS)
  }

  if (JSON_OUT) {
    emitJSON({
      command: 'check', at: result.at, metaFile: META_FILE, metaState: result.metaState,
      level: result.level, levelLabel: LEVEL_LABEL[result.level],
      daysLeft: result.daysLeft, expiresAt: result.expiresAt, note: result.note,
      recordedAt: result.recordedAt, reason: result.reason, error: result.error,
      due: true, notify: notifyOutcome, stateFile: persist ? STATE_FILE : null,
      exitCode: notifyOutcome?.exitCode ?? result.exitCode,
    })
    return notifyOutcome?.exitCode ?? result.exitCode
  }

  // `--quiet` 只在 **非 ok** 时输出（ok 的日常安静是常态；warn 及以上必须开口）。
  if (!QUIET || result.level !== 'ok') for (const line of renderCheckLines(result)) console.log(line)
  return notifyOutcome?.exitCode ?? result.exitCode
}

const code = CMD === 'set' ? cmdSet() : cmdCheck()
process.exit(code)
