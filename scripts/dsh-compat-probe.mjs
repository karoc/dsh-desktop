#!/usr/bin/env node
// ⚠️⚠️ WIP — **未校准，禁止用于判定**（2026-10-17）⚠️⚠️
// 校准证据（必读）：对**已知良好**的当前地板 `0.2.1-alpha.3` 跑，本脚本给出与对 `0.2.1-rc.1` 跑
// **完全相同**的全红结论（red 8：73 个 id "被删"、6 个 seam "消失"、CLI 开关 "--port/--max-http-header-size"
// 找不到）。已知良好的版本不可能是红的 ⇒ 错在本脚本的取数语义，不在上游。四处已定位的缺陷：
//   ① patch-id 是**苹果对橘子**：夹具（188 个）来自运行时的 `dsh --dump-config` 解析结果，
//      而新版取的是 web-app 的 `cordis.patch.yml`（115 个）⇒ 应改成 patch-yml ↔ patch-yml 对比；
//   ② overlay 目标行 `desktop-notifications` "不存在"：该行由**其它上游包**提供，只在 web-app 的
//      yml 里找必然找不到 ⇒ overlay 检查应交给装好后的 `test-patch-targets.mjs --runtime <dir>`；
//   ③ 6 个 seam 在 web-app tarball 里搜不到（连 `__ModuleLoader__` 都没有）⇒ seam 不在这个包里，
//      要先查清它们在哪个产物（当年人工审计是"抽检 web-app tarball"，需重新取证，别猜）；
//   ④ CLI 开关按文本搜 `.js` 命中不到 ⇒ 上游用动态拼装/配置对象，需换判据（或改在装好后跑 `--help`）。
// 修好并**通过 alpha.3 校准（必须绿）**之后，才允许接进 workflow 与清欠账。
// dsh 兼容性探针：给定一个 dsh 版本（或 latest / next），把"抬地板前必须人工核对"的那几件事
// 变成一次确定性检查，产出 verdict + 证据 JSON。
//
//   node scripts/dsh-compat-probe.mjs 0.2.1-rc.1
//   node scripts/dsh-compat-probe.mjs next --out .tmp-investigate/probe.json
//
// 为什么要有它（2026-10-17 方案 §3.1）：历史上"上游发布 → 抬地板"中位 38.2h，而这段里做的
// 全是确定性检查（集合 diff / 字符串存在性 / 语义断言），只是从来没有脚本。探针把它压到分钟级。
//
// 网络纪律（CONTRIBUTING 硬规则）：**不用裸 fetch** —— Node 的 fetch 不读 .npmrc 代理配置，
// 且代理环境变量在进程启动时被采样。本脚本一律 spawn `curl`（显式带 `-x $HTTPS_PROXY`）。
// 另：本机 `npm` CLI 不可用（`~/.npm/_cacache` 只读 ⇒ EROFS），所以取包也走 curl + tar。
//
// 判据分级：red = 必须人/agent 处理（我们依赖的东西消失了）；yellow = 要看一眼但可能无碍；
// info = 只记录（上游新增）。exit code：red ⇒ 1，其它 ⇒ 0（供 workflow 判分支）。

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(ROOT, 'scripts/fixtures/dsh-web-app-patch-ids.json')
const OVERLAY = join(ROOT, 'src-tauri/resources/patch/dsh-desktop.patch.yml')
const MANAGER = join(ROOT, 'scripts/server-manager.mjs')

const argv = process.argv.slice(2)
const want = argv.find((a) => !a.startsWith('--')) ?? 'latest'
const outIdx = argv.indexOf('--out')
const OUT = outIdx >= 0 ? argv[outIdx + 1] : null
const KEEP = argv.includes('--keep')

/** 我们依赖的客户端 seam / 槽位（来源：MIN_DSH_VERSION 注释里的历次核对项 + 四个预装插件的用法）。
 *  每项都写明"谁在用" —— 消失即 red，必须人处理。 */
const SEAMS = [
  { name: 'settings.section', who: 'model-reasoning / turn-navigator 的设置分区' },
  { name: 'settings.general.item', who: 'turn-navigator 的 General 开关' },
  { name: 'configForms', who: 'model-reasoning 的配置表单' },
  { name: 'settings.plugins.tab', who: '官方插件页 tab（我们判断是否要迁移的锚点）' },
  { name: 'conversation.chat.reasoning.body', who: 'model-reasoning 的推理槽' },
  { name: '__ModuleLoader__', who: '所有客户端插件的注册入口' },
]
/** manager 依赖的 CLI 面（读上游 bin，退化为文本存在性检查）。 */
const CLI_FLAGS = ['--port', '--patch', '--profile', '--dump-config', '--max-http-header-size']

