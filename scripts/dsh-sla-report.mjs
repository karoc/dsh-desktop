#!/usr/bin/env node
// dsh 升级 SLA 报表（自动化方案 P2）—— 对每个已发布版本量出「官方发布 → 我们发布稳定版」的真实耗时，
// 并把它拆成两段可指导行动的数字：**检测**（上游发布 → 我们首次开单）与**适配**（地板提交 → 我方发布），
// 外加一段"当前状态"实时信号（最新 watch issue / 各通道最新版本 / 壳地板 / 有没有未关闭的跟踪 issue）。
//
//   node scripts/dsh-sla-report.mjs [--json <out>] [--issue] [--fail-on-breach] [--recent 3]
//                                   [--since 2026-10-19] [--registry <url>] [--repo <owner/name>] [--assignee <login>]
//                                   [--now <iso>]（演练：钉住"现在"，只影响"距今多久"）
//
// 口径（方案 §1.1a，与人工基线一致）：
//   起点 T0   = npm `time[<该版本随包地板>]`（上游发布时间）
//   地板提交  = `git log -G"MIN_DSH_VERSION = '<v>'" -1 <tag>`（我们开始承诺该地板的提交）
//   终点      = 该版本 GitHub Release 的 publishedAt（我们对外发布）
//   SLA 6h    = 终点 − 起点 ≤ 6h（方案 §1.1b：latest 通道硬指标）
//
// ── 两段延迟（2026-10-22 加；这是报表现在的主读数）─────────────────────────────
//   检测（detection）  = 上游发布 T0 → **首次为该版本开 issue** 的 createdAt。
//                        数据源：`gh issue list --label dsh-upgrade` / `--label sla-breach --state all`
//                        （标题里的版本号按 `dsh-watch.mjs` 的词边界规则解析，见 parseIssueVersion 注释）；
//                        与 npm packument 里该版本的 `time` 相减。**找不到对应 issue ⇒ unknown，
//                        表格里显式打印「未检测到」，绝不当 0**（"没有判断 = 没有验证"）。
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

// ── 检测延迟的数据源：watch issue ─────────────────────────────────────────────
// ⚠️ 任务书给的命令是 `--label dsh-upgrade --label sla-breach`，但 **gh 的重复 `--label` 是 AND 语义**
// （本仓库实测：`--label sla-report` 1 条，加 `--label priority:high` 后 0 条），而 `dsh-watch.mjs` 对
// 同一个 issue **只挂其中一个** label（`breached ? 'sla-breach' : 'dsh-upgrade'`）⇒ 那条命令**恒返回空**，
// 会把所有版本的检测延迟静默变成 unknown（"没有判断"被伪装成"确实没有 issue"）。
// 这里按 label 各查一次、按 issue number 合并（= OR 语义），口径仍是那两个 label + `--state all`。
const WATCH_LABELS = ['dsh-upgrade', 'sla-breach']
const ISSUE_LIMIT = 100
function fetchWatchIssues() {
  const byNumber = new Map()
  for (const label of WATCH_LABELS) {
    const raw = sh(GH, ['issue', 'list', '--label', label, '--state', 'all',
      '--json', 'number,title,createdAt,closedAt', '--limit', String(ISSUE_LIMIT)])
    let list
    try { list = JSON.parse(raw) } catch (e) { throw new Error(`gh issue list --label ${label} 的返回值不是 JSON（前 200 字符）：${raw.slice(0, 200)}`) }
    if (!Array.isArray(list)) throw new Error(`gh issue list --label ${label} 的返回值不是数组（前 200 字符）：${raw.slice(0, 200)}`)
    // 命中 `--limit` 上限 ⇒ gh 返回的是**最新** 100 条，被截掉的恰是**最早**的 issue，而"首次开 issue"
    // 要的正是最早那条 ⇒ 检测延迟只会偏大。宁可不出数，也不出一个可能偏大的数。
    if (list.length >= ISSUE_LIMIT) {
      throw new Error(`gh issue list --label ${label} 命中 --limit ${ISSUE_LIMIT} 上限（返回 ${list.length} 条）：`
        + '被截掉的是最早的 issue ⇒ 检测延迟会偏大。拒绝出数（提高 --limit 或收窄 label 后重跑）。')
    }
    for (const i of list) if (i && i.number !== undefined && i.number !== null) byNumber.set(i.number, i)
  }
  return [...byNumber.values()]
}

