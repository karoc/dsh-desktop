#!/usr/bin/env node
// dsh:rehearse —— 把「装候选版本」这一步固化成**一条可重复执行的命令**（上游发版日全流程干跑，P1）。
//
//   node scripts/dsh-rehearse.mjs [--scenario install|bump] [--version <v>] [--from-floor <v>]
//                                 [--keep] [--json <out>] [--timeout <sec>]
//                                 [--warm-store <dir>] [--registry <url>] [--help]
//
// 它做什么：建一个**空**临时 runtime（只把真实 dev runtime 的 `.pnpm-store` 与
// `node_modules/pnpm` 软链进去 = "热 store"），用生产同款参数启动随包的
// `scripts/server-manager.mjs`，**让它走自己的启动期自动安装路径**
//（main()：`if (!dshInstalled(...)) { log('dsh missing or broken — installing automatically'); await installDshUpdate() }`），
// 然后断言临时 runtime 里落地的 dsh 版本、对它跑 `scripts/dsh-compat-probe.mjs`、
// 打印每步耗时表，最后清理临时目录。**只读真实 runtime**：一切写操作都在临时目录内。
//
// 为什么不在本脚本里自己跑 pnpm/npm：那样演练的就不是产品路径了。发版日真正会跑的是
// manager 的安装链路（pnpm hoisted + registry 降级链 + 预装插件保护 + profile bundles 补回），
// 演练必须命中同一段代码。
//
// ── 与 2026-10-19 手工配方（.tmp-investigate/rehearsal-install.sh）的三处差异，都是有意为之 ──
//  1) **装完立刻杀**：手工配方让 manager 一路跑到 `supervise()`，真的在临时 runtime 里起了
//     一个带 token 的 dsh web（旧日志实录 `{"t":"url","url":"http://127.0.0.1:34643/?token=…"}`），
//     一直到 `timeout 300` 才被砍。本脚本在 `install-status done` 后 2s（或更早，见
//     `launching dsh web` 逃逸线）按**进程组**终止 manager —— 演练不该顺手起服务。
//  2) **不注入 `npm_config_offline`**：手工配方设了它，但旧日志里 pnpm 照样 `downloaded 36`
//     （并不是离线），线上壳也不会设它。默认按生产语义联网，环境里已有 `npm_config_offline`
//     原样继承（要复刻手工配方就在调用前 export 它）。
//  3) 失败保留现场：任何一步失败都**不清临时目录**（并打印路径），成功的默认清掉。
//
// ── `--version` 的语义（重要，别误读）──
// 启动期自动安装路径**结构上不接受外部指定版本**：`installDshUpdate()` 的目标版本是
// `max(MIN_DSH_VERSION, registry latest)`（见 manager 的 installDshUpdate）。所以 `--version`
// 是"**我期望落地的版本**"（默认 = 壳地板 `MIN_DSH_VERSION`），不是"让 manager 装这个版本"的开关。
// 落地版本 != 期望版本 ⇒ 如实报 `MISMATCH` 并以退出码 1 结束，**绝不强行判绿**。
// 想演练比地板新的版本：把 `--registry` 指向 latest 更高的镜像（或等上游把 latest 挪上去），
// 然后用 `--version <那个版本>` 表达期望。
//
// ── `--version` ≠ 壳地板 时的探针判据（2026-10-30 修）──
// 适配**之前**跑 install 演练（target > 壳地板）时，探针的「已装 == 壳地板」与「已装 == 夹具版本」
// 两条判据必然 RED —— 那是「还没抬地板 / 还没重采夹具」的正常状态，不是不兼容。因此这时探针按
// `--assume-floor <target> --assume-fixture <target>` 的**演练假设值**判定，并断言报告里
// `rehearsal=true` 且 `assumed.floor/assumed.fixture` 都等于 target（假设没生效 ⇒ 判失败）。
// 结论里必须带「演练假设」字样：它**不构成**版本已一致 / 适配已完成的证据。旧实现只写
// `verdict !== 'red'` 却不给假设开关 ⇒ 该分支永远不可达，target≠floor 的 install 演练 100% 红，
// autopilot 的 ② 适配因此结构性阻塞（2026-10-30 实录：连续 10 轮失败后才发现）。
//
// ── 三个场景 ───────────────────────────────────────────────────────────────
//  install（默认）= 上面这条：空临时 runtime → manager 启动期自动安装 → 探针 → 只读自证。
//  upgrade        = 「旧版 → 新版」升级覆盖演练（本次新增）：
//    1 建**真实布局**的临时 runtime（默认 Windows `Local\Temp`，与 .pnpm-store 同设备；
//      跨设备会让 pnpm 退化成复制/变慢 ⇒ 候选目录设备不符就跳过，全都不符 ⇒ exit 3），
//      先按 manager 的 ensureRuntimeDir / ensurePnpmWorkspace 写好 package.json / .npmrc /
//      pnpm-workspace.yaml。**必须写**：只给空 node_modules 时 pnpm 会留下一份
//      `allowBuilds: …: set this to true or false` 的提示桩，manager 的升级安装看到文件已存在
//      就不会重写，于是 ERR_PNPM_IGNORED_BUILDS 让 pnpm 以 exit 1 收场（实测；见 §升级覆盖）。
//    2 绕过 manager 装旧版（manager 的启动期目标恒为 max(地板, latest)，装不了旧版）：
//      `pnpm add @deepseek-ai/dsh@<old> --store-dir <热 store> --node-linker=hoisted`
//      —— **必须 hoisted**：默认 isolated 布局会让 manager 走 isolated→hoisted 重建分支
//      （删光 node_modules 重装），那样"升级覆盖"和"无残留嵌套副本"两条断言就是假演练。
//      断言落地 == 旧版、且基线嵌套计数 == 1。
//    3 复用 install 场景（子进程 `--scenario install --runtime-dir <临时 runtime>`）让 manager
//      走**自己的启动期兼容闸门**升到地板（真实窗口里老用户走的正是这段：已装 < 地板 ⇒
//      `installDshUpdate({ version: MIN_DSH_VERSION })`）。
//    4 四条断言（实际值全部打印）：① 落地 == 目标；② **无残留嵌套副本**：同一棵树上
//      `find <runtime>/node_modules -path '*/node_modules/@deepseek-ai/dsh/package.json'` 计数 == 1，
//      **并对真实 dev runtime 跑同一计数作对照**（值来自实测，不是硬编码的 1）；
//      ③ `dsh-compat-probe --runtime <tmp>` ⇒ GREEN；④ 真实仓库非记录层 `git status` 前后一致
//      + 真实 runtime 关键文件 sha256/mtime/size 未变。
//    5 负向自证（不是"顺手加的"）：`--fault nested-copy` 在升级后的树里塞一份**同版本**嵌套
//      副本（manager 的 stale 清理只删版本不一致的，所以它会留在树里）⇒ ②必须变红；
//      `--upgrade-from` 指向 registry 不存在的版本 ⇒ 装旧版一步必须明确失败。两条都 exit 非 0。
//  upgrade 的写域只有临时 runtime：真实仓库 / 真实 runtime 只读；`.pnpm-store` 与 install
//  场景一样是软链共享的（pnpm 只往里追加内容寻址条目），已装树与 manager.log 有指纹自证。
//  bump           = 「抬地板」全链路演练：
//    1 clone 真实仓库到 /tmp（`git clone --local --shared`），要求克隆里 `git log` 可读；
//      克隆**之前**确认真实仓库没有非记录层改动（记录层 = KANBAN.json / .agents/notes/archive.json /
//      未跟踪的 .agents/notes/** 与 tools/）—— 有 ⇒ exit 3，绝不带脏状态演练。
//    2 在克隆里把两份 MIN_DSH_VERSION 改成 `--from-floor`（默认 0.2.1-alpha.5），并同步克隆里
//      README 的对应数值 ⇒ 制造"地板低于目标版本"的真实前提（否则 dsh-adapt 第 2/3 步会 skip）。
//    3 复用 install 场景的积木（本脚本子进程 `--scenario install --keep --json`）：建临时 runtime、
//      让 manager 走自己的安装路径装到 `--version`（默认 = 真实仓库当前地板），断言落地版本 == 目标。
//    4 在克隆里跑 `node scripts/dsh-adapt.mjs --version <目标> --runtime <临时 runtime>`（**不加**
//      `--dry-run`）—— 它写的是克隆里的地板 / README / patch 夹具，并跑全量门禁。
//    5 五项断言（任何一条不满足 ⇒ exit 1）：① 克隆两份地板 == 目标且 `node --check` 通过；
//      ② 克隆 README 里的旧地板被替换（打印替换处数）；③ 克隆夹具 dshVersion == 目标（打印 id 数）；
//      ④ **真实仓库**的 scripts/fixtures/dsh-web-app-patch-ids.json sha256/mtime/size 未变
//      （证明脚本写的是克隆里那份）；⑤ 真实仓库非记录层 `git status --porcelain` 为空。
//  bump 的写域只有 /tmp：克隆 + 临时 runtime；脚本**不执行任何 git 写操作**（除 clone 外不碰 .git），
//  真实仓库的 manager / README / 夹具在跑前跑后都有 sha256+mtime+size 指纹对照。
//
// bump 退出码沿用同一套：0 全绿；1 演练失败（任何断言/步骤不达标）；2 用法错误
//  （含"目标 ≤ --from-floor"这种违反场景语义的参数组合：那是假演练，直接拒绝）；3 前置不满足
//  （真实仓库脏 / 热 runtime 缺件 / 读不到地板）。
//
// upgrade 退出码：0 全绿；1 任一步/任一断言不达标（`--fault nested-copy` 下 ② 变红也是 1 ——
//  那是负向对照**预期**的红，结论文本会明说，不会伪装成绿）；2 用法错误（旧版不低于地板 ⇒
//  兼容闸门不会触发 = 假演练，直接拒绝）；3 前置不满足（热 runtime 缺件 / 没有同设备的临时目录 /
//  读不到真实仓库 status）。
//
// 退出码：0 = 全绿；1 = 演练失败（安装/版本/探针/自证任一步不达标）；2 = 用法错误；
//         3 = 前置不满足（热 runtime 不存在或缺 `.pnpm-store` / 随包 pnpm）。

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANAGER = join(ROOT, 'scripts/server-manager.mjs')
const PROBE = join(ROOT, 'scripts/dsh-compat-probe.mjs')
const RESOURCE_DIR = join(ROOT, 'src-tauri/resources')
const PATCH_FILE = join(RESOURCE_DIR, 'patch/dsh-desktop.patch.yml')
const DSH_PKG = '@deepseek-ai/dsh'
/** bump 场景在克隆里把地板降到这个版本（低于当前真实地板，且是上游真实存在的预发布版本）。 */
const BUMP_DEFAULT_FROM_FLOOR = '0.2.1-alpha.5'
const UPGRADE_GAPS = [
  '升级覆盖只走 manager 的兼容闸门（已装 < 地板 ⇒ installDshUpdate({version: 地板})）；**不覆盖**壳自更新（Tauri 安装包），也不覆盖 registry latest > 地板时"更新检查 / 托盘立即更新"那条路径。',
  '旧版是脚本用 pnpm 直接装的（manager 的启动期目标恒为 max(地板, latest)，装不了旧版）：只能靠"真实布局 + manager 同款 pnpm 参数"逼近生产现场，不能证明真实老用户机器上的每一处状态。',
  '临时 runtime 与真实 runtime 共享 .pnpm-store（软链）：pnpm 会往里追加内容寻址条目（只增不删）；已装树 / manager.log 有 sha256+mtime+size 指纹自证。',
  '探针只判结构/兼容性（版本三方一致、seam、peer）：**不验证升级后 dsh web 能否真起来**（脚本刻意在 launching dsh web 处终止），那一步仍靠真机验收。',
]
/** upgrade 场景先装的旧版本：上游真实存在、且**低于壳地板** ⇒ manager 的兼容闸门会真的升级。 */
const UPGRADE_DEFAULT_FROM = '0.2.1-alpha.5'
/** 记录层豁免：与看板同属会话记录，不算脏；每次运行都把豁免明细打印出来，不静默。
 *  注意：必须声明在场景分发**之前** —— bump 分支在模块顶部就被调用，`const` 有 TDZ。 */
