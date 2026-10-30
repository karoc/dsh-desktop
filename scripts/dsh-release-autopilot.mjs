#!/usr/bin/env node
// dsh-release-autopilot —— 把「检测到上游 dsh 新版 → 机械适配 → 开 PR → 合并 → 发版 → 核验资产」
// 收成**一条可装进定时器的真代码**（方案 docs/2026-10-17-dsh-upgrade-automation-plan.md 的
// 全自动流水线一节）。它是编排器，不是第二套适配实现：
//
//   ① 探测      node scripts/dsh-watch.mjs --dry-run --json <tmp>（无新版 ⇒ 打印「无需适配」exit 0）
//   ② 适配      git clone --local --shared <repo> /tmp/... → 在克隆里
//               node scripts/dsh-adapt.mjs --version <target> --runtime <tmp runtime>
//               runtime 由 dsh-rehearse 的 install 场景准备（**不重写安装逻辑**；
//               调用 `node scripts/dsh-rehearse.mjs --scenario install --version <target> --keep --json`）。
//               任一步失败 ⇒ issue 回帖 + exit（不 push，绝不留半截分支）。
//   ③ 推送      只提交 `git status --porcelain` 里的**已跟踪、非看板**文件 →
//               push 到 `auto/dsh-<target>`（**绝不** push main；更新既有分支用 `--force-with-lease` 锁到
//               当前远端 sha）→ `gh pr create`（正文含 target / 探针 verdict / 门禁套数 / 耗时 / 自动生成声明）。
//   ④ 等 CI     `gh pr view <n> --json statusCheckRollup`（README/方案里写的 `gh pr checks --json` 在本机
//               gh 2.45 **不支持 --json**，所以用方案允许的等价形式）。任一 check 明确失败 ⇒ 不合并、回帖、exit 1；
//               超时 / 一直 pending ⇒ 不合并、exit 1。SKIPPED / NEUTRAL 视为非失败（PR 上 windows/linux/release
//               作业本来就按事件 SKIP；把它们当失败会让任何 PR 都永不可合并）。
//   ⑤ 合并适配 PR  轮询 `mergeable` 到非 UNKNOWN；CONFLICTING / DIRTY ⇒ 停下、不 force；
//               MERGEABLE ⇒ `gh pr merge <n> --squash --admin`（合并必须用本机 PAT；CI 的 GITHUB_TOKEN
//               不能绕过分支保护）。合并后用 `gh pr view` 复核 state=MERGED。
//   ⑥ 版本 PR   release-please 由**本次合并的 push** 触发（合并走 PAT，事件会触发 workflow；GITHUB_TOKEN
//               创建的事件不会）。等标题 `chore(main): release X.Y.Z` 的 open PR（默认最多 15 分钟）→
//               确认 MERGEABLE → 合并。
//               ⚠ 该 PR 是 bot 创建的，GitHub 结构上**不会**给它的 PR 跑 workflow（action_required）⇒
//               `statusCheckRollup` 恒为空，这不是本脚本能改的。这里的替代门禁是三条同时成立：
//                 ① MERGEABLE（冲突即停）；② 若真有 check 上报，必须全绿/非失败；③ 变更文件必须全部落在
//                 release-please 的合法写域（package.json / tauri.conf.json / Cargo.toml / Cargo.lock /
//                 CHANGELOG.md / .release-please-manifest.json / 看板），否则拒绝合并。零 check 时日志会
//                 明写「按 bot PR 例外合并」，不会假装 checks 是绿的。
//   ⑦ 发版      从版本 PR 标题解析 X.Y.Z → 等 tag/Release 出现 → 若该 tag 尚无构建运行则
//               `gh workflow run build.yml --ref vX.Y.Z`（已有运行则**不重复派发**：build 的 concurrency 是
//               cancel-in-progress，重复派发会取消正在跑的构建）→ 轮询 Release 资产数（默认最多 30 分钟，
//               <3 就停在这里、回帖、exit 1）。
//   ⑧ 收尾      issue 回帖结构化总结（target / 适配耗时 / 门禁 / PR 号 / 版本号 / 资产 / 总耗时 / 是否发布）。
//
// ── 开关与安全阀 ─────────────────────────────────────────────────────────────
//   --dry-run            只走 ① + 打印计划；不 clone、不写文件、不 push、不调 gh 写接口。
//   --stage1             ⑤（合并适配 PR）之后停下，不等/不合并 release-please 版本 PR。「先建立信任」用。
//                        默认是**全自动**：检测到就一路到发布。
//   --require-canary     ⑤ 之前额外要求 `dsh-adapt --canary` 通过。默认关：canary 只认「脚本启动之后新写入」
//                        的两个日志行，前提是 dev 壳在窗口期内**新启动**；无人值守的定时器给不了这个前提。
//                        开启时需要 --dev-log / --manager-log 指向**真实 dev 壳**的日志；缺日志 ⇒ 停在 ⑤ 之前、
//                        回帖「等真机验收」、exit 3。
//   --issue <n>          指定回帖 issue；缺省按 target 在 open 的 dsh-upgrade / sla-breach 里找，找不到就新建。
//   --json [<file>]      结构化输出。不带文件：stdout 只输出 JSON、人类日志走 stderr；带文件：写文件、人类日志
//                        照旧走 stdout。
//   --wait-minutes <n>   ④ 等 CI 的上限，默认 40；0 表示只看一次（测试 pending 用）。
//   --poll-seconds <n>   轮询间隔，默认 20（测试用 1）。
//   --runtime <dir>      复用已装好目标版本的 runtime（跳过 dsh-rehearse install）；版本不符 ⇒ exit 3。
//   --repo <o/r>         gh 的仓库；缺省按 GH_REPO / GITHUB_REPOSITORY / git remote origin 解析。
//   --assignee <login>   新建 issue 时的 assignee/@提及；缺省=仓库 owner。
//   --canary-timeout <s> 透传给 dsh-adapt --canary-timeout（默认 180）。
//   --dev-log/--manager-log  --require-canary 时的真实 dev 壳日志路径（同 dsh-adapt 的参数）。
//
// 退出码：0 全绿完成（含无新版 / 已发布 / stage1 完成）｜1 失败（含 CI 红 / pending 超时 / 冲突 / 资产<3）
//         2 用法错误｜3 前置不满足（探测失败 / runtime 装不上 / 无法解析仓库或 issue / canary 缺日志）。
//
// ── 幂等 ───────────────────────────────────────────────────────────────────
//   * 同一 target：按分支 `auto/dsh-<target>` + `gh pr list --state all` 查已有 PR。
//       OPEN   ⇒ 复用（跳过 ②③，直接等 CI）；MERGED ⇒ 复用（直接继续 ⑥ 之后的版本链）；
//       CLOSED ⇒ 视为无 PR，重新适配并更新分支。
//   * 同一 target 且最新 Release 正文里 dsh `latest`/`next` == target 且资产 ≥3 ⇒ 直接打印「已发布」exit 0。
//   * 更新既有远端分支用 `--force-with-lease=refs/heads/auto/dsh-<target>:<远端 sha>`（只对这条自动化分支；
//     **绝不**对 main/master 做任何 force/写操作）。
//   * 成功/失败评论带内容摘要标记；同一内容的重复评论会被跳过（重跑不刷屏）。
//
// ── ⑥–⑧ 的「停摆版本 PR」兜底（2026-10-30）──────────────────────────────────
// 入口恒为「本轮检测到新版」⇒ 适配 PR 合并后地板==target，dsh-watch 不再报它，⑥–⑧ 不会自动续走；
// 一次无关 fix 合并留下的 release-please 版本 PR 会一直挂到下一次上游发版（实录：#234 从 10-24 停到
// 10-30，整整 5 天，v0.21.0 之后没有任何新壳）。因此在两条「本轮不干活」的早退路径（无新版 /
// 预发布通道跳过）上补一次收尾：若存在 open 的 `chore(main): release X.Y.Z`，走与 ⑥⑦⑧ **完全相同**的
// 合并 → 派发构建 → 等资产逻辑（写域白名单 / 冲突 / check 失败同口径 fail，不静默跳过）。
//   * `--no-release-resume` 关闭该兜底（人工接管/演练时用）；
//   * 该路径**不回帖 issue**：没有 target 可归因，避免把版本 PR 的收尾挂到预发布跟踪单上；
//   * 查询失败（gh 抖动）按「本轮无操作」处理并告警 —— 无新版轮次不该因为一次 API 抖动记失败。
//
// ── 刻意不做 ───────────────────────────────────────────────────────────────
//   * 不改仓库设置 / 分支保护 / 密钥；不 kill 任何进程；不动用户真实 runtime（只读软链 .pnpm-store）。
//   * 不在 CI 里合并（依赖本机 `scripts/gh` 的项目 PAT 才能 --admin）；`GH_BIN` 缺省自动指向它。
//   * 不自动适配 `next`/`alpha` 通道：manager 的安装目标 = max(地板, npm latest)，结构上装不到更高的预发布
//     （方案决策 ③C：预发布只开 issue、不开自动 PR）。--force-target 之类入口也不在本脚本里。
//   * 不写看板、不改工作区的任何文件；所有写操作都在 /tmp 克隆、临时 runtime 与远端 `auto/` 分支。
//
// ── 演练/测试注入点（正常跑不要设）──────────────────────────────────────────
//   GH_BIN=<stub>                  gh 桩（负向对照强制要求）
//   GIT_BIN=<stub>                 git 桩；正向前置用（不碰真仓库）
//   NODE_BIN=<stub>                dsh-watch / dsh-rehearse / dsh-adapt 的启动器桩
//   DSH_AUTOPILOT_WATCH_JSON=<f>   跳过 dsh-watch，直接读一份探测 JSON（回放 target 用）
//   GH_REPO=<o/r>                  同 --repo
//
// ── A6：退避 + 三态（2026-10-24，与 dsh-watch 共用 scripts/lib/backoff-state.mjs）────
//   定时器每 10–30 分钟一轮（本机 unit 是 10 分钟），旧行为是失败时**每轮重跑整条流水线 + 重印整段错误**。现在连续失败 3 次进入
//   broken，按 5→10→20→40（封顶 60）分钟退避：退避期内**只输出一行** `still broken (attempt k, next
//   retry in Xm)`、不 clone / 不 push / 不调 gh 写接口；心跳每轮写 `~/.dsh/state/dsh-release-autopilot.heartbeat`。
//   通知只在跃迁时回帖一次（healthy→degraded / →broken / →healthy），带 `state=<to>` 标记 + digest。
//   状态文件 `~/.dsh/state/dsh-release-autopilot.json`（`--state-dir`/`--state-file` 覆盖）；
//   `--reset-state` 人工恢复（不写 GitHub）；`--no-backoff` 只给演练/负向对照。
//   退出码补充：退避跳过轮 0（不干活、也不是新故障）；2（用法）/130（中断）不记账。
//   详细口径与"为什么 CI 里只记账不发评论"见 dsh-watch 头注释同名段。
//
// ── systemd user timer 模板（本仓库**不**改你机器上的 systemd；只给模板）──────
//   ~/.config/systemd/user/dsh-release-autopilot.service
//     [Unit]
//     Description=dsh-release-autopilot（检测上游 dsh 新版 → 自动适配 → 合并 → 发版）
//     After=network-online.target
//     Wants=network-online.target
//
//     [Service]
//     Type=oneshot
//     WorkingDirectory=%h/dsh-desktop
//     # 合并必须用项目 PAT 包装（CI 的 GITHUB_TOKEN 不能 --admin）；仓库脚本缺省已解析到 scripts/gh，
//     # 这里显式写死是为了 systemd 下不依赖实现细节（演练仍可用 GH_BIN 指向桩）。
//     Environment=GH_BIN=%h/dsh-desktop/scripts/gh
//     ExecStart=/usr/bin/node %h/dsh-desktop/scripts/dsh-release-autopilot.mjs
//     TimeoutStartSec=2h
//     Nice=10
//
//     [Install]
//     WantedBy=default.target
//
//   ~/.config/systemd/user/dsh-release-autopilot.timer
//     [Unit]
//     Description=周期跑 dsh-release-autopilot
//
//     [Timer]
//     OnBootSec=15min
//     OnUnitInactiveSec=30min
//     Persistent=true
//
//     [Install]
//     WantedBy=timers.target
//
//   启用（用户执行，本脚本不碰）：
//     systemctl --user daemon-reload
//     systemctl --user enable --now dsh-release-autopilot.timer
//   `Type=oneshot` + `OnUnitInactiveSec` 不会重入；不要与 dsh-watch 共用一个 unit。

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import {
  appendHeartbeat, backoffMinutes, decide, heartbeatFileFor, loadState, recordOutcome,
  renderBrokenEntry, renderHeartbeat, renderStillBroken, renderTransitionComment,
  resetStateFile, saveState,
} from './lib/backoff-state.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const T0 = Date.now()

