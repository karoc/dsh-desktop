#!/usr/bin/env node
// dsh:adapt —— 把"抬 dsh 地板"的机械动作收成一条命令（自动化方案 P1）。
//
//   node scripts/dsh-adapt.mjs --version 0.2.1-rc.2 [--runtime <dir>] [--dry-run]
//                              [--allow-yellow] [--canary] [--canary-timeout 180]
//                              [--dev-log <file>] [--manager-log <file>] [--strict-chain]
//
// 每步都有可失败的判据，任一步失败**立即停下**（fail-closed，不静默通过）：
//   1 runtime 里装的 dsh 版本 == 目标版本（安装由产品自身路径完成，见方案 §3.1）
//   2 两份 MIN_DSH_VERSION 同步抬高 + 适配记录写进注释块**内部** + `node --check` 校验（不通过则回滚）
//   3 README 里的地板数值同步（CI 有「改了 manager 必改 README」门禁）
//   4 patch 夹具重采（--update-fixture --runtime）并核对采集版本
//   5 预装插件 peer 兼容（test-plugin-dsh-compat）—— 地板与 bundle 必须同批
//   6 探针非 RED（红色即停；**默认给探针带 --fail-on-yellow ⇒ YELLOW 也停**，要放行必须显式
//     --allow-yellow —— 以前 yellow 会以 exit 0 通过，等于把"含糊"当"绿"）
//     **--dry-run 时**：探针按"演练假设值"判定版本一致性（`--assume-floor <TARGET> --assume-fixture <TARGET>`）。
//     为什么：dry-run 跳过第 2/4 步（写地板 / 重采夹具），而 `version-vs-floor` / `version-vs-fixture` 两条 RED
//     只能靠那两步消掉 ⇒ 旧实现下 target≠floor 时"演练"必然停在第 6 步 —— 那是假演练（2026-10-19 审计定性）。
//     非 dry-run **绝不**传这两个开关（绝不静默假设），演练结论也不代表真实一致。
//   7 全量门禁（**先 sync 派生的 Cargo.lock**，再按 package.json 的 test 链逐条跑，等价 CI；
//     本机 npm CLI 不可用，故直接跑 node）。为什么必须先 sync：Cargo.lock 是派生物，release-please
//     对它的 extra-files 过滤式替换实测不生效（见 sync-cargo-lock-version.mjs 头注释），于是干净 main 上
//     会出现 package.json / tauri.conf.json / Cargo.toml = 0.20.0 而 Cargo.lock = 0.19.0 的漂移。
//     CI 的 test 作业在 `npm test` **之前**先跑 sync 掩盖了它；本脚本不跑 sync 就会在最后一步必红，
//     每一次真实适配都被误判成"适配失败"（2026-10-23 实测确认）。sync 只改 Cargo.lock、只对齐到
//     Cargo.toml —— **三处 manifest 彼此不一致时它不会去修**，后面的 test-manifest-consistency 照样红，
//     所以这里**不是**用它掩盖真实不一致：它只修"派生物落后于真源"这一种漂移。
//   8 汇总 + 剩余人工步骤（dev 实机验收 / PR / 发布 / 装机）
//
// --canary 的前提：它只认「脚本启动**之后**新写入的日志行」，所以 dev 壳必须在检查期间**新启动**
//（一个早就开着且空闲的壳不会产生新标记行）。检查只读日志，不启动也不杀任何进程。
//
// **三个标记分居两个文件**（2026-10-19 审计定性：旧实现只读 --dev-log ⇒ 该"硬门槛"结构上永不通过）：
//   session 日志（<dev 数据目录>/dsh-desktop-session.log）= 壳 chrome 与 dsh web 的就绪上报；
//   **manager 日志（<runtime>/manager.log，由随包 manager 的 log() 落盘）** = 预装 bundle 装载。
// 两个文件都必须给出、都要读、都要在"检查开始之后新写入的行"里匹配；缺哪个标记要指名哪个文件。
//
// **刻意不做**：装候选版本（走 manager 的安装路径，实测 31.9s）、建 PR、发版、装机 —— 这些有对外副作用，
// 由人和产品流程执行。`--canary` 只**读取** dev 实例日志做验收断言，不启动/不杀任何进程。
//
// 幂等：目标版本与地板已一致时，2/3 步报 skip，其余步骤照常校验。

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANAGER_SRC = join(ROOT, 'scripts/server-manager.mjs')
const MANAGER_COPY = join(ROOT, 'src-tauri/resources/manager/server-manager.mjs')
const README = join(ROOT, 'README.md')
const FIXTURE = join(ROOT, 'scripts/fixtures/dsh-web-app-patch-ids.json')
const PATCH_GATE = join(ROOT, 'scripts/test-patch-targets.mjs')
const PLUGIN_GATE = join(ROOT, 'scripts/test-plugin-dsh-compat.mjs')
const PROBE = join(ROOT, 'scripts/dsh-compat-probe.mjs')
const DEFAULT_DEV_RUNTIME = join(process.env.APPDATA ?? '', 'dsh.smoothly.desktop.dev', 'runtime')
const DEFAULT_DEV_LOG = join(process.env.APPDATA ?? '', 'dsh.smoothly.desktop.dev', 'dsh-desktop-session.log')  // 仅在 Windows 宿主上可用

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}
const TARGET = arg('--version')
const RUNTIME = arg('--runtime', existsSync(DEFAULT_DEV_RUNTIME) ? DEFAULT_DEV_RUNTIME : null)
const DRY = argv.includes('--dry-run')
const ALLOW_YELLOW = argv.includes('--allow-yellow')
const CANARY = argv.includes('--canary')
const CANARY_TIMEOUT = Number(arg('--canary-timeout', '180'))
const STRICT_CHAIN = argv.includes('--strict-chain')
// 默认日志路径：$APPDATA 只在 Windows 宿主上有（在 WSL 里跑会塌成相对路径 —— 实测踩过），
// 因此回退到从 --runtime 推导：<dev 数据目录>/runtime ⇒ 同级的 dsh-desktop-session.log。
const resolvedDevLog = process.env.APPDATA
  ? join(process.env.APPDATA, 'dsh.smoothly.desktop.dev', 'dsh-desktop-session.log')
  : (RUNTIME ? join(dirname(RUNTIME), 'dsh-desktop-session.log') : DEFAULT_DEV_LOG)
