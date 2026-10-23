#!/usr/bin/env node
// gh 凭据纪律门禁（2026-10-24，`npm test` 链上的一员）：禁止把 `GH_BIN` 缺省成裸 `gh`。
//
// 背景：本仓有两个 PAT —— 项目专用的 fine-grained token 在 `~/.config/gh-dsh-desktop/token`，
// 由 `./scripts/gh` 注入 GH_TOKEN；全局 `~/.config/gh/hosts.yml` 里还有另一个 token（同账号、权限不同）。
// 脚本若把 `GH_BIN` 缺省成裸 `gh`，就会**静默**落到后者：`dsh-watch.mjs` 上已真实发生
// （`const GH = process.env.GH_BIN ?? 'gh'`），而修复版还曾因漏导入 `existsSync` 在兜底分支运行时
// ReferenceError。所以这里把纪律变成**可失败**的断言，而不是靠人记得：
//
//   ① `scripts/**/*.mjs` 不得把 `GH_BIN` 缺省成裸 `gh`（`??` 与等价的 `||` 都算；命中列 file:line）；
//   ② 已知 gh 消费者（dsh-watch / dsh-release-autopilot / dsh-sla-report / dsh-doctor）必须把缺省值
//      解析到仓库内的 `scripts/gh`（删掉兜底、退回裸 `gh` 都判红）；
//   ③ 仓库里给出的 systemd unit 模板（脚本头注释 / README / docs 的 fenced block）只要 `ExecStart=`
//      启动上述脚本，就必须显式 `Environment=GH_BIN=…/scripts/gh` —— 不能缺，也不能是裸 `gh`。
//
// 为什么需要 ③：仓库**不托管** `.service` / `.timer` 文件（模板只写在文档与头注释里，真正安装的是
// 用户机器上的 unit）。门禁只能对"仓库里写下的模板"负责；将来模板搬家时 ③ 会因"一个模板都找不到"
// 而红，提醒把断言迁过去，而不是静默放行。CI 的 workflow 显式 `GH_BIN=gh`（runner 上没有 token 文件）
// —— 那是显式注入、不是缺省值，①/②/③ 都不针对它。
//
// 负向对照（本套件自带，防恒真门禁）：判据必须能对合成夹具红/绿 —— 把 findBareGhDefaults 改成恒返回
// 空数组、或把模板检查改成恒通过，下面的自检会立刻失败。外部变异（/tmp 副本）：
//   把 ① 的 BARE_GH_DEFAULT 改成 /(?!)/ ⇒ 本套件 exit 1。
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SELF = fileURLToPath(import.meta.url)
const GH_CONSUMERS = ['dsh-watch.mjs', 'dsh-release-autopilot.mjs', 'dsh-sla-report.mjs', 'dsh-doctor.mjs']