const BUMP_EXEMPT_EXACT = new Set(['KANBAN.json', '.agents/notes/archive.json'])
/** bump 场景要自证「真实仓库零改动」的文件（跑前跑后各取一次 sha256+mtime+size）。 */
const BUMP_REAL_FILES = {
  'scripts/server-manager.mjs': join(ROOT, 'scripts/server-manager.mjs'),
  'src-tauri/resources/manager/server-manager.mjs': join(ROOT, 'src-tauri/resources/manager/server-manager.mjs'),
  'README.md': join(ROOT, 'README.md'),
  'scripts/fixtures/dsh-web-app-patch-ids.json': join(ROOT, 'scripts/fixtures/dsh-web-app-patch-ids.json'),
  'scripts/dsh-adapt.mjs': join(ROOT, 'scripts/dsh-adapt.mjs'),
  'scripts/dsh-rehearse.mjs': join(ROOT, 'scripts/dsh-rehearse.mjs'),
}
/** bump 场景结构上覆盖不到的地方（每次运行都打印）。 */
const BUMP_GAPS = [
  'bump 只演练「克隆内的地板/README/夹具改写 + 目标版本安装 + 全量门禁」这条链路；**不覆盖**真实仓库的提交/PR/发版，也不覆盖"已有 dsh 的升级覆盖分支"（第 3 步用的仍是 install 场景的全新安装）。',
  '克隆是 `--local --shared`（对象库共享真实仓库的 .git/objects，只读），且克隆里没有 node_modules —— dsh-adapt 第 7 步直接跑 node，本机实测无需依赖；CI 上等价命令会跑 npm test。',
  '真实仓库的 manager / README / 夹具只做"未改动"自证；bump 不验证"抬地板后真实仓库仍能被 CI 接受"（那要等真实提交后的门禁）。',
]
/** 真实（热）runtime 默认路径：dev 壳的数据目录。可用 --warm-store 覆盖。 */
const DEFAULT_WARM_RUNTIME = '/mnt/c/Users/qqwto/AppData/Roaming/dsh.smoothly.desktop.dev/runtime'
/** install-status done 之后额外等这么久，让收尾（profile bundles 补回 / 升级标记）走完；
 *  期间一旦看到 `launching dsh web` 立即终止（逃逸线，绝不让 supervise 起服务）。 */
const POST_INSTALL_GRACE_MS = 2000
const KILL_GRACE_MS = 4000

const USAGE = `usage: node scripts/dsh-rehearse.mjs [--scenario install|bump|upgrade] [--version <v>]
                                      [--from-floor <v>] [--upgrade-from <v>] [--temp-base <dir>]
                                      [--keep] [--json <out>] [--timeout <sec>]
                                      [--warm-store <dir>] [--registry <url>]

  --scenario <s>     install（默认）= 全新安装演练；bump = 在 /tmp 克隆里演练「抬地板」全链路
                     （降地板 → 复用 install 装目标版本 → 克隆里跑 dsh-adapt → 五项断言）；
                     upgrade = 旧版 → 新版「升级覆盖」演练（pnpm 装旧版 → manager 启动期兼容闸门
                     升级到地板 → 版本 / 无残留嵌套副本 / 探针 / 真实仓库只读 四条断言）。
  --from-floor <v>   仅 bump：把克隆里的地板降到这个版本（默认 ${BUMP_DEFAULT_FROM_FLOOR}）。必须**低于**目标版本，
                     否则 exit 2（低于/持平会让 dsh-adapt 第 2/3 步静默 skip = 假演练）。
  --upgrade-from <v> 仅 upgrade：先装哪个旧版本（默认 ${UPGRADE_DEFAULT_FROM}）。必须**低于**壳地板，
                     否则 manager 的兼容闸门不会触发（"升级"根本不发生 = 假演练）⇒ exit 2。
  --temp-base <dir>  仅 upgrade：临时 runtime 的父目录（默认从热 runtime 推导 Windows Local\\Temp）。
                     必须与 .pnpm-store **同设备**（跨设备 pnpm 会退化/变慢）⇒ 不符即 exit 3，不静默降级。
  --version <v>      期望落地的 dsh 版本（默认 = 壳地板 MIN_DSH_VERSION）。不等于"指定安装版本"：
                     install 的启动期目标 = max(壳地板, registry latest)；upgrade 的兼容闸门目标 = 壳地板。
                     不一致时如实报 MISMATCH。target≠壳地板时探针按演练假设值（--assume-floor /
                     --assume-fixture = target）判定，报告标 rehearsal=true —— 不是版本已一致的证据。
  --keep             保留临时 runtime（默认成功即清理；失败一律保留现场）
  --json <out>       结构化结果写入 <out>
  --timeout <sec>    安装段超时（默认 300）
  --warm-store <dir> 热 runtime 目录（内含 .pnpm-store 与 node_modules/pnpm），也可直接给
                     .pnpm-store 目录本身。默认 ${DEFAULT_WARM_RUNTIME}
  --registry <url>   透传给 manager / pnpm 的 --registry（默认取 DSH_DESKTOP_REGISTRY，再退官方源）
  --fault <name>     仅 upgrade：故障注入，当前只有 nested-copy（升级后往树里塞一份同版本嵌套
                     @deepseek-ai/dsh 副本）——专门用来证明「无残留嵌套副本」这条断言会红。
  --runtime-dir <d>  内部参数（install 场景）：在调用方给的已有 runtime 上跑，不新建也不清理。
  --help             本帮助
`

