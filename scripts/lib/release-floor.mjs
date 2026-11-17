/**
 * 壳 Release 正文里记录 dsh 版本的解析（autopilot 的「已发布」判定用）。
 *
 * 背景（2026-11-18 真机）：新策略让 `next`/`alpha` 也自动适配后，autopilot 立刻把它误判成
 * 「已发布」—— Release 正文有这么一行：
 *   `发版时 npm latest = **0.2.2-rc.1**（next 预发布 = 0.2.2-rc.4）`
 * 旧实现同时匹配 `latest` 与「next 预发布」两处，于是 `next` 恰好等于 target 时直接跳过适配。
 * **只有 latest 那处代表「这个版本随包分发的 dsh 版本」**；next 只是记录当时 npm 的预发布 tag，
 * 不代表壳里装了它。所以本模块只把 `latest` 当作「已发布该地板」的证据。
 */

/** 从 Release 正文解析出当时记录的 npm latest 与 next（取不到为 null）。 */
export function parseReleaseFloor(body) {
  const text = String(body ?? '')
  const latest = /发版时 npm\s*`latest`\s*=\s*\*\*([^*\n]+)\*\*/.exec(text)?.[1]?.trim() ?? null
  const next = /`next`\s*预发布\s*=\s*([^）)\n]+)/.exec(text)?.[1]?.trim() ?? null
  return { latest, next }
}

/**
 * 这个 Release 是否**随包分发**了 `target` 这个 dsh 版本。
 * @param {string} body - Release 正文
 * @param {string} target - 待适配的 dsh 版本
 * @param {number} assetCount - 该 Release 的资产数（<3 视为未发完整）
 * @returns {boolean} true = 已经有壳版本携带该地板，无需再适配
 */
export function releaseShippedFloor(body, target, assetCount) {
  if (!(Number(assetCount) >= 3)) return false
  const { latest } = parseReleaseFloor(body)
  return typeof target === 'string' && target.length > 0 && latest === target
}