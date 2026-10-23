// token-meta —— PAT 过期元数据（采用清单 A4）：本地录入一次 + 分级检查 + 每日门控 + 只在跃迁时提醒。
//
// 背景（docs/2026-10-24-alerting-and-idempotency-patterns.md §4.2 / 采用清单 A4）：
// 个人 fine-grained PAT 的**过期时间没有可读的 REST 端点** —— `GET /user` 只返回身份字段
// （`login`/`id`/`type` …），不返回 `expires_at`；classic token 的 `X-OAuth-Scopes` 头只给 scope，
// fine-grained PAT 连这个头都没有。UI 上能看到过期日，但那是给人看的，机器读不到。
// ⇒ 唯一可靠的路径是**人工在创建/轮换时录一次**，之后由工具检查并提前告警。
//
// 为什么是"独立文件、且**不含 token**"：
//   · token 本身在 `~/.config/gh-dsh-desktop/token`（600）。本文件只存**过期日 + 备注 + 录入时刻**，
//     与 secret 分离 —— 这样它可以安全地被 doctor 读、被 git/备份工具误收也**不泄露凭据**。
//   · 写入口有形状守卫：`--note` 里出现 token 形状（`ghp_…` / `github_pat_…`）直接拒绝写入（exit 2），
//     不是靠"人会记得别粘"。
//
// 分级的语义（**退出码只对"要动手"的两级非零**，见 EXIT_FOR_LEVEL）：
//   > 14 天 ok / ≤ 14 天 warn / ≤ 7 天 urgent / ≤ 1 天 critical / 已过期 expired；
//   ok/warn/urgent → **exit 0**（天天红等于让人忽略告警，也会和 systemd 的 Restart 叠成热循环）；
//   critical/expired → **exit 1**（这两级才是"今天不换就要出事"）。
//   **未知（没录入 / meta 损坏）→ exit 0**：没启用这个功能不该把门禁判红 —— 但输出必须明说"未知"。
//
// 剩余天数的口径（刻意选**整天**而不是毫秒）：`expires=YYYY-MM-DD` 表示"该 UTC 日**当日结束**前有效"
// （GitHub PAT 的过期也是按日），`daysLeft = floor((该日次日 00:00 UTC - now) / 24h)`。
// 用整天是为了让"14 天 ⇒ warn"这类文档口径与实测口径**完全一致**（用毫秒会有 14.7 天这种毛刺，
// 文档写 14、实测却是 ok）。代价是"今天到期"与"还剩 1 小时"都显示 0 天 —— 都归 critical，不影响动作。
//
// 设计约束：
//   ① 纯函数优先：解析/分级/门控/渲染不碰 IO，可单测（`scripts/test-token-meta.mjs`）。
//   ② 写 meta 用 **tmp + rename**（原子）且 **mode 600**（目录 700）；写完不改属主、不做任何网络动作。
//   ③ **不猜**：meta 缺失 / JSON 坏 / `expiresAt` 不是合法日历日期，一律 `unknown` + 明说原因，
//      绝不按"没写就是永远有效"或"没写就是过期"处理（前者静默失守，后者制造假告警）。
//   ④ 通知**只在跃迁时**发（warn→urgent→critical→expired 各一条；回到 ok 发一条"恢复"并关闭跟踪单），
//      与 `scripts/lib/backoff-state.mjs` 的"只在跃迁时通知"同一条纪律。