// ── 参数 ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { scenario: 'install', version: null, fromFloor: null, upgradeFrom: null, keep: false, json: null, timeoutSec: 300, warmStore: null, registry: null, tempBase: null, fault: null, runtimeDir: null, help: false }
  const val = (i, name) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} 需要值`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const eq = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : null
    const inline = eq ? a.slice(eq.length + 1) : null
    const take = () => (inline !== null ? inline : val(i++, a))
    if (a === '--keep') out.keep = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--scenario' || eq === '--scenario') out.scenario = take()
    else if (a === '--from-floor' || eq === '--from-floor') out.fromFloor = take()
    else if (a === '--upgrade-from' || eq === '--upgrade-from') out.upgradeFrom = take()
    else if (a === '--version' || eq === '--version') out.version = take()
    else if (a === '--json' || eq === '--json') out.json = resolve(take())
    else if (a === '--timeout' || eq === '--timeout') out.timeoutSec = Number(take())
    else if (a === '--warm-store' || eq === '--warm-store') out.warmStore = take()
    else if (a === '--registry' || eq === '--registry') out.registry = take()
    else if (a === '--temp-base' || eq === '--temp-base') out.tempBase = take()
    else if (a === '--fault' || eq === '--fault') out.fault = take()
    else if (a === '--runtime-dir' || eq === '--runtime-dir') out.runtimeDir = take()
    else throw new Error(`未知参数 ${a}`)
  }
  if (!Number.isFinite(out.timeoutSec) || out.timeoutSec <= 0) throw new Error('--timeout 必须是正数（秒）')
  if (!['install', 'bump', 'upgrade'].includes(out.scenario)) throw new Error(`--scenario 只支持 install | bump | upgrade（收到 ${out.scenario}）`)
  if (out.fromFloor && out.scenario !== 'bump') throw new Error('--from-floor 只对 --scenario bump 有意义（install 场景安装目标 = max(壳地板, registry latest)）')
  if (out.upgradeFrom && out.scenario !== 'upgrade') throw new Error('--upgrade-from 只对 --scenario upgrade 有意义')
  if (out.tempBase && out.scenario !== 'upgrade') throw new Error('--temp-base 只对 --scenario upgrade 有意义')
  if (out.fault && out.scenario !== 'upgrade') throw new Error('--fault 只对 --scenario upgrade 有意义（当前只有 nested-copy）')
  if (out.fault && out.fault !== 'nested-copy') throw new Error(`--fault 只支持 nested-copy（收到 ${out.fault}）`)
  if (out.runtimeDir && out.scenario !== 'install') throw new Error('--runtime-dir 是 install 场景的内部参数（供 upgrade 复用）')
  return out
}

let opts
try {
  opts = parseArgs(process.argv.slice(2))
} catch (err) {
  console.error(`dsh-rehearse: ${err.message}\n\n${USAGE}`)
  process.exit(2)
}
if (opts.help) {
  process.stdout.write(USAGE)
  process.exit(0)
}

// ── 小工具 ─────────────────────────────────────────────────────────────────
const steps = []
/** 本配方**结构上**覆盖不到的地方 —— 每次运行都打印，读"GREEN"的人必须同时看到这些边界。 */
const gaps = [
  '只演练「全新安装」分支（空 runtime ⇒ dshInstalled()=false）：已有 dsh 的**升级覆盖**分支、' +
  'isolated→hoisted 布局迁移分支、兼容闸门（已装版本 < 地板）分支都没走到。',
  '只演练到 install-status done + 探针（结构/兼容性判据）：**没有验证装完之后 dsh web 能否真起来**' +
  '（本脚本刻意在 launching dsh web 处终止）。这一步仍靠真机验收。',
  '安装目标版本不可注入：启动期路径的目标 = max(壳地板, registry latest)，--version 只能表达期望值。',
]
const t0 = Date.now()
const now = () => Date.now()
const fmtS = (ms) => `${(ms / 1000).toFixed(1)}s`
function step(name, status, ms, detail = '') {
  steps.push({ name, status, ms, detail })
  const mark = { ok: 'ok', skip: 'skip', fail: 'FAIL' }[status] ?? status
  console.log(`  [${String(steps.length).padStart(2)}] ${name.padEnd(22)} ${mark.padEnd(5)} ${fmtS(ms).padStart(7)}  ${detail}`)
}
function sha256(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}
/** 真实 runtime 的"未被改动"指纹：内容哈希 + mtime + size 三件套。 */
function fingerprint(file) {
  try {
    const st = statSync(file)
    return { path: file, exists: true, sha256: sha256(file), mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return { path: file, exists: false }
  }
}
function listProcsMatching(needle) {
  if (process.platform !== 'linux') return null // 非 Linux 不做进程枚举（报告里注明）
  const hits = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === process.pid) continue
    try {
      const cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').join(' ').trim()
      if (cmd.includes(needle)) hits.push({ pid, cmd: cmd.slice(0, 220) })
    } catch { /* 进程刚消失 / 无权限 —— 都不是残留证据 */ }
  }
  return hits
}
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// ── 场景分发 ───────────────────────────────────────────────────────────────
// bump 走独立分支：它自己复用 install 场景（以子进程方式调本脚本），所以这里必须先分流，
// 否则会落地一份"真实仓库里的安装演练"再跑 bump。
if (opts.scenario === 'bump') {
  process.exit(await runBumpScenario())
}
if (opts.scenario === 'upgrade') {
  process.exit(await runUpgradeScenario())
}

// ── 前置：读壳地板 + 解析热 runtime + 快照（只读） ─────────────────────────
console.log('dsh:rehearse —— 在临时 runtime 里演练「装候选版本」（真实 runtime 只读）')
const managerSrc = readFileSync(MANAGER, 'utf8')
const floor = /MIN_DSH_VERSION\s*=\s*'([^']+)'/.exec(managerSrc)?.[1] ?? null
if (!floor) {
  console.error('dsh-rehearse: 无法从 scripts/server-manager.mjs 读到 MIN_DSH_VERSION（壳地板）')
  process.exit(3)
}
const targetVersion = opts.version ?? floor

const warmArg = opts.warmStore ?? DEFAULT_WARM_RUNTIME
const warmSource = opts.warmStore ? '--warm-store' : '默认'
// 允许两种给法：runtime 根目录，或 `.pnpm-store` 目录本身。
let warmRuntime = resolve(warmArg)
if (basename(warmRuntime) === '.pnpm-store') warmRuntime = dirname(warmRuntime)
const warmStore = join(warmRuntime, '.pnpm-store')
const warmPnpm = join(warmRuntime, 'node_modules/pnpm/bin/pnpm.cjs')

function preflightFail(msg) {
  console.error(`\ndsh-rehearse: ${msg}\n\n${USAGE}`)
  const result = {
    tool: 'dsh-rehearse', ok: false, phase: 'preflight', error: msg,
    warmRuntime, floor, targetVersion, startedAt: new Date(t0).toISOString(), steps,
  }
  if (opts.json) writeJson(opts.json, result)
  process.exit(3)
}
if (!existsSync(warmRuntime)) {
  preflightFail(`热 runtime 不存在：${warmRuntime}\n  用 --warm-store <dir> 指向本机真实的 dsh runtime（默认路径是 dev 壳数据目录）。`)
}
if (!existsSync(warmStore)) preflightFail(`热 runtime 里没有 .pnpm-store：${warmStore}（没有它就不是"热 store"，装一次要几分钟）`)
if (!existsSync(warmPnpm)) preflightFail(`热 runtime 里没有随包 pnpm：${warmPnpm}`)
for (const f of [MANAGER, PROBE, PATCH_FILE, join(RESOURCE_DIR, 'plugin/@dsh-desktop')]) {
  if (!existsSync(f)) preflightFail(`仓库资源缺失：${f}`)
}

// 真实 runtime 的对照指纹：跑前跑后各取一次，用来自证"没被改过"。
const warmProbeFiles = [
  join(warmRuntime, `node_modules/${DSH_PKG}/package.json`),
  join(warmRuntime, `node_modules/${DSH_PKG}/lib/bin.js`),
  join(warmRuntime, 'package.json'),
  join(warmRuntime, 'manager.log'),
]
const warmBefore = warmProbeFiles.map(fingerprint)

const registry = opts.registry ?? process.env.DSH_DESKTOP_REGISTRY ?? 'https://registry.npmjs.org/'
const registrySource = opts.registry ? '--registry' : (process.env.DSH_DESKTOP_REGISTRY ? 'DSH_DESKTOP_REGISTRY' : '默认（官方源）')
const offline = process.env.npm_config_offline ?? process.env.NPM_CONFIG_OFFLINE ?? null

console.log(`  仓库         ${ROOT}`)
console.log(`  期望版本     ${targetVersion}${opts.version ? '（--version）' : `（壳地板 MIN_DSH_VERSION）`}`)
console.log(`  热 runtime   ${warmRuntime}（${warmSource}；只读，仅软链 .pnpm-store + node_modules/pnpm）`)
console.log(`  registry     ${registry}（${registrySource}；manager 内部还会降级到备用镜像）`)
console.log(`  npm offline  ${offline ?? '(未设置)'}   timeout ${opts.timeoutSec}s`)
console.log('')

// ── 建临时 runtime ─────────────────────────────────────────────────────────
let tmp = null
let installMs = 0
let probeMs = 0
let cleanupMs = 0
let managerInfo = null
let installedVersion = null
let dshEntryOk = null
let registryLatest = null
let probeInfo = { verdict: null, exitCode: null, counts: null, blocking: [], stdoutTail: [] }
let tmpKept = false
let killInfo = { stopReason: null, exit: null, dshWebStarted: false }

const preflightMs = now() - t0
step('preflight', 'ok', preflightMs, `地板 ${floor}；真实 runtime 指纹 ${warmBefore.filter((f) => f.exists).length}/${warmProbeFiles.length} 已记录`)

// --runtime-dir：upgrade 场景复用 install 的积木时，runtime 由调用方建好并装好旧版。
// 校验后**原样使用**：不建软链、不清理（清理权归调用方）。
const providedRuntime = opts.runtimeDir ? resolve(opts.runtimeDir) : null
if (providedRuntime) {
  if (!existsSync(providedRuntime) || !statSync(providedRuntime).isDirectory()) {
    preflightFail(`--runtime-dir 不存在或不是目录：${providedRuntime}`)
  }
  if (providedRuntime === resolve(warmRuntime)) {
    preflightFail('--runtime-dir 不能指向热 runtime（本脚本只读真实 runtime，绝不写它）')
  }
  if (!existsSync(join(providedRuntime, 'node_modules'))) {
    preflightFail(`--runtime-dir 里没有 node_modules（调用方应先装好旧版）：${providedRuntime}`)
  }
  tmp = providedRuntime
  gaps[0] = '本次跑在**已有 runtime**（--runtime-dir，upgrade 场景复用）：走 manager 的兼容闸门升级分支；' +
    '全新安装、isolated→hoisted 布局迁移分支没走到。'
  gaps[2] = 'upgrade 走的是兼容闸门，安装目标恒为壳地板 MIN_DSH_VERSION；--version 只是"期望值"，不一致即 MISMATCH。'
  step('temp-runtime', 'ok', 0, `${tmp}（--runtime-dir：调用方提供，校验后原样使用，不清理）`)
} else {
  tmp = mkdtempSync(join(tmpdir(), 'dsh-rehearse-'))
  {
    const s = now()
    mkdirSync(join(tmp, 'node_modules'), { recursive: true })
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(warmStore, join(tmp, '.pnpm-store'), linkType)
    symlinkSync(join(warmRuntime, 'node_modules/pnpm'), join(tmp, 'node_modules/pnpm'), linkType)
    step('temp-runtime', 'ok', now() - s, `${tmp}（空目录 + 2 条软链）`)
  }
}
console.log(`      临时 runtime ${tmp}`)

// ── 启动 manager，走它自己的启动期自动安装路径 ─────────────────────────────
const managerArgv = [
  MANAGER,
  '--runtime-dir', tmp,
  '--resource-dir', RESOURCE_DIR,
  '--patch', PATCH_FILE,
  '--cwd', tmp, // 生产传的是用户 home；这里指向临时目录，保证任何子进程都不落在仓库/家目录
]
if (opts.registry) managerArgv.push('--registry', opts.registry)
const managerCmdLine = `${process.execPath} ${managerArgv.join(' ')}`
const stdoutLog = join(tmp, 'manager-stdout.jsonl')
const stderrLog = join(tmp, 'manager-stderr.txt')
// 先把两个日志文件建出来：stderr 常常一个字都没有，"保留现场"时也要能看到"空"这个事实，
// 而不是让读报告的人猜这个文件为什么不存在。
writeFileSync(stdoutLog, '')
writeFileSync(stderrLog, '')

/** 让脚本自己被杀时也别留下演练进程树（进程组成员与我们在同一组 ⇒ 连坐，用组杀）。 */
let liveChild = null
function killGroup(sig) {
  if (!liveChild || liveChild.exitCode !== null || liveChild.signalCode !== null) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(liveChild.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-liveChild.pid, sig)
  } catch { /* 已经死了 */ }
}
const selfCleanup = () => { killGroup('SIGKILL') }
process.on('exit', selfCleanup)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { killGroup('SIGKILL'); process.exit(1) })
}

const CURATED = /installing automatically|updating @deepseek-ai\/dsh|updated to |installed @deepseek-ai\/dsh|pnpm installed|installing bundled pnpm|launching dsh web|auto-install dsh failed|fatal|安装失败|Done in|npm latest/
const stdoutTail = []
const stderrTail = []
console.log(`      启动 ${managerCmdLine.replace(ROOT, '.')}`)
// 注意：这里**不能**写 `installMs = await new Promise(...)` —— executor 没有返回值，
// await 的结果是 undefined，会把 finish() 里算好的耗时冲掉（首轮实测打印出 NaNs）。
await new Promise((resolvePromise) => {
  const startedAt = now()
  const child = spawn(process.execPath, managerArgv, {
    cwd: tmp,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // 自成进程组：这样一次 `kill(-pid)` 能带走 manager + pnpm + 万一已经起来的 dsh web。
    detached: process.platform !== 'win32',
  })
  liveChild = child
  let settled = false
  let sawInstallDone = false
  let doneAt = null
  let graceTimer = null
  let lastBeat = 0
  const finish = (reason) => {
    if (settled) return
    settled = true
    killInfo.stopReason = reason
    killInfo.installDoneSeen = sawInstallDone
    clearTimeout(graceTimer)
    clearTimeout(hardTimer)
    installMs = now() - startedAt
    const ok = reason.startsWith('install-status done') || reason === 'launching dsh web'
    const detail = reason === 'launching dsh web'
      ? `install-status done 后 manager 继续走到 supervise —— 在 launching dsh web 处按进程组终止（不让它起服务）`
      : `${reason}；manager pid=${child.pid} 按进程组终止`
    step('install', ok ? 'ok' : 'fail', installMs, detail)
    resolvePromise()
  }
  const hardTimer = setTimeout(() => {
    console.log(`      ⏱ 超时 ${opts.timeoutSec}s —— 终止进程组，如实报失败`)
    killGroup('SIGKILL')
    if (settled) return
    settled = true
    killInfo.stopReason = `timeout ${opts.timeoutSec}s`
    installMs = now() - startedAt
    step('install', 'fail', installMs, `超时 ${opts.timeoutSec}s`)
    resolvePromise()
  }, opts.timeoutSec * 1000)

  const handleLog = (line) => {
    stdoutTail.push(line)
    if (stdoutTail.length > 400) stdoutTail.shift()
    if (CURATED.test(line)) console.log(`      +${fmtS(now() - startedAt)} ${line.slice(0, 200)}`)
    const m = /^npm latest @deepseek-ai\/dsh: (.+)$/.exec(line)
    if (m) registryLatest = m[1]
    if (/auto-install dsh failed/.test(line)) { killGroup('SIGKILL'); finish('auto-install dsh failed') ; return }
    // 逃逸线：manager 已经走到 supervise —— 立刻终止，绝不让它把 dsh web 真起起来。
    if (/launching dsh web/.test(line)) { killGroup('SIGTERM'); finish('launching dsh web') }
  }
  const handleEvent = (obj) => {
    if (obj.t === 'log') { handleLog(String(obj.line ?? '')); return }
    if (obj.t === 'install-status') {
      if (obj.phase === 'start') {
        console.log(`      +${fmtS(now() - startedAt)} install-status start → 目标 ${obj.version}`)
      } else if (obj.phase === 'running') {
        if (now() - lastBeat >= 15000) { lastBeat = now(); console.log(`      +${fmtS(now() - startedAt)} 安装中… ${obj.seconds}s`) }
      } else if (obj.phase === 'done') {
        doneAt = now()
        sawInstallDone = true
        console.log(`      +${fmtS(doneAt - startedAt)} install-status done → ${obj.version}`)
        // 收尾书briefly走完（profile bundles 补回 / 升级标记），但不给 supervise 起服务的机会。
        // 实测 manager 从 done 到 `launching dsh web` 只隔 ~20ms ⇒ 正常都由逃逸线先触发。
        graceTimer = setTimeout(() => { killGroup('SIGTERM'); finish('install-status done') }, POST_INSTALL_GRACE_MS)
      } else if (obj.phase === 'error') {
        killGroup('SIGKILL')
        finish(`install-status error: ${obj.error ?? ''}`.trim())
      }
    } else if (obj.t === 'url') {
      killInfo.dshWebStarted = true
      console.log(`      ⚠ 意外：manager 已起 dsh web（${String(obj.url).replace(/token=[^&]+/, 'token=***')}）—— 立即终止`)
      killGroup('SIGKILL')
      finish('dsh web started (killed)')
    }
  }
  let buf = ''
  child.stdout.on('data', (d) => {
    appendFileSync(stdoutLog, d)
    buf += String(d)
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let obj = null
      try { obj = JSON.parse(line) } catch { /* 非 JSON 行原样当日志 */ }
      if (obj && typeof obj === 'object' && obj.t) handleEvent(obj)
      else handleLog(line)
    }
  })
  child.stderr.on('data', (d) => {
    appendFileSync(stderrLog, d)
    for (const l of String(d).split(/\r?\n/)) if (l.trim()) { stderrTail.push(l); if (stderrTail.length > 200) stderrTail.shift() }
  })
  child.on('exit', (code, signal) => {
    killInfo.exit = { code, signal }
    if (!settled) finish(`manager 提前退出 rc=${code} signal=${signal ?? '-'}`)
  })
  child.stdin.on('error', () => { /* 进程已退 */ })
})

// 等它真的死掉（组杀后仍持有 stdio 的话会拖住日志落盘）。注意：被信号杀死的进程
// exitCode 恒为 null、只有 signalCode 有值 —— 两个都要看，否则会白等一个 grace。
await new Promise((r) => {
  const child = liveChild
  if (!child || child.exitCode !== null || child.signalCode !== null) return r()
  const timer = setTimeout(() => { killGroup('SIGKILL'); r() }, KILL_GRACE_MS)
  child.on('exit', () => { clearTimeout(timer); r() })
})

// ── 断言落地版本 ───────────────────────────────────────────────────────────
const installedPkg = join(tmp, `node_modules/${DSH_PKG}/package.json`)
installedVersion = readJson(installedPkg)?.version ?? null
dshEntryOk = existsSync(join(tmp, `node_modules/${DSH_PKG}/lib/bin.js`))
{
  const s = now()
  const ok = installedVersion === targetVersion && dshEntryOk
  step('version-assert', ok ? 'ok' : 'fail', now() - s,
    `落地 ${installedVersion ?? '(未装上)'} vs 期望 ${targetVersion}${dshEntryOk ? '' : '；且缺 lib/bin.js（半装）'}`)
}

// ── 探针 ───────────────────────────────────────────────────────────────────
{
  const s = now()
  const probeJson = join(tmp, 'probe.json')
  // 适配前（target ≠ 当前地板）那两条版本一致性判据必然 RED，用探针的**演练假设值**换掉它们的
  // 期望值；下面还要断言假设确实生效（见 rehearsalOk），否则等于"没演练却判绿"。
  const greenExpected = targetVersion === floor
  const probeArgs = [PROBE, '--runtime', tmp, '--json', probeJson]
  if (!greenExpected) probeArgs.push('--assume-floor', targetVersion, '--assume-fixture', targetVersion)
  let exitCode = 0
  let wrote = false
  try {
    const out = execFileSync(process.execPath, probeArgs,
      { encoding: 'utf8', timeout: Math.max(300_000, opts.timeoutSec * 1000), maxBuffer: 64 * 1024 * 1024 })
    probeInfo.stdoutTail = out.trim().split('\n').slice(-14)
    wrote = true
  } catch (err) {
    exitCode = typeof err.status === 'number' ? err.status : -1
    const out = `${err.stdout ?? ''}`
    probeInfo.stdoutTail = out.trim() ? out.trim().split('\n').slice(-14) : [`(探针无 stdout；${err.message}）`.slice(0, 200)]
    wrote = existsSync(probeJson)
  }
  const report = readJson(probeJson)
  const assumed = report?.assumed ?? {}
  probeInfo.exitCode = exitCode
  probeInfo.verdict = report?.verdict ?? (/verdict = (\w+)/.exec(probeInfo.stdoutTail.join('\n'))?.[1]?.toLowerCase() ?? null)
  probeInfo.counts = report?.counts ?? null
  probeInfo.blocking = (report?.findings ?? []).filter((f) => f.sev !== 'info').map((f) => ({ sev: f.sev, id: f.id, msg: f.msg }))
  probeInfo.rehearsal = report?.rehearsal ?? null
  probeInfo.assumed = { floor: assumed.floor ?? null, fixture: assumed.fixture ?? null }
  probeMs = now() - s
  // 报告缺失 = 探针没跑成 = **不能**算通过（"没有判断 = 没有验证"）。旧实现在 target≠floor 时
  // 会把「没有报告」读成 verdict=null 再落进 `!== 'red'` 分支 ⇒ 探针崩溃也能假绿。
  const missingReport = !report
  // 演练假设必须可证明生效，两个方向都拦：该带没带 ⇒ 假演练；不该带却带了 ⇒ 真实校验被污染。
  const rehearsalOk = greenExpected
    ? report?.rehearsal !== true
    : (report?.rehearsal === true && probeInfo.assumed.floor === targetVersion && probeInfo.assumed.fixture === targetVersion)
  const verdictOk = !missingReport && rehearsalOk &&
    (greenExpected ? probeInfo.verdict === 'green' : probeInfo.verdict !== 'red')
  const provenance = greenExpected
    ? ''
    : `（演练假设：地板/夹具期望值 = ${targetVersion}；rehearsal=${JSON.stringify(probeInfo.rehearsal)}、` +
      `assumed.floor=${JSON.stringify(probeInfo.assumed.floor)}、assumed.fixture=${JSON.stringify(probeInfo.assumed.fixture)}）`
  step('probe', verdictOk ? 'ok' : 'fail', probeMs,
    missingReport ? '探针没有产出报告（探针失败 ≠ 通过）' : `verdict=${(probeInfo.verdict ?? '?').toUpperCase()} exit=${exitCode}${provenance}`)
  for (const f of probeInfo.blocking) console.log(`        [${f.sev.toUpperCase()}] ${f.id}: ${f.msg}`)
}

// ── 真实 runtime 自证 + 残留进程自证 ───────────────────────────────────────
const warmAfter = warmProbeFiles.map(fingerprint)
const warmDiff = warmBefore.map((b, i) => ({
  path: b.path,
  same: b.exists === warmAfter[i].exists && b.sha256 === warmAfter[i].sha256 &&
    b.mtimeMs === warmAfter[i].mtimeMs && b.size === warmAfter[i].size,
  before: b, after: warmAfter[i],
}))
const warmUnchanged = warmDiff.every((d) => d.same)
step('warm-unchanged', warmUnchanged ? 'ok' : 'fail', 0,
  warmUnchanged ? `真实 runtime ${warmDiff.length} 处指纹（sha256+mtime+size）全部一致`
    : `被改动：${warmDiff.filter((d) => !d.same).map((d) => d.path).join(', ')}`)
const leftovers = listProcsMatching(tmp)
step('no-leftover-procs', leftovers === null ? 'skip' : (leftovers.length === 0 ? 'ok' : 'fail'), 0,
  leftovers === null ? '非 Linux，未做 /proc 枚举（请看报告里的 ps 证据）'
    : (leftovers.length === 0 ? '无进程引用临时 runtime（/proc/*/cmdline 全扫）' : `${leftovers.length} 个残留：${leftovers.map((p) => p.pid).join(', ')}`))

// ── 清理 ───────────────────────────────────────────────────────────────────
const failed = steps.some((s) => s.status === 'fail')
tmpKept = opts.keep || failed || providedRuntime !== null
{
  const s = now()
  if (tmpKept) {
    const why = providedRuntime !== null ? '--runtime-dir（调用方所有，永不清理）' : (opts.keep ? '--keep' : '失败保留现场')
    step('cleanup', 'skip', 0, `${why}：${tmp}`)
  } else {
    rmSync(tmp, { recursive: true, force: true }) // 只删临时目录；两条软链被 unlink，不跟随
    step('cleanup', existsSync(tmp) ? 'fail' : 'ok', now() - s, '临时目录已删（软链只删链、不跟随）')
  }
  cleanupMs = now() - s
}

// 清理后复检一次：确认 rm 没有跟着软链动到真实 runtime（最坏情况的兜底证据）。
const warmAfterCleanup = warmProbeFiles.map(fingerprint)
const warmStillOk = warmDiff.every((d, i) =>
  warmAfterCleanup[i].exists === d.before.exists && warmAfterCleanup[i].sha256 === d.before.sha256)

// ── 结论 ───────────────────────────────────────────────────────────────────
const mismatch = installedVersion !== targetVersion
// 版本不一致时补一次诊断：启动期路径的目标 = max(地板, registry latest)，把 latest 查出来
// 才能说清"为什么装成了这个版本"。best-effort：查不到就如实说查不到（不编数字）。
let registryLatestSource = registryLatest ? 'manager 日志（npm latest 行）' : null
if (mismatch && !registryLatest) {
  try {
    const out = execFileSync('npm', ['view', DSH_PKG, 'dist-tags', '--json', '--registry', registry],
      { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] })
    const parsed = JSON.parse(out)
    const latest = typeof parsed === 'string' ? parsed : parsed?.['dist-tags']?.latest ?? parsed?.latest ?? null
    if (typeof latest === 'string') { registryLatest = latest; registryLatestSource = `npm view（best-effort，${registry}）` }
  } catch { /* 查不到就留 null */ }
}
let status
if (!warmUnchanged || !warmStillOk) status = 'FAILED' // 真实 runtime 被动过 = 最严重，优先报
else if (mismatch && installedVersion) status = 'MISMATCH'
else if (failed) status = 'FAILED'
else if (probeInfo.verdict === 'green') status = 'GREEN'
else status = String(probeInfo.verdict ?? 'unknown').toUpperCase()
const totalMs = now() - t0

/** 诚实标注的边界（不是失败，但读结论时必须知道）。 */
const caveats = [
  `热 store 是**软链共享**的：pnpm 可能往真实 runtime 的 .pnpm-store 追加内容寻址条目（只增不删）；` +
  `已装树（node_modules/${DSH_PKG}/*）与 manager.log 的指纹已逐一自证未变。`,
  `启动期自动安装路径的目标版本 = max(壳地板 ${floor}, registry latest)——结构上不可注入任意版本，` +
  `--version 只是"期望值"（不一致即报 MISMATCH）。`,
]
if (killInfo.dshWebStarted) caveats.push('本次演练意外让 manager 走到了 supervise 并起了 dsh web（已立即杀掉；临时 runtime 内，未影响真实实例）。')

console.log('')
console.log('  ── 每步耗时 ─────────────────────────────────────────────')
console.log(`  install（manager 启动→装完）  ${fmtS(installMs).padStart(8)}`)
console.log(`  probe（dsh-compat-probe）    ${fmtS(probeMs).padStart(8)}`)
console.log(`  其它（前置/临时目录/清理）    ${fmtS(totalMs - installMs - probeMs).padStart(8)}`)
console.log(`  total                        ${fmtS(totalMs).padStart(8)}`)
for (const g of gaps) console.log(`  ⚠ ${g}`)
const conclusion = status === 'GREEN'
  ? `GREEN — 临时 runtime 装到 ${installedVersion}（== 期望 ${targetVersion}），探针 green(exit 0)，真实 runtime 指纹未变，无残留进程`
  : (status === 'MISMATCH'
    ? `MISMATCH — 期望 ${targetVersion}，实际落地 ${installedVersion}` +
      (registryLatest ? `；manager 的启动期路径目标 = max(地板 ${floor}, registry latest ${registryLatest})` : '') +
      `，该路径不接受外部指定版本；探针 verdict=${(probeInfo.verdict ?? '?').toUpperCase()}`
    : `FAILED — ${steps.filter((s) => s.status === 'fail').map((s) => `${s.name}(${s.detail})`).join('；')}`)
console.log(`  结论: ${conclusion}`)
for (const c of caveats) console.log(`  说明: ${c}`)
if (tmpKept) console.log(`  现场保留：${tmp}（manager-stdout.jsonl / manager-stderr.txt / manager.log / probe.json）`)
if (stderrTail.length) console.log(`  stderr 尾部：${stderrTail.slice(-3).join(' | ').slice(0, 300)}`)
if (stdoutTail.length && status !== 'GREEN') console.log(`  日志尾部：\n${stdoutTail.slice(-8).map((l) => `    ${String(l).slice(0, 220)}`).join('\n')}`)

const result = {
  tool: 'dsh-rehearse',
  ok: status === 'GREEN',
  status,
  conclusion,
  repo: ROOT,
  startedAt: new Date(t0).toISOString(),
  finishedAt: new Date().toISOString(),
  floorVersion: floor,
  targetVersion,
  targetSource: opts.version ? '--version' : 'MIN_DSH_VERSION',
  installedVersion,
  registryLatest,
  registryLatestSource,
  registry,
  registrySource,
  npmOffline: offline,
  timeoutSec: opts.timeoutSec,
  warmRuntime,
  warmRuntimeSource: warmSource,
  warmUnchanged,
  // 完整指纹（内容哈希 + mtime + size）留在 JSON 里：报告里的"没被改动"必须能被第三方复核，
  // 只写一个 same:true 等于自证。
  warmFingerprints: warmDiff.map((d) => ({ path: d.path, same: d.same, before: d.before, after: d.after })),
  warmStillOkAfterCleanup: warmStillOk,
  manager: { command: managerCmdLine, ...killInfo, stderrTail: stderrTail.slice(-10) },
  steps,
  timings: { preflightMs, installMs, probeMs, cleanupMs, totalMs },
  probe: probeInfo,
  tmpDir: tmp,
  kept: tmpKept,
  removed: !tmpKept && !existsSync(tmp),
  leftoverProcs: leftovers,
  logTail: stdoutTail.slice(-20),
  caveats,
  gaps,
}
writeJson(opts.json, result)
process.exit(status === 'GREEN' ? 0 : 1)

// ══ 场景 bump：在 /tmp 克隆里演练「抬地板」全链路 ══════════════════════════════
// 步骤与五项断言见文件头。两条纪律：
//   1) 真实仓库只读：地板 / README / 夹具的改写全部发生在 clone 里，跑前跑后用
//      sha256+mtime+size 指纹逐一自证 —— 尤其 scripts/fixtures/dsh-web-app-patch-ids.json，
//      它最容易被"脚本写的是克隆里那份"这个假设掩盖。
//   2) 任一步 / 任一断言不达标 ⇒ exit 1，绝不把"没跑成"报成通过。
/** 记录层豁免：与看板同属会话记录，不算脏；每次运行都把豁免明细打印出来，不静默。 */
function bumpExemptWhy(entry) {
  if (BUMP_EXEMPT_EXACT.has(entry.path)) return '看板/笔记索引'
  if (entry.code !== '??') return null
  if (entry.path === 'tools' || entry.path.startsWith('tools/')) return '未跟踪 tools/'
  if (entry.path.startsWith('.agents/notes/')) return '未跟踪 Agent Note（记录层）'
  return null
}
/** 真实仓库的非记录层改动清单（porcelain v1 + -z；改名/复制条目占两个 NUL 字段）。 */
function bumpRepoStatus() {
  const out = execFileSync('git', ['-C', ROOT, 'status', '--porcelain=v1', '-z'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const fields = out.split('\0')
  const entries = []
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    if (!f) continue
    const code = f.slice(0, 2)
    const path = f.slice(3)
    entries.push({ code, path })
    if (/[RC]/.test(code)) { const renamed = fields[++i]; if (renamed) entries.push({ code: '=>', path: renamed }) }
  }
  const exempt = []
  const dirty = []
  for (const e of entries) {
    if (e.code === '=>') continue
    const why = bumpExemptWhy(e)
    if (why) exempt.push({ ...e, why })
    else dirty.push(e)
  }
  return { entries, exempt, dirty }
}
/** 语义化版本比较（与 manager / probe 的 preOrder 同口径：无 prerelease > 有 prerelease）。 */
function bumpCmpVer(a, b) {
  const parse = (v) => {
    const s = String(v).replace(/^v/, '')
    const dash = s.indexOf('-')
    return {
      core: (dash < 0 ? s : s.slice(0, dash)).split('.').map(Number),
      pre: dash < 0 ? [] : s.slice(dash + 1).split('.'),
    }
  }
  const A = parse(a)
  const B = parse(b)
  for (let i = 0; i < 3; i++) {
    const x = A.core[i] ?? 0
    const y = B.core[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (!A.pre.length && !B.pre.length) return 0
  if (!A.pre.length) return 1
  if (!B.pre.length) return -1
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i]
    const y = B.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1; continue }
    if (nx !== ny) return nx ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}
/** 跑子进程：输出按行前缀转发到本脚本 stdout，同时完整捕获（断言要取实际值）。 */
function bumpSpawn(cmd, args, spawnOpts = {}) {
  return new Promise((resolvePromise) => {
    const label = spawnOpts.label ?? null
    const child = spawn(cmd, args, { cwd: spawnOpts.cwd ?? ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const captured = { stdout: '', stderr: '' }
    let settled = false
    const done = (payload) => { if (!settled) { settled = true; resolvePromise(payload) } }
    for (const key of ['stdout', 'stderr']) {
      const stream = child[key]
      stream.setEncoding('utf8')
      let carry = ''
      stream.on('data', (text) => {
        captured[key] += text
        if (!label) return
        carry += text
        const lines = carry.split('\n')
        carry = lines.pop() ?? ''
        for (const l of lines) {
          if (!l.trim()) continue
          if (spawnOpts.filter && !spawnOpts.filter.test(l)) continue
          console.log(`      ${label}| ${l.slice(0, 220)}`)
        }
      })
      stream.on('end', () => {
        if (label && carry.trim() && (!spawnOpts.filter || spawnOpts.filter.test(carry))) {
          console.log(`      ${label}| ${carry.slice(0, 220)}`)
        }
      })
    }
    child.on('error', (err) => done({ code: -1, signal: null, error: err.message, stdout: captured.stdout, stderr: captured.stderr }))
    child.on('close', (code, signal) => done({ code: code ?? -1, signal, error: null, stdout: captured.stdout, stderr: captured.stderr }))
  })
}
/** 只删自己建的临时目录（路径必须落在 tmpdir，且自身或父目录带 dsh-rehearse 前缀）。 */
function bumpOwnsTempDir(p) {
  if (!p) return false
  const abs = resolve(p)
  if (!abs.startsWith(resolve(tmpdir()) + '/')) return false
  return basename(abs).startsWith('dsh-rehearse') || basename(dirname(abs)).startsWith('dsh-rehearse')
}

async function runBumpScenario() {
  steps.length = 0
  const tBump = now()
  const timing = { cloneMs: 0, setupMs: 0, installMs: 0, adaptMs: 0, assertMs: 0, cleanupMs: 0, totalMs: 0 }
  const versionRe = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
  const fromFloor = opts.fromFloor ?? BUMP_DEFAULT_FROM_FLOOR
  const realFloor = /MIN_DSH_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(MANAGER, 'utf8'))?.[1] ?? null
  const target = opts.version ?? realFloor
  let bumpRoot = null
  let cloneDir = null
  let runtimeDir = null
  let installJsonPath = null
  let installChild = null
  let installChildExit = null
  let readmeHits = 0
  let repoExempt = []
  let adaptResult = { code: null, signal: null, gateLine: null, outputTail: [] }
  const asserts = {}
  const realFingerprints = {}
  let status = 'PREFLIGHT'
  let errorMsg = null
  let kept = false

  const emit = (code, st) => {
    status = st
    timing.totalMs = now() - tBump
    const anyFail = steps.some((s) => s.status === 'fail')
    kept = opts.keep || anyFail
    const result = {
      tool: 'dsh-rehearse', scenario: 'bump', ok: code === 0, status, error: errorMsg,
      repo: ROOT, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString(),
      floorVersion: realFloor, targetVersion: target, fromFloor,
      targetSource: opts.version ? '--version' : 'MIN_DSH_VERSION',
      cloneDir, runtimeDir, installJson: installJsonPath,
      readmeReplaced: readmeHits,
      installChild: installChild
        ? {
          exitCode: installChildExit, status: installChild.status, installedVersion: installChild.installedVersion,
          registryLatest: installChild.registryLatest, probe: installChild.probe,
          tmpDir: installChild.tmpDir, kept: installChild.kept,
        }
        : null,
      adapt: adaptResult,
      asserts, realFingerprints, repoStatusExempt: repoExempt,
      steps, timings: timing, kept, gaps: BUMP_GAPS,
    }
    writeJson(opts.json, result)
    console.log('')
    if (code === 0) {
      console.log(`  结论: GREEN — 克隆里 ${realFloor} → ${target} 的抬地板全链路走通（dsh-adapt exit 0 + 五项断言全绿），真实仓库零改动`)
    } else {
      console.log(`  结论: ${status} — ${errorMsg ?? steps.filter((s) => s.status === 'fail').map((s) => `${s.name}(${s.detail})`).join('；')}`)
    }
    for (const g of BUMP_GAPS) console.log(`  ⚠ ${g}`)
    if (kept) console.log(`  现场保留：clone=${cloneDir ?? '-'}  runtime=${runtimeDir ?? '-'}`)
    return code
  }

  console.log('dsh:rehearse --scenario bump —— 在 /tmp 克隆里演练「抬地板」全链路（真实仓库只读）')
  console.log(`  目标版本     ${target}${opts.version ? '（--version）' : '（真实仓库地板 MIN_DSH_VERSION）'}`)
  console.log(`  演练起始地板 ${fromFloor}${opts.fromFloor ? '（--from-floor）' : `（默认 ${BUMP_DEFAULT_FROM_FLOOR}）`}`)
  console.log('')

  // ── 语义前置（exit 2）────────────────────────────────────────────────────
  const usageErr = (msg) => console.error(`\ndsh-rehearse --scenario bump: ${msg}\n\n${USAGE}`)
  if (!realFloor) {
    errorMsg = '读不到真实仓库地板 MIN_DSH_VERSION'
    usageErr(`${errorMsg}（${MANAGER}）`)
    return emit(3, 'PREFLIGHT')
  }
  if (!versionRe.test(target)) { errorMsg = `--version 不是合法版本号：${target}`; usageErr(errorMsg); return emit(2, 'USAGE') }
  if (!versionRe.test(fromFloor)) { errorMsg = `--from-floor 不是合法版本号：${fromFloor}`; usageErr(errorMsg); return emit(2, 'USAGE') }
  if (bumpCmpVer(target, fromFloor) <= 0) {
    errorMsg = `目标 ${target} 不高于 --from-floor ${fromFloor}`
    usageErr(`${errorMsg} —— bump 演练的是"把地板抬上去"；低于/持平会让 dsh-adapt 第 2/3 步静默 skip（假演练），拒绝执行。\n  想抬到更低的地板？那是另一件事，请显式给出更低的 --from-floor（必须低于目标）。`)
    return emit(2, 'USAGE')
  }

  // ── 前置：热 runtime（exit 3）────────────────────────────────────────────
  const warmArg = opts.warmStore ?? DEFAULT_WARM_RUNTIME
  let warmRuntime = resolve(warmArg)
  if (basename(warmRuntime) === '.pnpm-store') warmRuntime = dirname(warmRuntime)
  const warmMissing = [
    [warmRuntime, '热 runtime 不存在'],
    [join(warmRuntime, '.pnpm-store'), '缺 .pnpm-store（不是热 store）'],
    [join(warmRuntime, 'node_modules/pnpm/bin/pnpm.cjs'), '缺随包 pnpm'],
  ].filter(([p]) => !existsSync(p))
  if (warmMissing.length) {
    errorMsg = '热 runtime 前置不满足'
    console.error(`\ndsh-rehearse --scenario bump: ${errorMsg} —— ${warmMissing.map(([p, w]) => `${w}：${p}`).join('；')}\n  用 --warm-store <dir> 指向本机真实的 dsh runtime。`)
    return emit(3, 'PREFLIGHT')
  }

  // ── 前置：真实仓库干净（exit 3）+ 关键文件指纹 ────────────────────────────
  for (const [name, file] of Object.entries(BUMP_REAL_FILES)) realFingerprints[name] = { before: fingerprint(file) }
  let repoStatus
  try {
    repoStatus = bumpRepoStatus()
  } catch (err) {
    errorMsg = `git status 读不到：${err.message}`
    console.error(`\ndsh-rehearse --scenario bump: ${errorMsg}（${ROOT} 是 git 仓库吗？）`)
    return emit(3, 'PREFLIGHT')
  }
  repoExempt = repoStatus.exempt
  if (repoExempt.length) {
    console.log(`  记录层豁免（不算脏）：${repoExempt.map((e) => `${e.code} ${e.path}（${e.why}）`).join('；')}`)
  }
  if (repoStatus.dirty.length) {
    errorMsg = `真实仓库有 ${repoStatus.dirty.length} 处非记录层改动`
    console.error(`\ndsh-rehearse --scenario bump: ${errorMsg} ⇒ exit 3（不带脏状态演练）：`)
    for (const d of repoStatus.dirty) console.error(`  ${d.code} ${d.path}`)
    console.error('  请先提交或还原这些改动（本脚本不执行任何 git 写操作）。')
    return emit(3, 'PREFLIGHT')
  }
  step('bump-preflight', 'ok', now() - tBump,
    `真实仓库非记录层改动 0 条（豁免 ${repoExempt.length} 条记录层）；${Object.keys(BUMP_REAL_FILES).length} 份关键文件指纹已记录；目标 ${target} > 起始地板 ${fromFloor}`)

  // ── 1. clone ─────────────────────────────────────────────────────────────
  bumpRoot = mkdtempSync(join(tmpdir(), 'dsh-rehearse-bump-'))
  cloneDir = join(bumpRoot, 'repo')
  {
    const s = now()
    let cloneError = null
    try {
      execFileSync('git', ['clone', '--local', '--shared', ROOT, cloneDir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 })
    } catch (err) {
      cloneError = String(err.stderr ?? err.message ?? err).trim().split('\n').slice(-2).join(' | ').slice(0, 240)
    }
    if (cloneError) { step('clone', 'fail', now() - s, `git clone 失败：${cloneError}`); errorMsg = 'clone 失败'; return emit(1, 'FAILED') }
    let logLine = null
    try {
      logLine = execFileSync('git', ['-C', cloneDir, 'log', '-1', '--oneline'], { encoding: 'utf8' }).trim()
    } catch (err) { /* 下面按失败处理 */ }
    timing.cloneMs = now() - s
    if (!logLine) { step('clone', 'fail', timing.cloneMs, `克隆里 git log 读不到（${cloneDir}）`); errorMsg = '克隆里 git log 不可用'; return emit(1, 'FAILED') }
    step('clone', 'ok', timing.cloneMs, `${cloneDir}；git log: ${logLine.slice(0, 90)}`)
  }

  // ── 2. 降到 --from-floor（只在克隆里）────────────────────────────────────
  {
    const s = now()
    const cloneFloors = ['scripts/server-manager.mjs', 'src-tauri/resources/manager/server-manager.mjs']
    for (const rel of cloneFloors) {
      const file = join(cloneDir, rel)
      const text = readFileSync(file, 'utf8')
      const cur = /MIN_DSH_VERSION\s*=\s*'([^']+)'/.exec(text)?.[1] ?? null
      if (cur !== realFloor) {
        step('from-floor', 'fail', now() - s, `${rel} 的地板是 ${cur ?? '(读不到)'}，不是真实仓库的 ${realFloor}（克隆与工作区不一致？）`)
        errorMsg = '克隆里的地板与真实仓库不一致'
        return emit(1, 'FAILED')
      }
      writeFileSync(file, text.replace(`const MIN_DSH_VERSION = '${realFloor}'`, `const MIN_DSH_VERSION = '${fromFloor}'`))
    }
    const cloneReadme = readFileSync(join(cloneDir, 'README.md'), 'utf8')
    readmeHits = cloneReadme.split(realFloor).length - 1
    if (readmeHits === 0) {
      step('from-floor', 'fail', now() - s, `克隆 README 里找不到真实地板 ${realFloor} ⇒ "README 被替换"这条断言会失真`)
      errorMsg = 'README 里找不到真实地板'
      return emit(1, 'FAILED')
    }
    writeFileSync(join(cloneDir, 'README.md'), cloneReadme.split(realFloor).join(fromFloor))
    timing.setupMs = now() - s
    step('from-floor', 'ok', timing.setupMs, `克隆内两份 manager 地板 + README ${readmeHits} 处：${realFloor} → ${fromFloor}`)
    console.log(`  ⚠ 演练 setup：地板被降到 ${fromFloor}（只在克隆 ${cloneDir} 内；真实仓库未动）——目标 ${target} 高于它，`)
    console.log('     所以 dsh-adapt 的第 2/3/4 步会真的执行而不是 skip。')
  }

  // ── 3. 复用 install 场景装目标版本 ───────────────────────────────────────
  {
    const s = now()
    installJsonPath = join(bumpRoot, 'install.json')
    const selfArgs = [fileURLToPath(import.meta.url), '--scenario', 'install', '--version', target, '--keep', '--json', installJsonPath, '--timeout', String(opts.timeoutSec)]
    if (opts.warmStore) selfArgs.push('--warm-store', opts.warmStore)
    if (opts.registry) selfArgs.push('--registry', opts.registry)
    const out = await bumpSpawn(process.execPath, selfArgs, { label: 'install' })
    installChildExit = out.code
    installChild = readJson(installJsonPath)
    timing.installMs = now() - s
    if (!installChild) {
      step('install', 'fail', timing.installMs, `install 场景没有写出 JSON（exit=${out.code}）⇒ 不能断言落地版本`)
      errorMsg = 'install 场景未产出 JSON'
      return emit(1, 'FAILED')
    }
    runtimeDir = installChild.tmpDir ?? null
    const landed = installChild.installedVersion ?? null
    if (out.code !== 0 || landed !== target || !runtimeDir) {
      const why = landed === target ? `install 子进程 exit=${out.code}（status=${installChild.status}）` : `落地 ${landed ?? '(未装上)'} ≠ 目标 ${target}`
      step('install', 'fail', timing.installMs, `${why}${installChild.registryLatest ? `；manager 目标 = max(地板 ${installChild.floorVersion}, registry latest ${installChild.registryLatest})` : ''}`)
      console.log(`      install 场景 JSON：${installJsonPath}${runtimeDir ? `；临时 runtime：${runtimeDir}` : ''}`)
      errorMsg = `install 场景未装到目标版本（${why}）`
      return emit(1, 'FAILED')
    }
    step('install', 'ok', timing.installMs,
      `复用 install 场景：临时 runtime ${runtimeDir}，落地 ${landed} == 目标（install exit 0，probe ${String(installChild.probe?.verdict ?? '?').toUpperCase()}）`)
  }

  // ── 4. 在克隆里跑 dsh-adapt（不加 --dry-run）──────────────────────────────
  // 克隆里的 Cargo.lock 可能落后于 Cargo.toml（release-please 漏改派生物）：dsh-adapt 第 7 步会像 CI 的
  // test 作业那样**先 sync 再跑链**，所以 bump 在这里自动继承"门禁前的锁同步"——rehearse 自己不再重复跑
  // （否则两处逻辑漂移，演练就不再等价于真实运行）。sync 的实际输出收进 JSON，作为"确实继承到了"的证据。
  {
    const s = now()
    const out = await bumpSpawn(process.execPath, [join(cloneDir, 'scripts/dsh-adapt.mjs'), '--version', target, '--runtime', runtimeDir], { cwd: cloneDir, label: 'adapt' })
    timing.adaptMs = now() - s
    const lines = out.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    adaptResult = {
      code: out.code, signal: out.signal ?? null,
      gateLine: lines.filter((l) => /全量门禁/.test(l)).slice(-1)[0] ?? null,
      syncLine: lines.filter((l) => /前置 sync Cargo\.lock/.test(l)).slice(-1)[0] ?? null,
      outputTail: lines.slice(-12),
      stderrTail: out.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 240),
    }
    step('adapt', out.code === 0 ? 'ok' : 'fail', timing.adaptMs,
      `克隆内 dsh-adapt（无 --dry-run）exit=${out.code}${adaptResult.gateLine ? `；${adaptResult.gateLine.replace(/^\[\s*\w+\s*\]\s*/, '').slice(0, 160)}` : ''}`)
  }

  // ── 5. 五项断言（实际值全部打印进报告）──────────────────────────────────
  {
    const s = now()
    // ① 克隆两份地板 == 目标 且 node --check 通过
    const floorRows = ['scripts/server-manager.mjs', 'src-tauri/resources/manager/server-manager.mjs'].map((rel) => {
      const file = join(cloneDir, rel)
      const floorNow = /MIN_DSH_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(file, 'utf8'))?.[1] ?? null
      const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
      return { rel, floorNow, checkExit: check.status }
    })
    const ok1 = floorRows.every((r) => r.floorNow === target && r.checkExit === 0)
    asserts.floors = { ok: ok1, values: floorRows.map((r) => `${r.rel}=${r.floorNow ?? '(读不到)'}(node --check exit=${r.checkExit})`) }
    step('assert-1-floors', ok1 ? 'ok' : 'fail', 0, asserts.floors.values.join('；'))

    // ② 克隆 README：降下去的那份旧地板被 dsh-adapt 换成目标
    const readmeAfter = readFileSync(join(cloneDir, 'README.md'), 'utf8')
    const oldLeft = readmeAfter.split(fromFloor).length - 1
    const targetNow = readmeAfter.split(target).length - 1
    const ok2 = oldLeft === 0 && targetNow >= readmeHits
    asserts.readme = { ok: ok2, replaced: readmeHits, oldFloorLeft: oldLeft, targetOccurrences: targetNow }
    step('assert-2-readme', ok2 ? 'ok' : 'fail', 0,
      `旧地板 ${fromFloor} 被替换 ${readmeHits} 处 → ${target}；替换后残留 ${fromFloor} ${oldLeft} 处、${target} 现 ${targetNow} 处`)

    // ③ 克隆夹具（--update-fixture 写的是克隆里那份）
    const cloneFixturePath = join(cloneDir, 'scripts/fixtures/dsh-web-app-patch-ids.json')
    const cloneFixture = readJson(cloneFixturePath)
    const fixtureIds = Array.isArray(cloneFixture?.ids) ? cloneFixture.ids.length : null
    const ok3 = cloneFixture?.dshVersion === target && typeof fixtureIds === 'number'
    asserts.fixture = { ok: ok3, path: cloneFixturePath, dshVersion: cloneFixture?.dshVersion ?? null, ids: fixtureIds, sha256: sha256(cloneFixturePath) }
    step('assert-3-fixture', ok3 ? 'ok' : 'fail', 0,
      `克隆夹具 dshVersion=${cloneFixture?.dshVersion ?? '(读不到)'}（期望 ${target}），${fixtureIds ?? '?'} 个 id`)

    // ④ 真实仓库夹具未变（最关键的一条：证明写的是克隆里那份）
    const realFixturePath = BUMP_REAL_FILES['scripts/fixtures/dsh-web-app-patch-ids.json']
    const realFixtureAfter = fingerprint(realFixturePath)
    const realFixtureBefore = realFingerprints['scripts/fixtures/dsh-web-app-patch-ids.json'].before
    realFingerprints['scripts/fixtures/dsh-web-app-patch-ids.json'].after = realFixtureAfter
    const ok4 = realFixtureBefore.exists && realFixtureAfter.exists &&
      realFixtureAfter.sha256 === realFixtureBefore.sha256 &&
      realFixtureAfter.mtimeMs === realFixtureBefore.mtimeMs &&
      realFixtureAfter.size === realFixtureBefore.size
    asserts.realFixture = {
      ok: ok4, path: realFixturePath, before: realFixtureBefore.sha256, after: realFixtureAfter.sha256,
      mtimeSame: realFixtureAfter.mtimeMs === realFixtureBefore.mtimeMs,
      cloneSha256: asserts.fixture.sha256,
    }
    step('assert-4-real-fixture', ok4 ? 'ok' : 'fail', 0,
      `真实夹具 sha256 ${String(realFixtureBefore.sha256).slice(0, 12)}… → ${String(realFixtureAfter.sha256).slice(0, 12)}…（mtime/size 同）；克隆那份 sha256 ${String(asserts.fixture.sha256).slice(0, 12)}…`)

    // ⑤ 真实仓库非记录层 status 为空 + 其余关键文件指纹未变
    let statusAfter = null
    let statusError = null
    try {
      statusAfter = bumpRepoStatus()
    } catch (err) { statusError = err.message }
    let filesUnchanged = 0
    const changedFiles = []
    for (const [name, file] of Object.entries(BUMP_REAL_FILES)) {
      const after = fingerprint(file)
      realFingerprints[name].after = after
      const before = realFingerprints[name].before
      const same = before.exists === after.exists && before.sha256 === after.sha256 && before.mtimeMs === after.mtimeMs && before.size === after.size
      if (same) filesUnchanged += 1
      else changedFiles.push(name)
    }
    const ok5 = statusAfter !== null && statusAfter.dirty.length === 0 && filesUnchanged === Object.keys(BUMP_REAL_FILES).length
    asserts.realRepo = {
      ok: ok5, dirty: statusAfter?.dirty ?? null, statusError,
      exempt: statusAfter?.exempt ?? [],
      filesUnchanged, filesTotal: Object.keys(BUMP_REAL_FILES).length, changedFiles,
    }
    step('assert-5-real-repo', ok5 ? 'ok' : 'fail', 0,
      `非记录层 status ${statusAfter ? `${statusAfter.dirty.length} 条` : `读不到（${statusError}）`}；关键文件指纹 ${filesUnchanged}/${Object.keys(BUMP_REAL_FILES).length} 未变`)
    timing.assertMs = now() - s

    console.log('')
    console.log('  ── bump 五项断言（实际值）────────────────────────────────')
    console.log(`  ① 克隆地板    ${(asserts.floors.values ?? []).join('；')}  ⇒ ${asserts.floors.ok ? 'OK' : 'FAIL'}`)
    console.log(`  ② 克隆 README 旧地板 ${realFloor} ${readmeHits} 处 → ${fromFloor}（演练 setup）→ dsh-adapt 替换为目标；残留 ${fromFloor} ${oldLeft} 处、${target} 现 ${targetNow} 处  ⇒ ${asserts.readme.ok ? 'OK' : 'FAIL'}`)
    console.log(`  ③ 克隆夹具    dshVersion=${asserts.fixture.dshVersion ?? '?'}（期望 ${target}），${asserts.fixture.ids ?? '?'} 个 id  ⇒ ${asserts.fixture.ok ? 'OK' : 'FAIL'}`)
    console.log(`  ④ 真实夹具    sha256 ${String(asserts.realFixture.before).slice(0, 12)}… → ${String(asserts.realFixture.after).slice(0, 12)}…（mtime/size 未变）  ⇒ ${asserts.realFixture.ok ? 'OK（写入的是克隆里那份）' : 'FAIL'}`)
    console.log(`  ⑤ 真实仓库    非记录层 status ${statusAfter ? `${statusAfter.dirty.length} 条` : '读不到'}；关键文件指纹 ${filesUnchanged}/${Object.keys(BUMP_REAL_FILES).length} 未变  ⇒ ${asserts.realRepo.ok ? 'OK' : 'FAIL'}`)
  }

  // ── 6. 清理（默认删克隆与临时 runtime；--keep 或失败保留现场）────────────
  const anyFail = steps.some((s) => s.status === 'fail')
  kept = opts.keep || anyFail
  {
    const s = now()
    if (kept) {
      step('cleanup', 'skip', 0, `${opts.keep ? '--keep' : '失败保留现场'}：clone=${cloneDir} runtime=${runtimeDir ?? '-'}`)
    } else {
      let removed = true
      // bumpRoot 里还有 install.json（子进程场景的结构化结果），必须一起删掉，否则每次成功运行
      // 都会在 /tmp 留下一个小目录（实测踩过）。
      for (const [what, dir] of [['clone', cloneDir], ['临时 runtime', runtimeDir], ['bump 工作目录', bumpRoot]]) {
        if (!bumpOwnsTempDir(dir)) { removed = false; console.log(`      ⚠ 拒绝删除非本脚本创建的路径（${what}）：${dir}`); continue }
        rmSync(dir, { recursive: true, force: true })
        if (existsSync(dir)) removed = false
      }
      step('cleanup', removed ? 'ok' : 'fail', now() - s, removed ? '克隆、临时 runtime 与 bump 工作目录已删（只删自己建的目录）' : '有目录没能删掉')
    }
    timing.cleanupMs = now() - s
  }
  const allGreen = !steps.some((s) => s.status === 'fail') && adaptResult.code === 0
  return emit(allGreen ? 0 : 1, allGreen ? 'GREEN' : 'FAILED')
}

