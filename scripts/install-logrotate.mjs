#!/usr/bin/env node
// logrotate 模板的**带守卫安装**（2026-10-31，看板卡「logrotate 模板健壮化」）。
//
// 背景：本机曾把 `scripts/logrotate.dsh.conf` **原样拷**成 `~/.dsh/logrotate.dsh.conf`
// （没有把 `@HOME@` 换成真实 HOME），logrotate 报
// `lines must begin with a keyword or a filename`，配置长期不生效、日志一直没轮转。
// 模板里的占位符是给人替换的，所以"安装"这一步必须有守卫，而不是再写一句 sed：
//   - 替换后仍含 `@HOME@`       ⇒ 拒绝安装（不落盘）；
//   - 内容为空                  ⇒ 拒绝；
//   - 日志路径不是绝对路径      ⇒ 拒绝；
//   - 系统里有 logrotate        ⇒ 用临时文件跑 `logrotate -d`，失败同样不落盘；
//   - 全部通过才**原子写入**（同目录 tmp + rename，权限 0600），任何失败旧文件保持原样。
//
// 为什么替换用 split/join（等价 replaceAll）而不是 `String.replace('@HOME@', home)`：
// 后者只替换**第一处**，多行模板会留下一串 `@HOME@` —— 那正是事故形态。残留检查保留为
// 第二道防线（`--home` 本身含字面 `@HOME@`、或将来模板新增别的占位符时仍会装出坏配置）。
//
// 用法：
//   node scripts/install-logrotate.mjs [--dry-run] [--home <dir>] [--dest <path>]
//                                      [--template <path>] [--no-check]
// 退出码：0 成功（含 --dry-run）；1 校验或写盘失败（旧文件未被改动）；2 用法错误。
//
// 只做"生成并落盘配置"这一件事：不装 systemd unit、不动 `/etc`、不重启任何服务。
import { spawnSync } from 'node:child_process'
import {
  accessSync, chmodSync, closeSync, constants as fsConstants, existsSync, fsyncSync,
  mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLACEHOLDER = '@HOME@'
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const DEFAULT_TEMPLATE = join(dirname(SCRIPT_PATH), 'logrotate.dsh.conf')
const USAGE = `用法：node scripts/install-logrotate.mjs [选项]

  --dry-run             只替换 + 校验 + 打印目标路径/字节数/结论/内容，不写目标文件
  --home <dir>          HOME 目录，用来替换模板里的 ${PLACEHOLDER}（默认 $HOME）
  --dest <path>         目标配置路径（默认 <home>/.dsh/logrotate.dsh.conf）
  --template <path>     模板路径（默认 scripts/logrotate.dsh.conf）
  --no-check            跳过 logrotate -d 语法干跑（仍然做内容校验）
  -h, --help            显示本帮助

退出码：0 成功；1 校验或写盘失败（旧文件未被改动）；2 用法错误。
本脚本只写目标配置文件；不安装 systemd timer、不碰 /etc、不重启服务。`

// 顶层指令不是日志路径（本模板里这两类只出现在注释中；/etc 版本才需要 su）。
const TOP_LEVEL_DIRECTIVES = new Set(['include', 'su', 'tabooext'])

class CliError extends Error {
  constructor(message, { exitCode = 1, hint = '', usage = false } = {}) {
    super(message)
    this.exitCode = exitCode
    this.hint = hint
    this.usage = usage
  }
}

const usageFail = (message) => new CliError(message, { exitCode: 2, usage: true })
const installFail = (message, hint = '') => new CliError(message, { hint })

const warn = (message) => console.error(`warn ${message}`)

// ── 参数 ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { dryRun: false, noCheck: false, help: false, home: null, dest: null, template: null }
  const readValue = (flag, index) => {
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('-')) {
      throw usageFail(`${flag} 缺少值`)
    }
    return next
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      opts.help = true
      continue
    }
    if (!arg.startsWith('--')) throw usageFail(`无法识别的参数：${arg}`)
    const eq = arg.indexOf('=')
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? null : arg.slice(eq + 1)
    if (flag === '--dry-run' || flag === '--no-check') {
      if (inline !== null) throw usageFail(`${flag} 不接受值`)
      opts[flag === '--dry-run' ? 'dryRun' : 'noCheck'] = true
      continue
    }
    if (flag === '--home' || flag === '--dest' || flag === '--template') {
      const value = inline !== null ? inline : readValue(flag, i)
      if (inline === null) i += 1
      if (value === '') throw usageFail(`${flag} 的值不能为空`)
      opts[flag.slice(2)] = value
      continue
    }
    throw usageFail(`未知选项：${arg}`)
  }
  return opts
}

