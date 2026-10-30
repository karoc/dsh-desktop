#!/usr/bin/env node
// dsh 升级 SLA 报表（自动化方案 P2）—— 对每个已发布版本量出「官方发布 → 我们发布稳定版」的真实耗时，
// 并把它拆成两段可指导行动的数字：**检测**（上游发布 → 我们首次开单）与**适配**（地板提交 → 我方发布），
// 外加一段"当前状态"实时信号（最新 watch issue / 各通道最新版本 / 壳地板 / 有没有未关闭的跟踪 issue）。
//
//   node scripts/dsh-sla-report.mjs [--json <out>] [--issue] [--fail-on-breach] [--recent 3]
//                                   [--since 2026-10-19] [--registry <url>] [--repo <owner/name>] [--assignee <login>]
//                                   [--now <iso>]（演练：钉住"现在"，只影响"距今多久"）
//
// ── 为什么**不**接入 A6 的三态/退避状态机（2026-10-24 决定）───────────────────────
//   它是**每周**一趟的报表 job（`.github/workflows/dsh-sla-report.yml`，周一 01:00 UTC），且 issue
//   upsert 已用正文里的 `dsh-sla-report-state` digest 去重（版本集合/达标状态没变时连 edit 都跳过）
//   ⇒ 不存在"每 10 分钟重印同一段错误"的路径，接入只会多一个要维护的状态文件。
//   同样的理由见 `docs/2026-10-17-dsh-upgrade-automation-plan.md` §3.8.1 的"未做"清单。
//
// 口径（方案 §1.1a，与人工基线一致）：
//   起点 T0   = npm `time[<该版本随包地板>]`（上游发布时间）
//   地板提交  = `git log -G"MIN_DSH_VERSION = '<v>'" -1 <tag>`（我们开始承诺该地板的提交）
//   终点      = 该版本 GitHub Release 的 publishedAt（我们对外发布）
//   SLA 6h    = 终点 − 起点 ≤ 6h（方案 §1.1b：latest 通道硬指标）
//
// ── 两段延迟（2026-10-22 加；这是报表现在的主读数）─────────────────────────────
//   检测（detection）  = 上游发布 T0 → **首次为该版本开 issue** 的 createdAt。
//                        数据源：`gh issue list --state all`（**不按 label**）后用与 `dsh-watch.mjs` 共用的
//                        确定性键筛（`scripts/lib/issue-key.mjs`：标题前缀 `[dsh-watch]`/`[SLA 未达标]` +
//                        版本号词边界 + `dsh <版本>` 锚点）；再与 npm packument 里该版本的 `time` 相减。
//                        为什么不能用 label：PAT 缺 Issues:write 时 label 从未落地（事故里 16 条 issue 无
//                        label），按 label 取数会把每一个版本的检测延迟都静默判成「未检测到」。
//                        **找不到对应 issue ⇒ unknown，表格里显式打印「未检测到」，绝不当 0**。
//   适配（adaptation） = 地板提交 → 我方发布 —— **沿用旧口径**，即 JSON 里原有的 `release` 字段
//                        （旧报表把它印成"发布"，本轮只改列名，数值不变）。
//   抬地板             = 上游发布 → 地板提交（JSON 原有 `adapt` 字段；旧报表印成"适配"，本轮改名）。
//   合计               = 上游发布 → 我方发布（`total`，门禁判的就是它）。
//   ⚠️ 检测段与适配段**不首尾相接**：中间还隔着"开单 → 抬地板"（可用 检测 与 抬地板 两列相减得到）。
//
// 为什么检测延迟**不**进门禁：它量的是"上游发出来之后我们多久才发现"，而发现依赖定时探测所在的
// 机器 / runner 是否在跑、issue 是否被限流 —— 那是**平台属性**，不是适配能力。把它写进 `--check` /
// `--fail-on-breach` 只会让门禁随平台抖动而红绿。门禁口径**与旧实现逐位相同**：仍只看 `total`
// （上游发布 → 我方发布 ≤ 6h）+ since/recent 两条窗口规则。
//
// 配对方式：Release tag `vX.Y.Z` 的**tag 树上**读 `MIN_DSH_VERSION` 得到它随包分发的 dsh 版本；
// 读不到（历史早期 tag）则跳过并给出理由，不猜。
//
// 门禁口径（2026-10-19 两条修正，见 --check）：
//   ① **无数据即红**：量不出任何版本 ⇒ 不能算通过（旧实现 `0/0 ⇒ exit 0`，是假绿）；
//   ② **只看 since 之后首发的版本**：默认 `--since 2026-10-19`（方案落地日）。历史欠账（首发早于
//      since）仍在报表里逐条显示，但**不参与退出码** —— 否则门禁在历史信息上恒红，等于没有门禁。
//
// 时间口径（2026-10-19 修正）：表格与 JSON 里的三个时刻**统一成 UTC ISO（toISOString）**，列头写明 UTC。
//   旧实现对新 npm 时间戳取 slice(0,16) 得 "2026-10-17T19:40"（Z），对 `git log --format=%cI` 得
//   "2026-10-18T03:39"（+08:00 本地偏移）——两个不同时区的串都截到分钟且都看不到后缀，同一行里
//   看起来"地板提交比上游发布晚 8 小时"，实际只差 54 秒。**不允许**再做这种跨时区混排。
//
// `--recent` 必须是正整数（0 = 退化成"检查全部"、负数/非数字 = slice 丢行或空集 ⇒ 静默改变门禁口径）。
// `--check` 的阈值以**报表里的 slaHours** 为准：与脚本内常量不一致就是口径漂移，报错而非静默择一。
//
// 零 secret：只用 GITHUB_TOKEN（issues: write）。默认只出报表；--check 才按上面的口径判红绿。