// ══ 参数 ═══════════════════════════════════════════════════════════════════
const USAGE = `usage: node scripts/dsh-release-autopilot.mjs [--dry-run] [--stage1] [--require-canary]
                                      [--issue <n>] [--json [<file>]] [--wait-minutes <n>]
                                      [--poll-seconds <n>] [--runtime <dir>] [--repo <owner/name>]
                                      [--assignee <login>] [--canary-timeout <sec>]
                                      [--dev-log <session.log>] [--manager-log <runtime/manager.log>]

  ① dsh-watch 探测 → ② /tmp 克隆里 dsh-adapt（runtime 由 dsh-rehearse install 准备）→
  ③ push auto/dsh-<target> + PR → ④ 等 CI → ⑤ --admin 合并 → ⑥ 合并 release-please 版本 PR →
  ⑦ 派发 build + 等 3 个资产 → ⑧ issue 结构化回帖。

  --dry-run         只探测 + 打印计划，不写任何东西、不 push（无新版时打印「无需适配」exit 0）
  --stage1          ⑤ 之后停下（不合并版本 PR）；默认全自动
  --require-canary  ⑤ 之前要求 dsh-adapt --canary 通过（需要真实 dev 壳在窗口期内新启动）
  --issue <n>       指定回帖 issue（缺省按 target 查找/新建）
  --json [<file>]   结构化输出（不带文件 ⇒ stdout 只有 JSON）
  --wait-minutes n  等 CI 上限（默认 40；0 = 只看一次）
  --poll-seconds n  轮询间隔（默认 20）
  --runtime <dir>   复用已装目标版本的 runtime（跳过安装）
  --repo <o/r>      gh 仓库（缺省按 git remote/GH_REPO 解析）
  --assignee <login> 新 issue 的 assignee（缺省=仓库 owner）
  --canary-timeout s 透传 dsh-adapt（默认 180）
  --dev-log/--manager-log  --require-canary 用的真实 dev 壳日志路径
  --state-dir <dir>  退避状态目录（默认 ~/.dsh；状态文件 = <dir>/state/dsh-release-autopilot.json）
  --state-file <p>   直接指定退避状态文件
  --failure-threshold <n>  连续失败几次进入 broken（默认 3）
  --reset-state      重置本地退避状态为 healthy（不写 GitHub）后退出
  --no-backoff       禁用退避/状态记录（只给演练与负向对照）
  --no-release-resume 关闭「无新版时仍合并停摆的 release-please 版本 PR」兜底（默认开）

退出码：0 完成 / 1 失败 / 2 用法 / 3 前置不满足。详见脚本头注释。`

class UsageError extends Error {}

function parseArgs(argv) {
  const o = {
    dryRun: false, stage1: false, requireCanary: false, issue: null,
    json: false, jsonFile: null, waitMinutes: 40, pollSeconds: 20,
    runtime: null, repo: null, assignee: null, canaryTimeout: 180,
    devLog: null, managerLog: null, help: false,
    stateDir: null, stateFile: null, failureThreshold: 3, resetState: false, noBackoff: false,
    releaseResume: true,
  }
  const val = (i, name) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('-')) throw new UsageError(`${name} 需要值`)
    return v
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const eq = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : null
    const inline = eq ? a.slice(eq.length + 1) : null
    const take = (name) => (inline !== null ? inline : val(i++, name))
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--stage1') o.stage1 = true
    else if (a === '--require-canary') o.requireCanary = true
    else if (a === '--help' || a === '-h') o.help = true
    else if (a === '--issue' || eq === '--issue') {
      const n = Number(take('--issue'))
      if (!Number.isInteger(n) || n <= 0) throw new UsageError('--issue 必须是正整数')
      o.issue = n
    } else if (a === '--json' || eq === '--json') {
      o.json = true
      if (inline !== null) o.jsonFile = resolve(inline)
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) o.jsonFile = resolve(argv[++i])
    } else if (a === '--wait-minutes' || eq === '--wait-minutes') {
      const n = Number(take('--wait-minutes'))
      if (!Number.isFinite(n) || n < 0) throw new UsageError('--wait-minutes 必须是非负数')
      o.waitMinutes = n
    } else if (a === '--poll-seconds' || eq === '--poll-seconds') {
      const n = Number(take('--poll-seconds'))
      if (!Number.isFinite(n) || n < 1) throw new UsageError('--poll-seconds 必须 >= 1')
      o.pollSeconds = n
    } else if (a === '--runtime' || eq === '--runtime') o.runtime = resolve(take('--runtime'))
    else if (a === '--repo' || eq === '--repo') o.repo = take('--repo')
    else if (a === '--assignee' || eq === '--assignee') o.assignee = String(take('--assignee')).replace(/^@/, '')
    else if (a === '--canary-timeout' || eq === '--canary-timeout') {
      const n = Number(take('--canary-timeout'))
      if (!Number.isFinite(n) || n <= 0) throw new UsageError('--canary-timeout 必须是正数（秒）')
      o.canaryTimeout = n
    } else if (a === '--dev-log' || eq === '--dev-log') o.devLog = resolve(take('--dev-log'))
    else if (a === '--manager-log' || eq === '--manager-log') o.managerLog = resolve(take('--manager-log'))
    else if (a === '--state-dir' || eq === '--state-dir') o.stateDir = resolve(take('--state-dir'))
    else if (a === '--state-file' || eq === '--state-file') o.stateFile = resolve(take('--state-file'))
    else if (a === '--reset-state') o.resetState = true
    else if (a === '--no-backoff') o.noBackoff = true
    else if (a === '--no-release-resume') o.releaseResume = false
    else if (a === '--failure-threshold' || eq === '--failure-threshold') {
      const n = Number(take('--failure-threshold'))
      if (!Number.isInteger(n) || n < 1) throw new UsageError('--failure-threshold 必须是正整数')
      o.failureThreshold = n
    }
    else throw new UsageError(`未知参数 ${a}`)
  }
  if (o.repo && !/^[^/\s]+\/[^/\s]+$/.test(o.repo)) throw new UsageError(`--repo 必须是 owner/name（收到 ${o.repo}）`)
  return o
}

let opts
try {
  opts = parseArgs(process.argv.slice(2))
} catch (err) {
  console.error(`dsh-release-autopilot: ${err.message}\n\n${USAGE}`)
  process.exit(2)
}
if (opts.help) {
  process.stdout.write(USAGE + '\n')
  process.exit(0)
}

// 测试/演练注入点（正常环境不设）。
const GH = process.env.GH_BIN
  ?? (existsSync(join(ROOT, 'scripts', 'gh')) ? join(ROOT, 'scripts', 'gh') : 'gh')
const GIT = process.env.GIT_BIN ?? 'git'
const NODE = process.env.NODE_BIN ?? process.execPath
const WATCH_JSON = process.env.DSH_AUTOPILOT_WATCH_JSON ? resolve(process.env.DSH_AUTOPILOT_WATCH_JSON) : null

// ══ 输出 / 状态 ════════════════════════════════════════════════════════════
/** --json 不带文件时 stdout 必须是纯 JSON。 */
const jsonToStdout = opts.json && !opts.jsonFile
const log = (...parts) => {
  const text = parts.join(' ')
  ;(jsonToStdout ? process.stderr : process.stdout).write(text.endsWith('\n') ? text : text + '\n')
}
const short = (text, n = 420) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}
const STATE = {
  startedAt: new Date(T0).toISOString(),
  stage: 'init',
  currentStage: null,
  currentStageStarted: null,
  steps: [],
  target: null,
  floor: null,
  channel: null,
  probe: null,
  repo: null,
  remoteUrl: null,
  issue: null,
  branch: null,
  branchExisted: false,
  pushedThisRun: false,
  pr: null,
  adapt: null,
  releasePr: null,
  releaseVersion: null,
  resumed: null,
  tag: null,
  assets: [],
  waitingForHuman: false,
  error: null,
  notes: [],
  cloneDir: null,
  runtimeDir: null,
  runtimeCreated: false,
  workDir: null,
  releasePrNoCheckException: false,
}

// ── A6：三态 + 指数退避 + 只在跃迁时通知（与 dsh-watch 同一个模块）───────────
// 定时器每 10 分钟一轮；旧行为是失败时**每轮重跑整条流水线并重印整段错误**。现在连续失败 3 次进入
// broken、按 5→10→20→40（封顶 60）分钟退避；退避期内**只输出一行心跳行**、不 clone / 不 push /
// 不调 gh 写接口。通知只在跃迁时回帖一次（healthy→degraded / →broken / broken→healthy），
// 评论带 `state=<to>` 机器标记 + digest（补发/并发幂等）。人工恢复：`--reset-state`。
// 展开说明见 scripts/lib/backoff-state.mjs 与 scripts/dsh-watch.mjs 的同名段。
const TOOL = 'dsh-release-autopilot'
const STATE_DIR = resolve(opts.stateDir ?? process.env.DSH_STATE_DIR ?? join(homedir(), '.dsh'))
const STATE_FILE = resolve(opts.stateFile ?? join(STATE_DIR, 'state', `${TOOL}.json`))
const HEARTBEAT_FILE = heartbeatFileFor(STATE_FILE)
const STATE_WRITES_OK = !opts.dryRun
const PERSISTENT_STATE = Boolean(opts.stateDir || opts.stateFile || process.env.DSH_STATE_DIR)
const NOTIFY_TRANSITIONS = !(process.env.GITHUB_ACTIONS === 'true' && !PERSISTENT_STATE)
const FAILURE_THRESHOLD = opts.failureThreshold
let backoff = null
let backoffState = null

function persistBackoff() {
  if (!backoff || !STATE_WRITES_OK) return
  try { saveState(STATE_FILE, backoffState) } catch (err) {
    log(`[warn] 写不出退避状态 ${STATE_FILE}：${short(err.message, 200)} —— 本轮结果未记账（下一轮重新判断）`)
  }
}
function beat(exit) {
  if (!backoff || !STATE_WRITES_OK) return
  appendHeartbeat(HEARTBEAT_FILE, renderHeartbeat({
    tool: TOOL, state: backoffState?.state ?? 'unknown', nowIso: new Date().toISOString(),
    attempt: backoffState?.consecutiveFailures ?? 0, skipped: false, exit,
  }))
}
/** 同一场故障（同 enteredStateAt + 同 from→to）摘要稳定 ⇒ 补发不重复；恢复后再坏是新的一条。 */
const transitionDigest = (t) => createHash('sha256')
  .update(`${TOOL}|${t.from}|${t.to}|${backoffState?.enteredStateAt ?? ''}`).digest('hex').slice(0, 16)
