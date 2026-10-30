// 待适配版本 / 已被更高地板覆盖的版本 —— 纯逻辑，便于单测（`dsh-sla-report.mjs` 的 pending 段）。
//
// 背景（2026-10-30）：pending 的旧判据是「没有任何壳版本**恰好**携带这个版本作地板」。
// 但地板是单调上移的：上游 rc.3、rc.4 都在下一次抬地板时被 rc.5 跳过，于是它们永远留在 pending 里，
// 报表看起来像「还有两个版本没适配」。语义上 rc.5 已经覆盖它们（新地板 ≥ 该版本即可运行）——
// 把它们算成欠账，等于每次抬地板都往报表里堆一条永不清零的假信号（实录：v0.21.1 之后的 rc.3/rc.4）。
//
// 判据必须用**语义化版本比较**，不能用发布时间代理：2026-10-31 首次实跑抓到反例 ——
// `0.2.2-alpha.2` 的上游发布时间早于 `0.2.1-rc.5`（alpha 线先切出来），按时间比会被误判成
// 「已被 rc.5 覆盖」，但实际上 0.2.2-alpha.2 > 0.2.1-rc.5，它仍是待适配版本。
// 比较实现走 `scripts/lib/version-compare.mjs`（第 4 个调用点，已纳入 parity 门禁）。
//
// 返回 `{ pending, covered }`：
//   pending  —— 真正还没被任何地板覆盖的版本（上游发过、开过单，但我方地板还追不上）
//   covered  —— 已被某个更高地板跳过的版本（附覆盖者的 shell / floor / 我方发布时间）
// 调用方（报表）把 covered 单列一段，**不计入 pending 计数**，但保留检测段数字以便追溯。

import { cmpVersion } from './version-compare.mjs'

/**
 * @param {{
 *   versions?: string[],                       // 已开单的上游版本（issueByVersion.keys()）
 *   measured?: Array<{shell: string, floor: string, publishedAt: string}>,  // 已量出的我方发布行
 *   carriedFloors?: Set<string>,               // 恰好被某个壳版本携带过的地板（measuredFloors）
 * }} input
 * @returns {{
 *   pending: string[],
 *   covered: Array<{version: string, shell: string, floor: string, publishedAt: string}>,
 * }}
 */
export function classifyPendingVersions({ versions = [], measured = [], carriedFloors = new Set() } = {}) {
  // cmpVersion 对非 semver 输入会把缺段当 0（`0.2.x` ⇒ 0.2.0），据此判"被覆盖"是假判断 ——
  // 这里先做严格形状校验：解析不出来就保守留在 pending（宁可见一条待确认，也不静默清账）。
  const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
  const parseable = (v) => SEMVER.test(String(v ?? ''))
  const pending = []
  const covered = []
  for (const version of versions) {
    if (carriedFloors.has(version)) continue     // 恰好被某壳版本携带过 ⇒ 已进两段表
    if (!parseable(version)) { pending.push(version); continue }
    // 覆盖者 = 地板 **语义上不旧于** 该版本、且我方发布**最早**的那个壳版本
    // （"哪一次抬地板把它跳过去了"）。地板自身解析不出来 ⇒ 不参与覆盖判定。
    const cover = measured
      .filter((r) => parseable(r.floor) && cmpVersion(r.floor, version) >= 0)
      .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))[0]
    if (cover) {
      covered.push({ version, shell: cover.shell, floor: cover.floor, publishedAt: cover.publishedAt })
    } else {
      pending.push(version)
    }
  }
  return { pending, covered }
}
