// 壳自有客户端插件（`@dsh-desktop/*`）的生命周期清理 —— 纯逻辑，便于单测。
//
// 背景（2026-09-29 清理 plugin-console）：壳曾随包分发 `@dsh-desktop/plugin-console`
// （壳内插件管理面板），0.1.6-alpha.2 起该面板整体移除、仓库里也已删掉插件本体。但**已装用户**
// 的 runtime 里可能仍留着旧副本、profile bundles 里可能仍引用它：
//   - 旧副本留着 → dsh web 继续加载已废弃的面板；
//   - 被 profile 引用却解析不到 → dsh web 起不来（fail-closed，界面打不开）。
// 所以"不再分发"必须配套"清理引用"，且只动**壳自有命名空间**（`@dsh-desktop/*`），
// 绝不碰用户的第三方插件。
export const SHELL_PLUGIN_SCOPE = '@dsh-desktop/'

/**
 * @param {{shipped?: string[], present?: string[], bundles?: string[]}} input
 *   shipped：本次随包分发的壳自有插件名（来自 resources/plugin/@dsh-desktop/*）
 *   present：runtime node_modules/@dsh-desktop/ 下现存的条目（形如 '@dsh-desktop/plugin-console'）
 *   bundles：当前 web profile 的启用列表
 * @returns {{removeCopies: string[], dropBundles: string[]}}
 */
export function planShellPluginCleanup({ shipped = [], present = [], bundles = [] }) {
  const shippedSet = new Set(shipped)
  const stale = (name) => name.startsWith(SHELL_PLUGIN_SCOPE) && !shippedSet.has(name)
  return {
    removeCopies: present.filter(stale).sort(),
    dropBundles: bundles.filter(stale).sort(),
  }
}
