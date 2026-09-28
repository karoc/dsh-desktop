#!/usr/bin/env node
// shell-plugins 纯逻辑单测。负向对照（必须变红）：① 不再过滤命名空间（会误删用户插件）
// ② 把 shipped 判断写反（会删掉仍在分发的插件）③ 不去重/不过滤 bundles 里的第三方条目。
import assert from 'node:assert/strict'
import { planShellPluginCleanup, SHELL_PLUGIN_SCOPE } from './shell-plugins.mjs'

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

if (failures > 0) { console.error(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: 壳自有插件清理计划（命名空间隔离 / 仅在制品与引用 / 空输入）')