let failures = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}\n     ${error.message}`)
  }
}
const rel = (p) => relative(ROOT, p)

function listFiles(dir, ext) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(p, ext))
    else if (entry.name.endsWith(ext)) out.push(p)
  }
  return out.sort()
}

// ── 判据 ①：裸 gh 缺省 ────────────────────────────────────────────────────
// 只认"缺省值"：`GH_BIN ?? 'gh'` / `GH_BIN || 'gh'`。测试里给子进程显式注入的 `GH_BIN: 'gh'`
// 是注入、不是缺省，刻意不算。
const BARE_GH_DEFAULT = /GH_BIN\s*(\?\?|\|\|)\s*['"]gh['"]/
const findBareGhDefaults = (source) => source
  .split('\n')
  .map((text, i) => ({ line: i + 1, text: text.trim() }))
  .filter((hit) => BARE_GH_DEFAULT.test(hit.text))

check('自检：裸 gh 缺省判据能红也能绿（防恒假/恒真）', () => {
  const cases = [
    ["const GH = process.env.GH_BIN ?? 'gh'", 1, '?? 单引号'],
    ['const GH = process.env.GH_BIN ?? "gh"', 1, '?? 双引号'],
    ["const GH = process.env.GH_BIN || 'gh'", 1, '|| 等价兜底'],
    ["const GH = process.env.GH_BIN ?? 'scripts/gh'", 0, '相对路径指向 wrapper'],
    ["const GH = process.env.GH_BIN ?? (existsSync(join(ROOT, 'scripts', 'gh')) ? join(ROOT, 'scripts', 'gh') : 'gh')", 0, '先探测 wrapper、最后才退裸 gh'],
    ["GH_BIN: 'gh', // 测试桩注入", 0, '显式注入不是缺省'],
  ]
  for (const [src, want, label] of cases) {
    const got = findBareGhDefaults(src).length
    assert.equal(got, want, `${label}: 判据返回 ${got}，期望 ${want}（${src}）`)
  }
})

check('① scripts/ 下没有把 GH_BIN 缺省成裸 gh 的写法', () => {
  const files = listFiles(join(ROOT, 'scripts'), '.mjs').filter((p) => p !== SELF)
  assert.ok(files.length >= 20, `扫描到的脚本只有 ${files.length} 个 —— 目录结构变了？`)
  const names = new Set(files.map((p) => p.split(/[\\/]/).pop()))
  for (const name of GH_CONSUMERS) assert.ok(names.has(name), `已知 gh 消费者 ${name} 不在扫描范围`)

  const hits = files.flatMap((p) => findBareGhDefaults(readFileSync(p, 'utf8'))
    .map((h) => `${rel(p)}:${h.line}: ${h.text}`))
  assert.equal(hits.length, 0,
    `发现裸 gh 缺省（会落到 ~/.config/gh/hosts.yml 里的另一个 PAT）：\n       ${hits.join('\n       ')}`)
})

// ── 判据 ②：已知消费者的缺省值必须兜底到 scripts/gh ──────────────────────
check(`② 已知 gh 消费者缺省值兜底到 scripts/gh（${GH_CONSUMERS.length} 个）`, () => {
  const problems = []
  for (const name of GH_CONSUMERS) {
    const src = readFileSync(join(ROOT, 'scripts', name), 'utf8')
    if (!/GH\w*\s*=\s*process\.env\.GH_BIN\b/.test(src)) {
      problems.push(`${name}: 没有从 process.env.GH_BIN 解析 gh`)
      continue
    }
    if (!/'scripts',\s*'gh'|"scripts",\s*"gh"|['"]scripts\/gh['"]/.test(src)) {
      problems.push(`${name}: 缺省值没有兜底到 scripts/gh`)
    }
  }
  assert.equal(problems.length, 0, problems.join('\n     '))
})

// ── 判据 ③：systemd unit 模板 ─────────────────────────────────────────────
const GH_BIN_TEMPLATE_TARGET = /scripts[\\/](?:dsh-watch|dsh-release-autopilot|dsh-sla-report|dsh-doctor|dsh-token-meta)\.mjs/
const TEMPLATE_HEADER = /^\s*\[(Unit|Service|Install)\]/

/** `//` 注释里连写的块（脚本头注释里的模板）。 */
function commentBlocks(source) {
  const blocks = []
  let cur = null
  source.split('\n').forEach((line, i) => {
    if (/^\s*\/\//.test(line)) {
      if (!cur) cur = { start: i + 1, lines: [] }
      cur.lines.push(line.replace(/^\s*\/\/\s?/, ''))
    } else if (cur) {
      blocks.push(cur)
      cur = null
    }
  })
  if (cur) blocks.push(cur)
  return blocks.filter((b) => b.lines.some((l) => TEMPLATE_HEADER.test(l)))
}

/** Markdown fenced block（```...```）。 */
function fenceBlocks(source) {
  const blocks = []
  let cur = null
  source.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      if (cur) {
        blocks.push(cur)
        cur = null
      } else {
        cur = { start: i + 2, lines: [] }
      }
    } else if (cur) {
      cur.lines.push(line)
    }
  })
  return blocks.filter((b) => b.lines.some((l) => TEMPLATE_HEADER.test(l)))
}

