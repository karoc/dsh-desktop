#!/usr/bin/env node
// ⚠️⚠️ WIP — **未校准，禁止用于判定**（2026-10-17）⚠️⚠️
// 校准证据（必读）：对**已知良好**的当前地板 `0.2.1-alpha.3` 跑，本脚本给出与对 `0.2.1-rc.1` 跑
// **完全相同**的全红结论（red 8：73 个 id "被删"、6 个 seam "消失"、CLI 开关 "--port/--max-http-header-size"
// 找不到）。已知良好的版本不可能是红的 ⇒ 错在本脚本的取数语义，不在上游。四处已定位的缺陷：
//   ① patch-id 是**苹果对橘子**：夹具（188 个）来自运行时的 `dsh --dump-config` 解析结果，
//      而新版取的是 web-app 的 `cordis.patch.yml`（115 个）⇒ 应改成 patch-yml ↔ patch-yml 对比；
//   ② overlay 目标行 `desktop-notifications` "不存在"：该行由**其它上游包**提供，只在 web-app 的
//      yml 里找必然找不到 ⇒ overlay 检查应交给装好后的 `test-patch-targets.mjs --runtime <dir>`；
//   ③ 6 个 seam 在 web-app tarball 里搜不到（连 `__ModuleLoader__` 都没有）⇒ seam 不在这个包里，
//      要先查清它们在哪个产物（当年人工审计是"抽检 web-app tarball"，需重新取证，别猜）；
//   ④ CLI 开关按文本搜 `.js` 命中不到 ⇒ 上游用动态拼装/配置对象，需换判据（或改在装好后跑 `--help`）。
// 修好并**通过 alpha.3 校准（必须绿）**之后，才允许接进 workflow 与清欠账。
//
// ── 2026-10-17 二次取证：**架构结论（本骨架的"不装 runtime"前提是错的）** ─────────────
// 用本机已装的 dev runtime（dsh 0.2.1-alpha.3，`…/dsh.smoothly.desktop.dev/runtime/node_modules/@deepseek-ai`）
// 直接 grep，实测 seam 的所在地：
//   settings.section → dsh-client-ui-settings-account/lib/client.js、dsh-client-ui-agent-preset/lib/client.js
//   configForms      → dsh-client-locale/lib/client.js、dsh-client-ui-agent-preset/lib/client.js
//   __ModuleLoader__ → dsh-api-gateway/lib/client.browser.js
// ⇒ seam **不在** `@deepseek-ai/dsh-web-app` tarball 里，而是散在几十个 `dsh-*` / `dsh-client-ui-*` 包里。
// 同理：patch id 的权威来源是运行时 `dsh --dump-config`（夹具 188 个正是这么来的），CLI 开关要看运行时的
// `dsh web --help`。⇒ 正确架构与仓库既有模式一致：**探针 = 装一个候选版本到临时 runtime，然后跑既有的
// 权威判据**（`test-patch-targets.mjs --runtime <dir>` 的 id 集合、`--dump-config`、`--help`、以及本文件
// 的 seam grep 改为在 runtime 树上跑），探针只负责"编排 + 分级 + 出报告"。本文件里基于 tarball 的
// ①②③④ 四处检查因此全部作废（保留作反面参考），重写时不要再用 tarball 静态搜索。
// dsh 兼容性探针：给定一个 dsh 版本（或 latest / next），把"抬地板前必须人工核对"的那几件事
// 变成一次确定性检查，产出 verdict + 证据 JSON。
//
//   node scripts/dsh-compat-probe.mjs 0.2.1-rc.1
//   node scripts/dsh-compat-probe.mjs next --out .tmp-investigate/probe.json
//
// 为什么要有它（2026-10-17 方案 §3.1）：历史上"上游发布 → 抬地板"中位 38.2h，而这段里做的
// 全是确定性检查（集合 diff / 字符串存在性 / 语义断言），只是从来没有脚本。探针把它压到分钟级。
//
// 网络纪律（CONTRIBUTING 硬规则）：**不用裸 fetch** —— Node 的 fetch 不读 .npmrc 代理配置，
// 且代理环境变量在进程启动时被采样。本脚本一律 spawn `curl`（显式带 `-x $HTTPS_PROXY`）。
// 另：本机 `npm` CLI 不可用（`~/.npm/_cacache` 只读 ⇒ EROFS），所以取包也走 curl + tar。
//
// 判据分级：red = 必须人/agent 处理（我们依赖的东西消失了）；yellow = 要看一眼但可能无碍；
// info = 只记录（上游新增）。exit code：red ⇒ 1，其它 ⇒ 0（供 workflow 判分支）。

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(ROOT, 'scripts/fixtures/dsh-web-app-patch-ids.json')
const OVERLAY = join(ROOT, 'src-tauri/resources/patch/dsh-desktop.patch.yml')
const MANAGER = join(ROOT, 'scripts/server-manager.mjs')

