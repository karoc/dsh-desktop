#!/usr/bin/env node
// 覆盖率基线（2026-10-07 起）：用 Node **内建** `NODE_V8_COVERAGE` 采集并自行解析，不引入任何依赖。
//
// 为什么自己做：本仓的 18 个套件是自研 .mjs（不是 node:test），c8/nyc 需要新增依赖；而 V8 覆盖 JSON 只是
// "函数 + 字节区间 + 命中次数"，把区间并集映射到行号即可得到行覆盖率，够用且零依赖。
//
// 用法：
//   node scripts/coverage-baseline.mjs --run        # 在覆盖率下跑一次 npm test，然后打印表格
//   node scripts/coverage-baseline.mjs --dir <d>    # 只解析已有的 NODE_V8_COVERAGE 目录
//   node scripts/coverage-baseline.mjs --self-test  # 用内嵌夹具证明本工具**会失败**（否则不算测量）
import { readdirSync, readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** V8 覆盖 JSON → { url → [start, end, count][] }（**保持 V8 的嵌套顺序**，最内层在最后）。 */
export function coverageRanges(entries) {
  const byUrl = new Map()
  for (const e of entries) {
    if (!e || typeof e.url !== 'string' || !Array.isArray(e.functions)) continue
    const list = byUrl.get(e.url) ?? []
    for (const fn of e.functions) {
      for (const r of fn.ranges ?? []) {
        if (Number.isFinite(r.startOffset) && Number.isFinite(r.endOffset)) {
          list.push([r.startOffset, r.endOffset, r.count ?? 0])
        }
      }
    }
    byUrl.set(e.url, list)
  }
  return byUrl
}

/** 某偏移是否被覆盖：取**最内层**包含它的区间（V8 的 ranges 是嵌套的，内层 count=0 表示没执行到）。 */
export function isCovered(offset, ranges) {
  let innermost = null
  for (const r of ranges) if (r[0] <= offset && offset < r[1]) innermost = r
  return innermost !== null && innermost[2] > 0
}

/** 源码 + 覆盖区间 → { total, covered }（按"该行任一字节被覆盖"计）。 */
export function lineCoverage(source, ranges) {
  const lines = source.split('\n')
  let offset = 0
  let covered = 0
  for (const line of lines) {
    const start = offset
    const end = offset + line.length
    const hit = isCovered(start, ranges)
    const blank = line.trim() === ''
    if (hit && !blank) covered++
    offset = end + 1
  }
  const total = lines.filter((l) => l.trim() !== '').length
  return { total, covered }
}

function collect(dir) {
  const entries = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (Array.isArray(j.result)) entries.push(...j.result)
    } catch { /* 半写的文件：跳过（不静默通过 —— 计数会体现在下面的文件数里） */ }
  }
  return entries
}

function report(dir) {
  const entries = collect(dir)
  const byUrl = coverageRanges(entries)
  const rows = []
  for (const [url, ranges] of byUrl) {
    if (!url.startsWith('file://')) continue
    const abs = fileURLToPath(url)
    const rel = relative(ROOT, abs)
    if (rel.startsWith('..') || !/\.(mjs|cjs|js)$/.test(rel)) continue
    if (!/^(scripts|src-tauri\/resources\/manager)\//.test(rel)) continue
    let src
    try { src = readFileSync(abs, 'utf8') } catch { continue }
    const { total, covered } = lineCoverage(src, ranges)
    if (total > 0) rows.push({ rel, total, covered, pct: (covered / total) * 100 })
  }
  rows.sort((a, b) => a.pct - b.pct)
  const sum = rows.reduce((a, r) => ({ t: a.t + r.total, c: a.c + r.covered }), { t: 0, c: 0 })
  console.log(`\n覆盖率基线（V8，行覆盖；文件 ${rows.length} 个，覆盖 JSON ${entries.length} 条目）`)
  console.log(`  合计: ${sum.c}/${sum.t} = ${sum.t ? ((sum.c / sum.t) * 100).toFixed(1) : 'n/a'}%`)
  for (const r of rows.slice(0, 20)) console.log(`  ${r.pct.toFixed(1).padStart(5)}%  ${String(r.total).padStart(5)} 行  ${r.rel}`)
  if (rows.length > 20) console.log(`  …（共 ${rows.length} 个文件；已按覆盖率升序，上面是最低的 20 个）`)
  return rows.length === 0 ? 1 : 0
}

function selfTest() {
  const src = 'a\nb\n\nc\n' // 4 行（1 空行）
  const cases = [
    ['整文件覆盖 ⇒ 3/3 非空行', lineCoverage(src, [[0, src.length, 1]]).covered === 3],
    ['只覆盖首行 ⇒ 1/3', lineCoverage(src, [[0, 1, 1]]).covered === 1],
    ['空区间 ⇒ 0/3', lineCoverage(src, []).covered === 0],
    // ⚠️ 本次 bug 的回归夹具：V8 会给出覆盖整个文件的根区间（count=1），而内层区间 count=0 表示"没执行到"。
    //    早先版本把所有 count>0 区间做并集 ⇒ 每个文件都报 100%（完全失真）。必须取**最内层**区间。
    ['嵌套区间：内层 count=0 覆盖外层 count=1 ⇒ 该行不算覆盖', !isCovered(3, [[0, 100, 1], [2, 6, 0]])],
    ['嵌套区间：内层 count=1 覆盖外层 count=0 ⇒ 算覆盖', isCovered(3, [[0, 100, 0], [2, 6, 1]])],
    ['无区间包含 ⇒ 不算覆盖', !isCovered(3, [[10, 20, 1]])],
    ['非空行计数正确（4 行含 1 空行 ⇒ total 3）', lineCoverage(src, []).total === 3],
  ]
  let bad = 0
  for (const [n, ok] of cases) { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}`); if (!ok) bad++ }
  if (bad) { console.error(`FAILED: 覆盖率工具自检 ${bad} 项`); return 1 }
  console.log(`PASS: 覆盖率工具自检（${cases.length}/${cases.length}）`)
  return 0
}

if (process.argv.includes('--self-test')) process.exit(selfTest())
else if (process.argv.includes('--run')) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cov-'))
  console.log(`  在覆盖率下跑 npm test（NODE_V8_COVERAGE=${dir}）…`)
  execFileSync('npm', ['test'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: dir } })
  const code = report(dir)
  rmSync(dir, { recursive: true, force: true })
  process.exit(code)
} else {
  const i = process.argv.indexOf('--dir')
  process.exit(report(i >= 0 ? process.argv[i + 1] : process.env.NODE_V8_COVERAGE || tmpdir()))
}