import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// 跟踪单的确定性键：与 `dsh-watch.mjs` 共用同一份实现（标题前缀 + `dsh <版本>` 锚点 + 词边界）。
// 这份模块存在的原因就是"报表按 label 取数、watch 按标题去重"那次漂移（事故 #201–#217）。
import { earliestTrackingIssue, isTrackingIssue, parseIssueVersion, TRACKING_PREFIXES } from './lib/issue-key.mjs'
// 「待适配」vs「已被更高地板覆盖」的分类（纯逻辑 + 单测）：地板单调上移，中间预发布被跳过后
// 不应永久留在 pending（实录 rc.3/rc.4 被 rc.5 跳过）。口径：用发布时间代理版本先后，见该模块头注释。
import { classifyPendingVersions } from './lib/sla-pending.mjs'
// 语义化版本比较（共享实现，parity 门禁覆盖）：报表判断「地板是否覆盖某版本」与「通道是否领先地板」。
import { cmpVersion } from './lib/version-compare.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
const OUT = arg('--json')
const UPSERT_ISSUE = argv.includes('--issue')
const FAIL_ON_BREACH = argv.includes('--fail-on-breach')
// --recent 必须是正整数：0 会退化成 `slice(0)` = 检查全部（"最近 0 个"却判绿是假绿），
// NaN（如 abc）会退化成"检查全部"，负数会 slice 掉前面的行 —— 三种都**静默改变门禁口径**。
const RECENT_RAW = arg('--recent', '3')
if (!/^\d+$/.test(String(RECENT_RAW).trim()) || Number(RECENT_RAW) < 1) {
  console.error(`--recent 必须是正整数（实得 ${JSON.stringify(RECENT_RAW)}）：0 ⇒ "检查全部"、非数字 ⇒ 检查全部、负数 ⇒ 丢掉最早的行，都是静默改变门禁口径`)
  process.exit(2)
}
const RECENT = Number(RECENT_RAW)
const REPO = arg('--repo') || process.env.GH_REPO || process.env.GITHUB_REPOSITORY || (() => {
  // issue 是 bot（GITHUB_TOKEN）创建的；GitHub 的推送默认只覆盖「参与中 / 被 @ 提及 / 被赋值」的线程
  // ⇒ 报表 issue 必须带 assignee + 正文 @提及。属主从 repo slug 推导；本机回退到 git remote origin。
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim()
    const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url)
    return m ? `${m[1]}/${m[2]}` : null
  } catch { return null }
})() || 'karoc/dsh-desktop'
// `GH_BIN` 缺省指向仓库自带的项目 PAT 包装 `scripts/gh`（与 `dsh-release-autopilot.mjs` 同口径）：
// 本机裸 `gh` 会落到全局 `~/.config/gh/hosts.yml` 里的另一个 token（历史上已因此用错凭据）。
// CI 的 `dsh-sla-report.yml` 显式设 `GH_BIN=gh`（runner 上只有 `GITHUB_TOKEN`，没有 token 文件）。
const GH = process.env.GH_BIN ?? (existsSync(join(ROOT, 'scripts', 'gh')) ? join(ROOT, 'scripts', 'gh') : 'gh')
// issue 由 bot 创建 ⇒ 必须显式 assignee + 正文 @提及（见下方 --issue 分支）。属主解析在**取数之前**做：
// 解析不到就直接报错，不先跑完 npm/git 再静默跳过赋值。
const OWNER = String(arg('--assignee') ?? process.env.DSH_ISSUE_ASSIGNEE ?? '').trim().replace(/^@/, '')
  || (/^[^/\s]+\/[^/\s]+$/.test(REPO) ? REPO.split('/')[0] : null)
if (UPSERT_ISSUE && !OWNER) {
  console.error(`解析不到 issue 属主（assignee 目标）：REPO=${JSON.stringify(REPO)} 不是 OWNER/NAME。`
    + '\n用 --assignee <login> / --repo <owner/name> / GH_REPO / GITHUB_REPOSITORY 指定。'
    + '\n不赋值 = bot 开的 issue 很可能不推送（GitHub 只通知参与者/被@/被赋值者）—— 拒绝静默跳过。')
  process.exit(2)
}
const SLA_HOURS = 6
// 门禁起始日（方案落地日）。可用 --since 覆盖，便于演练与后续调整。
const SINCE = arg('--since', '2026-10-19')
const SINCE_MS = new Date(SINCE).getTime()
if (Number.isNaN(SINCE_MS)) {
  console.error(`--since 不是合法日期：${SINCE}（要 ISO 8601，例如 2026-10-19 或 2026-10-19T00:00:00Z）`)
  process.exit(2)
}
// npm CLI 本机不可用、直连 npmjs 会超时 ⇒ 允许指向本地 stub registry（演练/离线复核）。
const REGISTRY = (arg('--registry', process.env.DSH_SLA_REGISTRY ?? 'https://registry.npmjs.org')).replace(/\/+$/, '')
// `--now` 只用于演练/负向对照：钉住"现在"（当前状态里的"距今多久"要用它）。坏输入当场报错 ——
// 与 `dsh-watch.mjs` 同口径：`new Date('garbage')` ⇒ NaN ⇒ 所有"距今"变 NaN 却不报错。
const NOW_ARG = arg('--now')
const NOW = NOW_ARG ? new Date(NOW_ARG) : new Date()
if (Number.isNaN(NOW.getTime())) {
  console.error(`--now 不是合法时间：${NOW_ARG}（要 ISO 8601，例如 2026-10-22T00:00:00Z）—— 拒绝用坏时间戳静默算"距今"`)
  process.exit(2)
}
// 壳地板（当前 HEAD 的 `scripts/server-manager.mjs`）——"当前状态"块要它。读不到就显式说读不到，不猜。
const HEAD_FLOOR = (() => {
  try { return /MIN_DSH_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(join(ROOT, 'scripts', 'server-manager.mjs'), 'utf8'))?.[1] ?? null } catch { return null }
})()

/** 该版本是否落在门禁口径内：**上游首发时间**晚于 since。 */
const inScope = (r) => Boolean(r.t0) && new Date(r.t0).getTime() >= SINCE_MS
const h = (v) => (Number.isFinite(v) ? `${v.toFixed(2)}h` : '—')