const argv = process.argv.slice(2)
const want = argv.find((a) => !a.startsWith('--')) ?? 'latest'
const outIdx = argv.indexOf('--out')
const OUT = outIdx >= 0 ? argv[outIdx + 1] : null
const KEEP = argv.includes('--keep')

/** 我们依赖的客户端 seam / 槽位（来源：MIN_DSH_VERSION 注释里的历次核对项 + 四个预装插件的用法）。
 *  每项都写明"谁在用" —— 消失即 red，必须人处理。 */
const SEAMS = [
  { name: 'settings.section', who: 'model-reasoning / turn-navigator 的设置分区' },
  { name: 'settings.general.item', who: 'turn-navigator 的 General 开关' },
  { name: 'configForms', who: 'model-reasoning 的配置表单' },
  { name: 'settings.plugins.tab', who: '官方插件页 tab（我们判断是否要迁移的锚点）' },
  { name: 'conversation.chat.reasoning.body', who: 'model-reasoning 的推理槽' },
  { name: '__ModuleLoader__', who: '所有客户端插件的注册入口' },
]
/** manager 依赖的 CLI 面（读上游 bin，退化为文本存在性检查）。 */
const CLI_FLAGS = ['--port', '--patch', '--profile', '--dump-config', '--max-http-header-size']

const log = (...a) => console.log(...a)
const CURL = ['-sS', '--max-time', '40', '--retry', '2', '--retry-all-errors']
function curl(url) {
  const args = [...CURL]
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
  if (proxy) args.push('-x', proxy)
  args.push(url)
  return execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}
function curlFile(url, dest) {
  const args = [...CURL, '-L', '-o', dest]
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
  if (proxy) args.push('-x', proxy)
  args.push(url)
  execFileSync('curl', args, { encoding: 'utf8' })
}

const findings = []
const add = (sev, id, msg, evidence = '') => findings.push({ sev, id, msg, evidence })

// ── 1. 解析版本 ─────────────────────────────────────────────
const packument = JSON.parse(curl('https://registry.npmjs.org/@deepseek-ai/dsh'))
const distTags = packument['dist-tags'] ?? {}
const version = distTags[want] ?? want
if (!packument.versions?.[version]) {
  log(`FATAL: registry 里没有 @deepseek-ai/dsh@${version}（dist-tags: ${JSON.stringify(distTags)}）`)
  process.exit(2)
}
const publishedAt = packument.time?.[version] ?? '(unknown)'
log(`探针目标：@deepseek-ai/dsh@${version}（请求 "${want}"，发布 ${publishedAt}）`)
log(`dist-tags: ${JSON.stringify(distTags)}\n`)

const tmp = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
function fetchPkg(name, ver) {
  const p = JSON.parse(curl(`https://registry.npmjs.org/${name.replace('/', '%2F')}`))
  const tarball = p.versions?.[ver]?.dist?.tarball
  if (!tarball) return null
  const dest = join(tmp, `${name.replace(/[@/]/g, '_')}-${ver}.tgz`)
  curlFile(tarball, dest)
  const dir = join(tmp, name.replace(/[@/]/g, '_'))
  mkdirSync(dir, { recursive: true })
  execFileSync('tar', ['-xzf', dest, '-C', dir])
  return { dir: join(dir, 'package'), meta: p.versions[ver], packument: p }
}

