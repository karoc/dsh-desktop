#!/usr/bin/env node
// watchdog "dump 之后再探一次" 的可失败门禁（2026-10-23）。
//
// 背景（事故取证 05:54）：壳侧探针在 05:54:47 已记 `probe recovered after 3
// miss(es)`，manager 侧却在 05:54:51 dump 完后直接 `restarting dsh` —— 一次已自行
// 恢复的短暂无响应被打断成 400MB dump + 重启级联。修法：dump 完成后、kill 之前
// 再探一次 URL；2xx–4xx ⇒ 记 recovered、清零、不杀不重启；仍无响应 ⇒ 照旧杀。
//
// 本套件跑 manager 内置的 `--self-test-watchdog`（用桩把探活结果按顺序喂给**真实的
// watchdogTick**），并做八个**变异自证**——证明这些断言真的会失败：
//   ① 把 `if (recheck.ok)` 改成 `if (false)` ⇒ 场景 1（已恢复）必红；
//   ② 改成 `if (true)` ⇒ 场景 2（真挂起）必红；
//   ③ 把日志里的 `recovered` 改掉 ⇒ 场景 1 的日志断言必红（防"日志只是摆设"）；
//   ④ 把 `if (patient.ok)` 改成 `if (false)` ⇒ 场景 3（长窗口盘活、不 dump）必红；
//   ⑤ 把 startup 阈值 5 改回 3 ⇒ 场景 4（宽限内 4 次 miss 不重启）必红；
//   ⑥ 把 CPU-busy 阈值改成恒真 ⇒ 场景 7（空闲必须立即重启）必红；
//   ⑦ 把 CPU-aware ceiling 缩到 15s ⇒ 场景 6（忙 25s 后应答）必红；
//   ⑧ 把扩展循环的 `if (probeResult.ok)` 改成 `if (false)` ⇒ 场景 6 必红。
// 变异只发生在临时副本上，仓库文件不动。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-watchdog-'))
const runtime = join(work, 'runtime')
mkdirSync(runtime, { recursive: true })
writeFileSync(join(work, 'patch.yml'), '- insert: []\n')

