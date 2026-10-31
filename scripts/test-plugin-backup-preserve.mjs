#!/usr/bin/env node
// 端到端断言：安装开始时 `.plugin-backup` **只挪不删**（改名为 `.plugin-backup.prev`），
// 且"只存在于备份里"的插件标记不会因为一次安装尝试而丢失。
//
// 背景（2026-10-07 质量审计修的数据丢失面）：`server-manager.mjs` 原来在安装开始时无条件
// `rmSync(.plugin-backup)`。若上一次安装在"恢复插件"之前被打断，这份备份可能就是用户插件
// **唯一的一份拷贝** ⇒ 删掉就把"可恢复"变成"不可恢复"。修法：只挪不删（→ `.plugin-backup.prev`），
// 启动恢复主备份优先。
//
// ★ 为什么前四次实证是假绿（2026-10-31 第五次实证修正，逐条对源码核实）：
//   1) 旧套件在 manager **启动之前**就预置了 `.plugin-backup`。而 main() 的启动恢复
//      （日志 `restored interrupted-install plugin backup`）会把它恢复进 node_modules 并
//      **删掉备份目录** ⇒ 安装开始时根本没有 `.plugin-backup` 可挪，`.prev` 永远不会出现；
//      旧套件看到的"标记仍在"恰恰是这条**启动恢复路径**恢复的，与"只挪不删"无关。
//   2) 旧套件依赖的 `DSH_TEST_FAKE_DSH_PKG` 在 manager 里**根本不存在**（全文无引用），
//      假 dsh 包从未被采用；manager 反而因"dsh 版本未知 → 跳过地板守卫"直接去启动 dsh。
//   本版改用 `scripts/test-control-plane.mjs` 同款驱动面：预置 runtime 里的假 dsh
//   （stdout 打印 manager 认的 url 行并常驻，无需真安装/联网），等**启动完成（url 事件）后**
//   再放标记，然后用 stdin JSON 命令 `update-dsh`（带显式版本）发起一次真实安装。
//
// 两个场景（都是同一个威胁模型的半边，缺一即漏）：
//   A. **安装被打断**（观察到 `.plugin-backup.prev` 后立刻 SIGTERM）：
//      ① `.plugin-backup.prev` 出现（rename 而非删除，证明到达目标代码）；
//      ② rename 后标记内容完整地留在 `.plugin-backup.prev` 里；
//      ③ 打断后 `.prev` 与标记**仍在磁盘上**。
//   B. **安装跑完但失败**（假 pnpm 两次 registry 都失败 ⇒ `install-status=error`）：
//      ④ 失败后 `.prev` 仍在磁盘上、标记仍在 —— 2026-10-31 修：旧实现在恢复循环末尾**不区分成败**
//         删除 `.prev`，等于把"上次被打断的安装里唯一的一份拷贝"删掉（套件先抓到、后修）。
//      修复后失败时保留 `.prev`，下次启动的 recoverFrom 会在"主备份不存在而 .prev 存在"时用它兜底。
//
// 判据顺序不可换：观察不到 `.plugin-backup.prev` 就是没走到目标代码 ⇒ 失败，不许放宽成"标记仍在"。
// 假 pnpm 桩先挂起 8s 再失败，给观察/打断留窗口；两次 registry 尝试都是桩，不联网。
//
// 负向对照（必须变红）：
//   把 `scripts/` 复制到临时目录，把 `installDshUpdate` 开头那段
//   `if (existsSync(backupDir)) { ... renameSync(backupDir, prevBackupDir) ... }`
//   字符串替换成 `rmSync(backupDir, ...)`，然后：
//     DSH_PB_MANAGER=/tmp/neg/scripts/server-manager.mjs node scripts/test-plugin-backup-preserve.mjs
//   ⇒ 场景 A 的断言 ① 变红（`.plugin-backup.prev` 从未出现），且标记被删除。
//   把"仅在成功时删 .prev"改回无条件 rmSync ⇒ 场景 B 的断言 ④ 变红（这是 2026-10-31 修复的对照）。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 负向对照用：允许指向一份被改坏的临时副本（绝不改仓库源码）。
const MANAGER = process.env.DSH_PB_MANAGER
  ? resolve(process.env.DSH_PB_MANAGER)
  : join(ROOT, 'scripts', 'server-manager.mjs')
