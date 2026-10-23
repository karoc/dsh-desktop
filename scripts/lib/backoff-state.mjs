// backoff-state —— 三态健康机（healthy / degraded / broken）+ 指数退避 + **只在跃迁时通知**。
//
// 背景（docs/2026-10-24-alerting-and-idempotency-patterns.md §6、采用清单 A6）：
// 定时器每 10 分钟跑一次，失败时**每轮都重印同一段完整错误**。这既没有信息量（同一件事重复 8 次），
// 也掩盖了真正的信号（"什么时候开始坏的 / 中间有没有恢复过"），还会让 systemd 的
// `Restart=on-failure` + `RestartSec=60` 变成热循环。本模块把"最近一次结果 + 连续失败次数"变成状态，
// 由状态驱动输出与通知，而不是由"这一次是否抛异常"驱动（同 Argo CD 的 health / client-go 的
// 按 key 退避 + Forget）。
//
// 设计约束（每条都是刻意的）：
//   ① **纯函数优先**：`decide` / `recordOutcome` / `backoffMinutes` / `render*` 不碰 IO，可单测；
//      只有 `loadState` / `saveState` / `resetStateFile` 三个薄封装碰文件系统。
//   ② **按 tool 各自一份状态**（`~/.dsh/state/<tool>.json`）：一个工具坏了不拖慢另一个（client-go 的
//      per-item backoff）。同一文件内不再按 target 细分 —— 本仓的定时任务一次只处理一个 target。
//   ③ **状态文件损坏 ⇒ fail-open 回 healthy**（备份后重建）。坏状态文件绝不能把"还能报警的探针"
//      变成"永远静默"；代价是丢失退避历史，这是可接受的。
//   ④ **退避序列 5 → 10 → 20 → 40 → 封顶 60 分钟**（分钟）。取"心跳友好"的尺度：定时器 10 分钟一轮时，
//      5 分钟的等待立即到期（第一轮重试不被无谓拖慢），之后逐级放大到 60 分钟上限。
//   ⑤ **不可重试错误直接 broken**（403/404/凭据/权限）：重试不会好，只会在日志里重复 403 ——
//      这正是事故里 `updateIssue` 每轮失败的那条链。可重试错误（网络/超时/429/5xx）才走 N=3 的退化路径。
//   ⑥ **通知只在跃迁时**：healthy→degraded、degraded→broken、healthy→broken（首次即不可重试）、
//      broken→healthy。degraded→healthy 是**静默**的（还没通知过任何人，再通知一次只会制造噪音）。
//      `recordOutcome` 返回的 transition 里 `notify` 就是这条判据；写不写评论由调用方负责。
//   ⑦ 状态里留 `pendingNotification`：评论写失败时**下一轮补发**（至少一次），成功才清空。
//
// 状态文件 shape（schema 变更必须同时改 SCHEMA 并写迁移/备份）：
//   {
//     schema: 1, tool: 'dsh-watch', state: 'healthy'|'degraded'|'broken',
//     consecutiveFailures: 0, backoffRetries: 0, runsTotal: 0,
//     lastError: null, lastErrorAt: null, lastRunAt: null, lastSuccessAt: null,
//     nextAttemptAt: null,            // 仅 broken：下一次允许真正干活的时刻（ISO）
//     enteredStateAt: '<ISO>',        // 进入当前状态的时刻（"什么时候开始坏的"）
//     pendingNotification: null,      // { from,to,digest,text,at } —— 写失败待补发
//     notified: { <digest>: '<ISO>' } // 已发过的跃迁（幂等，防补发重复）
//   }
//
// 用法（同步、零依赖，node 18+）：
//   import { loadState, saveState, decide, recordOutcome, backoffMinutes, renderStillBroken } from './lib/backoff-state.mjs'
//   const { state } = loadState(file, { tool, nowMs })
//   const d = decide(state, nowMs)                  // broken 且未到 nextAttemptAt ⇒ d.skip = true
//   const { state: next, transition } = recordOutcome(state, { ok, error, nowMs })
//   saveState(file, next)

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const SCHEMA = 1
export const STATES = ['healthy', 'degraded', 'broken']
export const DEFAULT_THRESHOLD = 3
/** 指数退避的分钟序列；超过序列长度后封顶 MAX_BACKOFF_MIN。 */
export const BACKOFF_SCHEDULE_MIN = [5, 10, 20, 40]
export const MAX_BACKOFF_MIN = 60

