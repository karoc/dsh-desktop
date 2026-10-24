#!/usr/bin/env node
// dsh-doctor —— ① 凭据能力探测（canary 写）② 反向心跳（dead man's switch）③ 自测。
//
// 为什么需要它（docs/2026-10-24-alerting-and-idempotency-patterns.md §0.3 / §4 / §2.3）：
// 上游真发版时暴露了两个盲区 ——
//   · **能读不能写**：PAT 的仓库角色是 `admin=true`，`gh api repos/{repo}` 看起来"什么都能干"，
//     但 fine-grained PAT 的资源级权限里**没有 Issues:write** ⇒ `updateIssue` / `addLabelsToLabelable`
//     403。GitHub **没有**「模拟写」接口（AWS SimulatePrincipalPolicy / k8s SelfSubjectAccessReview
//     的等价物），classic token 能读 `X-OAuth-Scopes`、fine-grained PAT 连这个头都没有 ⇒
//     唯一可靠的判据是 **canary 写**：用真实凭据做一次**可逆**写，失败就 fail-closed。
//   · **心跳死了没人知道**：`Restart=on-failure` 只能覆盖"脚本自己知道自己失败"；机器关机 / timer 被
//     disable / 脚本一直失败时**没有人收到"没有告警"的告警**。本脚本把「本机最后一次成功写操作」写进
//     一条专用 canary issue 的正文（`last-ok=<ISO>`），云端 `dsh-heartbeat-check.yml` 每日读它：
//     新鲜 ⇒ 静默；陈旧 ⇒ 评论 @owner + `priority:high`。
//
// 用法：
//   node scripts/dsh-doctor.mjs [--dry-run] [--json <out>] [--repo <owner/name>] [--now <iso>]
//                               [--heartbeat-file <path>] [--timeout <sec>]
//      能力矩阵（默认模式）。用真实凭据对**专用 canary issue**（标题含 `[dsh-doctor] canary`，
//      首次自动创建后复用）做可逆写：改正文（写入 → 读回 → 还原，净变化只有 `last-ok` 心跳字段）。
//      输出 7 行矩阵：读 issue 列表 / 建 canary / 改 canary 正文 / 评论 / 加 label / 关闭
//      + **PAT 过期（本地 token.meta，A4）**。每行 ✓ / ✗ + 实际错误信息（**错误信息里的 token 一律打码**）。
//      最后一行的数据源是**本机文件**（`~/.dsh/token.meta.json`），不是 GitHub：个人 fine-grained PAT 的
//      过期时间没有 REST 端点可读 ⇒ 那一行永远不参与退出码（缺失 = "未知（建议 set）"，**不是失败**）。
//      `--dry-run` 只读（不写、不写心跳文件）；`--json <out>` 把矩阵写成 JSON（`--json -` 打到 stdout）。
//
//   node scripts/dsh-doctor.mjs --heartbeat-check [--grace-hours 26] [--repeat-hours 168]
//                               [--now <iso>] [--repo <owner/name>] [--dry-run] [--json <out>]
//      反向心跳判据（云端 dsh-heartbeat-check.yml 的薄壳内容）。**双向**：
//        心跳新鲜（age ≤ grace）⇒ 静默，exit 0（不评论、不加 label）；
//        心跳陈旧（age > grace）⇒ 评论 `@owner` + 加 `priority:high`，exit 3；
//        canary 不存在 ⇒ 先创建（正文带 `bootstrap-at`，进入宽限期）再判断 ⇒ 本次静默，**不误报**。
//      canary 在、但正文里既没有 `last-ok` 也没有 `bootstrap-at` ⇒ 无法判定 ⇒ 按陈旧报警（fail-loud）。
//
//   node scripts/dsh-doctor.mjs --self-test
//      自测（零外部依赖：内置有状态 gh 桩，跑在临时目录里，不碰仓库/真实 gh/真实 ~/.dsh）。
//      覆盖：矩阵幂等（跑两次不重复建 canary/评论）、403 注入（该项 ✗、退出码非零、不再试写、
//      token 打码）、心跳陈旧 48h ⇒ 报警、心跳新鲜 5min ⇒ 静默、canary 缺失 ⇒ 创建且不误报。
//
// 退出码：
//   默认模式   0 = 必需能力全部可用；1 = 有必需能力缺失 / 读列表失败 / gh 不可用；2 = 用法错误。
//   心跳模式   0 = 静默（新鲜或刚创建）；3 = **已报警**（陈旧；这是「报警」不是「job 坏了」）；
//              1 = 检查自身坏了（读不到 issue / 报警手段全部失败）；2 = 用法错误。
//   自测       0 = 全部断言通过；1 = 有断言失败。
//
// 测试注入点：`GH_BIN`（默认 **`scripts/gh`** —— 项目专用 PAT；**不要**用裸 `gh`，它落到另一个 token）、
// `--repo` / `GH_REPO` / `GITHUB_REPOSITORY`、`--now`（钉住"现在"）、`--heartbeat-file` /
// `DSH_HEARTBEAT_FILE`（心跳文件位置）、`--timeout`（单次 gh 调用秒数）。
//
// 负面保证（写在这里，防止后来者"顺手优化掉"）：
//   · 不会在 403 之后继续试写（遇错立即停止后续写探测，避免次级限流与重复 403 噪音）；
//   · 不会反复建 canary（按标题查找并复用；只允许全仓一条）；
//   · 不会把 token 打进任何输出（含错误信息）；
//   · 不会在 `--dry-run` 下写任何远端对象或本地心跳文件；
//   · 不会用 `permissions.admin=true` 推断 Issues 可写（那正是本次事故的反例）。

import { execFileSync } from 'node:child_process'
import { accessSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { LEVEL_LABEL as TOKEN_LEVEL_LABEL, evaluate as evaluateTokenMeta } from './lib/token-meta.mjs'

const SELF = fileURLToPath(import.meta.url)
const ROOT = join(dirname(SELF), '..')

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valOf = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] ?? d : d }
const MODE = has('--self-test') ? 'selftest' : has('--heartbeat-check') ? 'heartbeat' : 'doctor'
const DRY = has('--dry-run')
const OUT = valOf('--json')
const NOW_ARG = valOf('--now')
const NOW = NOW_ARG ? new Date(NOW_ARG) : new Date()
if (Number.isNaN(NOW.getTime())) {
  console.error(`--now 不是合法时间：${NOW_ARG}（要 ISO 8601，例如 2026-10-24T04:00:00Z）—— 拒绝用坏时间戳静默判定心跳`)
  process.exit(2)
}
const NOW_ISO = NOW.toISOString()
const GRACE_HOURS = Number(valOf('--grace-hours', '26'))
if (!Number.isFinite(GRACE_HOURS) || GRACE_HOURS <= 0) {
  console.error(`--grace-hours 必须是正数：${valOf('--grace-hours')}`)
  process.exit(2)
}
const REPEAT_HOURS = Number(valOf('--repeat-hours', '168'))
if (!Number.isFinite(REPEAT_HOURS) || REPEAT_HOURS < 0) {
  console.error(`--repeat-hours 必须是非负数：${valOf('--repeat-hours')}`)
  process.exit(2)
}
const TIMEOUT_MS = Number(valOf('--timeout', '60')) * 1000
if (!Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS <= 0) {
  console.error(`--timeout 必须是正数（秒）：${valOf('--timeout')}`)
  process.exit(2)
}

// 仓库 / 属主解析顺序与 dsh-watch 一致（--repo > GH_REPO > GITHUB_REPOSITORY > git remote origin > 默认）。
// 属主用于心跳报警里的 @提及；取不到就退回仓库 slug 的 owner，再取不到则**不加提及**并明确告警
// （不静默降级成"没人被叫醒"的告警）。
const GIT_SLUG = (() => {
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: ROOT, encoding: 'utf8' }).trim()
    const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url)
    return m ? `${m[1]}/${m[2]}` : null
  } catch { return null }
})()
const REPO_ARG = valOf('--repo')
const REPO = REPO_ARG || process.env.GH_REPO || process.env.GITHUB_REPOSITORY || GIT_SLUG || 'karoc/dsh-desktop'
const REPO_SOURCE = REPO_ARG ? '--repo' : process.env.GH_REPO ? 'GH_REPO' : process.env.GITHUB_REPOSITORY ? 'GITHUB_REPOSITORY' : GIT_SLUG ? 'git remote origin' : '内置默认'
const OWNER = String(valOf('--assignee') || process.env.DSH_ISSUE_ASSIGNEE || REPO.split('/')[0]).trim().replace(/^@/, '')

// gh 二进制：默认项目专用包装（**不是**裸 gh）。相对路径按仓库根解析，这样在任何 cwd 下都指向同一个凭据。
const GH_RAW = process.env.GH_BIN ?? 'scripts/gh'
const GH_BIN = (GH_RAW.includes('/') || GH_RAW.includes('\\')) && !isAbsolute(GH_RAW) ? join(ROOT, GH_RAW) : GH_RAW

const HEARTBEAT_FILE = valOf('--heartbeat-file') || process.env.DSH_HEARTBEAT_FILE || join(homedir(), '.dsh/heartbeat.json')
// PAT 过期元数据（A4）：**本地文件**，写入口是 `scripts/dsh-token-meta.mjs set`。缺失 = 未知，不判红。
const TOKEN_META_FILE = valOf('--token-meta') || process.env.DSH_TOKEN_META || join(homedir(), '.dsh/token.meta.json')
const CANARY_TITLE = '[dsh-doctor] canary — 凭据能力探测 / 反向心跳载体（自动化维护，勿删）'
const CANARY_RE = /\[dsh-doctor\]\s+canary/i
const PROBE_LINE_RE = /^<!-- dsh-doctor:probe nonce=[0-9a-z]+ -->$/m
const ALARM_MARK = '<!-- dsh-doctor:heartbeat-alarm -->'
const COMMENT_MARK = '<!-- dsh-doctor:comment-probe -->'
const PROBE_LABEL = 'dsh-doctor-probe'
const PRIORITY_LABEL = 'priority:high'

