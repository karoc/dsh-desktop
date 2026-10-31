#!/usr/bin/env node
// test-tree-guard —— `scripts/lib/tree-guard.mjs` 的门禁（可失败，含负向对照）。
//
// 为什么需要这道门禁：tree-guard 的判据是"**路径过滤后**的 ref 差异 + **路径过滤后**的未提交改动"。
// 这类判据最容易写出两种假绿，两种都曾被别处的守卫踩过：
//   ① 恒真：断言里没有"必须变干净"的对照 ⇒ 守卫永远报漂移、或永远不报，测试照样绿；
//   ② 由被测物派生：期望值从被测函数的输出里取 ⇒ 自己证明自己。
// 所以这里在**临时 git 仓库**上逐条构造场景，并显式跑负向对照：
//   · 把 paths 换成 `['README.md']` ⇒ 同一个漂移仓库必须判"干净"（证明 drifted 来自路径比较，不是恒真）；
//   · 把 mainRef 设成 `HEAD` ⇒ 自己跟自己比必须判"干净"（证明判据不是 "HEAD != mainRef 就飘"）。
// 场景 ③/⑦c 是同一类负向对照的另一面：记录层（KANBAN.json / .agents）与文档（README）不在判据里，
// 因为它们天天在变 —— 若把它们算进漂移，守卫会在第一周就被当成噪音关掉。
//
// 为什么每个场景用**独立临时仓库**而不是改同一个：断言之间不得互相污染（"干净"必须真的干净，
// 而不是前一步留下的偶然状态）—— 这也是 ⑤（origin/main 不存在）必须显式构造的原因。
//
// 对**真实仓库**只做结构 + 一致性断言（见文件末尾）：不对它断言 drifted=false（本机未提交改动
// 会让 dirtyFiles 非空），也不硬断言 diffFiles 为空（CI 的 PR 构建里 HEAD 与 origin/main 本来
// 就有差异，硬断言会变成永久红灯；改成"与 git 原始输出逐条一致"的可失败对照）。
//
// 用法：node scripts/test-tree-guard.mjs       ⇒ 全部通过打印 PASS 且 exit 0；任一失败 exit 1。
// 零外部依赖（只要求 PATH 里有 git）；不需要网络、不需要 npm；不碰仓库文件（只读真实仓库）。

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkTreeDrift, formatTreeDrift } from './lib/tree-guard.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// 默认判定路径（= lib 的默认值）：真实仓库那一段用它校验"diffFiles 都在判据里"。
const PATHS = ['scripts', 'src-tauri/resources/manager', 'src-tauri/resources/preinstalled']

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'tree-guard-test-'))
// 空全局 git 配置：不受用户 ~/.gitconfig 影响（否则 commit.gpgsign / init.defaultBranch / hooks 会让
// 夹具仓库在别人的机器上失败）；身份用 env 钉死，避免 "Please tell me who you are"。
const GITCONFIG = join(TMP_ROOT, 'gitconfig')
writeFileSync(GITCONFIG, '')
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: GITCONFIG,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'tree-guard-test',
  GIT_AUTHOR_EMAIL: 'tree-guard-test@example.invalid',
  GIT_COMMITTER_NAME: 'tree-guard-test',
  GIT_COMMITTER_EMAIL: 'tree-guard-test@example.invalid',
}

let nOk = 0
const failures = []
const skips = []

function check(name, expected, actual) {
  const ok = String(expected) === String(actual)
  if (ok) {
    nOk += 1
    console.log(`  ok   ${name}`)
  } else {
    failures.push(`${name}：期望 ${JSON.stringify(String(expected))}，实际 ${JSON.stringify(String(actual))}`)
    console.log(`  FAIL ${name} —— 期望 ${JSON.stringify(String(expected))}，实际 ${JSON.stringify(String(actual))}`)
  }
  return ok
}

/** `--skip` 只给"本机/CI 环境不提供的夹具"用（显式计数并逐条打印，不是静默通过）。 */
function skip(name, why) {
  skips.push(`${name}（${why}）`)
  console.log(`  SKIP ${name} —— ${why}`)
}

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV, timeout: 60_000 })
  if (r.error) throw new Error(`夹具 git ${args.join(' ')} 启动失败：${r.error.message}`)
  if (r.status !== 0) {
    throw new Error(`夹具 git ${args.join(' ')} 失败（exit ${r.status}）：${(r.stderr ?? '').trim().split('\n')[0] ?? ''}`)
  }
  return String(r.stdout ?? '').trim()
}

function put(abs, text) {
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text)
}