/** 跑一份 manager 的 `--self-test-watchdog`，返回 { status, stdout, stderr }。 */
function runSelfTest(scriptPath) {
  try {
    const stdout = execFileSync(process.execPath, [
      scriptPath,
      '--self-test-watchdog',
      '--runtime-dir', runtime,
      '--resource-dir', join(ROOT, 'src-tauri', 'resources'),
      '--patch', join(work, 'patch.yml'),
    ], { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

let failures = 0
const check = (label, fn) => {
  try { fn(); console.log(`ok   ${label}`) } catch (err) { failures += 1; console.error(`FAIL ${label}\n     ${err.message}`) }
}

// ── 1. 真源：两条负向对照都必须绿，且日志格式可判读 ─────────────────────────
const real = runSelfTest(join(ROOT, 'scripts', 'server-manager.mjs'))
check('真源 self-test 退出 0', () => assert.equal(real.status, 0, real.stderr || real.stdout))
check('场景 ①：3 次 miss → dump 窗口内恢复 ⇒ recovered 且不 kill/restart', () => {
  assert.match(real.stdout, /watchdog self-test: 3 次 miss → dump 窗口内恢复/)
  assert.match(real.stdout, /watchdog: dsh web recovered after 3 miss\(es\).* — no restart/)
  assert.match(real.stdout, /PASS \(kill=0, dump=1\)/)
})
check('场景 ②：dump 后仍无响应 ⇒ 仍然 kill + restart', () => {
  assert.match(real.stdout, /watchdog self-test: dump 后仍无响应/)
  assert.match(real.stdout, /watchdog: dsh web still UNRESPONSIVE after dump .* — restarting dsh/)
  assert.match(real.stdout, /PASS \(kill=1, dump=1\)/)
})
check('场景 ③：慢探针在长窗口内恢复 ⇒ 不 dump、不 kill（插件页首开型卡顿）', () => {
  assert.match(real.stdout, /watchdog self-test: slow but alive after patient probe/)
  assert.match(real.stdout, /watchdog: dsh web slow but alive after 3 miss\(es\) \(probe 303, \d+ms\) — no dump, no restart/)
  assert.match(real.stdout, /PASS \(kill=0, dump=0\)/)
})
check('场景 ④：启动宽限内 4 次 miss 不达阈值 ⇒ 不 dump、不 kill', () => {
  assert.match(real.stdout, /watchdog self-test: startup grace: 4 misses stay below the threshold/)
  assert.match(real.stdout, /watchdog: dsh web miss 4\/5 \(startup, /)
  assert.match(real.stdout, /PASS \(kill=0, dump=0\)/)
})
check('场景 ⑤：启动宽限内 5 次 miss 达阈值 ⇒ 仍然 dump + restart', () => {
  assert.match(real.stdout, /watchdog self-test: startup grace: 5 misses still dump and restart/)
  assert.match(real.stdout, /watchdog: dsh web still UNRESPONSIVE after dump/)
  assert.match(real.stdout, /PASS \(kill=1, dump=1\)/)
})
/** 取某个 self-test 场景的输出段（场景名 → 下一个场景名/结尾），负向断言必须按段判。 */
const section = (stdout, name, nextName) => {
  const start = stdout.indexOf('watchdog self-test: ' + name)
  if (start < 0) return ''
  const end = nextName === undefined ? -1 : stdout.indexOf('watchdog self-test: ' + nextName, start + 1)
  return stdout.slice(start, end < 0 ? stdout.length : end)
}
check('场景 ⑥：忙 25s+ 后应答 ⇒ CPU-aware 扩展耐心、不 dump/不重启', () => {
  assert.match(real.stdout, /watchdog self-test: busy stall keeps extending, then answers/)
  assert.match(real.stdout, /watchdog: stalled but busy — extending patience \(cpu \d+%, \d+s\/\d+s since first miss\)/)
  assert.match(real.stdout, /watchdog: dsh web slow but alive after 3 miss\(es\) \+ \d+s busy stall/)
  assert.match(real.stdout, /PASS \(kill=0, dump=0\)/)
})
check('场景 ⑦：空闲 25s ⇒ 立即按原边界 dump+restart（真挂起检测不退化）', () => {
  const block = section(real.stdout, 'idle stall goes straight to dump and restart', 'busy stall hits the ceiling and restarts')
  assert.match(block, /watchdog: dsh web stalled but IDLE/)
  assert.match(block, /PASS \(kill=1, dump=1\)/)
  assert.ok(!/stalled but busy/.test(block), '空闲场景出现了扩展日志（忙碌判定恒真 = 假门禁）')
})
check('场景 ⑧：忙过 60s ceiling ⇒ 仍然 dump + restart', () => {
  assert.match(real.stdout, /watchdog self-test: busy stall hits the ceiling and restarts/)
  assert.match(real.stdout, /reached the 60s ceiling/)
  assert.match(real.stdout, /PASS \(kill=1, dump=1\)/)
})
check('self-test 汇总 8/8', () => assert.match(real.stdout, /watchdog self-test: 8\/8 passed/))
check('日志不含 token / 完整 URL（探针 URL 带 ?token=…）', () => {
  assert.ok(!real.stdout.includes('SELF-TEST-SECRET'), '日志泄露了探针 URL 里的 token')
  assert.ok(!/token=/.test(real.stdout), '日志出现了 token= 参数')
})

// ── 2. 变异自证：改坏判定 ⇒ 对应场景必须变红 ───────────────────────────────
/** 在临时副本上改一处后跑 self-test（副本自带 manager 的本地依赖）。 */
function runMutation(label, transform, relativeTarget = 'server-manager.mjs') {
  const dir = join(work, `mut-${label}`)
  cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true })
  const entry = join(dir, 'scripts', 'server-manager.mjs')
  const target = join(dir, 'scripts', relativeTarget)
  const original = readFileSync(target, 'utf8')
  const mutated = transform(original)
  assert.notEqual(mutated, original, `变异 ${label} 没有改动任何字节（锚点漂移 ⇒ 变异自证无效）`)
  writeFileSync(target, mutated)
  const result = runSelfTest(entry)
  rmSync(dir, { recursive: true, force: true })
  return result
}

check('变异 ① 恢复分支永不执行 ⇒ 场景 ① 必红', () => {
  const r = runMutation('no-recovery', (s) => s.replace('if (recheck.ok) {', 'if (false) {'))
  assert.notEqual(r.status, 0, '恢复分支失效后 self-test 仍然通过 = 假门禁')
  assert.match(r.stdout + r.stderr, /kill 次数 1，期望 0/)
})
check('变异 ② 恢复分支恒真 ⇒ 场景 ② 必红（真挂起不再重启 = 安全边界被堵）', () => {
  const r = runMutation('always-recovered', (s) => s.replace('if (recheck.ok) {', 'if (true) {'))
  assert.notEqual(r.status, 0, '恒恢复后 self-test 仍然通过 = 假门禁')
  assert.match(r.stdout + r.stderr, /kill 次数 0，期望 1/)
})
check('变异 ③ recovered 日志措辞被改 ⇒ 场景 ① 的日志断言必红', () => {
  const r = runMutation('no-recovered-log', (s) => s.replace('dsh web recovered after', 'dsh web healthy again after'))
  assert.notEqual(r.status, 0, '日志断言是恒真的 = 判读约定无人守')
  assert.match(r.stdout + r.stderr, /缺少期望日志/)
})
check('变异 ④ 慢探针恢复分支永不执行 ⇒ 场景 ③ 必红（会回到 dump + 重启）', () => {
  const r = runMutation('no-patient-recovery', (s) => s.replace('if (patient.ok) {', 'if (false) {'))
  assert.notEqual(r.status, 0, '慢探针恢复分支失效后 self-test 仍然通过 = 假门禁')
  assert.match(r.stdout + r.stderr, /缺少期望日志|dump-web 应发 0 次/)
})
check('变异 ⑤ 启动宽限退回 3 miss/9s ⇒ 场景 ④ 必红', () => {
  const r = runMutation('startup-limit-3', (s) => s
    .replace('export const STARTUP_MISS_LIMIT = 5', 'export const STARTUP_MISS_LIMIT = 3')
    .replace('export const STARTUP_MIN_WINDOW_MS = 15_000', 'export const STARTUP_MIN_WINDOW_MS = 9_000'), join('lib', 'watchdog-policy.mjs'))
  assert.notEqual(r.status, 0, '宽限内阈值被退回 3 miss/9s 后 self-test 仍然通过 = 假门禁')
  assert.match(r.stdout + r.stderr, /kill 次数 1，期望 0/)
})

check('变异 ⑥ CPU-busy 判定恒真 ⇒ 场景 ⑦（空闲立即重启）必红', () => {
  const r = runMutation('always-busy', (s) => s.replace('export const STALL_MIN_BUSY_RATIO = 0.1', 'export const STALL_MIN_BUSY_RATIO = -1'), join('lib', 'watchdog-policy.mjs'))
  assert.notEqual(r.status, 0, 'busy 恒真后 self-test 仍然通过 = 空闲/真挂起检测被淹没')
  assert.match(r.stdout + r.stderr, /出现了禁止的日志 .*stalled but busy/)
})
check('变异 ⑦ CPU-aware ceiling 缩到 15s ⇒ 场景 ⑥（忙 25s 后应答）必红', () => {
  const r = runMutation('ceiling-15s', (s) => s.replace('export const STALL_BUSY_CEILING_MS = 60_000', 'export const STALL_BUSY_CEILING_MS = 15_000'), join('lib', 'watchdog-policy.mjs'))
  assert.notEqual(r.status, 0, 'ceiling 被缩短后 self-test 仍然通过 = 有界性无人守')
  assert.match(r.stdout + r.stderr, /dump-web 应发 0 次，实际 1|缺少期望日志/)
})
check('变异 ⑧ 扩展循环的应答分支永不执行 ⇒ 场景 ⑥ 必红', () => {
  const r = runMutation('no-extended-recovery', (s) => s.replace('if (probeResult.ok) {', 'if (false) {'))
  assert.notEqual(r.status, 0, '扩展循环应答分支失效后 self-test 仍然通过 = 假门禁')
  assert.match(r.stdout + r.stderr, /dump-web 应发 0 次，实际 1/)
})

rmSync(work, { recursive: true, force: true })
if (failures) {
  console.error(`\nFAILED: watchdog 恢复再探门禁 ${failures} 项`)
  process.exit(1)
}
console.log('\nPASS: watchdog 判据（启动宽限 5 miss/15s、宽限外 3 miss/9s、dump 前长窗口盘活、CPU-aware 有界扩展 / 真挂起仍重启 + 8 个变异自证）')