function notifyTransition(transition, error) {
  if (!transition?.notify) return
  const digest = transitionDigest(transition)
  if (backoffState.notified[digest]) return
  const { body } = renderTransitionComment({
    tool: TOOL, transition, error, threshold: FAILURE_THRESHOLD, nextAttemptAt: backoffState.nextAttemptAt,
    digestToken: digest, nowIso: new Date().toISOString(),
  })
  if (!NOTIFY_TRANSITIONS) {
    log(`[info] 状态跃迁 ${transition.from}→${transition.to}（CI 临时文件系统：只记账、不发评论）`)
    backoffState.notified[digest] = new Date().toISOString()
    return
  }
  const pending = { from: transition.from, to: transition.to, digest, body, at: new Date().toISOString() }
  if (!STATE.issue?.number) {
    backoffState.pendingNotification = pending
    log(`[info] 状态跃迁 ${transition.from}→${transition.to}：本轮还没有 issue 可回帖，已记进状态文件（下一轮补发）`)
    return
  }
  if (commentIssue(body)) {
    backoffState.notified[digest] = new Date().toISOString()
    log(`[info] 状态跃迁 ${transition.from}→${transition.to}：已回帖 issue #${STATE.issue.number}`)
  } else {
    backoffState.pendingNotification = pending
    log('[warn] 跃迁回帖失败：已记进状态文件（下一轮补发）')
  }
}
/** flow 里解析出 issue 之后调用：把上一轮没发出去的跃迁评论补上（至少一次）。 */
function flushPendingNotification() {
  const p = backoffState?.pendingNotification
  if (!p || !NOTIFY_TRANSITIONS || !STATE.issue?.number) return
  if (!commentIssue(p.body)) return
  backoffState.notified[p.digest] = new Date().toISOString()
  backoffState.pendingNotification = null
  log(`[info] 补发跃迁回帖 #${STATE.issue.number}（${p.from}→${p.to}）`)
  persistBackoff()
}
/** 收尾记账：0 成功 / 1 失败 / 3 前置不满足算失败；2 用法、130 中断不记（不是工具坏了）。 */
function finishBackoff(exitCode) {
  if (!backoff) return
  if (!STATE_WRITES_OK || (exitCode !== 0 && exitCode !== 1 && exitCode !== 3)) { beat(exitCode); return }
  const wasBroken = backoffState.state === 'broken'
  const error = exitCode === 0 ? null : (STATE.error?.message ?? `exit ${exitCode}`)
  const { state, transition } = recordOutcome(backoffState, {
    ok: exitCode === 0, error, nowMs: Date.now(), threshold: FAILURE_THRESHOLD,
  })
  backoffState = state
  if (exitCode !== 0 && state.state === 'broken') {
    log(wasBroken
      ? renderStillBroken({ attempt: state.consecutiveFailures, minutesLeft: backoffMinutes(state.backoffRetries), nowIso: new Date().toISOString() })
      : renderBrokenEntry({ attempt: state.consecutiveFailures, minutesLeft: backoffMinutes(state.backoffRetries), error, threshold: FAILURE_THRESHOLD }))
  }
  if (transition?.notify) notifyTransition(transition, error)
  persistBackoff()
  beat(exitCode)
}

if (opts.noBackoff) {
  log('[warn] 退避/状态记录已禁用（--no-backoff）：仅用于演练与负向对照，生产轮次不要带它')
} else {
  backoff = { file: STATE_FILE, tool: TOOL }
  const loaded = loadState(STATE_FILE, { tool: TOOL, nowMs: Date.now(), stamp: new Date().toISOString() })
  backoffState = loaded.state
  if (opts.resetState) {
    resetStateFile(STATE_FILE, { tool: TOOL, nowMs: Date.now() })
    log(`退避状态已重置：${STATE_FILE}（healthy，不写 GitHub）—— 人工恢复用；下一轮会重新判断`)
    process.exit(0)
  }
  if (STATE_WRITES_OK && loaded.corrupt) {
    log(`[warn] 退避状态文件损坏（${loaded.corrupt.reason}）⇒ 已备份并重建为 healthy（fail-open：坏状态不该让流水线永远静默）`)
    persistBackoff()
  }
  if (STATE_WRITES_OK) {
    const d = decide(backoffState, Date.now())
    if (d.skip) {
      backoffState.lastRunAt = new Date().toISOString()
      persistBackoff()
      beat(0)
      STATE.stage = 'skipped-backoff'
      log(renderStillBroken({ attempt: backoffState.consecutiveFailures, minutesLeft: d.minutesLeft, nowIso: new Date().toISOString() }))
      emitJson(0)
      process.exit(0)
    }
  }
}
function step(name, status, ms, detail = '') {
  STATE.steps.push({ name, status, ms, detail })
  const tag = { ok: ' ok ', skip: 'skip', fail: 'FAIL', wait: 'wait' }[status] ?? status
  log(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}`)
}
function beginStage(name) {
  STATE.stage = name
  STATE.currentStage = name
  STATE.currentStageStarted = Date.now()
}
function endStage(name, detail = '') {
  step(name, 'ok', Date.now() - (STATE.currentStageStarted ?? Date.now()), detail)
  STATE.currentStage = null
}
class AutopilotError extends Error {
  constructor(exitCode, message, { waiting = false } = {}) {
    super(message)
    this.exitCode = exitCode
    this.waiting = waiting
  }
}
const fail = (code, message, extra) => { throw new AutopilotError(code, message, extra) }
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))

// ══ 子进程 ═════════════════════════════════════════════════════════════════
const redact = (text) => String(text ?? '')
  .replace(/(https?:\/\/)([^/@\s]+)@/g, '$1***@')
  .replace(/(gh[pousr]_[A-Za-z0-9]{10,})/g, '***')
function run(cmd, args, { cwd = ROOT, timeout = 10 * 60 * 1000, env = process.env } = {}) {
  const started = Date.now()
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 128 * 1024 * 1024,
    env: { ...env, GIT_TERMINAL_PROMPT: '0' },
  })
  return {
    status: typeof res.status === 'number' ? res.status : -1,
    signal: res.signal ?? null,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error ? res.error.message : null,
    ms: Date.now() - started,
    cmd: [cmd, ...args].map((a) => (String(a).includes(' ') ? JSON.stringify(a) : a)).join(' '),
  }
}
function tail(text, n = 500) {
  const lines = String(text ?? '').trim().split('\n').filter((l) => l.trim())
  return short(redact(lines.slice(-3).join(' | ')), n)
}
function mustRun(cmd, args, label, { code = 1, ...runOpts } = {}) {
  const r = run(cmd, args, runOpts)
  if (r.status !== 0) {
    const why = r.error ? `spawn error: ${r.error}` : `exit=${r.status}${r.signal ? ` signal=${r.signal}` : ''}`
    fail(code, `${label} 失败（${why}）：${tail(r.stderr || r.stdout)}`)
  }
  return r
}
function gh(args, { allowFail = false, timeout = 120 * 1000 } = {}) {
  const r = run(GH, args, { timeout })
  if (!allowFail && r.status !== 0) {
    fail(1, `gh ${args[0]}${args[1] ? ' ' + args[1] : ''} 失败（exit=${r.status}）：${tail(r.stderr || r.stdout)}`)
  }
  return r
}
function ghJson(args, opts = {}) {
  const r = gh(args, opts)
  try {
    return JSON.parse(r.stdout)
  } catch {
    fail(1, `gh ${args[0]} 返回的不是 JSON：${short(r.stdout, 200)}`)
  }
}
function git(args, { code = 3, allowFail = false, cwd = ROOT, timeout = 10 * 60 * 1000 } = {}) {
  const r = run(GIT, args, { cwd, timeout })
  if (!allowFail && r.status !== 0) fail(code, `git ${args[0]} 失败（exit=${r.status}）：${tail(r.stderr || r.stdout)}`)
  return r
}
const ghRepoArgs = () => (STATE.repo ? ['--repo', STATE.repo] : [])
const withRepo = (args) => [...args, ...ghRepoArgs()]

// ══ 临时目录 ═══════════════════════════════════════════════════════════════
function workDir() {
  if (!STATE.workDir) STATE.workDir = mkdtempSync(join(tmpdir(), 'dsh-autopilot-'))
  return STATE.workDir
}
function workFile(name) {
  const file = join(workDir(), name)
  mkdirSync(dirname(file), { recursive: true })
  return file
}
/** 只删自己建的 /tmp 目录；绝不跟随软链、绝不动用户 runtime。 */
function safeRemove(dir, allowedPrefixes) {
  if (!dir) return false
  const abs = resolve(dir)
  const tmpRoot = resolve(tmpdir()) + sep
  if (!abs.startsWith(tmpRoot)) return false
  if (!allowedPrefixes.some((p) => basename(abs).startsWith(p))) return false
  try {
    rmSync(abs, { recursive: true, force: true, maxRetries: 3 })
    return !existsSync(abs)
  } catch (err) {
    log(`[warn] 清理 ${abs} 失败：${err.message}`)
    return false
  }
}

// ══ ① 探测 ═════════════════════════════════════════════════════════════════
function probeUpstream() {
  let raw
  if (WATCH_JSON) {
    if (!existsSync(WATCH_JSON)) fail(3, `DSH_AUTOPILOT_WATCH_JSON 不存在：${WATCH_JSON}`)
    try {
      raw = JSON.parse(readFileSync(WATCH_JSON, 'utf8'))
    } catch (err) {
      fail(3, `DSH_AUTOPILOT_WATCH_JSON 不是合法 JSON：${err.message}`)
    }
    log(`[info] 探测输入来自 DSH_AUTOPILOT_WATCH_JSON（演练/回放，未执行 dsh-watch）`)
  } else {
    const out = join(tmpdir(), `dsh-autopilot-watch-${process.pid}-${Date.now()}.json`)
    const r = run(NODE, [join(ROOT, 'scripts', 'dsh-watch.mjs'), '--dry-run', '--json', out], { timeout: 3 * 60 * 1000 })
    if (!existsSync(out)) {
      fail(3, `dsh-watch 没有产出 JSON（exit=${r.status}）：${tail(r.stderr || r.stdout)}`)
    }
    try {
      raw = JSON.parse(readFileSync(out, 'utf8'))
    } catch (err) {
      fail(3, `dsh-watch 的 JSON 无法解析：${err.message}`)
    } finally {
      try { rmSync(out, { force: true }) } catch { /* ignore */ }
    }
    if (r.status !== 0) fail(3, `dsh-watch 探测失败（exit=${r.status}）：${tail(r.stderr || r.stdout)}`)
  }
  const target = raw.target ?? null
  if (target !== null && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(target))) {
    fail(3, `探测结果里的 target 不是合法版本号：${JSON.stringify(target)}`)
  }
  const kind = String(raw.kind ?? '')
  // 通道口径：dsh-watch 的 pre-release 分支会写 "best-effort"；其余（含 latest 恰好是 rc）都按 latest 处理。
  const channel = /best-effort|预发布通道/.test(kind) ? 'best-effort' : 'latest'
  return {
    floor: raw.floor ?? null,
    target,
    tags: raw.tags ?? {},
    kind: raw.kind ?? null,
    channel,
    threshold: raw.threshold ?? null,
    deadline: raw.deadline ?? null,
    breached: raw.breached ?? false,
    pubUnknown: raw.pubUnknown ?? false,
  }
}

function printPlan() {
  const { target, floor, channel } = STATE
  const branch = `auto/dsh-${target}`
  log('')
  log(`[plan] 目标 dsh ${target}（地板 ${floor}，通道 ${channel}）—— 未执行任何写操作`)
  log(`  ② 准备临时 runtime：dsh-rehearse install --version ${target}；`)
  log(`     git clone --local --shared <repo> /tmp/...；在克隆里 dsh-adapt --version ${target}（写文件只发生在克隆）`)
  log(`  ③ 只提交已跟踪、非看板文件；push ${branch}（更新时 --force-with-lease 锁到当前远端 sha）；gh pr create`)
  log(`  ④ 轮询 gh pr view --json statusCheckRollup，最多 ${opts.waitMinutes} 分钟；任一 check 失败 ⇒ 不合并`)
  log(`  ⑤ mergeable=MERGEABLE 后 gh pr merge --squash --admin（冲突即停，绝不 force）`)
  if (opts.stage1) log('  --stage1：⑤ 之后停下（不合并 release-please 版本 PR）')
  else log('  ⑥ 等/合并 release-please 版本 PR（最多 15 分钟；bot PR 无 check 时按变更范围白名单 + mergeable 例外）')
  log('  ⑦ 等 tag → 无构建运行才 gh workflow run build.yml --ref <tag> → 等 Release 资产 ≥3（最多 30 分钟）')
  log(`  ⑧ 在 ${opts.issue ? `issue #${opts.issue}` : '按 target 查找/新建的 issue'} 回帖结构化总结`)
  if (opts.requireCanary) log('  --require-canary：⑤ 之前还要求 dsh-adapt --canary 通过（需要真实 dev 壳在窗口期新启动）')
  log(`  issue 查找：${opts.issue ? `--issue #${opts.issue}` : 'open 的 dsh-upgrade / sla-breach 中按 target 词边界匹配，找不到则新建'}`)
  log('  dry-run 到此为止。')
}

// ══ 仓库 / issue / 发布状态 ════════════════════════════════════════════════
function resolveRepo() {
  const forced = opts.repo ?? process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY ?? null
  const urlRes = git(['remote', 'get-url', '--push', 'origin'], { allowFail: true, code: 3 })
  const url = urlRes.status === 0 ? urlRes.stdout.trim() : ''
  if (urlRes.status !== 0 && !forced) {
    fail(3, `解析不到远端：git remote get-url --push origin 失败，且没有 --repo / GH_REPO\n${tail(urlRes.stderr)}`)
  }
  let repo = forced
  let remoteUrl = url || null
  if (!repo && url) {
    const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url)
    if (m) repo = `${m[1]}/${m[2]}`
  }
  if (!repo) fail(3, `解析不出 owner/name：远端 URL=${JSON.stringify(url)}；用 --repo <owner/name> 指定`)
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) fail(3, `解析出的仓库名不合法：${repo}`)
  if (!remoteUrl) remoteUrl = `git@github.com:${repo}.git`
  STATE.repo = repo
  STATE.remoteUrl = remoteUrl
  log(`[info] 仓库 ${repo}；远端 ${redact(remoteUrl)}；gh=${GH}`)
}

/** 最新 Release 的正文里是否已经写了这个 dsh target，且资产 ≥3。 */
function findPublished(target) {
  let releases
  try {
    releases = ghJson(withRepo(['release', 'list', '--limit', '10', '--json', 'tagName']), { allowFail: true })
  } catch {
    return null
  }
  if (!Array.isArray(releases)) return null
  for (const rel of releases) {
    const tag = rel?.tagName
    if (!tag) continue
    const r = gh(withRepo(['release', 'view', tag, '--json', 'tagName,body,assets']), { allowFail: true })
    if (r.status !== 0) continue
    let view
    try { view = JSON.parse(r.stdout) } catch { continue }
    const assets = Array.isArray(view.assets) ? view.assets : []
    const body = String(view.body ?? '')
    const latest = /发版时 npm\s*`latest`\s*=\s*\*\*([^*\n]+)\*\*/.exec(body)?.[1]?.trim() ?? null
    const next = /`next`\s*预发布\s*=\s*([^）)\n]+)/.exec(body)?.[1]?.trim() ?? null
    if (assets.length >= 3 && (latest === target || next === target)) {
      return { tag: view.tagName ?? tag, assets: assets.map((a) => a?.name).filter(Boolean) }
    }
  }
  return null
}

/** 目标版本的词边界匹配（`0.2.1` 不能命中 `0.2.1-rc.2` / `0.2.10`）。 */
function targetPattern(target) {
  return new RegExp(`(^|[^0-9A-Za-z.-])${String(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9A-Za-z.-]|$)`)
}

function resolveIssue(target, floor) {
  if (opts.issue) {
    return { number: opts.issue, source: '--issue' }
  }
  const pattern = targetPattern(target)
  for (const label of ['dsh-upgrade', 'sla-breach']) {
    const r = gh(withRepo(['issue', 'list', '--label', label, '--state', 'open', '--json', 'number,title', '--limit', '100']), { allowFail: true })
    if (r.status !== 0) {
      log(`[warn] gh issue list --label ${label} 失败（继续）：${tail(r.stderr)}`)
      continue
    }
    let list = []
    try { list = JSON.parse(r.stdout) } catch { continue }
    const hit = list.find((i) => pattern.test(String(i?.title ?? '')))
    if (hit) {
      return { number: hit.number, source: `label ${label}` }
    }
  }
  const owner = opts.assignee ?? STATE.repo.split('/')[0]
  const body = `@${owner}（负责人；自动流水线告警）

这条 issue 由 \`scripts/dsh-release-autopilot.mjs\` 建立：检测到上游 dsh \`${target}\` 比壳地板 \`${floor}\` 新，
自动流水线已接管（适配 → PR → 合并 → 发布）。

- 失败或需要真机验收时，会在本 issue 回帖具体阶段与原因；
- 完成（或确认已发布）后也会回帖结构化总结。

<!-- dsh-autopilot-issue: target=${target} floor=${floor} -->`
  const bodyFile = workFile(`issue-${target}.md`)
  writeFileSync(bodyFile, body + '\n')
  for (const [name, desc, color] of [
    ['dsh-upgrade', '上游 dsh 新版本待适配', '1d76db'],
    ['priority:high', '高优先级：自动化告警（dsh 升级 / 版本流水线）', 'b60205'],
  ]) {
    gh(withRepo(['label', 'create', name, '--description', desc, '--color', color]), { allowFail: true })
  }
  const attempts = [
    withRepo(['issue', 'create', '--title', `[dsh-autopilot] 自动适配 dsh ${target}`, '--body-file', bodyFile,
      '--label', 'dsh-upgrade', '--label', 'priority:high', '--assignee', owner]),
    withRepo(['issue', 'create', '--title', `[dsh-autopilot] 自动适配 dsh ${target}`, '--body-file', bodyFile,
      '--label', 'dsh-upgrade', '--assignee', owner]),
    withRepo(['issue', 'create', '--title', `[dsh-autopilot] 自动适配 dsh ${target}`, '--body-file', bodyFile]),
  ]
  let last = null
  for (const args of attempts) {
    const r = gh(args, { allowFail: true })
    if (r.status === 0) {
      const num = /\/issues\/(\d+)\s*$/.exec(r.stdout.trim())?.[1]
      if (num) {
        return { number: Number(num), source: `新建（assignee ${owner}）` }
      }
    }
    last = r
  }
  fail(3, `找不到也建不了 issue：${tail(last?.stderr || last?.stdout)}`)
}