function resolveHome(explicit) {
  let raw = explicit
  if (raw === null || raw === undefined) {
    raw = process.env.HOME
    if (!raw) {
      const fallback = homedir()
      warn(`未设置 HOME，回退到 os.homedir()：${fallback}`)
      raw = fallback
    }
  }
  const home = resolve(raw)
  let st
  try {
    st = statSync(home)
  } catch {
    throw usageFail(`--home 不存在或不可访问：${home}`)
  }
  if (!st.isDirectory()) throw usageFail(`--home 不是目录：${home}`)
  return home
}

function readTemplate(templatePath) {
  let st
  try {
    st = statSync(templatePath)
  } catch {
    throw usageFail(`--template 不存在或不可访问：${templatePath}`)
  }
  if (!st.isFile()) throw usageFail(`--template 不是文件：${templatePath}`)
  try {
    return readFileSync(templatePath, 'utf8')
  } catch (error) {
    throw installFail(
      `读取模板失败（${describeError(error)}）：${templatePath}`,
      '  修复提示：检查文件权限；或用 --template 显式指定可读的模板。',
    )
  }
}

// ── 内容校验 ────────────────────────────────────────────────────────────────
function validateContent(content) {
  const oks = []
  const problems = []

  if (content.includes(PLACEHOLDER)) {
    const count = content.split(PLACEHOLDER).length - 1
    const firstLine = content.slice(0, content.indexOf(PLACEHOLDER)).split(/\r?\n/).length
    problems.push(`目标内容仍含 ${PLACEHOLDER}（${count} 处，首次在第 ${firstLine} 行）`)
  } else {
    oks.push(`无残留 ${PLACEHOLDER}`)
  }

  if (content.trim() === '') {
    problems.push('目标内容为空')
  } else {
    oks.push(`非空（${Buffer.byteLength(content, 'utf8')} 字节）`)
  }

  const paths = extractLogPaths(content)
  if (paths.length === 0) {
    problems.push('未解析到任何日志路径行（配置里至少要有一行日志路径）')
  } else {
    const badPaths = paths.filter(({ token }) => !isAbsoluteLogPath(token))
    if (badPaths.length > 0) {
      for (const { token, lineNo } of badPaths.slice(0, 5)) {
        problems.push(`第 ${lineNo} 行的日志路径不是绝对路径：${token}`)
      }
      if (badPaths.length > 5) problems.push(`……另有 ${badPaths.length - 5} 条非绝对路径`)
    } else {
      oks.push(`${paths.length} 条日志路径均为绝对路径（如 ${stripQuotes(paths[0].token)}）`)
    }
  }

  return { oks, problems, paths }
}

/**
 * 抽出顶层（花括号之外）的日志路径行。
 *
 * logrotate 的配置形状：`<路径...> { <指令...> }`，路径可以一行多条、可以带引号，
 * `{` 既可以单独一行也可以跟在路径行尾。这里只找路径（用于"必须是绝对路径"校验），
 * 块内指令一律跳过；注释行不参与。
 */
function extractLogPaths(content) {
  const found = []
  let depth = 0
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line === '' || line.startsWith('#')) continue
    if (depth > 0) {
      depth = Math.max(0, depth + countBraces(line))
      continue
    }
    let pathPart = line
    let opens = 0
    while (pathPart.endsWith('{')) {
      pathPart = pathPart.slice(0, -1).trimEnd()
      opens += 1
    }
    if (pathPart !== '' && pathPart !== '}') {
      const tokens = pathPart.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
      const first = stripQuotes(tokens[0] ?? '')
      if (!TOP_LEVEL_DIRECTIVES.has(first)) {
        for (const token of tokens) found.push({ token, lineNo: i + 1 })
      }
    }
    depth += opens
  }
  return found
}