const nowIso = (ms) => new Date(ms).toISOString()
const asInt = (v, d) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d)
const errorLine = (err) => String(err ?? 'unknown').split('\n').map((s) => s.trim()).filter(Boolean).slice(-1)[0].slice(0, 500)

/** 默认状态文件路径：`<stateDir>/state/<tool>.json`（stateDir 缺省 = `~/.dsh` ⇒ `~/.dsh/state/<tool>.json`）。 */
export function defaultStateFile(tool, stateDir = join(homedir(), '.dsh')) {
  return join(stateDir, 'state', `${tool}.json`)
}

/**
 * 退避分钟数：retry=1 ⇒ 5、2 ⇒ 10、3 ⇒ 20、4 ⇒ 40、5+ ⇒ 60（封顶）。
 * 序列是"每档翻倍、封顶 MAX_BACKOFF_MIN"，不是"从数组里取到最后一档就停"——否则 40 会变成永久间隔。
 * 坏输入按第 1 次处理（返回 5，不返回 NaN）。
 */
export function backoffMinutes(retry) {
  const n = Math.max(1, asInt(retry, 1))
  return Math.min(BACKOFF_SCHEDULE_MIN[0] * 2 ** (n - 1), MAX_BACKOFF_MIN)
}

/**
 * 不可重试错误：权限 / 凭据 / 目标不存在。重试只会把同一条 403 再印一遍（事故里 `updateIssue` 的链）。
 * 顺序很关键：先判"不可重试"，其余（网络/超时/限流/5xx）一律默认可重试 —— 默认值选"可重试"，
 * 因为把可重试错误误判成 broken 会提前停止探测，代价比多退避一轮更大。
 */
const NON_RETRYABLE = [
  /not accessible/i, /\b40[13]\b/, /not found/i, /bad credentials/i, /unauthori[sz]ed/i,
  /authentication/i, /permission denied/i, /resource not accessible/i,
]
export function isRetryable(error) {
  const text = String(error ?? '')
  return !NON_RETRYABLE.some((re) => re.test(text))
}

export function createState(tool, nowMs = Date.now()) {
  return {
    schema: SCHEMA,
    tool,
    state: 'healthy',
    consecutiveFailures: 0,
    backoffRetries: 0,
    runsTotal: 0,
    lastError: null,
    lastErrorAt: null,
    lastRunAt: null,
    lastSuccessAt: null,
    nextAttemptAt: null,
    enteredStateAt: nowIso(nowMs),
    pendingNotification: null,
    notified: {},
  }
}

/** 把任意来源的状态规范化：缺字段补默认、未知 state 回 healthy、时间戳坏掉当 null。**不抛异常**。 */
export function normalizeState(raw, tool, nowMs = Date.now()) {
  const base = createState(tool, nowMs)
  if (!raw || typeof raw !== 'object') return base
  const out = { ...base }
  for (const k of ['consecutiveFailures', 'backoffRetries', 'runsTotal']) out[k] = Math.max(0, asInt(raw[k], 0))
  out.state = STATES.includes(raw.state) ? raw.state : 'healthy'
  for (const k of ['lastError', 'lastErrorAt', 'lastRunAt', 'lastSuccessAt', 'nextAttemptAt', 'enteredStateAt']) {
    out[k] = typeof raw[k] === 'string' && raw[k] ? raw[k] : base[k]
  }
  if (raw.pendingNotification && typeof raw.pendingNotification === 'object') {
    const p = raw.pendingNotification
    if (typeof p.digest === 'string' && typeof p.text === 'string') {
      out.pendingNotification = { from: String(p.from ?? '?'), to: String(p.to ?? '?'), digest: p.digest, text: p.text, at: String(p.at ?? '') }
    }
  }
  if (raw.notified && typeof raw.notified === 'object' && !Array.isArray(raw.notified)) {
    for (const [k, v] of Object.entries(raw.notified)) if (typeof v === 'string') out.notified[k] = v
  }
  // 一致性修正：healthy 不该带退避；broken 必须有 nextAttemptAt（丢了就按当前时刻立即允许重试，
  // 而不是让进程永远跳过 —— "跳过"是一种主动状态，不能因为字段丢失而变成静默停机）。
  if (out.state !== 'broken') { out.nextAttemptAt = null; if (out.state === 'healthy') out.consecutiveFailures = out.consecutiveFailures && out.lastError ? out.consecutiveFailures : 0 }
  if (out.state === 'broken' && !out.nextAttemptAt) out.nextAttemptAt = nowIso(nowMs)
  return out
}