// 标题里的版本号解析：**照 `dsh-watch.mjs` 的词边界规则**（前后不能是 `[0-9A-Za-z.-]`，
// 于是 `0.2.1` 既不匹配 `0.2.1-rc.2` 也不匹配 `0.2.10`），不另发明一套。
// watch 生成的标题里通常有**两个**版本号（target + 当时的地板），例如：
//   `[SLA 未达标] dsh 0.2.1 已发布 10.0h（门槛 6h），地板仍停在 0.2.1-rc.2`
//   `[dsh-watch][best-effort 24h（预发布通道）] dsh 0.2.1-rc.2 比地板 0.2.0-rc.2 新`
// ⇒ target 紧跟在 `dsh ` 之后，优先取它；没有这个锚点就只在"全文唯一版本号"时才敢用，多个 = 不猜。
const VERSION_TOKEN = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)*'
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function parseIssueVersion(title) {
  const text = String(title ?? '')
  const all = [...text.matchAll(new RegExp(`(?<![0-9A-Za-z.-])(${VERSION_TOKEN})(?![0-9A-Za-z.-])`, 'g'))].map((m) => m[1])
  const uniq = [...new Set(all)]
  const anchored = new RegExp(`(?:^|[^0-9A-Za-z.-])dsh\\s+(${VERSION_TOKEN})(?![0-9A-Za-z.-])`).exec(text)
  if (anchored) return { version: anchored[1], how: '`dsh <版本>` 锚点', candidates: uniq }
  if (uniq.length === 1) return { version: uniq[0], how: '全文唯一版本号', candidates: uniq }
  return {
    version: null,
    how: uniq.length === 0 ? '标题里没有版本号' : `标题里有 ${uniq.length} 个版本号且没有 \`dsh <版本>\` 锚点（有歧义，不猜）`,
    candidates: uniq,
  }
}

const watchIssues = fetchWatchIssues().map((i) => ({ ...i, parsed: parseIssueVersion(i.title) }))
// 同一版本多条 issue（watch 改过标题/人工补开）⇒ **取最早**那条：检测延迟问的是"第一次被发现"。
const issueByVersion = new Map()
for (const i of watchIssues) {
  const v = i.parsed.version
  if (!v) continue
  const prev = issueByVersion.get(v)
  if (!prev || new Date(i.createdAt) < new Date(prev.createdAt)) issueByVersion.set(v, i)
}

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
  ['首次 issue (UTC)', (r) => utcCell(r.detectionIssueAt)],
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
// 版本先后用**发布时间先后**作代理（同一个包的发布序列单调）—— 不在这里再养一套 semver 比较，
// 免得与 `dsh-watch.mjs` 的 cmp 口径漂移；取不到时间戳的通道显式标注"未知"，不猜先后。
const ahead = (HEAD_FLOOR && headFloorAt)
  ? channels.filter((c) => c.version && c.publishedAt && new Date(c.publishedAt) > new Date(headFloorAt))
  : []
const statusLines = []
statusLines.push(`- **壳地板**（当前 HEAD 的 \`scripts/server-manager.mjs\`）：${HEAD_FLOOR ? `\`${HEAD_FLOOR}\`（上游发布 ${headFloorAt ? utcCell(headFloorAt) : '时间未知'}）` : '⚠️ 读不到 `MIN_DSH_VERSION` ⇒ 无法判断当前地板'}`)
statusLines.push(`- **上游最新各通道**：${channels.map((c) => (c.version ? `${c.channel}=\`${c.version}\`（${c.publishedAt ? utcCell(c.publishedAt) : '发布时间未知'}）` : `${c.channel}=—`)).join('、')}`)
statusLines.push(newestIssue
  ? `- **最新 watch issue**：#${newestIssue.number}「${newestIssue.title}」（开于 ${utcCell(utc(newestIssue.createdAt))}，距今 **${Number.isFinite(issueAgeH) ? `${issueAgeH.toFixed(2)}h` : '—'}**，${newestIssue.closedAt ? '已关闭' : '**未关闭**'}；标题版本 ${newestIssue.parsed.version ? `\`${newestIssue.parsed.version}\`` : `解析不出（${newestIssue.parsed.how}）`}）`
  : `- **最新 watch issue**：**未检测到**（\`${WATCH_LABELS.join('`/`')}\` 两个 label 在 --state all 下一条都没有；不是"最近没有"，是"从来没有人开过单"）`)
