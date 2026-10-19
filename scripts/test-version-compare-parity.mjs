#!/usr/bin/env node
// 门禁（parity）：三份"版本比较"实现必须给出**完全一致**的结论。
//
//   node scripts/test-version-compare-parity.mjs [--root <dir>]
//
// 为什么需要它：语义化比较在仓库里有**三份独立实现** ——
//   scripts/dsh-watch.mjs            cmp(a, b)        （+ bare / pre）
//   scripts/dsh-compat-probe.mjs     cmp(a, b)        （+ preParts）
//   scripts/server-manager.mjs       versionGt(a, b)  （+ preParts / preCmp，返回布尔）
// 审计 P0-1 / P0-2 的教训是"一次只修一份"：main 上曾三份同时错（把正式版判成比同号预发布旧），
// 修的时候又只改了其中两份 ⇒ 剩下一份随时会再漂。本套件把"三份必须同结论"变成**可失败断言**。
//
// 机制：从三个文件的**源文本**里逐字抽出各自的比较函数（`new Function` 注入），**不复制粘贴实现** ——
// 复制出来的副本永远不会漂移，那是恒真断言。源文本被改名/改写导致抽不出来时**抛错即失败**，不静默跳过。
// 归一化：watch/probe 返回数值差，manager 返回布尔（a > b）⇒ 统一成关系 {-1, 0, 1}
// （数值版取 Math.sign 并要求返回有限数；布尔版用 gt(a,b) ? 1 : gt(b,a) ? -1 : 0）。
//
// 已知的**域外**输入（非 semver，如 `0.2.x` / `1.0.0+build`）不计入判定，只在末尾打印原始结论：
//   watch/probe 写 `A[i] || 0`（NaN ⇒ 0），manager 写 `pa[i] ?? 0`（NaN 保持 NaN）—— 但 manager 的
//   `versionGt` 返回布尔，双向都不成立时对外就是"相等"，与另两份的 0 不可区分 ⇒ **可观察结论一致**。
//   三份都不实现 semver §10 的 build metadata 忽略规则（按字符串比预发布段）。npm tag 与
//   package.json 里不会出现这类串；把它做成硬失败会让门禁在健康仓库上恒红（另一种假门禁）。
//
// 负向对照（必须变红）：把本套件指向"故意改坏一份"的副本 ⇒ exit 非零并指名是哪一份。
//   mkdir -p /tmp/parity-lab/scripts && cp scripts/*.mjs /tmp/parity-lab/scripts/ \
//     && sed -i 's/if (x.length === 0) return 1/if (x.length === 0) return -1/' /tmp/parity-lab/scripts/dsh-watch.mjs \
//     && node scripts/test-version-compare-parity.mjs --root /tmp/parity-lab
//
// ── 关于"抽成单处共享"的两个方案（供上层决策；本轮**不动** server-manager.mjs）──────────────
// A. `scripts/lib/version-compare.mjs` 由 dsh-watch / dsh-compat-probe 共用；manager 保独立副本，
//    用本 parity 套件兜底。风险：manager 那份仍可能单独漂（靠本套件在 CI/本机发现，非结构上禁止）；
//    收益：manager 是**随包发布**的产品面（src-tauri/resources/manager/ + copy-consistency 白名单），
//    不引入新的随包文件、不碰打包链路。回滚：删 scripts/lib/ 与两处 import，恢复两段本地实现（本套件即在）。
// B. 共享模块放进 `src-tauri/resources/manager/version-compare.mjs` 随包发布，三处共用。
//    风险：① 打包/白名单要同步（test-copy-consistency + sync-resources 的白名单，漏了就是"运行时文件缺失"）；
//    ② watch/probe 是**开发侧**脚本，从 `src-tauri/resources/manager/` import 会把开发工具绑到产品产物的路径上
//    （路径一改就编译期坏）；③ manager 的 versionGt 返回布尔、另两份返回数值差，共享必须先统一接口语义。
//    收益：真正单处实现，结构上不可能漂。回滚：共享文件改回各自副本 + 撤白名单条目（同样靠本套件确认）。

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
const ROOT = arg('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..')

const files = {
  watch: join(ROOT, 'scripts/dsh-watch.mjs'),
  probe: join(ROOT, 'scripts/dsh-compat-probe.mjs'),
  manager: join(ROOT, 'scripts/server-manager.mjs'),
}