// ══ 场景 upgrade：旧版 → 新版「升级覆盖」══════════════════════════════════════
// 步骤 / 四条断言 / 两条负向自证见文件头。三条纪律：
//   1) 旧版必须**绕过 manager** 装（manager 启动期目标恒为 max(地板, latest)），且必须 hoisted：
//      默认 isolated 布局会让 manager 走"删光重建"分支，升级覆盖与嵌套副本两条断言就失去意义。
//   2) 临时 runtime 必须与 .pnpm-store 同设备（跨设备 pnpm 会退化）；不静默降级。
//   3) 真实仓库 / 真实 runtime 只读：跑前跑后各取一次非记录层 git status 与关键文件指纹。

/** 临时目录候选（顺序即优先级）。跨设备不静默降级：设备不符的候选直接跳过，全不符 ⇒ exit 3。 */
function upgradeTempBaseCandidates(warmStore) {
  const out = []
  if (opts.tempBase) out.push({ dir: resolve(opts.tempBase), source: '--temp-base' })
  if (process.env.DSH_REHEARSE_TEMP_BASE) out.push({ dir: resolve(process.env.DSH_REHEARSE_TEMP_BASE), source: 'DSH_REHEARSE_TEMP_BASE' })
  // Windows 上热 runtime 在 %APPDATA%\<app>\runtime，临时目录应在 %LOCALAPPDATA%\Temp（与 C: 同设备）。
  const appData = /^(.*?[/\\]AppData)[/\\](?:Roaming|Local)[/\\]/.exec(warmStore)
  if (appData) out.push({ dir: join(appData[1], 'Local', 'Temp'), source: '由热 runtime 推导（Windows Local\\Temp）' })
  out.push({ dir: tmpdir(), source: 'os.tmpdir()（兜底）' })
  return out
}
function statDevice(p) {
  try { return statSync(p).dev } catch { return null }
}