// ── 2. 取两个 tarball：dsh 本体（CLI/native 依赖）+ web-app（patch id / seam）───
const dsh = fetchPkg('@deepseek-ai/dsh', version)
const web = fetchPkg('@deepseek-ai/dsh-web-app', version)
if (!dsh) add('red', 'dsh-tarball', `取不到 @deepseek-ai/dsh@${version} 的 tarball`)
if (!web) add('yellow', 'webapp-tarball', `取不到 @deepseek-ai/dsh-web-app@${version} 的 tarball（patch-id/seam 检查跳过）`)

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, acc)
    else acc.push(p)
  }
  return acc
}
function idsFromPatchYaml(text) {
  const ids = []
  for (const line of text.split('\n')) {
    const m = /^\s*-\s*id:\s*([\w.\-]+)\s*$/.exec(line)
    if (m) ids.push(m[1])
  }
  return ids
}

// ── 3. patch-id 集合 diff（对夹具）────────────────────────────
if (web) {
  const patchYml = join(web.dir, 'cordis.patch.yml')
  if (!existsSync(patchYml)) {
    add('red', 'webapp-patch-yml', '新版 web-app 里找不到 cordis.patch.yml（上游换了产物布局？）')
  } else {
    const fresh = [...new Set(idsFromPatchYaml(readFileSync(patchYml, 'utf8')))].sort()
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    const old = new Set(fixture.ids)
    const freshSet = new Set(fresh)
    const removed = [...old].filter((id) => !freshSet.has(id))
    const added = fresh.filter((id) => !old.has(id))
    const overlayIds = idsFromPatchYaml(readFileSync(OVERLAY, 'utf8'))
    const missingTargets = overlayIds.filter((id) => !freshSet.has(id))
    log(`patch id：夹具 ${fixture.dshVersion} 有 ${old.size} 个 → ${version} 有 ${freshSet.size} 个（+${added.length} / −${removed.length}）`)
    if (added.length) add('info', 'ids-added', `上游新增 ${added.length} 个 id`, added.join(', '))
    if (removed.length) add('yellow', 'ids-removed', `上游删除 ${removed.length} 个 id（确认我们没依赖）`, removed.join(', '))
    // 我们的 overlay 目标行必须仍然存在（历史上上游改名会让覆盖**静默失效**）
    if (missingTargets.length) {
      add('red', 'overlay-targets', `overlay 的目标行在新版不存在：${missingTargets.join(', ')} ⇒ 覆盖会静默失效`, `overlay=${relative(ROOT, OVERLAY)}`)
    } else {
      add('info', 'overlay-targets', `overlay 的 ${overlayIds.length} 个目标行在新版全部存在`)
    }
  }
}

// ── 4. seam / 槽位存在性（在 web-app 产物里搜）────────────────
if (web) {
  const files = walk(web.dir)
  const blob = files.map((f) => readFileSync(f, 'utf8')).join('\n')
  for (const s of SEAMS) {
    if (blob.includes(s.name)) add('info', `seam:${s.name}`, `seam 在位（${s.who}）`)
    else add('red', `seam:${s.name}`, `seam 消失：${s.name}（${s.who}）`)
  }
}

// ── 5. CLI 面（读上游 bin 文本）──────────────────────────────
if (dsh) {
  const files = walk(dsh.dir).filter((f) => /\.(m?js|cjs)$/.test(f))
  const blob = files.map((f) => readFileSync(f, 'utf8')).join('\n')
  const missing = CLI_FLAGS.filter((f) => !blob.includes(f))
  if (missing.length) add('red', 'cli-flags', `manager 依赖的 CLI 开关在新版 bin 里找不到：${missing.join(', ')}`)
  else add('info', 'cli-flags', `manager 依赖的 ${CLI_FLAGS.length} 个 CLI 开关都在`)
}

