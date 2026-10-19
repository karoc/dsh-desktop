#!/usr/bin/env node
// dsh 兼容性探针（P0）—— 对**已安装的 runtime** 跑一组确定性检查，产出 verdict + 证据 JSON。
//
//   node scripts/dsh-compat-probe.mjs --runtime <dir> [--json <out>] [--fail-on-yellow]
//                                      [--assume-floor <v>] [--assume-fixture <v>]
//
// 架构（2026-10-17 二次取证后定稿；旧版基于 npm tarball 的静态搜索已判定错误并删除）：
//   本探针**不自己造判据**，而是
//     ① 复用仓库既有的权威门禁（overlay / loader-id 交给 `test-patch-targets.mjs --runtime`）；
//     ② 对 runtime 实物做一致性核对（版本 ↔ 地板 ↔ 夹具、seam、CLI 开关、native 白名单、预装插件 peer）；
//     ③ 编排 + 分级 + 出报告。
//   为什么必须基于 runtime：seam 散在 `dsh-client-ui-*` / `dsh-api-gateway` 等几十个包里，patch id 的
//   权威来源是运行时的 loader 配置，CLI 开关要看运行时产物 —— 用 npm tarball 静态搜的旧版对**已知良好**
//   的版本同样报红（首轮校准当场证伪），属错误设计。
//
// 安装候选版本不在本脚本职责内：走产品自身路径（把地板写进随包 manager 后由 manager 装，实测 31.9s），
// 或在临时 runtime 里用 manager 的 pnpm 管线装。探针只回答"装完之后它行不行"。
//
// 判据分级：red = 必须处理；yellow = 要看一眼；info = 仅记录。exit：有 red ⇒ 1，否则 0。
//   `--fail-on-yellow`：yellow 也 ⇒ 1。**默认行为不变**（向后兼容）—— 但 CI 只跑 `npm run dsh:probe`
//   时，native 白名单 / CLI 开关这两条只报 yellow，等于没门禁（2026-10-19 审计定性），要门禁就加这个开关。
//
// 演练专用开关（**只用于演练，不代表真实一致**）：
//   --assume-floor <v>    把"runtime 版本 == 壳地板"这条判据的**期望值**换成 v
//   --assume-fixture <v>  把"runtime 版本 == 夹具采集版本"这条判据的期望值换成 v
//   加了任一开关 ⇒ 报告 JSON 里 rehearsal=true + assumed 值，stdout 打醒目声明，verdict 行也带演练标记。
//   为什么需要：dsh-adapt --dry-run 结构上跳过第 2/4 步（写地板 / 重采夹具），而这两条是
//   `version-vs-floor` / `version-vs-fixture` 两条 RED 的**唯一**消解途径 ⇒ target≠floor 时演练必然
//   停在第 6 步（"以为演练过、其实没演练"）。非 dry-run 绝不用这两个开关，也绝不静默假设。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(ROOT, 'scripts/fixtures/dsh-web-app-patch-ids.json')
const MANAGER = join(ROOT, 'scripts/server-manager.mjs')
const PATCH_GATE = join(ROOT, 'scripts/test-patch-targets.mjs')
const PREINSTALLED = join(ROOT, 'src-tauri/resources/preinstalled')

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
}
/** 取值型开关：出现在 argv 里就必须带合法版本号，否则 exit 2（坏输入不静默降级成"没给"）。 */
const versionArg = (name) => {
  const i = argv.indexOf(name)
  if (i < 0) return null
  const v = argv[i + 1]
  if (!v || v.startsWith('--') || !/^\d+\.\d+\.\d+/.test(v)) {
    console.error(`${name} 需要合法版本号（形如 0.2.1-rc.2），实得 ${JSON.stringify(v ?? null)}`)
    process.exit(2)
  }
  return v
}
const RUNTIME = arg('--runtime')
const OUT = arg('--json')
const FAIL_ON_YELLOW = argv.includes('--fail-on-yellow')
const ASSUME_FLOOR = versionArg('--assume-floor')
const ASSUME_FIXTURE = versionArg('--assume-fixture')
const REHEARSAL = ASSUME_FLOOR !== null || ASSUME_FIXTURE !== null
if (!RUNTIME) {
  console.error('usage: dsh-compat-probe.mjs --runtime <dir> [--json <out.json>] [--fail-on-yellow]')
  console.error('       [--assume-floor <v> --assume-fixture <v>]（演练专用；报告里会标 rehearsal=true）')
  process.exit(2)
}