const DEV_LOG = arg('--dev-log', resolvedDevLog)
// manager 日志 = <runtime>/manager.log：随包 manager 的 log() 落盘位置（server-manager.mjs 的
// appendFileSync(join(args.runtimeDir, 'manager.log'), …)）。预装 bundle 的装载标记只在这里。
const MANAGER_LOG = arg('--manager-log', RUNTIME ? join(RUNTIME, 'manager.log') : null)

if (!TARGET || !RUNTIME) {
  console.error('usage: dsh-adapt.mjs --version <x.y.z[-pre]> [--runtime <dir>] [--dry-run] [--allow-yellow] [--canary] [--strict-chain]')
  console.error('       [--dev-log <session.log>] [--manager-log <runtime/manager.log>]')
  console.error('  --dry-run：不写文件；探针按**演练假设值**判定版本一致性（--assume-floor/--assume-fixture = 目标版本），不代表真实一致')
  console.error(`  （--runtime 缺省尝试 dev 实例：${DEFAULT_DEV_RUNTIME}）`)
  process.exit(2)
}

const floorOf = (file) => /MIN_DSH_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(file, 'utf8'))?.[1] ?? null
const RUNTIME_PKG = join(RUNTIME, 'node_modules/@deepseek-ai/dsh/package.json')
const PREV_FLOOR = /MIN_DSH_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(MANAGER_SRC, 'utf8'))?.[1] ?? null
const steps = []
const note = (name, status, detail) => {
  steps.push({ name, status, detail })
  const tag = { ok: ' ok ', skip: 'skip', fail: 'FAIL' }[status]
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}`)
}
const abort = (name, detail) => {
  note(name, 'fail', detail)
  summary(1)
}
const summary = (code) => {
  console.log('\n—— 汇总 ——')
  for (const s of steps) console.log(`  ${s.status === 'ok' ? '✓' : s.status === 'skip' ? '·' : '✗'} ${s.name}${s.detail ? `：${s.detail}` : ''}`)
  if (DRY) {
    console.log('\n⚠️ 演练模式（版本一致性按假设值判定）：本次 --dry-run 让探针按 --assume-floor/--assume-fixture = '
      + `${TARGET} 判 version-vs-floor / version-vs-fixture，**不代表版本已真实一致**；`
      + '真实校验请去掉 --dry-run 重跑（非 dry-run 绝不带假设值）。')
  }
  if (code === 0) {
    console.log('\n下一步（人工/产品流程，脚本刻意不做）：')
    console.log('  1) dev 实机验收：启动 dev 壳后跑 `node scripts/dsh-adapt.mjs --version ' + TARGET + ' --canary`')
    console.log('  2) 提交 + PR（注意：本仓任何提交合并都会触发 release-please 版本 PR）')
    console.log('  3) 合并 → tag 构建 → 装到正式版')
  }
  process.exit(code)
}

console.log(`dsh:adapt 目标 ${TARGET}${DRY ? '（dry-run，不写文件；版本一致性按**演练假设值**判定，不代表真实一致）' : ''}`)
console.log(`  runtime = ${RUNTIME}`)
console.log(`  地板 = ${floorOf(MANAGER_SRC)}（src）/ ${floorOf(MANAGER_COPY)}（随包副本）\n`)

// ── 1. 目标版本必须在 runtime 里真的装着（安装由产品路径完成）─────────────────
if (!existsSync(RUNTIME_PKG)) abort('1 runtime 已装版本', `${RUNTIME} 下没有 @deepseek-ai/dsh`)
const installed = JSON.parse(readFileSync(RUNTIME_PKG, 'utf8')).version
if (installed !== TARGET) {
  abort('1 runtime 已装版本', `runtime 装的是 ${installed}，不是目标 ${TARGET}。先用产品路径装（把地板写进随包 manager 后由 manager 安装），例如 --version ${installed} 可先验证现有版本`)
}
note('1 runtime 已装版本', 'ok', `${installed}`)

// ── 2. 两份地板 + 适配记录（插在注释块内部）+ 语法校验，失败回滚 ─────────────
const LOG_LINE = ` * ${new Date().toISOString().slice(0, 10)} 抬到 ${TARGET}：夹具重采（--update-fixture，runtime 实测 ${TARGET}），\n * README 地板数值同步，预装 bundle 的 peer 由 test-plugin-dsh-compat 校验（地板与 bundle 同批）。\n`
const patchManager = (file) => {
  const before = readFileSync(file, 'utf8')
  const floor = floorOf(file)
  if (floor === TARGET) return { changed: false, text: before }
  if (!floor) throw new Error(`读不到 ${file} 的 MIN_DSH_VERSION`)
  let text = before.replace(`const MIN_DSH_VERSION = '${floor}'`, `const MIN_DSH_VERSION = '${TARGET}'`)
  // 适配记录必须落在 `const MIN_DSH_VERSION` 之前那个注释块**内部**：
  // 插在 `*/` 外面会变成裸文本 ⇒ SyntaxError（本会话真实踩过，只有会执行 manager 的套件抓到）。
  const idx = text.indexOf('const MIN_DSH_VERSION =')
  const open = text.lastIndexOf('/*', idx)
  const close = text.lastIndexOf('*/', idx)
  if (open < 0 || close < 0 || close > idx) throw new Error(`${file} 的 MIN_DSH_VERSION 前找不到完整注释块`)
  text = text.slice(0, close) + LOG_LINE + ' ' + text.slice(close)
  return { changed: true, text }
}
try {
  const patched = [patchManager(MANAGER_SRC), patchManager(MANAGER_COPY)]
  if (!patched[0].changed) {
    note('2 地板（两份）+ 适配记录', 'skip', `已是 ${TARGET}`)
  } else if (DRY) {
    note('2 地板（两份）+ 适配记录', 'skip', `dry-run：将把两份地板改为 ${TARGET} 并追加适配记录`)
  } else {
    for (const [file, p] of [[MANAGER_SRC, patched[0]], [MANAGER_COPY, patched[1]]]) {
      const backup = readFileSync(file, 'utf8')
      writeFileSync(file, p.text)
      const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
      if (check.status !== 0) {
        writeFileSync(file, backup)
        abort('2 地板（两份）+ 适配记录', `node --check 失败已回滚 ${file}：${(check.stderr || '').split('\n')[0].slice(0, 160)}`)
      }
    }
    note('2 地板（两份）+ 适配记录', 'ok', `两份都改为 ${TARGET}，node --check 通过`)
  }
} catch (error) {
  abort('2 地板（两份）+ 适配记录', error.message)
}

// ── 3. README 地板数值同步（只替换**旧地板字符串**，不碰历史版本号与插件版本号）──
{
  const src = readFileSync(README, 'utf8')
  if (PREV_FLOOR === null) {
    note('3 README 地板数值', 'skip', '读不到旧地板，跳过')
  } else if (PREV_FLOOR === TARGET) {
    note('3 README 地板数值', 'skip', `README 已无旧地板 ${PREV_FLOOR}（或本来就一致）`)
  } else {
    const hits = src.split(PREV_FLOOR).length - 1
    if (hits === 0) {
      note('3 README 地板数值', 'skip', `README 里找不到旧地板 ${PREV_FLOOR}；CI 的文档同步门禁要求同 PR 改 README，请人工确认`)
    } else if (DRY) {
      note('3 README 地板数值', 'skip', `dry-run：将把 ${hits} 处 ${PREV_FLOOR} 换成 ${TARGET}`)
    } else {
      writeFileSync(README, src.split(PREV_FLOOR).join(TARGET))
      note('3 README 地板数值', 'ok', `替换 ${hits} 处 ${PREV_FLOOR} → ${TARGET}`)
    }
  }
}

// ── 4. 夹具重采 ───────────────────────────────────────────────────────────
if (DRY) {
  note('4 patch 夹具重采', 'skip', 'dry-run')
} else {
  const out = spawnSync(process.execPath, [PATCH_GATE, '--update-fixture', '--runtime', RUNTIME], { encoding: 'utf8' })
  const fixtureVersion = JSON.parse(readFileSync(FIXTURE, 'utf8')).dshVersion
  if (out.status !== 0 || fixtureVersion !== TARGET) {
    abort('4 patch 夹具重采', `失败或采集版本不对（status=${out.status}, fixture=${fixtureVersion}）：${(out.stdout ?? '').trim().split('\n').slice(-2).join(' | ').slice(0, 200)}`)
  }
  note('4 patch 夹具重采', 'ok', `夹具 dshVersion=${fixtureVersion}，${JSON.parse(readFileSync(FIXTURE, 'utf8')).ids.length} 个 id`)
}

// ── 5. 预装插件 peer 兼容 ──────────────────────────────────────────────────
{
  const out = spawnSync(process.execPath, [PLUGIN_GATE], { encoding: 'utf8' })
  if (out.status !== 0) abort('5 预装插件 peer 兼容', (out.stdout ?? '').trim().split('\n').slice(-2).join(' | ').slice(0, 200))
  note('5 预装插件 peer 兼容', 'ok', 'test-plugin-dsh-compat 通过（地板与四个 bundle 同批）')
}

// ── 6. 探针：RED 即停；yellow 需显式放行 ───────────────────────────────────
// dry-run 走"演练假设"（--assume-floor/--assume-fixture = TARGET）：只替换版本一致性那两条判据的期望值，
// 并**校验报告确实带上了 rehearsal 标记** —— 探针没吃到开关就停，否则等于"白演练还判绿"。
{
  // 报告路径必须**唯一**：固定名（`dsh-adapt-probe-<target>.json`）会让同机并发的第二个 dsh-adapt
  // 读到/删掉别人的报告 ⇒ 步骤 6 假失败或假绿（2026-10-19 复现：8 个并发 dry-run 里 2 个报
  // "探针没有产出报告"）。pid + 时间戳 + 随机后缀同时覆盖"同机并发"与"同 pid 复用"两种撞车。
  const report = join(tmpdir(), `dsh-adapt-probe-${TARGET}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
  try { rmSync(report, { force: true }) } catch { /* ignore */ }   // 先删旧报告，避免读到上一轮的绿
  const probeArgs = [PROBE, '--runtime', RUNTIME, '--json', report]
  // 默认把 yellow 视为失败（探针的 --fail-on-yellow）：yellow 只表示"只差门禁开关/peer 判据不全"
  // 这类含糊态，让整步以 exit 0 通过等于把含糊报成绿。--allow-yellow 仍能显式放行（那时不加此开关，
  // 由下面的 verdict 分支给出 YELLOW⇒ok 的结论）。
  if (!ALLOW_YELLOW) probeArgs.push('--fail-on-yellow')
  if (DRY) probeArgs.push('--assume-floor', TARGET, '--assume-fixture', TARGET)
  const out = spawnSync(process.execPath, probeArgs, { encoding: 'utf8' })
  // 没有报告 = 探针没跑成 = **不能**算通过。旧实现把缺失报告读成 '(no report)' 再落到 ok 分支
  // ⇒ 探针崩了/没写文件时全链路假绿（2026-10-19 审计定性）。
  if (!existsSync(report)) {
    abort('6 探针', `探针没有产出报告（${report}）—— 探针失败不等于通过（status=${out.status}）：${(out.stderr ?? out.stdout ?? '').trim().split('\n').slice(-2).join(' | ').slice(0, 200)}`)
  }
  let parsed = null
  try { parsed = JSON.parse(readFileSync(report, 'utf8')) } catch (error) {
    abort('6 探针', `报告无法解析：${error.message}`)
  }
  try { rmSync(report, { force: true }) } catch { /* ignore */ }
  const verdict = parsed.verdict ?? null
  if (!['red', 'yellow', 'green'].includes(verdict)) abort('6 探针', `报告里的 verdict 非法：${JSON.stringify(verdict)}`)
  // 演练假设必须**可证明**生效：报告里的 rehearsal/assumed 就是证据。两个方向都拦：
  //   dry-run 没带假设 ⇒ 演练是假的（探针按真实值判）；非 dry-run 带了假设 ⇒ 真实校验被假设值污染。
  const assumed = parsed.assumed ?? {}
  if (DRY && !(parsed.rehearsal === true && assumed.floor === TARGET && assumed.fixture === TARGET)) {
    abort('6 探针', `dry-run 要求按演练假设值判定，但报告里 rehearsal=${JSON.stringify(parsed.rehearsal)}、assumed=${JSON.stringify(assumed)}` +
      `（期望 rehearsal=true 且 floor/fixture 都=${TARGET}）—— 拒绝把"没演练成"当通过`)
  }
  if (!DRY && parsed.rehearsal === true) {
    abort('6 探针', `非 dry-run 却拿到 rehearsal=true 的报告（assumed=${JSON.stringify(assumed)}）—— 真实校验不许带假设值，停下人工确认`)
  }
  const rehearsalNote = DRY ? `；演练模式（版本一致性按假设值 ${TARGET} 判定，不代表真实一致）` : ''
  if (verdict === 'red') abort('6 探针', `RED：${(out.stdout ?? '').split('\n').filter((l) => l.includes('[RED]')).slice(0, 3).join(' | ').slice(0, 240)}${rehearsalNote}`)
  if (verdict === 'yellow' && !ALLOW_YELLOW) abort('6 探针', `YELLOW：需人工看一眼再显式加 --allow-yellow 重跑${rehearsalNote}`)
  note('6 探针', 'ok', `verdict=${verdict.toUpperCase()}${rehearsalNote}`)
}