// ── 6. native 构建白名单（manager 的 allowBuilds 跟随它）────────
if (dsh) {
  const mgrSrc = readFileSync(MANAGER, 'utf8')
  const m = /const NATIVE_BUILD_PKGS = \[([\s\S]*?)\]/.exec(mgrSrc)
  const listed = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []
  const deps = { ...(dsh.meta.dependencies ?? {}), ...(dsh.meta.optionalDependencies ?? {}) }
  const gone = listed.filter((p) => !(p in deps))
  if (gone.length) add('yellow', 'native-build', `壳的 native 构建白名单里这些包已不在新版 dsh 依赖里（manager 白名单应同步删）：${gone.join(', ')}`)
  else add('info', 'native-build', `native 构建白名单 ${listed.length} 个包在新版依赖里都能找到`)
}

// ── 7. 预装插件的 peer 地板 vs 候选版本 ──────────────────────
{
  const dirs = existsSync(join(ROOT, 'src-tauri/resources/preinstalled'))
    ? readdirSync(join(ROOT, 'src-tauri/resources/preinstalled')).filter((d) => statSync(join(ROOT, 'src-tauri/resources/preinstalled', d)).isDirectory())
    : []
  const cmp = (a, b) => {
    const norm = (v) => (v.split('-')[0]).split('.').map(Number)
    const [A, B] = [norm(a), norm(b)]
    for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0)
    return 0
  }
  for (const d of dirs) {
    const pj = join(ROOT, 'src-tauri/resources/preinstalled', d, 'package.json')
    if (!existsSync(pj)) continue
    const j = JSON.parse(readFileSync(pj, 'utf8'))
    const peers = Object.entries(j.peerDependencies ?? {}).filter(([k]) => k.startsWith('@deepseek-ai/dsh'))
    for (const [k, range] of peers) {
      const lo = /[>]=?\s*([\w.\-]+)/.exec(range)?.[1]
      if (lo && cmp(version, lo) < 0) add('red', `peer:${d}`, `${d} 声明 ${k} ${range}，候选版本 ${version} 不满足`)
      else add('info', `peer:${d}`, `${d} 的 peer ${range} 被 ${version} 满足`)
    }
  }
}

// ── 8. 汇总 ─────────────────────────────────────────────────
const red = findings.filter((f) => f.sev === 'red')
const yellow = findings.filter((f) => f.sev === 'yellow')
const verdict = red.length ? 'red' : yellow.length ? 'yellow' : 'green'
const report = {
  target: version, requested: want, publishedAt, verdict,
  generatedAt: new Date().toISOString(),
  counts: { red: red.length, yellow: yellow.length, info: findings.length - red.length - yellow.length },
  findings,
}
log('')
for (const f of findings.filter((x) => x.sev !== 'info')) log(`  [${f.sev.toUpperCase()}] ${f.id}: ${f.msg}${f.evidence ? `\n         ${f.evidence}` : ''}`)
log(`\nverdict = ${verdict.toUpperCase()}（red ${red.length} / yellow ${yellow.length} / info ${report.counts.info}）`)
if (OUT) { writeFileSync(OUT, JSON.stringify(report, null, 2)); log(`报告已写入 ${OUT}`) }
if (!KEEP) rmSync(tmp, { recursive: true, force: true })
else log(`tarball 保留在 ${tmp}`)
process.exit(red.length ? 1 : 0)