/** 返回该模板块的违规列表；没有 ExecStart 启动 gh 消费者 ⇒ 不是"gh 相关模板"，返回空。 */
function templateViolations(block) {
  const text = block.lines.join('\n')
  const exec = text.match(/^\s*ExecStart=.*$/m)
  if (!exec || !GH_BIN_TEMPLATE_TARGET.test(exec[0])) return []
  const env = text.match(/^\s*Environment=GH_BIN=(\S+)\s*$/m)
  if (!env) return ['缺少 Environment=GH_BIN=（systemd 下裸 gh 会落到另一个 PAT）']
  if (!/(?:^|[\\/])scripts[\\/]gh$/.test(env[1])) return [`Environment=GH_BIN=${env[1]} 没指向 scripts/gh`]
  return []
}

check('自检：unit 模板判据能红也能绿（防恒假/恒真）', () => {
  const block = (lines) => ({ start: 1, lines })
  const cases = [
    [block(['[Service]', 'ExecStart=/usr/bin/node %h/dsh-desktop/scripts/dsh-watch.mjs',
      'Environment=GH_BIN=%h/dsh-desktop/scripts/gh']), 0, '完整模板'],
    [block(['[Service]', 'ExecStart=/usr/bin/node %h/dsh-desktop/scripts/dsh-watch.mjs']), 1, '缺 GH_BIN'],
    [block(['[Service]', 'ExecStart=/usr/bin/node %h/dsh-desktop/scripts/dsh-watch.mjs',
      'Environment=GH_BIN=gh']), 1, 'GH_BIN 指向裸 gh'],
    [block(['[Service]', 'ExecStart=/usr/sbin/logrotate -s %h/.dsh/status %h/.dsh/logrotate.conf']), 0, '非 gh 模板'],
  ]
  for (const [b, want, label] of cases) {
    const got = templateViolations(b).length
    assert.equal(got, want, `${label}: 判据返回 ${got}，期望 ${want}`)
  }
})

check('③ 文档/头注释里的 systemd unit 模板给 gh 消费者显式 GH_BIN=scripts/gh', () => {
  const mdFiles = [join(ROOT, 'README.md'), join(ROOT, 'CONTRIBUTING.md'), ...listFiles(join(ROOT, 'docs'), '.md')]
  const scriptFiles = listFiles(join(ROOT, 'scripts'), '.mjs').filter((p) => p !== SELF)
  const blocks = []
  for (const file of mdFiles) {
    for (const b of fenceBlocks(readFileSync(file, 'utf8'))) blocks.push({ ...b, file })
  }
  for (const file of scriptFiles) {
    for (const b of commentBlocks(readFileSync(file, 'utf8'))) blocks.push({ ...b, file })
  }

  const ghTemplates = []
  const problems = []
  for (const b of blocks) {
    const text = b.lines.join('\n')
    const exec = text.match(/^\s*ExecStart=.*$/m)
    if (!exec || !GH_BIN_TEMPLATE_TARGET.test(exec[0])) continue
    ghTemplates.push(b)
    for (const problem of templateViolations(b)) problems.push(`${rel(b.file)}:${b.start}（${exec[0].trim()}）：${problem}`)
  }

  assert.ok(ghTemplates.length >= 1,
    '仓库里找不到任何"ExecStart 启动 gh 消费者"的 systemd unit 模板 —— 若模板已搬家，请把本断言的扫描位置一起迁过去（不许静默放行）')
  assert.equal(problems.length, 0, problems.join('\n     '))
  console.log(`     （核验了 ${ghTemplates.length} 个 gh 相关 unit 模板：${ghTemplates.map((b) => rel(b.file)).join(' / ')}）`)
})

if (failures > 0) {
  console.error(`\nFAILED: ${failures} 项（gh 凭据纪律：GH_BIN 缺省必须指向 scripts/gh）`)
  process.exit(1)
}
console.log('\nPASS: gh 凭据纪律（裸 gh 缺省扫描 + 消费者兜底 + unit 模板 GH_BIN）')