// ── 抽取器（源文本 → 可求值的源码片段）──────────────────────────────────────
/** 单行箭头函数（形如 `const bare = (v) => …`）：整行取出。 */
const extractLine = (src, re, label) => {
  const m = re.exec(src)
  if (!m) throw new Error(`从 ${label} 的源文本里抽不出 ${re}（实现被改名/改写 ⇒ 本套件必须失败，不许静默跳过）`)
  return m[0].trim()
}
/** 花括号配平取整段（这三份实现的函数体里没有会干扰配平的花括号字符串/注释）。配不平即抛。 */
const extractBlock = (src, re, label) => {
  const m = re.exec(src)
  if (!m) throw new Error(`从 ${label} 的源文本里抽不出 ${re}（实现被改名/改写 ⇒ 本套件必须失败，不许静默跳过）`)
  const open = src.indexOf('{', m.index)
  if (open < 0) throw new Error(`${label}: ${re} 后面找不到 "{"`)
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(m.index, i + 1)
    }
  }
  throw new Error(`${label}: ${re} 的花括号未配平`)
}
const build = (parts, expr, label) => {
  const text = parts.join('\n')
  for (const marker of ['return']) {
    if (!text.includes(marker)) throw new Error(`${label}: 抽出的源文本里没有 "${marker}"（抽取位置不对）`)
  }
  let fn
  try { fn = new Function(`${text}\nreturn ${expr}`)() } catch (error) {
    throw new Error(`${label}: 抽出的源文本无法求值：${error.message}`)
  }
  if (typeof fn !== 'function') throw new Error(`${label}: 抽出的 ${expr} 不是函数`)
  return fn
}