const CHECK = arg('--check')
if (CHECK) {
  // 门禁独立成步：红色只代表"SLA 未达标"或"根本没量出来"，与"报表 job 坏了"可区分（首次实跑的教训）
  let data = null
  try { data = JSON.parse(readFileSync(CHECK, 'utf8')) } catch (error) {
    // 读不到/解析不了 = 没判断。**不能**静默放行（旧实现会让这一步以异常栈退出，语义上等价于红，
    // 但错误信息说不清是"报表没生成"还是"报表坏了"，这里显式说清）。
    console.error(`SLA 门禁红：读不到或解析不了报表 ${CHECK} —— ${error.message}（"量不出来"不等于"达标"）`)
    process.exit(1)
  }
  const perVersion = data.perVersion ?? []
  // 阈值口径必须与报表一致：旧实现硬编码 6h，报表按别的 slaHours 量时，门禁按另一个阈值判 —— 口径漂移不可见。
  if (data.slaHours === undefined || data.slaHours === null) {
    console.error(`SLA 门禁红：报表 ${CHECK} 里没有 slaHours 字段 —— 阈值口径不可判定，拒绝用脚本内硬编码的 ${SLA_HOURS}h 静默替代（"量不出来"不等于"达标"）`)
    process.exit(1)
  }
  if (Number(data.slaHours) !== SLA_HOURS) {
    console.error(`SLA 门禁红：口径漂移 —— 报表的 slaHours=${data.slaHours}，本脚本内是 ${SLA_HOURS}h。`
      + '报表按一个阈值量、门禁按另一个阈值判，两边必须同源；请统一（报表用 --sla-hours？改脚本常量？）后重跑。')
    process.exit(2)
  }
  if (perVersion.length === 0) {
    // ① 无数据即红：最近 0 个版本中 0 个超 6h 是**没有判断**，不是通过。
    console.error(`SLA 门禁红：报表里没有任何已量出的版本（${CHECK} 的 perVersion 为空）——`
      + ' 量不出任何版本不能算通过。常见原因：npm 取不到时间戳 / tag 树上读不到地板 / gh api 失败。')
    process.exit(1)
  }
  const scoped = perVersion.filter(inScope)
  const historical = perVersion.filter((r) => !inScope(r))
  const recent = scoped.slice(-RECENT)
  const bad = recent.filter((r) => !r.ok)
  console.log(`SLA 门禁：since=${SINCE}（上游首发日）之后量出 **${scoped.length}** 个版本，`
    + `其中最近 ${recent.length} 个里 ${bad.length} 个超 ${SLA_HOURS}h`
    + (bad.length ? `：${bad.map((r) => `${r.shell}=${h(r.total)}`).join(', ')}` : ''))
  if (recent.length === 0) console.log(`  注：since 之后还没有新首发的版本 ⇒ 无欠账，门禁绿（不是 0/0 的假绿）`)
  if (historical.length) {
    console.log(`  历史欠账 ${historical.length} 个（首发早于 ${SINCE}）只在报表里展示、不影响退出码：`
      + historical.map((r) => `${r.shell}=${h(r.total)}`).join(', '))
  }
  process.exit(bad.length ? 1 : 0)
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
const hours = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / 3600000
const fmt = (h) => (Number.isFinite(h) ? `${h.toFixed(2)}h` : '—')
/** 三个时刻统一成 UTC ISO（toISOString，带 Z）。**不要**再对原始串 slice：npm 给 Z、git 给本地偏移，
 *  截断后两者都看不到时区后缀 ⇒ 同一行看起来相差 8 小时（审计实测 floorCommitAt=+08:00 与 publishedAt=Z）。 */
const utc = (t) => {
  if (!t) return null
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
/** 表格单元格：UTC ISO 截到分钟 + 显式 Z（列头已写明 UTC）。 */
const utcCell = (iso) => (iso ? `${iso.slice(0, 16)}Z` : '—')

// npm packument：直连失败时走 HTTPS_PROXY（本机取证：裸 fetch/直连会超时）
function npmPackument() {
  const url = `${REGISTRY}/@deepseek-ai/dsh`
  const attempts = [['-fsS'], ...(process.env.HTTPS_PROXY ? [['-fsS', '-x', process.env.HTTPS_PROXY]] : [])]
  for (const extra of attempts) {
    try { return JSON.parse(sh('curl', [...extra, '--max-time', '40', url])) } catch { /* next */ }
  }
  throw new Error(`拿不到 npm packument（${url}；直连与代理都失败）`)
}
const packument = npmPackument()
const times = packument.time ?? {}
const tags = packument['dist-tags'] ?? {}

// ── 检测延迟的数据源：**跟踪 issue 的确定性键**（不按 label）──────────────────
// 旧实现按 `--label dsh-upgrade` / `--label sla-breach` 各查一次（gh 的重复 `--label` 是 AND 语义，
// 不能合成一条 —— 那会恒返回空）。但真正的事故在别处：PAT 缺 Issues:write 时 `issue create` 能过、
// **label 从未落地**（事故 #201–#216 的 16 条 issue 都没有 label）⇒ 按 label 取数查到 0 条 ⇒ 每个版本的
// 检测延迟都被静默判成「未检测到」，而 issue 明明开着（"没有判断"被伪装成"确实没有 issue"）。
// 现在改用与 `dsh-watch.mjs` **同一套确定性键**（唯一实现 `scripts/lib/issue-key.mjs`）：
//   ① 标题前缀 `[dsh-watch]` / `[SLA 未达标]`（人类手写的 issue 与报表自己的 `sla-report` issue 都不算）；
//   ② 版本号按**词边界**解析，`dsh <版本>` 锚点优先（watch 标题里同时有 target 与"当时的地板"两个版本号）；
//   ③ `--state all`：检测延迟取 `createdAt`，**关掉的单同样是历史证据**；不看 label / assignee / state ——
//      三者都可能因权限或人工操作而缺失，而检测延迟问的是"这一版第一次被发现是什么时候"。
const ISSUE_LIMIT = 1000
function fetchTrackingIssues() {
  const raw = sh(GH, ['issue', 'list', '--state', 'all', '--limit', String(ISSUE_LIMIT),
    '--json', 'number,title,createdAt,closedAt,labels'])
  let list
  try { list = JSON.parse(raw) } catch (e) { throw new Error(`gh issue list 的返回值不是 JSON（前 200 字符）：${raw.slice(0, 200)}`) }
  if (!Array.isArray(list)) throw new Error(`gh issue list 的返回值不是数组（前 200 字符）：${raw.slice(0, 200)}`)
  // 命中 `--limit` 上限 ⇒ 被截掉的可能包含**最早**的 issue，而"首次开 issue"要的正是最早那条 ⇒
  // 检测延迟只会偏大。宁可不出数，也不出一个可能偏大的数。
  if (list.length >= ISSUE_LIMIT) {
    throw new Error(`gh issue list 命中 --limit ${ISSUE_LIMIT} 上限（返回 ${list.length} 条）：`
      + '被截掉的可能包含最早的 issue ⇒ 检测延迟会偏大。拒绝出数（提高 --limit 后重跑）。')
  }
  return list.filter((i) => isTrackingIssue(i))
}

const watchIssues = fetchTrackingIssues().map((i) => ({ ...i, parsed: parseIssueVersion(i.title) }))
// 同一版本多条 issue（watch 重复建单 / 人工补开 / 改过标题）⇒ **取最早创建**那条：检测延迟问的是
// "这一版第一次被发现"，不是"最近一次建单"。同刻创建（gh 时间戳只到秒，事故里 #216/#217 撞在同一秒）
// 按编号小的优先（编号单调 = 先开的单），结论与列表顺序无关。取到哪条会印在表格与"注意"里。
const issueByVersion = new Map()
for (const v of new Set(watchIssues.map((i) => i.parsed.version).filter(Boolean))) {
  issueByVersion.set(v, earliestTrackingIssue(watchIssues, v).earliest)
}
// label 只当**信号**（不参与取数）：无 label 的跟踪单数量 = PAT 缺 Issues:write 留下的痕迹。
const labelsOf = (i) => (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
const TRACKING_LABELS = ['dsh-upgrade', 'sla-breach']
const unlabeled = watchIssues.filter((i) => !labelsOf(i).some((n) => TRACKING_LABELS.includes(n))).length

const rel = sh(GH, ['api', `repos/${REPO}/releases?per_page=100`, '--jq', '.[] | [.tag_name, .published_at] | @tsv'])
  .split('\n').filter(Boolean).map((l) => l.split('\t'))

const rows = []
for (const [tag, publishedAt] of rel) {
  if (!/^v\d+\.\d+\.\d+/.test(tag)) continue
  let floor = null
  try {
    const dump = sh('git', ['show', tag + ':scripts/server-manager.mjs'])
    const m = /MIN_DSH_VERSION\s*=\s*'([^']+)'/.exec(dump)
    floor = m ? m[1] : null
  } catch (e) { floor = null }
  if (!floor) { rows.push({ tag, skip: 'tag 树里读不到 MIN_DSH_VERSION' }); continue }
  const t0 = times[floor]
  if (!t0) { rows.push({ tag: tag, floor: floor, skip: 'npm 上没有 ' + floor + ' 的发布时间' }); continue }
  let floorCommitAt = null
  try { floorCommitAt = sh('git', ['log', `-GMIN_DSH_VERSION = '${floor}'`, '--format=%cI', '-1', tag]) || null } catch { /* ignore */ }
  const total = hours(t0, publishedAt)
  const adapt = floorCommitAt ? hours(t0, floorCommitAt) : null
  const release = floorCommitAt ? hours(floorCommitAt, publishedAt) : null
  // 检测延迟：上游发布 → 首次为该地板版本开 issue。**没有对应 issue 就是 unknown（null）**，
  // 表格里印「未检测到」；写成 0 等于宣称"上游一发我们就发现了"，那是没有验证过的判断。
  const issue = issueByVersion.get(floor) ?? null
  const detectionIssueAt = issue ? utc(issue.createdAt) : null
  const detection = detectionIssueAt ? hours(t0, detectionIssueAt) : null
  const detectionAnomaly = detection !== null && detection < 0 ? '首次 issue 早于该版本的上游发布时间（时间戳异常）' : null
  // 时长用原值算（时区不影响差值），落表/落 JSON 的一律是 UTC ISO。
  rows.push({
    tag, shell: tag.slice(1), floor, t0: utc(t0), floorCommitAt: utc(floorCommitAt), publishedAt: utc(publishedAt),
    adapt, release, total, ok: total <= SLA_HOURS,
    detection, detectionStatus: issue ? 'measured' : 'unknown-no-issue',
    detectionIssue: issue ? issue.number : null, detectionIssueAt,
    detectionIssueClosedAt: issue ? utc(issue.closedAt) : null,
    detectionAnomaly,
  })
}

// SLA 的量纲是「**一个上游版本**从发布到我们发出稳定版」，所以必须按 dsh 版本聚合：
// 同一个地板可能被多个壳版本携带（0.18.0–0.18.4 都是 alpha.3），按 Release 计数会重复计量。
// 取每个地板**最早**的那次 Release（= 该版本适配完成的时点），全量明细仍留在 JSON 里。
const allMeasured = rows.filter((r) => !r.skip)
const byFloor = new Map()
for (const r of allMeasured) {
  const prev = byFloor.get(r.floor)
  if (!prev || new Date(r.publishedAt) < new Date(prev.publishedAt)) byFloor.set(r.floor, r)
}
const measured = [...byFloor.values()].sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt))
// 已量出版本携带过的地板集合 —— "这个版本是否已被适配"的判据（下方 pending 段与注意段共用）。
const measuredFloors = new Set(measured.map((r) => r.floor))
const skipped = rows.filter((r) => r.skip)
const totals = measured.map((r) => r.total).sort((a, b) => a - b)
const median = totals.length ? totals[Math.floor(totals.length / 2)] : NaN

