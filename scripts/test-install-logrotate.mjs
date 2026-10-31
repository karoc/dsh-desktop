#!/usr/bin/env node
// logrotate 安装器守卫的**可失败**自检（2026-10-31，看板卡「logrotate 模板健壮化」）。
//
// 守的是两条真实事故/边界：
//   ① 把模板**原样拷**成 ~/.dsh/logrotate.dsh.conf（@HOME@ 没替换）⇒ logrotate 报
//      "lines must begin with a keyword or a filename"，配置长期不生效、日志一直没轮转。
//      安装器必须先校验后落盘，且校验 / 语法干跑失败时**旧文件保持原样**。
//   ② 模板只列三个 timer 日志，漏掉每日 doctor 写的 dsh-doctor.log ⇒ 新日志继续无上限增长。
//
// 负向对照（本套件自证可失败；把安装器改坏任意一处，对应断言必红）：
//   - 去掉"输出不得残留 @HOME@"检查        ⇒ ④b 必红；
//   - 先写目标再校验 / 忽略 logrotate 退出码 ⇒ ③ 必红（旧文件会被覆盖）；
//   - 把全局替换改回只替换第一处（`String.replace`）⇒ ② 与 ④a 必红；
//   - 去掉 0600 权限                        ⇒ ② 的 POSIX 权限断言必红。
//
// 安全边界：**绝不写真实 ~/.dsh** —— 每条用例都显式传 `--home <tmp>` 与
// `--dest <tmp>/...`；假 logrotate 只存在于临时 PATH 注入目录里。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALLER = join(ROOT, 'scripts', 'install-logrotate.mjs')
const TEMPLATE = join(ROOT, 'scripts', 'logrotate.dsh.conf')
const NODE = process.execPath
const POSIX = process.platform !== 'win32'

const TMP = mkdtempSync(join(tmpdir(), 'dsh-logrotate-install-'))
const HOME_DIR = join(TMP, 'home')
mkdirSync(HOME_DIR, { recursive: true })

// 假 logrotate：行为完全由环境变量控制（不解析配置），用来区分"语法干跑通过/失败"。
const BIN_DIR = join(TMP, 'bin')
mkdirSync(BIN_DIR, { recursive: true })
const STUB = join(BIN_DIR, 'logrotate')
writeFileSync(STUB, [
  '#!/bin/sh',
  '# 测试夹具：假 logrotate。参数/配置落盘由 STUB_* 控制，退出码由 STUB_EXIT 控制。',
  'if [ -n "$STUB_ARGS_FILE" ]; then printf "%s\\n" "$@" > "$STUB_ARGS_FILE"; fi',
  'if [ -n "$STUB_CONFIG_COPY" ] && [ -f "$2" ]; then cp "$2" "$STUB_CONFIG_COPY"; fi',
  'if [ -n "$STUB_STDERR" ]; then printf "%s\\n" "$STUB_STDERR" >&2; fi',
  'exit "${STUB_EXIT:-0}"',
  '',
].join('\n'))
chmodSync(STUB, 0o755)
const PATH_WITH_STUB = `${BIN_DIR}${delimiter}${process.env.PATH ?? ''}`