let repoSeq = 0
/**
 * 建一个**独立**临时 git 仓库：初始提交 + 伪造 `refs/remotes/origin/main`（不联网、不配 remote）。
 * @returns {string} 仓库根目录
 */
function makeRepo() {
  const dir = join(TMP_ROOT, `repo-${++repoSeq}`)
  mkdirSync(dir, { recursive: true })
  put(join(dir, 'scripts/base.mjs'), '// base\n')
  put(join(dir, 'README.md'), '# fixture\n')
  put(join(dir, 'KANBAN.json'), '{}\n')
  put(join(dir, '.agents/notes/implemented/feature/x.md'), 'note\n')
  git(dir, ['init', '-q'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'init'])
  git(dir, ['update-ref', 'refs/remotes/origin/main', git(dir, ['rev-parse', 'HEAD'])])
  return dir
}

console.log(`test-tree-guard：仓库 ${ROOT}\n临时目录 ${TMP_ROOT}\n`)

// ── ① 干净工作树 ⇐ 必须判"无漂移"（否则默认轮次会被假警报淹掉）─────────────
console.log('[1] 干净工作树 ⇒ drifted=false')
{
  const repo = makeRepo()
  const r = checkTreeDrift({ root: repo })
  check('① 干净 ⇒ drifted=false', 'false', r.drifted)
  check('① 干净 ⇒ unknown=false', 'false', r.unknown)
  check('① 干净 ⇒ diffFiles / dirtyFiles 都为空', '0|0', `${r.diffFiles.length}|${r.dirtyFiles.length}`)
  check('① 干净 ⇒ reasons 为空（没有"无事生非"的原因）', '0', r.reasons.length)
  check('① 干净 ⇒ head / main / branch 都有值', 'true', String(Boolean(r.head && r.main && r.branch)))
  check('① 干净 ⇒ head 与 main 是同一个提交', 'true', String(r.head === r.main))
  check('① 干净 ⇒ formatTreeDrift 返回空串（默认轮次一行都不多打）', '', formatTreeDrift(r))
}

