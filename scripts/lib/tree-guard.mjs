// tree-guard —— 运行时守卫：**正在跑自动化的这棵工作树**有没有偏离 `origin/main`。
//
// 为什么需要它（事故 2026-10-24 → 10-30，五天旧代码在"线上"）：本机四个 systemd user timer 直接执行
// `$ROOT/scripts/*.mjs` —— 不是从 origin/main 导出、也不是从发布包里跑。ROOT 的工作树一旦停在旧分支，
// "线上"就在跑**五天前**的代码，而 `dsh-doctor` 每天都 FAIL、却仍推进 canary 的 `last-ok`（反向心跳
// 照常显示"新鲜"）。纪律「ROOT 必须留在 main」此前只写在文档里；本模块把它变成**可检测的机制**：
// `dsh-watch` / `dsh-release-autopilot` / `dsh-doctor` 三个入口在"解析完参数、真正干活之前"调用它。
//
// 判据**不是** `HEAD == origin/main`：
//   · 发布合并后本地 ref 落后 / 特性分支领先都是常态，逐轮比较 HEAD 与 origin/main 会造成**每轮假警报**
//     （假警报的代价是被忽略，等于没有守卫）；
//   · 真正要防的是"这棵树里的脚本 / 随包资源与 origin/main 不一致"。所以判据是**路径过滤后的差异**：
//       ① `git -C root diff --name-only HEAD <mainRef> -- <paths>` 非空 ⇒ drifted（两边脚本/资源有差异）；
//       ② `git -C root status --porcelain -- <paths>` 非空 ⇒ drifted（这些路径有未提交改动）。
//   记录层（`KANBAN.json` / `.agents/notes/**`）**不在** paths 里 ⇒ 天然豁免：看板/笔记的日常改动
//   不该把心跳挡下来。默认路径集 = `scripts`（入口本身）+ `src-tauri/resources/{manager,preinstalled}`
//   （随包发布的资源）；改 README/docs/CONTRIBUTING 不算漂移。
//
// 三态（干净 / drifted / unknown）：
//   · 干净   ⇒ drifted=false、unknown=false、reasons=[]；
//   · 漂移   ⇒ drifted=true、unknown=false、reasons 点名文件；
//   · **判断不了**（不是 git 工作树 / root 不是仓库顶层 / 解析不到 mainRef / HEAD 解析不到 /
//     git 命令失败 / PATH 里没有 git）⇒ unknown=true、drifted=false + reasons。
//     **不猜成漂移，也不静默通过**：调用方必须把 formatTreeDrift() 打出来 ——「无法判断」本身就是要人看的信息
//     （这个仓库的纪律是"没有判断 = 没有验证"，静默通过等于假绿）。
//     判断不了时 diffFiles / dirtyFiles 一律空数组：半成品判据比"不知道"更危险。
//
// 负向保证（别"顺手优化"掉）：
//   · 只读：不联网、不 fetch、不改 git 状态；git 命令带 `--no-optional-locks`，不与别的 git 进程抢 index 锁；
//   · 不做 `HEAD == origin/main` 判据（见上：会产生每轮假警报）；
//   · 不用"分支名是 main"当判据（分支名不是代码状态的证据，且游离 HEAD 没有分支名）；
//   · 不把 unknown 归并成"通过"或"漂移"；
//   · 本模块是**纯逻辑**：不 process.exit、不 console、不读 argv/env —— 是否停跑由入口的
//     `--strict-tree` / `DSH_TREE_GUARD=strict` 决定（默认行为必须与守卫上线前完全一致）；
//   · paths 传空数组 ⇒ unknown（没有判据路径时拒绝"通过"）；
//   · 不信任调用方环境里的 `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` / `GIT_OBJECT_DIRECTORY`
//     （systemd / 测试注入可能残留）：一律剔除，只认 `-C root`，避免守卫检查到另一个仓库。
//
// 判据可失败性由 `scripts/test-tree-guard.mjs` 证明：临时 git 仓库上逐条跑正例 + 负向对照
// （换 paths ⇒ 必须变干净；mainRef=HEAD ⇒ 必须变干净），证明 drifted 来自路径比较而不是恒真。

import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

/** 超过这个数量就不逐条列名（日志一行要可读；返回值里的数组仍是全量）。 */
const MAX_NAMES = 10
/** 单条 git 命令的超时：守卫在每轮心跳前跑，绝不能因为一次卡住的 git 把整轮拖死。 */
const GIT_TIMEOUT_MS = 20_000
/** 会劫持 `-C root` 语义的环境变量（见头注释"负向保证"）。 */
const HIJACKING_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']