const lines = []
// 列定义集中在一处：表头 / 分隔行 / 数据行 / 末尾"两段中位/最大"行都由它生成，
// 避免"加了一列却漏改分隔行"这种只在渲染时才暴露的漂移。
const COLS = [
  ['首个携带该地板的版本', (r) => r.shell],
  ['随包地板', (r) => `\`${r.floor}\``],
  ['上游发布 (UTC)', (r) => utcCell(r.t0)],
  // 印出**取到哪一条**（#编号）：同版本可能有多条 issue，取最早那条；只有时间没有编号时读者无法复核。
  ['首次 issue (UTC)', (r) => (r.detectionIssueAt ? `#${r.detectionIssue} ${utcCell(r.detectionIssueAt)}` : '—')],
  ['地板提交 (UTC)', (r) => utcCell(r.floorCommitAt)],
  ['我方发布 (UTC)', (r) => utcCell(r.publishedAt)],
  ['抬地板', (r) => fmt(r.adapt)],
  ['**检测**', (r) => (r.detection === null ? '未检测到' : fmt(r.detection))],
  ['**适配**', (r) => fmt(r.release)],
  ['**合计**', (r) => `**${fmt(r.total)}**`],
  ['≤6h', (r) => (r.ok ? '✅' : '❌')],
]
lines.push(`| ${COLS.map(([label]) => label).join(' | ')} |`)
lines.push(`|${COLS.map(() => '---').join('|')}|`)
for (const r of measured) lines.push(`| ${COLS.map(([, get]) => get(r)).join(' | ')} |`)