import {
  chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DAY_MS = 86_400_000

/** 分级阈值（天）。改这里必须同步 README / CONTRIBUTING / 技能与测试。 */
export const THRESHOLDS = Object.freeze({ warn: 14, urgent: 7, critical: 1 })

/** 五个**可判定**级别（按严重度升序）。`unknown` 不在这里：它不是"级别"，是"判不了"。 */
export const LEVELS = Object.freeze(['ok', 'warn', 'urgent', 'critical', 'expired'])

/** 无法判定（meta 缺失 / 损坏）。**不是**一种级别，也不非零退出。 */
export const LEVEL_UNKNOWN = 'unknown'

/**
 * 级别 → 退出码。**只有 critical / expired 非零**；`unknown` 0（没启用功能不该判红）。
 * 这是本模块最容易被"顺手优化掉"的约定：把 warn 也改成非零 ⇒ 每天红 ⇒ 人开始忽略 ⇒ 告警失效。
 */
export const EXIT_FOR_LEVEL = Object.freeze({
  ok: 0, warn: 0, urgent: 0, critical: 1, expired: 1, [LEVEL_UNKNOWN]: 0,
})

/** 级别 → 一句话人话标签（输出/评论共用，避免两处措辞漂移）。 */
export const LEVEL_LABEL = Object.freeze({
  ok: '正常（>14 天）',
  warn: '提醒（≤14 天）',
  urgent: '尽快轮换（≤7 天）',
  critical: '必须立即轮换（≤1 天）',
  expired: '已过期',
  [LEVEL_UNKNOWN]: '未知（未录入或 meta 损坏）',
})

/** 写进 meta 的字段**只有这三个** —— 负向保证：永远不会有 token、scope、用户名。 */
export const META_FIELDS = Object.freeze(['expiresAt', 'note', 'recordedAt'])

export const DEFAULT_META_FILE = () => join(homedir(), '.dsh', 'token.meta.json')
export const DEFAULT_STATE_FILE = () => join(homedir(), '.dsh', 'state', 'token-meta.json')

/** 跟踪单的身份（标题固定 + 正文 marker 双保险；全仓只允许一条）。 */
export const TRACKING_TITLE = '[automation] PAT 过期元数据（A4）'
export const TRACKING_MARK = '<!-- dsh-token-meta:tracking -->'

// ── 日期解析 / 分级 ─────────────────────────────────────────────────────────

/**
 * 严格解析 `YYYY-MM-DD`（同时校验是**真实日历日**：2026-02-30 会被拒绝）。
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
export function parseExpiresDate(text) {
  const s = String(text ?? '').trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return { ok: false, error: `不是 YYYY-MM-DD 格式：${JSON.stringify(s)}` }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { ok: false, error: `不是合法日历日期：${s}` }
  }
  return { ok: true, value: `${m[1]}-${m[2]}-${m[3]}` }
}

/** `expires=YYYY-MM-DD` ⇒ 有效期末端（该 UTC 日**次日 00:00**）的毫秒时间戳；非法返回 NaN。 */
export function expiryEndMs(expiresAt) {
  const p = parseExpiresDate(expiresAt)
  if (!p.ok) return Number.NaN
  return Date.parse(`${p.value}T00:00:00Z`) + DAY_MS
}

/** 剩余**整天**数（floor；过期返回负数）。非法输入返回 NaN（调用方必须按 unknown 处理）。 */
export function daysLeft(expiresAt, nowMs) {
  const end = expiryEndMs(expiresAt)
  if (!Number.isFinite(end) || !Number.isFinite(nowMs)) return Number.NaN
  return Math.floor((end - nowMs) / DAY_MS)
}

/**
 * 天数 → 级别。边界（含）：>14 ok、8..14 warn、2..7 urgent、0..1 critical、<0 expired。
 * 用 `>` 而不是 `>=` 是刻意的：`14 天 ⇒ warn` 是文档口径，`>=` 会让它变成 ok。
 */
export function grade(days) {
  if (!Number.isFinite(days)) return LEVEL_UNKNOWN
  if (days < 0) return 'expired'
  if (days > THRESHOLDS.warn) return 'ok'
  if (days > THRESHOLDS.urgent) return 'warn'
  if (days > THRESHOLDS.critical) return 'urgent'
  return 'critical'
}

/** 是否"必须动手"（critical / expired）。给 doctor / cron 的一句话摘要用。 */
export const isActionable = (level) => level === 'critical' || level === 'expired'

// ── meta 文件读写 ──────────────────────────────────────────────────────────

/**
 * 读 meta。永不抛异常：缺失/损坏都折成 `metaState`，由调用方决定怎么显示。
 * @returns {{metaState: 'ok'|'missing'|'corrupt', meta: null|{expiresAt:string,note:string|null,recordedAt:string|null}, error: string|null}}
 */
export function readMetaFile(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    const missing = e?.code === 'ENOENT'
    return { metaState: missing ? 'missing' : 'corrupt', meta: null, error: missing ? null : `读不到：${String(e?.message ?? e).slice(0, 160)}` }
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch (e) {
    return { metaState: 'corrupt', meta: null, error: `不是合法 JSON：${String(e?.message ?? e).slice(0, 120)}` }
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { metaState: 'corrupt', meta: null, error: '顶层不是对象' }
  }
  const rawExpires = json.expiresAt ?? json.expires ?? json.expires_at
  const parsed = parseExpiresDate(rawExpires)
  const note = typeof json.note === 'string' && json.note.trim() ? json.note : null
  const recordedAt = typeof json.recordedAt === 'string' ? json.recordedAt : null
  if (!parsed.ok) {
    return { metaState: 'corrupt', meta: { expiresAt: rawExpires == null ? null : String(rawExpires), note, recordedAt }, error: `expiresAt ${parsed.error}` }
  }
  return { metaState: 'ok', meta: { expiresAt: parsed.value, note, recordedAt }, error: null }
}

/**
 * 原子写 meta（tmp + rename，mode 600；父目录 700）。
 * **只写 META_FIELDS**：调用方给的其它键一律丢弃（防止"顺手把 token 塞进来"）。
 */
export function writeMetaFile(file, { expiresAt, note = null, recordedAt }) {
  const p = parseExpiresDate(expiresAt)
  if (!p.ok) throw new Error(`拒绝写入非法 expiresAt：${p.error}`)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const payload = { expiresAt: p.value, note: note ?? null, recordedAt }
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch { /* 非 POSIX 文件系统没有 600 语义 —— 不因此拒绝写 */ }
  renameSync(tmp, file)
  return payload
}

// ── 把"读 + 判"合成一次评估 ────────────────────────────────────────────────

/**
 * @returns {{level: string, metaState: string, reason: string, error: string|null,
 *   metaFile: string, at: string, expiresAt: string|null, note: string|null,
 *   recordedAt: string|null, daysLeft: number|null, exitCode: number}}
 */
export function evaluate({ file, nowMs }) {
  const at = new Date(nowMs).toISOString()
  const r = readMetaFile(file)
  const common = {
    metaFile: file, at, metaState: r.metaState,
    expiresAt: r.meta?.expiresAt ?? null, note: r.meta?.note ?? null, recordedAt: r.meta?.recordedAt ?? null,
  }
  if (r.metaState !== 'ok') {
    return { ...common, level: LEVEL_UNKNOWN, reason: r.metaState, error: r.error, daysLeft: null, exitCode: EXIT_FOR_LEVEL[LEVEL_UNKNOWN] }
  }
  const days = daysLeft(r.meta.expiresAt, nowMs)
  const level = grade(days)
  return { ...common, level, reason: level, error: null, daysLeft: Number.isFinite(days) ? days : null, exitCode: EXIT_FOR_LEVEL[level] }
}

// ── 秘密形状守卫 ───────────────────────────────────────────────────────────

const SECRET_SHAPE = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/

/** `note` 里出现 token 形状 ⇒ true（写入口据此拒绝）。 */
export const containsSecretLike = (text) => SECRET_SHAPE.test(String(text ?? ''))

// ── 输出渲染 ───────────────────────────────────────────────────────────────

const fmtDays = (d) => (d == null ? '未知' : d < 0 ? `已过期 ${Math.abs(d)} 天` : `剩余 ${d} 天`)

/** `check` 的人类可读输出（`--quiet` 由调用方决定是否打印）。 */
export function renderCheckLines(result) {
  const head = `PAT 过期元数据：${result.metaFile}`
  if (result.level === LEVEL_UNKNOWN) {
    const why = result.reason === 'missing'
      ? '未知（未录入）'
      : `未知（meta 损坏：${result.error ?? '原因不明'}）`
    return [
      head,
      `  ${why}`,
      '  说明：个人 fine-grained PAT 的过期时间没有 REST 端点可读（GET /user 不返回 expires_at），只能人工录一次。',
      `  建议：node scripts/dsh-token-meta.mjs set --expires YYYY-MM-DD [--note "创建于…"]`,
    ]
  }
  const lines = [
    head,
    `  expiresAt=${result.expiresAt}（该 UTC 日结束前有效）  ${fmtDays(result.daysLeft)} → ${result.level}（${LEVEL_LABEL[result.level]}）`,
  ]
  if (result.note) lines.push(`  note=${result.note}`)
  if (result.recordedAt) lines.push(`  录入于 ${result.recordedAt}`)
  if (isActionable(result.level)) {
    lines.push(`  ⇒ 现在就轮换 token，然后重新录入：node scripts/dsh-token-meta.mjs set --expires YYYY-MM-DD`)
  } else if (result.level === 'warn' || result.level === 'urgent') {
    lines.push('  ⇒ 排进本周的轮换；换完记得重新录入新的 expiresAt')
  }
  return lines
}

/**
 * 写进 issue 的提醒正文。带 marker（`<!-- dsh-token-meta:level=… -->`）便于事后按级去重/取证。
 */
export function renderReminder(result, { owner = null, repo = null } = {}) {
  const mention = owner ? `@${String(owner).replace(/^@/, '')} ` : ''
  const lines = [
    `<!-- dsh-token-meta:level=${result.level} -->`,
    `## PAT 过期提醒：${LEVEL_LABEL[result.level]}`,
    '',
    `${mention}本地过期元数据（A4）判出 **${result.level}** 级别。`,
    '',
    `| 项 | 值 |`,
    `|---|---|`,
    `| 仓库 | \`${repo ?? '未知'}\` |`,
    `| meta 文件 | \`${result.metaFile}\` |`,
    `| expiresAt | ${result.expiresAt ? `\`${result.expiresAt}\`（该 UTC 日结束前有效）` : '未知'} |`,
    `| ${fmtDays(result.daysLeft)} | ${result.daysLeft == null ? '' : `分级 ${result.level}`} |`,
    `| 判定时刻 | ${result.at} |`,
  ]
  if (result.note) lines.push(`| note | ${result.note} |`)
  lines.push(
    '',
    '**为什么是人工录入**：个人 fine-grained PAT 的过期时间没有可读的 REST 端点（`GET /user` 不返回',
    '`expires_at`，fine-grained PAT 也没有 `X-OAuth-Scopes`）⇒ 只能创建/轮换时录一次，之后由',
    '`scripts/dsh-token-meta.mjs` 检查。',
    '',
    '轮换后重新录入：',
    '```bash',
    'node scripts/dsh-token-meta.mjs set --expires YYYY-MM-DD',
    'node scripts/dsh-token-meta.mjs check',
    '```',
    '',
    '（本 issue 由 `scripts/dsh-token-meta.mjs --notify` 自动维护；只在级别跃迁时评论，回到 ok 时自动关闭。）',
  )
  return lines.join('\n')
}

