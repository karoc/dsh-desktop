// 预装插件与 dsh 地板的**运行时**守卫（纯逻辑，manager 在启动 dsh web 之前调用）。
//
// 背景（2026-09-25 真机事故）：dsh 0.1.7 移除了客户端服务 `settingsScope`，而预装插件
// dsh-model-reasoning 0.2.4 仍声明它 → 插件 fiber 永远 pending，而 dsh 的 web boot 对
// 未激活条目 **fail-closed** → 整个 Web UI 停在「Failed to load plugins」打不开。
// 静态门禁（scripts/test-plugin-dsh-compat.mjs）管的是"**打包时**的搭配"；本模块管
// "**运行时**的搭配"：用户回退 dsh、离线导致地板升级失败、或 plugins 与 dsh 被单独
// 升降级时，运行时仍可能处于"插件要求的能力 > 已装 dsh"的不一致态。
//
// 两条处置（都只在**插件自己声明了** dsh 地板且地板不被满足时触发 —— 没声明就没有
// 证据说它不兼容，绝不动它）：
//   1. skipInstall：不要把该插件的（新）副本装进 runtime —— 装了也不会激活。
//   2. quarantine ：把**已启用**的该插件从 profile bundles 里摘掉（先备份 manifest），
//      否则 dsh web 起不来。摘掉 ≠ 删除：文件仍在 runtime，dsh 升到地板以上后
//      （下一轮守卫）会因为它仍能通过地板校验而**不再被隔离**，用户可在插件页重新启用。
//
// 负向保证：不动 `@deepseek-ai/*`（那是 dsh 自身）；不动没有声明地板的插件；
// 不删除任何文件；不修改 dsh 自身的 manifest（只改 profile bundles 列表）。

/** 极简 semver（只覆盖插件实际使用的形式；自检见 selfTest）。 */
export const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v ?? '').trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}

const cmpPre = (a, b) => {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1 // 带 prerelease 的 < 不带
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

export const compare = (a, b) => {
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
/** caret 上界：0.x 的"最左非零位"才是破坏性轴（^0.1.7 → <0.2.0；^0.0.3 → <0.0.4）。 */
const caretUpper = (v) => {
  const p = parse(v)
  if (p.major > 0) return bump(v, 'major')
  if (p.minor > 0) return bump(v, 'minor')
  return bump(v, 'patch')
}

/** 版本 V 是否满足范围 R（支持 >=、>、<=、<、^、~、精确、空格并列）。
 *  includePrerelease 默认 true：dsh 自己的 peer 闸门就是按 includePrerelease 语义判定的。 */
export const satisfies = (v, range, { includePrerelease = true } = {}) => {
  for (const part of String(range).trim().split(/\s+/)) {
    const m = /^(>=|<=|>|<|\^|~)?(.+)$/.exec(part)
    if (!m) return false
    const op = m[1] ?? ''
    const bound = m[2]
    const pv = parse(v)
    const pb = parse(bound)
    if (!pv || !pb) return false
    if (pv.pre.length > 0 && !includePrerelease && pb.pre.length === 0) return false
    const c = compare(v, bound)
    const ok = op === '>=' ? c >= 0
      : op === '>' ? c > 0
        : op === '<=' ? c <= 0
          : op === '<' ? c < 0
            : op === '^' ? c >= 0 && compare(v, caretUpper(bound)) < 0
              : op === '~' ? c >= 0 && compare(v, bump(bound, 'minor')) < 0
                : c === 0
    if (!ok) return false
  }
  return true
}

/** 从插件 package.json 提取它对 dsh 平台的地板声明（@deepseek-ai/dsh* 的 peerDependencies）。 */
export const collectDshFloors = (pkgJson) =>
  Object.entries(pkgJson?.peerDependencies ?? {})
    .filter(([name]) => /^@deepseek-ai\/dsh($|-)/.test(name))
    .map(([name, range]) => ({ name, range }))

/**
 * 生成运行时守卫计划（纯函数）。
 * @param {{installedDsh: string|null, bundled: Array<{name:string, version?:string, pkgJson?:object}>, enabled: string[]}} input
 *   installedDsh：runtime 里实际装着的 dsh 版本（null = 还没装，不做判断）
 *   bundled    ：resources 里随壳分发的预装插件
 *   enabled    ：profile bundles 当前启用列表
 * @returns {{skipInstall: Array, quarantine: Array, warnings: string[]}}
 */
export const planPluginGuard = ({ installedDsh, bundled = [], enabled = [] }) => {
  const skipInstall = []
  const quarantine = []
  const warnings = []
  if (!installedDsh || !parse(installedDsh)) {
    // dsh 还没装或版本不可解析：没有可比的基准，什么都不动（避免误伤）
    return { skipInstall, quarantine, warnings: ['dsh 版本未知 → 跳过地板守卫'] }
  }
  const judge = (name, pkgJson) => {
    const floors = collectDshFloors(pkgJson)
    if (floors.length === 0) return { floors, unsatisfied: null }
    const bad = floors.find(({ range }) => {
      try { return !satisfies(installedDsh, range) } catch { return false }
    })
    return { floors, unsatisfied: bad ?? null }
  }
  // ① 预装插件：地板不满足就不要装进 runtime（装了也不激活）
  for (const item of bundled) {
    const { unsatisfied } = judge(item.name, item.pkgJson)
    if (unsatisfied) {
      skipInstall.push({ name: item.name, version: item.version ?? null, floor: unsatisfied.range, requires: unsatisfied.name })
    }
  }
  // ② 已启用的插件：地板不满足必须从 bundles 摘掉，否则 dsh web 起不来
  for (const name of enabled) {
    if (name.startsWith('@deepseek-ai/')) continue // dsh 自身，永不隔离
    const item = bundled.find((b) => b.name === name)
    if (!item) continue // 用户自装插件：我们不知道它的地板声明（未随壳分发），不动
    const { floors, unsatisfied } = judge(name, item.pkgJson)
    if (!unsatisfied) {
      if (floors.length === 0) warnings.push(`${name} 未声明 dsh 地板 → 无法判断兼容性，保持启用`)
      continue
    }
    quarantine.push({ name, version: item.version ?? null, floor: unsatisfied.range, requires: unsatisfied.name })
  }
  return { skipInstall, quarantine, warnings }
}

/** 自检（被门禁与单测调用；不自证：这些是 semver 的既有语义）。 */
export const selfTest = () => {
  const cases = [
    ['0.1.7-rc.2', '>=0.1.7-rc.1', true],
    ['0.1.6-alpha.1', '>=0.1.7-rc.1', false],
    ['0.1.7-rc.2', '>=0.1.7', false], // prerelease 小于同版本正式版
    ['0.1.9', '^0.1.7', true],
    ['0.2.0', '^0.1.7', false],
    ['0.0.4', '^0.0.3', false],
    ['0.1.8', '~0.1.7', true],
    ['0.2.0', '~0.1.7', false],
    ['0.1.7-rc.2', '>=0.1.7-rc.1 <0.2.0', true],
  ]
  return cases.map(([v, range, expected]) => ({ v, range, expected, got: satisfies(v, range), ok: satisfies(v, range) === expected }))
}
