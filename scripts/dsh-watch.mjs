#!/usr/bin/env node
// dsh-watch —— 上游发布探测（方案 P0 §3.2）。**逻辑提取成脚本**才可本地演练：
// 原先内联在 workflow 的 bash 里，"建 issue 那条路径"从未被跑过（首次实跑时因当天没有新版本
// 走的是"无事发生"分支）—— 这类"代码在但路径没跑过"的缺口正是首次实跑暴露出来的。
//
//   node scripts/dsh-watch.mjs [--dry-run] [--force-target <version>] [--json <out>]
//                              [--registry <url>] [--floor <version>] [--now <iso>] [--force-published <iso>]
//
// 演练参数（--registry / --floor / --now / --force-published）只为本地回放：本机 npm CLI 不可用、
// 直连 npmjs 会超时，所以演练要用本地 stub registry（python http.server + 手写 packument）指向。
//
// 默认行为：读壳地板（scripts/server-manager.mjs）→ 取 npm dist-tags → 比较 → 需要适配就开/更新
// `dsh-upgrade` issue（正文含 6h 倒计时与八步适配清单）。**不改地板、不建 PR**。
// --force-target：把某版本强制当作"需要适配"（演练 issue 路径）；配合 --dry-run 可零副作用跑全路径。
//
// 零 secret：只用 GITHUB_TOKEN（issues: write）。退出码恒为 0 —— 红色应当只代表"这个 job 坏了"，
// 而不是"今天没有新版本"（否则真故障会被假红淹没）。

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANAGER = join(ROOT, 'scripts/server-manager.mjs')
const argv = process.argv.slice(2)
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
const DRY = argv.includes('--dry-run')
const FORCE = arg('--force-target')
const OUT = arg('--json')
const REPO = arg('--repo', process.env.GITHUB_REPOSITORY ?? 'karoc/dsh-desktop')
const GH = process.env.GH_BIN ?? 'gh'
const SLA_HOURS = Number(arg('--sla-hours', '6'))
const BEST_EFFORT_HOURS = Number(arg('--best-effort-hours', '24'))
// 本机 npm CLI 不可用、直连 npmjs 会超时 ⇒ 演练必须能指向本地 stub registry（python http.server + 手写 packument）。
const REGISTRY = (arg('--registry', process.env.DSH_WATCH_REGISTRY ?? 'https://registry.npmjs.org')).replace(/\/+$/, '')
// --now 只用于演练（把"现在"钉在某个时刻）。坏输入必须当场报错：旧实现里
// `new Date('garbage')` ⇒ NaN ⇒ 所有比较为 false ⇒ 静默判"未违约"（假阴性）。
const NOW_ARG = arg('--now')
const NOW = NOW_ARG ? new Date(NOW_ARG) : new Date()
if (Number.isNaN(NOW.getTime())) {
  console.error(`--now 不是合法时间：${NOW_ARG}（要 ISO 8601，例如 2026-10-19T12:00:00Z）—— 拒绝用坏时间戳静默判"未违约"`)
  process.exit(2)
}
const FORCE_PUBLISHED = arg('--force-published')

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
  console.error(`拿不到 npm packument（${url}；直连与代理都失败）—— 这是**真故障**，故非零退出`)
  process.exit(1)
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
if (OUT) writeFileSync(OUT, JSON.stringify({ floor, tags, target, kind, threshold, deadline, elapsed, breached, pubUnknown, registry: REGISTRY, generatedAt: new Date().toISOString() }, null, 2))
if (!target) process.exit(0)

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
const body = breached
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
const label = breached ? 'sla-breach' : 'dsh-upgrade'
const title = breached
  ? `[SLA 未达标] dsh ${target} ${pubUnknown ? '发布时长未知（npm 无发布时间戳）' : `已发布 ${elapsed.toFixed(1)}h`}（门槛 ${threshold}h），地板仍停在 ${floor}`
  : `[dsh-watch][${kind}] dsh ${target} 比地板 ${floor} 新`

if (DRY) {
  console.log(`\n[dry-run] breached=${breached}（门槛 ${threshold}h，已过 ${elapsed === null ? '—' : elapsed.toFixed(2) + 'h'}）`
  + `\n          会以 label=${label} 开/更新 issue，标题：${title}`
  + `\n          正文 ${body.length} 字符 —— 未执行任何写操作。`)
  process.exit(0)
}

const bodyFile = join(tmpdir(), 'dsh-watch-body.md')
writeFileSync(bodyFile, body)
try { execFileSync(GH, ['label', 'create', label, '--description', breached ? 'SLA 未达标（方案 §6）' : '上游 dsh 新版本待适配', '--color', breached ? 'b60205' : '1d76db'], { encoding: 'utf8' }) } catch (e) { /* 已存在即可 */ }
// 去重必须按**版本号词边界**匹配，不能用 `contains(target)`：`contains("0.2.1")` 会命中已存在的
// `0.2.1-rc.2` issue ⇒ 上游转正时评论挂到预发布单上，正式版永远没有自己的跟踪/未达标 issue。
// 词边界 = 前后不能是 [0-9A-Za-z.-]，于是 `0.2.1` 不匹配 `0.2.1-rc.2`，也不匹配 `0.2.10`。
// 同时：gh 的 `--jq` 过滤无从加 --limit（默认只取 30 条 open issue）⇒ 改成取 JSON 后在 node 里过滤，
// 一次拿 100 条（本机无 jq 也照跑）。
const titlePattern = new RegExp(`(^|[^0-9A-Za-z.-])${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9A-Za-z.-]|$)`)
const listing = JSON.parse(execFileSync(GH, ['issue', 'list', '--label', label, '--state', 'open', '--json', 'number,title', '--limit', '100'], { encoding: 'utf8' }))
const existing = listing.find((i) => titlePattern.test(i.title ?? ''))?.number ?? ''
if (existing) {
  execFileSync(GH, ['issue', 'comment', String(existing), '--body-file', bodyFile], { encoding: 'utf8' })
  console.log(`${breached ? 'SLA 未达标' : '跟踪'} issue 已更新：#${existing}（按词边界命中标题）`)
} else {
  console.log(`（已扫描 ${listing.length} 个 open issue，无 ${target} 的词边界命中 ⇒ 新建）`)
  execFileSync(GH, ['issue', 'create', '--label', label, '--title', title, '--body-file', bodyFile], { encoding: 'utf8' })
  console.log(breached ? '已开 SLA 未达标 issue（方案 §6）' : '已开跟踪 issue')
}