/** 实测计数：`find <runtime>/node_modules -path "…@deepseek-ai/dsh/package.json"`。
 *  **不硬编码基线**：真实 dev runtime 用同一条命令再跑一次作对照，两个数都进报告。
 *  find 不可用时退化为 JS 遍历（同一判据、同样不跟随软链），报告里写明用的哪种。 */
function countDshPackageJson(runtimeDir) {
  const root = join(runtimeDir, 'node_modules')
  const pattern = '*/node_modules/@deepseek-ai/dsh/package.json'
  try {
    const out = execFileSync('find', [root, '-path', pattern], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const paths = out.split('\n').map((l) => l.trim()).filter(Boolean)
    return { count: paths.length, method: 'find', paths, root, pattern }
  } catch (err) {
    const paths = []
    const suffix = /node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]package\.json$/
    const walk = (dir) => {
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isSymbolicLink()) continue // 与 find 默认一致：不跟随软链
        if (e.isDirectory()) walk(p)
        else if (e.isFile() && suffix.test(p)) paths.push(p)
      }
    }
    walk(root)
    return { count: paths.length, method: 'js-walk', paths, root, pattern, findError: String(err.message ?? err).slice(0, 160) }
  }
}

/** 只删自己建的升级临时目录：父目录 == tempBase 且名字带前缀（防 rm -rf 误伤）。 */
function upgradeOwnsTempDir(dir, tempBase) {
  if (!dir || !tempBase) return false
  const abs = resolve(dir)
  return dirname(abs) === resolve(tempBase) && basename(abs).startsWith('dsh-rehearse-upgrade-')
}