const gateScoped = measured.filter(inScope)
const gateHistory = measured.filter((r) => !inScope(r))
/** 中位/最大（中位口径沿用旧实现：偶数个取上半，`[floor(n/2)]`）。unknown（null）不计入，只报条数。 */
const seg = (vals) => {
  const s = vals.filter(Number.isFinite).sort((a, b) => a - b)
  return { n: s.length, median: s.length ? s[Math.floor(s.length / 2)] : NaN, max: s.length ? s[s.length - 1] : NaN }
}
const det = seg(measured.map((r) => r.detection))
const detUnknown = measured.filter((r) => r.detection === null).length
const ada = seg(measured.map((r) => r.release))
const flo = seg(measured.map((r) => r.adapt))
const twoSegText = `检测 中位 ${fmt(det.median)} / 最大 ${fmt(det.max)}（可判定 ${det.n}/${measured.length}；未检测到 ${detUnknown}）；`
  + `适配 中位 ${fmt(ada.median)} / 最大 ${fmt(ada.max)}（${ada.n}）`
// "最后给一行两段中位/最大"：填在 检测 / 适配 两列下，其余列 —（列数由 COLS 决定，不会错位）。
// 检测一条都判定不出时**不印"—"**（那看起来像"零"）：明写"未检测到（0/N 可判定）"。
const detCell = det.n ? `**中位 ${fmt(det.median)} / 最大 ${fmt(det.max)}**` : `**未检测到（0/${measured.length} 可判定）**`
lines.push(`| ${COLS.map(([label]) => {
  if (label === '**检测**') return detCell
  if (label === '**适配**') return ada.n ? `**中位 ${fmt(ada.median)} / 最大 ${fmt(ada.max)}**` : '—'
  return label === '首个携带该地板的版本' ? '**两段中位 / 最大**' : '—'
}).join(' | ')} |`)

const stats = [
  `已量出版本：**${measured.length}**（跳过 ${skipped.length}）`,
  measured.length ? `合计中位 **${fmt(median)}**、最好 ${fmt(totals[0])}、最差 ${fmt(totals[totals.length - 1])}` : '',
  measured.length ? `达标（≤${SLA_HOURS}h）：**${measured.filter((r) => r.ok).length}/${measured.length}**` : '',
  measured.length ? `抬地板段中位 ${fmt(flo.median)}（上游发布→地板提交）、适配段中位 ${fmt(ada.median)}（地板提交→我方发布）` : '',
  `门禁口径：` + `since=${SINCE} 之后首发的 **${gateScoped.length}** 个参与判定；历史欠账 **${gateHistory.length}** 个仅展示（不影响退出码）`,
].filter(Boolean)

// ── 当前状态（实时信号）：让读者一眼看出"是否已被发现、卡了多久" ────────────────
const openIssues = watchIssues.filter((i) => !i.closedAt)
const newestIssue = [...watchIssues].sort((a, b) => (new Date(b.createdAt) - new Date(a.createdAt)) || (b.number - a.number))[0] ?? null
const issueAgeH = newestIssue ? (NOW.getTime() - new Date(newestIssue.createdAt).getTime()) / 3600000 : null
const channels = ['latest', 'next', 'alpha'].map((ch) => ({
  channel: ch, version: tags[ch] ?? null, publishedAt: utc(tags[ch] ? times[tags[ch]] : null),
}))
const headFloorAt = HEAD_FLOOR ? utc(times[HEAD_FLOOR]) : null
// 版本先后用**语义化比较**（共享 `scripts/lib/version-compare.mjs`，已纳入 parity 门禁）。
// 2026-10-31 修：旧实现用发布时间作代理，实跑抓到反例 —— `0.2.2-alpha.2` 的发布时间早于
// `0.2.1-rc.5`（alpha 线先切出来）⇒ 被误判成"不晚于壳地板"，而它语义上更高、仍是待适配版本。
const cmpFloor = (v) => (HEAD_FLOOR ? cmpVersion(v, HEAD_FLOOR) : NaN)
const ahead = HEAD_FLOOR
  ? channels.filter((c) => c.version && Number.isFinite(cmpFloor(c.version)) && cmpFloor(c.version) > 0)
  : []
