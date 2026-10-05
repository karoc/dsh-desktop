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
  // `.bak-stale-<ts>` 是上一次清理留下的备份目录：**必须排除**，否则每次启动都会再改一次名
  // （`x.bak-stale-1` → `x.bak-stale-1.bak-stale-2` …）。2026-10-05 修。
  const stale = (name) => name.startsWith(SHELL_PLUGIN_SCOPE) && !shippedSet.has(name) && !/\.bak-stale-\d+$/.test(name)
  return {
    removeCopies: present.filter(stale).sort(),
    dropBundles: bundles.filter(stale).sort(),
  }
}

/**
 * 资源侧（随包目录）的陈旧插件清理计划：安装器升级时**不会删除**上一版遗留的文件，于是
 * `<resources>/plugin/@dsh-desktop/<dir>` 里的旧插件会被 boot 时的拷贝循环一直复制进 runtime
 * （2026-10-04 实测：旧安装遗留的 `plugin-console` 每启动都被复制一次）。判据是**当前 patch
 * roster 有没有引用该包名** —— 没被引用的随包插件不会被加载，属死重量，可安全移走。
 *
 * @param {{present?: string[], referenced?: string[]}} input
 *   present：资源 scope 下现存的目录名（如 ['client-notifications', 'plugin-console']）
 *   referenced：当前 patch yml 里引用到的包名（如 ['@dsh-desktop/client-notifications']）
 * @returns {{removeDirs: string[]}} 需要移走的目录名（不含 .bak-stale-*）
 */
export function planStaleResourcePlugins({ present = [], referenced = [] } = {}) {
  const refs = new Set(referenced)
  return {
    removeDirs: present
      .filter((dir) => !/\.bak-stale-\d+$/.test(dir))
      .filter((dir) => !refs.has(dir) && !refs.has(`${SHELL_PLUGIN_SCOPE}${dir}`))
      .sort(),
  }
}
