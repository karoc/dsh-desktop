#!/usr/bin/env node
// dsh-watch —— 上游发布探测（方案 P0 §3.2）。**逻辑提取成脚本**才可本地演练：
// 原先内联在 workflow 的 bash 里，"建 issue 那条路径"从未被跑过（首次实跑时因当天没有新版本
// 走的是"无事发生"分支）—— 这类"代码在但路径没跑过"的缺口正是首次实跑暴露出来的。
//
//   node scripts/dsh-watch.mjs [--dry-run] [--force-target <version>] [--json <out>]
//                              [--registry <url>] [--floor <version>] [--now <iso>] [--force-published <iso>]
//                              [--repo <owner/name>] [--assignee <login>]
//                              [--state-dir <dir>] [--lock-file <path>] [--pause-file <path>]
//                              [--state-file <path>] [--failure-threshold <n>] [--reset-state] [--no-backoff]
//
// 退避 / 三态（A6，`scripts/lib/backoff-state.mjs`）：
//   状态文件 `<state-dir>/state/dsh-watch.json`（默认 `~/.dsh/state/dsh-watch.json`；`--state-file` 直接指定）。
//   失败 1..N-1 次 = degraded（仍打印完整错误，只发一次跃迁评论）；第 N 次（默认 3）= broken（进入退避，
//   发一次跃迁评论）；broken 期间每轮**只输出一行** `still broken (attempt k, next retry in Xm)`，到
//   `nextAttemptAt` 之前**跳过实际工作**，失败明细进 `<state>.detail.log`；任一次成功 = healthy（发一次恢复
//   评论）。退避 5 → 10 → 20 → 40 → 封顶 60 分钟。心跳每轮一行写入 `<state>.heartbeat`
//   （`skipped=yes/no` —— 反向心跳据此区分"在退避"与"进程死了"）。
//   人工恢复：`--reset-state`（只重置本地状态文件、**不写 GitHub**；随后正常一轮会重新判断）。
//   `--no-backoff` 只给演练/负向对照（门禁 `scripts/test-backoff-state.mjs` 用它证明断言能失败）。
//   `--now` 同时钉住状态机时钟（演练可确定性回放"连续 8 轮失败"）。
//   **CI 特例**：Actions runner 的文件系统是临时的 ⇒ 状态每轮从 healthy 开始，只记账、**不发**跃迁评论
//   （显式给 `--state-dir`/`--state-file`/`DSH_STATE_DIR` 才算持久化环境）。CI 侧的"没跑/没发出来"
//   由 dead man's switch（A5）负责，不靠这里刷评论。
//   退出码补充：degraded/broken 的**重试轮**仍是 1；**退避跳过轮是 0**（它没干活、也不是新故障，
//   0 是为了不与 systemd 的 `Restart=on-failure` + 60s 叠成热循环）。健康判据 = 状态文件的 `state`
//   + 跃迁评论，不是 timer 的退出码。
//   systemd 单元模板（本仓库**不**改你机器上的 systemd；推荐值，配合 `Restart=on-failure`）：
//     [Service]
//     RestartSec=60              # 首轮失败后 60s 内重启一次（本轮会被退避跳过，随后停下）
//     RestartSteps=4             # systemd 254+：60s → 120s → 240s → 480s → 960s 的指数重启
//     RestartMaxDelaySec=3600    # 封顶 1h；与脚本内的 60 分钟退避同尺度
//
// 演练参数（--registry / --floor / --now / --force-published）只为本地回放：本机 npm CLI 不可用、
// 直连 npmjs 会超时，所以演练要用本地 stub registry（python http.server + 手写 packument）指向。
//
// 默认行为：读壳地板（scripts/server-manager.mjs）→ 取 npm dist-tags → 比较 → 需要适配就开/更新
// `dsh-upgrade` issue（正文含 6h 倒计时与八步适配清单）。**不改地板、不建 PR**。
// --force-target：把某版本强制当作"需要适配"（演练 issue 路径）；配合 --dry-run 可零副作用跑全路径。
//
// 零 secret：只用 GITHUB_TOKEN（issues: write）。退出码：0 = 正常（含"今天没有新版本"、以及对账失败但
// 已输出待人工清单）；1 = 真故障（拿不到 npm packument / 读不到 open issue 列表 / 跟踪单没开成或没更新成）；
// 2 = 用法/属主解析失败。
// 红色只应代表"这个 job 坏了"，不代表"今天没有新版本"。
//
// ── 2026-10-24 止血（事故 #201–#217；方案 A1 + A2 + A10）────────────────────────────────
// 事故：上游发了 `0.2.1-rc.3` 后，本机 systemd timer 与 Actions cron **双写**，共开出 17 条重复 issue。
// 其中 16 条（本机 PAT 创建）的 label/assignee **从未落地** ⇒ 旧去重按 `--label` 过滤查到 0 条 ⇒
// 每 10 分钟再建一条。三条结构性缺陷，对应下面三条改动：
//
//  A1 去重键 = **与写者无关的确定性键**：查所有 `state=open` 的 issue，用**词边界**匹配标题里的版本号
//     （`0.2.1-rc.3` 不会命中 `0.2.1-rc.30`，也不会命中 `0.2.1-rc.2`；只匹配本脚本自己的两种标题前缀），
//     命中即 `edit` 复用，未命中才 `create`。**不再依赖 label**（label 是创建之后的第二次写，可能静默失败）。
//     正文里的 `<!-- dsh-watch-state: target=… breached=… -->` 只用于判断"要不要追加评论"
//     （目标版本变化 / 状态跨级才评论），**不是**去重键（body 的 edit 同样可能失败）。
//     写后**读回复核** label/assignee：缺失就报出来（不当作成功），但绝不因此再建一条。
//
//  A2 单写者 + 幂等锁：非 --dry-run 时整个进程包在 `flock -n <state-dir>/locks/dsh-watch.lock` 里
//     （util-linux flock；进程退出即释放，不会留"崩溃后永久死锁"）。同一时刻只允许一个本机实例；
//     拿不到锁 ⇒ 打印 `skipped by lock` 后 exit 0（另一轮正在写，本轮无事可做）。
//     `~/.dsh/PAUSE` 存在 ⇒ **跳过一切写操作**（只读探测、去重判定、重复单报告照常），日志明确写
//     `paused by <路径>`。这是给"人工排障 / 上游事故期间"的刹车，不需要改 systemd。
//
//  收敛对账（自愈，A10 的常驻形态）：每轮末尾按版本分组扫一遍 open issue；同一版本 >1 条时保留一条
//     （优先带 label/assignee 的规范单，同优先级取最早创建；#217 就是这样被保留的），其余
//     `close` 后评论"重复于 #N（同版本跟踪单），由 autopilot 对账关闭"。**失败不重试、不报假成功**：
//     任何 close/comment 被 403 ⇒ 本轮停写，输出"待人工关闭"清单（issue 号 + 可复制的命令）。
//     对账后再读一次列表复核；读不到就明说"无法复核"，绝不报"已收敛"。
//
//  双写者是**设计事实**（本机 systemd timer + `.github/workflows/dsh-watch.yml` 的 cron 各跑一份），
//  因此所有写操作必须是**收敛式**（幂等）：只依赖"对象身份 + 正文状态"，不假设自己独占。
//  flock 只保本机；跨写者的 TOCTOU（两边同时查到 0 条再各建一条）无法在客户端根除 —— 那正是对账这一层
//  存在的理由（下一轮收敛）。所以**不要**把这里的"先查后建"当成原子的唯一性约束。

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  appendHeartbeat, backoffMinutes, decide, heartbeatFileFor, loadState, recordOutcome,
  renderBrokenEntry, renderHeartbeat, renderStillBroken, renderTransitionComment,
  resetStateFile, saveState, stateFilePath,
} from './lib/backoff-state.mjs'
// 跟踪单的身份（标题前缀 + `dsh <版本>` 锚点 + 词边界）唯一实现在这里 —— 与 `dsh-sla-report.mjs` 共用，
// 避免"watch 按标题去重、报表按 label 取数"那种两份实现互相漂移（事故 #201–#217 的根因之一）。
import {
  findTrackingIssue, isTrackingIssue as isTracking, versionInTitle,
} from './lib/issue-key.mjs'

