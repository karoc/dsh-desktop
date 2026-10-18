#!/usr/bin/env node
// dsh 兼容性探针（P0）—— 对**已安装的 runtime** 跑一组确定性检查，产出 verdict + 证据 JSON。
//
//   node scripts/dsh-compat-probe.mjs --runtime <dir> [--json <out>]
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
const RUNTIME = arg('--runtime')
const OUT = arg('--json')
if (!RUNTIME) {
  console.error('usage: dsh-compat-probe.mjs --runtime <dir> [--json <out.json>]')
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
console.log(`探针目标：runtime=${RUNTIME}`)
console.log(`  已装 dsh=${version}  壳地板=${floor ?? '?'}  夹具=${fixture.dshVersion}（${fixture.ids.length} id）\n`)

// ① 版本三方一致：运行时装的东西 = 壳承诺的地板 = 夹具的采集版本
if (version !== floor) {
  add('red', 'version-vs-floor', `runtime 的 dsh=${version} 与壳地板 ${floor} 不一致（升级没成功，或地板没同步）`)
} else {
  add('info', 'version-vs-floor', `已装版本与壳地板一致：${version}`)
}
if (version !== fixture.dshVersion) {
  add('red', 'version-vs-fixture', `patch 夹具仍是 ${fixture.dshVersion} 采的；需 --update-fixture 重采`)
} else {
  add('info', 'version-vs-fixture', `patch 夹具与已装版本一致：${fixture.ids.length} 个 id`)
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

// ⑥ 预装插件 peer 范围 vs 已装版本（地板与 bundle 必须同批）
const cmp = (a, b) => {
  const norm = (v) => v.split('-')[0].split('.').map(Number)
  const [A, B] = [norm(a), norm(b)]
  for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0)
  return 0
}
if (existsSync(PREINSTALLED)) {
  for (const dir of readdirSync(PREINSTALLED)) {
    const pj = join(PREINSTALLED, dir, 'package.json')
    if (!existsSync(pj)) continue
    const pkg = JSON.parse(readFileSync(pj, 'utf8'))
    for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
      if (!name.startsWith('@deepseek-ai/dsh')) continue
      const lo = /[>]=?\s*([\w.\-]+)/.exec(range)?.[1]
      if (lo && cmp(version, lo) < 0) add('red', `peer:${dir}`, `${dir} 声明 ${name} ${range}，已装版本 ${version} 不满足`)
      else add('info', `peer:${dir}`, `${dir} 的 peer ${range} 被 ${version} 满足`)
    }
  }
}

const red = findings.filter((f) => f.sev === 'red')
const yellow = findings.filter((f) => f.sev === 'yellow')
const verdict = red.length ? 'red' : yellow.length ? 'yellow' : 'green'
const report = {
  runtime: RUNTIME,
  version,
  floor,
  fixtureVersion: fixture.dshVersion,
  verdict,
  generatedAt: new Date().toISOString(),
  counts: { red: red.length, yellow: yellow.length, info: findings.length - red.length - yellow.length },
  findings,
}
for (const f of findings.filter((x) => x.sev !== 'info')) {
  console.log(`  [${f.sev.toUpperCase()}] ${f.id}: ${f.msg}${f.evidence ? `\n         ${f.evidence}` : ''}`)
}
console.log(`\nverdict = ${verdict.toUpperCase()}（red ${red.length} / yellow ${yellow.length} / info ${report.counts.info}）`)
if (OUT) {
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  console.log(`报告已写入 ${OUT}`)
}
process.exit(red.length ? 1 : 0)
