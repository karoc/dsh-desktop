#!/usr/bin/env node
// dsh 升级 SLA 报表（自动化方案 P2）—— 对每个已发布版本量出「官方发布 → 我们发布稳定版」的真实耗时。
//
//   node scripts/dsh-sla-report.mjs [--json <out>] [--issue] [--fail-on-breach] [--recent 3]
//
// 口径（方案 §1.1a，与人工基线一致）：
//   起点 T0   = npm `time[<该版本随包地板>]`（上游发布时间）
//   地板提交  = `git log -G"MIN_DSH_VERSION = '<v>'" -1 <tag>`（我们开始承诺该地板的提交）
//   终点      = 该版本 GitHub Release 的 publishedAt（我们对外发布）
//   SLA 6h    = 终点 − 起点 ≤ 6h（方案 §1.1b：latest 通道硬指标）
//
// 配对方式：Release tag `vX.Y.Z` 的**tag 树上**读 `MIN_DSH_VERSION` 得到它随包分发的 dsh 版本；
// 读不到（历史早期 tag）则跳过并给出理由，不猜。
//
// 零 secret：只用 GITHUB_TOKEN（issues: write）。默认只出报表；--fail-on-breach 才让最近 N 个版本
// 的 6h 超时把退出码置 1（给工作流当门禁用，且只盯最近的，避免历史数据让门禁恒红）。

import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
const OUT = arg('--json')
const UPSERT_ISSUE = argv.includes('--issue')
const FAIL_ON_BREACH = argv.includes('--fail-on-breach')
const RECENT = Number(arg('--recent', '3'))
const REPO = arg('--repo', process.env.GITHUB_REPOSITORY ?? 'karoc/dsh-desktop')
const GH = process.env.GH_BIN ?? 'gh'
const SLA_HOURS = 6

const CHECK = arg('--check')
if (CHECK) {
  // 门禁独立成步：红色只代表"最近 N 个版本超 SLA"，与"报表 job 坏了"可区分（首次实跑的教训）
  const data = JSON.parse(readFileSync(CHECK, 'utf8'))
  const recent = (data.perVersion ?? []).slice(-RECENT)
  const bad = recent.filter((r) => !r.ok)
  console.log(`SLA 门禁：最近 ${recent.length} 个版本中 ${bad.length} 个超 ${SLA_HOURS}h` + (bad.length ? `：${bad.map((r) => `${r.shell}=${r.total.toFixed(2)}h`).join(', ')}` : ''))
  process.exit(bad.length ? 1 : 0)
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
const hours = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / 3600000
const fmt = (h) => (Number.isFinite(h) ? `${h.toFixed(2)}h` : '—')

// npm packument：直连失败时走 HTTPS_PROXY（本机取证：裸 fetch/直连会超时）
function npmTimes() {
  const url = 'https://registry.npmjs.org/@deepseek-ai/dsh'
  const attempts = [['-fsS'], ...(process.env.HTTPS_PROXY ? [['-fsS', '-x', process.env.HTTPS_PROXY]] : [])]
  for (const extra of attempts) {
    try { return JSON.parse(sh('curl', [...extra, '--max-time', '40', url])).time ?? {} } catch { /* next */ }
  }
  throw new Error('拿不到 npm packument（直连与代理都失败）')
}
const times = npmTimes()

const rel = sh(GH, ['api', `repos/${REPO}/releases?per_page=100`, '--jq', '.[] | [.tag_name, .published_at] | @tsv'])
  .split('\n').filter(Boolean).map((l) => l.split('\t'))

const rows = []
for (const [tag, publishedAt] of rel) {
  if (!/^v\d+\.\d+\.\d+/.test(tag)) continue
  let floor = null
  try {
    const dump = sh('git', ['show', tag + ':scripts/server-manager.mjs'])
    const m = /MIN_DSH_VERSION\s*=\s*'([^']+)'/.exec(dump)
    floor = m ? m[1] : null
  } catch (e) { floor = null }
  if (!floor) { rows.push({ tag, skip: 'tag 树里读不到 MIN_DSH_VERSION' }); continue }
  const t0 = times[floor]
  if (!t0) { rows.push({ tag: tag, floor: floor, skip: 'npm 上没有 ' + floor + ' 的发布时间' }); continue }
  let floorCommitAt = null
  try { floorCommitAt = sh('git', ['log', `-GMIN_DSH_VERSION = '${floor}'`, '--format=%cI', '-1', tag]) || null } catch { /* ignore */ }
  const total = hours(t0, publishedAt)
  const adapt = floorCommitAt ? hours(t0, floorCommitAt) : null
  const release = floorCommitAt ? hours(floorCommitAt, publishedAt) : null
  rows.push({ tag, shell: tag.slice(1), floor, t0, floorCommitAt, publishedAt, adapt, release, total, ok: total <= SLA_HOURS })
}