/** 负向自证注入点：升级后的树里塞一份**同版本**嵌套副本。
 *  版本与父包一致 ⇒ manager 的 stale 清理（只删版本不一致的）不会捡走它，计数必然 > 1。
 *  这是给断言 ② 做变异自证：如果塞了它断言还绿，说明该断言恒真。 */
function injectNestedCopy(runtimeDir) {
  const scope = join(runtimeDir, 'node_modules', '@deepseek-ai')
  if (!existsSync(scope)) return { ok: false, error: `没有 ${scope}` }
  const parent = readdirSync(scope).find((name) => name !== 'dsh' && existsSync(join(scope, name, 'package.json')))
  if (!parent) return { ok: false, error: '找不到可注入的父包（@deepseek-ai/* 除 dsh 外至少需要一个）' }
  const parentVersion = readJson(join(scope, parent, 'package.json'))?.version ?? null
  if (!parentVersion) return { ok: false, error: `读不到父包版本：${parent}` }
  const dest = join(scope, parent, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'package.json'), JSON.stringify({ name: DSH_PKG, version: parentVersion, private: true }, null, 2) + '\n')
  return { ok: true, parent, version: parentVersion, dest }
}

async function runUpgradeScenario() {
  steps.length = 0
  const tUp = now()
  const timing = { preflightMs: 0, seedMs: 0, oldInstallMs: 0, upgradeMs: 0, probeMs: 0, assertMs: 0, cleanupMs: 0, totalMs: 0 }
  const versionRe = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
  const from = opts.upgradeFrom ?? UPGRADE_DEFAULT_FROM
  const managerText = readFileSync(MANAGER, 'utf8')
  const realFloor = /MIN_DSH_VERSION\s*=\s*'([^']+)'/.exec(managerText)?.[1] ?? null
  const target = opts.version ?? realFloor
  let status = 'PREFLIGHT'
  let errorMsg = null
  let tmp = null
  let tempBase = null
  let installJsonPath = null
  let oldInfo = null
  let upgradeChild = null
  let upgradeChildExit = null
  let counts = null
  let faultInfo = null
  let kept = false
  let repoBefore = null
  let repoAfter = null
  const probe = { verdict: null, exitCode: null, counts: null, blocking: [], stdoutTail: [] }
  const asserts = {}
  const realFingerprints = {}

  const emit = (code, st) => {
    status = st
    timing.totalMs = now() - tUp
    const failedSteps = steps.filter((s) => s.status === 'fail')
    const faultProven = opts.fault === 'nested-copy' && asserts.nested?.ok === false && counts?.temp?.count === 2
    const result = {
      tool: 'dsh-rehearse', scenario: 'upgrade', ok: code === 0, status, error: errorMsg,
      repo: ROOT, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString(),
      floorVersion: realFloor, targetVersion: target,
      targetSource: opts.version ? '--version' : 'MIN_DSH_VERSION',
      upgradeFrom: from, upgradeFromSource: opts.upgradeFrom ? '--upgrade-from' : `默认 ${UPGRADE_DEFAULT_FROM}`,
      fault: opts.fault,
      tmpDir: tmp, tempBase, kept,
      installedOld: oldInfo,
      upgradeChild: upgradeChild
        ? {
          exitCode: upgradeChildExit, status: upgradeChild.status,
          installedVersion: upgradeChild.installedVersion, floorVersion: upgradeChild.floorVersion,
          probe: upgradeChild.probe, tmpDir: upgradeChild.tmpDir, kept: upgradeChild.kept,
        }
        : null,
      nestedCounts: counts, faultInfo,
      asserts, probe,
      repoStatusBefore: repoBefore, repoStatusAfter: repoAfter,
      realFingerprints,
      steps, timings: timing, gaps: UPGRADE_GAPS,
    }
    writeJson(opts.json, result)
    console.log('')
    if (code === 0) {
      console.log(`  结论: GREEN — ${from} → ${target} 升级覆盖走通：落地 == 目标、无残留嵌套副本` +
        `（临时 ${counts?.temp?.count} / 真实 runtime 对照 ${counts?.control?.count}）、探针 GREEN、真实仓库与真实 runtime 未被改动`)
    } else if (faultProven) {
      console.log(`  结论: 负向对照按预期变红 — --fault nested-copy 注入后「无残留嵌套副本」计数 ${counts?.temp?.count} ≠ 1，` +
        `断言 ② 红、exit 1。这证明该断言会失败，不是恒真门禁；正常演练（不带 --fault）必须回到 1。`)
    } else {
      console.log(`  结论: ${status} — ${errorMsg ?? failedSteps.map((s) => `${s.name}(${s.detail})`).join('；')}`)
    }
    for (const g of UPGRADE_GAPS) console.log(`  ⚠ ${g}`)
    if (kept && tmp) console.log(`  现场保留：${tmp}${installJsonPath ? `（install JSON：${installJsonPath}）` : ''}`)
    return code
  }

  console.log('dsh:rehearse --scenario upgrade —— 旧版 → 新版「升级覆盖」演练（真实仓库 / 真实 runtime 只读）')
  console.log(`  目标版本     ${target}${opts.version ? '（--version）' : '（真实仓库地板 MIN_DSH_VERSION）'}`)
  console.log(`  旧版本       ${from}${opts.upgradeFrom ? '（--upgrade-from）' : `（默认 ${UPGRADE_DEFAULT_FROM}）`}`)
  if (opts.fault) console.log(`  故障注入     ${opts.fault}（负向自证：断言 ② 必须变红）`)
  console.log('')

  // ── 语义前置（exit 2）：旧版必须低于地板，否则兼容闸门不会触发 ─────────────
  const usageErr = (msg) => console.error(`\ndsh-rehearse --scenario upgrade: ${msg}\n\n${USAGE}`)
  if (!realFloor) {
    errorMsg = '读不到真实仓库地板 MIN_DSH_VERSION'
    console.error(`\ndsh-rehearse --scenario upgrade: ${errorMsg}（${MANAGER}）`)
    return emit(3, 'PREFLIGHT')
  }
  if (!versionRe.test(target)) { errorMsg = `--version 不是合法版本号：${target}`; usageErr(errorMsg); return emit(2, 'USAGE') }
  if (!versionRe.test(from)) { errorMsg = `--upgrade-from 不是合法版本号：${from}`; usageErr(errorMsg); return emit(2, 'USAGE') }
  if (bumpCmpVer(target, from) <= 0) {
    errorMsg = `目标 ${target} 不高于旧版 ${from}`
    usageErr(`${errorMsg} —— 升级演练要求"旧 → 新"；目标不高于旧版 = 假演练，拒绝执行。`)
    return emit(2, 'USAGE')
  }
  if (bumpCmpVer(realFloor, from) <= 0) {
    errorMsg = `旧版 ${from} 不低于壳地板 ${realFloor}`
    usageErr(`${errorMsg} —— manager 的兼容闸门只在「已装版本 < 地板」时才升级；旧版 >= 地板时启动期不会发生升级（= 假演练）。\n  请给更低的 --upgrade-from（默认 ${UPGRADE_DEFAULT_FROM}）。`)
    return emit(2, 'USAGE')
  }

  // ── 前置：热 runtime + 仓库资源（exit 3）──────────────────────────────────
  const warmArg = opts.warmStore ?? DEFAULT_WARM_RUNTIME
  let warmRuntime = resolve(warmArg)
  if (basename(warmRuntime) === '.pnpm-store') warmRuntime = dirname(warmRuntime)
  const warmStore = join(warmRuntime, '.pnpm-store')
  const warmPnpm = join(warmRuntime, 'node_modules/pnpm/bin/pnpm.cjs')
  const warmMissing = [
    [warmRuntime, '热 runtime 不存在'],
    [warmStore, '缺 .pnpm-store（不是热 store）'],
    [warmPnpm, '缺随包 pnpm'],
  ].filter(([p]) => !existsSync(p))
  if (warmMissing.length) {
    errorMsg = '热 runtime 前置不满足'
    console.error(`\ndsh-rehearse --scenario upgrade: ${errorMsg} —— ${warmMissing.map(([p, w]) => `${w}：${p}`).join('；')}\n  用 --warm-store <dir> 指向本机真实的 dsh runtime。`)
    return emit(3, 'PREFLIGHT')
  }
  for (const f of [MANAGER, PROBE, PATCH_FILE, join(RESOURCE_DIR, 'plugin/@dsh-desktop')]) {
    if (!existsSync(f)) { errorMsg = `仓库资源缺失：${f}`; console.error(`\ndsh-rehearse --scenario upgrade: ${errorMsg}`); return emit(3, 'PREFLIGHT') }
  }

  // 原生构建放行名单**从 manager 派生**（不抄第二份）：空 runtime 直接 pnpm add 会让 pnpm 留下
  // `allowBuilds: … set this to true or false` 提示桩；manager 的升级安装见文件已存在不会重写，
  // 于是 ERR_PNPM_IGNORED_BUILDS 让 pnpm exit 1（本机 pnpm 11.24 实测）。真实 runtime 在升级前
  // 本来就有 manager 写的这两份文件 ⇒ 先按同样写法铺好，才是"与真实窗口一致"。
  const nativeBlock = /const NATIVE_BUILD_PKGS\s*=\s*\[([\s\S]*?)\]/.exec(managerText)
  const nativePkgs = nativeBlock ? [...nativeBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []
  if (!nativePkgs.length) {
    errorMsg = '无法从 manager 的 NATIVE_BUILD_PKGS 解析原生构建放行名单'
    console.error(`\ndsh-rehearse --scenario upgrade: ${errorMsg}（${MANAGER}）—— 解析不到就不铺 .npmrc/pnpm-workspace.yaml，拒绝继续。`)
    return emit(3, 'PREFLIGHT')
  }

  // ── 前置：临时目录与 .pnpm-store 同设备（exit 3，不静默降级）──────────────
  const storeDev = statDevice(warmStore)
  const candidates = upgradeTempBaseCandidates(warmStore)
  const rejected = []
  let picked = null
  for (const c of candidates) {
    if (!existsSync(c.dir)) {
      try { mkdirSync(c.dir, { recursive: true }) } catch (err) { rejected.push(`${c.dir}（${c.source}）创建失败：${err.message}`); continue }
    }
    const dev = statDevice(c.dir)
    if (dev === null) { rejected.push(`${c.dir}（${c.source}）stat 失败`); continue }
    if (storeDev !== null && dev !== storeDev) {
      rejected.push(`${c.dir}（${c.source}）设备 ${dev} ≠ .pnpm-store 设备 ${storeDev}（跨设备会让 pnpm 退化/变慢）`)
      continue
    }
    picked = { dir: c.dir, source: c.source, dev }
    break
  }
  if (!picked) {
    errorMsg = '没有与 .pnpm-store 同设备的临时目录'
    console.error(`\ndsh-rehearse --scenario upgrade: ${errorMsg} —— 候选全部不可用：\n${rejected.map((r) => `  - ${r}`).join('\n')}\n  用 --temp-base <dir> 指定一个与热 runtime 的 .pnpm-store 同设备的目录。`)
    return emit(3, 'PREFLIGHT')
  }
  if (opts.tempBase && picked.source !== '--temp-base') {
    errorMsg = `--temp-base 不可用：${opts.tempBase}`
    console.error(`\ndsh-rehearse --scenario upgrade: ${errorMsg} —— ${rejected.filter((r) => r.startsWith(resolve(opts.tempBase))).join('；') || '与 .pnpm-store 不同设备'}。\n  显式给了 --temp-base 就绝不偷偷换成别的目录。`)
    return emit(3, 'PREFLIGHT')
  }
  tempBase = picked.dir

  // ── 前置：真实仓库 status + 真实 runtime / 仓库关键文件指纹（只读快照）──────
  for (const [name, file] of Object.entries(BUMP_REAL_FILES)) realFingerprints[name] = { before: fingerprint(file) }
  const realRuntimeFiles = [
    join(warmRuntime, `node_modules/${DSH_PKG}/package.json`),
    join(warmRuntime, `node_modules/${DSH_PKG}/lib/bin.js`),
    join(warmRuntime, 'package.json'),
    join(warmRuntime, 'manager.log'),
  ]
  const realRuntimeBefore = realRuntimeFiles.map(fingerprint)
  try {
    repoBefore = bumpRepoStatus()
  } catch (err) {
    errorMsg = `git status 读不到：${err.message}`
    console.error(`\ndsh-rehearse --scenario upgrade: ${errorMsg}（${ROOT} 是 git 仓库吗？）`)
    return emit(3, 'PREFLIGHT')
  }
  timing.preflightMs = now() - tUp
  step('upgrade-preflight', 'ok', timing.preflightMs,
    `旧版 ${from} < 地板 ${realFloor}（兼容闸门会触发）；临时目录 ${tempBase}（${picked.source}，设备 ${picked.dev} == store ${storeDev}）；` +
    `真实仓库非记录层改动 ${repoBefore.dirty.length} 条（前后必须一致）；原生构建放行 ${nativePkgs.length} 个（从 manager 派生）`)

  // ── 1. 建临时 runtime（真实布局：manager 的两份配置 + 软链）─────────────────
  {
    const s = now()
    tmp = mkdtempSync(join(tempBase, 'dsh-rehearse-upgrade-'))
    mkdirSync(join(tmp, 'node_modules'), { recursive: true })
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(warmStore, join(tmp, '.pnpm-store'), linkType)
    symlinkSync(join(warmRuntime, 'node_modules/pnpm'), join(tmp, 'node_modules/pnpm'), linkType)
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'dsh-runtime', private: true, version: '0.0.0' }, null, 2) + '\n')
    // 与 manager 的 ensureRuntimeDir / ensurePnpmWorkspace 逐字同形（含 JSON.stringify 的引号）。
    writeFileSync(join(tmp, '.npmrc'), nativePkgs.map((p) => `allow-scripts[]=${p}`).join('\n') + '\n')
    writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'allowBuilds:\n' + nativePkgs.map((p) => `  ${JSON.stringify(p)}: true`).join('\n') + '\n')
    timing.seedMs = now() - s
    step('seed-runtime', 'ok', timing.seedMs,
      `${tmp}（package.json + .npmrc + pnpm-workspace.yaml 按 manager 两处写法生成；.pnpm-store / node_modules/pnpm 软链）`)
  }

  // ── 2. 绕过 manager 装旧版（hoisted，与生产布局一致）────────────────────────
  {
    const s = now()
    const pnpmArgs = [warmPnpm, 'add', `${DSH_PKG}@${from}`, '--store-dir', warmStore, '--reporter=append-only', '--node-linker=hoisted']
    if (opts.registry) pnpmArgs.push('--registry', opts.registry)
    const out = await bumpSpawn(process.execPath, pnpmArgs, { cwd: tmp, label: 'pnpm-add', filter: /ERR_|Done in|postinstall|deprecated|WARN/ })
    timing.oldInstallMs = now() - s
    const landed = readJson(join(tmp, `node_modules/${DSH_PKG}/package.json`))?.version ?? null
    const entryOk = existsSync(join(tmp, `node_modules/${DSH_PKG}/lib/bin.js`))
    oldInfo = {
      exitCode: out.code, signal: out.signal ?? null, landed, entryOk,
      seconds: Math.round(timing.oldInstallMs / 1000),
      stdoutTail: out.stdout.trim().split('\n').slice(-6),
      stderrTail: out.stderr.trim().split('\n').slice(-6),
    }
    const ok = out.code === 0 && landed === from && entryOk
    step('install-old', ok ? 'ok' : 'fail', timing.oldInstallMs,
      `pnpm add ${DSH_PKG}@${from}（hoisted）→ rc=${out.code}，落地 ${landed ?? '(未装上)'}${entryOk ? '' : (landed ? '；缺 lib/bin.js（半装）' : '；未落地')}，${oldInfo.seconds}s`)
    if (!ok) {
      errorMsg = `旧版没装成：pnpm rc=${out.code}，落地 ${landed ?? '(未装上)'}（期望 ${from}）`
      console.error(`\ndsh-rehearse --scenario upgrade: ${errorMsg}`)
      if (out.stderr.trim()) console.error(`  pnpm stderr 尾部：${out.stderr.trim().split('\n').slice(-4).join(' | ').slice(0, 500)}`)
      if (out.stdout.trim()) console.error(`  pnpm stdout 尾部：${out.stdout.trim().split('\n').slice(-4).join(' | ').slice(0, 500)}`)
      kept = true
      return emit(1, 'FAILED')
    }
  }

  // ── 3. 基线：旧版树自己的嵌套计数必须 == 1（否则后续断言不可信）─────────────
  {
    const s = now()
    const c = countDshPackageJson(tmp)
    asserts.baseline = { ok: c.count === 1, count: c.count, method: c.method, paths: c.paths.map((p) => p.replace(tmp, '<tmp>')) }
    step('baseline-nested', asserts.baseline.ok ? 'ok' : 'fail', now() - s,
      `装旧版后同一 find 计数 ${c.count}（${c.method}）：${asserts.baseline.paths.join(', ') || '(无)'}`)
    if (!asserts.baseline.ok) {
      errorMsg = `装旧版后基线计数 ${c.count} ≠ 1（旧版树本身就不干净，后续断言不可信）`
      kept = true
      return emit(1, 'FAILED')
    }
  }

  // ── 4. 复用 install 场景：manager 启动期兼容闸门升到地板 ────────────────────
  {
    const s = now()
    installJsonPath = join(tmp, 'rehearse-install.json')
    const selfArgs = [
      fileURLToPath(import.meta.url), '--scenario', 'install', '--runtime-dir', tmp,
      '--version', target, '--keep', '--json', installJsonPath, '--timeout', String(opts.timeoutSec),
    ]
    if (opts.warmStore) selfArgs.push('--warm-store', opts.warmStore)
    if (opts.registry) selfArgs.push('--registry', opts.registry)
    const out = await bumpSpawn(process.execPath, selfArgs, { label: 'upgrade' })
    upgradeChildExit = out.code
    upgradeChild = readJson(installJsonPath)
    timing.upgradeMs = now() - s
    const landed = upgradeChild?.installedVersion ?? null
    const ok = out.code === 0 && upgradeChild !== null && landed === target
    step('upgrade-install', ok ? 'ok' : 'fail', timing.upgradeMs,
      `复用 install 场景（manager 启动期兼容闸门）exit=${out.code}，落地 ${landed ?? '(读不到)'}，探针 ${String(upgradeChild?.probe?.verdict ?? '?').toUpperCase()}`)
    if (!ok) {
      errorMsg = upgradeChild === null
        ? `install 子场景没有写出 JSON（exit=${out.code}）`
        : `升级没落到目标：落地 ${landed ?? '(无)'}，期望 ${target}（install exit=${out.code}，status=${upgradeChild.status}）`
      kept = true
      return emit(1, 'FAILED')
    }
  }

  // ── 5. 断言 ①：落地版本（父进程独立复读，不采信子场景的自报）────────────────
  {
    const s = now()
    const landed = readJson(join(tmp, `node_modules/${DSH_PKG}/package.json`))?.version ?? null
    asserts.version = { ok: landed === target, landed, target, childReported: upgradeChild?.installedVersion ?? null }
    step('assert-1-version', asserts.version.ok ? 'ok' : 'fail', now() - s,
      `落地 ${landed ?? '(读不到)'} vs 目标 ${target}（父进程独立复读 package.json；子场景报告 ${upgradeChild?.installedVersion ?? '?'}）`)
  }

  // ── 5b. 负向自证注入（只在 --fault nested-copy 时）：让断言 ② 必须红 ─────────
  if (opts.fault === 'nested-copy') {
    const s = now()
    faultInfo = injectNestedCopy(tmp)
    step('fault-inject', faultInfo.ok ? 'ok' : 'fail', now() - s,
      faultInfo.ok
        ? `已注入 ${faultInfo.dest.replace(tmp, '<tmp>')}（version=${faultInfo.version}，与父包 ${faultInfo.parent} 同版本 ⇒ manager 的 stale 清理不会捡走）`
        : `注入失败：${faultInfo.error}`)
  }

  // ── 5c. 断言 ②：无残留嵌套副本（同一命令 + 真实 runtime 对照）──────────────
  {
    const s = now()
    counts = { temp: countDshPackageJson(tmp), control: countDshPackageJson(warmRuntime) }
    const tempOk = counts.temp.count === 1
    const controlOk = Number.isInteger(counts.control.count)
    const ok = tempOk && controlOk
    asserts.nested = {
      ok, tempCount: counts.temp.count, controlCount: counts.control.count,
      tempMethod: counts.temp.method, controlMethod: counts.control.method,
      controlBaselineIsOne: counts.control.count === 1,
      tempPaths: counts.temp.paths.map((p) => p.replace(tmp, '<tmp>')),
      controlPaths: counts.control.paths.map((p) => p.replace(warmRuntime, '<warm>')),
    }
    step('assert-2-no-nested', ok ? 'ok' : 'fail', now() - s,
      `临时 runtime 计数 ${counts.temp.count}（${counts.temp.method}）${opts.fault === 'nested-copy' ? ' ← 故障注入' : ''}；` +
      `对照：真实 dev runtime 计数 ${counts.control.count}（同一命令，实测基线，不是硬编码的 1）`)
  }

  // ── 5d. 断言 ③：探针 GREEN（父进程独立跑，不采信子场景）────────────────────
  {
    const s = now()
    const probeJson = join(tmp, 'upgrade-probe.json')
    let exitCode = 0
    let wrote = false
    try {
      const out = execFileSync(process.execPath, [PROBE, '--runtime', tmp, '--json', probeJson],
        { encoding: 'utf8', timeout: Math.max(300_000, opts.timeoutSec * 1000), maxBuffer: 64 * 1024 * 1024 })
      probe.stdoutTail = out.trim().split('\n').slice(-14)
      wrote = true
    } catch (err) {
      exitCode = typeof err.status === 'number' ? err.status : -1
      const out = `${err.stdout ?? ''}`
      probe.stdoutTail = out.trim() ? out.trim().split('\n').slice(-14) : [`(探针无 stdout；${err.message}）`.slice(0, 200)]
      wrote = existsSync(probeJson)
    }
    const report = readJson(probeJson)
    probe.exitCode = exitCode
    probe.verdict = report?.verdict ?? (/verdict = (\w+)/.exec(probe.stdoutTail.join('\n'))?.[1]?.toLowerCase() ?? null)
    probe.counts = report?.counts ?? null
    probe.blocking = (report?.findings ?? []).filter((f) => f.sev !== 'info').map((f) => ({ sev: f.sev, id: f.id, msg: f.msg }))
    timing.probeMs = now() - s
    asserts.probe = { ok: exitCode === 0 && probe.verdict === 'green', exitCode, verdict: probe.verdict, wrote }
    step('assert-3-probe', asserts.probe.ok ? 'ok' : 'fail', timing.probeMs,
      `dsh-compat-probe --runtime <tmp> ⇒ verdict=${(probe.verdict ?? '?').toUpperCase()} exit=${exitCode}`)
    for (const f of probe.blocking) console.log(`        [${f.sev.toUpperCase()}] ${f.id}: ${f.msg}`)
  }

  // ── 5e. 断言 ④：真实仓库 status 前后一致 + 真实 runtime 指纹未变 ───────────
  {
    const s = now()
    const realRuntimeAfter = realRuntimeFiles.map(fingerprint)
    const runtimeUnchanged = realRuntimeBefore.every((b, i) => {
      const a = realRuntimeAfter[i]
      return b.exists === a.exists && b.sha256 === a.sha256 && b.mtimeMs === a.mtimeMs && b.size === a.size
    })
    let filesUnchanged = 0
    const changedFiles = []
    for (const [name, file] of Object.entries(BUMP_REAL_FILES)) {
      const after = fingerprint(file)
      realFingerprints[name].after = after
      const before = realFingerprints[name].before
      if (before.exists === after.exists && before.sha256 === after.sha256 && before.mtimeMs === after.mtimeMs && before.size === after.size) filesUnchanged += 1
      else changedFiles.push(name)
    }
    let statusError = null
    try { repoAfter = bumpRepoStatus() } catch (err) { statusError = err.message }
    const sameStatus = repoAfter !== null && JSON.stringify(repoBefore.entries) === JSON.stringify(repoAfter.entries)
    const ok = sameStatus && runtimeUnchanged && filesUnchanged === Object.keys(BUMP_REAL_FILES).length
    asserts.realRepo = {
      ok, sameStatus, statusError,
      dirtyBefore: repoBefore.dirty, dirtyAfter: repoAfter?.dirty ?? null,
      exemptBefore: repoBefore.exempt, exemptAfter: repoAfter?.exempt ?? [],
      entriesBefore: repoBefore.entries.length, entriesAfter: repoAfter?.entries.length ?? null,
      filesUnchanged, filesTotal: Object.keys(BUMP_REAL_FILES).length, changedFiles,
      runtimeUnchanged,
      runtimeFingerprints: realRuntimeFiles.map((f, i) => ({ path: f, before: realRuntimeBefore[i], after: realRuntimeAfter[i] })),
    }
    timing.assertMs = now() - s
    step('assert-4-real-unchanged', ok ? 'ok' : 'fail', now() - s,
      `真实仓库非记录层 status 前后${sameStatus ? '一致' : '不一致'}（${repoBefore.dirty.length} → ${repoAfter?.dirty.length ?? '读不到'} 条；条目 ${repoBefore.entries.length} → ${repoAfter?.entries.length ?? '?'}）；` +
      `真实 runtime ${runtimeUnchanged ? `${realRuntimeFiles.length} 处指纹未变` : '指纹变了'}；仓库关键文件 ${filesUnchanged}/${Object.keys(BUMP_REAL_FILES).length} 未变`)
  }

  // ── 6. 清理（成功才删自己建的临时 runtime；失败 / --keep 保留现场）──────────
  {
    const s = now()
    const anyFail = steps.some((x) => x.status === 'fail')
    kept = opts.keep || anyFail
    if (kept) {
      step('cleanup', 'skip', 0, `${opts.keep ? '--keep' : '失败保留现场'}：${tmp}`)
    } else if (!upgradeOwnsTempDir(tmp, tempBase)) {
      step('cleanup', 'fail', 0, `拒绝删除非本脚本创建的路径：${tmp}`)
    } else {
      rmSync(tmp, { recursive: true, force: true })
      step('cleanup', existsSync(tmp) ? 'fail' : 'ok', now() - s, '临时 runtime 已删（软链只删链、不跟随）')
    }
    timing.cleanupMs = now() - s
  }

  const allGreen = !steps.some((x) => x.status === 'fail') && upgradeChildExit === 0
  return emit(allGreen ? 0 : 1, allGreen ? 'GREEN' : 'FAILED')
}

function writeJson(out, obj) {
  if (!out) return
  try {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(obj, null, 2))
    console.log(`  JSON 已写入 ${out}`)
  } catch (err) {
    console.error(`dsh-rehearse: 写 ${out} 失败：${err.message}`)
  }
}
