#!/usr/bin/env node
// 运行时地板守卫（scripts/plugin-floor.mjs）的单测 + 语义自检。
// 负向对照（必须变红）：① 让 satisfies 忽略 prerelease 排序 ② 让守卫在"未声明地板"时也隔离
// ③ 让守卫隔离 @deepseek-ai/* ④ 把 caret 上界写回"永远 bump major"。
import assert from 'node:assert/strict'
import { collectDshFloors, compare, planPluginGuard, satisfies, selfTest } from './plugin-floor.mjs'

let failures = 0
const check = (label, fn) => {
  try { fn(); console.log(`ok   ${label}`) } catch (e) { failures += 1; console.error(`FAIL ${label}\n     ${e.message}`) }
}

check('semver 自检（9 条，含 prerelease/caret 0.x/tilde/区间）', () => {
  const bad = selfTest().filter((r) => !r.ok)
  assert.equal(bad.length, 0, `自检失败：${JSON.stringify(bad)}`)
})

check('compare 的 prerelease 排序', () => {
  assert.equal(compare('0.1.7-rc.2', '0.1.7-rc.1'), 1)
  assert.equal(compare('0.1.7-rc.2', '0.1.7'), -1)
  assert.equal(compare('0.1.7', '0.1.7-rc.2'), 1, '反向：正式版大于同版本 prerelease')
  assert.equal(compare('0.1.7-alpha.1', '0.1.7-rc.1'), -1)
  assert.equal(compare('0.1.7', '0.1.7'), 0)
  assert.equal(satisfies('0.1.7', '>=0.1.7-rc.1'), true, '正式版满足 rc 地板')
})

check('collectDshFloors 只取 dsh 平台包', () => {
  const floors = collectDshFloors({
    peerDependencies: { '@deepseek-ai/dsh-client-ui-settings': '>=0.1.7-rc.1', react: '^18.2.0' },
  })
  assert.deepEqual(floors, [{ name: '@deepseek-ai/dsh-client-ui-settings', range: '>=0.1.7-rc.1' }])
  assert.deepEqual(collectDshFloors({}), [])
})

check('已装 dsh 低于插件地板 → skipInstall + quarantine', () => {
  const plan = planPluginGuard({
    installedDsh: '0.1.6-alpha.1',
    bundled: [{ name: 'dsh-model-reasoning', version: '0.2.6', pkgJson: { peerDependencies: { '@deepseek-ai/dsh-client-ui-settings': '>=0.1.7-rc.1' } } }],
    enabled: ['@deepseek-ai/dsh-base', 'dsh-model-reasoning'],
  })
  assert.deepEqual(plan.skipInstall.map((x) => x.name), ['dsh-model-reasoning'])
  assert.deepEqual(plan.quarantine.map((x) => x.name), ['dsh-model-reasoning'])
  assert.equal(plan.quarantine[0].floor, '>=0.1.7-rc.1')
})

check('已装 dsh 满足地板 → 什么都不做（不误伤）', () => {
  const plan = planPluginGuard({
    installedDsh: '0.1.7-rc.2',
    bundled: [{ name: 'dsh-model-reasoning', version: '0.2.6', pkgJson: { peerDependencies: { '@deepseek-ai/dsh-client-ui-settings': '>=0.1.7-rc.1' } } }],
    enabled: ['@deepseek-ai/dsh-base', 'dsh-model-reasoning'],
  })
  assert.deepEqual(plan.skipInstall, [])
  assert.deepEqual(plan.quarantine, [])
})

check('未声明地板的插件不动（只有警告）；@deepseek-ai/* 永不隔离', () => {
  const plan = planPluginGuard({
    installedDsh: '0.1.6-alpha.1',
    bundled: [
      { name: 'dsh-kanban', version: '0.2.8', pkgJson: { peerDependencies: { react: '^18.2.0' } } },
      { name: '@deepseek-ai/dsh-web-app', version: '0.1.7-rc.2', pkgJson: {} },
    ],
    enabled: ['dsh-kanban', '@deepseek-ai/dsh-web-app'],
  })
  assert.deepEqual(plan.skipInstall, [], '未声明地板 → 不跳过安装')
  assert.deepEqual(plan.quarantine, [], '@deepseek-ai/* 与未声明地板者都不隔离')
  assert.equal(plan.warnings.length, 1)
  assert.match(plan.warnings[0], /dsh-kanban 未声明 dsh 地板/)
})

check('dsh 未安装/版本不可解析 → 不做任何判断', () => {
  for (const installedDsh of [null, '', 'not-a-version']) {
    const plan = planPluginGuard({
      installedDsh,
      bundled: [{ name: 'dsh-model-reasoning', version: '0.2.6', pkgJson: { peerDependencies: { '@deepseek-ai/dsh-client-ui-settings': '>=0.1.7-rc.1' } } }],
      enabled: ['dsh-model-reasoning'],
    })
    assert.deepEqual(plan.skipInstall, [])
    assert.deepEqual(plan.quarantine, [])
    assert.equal(plan.warnings.length, 1)
  }
})

check('用户自装插件（未随壳分发）不隔离', () => {
  const plan = planPluginGuard({ installedDsh: '0.1.6-alpha.1', bundled: [], enabled: ['someone-elses-plugin'] })
  assert.deepEqual(plan.quarantine, [])
})

if (failures > 0) { console.error(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: 运行时地板守卫（semver 自检 + 计划四态）')