/** 跑一条只读 git 命令；任何失败都折成 `{ ok:false, error }`，**不抛异常**（守卫不能自己把入口打崩）。 */
function runGit(root, args) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' }
  for (const key of HIJACKING_ENV) delete env[key]
  let r
  try {
    r = spawnSync('git', ['-C', root, '--no-optional-locks', '-c', 'core.quotepath=false', ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env,
    })
  } catch (e) {
    return { ok: false, stdout: '', error: `git 启动失败：${e.message}` }
  }
  if (r.error) {
    const code = r.error.code
    return {
      ok: false,
      stdout: '',
      error: code === 'ENOENT' ? 'PATH 里找不到 git 可执行文件' : String(r.error.message ?? code ?? '未知错误'),
    }
  }
  if (typeof r.status !== 'number') return { ok: false, stdout: '', error: 'git 进程没有正常退出（超时或被信号杀掉？）' }
  if (r.status !== 0) {
    const first = String(r.stderr ?? '').split('\n').map((s) => s.trim()).filter(Boolean)[0]
    return { ok: false, stdout: '', error: first ?? `git ${args[0]} 退出码 ${r.status}` }
  }
  return { ok: true, stdout: String(r.stdout ?? ''), error: null }
}

const splitLines = (text) => String(text ?? '').split('\n').map((s) => s.replace(/\r$/, '').trim()).filter(Boolean)

/**
 * `git status --porcelain` 的原始行。
 * **不要**在这里 trim 左空白：v1 格式是 `XY <path>`，工作区修改的首字符就是**空格**（`" M scripts/a"`），
 * trim 掉后 `slice(3)` 会从路径中间切 —— 实测把 `scripts/a` 打成 `cripts/a`（守卫文案点名错文件）。
 */
const porcelainLines = (text) => String(text ?? '')
  .split('\n')
  .map((s) => s.replace(/\r$/, ''))
  .filter((s) => s.trim() !== '')

/** `git status --porcelain` 的一行 ⇒ 当前文件路径（重命名取新路径）。 */
function porcelainPath(line) {
  const rest = line.length > 3 ? line.slice(3) : line.trim()
  const moved = rest.split(' -> ')
  let p = (moved.length > 1 ? moved[moved.length - 1] : rest).trim()
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) p = p.slice(1, -1)
  return p
}

const parsePorcelain = (text) => porcelainLines(text).map(porcelainPath).filter(Boolean)

const describeNames = (files) => {
  const shown = files.slice(0, MAX_NAMES)
  const rest = files.length - shown.length
  return `${shown.join('、')}${rest > 0 ? ` 等 ${files.length} 个` : ''}`
}

/** 短 sha（日志可读；比较用不到完整 sha）。 */
const shortSha = (sha) => String(sha ?? '').slice(0, 7)

/** 路径归一（符号链接/macOS 的 /tmp → /private/tmp 不能让"顶层目录 == root"误判）。 */
function samePath(a, b) {
  const norm = (p) => {
    try { return realpathSync(p) } catch { return resolvePath(p) }
  }
  return norm(a) === norm(b)
}

/**
 * 检查 `root` 这棵工作树是否偏离 `mainRef`（默认 `origin/main`）。
 *
 * @param {object} [options]
 * @param {string} options.root 工作树根目录（systemd timer 里就是 `$ROOT`）
 * @param {string} [options.mainRef='origin/main'] 基准 ref
 * @param {string[]} [options.paths] 判定路径（默认 = 入口脚本 + 随包资源）
 * @returns {{
 *   drifted: boolean, unknown: boolean,
 *   head: string|null, main: string|null, branch: string|null,
 *   diffFiles: string[], dirtyFiles: string[], reasons: string[],
 *   root: string, mainRef: string,
 * }}
 *   `root` / `mainRef` 是回显（附在返回结构里，好让 formatTreeDrift 生成可直接粘贴的修复命令）。
 */