const SELF = fileURLToPath(import.meta.url)
const ROOT = join(dirname(SELF), '..')
const MANAGER = join(ROOT, 'scripts/server-manager.mjs')
const argv = process.argv.slice(2)
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
const DRY = argv.includes('--dry-run')
const FORCE = arg('--force-target')
const OUT = arg('--json')
// issue 是 bot（GITHUB_TOKEN）创建的，而 GitHub 的推送默认只覆盖「参与中 / 被 @ 提及 / 被赋值」的线程
// ⇒ 只开 issue 不赋值、不提及，很可能**根本不会叫醒仓库属主**（2026-10-20 修正）。属主解析顺序：
// --assignee > --repo > GH_REPO > GITHUB_REPOSITORY > git remote origin；**取不到就报错**，
// 不静默跳过（静默跳过 = 又回到「issue 开着但没人知道」）。
const GIT_SLUG = (() => {
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: ROOT, encoding: 'utf8' }).trim()
    const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url)
    return m ? `${m[1]}/${m[2]}` : null
  } catch { return null }
})()
const REPO_ARG = arg('--repo')
const REPO = REPO_ARG || process.env.GH_REPO || process.env.GITHUB_REPOSITORY || GIT_SLUG || 'karoc/dsh-desktop'
const REPO_SOURCE = REPO_ARG ? '--repo' : process.env.GH_REPO ? 'GH_REPO' : process.env.GITHUB_REPOSITORY ? 'GITHUB_REPOSITORY' : GIT_SLUG ? 'git remote origin' : '内置默认'
const OWNER_ARG = arg('--assignee')
const OWNER_RESOLVED = String(OWNER_ARG ?? process.env.DSH_ISSUE_ASSIGNEE ?? '').trim().replace(/^@/, '')
const OWNER_SLUG = /^[^/\s]+\/[^/\s]+$/.test(String(REPO).trim()) ? String(REPO).trim().split('/')[0] : null
const OWNER = OWNER_RESOLVED || OWNER_SLUG
// 注意：这里**不**立刻报错 —— "今天没有新版本"（target=null）根本不需要 issue/assignee，
// 此时因解析不到属主而判红会把"无事发生"变成假故障。真正需要发 issue 的路径在 `if (!target)`
// 之后单独 fail-closed（见下方）。
const OWNER_SOURCE = OWNER_RESOLVED ? '--assignee/DSH_ISSUE_ASSIGNEE' : `${REPO_SOURCE}（${REPO}）`
// 高优先级标记：先查过仓库现有 label（2026-10-20：只有默认 label + sla-report，没有任何优先级标记）
// ⇒ 只新增这一个共享标记，不在每次运行里造一堆。label **不产生通知**，只用于 triage；
// 真正叫醒人的是 assignee 与正文 @提及（见 README 维护者小节）。
const PRIORITY_LABEL = 'priority:high'
const GH = process.env.GH_BIN ?? 'gh'
const SLA_HOURS = Number(arg('--sla-hours', '6'))
const BEST_EFFORT_HOURS = Number(arg('--best-effort-hours', '24'))
// 本机 npm CLI 不可用、直连 npmjs 会超时 ⇒ 演练必须能指向本地 stub registry（python http.server + 手写 packument）。
const REGISTRY = (arg('--registry', process.env.DSH_WATCH_REGISTRY ?? 'https://registry.npmjs.org')).replace(/\/+$/, '')
// --now 只用于演练（把"现在"钉在某个时刻）。坏输入必须当场报错：旧实现里
// `new Date('garbage')` ⇒ NaN ⇒ 所有比较为 false ⇒ 静默判"未违约"（假阴性）。
const NOW_ARG = arg('--now')
const NOW = NOW_ARG ? new Date(NOW_ARG) : new Date()
const FORCE_PUBLISHED = arg('--force-published')

// `--now` 必须在这里就校验：它同时是退避状态机的时钟（演练要能钉住"现在"）。
if (Number.isNaN(NOW.getTime())) {
  console.error(`--now 不是合法时间：${NOW_ARG}（要 ISO 8601，例如 2026-10-19T12:00:00Z）—— 拒绝用坏时间戳静默判"未违约"`)
  process.exit(2)
}

// ── A2：状态目录 / 互斥锁 / 刹车文件 ────────────────────────────────────────
// --state-dir（或 DSH_STATE_DIR）把三样东西收在一处：锁文件、PAUSE 刹车、**退避状态文件**
// （`<state-dir>/state/dsh-watch.json`，见下面的 A6）。默认 `~/.dsh` 与既有约定一致
// （systemd user 单元、日志、dump 都在这里）。
const STATE_DIR = resolve(arg('--state-dir') ?? process.env.DSH_STATE_DIR ?? join(homedir(), '.dsh'))
const LOCK_FILE = resolve(arg('--lock-file') ?? join(STATE_DIR, 'locks/dsh-watch.lock'))
const PAUSE_FILE = resolve(arg('--pause-file') ?? join(STATE_DIR, 'PAUSE'))
const PAUSED = existsSync(PAUSE_FILE)
const UNDER_LOCK = process.env.DSH_WATCH_LOCK_HELD === '1'

// ── 跟踪 issue 的身份（A6 的跃迁评论也用它定位落点）──────────────────────────
// 只认本脚本自己写的两种标题前缀：`[dsh-watch][…] dsh <ver> 比地板 <floor> 新` / `[SLA 未达标] dsh <ver> …`。
// 这样人类随手开的 "please upgrade to 0.2.1-rc.3" 不会被我们 edit 掉正文（那会改写别人的字）。
// 实现（含 `isTracking` / `versionInTitle`）在 `scripts/lib/issue-key.mjs`，与报表共用一份。

// ── A6：三态健康机 + 指数退避 + 只在跃迁时通知（2026-10-24）──────────────────
// 背景：定时器每 10 分钟一轮，失败时**每轮重印同一段完整错误** —— 没有新信息、掩盖"什么时候开始
// 坏的 / 中间有没有恢复过"，还会让 systemd 的 `Restart=on-failure` + `RestartSec=60` 变成热循环。
// 状态机把"最近一次结果 + 连续失败次数"落盘（`~/.dsh/state/dsh-watch.json`，原子写），由状态驱动
// 输出与通知，而不是由"这一次是否抛异常"驱动（同 Argo CD 的 health / client-go 的按 key 退避 + Forget）：
//   ① healthy --连续失败 1..N-1--> degraded：**仍打印完整错误**（还在诊断窗口里），只发一次跃迁评论；
//   ② degraded --第 N 次连续失败--> broken：**只发一次**跃迁评论，进入退避；
//   ③ broken 期间每轮**只输出一行** `still broken (attempt k, next retry in Xm)`，到 nextAttemptAt
//      之前**跳过实际工作**（不探 npm、不写 issue），但每轮都写一行心跳（`<state>.heartbeat`）——
//      反向心跳据此区分"进程还在、只是退避中"与"进程死了"；失败明细进 `<state>.detail.log`；
//   ④ broken --任一次成功--> healthy：**只发一次**恢复评论，计数清零；
//   ⑤ 不可重试错误（403/404/凭据/权限）**第一次就 broken**（重试不会好，只会把 403 再印一遍）。
// 通知只在跃迁时发生，评论带机器标记 `<!-- dsh-watch-backoff: state=broken … -->` + digest（补发/并发
// 幂等）。退避序列 5 → 10 → 20 → 40 分钟、封顶 60（`scripts/lib/backoff-state.mjs` 的纯函数）。
// 退出码：degraded / broken 的**重试轮**仍是 1（CI 该红就红）；**退避跳过轮是 0** —— 它没干活、也不是
// 新故障，0 是为了不与 systemd 的 restart 叠成热循环；健康判据是状态文件里的 `state` 与跃迁评论。
const TOOL = 'dsh-watch'
const BACKOFF_OFF = argv.includes('--no-backoff')
const RESET_STATE = argv.includes('--reset-state')
const STATE_FILE = resolve(arg('--state-file') ?? process.env.DSH_WATCH_STATE_FILE
  ?? stateFilePath({ tool: TOOL, stateDir: STATE_DIR }))