const log = (...a) => console.log(...a)
const CURL = ['-sS', '--max-time', '40', '--retry', '2', '--retry-all-errors']
function curl(url) {
  const args = [...CURL]
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
  if (proxy) args.push('-x', proxy)
  args.push(url)
  return execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}
function curlFile(url, dest) {
  const args = [...CURL, '-L', '-o', dest]
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
  if (proxy) args.push('-x', proxy)
  args.push(url)
  execFileSync('curl', args, { encoding: 'utf8' })
}

const findings = []
const add = (sev, id, msg, evidence = '') => findings.push({ sev, id, msg, evidence })

// ── 1. 解析版本 ─────────────────────────────────────────────
const packument = JSON.parse(curl('https://registry.npmjs.org/@deepseek-ai/dsh'))
const distTags = packument['dist-tags'] ?? {}
const version = distTags[want] ?? want
if (!packument.versions?.[version]) {
  log(`FATAL: registry 里没有 @deepseek-ai/dsh@${version}（dist-tags: ${JSON.stringify(distTags)}）`)
  process.exit(2)
}
const publishedAt = packument.time?.[version] ?? '(unknown)'
log(`探针目标：@deepseek-ai/dsh@${version}（请求 "${want}"，发布 ${publishedAt}）`)
log(`dist-tags: ${JSON.stringify(distTags)}\n`)

const tmp = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
function fetchPkg(name, ver) {
  const p = JSON.parse(curl(`https://registry.npmjs.org/${name.replace('/', '%2F')}`))
  const tarball = p.versions?.[ver]?.dist?.tarball
  if (!tarball) return null
  const dest = join(tmp, `${name.replace(/[@/]/g, '_')}-${ver}.tgz`)
  curlFile(tarball, dest)
  const dir = join(tmp, name.replace(/[@/]/g, '_'))
  mkdirSync(dir, { recursive: true })
  execFileSync('tar', ['-xzf', dest, '-C', dir])
  return { dir: join(dir, 'package'), meta: p.versions[ver], packument: p }
}

// ── 2. 取两个 tarball：dsh 本体（CLI/native 依赖）+ web-app（patch id / seam）───
const dsh = fetchPkg('@deepseek-ai/dsh', version)
const web = fetchPkg('@deepseek-ai/dsh-web-app', version)
if (!dsh) add('red', 'dsh-tarball', `取不到 @deepseek-ai/dsh@${version} 的 tarball`)
if (!web) add('yellow', 'webapp-tarball', `取不到 @deepseek-ai/dsh-web-app@${version} 的 tarball（patch-id/seam 检查跳过）`)

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, acc)
    else acc.push(p)
  }
  return acc
}
function idsFromPatchYaml(text) {
  const ids = []
  for (const line of text.split('\n')) {
    const m = /^\s*-\s*id:\s*([\w.\-]+)\s*$/.exec(line)
    if (m) ids.push(m[1])
  }
  return ids
}

// ── 3. patch-id 集合 diff（对夹具）────────────────────────────
if (web) {
  const patchYml = join(web.dir, 'cordis.patch.yml')
  if (!existsSync(patchYml)) {
    add('red', 'webapp-patch-yml', '新版 web-app 里找不到 cordis.patch.yml（上游换了产物布局？）')
  } else {
    const fresh = [...new Set(idsFromPatchYaml(readFileSync(patchYml, 'utf8')))].sort()
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    const old = new Set(fixture.ids)
    const freshSet = new Set(fresh)
    const removed = [...old].filter((id) => !freshSet.has(id))
    const added = fresh.filter((id) => !old.has(id))
    const overlayIds = idsFromPatchYaml(readFileSync(OVERLAY, 'utf8'))
    const missingTargets = overlayIds.filter((id) => !freshSet.has(id))
    log(`patch id：夹具 ${fixture.dshVersion} 有 ${old.size} 个 → ${version} 有 ${freshSet.size} 个（+${added.length} / −${removed.length}）`)
    if (added.length) add('info', 'ids-added', `上游新增 ${added.length} 个 id`, added.join(', '))
    if (removed.length) add('yellow', 'ids-removed', `上游删除 ${removed.length} 个 id（确认我们没依赖）`, removed.join(', '))
    // 我们的 overlay 目标行必须仍然存在（历史上上游改名会让覆盖**静默失效**）
    if (missingTargets.length) {
      add('red', 'overlay-targets', `overlay 的目标行在新版不存在：${missingTargets.join(', ')} ⇒ 覆盖会静默失效`, `overlay=${relative(ROOT, OVERLAY)}`)
    } else {
      add('info', 'overlay-targets', `overlay 的 ${overlayIds.length} 个目标行在新版全部存在`)
    }
  }
}

