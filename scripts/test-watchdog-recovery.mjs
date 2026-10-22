#!/usr/bin/env node
// watchdog "dump 之后再探一次" 的可失败门禁（2026-10-23）。
//
// 背景（事故取证 05:54）：壳侧探针在 05:54:47 已记 `probe recovered after 3
// miss(es)`，manager 侧却在 05:54:51 dump 完后直接 `restarting dsh` —— 一次已自行
// 恢复的短暂无响应被打断成 400MB dump + 重启级联。修法：dump 完成后、kill 之前
// 再探一次 URL；2xx–4xx ⇒ 记 recovered、清零、不杀不重启；仍无响应 ⇒ 照旧杀。
//
// 本套件跑 manager 内置的 `--self-test-watchdog`（用桩把探活结果按顺序喂给**真实的
// watchdogTick**），并做三个**变异自证**——证明这两条断言真的会失败：
//   ① 把 `if (recheck.ok)` 改成 `if (false)` ⇒ 场景 1（已恢复）必红；
//   ② 改成 `if (true)` ⇒ 场景 2（真挂起）必红；
//   ③ 把日志里的 `recovered` 改掉 ⇒ 场景 1 的日志断言必红（防"日志只是摆设"）。
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
check('self-test 汇总 2/2', () => assert.match(real.stdout, /watchdog self-test: 2\/2 passed/))
check('日志不含 token / 完整 URL（探针 URL 带 ?token=…）', () => {
  assert.ok(!real.stdout.includes('SELF-TEST-SECRET'), '日志泄露了探针 URL 里的 token')
  assert.ok(!/token=/.test(real.stdout), '日志出现了 token= 参数')
})

// ── 2. 变异自证：改坏判定 ⇒ 对应场景必须变红 ───────────────────────────────
/** 在临时副本上改一处后跑 self-test（副本自带 manager 的本地依赖）。 */
function runMutation(label, transform) {
  const dir = join(work, `mut-${label}`)
  cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true })
  const target = join(dir, 'scripts', 'server-manager.mjs')
  const original = readFileSync(target, 'utf8')
  const mutated = transform(original)
  assert.notEqual(mutated, original, `变异 ${label} 没有改动任何字节（锚点漂移 ⇒ 变异自证无效）`)
  writeFileSync(target, mutated)
  const result = runSelfTest(target)
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

rmSync(work, { recursive: true, force: true })
if (failures) {
  console.error(`\nFAILED: watchdog 恢复再探门禁 ${failures} 项`)
  process.exit(1)
}
console.log('\nPASS: watchdog dump 后再探一次（恢复不杀 / 真挂起仍重启 + 3 个变异自证）')