statusLines.push(`- **未关闭的跟踪 issue**：${openIssues.length ? `${openIssues.length} 条（${openIssues.map((i) => `#${i.number}`).join('、')}）` : '**无**'}`)
if (!HEAD_FLOOR) statusLines.push('- **待适配判定**：⚠️ 壳地板读不到 ⇒ 无法判断（不猜）')
else if (!headFloorAt) statusLines.push(`- **待适配判定**：⚠️ 壳地板 \`${HEAD_FLOOR}\` 在 npm packument 里没有发布时间 ⇒ 无法比较先后（不猜）`)
else if (!ahead.length) statusLines.push('- **待适配判定**：各通道最新版本都不晚于壳地板（按发布时间比较）⇒ 当前没有待适配的上游版本')
else statusLines.push(`- **待适配判定**：${ahead.map((c) => {
  const open = openIssues.find((i) => i.parsed.version === c.version)
  return `${c.channel}=\`${c.version}\` 晚于壳地板 ⇒ ${open ? `**已被发现**（未关闭 issue #${open.number}）` : '⚠️ **未发现**（没有任何未关闭 issue 提到它）'}`
}).join('；')}`)
statusLines.push(`- **issue 解析**：取到 ${watchIssues.length} 条（\`${WATCH_LABELS.join('`/`')}\`、--state all、上限 ${ISSUE_LIMIT}/label）；其中 ${watchIssues.filter((i) => i.parsed.version).length} 条解析出版本号`)

const warnLines = []
const measuredFloors = new Set(measured.map((r) => r.floor))
for (const i of watchIssues) {
  if (!i.parsed.version) { warnLines.push(`⚠️ issue #${i.number} 的标题里没有可识别的版本号（${i.parsed.how}）⇒ 检测延迟无法配对：${i.title}`); continue }
  if (!times[i.parsed.version]) { warnLines.push(`⚠️ issue #${i.number} 标题版本 \`${i.parsed.version}\` 与 packument **不匹配**（npm 上没有该版本的发布时间）⇒ 检测延迟无法计算`); continue }
  if (!measuredFloors.has(i.parsed.version)) warnLines.push(`ℹ️ issue #${i.number} 的版本 \`${i.parsed.version}\` 已开单，但没有任何已量出版本携带它作地板（未适配 / 未发布）`)
}
for (const [v, issue] of issueByVersion) {
  const dup = watchIssues.filter((i) => i.parsed.version === v && i.number !== issue.number)
  if (dup.length) warnLines.push(`ℹ️ 版本 \`${v}\` 有多条 issue（${[issue.number, ...dup.map((d) => d.number)].join('、')}）⇒ 检测延迟取**最早**的 #${issue.number}`)
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
      detection: '上游发布 → 首次为该版本开 issue（数据源 = gh issue list --label dsh-upgrade / --label sla-breach --state all）',
      floor: '上游发布 → 地板提交（旧报表印作"适配"；JSON 字段仍是 adapt）',
      adaptation: '地板提交 → 我方发布（旧报表印作"发布"；JSON 字段仍是 release）',
      total: '上游发布 → 我方发布（total；门禁判它，与旧实现逐位相同）',
    },
    gateScoped: gateScoped.map((r) => r.shell),
    gateHistory: gateHistory.map((r) => r.shell),
    stats,
    detectionStats: {
      source: `gh issue list --label {${WATCH_LABELS.join(',')}} --state all --limit ${ISSUE_LIMIT}（逐 label 查询后按 number 合并 = OR；gh 的重复 --label 是 AND）`,
      measured: det.n, unknown: detUnknown, median: Number.isFinite(det.median) ? det.median : null, max: Number.isFinite(det.max) ? det.max : null,
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