// ── 待适配版本的检测延迟（上游已发布 + 已有跟踪单，但还没有任何壳版本携带它）──────────
// 这些版本配不到"我方发布"⇒ 不进上面的两段表；但**检测段照样可算**（上游发布 → 首次开单），
// 而且这是"发版前唯一能看到检测段真实数字"的窗口（检测延迟本来就该在发版前被发现）。
// 旧实现（按 label 取数）在这里恒为"未检测到"—— 事故里 16 条 issue 无 label，正是这个位置永远空白。
// 2026-10-31 修：旧判据只认「**恰好**有壳版本携带该版本作地板」⇒ 被更高地板跳过的预发布（rc.3/rc.4）
// 永久留在 pending（"还有两个版本没适配"的假信号）。分类移到 `scripts/lib/sla-pending.mjs`。
const pendingPlan = classifyPendingVersions({
  versions: [...issueByVersion.keys()].filter((v) => times[v]), measured, carriedFloors: measuredFloors,
})
const pendingRow = (v) => {
  const issue = issueByVersion.get(v)
  const detection = hours(times[v], issue.createdAt)
  return {
    version: v, upstreamAt: utc(times[v]),
    issue: issue.number, issueAt: utc(issue.createdAt),
    issueCount: watchIssues.filter((i) => i.parsed.version === v).length,
    detection: Number.isFinite(detection) ? detection : null,
  }
}
const pending = pendingPlan.pending.map(pendingRow).sort((a, b) => new Date(a.upstreamAt) - new Date(b.upstreamAt))
// 被更高地板覆盖的版本**单列一段**：保留检测段数字，但不再读成「还欠着」（不计入 pending 计数）。
const coveredPending = pendingPlan.covered.map((c) => ({
  ...pendingRow(c.version),
  coveredBy: { shell: c.shell, floor: c.floor, publishedAt: utc(c.publishedAt) },
})).sort((a, b) => new Date(a.upstreamAt) - new Date(b.upstreamAt))
const pendingText = pending.length ? [
  '### 待适配版本的检测延迟（上游已发布 + 已有跟踪单，但我方还没发版）',
  '',
  '这些版本配不到"我方发布"⇒ 不在上面的两段表里；检测延迟照样可算（上游发布 → 首次开单，同版本多条取最早）。',
  '',
  '| 版本 | 上游发布 (UTC) | 首次 issue (UTC) | 检测 |',
  '|---|---|---|---|',
  ...pending.map((p) => `| \`${p.version}\` | ${utcCell(p.upstreamAt)} | #${p.issue} ${utcCell(p.issueAt)}（共 ${p.issueCount} 条） | **${fmt(p.detection)}** |`),
].join('\n') : ''
const coveredText = coveredPending.length ? [
  '### 已被更高地板覆盖（不计入待适配）',
  '',
  '地板是单调上移的：这些版本上游发过、也开过单，但下一次抬地板直接跨过去了 —— 语义上已被新地板覆盖，不算欠账。',
  '',
  '| 版本 | 上游发布 (UTC) | 首次 issue (UTC) | 检测 | 被谁覆盖（壳体版本 / 随包地板） |',
  '|---|---|---|---|---|',
  ...coveredPending.map((p) => `| \`${p.version}\` | ${utcCell(p.upstreamAt)} | #${p.issue} ${utcCell(p.issueAt)}（共 ${p.issueCount} 条） | **${fmt(p.detection)}** | ${p.coveredBy.shell}（floor \`${p.coveredBy.floor}\`） |`),
].join('\n') : ''
const statusLines = []
statusLines.push(`- **壳地板**（当前 HEAD 的 \`scripts/server-manager.mjs\`）：${HEAD_FLOOR ? `\`${HEAD_FLOOR}\`（上游发布 ${headFloorAt ? utcCell(headFloorAt) : '时间未知'}）` : '⚠️ 读不到 `MIN_DSH_VERSION` ⇒ 无法判断当前地板'}`)
statusLines.push(`- **上游最新各通道**：${channels.map((c) => (c.version ? `${c.channel}=\`${c.version}\`（${c.publishedAt ? utcCell(c.publishedAt) : '发布时间未知'}）` : `${c.channel}=—`)).join('、')}`)
statusLines.push(newestIssue
  ? `- **最新 watch issue**：#${newestIssue.number}「${newestIssue.title}」（开于 ${utcCell(utc(newestIssue.createdAt))}，距今 **${Number.isFinite(issueAgeH) ? `${issueAgeH.toFixed(2)}h` : '—'}**，${newestIssue.closedAt ? '已关闭' : '**未关闭**'}；标题版本 ${newestIssue.parsed.version ? `\`${newestIssue.parsed.version}\`` : `解析不出（${newestIssue.parsed.how}）`}）`
  : `- **最新 watch issue**：**未检测到**（标题前缀 ${TRACKING_PREFIXES.map((p) => `\`${p}\``).join(' / ')} 在 --state all 下一条都没有；不是"最近没有"，是"从来没有人开过单"）`)
statusLines.push(`- **未关闭的跟踪 issue**：${openIssues.length ? `${openIssues.length} 条（${openIssues.map((i) => `#${i.number}`).join('、')}）` : '**无**'}`)
if (!HEAD_FLOOR) statusLines.push('- **待适配判定**：⚠️ 壳地板读不到 ⇒ 无法判断（不猜）')
else if (!Number.isFinite(cmpVersion(HEAD_FLOOR, HEAD_FLOOR))) statusLines.push(`- **待适配判定**：⚠️ 壳地板 \`${HEAD_FLOOR}\` 解析不出版本语义 ⇒ 无法比较（不猜）`)
else if (!ahead.length) statusLines.push('- **待适配判定**：各通道最新版本都不高于壳地板（语义化比较）⇒ 当前没有待适配的上游版本')
else statusLines.push(`- **待适配判定**：${ahead.map((c) => {
  // 与检测段同口径：**最早**那条未关闭 issue（不是列表里的第一条），这样这里点名的编号与「待适配版本」段一致。
  const open = openIssues.filter((i) => i.parsed.version === c.version)
    .sort((a, b) => (Date.parse(a.createdAt) || Infinity) - (Date.parse(b.createdAt) || Infinity) || ((a.number ?? Infinity) - (b.number ?? Infinity)))
  return `${c.channel}=\`${c.version}\` 晚于壳地板 ⇒ ${open.length ? `**已被发现**（最早未关闭 #${open[0].number}，共 ${open.length} 条）` : '⚠️ **未发现**（没有任何未关闭 issue 提到它）'}`
}).join('；')}`)
statusLines.push(`- **issue 解析**：按标题前缀命中 **${watchIssues.length}** 条跟踪单（\`gh issue list --state all --limit ${ISSUE_LIMIT}\`，**不按 label**）；`
  + `其中 ${watchIssues.filter((i) => i.parsed.version).length} 条解析出版本号；${unlabeled} 条没有 \`${TRACKING_LABELS.join('\`/\`')}\` label`
  + `（不参与取数，仅作信号 —— 事故里 PAT 缺 Issues:write 就是这样）`)

