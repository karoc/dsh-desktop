// issue-key —— 跟踪 issue 的**确定性键**（`dsh-watch.mjs` 与 `dsh-sla-report.mjs` 共用唯一实现）。
//
// 背景（事故 #201–#217）：watch 按 label 去重、报表按 label 取"首次开单时间"。PAT 缺 Issues:write ⇒
// issue create 能过、label 从未落地（16 条 issue 无 label）⇒ 报表把每个版本的检测延迟都判成「未检测到」，
// 而 watch 每 10 分钟再建一条重复单。两个脚本各自实现同一件"这是哪一版"的判断，是那次漂移的根；
// 所以键的**唯一实现**放在这里，两边只做调用方。
//
// 键由三件事确定（与 label、state、写者都无关）：
//   ① **标题前缀**：只认本脚本自己写的 `[dsh-watch]` / `[SLA 未达标]` —— 人类随手开的
//      "please upgrade to 0.2.1-rc.3" 永远不会被当成跟踪单（也就不会被 edit/close 掉别人的字）；
//   ② **`dsh <版本>` 锚点**：watch 的标题里通常有**两个**版本号（目标 + 当时的地板），例如
//      `[SLA 未达标] dsh 0.2.1 已发布 10.0h（门槛 6h），地板仍停在 0.2.1-rc.2` ——
//      目标版本紧跟 `dsh `，只认它；没有这个锚点又出现多个版本号时**不猜**（返回 null + 原因）；
//   ③ **词边界**：版本前后不能是 `[0-9A-Za-z.-]`，于是 `0.2.1` 不匹配 `0.2.1-rc.2`/`0.2.10`，
//      `0.2.1-rc.3` 不匹配 `0.2.1-rc.30`（后者是事故之外的第二个隐患：`contains()` 式匹配会误合并）。
//
// **任意 state**：关掉的 issue 同样是"当时被发现过"的历史证据 —— 检测延迟取的是 `createdAt`。
//
// 改这里的口径 = 同时改两个脚本：`scripts/test-automation-gates.mjs` 的 watch 组（词边界去重/幂等）
// 与 sla 组（`--check`）会一起变红，那是刻意的耦合。

/** 本脚本自己写的两种标题前缀（`dsh-watch` 的跟踪单 / SLA 未达标单）。 */
export const TRACKING_PREFIXES = ['[dsh-watch]', '[SLA 未达标]']

const TRACKING_TITLE = /^(\[dsh-watch\]|\[SLA 未达标\])/

/** 标题是否本脚本写的跟踪单（不看 label、不看 state）。 */
export function isTrackingTitle(title) {
  return TRACKING_TITLE.test(String(title ?? ''))
}

/** 同上，入参是 issue 对象（`gh issue list --json` 的形状）。 */
export function isTrackingIssue(issue) {
  return isTrackingTitle(issue?.title)
}

// 版本号 token：与 watch 原来的形状一致（`0.2.1` / `0.2.1-rc.2` / `0.2.1-alpha.2.1`）。
// **不要**放宽成 `[0-9A-Za-z.]+`（会吃进尾部的 `.`，也会把 `0.2.1-rc.3` 截成 `0.2.1-rc.3.`）。
const VERSION_TOKEN = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?'

/** 词边界 = 前后不能是 `[0-9A-Za-z.-]`（见文件头 ③）。 */
export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `version` 作为一个**完整版本号**出现在文本里（不是更长版本号的子串）时才匹配。 */
export const versionRe = (version) => new RegExp(`(?:^|[^0-9A-Za-z.-])${escapeRe(version)}(?![0-9A-Za-z.-])`)

/**
 * 从我们自己的标题里取**目标版本**（只认 `dsh <版本>` 锚点）。
 * `dsh-watch` 里没有空格，锚点不会误命中脚本名本身。
 * @returns {string|null}
 */
export function versionInTitle(title) {
  const m = new RegExp(`(?:^|[^0-9A-Za-z.-])dsh\\s+(${VERSION_TOKEN})`).exec(String(title ?? ''))
  return m ? m[1] : null
}

/**
 * 解析标题里的目标版本（报表侧用：要同时给出"怎么判的"与候选，便于打印"解析不出"的理由）。
 * 优先级：`dsh <版本>` 锚点 > 全文唯一版本号 > 不猜。
 * @returns {{version: string|null, how: string, candidates: string[]}}
 */
export function parseIssueVersion(title) {
  const text = String(title ?? '')
  const uniq = [...new Set(
    [...text.matchAll(new RegExp(`(?:^|[^0-9A-Za-z.-])(${VERSION_TOKEN})(?![0-9A-Za-z.-])`, 'g'))].map((m) => m[1]),
  )]
  const anchored = versionInTitle(text)
  if (anchored) return { version: anchored, how: '`dsh <版本>` 锚点', candidates: uniq }
  if (uniq.length === 1) return { version: uniq[0], how: '全文唯一版本号', candidates: uniq }
  return {
    version: null,
    how: uniq.length === 0 ? '标题里没有版本号' : `标题里有 ${uniq.length} 个版本号且没有 \`dsh <版本>\` 锚点（有歧义，不猜）`,
    candidates: uniq,
  }
}

/**
 * 找到某一版的跟踪单（watch 的写路径用）：本脚本标题前缀 + 版本号词边界命中。
 * 确定性、与写者/label 无关；**取列表里的第一条**（调用方决定顺序，watch 传的是 gh 的 open 列表）。
 * @returns {object|null}
 */
export function findTrackingIssue(issues, version) {
  const re = versionRe(version)
  return (issues ?? []).find((i) => isTrackingIssue(i) && re.test(String(i?.title ?? ''))) ?? null
}

/**
 * 同一版本多条 issue（watch 重复建单 / 人工补开 / 改过标题）⇒ **取最早创建**那条：
 * 检测延迟问的是"这一版第一次被发现"是什么时候，不是"最近一次建单"。
 * 同刻创建（gh 的秒级时间戳会撞）按**编号小的优先**（编号单调 ⇒ 先开的单），保证与列表顺序无关。
 * @returns {{earliest: object, all: object[]}|null}
 */
export function earliestTrackingIssue(issues, version) {
  const all = (issues ?? []).filter((i) => isTrackingIssue(i) && parseIssueVersion(i?.title).version === version)
  if (!all.length) return null
  const when = (i) => {
    const t = Date.parse(i?.createdAt ?? '')
    return Number.isNaN(t) ? Infinity : t
  }
  const earliest = [...all].sort((a, b) => (when(a) - when(b)) || ((a?.number ?? Infinity) - (b?.number ?? Infinity)))[0]
  return { earliest, all }
}
