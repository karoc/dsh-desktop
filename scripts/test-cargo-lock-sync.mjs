#!/usr/bin/env node
// Cargo.lock 版本同步脚本的回归测试（2026-10-16 新增）。
//
// 为什么必须有：`npm run bundle`（= sync:cargo-lock && tauri build）里第一步就是这个脚本，
// 它一旦误判，**打不出 Windows 安装包**（发布阻断）。2026-10-15/16 的真实事故：脚本把行尾硬编码
// 成 `\n`，而 GitHub 的 Windows runner 以 core.autocrlf=true 检出、Cargo.lock 到手是 CRLF ⇒
// main 上连续多次 CI 在 `npm run bundle` 第一步红（v0.18.0 那次侥幸绿，只因当时 lock 里的
// dsh-desktop 还是旧版本、cargo 先把它重写成了 LF）。本测试把"CRLF 也必须能同步"钉住。
//
// 判据（每条都实测过会失败：把脚本换回 LF 硬编码的旧实现，CRLF 两条立刻变红）：
//   ① LF + 版本落后 → exit 0 / FIXED / 版本写入 / 仍是 LF
//   ② CRLF + 版本落后 → exit 0 / FIXED / 版本写入 / **仍是 CRLF**（回归判据）
//   ③ CRLF + 版本已一致 → exit 0 / PASS / 文件零改动
//   ④ 没有 dsh-desktop 包段 → exit 1 且 stderr 带可判读的诊断（size / CRLF 行数 / 是否出现包名 / EOL）
//   ⑤ 同名前缀的别的包段（dsh-desktop-helper）绝不能被改（精确匹配，不误伤）
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'sync-cargo-lock-version.mjs')
const TOOL_VERSION = '9.9.9'
const DECOY = '[[package]]\nname = "dsh-desktop-helper"\nversion = "1.0.0"\n'

function fixture({ lockEol = '\n', lockVersion = '0.0.1', withSection = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lock-'))
  mkdirSync(join(dir, 'src-tauri'), { recursive: true })
  writeFileSync(join(dir, 'src-tauri', 'Cargo.toml'), `[package]\nname = "dsh-desktop"\nversion = "${TOOL_VERSION}"\n`)
  let lock = DECOY + '\n'
  if (withSection) lock += `[[package]]\nname = "dsh-desktop"\nversion = "${lockVersion}"\ndependencies = [\n "x",\n]\n`
  if (lockEol === '\r\n') lock = lock.replace(/\n/g, '\r\n')
  writeFileSync(join(dir, 'src-tauri', 'Cargo.lock'), lock)
  return dir
}

function runScript(dir) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT], {
      env: { ...process.env, DSH_LOCK_ROOT: dir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out, err: '' }
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout || ''), err: String(e.stderr || '') }
  }
}

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : '  ← ' + extra}`)
  if (!ok) failed++
}
const body = (dir) => readFileSync(join(dir, 'src-tauri', 'Cargo.lock'), 'utf8')
const cleanup = []

// ① LF + 落后
{
  const dir = fixture({ lockEol: '\n', lockVersion: '0.0.1' }); cleanup.push(dir)
  const r = runScript(dir)
  const after = body(dir)
  check('LF + 版本落后 → exit 0 / FIXED / 已写入 / 仍为 LF',
    r.code === 0 && /FIXED/.test(r.out) && after.includes(`name = "dsh-desktop"\nversion = "${TOOL_VERSION}"`) && !after.includes('\r'),
    `code=${r.code} out=${r.out.trim()} err=${r.err.trim()}`)
}

// ② CRLF + 落后（回归判据：旧实现（\n 硬编码）在这里必红）
{
  const dir = fixture({ lockEol: '\r\n', lockVersion: '0.0.1' }); cleanup.push(dir)
  const r = runScript(dir)
  const after = body(dir)
  check('CRLF + 版本落后 → exit 0 / FIXED / 已写入 / **仍为 CRLF**',
    r.code === 0 && /FIXED/.test(r.out) && after.includes(`name = "dsh-desktop"\r\nversion = "${TOOL_VERSION}"`) && after.includes('\r\n'),
    `code=${r.code} out=${r.out.trim()} err=${r.err.trim()}`)
}

// ③ CRLF + 已一致 → 不该改文件
{
  const dir = fixture({ lockEol: '\r\n', lockVersion: TOOL_VERSION }); cleanup.push(dir)
  const before = body(dir)
  const r = runScript(dir)
  check('CRLF + 版本已一致 → exit 0 / PASS / 文件零改动',
    r.code === 0 && /PASS/.test(r.out) && body(dir) === before,
    `code=${r.code} out=${r.out.trim()} err=${r.err.trim()}`)
}

// ④ 找不到包段 → 失败且诊断可判读
{
  const dir = fixture({ lockEol: '\r\n', withSection: false }); cleanup.push(dir)
  const r = runScript(dir)
  check('缺 dsh-desktop 包段 → exit 1 且 stderr 带 size/CRLF/包名/EOL 四项诊断',
    r.code === 1 && /找不到 dsh-desktop 包段/.test(r.err) &&
    /size=\d+/.test(r.err) && /CRLF行=\d+/.test(r.err) && /出现包名=/.test(r.err) && /采用EOL=/.test(r.err),
    `code=${r.code} err=${r.err.trim()}`)
}

// ⑤ 精确匹配：同名前缀的别的包段不能被误伤
{
  const dir = fixture({ lockEol: '\n', lockVersion: '0.0.1' }); cleanup.push(dir)
  runScript(dir)
  check('精确匹配：dsh-desktop-helper 的版本不被改写',
    body(dir).includes('name = "dsh-desktop-helper"\nversion = "1.0.0"'),
    body(dir).slice(0, 120))
}

for (const d of cleanup) rmSync(d, { recursive: true, force: true })
if (failed) { console.error(`FAILED: Cargo.lock 同步脚本回归 ${failed} 项`); process.exit(1) }
console.log('PASS: Cargo.lock 同步脚本回归（LF/CRLF 双行尾 + 精确匹配 + 失败诊断）')