const warnLines = []
for (const i of watchIssues) {
  if (!i.parsed.version) { warnLines.push(`⚠️ issue #${i.number} 的标题里没有可识别的版本号（${i.parsed.how}）⇒ 检测延迟无法配对：${i.title}`); continue }
  if (!times[i.parsed.version]) warnLines.push(`⚠️ issue #${i.number} 标题版本 \`${i.parsed.version}\` 与 packument **不匹配**（npm 上没有该版本的发布时间）⇒ 检测延迟无法计算`)
}
// "已开单但还没发版"按**版本**报一次（不是每条 issue 报一次）：事故后有 17 条同版本 issue，
// 逐条报会把一条事实刷成 17 行噪音；条数已经写在括号里。
for (const [v, issue] of issueByVersion) {
  const dup = watchIssues.filter((i) => i.parsed.version === v && i.number !== issue.number)
  if (dup.length) warnLines.push(`ℹ️ 版本 \`${v}\` 有多条 issue（${[issue.number, ...dup.map((d) => d.number)].join('、')}）⇒ 检测延迟取**最早**的 #${issue.number}`)
  if (!measuredFloors.has(v) && times[v]) {
    if (coveredPending.some((p) => p.version === v)) {
      warnLines.push(`ℹ️ 版本 \`${v}\` 已开单（最早 #${issue.number}，共 ${dup.length + 1} 条）但已被更高地板覆盖 ⇒ 不计入待适配（见「已被更高地板覆盖」段）`)
    } else {
      warnLines.push(`ℹ️ 版本 \`${v}\` 已开单（最早 #${issue.number}，共 ${dup.length + 1} 条）但还没有任何壳版本携带它作地板（未适配 / 未发布）⇒ 检测延迟见「待适配版本」段`)
    }
  }
}
for (const r of measured) if (r.detectionAnomaly) warnLines.push(`⚠️ ${r.shell}（地板 \`${r.floor}\`）：${r.detectionAnomaly}`)

const md = [
  '## dsh 升级 SLA 报表',
  '',
  '### 当前状态（实时信号，UTC）',
  '',
  ...statusLines,
  '',
  `### 两段延迟（按 dsh 版本聚合）`,
  '',
  '段口径（UTC）：**检测** = 上游发布 → 首次为该版本开 issue（unknown 印「未检测到」，不当 0）；'
  + '**适配** = 地板提交 → 我方发布；抬地板 = 上游发布 → 地板提交；合计 = 上游发布 → 我方发布（门禁判它）。'
  + `两段中位/最大见末行；检测段可判定 **${det.n}/${measured.length}**。`,
  '',
  ...stats, '',
  ...lines,
  pendingText ? `\n${pendingText}` : '',
  coveredText ? `\n${coveredText}` : '',
  warnLines.length ? `\n注意：${warnLines.join('\n')}` : '',
  skipped.length ? `\n跳过：${skipped.map((r) => `${r.tag}（${r.skip}）`).join('；')}` : '',
].join('\n')
console.log(md)

// 更新路径的降噪判据：把「量到的版本集合 + 达标标记」压成一个 digest 写进 issue 正文（HTML 注释）。
// 只有目标版本（最新量到的壳版本）或达标状态变化时才评论；其余更新静默 —— 报表 weekly cron
// 不该每周刷一条通知。digest 相同则连 edit 都跳过（幂等）。
const newestShell = measured.length ? measured[measured.length - 1].shell : '—'
const okCount = measured.filter((r) => r.ok).length
const stateDigest = createHash('sha1').update(JSON.stringify(measured.map((r) => [r.shell, r.floor, r.ok]))).digest('hex').slice(0, 12)
const stateLine = `<!-- dsh-sla-report-state: ${stateDigest} newest=${newestShell} ok=${okCount}/${measured.length} -->`
const parseReportState = (text) => {
  const m = /<!-- dsh-sla-report-state: ([0-9a-f]+) newest=(\S+) ok=(\d+\/\d+) -->/.exec(String(text ?? ''))
  return m ? { digest: m[1], newest: m[2], ok: m[3] } : null
}