/** 我们依赖的客户端 seam。inBaseline=true 表示已在**已发布的**地板版本上实测存在 ⇒ 消失即 red；
 *  false 表示在已知良好版本上也未实测到（说明它不是我们真正依赖的锚点）⇒ 只报 yellow 待人工确认。 */
const SEAMS = [
  { name: 'settings.section', who: 'model-reasoning / turn-navigator 设置分区', inBaseline: true },
  { name: 'configForms', who: 'model-reasoning 配置表单', inBaseline: true },
  { name: '__ModuleLoader__', who: '全部客户端插件注册入口', inBaseline: true },
  { name: 'settings.general.item', who: 'turn-navigator General 开关', inBaseline: true },
  { name: 'settings.plugins.tab', who: '官方插件页 tab（迁移锚点）', inBaseline: true },
  { name: 'conversation.chat.reasoning.body', who: 'model-reasoning 推理槽', inBaseline: true },
]
// 注意：--max-http-header-size **不是** dsh 的 CLI 开关，而是 manager 注入给 dsh 子进程的 NODE_OPTIONS
// （manager 日志原文：`dsh web NODE_OPTIONS: --max-http-header-size=65536 …`），因此不在此清单里。
const CLI_FLAGS = ['--port', '--patch', '--profile', '--dump-config']

const findings = []
const add = (sev, id, msg, evidence = '') => findings.push({ sev, id, msg, evidence })

const pkgJson = join(RUNTIME, 'node_modules/@deepseek-ai/dsh/package.json')
if (!existsSync(pkgJson)) {
  console.error(`FATAL: ${RUNTIME} 下没有 @deepseek-ai/dsh（不是有效 runtime）`)
  process.exit(2)
}
const installed = JSON.parse(readFileSync(pkgJson, 'utf8'))
const version = installed.version
const floor = /MIN_DSH_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(MANAGER, 'utf8'))?.[1]
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))
// 演练假设只替换这两条判据的**期望值**（其余判据一律按实物判），默认（不给开关）= 真实值。
const expectedFloor = ASSUME_FLOOR ?? floor
const expectedFixture = ASSUME_FIXTURE ?? fixture.dshVersion
console.log(`探针目标：runtime=${RUNTIME}`)
console.log(`  已装 dsh=${version}  壳地板=${floor ?? '?'}  夹具=${fixture.dshVersion}（${fixture.ids.length} id）${REHEARSAL ? '  ← 演练模式，见下方声明' : ''}\n`)
if (REHEARSAL) {
  console.log('  ！！！ 演练模式（rehearsal）：版本一致性按**假设值**判定，不代表真实一致 ！！！')
  console.log(`      假设地板=${ASSUME_FLOOR ?? '(未假设，按真实值)'}、假设夹具=${ASSUME_FIXTURE ?? '(未假设，按真实值)'}`)
  console.log(`      真实值：壳地板=${floor ?? '?'}、夹具=${fixture.dshVersion}。本模式只供 dsh-adapt --dry-run 演练，不构成"版本已一致"的证据。\n`)
}

// ① 版本三方一致：运行时装的东西 = 壳承诺的地板 = 夹具的采集版本
//    演练时用 expected*（假设值），并在文案里点名"这是假设"，绝不冒充真实一致。
if (version !== expectedFloor) {
  add('red', 'version-vs-floor', `runtime 的 dsh=${version} 与壳地板 ${expectedFloor} 不一致（升级没成功，或地板没同步）${ASSUME_FLOOR !== null ? `（注意：地板期望值是**演练假设值**；真实地板 ${floor ?? '?'}）` : ''}`)
} else {
  add('info', 'version-vs-floor', `已装版本与壳地板一致：${version}${ASSUME_FLOOR !== null ? `（演练假设值；真实地板 ${floor ?? '?'}）` : ''}`)
}
if (version !== expectedFixture) {
  add('red', 'version-vs-fixture', `patch 夹具仍是 ${fixture.dshVersion} 采的；需 --update-fixture 重采${ASSUME_FIXTURE !== null ? `（注意：夹具期望值是**演练假设值** ${ASSUME_FIXTURE}；真实夹具版本 ${fixture.dshVersion}）` : ''}`)
} else {
  add('info', 'version-vs-fixture', `patch 夹具与已装版本一致：${fixture.ids.length} 个 id${ASSUME_FIXTURE !== null ? `（演练假设值；真实夹具版本 ${fixture.dshVersion}）` : ''}`)
}

