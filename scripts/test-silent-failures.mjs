#!/usr/bin/env node
// 静默失效审计（2026-10-07 起，npm test 第 18 套；默认先自检再审计，自检不过即失败）：把"结果被忽略的销毁/写入操作"变成门禁。
//
// 背景：2026-10-06 的质量审计修掉两处"备份失败被吞、销毁照做"的 fail-open，但**同类复查当时漏做了**。
// 靠自觉的审计一定会漏 —— 本脚本把这一类变成可执行规则。
//
// 规则（逐点标注，**不做区域猜测**）：
//   · Rust：`let _ = std::fs::(remove_file|remove_dir_all|copy|write|rename|create_dir*)` 与
//           `std::fs::(…)(…) .ok();` 一律要被审；本行或上一行需带 `// fail-open-ok: <非空理由>`。
//   · JS（manager 真源 scripts/server-manager.mjs）：**空 catch**（块内无语句）同上。
//
// ⚠️ 2026-10-07 教训（为什么不做区域猜测）：前两版试图自动跳过 `#[cfg(test)] mod …` 区域，两次都判错 ——
//   第一版跳过该行之后的全部内容（**漏检生产代码**，假阴性最危险），第二版连模块边界都没匹配上（把 20 条
//   测试区命中当生产报出来）。启发式在这里静默出错的代价太高，因此改为：任何站点都要标注，测试夹具写
//   "测试夹具清理"即可。零假阴性，代价是每个新站点一行理由。
//
// 可失败证明：`npm run audit:self-test`（或 --self-test）用内嵌夹具断言"未标注 ⇒ 红、已标注 ⇒ 绿、
//   空 catch ⇒ 红" —— 恒真的门禁等于没有门禁。
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUST_FILES = ['src-tauri/src/lib.rs']
const JS_FILES = ['scripts/server-manager.mjs']

const ANNOTATION = /fail-open-ok:\s*\S/
const RUST_SITE = /let\s+_\s*=\s*std::fs::(?:remove_file|remove_dir_all|copy|write|rename|create_dir|create_dir_all)\s*\(|std::fs::(?:remove_file|remove_dir_all|copy|write|rename|create_dir_all)\([^;]*\)\s*\.ok\(\)\s*;/
const JS_EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g

function scanLines(lines, siteRe) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (!siteRe.test(lines[i])) continue
    const annotated = ANNOTATION.test(lines[i]) || (i > 0 && ANNOTATION.test(lines[i - 1]))
    if (!annotated) out.push({ line: i + 1, text: lines[i].trim().slice(0, 110) })
  }
  return out
}

function scanJs(text) {
  const lines = text.split('\n')
  const out = []
  for (const m of text.matchAll(JS_EMPTY_CATCH)) {
    const line = text.slice(0, m.index).split('\n').length
    const annotated = ANNOTATION.test(lines[line - 1] || '') || ANNOTATION.test(lines[line - 2] || '')
    if (!annotated) out.push({ line, text: `空 catch：${(lines[line - 1] || '').trim().slice(0, 90)}` })
  }
  return out
}

function collect() {
  const findings = []
  for (const rel of RUST_FILES) {
    if (!existsSync(join(ROOT, rel))) continue
    for (const f of scanLines(readFileSync(join(ROOT, rel), 'utf8').split('\n'), RUST_SITE)) findings.push({ file: rel, ...f })
  }
  for (const rel of JS_FILES) {
    if (!existsSync(join(ROOT, rel))) continue
    for (const f of scanJs(readFileSync(join(ROOT, rel), 'utf8'))) findings.push({ file: rel, ...f })
  }
  return findings
}

function run() {
  const findings = collect()
  if (findings.length) {
    console.error(`FAIL: ${findings.length} 处"结果被忽略"未标注理由`)
    for (const f of findings) console.error(`   ${f.file}:${f.line}  ${f.text}`)
    console.error('   修法：① 改 fail-closed（失败即返回/阻断）；或 ② 本行/上一行加 `// fail-open-ok: <理由>`。')
    return 1
  }
  console.log(`PASS: 静默失效审计（${RUST_FILES.length} 个 Rust + ${JS_FILES.length} 个 JS 文件的销毁/写入站点均已 fail-closed 或标注理由）`)
  return 0
}

function selfTest() {
  const rustBad = ['fn x() {', '    let _ = std::fs::remove_file("p");', '}']
  const rustGood = ['fn x() {', '    // fail-open-ok: 仅日志路径，失败无副作用', '    let _ = std::fs::remove_file("p");', '}']
  const rustOkSwallow = ['fn x() {', '    std::fs::write("p", b"1").ok();', '}']
  const jsBad = 'try { rmSync(p) } catch { }'
  const cases = [
    ['未标注的 Rust 销毁调用 ⇒ 红', scanLines(rustBad, RUST_SITE).length === 1],
    ['已标注的 Rust 销毁调用 ⇒ 绿', scanLines(rustGood, RUST_SITE).length === 0],
    ['`.ok()` 吞错 ⇒ 红', scanLines(rustOkSwallow, RUST_SITE).length === 1],
    ['空 catch ⇒ 红', scanJs(jsBad).length === 1],
  ]
  let failed = 0
  for (const [name, ok] of cases) { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failed++ }
  if (failed) { console.error(`FAILED: 自检 ${failed} 项（门禁不可信）`); return 1 }
  console.log(`PASS: 审计门禁自检（${cases.length}/${cases.length}）`)
  return 0
}

// 默认模式：**先自检再审计** —— 门禁必须先证明自己会红（恒真的门禁不算门禁）。
process.exit(process.argv.includes('--self-test') ? selfTest() : (selfTest() || run()))