const NODE = process.execPath
const MARK = 'ONLY-COPY-MARKER'
const MARK_REL = join('only-copy-plugin', MARK) // 只存在于备份里的包（模拟被 pnpm 剪掉后仅剩的拷贝）

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`)
  else { console.error(`  FAIL ${name}${detail ? `  (${detail})` : ''}`); failures++ }
}

/**
 * @param {{ label: string, interrupt: boolean }} opts
 *   interrupt=true  ⇒ 看到 `.plugin-backup.prev` 后立刻 SIGTERM（场景 A）；
 *   interrupt=false ⇒ 等安装跑完（假 pnpm 失败）并收到 install-status=error 再断言（场景 B）。
 */
async function runScenario({ label, interrupt }) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-pb-'))
  const runtime = join(tmp, 'runtime')
  const fakeHome = join(tmp, 'home')
  mkdirSync(join(runtime, 'node_modules'), { recursive: true })
  mkdirSync(fakeHome, { recursive: true })
  const BACKUP = join(runtime, '.plugin-backup')
  const PREV = join(runtime, '.plugin-backup.prev')

  // ── 假 dsh：manager 从子进程 stdout 匹配 url 行；不需要真实现 ───────────────
  const dshDir = join(runtime, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(dshDir, 'lib'), { recursive: true })
  writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '999.0.0-test' }, null, 2))
  writeFileSync(join(dshDir, 'lib', 'bin.js'),
    "process.stdout.write('dsh web: http://127.0.0.1:18123/?token=TEST\\n')\nsetInterval(() => {}, 1000)\n")

  // ── 假 pnpm：先挂起再失败（观察窗口；不联网、不真的装东西）──────────────────
  mkdirSync(join(runtime, 'node_modules', 'pnpm', 'bin'), { recursive: true })
  writeFileSync(join(runtime, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), [
    "process.stderr.write('stub pnpm: holding for observation window\\n')",
    "setTimeout(() => { process.stderr.write('stub pnpm: failing on purpose\\n'); process.exit(3) }, 8000)",
    '',
  ].join('\n'))

  // 最小 patch（假 dsh 不解析它）+ 假 registry：只为让 `npm view` 快速返回，绝不触网。
  const patch = join(tmp, 'patch.yml')
  writeFileSync(patch, '- insert:\n    - id: test\n      name: "@dsh-desktop/client-notifications"\n')
  const registry = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ 'dist-tags': { latest: '9.9.9' } }))
  })
  await new Promise((r) => registry.listen(0, '127.0.0.1', r))

  const child = spawn(NODE, [
    MANAGER,
    '--runtime-dir', runtime,
    '--resource-dir', join(ROOT, 'src-tauri', 'resources'),
    '--patch', patch,
    '--cwd', tmp,
    '--home', fakeHome,
    '--registry', `http://127.0.0.1:${registry.address().port}/`,
  ], {
    // hermetic：宿主若由 `npm test` 启动，会注入 npm_config_*（cache 只读 / proxy 指向 harness），
    // manager 的 `npm view` 子进程会失败。清掉并把 cache 指到本场景的临时目录（与 test-broken-install 同因）。
    env: (() => {
      const env = { ...process.env, HOME: fakeHome, DSH_DESKTOP_NO_UPDATE: '1' }
      for (const key of Object.keys(env)) if (/^npm_config_/i.test(key) || /^npm_lifecycle_/i.test(key)) delete env[key]
      env.npm_config_cache = join(tmp, 'npm-cache')
      return env
    })(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  // stdout 是 JSON 行事件；manager.log 是持久旁路（不受事件时序影响）。
  const events = []
  let stdoutBuf = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdoutBuf += String(chunk)
    let nl
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim()
      stdoutBuf = stdoutBuf.slice(nl + 1)
      if (!line) continue
      try { events.push(JSON.parse(line)) } catch { /* 非 JSON 噪声 */ }
    }
  })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const managerLog = () => (existsSync(join(runtime, 'manager.log')) ? readFileSync(join(runtime, 'manager.log'), 'utf8') : '')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (pred, what, timeoutMs = 90_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = events.find(pred)
      if (hit) return hit
      if (child.exitCode !== null) throw new Error(`manager 在 ${what} 之前退出（exit=${child.exitCode}）\nstderr: ${stderr.slice(0, 1500)}`)
      await sleep(25)
    }
    throw new Error(`等待 ${what} 超时（manager.log 尾部：${managerLog().split('\n').slice(-8).join(' | ')}）\nstderr: ${stderr.slice(0, 1500)}`)
  }
  const readMarkerFrom = (dir) => {
    const p = join(dir, MARK_REL)
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  }

  let prevSeen = false
  let prevMarkerInPrev = null
  let prevBeforeSeed = null
  let managerExit = null
  let newBackupSeeded = null
  let terminalPhase = null
  try {
    // ── 场景前置 1：启动完成（这一步同时保证启动恢复已经跑过）──────────────────
    const bootEvent = await waitFor((e) => e.t === 'url', '启动后的 url 事件')
    prevBeforeSeed = existsSync(PREV)

    // ── 场景前置 2：放"仅备份里有"的标记（必须晚于启动恢复，否则会被它消费掉）──
    mkdirSync(join(BACKUP, 'only-copy-plugin'), { recursive: true })
    writeFileSync(join(BACKUP, MARK_REL), 'must-not-be-lost\n')

    // ── 发起一次真实安装（显式版本 ⇒ 不等 registry）────────────────────────────
    child.stdin.write(JSON.stringify({ cmd: 'update-dsh', version: '999.0.0-next' }) + '\n')

    // 观察顺序：先看到 `.prev` 出现（到达目标代码）→ 再看标记。
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (existsSync(PREV)) { prevSeen = true; break }
      const terminal = events.find((e) => e.t === 'install-status' && (e.phase === 'done' || e.phase === 'error'))
      if (terminal) { terminalPhase = terminal.phase; break }
      if (child.exitCode !== null) break
      await sleep(20)
    }
    if (prevSeen) {
      await sleep(250) // 让紧随 rename 之后的"新备份拷贝"落盘，便于记录现场
      prevMarkerInPrev = readMarkerFrom(PREV)
      newBackupSeeded = existsSync(join(BACKUP, '@dsh-desktop', 'client-notifications', 'package.json'))
    }

    check(`${label}【前置】manager 启动并拉起 dsh（收到 url 事件）`, Boolean(bootEvent))
    check(`${label}【前置】标记晚于启动恢复放入（放之前 .plugin-backup.prev 不存在）`, prevBeforeSeed === false, `prevExist=${prevBeforeSeed}`)
    check(`${label}【关键·目标代码】安装路径被执行：.plugin-backup 被改名为 .plugin-backup.prev`, prevSeen,
      terminalPhase ? `先收到 install-status=${terminalPhase}` : '等待超时/manager 提前退出')
    check(`${label}标记随 rename 保留在 .plugin-backup.prev 内（只挪不删）`, prevMarkerInPrev !== null,
      prevSeen ? 'rename 后标记不存在' : '未进入安装路径')

    if (interrupt) {
      // 立刻打断安装 —— 这正是"上次安装在恢复前被打断"的威胁模型。
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      managerExit = await new Promise((r) => {
        if (child.exitCode !== null) return r(child.exitCode)
        child.once('exit', (code, signal) => r(code ?? signal))
        setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } r('timeout') }, 15_000)
      })
      const afterPrev = existsSync(PREV)
      const afterMarker = afterPrev ? readMarkerFrom(PREV) : null
      check(`${label}打断安装后 .plugin-backup.prev 仍在磁盘上`, afterPrev)
      check(`${label}打断安装后标记内容仍完整（未被删除/清空）`, afterMarker !== null && afterMarker.includes('must-not-be-lost'))
    } else {
      // 不打断：等安装跑完并失败（假 pnpm 两次 registry 都失败）
      const terminal = await waitFor((e) => e.t === 'install-status' && (e.phase === 'done' || e.phase === 'error'), '安装终态事件')
      terminalPhase = terminal.phase
      check(`${label}安装跑完且失败（install-status=error，不是 done —— 否则本场景无意义）`, terminal.phase === 'error', `phase=${terminal.phase}`)
      const afterPrev = existsSync(PREV)
      const afterMarker = afterPrev ? readMarkerFrom(PREV) : null
      check(`${label}失败安装后 .plugin-backup.prev 仍在磁盘上（旧实现会无条件删掉）`, afterPrev,
        '旧实现在恢复循环末尾不区分成败 rmSync(prevBackupDir) ⇒ 唯一拷贝丢失')
      check(`${label}失败安装后标记内容仍完整（未被删除/清空）`, afterMarker !== null && afterMarker.includes('must-not-be-lost'))
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      managerExit = await new Promise((r) => {
        if (child.exitCode !== null) return r(child.exitCode)
        child.once('exit', (code, signal) => r(code ?? signal))
        setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } r('timeout') }, 15_000)
      })
    }

    const logText = managerLog()
    check(`${label}命令面生效：manager 记录了安装请求（不是 unknown manager command）`,
      logText.includes('update requested by user') && !logText.includes('unknown manager command'))
    console.log(`  ${label}现场：manager exit=${managerExit}${terminalPhase ? ` install-status=${terminalPhase}` : ''}；`
      + `新备份已建 = ${newBackupSeeded}；.prev 中存在标记 = ${prevMarkerInPrev !== null}`)
  } catch (err) {
    console.error(`  FAIL ${label}场景搭建/观察抛错：${err.message}`)
    failures++
    try { child.kill('SIGKILL') } catch { /* gone */ }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGTERM') } catch { /* gone */ } }
    await new Promise((r) => registry.close(r))
    const logLines = managerLog().split('\n').filter(Boolean)
    if (logLines.length) {
      console.log(`  ${label}--- manager.log（尾部 10 行）---`)
      for (const l of logLines.slice(-10)) console.log('    ' + l.slice(0, 220))
    }
    if (stderr.trim()) {
      console.log(`  ${label}--- manager stderr（尾部 4 行）---`)
      for (const l of stderr.trim().split('\n').slice(-4)) console.log('    ' + l.slice(0, 220))
    }
    rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('== 场景 A：安装开始 → 观察到 .plugin-backup.prev 后立即打断（威胁模型：上次安装在恢复前被打断）==')
await runScenario({ label: 'A ', interrupt: true })
console.log('\n== 场景 B：安装跑完但失败（假 pnpm 两次 registry 均失败）—— .prev 不得被删 ==')
await runScenario({ label: 'B ', interrupt: false })

if (failures) { console.error(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: 安装开始时插件备份只挪不删（.plugin-backup → .plugin-backup.prev），'
  + '被打断与"跑完但失败"两种情形下标记都未丢失')
