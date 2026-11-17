#!/usr/bin/env node
// 纯逻辑门禁：scripts/lib/watchdog-policy.mjs 的阈值与判定。
//
// 背景（2026-11-17 插件页首开卡顿）：dsh 0.2.2 首次打开 Plugins 页会让 dsh web 的
// 事件循环同步扫盘 2-12s（上游 metaOf→dictionariesOf 无缓存，三条 RPC 各跑一遍），
// 旧判据「连续 3 次 × 1.5s 探针超时 ⇒ dump + 重启」把一次自恢复的停顿升级成重启，
// 用户会话被中断、留下 357MB dump。本套件钉死两条防线：
//   ① 启动宽限（120s）内要 5 次 miss / ≈15s，宽限外维持 3 次 / ≈9s；
//   ② 判定全部来自纯函数，阈值只此一份（manager 不再硬编码）。
//
// 可失败性：这些断言都对着真实导出值；把 STARTUP_MISS_LIMIT 改回 3、把
// STARTUP_GRACE_MS 改成 0，或把 decide 的 AND 改成 OR，本文件立刻变红。
import assert from 'node:assert/strict'
import {
  decideWatchdogRestart, watchdogThresholds,
  WATCHDOG_TICK_MS, STARTUP_GRACE_MS, STARTUP_MISS_LIMIT, STARTUP_MIN_WINDOW_MS,
  STEADY_MISS_LIMIT, STEADY_MIN_WINDOW_MS, PRE_DUMP_PATIENCE_MS, STARTUP_MUTE_MS,
} from './lib/watchdog-policy.mjs'

let failures = 0
const check = (label, fn) => {
  try { fn(); console.log('ok   ' + label) } catch (err) { failures += 1; console.error('FAIL ' + label + '\n     ' + err.message) }
}

check('阈值常数自洽（宽限内比宽限外更宽，窗口与 tick 对齐）', () => {
  assert.equal(WATCHDOG_TICK_MS, 3000)
  assert.equal(STARTUP_GRACE_MS, 120000)
  assert.equal(STARTUP_MUTE_MS, 30000)
  assert.equal(PRE_DUMP_PATIENCE_MS, 15000)
  assert.ok(STARTUP_MISS_LIMIT > STEADY_MISS_LIMIT, '启动宽限内必须比宽限外更宽松')
  assert.equal(STARTUP_MIN_WINDOW_MS, STARTUP_MISS_LIMIT * WATCHDOG_TICK_MS)
  assert.equal(STEADY_MIN_WINDOW_MS, STEADY_MISS_LIMIT * WATCHDOG_TICK_MS)
})

check('相位：刚好 120s 算宽限外，119999ms 算宽限内', () => {
  assert.equal(watchdogThresholds(0).phase, 'startup')
  assert.equal(watchdogThresholds(STARTUP_GRACE_MS - 1).phase, 'startup')
  assert.equal(watchdogThresholds(STARTUP_GRACE_MS).phase, 'steady')
  assert.equal(watchdogThresholds(300000).phase, 'steady')
  assert.equal(watchdogThresholds(-1).phase, 'steady', '非法输入按宽限外处理，不能放宽')
  assert.equal(watchdogThresholds(Number.NaN).phase, 'steady')
})

check('宽限外：3 次 miss ⇒ 重启（历史行为不变）', () => {
  const d = decideWatchdogRestart({ elapsedSinceStartMs: 300000, consecutiveMisses: 3 })
  assert.equal(d.restart, true)
  assert.equal(d.missLimit, 3)
  assert.equal(d.windowMs, 9000)
  assert.match(d.reason, /steady/)
})

check('宽限外：2 次 miss ⇒ 不重启', () => {
  const d = decideWatchdogRestart({ elapsedSinceStartMs: 300000, consecutiveMisses: 2 })
  assert.equal(d.restart, false)
})

check('宽限外：3 次 miss 但窗口不足 9s ⇒ 不重启（快连失败不算挂起）', () => {
  const d = decideWatchdogRestart({ elapsedSinceStartMs: 300000, consecutiveMisses: 3, missWindowMs: 8999 })
  assert.equal(d.restart, false)
  const ok = decideWatchdogRestart({ elapsedSinceStartMs: 300000, consecutiveMisses: 3, missWindowMs: 9000 })
  assert.equal(ok.restart, true)
})

check('启动宽限内：4 次 miss 不重启（旧判据会误报）', () => {
  const d = decideWatchdogRestart({ elapsedSinceStartMs: 60000, consecutiveMisses: 4 })
  assert.equal(d.restart, false)
  assert.equal(d.missLimit, 5)
})

check('启动宽限内：5 次 miss ⇒ 重启（安全边界没被堵死）', () => {
  const d = decideWatchdogRestart({ elapsedSinceStartMs: 60000, consecutiveMisses: 5 })
  assert.equal(d.restart, true)
  assert.equal(d.windowMs, 15000)
})

check('窗口由 miss 间隔推导：2.5s 间隔 × 5 次 = 12.5s < 15s ⇒ 不重启', () => {
  const d = decideWatchdogRestart({ elapsedSinceStartMs: 60000, consecutiveMisses: 5, missIntervalMs: 2500 })
  assert.equal(d.windowMs, 12500)
  assert.equal(d.restart, false)
})

check('0 / 负数 / 非有限 miss 数 ⇒ 永不重启', () => {
  for (const misses of [0, -1, Number.NaN, undefined]) {
    const d = decideWatchdogRestart({ elapsedSinceStartMs: 300000, consecutiveMisses: misses })
    assert.equal(d.restart, false, 'misses=' + String(misses))
  }
})

check('reason 带相位与计数，可直接进日志判读', () => {
  const d = decideWatchdogRestart({ elapsedSinceStartMs: 300000, consecutiveMisses: 3 })
  assert.match(d.reason, /^steady: 3 miss\(es\) over 9000ms/)
  const s = decideWatchdogRestart({ elapsedSinceStartMs: 60000, consecutiveMisses: 4 })
  assert.match(s.reason, /^startup: 4\/5 miss\(es\)/)
})

if (failures) {
  console.error('\nFAILED: watchdog-policy 纯逻辑门禁 ' + failures + ' 项')
  process.exit(1)
}
console.log('\nPASS: watchdog-policy（启动宽限 5 miss/15s、宽限外 3 miss/9s、边界与非法输入）')