/**
 * 本轮该不该真正干活。
 * @returns {{ skip: boolean, reason: 'not-broken'|'backoff'|'retry-due', attempt?: number,
 *             nextAttemptAt?: string|null, minutesLeft?: number }}
 */
export function decide(state, nowMs = Date.now()) {
  const st = normalizeState(state, state?.tool ?? '?', nowMs)
  if (st.state !== 'broken') return { skip: false, reason: 'not-broken', state: st }
  const next = st.nextAttemptAt ? Date.parse(st.nextAttemptAt) : NaN
  // nextAttemptAt 解析不了 ⇒ 不跳过（宁可多跑一次，也不能静默停机）。
  if (Number.isFinite(next) && nowMs < next) {
    return {
      skip: true, reason: 'backoff', attempt: st.consecutiveFailures,
      nextAttemptAt: st.nextAttemptAt, minutesLeft: Math.max(1, Math.ceil((next - nowMs) / 60000)),
    }
  }
  return { skip: false, reason: 'retry-due', attempt: st.consecutiveFailures, nextAttemptAt: st.nextAttemptAt }
}

/**
 * 记录一轮结果，返回新状态 + 本次跃迁（没有跃迁时 transition = null）。
 * transition.notify = 是否应该发通知（只有 healthy→degraded / →broken / broken→healthy 为 true）。
 */
export function recordOutcome(state, { ok, error = null, nowMs = Date.now(), threshold = DEFAULT_THRESHOLD, retryable = null } = {}) {
  const st = normalizeState(state, state?.tool ?? '?', nowMs)
  const at = nowIso(nowMs)
  const prev = st.state
  st.lastRunAt = at
  st.runsTotal += 1

  if (ok) {
    st.consecutiveFailures = 0
    st.backoffRetries = 0
    st.nextAttemptAt = null
    st.lastSuccessAt = at
    st.state = 'healthy'
    if (prev !== 'healthy') st.enteredStateAt = at
    const transition = prev === 'healthy'
      ? null
      : { from: prev, to: 'healthy', notify: prev === 'broken', attempt: 0, retryInMinutes: null }
    return { state: st, transition }
  }

  st.consecutiveFailures += 1
  st.lastError = errorLine(error)
  st.lastErrorAt = at
  const canRetry = retryable === null ? isRetryable(st.lastError) : Boolean(retryable)
  const brokeNow = !canRetry || st.consecutiveFailures >= Math.max(1, asInt(threshold, DEFAULT_THRESHOLD))

  if (!brokeNow) {
    st.state = 'degraded'
    if (prev !== 'degraded') st.enteredStateAt = at
    const transition = prev === 'degraded' ? null : { from: prev, to: 'degraded', notify: true, attempt: st.consecutiveFailures, retryInMinutes: null }
    return { state: st, transition }
  }

  st.state = 'broken'
  st.backoffRetries = prev === 'broken' ? st.backoffRetries + 1 : 1
  const minutes = backoffMinutes(st.backoffRetries)
  st.nextAttemptAt = nowIso(nowMs + minutes * 60000)
  if (prev !== 'broken') st.enteredStateAt = at
  // broken→broken（重试仍失败）**不发通知**：状态没变，评论只会变成"每轮一条"。
  const transition = { from: prev, to: 'broken', notify: prev !== 'broken', attempt: st.consecutiveFailures, retryInMinutes: minutes }
  return { state: st, transition }
}