// ── token 打码 ──────────────────────────────────────────────────────────────
// 纪律：token 等同 bearer 凭据，任何输出（含 gh 的错误信息）都不得出现。
// 已知值从环境与项目 token 文件取（**只用于替换**，绝不打印；读不到就算了）。
const SECRETS = (() => {
  const list = [process.env.GH_TOKEN, process.env.GITHUB_TOKEN]
  try {
    const raw = readFileSync(join(homedir(), '.config/gh-dsh-desktop/token'), 'utf8')
    for (const line of raw.split('\n')) {
      const v = line.trim()
      if (v && !v.startsWith('#')) list.push(v)
    }
  } catch { /* 没有 token 文件（CI / 自测）—— 不用它 */ }
  return list.filter((s) => typeof s === 'string' && s.length >= 8)
})()

/** 打码：先抹掉已知 token 值，再抹掉 token 形状（防止"部分打印"与未知来源的 token）。 */
function redact(text) {
  let out = String(text ?? '')
  for (const sec of SECRETS) out = out.split(sec).join('<redacted>')
  return out
    .replace(/github_pat_[A-Za-z0-9_]{10,}/g, '<redacted>')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<redacted>')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{10,}/g, '<redacted>')
}

// ── gh 调用 ─────────────────────────────────────────────────────────────────
/** 同步调用 gh；**绝不把 token 放进 argv/env 的可见输出**。返回结构化结果而不是抛异常。 */
function runGH(args, { cwd = ROOT, env = process.env } = {}) {
  try {
    const stdout = execFileSync(GH_BIN, args, {
      encoding: 'utf8',
      cwd,
      env,
      timeout: TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, stdout: String(stdout ?? ''), stderr: '', status: 0 }
  } catch (e) {
    const stdout = e?.stdout != null ? String(e.stdout) : ''
    const stderr = e?.stderr != null ? String(e.stderr) : ''
    const status = typeof e?.status === 'number' ? e.status : null
    // ENOENT / 超时走 e.message；两者都可能带路径，不含 token，但仍统一打码。
    const msg = stderr.trim() || e?.message || String(e)
    return { ok: false, stdout, stderr, status, error: redact(msg) }
  }
}

/** 一句话错误（用于矩阵的 detail 列）：第一行、最多 240 字符、已打码。 */
const oneLine = (r) => redact(String(r.error || r.stderr || 'unknown error').split('\n')[0].trim()).slice(0, 240)

function preflightGH() {
  if (GH_RAW.includes('/') || GH_RAW.includes('\\')) {
    try { accessSync(GH_BIN) } catch {
      console.error(`GH_BIN 指向的 gh 不存在：${GH_BIN}\n（默认是仓库内的 scripts/gh —— 项目专用 PAT 包装；CI 里请显式设 GH_BIN=gh）`)
      process.exit(1)
    }
  }
  const v = runGH(['--version'])
  if (!v.ok) {
    console.error(`无法执行 gh（GH_BIN=${GH_BIN}）：${oneLine(v)}\n提示：本机用 ./scripts/gh（项目专用 token），CI 用 GH_BIN=gh + GITHUB_TOKEN。`)
    process.exit(1)
  }
  return String(v.stdout).split('\n')[0].trim()
}

// ── 正文标记（canary 的状态就存在正文里：云端只看得到 issue，看不到本机文件） ──────
const fieldRe = (k) => new RegExp(`^${k}=(.*)$`, 'm')
function getField(body, key) {
  const m = fieldRe(key).exec(String(body ?? ''))
  return m ? m[1].trim() : null
}
/** 设置 `key=value` 行：存在则原位替换（不新增行），不存在则追加在末尾。 */
function setField(body, key, value) {
  const text = String(body ?? '')
  const re = fieldRe(key)
  if (re.test(text)) return text.replace(re, () => `${key}=${value}`)
  return `${text.replace(/\s+$/, '')}\n${key}=${value}\n`
}
/** 去掉探测行（上次运行若在"还原"前崩溃，会留下它；幂等复用必须能自愈）。 */
const stripProbe = (body) => String(body ?? '').replace(/^<!-- dsh-doctor:probe nonce=[0-9a-z]+ -->\n?/gm, '')
const stripMarkers = (body) => stripProbe(String(body ?? '').replace(/\r\n/g, '\n')).trim()
const hasProbe = (body, nonce) => String(body ?? '').includes(`nonce=${nonce}`)

function baseBody(nowIso) {
  return `dsh-doctor canary —— \`scripts/dsh-doctor.mjs\` 自动维护的**凭据能力探测 / 反向心跳**载体。

- **请勿删除、请勿改标题**；全仓只需要一条（脚本按标题查找并复用，不会重复创建）。
- \`last-ok=\` 是本机自动化**最后一次成功完成写操作**的 UTC 时间。云端
  \`.github/workflows/dsh-heartbeat-check.yml\` 每日读它判断心跳是否陈旧
  （默认 >${GRACE_HOURS}h 未更新 ⇒ 在该 issue 评论 @${OWNER} + 加 \`${PRIORITY_LABEL}\`）。
- \`bootstrap-at=\` 是首次创建时间，**只在"从未写入过 last-ok"时**用于宽限期，避免刚建就误报。

last-ok=
bootstrap-at=${nowIso}
`
}

// ── 输出工具 ────────────────────────────────────────────────────────────────
const isWide = (ch) => /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch)
const width = (s) => [...String(s)].reduce((n, ch) => n + (isWide(ch) ? 2 : 1), 0)
const padEndW = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)))
const SYM = {
  ok: '✓', fail: '✗', skip: '⊘', dry: '⊘', pending: '·',
  warn: '!', urgent: '!', critical: '✗', expired: '✗', unknown: '·',
}
const VERDICT = {
  ok: '可用', fail: '不可用', skip: '未探测', dry: '未探测（dry-run）', pending: '未执行',
  warn: '提醒（≤14 天）', urgent: '尽快轮换（≤7 天）', critical: '立即轮换（≤1 天）',
  expired: '已过期', unknown: '未知（未录入）',
}

function printMatrix(rows) {
  const w = Math.max(...rows.map((r) => width(r.label))) + 2
  console.log('\n能力矩阵（操作 × 结果；✓=可用 ✗=不可用 ⊘=未探测）')
  for (const r of rows) {
    const sym = SYM[r.status] ?? '?'
    const tail = r.error ? ` —— 错误：${r.error}` : r.detail ? ` —— ${r.detail}` : ''
    console.log(`  ${sym} ${padEndW(r.label, w)}${tail}`)
  }
}

function appendStepSummary(md) {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (!file) return
  try { writeFileSync(file, `${md}\n`, { flag: 'a' }) } catch { /* summary 不是判据，写不进去不影响退出码 */ }
}

function readVersion() {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? 'unknown' } catch { return 'unknown' }
}

// 自愈：上次"关闭"探测在重开前失败会把 canary 留在 CLOSED。不能因为状态就另建一条。
function findCanary(issues) {
  const matches = issues.filter((i) => CANARY_RE.test(String(i.title ?? '')))
  matches.sort((a, b) => Number(a.number) - Number(b.number))
  return { canary: matches[0] ?? null, duplicates: matches.slice(1) }
}

/** `--json` 输出（`-` = stdout）。先渲染再决定，保证任何路径都能拿到机器可读结果。 */
function emitJSON(payload) {
  const text = `${JSON.stringify(payload, null, 2)}\n`
  if (OUT === '-') process.stdout.write(text)
  else if (OUT) writeFileSync(OUT, text)
}

