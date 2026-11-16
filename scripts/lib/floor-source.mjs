// 壳地板（MIN_DSH_VERSION）真源的**唯一实现**：读取 `origin/main` 的 scripts/server-manager.mjs。
//
// 为什么单独成文件（2026-11-16）：同一份读数在两个调用点各写一遍，已经漂移过一次 ——
//   · `dsh-watch.mjs` 2026-11-16 起改用 origin/main（事故 #259：工作树漂到 feature 分支后地板落后于
//     发布状态 ⇒ 每轮把**已关闭**的跟踪单当「未适配」重新 edit，autopilot 吃同一份读数）；
//   · `dsh-sla-report.mjs` 的「当前状态」块当时仍按 HEAD/工作树读 ⇒ 同一台机器上两张表可以给出
//     两个不同的「壳地板」。现在两边共用本文件：口径只有一处，回退告警文案也只有一处。
//
// 优先级：`--floor`（演练/回放覆盖，最高；此时**不跑 git、不联网**）> origin/main（发布状态的真源）
// > 工作树文件（回退 + 一行 stderr 告警，绝不静默）。回退读数可能落后于发布状态。
// 取法：有界 fetch（20s 超时；超时/失败只跳过 fetch，不阻塞）→ `git show origin/main:<file>` → 正则。
// fetch 只更新远端跟踪 ref（FETCH_HEAD / refs/remotes/origin/main），不碰工作树与 index。
//
// 注入点：调用方传 `git`（生产 = `process.env.GIT_BIN ?? 'git'`；门禁/演练换成立即返回的桩 ——
// 与 dsh-release-autopilot / test-automation-gates 同一约定）。
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const FLOOR_REF = 'origin/main'
export const FLOOR_FILE = 'scripts/server-manager.mjs'
export const FLOOR_RE = /MIN_DSH_VERSION\s*=\s*'([^']+)'/
// 有界：心跳每 10 分钟一轮 / 报表每周一轮，一次 fetch 卡住不能把整轮拖死；
// 离线/无凭据时快速失败后走回退。
export const GIT_TIMEOUT_MS = 20_000
// 与 tree-guard 同口径：不信任调用方环境里的 GIT_DIR / GIT_WORK_TREE 等（systemd / 测试注入可能残留），
// 否则「读 origin/main」可能读的是**另一个仓库**。GIT_TERMINAL_PROMPT=0 防 fetch 卡在凭据提示上。
export const GIT_HIJACKING_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']

export const floorOf = (text) => FLOOR_RE.exec(String(text ?? ''))?.[1] ?? null

/** 跑一条只读 git 命令；任何失败都折成 {ok:false, error}，不抛（地板读不到不该把整轮打崩）。 */
export function runGit({ root, git = 'git' }, args) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' }
  for (const key of GIT_HIJACKING_ENV) delete env[key]
  let r
  try {
    r = spawnSync(git, args, { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env })
  } catch (e) {
    return { ok: false, stdout: '', error: `git 启动失败：${e.message}` }
  }
  if (r.error) {
    const code = r.error.code
    return {
      ok: false,
      stdout: '',
      error: code === 'ENOENT' ? `PATH 里找不到 git 可执行文件（GIT_BIN=${git}）` : String(r.error.message ?? code ?? '未知错误'),
    }
  }
  if (typeof r.status !== 'number') return { ok: false, stdout: '', error: 'git 进程没有正常退出（超时或被信号杀掉？）' }
  if (r.status !== 0) {
    const first = String(r.stderr ?? '').split('\n').map((s) => s.trim()).filter(Boolean)[0]
    return { ok: false, stdout: '', error: first ?? `git ${args[0]} 退出码 ${r.status}` }
  }
  return { ok: true, stdout: String(r.stdout ?? ''), error: null }
}