const HEARTBEAT_FILE = heartbeatFileFor(STATE_FILE)
const DETAIL_FILE = `${STATE_FILE}.detail.log`
const FAILURE_THRESHOLD = Math.max(1, Number(arg('--failure-threshold', '3')) || 3)
// --dry-run / PAUSE 都是"只读轮"：不读写退避状态（演练不该污染真实退避；PAUSE 期间人工接管）。
const STATE_WRITES_OK = !DRY && !PAUSED
// 环境判定（显式）：GitHub Actions 的 runner 文件系统是临时的 ⇒ 状态每轮都从 healthy 开始，通知只会
// 变成"每轮一条 healthy→degraded"（比现状更吵）。所以 CI 里**只记账、不发**跃迁评论（下面的
// `--state-dir` 显式给了才算持久化环境，本机 timer/演练/测试都属于这一类）。
const PERSISTENT_STATE = Boolean(arg('--state-file') || arg('--state-dir') || process.env.DSH_STATE_DIR)
const NOTIFY_TRANSITIONS = !(process.env.GITHUB_ACTIONS === 'true' && !PERSISTENT_STATE)

let backoff = null
let backoffState = null
let FAILURE = null
// 本轮 target（拿到之后赋值）：跃迁评论优先挂到**这一版**的跟踪单上，而不是随便最新一条。
let CURRENT_TARGET = null

/** broken 期间的失败细节只进明细文件 —— stdout 保持**一行**（"不再每轮重印完整错误"）。 */
const quiet = () => Boolean(backoff && STATE_WRITES_OK && backoffState?.state === 'broken')
function appendDetail(line) {
  try {
    mkdirSync(dirname(DETAIL_FILE), { recursive: true })
    appendFileSync(DETAIL_FILE, line)
    // 明细文件只服务本机排障、不参与 logrotate ⇒ 自带上限（涨过 128KB 就只留尾部 400 行）。
    if (statSync(DETAIL_FILE).size > 128 * 1024) {
      const tail = readFileSync(DETAIL_FILE, 'utf8').split('\n').slice(-400).join('\n')
      writeFileSync(DETAIL_FILE, tail, { mode: 0o600 })
    }
  } catch { /* 明细丢失不该改变退出码 */ }
}
/** 失败细节的唯一出口：degraded 时进 stderr（照旧），broken 时进明细文件（stdout 只留一行摘要）。 */
function failErr(...args) {
  FAILURE = args.join(' ')
  const line = `${NOW.toISOString()} ${FAILURE}\n`
  if (quiet()) { appendDetail(line); return }
  process.stderr.write(line)
}
function persistBackoff() {
  if (!backoff || !STATE_WRITES_OK) return
  try { saveState(STATE_FILE, backoffState) } catch (e) {
    failErr(`!! 写不出退避状态 ${STATE_FILE}：${e.message} —— 本轮结果未记账（下一轮重新判断，不会因此停摆）`)
  }
}
/**
 * 心跳：**每一轮都要落一行**（含 broken 的跳过轮与重试轮）。反向心跳用它区分
 * "进程还在、只是退避中"（state=broken, skipped=yes）与"进程根本没跑"（文件不动）。
 */
function beat({ skipped = false, exit = 0 } = {}) {
  if (!backoff || !STATE_WRITES_OK) return
  appendHeartbeat(HEARTBEAT_FILE, renderHeartbeat({
    tool: TOOL, state: backoffState?.state ?? 'unknown', nowIso: NOW.toISOString(),
    attempt: backoffState?.consecutiveFailures ?? 0, skipped, exit,
  }))
}
/**
 * 跃迁的稳定摘要：同一场故障（同 enteredStateAt + 同 from→to）跨轮次稳定 ⇒ 补发不会重复评论；
 * 恢复后再次坏掉时 enteredStateAt 变了 ⇒ 仍然是新的一条评论。
 */
const transitionDigest = (transition) => createHash('sha256')
  .update(`${TOOL}|${transition.from}|${transition.to}|${backoffState?.enteredStateAt ?? ''}`).digest('hex').slice(0, 16)