// ② overlay / loader-id：交给既有权威门禁，不重实现
try {
  const out = execFileSync(process.execPath, [PATCH_GATE, '--runtime', RUNTIME], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const key = out.split('\n').filter((l) => l.includes('关键覆盖') || l.includes('PASS')).pop()
  add('info', 'overlay-targets', 'overlay 目标行契约门禁通过', (key ?? '').trim())
} catch (error) {
  const text = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ')
  add('red', 'overlay-targets', 'overlay 目标行契约门禁失败（上游改名会让覆盖静默失效）', text.slice(0, 400))
}

// ③ seam：在 runtime 实物里搜
const walk = (dir, out, depth = 0) => {
  if (depth > 4) return out
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.bin') continue
    const p = join(dir, entry)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out, depth + 1)
    else if (/\.(m?js|cjs)$/.test(entry)) out.push(p)
  }
  return out
}
const scopeFiles = walk(join(RUNTIME, 'node_modules/@deepseek-ai'), [])
const blob = scopeFiles.map((f) => readFileSync(f, 'utf8')).join('\n')
console.log(`seam 搜索范围：@deepseek-ai/** 下 ${scopeFiles.length} 个 JS 文件（深度≤4）`)
for (const seam of SEAMS) {
  if (blob.includes(seam.name)) {
    add('info', `seam:${seam.name}`, `seam 在位（${seam.who}）`)
  } else if (seam.inBaseline) {
    add('red', `seam:${seam.name}`, `seam 消失：${seam.name}（${seam.who}）—— 该锚点在已发布基线上实测存在`)
  } else {
    add('yellow', `seam:${seam.name}`, `未找到 ${seam.name}（${seam.who}）；它在已发布基线上也未实测到，需人工确认是否仍依赖`)
  }
}

// ④ manager 依赖的 CLI 开关：搜 runtime 里的 dsh 产物
const dshFiles = []
const walkDsh = (dir, depth = 0) => {
  if (depth > 4) return
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walkDsh(p, depth + 1)
    else if (/\.(m?js|cjs|json)$/.test(entry)) dshFiles.push(p)
  }
}
walkDsh(join(RUNTIME, 'node_modules/@deepseek-ai/dsh'))
const dshBlob = dshFiles.map((f) => readFileSync(f, 'utf8')).join('\n')
const missingFlags = CLI_FLAGS.filter((f) => !blob.includes(f) && !dshBlob.includes(f))
if (missingFlags.length) {
  add('yellow', 'cli-flags', `dsh 产物里按文本找不到：${missingFlags.join(', ')}（文本搜索对动态拼装不成立；确认方式：跑 test-control-plane / test-broken-install，它们会真拉起 manager 并传这些参数）`)
} else {
  add('info', 'cli-flags', `manager 依赖的 ${CLI_FLAGS.length} 个 CLI 开关都在产物里`)
}