function countBraces(line) {
  let delta = 0
  let quote = null
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '{') {
      delta += 1
    } else if (ch === '}') {
      delta -= 1
    }
  }
  return delta
}

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

function isAbsoluteLogPath(token) {
  const path = stripQuotes(token)
  // logrotate 本身只跑在 POSIX 上；Windows 上仍允许盘符绝对路径，避免在非 POSIX
  // 平台把"内容校验"也变成不可用（语法检查那一步已经显式跳过并告警）。
  if (process.platform === 'win32') return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/')
  return path.startsWith('/')
}

// ── logrotate -d 语法干跑 ───────────────────────────────────────────────────
function resolveLogrotate(opts) {
  if (opts.noCheck) {
    console.log('    skip logrotate -d 语法干跑（--no-check）')
    return null
  }
  if (process.platform === 'win32') {
    warn('非 POSIX 平台（win32）：logrotate 不适用，跳过语法检查后继续')
    return null
  }
  const bin = findLogrotate()
  if (!bin) {
    warn('未找到 logrotate 可执行：跳过语法检查后继续（安装后建议手动 `logrotate -d` 复查）')
    return null
  }
  return bin
}

function findLogrotate() {
  const candidates = []
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir) candidates.push(join(dir, 'logrotate'))
  }
  // 很多发行版把 logrotate 放在 sbin，普通用户 PATH 里不一定有。
  for (const dir of ['/usr/sbin', '/sbin', '/usr/local/sbin', '/usr/bin', '/bin']) {
    candidates.push(join(dir, 'logrotate'))
  }
  return candidates.find(isExecutableFile) ?? null
}

