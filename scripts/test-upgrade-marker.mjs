#!/usr/bin/env node
// 升级标记的纯逻辑单测（S9）。负向对照（必须变红）：
//   - 让冷安装（from=null）也返回标记；
//   - 去掉 attempts 累加（同一目标重复失败永远 attempts=1）；
//   - 让 allowsVersionSwitch 在 attempts>=2 时仍返回 true。
import assert from 'node:assert/strict'
import { allowsVersionSwitch, nextUpgradeMarker, upgradeMarkerPath } from './upgrade-marker.mjs'

let failures = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}\n     ${error.message}`)
  }
}

check('标记路径在 runtime 下', () => {
  assert.equal(upgradeMarkerPath('/x/runtime'), '/x/runtime/upgrade.json')
})

check('确有旧版本才写标记；冷安装/同版本不写', () => {
  const m = nextUpgradeMarker(null, '0.1.6-alpha.1', '0.1.7-rc.2', 'update', 111)
  assert.deepEqual(m, { from: '0.1.6-alpha.1', to: '0.1.7-rc.2', kind: 'update', attempts: 1, at: 111 })
  assert.equal(nextUpgradeMarker(null, null, '0.1.7-rc.2'), null, '冷安装不应写标记')
  assert.equal(nextUpgradeMarker(null, '', '0.1.7-rc.2'), null, '空 from 不应写标记')
  assert.equal(nextUpgradeMarker(null, '0.1.7-rc.2', '0.1.7-rc.2'), null, '同版本不应写标记')
})

check('同一 (from,to) 的重复失败累加 attempts；不同目标重置', () => {
  const first = nextUpgradeMarker(null, 'a', 'b')
  assert.equal(first.attempts, 1)
  const second = nextUpgradeMarker(first, 'a', 'b')
  assert.equal(second.attempts, 2, '同一目标重复失败必须累加（防 ping-pong 的关键）')
  const third = nextUpgradeMarker(second, 'b', 'a', 'rollback')
  assert.deepEqual(
    { from: third.from, to: third.to, kind: third.kind, attempts: third.attempts },
    { from: 'b', to: 'a', kind: 'rollback', attempts: 1 },
    '换目标（回退）重置计数并记 kind',
  )
})

check('attempts>=2 之后不再提供版本切换', () => {
  assert.equal(allowsVersionSwitch({ attempts: 1 }), true)
  assert.equal(allowsVersionSwitch({ attempts: 2 }), false)
  assert.equal(allowsVersionSwitch({ attempts: 9 }), false)
  assert.equal(allowsVersionSwitch(null), false)
  assert.equal(allowsVersionSwitch({}), true, '缺 attempts 视为首次（1）')
})

if (failures > 0) {
  console.error(`\nFAILED: ${failures} 项`)
  process.exit(1)
}
console.log('\nPASS: upgrade marker 纯逻辑（写标记条件 / attempts / 切换闸门）')