// ⑤ native 构建白名单 vs 已装依赖
const mgrSrc = readFileSync(MANAGER, 'utf8')
const whitelist = [...(/const NATIVE_BUILD_PKGS = \[([\s\S]*?)\]/.exec(mgrSrc)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
const deps = { ...(installed.dependencies ?? {}), ...(installed.optionalDependencies ?? {}) }
const nmRoot = join(RUNTIME, 'node_modules')
const installedAnywhere = (name) => {
  if (existsSync(join(nmRoot, name))) return true
  // 子包内嵌安装（pnpm 会把 node-pty 之类挂在 dsh-subprocess-local 下面）
  for (const scope of readdirSync(nmRoot)) {
    if (!scope.startsWith('@')) continue
    const scopeDir2 = join(nmRoot, scope)
    let entries = []
    try { entries = readdirSync(scopeDir2) } catch { continue }
    for (const pkg of entries) {
      if (existsSync(join(scopeDir2, pkg, 'node_modules', name))) return true
    }
  }
  return false
}
const absent = whitelist.filter((p) => !(p in deps) && !installedAnywhere(p))
if (absent.length) add('yellow', 'native-build', `壳的 native 白名单里这些包既不在 dsh 直接依赖里、也不在 runtime 顶层 node_modules（可能真被移除，人工确认后再决定是否同步删）：${absent.join(', ')}`)
else add('info', 'native-build', `native 白名单 ${whitelist.length} 个包都能在 runtime 里找到`)

// ⑥ 预装插件 peer 范围 vs **runtime 里已装的 peer 包本体**（地板与 bundle 必须同批）
// 旧实现拿 dsh CLI 版本当所有 `@deepseek-ai/dsh*` 子包版本的代理 —— "CLI 到位、子包滞后"的
// 部分升级永远漏判（2026-10-19 审计定性）。现在读 runtime 里该 peer 包自己的 package.json。
// 比较必须**预发布感知**（与 dsh-watch 的 cmp、manager 的 versionGt 同一口径）：
// 旧实现 `v.split('-')[0]` 直接丢掉预发布段 ⇒ `0.2.1` 与 `0.2.1-rc.2` 判为相等
// （审计 P0-1 的第三份独立实现）。无预发布必须回空数组，否则 `0.2.1` 被当成"有预发布"。
const preParts = (v) => { const s = String(v ?? '').split('-').slice(1).join('-'); return s === '' ? [] : s.split('.') }
const cmp = (a, b) => {
  const norm = (v) => String(v).split('-')[0].split('.').map(Number)
  const [A, B] = [norm(a), norm(b)]
  for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0)
  const [x, y] = [preParts(a), preParts(b)]
  if (x.length === 0 && y.length === 0) return 0
  if (x.length === 0) return 1    // 正式版 > 同号任何预发布
  if (y.length === 0) return -1
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const u = x[i] ?? '', v = y[i] ?? ''
    const un = /^\d+$/.test(u), vn = /^\d+$/.test(v)
    if (un && vn) { if (+u !== +v) return +u - +v }
    else if (u !== v) return u < v ? -1 : 1
  }
  return 0
}
/** 按 Node 的解析顺序找已装的 peer 包：runtime 根 → 该插件自己装的位置（pnpm 会把依赖挂在插件下）。 */
const readPeerVersion = (name, pluginName) => {
  const candidates = [join(nmRoot, name), ...(pluginName ? [join(nmRoot, pluginName, 'node_modules', name)] : [])]
  for (const dir of candidates) {
    const pj = join(dir, 'package.json')
    if (!existsSync(pj)) continue
    try {
      const v = JSON.parse(readFileSync(pj, 'utf8')).version
      if (typeof v === 'string' && v) return { version: v, from: pj }
    } catch { /* 坏 package.json 视同"读不到"，落到下面的分支，不静默放行 */ }
  }
  return null
}
const absentOptionalPeers = []
if (existsSync(PREINSTALLED)) {
  for (const dir of readdirSync(PREINSTALLED)) {
    const pj = join(PREINSTALLED, dir, 'package.json')
    if (!existsSync(pj)) continue
    const pkg = JSON.parse(readFileSync(pj, 'utf8'))
    const meta = pkg.peerDependenciesMeta ?? {}
    for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
      if (!name.startsWith('@deepseek-ai/dsh')) continue
      const lo = /[>]=?\s*([\w.\-]+)/.exec(range)?.[1]
      const installedPeer = readPeerVersion(name, pkg.name)
      if (installedPeer === null) {
        if (meta[name]?.optional === true) {
          // npm 语义：optional peer 没装**不算错误**（四个预装包都把 dsh 平台包标成 optional）。
          // 一律判 red 会让健康 runtime 恒红 —— 实测 0.2.1-rc.2 的 runtime 里没有
          // @deepseek-ai/dsh-client-ui-slots（上游不再把它当 dsh 的运行时依赖安装，而它在 npm 上
          // 确实有 0.2.1-rc.2），dsh-kanban 的 peer 正指着它。但**不许静默**：info 进报告 JSON，
          // 并在 stdout 用专门一段点名（下面的 absentOptionalPeers）；要当门禁就配 --fail-on-yellow。
          add('info', `peer-absent:${dir}`, `${dir} 声明了 peer ${name} ${range}，但 runtime 里找不到该包（peerDependenciesMeta.optional=true ⇒ 按 npm 语义缺失合法；无法核实其滞后）`)
          absentOptionalPeers.push(`${dir} → ${name}`)
        } else {
          add('red', `peer:${dir}`, `${dir} 声明了 peer ${name} ${range}，但 runtime 里找不到该包（非 optional）—— 缺包不能算通过`)
        }
      } else if (lo && cmp(installedPeer.version, lo) < 0) {
        add('red', `peer:${dir}`, `${dir} 声明 ${name} ${range}，runtime 里已装的 ${name}=${installedPeer.version} 不满足（CLI 版本 ${version} 只是代理信号，代表不了子包）`, installedPeer.from)
      } else {
        add('info', `peer:${dir}`, `${dir} 的 peer ${name} ${range} 被已装的 ${name}=${installedPeer.version} 满足`)
      }
      // CLI 版本检查**保留为额外信号**（旧实现唯一的判据）：平台包缺位时它仍是唯一线索。
      if (lo && cmp(version, lo) < 0) {
        add('red', `peer-cli:${dir}`, `额外信号：已装 dsh CLI=${version} 低于 ${dir} 声明的 ${name} 下限（平台包与 CLI lockstep 发布）`)
      } else if (lo && installedPeer === null) {
        add('info', `peer-cli:${dir}`, `额外信号：dsh CLI=${version} 满足 ${name} ${range} 的下限 ${lo}，但该平台包没随 runtime 安装`)
      }
    }
  }
}