/** 跃迁通知的落点：本脚本自己的跟踪 issue（优先本轮 target 那一条，其次最新一条）。找不到就**不新建**。 */
function resolveNotifyIssue() {
  const got = readOpenIssues()
  if (!got.ok) return { ok: false, why: '读不到 open issue 列表' }
  const tracking = got.issues.filter(isTracking)
  if (!tracking.length) return { ok: false, why: '没有本脚本的 open 跟踪 issue（不为退避通知另开一种 issue 通道）' }
  const forTarget = CURRENT_TARGET ? tracking.find((i) => versionInTitle(i.title) === CURRENT_TARGET) : null
  const sorted = [...tracking].sort((a, b) => (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0)
    || (b.number ?? 0) - (a.number ?? 0))
  return { ok: true, number: (forTarget ?? sorted[0]).number }
}
function alreadyCommented(number, digest) {
  try {
    const out = execFileSync(GH, ['issue', 'view', String(number), '--json', 'comments'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return (JSON.parse(out).comments ?? []).some((c) => String(c?.body ?? '').includes(`dsh-watch-backoff-digest: ${digest}`))
  } catch { return false }   // 读不到评论列表就照发：不因查询失败丢掉告警
}
function postComment(number, body, digest) {
  try {
    execFileSync(GH, ['issue', 'comment', String(number), '--body', `${body}\n\n<!-- dsh-watch-backoff-digest: ${digest} -->`], { encoding: 'utf8' })
    return { ok: true }
  } catch (e) {
    return { ok: false, err: String(e?.stderr || e?.message || e).trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'unknown' }
  }
}
/**
 * 只在跃迁时发一条评论（带 `state=<to>` 标记 + digest）。写失败 ⇒ 记进状态文件的
 * pendingNotification、**下一轮补发**（至少一次）；成功 ⇒ 记进 notified（digest 幂等）。
 */
function notifyTransition(transition, { error = null, nextAttemptAt = null } = {}) {
  if (!transition?.notify) return { posted: false }
  const digest = transitionDigest(transition)
  const { body } = renderTransitionComment({
    tool: TOOL, transition, error, threshold: FAILURE_THRESHOLD, nextAttemptAt, digestToken: digest, nowIso: NOW.toISOString(),
  })
  if (!NOTIFY_TRANSITIONS) {
    console.log(`状态跃迁 ${transition.from}→${transition.to}（CI 临时文件系统：只记账、不发评论）`)
    backoffState.notified[digest] = NOW.toISOString()
    return { posted: false, ci: true }
  }
  if (backoffState.notified[digest]) return { posted: false, duplicate: true }
  const target = resolveNotifyIssue()
  if (!target.ok) {
    backoffState.pendingNotification = { from: transition.from, to: transition.to, digest, body, at: NOW.toISOString() }
    console.log(`（跃迁通知暂缓：${target.why}；已记入状态文件，下一轮补发）`)
    return { posted: false, pending: true }
  }
  if (alreadyCommented(target.number, digest)) {
    backoffState.notified[digest] = NOW.toISOString()
    return { posted: false, duplicate: true }
  }
  const r = postComment(target.number, body, digest)
  if (!r.ok) {
    backoffState.pendingNotification = { from: transition.from, to: transition.to, digest, body, at: NOW.toISOString() }
    console.log(`（跃迁评论失败：${r.err}；已记入状态文件，下一轮补发）`)
    return { posted: false, pending: true, error: r.err }
  }
  backoffState.notified[digest] = NOW.toISOString()
  console.log(`状态跃迁 ${transition.from}→${transition.to}：已评论 #${target.number}（同一状态不再重复评论）`)
  return { posted: true, number: target.number }
}
function flushPendingNotification() {
  const p = backoffState?.pendingNotification
  if (!p || !NOTIFY_TRANSITIONS) return
  const target = resolveNotifyIssue()
  if (!target.ok) return
  if (alreadyCommented(target.number, p.digest)) { backoffState.pendingNotification = null; persistBackoff(); return }
  const r = postComment(target.number, p.body, p.digest)
  if (!r.ok) return
  backoffState.notified[p.digest] = NOW.toISOString()
  backoffState.pendingNotification = null
  console.log(`补发跃迁评论 #${target.number}（${p.from}→${p.to}）`)
  persistBackoff()
}
/** 记一轮失败（供"工作第一步就失败"的路径在 finish 之外使用）。 */
function recordFailureNow(errorMsg) {
  if (!backoff || !STATE_WRITES_OK) return null
  const { state, transition } = recordOutcome(backoffState, {
    ok: false, error: errorMsg, nowMs: NOW.getTime(), threshold: FAILURE_THRESHOLD,
  })
  backoffState = state
  if (transition?.notify) notifyTransition(transition, { error: errorMsg, nextAttemptAt: state.nextAttemptAt })
  persistBackoff()
  return { state, transition }
}
/** 工作第一步就失败（拿不到 packument 等）：记账 → 按状态决定输出多少 → exit 1。 */
function fatal(errorMsg) {
  failErr(errorMsg)
  const wasBroken = backoffState?.state === 'broken'
  const rec = recordFailureNow(errorMsg)
  if (rec?.state.state === 'broken') {
    // 进入 broken 的那一轮给"连续 N 次失败"；之后的重试轮只报"仍是 broken"（都是一行）。
    console.log(!wasBroken
      ? renderBrokenEntry({
        attempt: rec.state.consecutiveFailures, minutesLeft: backoffMinutes(rec.state.backoffRetries),
        error: errorMsg, threshold: FAILURE_THRESHOLD,
      })
      : renderStillBroken({
        attempt: rec.state.consecutiveFailures, minutesLeft: backoffMinutes(rec.state.backoffRetries),
        nowIso: NOW.toISOString(),
      }))
  }
  beat({ skipped: false, exit: 1 })
  process.exit(1)
}

if (!BACKOFF_OFF) {
  backoff = { file: STATE_FILE, tool: TOOL }
  const loaded = loadState(STATE_FILE, { tool: TOOL, nowMs: NOW.getTime(), stamp: NOW.toISOString() })
  backoffState = loaded.state
  if (loaded.corrupt) {
    console.error(`!! 退避状态文件损坏（${loaded.corrupt.reason}）⇒ 已备份到 ${loaded.corrupt.backupPath || '（备份也失败）'}、重建为 healthy`
      + '（fail-open：坏状态不该让探针永远静默）')
  }
  if (RESET_STATE) {
    resetStateFile(STATE_FILE, { tool: TOOL, nowMs: NOW.getTime() })
    console.log(`退避状态已重置：${STATE_FILE}（healthy，不写 GitHub）—— 人工恢复用；下一轮会重新判断`)
    process.exit(0)
  }
  if (STATE_WRITES_OK) {
    if (loaded.corrupt) persistBackoff()
    flushPendingNotification()
    const d = decide(backoffState, NOW.getTime())
    if (d.skip) {
      backoffState.lastRunAt = NOW.toISOString()
      persistBackoff()
      beat({ skipped: true, exit: 0 })
      console.log(renderStillBroken({ attempt: backoffState.consecutiveFailures, minutesLeft: d.minutesLeft, nowIso: NOW.toISOString() }))
      process.exit(0)
    }
  } else {
    console.log(`（只读轮${DRY ? ' --dry-run' : ''}${PAUSED ? ' / PAUSE' : ''}：不做退避判定、不写状态文件 ${STATE_FILE}）`)
  }
} else {
  console.error('退避/状态记录已禁用（--no-backoff）：仅用于演练与负向对照，生产轮次不要带它')
}

// 锁必须在**任何写操作之前**拿到，而且要靠"进程退出自动释放"的 flock ——
// 用 `open('wx')` 那种锁文件，崩溃后会留下永久死锁（下一次告警就再也不会发出）。
// 实现方式是最小侵入的 re-exec：`flock -n -E 75 <lock> node <self> <原参数…>`，
// 子进程通过 DSH_WATCH_LOCK_HELD=1 认自己已在锁内（避免无限递归）。
// flock 缺失（例如 Windows 侧直接跑）⇒ 明确告警后继续：写操作仍然是收敛式的（确定性键 + 对账），
// 只是失去"本机同一时刻只有一个实例"的保证。
if (!DRY && !PAUSED && !UNDER_LOCK) {
  try { mkdirSync(dirname(LOCK_FILE), { recursive: true }) } catch (e) {
    console.error(`!! 无法创建锁目录 ${dirname(LOCK_FILE)}：${e.message} —— 放弃本机互斥继续（写操作仍是收敛式）`)
  }
  const r = spawnSync('flock', ['-n', '-E', '75', LOCK_FILE, process.execPath, SELF, ...argv], {
    stdio: 'inherit',
    env: { ...process.env, DSH_WATCH_LOCK_HELD: '1' },
  })
  if (r.error?.code === 'ENOENT') {
    console.error('!! 找不到 flock（util-linux）：无法保证本机单写者 ⇒ 继续执行；'
      + '写操作仍按"确定性键 + 对账"收敛，但同一台机器上并发跑两个实例时可能各建一条（下一轮对账会收敛）')
  } else if (r.status === 75) {
    console.log(`已跳过本轮（skipped by lock）：另一个 dsh-watch 实例持有 ${LOCK_FILE}`
      + ' —— 单写者纪律：同一时刻只允许一个本机实例写 GitHub')
    process.exit(0)
  } else if (typeof r.status !== 'number') {
    console.error(`!! flock 执行失败（${r.error?.message ?? '未知原因'}）—— 本轮放弃（不带着未知的互斥状态去写）`)
    process.exit(1)
  } else {
    process.exit(r.status)
  }
}
if (UNDER_LOCK && !quiet()) console.log(`已获取本机独占锁（flock ${LOCK_FILE}）`)
if (PAUSED) console.log(`paused by ${PAUSE_FILE} —— 本轮跳过一切写操作（只读探测、去重判定、重复单报告继续）`)

const bare = (v) => (v ?? '').split('-')[0].split('.').map(Number)
// 无预发布必须返回**空数组**：`'0.2.1'.split('-')[1]` 是 undefined，旧写法 `?? ''` 再 split('.')
// 得到 `['']`（长度 1）⇒ 正式版被判成"有预发布标识"，于是 `0.2.1 < 0.2.1-rc.2`。
// 后果正是审计定性 P0-1：上游 rc 转正为正式版时 watch 判"比地板旧"，静默不提醒 ——
// 而那恰好是 6h 硬 SLA 唯一生效的时刻。多段预发布（0.1.0-alpha-1）用 slice(1).join('-') 保留。
const pre = (v) => { const s = String(v ?? '').split('-').slice(1).join('-'); return s === '' ? [] : s.split('.') }
/** 语义化比较：a > b ⇒ >0（与 manager 的 versionGt / 探针口径一致）。 */
function cmp(a, b) {
  const [A, B] = [bare(a), bare(b)]
  for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0)
  const [x, y] = [pre(a), pre(b)]
  if (x.length === 0 && y.length === 0) return 0
  if (x.length === 0) return 1    // 正式版 > 同号任何预发布（semver §11.3）
  if (y.length === 0) return -1
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const u = x[i] ?? '', v = y[i] ?? ''
    const un = /^\d+$/.test(u), vn = /^\d+$/.test(v)
    if (un && vn) { if (+u !== +v) return +u - +v }
    else if (u !== v) return u < v ? -1 : 1
  }
  return 0
}

