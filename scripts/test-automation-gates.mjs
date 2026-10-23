#!/usr/bin/env node
// 自动化链路「门禁自证」套件（2026-10-19 起，`npm test` 链上的一员）。
//
// 它回答一个问题：**dsh 升级自动化链路上的那些判据，在"该失败"的时候会失败吗？**
// 恒真的门禁比没有门禁更糟（它给出虚假的安心），所以每条判据都要有一条"注入对应缺陷 ⇒ 必须变红"的证据。
//
// 覆盖五个判据 + 一条元判据（全部在临时目录里跑，仓库文件只读）：
//   1. probe   `scripts/dsh-compat-probe.mjs`：版本三方一致 / seam / peer / overlay 目标行 —— 该红时红，
//              该 FATAL（exit 2）时 FATAL；native 白名单与 CLI 开关**只算 YELLOW**（已知缺口，见下）。
//   2. sla     `scripts/dsh-sla-report.mjs --check`：最近 N 个超 6h 判红、窗口外不判红、**没有数据判红**
//              （旧实现在 perVersion 缺失/为空时 0/0 ⇒ exit 0，是假绿）。
//   3. watch   `scripts/dsh-watch.mjs`：违约判定在门槛前后（5.998h/6.002h）、未来时间戳、坏输入、
//              取不到 npm 发布时间戳时是否 fail-closed（旧实现三处静默判"未违约"）；
//              **2026-10-24 事故 #201–#217 的回归面**：确定性去重（不依赖 label）的幂等性、
//              冷启动、并发 flock 单写者、`~/.dsh/PAUSE` 零写、对账失败只出清单不报假成功。
//   4. adapt   `scripts/dsh-adapt.mjs`：runtime 不符 / 门禁崩 / 探针 RED / **探针没产出报告** /
//              canary 三标记 —— 任一步必须立即停（旧实现把"探针没出报告"判成 ok ⇒ 全链路假绿）。
//   5. drift   `.github/workflows/preinstalled-sync.yml` 的"检测漂移"段（**逐字抽取后在临时目录里跑**）：
//              目录缺失 / package.json 缺失 / npm 查询失败 / 返回值不是版本号 ⇒ 必须判红而不是"无漂移"；
//              本地领先 npm latest ⇒ 不得"降级同步"。
//
// 三条纪律：
//   ① **纯 node、零外部依赖**：不依赖 jq、不依赖本机 npm CLI。npm / gh / curl 一律用**桩**（写在临时
//      目录，通过 PATH / GH_BIN / FAKE_* 环境变量注入），被测脚本与仓库文件一概不改（只读）。
//   ② **断言分级**：CORRECT（正确性判据，红即套件红）与 KNOWN_GAP（已知仍不完美，**只打印、不判红**，
//      避免用"跳过"掩盖假绿；行为一旦变化会以 `GAP?` 提醒把它升级成 CORRECT）。
//   ③ **变异自证**：6 条"在临时副本（拷工作树 + node_modules 软链）上把判据改坏 ⇒ 本套件必须
//      变红"的对照。副本里跑本套件时用 `--only <组> --fast --no-mutation`（否则会递归），
//      且**绝不触碰仓库文件**。其中 doctor 组（2026-10-24 起，采用清单 A11）把"凭据 canary 写失败
//      必须让退出码非零"钉成可失败的判据 —— 它自己从不写真实仓库（`dsh-doctor --self-test` 用内置
//      gh 桩）；坏掉这条判据会让整条自动化链路在"只能读不能写"的 PAT 上继续假装正常。
//
// 用法：
//   node scripts/test-automation-gates.mjs                 # 全量（约 2 分钟）
//   node scripts/test-automation-gates.mjs --only probe    # 只跑一组（probe|sla|watch|doctor|adapt|drift|mutation）
//   node scripts/test-automation-gates.mjs --fast          # 跳过慢用例（canary 等待等），用于变异自证子跑
//   node scripts/test-automation-gates.mjs --no-mutation   # 跳过变异自证（仍打印"跳过了什么"）
//   node scripts/test-automation-gates.mjs --keep          # 保留临时目录（排障）
//
// exit：任何 CORRECT 断言失败、或变异自证未按期变红 ⇒ 1；否则 0（KNOWN_GAP 不影响退出码）。

import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SELF = fileURLToPath(import.meta.url)
const FIXTURE = join(ROOT, 'scripts/fixtures/dsh-web-app-patch-ids.json')
const DRIFT_WORKFLOW = join(ROOT, '.github/workflows/preinstalled-sync.yml')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valOf = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d }
const ONLY = valOf('--only')
const FAST = has('--fast')
const KEEP = has('--keep')
const NO_MUTATION = has('--no-mutation') || process.env.DSH_GATES_CHILD === '1'
const GROUPS = ['probe', 'sla', 'watch', 'doctor', 'adapt', 'drift', 'mutation']
if (ONLY && !GROUPS.includes(ONLY)) {
  console.error(`--only 只支持：${GROUPS.join(' | ')}`)
  process.exit(2)
}
const wants = (g) => !ONLY || ONLY === g

const TMP = mkdtempSync(join(tmpdir(), 'dsh-gates-'))
const BIN = join(TMP, 'bin')
mkdirSync(BIN, { recursive: true })

// 私有 TMPDIR：`dsh-adapt` 的探针报告路径是 `join(os.tmpdir(), 'dsh-adapt-probe-<TARGET>.json')`，
// **同机并发跑两个 adapt（同一个 TARGET）会互相删/读对方正在写的报告** —— 实测 8 个并发 --dry-run 里
// 4 个报"探针没有产出报告"（方向是 fail-closed，不是假绿，但会让门禁随机变红）。
// 本套件自己按顺序跑，但仍可能与并行会话/别的 agent 撞上，所以给它一个私有 TMPDIR：
// 被测判据的语义不变，只是不受"同一台机器上还有谁在跑 adapt"影响。
const PRIVATE_TMP = join(TMP, 'os-tmp')
mkdirSync(PRIVATE_TMP, { recursive: true })
const privateTmpEnv = { TMPDIR: PRIVATE_TMP, TMP: PRIVATE_TMP, TEMP: PRIVATE_TMP }

// ── 断言记录 ────────────────────────────────────────────────────────────────
let nOk = 0
let nFail = 0
let nGap = 0
let nGapChanged = 0
let nSkipped = 0
const failures = []
const gaps = []
const skipped = []

/** 每条断言打印一行。expected/actual 一律字符串化比较，避免隐式语义。 */
function check(group, name, expected, actual, { gap = false, detail = '' } = {}) {
  const ok = String(expected) === String(actual)
  if (ok && gap) {
    nGap += 1
    gaps.push(`[${group}] ${name}`)
    console.log(`  gap  [${group}] ${name}（已知缺口，仍存在：${JSON.stringify(String(actual))}）`)
  } else if (ok) {
    nOk += 1
    console.log(`  ok   [${group}] ${name}`)
  } else if (gap) {
    nGapChanged += 1
    console.log(`  GAP? [${group}] ${name} —— 已知缺口的行为已变化（现为 ${JSON.stringify(String(actual))}）；若确已修好，请把它升级成正确性断言`)
  } else {
    nFail += 1
    failures.push(`[${group}] ${name}：期望 ${JSON.stringify(String(expected))}，实际 ${JSON.stringify(String(actual))}${detail ? `（${detail}）` : ''}`)
    console.log(`  FAIL [${group}] ${name} —— 期望 ${JSON.stringify(String(expected))}，实际 ${JSON.stringify(String(actual))}${detail ? `（${detail}）` : ''}`)
  }
  return ok
}

/** --fast / 平台不可跑时**响亮地**跳过（不是通过：它会被计入 skipped 并在汇总里逐条列出）。 */
function skip(group, name, why) {
  nSkipped += 1
  skipped.push(`[${group}] ${name}（${why}）`)
  console.log(`  SKIP [${group}] ${name} —— ${why}`)
}

// ── 子进程工具 ──────────────────────────────────────────────────────────────
const PATH_WITH_STUBS = `${BIN}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`
function cmd(exe, args, opts = {}) {
  const r = spawnSync(exe, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout ?? 240000,
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
  })
  const status = typeof r.status === 'number' ? r.status : 1
  return { status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
const nodeAt = (root, script, args = [], opts = {}) => cmd(process.execPath, [join(root, script), ...args], opts)
const redIds = (r) => [...r.out.matchAll(/\[RED\] (\S+?): /g)].map((m) => m[1])
const yellowIds = (r) => [...r.out.matchAll(/\[YELLOW\] ([a-z-]+)/g)].map((m) => m[1])
const jsonOf = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const verdictOf = (p) => jsonOf(p)?.verdict ?? 'missing'

const floorOfManager = (root) => /MIN_DSH_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(join(root, 'scripts/server-manager.mjs'), 'utf8'))?.[1] ?? '?'

// ── 桩：npm / curl / gh（全部写在临时目录，绝不依赖本机同名可执行文件）──────
function mkStub(name, text) {
  const p = join(BIN, name)
  writeFileSync(p, text)
  chmodSync(p, 0o755)
  return p
}
// 只实现漂移检测段用到的那一条：npm view <name> dist-tags.latest
// FAKE_NPM_MAP 指向一个 JSON 映射：值 = 版本号 | '@fail' | '@empty' | 任意垃圾文本
mkStub('npm', `#!/usr/bin/env node
const { readFileSync } = require('node:fs')
const map = JSON.parse(readFileSync(process.env.FAKE_NPM_MAP, 'utf8'))
const name = process.argv[3]
const v = map[name]
if (v === undefined || v === '@fail') {
  process.stderr.write('npm ERR! code E404\\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/' + name + '\\n')
  process.exit(1)
}
if (v === '@empty') process.exit(0)
process.stdout.write(v + '\\n')
`)
// 只服务 packument 拉取：FAKE_PACKUMENT 指向本地文件；FAKE_CURL_FAIL=1 时模拟网络故障
mkStub('curl', `#!/usr/bin/env node
const { readFileSync } = require('node:fs')
if (process.env.FAKE_CURL_FAIL === '1' || !process.env.FAKE_PACKUMENT) {
  process.stderr.write('curl: (7) 假 curl：按测试要求失败\\n')
  process.exit(7)
}
process.stdout.write(readFileSync(process.env.FAKE_PACKUMENT, 'utf8'))
`)
// watch / sla 的 gh 调用：记账 + 按 FAKE_GH_ISSUES 回放已有 issue 列表
const GH_STUB = mkStub('gh', `#!/usr/bin/env node
const { appendFileSync, readFileSync, existsSync } = require('node:fs')
const args = process.argv.slice(2)
if (process.env.GH_CALLS) appendFileSync(process.env.GH_CALLS, args.join(' ') + '\\n')
if (args[0] === 'label') process.exit(0)
if (args[0] === 'issue' && args[1] === 'list') {
  const p = process.env.FAKE_GH_ISSUES || ''
  process.stdout.write(existsSync(p) ? readFileSync(p, 'utf8') : '[]')
  process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'create') { process.stdout.write('https://github.com/karoc/dsh-desktop/issues/999\\n'); process.exit(0) }
if (args[0] === 'issue' && args[1] === 'comment') process.exit(0)
if (args[0] === 'api') { process.stdout.write(process.env.FAKE_GH_API ?? ''); process.exit(0) }
process.exit(0)
`)