/** 恢复（回到 ok）时的关闭评论。 */
export function renderRecovery(result, { repo = null } = {}) {
  return [
    `<!-- dsh-token-meta:level=ok -->`,
    `## PAT 过期提醒已解除`,
    '',
    `本地过期元数据判出 **ok**：\`expiresAt=${result.expiresAt}\`（${fmtDays(result.daysLeft)}）。`,
    `判定时刻 ${result.at}，仓库 \`${repo ?? '未知'}\`。`,
    '',
    '自动关闭本条跟踪单；下次级别非 ok 时会重新打开。',
  ].join('\n')
}

// ── 每日门控 / 通知状态（`<state>.json`，与 meta 分离） ──────────────────────

export const STATE_SCHEMA = 1

/** UTC 日期（`YYYY-MM-DD`）—— `--if-due` 的"今天"是 UTC 日，和 expiresAt 的口径一致。 */
export const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10)

export function createCheckState(nowMs = Date.now()) {
  return {
    schema: STATE_SCHEMA,
    lastCheckedAt: null,
    lastCheckedDate: null,
    lastLevel: null,
    lastNotifiedLevel: null,
    lastNotifiedAt: null,
    lastNotifyError: null,
    updatedAt: new Date(nowMs).toISOString(),
  }
}

/** 读状态：损坏/未知 schema ⇒ 返回全新状态并标记 `corrupt`（fail-open，不静默停机）。 */
export function loadCheckState(file, nowMs = Date.now()) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    return { state: createCheckState(nowMs), corrupt: e?.code === 'ENOENT' ? null : String(e?.message ?? e), existed: false }
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch (e) {
    return { state: createCheckState(nowMs), corrupt: `不是合法 JSON：${String(e?.message ?? e).slice(0, 120)}`, existed: true }
  }
  if (json === null || typeof json !== 'object' || json.schema !== STATE_SCHEMA) {
    return { state: createCheckState(nowMs), corrupt: `schema 不是 ${STATE_SCHEMA}`, existed: true }
  }
  return { state: { ...createCheckState(nowMs), ...json, schema: STATE_SCHEMA }, corrupt: null, existed: true }
}

/** 原子写状态（600）。 */
export function saveCheckState(file, state, nowMs = Date.now()) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify({ ...state, schema: STATE_SCHEMA, updatedAt: new Date(nowMs).toISOString() }, null, 2)}\n`, { mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch { /* 见 writeMetaFile 的同一条注释 */ }
  renameSync(tmp, file)
  return state
}

/** `--if-due`：今天（UTC）还没跑过 ⇒ true。 */
export const isDue = (state, nowMs) => state?.lastCheckedDate !== utcDate(nowMs)