// ── 渲染（纯函数：同一输入同一输出，便于在测试里逐字断言）─────────────────────
/** 退避中的**唯一一行**输出（既是 still-broken 通知，也是"进程还在"的心跳）。 */
export function renderStillBroken({ attempt, minutesLeft, nowIso: at = nowIso(Date.now()) }) {
  return `still broken (attempt ${attempt}, next retry in ${Math.max(1, asInt(minutesLeft, 1))}m) — heartbeat ${at}`
}

/** broken 但到达重试窗口、重试仍然失败时的一行摘要（完整错误进状态文件 / 明细文件）。 */
export function renderRetriedFailure({ attempt, minutesLeft, error, nowIso: at = nowIso(Date.now()) }) {
  const why = errorLine(error)
  return `still broken (attempt ${attempt}, next retry in ${Math.max(1, asInt(minutesLeft, 1))}m) — heartbeat ${at}`
    + (why ? ` — ${why}` : '')
}

/** 进入 broken 的那一轮：一行摘要（不是完整栈，也不是每轮重印）。 */
export function renderBrokenEntry({ attempt, minutesLeft, error, threshold = DEFAULT_THRESHOLD }) {
  const why = errorLine(error)
  return `broken: 连续 ${asInt(attempt, threshold)} 次失败（阈值 ${threshold}），进入退避 —— 下次重试 ${Math.max(1, asInt(minutesLeft, 1))}m 后`
    + (why ? `；最后一次：${why}` : '')
}

/**
 * 跃迁评论正文 + 机器标记。`state=<to>` 让 grep / 反向心跳脚本能直接读。
 * `digestToken`（可选）由调用方给 —— 它必须**与"这一次故障"一一对应且跨轮次稳定**：
 * 调用方一般用 `<tool>|<from>|<to>|<enteredStateAt>` 的哈希，于是"补发"不会重复评论，
 * 而"恢复后再次坏掉"（enteredStateAt 变了）仍然是新的一条。
 */
export function renderTransitionComment({ tool, transition, error = null, threshold = DEFAULT_THRESHOLD, nextAttemptAt = null, digestToken = null, nowIso: at = nowIso(Date.now()) }) {
  const { from, to, attempt, retryInMinutes } = transition
  const digest = digestToken ?? `${tool}|${from}|${to}|${errorLine(error)}`
  const marker = `<!-- ${tool}-backoff: state=${to} from=${from} attempt=${attempt ?? 0}`
    + `${retryInMinutes ? ` retry_in=${retryInMinutes}m` : ''}${nextAttemptAt ? ` next=${nextAttemptAt}` : ''} digest=${digest} at=${at} -->`
  const head = to === 'healthy'
    ? `**自动化状态跃迁：${from} → healthy**（恢复）`
    : to === 'broken'
      ? `**自动化状态跃迁：${from} → broken**（进入退避）`
      : `**自动化状态跃迁：${from} → degraded**（连续失败，未到 broken 阈值）`
  const lines = [head, '']
  if (to === 'healthy') {
    lines.push(`\`${tool}\` 本轮成功，退避与失败计数已清零（此前状态 \`${from}\`）。`)
  } else {
    lines.push(`\`${tool}\` 已连续失败 **${attempt}** 次；阈值为 ${threshold}。`)
    if (error) lines.push('', '最后一次错误（末行）：', '', '```', errorLine(error), '```')
    if (to === 'broken') {
      lines.push('', `**进入退避**：之后的轮次只输出一行 \`still broken (attempt k, next retry in Xm)\`，`
        + `不再每轮重印完整错误；重试间隔 ${retryInMinutes ? `${retryInMinutes} 分钟起` : '按指数'}（5 → 10 → 20 → 40，封顶 60 分钟）。`
        + `${nextAttemptAt ? ` 下次重试：\`${nextAttemptAt}\`。` : ''}`)
      lines.push('', '**只在跃迁时通知**：同一状态的重复失败不评论、不重印完整错误；恢复时再发一条 `state=healthy`。')
      lines.push('', '人工恢复：修好根因后跑一次 `--reset-state`（不会写 GitHub），或等下一次成功自动回到 `healthy`。')
    } else {
      lines.push('', `同一状态的重复失败**不再发评论**（只在跃迁时通知）；到第 ${threshold} 次连续失败即转 \`broken\` 并只再通知一次。`)
    }
  }
  lines.push('', marker)
  return { body: lines.join('\n'), digest, marker }
}