if (OUT) {
  // `--json` 是**只增不改**的接口：原有字段（perVersion / allReleases / stats / gateScoped / …）名字与语义不变，
  // 新增 detection*（逐行）与 currentStatus / detectionStats（汇总）。`now` = 算"距今"用的时刻（--now 可钉住）。
  writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    now: NOW.toISOString(),
    slaHours: SLA_HOURS,
    since: SINCE,
    timeFormat: 'UTC ISO 8601（toISOString；表格列头亦标 UTC）',
    segments: {
      detection: '上游发布 → 首次为该版本开 issue（数据源 = gh issue list --state all，按 scripts/lib/issue-key.mjs 的确定性键筛选：标题前缀 + 版本号词边界 + `dsh <版本>` 锚点；不按 label）',
      floor: '上游发布 → 地板提交（旧报表印作"适配"；JSON 字段仍是 adapt）',
      adaptation: '地板提交 → 我方发布（旧报表印作"发布"；JSON 字段仍是 release）',
      total: '上游发布 → 我方发布（total；门禁判它，与旧实现逐位相同）',
    },
    gateScoped: gateScoped.map((r) => r.shell),
    gateHistory: gateHistory.map((r) => r.shell),
    stats,
    detectionStats: {
      source: `gh issue list --state all --limit ${ISSUE_LIMIT}（**不按 label**；筛选用 scripts/lib/issue-key.mjs 的确定性键：标题前缀 ${TRACKING_PREFIXES.join(' / ')} + 版本号词边界）`,
      measured: det.n, unknown: detUnknown, median: Number.isFinite(det.median) ? det.median : null, max: Number.isFinite(det.max) ? det.max : null,
      // 还没发版的版本也有检测延迟（上游发布 → 首次开单）；这是发版前唯一能看到检测段的窗口。
      pending: pending.map((p) => ({ version: p.version, upstreamAt: p.upstreamAt, issue: p.issue, issueAt: p.issueAt, issueCount: p.issueCount, detection: p.detection })),
      // 已被更高地板覆盖（例如 rc.3/rc.4 被 rc.5 跳过）：保留检测段数字，但**不计入** pending。
      pendingCovered: coveredPending.map((p) => ({ version: p.version, upstreamAt: p.upstreamAt, issue: p.issue, issueAt: p.issueAt, issueCount: p.issueCount, detection: p.detection, coveredBy: p.coveredBy })),
      adaptation: { measured: ada.n, median: Number.isFinite(ada.median) ? ada.median : null, max: Number.isFinite(ada.max) ? ada.max : null },
      floorSegment: { measured: flo.n, median: Number.isFinite(flo.median) ? flo.median : null, max: Number.isFinite(flo.max) ? flo.max : null },
    },
    currentStatus: {
      floor: HEAD_FLOOR, floorPublishedAt: headFloorAt, floorSource: 'scripts/server-manager.mjs（当前 HEAD 工作树）',
      channels: Object.fromEntries(channels.map((c) => [c.channel, { version: c.version, publishedAt: c.publishedAt }])),
      newestWatchIssue: newestIssue ? {
        number: newestIssue.number, title: newestIssue.title, createdAt: utc(newestIssue.createdAt),
        closedAt: utc(newestIssue.closedAt), ageHours: Number.isFinite(issueAgeH) ? issueAgeH : null,
        parsedVersion: newestIssue.parsed.version, parseHow: newestIssue.parsed.how,
      } : null,
      openWatchIssues: openIssues.map((i) => i.number),
      upstreamAhead: ahead.map((c) => ({ channel: c.channel, version: c.version, publishedAt: c.publishedAt, openIssue: openIssues.find((i) => i.parsed.version === c.version)?.number ?? null })),
      issuesFetched: watchIssues.length, issuesParsed: watchIssues.filter((i) => i.parsed.version).length,
      issuesWithoutTrackingLabel: unlabeled, trackingLabels: TRACKING_LABELS,
    },
    warnings: warnLines,
    perVersion: measured,
    allReleases: rows,
  }, null, 2))
  console.log(`\nJSON 已写入 ${OUT}`)
}

if (UPSERT_ISSUE) {
  // /dev/stdin 在 runner 上不可用（实测：open /dev/stdin: no such device or address）⇒ 写临时文件
  const bodyFile = join(tmpdir(), 'dsh-sla-report-body.md')
  writeFileSync(bodyFile, `@${OWNER}（负责人；自动化 SLA 报表：assignee + 提及双保险；只在目标版本/达标状态变化时评论）

${md}

${stateLine}`)
  try { sh(GH, ['label', 'create', 'sla-report', '--description', 'dsh 升级 SLA 报表', '--color', '0e8a16']) } catch (e) { /* 已存在即可 */ }
  // 取回 body 以便比对上次的状态标记；`gh issue list --json` 后由 node 解析（不依赖 jq）。
  const listing = JSON.parse(sh(GH, ['issue', 'list', '--label', 'sla-report', '--state', 'open', '--json', 'number,body', '--limit', '100']))
  const existing = Array.isArray(listing) ? listing[0] : null
  if (existing) {
    const prev = parseReportState(existing.body)
    if (prev && prev.digest === stateDigest) {
      console.log(`SLA issue #${existing.number} 无变化（目标与达标状态均未变）⇒ 静默跳过，不 edit 也不评论`)
    } else {
      // edit 不推送 ⇒ 有意义的变化要补一条短 comment（comment 会通知 assignee/订阅者）。
      sh(GH, ['issue', 'edit', String(existing.number), '--body-file', bodyFile, '--add-assignee', OWNER])
      const changes = []
      if (!prev) changes.push('首次接管（此前没有状态标记）')
      else {
        if (prev.newest !== newestShell) changes.push(`目标版本 ${prev.newest} → ${newestShell}`)
        if (prev.ok !== `${okCount}/${measured.length}`) changes.push(`达标 ${prev.ok} → ${okCount}/${measured.length}`)
      }
      if (!changes.length) changes.push('报表数据已更新')
      sh(GH, ['issue', 'comment', String(existing.number), '--body', `已更新 SLA 报表：${changes.join('；')}。`])
      console.log(`已更新 SLA issue #${existing.number}（${changes.join('；')}）`)
    }
  } else {
    sh(GH, ['issue', 'create', '--label', 'sla-report', '--assignee', OWNER, '--title', 'dsh 升级 SLA 报表（自动更新）', '--body-file', bodyFile])
    console.log('已创建 SLA issue（已赋值并 @ 提及属主）')
  }
}

const recent = gateScoped.slice(-RECENT)
const breached = recent.filter((r) => !r.ok)
if (FAIL_ON_BREACH && breached.length) {
  console.error(`\nSLA 门禁：since=${SINCE} 之后最近 ${recent.length} 个版本里 ${breached.length} 个超 ${SLA_HOURS}h：${breached.map((r) => `${r.shell}=${fmt(r.total)}`).join(', ')}`)
  process.exit(1)
}