// ── 逐份抽取 + 归一化 ──────────────────────────────────────────────────────
const impls = []
const extractionNotes = []
try {
  for (const [key, file] of Object.entries(files)) {
    if (!existsSync(file)) throw new Error(`源文件不存在：${file}`)
  }
  const watchSrc = readFileSync(files.watch, 'utf8')
  const bareText = extractLine(watchSrc, /\nconst bare = \(v\) =>[^\n]*/, 'dsh-watch')
  const watchPre = extractLine(watchSrc, /\nconst pre = \(v\) =>[^\n]*/, 'dsh-watch')
  const watchCmpText = extractBlock(watchSrc, /\nfunction cmp\(a, b\) \{/, 'dsh-watch')
  const watchRaw = build([bareText, watchPre, watchCmpText], 'cmp', 'dsh-watch')
  impls.push({ name: 'dsh-watch.mjs cmp()', rel: watchRaw, kind: 'numeric' })
  extractionNotes.push(`dsh-watch.mjs        bare=${bareText.length}B pre=${watchPre.length}B cmp=${watchCmpText.length}B`)

  const probeSrc = readFileSync(files.probe, 'utf8')
  const probePre = extractBlock(probeSrc, /\nconst preParts = \(v\) => \{/, 'dsh-compat-probe')
  const probeCmp = extractBlock(probeSrc, /\nconst cmp = \(a, b\) => \{/, 'dsh-compat-probe')
  const probeRaw = build([probePre, probeCmp], 'cmp', 'dsh-compat-probe')
  impls.push({ name: 'dsh-compat-probe.mjs cmp()', rel: probeRaw, kind: 'numeric' })
  extractionNotes.push(`dsh-compat-probe.mjs preParts=${probePre.length}B cmp=${probeCmp.length}B`)

  const mgrSrc = readFileSync(files.manager, 'utf8')
  const mgrPre = extractBlock(mgrSrc, /\nfunction preParts\(v\) \{/, 'server-manager')
  const mgrPreCmp = extractBlock(mgrSrc, /\nfunction preCmp\(a, b\) \{/, 'server-manager')
  const mgrGt = extractBlock(mgrSrc, /\nfunction versionGt\(a, b\) \{/, 'server-manager')
  const mgrRaw = build([mgrPre, mgrPreCmp, mgrGt], 'versionGt', 'server-manager')
  impls.push({ name: 'server-manager.mjs versionGt()', rel: mgrRaw, kind: 'boolean' })
  extractionNotes.push(`server-manager.mjs   preParts=${mgrPre.length}B preCmp=${mgrPreCmp.length}B versionGt=${mgrGt.length}B`)
} catch (error) {
  console.error(`FAIL 抽取三份实现时出错：${error.message}`)
  process.exit(1)
}

/** 统一成关系 {-1, 0, 1}；数值版要求返回有限数（NaN 落进 if 会静默当 false），布尔版跑双向。 */
const relOf = (impl) => {
  if (impl.kind === 'numeric') {
    return (a, b) => {
      const r = impl.rel(a, b)
      if (typeof r !== 'number' || !Number.isFinite(r)) throw new Error(`${impl.name}('${a}','${b}') 返回非有限数：${String(r)}`)
      return Math.sign(r)
    }
  }
  return (a, b) => {
    const gt = impl.rel(a, b)
    if (typeof gt !== 'boolean') throw new Error(`${impl.name}('${a}','${b}') 返回非布尔：${String(gt)}`)
    return gt ? 1 : (impl.rel(b, a) ? -1 : 0)
  }
}

// ── 用例矩阵（≥20 条；每条都带**期望关系**，所以"三份一起错"也会被抓）──────────────
const CASES = [
  ['0.2.1', '0.2.1-rc.2', 1, '正式版 > 同号预发布（审计 P0-1 的核心）'],
  ['0.2.1-rc.2', '0.2.1', -1, '反向'],
  ['0.2.1-rc.10', '0.2.1-rc.9', 1, '预发布数字标识符按**数值**比（字符串比会把 rc.10 判小）'],
  ['0.2.1-rc.9', '0.2.1-rc.10', -1, '反向'],
  ['0.2.1-alpha.3', '0.2.1-rc.1', -1, '字母标识符按 ASCII：alpha < rc'],
  ['0.2.1-rc.1', '0.2.1-alpha.3', 1, '反向'],
  ['0.2.1-rc.2', '0.2.1-rc.2', 0, '相等（带预发布）'],
  ['0.2.1', '0.2.1', 0, '相等（正式版）'],
  ['1.0.0', '1.0.0', 0, '相等（主版本线）'],
  ['0.2.1', '0.2.1-alpha', 1, '正式版 vs 单段预发布'],
  ['0.2.1-alpha', '0.2.1-alpha.1', -1, '预发布段数少者小（缺段 < 非空段）'],
  ['0.2.1-alpha.1', '0.2.1-alpha', 1, '反向'],
  ['0.2.1-beta.2', '0.2.1-beta.11', -1, '同前缀、数字段按数值（2 < 11）'],
  ['0.2.1-rc.2', '0.2.1-alpha.3', 1, '同为预发布：rc > alpha'],
  ['0.2.1', '0.2.0', 1, '补丁号'],
  ['0.2.1', '0.3.0', -1, '次版本号'],
  ['0.3.0', '0.2.9', 1, '次版本优先于补丁'],
  ['1.0.0', '0.9.9', 1, '主版本号'],
  ['0.2.1-rc.2', '0.2.0', 1, '预发布 vs 更低的正式版：先比主次补丁'],
  ['0.2.0', '0.2.1-rc.2', -1, '反向'],
  ['0.1.7-rc.2', '0.1.7-rc.1', 1, '地板线上的实际取值（壳地板 0.1.7-rc.1/2）'],
  ['0.2.1-rc.2', '0.1.7-rc.1', 1, '跨次版本 + 预发布混合'],
  ['0.2.1-alpha', '0.2.1-alpha-1', -1, '多段预发布保留（slice(1).join("-")）：alpha < alpha-1'],
  ['0.0.0', '0.0.0', 0, '全零'],
]

const failures = []
console.log(`版本比较 parity：root=${ROOT}`)
console.log('  抽出的实现（源文本逐字，未复制实现）：')
for (const n of extractionNotes) console.log(`    ${n}`)
console.log(`  用例矩阵：${CASES.length} 条\n`)

const R = impls.map((impl) => ({ impl, rel: relOf(impl) }))
for (const [a, b, expected, why] of CASES) {
  const results = []
  for (const { impl, rel } of R) {
    try { results.push({ name: impl.name, value: rel(a, b) }) } catch (error) { results.push({ name: impl.name, value: `ERR:${error.message}` }) }
  }
  const values = results.map((r) => r.value)
  const agree = values.every((v) => v === values[0])
  if (!agree) {
    failures.push(`结论不一致：cmp('${a}','${b}') → ${results.map((r) => `${r.name}=${r.value}`).join(' | ')}（期望 ${expected}；${why}）`)
    continue
  }
  if (values[0] !== expected) {
    failures.push(`三份一致但与语义期望不符：cmp('${a}','${b}') → ${values[0]}，期望 ${expected}（${why}）—— 可能是三份一起错`)
  }
}

// ── 域外输入：只打印，不判定（见文件头说明）────────────────────────────────
const EXTRA = [
  ['0.2.x', '0.2.0'],
  ['1.0.0+build.5', '1.0.0'],
  ['0.2.1-rc.2+build.1', '0.2.1-rc.2'],
]
const extraLines = []
for (const [a, b] of EXTRA) {
  const pairs = R.map(({ impl, rel }) => {
    const short = `${impl.name.split(' ')[0]}`
    try { return { short, value: String(rel(a, b)) } } catch { return { short, value: 'ERR' } }
  })
  const distinct = new Set(pairs.map((p) => p.value))
  extraLines.push(`  ${a} vs ${b}: ${pairs.map((p) => `${p.short}=${p.value}`).join(' | ')}${distinct.size > 1 ? '   ← 域外差异（不计入判定）' : '   ← 三份结论一致'}`)
}

console.log(`域外输入（非 semver；仅记录，不参与退出码）：`)
for (const l of extraLines) console.log(l)

if (failures.length) {
  console.error(`\nFAIL — 三份版本比较实现不一致（${failures.length} 项）：`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  console.error('\n修法：以 dsh-watch 的 cmp 语义为准（正式版 > 同号预发布；预发布数字段按数值、字母段按 ASCII），'
    + '三份**同一次**改齐。共享方案见本文件头部注释（A：scripts/lib 由 watch/probe 共用；B：随包 manager 目录三处共用）。')
  process.exit(1)
}
console.log(`\nPASS — ${CASES.length} 条用例：三份实现（watch cmp / probe cmp / manager versionGt）结论完全一致`)