export function checkTreeDrift({
  root,
  mainRef = 'origin/main',
  paths = ['scripts', 'src-tauri/resources/manager', 'src-tauri/resources/preinstalled'],
} = {}) {
  const result = {
    drifted: false,
    unknown: false,
    head: null,
    main: null,
    branch: null,
    diffFiles: [],
    dirtyFiles: [],
    reasons: [],
    root: root ? resolvePath(String(root)) : '',
    mainRef: String(mainRef ?? ''),
  }
  const fail = (reason) => {
    result.unknown = true
    result.drifted = false
    result.diffFiles = []
    result.dirtyFiles = []
    result.reasons.push(reason)
    return result
  }

  if (!result.root) return fail('没有给出 root（无法判断该检查哪棵工作树）')
  if (!result.mainRef) return fail('mainRef 为空（无法判断拿哪个 ref 当基准）')
  if (!Array.isArray(paths) || paths.length === 0) {
    return fail('paths 为空数组 ⇒ 没有任何判定路径，拒绝在"无判据"时当作通过')
  }

  // ① 必须是 git 工作树，且 root **就是**仓库顶层。
  //    只是"某个仓库的子目录"时不能替它下结论：那棵树该不该在 main 上，取决于它自己的顶层。
  const toplevel = runGit(result.root, ['rev-parse', '--show-toplevel'])
  if (!toplevel.ok) return fail(`不是 git 工作树（${toplevel.error}）`)
  const top = toplevel.stdout.trim()
  if (!samePath(top, result.root)) {
    return fail(`root 不是 git 仓库顶层（git 说顶层是 ${top}）⇒ 无法判断这棵树本身是否偏离 ${result.mainRef}`)
  }

  const headRev = runGit(result.root, ['rev-parse', '--verify', 'HEAD'])
  if (!headRev.ok || !headRev.stdout.trim()) {
    return fail(`解析不到 HEAD（${headRev.error ?? '空仓库？'}）⇒ 无法判断当前代码是什么`)
  }
  result.head = shortSha(headRev.stdout.trim())

  const branchRev = runGit(result.root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  // 拿不到分支名不是致命信息（游离 HEAD 会返回 `HEAD`，旧 git 可能失败）；head/main 已足以判定。
  result.branch = branchRev.ok && branchRev.stdout.trim() ? branchRev.stdout.trim() : null

  const mainRev = runGit(result.root, ['rev-parse', '--verify', '--quiet', `${result.mainRef}^{commit}`])
  if (!mainRev.ok || !mainRev.stdout.trim()) {
    return fail(`解析不到 ${result.mainRef}（${mainRev.error ?? 'ref 不存在'}）—— 可能没 \`git fetch\`、没有远端，或 ref 名写错`)
  }
  result.main = shortSha(mainRev.stdout.trim())

  // ② HEAD 与基准 ref 之间，判定路径下有没有差异（tree-to-tree，不看工作树）。
  const diff = runGit(result.root, ['diff', '--name-only', 'HEAD', result.mainRef, '--', ...paths])
  if (!diff.ok) return fail(`git diff HEAD ${result.mainRef} -- ${paths.join(' ')} 失败：${diff.error}`)
  result.diffFiles = splitLines(diff.stdout)

  // ③ 判定路径下有没有未提交改动（含未跟踪；不含 .gitignore 掉的构建产物）。
  const status = runGit(result.root, ['status', '--porcelain', '--', ...paths])
  if (!status.ok) return fail(`git status --porcelain -- ${paths.join(' ')} 失败：${status.error}`)
  result.dirtyFiles = parsePorcelain(status.stdout)

  result.drifted = result.diffFiles.length > 0 || result.dirtyFiles.length > 0
  if (result.diffFiles.length) {
    result.reasons.push(`HEAD 与 ${result.mainRef} 在脚本/随包资源上有 ${result.diffFiles.length} 个文件不同：${describeNames(result.diffFiles)}`)
  }
  if (result.dirtyFiles.length) {
    result.reasons.push(`判定路径（${paths.join('、')}）下有 ${result.dirtyFiles.length} 个未提交改动：${describeNames(result.dirtyFiles)}`)
  }
  return result
}

/**
 * 把 checkTreeDrift 的结论渲染成中文告警文案。
 * 干净 ⇒ `''`（**调用方只在非空时打印**：默认轮次的日志必须与守卫上线前一致）。
 * 漂移/无法判断 ⇒ 多行：第一行是"大声的那一行"，随后点名文件 / 原因、修复命令、
 * 以及"要停跑该怎么开"（默认只告警，不改变退出码）。
 */
export function formatTreeDrift(result) {
  const r = (result && typeof result === 'object') ? result : {}
  const root = r.root ? String(r.root) : '<ROOT>'
  const ref = r.mainRef ? String(r.mainRef) : 'origin/main'
  const head = r.head ?? '?'
  const main = r.main ?? '?'
  const branch = r.branch ?? '（未知/游离 HEAD）'
  const quotedRoot = /\s/.test(root) ? JSON.stringify(root) : root
  const fix = `git -C ${quotedRoot} switch main && git -C ${quotedRoot} merge --ff-only origin/main`
  const stop = '要停跑：给入口加 --strict-tree 或设 DSH_TREE_GUARD=strict（默认只告警、继续跑）'
  const reasons = Array.isArray(r.reasons) ? r.reasons.filter((s) => String(s).trim()) : []
  const bullets = reasons.map((s) => `   · ${s}`)

  if (r.drifted) {
    return [
      `!! tree-guard：ROOT 工作树偏离 ${ref}（HEAD=${head} ${ref}=${main} 分支=${branch}）`,
      ...bullets,
      '   ⇒ 本机 systemd timer 直接执行这棵树的 scripts/*.mjs：线上跑的不是 origin/main 的代码。',
      `   修复：${fix}`,
      `   ${stop}`,
    ].join('\n')
  }
  if (r.unknown) {
    return [
      `!! tree-guard：无法判断 ROOT 工作树是否偏离 ${ref}（HEAD=${head} ${ref}=${main} 分支=${branch}）`,
      ...(bullets.length ? bullets : ['   · 原因未知（checkTreeDrift 没有给出 reasons）']),
      '   ⇒ 不猜成漂移、也不当作通过：这轮守卫等于没生效，需要人看一眼。',
      `   排查：git -C ${quotedRoot} fetch origin && git -C ${quotedRoot} status -sb`,
      `   修复（确认这棵树该在 main 上之后）：${fix}`,
      `   ${stop}`,
    ].join('\n')
  }
  return ''
}