/** origin/main 那份（真源）。fetch 失败不阻塞：仍用本地已有的 origin/main ref 读（可能不是最新，调用方告警一行）。 */
export function readFloorFromOriginMain({ root, git = 'git' }) {
  const fetched = runGit({ root, git }, ['fetch', '--no-tags', 'origin', 'main'])
  const shown = runGit({ root, git }, ['show', `${FLOOR_REF}:${FLOOR_FILE}`])
  if (!shown.ok) {
    return { ok: false, floor: null, error: `取不到 ${FLOOR_REF}:${FLOOR_FILE}（${shown.error}）` + (fetched.ok ? '' : `；fetch 也失败（${fetched.error}）`) }
  }
  const f = floorOf(shown.stdout)
  if (!f) return { ok: false, floor: null, error: `${FLOOR_REF}:${FLOOR_FILE} 里解析不到 MIN_DSH_VERSION` }
  return { ok: true, floor: f, error: null, fetchError: fetched.ok ? null : fetched.error }
}

/** 工作树文件（回退路径；不是真源）。读不到也返回 null，由告警把原因说清楚。 */
export function readFloorFromWorktree(file) {
  try { return { floor: floorOf(readFileSync(file, 'utf8')), error: null } } catch (e) {
    return { floor: null, error: `读不到工作树文件 ${file}：${e.message}` }
  }
}

/**
 * 读壳地板（统一入口）。优先级 --floor > origin/main > 工作树（回退 + 告警，绝不静默）。
 * @param {object} o
 * @param {string} o.root          仓库根（git 命令的 cwd）
 * @param {string} [o.git]         git 可执行文件 / 桩（默认 'git'）
 * @param {string|null} [o.floorArg] `--floor` 覆盖值（最高优先级；此时不跑 git）
 * @param {string} [o.worktreeFile] 回退时读的工作树文件（默认 <root>/scripts/server-manager.mjs）
 * @param {string} [o.tool]        告警前缀里的工具名（'dsh-watch' / 'dsh-sla-report'）
 * @param {string} [o.reportHint]  回退告警末句：去哪儿看 floorSource
 * @returns {{floor: string|null, floorSource: 'arg'|'origin/main'|'worktree', warnings: string[]}}
 *          warnings 由调用方打到 stderr（**一行**一条，绝不静默）。
 */
export function resolveFloor({
  root,
  git = 'git',
  floorArg = null,
  worktreeFile = join(root, FLOOR_FILE),
  tool = 'dsh',
  reportHint = '本轮以 --json 报告的 floorSource="worktree" 为准',
}) {
  if (floorArg) {
    // --floor 是最高优先级覆盖：**不跑 git、不联网**（演练/回放要能完全离线复刻，且不能被工作树/远端影响）。
    return { floor: floorArg, floorSource: 'arg', warnings: [] }
  }
  const fromMain = readFloorFromOriginMain({ root, git })
  if (fromMain.ok) {
    const warnings = []
    if (fromMain.fetchError) {
      // 不是回退，但读数可能是旧的：说清楚，别让"真源 origin/main"读成"刚拉过最新"。
      warnings.push(`!! ${tool}：git fetch origin main 失败（${fromMain.fetchError}）—— 改用本地已有的 origin/main 读数（${fromMain.floor}），它可能不是最新；检查网络/凭据后重跑即可`)
    }
    return { floor: fromMain.floor, floorSource: FLOOR_REF, warnings }
  }
  // 回退：一行告警（真源 + 原因 + 读数），绝不静默 —— 这一读数可能落后于发布状态。
  const wt = readFloorFromWorktree(worktreeFile)
  return {
    floor: wt.floor,
    floorSource: 'worktree',
    warnings: [`!! ${tool}：地板真源回退到工作树（读 ${worktreeFile}）—— ${fromMain.error}${wt.error ? `；${wt.error}` : ''}；`
      + `读数 ${wt.floor ?? '（读不到 MIN_DSH_VERSION）'}。工作树漂到 feature 分支时这一读数会落后于发布状态（把已适配版本当未适配）；`
      + `修法：git -C ${root} fetch origin main；${reportHint}`],
  }
}

/** 人读输出里 floorSource 的渲染（三种取值各一句，绝不把回退印得跟真源一样）。 */
export function floorSourceLabel(floorSource) {
  return {
    arg: '--floor（演练覆盖）',
    [FLOOR_REF]: FLOOR_REF,
    worktree: `worktree·回退：取不到 ${FLOOR_REF}`,
  }[floorSource] ?? String(floorSource)
}