// ── 7. 全量门禁（先 sync Cargo.lock，再按 package.json 的 test 链逐条跑；npm CLI 本机不可用，故直接跑 node）──
{
  // 7.0 与 CI 的 test 作业对齐：`node scripts/sync-cargo-lock-version.mjs` → `npm test`。
  // Cargo.lock 是 Cargo.toml 的派生物（dsh-desktop 那一段），release-please 漏改它 ⇒ manifest 门禁红。
  // 这里只**复用**该脚本，不重写同步逻辑；它只改 Cargo.lock、只对齐到 Cargo.toml，修不了
  // "package.json / tauri.conf.json / Cargo.toml 彼此不一致" —— 那种真不一致留给下面的
  // test-manifest-consistency 判红（绝不以 sync 成功代替门禁结论）。
  const lockFile = join(ROOT, 'src-tauri', 'Cargo.lock')
  const lockBefore = existsSync(lockFile) ? readFileSync(lockFile, 'utf8') : null
  const sync = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-cargo-lock-version.mjs')], { encoding: 'utf8', cwd: ROOT })
  const syncLine = (sync.stdout ?? '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? ''
  // dry-run 的契约是"不落盘"（README：运行前后 git status 一致）：为了把门禁跑在**与真实运行/CI 相同**
  // 的状态上，这里临时同步；跑完（无论门禁成败）把原内容写回，并在明细里说清楚。真实运行则保留同步结果
  //（那正是要一起提交的修复），并提示提交。
  const restoreLock = () => {
    if (!DRY || lockBefore === null) return false
    const now = existsSync(lockFile) ? readFileSync(lockFile, 'utf8') : null
    if (now === lockBefore) return false
    writeFileSync(lockFile, lockBefore)
    return true
  }
  if (sync.status !== 0) {
    const restored = restoreLock()
    abort('7 全量门禁', `跑门禁前 sync Cargo.lock 失败（exit=${sync.status}）：`
      + `${(sync.stdout ?? '').trim().split('\n').slice(-2).join(' | ').slice(0, 200)} ${(sync.stderr ?? '').trim().split('\n')[0]?.slice(0, 160) ?? ''}`
      + `${restored ? '；dry-run 已还原 Cargo.lock' : ''} —— sync 失败不等于门禁通过`)
  }
  if (syncLine) console.log(`      7 前置 sync Cargo.lock：${syncLine}`)
  if (/^FIXED:/.test(syncLine) && !DRY) {
    console.log('      ⚠ Cargo.lock 漂移已被修正（派生物对齐 Cargo.toml）：提交时把 src-tauri/Cargo.lock 一起带上')
  }
  if (/^FIXED:/.test(syncLine)) {
    // 如实说出这条与 CI 相同的副作用：sync 真的改了文件 ⇒ 跑链期间工作树是脏的，test-controls 会按既有规则
    // SKIP 三个可信度对照（它只在干净树上跑）。不能把"跳过"说成"通过"；CI 在 sync 步骤之后也是同样的脏树。
    console.log(DRY
      ? '      ⚠ dry-run：门禁跑在"已同步"状态（期间工作树是脏的）⇒ test-controls 的可信度对照会 SKIP；跑完立即还原 Cargo.lock'
      : '      ⚠ 门禁期间工作树是脏的（Cargo.lock 已改）⇒ test-controls 的三个可信度对照会 SKIP（已知覆盖缺口；CI 的 sync 之后同理，跳过 ≠ 通过）')
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const entries = pkg.scripts.test.split(' && ').map((e) => e.trim())
  let failed = 0
  let ran = 0
  const skipped = []
  for (const raw of entries) {
    let cmd = raw
    const npmRun = /^npm\s+run\s+([\w:.-]+)$/.exec(cmd)
    if (npmRun) cmd = pkg.scripts[npmRun[1]] ?? ''   // 解析一层 npm run 间接
    if (!/^node\s+/.test(cmd)) { skipped.push(raw); continue }  // 非 node 命令（如 cargo 相关）本机跑不了，如实报跳过
    const out = spawnSync(process.execPath, cmd.replace(/^node\s+/, '').split(' '), { encoding: 'utf8', cwd: ROOT })
    ran += 1
    if (out.status !== 0) {
      failed += 1
      console.log(`      FAIL ${raw}`)
      console.log(`      ${(out.stdout ?? '').trim().split('\n').slice(-4).join('\n      ').slice(0, 400)}`)
    }
  }
  // 跳过的条目必须**看得见**（旧实现只把它们塞进 ok 的 detail 里）：默认容忍，但显著打印；
  // --strict-chain 把跳过也算失败（CI 上这些确实会跑，本机跳过 = 覆盖缺口）。
  if (skipped.length) {
    console.log(`      本机跳过 ${skipped.length} 项（非 node 命令，CI 覆盖）：`)
    for (const s of skipped) console.log(`        · ${s}`)
  }
  const restoredOnFail = () => (restoreLock() ? '；dry-run 已还原 Cargo.lock（临时同步仅供门禁使用）' : '')
  if (failed > 0) abort('7 全量门禁', `${failed}/${ran} 套失败${restoredOnFail()}`)
  if (skipped.length && STRICT_CHAIN) abort('7 全量门禁', `--strict-chain：${ran} 套通过，但有 ${skipped.length} 项被本机跳过（${skipped.join(' / ')}）—— 覆盖缺口不算通过${restoredOnFail()}`)
  const restored = restoreLock()
  note('7 全量门禁', 'ok', `先 sync Cargo.lock（${syncLine || '无输出'}${restored ? '；dry-run 已还原（临时同步只为让门禁跑在与 CI 相同的状态）' : ''}）；`
    + `${ran} 套通过（CI 等价：直接跑 node，不经 npm）${skipped.length ? `；本机跳过 ${skipped.length} 项非 node 命令（CI 覆盖，已列在上面；--strict-chain 可把它们算失败）` : ''}`)
}

// ── 8. canary 验收（只读两个日志文件，不启动/不杀进程）─────────────────────
// 三个标记的来源必须写死在断言里：session 日志给 chrome/就绪，manager 日志给预装 bundle 装载。
const CANARY_MARKERS = [
  { text: 'client/log chrome ready', from: 'session', who: '壳 chrome 注入完成' },
  { text: 'client-ready (http)', from: 'session', who: 'dsh web 就绪（HTTP）' },
  { text: 'preinstalled bundles:', from: 'manager', who: '预装 bundle 装载（随包 manager 的 log() 落盘）' },
]
if (CANARY) {
  const logs = { session: DEV_LOG, manager: MANAGER_LOG }
  const missingFiles = Object.entries(logs).filter(([, p]) => !p || !existsSync(p))
    .map(([k, p]) => `${k} 日志（${k === 'session' ? '--dev-log' : '--manager-log'}）= ${p ?? '(未解析出路径，--runtime 为空？)'}`)
  if (missingFiles.length) {
    abort('8 canary 验收', `找不到日志文件：${missingFiles.join('；')}。`
      + '（session 日志默认 <dev 数据目录>/dsh-desktop-session.log；manager 日志默认 <runtime>/manager.log）')
  }
  // 只认"检查开始之后新写入的行"：分别记下两个文件的起始长度，每轮各读自己那段。
  const startSizes = { session: readFileSync(logs.session, 'utf8').length, manager: readFileSync(logs.manager, 'utf8').length }
  const deadline = Date.now() + CANARY_TIMEOUT * 1000
  let missing = CANARY_MARKERS
  const missingText = (list) => list
    .map((m) => `${m.text}（来自 ${m.from === 'session' ? 'session' : 'manager'} 日志 ${logs[m.from]}）`)
    .join(' / ')
  while (Date.now() < deadline) {
    const fresh = {
      session: readFileSync(logs.session, 'utf8').slice(startSizes.session),
      manager: readFileSync(logs.manager, 'utf8').slice(startSizes.manager),
    }
    missing = CANARY_MARKERS.filter((m) => !fresh[m.from].includes(m.text))
    if (missing.length === 0) break
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},5000)'])
  }
  if (missing.length) {
    abort('8 canary 验收', `${CANARY_TIMEOUT}s 内没看到这些标记（新增行内）：${missingText(missing)}。`
      + `本次新写入的字节数：session ${readFileSync(logs.session, 'utf8').length - startSizes.session}、`
      + `manager ${readFileSync(logs.manager, 'utf8').length - startSizes.manager}`
      + ' —— 确认 dev 壳真的在检查期间**新启动**（空闲的壳不产生新标记行），且两个日志路径都指对')
  }
  note('8 canary 验收', 'ok', '三标记齐全（新增行内）：chrome ready / client-ready 来自 session 日志；preinstalled bundles 来自 manager 日志')
} else {
  note('8 canary 验收', 'skip', '未加 --canary（dev 实机验收需 dev 壳在运行）')
}

summary(0)