function npmPackument() {
  const url = `${REGISTRY}/@deepseek-ai/dsh`
  const attempts = [['-fsS'], ...(process.env.HTTPS_PROXY ? [['-fsS', '-x', process.env.HTTPS_PROXY]] : [])]
  for (const extra of attempts) {
    try { return JSON.parse(execFileSync('curl', [...extra, '--max-time', '40', url], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) } catch (e) { /* next */ }
  }
  // 走 fatal()：记账（degraded/broken）+ 按状态决定输出多少（broken 时只留一行摘要，明细进 .detail.log）。
  fatal(`拿不到 npm packument（${url}；直连与代理都失败）—— 这是**真故障**，故非零退出`)
}

// 地板默认读真源（scripts/server-manager.mjs）；--floor 只为演练/回放（把地板钉在某个版本，
// 否则"上游转正"这类场景只能在真源恰好落后时才能复现）。
const FLOOR_ARG = arg('--floor')
const floor = FLOOR_ARG ?? /MIN_DSH_VERSION\s*=\s*'([^']+)'/.exec(execFileSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(MANAGER)},'utf8'))`], { encoding: 'utf8' }))?.[1]
const pkg = npmPackument()
const tags = pkg['dist-tags'] ?? {}
const time = pkg.time ?? {}

let target = null
let kind = null
let deadline = null
let threshold = null
let elapsed = null
let breached = false
if (FORCE) {
  target = FORCE
  kind = '演练（--force-target）'
  threshold = argv.includes('--force-pre') ? BEST_EFFORT_HOURS : SLA_HOURS
} else if (cmp(tags.latest, floor) > 0) {
  target = tags.latest
  kind = `SLA ${SLA_HOURS}h（latest 通道，硬指标）`
  threshold = SLA_HOURS
} else if (cmp(tags.next, floor) > 0 || cmp(tags.alpha, floor) > 0) {
  target = cmp(tags.next, floor) > 0 ? tags.next : tags.alpha
  kind = `best-effort ${BEST_EFFORT_HOURS}h（预发布通道）`
  threshold = BEST_EFFORT_HOURS
}
// 拿到 target 后再赋值（A6 的跃迁评论优先挂到这一版的跟踪单上）。
CURRENT_TARGET = target
let pubUnknown = false
if (target && threshold !== null) {
  const pub = FORCE_PUBLISHED ?? time[target]
  const pubMs = pub ? new Date(pub).getTime() : NaN
  if (!Number.isNaN(pubMs)) {
    deadline = new Date(pubMs + threshold * 3600000).toISOString()
    elapsed = (NOW.getTime() - pubMs) / 3600000
    breached = NOW.getTime() > new Date(deadline).getTime()   // 方案 §6：到点地板未动 ⇒ 合法失败入口
  } else {
    // fail-closed：取不到上游发布时间就**不能**断言"未超时"。旧实现把 deadline 设成 '?' 而 breached
    // 保持 false，于是这个版本永远不会进入 SLA 未达标入口（静默假阴性）。
    deadline = '?'
    pubUnknown = true
    breached = true
  }
}

const lines = [
  '### dsh-watch',
  '',
  `壳地板 \`${floor}\`；npm dist-tags：latest=\`${tags.latest ?? '—'}\` next=\`${tags.next ?? '—'}\` alpha=\`${tags.alpha ?? '—'}\``,
  '',
  target ? `需要适配：**${target}** —— ${kind}，${threshold}h 截止 ${deadline}` : '无需适配（地板不落后于任何通道）',
]
const md = lines.join('\n')
console.log(md)
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n', { flag: 'a' })