// ── 2026-10-17 路线甲（先清欠账）尝试记录：**两次都没能让候选版本装上，原因待查** ──────────
// 目的：把 dsh 抬到 0.2.1-rc.1（欠账：alpha.4 41.0h / alpha.5 17.6h / rc.1 2.9h）。
// 尝试①：手工跑 runtime 自带 pnpm —— `& <runtime>\bin\pnpm.cmd add '@deepseek-ai/dsh@0.2.1-rc.1'`
//   （cwd=runtime）。结果：**no-op** —— 装完 runtime/package.json 仍是 `0.2.1-alpha.3`，
//   `node node_modules/@deepseek-ai/dsh/lib/bin.js --version` 仍报 alpha.3。
//   已定位的可能原因（未验证，别当结论）：manager 的注释写明"store 路径失配修复**必须在任何 pnpm install 前**执行"，
//   手搓 pnpm 绕过了它；另外 native 依赖（koffi/node-pty…）与 allowBuilds 也需要 manager 的管线。
// 尝试②：改 **dev 已安装副本**的 `resources\manager\server-manager.mjs` 地板为 0.2.1-rc.1 后启动 dev 壳，
//   让 manager 自己按 max(latest, floor) 安装。结果：等 150s 后 runtime 仍是 alpha.3，日志里**没有任何安装尝试行**
//   （只有 `activated: pending-open=None`）。是"地板编辑没生效"还是"manager 判定无需安装"**尚未确定**。
// ⚠️ **未核实项（下一会话第一件事）**：尝试② 对 dev 安装副本的那处编辑是否真的生效、是否已回滚**没验证成功**
//   （回滚脚本无输出）。核实/回滚一行命令：
//   `Select-String -Path 'C:\Users\qqwto\AppData\Local\DSH Smoothly Desktop Dev\resources\manager\server-manager.mjs' -Pattern "MIN_DSH_VERSION = '([^']+)'"`
//   —— 期望值 `0.2.1-alpha.3`；若为 `0.2.1-rc.1` 就把它改回去（正式版从未被触碰）。
// 结论：清欠账的正确入口是**跑 manager 自己的升级路径**（或找出 install 未触发的原因），不是手搓 pnpm；
//   下一步建议：先只读核实那处编辑状态，然后在 dev 上触发一次真实升级（壳内菜单「检查更新」/ manager 的
//   `update-dsh` 路径），用它的日志确认候选版本能否干净装上。

// ── 2026-10-17 晚 续查：未核实项已清，但"改地板让 manager 自己装"仍无效果，且**写入本身疑似被挡** ──
// ✅ 已核实（上轮遗留）：dev 安装副本 `C:\Users\qqwto\AppData\Local\DSH Smoothly Desktop Dev\resources\manager\server-manager.mjs`
//    存在，地板值 = `0.2.1-alpha.3` ⇒ **上轮那处编辑从未生效**（脚本判为 "no revert needed"）。所以尝试②的真实原因是
//    "地板没被改"（而不是"manager 判定无需安装"）—— 正式版全程未被触碰。
// ❌ 尝试③：改用**按行号精确改写**（Select-String 取行号 → 改该行 → Set-Content → 回读校验）并启动 dev 观察安装。
//    结果又是**静默无输出**：脚本自报的"命中行/写后/已启动"一行都没打印，runtime 仍是 alpha.3，日志无安装行。
// 🔎 新增假设（有旁证，**未证实**）：**经 PowerShell 写入 Windows 侧用户目录的写操作在本会话里失败/被挡** ——
//    旁证：本轮三次 `Set-Content` 到 `AppData\Local\...` 全部无输出无效，而**同一会话里经 stdin 管道写
//    `D:\Dev\_install\*.exe` 是大文件也成功**（安装器落地 + SHA256 校验通过）。可能与环境/文件策略有关。
// ⚠️ 因此"清欠账"下一步的正确顺序（别直接再改地板）：
//    ① 先验证写入通路：往目标目录写一个小探针文件并回读（**不要再用 grep 过滤 PowerShell 输出**，
//       静默失败就是这样漏掉的 —— 必须看 stderr/CLIXML 原文）；
//    ② 写入通路确认后，优先用**产品自己的升级路径**（壳内「检查更新」→ 更新，或 manager 的 update-dsh）
//       让 manager 安装候选版本，而不是手工改它随包副本的地板；
//    ③ 候选装成后，才做仓库侧适配（抬 `MIN_DSH_VERSION` 两份副本 + `--update-fixture` 重采 + 插件 peer 对齐 + 门禁）。