// ── 4. seam / 槽位存在性（在 web-app 产物里搜）────────────────
if (web) {
  const files = walk(web.dir)
  const blob = files.map((f) => readFileSync(f, 'utf8')).join('\n')
  for (const s of SEAMS) {
    if (blob.includes(s.name)) add('info', `seam:${s.name}`, `seam 在位（${s.who}）`)
    else add('red', `seam:${s.name}`, `seam 消失：${s.name}（${s.who}）`)
  }
}

// ── 5. CLI 面（读上游 bin 文本）──────────────────────────────
if (dsh) {
  const files = walk(dsh.dir).filter((f) => /\.(m?js|cjs)$/.test(f))
  const blob = files.map((f) => readFileSync(f, 'utf8')).join('\n')
  const missing = CLI_FLAGS.filter((f) => !blob.includes(f))
  if (missing.length) add('red', 'cli-flags', `manager 依赖的 CLI 开关在新版 bin 里找不到：${missing.join(', ')}`)
  else add('info', 'cli-flags', `manager 依赖的 ${CLI_FLAGS.length} 个 CLI 开关都在`)
}

// ── 6. native 构建白名单（manager 的 allowBuilds 跟随它）────────
if (dsh) {
  const mgrSrc = readFileSync(MANAGER, 'utf8')
  const m = /const NATIVE_BUILD_PKGS = \[([\s\S]*?)\]/.exec(mgrSrc)
  const listed = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []
  const deps = { ...(dsh.meta.dependencies ?? {}), ...(dsh.meta.optionalDependencies ?? {}) }
  const gone = listed.filter((p) => !(p in deps))
  if (gone.length) add('yellow', 'native-build', `壳的 native 构建白名单里这些包已不在新版 dsh 依赖里（manager 白名单应同步删）：${gone.join(', ')}`)
  else add('info', 'native-build', `native 构建白名单 ${listed.length} 个包在新版依赖里都能找到`)
}

// ── 7. 预装插件的 peer 地板 vs 候选版本 ──────────────────────
{
  const dirs = existsSync(join(ROOT, 'src-tauri/resources/preinstalled'))
    ? readdirSync(join(ROOT, 'src-tauri/resources/preinstalled')).filter((d) => statSync(join(ROOT, 'src-tauri/resources/preinstalled', d)).isDirectory())
    : []
  const cmp = (a, b) => {
    const norm = (v) => (v.split('-')[0]).split('.').map(Number)
    const [A, B] = [norm(a), norm(b)]
    for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0)
    return 0
  }
  for (const d of dirs) {
    const pj = join(ROOT, 'src-tauri/resources/preinstalled', d, 'package.json')
    if (!existsSync(pj)) continue
    const j = JSON.parse(readFileSync(pj, 'utf8'))
    const peers = Object.entries(j.peerDependencies ?? {}).filter(([k]) => k.startsWith('@deepseek-ai/dsh'))
    for (const [k, range] of peers) {
      const lo = /[>]=?\s*([\w.\-]+)/.exec(range)?.[1]
      if (lo && cmp(version, lo) < 0) add('red', `peer:${d}`, `${d} 声明 ${k} ${range}，候选版本 ${version} 不满足`)
      else add('info', `peer:${d}`, `${d} 的 peer ${range} 被 ${version} 满足`)
    }
  }
}

// ── 8. 汇总 ─────────────────────────────────────────────────
const red = findings.filter((f) => f.sev === 'red')
const yellow = findings.filter((f) => f.sev === 'yellow')
const verdict = red.length ? 'red' : yellow.length ? 'yellow' : 'green'
const report = {
  target: version, requested: want, publishedAt, verdict,
  generatedAt: new Date().toISOString(),
  counts: { red: red.length, yellow: yellow.length, info: findings.length - red.length - yellow.length },
  findings,
}
log('')
for (const f of findings.filter((x) => x.sev !== 'info')) log(`  [${f.sev.toUpperCase()}] ${f.id}: ${f.msg}${f.evidence ? `\n         ${f.evidence}` : ''}`)
log(`\nverdict = ${verdict.toUpperCase()}（red ${red.length} / yellow ${yellow.length} / info ${report.counts.info}）`)
if (OUT) { writeFileSync(OUT, JSON.stringify(report, null, 2)); log(`报告已写入 ${OUT}`) }
if (!KEEP) rmSync(tmp, { recursive: true, force: true })
else log(`tarball 保留在 ${tmp}`)
process.exit(red.length ? 1 : 0)