// 报告只在结尾写一次：所有分支（含"无事发生"、dry-run、paused、锁跳过）都要留下机器可读结论。
// 注意 `--now` 是垃圾时在上面就 exit 2 了 ⇒ 不会留下"未违约"的假报告（既有断言如此）。
const report = {
  floor, tags, target, kind, threshold, deadline, elapsed, breached, pubUnknown,
  registry: REGISTRY, generatedAt: new Date().toISOString(),
  dryRun: DRY, paused: PAUSED, pauseFile: PAUSED ? PAUSE_FILE : null,
  lock: UNDER_LOCK ? LOCK_FILE : null,
  dedupe: null, reconcile: null, backoff: null,
}
const finish = (code) => {
  // A6：记账（只读轮次不记；code 2 = 用法/属主配置错误，不当作"探针坏了" —— 否则打错一次
  // --assignee 就会退避一小时）。正常轮（0）会显式清零，**成功即 Forget**（client-go 的语义）。
  if (backoff && STATE_WRITES_OK && (code === 0 || code === 1)) {
    const wasBroken = backoffState.state === 'broken'
    const { state, transition } = recordOutcome(backoffState, {
      ok: code === 0,
      error: code === 0 ? null : (FAILURE ?? 'exit 1'),
      nowMs: NOW.getTime(),
      threshold: FAILURE_THRESHOLD,
    })
    backoffState = state
    report.backoff = {
      state: state.state, consecutiveFailures: state.consecutiveFailures, backoffRetries: state.backoffRetries,
      nextAttemptAt: state.nextAttemptAt, lastSuccessAt: state.lastSuccessAt, lastError: state.lastError,
      transition: transition ? { from: transition.from, to: transition.to, notify: transition.notify } : null,
    }
    if (code === 1 && state.state === 'broken') {
      // broken 期间 stdout 只留一行：入口给"连续 N 次失败"的摘要，之后的重试只报"仍是 broken"。
      console.log(!wasBroken
        ? renderBrokenEntry({
          attempt: state.consecutiveFailures, minutesLeft: backoffMinutes(state.backoffRetries),
          error: FAILURE, threshold: FAILURE_THRESHOLD,
        })
        : renderStillBroken({
          attempt: state.consecutiveFailures, minutesLeft: backoffMinutes(state.backoffRetries),
          nowIso: NOW.toISOString(),
        }))
    }
    if (transition?.notify) notifyTransition(transition, { error: code === 0 ? null : FAILURE, nextAttemptAt: state.nextAttemptAt })
    persistBackoff()
  }
  beat({ skipped: false, exit: code })
  if (OUT) {
    try { writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch (e) { console.error(`!! 写不出 --json 报告 ${OUT}：${e.message}`) }
  }
  process.exit(code)
}

// ── 确定性键：版本号的词边界匹配 ────────────────────────────────────────────
// 词边界 = 前后不能是 [0-9A-Za-z.-]，于是 `0.2.1` 不匹配 `0.2.1-rc.2`，也不匹配 `0.2.10`；
// `0.2.1-rc.3` 不匹配 `0.2.1-rc.30`（这正是事故里"去重按 label 过滤"之外的第二处隐患）。
// 正则、标题前缀与 `findTrackingIssue` 的唯一实现在 `scripts/lib/issue-key.mjs`：本脚本用它去重/对账，
// `dsh-sla-report.mjs` 用同一个键取"这一版最早什么时候被发现" —— 一份实现，两处口径。

// ── 读：open issue 列表（去重与对账共用一次查询）───────────────────────────
// 不按 label 过滤（事故根因）。`--limit 1000` 覆盖本仓库规模；真到上限会显式告警"可能被截断"，
// 不把截断后的列表当成"完整事实"。
function readOpenIssues() {
  try {
    const out = execFileSync(GH, ['issue', 'list', '--state', 'open', '--limit', '1000',
      '--json', 'number,title,body,labels,assignees,createdAt,author'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    const arr = JSON.parse(out)
    if (!Array.isArray(arr)) throw new Error('gh issue list 返回的不是数组')
    if (arr.length >= 1000) console.error('!! open issue 达到 --limit 1000 上限：列表可能被截断（去重/对账结论不完整）')
    return { ok: true, issues: arr }
  } catch (e) {
    const msg = String(e?.stderr || e?.message || e).trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'unknown'
    failErr(`!! 读不到 open issue 列表（${msg}）—— "查不到"不等于"没有重复"，本轮不做去重判定`)
    return { ok: false, issues: [], error: msg }
  }
}

// 找到这一版的跟踪单（`findTrackingIssue`，见 `scripts/lib/issue-key.mjs`）：本脚本标题前缀 +
// 版本号词边界命中。确定性、与写者/label 无关；报表侧用同一个键判断"哪一版、最早什么时候被发现"。

/** 读回上次写进正文的状态标记；没有 = 这单是本改动之前建的（状态未知）。 */
function parseState(text) {
  const m = new RegExp('<!-- dsh-watch-state: target=(\\S+) breached=(true|false) -->').exec(String(text ?? ''))
  return m ? { target: m[1], breached: m[2] } : null
}

// ── 收敛对账：同一版本多条 open issue ⇒ 留一条、关其余 ─────────────────────
const RECONCILE_NOTE = (canonical) => `重复于 #${canonical}（同版本跟踪单），由 autopilot 对账关闭`
const labelNames = (i) => (i?.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
const assigneeNames = (i) => (i?.assignees ?? []).map((a) => (typeof a === 'string' ? a : a?.login)).filter(Boolean)
/**
 * 保留哪一条（**明确规则**，避免"谁先建谁算"这种与写者耦合的判据）：
 *   ① 带跟踪 label（`dsh-upgrade` / `sla-breach`）的优先 —— 事故里唯一带 label 的 #217 因此被保留；
 *   ② 其次带 assignee 的优先（能叫醒人）；
 *   ③ 同优先级取 `createdAt` 最早（等价于最小编号；确定性）；
 *   ④ createdAt 缺失时按编号升序。
 */
function canonicalRank(a, b) {
  const labelOf = (i) => labelNames(i).filter((n) => n === 'dsh-upgrade' || n === 'sla-breach').length ? 1 : 0
  if (labelOf(a) !== labelOf(b)) return labelOf(b) - labelOf(a)
  const asOf = (i) => assigneeNames(i).length ? 1 : 0
  if (asOf(a) !== asOf(b)) return asOf(b) - asOf(a)
  const ta = Date.parse(a.createdAt ?? '') || 0
  const tb = Date.parse(b.createdAt ?? '') || 0
  if (ta !== tb) return ta - tb
  return (a.number ?? 0) - (b.number ?? 0)
}
/** 按版本分组，返回需要收敛的组（>1 条）。只处理本脚本自己的标题（不动人类的 issue）。 */
function planReconcile(issues) {
  const groups = new Map()
  for (const i of issues ?? []) {
    if (!isTracking(i)) continue
    const v = versionInTitle(i.title)
    if (!v) continue
    if (!groups.has(v)) groups.set(v, [])
    groups.get(v).push(i)
  }
  const plans = []
  for (const [version, list] of groups) {
    if (list.length < 2) continue
    const sorted = [...list].sort(canonicalRank)
    plans.push({ version, keep: sorted[0].number, close: sorted.slice(1).map((i) => i.number).sort((a, b) => a - b) })
  }
  return plans.sort((a, b) => (a.version < b.version ? -1 : 1))
}
const planText = (plans) => [
  `对账：open issue 里发现 ${plans.length} 组同版本重复 ——`,
  ...plans.map((p) => `  · ${p.version}：保留 #${p.keep}（带 label/assignee 的规范单优先，同分取最早创建），`
    + `待关闭 ${p.close.length} 条：${p.close.map((n) => `#${n}`).join(' ')}`),
].join('\n')
const manualCommands = (plans) => plans.flatMap((p) => p.close.map((n) =>
  `  ./scripts/gh issue close ${n} --reason "not planned" --comment "${RECONCILE_NOTE(p.keep)}"`))
function manualText(plans, why) {
  const cmds = manualCommands(plans)
  if (!cmds.length) return ''
  return [`待人工关闭（${why}；**不要重复重试**，每次重试都是一条噪音 + 可能 429）：`, ...cmds].join('\n')
}

// ── 写：统一入口（失败即停写，不硬试）──────────────────────────────────────
// 事故里最贵的教训：PAT 缺 Issues:write，create 能过、update/close/comment 全部 403。
// 一旦命中"权限/不可用"，后续每个写操作都会再撞一次墙（噪音 + 限流），所以**一次就停**，
// 剩下的转成"待人工清单"。这不影响下一轮：所有写操作都是收敛式的。
let writeBlocked = null
const blockedReason = (msg) => /not accessible|forbidden|403|429|rate limit|not found|404/i.test(msg)
function runWrite(what, fn) {
  if (writeBlocked) {
    console.log(`  · 跳过写操作「${what}」：本轮已停写（${writeBlocked}）`)
    return { ok: false, skipped: true, err: writeBlocked }
  }
  try { return { ok: true, out: fn() } } catch (e) {
    const msg = String(e?.stderr || e?.message || e).trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'unknown'
    failErr(`!! 写操作失败「${what}」：${msg}`)
    if (blockedReason(msg)) {
      writeBlocked = msg
      failErr('!! 权限/目标不可用 ⇒ 本轮停止一切写操作（不硬试，避免噪音与 429）；失败项见日志与 --json 报告')
    }
    return { ok: false, err: msg }
  }
}
/** 写后复核：label/assignee 是否真的落地（事故里它们静默没落地）。读不到不算通过，但也不因此再建一条。 */
function readIssueBrief(number) {
  try {
    const out = execFileSync(GH, ['issue', 'view', String(number), '--json', 'number,labels,assignees'], { encoding: 'utf8' })
    return JSON.parse(out)
  } catch { return null }
}
function verifyWritten(number, want) {
  const check = (v) => {
    if (!v) return null
    const labels = labelNames(v)
    const assignees = assigneeNames(v)
    const missing = []
    for (const l of [want.label, PRIORITY_LABEL]) if (!labels.includes(l)) missing.push(`label:${l}`)
    if (want.assignee && !assignees.includes(want.assignee)) missing.push(`assignee:${want.assignee}`)
    return missing
  }
  let missing = check(readIssueBrief(number))
  if (missing === null) {
    console.log(`?? 写后复核：#${number} 的 label/assignee 读不回来（不算通过；去重不依赖它们，不会因此重复开单）`)
    return 'unreadable'
  }
  if (missing.length === 0) {
    console.log(`写后复核通过：#${number} 的 label/assignee 已落地`)
    return 'ok'
  }
  console.log(`!! 写后复核失败：#${number} 缺少 ${missing.join('、')} —— 尝试一次幂等修复（edit --add-label/--add-assignee）`)
  const fix = runWrite(`修复 #${number} 的 label/assignee`, () => execFileSync(GH,
    ['issue', 'edit', String(number), '--add-label', want.label, '--add-label', PRIORITY_LABEL, '--add-assignee', want.assignee],
    { encoding: 'utf8' }))
  if (!fix.ok) {
    console.log(`!! 修复未成功（${fix.err}）—— 去重键是标题里的版本号，下一轮仍会命中 #${number}（不会重复开单）`)
    console.log(`   待人工：./scripts/gh issue edit ${number} --add-label ${want.label} --add-label ${PRIORITY_LABEL} --add-assignee ${want.assignee}`)
    return 'missing'
  }
  missing = check(readIssueBrief(number))
  if (missing === null) return 'unreadable'
  if (missing.length) { console.log(`!! 修复后仍缺 ${missing.join('、')} —— 列入待人工清单，不再重试`); return 'missing' }
  console.log(`修复通过：#${number} 的 label/assignee 已补齐`)
  return 'ok'
}
/** 对账执行：close 成功后才评论（先关后评，避免"评论成功但关不掉"制造半截噪音；重跑也不会重复评论）。 */
function applyReconcile(plans) {
  const closed = []
  const failed = []
  const notes = []
  for (const p of plans) {
    for (const n of p.close) {
      const c = runWrite(`对账关闭 #${n}`, () => execFileSync(GH,
        ['issue', 'close', String(n), '--reason', 'not planned'], { encoding: 'utf8' }))
      if (!c.ok) { failed.push({ number: n, error: c.err }); continue }
      closed.push(n)
      const k = runWrite(`对账评论 #${n}`, () => execFileSync(GH,
        ['issue', 'comment', String(n), '--body', RECONCILE_NOTE(p.keep)], { encoding: 'utf8' }))
      if (!k.ok) notes.push({ number: n, error: k.err })
    }
  }
  return { closed, failed, notes }
}

// ── 无新版本：仍然做一次只读/收敛对账（自愈不依赖本轮 target）───────────────
if (!target) {
  const got = readOpenIssues()
  const plans = got.ok ? planReconcile(got.issues) : []
  report.reconcile = {
    scanned: got.ok ? got.issues.length : null,
    available: got.ok,
    plans: plans.map((p) => ({ version: p.version, keep: p.keep, close: p.close })),
    applied: null,
  }
  if (!got.ok) {
    failErr('!! 本轮不做对账（读不到 open issue 列表）—— 这是故障，不是"没有重复"')
    finish(1)
  }
  if (plans.length) {
    console.log(planText(plans))
    const canWrite = !DRY && !PAUSED
    if (!canWrite) {
      console.log(manualText(plans, DRY ? '--dry-run：未执行任何写操作' : `paused by ${PAUSE_FILE}`))
      report.reconcile.manual = manualCommands(plans)
    } else {
      const applied = applyReconcile(plans)
      report.reconcile.applied = applied
      const after = readOpenIssues()
      const left = after.ok ? planReconcile(after.issues) : null
      report.reconcile.remaining = left ? left.length : null
      if (left === null) {
        failErr('!! 对账后无法复核（读不到列表）—— 不报"已收敛"')
      } else if (left.length) {
        failErr(`!! 对账后仍有 ${left.length} 组重复（失败/未完成）`)
        console.log(manualText(left, applied.failed.length ? `对账失败：${applied.failed[0].error}` : '自动对账未完成'))
        report.reconcile.manual = manualCommands(left)
      } else {
        console.log(`对账完成：关闭 ${applied.closed.length} 条重复，open issue 里这些版本各只剩 1 条`)
      }
      if (applied.notes.length) {
        console.log(`!! 已关闭但评论未发出（${applied.notes.map((x) => `#${x.number}`).join(' ')}）：`
          + `./scripts/gh issue comment <number> --body "${RECONCILE_NOTE('?')}"`)
      }
    }
  }
  finish(0)
}

// 只有真的要开/更新 issue 时才要求属主可解析：解析不到 = 会静默跳过赋值 ⇒ 显式 exit 2（不是假绿）。
if (!OWNER) {
  console.error(`解析不到 issue 属主（assignee 目标）：--repo=${JSON.stringify(REPO)} 不是 OWNER/NAME。`
    + `\n用 --assignee <login> / --repo <owner/name> / GH_REPO / GITHUB_REPOSITORY 指定，或在本仓库配置 origin。`
    + `\n不赋值 = bot 开的 issue 很可能不推送（GitHub 只通知参与者/被@/被赋值者）—— 拒绝静默跳过。`)
  finish(2)
}

const checklist = `适配清单（方案 §4，按序执行；每步产物都要有坐标）：
1. 抬 MIN_DSH_VERSION（scripts/server-manager.mjs + src-tauri/resources/manager/server-manager.mjs）+ 注释块追加适配记录
2. 同步 README 的地板数值（CI 有「改了 manager 必改 README」门禁）
3. 重采夹具：node scripts/test-patch-targets.mjs --update-fixture --runtime <已装新版的 runtime>
4. 预装插件 peer 对齐：node scripts/test-plugin-dsh-compat.mjs（地板与 bundle 必须同批）
5. 全量门禁：npm test
6. 探针判据：node scripts/dsh-compat-probe.mjs --runtime <runtime> 必须 GREEN
7. dev 实机验收（chrome 三上报 / 桥 / 四个预装 bundle 装载）—— 需要**新启动的 dev 壳** + 两个日志文件
8. PR → 合并 → release-please 出 tag → 构建 → 装到正式版

一键（覆盖上面第 1–6 步的机械动作）：node scripts/dsh-adapt.mjs --version ${target} --runtime <runtime>
第 7 步要另跑（dev 壳在检查期间新启动）：node scripts/dsh-adapt.mjs --version ${target} --runtime <runtime> --canary
第 8 步（PR / 发布 / 装机）仍是人工流程 —— 脚本刻意不做（对外副作用）。`

const pubText = FORCE_PUBLISHED ?? time[target] ?? '（npm packument 里没有该版本的发布时间）'
const bodyMain = breached
  ? `**SLA 未达标（方案 §6 的「合法失败」入口）**

上游 dsh \`${target}\` 于 \`${pubText}\` 发布，门槛 **${threshold}h**（${kind}），截止 \`${deadline}\` ——
${pubUnknown
    ? '**取不到该版本的上游发布时间，无法证明达标；按 fail-closed 记为未达标**（"量不出来"不等于"达标"）。'
    : `现在已过 **${elapsed.toFixed(2)}h**，而壳地板仍是 \`${floor}\`。`}

要把这一次变成「合法失败」，只需两件事（§6）：
1. **在本 issue 写清具体 blocker**（哪条契约 / 哪个门禁 / 哪个上游破坏性变更）与一个 ETA；
2. 同时发一个**保持旧地板**的稳定版 —— 它不产生新的 SLA 配对，所以数字不会被修饰。

${checklist}`
  : `**上游 dsh \`${target}\` 比壳地板 \`${floor}\` 新** —— 通道口径：${kind}
截止时间：\`${deadline}\`（起点 = npm 上的发布时间，方案 §1.1a）

${checklist}`
// 状态标记（HTML 注释，渲染不可见）：更新路径靠它判断「目标版本 / SLA 状态是否真的变了」，
// 避免每 15 分钟的 cron 都刷一条评论（GitHub 的 comment 会推送，edit 不会）。
// ⚠️ 它是"要不要评论"的判据，**不是**去重键：正文 edit 也可能失败，去重键只能是标题里的版本号。
const STATE_TAG = 'dsh-watch-state'
// 首行以 @owner 开头（不要在前面加中文标点：mention 需要前面是行首/空白才成立）。
const body = `@${OWNER}（负责人；自动化告警：assignee + 正文提及双保险）

${bodyMain}

<!-- ${STATE_TAG}: target=${target} breached=${breached} -->`
const label = breached ? 'sla-breach' : 'dsh-upgrade'
const title = breached
  ? `[SLA 未达标] dsh ${target} ${pubUnknown ? '发布时长未知（npm 无发布时间戳）' : `已发布 ${elapsed.toFixed(1)}h`}（门槛 ${threshold}h），地板仍停在 ${floor}`
  : `[dsh-watch][${kind}] dsh ${target} 比地板 ${floor} 新`

const bodyFile = join(tmpdir(), 'dsh-watch-body.md')
writeFileSync(bodyFile, body)

// ── 去重判定（读）：确定性键，不依赖 label ─────────────────────────────────
/** 上次写进正文的状态标记 ⇒ 本轮"要不要评论"。读不到标记 = 首次接管（状态未知）。 */
function describeMatch(issue) {
  if (!issue) return { prev: null, changes: [] }
  const prev = parseState(issue.body)
  const changes = []
  if (!prev) changes.push('首次接管（此前没有状态标记）')
  else {
    if (prev.target !== String(target)) changes.push(`目标版本 ${prev.target} → ${target}`)
    if (prev.breached !== String(breached)) changes.push(`状态 ${prev.breached === 'true' ? 'SLA 未达标' : '跟踪中'} → ${breached ? 'SLA 未达标' : '跟踪中'}`)
  }
  return { prev, changes }
}
/** 命中哪一条：正常情况就是版本词边界那一单；若这一版正在对账，则取"对账后会保留的规范单"。 */
function chooseMatch(issues, plans) {
  const plan = (plans ?? []).find((p) => p.version === String(target))
  if (plan) {
    const canonical = (issues ?? []).find((i) => i.number === plan.keep)
    if (canonical) return canonical
  }
  return findTrackingIssue(issues, target)
}

let got = readOpenIssues()
let reconcilePlans = got.ok ? planReconcile(got.issues) : []
let match = got.ok ? chooseMatch(got.issues, reconcilePlans) : null
let { prev, changes } = describeMatch(match)

report.dedupe = {
  available: got.ok,
  scanned: got.ok ? got.issues.length : null,
  matched: match ? match.number : null,
  wouldCreate: !match,
  prevState: prev,
  changes,
  reconcileFirst: reconcilePlans.length > 0,
}
report.reconcile = {
  available: got.ok,
  plans: reconcilePlans.map((p) => ({ version: p.version, keep: p.keep, close: p.close })),
  applied: null,
}

if (DRY) {
  console.log(`\n[dry-run] breached=${breached}（门槛 ${threshold}h，已过 ${elapsed === null ? '—' : elapsed.toFixed(2) + 'h'}）`
  + `\n          会以 labels=${label},${PRIORITY_LABEL}、assignee=${OWNER}（来源 ${OWNER_SOURCE}；正文含 @${OWNER}）开/更新 issue，标题：${title}`
  + `\n          去重（只读）：扫描 ${got.ok ? got.issues.length : '?'} 个 open issue ⇒ `
  + (match ? `**命中 #${match.number}**（复用：edit${changes.length ? ' + 评论（' + changes.join('；') + '）' : '，不评论'}）`
    : '未命中 ⇒ 会新建 1 条')
  + `\n          正文 ${body.length} 字符 —— 未执行任何写操作。`)
  if (reconcilePlans.length) {
    console.log(planText(reconcilePlans))
    console.log(manualText(reconcilePlans, '--dry-run：未执行任何写操作'))
    report.reconcile.manual = manualCommands(reconcilePlans)
  } else if (got.ok) {
    console.log(`对账（只读）：开单前扫描 ${got.issues.length} 条 open issue，无同版本重复`)
  }
  finish(0)
}

if (PAUSED) {
  console.log(`\n[paused] 本轮本应 ${match ? `更新 #${match.number}` : '新建 1 条'}（标题：${title}）—— 零写操作。`)
  if (reconcilePlans.length) {
    console.log(planText(reconcilePlans))
    console.log(manualText(reconcilePlans, `paused by ${PAUSE_FILE}`))
    report.reconcile.manual = manualCommands(reconcilePlans)
  }
  finish(0)
}

if (!got.ok) {
  failErr('!! 拒绝新建/更新：读不到 open issue 列表时无法做去重判定，此时开单只会再造一条重复')
  finish(1)
}

// ── 写 ①：label（"已存在即可"；失败不算错 —— 去重不依赖 label）───────────────
for (const [name, description, color] of [
  [label, breached ? 'SLA 未达标（方案 §6）' : '上游 dsh 新版本待适配', breached ? 'b60205' : '1d76db'],
  [PRIORITY_LABEL, '高优先级：自动化告警（dsh 升级 / SLA 未达标）', 'b60205'],
]) {
  try { execFileSync(GH, ['label', 'create', name, '--description', description, '--color', color], { encoding: 'utf8' }) } catch (e) { /* 已存在即可 */ }
}

// ── 写 ②：先收敛对账，再去重写单 ──────────────────────────────────────────
// 顺序很重要：若先按"第一条命中"去 edit，可能编辑的正是一条马上要被关掉的重复单；
// 对账先跑 ⇒ 接下来 edit 的一定是保留下来的规范单（#217 那类），正文不会停在旧状态。
if (reconcilePlans.length) {
  console.log(planText(reconcilePlans))
  const applied = applyReconcile(reconcilePlans)
  report.reconcile.applied = applied
  const after = readOpenIssues()
  const left = after.ok ? planReconcile(after.issues) : null
  report.reconcile.remaining = left ? left.length : null
  if (left === null) {
    failErr('!! 对账后无法复核（读不到列表）—— 不报"已收敛"；本轮也不再开/改单（宁可下一轮再来）')
    finish(1)
  } else if (left.length) {
    failErr(`!! 对账后仍有 ${left.length} 组重复（被 403 挡住或写入失败）`)
    console.log(manualText(left, applied.failed.length ? `对账失败：${applied.failed[0].error}` : '自动对账未完成'))
    report.reconcile.manual = manualCommands(left)
  } else {
    console.log(`对账完成：关闭 ${applied.closed.length} 条重复，这些版本各自只剩 1 条 open issue`)
  }
  if (applied.notes.length) {
    console.log(`!! 已关闭但评论未发出（${applied.notes.map((x) => `#${x.number}`).join(' ')}）：`
      + `./scripts/gh issue comment <number> --body "${RECONCILE_NOTE(reconcilePlans[0]?.keep ?? '?')}"`)
  }
  // 对账后的列表才是本轮的事实基础；重算命中的规范单（以及"要不要评论"）。
  got = after
  reconcilePlans = left ?? []
  match = chooseMatch(got.issues, reconcilePlans)
  ;({ prev, changes } = describeMatch(match))
  report.dedupe.matched = match ? match.number : null
  report.dedupe.wouldCreate = !match
  report.dedupe.prevState = prev
  report.dedupe.changes = changes
}

// ── 写 ③：复用（edit 静默刷新 + 必要时短评论）或新建（未命中才建）──────────
let written = null
if (match) {
  // 复用一律先 edit：静默刷新正文/标题、补齐 label/assignee（edit **不会**推送）；comment 只在
  // 「目标版本变化」或「状态跨级（无→跟踪中→SLA 未达标）」时追加一条**短**评论，避免 cron 噪音。
  const r = runWrite(`更新 #${match.number}`, () => execFileSync(GH, ['issue', 'edit', String(match.number),
    '--title', title, '--body-file', bodyFile,
    '--add-label', label, '--add-label', PRIORITY_LABEL, '--add-assignee', OWNER], { encoding: 'utf8' }))
  report.dedupe.updated = r.ok
  if (r.ok) {
    written = match.number
    if (changes.length) {
      const c = runWrite(`评论 #${match.number}`, () => execFileSync(GH, ['issue', 'comment', String(match.number),
        '--body', `已更新跟踪：${changes.join('；')}。`], { encoding: 'utf8' }))
      report.dedupe.commented = c.ok
      if (c.ok) console.log(`${breached ? 'SLA 未达标' : '跟踪'} issue 已更新并通知：#${match.number}（${changes.join('；')}）`)
    } else {
      console.log(`${breached ? 'SLA 未达标' : '跟踪'} issue 已静默更新：#${match.number}（目标与状态均未变，不刷评论）`)
    }
  } else {
    failErr(`!! 复用已有跟踪单 #${match.number} 失败 —— **不新建**（新建只会再造一条重复）`)
    report.dedupe.error = r.err
  }
} else {
  console.log(`（已扫描 ${got.issues.length} 个 open issue，无 ${target} 的词边界命中 ⇒ 新建）`)
  const r = runWrite('创建跟踪 issue', () => execFileSync(GH, ['issue', 'create', '--label', label, '--label', PRIORITY_LABEL,
    '--assignee', OWNER, '--title', title, '--body-file', bodyFile], { encoding: 'utf8' }))
  report.dedupe.created = r.ok
  if (r.ok) {
    written = Number((/\/issues\/(\d+)/.exec(String(r.out)) ?? [])[1] ?? 0) || null
    console.log(breached ? '已开 SLA 未达标 issue（方案 §6；已赋值并 @ 提及属主）' : '已开跟踪 issue（已赋值并 @ 提及属主）')
    if (written) console.log(`新 issue：#${written}`)
  } else {
    report.dedupe.error = r.err
  }
}

if (written) report.dedupe.verify = verifyWritten(written, { label, assignee: OWNER })

// 退出码口径：**primary 写失败**（跟踪单没开成/没更新成 ⇒ 本轮告警没发出去）⇒ 1，让 CI 真红；
// 对账失败只出清单、exit 0 —— 否则本机 PAT 缺 Issues:write 时每次运行都非零退出，
// systemd 的 Restart=on-failure 会 60s 一次热循环（这正是 A6 要修的，不该在这里放大噪音）。
finish(report.dedupe.error ? 1 : 0)