let checks = 0
let failures = 0
const skipped = []
const check = (label, fn) => {
  checks += 1
  try {
    fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}\n     ${error.message}`)
  }
}
const skip = (label, why) => {
  skipped.push(`${label} —— ${why}`)
  console.log(`SKIP ${label} —— ${why}`)
}

function runInstaller(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv }
  if (POSIX && extraEnv.PATH === undefined) env.PATH = PATH_WITH_STUB
  const res = spawnSync(NODE, [INSTALLER, ...args], { encoding: 'utf8', timeout: 60_000, env })
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    output: `${res.stdout ?? ''}${res.stderr ?? ''}`,
    error: res.error,
  }
}

const withHome = (dest, extra = []) => ['--home', HOME_DIR, '--dest', dest, '--template', TEMPLATE, ...extra]

// ① --dry-run：只打印，不写目标文件（也不创建目标目录）。
check('① --dry-run 打印目标路径/字节数/校验结论/内容，且不写盘', () => {
  const dest = join(TMP, 'dry', 'logrotate.dsh.conf')
  const argsFile = join(TMP, 'dry-args.txt')
  const configCopy = join(TMP, 'dry-checked.conf')
  const r = runInstaller(
    ['--dry-run', ...withHome(dest)],
    POSIX ? { STUB_ARGS_FILE: argsFile, STUB_CONFIG_COPY: configCopy } : {},
  )
  assert.equal(r.status, 0, `应 exit 0，实际 ${r.status}\n${r.output}`)
  assert.equal(existsSync(dest), false, 'dry-run 不得写目标文件')
  assert.equal(existsSync(dirname(dest)), false, 'dry-run 不得创建目标目录')
  assert.match(r.output, /dry-run：目标 .*（\d+ 字节/, '应打印目标路径与字节数')
  assert.match(r.output, /--- 目标内容开始 ---[\s\S]*--- 目标内容结束 ---/, '应打印目标内容')
  const preview = r.output.split('--- 目标内容开始 ---')[1].split('--- 目标内容结束 ---')[0]
  assert.ok(preview.includes(join(HOME_DIR, '.dsh', 'logs', 'dsh-doctor.log')), '内容预览应含 dsh-doctor.log')
  assert.ok(!preview.includes('@HOME@'), '内容预览不得残留 @HOME@')

  if (POSIX) {
    assert.equal(existsSync(configCopy), true, '应把替换后的配置交给 logrotate -d（临时文件）')
    const checked = readFileSync(configCopy, 'utf8')
    assert.ok(checked.includes(join(HOME_DIR, '.dsh', 'logs', 'dsh-doctor.log')), '语法干跑读到的必须是替换后的配置')
    assert.ok(!checked.includes('@HOME@'), '语法干跑不得读未替换的模板')
    const stubArgs = readFileSync(argsFile, 'utf8').trim().split('\n')
    assert.equal(stubArgs[0], '-d', '必须以 logrotate -d 干跑')
  } else {
    skip('① 假 logrotate 桩断言', 'Windows 上安装器显式跳过 logrotate（非 POSIX 告警）')
  }
})

// ② 真跑：原子写入 + 0600 + 四个日志路径 + 无占位符。
check('② 真跑写入成功：无 @HOME@、含四个日志路径、权限 0600（POSIX）', () => {
  const dest = join(TMP, 'installed', 'logrotate.dsh.conf')
  const r = runInstaller(withHome(dest))
  assert.equal(r.status, 0, `应 exit 0，实际 ${r.status}\n${r.output}`)
  assert.equal(existsSync(dest), true, '目标文件应存在')
  assert.match(r.output, /已写入：.*（\d+ 字节，权限 0600，原子替换）/, '应报告写入字节数与权限')

  const content = readFileSync(dest, 'utf8')
  assert.ok(!content.includes('@HOME@'), '安装后的配置不得残留 @HOME@')
  for (const name of ['dsh-watch-timer.log', 'dsh-autopilot.log', 'dsh-tagdispatch.log', 'dsh-doctor.log']) {
    assert.ok(
      content.includes(join(HOME_DIR, '.dsh', 'logs', name)),
      `安装后的配置应含 ${name}（doctor 日志漏纳管是本次要修的缺陷）`,
    )
  }
  assert.match(r.output, /4 条日志路径均为绝对路径/)
  const tainted = content.split('\n').map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && line.includes('dsh-web.out.log'))
  assert.deepEqual(tainted, [], 'dsh-web.out.log 不得被纳管（dsh-web.service 自己维护 .prev.log）')

  if (POSIX) {
    const mode = statSync(dest).mode & 0o777
    assert.equal(mode, 0o600, `配置权限必须是 0600，实际 0${mode.toString(8)}`)
  } else {
    skip('② 0600 权限断言', '非 POSIX 平台没有 POSIX 权限位')
  }
})

// ③ 语法干跑失败 ⇒ exit 1，且旧文件一个字节都不动（历史事故的核心防线）。
check('③ 桩 logrotate exit 1 ⇒ 安装器 exit 1 且旧文件原样', () => {
  if (!POSIX) {
    skip('③ 语法干跑失败不落盘', 'Windows 上没有可执行的 POSIX 假 logrotate 桩')
    return
  }
  const dir = join(TMP, 'syntax-fail')
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, 'logrotate.dsh.conf')
  const OLD = '# 旧配置：语法干跑失败时必须原样保留\n'
  writeFileSync(dest, OLD, { mode: 0o600 })

  const r = runInstaller(withHome(dest), {
    STUB_EXIT: '1',
    STUB_STDERR: 'error: lines must begin with a keyword or a filename',
  })
  assert.equal(r.status, 1, `应 exit 1，实际 ${r.status}\n${r.output}`)
  assert.equal(readFileSync(dest, 'utf8'), OLD, '旧文件必须保持原样（不得先写后校验）')
  assert.ok(
    r.output.includes('lines must begin with a keyword or a filename'),
    '应带出 logrotate 的报错尾部（便于定位）',
  )
  assert.match(r.output, /未写入/, '应明确说明未写入')
  assert.deepEqual(readdirSync(dir), ['logrotate.dsh.conf'], '不得留下临时文件')
})

// ④a 全局替换的正向对照：同一行两个占位符都必须被替换。
check('④a 同一行多个 @HOME@ 全部替换（防止回退到只替换第一处）', () => {
  const template = join(TMP, 'fixture-two-placeholders.conf')
  writeFileSync(template, [
    '# fixture：同一行两个占位符，用于证明替换是全局的',
    '@HOME@/.dsh/logs/a.log',
    '@HOME@/@HOME@/.dsh/logs/b.log',
    '{',
    '    daily',
    '    missingok',
    '}',
    '',
  ].join('\n'))
  const dest = join(TMP, 'multi', 'logrotate.dsh.conf')
  const r = runInstaller(['--home', HOME_DIR, '--dest', dest, '--template', template])
  assert.equal(r.status, 0, `应 exit 0，实际 ${r.status}\n${r.output}`)
  const content = readFileSync(dest, 'utf8')
  assert.ok(
    content.includes(`${HOME_DIR}/${HOME_DIR}/.dsh/logs/b.log`),
    '同一行的第二个占位符也必须被替换（String.replace 只换第一处，会留下 @HOME@）',
  )
  assert.ok(!content.includes('@HOME@'), '替换后不得残留 @HOME@')
})

// ④b 可失败用例：替换后仍含 @HOME@ ⇒ 拒绝安装、不落盘。
// 说明：安装器用全局替换，所以"模板写 @HOME@/@HOME@ 但 --home 普通"不会残留；残留只可能
// 来自 --home 本身含字面 @HOME@（或将来新增的占位符）。这里正是注入这种输入来证明守卫会红。
check('④b 输出仍含 @HOME@ ⇒ exit 1、不落盘、旧文件不变', () => {
  const weirdHome = join(TMP, 'home-@HOME@')
  mkdirSync(weirdHome, { recursive: true })
  const dir = join(TMP, 'residual')
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, 'logrotate.dsh.conf')
  const OLD = '# 旧配置：内容校验失败时不得被覆盖\n'
  writeFileSync(dest, OLD, { mode: 0o600 })

  const r = runInstaller(['--home', weirdHome, '--dest', dest, '--template', TEMPLATE])
  assert.equal(r.status, 1, `应 exit 1，实际 ${r.status}\n${r.output}`)
  assert.equal(readFileSync(dest, 'utf8'), OLD, '校验失败不得覆盖旧文件')
  assert.match(r.output, /仍含 @HOME@/, '错误必须指明残留的占位符')
  assert.match(r.output, /未写入/, '应明确说明未写入')
  assert.deepEqual(readdirSync(dir), ['logrotate.dsh.conf'], '不得留下临时文件')
})

// ⑤ 用法错误 ⇒ exit 2（不存在 / 不是目录 / 未知选项）。
check('⑤ 用法错误（--home 不存在/不是目录、未知选项）⇒ exit 2', () => {
  const dest = join(TMP, 'usage', 'logrotate.dsh.conf')

  const missing = runInstaller(['--home', join(TMP, 'no-such-home'), '--dest', dest, '--template', TEMPLATE])
  assert.equal(missing.status, 2, `--home 不存在应 exit 2，实际 ${missing.status}\n${missing.output}`)
  assert.match(missing.output, /--home/)
  assert.equal(existsSync(dest), false, '用法错误不得写目标文件')

  const notDirPath = join(TMP, 'not-a-dir')
  writeFileSync(notDirPath, 'x')
  const notDir = runInstaller(['--home', notDirPath, '--dest', dest, '--template', TEMPLATE])
  assert.equal(notDir.status, 2, `--home 不是目录应 exit 2，实际 ${notDir.status}\n${notDir.output}`)
  assert.equal(existsSync(dest), false, '用法错误不得写目标文件')

  const unknown = runInstaller(['--bogus'])
  assert.equal(unknown.status, 2, `未知选项应 exit 2，实际 ${unknown.status}\n${unknown.output}`)
  assert.match(unknown.output, /未知选项/)
})

// ⑥ --no-check：即使桩 logrotate 失败也照常安装（显式跳过语法检查，但仍做内容校验）。
check('⑥ --no-check 跳过语法检查（桩故意失败仍安装成功）', () => {
  const dest = join(TMP, 'no-check', 'logrotate.dsh.conf')
  const r = runInstaller(['--no-check', ...withHome(dest)], { STUB_EXIT: '1' })
  assert.equal(r.status, 0, `应 exit 0，实际 ${r.status}\n${r.output}`)
  assert.match(r.output, /--no-check/, '应打印跳过语法干跑的原因')
  assert.equal(existsSync(dest), true, '目标文件应存在')
  assert.ok(!readFileSync(dest, 'utf8').includes('@HOME@'), '安装后的配置不得残留 @HOME@')
})

if (skipped.length > 0) {
  console.log(`\n${skipped.length} 条显式 SKIP（不是通过；见上面逐条原因）`)
  for (const item of skipped) console.log(`  SKIP ${item}`)
}
if (failures > 0) {
  console.error(`\nFAIL: ${failures}/${checks} 条断言失败（夹具保留：${TMP}）`)
  process.exit(1)
}
rmSync(TMP, { recursive: true, force: true })
console.log(`\nPASS: logrotate 安装器守卫自检（${checks} 条断言${skipped.length > 0 ? `，${skipped.length} 条显式 SKIP` : ''}）`)