// SLA 的量纲是「**一个上游版本**从发布到我们发出稳定版」，所以必须按 dsh 版本聚合：
// 同一个地板可能被多个壳版本携带（0.18.0–0.18.4 都是 alpha.3），按 Release 计数会重复计量。
// 取每个地板**最早**的那次 Release（= 该版本适配完成的时点），全量明细仍留在 JSON 里。
const allMeasured = rows.filter((r) => !r.skip)
const byFloor = new Map()
for (const r of allMeasured) {
  const prev = byFloor.get(r.floor)
  if (!prev || new Date(r.publishedAt) < new Date(prev.publishedAt)) byFloor.set(r.floor, r)
}
const measured = [...byFloor.values()].sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt))
const skipped = rows.filter((r) => r.skip)
const totals = measured.map((r) => r.total).sort((a, b) => a - b)
const median = totals.length ? totals[Math.floor(totals.length / 2)] : NaN

const lines = []
lines.push('| 首个携带该地板的版本 | 随包地板 | 上游发布 | 地板提交 | 我方发布 | 适配 | 发布 | **合计** | ≤6h |')
lines.push('|---|---|---|---|---|---|---|---|---|')
for (const r of measured) {
  lines.push(`| ${r.shell} | \`${r.floor}\` | ${r.t0} | ${r.floorCommitAt ? r.floorCommitAt.slice(0, 16) : '—'} | ${r.publishedAt.slice(0, 16)} | ${fmt(r.adapt)} | ${fmt(r.release)} | **${fmt(r.total)}** | ${r.ok ? '✅' : '❌'} |`)
}
const stats = [
  `已量出版本：**${measured.length}**（跳过 ${skipped.length}）`,
  measured.length ? `合计中位 **${fmt(median)}**、最好 ${fmt(totals[0])}、最差 ${fmt(totals[totals.length - 1])}` : '',
  measured.length ? `达标（≤${SLA_HOURS}h）：**${measured.filter((r) => r.ok).length}/${measured.length}**` : '',
  measured.length ? `适配段中位 ${fmt(measured.map((r) => r.adapt).filter(Number.isFinite).sort((a, b) => a - b)[Math.floor(measured.length / 2)])}、发布段中位 ${fmt(measured.map((r) => r.release).filter(Number.isFinite).sort((a, b) => a - b)[Math.floor(measured.length / 2)])}` : '',
].filter(Boolean)

const md = ['## dsh 升级 SLA 报表', '', ...stats, '', ...lines, skipped.length ? `\n跳过：${skipped.map((r) => `${r.tag}（${r.skip}）`).join('；')}` : ''].join('\n')
console.log(md)

if (OUT) { writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), slaHours: SLA_HOURS, stats, perVersion: measured, allReleases: rows }, null, 2)); console.log(`\nJSON 已写入 ${OUT}`) }

if (UPSERT_ISSUE) {
  // /dev/stdin 在 runner 上不可用（实测：open /dev/stdin: no such device or address）⇒ 写临时文件
  const bodyFile = join(tmpdir(), 'dsh-sla-report-body.md')
  writeFileSync(bodyFile, md)
  try { sh(GH, ['label', 'create', 'sla-report', '--description', 'dsh 升级 SLA 报表', '--color', '0e8a16']) } catch (e) { /* 已存在即可 */ }
  const existing = sh(GH, ['issue', 'list', '--label', 'sla-report', '--state', 'open', '--json', 'number', '--jq', '.[0].number // empty'])
  if (existing) {
    sh(GH, ['issue', 'edit', existing, '--body-file', bodyFile])
    console.log('已更新 SLA issue #' + existing)
  } else {
    sh(GH, ['issue', 'create', '--label', 'sla-report', '--title', 'dsh 升级 SLA 报表（自动更新）', '--body-file', bodyFile])
    console.log('已创建 SLA issue')
  }
}

const recent = measured.slice(-RECENT)
const breached = recent.filter((r) => !r.ok)
if (FAIL_ON_BREACH && breached.length) {
  console.error(`\nSLA 门禁：最近 ${recent.length} 个版本里 ${breached.length} 个超 ${SLA_HOURS}h：${breached.map((r) => `${r.shell}=${fmt(r.total)}`).join(', ')}`)
  process.exit(1)
}
