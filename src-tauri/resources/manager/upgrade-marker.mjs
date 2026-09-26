// 升级标记（升级归因）——纯逻辑，单独成模块以便单测（manager 内联无法被测试导入）。
//
// 目的：把「启动失败」与「刚升级过」建立因果关系。manager 在**成功安装新版本后**
// 写 `<runtime>/upgrade.json`；壳在启动成功（页面 POST /alive）时删除它；若下次
// 启动失败，壳就能说清"上次升级 vA → vB 后启动失败"，并给出一键回退入口。
//
// 关键约束（v3 审计）：
//   - 只在「确有旧版本」时写（冷安装 / 地板抬升不算升级）；
//   - 回退动作**不再写同种标记**（否则语义颠倒），而是把 attempts 累加并标记
//     `kind: 'rollback'`；`attempts >= 2` 时只保留取证，不再提供版本切换
//     （防两个版本之间来回 ping-pong）。
//   - attempts 按**无序版本对**累计（{A,B} 与 {B,A} 是同一对）：一次升级 + 一次回退就把
//     这对版本的切换额度用尽 —— 护栏必须在「回退也失败」时生效。
import { join } from 'node:path'

/** 标记文件路径（相对 runtime 目录）。 */
export function upgradeMarkerPath(runtimeDir) {
  return join(runtimeDir, 'upgrade.json')
}

/**
 * 计算下一个标记内容（纯函数）。
 * @param {{from?: string, to?: string, attempts?: number, kind?: string}|null} previous 现有标记
 * @param {string|null} from 本次操作前的版本（null = 冷安装，不写标记）
 * @param {string} to 本次操作后的版本
 * @param {string} [kind] 'update'（默认）| 'rollback'
 * @param {number} [now] 时间戳（默认 Date.now()，便于测试）
 * @returns {{from: string, to: string, kind: string, attempts: number, at: number}|null}
 */
export function nextUpgradeMarker(previous, from, to, kind = 'update', now = Date.now()) {
  // 冷安装（没有旧版本）不算升级：写标记只会把"首次安装失败"误报成"升级失败"。
  if (from === null || from === undefined || from === '' || from === to) return null
  // 同一**版本对**的重复尝试累计 attempts —— 必须按**无序对**判：回退会把 from/to 交换，
  // 若按「同向同对」判，回退这一步会把 attempts 重置为 1，护栏在它要防的场景（A→B 失败 →
  // 回退 B→A 又失败 → 再给「回退到 B」）里永不触发，用户可被拖进 A↔B 无限来回
  // （每次都是真实安装 + 重启）。2026-09-26 由独立评审发现，此前单测把缺陷当成了预期。
  const prev = previous !== null && typeof previous === 'object' ? previous : null
  const samePair = prev !== null
    && ((prev.to === to && prev.from === from) || (prev.to === from && prev.from === to))
  const attempts = samePair ? (Number(prev.attempts) || 1) + 1 : 1
  return { from: String(from), to: String(to), kind, attempts, at: now }
}

/**
 * 是否还允许「一键切换版本」（回退/再升级）。attempts >= 2 时只保留取证：
 * 反复在两个版本之间跳会把用户拖进 ping-pong，不如如实报告并让人工决策。
 * @param {{attempts?: number}|null} marker
 * @returns {boolean}
 */
export function allowsVersionSwitch(marker) {
  if (marker === null || typeof marker !== 'object') return false
  return (Number(marker.attempts) || 1) < 2
}