// ── 2026-10-17 深夜 结论修正（上方"写入被挡"假设**已证伪**，真因另有其物） ──────────────
// ① 写入通路是好的：放开策略后探针文件写入 + 回读成功（WRITE-OK / PROBE-CLEANED）。
// ② 真因：我用的 `Set-Content -Encoding UTF8` 在 PS 5.1 下**给文件加了 BOM 并把中文注释写成乱码**
//    （`—` → `鈥?`，读时按 ANSI 解码）⇒ 改的是 dev 已安装副本 `…\DSH Smoothly Desktop Dev\resources\manager\server-manager.mjs`。
//    教训：改 Windows 侧文本文件**不要用 PS Set-Content 往返**；正解是 python 生成字节 + stdin 管道 WriteAllBytes（已验证）。
// ③ 用逐字节干净副本（只差地板行 = 0.2.1-rc.1）重跑：manager **仍在 ~2s 内 exit 1**
//    ⇒ "我写坏文件"也被推翻；**真凶是地板值触发的安装路径**（该环境里 registry 路线不通那一类）。
// ④ 已还原：dev 副本逐字节恢复为仓库版本（floor=0.2.1-alpha.3，diff 空）、dev 壳已停（无 crash 循环）、
//    **正式版全程未触碰**。dev runtime 文件完好（dsh bin.js 在、node_modules 247 项）但该实例当前起不来服务。
// ⑤ **新发现的诊断盲点（值得进方案）**：crash 报告目录只有 summary.json / wer.txt / shell-session.log.tail /
//    orphans.txt，**没有 manager 自己的 stdout/stderr** ⇒ "启动期失败（退出码 1）"看不到原因。
//    下一步最快的取证：**手工跑一次 manager** 抓 stderr（shell 不捕获它）；或重置 dev runtime 后重试。
// ⑥ 因此"清欠账"的真实前置条件被重新定义：**先把安装链路弄通**（registry/代理路线），
//    而不是改地板 —— 地板只是触发那次安装的开关。

// ── 2026-10-17 深夜 终极定位：**两次误判都是我造成的，产品侧没有"安装链路不通"这回事** ────────────
// 手工跑 manager 抓 stderr（壳不捕获它，见上方"诊断盲点"）拿到真正的报错：
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find module
//     '…\DSH Smoothly Desktop Dev\resources\manager\bake-port.mjs'
//     imported from '…\resources\manager\server-manager.mjs'
// ⇒ 根因：我上一步"还原"时把**仓库当前版**的 server-manager.mjs（它 import './bake-port.mjs'）覆盖到
//   **旧构建的 dev 安装**上，而那个 manager 目录里没有 bake-port.mjs ⇒ import 失败 ⇒ 秒退 1。
//   所以此前所有"启动期失败 / 网络不通 / 地板触发安装失败"的推论**全部作废** —— manager 根本没走到安装那一步。
// ✅ 修复（仓库文档化的热部署做法：整目录覆盖）：`tar -czf - -C src-tauri/resources/manager .` 经 stdin 管道
//   送进 Windows 后 `tar -xzf` 到 dev 安装的 resources\manager\ ⇒ 六个 .mjs 全部就位。
// ✅ 恢复验证：manager 重启后日志有**新行**、`dsh web: http://127.0.0.1:58078/?token=…` 起来 ⇒ dev 健康。
// 新数据（同时刻 registry）：`npm latest … 0.2.0-rc.2 (next 0.2.1-rc.2)` ⇒ 欠账现为 **alpha.4/alpha.5/rc.1/rc.2 四个**；
//   manager 明示 `pre-release update available … (next tag, user decides)` ⇒ **预发布走用户显式触发**
//   （壳内「检查更新」→ 立即更新，或桥 `/update-dsh`），这正是清欠账该走的路径 —— 而不是手工改地板。
// 下一步（顺序）：① 用产品自己的预发布升级路径在 dev 上装 0.2.1-rc.2；② 装成后按方案走仓库侧适配。