const red = findings.filter((f) => f.sev === 'red')
const yellow = findings.filter((f) => f.sev === 'yellow')
const verdict = red.length ? 'red' : yellow.length ? 'yellow' : 'green'
// --fail-on-yellow：yellow 也 ⇒ 1。默认不加时行为与旧版完全一致（向后兼容）。
const failYellow = FAIL_ON_YELLOW && yellow.length > 0
const report = {
  runtime: RUNTIME,
  version,
  floor,
  fixtureVersion: fixture.dshVersion,
  rehearsal: REHEARSAL,
  assumed: { floor: ASSUME_FLOOR, fixture: ASSUME_FIXTURE },
  verdict,
  failOnYellow: FAIL_ON_YELLOW,
  generatedAt: new Date().toISOString(),
  counts: { red: red.length, yellow: yellow.length, info: findings.length - red.length - yellow.length },
  findings,
}
if (absentOptionalPeers.length) {
  // info 不进下面的 [SEV] 打印块，所以这里专门点名：声明了 peer 却没随 runtime 装的包必须看得见。
  console.log(`  说明（不影响退出码；明细在报告 JSON 的 peer-absent:* 里）：${absentOptionalPeers.length} 个声明了 peer 的平台包没随 runtime 安装，且插件把它标为 optional（npm 语义合法，无法据此判定滞后）：`)
  for (const line of absentOptionalPeers) console.log(`    · ${line}`)
}
for (const f of findings.filter((x) => x.sev !== 'info')) {
  console.log(`  [${f.sev.toUpperCase()}] ${f.id}: ${f.msg}${f.evidence ? `\n         ${f.evidence}` : ''}`)
}
console.log(`\nverdict = ${verdict.toUpperCase()}（red ${red.length} / yellow ${yellow.length} / info ${report.counts.info}）${REHEARSAL ? '  [演练模式：版本一致性按假设值判定，不代表真实一致]' : ''}`)
if (failYellow) console.log(`--fail-on-yellow：${yellow.length} 条 yellow 计为失败 ⇒ exit 1（默认不加此开关时 yellow 仍 exit 0）`)
if (OUT) {
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  console.log(`报告已写入 ${OUT}`)
}
process.exit(red.length || failYellow ? 1 : 0)
