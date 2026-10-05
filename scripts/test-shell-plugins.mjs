#!/usr/bin/env node
// shell-plugins 纯逻辑单测。负向对照（必须变红）：① 不再过滤命名空间（会误删用户插件）
// ② 把 shipped 判断写反（会删掉仍在分发的插件）③ 不去重/不过滤 bundles 里的第三方条目。
import assert from 'node:assert/strict'
import { planShellPluginCleanup, planStaleResourcePlugins, SHELL_PLUGIN_SCOPE } from './shell-plugins.mjs'

let failures = 0
const check = (label, fn) => {
  try { fn(); console.log(`ok   ${label}`) } catch (e) { failures += 1; console.error(`FAIL ${label}\n     ${e.message}`) }
}

check('命名空间常量', () => { assert.equal(SHELL_PLUGIN_SCOPE, '@dsh-desktop/') })

check('不再分发 + runtime 有旧副本 + profile 有引用 → 两者都清', () => {
  const plan = planShellPluginCleanup({
    shipped: ['@dsh-desktop/client-notifications'],
    present: ['client-notifications', 'plugin-console'].map((n) => `@dsh-desktop/${n}`),
    bundles: ['@deepseek-ai/dsh-base', '@dsh-desktop/plugin-console', '@dsh-desktop/client-notifications'],
  })
  assert.deepEqual(plan.removeCopies, ['@dsh-desktop/plugin-console'])
  assert.deepEqual(plan.dropBundles, ['@dsh-desktop/plugin-console'])
})

check('仍在分发的壳插件不动；第三方插件永不动', () => {
  const plan = planShellPluginCleanup({
    shipped: ['@dsh-desktop/client-notifications'],
    present: ['@dsh-desktop/client-notifications', '@karoc/dsh-smoothly-opencode-session'],
    bundles: ['@dsh-desktop/client-notifications', 'dsh-kanban', '@karoc/whatever'],
  })
  assert.deepEqual(plan.removeCopies, [])
  assert.deepEqual(plan.dropBundles, [])
})

check('空输入安全（首次启动 / 无 profile）', () => {
  assert.deepEqual(planShellPluginCleanup({}), { removeCopies: [], dropBundles: [] })
  assert.deepEqual(planShellPluginCleanup({ shipped: [], present: [], bundles: [] }), { removeCopies: [], dropBundles: [] })
})

check('备份目录 .bak-stale-* 不再被反复改名（runtime 侧）', () => {
  const plan = planShellPluginCleanup({
    shipped: ['@dsh-desktop/client-notifications'],
    present: ['@dsh-desktop/client-notifications', '@dsh-desktop/plugin-console.bak-stale-1790615559394'],
    bundles: [],
  })
  assert.deepEqual(plan.removeCopies, [])
})

check('资源侧：未被 patch 引用的随包插件要移走（本次缺陷 a）', () => {
  const plan = planStaleResourcePlugins({
    present: ['client-notifications', 'plugin-console'],
    referenced: ['@dsh-desktop/client-notifications'],
  })
  assert.deepEqual(plan.removeDirs, ['plugin-console'])
})

check('资源侧：被引用的一律不动；.bak-stale-* 不算候选', () => {
  const plan = planStaleResourcePlugins({
    present: ['client-notifications', 'client-notifications.bak-stale-1'],
    referenced: ['client-notifications'],
  })
  assert.deepEqual(plan.removeDirs, [])
})

check('资源侧：空输入安全', () => {
  assert.deepEqual(planStaleResourcePlugins(), { removeDirs: [] })
})

if (failures > 0) { console.error(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: 壳自有插件清理计划（命名空间隔离 / 仅在制品与引用 / 空输入）')