// ══ 分支 / PR ═══════════════════════════════════════════════════════════════
function findExistingPr(branch) {
  const list = ghJson(withRepo(['pr', 'list', '--state', 'all', '--head', branch,
    '--json', 'number,title,state,url,mergedAt,body', '--limit', '10']))
  if (!Array.isArray(list) || list.length === 0) return null
  return list.find((p) => p.state === 'OPEN')
    ?? list.find((p) => p.state === 'MERGED')
    ?? list[0]
}

function remoteBranchSha(branch) {
  const r = run(GIT, ['ls-remote', '--heads', STATE.remoteUrl, `refs/heads/${branch}`], { timeout: 120 * 1000 })
  if (r.status !== 0) fail(3, `git ls-remote 失败（exit=${r.status}）：${tail(r.stderr || r.stdout)}`)
  const line = r.stdout.trim().split('\n').filter(Boolean)[0]
  return line ? line.split(/\s+/)[0] : null
}

/** 本地克隆：对象库共享真实仓库（只读），再从 GitHub 远端取最新 main（工作区可能是旧分支/分离 HEAD）。 */
function prepareClone() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-autopilot-clone-'))
  const clone = run(GIT, ['clone', '--local', '--shared', ROOT, dir], { timeout: 10 * 60 * 1000 })
  if (clone.status !== 0) {
    safeRemove(dir, ['dsh-autopilot-clone-'])
    fail(3, `git clone --local --shared 失败（exit=${clone.status}）：${tail(clone.stderr || clone.stdout)}`)
  }
  STATE.cloneDir = dir
  const remoteAdd = run(GIT, ['-C', dir, 'remote', 'add', 'autopilot', STATE.remoteUrl], { timeout: 60 * 1000 })
  if (remoteAdd.status !== 0) {
    // 源仓库若恰好已有同名 remote，clone 会把它带过来 ⇒ 不硬失败，改 set-url。
    const setUrl = run(GIT, ['-C', dir, 'remote', 'set-url', 'autopilot', STATE.remoteUrl], { timeout: 60 * 1000 })
    if (setUrl.status !== 0) fail(3, `git remote add/set-url autopilot 失败：${tail(remoteAdd.stderr || setUrl.stderr)}`)
  }
  mustRun(GIT, ['-C', dir, 'fetch', '--no-tags', 'autopilot', 'main'], 'git fetch autopilot main', { code: 3, timeout: 10 * 60 * 1000 })
  mustRun(GIT, ['-C', dir, 'checkout', '-B', 'main', 'FETCH_HEAD'], 'git checkout -B main FETCH_HEAD', { code: 3 })
  const status = mustRun(GIT, ['-C', dir, 'status', '--porcelain'], 'git status（克隆）', { code: 3 })
  if (status.stdout.trim()) {
    fail(3, `克隆不是干净的（${short(status.stdout, 200)}）—— 拒绝带着未知改动适配`)
  }
  step('clone', 'ok', clone.ms + 1, `${dir}（main=FETCH_HEAD，工作区干净）`)
  return dir
}

/** 在既有分支（重跑 canary 用）上检出。 */
function checkoutExistingBranch(branch) {
  const dir = prepareClone()
  mustRun(GIT, ['-C', dir, 'fetch', '--no-tags', 'autopilot', `refs/heads/${branch}`], `git fetch ${branch}`, { code: 3 })
  mustRun(GIT, ['-C', dir, 'checkout', '-B', 'autopilot-canary', 'FETCH_HEAD'], 'git checkout 分支', { code: 3 })
  return dir
}