// ── 模式 1：能力矩阵 ────────────────────────────────────────────────────────
function doctor() {
  const ghVersion = preflightGH()
  console.log(`dsh-doctor —— 凭据能力探测（canary 写）`)
  console.log(`  仓库：${REPO}（来源：${REPO_SOURCE}）`)
  console.log(`  gh  ：${GH_BIN}（${ghVersion}）`)
  console.log(`  PAT 过期元数据：${TOKEN_META_FILE}（本地文件；缺失 = 未知，**不判红**）`)
  if (DRY) console.log('  模式：--dry-run（只读；不写远端、不写心跳文件）')

  const rows = []
  const row = (key, label, required = true) => {
    const r = { key, label, required, status: 'pending', detail: '', error: null }
    rows.push(r)
    return r
  }
  const mark = (r, status, detail = '', error = null) => { r.status = status; r.detail = detail; r.error = error ? redact(error) : null; return r }

  // 一旦某个**写**操作失败就停止后续写探测：403 是资源级权限边界，继续试只会制造更多 403 与次级限流。
  let writeBlock = ''
  const blockWrites = (why) => { writeBlock = writeBlock || why }

  // ① 读 issue 列表（所有后续操作的前提）
  const readRow = row('read', '读 issue 列表')
  const listing = runGH(['issue', 'list', '--state', 'all', '--limit', '100', '--json', 'number,title,body,state,labels,createdAt'])
  let issues = []
  if (!listing.ok) {
    mark(readRow, 'fail', '', oneLine(listing))
    blockWrites('读 issue 列表失败，无法定位 canary')
  } else {
    try {
      issues = JSON.parse(listing.stdout)
      const cap = issues.length >= 100 ? '（⚠️ 命中 --limit 100 上限，可能被截断）' : ''
      mark(readRow, 'ok', `${issues.length} 条（state=all）${cap}`)
    } catch (e) {
      mark(readRow, 'fail', '', `返回的不是 JSON：${redact(e.message).slice(0, 120)}`)
      blockWrites('issue 列表无法解析')
    }
  }

  // 对照：仓库级角色权限。**它不能证明 Issues 可写** —— 本脚本存在的理由就是这次反例。
  let permissions = null
  const perm = runGH(['api', `repos/${REPO}`, '--jq', '.permissions'])
  if (perm.ok) {
    try { permissions = JSON.parse(perm.stdout) } catch { permissions = perm.stdout.trim() }
    const flat = typeof permissions === 'string' ? permissions : Object.entries(permissions).map(([k, v]) => `${k}=${v}`).join(' ')
    console.log(`\n仓库级 permissions：${flat}`)
    console.log('  ⚠️ admin=true 是**仓库角色**，不表示 fine-grained PAT 有 Issues 写权限（2026-10-24 事故反例：')
    console.log('     admin=true 仍然 updateIssue / addLabelsToLabelable 403）—— 所以下面要真实写一次。')
  } else {
    console.log(`\n仓库级 permissions：读不到（${oneLine(perm)}）—— 不影响矩阵，但没有对照值。`)
  }
  const identity = runGH(['api', 'user', '--jq', '.login'])
  if (identity.ok) console.log(`凭据身份：${identity.stdout.trim()}（gh api user）`)
  else console.log(`凭据身份：读不到（${oneLine(identity)}）`)

  // ② 建 canary（只建一条、之后复用）
  const createRow = row('create', '建 canary')
  let canary = null
  let created = false
  let duplicates = []
  if (!listing.ok) {
    mark(createRow, 'skip', '依赖「读 issue 列表」失败')
  } else {
    const found = findCanary(issues)
    canary = found.canary
    duplicates = found.duplicates
    if (canary) {
      mark(createRow, 'ok', `复用 #${canary.number}（已存在，未新建）`)
    } else if (DRY) {
      mark(createRow, 'dry', '将创建（dry-run 不写）')
    } else if (writeBlock) {
      mark(createRow, 'skip', writeBlock)
    } else {
      const bodyFile = join(mkdtempSync(join(tmpdir(), 'dsh-doctor-')), 'canary.md')
      writeFileSync(bodyFile, baseBody(NOW_ISO))
      const created_ = runGH(['issue', 'create', '--title', CANARY_TITLE, '--body-file', bodyFile])
      if (!created_.ok) {
        mark(createRow, 'fail', '', oneLine(created_))
        blockWrites('建 canary 失败（403/权限不足），不再追加写请求')
      } else {
        const num = /\/issues\/(\d+)/.exec(created_.stdout)?.[1]
        if (!num) {
          mark(createRow, 'fail', '', `创建成功但没解析出 issue 号：${redact(created_.stdout).slice(0, 120)}`)
          blockWrites('创建后无法确认 issue 号')
        } else {
          created = true
          canary = { number: Number(num), body: baseBody(NOW_ISO), state: 'OPEN' }
          mark(createRow, 'ok', `已创建 #${num}`)
        }
      }
    }
  }
  if (duplicates.length) {
    console.log(`\n⚠️ 检测到 ${duplicates.length + 1} 条 canary（#${[canary?.number, ...duplicates.map((d) => d.number)].filter(Boolean).join('、#')}）——`)
    console.log(`   使用 **#${canary.number}**，多余条目需人工关闭（并发创建；本脚本不会自动删/关别人可见的 issue）。`)
  }

  const canaryNo = canary?.number ?? null

  // 自愈：canary 被留在 CLOSED（上次"关闭"探测在重开前失败）⇒ 先重开，否则云端心跳检查会误判。
  if (canary?.state && String(canary.state).toUpperCase() !== 'OPEN' && !DRY && !writeBlock) {
    const re = runGH(['issue', 'reopen', String(canaryNo)])
    if (!re.ok) {
      console.log(`\n⚠️ canary #${canaryNo} 当前是 ${canary.state}，重开失败：${oneLine(re)}`)
      blockWrites('canary 无法重开，写探测失去可复用的对象')
    } else {
      console.log(`\n修复：canary #${canaryNo} 原本是 ${canary.state}，已重开（不新建第二条）。`)
      canary.state = 'OPEN'
    }
  }

  // ③ 改 canary 正文：写入（last-ok + 探针行）→ 读回 → 还原（探针行去掉、last-ok 保留）
  //    这是"可逆写"的定义：远端正文的**净变化只有 last-ok** 这一个心跳字段，探针行不残留。
  const editRow = row('edit', '改 canary 正文')
  let didWrite = false
  let lastOkWritten = null
  const viewIssue = (fields) => {
    const r = runGH(['issue', 'view', String(canaryNo), '--json', fields])
    if (!r.ok) return { ok: false, error: oneLine(r) }
    try { return { ok: true, data: JSON.parse(r.stdout) } } catch (e) { return { ok: false, error: `返回的不是 JSON：${redact(e.message)}` } }
  }
  if (canaryNo == null) {
    mark(editRow, DRY ? 'dry' : 'skip', DRY ? '将写入（dry-run 不写）' : '没有 canary')
  } else if (DRY) {
    mark(editRow, 'dry', '将写入→读回→还原（dry-run 不写）')
  } else if (writeBlock) {
    mark(editRow, 'skip', writeBlock)
  } else {
    const v = viewIssue('body')
    if (!v.ok) {
      mark(editRow, 'fail', '', `读正文失败：${v.error}`)
      blockWrites('读不到 canary 正文')
    } else {
      const original = String(v.data.body ?? '')
      const nonce = randomBytes(4).toString('hex')
      const target = stripProbe(setField(original, 'last-ok', NOW_ISO)) // 净变化：last-ok
      const probeBody = `${target.replace(/\s+$/, '')}\n<!-- dsh-doctor:probe nonce=${nonce} -->\n`
      const dir = mkdtempSync(join(tmpdir(), 'dsh-doctor-'))
      const f1 = join(dir, 'probe.md')
      const f2 = join(dir, 'restore.md')
      writeFileSync(f1, probeBody)
      writeFileSync(f2, target)
      const p1 = runGH(['issue', 'edit', String(canaryNo), '--body-file', f1])
      if (!p1.ok) {
        mark(editRow, 'fail', '', oneLine(p1))
        blockWrites('改正文被拒（403/权限不足），不再追加写请求 —— 先修 PAT 的 Issues 写权限')
      } else {
        const rb1 = viewIssue('body')
        const ok1 = rb1.ok && hasProbe(rb1.data.body, nonce) && getField(rb1.data.body, 'last-ok') === NOW_ISO
        if (!ok1) {
          mark(editRow, 'fail', '', rb1.ok ? '写入后读回复核不一致（探针行/last-ok 未落地）' : `读回复核失败：${rb1.error}`)
          blockWrites('写后读回复核失败')
        } else {
          didWrite = true
          lastOkWritten = NOW_ISO
          const p2 = runGH(['issue', 'edit', String(canaryNo), '--body-file', f2])
          if (!p2.ok) {
            mark(editRow, 'fail', `last-ok=${NOW_ISO} 已写入，但探针行未能还原（下次运行会自愈）`, oneLine(p2))
            blockWrites('还原正文失败')
          } else {
            const rb2 = viewIssue('body')
            const restoredOk = rb2.ok
              && !hasProbe(rb2.data.body, nonce)
              && getField(rb2.data.body, 'last-ok') === NOW_ISO
              && stripMarkers(rb2.data.body) === stripMarkers(target)
            if (restoredOk) {
              mark(editRow, 'ok', `写入→读回→还原 均成功；净变化只有 last-ok=${NOW_ISO}`)
            } else {
              mark(editRow, 'fail', '', rb2.ok ? '还原后正文与预期不一致（探针行残留或 last-ok 丢失）' : `还原后读回复核失败：${rb2.error}`)
              blockWrites('还原后读回复核失败')
            }
          }
        }
      }
    }
  }

  // ④ 评论：只维护**一条**探测评论（有则 PATCH、无则创建）——避免每天一条噪音评论。
  const commentRow = row('comment', '评论')
  if (canaryNo == null) mark(commentRow, DRY ? 'dry' : 'skip', DRY ? '将写探测评论（dry-run 不写）' : '没有 canary')
  else if (DRY) mark(commentRow, 'dry', '将写探测评论（dry-run 不写）')
  else if (writeBlock) mark(commentRow, 'skip', writeBlock)
  else {
    const v = viewIssue('comments')
    if (!v.ok) {
      mark(commentRow, 'fail', '', `读评论失败：${v.error}`)
      blockWrites('读不到评论列表')
    } else {
      const existing = (v.data.comments ?? []).find((c) => String(c.body ?? '').includes(COMMENT_MARK))
      const dir = mkdtempSync(join(tmpdir(), 'dsh-doctor-'))
      const f = join(dir, 'comment.md')
      writeFileSync(f, `${COMMENT_MARK}\n凭据能力探测：评论写入可用（由 \`scripts/dsh-doctor.mjs\` 维护，最近一次 ${NOW_ISO}）。\n`)
      let r
      let how
      if (existing) {
        r = runGH(['api', '--method', 'PATCH', `repos/${REPO}/issues/comments/${existing.id}`, '-F', `body=@${f}`])
        how = `更新探测评论 #${existing.id}（未新增）`
      } else {
        r = runGH(['issue', 'comment', String(canaryNo), '--body-file', f])
        const id = /#issuecomment-(\d+)/.exec(r.stdout || '')?.[1] ?? '?'
        how = `新建探测评论 #${id}（全仓只此一条）`
      }
      if (r.ok) mark(commentRow, 'ok', how)
      else { mark(commentRow, 'fail', '', oneLine(r)); blockWrites('写评论被拒，不再追加写请求') }
    }
  }

  // ⑤ 加 label：加 → 读回 → 移除（可逆，不影响 canary 的 triage 语义）
  const labelRow = row('label', '加 label')
  if (canaryNo == null) mark(labelRow, DRY ? 'dry' : 'skip', DRY ? '将加/删 label（dry-run 不写）' : '没有 canary')
  else if (DRY) mark(labelRow, 'dry', '将加/删 label（dry-run 不写）')
  else if (writeBlock) mark(labelRow, 'skip', writeBlock)
  else {
    let r = runGH(['label', 'create', PROBE_LABEL, '--description', 'dsh-doctor 能力探测用（自动加/删，可忽略）', '--color', '5319e7', '--force'])
    if (!r.ok) { mark(labelRow, 'fail', '', `建探测 label 失败：${oneLine(r)}`); blockWrites('label 写被拒，不再追加写请求') }
    else {
      r = runGH(['issue', 'edit', String(canaryNo), '--add-label', PROBE_LABEL])
      if (!r.ok) { mark(labelRow, 'fail', '', oneLine(r)); blockWrites('加 label 被拒，不再追加写请求') }
      else {
        const v = viewIssue('labels')
        const names = (v.data?.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
        if (!v.ok || !names.includes(PROBE_LABEL)) {
          mark(labelRow, 'fail', '', v.ok ? `读回 label 不含 ${PROBE_LABEL}` : `读回 label 失败：${v.error}`)
          blockWrites('label 写后读回复核失败')
        } else {
          const rm = runGH(['issue', 'edit', String(canaryNo), '--remove-label', PROBE_LABEL])
          if (!rm.ok) { mark(labelRow, 'fail', `已加上 ${PROBE_LABEL} 但未能移除（下次运行会重试）`, oneLine(rm)); blockWrites('移除 label 失败') }
          else mark(labelRow, 'ok', `加→读回→移除 均成功（${PROBE_LABEL}）`)
        }
      }
    }
  }

  // ⑥ 关闭：关闭 → 读回 CLOSED → 重开 → 读回 OPEN（可逆；canary 必须保持可复用）
  const closeRow = row('close', '关闭')
  if (canaryNo == null) mark(closeRow, DRY ? 'dry' : 'skip', DRY ? '将关闭/重开（dry-run 不写）' : '没有 canary')
  else if (DRY) mark(closeRow, 'dry', '将关闭→读回→重开（dry-run 不写）')
  else if (writeBlock) mark(closeRow, 'skip', writeBlock)
  else {
    let r = runGH(['issue', 'close', String(canaryNo), '--reason', 'completed'])
    if (!r.ok) { mark(closeRow, 'fail', '', oneLine(r)); blockWrites('关闭被拒，不再追加写请求') }
    else {
      const v1 = viewIssue('state')
      if (!v1.ok || String(v1.data?.state).toUpperCase() !== 'CLOSED') {
        mark(closeRow, 'fail', '', v1.ok ? `关闭后读回状态是 ${v1.data?.state}` : `读回状态失败：${v1.error}`)
        blockWrites('关闭后读回复核失败')
      } else {
        const re = runGH(['issue', 'reopen', String(canaryNo)])
        if (!re.ok) {
          mark(closeRow, 'fail', `canary 已关闭但重开失败（下轮会自愈重开）`, oneLine(re))
          blockWrites('重开失败')
        } else {
          const v2 = viewIssue('state')
          if (!v2.ok || String(v2.data?.state).toUpperCase() !== 'OPEN') {
            mark(closeRow, 'fail', '', v2.ok ? `重开后读回状态是 ${v2.data?.state}` : `读回状态失败：${v2.error}`)
          } else mark(closeRow, 'ok', '关闭→读回 CLOSED→重开→读回 OPEN 均成功')
        }
      }
    }
  }

  // ⑧ PAT 过期（本地元数据，A4）：数据源是**本机文件**，不联网、不进 required。
  //    缺失/损坏 ⇒ "未知（建议 set）"，**绝不**因为"还没录入"把 doctor 判红 —— 没启用功能不是故障。
  const tokenRow = row('tokenExpiry', 'PAT 过期（本地 token.meta）', false)
  const tokenMeta = evaluateTokenMeta({ file: TOKEN_META_FILE, nowMs: NOW.getTime() })
  const TOKEN_STATUS = { ok: 'ok', warn: 'warn', urgent: 'urgent', critical: 'critical', expired: 'expired', unknown: 'unknown' }
  const fmtLeft = (d) => (d == null ? '' : d < 0 ? `已过期 ${Math.abs(d)} 天` : `剩余 ${d} 天`)
  if (tokenMeta.level === 'unknown') {
    mark(tokenRow, 'unknown', tokenMeta.reason === 'missing'
      ? '未录入 ⇒ 未知 —— 建议 set --expires 录一次（不判红）'
      : `meta 损坏 ⇒ 未知（${tokenMeta.error ?? '原因不明'}）—— 建议重新 set（不判红）`)
  } else {
    const urgentTail = tokenMeta.level === 'critical' || tokenMeta.level === 'expired'
      ? ` —— ${TOKEN_LEVEL_LABEL[tokenMeta.level]}`
      : ''
    mark(tokenRow, TOKEN_STATUS[tokenMeta.level] ?? 'unknown',
      `${tokenMeta.expiresAt}（${fmtLeft(tokenMeta.daysLeft)}）${urgentTail}`,
      null)
  }

  // 结论 + 修复建议（fail-loud：必需能力缺一项就非零退出，且必须给出做得动的下一步）
  const required = rows.filter((r) => r.required)
  const missing = required.filter((r) => r.status !== 'ok' && !(DRY && r.status === 'dry'))
  const exitCode = DRY ? (readRow.status === 'ok' ? 0 : 1) : missing.length ? 1 : 0

  printMatrix(rows)
  if (duplicates.length) console.log(`  ⚠️ 另有 ${duplicates.length} 条重复 canary 未使用：#${duplicates.map((d) => d.number).join('、#')}（需人工关闭）`)

  // PAT 过期一行**不参与退出码**（required=false）：缺失只提示，critical/expired 也只是"该动手了"。
  if (tokenRow.status === 'unknown') {
    console.log(`  · 录入 PAT 过期日（本地文件，不碰 GitHub；不录不影响退出码）：`)
    console.log(`      node scripts/dsh-token-meta.mjs set --expires YYYY-MM-DD [--note "创建于…"]`)
  } else if (tokenRow.status === 'critical' || tokenRow.status === 'expired') {
    console.log(`  · PAT ${VERDICT[tokenRow.status]} —— 轮换后重新录入：`)
    console.log(`      node scripts/dsh-token-meta.mjs set --expires YYYY-MM-DD`)
    console.log(`      node scripts/dsh-token-meta.mjs check`)
  }

  console.log('')
  if (exitCode === 0) {
    if (DRY) {
      console.log('结论：PASS（只读检查）—— 能读到 issue 列表；写能力**未验证**（dry-run 不写），')
      console.log('      所以本次不写 ~/.dsh/heartbeat.json —— 心跳只代表"写路径真实可用"。')
    } else {
      console.log(`结论：PASS —— ${required.length} 项能力全部可用（写能力已用真实 canary #${canaryNo} 证明，可逆）。`)
    }
  } else {
    // 区分"实测不可用"与"因为已撞到 403 而不再探测" —— 后者不能算"能力缺失"的证据，
    // 只能算"未验证"。两者都必须让退出码非零，但结论里要分开写，避免夸大矩阵覆盖。
    const failed = required.filter((r) => r.status === 'fail')
    const notProbed = required.filter((r) => r.status === 'skip')
    const parts = []
    if (failed.length) parts.push(`${failed.length} 项必需能力**不可用**（${failed.map((r) => r.label).join('、')}）`)
    if (notProbed.length) parts.push(`${notProbed.length} 项**未探测**（撞到 403 后已按纪律停止写探测：${notProbed.map((r) => r.label).join('、')}）`)
    console.log(`结论：FAIL —— ${parts.join('；')}。`)
    const writeMissing = missing.some((r) => ['create', 'edit', 'comment', 'label', 'close'].includes(r.key))
    if (writeMissing) {
      console.log(`修复建议：给 PAT 勾上 **Issues: Read and write**（fine-grained PAT → Repository permissions → Issues）。`)
      console.log(`          当前快照：仓库角色 ${typeof permissions === 'string' ? permissions : JSON.stringify(permissions)} ——`)
      console.log(`          **admin=true 不能替代资源级 Issues 权限**（GitHub 没有"模拟写"接口，只能靠这次 canary 写证明）。`)
      console.log(`          改完权限后重跑本命令；在此之前 dsh-watch / autopilot 的 issue 写入仍会失败。`)
    }
    if (missing.some((r) => r.key === 'read')) console.log('修复建议：确认该 token 对仓库有 Issues: Read（或检查网络 / gh 版本）。')
    if (writeBlock) console.log(`停止原因：${writeBlock}`)
  }

  // 本地心跳：只在"写路径被真实证明"时写 —— 否则反向心跳会替一个坏掉的链路作伪证。
  if (!DRY && exitCode === 0) {
    try {
      mkdirSync(dirname(HEARTBEAT_FILE), { recursive: true })
      const payload = { lastOkAt: NOW_ISO, version: readVersion(), didWrite }
      const tmp = `${HEARTBEAT_FILE}.tmp-${process.pid}`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`)
      renameSync(tmp, HEARTBEAT_FILE)
      console.log(`心跳：已写 ${HEARTBEAT_FILE}（lastOkAt=${NOW_ISO} version=${payload.version} didWrite=${didWrite}）`)
    } catch (e) {
      console.log(`心跳：写 ${HEARTBEAT_FILE} 失败：${redact(e.message)}（不影响本次判定，但云端反向心跳会失去本地对照）`)
    }
  } else if (!DRY) {
    console.log(`心跳：**未写**（本次未证明写能力；云端 last-ok 也不会更新 ⇒ 反向心跳会在 ${GRACE_HOURS}h 后如实报警）`)
  }
  if (lastOkWritten) console.log(`云端心跳：canary #${canaryNo} 正文 last-ok=${lastOkWritten}（云端 dsh-heartbeat-check 读这个字段）`)

  emitJSON({
    mode: 'doctor',
    at: NOW_ISO,
    repo: REPO,
    repoSource: REPO_SOURCE,
    gh: GH_BIN,
    ghVersion,
    dryRun: DRY,
    permissions,
    canary: canaryNo == null ? null : { number: canaryNo, created, url: `https://github.com/${REPO}/issues/${canaryNo}` },
    duplicates: duplicates.map((d) => d.number),
    matrix: rows,
    tokenMeta: {
      file: TOKEN_META_FILE, metaState: tokenMeta.metaState, level: tokenMeta.level,
      expiresAt: tokenMeta.expiresAt, daysLeft: tokenMeta.daysLeft, exitCode: tokenMeta.exitCode,
    },
    heartbeatFile: HEARTBEAT_FILE,
    lastOkWritten,
    exitCode,
  })

  appendStepSummary([
    `## dsh-doctor 能力矩阵${DRY ? '（dry-run）' : ''}`,
    '',
    '| 操作 | 结果 | 说明 |',
    '|---|---|---|',
    ...rows.map((r) => `| ${r.label} | ${SYM[r.status]} ${VERDICT[r.status]} | ${r.error ? `错误：${r.error}` : r.detail} |`),
    '',
    `结论：**${exitCode === 0 ? 'PASS' : 'FAIL'}**（仓库 \`${REPO}\`，canary ${canaryNo ? `#${canaryNo}` : '无'}）`,
    permissions ? `仓库级 permissions：\`${typeof permissions === 'string' ? permissions : JSON.stringify(permissions)}\`（**不代表 Issues 可写**）` : '',
  ].join('\n'))

  process.exit(exitCode)
}

// ── 模式 2：反向心跳（云端判据） ────────────────────────────────────────────
function heartbeatCheck() {
  preflightGH()
  console.log('dsh-heartbeat-check —— 反向心跳（"没消息也报警"）')
  console.log(`  仓库：${REPO}（来源：${REPO_SOURCE}）；现在：${NOW_ISO}；阈值：>${GRACE_HOURS}h 未更新 ⇒ 报警`)
  console.log('  判据：本机看不到云端，云端也看不到本机文件 ⇒ 唯一可见的信号是 canary 正文的 last-ok 字段。')

  const listing = runGH(['issue', 'list', '--state', 'all', '--limit', '100', '--json', 'number,title,body,state,createdAt'])
  if (!listing.ok) {
    console.error(`检查失败：读不到 issue 列表 —— ${oneLine(listing)}`)
    console.error('（这是"检查器自己坏了"，不是心跳陈旧；不改 canary、不报警，exit 1）')
    emitJSON({ mode: 'heartbeat-check', at: NOW_ISO, repo: REPO, verdict: 'error', error: oneLine(listing), exitCode: 1 })
    process.exit(1)
  }
  let issues
  try { issues = JSON.parse(listing.stdout) } catch (e) {
    console.error(`检查失败：issue 列表返回的不是 JSON —— ${redact(e.message).slice(0, 120)}`)
    process.exit(1)
  }
  const { canary, duplicates } = findCanary(issues)
  let canaryNo = canary?.number ?? null
  let created = false
  let body = String(canary?.body ?? '')
  const actions = { comment: null, label: null }

  if (!canary) {
    if (DRY) {
      console.log('\ncanary 不存在；dry-run 会创建它（创建即进入宽限期，本次不报警）。')
      emitJSON({ mode: 'heartbeat-check', at: NOW_ISO, repo: REPO, verdict: 'would-create', exitCode: 0 })
      process.exit(0)
    }
    console.log('\ncanary 不存在 ⇒ 先创建（正文带 bootstrap-at，进入宽限期），**本次不报警**。')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-heartbeat-'))
    const f = join(dir, 'canary.md')
    writeFileSync(f, baseBody(NOW_ISO))
    const c = runGH(['issue', 'create', '--title', CANARY_TITLE, '--body-file', f])
    if (!c.ok) {
      console.error(`创建 canary 失败：${oneLine(c)}（exit 1：连载体都建不出来，无法判定心跳）`)
      emitJSON({ mode: 'heartbeat-check', at: NOW_ISO, repo: REPO, verdict: 'error', error: oneLine(c), exitCode: 1 })
      process.exit(1)
    }
    canaryNo = Number(/\/issues\/(\d+)/.exec(c.stdout || '')?.[1] ?? 0) || null
    if (!canaryNo) {
      console.error(`创建 canary 成功但没解析出 issue 号：${redact(c.stdout).slice(0, 120)}（exit 1：无法确定载体）`)
      emitJSON({ mode: 'heartbeat-check', at: NOW_ISO, repo: REPO, verdict: 'error', error: 'cannot parse created issue number', exitCode: 1 })
      process.exit(1)
    }
    created = true
    body = baseBody(NOW_ISO)
    console.log(`  已创建 canary #${canaryNo}。下一次运行起按 last-ok（在本机 doctor 成功前为空）判断。`)
  }

  // 解析心跳：last-ok 优先；从未写入过则用 bootstrap-at 宽限（避免"刚建就报警"）。
  const lastOkRaw = getField(body, 'last-ok') || ''
  const bootstrapRaw = getField(body, 'bootstrap-at') || ''
  const src = lastOkRaw ? 'last-ok' : bootstrapRaw ? 'bootstrap-at' : null
  const raw = lastOkRaw || bootstrapRaw
  const parsed = raw ? new Date(raw) : null
  const valid = parsed && !Number.isNaN(parsed.getTime())
  const ageHours = valid ? (NOW.getTime() - parsed.getTime()) / 3_600_000 : null
  const fresh = valid && ageHours >= -0.1 && ageHours <= GRACE_HOURS
  console.log('')
  if (!src) {
    console.log('  心跳字段：正文里既没有 last-ok 也没有 bootstrap-at —— 无法判定（按陈旧处理，fail-loud）。')
  } else if (!valid) {
    console.log(`  心跳字段：${src}=${redact(String(raw)).slice(0, 60)} 不是合法时间 —— 无法判定（按陈旧处理）。`)
  } else {
    const label = src === 'last-ok' ? '最近一次成功写' : '从未写入过 last-ok，按创建时间宽限'
    console.log(`  心跳字段：${src}=${parsed.toISOString()}（${label}；距今 ${ageHours.toFixed(2)}h，阈值 ${GRACE_HOURS}h）`)
  }

  if (fresh) {
    console.log(`\n结论：静默 —— 心跳新鲜（${ageHours.toFixed(2)}h ≤ ${GRACE_HOURS}h），不评论、不加 label。`)
    emitJSON({ mode: 'heartbeat-check', at: NOW_ISO, repo: REPO, canary: { number: canaryNo, created }, field: src, value: parsed.toISOString(), ageHours, graceHours: GRACE_HOURS, verdict: 'fresh', actions, exitCode: 0 })
    appendStepSummary(`## 反向心跳：静默（新鲜）\n\n- canary: ${canaryNo ? `#${canaryNo}` : '刚创建'}\n- ${src}: \`${parsed.toISOString()}\`（距今 ${ageHours.toFixed(2)}h ≤ ${GRACE_HOURS}h）`)
    process.exit(0)
  }

  // 陈旧 ⇒ 报警：评论 @owner（会通知）+ priority:high（triage），并且 exit 3（"已报警"不是"job 坏了"）。
  const reason = !src
    ? '正文里既没有 last-ok 也没有 bootstrap-at'
    : !valid
      ? `${src} 不是合法时间（${String(raw).slice(0, 40)}）`
      : ageHours < 0
        ? `${src} 在未来（${parsed.toISOString()}，时钟可疑）`
        : `${src} 距今 ${ageHours.toFixed(1)}h > ${GRACE_HOURS}h`
  console.log(`\n判定：**心跳陈旧** —— ${reason}`)
  if (DRY) {
    console.log('[dry-run] 会：① 在 canary 评论 @' + OWNER + '；② 加 label ' + PRIORITY_LABEL + '；③ exit 3。未执行任何写操作。')
    emitJSON({ mode: 'heartbeat-check', at: NOW_ISO, repo: REPO, canary: { number: canaryNo, created }, field: src, ageHours, graceHours: GRACE_HOURS, verdict: 'stale', reason, dryRun: true, actions, exitCode: 0 })
    process.exit(0)
  }

  if (duplicates.length) console.log(`  ⚠️ 同时存在 ${duplicates.length + 1} 条 canary（#${[canaryNo, ...duplicates.map((d) => d.number)].join('、#')}），只用 #${canaryNo}。`)

  // 去重：同一段停更期内只发一条报警评论（否则每日 cron 会刷 1 条/天）。label 每次都确保加上。
  let alreadyAlarmed = false
  const v = runGH(['issue', 'view', String(canaryNo), '--json', 'comments'])
  if (v.ok) {
    try {
      const comments = JSON.parse(v.stdout).comments ?? []
      const alarms = comments.filter((c) => String(c.body ?? '').includes(ALARM_MARK))
      const lastAlarmAt = alarms.length ? new Date(alarms[alarms.length - 1].createdAt ?? alarms[alarms.length - 1].updatedAt ?? 0).getTime() : null
      const sinceLastAlarmH = lastAlarmAt ? (NOW.getTime() - lastAlarmAt) / 3_600_000 : null
      // ① 上一条报警晚于最后一次成功心跳 ⇒ 这段停更期已经报过；
      // ② 或者距上一条报警不到 repeat-hours（"从未成功过"也必须重复提醒）。
      alreadyAlarmed = Boolean(
        lastAlarmAt && sinceLastAlarmH != null && sinceLastAlarmH >= 0
        && (valid && src === 'last-ok' ? lastAlarmAt > parsed.getTime() : true)
        && sinceLastAlarmH < REPEAT_HOURS,
      )
      if (alarms.length) console.log(`  既有报警评论 ${alarms.length} 条（最近一条 ${sinceLastAlarmH?.toFixed(1)}h 前，重复阈值 ${REPEAT_HOURS}h）。`)
    } catch (e) { console.log(`  读评论失败（去重退化为每次报警）：${redact(e.message).slice(0, 120)}`) }
  } else {
    console.log(`  读评论失败（去重退化为每次报警）：${oneLine(v)}`)
  }

  if (alreadyAlarmed) {
    actions.comment = 'skipped-duplicate'
    console.log('  评论：已在本段停更期内报过 —— 跳过（避免每天刷屏）；label 仍会确保存在。')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-heartbeat-'))
    const f = join(dir, 'alarm.md')
    writeFileSync(f, [
      ALARM_MARK,
      `@${OWNER} 反向心跳缺失：自动化最后一次成功写入已 **${ageHours == null ? '无法判定（字段缺失/非法）' : `${ageHours.toFixed(1)}h 前`}**`,
      `，超过阈值 ${GRACE_HOURS}h（判据：canary 正文 \`${src ?? 'last-ok'}\`）。`,
      '',
      `- 原因：${reason}`,
      `- 含义：本机自动化（dsh-watch / dsh-doctor / timer）可能没在跑、机器关机、timer 被 disable，或持证凭据写不了 issue。`,
      `- 修复：在跑自动化的机器上执行 \`node scripts/dsh-doctor.mjs\`；若报 Issues 写权限不足，给 PAT 勾 **Issues: Read and write**。`,
      `- 这条评论由 \`dsh-heartbeat-check.yml\` 生成；同一段停更期只发一次（label 每次确保）。`,
    ].join('\n'))
    const c = runGH(['issue', 'comment', String(canaryNo), '--body-file', f])
    if (c.ok) { actions.comment = 'posted'; console.log(`  评论：已发（@${OWNER}）—— 会触发参与/被提及者通知。`) }
    else { actions.comment = `failed: ${oneLine(c)}`; console.error(`  评论：**失败** —— ${oneLine(c)}`) }
  }

  // label：存在即加（`--force` 幂等；CI 的 GITHUB_TOKEN 有 issues:write）。
  const lc = runGH(['label', 'create', PRIORITY_LABEL, '--description', '高优先级：自动化告警（dsh 升级 / SLA 未达标 / 心跳缺失）', '--color', 'b60205', '--force'])
  const la = lc.ok ? runGH(['issue', 'edit', String(canaryNo), '--add-label', PRIORITY_LABEL]) : lc
  if (la.ok) { actions.label = 'added'; console.log(`  label：已加 ${PRIORITY_LABEL}。`) }
  else { actions.label = `failed: ${oneLine(la)}`; console.error(`  label：**失败** —— ${oneLine(la)}`) }

  const delivered = actions.comment === 'posted' || actions.comment === 'skipped-duplicate' || actions.label === 'added'
  const exitCode = delivered ? 3 : 1
  console.log('')
  if (exitCode === 3) {
    console.log('结论：**已报警**（心跳陈旧）。exit 3 = "报警"，不是 "job 坏了"；心跳恢复后下一次运行自动转静默。')
  } else {
    console.log('结论：报警未能送达（评论与 label 都失败）。exit 1 = 检查器坏了，需要人看 Actions 日志。')
  }
  emitJSON({ mode: 'heartbeat-check', at: NOW_ISO, repo: REPO, canary: { number: canaryNo, created }, field: src, value: valid ? parsed.toISOString() : null, ageHours, graceHours: GRACE_HOURS, repeatHours: REPEAT_HOURS, verdict: 'stale', reason, actions, exitCode })
  appendStepSummary([
    '## 反向心跳：**报警（陈旧）**',
    '',
    `- canary: ${canaryNo ? `#${canaryNo}` : '无'}`,
    `- 判据: \`${src ?? '无字段'}\`${valid ? ` = \`${parsed.toISOString()}\`（距今 ${ageHours.toFixed(1)}h > ${GRACE_HOURS}h）` : '（缺失/非法）'}`,
    `- 评论: ${actions.comment}；label: ${actions.label}`,
    `- 退出码 3 = 已报警（不是 job 坏了）`,
  ].join('\n'))
  process.exit(exitCode)
}

// ── 模式 3：自测（内置有状态 gh 桩；零外部依赖） ─────────────────────────────
// 为什么把桩嵌在脚本里：本 PR 的写域只有这一个脚本文件 —— 与其把负向对照写成"手工跑过的一次性命令"，
// 不如让它可重复执行（`npm run test:doctor`）。桩只实现被测到的 gh 子命令，状态落在一个 JSON 文件里，
// 每次调用都追加一条调用记录，供断言"403 之后没有继续试写"。
const STUB_SOURCE = String.raw`#!/usr/bin/env node
// dsh-doctor 自测桩：有状态的 gh 替身（只实现被测到的子命令；每次调用都记账）
const fs = require('fs')
const stFile = process.env.STUB_STATE
const st = JSON.parse(fs.readFileSync(stFile, 'utf8'))
const argv = process.argv.slice(2)
// ⚠️ 桩时钟：这个桩里所有"现在"（createdAt / updatedAt / 调用记录）都必须取 STUB_NOW，绝不直接读真实墙钟。
//    断言侧的"现在"是 --now 钉死的固定值；桩若用墙钟，真实 UTC 一旦越过钉死点，报警评论的 createdAt
//    就落在"现在"之后 ⇒ 去重判据 sinceLastAlarmH >= 0 永远不成立 ⇒ 同一段停更期被判定要发第二条评论
//    ⇒ 自测从那天起永久变红（时间炸弹）。STUB_NOW 由 selfTest() 的 run() 从**同一条** --now 派生（单一时间源）。
//    负向对照：把下面这行改回 new Date().toISOString() ⇒ "桩写入的 createdAt == 钉死的 now" 断言必须红。
const at = process.env.STUB_NOW || new Date().toISOString()
st.calls = st.calls || []
st.calls.push({ argv, at })
st.fail = st.fail || {}
const save = () => fs.writeFileSync(stFile, JSON.stringify(st, null, 2))
const leak = () => (process.env.STUB_TOKEN_LEAK ? ' (token=github_pat_FAKE_LEAK_1234567890abcdef)' : '')
const die = (msg) => { process.stderr.write(msg + leak() + '\n'); save(); process.exit(1) }
const out = (o) => { process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n'); save(); process.exit(0) }
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const readBody = (f) => (f && f !== '-' ? fs.readFileSync(f, 'utf8') : '')
const issue = (n) => (st.issues || []).find((i) => Number(i.number) === Number(n))
const url = (n) => 'https://github.com/' + (st.repo || 'o/r') + '/issues/' + n
const labelsOf = (i) => (i.labels || []).map((l) => ({ name: typeof l === 'string' ? l : l.name }))
const cmd = argv[0] + ' ' + (argv[1] || '')
if (argv[0] === '--version') return out('gh version 2.45.0 (stub)')

if (cmd === 'issue list') {
  return out((st.issues || []).map((i) => ({ number: i.number, title: i.title, body: i.body, state: i.state, labels: labelsOf(i), createdAt: i.createdAt })))
}
if (cmd === 'issue view') {
  const i = issue(argv[2])
  if (!i) return die('graphql: Could not resolve to an issue with the number of ' + argv[2] + '.')
  const fields = (flag('--json') || '').split(',')
  const o = {}
  for (const f of fields) {
    if (f === 'comments') o.comments = (i.comments || []).map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, author: { login: 'stub' } }))
    else if (f === 'labels') o.labels = labelsOf(i)
    else if (f === 'body') o.body = i.body
    else if (f === 'state') o.state = i.state
    else o[f] = i[f]
  }
  return out(o)
}
if (cmd === 'issue create') {
  if (st.fail.create) return die('GraphQL: Resource not accessible by personal access token (createIssue)')
  const n = Math.max(0, ...(st.issues || []).map((i) => Number(i.number))) + 1
  st.issues = st.issues || []
  st.issues.push({ number: n, title: flag('--title'), body: readBody(flag('--body-file')), state: 'OPEN', labels: [], comments: [], createdAt: at })
  return out(url(n))
}
if (cmd === 'issue edit') {
  const i = issue(argv[2])
  if (!i) return die('no such issue')
  const bodyFile = flag('--body-file')
  if (bodyFile) {
    if (st.fail.bodyPatch) return die('GraphQL: Resource not accessible by personal access token (updateIssue)')
    i.body = readBody(bodyFile)
  }
  const add = flag('--add-label')
  const rem = flag('--remove-label')
  if (add) {
    if (st.fail.label) return die('GraphQL: Resource not accessible by personal access token (addLabelsToLabelable)')
    i.labels = i.labels || []
    if (!i.labels.includes(add)) i.labels.push(add)
  }
  if (rem) i.labels = (i.labels || []).filter((l) => l !== rem)
  return out(url(i.number))
}
if (cmd === 'issue comment') {
  if (st.fail.comment) return die('GraphQL: Resource not accessible by personal access token (addComment)')
  const i = issue(argv[2])
  if (!i) return die('no such issue')
  i.comments = i.comments || []
  const id = st.nextCommentId = (st.nextCommentId || 1000) + 1
  i.comments.push({ id, body: readBody(flag('--body-file')), createdAt: at })
  return out(url(i.number) + '#issuecomment-' + id)
}
if (cmd === 'issue close') { const i = issue(argv[2]); if (!i) return die('no such issue'); i.state = 'CLOSED'; return out(url(i.number)) }
if (cmd === 'issue reopen') { const i = issue(argv[2]); if (!i) return die('no such issue'); i.state = 'OPEN'; return out(url(i.number)) }
if (cmd === 'label create') {
  st.labels = st.labels || []
  const name = argv[2]
  if (!st.labels.includes(name)) st.labels.push(name)
  return out('label created')
}
if (cmd.startsWith('api ')) {
  if (argv.includes('--method') && argv.includes('PATCH')) {
    const target = argv.find((a) => a.includes('/issues/comments/'))
    const id = target ? Number(target.split('/issues/comments/')[1]) : null
    const field = argv.find((a) => a.startsWith('body=@'))
    const body = field ? readBody(field.slice('body=@'.length)) : ''
    for (const i of st.issues || []) for (const c of i.comments || []) if (Number(c.id) === id) { c.body = body; c.updatedAt = at }
    return out({ id })
  }
  if (argv.includes('.permissions')) return out({ admin: true, maintain: true, push: true, triage: true, pull: true })
  if (argv.includes('.login')) return out('stub-user')
  return die('stub: unsupported api call ' + argv.join(' '))
}
return die('stub: unsupported command: ' + argv.join(' '))
`

function selfTest() {
  if (process.platform === 'win32') {
    console.log('SKIP: --self-test 需要有 shebang 可执行的 gh 桩（POSIX）；Windows 上未执行 —— 这不是通过。')
    process.exit(0)
  }
  const TMP = mkdtempSync(join(tmpdir(), 'dsh-doctor-test-'))
  const BIN = join(TMP, 'gh')
  writeFileSync(BIN, STUB_SOURCE)
  chmodSync(BIN, 0o755)
  const HOME = join(TMP, 'home')
  mkdirSync(HOME, { recursive: true })
  const HB = join(HOME, '.dsh/heartbeat.json')
  let nPass = 0
  const failures = []
  const check = (name, cond, detail = '') => {
    if (cond) { nPass += 1; console.log(`  ok   ${name}`) }
    else { failures.push(`${name}${detail ? `：${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`) }
  }
  const eq = (name, expected, actual) => check(name, String(expected) === String(actual), `期望 ${JSON.stringify(String(expected))}，实际 ${JSON.stringify(String(actual))}`)
  const rowLine = (out, label) => String(out).split('\n').filter((l) => l.includes(label)).join('|') || '（没有这一行）'
  const statePath = join(TMP, 'state.json')
  const writeState = (s) => writeFileSync(statePath, JSON.stringify(s, null, 2))
  const readState = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const seed = (extra = {}) => ({ repo: 'o/r', issues: [], labels: ['priority:high'], nextCommentId: 1000, calls: [], fail: {}, ...extra })
  // 桩时钟必须与断言时钟同源：STUB_NOW 从**同一条** --now 派生（内置 gh 桩见 STUB_SOURCE 顶部注释）。
  // 也就是说：自测里任何"桩认为的现在"都只能经这里进来，桩自己永远不读墙钟 —— 否则真实 UTC 越过
  // 钉死的 now 之后，去重判据失效、套件永久变红（2026-10-24 的实测事故）。
  const stubNowOf = (args) => {
    const i = args.indexOf('--now')
    if (i < 0 || !args[i + 1]) return ''
    const t = new Date(args[i + 1])
    return Number.isNaN(t.getTime()) ? '' : t.toISOString()
  }
  const run = (args, extraEnv = {}) => {
    const r = execFileSync(process.execPath, [SELF, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GH_BIN: BIN, STUB_STATE: statePath, STUB_NOW: stubNowOf(args), HOME, GH_TOKEN: '', GITHUB_TOKEN: '', DSH_TOKEN_META: join(HOME, 'token.meta.json'), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, out: String(r ?? '') }
  }
  const runStatus = (args, extraEnv = {}) => {
    try { const r = run(args, extraEnv); return { status: 0, out: r.out } } catch (e) { return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` } }
  }
  const writeCalls = (calls) => calls.filter(({ argv: a }) => {
    if (a[0] === 'label') return true
    if (a[0] === 'api') return a.includes('--method')
    return a[0] === 'issue' && ['create', 'edit', 'comment', 'close', 'reopen'].includes(a[1])
  })
  const count = (calls, pred) => calls.filter(pred).length

  console.log('dsh-doctor 自测（内置 gh 桩；不碰真实仓库 / 真实 ~/.dsh）')
  console.log('\n[1] 能力矩阵 · 正向 + 幂等（跑两次）')
  writeState(seed())
  const r1 = runStatus(['--repo', 'o/r', '--heartbeat-file', HB, '--now', '2026-10-24T04:00:00Z'])
  eq('第一次运行 exit 0', 0, r1.status)
  check('矩阵 6 项全 ✓', (r1.out.match(/✓/g) || []).length >= 6, `✓ 计数 ${(r1.out.match(/✓/g) || []).length}`)
  let s = readState()
  eq('canary 只建一条', 1, s.issues.length)
  eq('探测评论只建一条', 1, (s.issues[0].comments || []).length)
  eq('探测 label 已移除（净变化为 0）', false, (s.issues[0].labels || []).includes('dsh-doctor-probe'))
  eq('canary 结束时是 OPEN', 'OPEN', s.issues[0].state)
  check('canary 正文写入了 last-ok', /^last-ok=2026-10-24T04:00:00\.000Z$/m.test(s.issues[0].body), s.issues[0].body.split('\n').find((l) => l.startsWith('last-ok=')))
  check('探针行未残留', !s.issues[0].body.includes('dsh-doctor:probe'))
  const hb = JSON.parse(readFileSync(HB, 'utf8'))
  eq('心跳文件 didWrite=true', true, hb.didWrite)
  eq('心跳文件 lastOkAt', '2026-10-24T04:00:00.000Z', hb.lastOkAt)
  check('心跳文件有 version', typeof hb.version === 'string' && hb.version.length > 0, JSON.stringify(hb))

  const before = readState().calls.length
  const r2 = runStatus(['--repo', 'o/r', '--heartbeat-file', HB, '--now', '2026-10-24T05:00:00Z'])
  eq('第二次运行 exit 0', 0, r2.status)
  check('第二次复用 canary（不新建）', /复用 #1/.test(r2.out), r2.out.split('\n').filter((l) => l.includes('建 canary')).join('|'))
  s = readState()
  eq('两次运行后 canary 仍只有 1 条', 1, s.issues.length)
  eq('两次运行后评论仍只有 1 条（PATCH 而非新增）', 1, (s.issues[0]?.comments || []).length)
  const calls2 = s.calls.slice(before)
  eq('第二次运行 issue create 次数 0', 0, count(calls2, (c) => c.argv[0] === 'issue' && c.argv[1] === 'create'))
  check('第二次运行 last-ok 前进', /^last-ok=2026-10-24T05:00:00\.000Z$/m.test(s.issues[0].body))

  console.log('\n[2] 能力矩阵 · 负向：403 注入到"改正文"（不继续试写 + token 打码）')
  writeState(seed({ fail: { bodyPatch: true } }))
  const r3 = runStatus(['--repo', 'o/r', '--heartbeat-file', HB, '--now', '2026-10-24T06:00:00Z'], { STUB_TOKEN_LEAK: '1' })
  check('exit 非零', r3.status !== 0 && r3.status != null, `status=${r3.status}`)
  check('该项标 ✗', /✗ 改 canary 正文/.test(r3.out), r3.out.split('\n').filter((l) => l.includes('改 canary 正文')).join('|'))
  check('如实打印 403 错误', /Resource not accessible by personal access token/.test(r3.out))
  check('token 被打码（不出现原文）', !r3.out.includes('github_pat_FAKE_LEAK_1234567890abcdef'))
  check('打码标记存在', r3.out.includes('<redacted>'), '输出里没有 <redacted>')
  const s3 = readState()
  const edits = s3.calls.filter((c) => c.argv[0] === 'issue' && c.argv[1] === 'edit' && c.argv.includes('--body-file'))
  eq('改正文 PATCH 调用数（不重试）', 1, edits.length)
  const afterFail = s3.calls.slice(s3.calls.indexOf(edits[0]) + 1)
  eq('403 之后没有任何写调用', 0, writeCalls(afterFail).length)
  check('退出码是 1', /exit 1|结论：FAIL/.test(r3.out) || r3.status === 1, `status=${r3.status}`)
  const hbAfterFail = JSON.parse(readFileSync(HB, 'utf8'))
  eq('失败运行不写心跳（不替坏链路作伪证）', '2026-10-24T05:00:00.000Z', hbAfterFail.lastOkAt)

  console.log('\n[3] 反向心跳 · 负向：last-ok=48h 前 ⇒ 必须报警（评论 + label）')
  const fixNow = '2026-10-24T04:00:00Z'
  const pinnedIso = new Date(fixNow).toISOString() // 断言时钟的标准形态；桩时钟必须与它同源
  const stale = new Date(Date.parse(fixNow) - 48 * 3600e3).toISOString()
  writeState(seed({
    issues: [{ number: 7, title: CANARY_TITLE, body: `dsh-doctor canary\n\nlast-ok=${stale}\nbootstrap-at=${stale}\n`, state: 'OPEN', labels: [], comments: [], createdAt: stale }],
  }))
  const h1 = runStatus(['--heartbeat-check', '--repo', 'o/r', '--now', fixNow])
  eq('陈旧 ⇒ exit 3（"已报警"）', 3, h1.status)
  check('输出说报警', /已报警/.test(h1.out), h1.out.split('\n').slice(-4).join('|'))
  s = readState()
  eq('报警评论 1 条', 1, (s.issues[0].comments || []).length)
  // 防回归（时间炸弹）：上面"不重复评论"能成立的前提是——桩写入的时间来自被钉死的 now，而不是真实墙钟。
  // 断言时钟（--now）与桩时钟（STUB_NOW）同源 ⇒ createdAt 必须恰好等于 pinnedIso。
  // 负向对照（已实测）：把 STUB_SOURCE 里的 `process.env.STUB_NOW ||` 去掉（桩回到墙钟）⇒ 下面两条必红。
  eq('桩写入的 createdAt == 钉死的 now（单一时间源，不是墙钟）', pinnedIso, (s.issues[0].comments[0] || {}).createdAt)
  const stubCallTimes = [...new Set((s.calls || []).map((c) => c.at))]
  check('桩的调用记录也全部来自同一个钉死的 now', stubCallTimes.length === 1 && stubCallTimes[0] === pinnedIso, `at=${stubCallTimes.join(',')}`)
  check('评论 @ 属主', String(s.issues[0].comments[0].body).includes('@o '), s.issues[0].comments[0].body.split('\n')[1])
  check('评论含陈旧小时数', /48\.0h/.test(s.issues[0].comments[0].body), s.issues[0].comments[0].body.split('\n')[1])
  check('已加 priority:high', (s.issues[0].labels || []).includes('priority:high'), JSON.stringify(s.issues[0].labels))
  const h2 = runStatus(['--heartbeat-check', '--repo', 'o/r', '--now', fixNow])
  eq('再跑一次仍 exit 3', 3, h2.status)
  eq('同一段停更期不重复评论', 1, (readState().issues[0].comments || []).length)

  console.log('\n[3b] 反向心跳 · 无法判定的三种正文形态 ⇒ 一律按陈旧报警（fail-loud）')
  const badBodies = [
    ['字段缺失', 'dsh-doctor canary\n\n（正文里没有任何心跳字段）\n'],
    ['last-ok 非法', 'dsh-doctor canary\n\nlast-ok=not-a-time\nbootstrap-at=' + stale + '\n'],
    ['last-ok 在未来', 'dsh-doctor canary\n\nlast-ok=' + new Date(Date.parse(fixNow) + 2 * 3600e3).toISOString() + '\n'],
  ]
  for (const [name, body] of badBodies) {
    writeState(seed({ issues: [{ number: 7, title: CANARY_TITLE, body, state: 'OPEN', labels: [], comments: [] }] }))
    const r = runStatus(['--heartbeat-check', '--repo', 'o/r', '--now', fixNow])
    eq(`${name} ⇒ exit 3（按陈旧处理）`, 3, r.status)
    eq(`${name} ⇒ 报警评论 1 条`, 1, (readState().issues[0].comments || []).length)
  }

  console.log('\n[4] 反向心跳 · 正向：last-ok=5min 前 ⇒ 必须静默')
  const fresh = new Date(Date.parse(fixNow) - 5 * 60e3).toISOString()
  writeState(seed({
    issues: [{ number: 7, title: CANARY_TITLE, body: `dsh-doctor canary\n\nlast-ok=${fresh}\nbootstrap-at=${stale}\n`, state: 'OPEN', labels: [], comments: [], createdAt: stale }],
  }))
  const h3 = runStatus(['--heartbeat-check', '--repo', 'o/r', '--now', fixNow])
  eq('新鲜 ⇒ exit 0', 0, h3.status)
  check('输出说静默', /静默/.test(h3.out))
  eq('不评论', 0, (readState().issues[0].comments || []).length)
  eq('不加 label', 0, (readState().issues[0].labels || []).length)

  console.log('\n[5] 反向心跳 · canary 不存在 ⇒ 先创建再判断（不误报）')
  writeState(seed())
  const h4 = runStatus(['--heartbeat-check', '--repo', 'o/r', '--now', fixNow])
  eq('创建后 exit 0（宽限期内静默）', 0, h4.status)
  s = readState()
  eq('canary 被创建 1 条', 1, s.issues.length)
  check('正文带 bootstrap-at', /^bootstrap-at=2026-10-24T04:00:00\.000Z$/m.test(s.issues[0].body))
  eq('没有误报评论', 0, (s.issues[0].comments || []).length)
  const h5 = runStatus(['--heartbeat-check', '--repo', 'o/r', '--now', fixNow])
  eq('紧接着再跑也不误报', 0, h5.status)
  eq('仍只有 1 条 canary', 1, readState().issues.length)

  console.log('\n[6] 反向心跳 · dry-run 不写')
  writeState(seed({
    issues: [{ number: 7, title: CANARY_TITLE, body: `x\n\nlast-ok=${stale}\nbootstrap-at=${stale}\n`, state: 'OPEN', labels: [], comments: [] }],
  }))
  const h6 = runStatus(['--heartbeat-check', '--repo', 'o/r', '--now', fixNow, '--dry-run'])
  eq('dry-run exit 0', 0, h6.status)
  eq('dry-run 不评论', 0, (readState().issues[0].comments || []).length)
  eq('dry-run 不加 label', 0, (readState().issues[0].labels || []).length)

  console.log('\n[7] PAT 过期（本地 token.meta，A4）—— 缺失=未知不判红；过期只提示、不改退出码')
  const TM = join(HOME, 'token.meta.json')
  writeState(seed())
  const t1 = runStatus(['--repo', 'o/r', '--heartbeat-file', HB, '--now', fixNow])
  eq('未录入 ⇒ exit 0（没启用功能不是故障）', 0, t1.status)
  check('未录入 ⇒ 那一行显示"未知"', /PAT 过期（本地 token\.meta）\s+—— 未录入 ⇒ 未知/.test(t1.out), rowLine(t1.out, 'PAT 过期'))
  check('未录入 ⇒ 给出 set 提示', /dsh-token-meta\.mjs set --expires/.test(t1.out))
  writeFileSync(TM, JSON.stringify({ expiresAt: '2026-10-23', note: null, recordedAt: fixNow }))
  const t2 = runStatus(['--repo', 'o/r', '--heartbeat-file', HB, '--now', fixNow])
  eq('已过期 ⇒ 仍 exit 0（非必需项不参与退出码）', 0, t2.status)
  check('已过期 ⇒ 那一行 ✗（符号）+ 已过期 N 天', /✗ PAT 过期（本地 token\.meta）\s+—— 2026-10-23（已过期 1 天）/.test(t2.out), rowLine(t2.out, 'PAT 过期'))
  check('已过期 ⇒ 提示轮换后重新录入', /set --expires YYYY-MM-DD/.test(t2.out))
  writeFileSync(TM, '{ not json')
  const t3 = runStatus(['--repo', 'o/r', '--heartbeat-file', HB, '--now', fixNow])
  eq('meta 损坏 ⇒ exit 0（不判红）', 0, t3.status)
  check('meta 损坏 ⇒ 明说损坏原因', /PAT 过期（本地 token\.meta）\s+—— meta 损坏 ⇒ 未知（不是合法 JSON/.test(t3.out), rowLine(t3.out, 'PAT 过期'))
  writeFileSync(TM, JSON.stringify({ expiresAt: '2027-04-01', note: null, recordedAt: fixNow }))
  const t4 = runStatus(['--repo', 'o/r', '--heartbeat-file', HB, '--now', fixNow])
  check('正常 ⇒ 那一行 ✓ + 剩余天数', /✓ PAT 过期（本地 token\.meta）\s+—— 2027-04-01（剩余 159 天）/.test(t4.out), rowLine(t4.out, 'PAT 过期'))
  eq('正常 ⇒ exit 0', 0, t4.status)

  const total = nPass + failures.length
  console.log(`\n自测结果：${nPass}/${total} 通过，${failures.length} 失败`)
  if (failures.length) {
    for (const f of failures) console.error(`  - ${f}`)
    console.error(`临时目录（保留供排障）：${TMP}`)
    process.exit(1)
  }
  rmSync(TMP, { recursive: true, force: true })
  process.exit(0)
}

// ── 入口 ────────────────────────────────────────────────────────────────────
const KNOWN_FLAGS = new Set([
  '--dry-run', '--heartbeat-check', '--self-test', '--json', '--repo', '--now', '--assignee',
  '--grace-hours', '--repeat-hours', '--heartbeat-file', '--token-meta', '--timeout', '--help', '-h',
])
const UNKNOWN = argv.find((a, i) => a.startsWith('--') && !KNOWN_FLAGS.has(a))
if (UNKNOWN) {
  console.error(`未知参数：${UNKNOWN}\n用 --help 看用法（退出码 2 表示用法错误，不写任何东西）`)
  process.exit(2)
}
if (has('--help') || has('-h')) {
  console.log(readFileSync(SELF, 'utf8').split('\n').slice(0, 46).join('\n'))
  process.exit(0)
}

if (MODE === 'selftest') selfTest()
else if (MODE === 'heartbeat') heartbeatCheck()
else doctor()