// 有状态 gh 桩：list 读状态文件、create/edit/comment/close 真改状态。
// 幂等断言（run(); run() ⇒ open 数量不增加）必须用它 —— 回放固定列表的桩永远看不到第二次运行
// 是否又 create 了一条（那样断言会恒真）。失败注入：FAKE_GH_FAIL=create,edit,comment,close；
// FAKE_GH_DROP_LABELS=1 复刻事故（label/assignee 静默丢失）；FAKE_GH_SLEEP_MS 放大并发窗口。
const GH_STATE_STUB = mkStub('gh-stateful', `#!/usr/bin/env node
const { readFileSync, writeFileSync, existsSync, appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
const STATE = process.env.FAKE_GH_STATE || ''
if (process.env.GH_CALLS) appendFileSync(process.env.GH_CALLS, args.join(' ') + '\\n')
const sleepFor = Number(process.env.FAKE_GH_SLEEP_MS || 0)
if (sleepFor > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepFor)
const load = () => ((STATE && existsSync(STATE)) ? JSON.parse(readFileSync(STATE, 'utf8')) : [])
const save = (x) => { if (STATE) writeFileSync(STATE, JSON.stringify(x, null, 2)) }
const fail = (op) => (process.env.FAKE_GH_FAIL || '').split(',').filter(Boolean).includes(op)
const die = (op) => { process.stderr.write('GraphQL: Resource not accessible by personal access token (' + op + ')\\n'); process.exit(1) }
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const opts = (name) => args.reduce((acc, a, i) => (a === name ? acc.concat(args[i + 1]) : acc), [])
if (args[0] === 'label') process.exit(0)
if (args[0] === 'issue' && args[1] === 'list') {
  const want = opt('--state') || 'open'
  process.stdout.write(JSON.stringify(load().filter((i) => want === 'all' || i.state === 'open')))
  process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'view') {
  const it = load().find((i) => i.number === Number(args[2]))
  if (!it) { process.stderr.write('issue not found\\n'); process.exit(1) }
  process.stdout.write(JSON.stringify(it)); process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'create') {
  if (fail('create')) die('createIssue')
  const list = load()
  const n = (list.reduce((m, i) => Math.max(m, i.number), 0) || 200) + 1
  const drop = process.env.FAKE_GH_DROP_LABELS === '1'
  list.push({ number: n, title: opt('--title'), body: readFileSync(opt('--body-file'), 'utf8'),
    labels: drop ? [] : opts('--label').map((name) => ({ name })),
    assignees: drop ? [] : opts('--assignee').map((login) => ({ login })),
    createdAt: new Date().toISOString(), state: 'open', comments: [] })
  save(list); process.stdout.write('https://github.com/karoc/dsh-desktop/issues/' + n + '\\n'); process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'edit') {
  if (fail('edit')) die('updateIssue')
  const list = load(); const it = list.find((i) => i.number === Number(args[2]))
  if (!it) die('updateIssue')
  const t = opt('--title'); if (t) it.title = t
  const bf = opt('--body-file'); if (bf) it.body = readFileSync(bf, 'utf8')
  for (const l of opts('--add-label')) if (!(it.labels || []).some((x) => x.name === l)) (it.labels = it.labels || []).push({ name: l })
  for (const a of opts('--add-assignee')) if (!(it.assignees || []).some((x) => x.login === a)) (it.assignees = it.assignees || []).push({ login: a })
  save(list); process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'comment') {
  if (fail('comment')) die('addComment')
  const list = load(); const it = list.find((i) => i.number === Number(args[2]))
  if (!it) die('addComment')
  it.comments = it.comments || []
  it.comments.push({ body: opt('--body') })
  save(list); process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'close') {
  if (fail('close')) die('closeIssue')
  const list = load(); const it = list.find((i) => i.number === Number(args[2]))
  if (!it) die('closeIssue')
  it.state = 'closed'; save(list); process.exit(0)
}
if (args[0] === 'api') { process.stdout.write(process.env.FAKE_GH_API || ''); process.exit(0) }
process.exit(0)
`)

// ── 合成 runtime（探针/适配的夹具；只在临时目录里造）──────────────────────
const SEAMS = ['settings.section', 'configForms', '__ModuleLoader__', 'settings.general.item', 'settings.plugins.tab', 'conversation.chat.reasoning.body']
const CLI_FLAGS = ['--port', '--patch', '--profile', '--dump-config']
const ALL_DEPS = { '@deepseek-ai/dsh-subprocess-local': '0.2.1', koffi: '2.9.0', 'node-pty': '1.0.0', '@google/genai': '0.1.0', protobufjs: '7.0.0' }
/** 造一个最小假 runtime：版本号 / seam 清单 / CLI 开关 / 依赖清单都可注入。 */
function mkRuntime(dir, version, { seams = true, flags = true, deps = ALL_DEPS } = {}) {
  rmSync(dir, { recursive: true, force: true })
  const dshDir = join(dir, 'node_modules/@deepseek-ai/dsh')
  const webApp = join(dir, 'node_modules/@deepseek-ai/dsh-web-app')
  mkdirSync(join(dshDir, 'lib'), { recursive: true })
  mkdirSync(webApp, { recursive: true })
  writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, dependencies: deps }, null, 2))
  // 权威 dump：打印 fixture 的扁平化 id（- id: <x>）⇒ overlay 契约门禁能过
  writeFileSync(join(dshDir, 'lib/bin.js'), `const fs = require('fs')\n`
    + `const ids = JSON.parse(fs.readFileSync(${JSON.stringify(FIXTURE)}, 'utf8')).ids\n`
    + `process.stdout.write(ids.map((i) => '- id: ' + i + '\\n').join(''))\n`)
  writeFileSync(join(webApp, 'cordis.patch.yml'), '# fake upstream\n')
  const strings = [
    ...(seams ? SEAMS : SEAMS.filter((s) => s !== 'settings.plugins.tab')),
    ...(flags ? CLI_FLAGS : []),
  ]
  writeFileSync(join(webApp, 'lib.js'), `export const seams = [\n${strings.map((s) => `  '${s}',`).join('\n')}\n]\n`)
  return dir
}
const rtPath = (name) => join(TMP, 'rt', name)