// ══ runtime / 适配 ═════════════════════════════════════════════════════════
function prepareRuntime(target) {
  if (opts.runtime) {
    const pkg = join(opts.runtime, 'node_modules/@deepseek-ai/dsh/package.json')
    if (!existsSync(pkg)) fail(3, `--runtime ${opts.runtime} 下没有 @deepseek-ai/dsh`)
    let version = null
    try { version = JSON.parse(readFileSync(pkg, 'utf8')).version } catch { /* below */ }
    if (version !== target) fail(3, `--runtime 装的是 ${version ?? '(读不到版本)'}，不是目标 ${target}`)
    STATE.runtimeDir = opts.runtime
    step('runtime', 'ok', 0, `复用 --runtime ${opts.runtime}（${version}）`)
    return opts.runtime
  }
  const jsonPath = workFile(`rehearse-${target}.json`)
  log(`[info] 用 dsh-rehearse install 准备临时 runtime（目标 ${target}；这不会碰真实 runtime）`)
  const r = run(NODE, [join(ROOT, 'scripts', 'dsh-rehearse.mjs'), '--scenario', 'install',
    '--version', target, '--keep', '--json', jsonPath, '--timeout', '300'], { timeout: 15 * 60 * 1000 })
  if (!existsSync(jsonPath)) {
    fail(3, `dsh-rehearse install 没有产出 JSON（exit=${r.status}）：${tail(r.stderr || r.stdout)}`)
  }
  let info
  try { info = JSON.parse(readFileSync(jsonPath, 'utf8')) } catch (err) {
    fail(3, `dsh-rehearse install 的 JSON 无法解析：${err.message}`)
  }
  if (info.tmpDir) {
    STATE.runtimeDir = info.tmpDir
    STATE.runtimeCreated = true
  }
  if (r.status !== 0 || info.ok !== true || info.installedVersion !== target || !info.tmpDir) {
    const why = info.status ? `status=${info.status}` : `exit=${r.status}`
    const detail = info.conclusion || info.error || tail(r.stderr || r.stdout)
    fail(3, `目标版本装不上（${why}，落地 ${info.installedVersion ?? '(未装上)'}，期望 ${target}）：${short(detail, 500)}`)
  }
  const pkg = join(info.tmpDir, 'node_modules/@deepseek-ai/dsh/package.json')
  let installed = null
  try { installed = JSON.parse(readFileSync(pkg, 'utf8')).version } catch { /* below */ }
  if (installed !== target) {
    fail(3, `临时 runtime 里读到的版本是 ${installed ?? '(读不到)'}，不是目标 ${target}`)
  }
  STATE.runtimeDir = info.tmpDir
  STATE.runtimeCreated = true
  const probeVerdict = String(info.probe?.verdict ?? '?').toUpperCase()
  step('runtime', 'ok', r.ms, `${info.tmpDir}（dsh ${installed}，install 探针 ${probeVerdict}）`)
  return info.tmpDir
}

function runAdapt(cloneDir, runtimeDir, target, { canary = false } = {}) {
  const args = [join(cloneDir, 'scripts', 'dsh-adapt.mjs'), '--version', target, '--runtime', runtimeDir]
  if (canary) {
    args.push('--canary', '--canary-timeout', String(opts.canaryTimeout))
    if (opts.devLog) args.push('--dev-log', opts.devLog)
    if (opts.managerLog) args.push('--manager-log', opts.managerLog)
  }
  const r = run(NODE, args, { cwd: cloneDir, timeout: 60 * 60 * 1000 })
  const text = `${r.stdout}\n${r.stderr}`
  for (const line of r.stdout.split('\n')) {
    if (/^\[( ok|skip|FAIL)\s*\]/.test(line) || line.startsWith('—— 汇总')) log(`      adapt| ${line}`)
  }
  if (r.status !== 0) {
    const why = r.error ? r.error : `exit=${r.status}${r.signal ? ` signal=${r.signal}` : ''}`
    fail(1, `dsh-adapt 失败（${why}）：${tail(text, 600)}`)
  }
  const verdict = /verdict=([A-Za-z]+)/.exec(text)?.[1]?.toUpperCase() ?? null
  const gates = Number(/全量门禁[^\n]*?(\d+)\s*套通过/.exec(text)?.[1] ?? NaN)
  return {
    verdict,
    gates: Number.isFinite(gates) ? gates : null,
    ms: r.ms,
    outputTail: r.stdout.trim().split('\n').slice(-14),
  }
}

/** porcelain v1 -z：只留已跟踪、非看板文件；未跟踪文件不提交（dsh-adapt 不产生新文件）。 */
function changedFiles(cloneDir) {
  const r = mustRun(GIT, ['-C', cloneDir, 'status', '--porcelain=v1', '-z'], 'git status --porcelain', { code: 3 })
  const fields = r.stdout.split('\0')
  const entries = []
  for (let i = 0; i < fields.length; i += 1) {
    const raw = fields[i]
    if (!raw) continue
    const code = raw.slice(0, 2)
    const path = raw.slice(3)
    const item = { code, path }
    if (/[RC]/.test(code)) {
      const orig = fields[++i]
      if (orig) item.orig = orig
    }
    entries.push(item)
  }
  const skipped = []
  const files = []
  for (const e of entries) {
    if (e.path === 'KANBAN.json') { skipped.push(`${e.path}（看板）`); continue }
    if (e.code === '??') { skipped.push(`${e.path}（未跟踪，不提交）`); continue }
    files.push(e.path)
    if (e.orig) files.push(e.orig)
  }
  if (skipped.length) log(`[info] 忽略：${skipped.join('、')}`)
  return files
}

function commitAndPush(cloneDir, target, files) {
  const branch = `auto/dsh-${target}`
  if (!/^auto\/dsh-[0-9A-Za-z._-]+$/.test(branch)) fail(1, `拒绝推送可疑分支名：${branch}`)
  mustRun(GIT, ['-C', cloneDir, 'add', '--', ...files], 'git add', { code: 1 })
  mustRun(GIT, ['-C', cloneDir, '-c', 'user.name=dsh-release-autopilot',
    '-c', 'user.email=autopilot@users.noreply.github.com',
    'commit', '-m', `fix(dsh): 适配上游 dsh ${target}（autopilot）`], 'git commit', { code: 1 })
  const remoteSha = remoteBranchSha(branch)
  const existed = remoteSha !== null
  const pushArgs = ['-C', cloneDir, 'push']
  // 只对这条自动化分支更新；锁到刚才 ls-remote 看到的 sha，远端被别人推过就失败而不是覆盖。
  if (existed) pushArgs.push(`--force-with-lease=refs/heads/${branch}:${remoteSha}`)
  pushArgs.push('autopilot', `HEAD:refs/heads/${branch}`)
  const pushed = run(GIT, pushArgs, { timeout: 10 * 60 * 1000 })
  if (pushed.status !== 0) {
    fail(1, `git push ${branch} 失败（exit=${pushed.status}）：${tail(pushed.stderr || pushed.stdout)}`)
  }
  STATE.pushedThisRun = true
  STATE.branchExisted = existed
  STATE.branch = branch
  return { branch, existed }
}

function buildPrBody(target, adapt) {
  const floor = STATE.floor
  const verdict = adapt?.verdict ?? 'UNKNOWN'
  const gates = adapt?.gates ?? '?'
  const duration = adapt?.ms ? fmtDuration(adapt.ms) : '?'
  return `## dsh 上游适配（autopilot 自动生成）

| 项 | 值 |
|---|---|
| 目标 dsh | \`${target}\` |
| 壳地板（适配前） | \`${floor}\` |
| 探针 verdict | **${verdict}** |
| 全量门禁 | ${gates} 套通过（\`dsh-adapt\` 第 7 步） |
| 适配耗时 | ${duration} |
| 触发 issue | ${STATE.issue ? `#${STATE.issue.number}` : '(未关联)'} |

> 本 PR 由 \`scripts/dsh-release-autopilot.mjs\` **自动生成并推送**：临时克隆里跑
> \`dsh-adapt --version ${target}\`（地板两份 / README / patch 夹具 / peer / 探针 / 全量门禁），
> 只提交已跟踪的非看板文件。合并后同一条流水线会继续等待 release-please 版本 PR、合并、派发
> \`build.yml\` 并核验 Release 资产。

<!-- dsh-autopilot: target=${target} verdict=${verdict} gates=${gates} floor=${floor} duration=${duration} -->
`
}

function createPr(branch, target, adapt) {
  const bodyFile = workFile(`pr-${target}.md`)
  writeFileSync(bodyFile, buildPrBody(target, adapt))
  const r = run(GH, withRepo(['pr', 'create', '--base', 'main', '--head', branch,
    '--title', `fix(dsh): 适配上游 dsh ${target}（autopilot）`, '--body-file', bodyFile]), { timeout: 3 * 60 * 1000 })
  if (r.status !== 0) {
    // 分支已推、PR 没开成 = 半截分支：只有本次新建的分支才删（既有孤儿分支不替人做主）。
    // 删之前再查一次 PR：并发跑时另一实例可能刚建好 PR，删分支会把它的 PR 弄断。
    if (STATE.pushedThisRun && !STATE.branchExisted) {
      let raced = null
      try { raced = findExistingPr(branch) } catch { /* 查询失败按无 PR 处理 */ }
      if (raced) {
        log(`[warn] PR 创建失败，但已存在 PR #${raced.number}（并发实例？）—— 保留分支 ${branch}`)
      } else {
        const del = run(GIT, ['push', STATE.remoteUrl, '--delete', `refs/heads/${branch}`], { timeout: 120 * 1000 })
        log(`[warn] PR 创建失败，已尝试删除本次新建的分支 ${branch}（${del.status === 0 ? '成功' : '失败：' + tail(del.stderr)}）`)
      }
    }
    fail(1, `gh pr create 失败（exit=${r.status}）：${tail(r.stderr || r.stdout)}`)
  }
  const url = /https?:\/\/\S+\/pull\/\d+/.exec(r.stdout)?.[0] ?? ''
  const number = /\/pull\/(\d+)/.exec(url)?.[1]
  if (!number) fail(1, `gh pr create 成功但没有解析出 PR 号：${short(r.stdout, 200)}`)
  return { number: Number(number), url, state: 'OPEN', title: `fix(dsh): 适配上游 dsh ${target}（autopilot）` }
}

