#!/usr/bin/env node
// 门禁：预装插件必须与壳**强制执行的 dsh 地板**兼容。
//
// 为什么需要它：2026-09-25 真机事故 —— 壳把 dsh 地板抬到 0.1.7-rc.2，而打包的预装插件
// dsh-model-reasoning 0.2.4 的客户端 `inject` 里仍声明 `settingsScope`（0.1.7 已移除该
// 客户端服务），dsh 的 web boot 对未激活条目是 **fail-closed**：页面直接停在
// 「Failed to load plugins / dsh-model-reasoning: pending (waiting for service: settingsScope)」，
// 整个 Web UI 打不开。当时所有源码侧门禁都是绿的 —— 因为没有任何一道门禁把
// 「插件要求的 dsh 能力」与「壳强制的 dsh 地板」放在一起看。
//
// 本门禁查三件事（判据全部可失败，见 scripts/test-plugin-dsh-compat 的负向对照记录）：
//   1. **已移除服务的用法**：地板 ≥ 某服务被移除的版本时，插件客户端产物（**去掉注释后**）
//      不得再出现该服务名 → FAIL。这是上述事故的静态形态。
//   2. **声明的 peer 地板必须被壳地板满足**：插件若声明了 `@deepseek-ai/dsh*` 的
//      peerDependencies，壳的 MIN_DSH_VERSION 必须落在该范围里 → 否则 FAIL。
//   3. **完全未声明 dsh 地板** → 只**警告**并列出（缺声明不是破坏性证据，但必须可见；
//      把它做成 FAIL 会让门禁变成"所有插件都得先改一遍"的噪音门禁）。
//
// 前提：dsh 与 `@deepseek-ai/*` 平台包**同版本行发布**（lockstep）。已实测两套运行时：
//   0.1.6-alpha.1：dsh / dsh-client-ui-settings / dsh-client-locale 都是 0.1.6-alpha.1
//   0.1.7-rc.2  ：同上（含 dsh-client-ui-slots）
// 若上游改为分包独立版本，本门禁的 peer 比较需要改成读平台包自己的版本。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const warnings = []

// ── 已移除的客户端服务表（新增条目时必须写清 removedIn 与替代品）──────────────
const REMOVED_SERVICES = [
  {
    service: 'settingsScope',
    removedIn: '0.1.7',
    replacement: "ctx.configForms.get<T>(ns)（ConfigForm 与旧 SettingsScope 同形；写路径仍走 ctx.remote.settings）",
    evidence: 'dsh 0.1.6 的 @deepseek-ai/* 有 18 个文件提供/使用它；0.1.7 全树 0 命中（官方源码 src/ 亦 0）',
  },
]

// ── semver（只实现门禁需要的形式，并自带自检）────────────────────────────────
const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}
const cmpPre = (a, b) => {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1 // 有 prerelease 的 < 无 prerelease 的
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      if (+x !== +y) return +x > +y ? 1 : -1
    } else if (nx !== ny) {
      return nx ? -1 : 1 // 数字标识符 < 字母标识符
    } else if (x !== y) {
      return x > y ? 1 : -1
    }
  }
  return 0
}
const compare = (a, b) => {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) throw new Error(`非 semver 版本：${a} / ${b}`)
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1
  }
  return cmpPre(pa.pre, pb.pre)
}
const bump = (v, part) => {
  const p = parse(v)
  if (part === 'minor') return `${p.major}.${p.minor + 1}.0`
  if (part === 'patch') return `${p.major}.${p.minor}.${p.patch + 1}`
  return `${p.major + 1}.0.0`
}
/** caret 上界（semver 规则：0.x 的"最左非零位"才是破坏性轴）。
 *  ^1.2.3 → <2.0.0；^0.1.7 → <0.2.0；^0.0.3 → <0.0.4 */
const caretUpper = (v) => {
  const p = parse(v)
  if (p.major > 0) return bump(v, 'major')
  if (p.minor > 0) return bump(v, 'minor')
  return bump(v, 'patch')
}
/** 单个比较器求值；includePrerelease 只影响"是否允许 prerelease 版本匹配"。 */
const testComparator = (v, op, bound, includePrerelease) => {
  const pv = parse(v)
  const pb = parse(bound)
  if (pv.pre.length > 0 && !includePrerelease) {
    // 默认语义：prerelease 版本只在比较器自身也带 prerelease 时才可能匹配
    if (pb.pre.length === 0) return false
  }
  const c = compare(v, bound)
  switch (op) {
    case '>=': return c >= 0
    case '>': return c > 0
    case '<=': return c <= 0
    case '<': return c < 0
    case '^': return c >= 0 && compare(v, caretUpper(bound)) < 0
    case '~': return c >= 0 && compare(v, bump(bound, 'minor')) < 0
    case '': return c === 0
    default: throw new Error(`不支持的比较符：${op}`)
  }
}
const satisfies = (v, range, { includePrerelease = true } = {}) => {
  for (const part of String(range).trim().split(/\s+/)) {
    const m = /^(>=|<=|>|<|\^|~)?(.+)$/.exec(part)
    if (!m) return false
    if (!testComparator(v, m[1] ?? '', m[2], includePrerelease)) return false
  }
  return true
}