/** 共享夹具：合成 runtime。probe 组与 adapt 组都要用 —— 谁先跑谁先造（幂等）。 */
let RUNTIMES = null
function ensureRuntimes() {
  if (RUNTIMES) return RUNTIMES
  const floor = floorOfManager(ROOT)
  const crash = mkRuntime(rtPath('r-crash'), floor)
  writeFileSync(join(crash, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'process.exit(3)\n')  // 被调门禁崩
  const peerPkg = mkRuntime(rtPath('r-peerpkg'), floor)
  const slots = join(peerPkg, 'node_modules/@deepseek-ai/dsh-client-ui-slots')
  mkdirSync(slots, { recursive: true })
  writeFileSync(join(slots, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-client-ui-slots', version: '0.0.1' }))
  RUNTIMES = {
    floor,
    good: mkRuntime(rtPath('r-good'), floor),
    ver: mkRuntime(rtPath('r-ver'), '0.1.9'),
    seam: mkRuntime(rtPath('r-seam'), floor, { seams: false }),
    peer: mkRuntime(rtPath('r-peer'), '0.1.6'),
    crash,
    nat: mkRuntime(rtPath('r-nat'), floor, { deps: Object.fromEntries(Object.entries(ALL_DEPS).filter(([k]) => k !== 'node-pty')) }),
    flag: mkRuntime(rtPath('r-flag'), floor, { flags: false }),
    peerPkg,
  }
  return RUNTIMES
}

// ══ 1. probe ═══════════════════════════════════════════════════════════════
function groupProbe() {
  console.log('\n── 1. dsh-compat-probe：判据在"该红"时会红吗 ─────────────────────')
  const R = ensureRuntimes()
  const floor = R.floor
  const fixture = jsonOf(FIXTURE)
  check('probe', '前置：壳地板 == patch 夹具采集版本（不一致则该组的"正向对照"不存在）',
    true, floor === fixture?.dshVersion, { detail: `地板=${floor} 夹具=${fixture?.dshVersion}` })

  const goodRep = join(TMP, 'rt/good.json')
  let r = nodeAt(ROOT, 'scripts/dsh-compat-probe.mjs', ['--runtime', R.good, '--json', goodRep])
  check('probe', '正向对照：合成 runtime（版本=地板=夹具、seam/CLI/native/peer 齐）⇒ GREEN + exit 0', '0|green', `${r.status}|${verdictOf(goodRep)}`)

  r = nodeAt(ROOT, 'scripts/dsh-compat-probe.mjs', ['--runtime', R.ver])
  check('probe', 'runtime 版本 ≠ 地板/夹具 ⇒ exit 1', '1', String(r.status))
  check('probe', '  且红条目同时含 version-vs-floor 与 version-vs-fixture', 'version-vs-floor,version-vs-fixture', redIds(r).join(','))

  r = nodeAt(ROOT, 'scripts/dsh-compat-probe.mjs', ['--runtime', R.seam])
  check('probe', 'seam `settings.plugins.tab` 消失 ⇒ exit 1', '1', String(r.status))
  check('probe', '  且红条目 id = seam:settings.plugins.tab', 'seam:settings.plugins.tab', redIds(r).join(','))

  r = nodeAt(ROOT, 'scripts/dsh-compat-probe.mjs', ['--runtime', R.peer])
  check('probe', 'dsh 版本低于预装 bundle 的 peer 下限 ⇒ exit 1', '1', String(r.status))
  check('probe', '  且 peer 判据逐包报红（≥3 条 peer* 红：CLI 版本信号 / 已装 peer 包）', true,
    redIds(r).filter((id) => id.startsWith('peer')).length >= 3, { detail: redIds(r).join(',') })

  // overlay 目标行契约：交给既有权威门禁（test-patch-targets --runtime）；探针必须把它包成 red 而不是自己崩
  r = nodeAt(ROOT, 'scripts/dsh-compat-probe.mjs', ['--runtime', R.crash])
  check('probe', '被调门禁崩（bin.js exit 3）⇒ 探针不崩、判 overlay RED + exit 1', '1|overlay-targets', `${r.status}|${redIds(r).join(',')}`)
  const rNoBin = mkRuntime(rtPath('r-nobin'), floor)
  rmSync(join(rNoBin, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
  r = nodeAt(ROOT, 'scripts/dsh-compat-probe.mjs', ['--runtime', rNoBin])
  check('probe', 'bin.js 缺失 ⇒ overlay RED + exit 1', '1|overlay-targets', `${r.status}|${redIds(r).join(',')}`)
  const rNoIds = mkRuntime(rtPath('r-noids'), floor)
  writeFileSync(join(rNoIds, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'process.exit(0)\n')
  r = nodeAt(ROOT, 'scripts/dsh-compat-probe.mjs', ['--runtime', rNoIds])
  check('probe', '--dump-config 吐空 ⇒ overlay RED + exit 1（不许静默绿）', '1|overlay-targets', `${r.status}|${redIds(r).join(',')}`)

  r = nodeAt(ROOT, 'scripts/dsh-compat-probe.mjs', ['--runtime', join(TMP, 'rt/不存在')])
  check('probe', 'runtime 目录不存在 ⇒ FATAL + exit 2（不是 exit 0/1 的模糊态）', '2|true', `${r.status}|${r.stderr.includes('FATAL')}`)
  const rNoPkg = join(TMP, 'rt/r-nopkg')
  rmSync(rNoPkg, { recursive: true, force: true })
  mkdirSync(rNoPkg, { recursive: true })
  r = nodeAt(ROOT, 'scripts/dsh-compat-probe.mjs', ['--runtime', rNoPkg])
  check('probe', '目录里没有 @deepseek-ai/dsh ⇒ exit 2', '2', String(r.status))
  r = nodeAt(ROOT, 'scripts/dsh-compat-probe.mjs', [])
  check('probe', '缺 --runtime ⇒ usage + exit 2', '2', String(r.status))

  const badJson = mkRuntime(rtPath('r-badjson'), floor)
  writeFileSync(join(badJson, 'node_modules/@deepseek-ai/dsh/package.json'), '{ "version": \n')
  r = nodeAt(ROOT, 'scripts/dsh-compat-probe.mjs', ['--runtime', badJson])
  check('probe', 'dsh/package.json 是坏 JSON ⇒ exit ≠ 0（fail-closed）', true, r.status !== 0)
  check('probe', '  报错是异常栈而不是判据失败（KNOWN_GAP：错误文案不合格，但方向是 fail-closed）', true,
    /SyntaxError|JSON\.parse/.test(r.out), { gap: true })

  const noDir = join(TMP, 'rt/不存在/out.json')
  r = nodeAt(ROOT, 'scripts/dsh-compat-probe.mjs', ['--runtime', R.seam, '--json', noDir])
  check('probe', '--json 目标目录不存在 ⇒ exit ≠ 0（fail-closed，不是假绿）', true, r.status !== 0)
  check('probe', '  但报告没写出来（KNOWN_GAP：判定已算完却崩在写文件上，调用方读不到红）', true,
    !existsSync(noDir), { gap: true })

  // 分级：这两类风险只报 YELLOW（exit 0）—— 审计定性为"中"，尚未修
  r = nodeAt(ROOT, 'scripts/dsh-compat-probe.mjs', ['--runtime', R.nat])
  check('probe', '缺 native 白名单包（node-pty）⇒ 只 YELLOW、exit 0（KNOWN_GAP：单跑探针时这条没门禁）', '0|native-build',
    `${r.status}|${yellowIds(r).join(',')}`, { gap: true })
  r = nodeAt(ROOT, 'scripts/dsh-compat-probe.mjs', ['--runtime', R.flag])
  check('probe', '四个 CLI 开关全搜不到 ⇒ 只 YELLOW、exit 0（KNOWN_GAP：文本搜索本身对动态拼装不成立）', '0|cli-flags',
    `${r.status}|${yellowIds(r).join(',')}`, { gap: true })
  // 真的装一个不满足范围的 peer 包本体：判据不读它，只看 dsh CLI 版本 ⇒ 部分升级（CLI 到位、子包滞后）漏判
  const peerPkgRep = join(TMP, 'rt/peerpkg.json')
  r = nodeAt(ROOT, 'scripts/dsh-compat-probe.mjs', ['--runtime', R.peerPkg, '--json', peerPkgRep])
  check('probe', '装了不满足 peer 范围的 @deepseek-ai/dsh-client-ui-slots@0.0.1 ⇒ RED + exit 1（读 peer 包本体，'
    + 'CLI 版本当代理会漏判"子包滞后"）', '1|red|peer:dsh-kanban',
  `${r.status}|${verdictOf(peerPkgRep)}|${redIds(r).join(',')}`)
  check('probe', '  缺 optional peer 包**不**制造假红（四个预装包的 peer 全是 peerDependenciesMeta.optional）', '0',
    String(jsonOf(goodRep)?.counts?.red))

  // 分级开关：默认行为不变（yellow 仍 exit 0，上面已断言），要门禁就显式 --fail-on-yellow
  r = nodeAt(ROOT, 'scripts/dsh-compat-probe.mjs', ['--runtime', R.nat, '--fail-on-yellow'])
  check('probe', 'native 白名单缺包 + --fail-on-yellow ⇒ exit 1（把"只 yellow"升级成门禁的显式开关）', '1', String(r.status))
  r = nodeAt(ROOT, 'scripts/dsh-compat-probe.mjs', ['--runtime', R.good, '--fail-on-yellow'])
  check('probe', '  正向对照：GREEN 的 runtime 加 --fail-on-yellow 仍是 exit 0（不误伤）', '0', String(r.status))

  // 演练假设开关（--assume-floor/--assume-fixture）：只服务 dsh-adapt --dry-run，必须**响亮且可证伪**
  const assumeRep = join(TMP, 'rt/assume.json')
  r = nodeAt(ROOT, 'scripts/dsh-compat-probe.mjs', ['--runtime', R.ver, '--assume-floor', '0.1.9', '--assume-fixture', '0.1.9', '--json', assumeRep])
  check('probe', '演练假设生效：把 floor/fixture 假设成 runtime 的版本 ⇒ 版本判据不再红 + exit 0', '0', String(r.status))
  check('probe', '  且报告里 rehearsal=true、assumed.floor/fixture 都写出来（调用方可证伪"演练成了"）', 'true|0.1.9|0.1.9',
    `${jsonOf(assumeRep)?.rehearsal}|${jsonOf(assumeRep)?.assumed?.floor}|${jsonOf(assumeRep)?.assumed?.fixture}`)
  check('probe', '  且 stdout 明说"演练模式 / 不代表真实一致"（不静默假设）', 'true|true',
    `${r.stdout.includes('演练模式')}|${r.stdout.includes('不代表')}`)
  r = nodeAt(ROOT, 'scripts/dsh-compat-probe.mjs', ['--runtime', R.good, '--assume-floor', 'garbage'])
  check('probe', '--assume-floor 是垃圾版本号 ⇒ exit 2（坏输入不静默降级成"没给"）', '2', String(r.status))
}

// ══ 2. sla-report --check ══════════════════════════════════════════════════
function groupSla() {
  console.log('\n── 2. dsh-sla-report --check：没有数据 ≠ 达标 ────────────────────')
  const SLA = join(TMP, 'sla')
  mkdirSync(SLA, { recursive: true })
  // 行形状与报表输出一致（inScope 只看 t0 是否晚于 --since 默认 2026-10-19）
  const row = (shell, hours, t0 = '2026-10-19T00:00:00Z') => ({
    shell, floor: '0.2.1-rc.2', t0,
    publishedAt: new Date(new Date(t0).getTime() + hours * 3600000).toISOString(),
    total: hours, ok: hours <= 6,
  })
  // 阈值口径必须同源：报表要带 slaHours，门禁拿它对账（2026-10-19 起；旧实现硬编码 6h 忽略报表）
  const write = (name, perVersion, extra = {}) => {
    const p = join(SLA, name)
    writeFileSync(p, JSON.stringify({ slaHours: 6, ...extra, perVersion }, null, 2))
    return p
  }
  const writeRaw = (name, payload) => { const p = join(SLA, name); writeFileSync(p, JSON.stringify(payload, null, 2)); return p }
  const old = '2026-10-01T00:00:00Z'
  const sla = (file, extra = []) => nodeAt(ROOT, 'scripts/dsh-sla-report.mjs', ['--check', file, ...extra])
  // 窗口语义：5 个版本都在 --since 口径内（t0 递增），前 2 个超标、后 3 个达标
  const winRows = () => [
    row('a', 99, '2026-10-19T01:00:00Z'), row('b', 88, '2026-10-19T02:00:00Z'),
    row('c', 1, '2026-10-19T03:00:00Z'), row('d', 2, '2026-10-19T04:00:00Z'), row('e', 3, '2026-10-19T05:00:00Z'),
  ]

  check('sla', '最近 3 个版本全达标 ⇒ exit 0', '0', String(sla(write('ok.json', [row('a', 1), row('b', 2), row('c', 3)])).status))
  const bad = write('bad.json', [row('a', 9), row('b', 8), row('c', 7)])
  let r = sla(bad)
  check('sla', '最近 3 个版本全超 6h ⇒ exit 1', '1', String(r.status))
  check('sla', '  且逐条点名超时版本（shell=时长）', true, /a=9\.00h/.test(r.out), { detail: r.out.trim().split('\n').slice(-1)[0] ?? '' })
  check('sla', '超标都在 --recent 3 窗口之外 ⇒ exit 0（窗口语义成立）', '0', String(sla(write('out.json', winRows())).status))
  check('sla', '首发早于 --since 的历史欠账只展示、不影响退出码 ⇒ exit 0', '0|true',
    (() => { const rr = sla(write('hist.json', [row('a', 99, old), row('b', 88, old)])); return `${rr.status}|${rr.out.includes('历史欠账')}` })(),
    { detail: '否则门禁在历史上恒红，等于没有门禁' })

  r = sla(write('nopv.json', undefined, { stats: ['已量出版本：0'] }))
  check('sla', 'perVersion 缺失 ⇒ exit 1（旧实现 0/0 ⇒ exit 0，假绿）', '1', String(r.status))
  check('sla', '  且说清"量不出任何版本不能算通过"', true, r.out.includes('perVersion 为空'))
  check('sla', 'perVersion 为空数组 ⇒ exit 1', '1', String(sla(write('empty.json', [])).status))
  check('sla', '报表文件不存在 ⇒ exit 1（读不到 = 没判断）', '1', String(sla(join(SLA, '没有这个文件.json')).status))
  check('sla', '报表是坏 JSON ⇒ exit 1（fail-closed）', '1', String(sla(writeRaw('broken.json', '{ perVersion: ')).status))
  check('sla', '--since 是垃圾日期 ⇒ exit 2（不留默认口径静默判）', '2', String(sla(bad, ['--since', 'garbage']).status))

  // 阈值口径同源（2026-10-19 修）：报表里的 slaHours 与脚本常量不一致 ⇒ 红，不静默择一
  check('sla', '报表 slaHours 缺失 ⇒ exit 1 + 明说"口径不可判定"（不拿硬编码 6h 静默替代）', '1|true',
    (() => { const rr = sla(writeRaw('nohours.json', { perVersion: [row('a', 1)] })); return `${rr.status}|${rr.out.includes('没有 slaHours')}` })())
  check('sla', '报表 slaHours=1（与门禁的 6h 漂移）⇒ exit 2 + 明说"口径漂移"', '2|true',
    (() => { const rr = sla(write('hours.json', [row('a', 1)], { slaHours: 1 })); return `${rr.status}|${rr.out.includes('口径漂移')}` })())

  // 窗口参数必须是正整数：0/非数字/负数都会静默改变门禁口径（2026-10-19 修）
  check('sla', '--recent 0 ⇒ exit 2（旧实现退化成"检查全部版本"）', '2', String(sla(write('out2.json', winRows()), ['--recent', '0']).status))
  check('sla', '--recent abc ⇒ exit 2（旧实现 NaN ⇒ 静默检查全部）', '2', String(sla(write('out3.json', winRows()), ['--recent', 'abc']).status))
  check('sla', '--recent -1 ⇒ exit 2（负数会丢行）', '2', String(sla(write('out4.json', winRows()), ['--recent', '-1']).status))
  check('sla', '--recent 2 是合法值（只查最近 2 个）⇒ exit 0', '0', String(sla(write('out5.json', winRows()), ['--recent', '2']).status))
}

// ══ 3. watch ═══════════════════════════════════════════════════════════════
function groupWatch() {
  console.log('\n── 3. dsh-watch：违约判定在门槛前后与坏输入下 fail-closed 吗 ──────')
  const W = join(TMP, 'watch')
  mkdirSync(W, { recursive: true })
  let seq = 0
  const packument = (tags, time = {}) => {
    seq += 1
    const p = join(W, `pack-${seq}.json`)
    writeFileSync(p, JSON.stringify({ 'dist-tags': tags, time }, null, 2))
    return p
  }
  const watch = ({ pack, args, out = true, env = {} }) => {
    const o = join(W, `w-${++seq}.json`)
    // 每次运行一个独立 --state-dir：脚本默认用 ~/.dsh（真实锁/PAUSE 所在），
    // 测试绝不能去碰真实目录（否则可能被本机 timer 的锁挤掉，或在真实 PAUSE 存在时静默零写）。
    const sd = join(W, 'sd', `run-${seq}`)
    const r = cmd(process.execPath, [join(ROOT, 'scripts/dsh-watch.mjs'), ...(out ? ['--dry-run', '--json', o] : []), '--state-dir', sd, ...args], {
      env: { PATH_WITH_STUBS: undefined, ...privateTmpEnv, PATH: PATH_WITH_STUBS, FAKE_PACKUMENT: pack, GH_BIN: GH_STUB, ...env },
    })
    return { ...r, report: jsonOf(o), outPath: o }
  }
  const P = (version, iso) => packument({ latest: version }, { [version]: iso })
  const TARGET = ['--force-target', '0.2.1']

  let r = watch({ pack: P('0.2.1', '2026-10-18T18:00:06Z'), args: [...TARGET, '--force-published', '2026-10-18T18:00:06Z', '--now', '2026-10-19T00:00:00Z', '--sla-hours', '6'] })
  check('watch', 'published 距今 5.998h（门槛 6h）⇒ breached=false', 'false', String(r.report?.breached))
  r = watch({ pack: P('0.2.1', '2026-10-18T17:59:54Z'), args: [...TARGET, '--force-published', '2026-10-18T17:59:54Z', '--now', '2026-10-19T00:00:00Z', '--sla-hours', '6'] })
  check('watch', 'published 距今 6.0017h ⇒ breached=true', 'true', String(r.report?.breached))
  // 演练注入面（审计曾登记"地板/registry 不可注入"）：--floor 与 --registry 必须真的进判定与报告
  r = watch({ pack: P('0.2.1', '2026-10-18T12:00:00Z'), args: ['--floor', '9.9.9', '--now', '2026-10-19T00:00:00Z'] })
  check('watch', '--floor 注入生效：地板比 latest 新 ⇒ target=null、"无需适配"、exit 0', 'null|true',
    `${r.report?.target === null ? 'null' : r.report?.target}|${r.stdout.includes('无需适配')}`)
  r = watch({ pack: P('0.2.1', '2026-10-18T12:00:00Z'), args: ['--floor', '0.2.1-rc.2', '--registry', 'http://127.0.0.1:9', '--now', '2026-10-19T00:00:00Z'] })
  check('watch', '--floor / --registry 注入进报告（演练可完全离线复刻）', '0.2.1-rc.2|http://127.0.0.1:9',
    `${r.report?.floor}|${r.report?.registry}`)

  r = watch({ pack: P('0.2.1', '2026-10-19T01:00:00Z'), args: [...TARGET, '--force-published', '2026-10-19T01:00:00Z', '--now', '2026-10-19T00:00:00Z'] })
  check('watch', 'published 在未来 1h ⇒ elapsed=-1、breached=false（未到点不违约）', '-1|false', `${r.report?.elapsed}|${r.report?.breached}`)

  r = watch({ pack: P('0.2.1', '2026-10-18T12:00:00Z'), args: [...TARGET, '--force-published', '2026-10-18T12:00:00Z', '--now', 'garbage'] })
  check('watch', '--now 是垃圾 ⇒ exit 2 + 明确拒绝（旧实现 NaN ⇒ 静默判"未违约"）', '2|true', `${r.status}|${r.stderr.includes('不是合法时间')}`)
  check('watch', '  且没有写出任何"未违约"的报告（拒绝而不是继续）', true, !existsSync(r.outPath))

  r = watch({ pack: P('0.2.1', '2026-10-18T12:00:00Z'), args: [...TARGET, '--force-published', 'not-a-date', '--now', '2026-10-19T00:00:00Z'] })
  check('watch', '--force-published 是垃圾 ⇒ 不静默放行：pubUnknown=true 且 breached=true（fail-closed）', 'true|true|?',
    `${r.report?.pubUnknown}|${r.report?.breached}|${r.report?.deadline}`)
  check('watch', '  （KNOWN_GAP 已修：期限未知时按违约处理，不再落进"永远不违约"）', 'true', String(r.report?.breached), { gap: false })

  const noTime = packument({ latest: '0.2.2' }, {})
  r = watch({ pack: noTime, args: ['--now', '2026-10-19T00:00:00Z'] })
  check('watch', 'target 在 npm packument 里没有发布时间戳 ⇒ deadline=\'?\' 且 breached=true（fail-closed）', '?|true',
    `${r.report?.deadline}|${r.report?.breached}`)

  r = watch({ pack: P('0.2.1', '2026-10-18T12:00:00Z'), args: [...TARGET, '--force-pre', '--force-published', '2026-10-18T12:00:00Z', '--now', '2026-10-19T00:00:00Z'] })
  check('watch', '24h best-effort 通道的正文门槛文案跟着实际门槛走（不再写死 6h）', 'true|true',
    `${r.stdout.includes('24h 截止')}|${!r.stdout.includes('6h 截止')}`)

  // rc → 正式版转正：0.2.1 在同号 rc 之后，必须被探到（P0，2026-10-19 修）
  r = watch({ pack: P('0.2.1', '2026-10-18T12:00:00Z'), args: ['--now', '2026-10-19T00:00:00Z'] })
  check('watch', 'latest 由同号 rc 转正（0.2.1 vs 地板 0.2.1-rc.2）⇒ target 落到 latest、走 6h 硬指标', '0.2.1|6',
    `${r.report?.target}|${r.report?.threshold}`)
  r = watch({ pack: packument({ latest: '0.1.9', next: '0.2.2-rc.1' }, { '0.2.2-rc.1': '2026-10-18T12:00:00Z' }), args: ['--now', '2026-10-19T00:00:00Z'] })
  check('watch', 'latest 落后、next 超前 ⇒ target=next、门槛 24h（best-effort 通道）', '0.2.2-rc.1|24',
    `${r.report?.target}|${r.report?.threshold}`)

  r = watch({ pack: P('0.2.1', '2026-10-18T12:00:00Z'), args: [...TARGET, '--force-published', '2026-10-18T12:00:00Z', '--now', '2026-10-19T00:00:00Z'] })
  check('watch', '违约时 --dry-run 的退出码仍是 0（KNOWN_GAP：设计如此，工作流上没有红色兜底信号）', '0|true', `${r.status}|${r.report?.breached}`, { gap: true })
  r = watch({ pack: P('0.2.1', '2026-10-18T12:00:00Z'), args: [...TARGET, '--sla-hours', 'abc', '--force-published', '2026-10-18T12:00:00Z'] })
  check('watch', '--sla-hours 是垃圾 ⇒ exit ≠ 0（fail-closed）', true, r.status !== 0)
  check('watch', '  但崩在 RangeError 且没有判据文案（KNOWN_GAP：错误信息不合格）', true, /RangeError/.test(r.out), { gap: true })

  r = watch({ pack: P('0.2.1', '2026-10-18T12:00:00Z'), args: [...TARGET], env: { FAKE_CURL_FAIL: '1' } })
  check('watch', '拿不到 npm packument ⇒ exit 1（真故障非零退出，不是"今天没新版本"）', '1|true', `${r.status}|${r.stderr.includes('拿不到 npm packument')}`)

  // 非 dry-run 的 issue 路径：用 gh 桩真跑（旧 harness 只跑到 dry-run，issue 那段从未被断言）
  const runIssue = (pkg, extra, issues = []) => {
    const issuesFile = join(W, `issues-${++seq}.json`)
    writeFileSync(issuesFile, JSON.stringify(issues))
    const calls = join(W, `gh-${seq}.log`)
    writeFileSync(calls, '')
    const r2 = watch({ pack: pkg, out: false, args: extra, env: { FAKE_GH_ISSUES: issuesFile, GH_CALLS: calls } })
    return { ...r2, calls: readFileSync(calls, 'utf8') }
  }
  const breachPkg = P('0.2.1', '2026-10-18T12:00:00Z')
  r = runIssue(breachPkg, [...TARGET, '--force-published', '2026-10-18T12:00:00Z'])
  check('watch', '违约 + 没有同名 issue ⇒ 真的调 gh issue create（label=sla-breach）', 'true|true',
    `${r.calls.includes('issue create')}|${r.calls.includes('--label sla-breach')}`)
  r = runIssue(breachPkg, [...TARGET, '--force-published', '2026-10-18T12:00:00Z'], [{ number: 42, title: '[SLA 未达标] dsh 0.2.1 已发布 10.0h（门槛 6h），地板仍停在 0.2.1-rc.2' }])
  check('watch', '已有同 target 的 issue ⇒ 只评论（#42），不新建', 'true|false',
    `${r.calls.includes('issue comment 42')}|${r.calls.includes('issue create')}`)
  r = runIssue(breachPkg, [...TARGET, '--force-published', '2026-10-18T12:00:00Z'], [{ number: 7, title: '[dsh-watch] dsh 0.2.1-rc.2 比地板新' }])
  check('watch', '去重按版本词边界：target=0.2.1 不匹配已存在的 0.2.1-rc.2 issue ⇒ 新建（旧实现 contains() 会误合并）', 'true',
    String(r.calls.includes('issue create')))

  // ══ 2026-10-24 事故 #201–#217 的回归面 ════════════════════════════════════
  // A1 确定性去重（不依赖 label）：run(); run() ⇒ open 数量不增加；冷启动只建 1 条；
  //   事故同构（label 从未落地 + edit 403）下仍不许再建。
  // A2 单写者（flock 真并发）/ PAUSE 零写。 A10 对账：收敛成功、失败只出清单不报假成功。
  // 这些断言用**有状态** gh 桩（GH_STATE_STUB）+ 独立 state-dir；回放固定列表会变成恒真断言。
  const S = join(W, 'idem')
  mkdirSync(S, { recursive: true })
  let idemSeq = 0
  const sleepFor = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
  const waitFor = (fn, timeoutMs) => { const end = Date.now() + timeoutMs; while (Date.now() < end) { if (fn()) return true; sleepFor(25) } return false }
  const callsFor = (stateFile) => stateFile.replace(/\.json$/, '.calls')
  const seedIssue = (number, { title, body = '', labels = [], assignees = [], createdAt = null } = {}) => ({
    number, title, body,
    labels: labels.map((name) => ({ name })),
    assignees: assignees.map((login) => ({ login })),
    createdAt: createdAt ?? new Date(Date.UTC(2026, 9, 23, 8, 0, number - 200)).toISOString(),
    state: 'open', comments: [],
  })
  const mkState = (name, issues = []) => {
    const p = join(S, `${name}-${++idemSeq}.json`)
    writeFileSync(p, JSON.stringify(issues, null, 2))
    writeFileSync(callsFor(p), '')
    return p
  }
  const readCalls = (stateFile) => readFileSync(callsFor(stateFile), 'utf8')
  const countCalls = (stateFile, re) => readCalls(stateFile).split('\n').filter((l) => re.test(l)).length
  const openCount = (stateFile) => JSON.parse(readFileSync(stateFile, 'utf8')).filter((i) => i.state === 'open').length
  const PACK_IDEM = packument({ latest: '0.2.1-rc.3' }, { '0.2.1-rc.3': '2026-10-23T08:00:00Z' })
  const idemArgs = (stateDir, extra = []) => [join(ROOT, 'scripts/dsh-watch.mjs'),
    '--floor', '0.2.1-rc.2', '--force-target', '0.2.1-rc.3', '--force-published', '2026-10-23T08:00:00Z',
    '--now', '2026-10-24T00:00:00Z', '--state-dir', stateDir, ...extra]
  const idemEnv = (stateFile, extra = {}) => ({
    PATH_WITH_STUBS: undefined, ...privateTmpEnv, PATH: PATH_WITH_STUBS, FAKE_PACKUMENT: PACK_IDEM,
    GH_BIN: GH_STATE_STUB, FAKE_GH_STATE: stateFile, GH_CALLS: callsFor(stateFile), ...extra,
  })
  const runIdem = (stateFile, { env = {}, extra = [], json = false, stateDir = null } = {}) => {
    const sd = stateDir ?? join(S, `sd-${++idemSeq}`)
    const o = json ? join(W, `idem-${++seq}.json`) : null
    const r = cmd(process.execPath, idemArgs(sd, [...(o ? ['--json', o] : []), ...extra]), { env: idemEnv(stateFile, env) })
    return { ...r, report: o ? jsonOf(o) : null, sid: sd }
  }

  // ① 空状态冷启动：没有任何 open issue、也没有 label ⇒ 只创建 1 条
  let st = mkState('cold')
  let ri = runIdem(st)
  check('watch', '幂等①冷启动：桩里没有任何 issue / 没有 label ⇒ 只创建 1 条', '1|1|0',
    `${countCalls(st, /^issue create/)}|${openCount(st)}|${ri.status}`)

  // ② 幂等性质（核心）：run(); run() ⇒ open issue 数量不增加 —— 第二次必须按标题命中同一条
  ri = runIdem(st)
  check('watch', '幂等②run(); run() ⇒ open issue 数量不增加（第二次按标题命中同一条、只 edit、不新建）', '1|1|0|true',
    `${countCalls(st, /^issue create/)}|${openCount(st)}|${ri.status}|${!ri.stdout.includes('⇒ 新建') && ri.stdout.includes('已静默更新')}`)

  // ③ 事故同构：create 成功但 label/assignee 从未落地（且 edit/comment 403）
  //    旧实现：去重按 label 过滤 ⇒ 查到 0 条 ⇒ 每 10 分钟再建一条（#201–#216 共 16 条）。
  st = mkState('incident')
  ri = runIdem(st, { env: { FAKE_GH_DROP_LABELS: '1', FAKE_GH_FAIL: 'edit,comment' } })
  check('watch', '幂等③事故同构：第一轮 create（label/assignee 丢失、写后复核失败）', 'true|true',
    `${ri.stdout.includes('写后复核失败')}|${ri.stdout.includes('gh issue edit')}`)
  ri = runIdem(st, { env: { FAKE_GH_DROP_LABELS: '1', FAKE_GH_FAIL: 'edit,comment' } })
  check('watch', '  第二轮仍按标题命中同一条 ⇒ 累计只 create 1 次、open 仍是 1（旧实现累计 2 条）', '1|1|1',
    `${countCalls(st, /^issue create/)}|${openCount(st)}|${ri.status}`)

  // ④ 并发：真起两个进程 ⇒ flock 保证只有一个执行，另一个 skipped by lock 且零 gh 调用
  st = mkState('concurrent')
  const sdConc = join(S, 'sd-conc')
  const outA = join(S, 'conc-A.out')
  const callsA = join(S, 'conc-A.calls')
  const callsB = join(S, 'conc-B.calls')
  writeFileSync(outA, ''); writeFileSync(callsA, ''); writeFileSync(callsB, '')
  // 主线程用 Atomics.wait 同步等待时**不会**处理 'exit' 事件 ⇒ child.exitCode 永远是 null。
  // 所以用一个极小的 wrapper 进程把退出码落到文件里，测试只等文件出现（不依赖事件循环）。
  const wrapper = join(S, 'run-and-mark.mjs')
  writeFileSync(wrapper, "import { spawnSync } from 'node:child_process'\nimport { writeFileSync } from 'node:fs'\n"
    + "const [marker, ...rest] = process.argv.slice(2)\n"
    + "const r = spawnSync(process.execPath, rest, { stdio: 'inherit' })\n"
    + 'writeFileSync(marker, String(r.status))\n')
  const markerA = join(S, 'conc-A.exit')
  const fdA = openSync(outA, 'a')
  const childA = spawn(process.execPath, [wrapper, markerA, ...idemArgs(sdConc)], {
    cwd: ROOT,
    stdio: ['ignore', fdA, fdA],
    env: { ...process.env, ...idemEnv(st, { FAKE_GH_SLEEP_MS: '300' }), GH_CALLS: callsA },
  })
  const gotLock = waitFor(() => readFileSync(outA, 'utf8').includes('已获取本机独占锁'), 15000)
  const rB = cmd(process.execPath, idemArgs(sdConc), { env: idemEnv(st, { GH_CALLS: callsB }) })
  const aDone = waitFor(() => existsSync(markerA), 30000)
  if (!aDone) childA.kill('SIGKILL')
  closeSync(fdA)
  const aExit = aDone ? Number(readFileSync(markerA, 'utf8')) : null
  const outAtext = readFileSync(outA, 'utf8')
  check('watch', '并发①两个进程同时跑 ⇒ 先拿到 flock 的执行；另一个打印 skipped by lock 且零 gh 调用', 'true|true|true|true',
    `${gotLock}|${rB.stdout.includes('skipped by lock')}|${rB.status === 0}|${readFileSync(callsB, 'utf8').trim() === ''}`)
  check('watch', '并发②两个进程合计只创建 1 条（open = 1），持锁进程正常走完（exit 0）', '1|1|true',
    `${readFileSync(callsA, 'utf8').split('\n').filter((l) => l.startsWith('issue create')).length}|${openCount(st)}|${outAtext.includes('已获取本机独占锁') && aExit === 0}`)

  // ⑤ PAUSE：已有一条需要更新的 open issue ⇒ 没有 PAUSE 必然有 edit；有 PAUSE 必须零写
  st = mkState('paused', [seedIssue(42, {
    title: '[SLA 未达标] dsh 0.2.1-rc.3 已发布 10.0h（门槛 6h），地板仍停在 0.2.1-rc.2',
    body: '@karoc（负责人）\n\n<!-- dsh-watch-state: target=0.2.1-rc.3 breached=false -->',
  })])
  const sdPause = join(S, 'sd-pause')
  mkdirSync(sdPause, { recursive: true })
  writeFileSync(join(sdPause, 'PAUSE'), '')
  ri = runIdem(st, { stateDir: sdPause })
  check('watch', 'PAUSE：~/.dsh/PAUSE 存在 ⇒ 零写操作（create/edit/comment/close 全 0）、状态不变、日志写明 paused by',
    '0|1|0|true', `${countCalls(st, /^issue (create|edit|comment|close)/)}|${openCount(st)}|${ri.status}|${ri.stdout.includes('paused by')}`)
  check('watch', '  ⇒ 且只读探测继续、明说"本应更新 #42"（没有把 PAUSE 当成故障）', 'true',
    String(ri.stdout.includes('[paused]') && ri.stdout.includes('更新 #42')))

  // ⑥ 对账（A10）：同版本 3 条 ⇒ 保留带 label/assignee 的规范单、其余评论后关闭
  const dupTitle = '[dsh-watch][best-effort 24h（预发布通道）] dsh 0.2.1-rc.3 比地板 0.2.1-rc.2 新'
  const dupBody = '@karoc（负责人）\n\n<!-- dsh-watch-state: target=0.2.1-rc.3 breached=false -->'
  st = mkState('dup-ok', [
    seedIssue(201, { title: dupTitle, body: dupBody }),
    seedIssue(202, { title: dupTitle, body: dupBody }),
    seedIssue(203, { title: dupTitle, body: dupBody, labels: ['dsh-upgrade'], assignees: ['karoc'] }),
  ])
  ri = runIdem(st, { env: { FAKE_GH_FAIL: 'edit' } })
  check('watch', '对账①同版本 3 条 ⇒ 保留 #203（唯一带 label/assignee 的规范单），其余评论后关闭', 'true|true|2|1',
    `${ri.stdout.includes('保留 #203')}|${/issue comment 201 --body 重复于 #203（同版本跟踪单），由 autopilot 对账关闭/.test(readCalls(st))}|${countCalls(st, /^issue close/)}|${openCount(st)}`)
  check('watch', '  ⇒ 关掉的重复单带统一评论、且 after-对账列表只剩 1 条', 'true|true',
    `${JSON.parse(readFileSync(st, 'utf8')).find((i) => i.number === 201).state === 'closed'}|${ri.stdout.includes('对账完成')}`)

  // ⑦ 对账失败（权限 403）：只出"待人工关闭"清单，**不报假成功**
  st = mkState('dup-fail', [
    seedIssue(201, { title: dupTitle, body: dupBody }),
    seedIssue(202, { title: dupTitle, body: dupBody }),
    seedIssue(203, { title: dupTitle, body: dupBody, labels: ['dsh-upgrade'], assignees: ['karoc'] }),
  ])
  ri = runIdem(st, { env: { FAKE_GH_FAIL: 'close,comment,edit' } })
  check('watch', '对账②close/comment 403 ⇒ 明确报"仍有 1 组重复" + 待人工清单（含可复制命令），不打印"对账完成"',
    'true|true|true|true', `${ri.out.includes('对账后仍有 1 组重复')}|${ri.out.includes('待人工关闭')}`
    + `|${ri.out.includes('issue close 201 --reason')}|${!ri.out.includes('对账完成')}`)
  check('watch', '  ⇒ 三条 issue 仍全部 open（没有假装关掉），且本进程以非零退出如实报错', '3|1',
    `${openCount(st)}|${ri.status}`)

  // ⑧ --dry-run 的只读对账报告（真实仓库上跑之前先在这里钉住）：17 条重复 ⇒ 保留 #217 + 16 条命令、零写入
  st = mkState('dry', Array.from({ length: 17 }, (_, k) => seedIssue(201 + k, {
    title: dupTitle, body: dupBody,
    labels: k === 16 ? ['dsh-upgrade', 'priority:high'] : [], assignees: k === 16 ? ['karoc'] : [],
  })))
  ri = runIdem(st, { extra: ['--dry-run'], json: true })
  check('watch', '对账③--dry-run：17 条重复 ⇒ 保留 #217、输出 16 条关闭命令，零写入且 issue 数不变', 'true|true|0|17',
    `${ri.stdout.includes('保留 #217')}|${ri.stdout.includes('issue close 201 --reason')}|${countCalls(st, /^issue (create|edit|comment|close)/)}|${openCount(st)}`)
  check('watch', '  ⇒ 去重判定也落在规范单上（命中 #217，而不是即将被关掉的 #201）', '217|true',
    `${ri.report?.dedupe?.matched}|${ri.report?.reconcile?.plans?.length === 1}`)
}

// ══ 4. adapt ═══════════════════════════════════════════════════════════════
/** 临时仓库副本：git archive HEAD（只读操作）+ node_modules 软链 + 本套件自身 + 短 test 链。 */
function makeRepoCopy(dest) {
  mkdirSync(dest, { recursive: true })
  // 拷**工作树**（不是 `git archive HEAD`）：副本要测的是"你手上这份代码"——本地改了 dsh-*.mjs 还没提交时，
  // HEAD 版会让本套件对着旧实现判分（实测踩过：adapt 的 --dry-run 演练改动因此在副本里看不见）。
  // 同时也让"副本里再造副本"（变异自证的子跑）在没有 .git 时照样成立。
  const r = spawnSync('bash', ['-c',
    'set -euo pipefail\ntar -cf - --exclude=./.git --exclude=./node_modules --exclude=./src-tauri/target --exclude=./.tmp-investigate --exclude=./dist . | tar -xf - -C "$1"',
    'bash', dest], { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`拷贝工作树到副本失败：${(r.stderr ?? '').trim()}`)
  try { symlinkSync(join(ROOT, 'node_modules'), join(dest, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir') } catch { /* 已有就算了 */ }
  mkdirSync(join(dest, 'scripts'), { recursive: true })
  cpSync(SELF, join(dest, 'scripts/test-automation-gates.mjs'))
  // 第 7 步会按 package.json 的 test 链逐条跑 —— 必须换短链：① 否则递归跑本套件；
  // ② 顺便复现"链里有解析不出来的 npm 脚本"这一格（审计 #34 的假跳过）。
  const pkgPath = join(dest, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.scripts.test = 'node scripts/test-doc-links.mjs && npm run test:does-not-exist && cargo test --quiet'
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  return dest
}

function groupDoctor() {
  console.log('\n── 3b. dsh-doctor canary：凭据能力探测自测必须绿（A3/A11）────────────')
  // 为什么把 doctor 的自测拉进门禁：A3 的结论是"GitHub 没有模拟写接口，唯一判据是 canary 写"，
  // 而"403 ⇒ 退出码非零"正是那条判据的**唯一出口**。它此前只有 `npm run test:doctor` 这一条
  // 靠人记得跑的入口，且不在 `npm test` 链上 —— 判据坏了没人知道。
  // Windows 上自测自己 SKIP（需要 shebang 可执行的 POSIX gh 桩）⇒ 这里如实登记为覆盖缺口。
  const r = nodeAt(ROOT, 'scripts/dsh-doctor.mjs', ['--self-test'], { env: privateTmpEnv })
  if (process.platform === 'win32') {
    skip('doctor', 'dsh-doctor --self-test 全绿 + 403 ⇒ 非零退出', 'Windows 上该自测自身 SKIP（POSIX shebang 桩）—— 覆盖缺口，不是通过')
    return
  }
  const m = /自测结果：(\d+)\/(\d+) 通过，(\d+) 失败/.exec(r.out)
  const detail = r.out.split('\n').filter((l) => l.startsWith('  FAIL')).slice(0, 3).join(' | ') || r.out.split('\n').slice(-2).join(' | ')
  check('doctor', '自测跑完并给出 通过/失败 计数（没有计数 = 没有判断）', 'true', String(Boolean(m)), { detail })
  const pass = m ? Number(m[1]) : 0
  const total = m ? Number(m[2]) : 0
  const failed = m ? Number(m[3]) : -1
  check('doctor', '自测 0 失败', '0', String(failed), { detail })
  check('doctor', '断言数 ≥ 40 且 通过 == 总数（套件没被删空/没被跳过）', 'true', String(total >= 40 && pass === total))
  // 断言的是"自测真的跑了 403 那一段"—— 自测对每条用例打印 `ok <用例名>`，用例名就是判据本身。
  // （不要把"矩阵输出里的错误文案"当依据：那段只在失败时才打印 detail。）
  check('doctor', '覆盖了 403 场景：既有"该项标 ✗"也有"403 之后没有任何写调用"', 'true',
    String(/该项标 ✗/.test(r.out) && /如实打印 403 错误/.test(r.out) && /403 之后没有任何写调用/.test(r.out)))
  check('doctor', '自测退出码 0（全绿）', '0', String(r.status), { detail })
}

function groupAdapt() {
  console.log('\n── 4. dsh-adapt：任一步失败立即停（含"探针没出报告"）──────────────')
  const R = ensureRuntimes()
  const floor = R.floor
  const copy = makeRepoCopy(join(TMP, 'copy'))
  const adapt = (root, args, opts = {}) => nodeAt(root, 'scripts/dsh-adapt.mjs', args, { ...opts, env: { ...privateTmpEnv, ...(opts.env ?? {}) } })

  let r = adapt(copy, ['--version', floor, '--runtime', join(TMP, 'rt/不存在')])
  check('adapt', 'runtime 目录不存在 ⇒ 停在第 1 步 + exit 1', '1|true', `${r.status}|${r.stdout.includes('✗ 1 runtime')}`)
  r = adapt(copy, ['--version', '9.9.9', '--runtime', R.good])
  check('adapt', '--version 与 runtime 里装的版本不符 ⇒ 停在第 1 步 + exit 1', '1|true', `${r.status}|${r.stdout.includes('✗ 1 runtime')}`)
  r = adapt(copy, ['--version', floor, '--runtime', R.crash])
  check('adapt', '夹具重采门禁崩（bin.js exit 3）⇒ 停在第 4 步 + exit 1', '1|true', `${r.status}|${r.stdout.includes('✗ 4 patch')}`)
  r = adapt(copy, ['--version', floor, '--runtime', R.seam])
  check('adapt', '探针判 RED（缺 seam）⇒ 停在第 6 步 + exit 1', '1|true', `${r.status}|${r.stdout.includes('✗ 6 探针')}`)
  r = adapt(copy, ['--version', floor, '--runtime', R.nat])
  check('adapt', '探针判 YELLOW 且没有 --allow-yellow ⇒ 停在第 6 步 + exit 1', '1|true', `${r.status}|${r.stdout.includes('✗ 6 探针')}`)

  // 金路径：探针 GREEN + 链里的非 node / 解析不出来的条目按现状处理（下一条断言正是它的缺口）
  r = adapt(copy, ['--version', floor, '--runtime', R.good, '--allow-yellow'])
  check('adapt', '探针 GREEN + 全链跑通 ⇒ exit 0（金路径真的能走完，不是只会红）', '0', String(r.status), { detail: (r.stdout.match(/7 全量门禁.*/) ?? [''])[0] })
  check('adapt', '  链里解析不出来的 npm 脚本被算成"跳过（非 node 命令，CI 覆盖）"（KNOWN_GAP：解析失败 ≠ 非 node）', 'true',
    r.stdout.includes('跳过 2 项非 node 命令'), { gap: true })
  r = adapt(copy, ['--version', floor, '--runtime', R.good, '--allow-yellow', '--strict-chain'])
  check('adapt', '--strict-chain 把"本机跳过"算失败 ⇒ exit 1 + 明说覆盖缺口不算通过', '1|true',
    `${r.status}|${r.stdout.includes('覆盖缺口不算通过')}`)

  // 审计定性 P1：探针进程崩/不写报告时，整轮**必须**停（旧实现 exit 0 = 全链路假绿）
  const crashCopy = makeRepoCopy(join(TMP, 'copy-probe-crash'))
  writeFileSync(join(crashCopy, 'scripts/dsh-compat-probe.mjs'), 'process.exit(7)\n')
  r = adapt(crashCopy, ['--version', floor, '--runtime', R.good, '--allow-yellow'])
  check('adapt', '探针崩/不产出报告 ⇒ 停在第 6 步 + exit 1（不得读成 (no report) 再放行）', '1|true',
    `${r.status}|${r.stdout.includes('探针没有产出报告')}`)

  // canary：三标记分居两个日志文件，只认"检查开始之后新写入的行"
  if (FAST) {
    skip('adapt', '--canary 三条（缺日志 / 只有旧标记 / 启动后新标记）', '--fast：跳过等待型用例')
  } else {
    const logs = join(TMP, 'canary')
    mkdirSync(logs, { recursive: true })
    const sess = join(logs, 'session.log')
    const mgr = join(logs, 'manager.log')
    r = adapt(copy, ['--version', floor, '--runtime', R.good, '--allow-yellow', '--canary',
      '--dev-log', join(logs, '没有这个.log'), '--manager-log', join(logs, '也没有.log'), '--canary-timeout', '1'])
    check('adapt', '--canary 日志文件不存在 ⇒ 停在第 8 步 + exit 1，且指名两个日志的角色', '1|true',
      `${r.status}|${r.stdout.includes('找不到日志文件') && r.stdout.includes('session 日志') && r.stdout.includes('manager 日志')}`)

    const SESSION_MARKERS = 'client/log chrome ready\nclient-ready (http)\n'
    const MANAGER_MARKERS = 'preinstalled bundles:\n'
    writeFileSync(sess, SESSION_MARKERS)
    writeFileSync(mgr, MANAGER_MARKERS)
    r = adapt(copy, ['--version', floor, '--runtime', R.good, '--allow-yellow', '--canary',
      '--dev-log', sess, '--manager-log', mgr, '--canary-timeout', '1'])
    check('adapt', '--canary 日志里早有旧标记、启动后没有新行 ⇒ exit 1（只认新增行）', '1|true',
      `${r.status}|${r.stdout.includes('没看到这些标记')}`)

    writeFileSync(sess, '')
    writeFileSync(mgr, '')
    const writer = join(logs, 'writer.mjs')
    writeFileSync(writer, `import { appendFileSync } from 'node:fs'\n`
      + `setTimeout(() => {\n`
      + `  appendFileSync(${JSON.stringify(sess)}, ${JSON.stringify(SESSION_MARKERS)})\n`
      + `  appendFileSync(${JSON.stringify(mgr)}, ${JSON.stringify(MANAGER_MARKERS)})\n`
      + `}, 1200)\n`)
    const child = spawn(process.execPath, [writer], { stdio: 'ignore', detached: true })
    child.unref()
    r = adapt(copy, ['--version', floor, '--runtime', R.good, '--allow-yellow', '--canary',
      '--dev-log', sess, '--manager-log', mgr, '--canary-timeout', '12'])
    check('adapt', '--canary 启动后两个日志都写入新标记 ⇒ 第 8 步通过 + exit 0', '0|true',
      `${r.status}|${r.stdout.includes('三标记齐全')}`)
  }

  // --dry-run 不落盘：把副本的地板改旧，dry-run 走一遍（会在第 6 步被探针挡下，见 README 的已知限制）
  const dryCopy = makeRepoCopy(join(TMP, 'copy-dry'))
  for (const rel of ['scripts/server-manager.mjs', 'src-tauri/resources/manager/server-manager.mjs']) {
    const p = join(dryCopy, rel)
    writeFileSync(p, readFileSync(p, 'utf8').replace(/MIN_DSH_VERSION = '[^']+'/, "MIN_DSH_VERSION = '0.2.1-alpha.3'"))
  }
  const before = {
    readme: readFileSync(join(dryCopy, 'README.md'), 'utf8'),
    src: readFileSync(join(dryCopy, 'scripts/server-manager.mjs'), 'utf8'),
    fixture: readFileSync(join(dryCopy, 'scripts/fixtures/dsh-web-app-patch-ids.json'), 'utf8'),
  }
  r = adapt(dryCopy, ['--version', floor, '--runtime', R.good, '--dry-run', '--allow-yellow'])
  const after = {
    readme: readFileSync(join(dryCopy, 'README.md'), 'utf8'),
    src: readFileSync(join(dryCopy, 'scripts/server-manager.mjs'), 'utf8'),
    fixture: readFileSync(join(dryCopy, 'scripts/fixtures/dsh-web-app-patch-ids.json'), 'utf8'),
  }
  check('adapt', '--dry-run 一个字节都不写（README / 地板 / 夹具三处逐字比对）', 'true|true|true',
    `${before.readme === after.readme}|${before.src === after.src}|${before.fixture === after.fixture}`)
  check('adapt', '  且目标版本 ≠ 现状时 dry-run 走"演练假设"（--assume-floor/--assume-fixture）⇒ exit 0'
    + '（旧实现必然停在第 6 步 ⇒ 假演练）', '0', String(r.status), { detail: (r.stdout.match(/✗ \d \S+/) ?? [''])[0] })
  check('adapt', '  但必须把"按假设值判定、不代表真实一致"印出来（不许静默冒充真实校验）', 'true',
    String(r.stdout.includes('演练模式') && r.stdout.includes('不代表')))
}

// ══ 5. drift（逐字抽取工作流的一段，在临时目录里跑）═══════════════════════
/** 从 preinstalled-sync.yml 里抽出 `id: drift` 那一步的 run 脚本（按 YAML 缩进切块）。结构变了就判失败，不静默跳过。 */
function extractDriftStep() {
  if (!existsSync(DRIFT_WORKFLOW)) return null
  const lines = readFileSync(DRIFT_WORKFLOW, 'utf8').split('\n')
  const at = lines.findIndex((l) => /^\s*id:\s*drift\s*$/.test(l))
  if (at < 0) return null
  let i = at
  while (i < lines.length && !/^\s*run:\s*\|/.test(lines[i])) i += 1
  if (i >= lines.length) return null
  const indent = lines[i].match(/^\s*/)[0].length
  const body = []
  for (let j = i + 1; j < lines.length; j += 1) {
    const l = lines[j]
    if (l.trim() === '') { body.push(''); continue }
    if (l.match(/^\s*/)[0].length <= indent) break
    body.push(l.slice(indent + 2))
  }
  return body.length ? body.join('\n') : null
}

function groupDrift() {
  console.log('\n── 5. preinstalled-sync 漂移检测：坏输入不得变成"无漂移" ──────────')
  const driftSrc = extractDriftStep()
  if (!driftSrc) {
    nFail += 1
    failures.push('[drift] 抽不到漂移检测段：.github/workflows/preinstalled-sync.yml 结构变了（请在套件里更新抽取逻辑，不要静默跳过）')
    console.log('  FAIL [drift] 抽不到漂移检测段 —— 工作流结构变了；请在套件里更新抽取逻辑（不要静默跳过）')
    return
  }
  check('drift', '前置：能从工作流里逐字抽出"检测漂移"段（id: drift + run: |）', true,
    driftSrc.includes('drifted=') && driftSrc.includes('dist-tags.latest'))
  if (cmd('bash', ['-c', 'printf "1.0.0\\n1.0.1\\n" | sort -V > /dev/null']).status !== 0) {
    skip('drift', '漂移检测段全部用例', '本机缺 bash 或 GNU sort -V（CI 的 ubuntu runner 上会真跑）')
    return
  }

  const scriptPath = join(TMP, 'drift-step.sh')
  writeFileSync(scriptPath, driftSrc)
  const driftRoot = join(TMP, 'drift')
  const outFile = join(TMP, 'drift.out')
  const sumFile = join(TMP, 'drift.summary')
  const mapFile = join(TMP, 'npm-map.json')
  const PKGS = [
    { dir: 'dsh-kanban', name: '@deepseek-ai/dsh-kanban', version: '0.2.10' },
    { dir: 'dsh-model-reasoning', name: 'dsh-model-reasoning', version: '0.2.6' },
    { dir: 'dsh-smoothly-opencode-session', name: '@karoc/dsh-smoothly-opencode-session', version: '0.2.1' },
    { dir: 'dsh-turn-navigator', name: 'dsh-turn-navigator', version: '0.4.8' },
  ]
  const mkTree = (entries = PKGS, { root = true } = {}) => {
    rmSync(join(driftRoot, 'src-tauri'), { recursive: true, force: true })
    if (!root) return
    for (const e of entries) {
      const dir = join(driftRoot, 'src-tauri/resources/preinstalled', e.dir)
      mkdirSync(dir, { recursive: true })
      if (e.noPkg) continue
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: e.name, version: e.version }))
    }
  }
  const runDrift = (map) => {
    writeFileSync(mapFile, JSON.stringify(map))
    writeFileSync(outFile, '')
    writeFileSync(sumFile, '')
    const r = cmd('bash', [scriptPath], {
      cwd: driftRoot,
      env: { PATH: PATH_WITH_STUBS, FAKE_NPM_MAP: mapFile, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: sumFile },
    })
    const out = readFileSync(outFile, 'utf8')
    return { ...r, outputs: out, drifted: (/^drifted=(.*)$/m.exec(out) ?? [])[1] ?? null, summary: readFileSync(sumFile, 'utf8') }
  }
  const equalMap = Object.fromEntries(PKGS.map((p) => [p.name, p.version]))

  mkTree()
  let r = runDrift(equalMap)
  check('drift', '四个包本地 == npm latest ⇒ exit 0、drifted 为空（不制造假漂移）', '0|', `${r.status}|${r.drifted ?? '(无 drifted 行)'}`)
  check('drift', '  summary 写"漂移：无"', true, r.summary.includes('漂移（会同步）：**无**'))

  r = runDrift({ ...equalMap, 'dsh-turn-navigator': '0.5.0' })
  check('drift', '本地 < npm latest ⇒ drifted 指名该包（name@latest）', '0|dsh-turn-navigator@0.5.0', `${r.status}|${r.drifted}`)
  r = runDrift({ ...equalMap, 'dsh-turn-navigator': '0.0.1' })
  check('drift', '本地 > npm latest ⇒ **不**同步（旧实现会降级同步）：drifted 空 + summary 记"本地领先"', '0|true',
    `${r.status}|${(r.drifted === '' && r.summary.includes('本地领先（不动）：**dsh-turn-navigator@0.4.8**'))}`)

  const KANBAN = '@deepseek-ai/dsh-kanban'
  r = runDrift({ ...equalMap, [KANBAN]: '@fail' })
  check('drift', 'npm 查询失败 ⇒ exit 1（旧实现折成 `?` ⇒ 制造假漂移且中断整批）', '1', String(r.status))
  check('drift', '  且明说查询失败、不写 drifted 到 GITHUB_OUTPUT（绝不进开 PR 路径）', 'true|true',
    `${r.out.includes('::error::')}|${r.drifted === null}`)
  r = runDrift({ ...equalMap, [KANBAN]: '@empty' })
  check('drift', 'npm 静默返回空 ⇒ exit 1（空 ≠ 无漂移）', '1', String(r.status))
  r = runDrift({ ...equalMap, [KANBAN]: 'npm WARN deprecated 这是垃圾文本' })
  check('drift', 'npm 返回值不是版本号 ⇒ exit 1（垃圾文本不得当版本比较）', '1|true',
    `${r.status}|${r.out.includes('不是版本号')}`)
  r = runDrift({ ...equalMap, [KANBAN]: '@fail', 'dsh-turn-navigator': '0.5.0' })
  check('drift', '有失败 + 有真漂移 ⇒ 仍 exit 1 且不输出 drifted（一次坏查询不允许"部分开 PR"）', '1|true',
    `${r.status}|${r.drifted === null}`)

  mkTree(PKGS, { root: false })
  r = runDrift(equalMap)
  check('drift', '预装目录根本不存在 ⇒ exit 1（旧实现静默"漂移：无" ⇒ 永远不开 PR）', '1|true',
    `${r.status}|${r.out.includes('没有任何预装目录')}`)
  mkTree([])
  r = runDrift(equalMap)
  check('drift', '预装目录存在但没有子目录 ⇒ exit 1', '1', String(r.status))
  mkTree(PKGS.map((p) => (p.dir === 'dsh-kanban' ? { dir: p.dir, noPkg: true } : p)))
  r = runDrift(equalMap)
  check('drift', '某个包目录缺 package.json ⇒ exit 1（旧实现静默 continue）', '1|true',
    `${r.status}|${r.out.includes('缺少 package.json')}`)

  mkTree()
  r = runDrift({ ...equalMap, [KANBAN]: '9.9.9', 'dsh-turn-navigator': '0.5.0' })
  check('drift', '多个包漂移 ⇒ drifted 恰好列出这两个（不吞、不多）', '@deepseek-ai/dsh-kanban@9.9.9 dsh-turn-navigator@0.5.0', String(r.drifted))
}

// ══ 6. mutation：本套件自己也要被证明会红 ═════════════════════════════════
const MUTATIONS = [
  {
    group: 'probe',
    name: '探针的 seam 判据不再报红（inBaseline 分支恒不成立）',
    file: 'scripts/dsh-compat-probe.mjs',
    from: '} else if (seam.inBaseline) {',
    to: '} else if (false) {',
    expect: 'seam `settings.plugins.tab` 消失 ⇒ exit 1',
  },
  {
    group: 'adapt',
    name: 'dsh:adapt 第 6 步对"探针 RED"不再停下（red 也当通过）',
    file: 'scripts/dsh-adapt.mjs',
    from: "if (verdict === 'red') abort(",
    to: 'if (false) abort(',
    expect: '探针判 RED（缺 seam）⇒ 停在第 6 步',
  },
  {
    group: 'adapt',
    name: 'dsh:adapt 第 6 步重新把"探针没出报告"当成通过',
    file: 'scripts/dsh-adapt.mjs',
    from: 'if (!existsSync(report)) {',
    to: 'if (false) {',
    expect: '探针崩/不产出报告 ⇒ 停在第 6 步',
  },
  {
    group: 'sla',
    name: 'SLA --check 重新把"没有数据"判成达标',
    file: 'scripts/dsh-sla-report.mjs',
    from: 'if (perVersion.length === 0) {',
    to: 'if (false) {',
    expect: 'perVersion 缺失 ⇒ exit 1',
  },
  {
    group: 'drift',
    name: '漂移检测重新把"预装目录不存在"当成"无漂移"',
    file: '.github/workflows/preinstalled-sync.yml',
    from: 'if [ "$dirs" -eq 0 ]; then',
    to: 'if false; then',
    expect: '预装目录根本不存在 ⇒ exit 1',
  },
  {
    group: 'doctor',
    // doctor 自测在 Windows 上自己 SKIP ⇒ 这条变异显式只在 POSIX 上跑（不是静默跳过）。
    platform: 'posix',
    name: 'dsh-doctor 在"必需能力缺失（403）"时仍以 0 退出（canary 判据不再阻断）',
    file: 'scripts/dsh-doctor.mjs',
    from: ': missing.length ? 1 : 0',
    to: ': 0',
    expect: 'exit 非零',
  },
]

function groupMutation() {
  console.log('\n── 6. 变异自证：把判据改坏 ⇒ 本套件必须变红（临时副本上做，仓库只读）──')
  if (NO_MUTATION) {
    skip('mutation', `全部 ${MUTATIONS.length} 条变异自证`, '--no-mutation / 子跑（DSH_GATES_CHILD=1）')
    return
  }
  MUTATIONS.forEach((m, i) => {
    if (m.platform && !((m.platform === 'posix' && process.platform !== 'win32') || m.platform === process.platform)) {
      skip('mutation', `${m.group}：${m.name}`, `该组在 ${process.platform} 上不可跑（仅 ${m.platform}）—— 覆盖缺口，不是通过`)
      return
    }
    const copy = makeRepoCopy(join(TMP, `mut-${i}`))
    const child = (label) => {
      const r = cmd(process.execPath, [join(copy, 'scripts/test-automation-gates.mjs'), '--only', m.group, '--fast', '--no-mutation'], {
        cwd: copy,
        env: { DSH_GATES_CHILD: '1' },
      })
      return { ...r, label }
    }
    // 对照：同一份副本、未注入 ⇒ 该组必须绿（证明"变红"是注入造成的，不是副本环境造成的）
    const base = child('baseline')
    check('mutation', `副本对照：未注入时 ${m.group} 组在本套件里是绿的（exit 0）`, '0', String(base.status),
      { detail: base.status === 0 ? '' : (base.stdout.split('\n').filter((l) => l.includes('FAIL')).slice(0, 2).join(' | ')) })

    const path = join(copy, m.file)
    const original = readFileSync(path, 'utf8')
    const hits = original.split(m.from).length - 1
    if (hits !== 1) {
      check('mutation', `注入点仍与代码耦合（${m.file} 里 "${m.from}" 命中 ${hits} 次，应为 1）`, '1', String(hits),
        { detail: '夹具与被测文本脱钩 ⇒ 变异无效，必须修套件而不是忽略' })
      return
    }
    writeFileSync(path, original.replace(m.from, m.to))
    const red = child('mutated')
    const fails = red.stdout.split('\n').filter((l) => l.includes('FAIL'))
    check('mutation', `注入：${m.name} ⇒ ${m.group} 组必须变红`, true, red.status !== 0 && fails.length > 0,
      { detail: `子跑 exit=${red.status}，红断言 ${fails.length} 条${fails[0] ? `：${fails[0].trim().slice(0, 120)}` : ''}` })
    const hitExpected = red.stdout.includes(m.expect)
    if (!hitExpected) {
      console.log(`         （注意：子跑红了，但没有命中预期的断言"${m.expect}"——请核对注入点是否还咬在判据上）`)
    }
  })
}

// ══ 主流程 ═════════════════════════════════════════════════════════════════
console.log('自动化链路门禁自证（假门禁猎手 harness 的仓库化版本；纯 node、零依赖、仓库只读）')
console.log(`  仓库 = ${ROOT}`)
console.log(`  临时目录 = ${TMP}${KEEP ? '（--keep：跑完保留）' : ''}`)
console.log(`  分组 = ${ONLY ? ONLY : GROUPS.join(' / ')}${FAST ? '；--fast（跳过的用例会逐条打印）' : ''}`)

const started = Date.now()
try {
  if (wants('probe')) groupProbe()
  if (wants('sla')) groupSla()
  if (wants('watch')) groupWatch()
  if (wants('doctor')) groupDoctor()
  if (wants('adapt')) groupAdapt()
  if (wants('drift')) groupDrift()
  if (wants('mutation')) groupMutation()
} catch (error) {
  nFail += 1
  failures.push(`套件自身异常：${error.stack ?? error.message}`)
  console.log(`  FAIL [suite] 套件自身异常：${error.message}`)
}

const total = nOk + nFail + nGap + nGapChanged
console.log('\n── 合计 ──────────────────────────────────────────────────────────')
console.log(`  断言 ${total} 条：通过 ${nOk} / 失败 ${nFail}（其中 KNOWN_GAP 仍存在 ${nGap} 条、已变化 ${nGapChanged} 条）`)
console.log(`  跳过 ${nSkipped} 条（不是通过：见上面的 SKIP 行）`)
if (gaps.length) for (const g of gaps) console.log(`    gap  ${g}`)
if (skipped.length) for (const s of skipped) console.log(`    SKIP ${s}`)
if (failures.length) for (const f of failures) console.log(`    FAIL ${f}`)
console.log(`  用时 ${((Date.now() - started) / 1000).toFixed(1)}s`)

if (!KEEP) rmSync(TMP, { recursive: true, force: true })
if (nFail > 0) {
  console.error(`\nFAILED: ${nFail} 条正确性断言未通过（自动化链路的判据没有按设计失败）`)
  process.exit(1)
}
console.log(`\nPASS: 自动化链路门禁自证（${nOk} 条正确性断言 + ${nGap} 条已知缺口已逐条打印${nSkipped ? ` + ${nSkipped} 条显式 SKIP` : ''}）`)
process.exit(0)