// ══ CI / 合并 ═══════════════════════════════════════════════════════════════
function checkBuckets(rollup) {
  const out = []
  for (const c of rollup ?? []) {
    const name = c?.name ?? c?.context ?? 'check'
    const status = String(c?.status ?? '').toUpperCase()
    const state = String(c?.state ?? c?.conclusion ?? (status === 'COMPLETED' ? '' : status)).toUpperCase()
    let bucket
    if (status && status !== 'COMPLETED') bucket = 'pending'
    else if (['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(state)) bucket = 'ok'
    else if (['FAILURE', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE', 'ERROR'].includes(state)) bucket = 'fail'
    else bucket = 'pending' // 空/未知一律不当绿（"没有判断 = 没有验证"）
    out.push({ name, bucket, state: state || status || 'UNKNOWN' })
  }
  return out
}

function fetchPr(number) {
  const r = gh(withRepo(['pr', 'view', String(number), '--json',
    'number,title,state,mergeable,mergeStateStatus,statusCheckRollup,url,headRefName,files,body']), { allowFail: true })
  if (r.status !== 0) fail(1, `gh pr view #${number} 失败：${tail(r.stderr || r.stdout)}`)
  try { return JSON.parse(r.stdout) } catch { fail(1, `gh pr view #${number} 返回的不是 JSON`) }
}

async function waitForAdaptPr(pr) {
  const deadline = Date.now() + opts.waitMinutes * 60 * 1000
  let last = null
  for (;;) {
    const info = fetchPr(pr.number)
    last = info
    if (info.state === 'MERGED') {
      step('④ 等 CI', 'skip', 0, `PR #${pr.number} 已是 MERGED（重跑）`)
      return info
    }
    if (String(info.mergeable).toUpperCase() === 'CONFLICTING' || String(info.mergeStateStatus).toUpperCase() === 'DIRTY') {
      fail(1, `PR #${pr.number} 冲突（mergeable=${info.mergeable}, mergeStateStatus=${info.mergeStateStatus}）—— 停下，不 force、不合并`)
    }
    const checks = checkBuckets(info.statusCheckRollup)
    const failed = checks.filter((c) => c.bucket === 'fail')
    const pending = checks.filter((c) => c.bucket === 'pending')
    if (failed.length) {
      fail(1, `CI 红：${failed.map((c) => `${c.name}=${c.state}`).join(', ')}（PR #${pr.number}）—— 不合并`)
    }
    if (checks.length > 0 && pending.length === 0) {
      step('④ 等 CI', 'ok', 0, `${checks.length} 项全绿/非失败（${checks.map((c) => `${c.name}=${c.state}`).join(', ')}）`)
      return info
    }
    if (Date.now() >= deadline) {
      if (checks.length === 0) {
        fail(1, `${opts.waitMinutes} 分钟内 PR #${pr.number} 没有任何 CI 上报（statusCheckRollup 为空）—— 不合并`)
      }
      fail(1, `${opts.waitMinutes} 分钟内 CI 未完成：${pending.map((c) => `${c.name}=${c.state}`).join(', ')} —— 不合并`)
    }
    log(`[wait] PR #${pr.number}：${checks.length ? `${checks.length} 项，${pending.length} 项未完成` : '等待 CI 上报'}（${opts.pollSeconds}s 后重试）`)
    await sleep(opts.pollSeconds * 1000)
  }
}

async function waitMergeable(pr, maxMs, label) {
  const deadline = Date.now() + maxMs
  for (;;) {
    const info = fetchPr(pr.number)
    if (info.state === 'MERGED') return info
    const mergeable = String(info.mergeable ?? '').toUpperCase()
    const mergeState = String(info.mergeStateStatus ?? '').toUpperCase()
    if (mergeable === 'CONFLICTING' || mergeState === 'DIRTY') {
      fail(1, `${label} #${pr.number} 冲突（mergeable=${mergeable}, mergeStateStatus=${mergeState}）—— 停下，不 force`)
    }
    if (mergeable === 'MERGEABLE') return info
    if (Date.now() >= deadline) {
      fail(1, `${label} #${pr.number} 的 mergeable 一直是 ${mergeable || 'UNKNOWN'} —— 不合并`)
    }
    log(`[wait] ${label} #${pr.number} mergeable=${mergeable || 'UNKNOWN'}（${opts.pollSeconds}s 后重试）`)
    await sleep(opts.pollSeconds * 1000)
  }
}

async function mergePr(pr, label) {
  const r = run(GH, withRepo(['pr', 'merge', String(pr.number), '--squash', '--admin']), { timeout: 3 * 60 * 1000 })
  if (r.status !== 0) fail(1, `${label} #${pr.number} 合并失败（exit=${r.status}）：${tail(r.stderr || r.stdout)}`)
  // 合并成功也要复核状态：gh 退出 0 不等于服务端一定 MERGED（排队/权限边缘）。
  const deadline = Date.now() + 60 * 1000
  for (;;) {
    const info = fetchPr(pr.number)
    if (String(info.state).toUpperCase() === 'MERGED') return info
    if (Date.now() >= deadline) fail(1, `${label} #${pr.number} 合并后状态仍是 ${info.state} —— 视为未合并`)
    await sleep(3 * 1000)
  }
}

// ══ ⑤ 之前的 canary（可选安全阀）═══════════════════════════════════════════
function canaryPrecheck(target) {
  if (!opts.requireCanary) {
    return '跳过（未加 --require-canary；默认关：需要 dev 壳在窗口期内新启动）'
  }
  if (!opts.devLog || !opts.managerLog) {
    STATE.waitingForHuman = true
    fail(3, '--require-canary 需要 --dev-log 与 --manager-log 指向真实 dev 壳的两个日志（'
      + 'session 日志出 chrome/client-ready，<runtime>/manager.log 出 preinstalled bundles）—— 等真机验收', { waiting: true })
  }
  const missing = [[opts.devLog, '--dev-log'], [opts.managerLog, '--manager-log']]
    .filter(([p]) => !existsSync(p)).map(([p, flag]) => `${flag}=${p}`)
  if (missing.length) {
    STATE.waitingForHuman = true
    fail(3, `找不到 dev 壳日志：${missing.join('；')} —— 等真机验收（需要 dev 壳在检查窗口内新启动）`, { waiting: true })
  }
  const dir = STATE.cloneDir ?? checkoutExistingBranch(STATE.branch)
  const runtime = STATE.runtimeDir ?? prepareRuntime(target)
  let adapt
  try {
    adapt = runAdapt(dir, runtime, target, { canary: true })
  } catch (err) {
    STATE.waitingForHuman = true
    fail(3, `dsh-adapt --canary 未通过（等真机验收）：${err.message}`, { waiting: true })
  }
  return `dsh-adapt --canary 通过（verdict=${adapt.verdict ?? '?'}）`
}

// ══ ⑥ release-please 版本 PR ════════════════════════════════════════════════
function findReleasePr() {
  const list = ghJson(withRepo(['pr', 'list', '--state', 'open', '--json',
    'number,title,headRefName,mergeable,statusCheckRollup,url', '--limit', '30']))
  if (!Array.isArray(list)) return null
  return list.find((p) => /^chore\(main\):\s*release\s+\d+\.\d+\.\d+$/.test(String(p.title ?? ''))) ?? null
}

async function waitReleasePr() {
  const deadline = Date.now() + 15 * 60 * 1000
  for (;;) {
    const pr = findReleasePr()
    if (pr) return pr
    if (Date.now() >= deadline) {
      fail(1, '15 分钟内没等到 release-please 的版本 PR（标题 chore(main): release X.Y.Z）—— 停在 ⑥，未合并')
    }
    log(`[wait] 等 release-please 版本 PR（${opts.pollSeconds}s 后重试；最多 15 分钟）`)
    await sleep(opts.pollSeconds * 1000)
  }
}

const RELEASE_PR_ALLOWED_FILES = new Set([
  'package.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'CHANGELOG.md',
  '.release-please-manifest.json',
])

function verifyReleasePrScope(info) {
  const head = String(info.headRefName ?? '')
  if (!head.startsWith('release-please--branches--')) {
    fail(1, `版本 PR #${info.number} 的 head 是 ${head || '(空)'}，不是 release-please 分支 —— 拒绝自动合并`)
  }
  const files = Array.isArray(info.files) ? info.files.map((f) => f?.path).filter(Boolean) : []
  // gh 的 files 字段偶尔滞后：返回空不立刻判失败（否则刚创建就合并会被误拒），由调用方重试；
  // 到截止时间仍为空才判失败（见 mergeReleasePr）。
  if (files.length === 0) return null
  const bad = files.filter((p) => !RELEASE_PR_ALLOWED_FILES.has(p) && p !== 'KANBAN.json')
  if (bad.length) {
    fail(1, `版本 PR #${info.number} 超出 release-please 写域：${bad.join(', ')} —— 拒绝自动合并`)
  }
  return files
}

async function mergeReleasePr() {
  const pr = await waitReleasePr()
  STATE.releasePr = pr
  const titleVersion = /^chore\(main\):\s*release\s+(\d+\.\d+\.\d+)$/.exec(String(pr.title))?.[1] ?? null
  if (!titleVersion) fail(1, `版本 PR #${pr.number} 标题解析不出 X.Y.Z：${pr.title}`)
  step('release-pr', 'ok', 0, `#${pr.number} chore(main): release ${titleVersion} — ${pr.url ?? ''}`)

  const maxWaitMs = 15 * 60 * 1000
  const deadline = Date.now() + maxWaitMs
  let noChecksSince = null
  let mergedInfo = null
  let lastScope = null
  for (;;) {
    const info = fetchPr(pr.number)
    const mergeable = String(info.mergeable ?? '').toUpperCase()
    const mergeState = String(info.mergeStateStatus ?? '').toUpperCase()
    if (mergeable === 'CONFLICTING' || mergeState === 'DIRTY') {
      fail(1, `版本 PR #${pr.number} 冲突（mergeable=${mergeable}, mergeStateStatus=${mergeState}）—— 停下，不 force`)
    }
    const checks = checkBuckets(info.statusCheckRollup)
    const failed = checks.filter((c) => c.bucket === 'fail')
    const pending = checks.filter((c) => c.bucket === 'pending')
    if (failed.length) {
      fail(1, `版本 PR #${pr.number} 有失败的 check：${failed.map((c) => `${c.name}=${c.state}`).join(', ')} —— 不合并`)
    }
    if (checks.length > 0 && pending.length === 0 && mergeable === 'MERGEABLE') {
      step('release-checks', 'ok', 0, `${checks.length} 项 check 全绿（${checks.map((c) => `${c.name}=${c.state}`).join(', ')}）`)
      mergedInfo = info
      break
    }
    if (checks.length === 0 && mergeable === 'MERGEABLE') {
      // bot PR（GITHUB_TOKEN 创建）结构上不跑 workflow ⇒ checks 恒空。这是 README/CONTRIBUTING 记录的例外，
      // 不能因此把版本 PR 永远卡死；但必须用「变更范围白名单 + head 分支 + mergeable」补上判断。
      lastScope = verifyReleasePrScope(info)
      if (lastScope) {
        noChecksSince ??= Date.now()
      }
      const settleMs = Math.max(1000, opts.pollSeconds * 2000)
      if (lastScope && Date.now() - noChecksSince >= settleMs) {
        if (!STATE.releasePrNoCheckException) {
          STATE.releasePrNoCheckException = true
          log('[info] 版本 PR 没有任何 check（release-please 的 bot PR 在 GitHub 上恒为 action_required）'
            + '—— 按文档登记的例外合并：mergeable=MERGEABLE + 变更文件全在 release-please 写域')
        }
        mergedInfo = info
        break
      }
    }
    if (Date.now() >= deadline) {
      if (checks.length === 0 && !lastScope) {
        fail(1, `15 分钟内版本 PR #${pr.number} 没有返回变更文件 —— 无法确认写域，拒绝自动合并`)
      }
      if (checks.length === 0) fail(1, `15 分钟内版本 PR #${pr.number} 的 mergeable 仍是 ${mergeable || 'UNKNOWN'} —— 不合并`)
      fail(1, `15 分钟内版本 PR #${pr.number} 的 check 未完成：${pending.map((c) => `${c.name}=${c.state}`).join(', ')} —— 不合并`)
    }
    await sleep(opts.pollSeconds * 1000)
  }
  const merged = await mergePr({ number: pr.number }, '版本 PR')
  STATE.releaseVersion = titleVersion
  step('release-merge', 'ok', 0, `版本 PR #${pr.number} 已合并（${titleVersion}${STATE.releasePrNoCheckException ? '；按 bot PR 无 check 例外' : '；checks 绿'}）`)
  return { pr, version: titleVersion, info: merged }
}

// ══ ⑦ 派发构建 + 等资产 ═════════════════════════════════════════════════════
async function waitForTag(version) {
  const tag = `v${version}`
  const deadline = Date.now() + 10 * 60 * 1000
  for (;;) {
    const rel = gh(withRepo(['release', 'list', '--limit', '10', '--json', 'tagName']), { allowFail: true })
    if (rel.status === 0) {
      let list = []
      try { list = JSON.parse(rel.stdout) } catch { /* ignore */ }
      if (Array.isArray(list) && list.some((r) => r?.tagName === tag)) return tag
    }
    if (Date.now() >= deadline) fail(1, `10 分钟内没等到 Release/tag ${tag} —— 停在 ⑦，未派发构建`)
    log(`[wait] 等 release-please 打出 ${tag}（${opts.pollSeconds}s 后重试）`)
    await sleep(opts.pollSeconds * 1000)
  }
}

function buildRunCount(tag) {
  const r = gh(['api', `repos/${STATE.repo}/actions/workflows/build.yml/runs?branch=${encodeURIComponent(tag)}&per_page=1`], { allowFail: true })
  if (r.status !== 0) {
    log(`[warn] 查询 ${tag} 的构建运行失败（按 0 处理，可能重复派发）：${tail(r.stderr)}`)
    return null
  }
  try { return Number(JSON.parse(r.stdout)?.total_count ?? 0) } catch { return null }
}

async function releaseAssets(tag) {
  const deadline = Date.now() + 30 * 60 * 1000
  let lastCount = 0
  for (;;) {
    const r = gh(withRepo(['release', 'view', tag, '--json', 'tagName,assets']), { allowFail: true })
    if (r.status === 0) {
      try {
        const view = JSON.parse(r.stdout)
        const assets = Array.isArray(view.assets) ? view.assets : []
        lastCount = assets.length
        if (assets.length >= 3) return assets.map((a) => a?.name).filter(Boolean)
      } catch { /* keep polling */ }
    }
    if (Date.now() >= deadline) {
      fail(1, `30 分钟内 ${tag} 的 Release 资产仍 <3（当前 ${lastCount}）—— 停在 ⑦，未完成发布；已派发的构建请到 Actions 查看`)
    }
    log(`[wait] ${tag} 资产 ${lastCount}/3（${opts.pollSeconds}s 后重试；最多 30 分钟）`)
    await sleep(opts.pollSeconds * 1000)
  }
}

// ══ issue 回帖 ═════════════════════════════════════════════════════════════
function commentIssue(body) {
  if (!STATE.issue?.number) return false
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 16)
  const marked = `${body.trimEnd()}\n\n<!-- dsh-autopilot-comment: ${digest} -->\n`
  // 同内容不重复刷屏（重跑/重复失败时）。读不到评论就照发，不因查询失败丢总结。
  const view = gh(withRepo(['issue', 'view', String(STATE.issue.number), '--json', 'comments']), { allowFail: true })
  if (view.status === 0) {
    try {
      const comments = JSON.parse(view.stdout)?.comments ?? []
      if (comments.some((c) => String(c?.body ?? '').includes(`dsh-autopilot-comment: ${digest}`))) {
        log(`[info] issue #${STATE.issue.number} 已有同内容评论，跳过`)
        return true
      }
    } catch { /* ignore */ }
  }
  const file = workFile(`comment-${digest}.md`)
  writeFileSync(file, marked)
  const r = gh(withRepo(['issue', 'comment', String(STATE.issue.number), '--body-file', file]), { allowFail: true })
  if (r.status !== 0) {
    log(`[warn] issue #${STATE.issue.number} 回帖失败：${tail(r.stderr || r.stdout)}`)
    return false
  }
  log(`[info] 已回帖 issue #${STATE.issue.number}`)
  return true
}

function successBody(target, { stage1 = false } = {}) {
  const pr = STATE.pr
  const rel = STATE.releasePr
  const assets = STATE.assets
  const total = Date.now() - T0
  const relLink = STATE.tag ? `https://github.com/${STATE.repo}/releases/tag/${STATE.tag}` : '—'
  return `### dsh-release-autopilot ${stage1 ? '（stage1 完成）' : '完成'}

| 项 | 值 |
|---|---|
| 目标 dsh | \`${target}\`（适配前地板 \`${STATE.floor}\`） |
| 适配耗时 | ${STATE.adapt?.ms ? fmtDuration(STATE.adapt.ms) : '复用既有 PR（本轮未重跑）'} |
| 探针 | **${STATE.adapt?.verdict ?? '（复用既有 PR）'}** |
| 全量门禁 | ${STATE.adapt?.gates ?? '?'} 套通过 |
| 适配 PR | ${pr ? `#${pr.number}（已合并）` : '—'} |
| 版本 PR | ${rel ? `#${rel.number} ${stage1 ? '（未合并，stage1）' : '（已合并）'}` : '—'} |
| 发布版本 | ${STATE.releaseVersion ? `\`${STATE.releaseVersion}\`` : '—'} |
| Release | ${relLink} |
| 资产 | ${assets.length ? `${assets.length} 个：${assets.map((a) => `\`${a}\``).join('、')}` : '—'} |
| 总耗时 | ${fmtDuration(total)} |
| 状态 | ${stage1 ? '适配 PR 已合并；版本 PR 留给人工（--stage1）' : (STATE.releaseVersion && assets.length >= 3 ? '**已合并并发布**' : '未完成')} |

${stage1 ? '`--stage1` 已停在 ⑤ 之后：适配 PR 已合并，release-please 版本 PR **未合并**。后续由人工接手：合并版本 PR（`gh pr merge <n> --squash --admin`）后派发构建（`gh workflow run build.yml --ref vX.Y.Z`）。注意：适配 PR 合并后地板已等于目标版本，dsh-watch 不会再报这个 target，所以**不要**指望重跑本脚本自动续走 ⑥–⑧。' : '流水线全自动完成：适配 PR 与 release-please 版本 PR 均已合并，构建已派发并核验资产。'}

<!-- dsh-autopilot-success: target=${target} stage1=${stage1} version=${STATE.releaseVersion ?? ''} assets=${assets.length} -->`
}

function failureBody(target, err, elapsed) {
  const done = STATE.steps.filter((s) => s.status === 'ok').map((s) => s.name)
  const waiting = err.waiting || STATE.waitingForHuman
  return `### dsh-release-autopilot 失败${waiting ? '（等真机验收）' : ''}

- **阶段**：${STATE.currentStage ?? STATE.stage}
- **原因**：${short(err.message, 1200)}
- **目标 dsh**：\`${target}\`（地板 \`${STATE.floor}\`）
- **已完成**：${done.length ? done.join(' → ') : '（无）'}
- **PR**：${STATE.pr ? `#${STATE.pr.number}（${STATE.pr.url ?? ''}，${String(STATE.pr.state).toUpperCase() === 'MERGED' ? '已合并' : '保持打开、未合并'}）` : '尚未创建'}
- **耗时**：${fmtDuration(elapsed)}
${waiting ? '\n> 需要人在窗口期内启动 dev 壳并提供两个日志，再重跑；PR 不会被合并。\n' : ''}
${err instanceof AutopilotError && err.exitCode === 3 ? '> 前置不满足（exit 3）：修好前置后重跑；已推的 `auto/` 分支/PR 会被复用。\n' : '> 修复后重跑同 target 会复用既有分支/PR；冲突或 CI 红时不会 force、不会合并。\n'}

<!-- dsh-autopilot-failure: target=${target} stage=${short(STATE.currentStage ?? STATE.stage, 80)} -->`
}

// ══ 主流程 ═════════════════════════════════════════════════════════════════
// ══ ⑥–⑧ 可复用收尾（含「停摆版本 PR」兜底）════════════════════════════════
/** ⑦：等 tag → 无构建运行才派发 build.yml → 等 Release 资产 ≥3。flow 与兜底路径共用。 */
async function shipTag(version) {
  beginStage('⑦ 发版')
  const tag = await waitForTag(version)
  STATE.tag = tag
  const runs = buildRunCount(tag)
  if (runs === null) {
    fail(1, `无法确认 ${tag} 是否已有构建运行（gh api 失败）—— 不派发，避免重复派发取消在跑的构建；修复权限/网络后重跑`)
  }
  if (runs === 0) {
    mustRun(GH, withRepo(['workflow', 'run', 'build.yml', '--ref', tag]), `gh workflow run build.yml --ref ${tag}`, { code: 1 })
    step('dispatch', 'ok', 0, `已派发 build.yml @ ${tag}`)
  } else {
    step('dispatch', 'skip', 0, `${tag} 已有 ${runs ?? '?'} 次构建运行（不重复派发，避免 cancel-in-progress 取消在跑的构建）`)
  }
  const assets = await releaseAssets(tag)
  STATE.assets = assets
  endStage('⑦ 发版', `${tag} 资产 ${assets.length} 个：${assets.join(', ')}`)
  return tag
}

/**
 * 无新版 / 预发布跳过时，收尾「停摆的 release-please 版本 PR」（见头注释同名段）。
 * 返回是否真的续走了一次发布；查询失败按无操作处理（不让一次 gh 抖动把无新版轮次记成失败）。
 */
async function resumeStrandedRelease(reason) {
  if (!opts.releaseResume) {
    step('⑥′ 停摆版本 PR', 'skip', 0, `${reason}；--no-release-resume：不做兜底`)
    return false
  }
  let pr
  try {
    resolveRepo()
    pr = findReleasePr()
  } catch (err) {
    log(`[warn] 查询停摆版本 PR 失败（本轮按无操作处理，不记失败）：${short(err.message, 300)}`)
    return false
  }
  if (!pr) {
    step('⑥′ 停摆版本 PR', 'skip', 0, `${reason}；没有 open 的 release-please 版本 PR`)
    return false
  }
  beginStage('⑥′ 停摆版本 PR')
  log(`[info] 本轮没有可自动适配的目标（${reason}），但发现 open 的版本 PR #${pr.number}「${pr.title}」—— 续走 ⑥–⑧`)
  const release = await mergeReleasePr()
  endStage('⑥′ 停摆版本 PR', `#${release.pr.number} → ${release.version}`)
  await shipTag(release.version)
  STATE.resumed = {
    reason,
    pr: release.pr.number,
    version: release.version,
    tag: STATE.tag,
    assets: STATE.assets,
  }
  STATE.stage = 'release-resumed'
  return true
}

/** dry-run：只读地报告「如果有停摆版本 PR，会做什么」。 */
function printResumePlan(reason) {
  let pr = null
  try { resolveRepo(); pr = findReleasePr() } catch (err) { log(`[warn] 查询停摆版本 PR 失败：${short(err.message, 200)}`) }
  log('')
  if (!pr) {
    log(`[plan] ${reason}；没有停摆的 release-please 版本 PR —— 无操作，exit 0`)
    return
  }
  log(`[plan] ${reason}；发现停摆的版本 PR #${pr.number}「${pr.title}」—— 会合并它 → 等 tag → 无构建运行才派发`
    + ' build.yml → 等 Release 资产 ≥3（dry-run 不执行任何写操作）')
}

async function flow() {
  // ① 探测
  beginStage('① 探测')
  const probe = probeUpstream()
  STATE.probe = probe
  STATE.floor = probe.floor
  STATE.target = probe.target
  STATE.channel = probe.channel
  if (!probe.target) {
    step('① 探测', 'skip', Date.now() - STATE.currentStageStarted,
      `地板 ${probe.floor}；latest=${probe.tags?.latest ?? '—'} next=${probe.tags?.next ?? '—'} alpha=${probe.tags?.alpha ?? '—'}`)
    log('')
    log('无需适配（当前无新版）—— 地板已不低于 npm 任何通道，未开单、未推分支。')
    STATE.stage = 'no-update'
    STATE.currentStage = null
    if (opts.dryRun) {
      printResumePlan('本轮无新版')
      return 0
    }
    await resumeStrandedRelease('本轮无新版')
    return 0
  }
  step('① 探测', 'ok', Date.now() - STATE.currentStageStarted,
    `target=${probe.target}，地板=${probe.floor}，通道=${probe.channel}${probe.breached ? '（SLA 已超时）' : ''}`)
  STATE.currentStage = null

  if (opts.dryRun) {
    printPlan()
    STATE.stage = 'dry-run'
    return 0
  }

  if (probe.channel === 'best-effort') {
    step('② 适配', 'skip', 0, `预发布目标 ${probe.target}：按方案决策 ③C 只开 issue、不自动适配（安装路径只装 max(地板, latest)）`)
    log(`预发布通道目标 ${probe.target}：不自动适配（决策 ③C）。issue 由 dsh-watch 维护，本脚本不推分支、不开 PR。`)
    STATE.stage = 'pre-release-skip'
    STATE.currentStage = null
    // 预发布通道挡住的是「适配」，不是「发布」：已合并提交留下的版本 PR 仍应发出。
    await resumeStrandedRelease('预发布通道目标不自动适配')
    return 0
  }

  // 仓库 / 已发布 / issue
  beginStage('仓库解析')
  resolveRepo()
  endStage('仓库解析', STATE.repo)

  const published = findPublished(probe.target)
  if (published) {
    step('已发布', 'skip', 0, `${published.tag} 资产 ${published.assets.length} 个，正文含 dsh ${probe.target}`)
    log(`已发布：${published.tag}（资产 ${published.assets.length} 个，正文记录 dsh ${probe.target}）—— 无需适配，exit 0。`)
    STATE.tag = published.tag
    STATE.assets = published.assets
    STATE.stage = 'already-published'
    return 0
  }

  beginStage('issue')
  STATE.issue = resolveIssue(probe.target, probe.floor)
  flushPendingNotification()
  endStage('issue', `#${STATE.issue.number}（${STATE.issue.source}）`)

  // 既有 PR（幂等）
  beginStage('既有 PR')
  const branch = `auto/dsh-${probe.target}`
  STATE.branch = branch
  const existing = findExistingPr(branch)
  endStage('既有 PR', existing ? `#${existing.number} state=${existing.state}` : '无（将适配）')

  if (existing && String(existing.state).toUpperCase() === 'OPEN') {
    STATE.pr = { number: existing.number, url: existing.url, state: 'OPEN' }
    const marker = /<!-- dsh-autopilot: ([^>]*)-->/.exec(String(existing.body ?? ''))?.[1] ?? ''
    const kv = Object.fromEntries((marker.match(/([a-z]+)=(\S+)/g) ?? []).map((x) => x.split('=')))
    STATE.adapt = {
      verdict: kv.verdict ?? null,
      gates: kv.gates ? Number(kv.gates) : null,
      ms: null,
      reused: true,
    }
    step('② 适配', 'skip', 0, `复用既有 PR #${existing.number}（分支 ${branch}；跳过克隆/适配/推送）`)
    step('③ 推送 + PR', 'skip', 0, `复用 #${existing.number}`)
  } else if (existing && String(existing.state).toUpperCase() === 'MERGED') {
    STATE.pr = { number: existing.number, url: existing.url, state: 'MERGED' }
    const marker = /<!-- dsh-autopilot: ([^>]*)-->/.exec(String(existing.body ?? ''))?.[1] ?? ''
    const kv = Object.fromEntries((marker.match(/([a-z]+)=(\S+)/g) ?? []).map((x) => x.split('=')))
    STATE.adapt = { verdict: kv.verdict ?? null, gates: kv.gates ? Number(kv.gates) : null, ms: null, reused: true }
    step('② 适配', 'skip', 0, `已有 MERGED PR #${existing.number}（${branch}）—— 直接从 ⑥ 续走发布链`)
    step('③ 推送 + PR', 'skip', 0, `复用已合并 #${existing.number}`)
  } else {
    // ② 适配：克隆 → runtime → dsh-adapt
    beginStage('② 适配')
    const cloneDir = prepareClone()
    const runtimeDir = prepareRuntime(probe.target)
    log(`[info] 在克隆里跑 dsh-adapt --version ${probe.target}（完整门禁，可能需要几分钟）`)
    const adapt = runAdapt(cloneDir, runtimeDir, probe.target)
    STATE.adapt = adapt
    const files = changedFiles(cloneDir)
    if (files.length === 0) fail(1, 'dsh-adapt 成功但克隆里没有任何已跟踪文件变更 —— 拒绝推空分支')
    log(`[info] 适配改动 ${files.length} 个已跟踪文件：${files.join(', ')}`)
    endStage('② 适配', `${fmtDuration(adapt.ms)}；探针 ${adapt.verdict ?? '?'}；${adapt.gates ?? '?'} 套门禁；${files.length} 个文件`)

    // ③ 推送 + PR
    beginStage('③ 推送 + PR')
    commitAndPush(cloneDir, probe.target, files)
    const pr = createPr(branch, probe.target, adapt)
    STATE.pr = pr
    endStage('③ 推送 + PR', `#${pr.number} ${pr.url ?? ''}（分支 ${branch}）`)
  }

  // ④ 等 CI
  beginStage('④ 等 CI')
  const ciInfo = await waitForAdaptPr(STATE.pr)
  const alreadyMerged = String(ciInfo.state).toUpperCase() === 'MERGED'
  STATE.currentStage = null

  // ⑤ 之前：可选 canary（只对还要合并的 PR 有意义；已合并的 PR 无处可挡）
  if (!alreadyMerged) {
    beginStage('canary')
    const canaryDetail = canaryPrecheck(probe.target)
    endStage('canary', canaryDetail)
  } else {
    step('canary', 'skip', 0, '适配 PR 已合并，跳过 canary')
  }

  // ⑤ 合并适配 PR
  beginStage('⑤ 合并适配 PR')
  if (!alreadyMerged) {
    // 方案要求「git fetch + 确认 mergeable」。有克隆就刷新一次远端 main（失败只告警：mergeable 以 gh 为准）；
    // 复用既有 PR 时没有克隆，明确打印「以 gh 为准」而不是假装 fetch 过。
    if (STATE.cloneDir) {
      const fetched = run(GIT, ['-C', STATE.cloneDir, 'fetch', '--no-tags', 'autopilot', 'main'], { timeout: 10 * 60 * 1000 })
      if (fetched.status !== 0) log(`[warn] 合并前 git fetch 失败（继续以 gh mergeable 为准）：${tail(fetched.stderr || fetched.stdout)}`)
    } else {
      log('[info] 复用既有 PR：没有本地克隆，mergeable 直接以 gh pr view 为准')
    }
    await waitMergeable(STATE.pr, Math.max(120 * 1000, opts.pollSeconds * 6 * 1000), '适配 PR')
    const merged = await mergePr(STATE.pr, '适配 PR')
    STATE.pr.state = 'MERGED'
    endStage('⑤ 合并适配 PR', `#${STATE.pr.number} squash --admin；state=${merged.state}`)
  } else {
    step('⑤ 合并适配 PR', 'skip', 0, `#${STATE.pr.number} 已由上一轮/外部合并，跳过 merge`)
    STATE.currentStage = null
  }

  if (opts.stage1) {
    step('⑥–⑧', 'skip', 0, '--stage1：停在 ⑤ 之后（版本 PR 留给人工）')
    STATE.stage = 'stage1'
    commentIssue(successBody(probe.target, { stage1: true }))
    return 0
  }

  // ⑥ 版本 PR
  beginStage('⑥ 版本 PR')
  const release = await mergeReleasePr()
  endStage('⑥ 版本 PR', `#${release.pr.number} → ${release.version}`)

  // ⑦ 派发构建 + 等资产（与兜底路径共用 shipTag，避免两处漂移）
  await shipTag(release.version)

  // ⑧ 收尾
  beginStage('⑧ 收尾')
  const ok = commentIssue(successBody(probe.target))
  if (!ok) fail(1, `issue #${STATE.issue.number} 的完成总结回帖失败`)
  endStage('⑧ 收尾', `issue #${STATE.issue.number} 已回帖`)
  STATE.stage = 'done'
  return 0
}

// ══ 结果 / 清理 / 退出 ═════════════════════════════════════════════════════
function resultJson(exitCode) {
  return {
    tool: 'dsh-release-autopilot',
    ok: exitCode === 0,
    exitCode,
    stage: STATE.stage,
    target: STATE.target,
    floor: STATE.floor,
    channel: STATE.channel,
    repo: STATE.repo,
    issue: STATE.issue?.number ?? null,
    branch: STATE.branch,
    pr: STATE.pr ? { number: STATE.pr.number, url: STATE.pr.url ?? null, state: STATE.pr.state ?? null } : null,
    adapt: STATE.adapt,
    releasePr: STATE.releasePr ? { number: STATE.releasePr.number, title: STATE.releasePr.title } : null,
    releaseVersion: STATE.releaseVersion,
    resumed: STATE.resumed,
    tag: STATE.tag,
    assets: STATE.assets,
    published: STATE.stage === 'already-published' || Boolean(STATE.releaseVersion && STATE.assets.length >= 3),
    stage1: opts.stage1,
    dryRun: opts.dryRun,
    requireCanary: opts.requireCanary,
    releasePrNoCheckException: STATE.releasePrNoCheckException,
    startedAt: STATE.startedAt,
    finishedAt: new Date().toISOString(),
    totalMs: Date.now() - T0,
    steps: STATE.steps.map((s) => ({ name: s.name, status: s.status, ms: s.ms, detail: s.detail })),
    error: STATE.error,
  }
}

function printSummary(exitCode) {
  log('')
  log('—— 汇总 ——')
  for (const s of STATE.steps) {
    const icon = s.status === 'ok' ? '✓' : s.status === 'skip' ? '·' : s.status === 'fail' ? '✗' : '⏳'
    log(`  ${icon} ${s.name}${s.detail ? `：${s.detail}` : ''}${s.ms ? `（${fmtDuration(s.ms)}）` : ''}`)
  }
  log(`  总耗时 ${fmtDuration(Date.now() - T0)}；退出码 ${exitCode}`)
  if (exitCode === 0 && STATE.stage === 'done') {
    log(`  ✅ 已合并并发布：${STATE.tag}（资产 ${STATE.assets.length} 个）`)
  }
  if (exitCode === 0 && STATE.stage === 'release-resumed') {
    log(`  ✅ 本轮无新版，但已收尾停摆版本 PR：${STATE.tag}（版本 ${STATE.releaseVersion}，资产 ${STATE.assets.length} 个）`)
  }
}

function emitJson(exitCode) {
  const text = JSON.stringify(resultJson(exitCode), null, 2) + '\n'
  if (opts.jsonFile) {
    try { writeFileSync(opts.jsonFile, text) } catch (err) { log(`[warn] 写 --json 文件失败：${err.message}`) }
  }
  if (jsonToStdout) process.stdout.write(text)
}

function cleanupAndExit(exitCode, { hard = false } = {}) {
  if (exitCode === 0) {
    if (STATE.cloneDir && safeRemove(STATE.cloneDir, ['dsh-autopilot-clone-'])) log(`[info] 已清理克隆 ${STATE.cloneDir}`)
    if (STATE.runtimeCreated && STATE.runtimeDir && safeRemove(STATE.runtimeDir, ['dsh-rehearse-'])) {
      log(`[info] 已清理临时 runtime ${STATE.runtimeDir}`)
    }
    if (STATE.workDir && safeRemove(STATE.workDir, ['dsh-autopilot-'])) log(`[info] 已清理工作目录 ${STATE.workDir}`)
  } else {
    const keep = [STATE.cloneDir, STATE.runtimeDir, STATE.workDir].filter(Boolean)
    if (keep.length) log(`  现场保留（排障用）：${keep.join('；')}`)
  }
  // 正常路径不硬退：让 Node 把 stdout（--json 时只有 JSON）写干净再退出。
  if (hard) process.exit(exitCode)
  process.exitCode = exitCode
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`\n收到 ${sig}：中断。已 push 的 auto/ 分支与 PR 保留；若中断在 ⑤（合并适配 PR）之前，重跑同一 target 会复用；`
      + '若中断在 ⑤ 之后（或用了 --stage1），地板已等于 target、dsh-watch 不会再报它，release-please 版本 PR 留在 open，需人工合并/派发。未对 main 做任何写操作。')
    beat(130)
    cleanupAndExit(130, { hard: true })
  })
}

let exitCode = 0
beginStage('start')
try {
  exitCode = await flow()
} catch (err) {
  exitCode = err instanceof AutopilotError ? err.exitCode : 1
  STATE.error = { message: short(err.stack ?? err.message, 1500), exitCode }
  const stageName = STATE.currentStage ?? STATE.stage ?? 'unknown'
  step(`${stageName}（失败）`, 'fail', Date.now() - (STATE.currentStageStarted ?? T0), short(err.message, 800))
  if (!opts.dryRun && STATE.issue?.number && STATE.target) {
    try {
      commentIssue(failureBody(STATE.target, err, Date.now() - T0))
    } catch (commentErr) {
      log(`[warn] 失败回帖也失败了：${short(commentErr.message, 300)}`)
    }
  }
  STATE.stage = 'failed'
} finally {
  printSummary(exitCode)
  emitJson(exitCode)
}
finishBackoff(exitCode)
cleanupAndExit(exitCode)