function isExecutableFile(path) {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function checkSyntax(content, bin) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-logrotate-check-'))
  const configPath = join(dir, 'dsh.conf')
  try {
    // 校验用的是"替换后的输出"，不是原模板 —— 与最终要落盘的内容逐字节一致。
    writeFileSync(configPath, content, { mode: 0o600 })
    const res = spawnSync(bin, ['-d', configPath], { encoding: 'utf8', timeout: 30_000 })
    if (res.error) {
      return { ok: false, summary: `无法执行 ${bin}：${res.error.message}`, detail: '' }
    }
    if (res.status !== 0) {
      const summary = res.signal ? `被信号 ${res.signal} 终止` : `exit ${res.status}`
      return { ok: false, summary, detail: [res.stdout, res.stderr].filter(Boolean).join('\n') }
    }
    return { ok: true }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── 原子写 ──────────────────────────────────────────────────────────────────
function writeAtomic(destPath, content) {
  const dir = dirname(destPath)
  const tmpPath = join(dir, `.${basename(destPath)}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 10)}`)
  let fd = null
  try {
    fd = openSync(tmpPath, 'wx', 0o600)
    writeFileSync(fd, content)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    // 显式 chmod：mode 会受 umask 影响，这里确保落盘后就是 0600。
    chmodSync(tmpPath, 0o600)
    renameSync(tmpPath, destPath)
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* 已经关掉/不可关 */ }
    }
    try { unlinkSync(tmpPath) } catch { /* 临时文件可能还没创建 */ }
    throw error
  }
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(USAGE)
    return 0
  }

  const home = resolveHome(opts.home)
  const templatePath = resolve(opts.template ?? DEFAULT_TEMPLATE)
  const destPath = resolve(opts.dest ?? join(home, '.dsh', 'logrotate.dsh.conf'))
  if (existsSync(destPath) && statSync(destPath).isDirectory()) {
    throw usageFail(`--dest 指向一个目录（目标必须是文件）：${destPath}`)
  }

  const templateText = readTemplate(templatePath)
  const occurrences = templateText.split(PLACEHOLDER).length - 1
  // 全局替换：String.replace(字面量) 只换第一处，会留下占位符（历史事故形态）。
  const content = templateText.split(PLACEHOLDER).join(home)
  const bytes = Buffer.byteLength(content, 'utf8')

  console.log(`install-logrotate: 模板 ${templatePath}`)
  console.log(`  HOME：${home}（替换 ${PLACEHOLDER} × ${occurrences}）`)
  if (occurrences === 0) {
    console.log(`  注：模板不含 ${PLACEHOLDER}（可能已是具体路径），按原样校验`)
  }

  const verdict = validateContent(content)
  console.log('  校验：')
  for (const item of verdict.oks) console.log(`    ok   ${item}`)
  for (const item of verdict.problems) console.error(`    FAIL ${item}`)
  if (verdict.problems.length > 0) {
    throw installFail(
      opts.dryRun
        ? '目标内容校验失败（dry-run，未写目标文件）'
        : `目标内容校验失败——未写入 ${destPath}（旧文件保持不变）`,
      [
        '  修复提示：',
        '    · 路径行必须是替换后的绝对路径；不要把模板直接拷成配置。',
        '    · 若 --home 本身含字面 @HOME@，换一个真实 HOME 再试。',
        '    · 修好模板后重跑本脚本（--dry-run 可先看结论和内容）。',
      ].join('\n'),
    )
  }

  const logrotateBin = resolveLogrotate(opts)
  if (logrotateBin !== null) {
    const result = checkSyntax(content, logrotateBin)
    if (!result.ok) {
      const detail = result.detail.trim()
        ? `\n  logrotate 输出（尾部）：\n${indentBlock(tail(result.detail), '    ')}`
        : ''
      throw installFail(
        opts.dryRun
          ? `logrotate -d 语法干跑失败（${result.summary}）（dry-run，未写目标文件）`
          : `logrotate -d 语法干跑失败（${result.summary}）——未写入 ${destPath}（旧文件保持不变）`,
        `${detail}\n  修复提示：先修模板/替换后的路径，再用 logrotate -d 复查。`,
      )
    }
    console.log(`    ok   logrotate -d 语法干跑（${logrotateBin}）`)
  }

  if (opts.dryRun) {
    console.log(`dry-run：目标 ${destPath}（${bytes} 字节，权限 0600）—— 未写目标文件`)
    if (logrotateBin !== null) console.log('  （语法干跑用的临时配置文件已清理）')
    console.log('--- 目标内容开始 ---')
    process.stdout.write(content.endsWith('\n') ? content : `${content}\n`)
    console.log('--- 目标内容结束 ---')
    return 0
  }

  const destDir = dirname(destPath)
  try {
    mkdirSync(destDir, { recursive: true, mode: 0o700 })
    writeAtomic(destPath, content)
  } catch (error) {
    throw installFail(
      `写盘失败（${describeError(error)}）——旧文件未被改动`,
      `  修复提示：检查 ${destDir} 是否存在且可写，或换个 --dest 路径。`,
    )
  }
  console.log(`已写入：${destPath}（${bytes} 字节，权限 0600，原子替换）`)
  console.log(`  复查：logrotate -d ${destPath}`)
  return 0
}

function describeError(error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
  const message = error instanceof Error ? error.message : String(error)
  return code ? `${code}: ${message}` : message
}

function tail(text, maxLines = 20, maxChars = 4000) {
  const lines = text.replace(/\n+$/, '').split(/\r?\n/)
  let kept = lines.slice(-maxLines).join('\n')
  if (kept.length > maxChars) kept = kept.slice(-maxChars)
  return kept
}

function indentBlock(text, prefix) {
  return text.split(/\r?\n/).map((line) => prefix + line).join('\n')
}

function reportError(error) {
  if (!(error instanceof CliError)) {
    console.error(`ERROR 未预期失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    return 1
  }
  if (error.usage) {
    console.error(`用法错误：${error.message}\n`)
    console.error(USAGE)
    return 2
  }
  console.error(`ERROR ${error.message}`)
  if (error.hint) console.error(error.hint)
  return 1
}

try {
  process.exitCode = main()
} catch (error) {
  process.exitCode = reportError(error)
}