// 自检：比较器自身必须可信，否则这道门禁是假的
const SELF_TESTS = [
  ['0.1.7-rc.2', '>=0.1.7-rc.1', true, 'rc.2 > rc.1'],
  ['0.1.7-rc.2', '>=0.1.7', false, 'prerelease 小于同版本正式版（排序优先于 includePrerelease 规则）'],
  ['0.1.7', '>=0.1.7', true, '等值'],
  ['0.1.6-alpha.1', '>=0.1.7-rc.1', false, '旧于地板'],
  ['0.1.7-rc.2', '^0.1.7-rc.1', true, 'caret 下界'],
  ['0.2.0', '^0.1.7', false, 'caret 上界'],
  ['0.1.7-rc.2', '>=0.1.7-rc.1 <0.2.0', true, '区间'],
  ['0.1.8', '~0.1.7', true, 'tilde 允许补丁级变化（~0.1.7 → <0.2.0）'],
  ['0.2.0', '~0.1.7', false, 'tilde 上界'],
  ['0.0.4', '^0.0.3', false, 'caret 的 0.0.x 只允许补丁'],
  ['0.1.9', '^0.1.7', true, 'caret 的 0.x.y 允许补丁'],
  ['0.1.7-rc.2', '^0.1.7-rc.1', true, 'caret 下界含 prerelease'],
]
for (const [v, range, expected, why] of SELF_TESTS) {
  const got = satisfies(v, range)
  if (got !== expected) {
    failures.push(`比较器自检失败：satisfies('${v}','${range}') 期望 ${expected} 实得 ${got}（${why}）`)
  }
}

/** 版本行比较（只看 major.minor.patch，忽略 prerelease）。
 *  用于"某服务自哪个版本行起被移除"的判定：0.1.7-rc.2 与 0.1.7 同属 0.1.7 行。 */
const sameLineOrLater = (version, line) => {
  const a = parse(version)
  const b = parse(line)
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] > b[k]
  }
  return true
}

// ── 壳强制的 dsh 地板 ────────────────────────────────────────────────────────
const managerSrc = readFileSync(join(root, 'scripts', 'server-manager.mjs'), 'utf8')
const floor = /MIN_DSH_VERSION\s*=\s*'([^']+)'/.exec(managerSrc)?.[1]
if (!floor) {
  failures.push('读不到 scripts/server-manager.mjs 的 MIN_DSH_VERSION')
} else {
  console.log(`壳强制的 dsh 地板（MIN_DSH_VERSION）= ${floor}`)
}

// ── 注释剥离（插件产物保留了 doc 注释，注释里出现服务名不等于使用）─────────────
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

// ── 逐个预装插件检查 ────────────────────────────────────────────────────────
const preinstalledRoot = join(root, 'plugins', 'preinstalled')
const dirs = readdirSync(preinstalledRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
let checked = 0
for (const dir of dirs) {
  const pkgPath = join(preinstalledRoot, dir.name, 'package.json')
  if (!existsSync(pkgPath)) {
    failures.push(`plugins/preinstalled/${dir.name}/package.json 缺失（不是可识别的插件包）`)
    continue
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const label = `${pkg.name}@${pkg.version}`
  checked += 1

  // ① 已移除服务的用法（去注释后匹配整个词）
  const clientPath = join(preinstalledRoot, dir.name, 'lib', 'client.js')
  if (existsSync(clientPath)) {
    const code = stripComments(readFileSync(clientPath, 'utf8'))
    for (const entry of REMOVED_SERVICES) {
      // 按"版本行"判（忽略 prerelease）：0.1.7-rc.2 已落在 0.1.7 行内，移除已生效 ——
      // 用严格 semver 比较会把 rc 行误判成"还没到 0.1.7"，从而漏掉真实事故。
      if (!sameLineOrLater(floor, entry.removedIn)) continue
      const hits = (code.match(new RegExp(`(^|[^\\w$.])${entry.service}(?!\\w)`, 'g')) ?? []).length
      if (hits > 0) {
        failures.push(
          `${label}: 客户端产物仍在用已移除的服务 "${entry.service}"（${hits} 处；${entry.service} 在 dsh ${entry.removedIn} 被移除，` +
          `而壳强制地板 ${floor} 已在其后）。dsh 的 web boot 对未激活条目 fail-closed → 整个 UI 会停在「Failed to load plugins」。` +
          `替代：${entry.replacement}。证据：${entry.evidence}`,
        )
      }
    }
  }

  // ②/③ peer 地板
  const peers = Object.entries(pkg.peerDependencies ?? {}).filter(([k]) => /^@deepseek-ai\/dsh($|-)/.test(k))
  if (peers.length === 0) {
    warnings.push(`${label}: 未声明任何 @deepseek-ai/dsh* 的 peer 地板 —— 无法静态证明它与地板 ${floor} 兼容（建议插件侧声明）`)
  }
  for (const [name, range] of peers) {
    if (!satisfies(floor, range)) {
      failures.push(`${label}: 它要求 ${name} "${range}"，但壳强制的地板是 ${floor} → 该组合下插件不会激活（UI 卡死）`)
    }
  }
}

// ── 结果 ────────────────────────────────────────────────────────────────────
console.log(`已检查 ${checked} 个预装插件；警告 ${warnings.length} 条`)
for (const w of warnings) console.log(`  ⚠️  ${w}`)
if (failures.length > 0) {
  console.error(`\nFAIL — 预装插件与 dsh 地板不兼容（${failures.length} 项）：`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  console.error('\n修法二选一：① 同步插件到已适配的版本（技能 dsh-preinstalled-plugin-sync §6.5）② 下调 MIN_DSH_VERSION 到插件支持的版本。')
  process.exit(1)
}
console.log('\nPASS — 预装插件与壳强制的 dsh 地板兼容（已移除服务无残留用法；声明的 peer 地板均被满足）')