// ── ② 分支上提交一处 scripts/foo.mjs ⇒ 必须判漂移并点名 ────────────────────
console.log('\n[2] 分支上提交一处 scripts/foo.mjs ⇒ drifted=true 且 diffFiles 点名')
{
  const repo = makeRepo()
  git(repo, ['checkout', '-q', '-b', 'feat/drift'])
  put(join(repo, 'scripts/foo.mjs'), '// drift\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'add foo'])
  const r = checkTreeDrift({ root: repo })
  check('② 分支上提交 scripts/foo.mjs ⇒ drifted=true', 'true', r.drifted)
  check('② unknown=false（能判断就别说"不知道"）', 'false', r.unknown)
  check('② diffFiles 点名该文件（且只有它）', 'scripts/foo.mjs', r.diffFiles.join('|'))
  check('② dirtyFiles 为空（改动已提交）', '0', r.dirtyFiles.length)
  const rawDiff = git(repo, ['diff', '--name-only', 'HEAD', 'origin/main', '--', ...PATHS])
  check('② diffFiles 与 git 原始输出逐条一致（不是从被测物派生的期望）', rawDiff, r.diffFiles.join('\n'))
  const text = formatTreeDrift(r)
  check('② 告警第一行含 HEAD 与 origin/main 两个 sha', 'true', String(text.includes(`HEAD=${r.head}`) && text.includes(`origin/main=${r.main}`)))
  check('② 告警含分支名', 'true', String(text.includes('feat/drift')))
  check('② 告警点名文件', 'true', String(text.includes('scripts/foo.mjs')))
  check('② 告警含可直接粘贴的修复命令（-C root + switch main + ff-only merge）', 'true',
    String(text.includes(`git -C ${repo} switch main`) && text.includes(`git -C ${repo} merge --ff-only origin/main`)))
  check('② 告警写明"默认只告警"与"要停跑怎么开"', 'true',
    String(text.includes('--strict-tree') && text.includes('DSH_TREE_GUARD=strict')))
}

// ── ③ 只提交 KANBAN.json 改动 ⇒ 记录层不是判据（否则看板天天挡住心跳）──────
console.log('\n[3] 只提交 KANBAN.json 改动 ⇒ drifted=false')
{
  const repo = makeRepo()
  git(repo, ['checkout', '-q', '-b', 'feat/kanban'])
  put(join(repo, 'KANBAN.json'), '{"cards":["跟进卡"]}\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'kanban'])
  const r = checkTreeDrift({ root: repo })
  check('③ 提交了 KANBAN.json（HEAD 与 origin/main 确实不同）⇒ drifted=false', 'false', r.drifted)
  check('③ diffFiles 为空（被 paths 过滤掉）', '0', r.diffFiles.length)
  check('③ 反向证明夹具真的产生了差异：git diff 全仓能看到 KANBAN.json', 'KANBAN.json',
    git(repo, ['diff', '--name-only', 'HEAD', 'origin/main']))

  const repoDirty = makeRepo()
  put(join(repoDirty, 'KANBAN.json'), '{"cards":["未提交的跟进卡"]}\n')
  const rd = checkTreeDrift({ root: repoDirty })
  check('③b 未提交的 KANBAN.json ⇒ drifted=false（status 也按 paths 过滤）', '0|false', `${rd.dirtyFiles.length}|${rd.drifted}`)
}

// ── ④ 工作树里未提交改 scripts/bar.mjs ⇒ 必须判漂移并点名 ──────────────────
console.log('\n[4] 未提交改 scripts/bar.mjs ⇒ drifted=true 且 dirtyFiles 点名')
{
  const repo = makeRepo()
  put(join(repo, 'scripts/bar.mjs'), '// wip\n')
  let r = checkTreeDrift({ root: repo })
  check('④ 未提交改 scripts/bar.mjs ⇒ drifted=true', 'true', r.drifted)
  check('④ unknown=false', 'false', r.unknown)
  check('④ dirtyFiles 点名该文件（且只有它）', 'scripts/bar.mjs', r.dirtyFiles.join('|'))
  check('④ diffFiles 为空（差异来自工作树，不是 refs）', '0', r.diffFiles.length)
  check('④ 告警点名文件', 'true', String(formatTreeDrift(r).includes('scripts/bar.mjs')))

  git(repo, ['add', 'scripts/bar.mjs'])
  r = checkTreeDrift({ root: repo })
  check('④b 已暂存但未提交也算 dirty（不只看工作区）', 'scripts/bar.mjs', r.dirtyFiles.join('|'))

  // ④c–e 回归：`git status --porcelain` 的行首**前导空格有意义**（`" M <path>"` 是"未暂存修改"）。
  // 旧实现把行 trim 掉再 slice(3) ⇒ 点名成 `cripts/base.mjs`。这个 bug 是**真实仓库冒烟**抓到的
  // （④a/④b 只有 `??` 与 `A ` 两种行首，碰不到 ` M`），所以这里把三种行首都钉住。
  const repoMod = makeRepo()
  put(join(repoMod, 'scripts/base.mjs'), '// base changed\n')
  let rMod = checkTreeDrift({ root: repoMod })
  check('④c 未暂存的已跟踪文件修改 ⇒ dirtyFiles 点名 scripts/base.mjs（不丢首字符）', 'scripts/base.mjs', rMod.dirtyFiles.join('|'))
  check('④c 告警文案里的路径同样不能变形', 'true', String(formatTreeDrift(rMod).includes('scripts/base.mjs')))
  rmSync(join(repoMod, 'scripts/base.mjs'))
  rMod = checkTreeDrift({ root: repoMod })
  check('④d 未暂存删除（` D`，同样行首空格）⇒ 点名 scripts/base.mjs', 'scripts/base.mjs', rMod.dirtyFiles.join('|'))
  git(repoMod, ['add', '-A'])
  rMod = checkTreeDrift({ root: repoMod })
  check('④e 暂存后的删除（`D `）⇒ 仍点名 scripts/base.mjs', 'scripts/base.mjs', rMod.dirtyFiles.join('|'))

  const repoUtf8 = makeRepo()
  put(join(repoUtf8, 'scripts/中文.mjs'), '// 中文路径\n')
  const rUtf8 = checkTreeDrift({ root: repoUtf8 })
  check('④f 非 ASCII 路径原样点名（-c core.quotepath=false 生效，不出 \\344 转义）', 'scripts/中文.mjs', rUtf8.dirtyFiles.join('|'))
}

// ── ⑤ mainRef 不存在 ⇒ unknown（不猜成漂移，也不静默通过）─────────────────
console.log('\n[5] mainRef 不存在 ⇒ unknown=true、drifted=false')
{
  const repo = makeRepo()
  const r = checkTreeDrift({ root: repo, mainRef: 'refs/remotes/nope/main' })
  check('⑤ mainRef 不存在 ⇒ unknown=true', 'true', r.unknown)
  check('⑤ mainRef 不存在 ⇒ drifted=false（不猜成漂移）', 'false', r.drifted)
  check('⑤ mainRef 不存在 ⇒ main=null', 'null', String(r.main))
  check('⑤ mainRef 不存在 ⇒ 有 reason 且说明解析不到哪个 ref', 'true',
    String(r.reasons.some((s) => s.includes('解析不到') && s.includes('refs/remotes/nope/main'))))
  check('⑤ mainRef 不存在 ⇒ diffFiles / dirtyFiles 都是空（不交半成品判据）', '0|0', `${r.diffFiles.length}|${r.dirtyFiles.length}`)
  const text = formatTreeDrift(r)
  check('⑤ 告警明说"无法判断"而不是"已通过"', 'true', String(text.includes('无法判断')))
  check('⑤ 告警给出排查命令（fetch/status）', 'true', String(text.includes('fetch origin') && text.includes('status -sb')))
}

// ── ⑥ 非 git 目录 ⇒ unknown、不抛异常 ──────────────────────────────────────
console.log('\n[6] 非 git 目录 ⇒ unknown=true、不抛异常')
{
  const plain = join(TMP_ROOT, 'not-a-repo')
  mkdirSync(plain, { recursive: true })
  put(join(plain, 'scripts/whatever.mjs'), '// x\n')
  let threw = null
  let r = null
  try { r = checkTreeDrift({ root: plain }) } catch (e) { threw = e }
  check('⑥ 非 git 目录 ⇒ 不抛异常', 'null', threw === null ? 'null' : String(threw))
  check('⑥ 非 git 目录 ⇒ unknown=true', 'true', String(r?.unknown))
  check('⑥ 非 git 目录 ⇒ drifted=false', 'false', String(r?.drifted))
  check('⑥ 非 git 目录 ⇒ reason 说明"不是 git 工作树"', 'true', String((r?.reasons ?? []).some((s) => s.includes('不是 git'))))
  check('⑥ 非 git 目录 ⇒ formatTreeDrift 仍可打印（调用方不必自己判空）', 'true', String(formatTreeDrift(r).includes('无法判断')))

  let threw2 = null
  let r2 = null
  try { r2 = checkTreeDrift({ root: join(TMP_ROOT, 'no-such-dir') }) } catch (e) { threw2 = e }
  check('⑥b root 不存在 ⇒ 不抛异常、unknown=true', 'null|true', `${threw2 === null ? 'null' : String(threw2)}|${r2?.unknown}`)
}

// ── ⑦ 负向对照：证明判据不是恒真 ───────────────────────────────────────────
console.log('\n[7] 负向对照：把判据改掉 ⇒ 同一份漂移仓库必须变"干净"')
{
  // 与 ② 同构的漂移仓库（分支上提交了 scripts/foo.mjs）
  const repo = makeRepo()
  git(repo, ['checkout', '-q', '-b', 'feat/control'])
  put(join(repo, 'scripts/foo.mjs'), '// drift\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'add foo control'])
  const baseline = checkTreeDrift({ root: repo })
  check('⑦ 对照前提：默认判据下这个仓库是漂移的（否则下面的对照没有意义）', 'true', baseline.drifted)

  const byPaths = checkTreeDrift({ root: repo, paths: ['README.md'] })
  check('⑦a paths=[README.md] ⇒ drifted=false（证明检测来自 paths 比较，不是恒真）', 'false|0|0',
    `${byPaths.drifted}|${byPaths.diffFiles.length}|${byPaths.dirtyFiles.length}`)

  const byHead = checkTreeDrift({ root: repo, mainRef: 'HEAD' })
  check('⑦b mainRef=HEAD ⇒ drifted=false（证明判据不是"HEAD != mainRef 就飘"）', 'false|0|0',
    `${byHead.drifted}|${byHead.diffFiles.length}|${byHead.dirtyFiles.length}`)

  const repoDocs = makeRepo()
  put(join(repoDocs, 'README.md'), '# changed\n')
  const docs = checkTreeDrift({ root: repoDocs })
  check('⑦c 只有 README.md 未提交 ⇒ drifted=false（文档层不在判据里）', '0|false', `${docs.dirtyFiles.length}|${docs.drifted}`)
}

// ── ⑧ 真实仓库（本仓库）：只做结构 + 一致性断言 ───────────────────────────
console.log('\n[8] 真实仓库：不抛异常、结构完整、与 git 原始输出一致')
{
  const real = checkTreeDrift({ root: ROOT })
  const keys = ['drifted', 'unknown', 'head', 'main', 'branch', 'diffFiles', 'dirtyFiles', 'reasons']
  check('真实仓库：返回结构完整（8 个字段都在）', keys.join(','), keys.filter((k) => k in real).join(','))
  check('真实仓库：布尔字段类型正确', 'true|true', `${typeof real.drifted === 'boolean'}|${typeof real.unknown === 'boolean'}`)
  check('真实仓库：数组字段类型正确', 'true|true|true',
    `${Array.isArray(real.diffFiles)}|${Array.isArray(real.dirtyFiles)}|${Array.isArray(real.reasons)}`)
  // 一致性：drifted 必须恰好等价于"有点名的文件"——杜绝"报了漂移却点不出文件"或反过来。
  check('真实仓库：drifted 与两个文件数组一致', String(real.diffFiles.length > 0 || real.dirtyFiles.length > 0), String(real.drifted))
  check('真实仓库：unknown 与 drifted 互斥（不猜成漂移）', 'false', String(real.unknown && real.drifted))
  check('真实仓库：diffFiles 都在默认判定路径内（paths 过滤真的生效）', 'true',
    String(real.diffFiles.every((p) => PATHS.some((base) => p === base || p.startsWith(`${base}/`)))))
  check('真实仓库：formatTreeDrift 与 drifted 状态一致', String(real.drifted), String(Boolean(formatTreeDrift(real))))

  // 与 git 原始输出逐条一致。**不硬断言 diffFiles 为空**：CI 的 PR 构建里 HEAD 与 origin/main
  // 本来就有差异（checkout fetch-depth: 0），硬断言会变成永久红灯；这条对照同样能抓"解析造假文件"。
  const rawRef = spawnSync('git', ['-C', ROOT, 'rev-parse', '--verify', '--quiet', 'origin/main^{commit}'], { encoding: 'utf8', env: GIT_ENV })
  if (rawRef.status === 0) {
    const rawDiff = spawnSync('git', ['-C', ROOT, 'diff', '--name-only', 'HEAD', 'origin/main', '--', ...PATHS], { encoding: 'utf8', env: GIT_ENV })
    check('真实仓库：diffFiles 与 git 原始输出逐条一致', String(rawDiff.stdout ?? '').trim(), real.diffFiles.join('\n'))
    check('真实仓库：origin/main 可解析 ⇒ unknown=false（这是"能判断"的前提）', 'false', String(real.unknown))
    // 本机开发态（HEAD == origin/main）下 diffFiles 必须是空的；CI 的 PR 构建里两者本来就不同 ⇒ 显式登记。
    if (real.head && real.main && real.head === real.main) {
      check('真实仓库：HEAD == origin/main ⇒ diffFiles 为空（不产生虚假差异）', '0', real.diffFiles.length)
    } else {
      skip('真实仓库：HEAD == origin/main ⇒ diffFiles 为空', `HEAD=${real.head} 与 origin/main=${real.main} 不同（PR 构建/特性分支的常态），该断言只在两者相同时有意义`)
    }
  } else {
    skip('真实仓库：diffFiles 与 git 原始输出逐条一致', '本机解析不到 origin/main（浅克隆/没 fetch）—— 覆盖缺口，不是通过')
  }
}

// ── ⑨ 入口接线：三个入口都必须真的调用守卫（否则模块再好也没人用）───────────
// 行为级证明在人工负向对照里（真实工作树 + --dry-run --strict-tree ⇒ exit 1），门禁这里只能验"接上了"。
console.log('\n[9] 入口接线：三个入口都 import + 调用 + 支持 --strict-tree / DSH_TREE_GUARD')
{
  for (const file of ['scripts/dsh-watch.mjs', 'scripts/dsh-release-autopilot.mjs', 'scripts/dsh-doctor.mjs']) {
    const src = readFileSync(join(ROOT, file), 'utf8')
    const wired = /from '\.\/lib\/tree-guard\.mjs'/.test(src)
      && /checkTreeDrift\(\{ root: ROOT \}\)/.test(src)
      && /formatTreeDrift\(/.test(src)
      && /--strict-tree/.test(src)
      && /DSH_TREE_GUARD/.test(src)
    check(`${file} 已接入 tree-guard（import/调用/严格开关齐全）`, 'true', String(wired))
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const total = nOk + failures.length
const skippedNote = skips.length ? `，${skips.length} 条跳过（覆盖缺口，逐条列出）` : ''
console.log(`\n${failures.length ? 'FAIL' : 'PASS'} tree-guard 门禁：${nOk}/${total} 条断言通过${skippedNote}`)
for (const s of skips) console.log(`  SKIP ${s}`)
if (failures.length) {
  for (const f of failures) console.error(`  - ${f}`)
  console.error(`临时目录保留供排障：${TMP_ROOT}`)
  process.exit(1)
}
rmSync(TMP_ROOT, { recursive: true, force: true })
process.exit(0)