/** 心跳行（写文件，不占 stdout）。供 A5 的反向心跳/死手开关读取：state=broken ≠ 进程死了。 */
export function renderHeartbeat({ tool, state, nowIso: at = nowIso(Date.now()), attempt = 0, skipped = false, exit = 0 }) {
  return `${at} tool=${tool} state=${state} attempt=${attempt} skipped=${skipped ? 'yes' : 'no'} exit=${exit}`
}

// ── 文件系统（薄封装；失败抛异常由调用方决定怎么降级）────────────────────────
export function stateFilePath({ tool, stateFile = null, stateDir = null }) {
  if (stateFile) return stateFile
  return defaultStateFile(tool, stateDir ?? join(homedir(), '.dsh'))
}

/**
 * 读状态。文件不存在 ⇒ 全新 healthy（首次运行不是故障）；**存在但坏掉 ⇒ 备份 + 重建 healthy**（fail-open）。
 * @returns {{ state: object, existed: boolean, corrupt: null | { backupPath: string, reason: string } }}
 */
export function loadState(file, { tool, nowMs = Date.now(), stamp = nowIso(nowMs) } = {}) {
  if (!existsSync(file)) return { state: createState(tool, nowMs), existed: false, corrupt: null }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    return { state: createState(tool, nowMs), existed: false, corrupt: { backupPath: '', reason: `读不出来：${err.message}` } }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return quarantine(file, tool, nowMs, `JSON 解析失败：${err.message}`, stamp)
  }
  if (!raw || typeof raw !== 'object') return quarantine(file, tool, nowMs, 'JSON 不是对象', stamp)
  if (raw.schema !== SCHEMA) return quarantine(file, tool, nowMs, `schema=${JSON.stringify(raw.schema)} 不是 ${SCHEMA}`, stamp)
  return { state: normalizeState(raw, tool, nowMs), existed: true, corrupt: null }
}

function quarantine(file, tool, nowMs, reason, stamp) {
  const backupPath = `${file}.corrupt-${String(stamp).replace(/[:.]/g, '')}`
  try { copyFileSync(file, backupPath) } catch { /* 备份失败也继续：重建比"带着坏状态停机"重要 */ }
  return { state: createState(tool, nowMs), existed: false, corrupt: { backupPath, reason } }
}

/** 原子写：同目录写临时文件再 rename，避免读到半截 JSON（并发/崩溃窗口）。 */
export function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
  return file
}

/** `--reset-state`：人工恢复。保留文件（记 runsTotal=0、healthy），并清掉待补发通知。 */
export function resetStateFile(file, { tool, nowMs = Date.now() } = {}) {
  const fresh = createState(tool, nowMs)
  saveState(file, fresh)
  return fresh
}

/** 心跳文件：默认与状态文件同目录（`<state>.heartbeat`），一行一次运行。 */
export function heartbeatFileFor(file) {
  return file.replace(/\.json$/, '.heartbeat')
}
export function appendHeartbeat(file, line, { maxLines = 200 } = {}) {
  mkdirSync(dirname(file), { recursive: true })
  let prev = ''
  try { prev = readFileSync(file, 'utf8') } catch { /* 首次写 */ }
  const lines = prev.split('\n').filter(Boolean)
  lines.push(line)
  // 心跳只服务"最近还活着吗"，不服务取证 ⇒ 有界行数，不参与日志轮转。
  writeFileSync(file, `${lines.slice(-maxLines).join('\n')}\n`, { mode: 0o600 })
  return file
}
export function clearHeartbeat(file) {
  try { rmSync(file) } catch { /* 不存在即可 */ }
}
