#!/usr/bin/env node
// 文档门禁（2026-10-05 起）：
//   ① 文档里的**内部相对链接**必须可达（外部 http(s)/mailto/锚点 跳过；行内代码里的示例链接跳过，
//      否则技能里"引用插件 README 的 `[简体中文](README.zh.md)`"这类**示例**会被误判为坏链）；
//   ② `docs/**/*.md` 必须在 `docs/INDEX.md` 登记 —— 新增文档不登记即红，避免 docs/ 再次变成无人认领的堆积。
// 负向对照（必须红）：塞一个未登记的新文档 / 塞一条不存在的相对链接。
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, basename } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SKIP = ['node_modules', '.git', 'src-tauri/target', '.tmp-investigate', 'plugins/preinstalled', 'src-tauri/resources']

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (SKIP.some((s) => s.includes('/') ? join(dir, e).includes(s) : e === s)) continue
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (e.endsWith('.md')) out.push(p)
  }
  return out
}

const docFiles = walk(ROOT).filter((p) => {
  const r = relative(ROOT, p)
  return /^(README|CONTRIBUTING|ENGINEERING-NOTES)\.md$/.test(r) || r.startsWith('docs/') || r.startsWith('.dsh/skills/') || r.startsWith('.agents/notes/implemented/')
})

/** 去掉行内代码（`…`）与围栏代码块，避免把示例当链接。 */
function stripCode(text) {
  const noFence = text.replace(/```[\s\S]*?```/g, '')
  return noFence.replace(/`[^`\n]*`/g, '``')
}

const linkProblems = []
for (const file of docFiles) {
  const text = stripCode(readFileSync(file, 'utf8'))
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const raw = m[1]
    if (/^(https?:|mailto:|#|tel:)/.test(raw)) continue
    const target = raw.split('#')[0]
    if (target === '') continue
    const abs = resolve(dirname(file), decodeURIComponent(target))
    if (!existsSync(abs)) linkProblems.push(`${relative(ROOT, file)} → ${raw}`)
  }
}

const index = readFileSync(join(ROOT, 'docs/INDEX.md'), 'utf8')
const unregistered = readdirSync(join(ROOT, 'docs'), { recursive: true })
  .filter((p) => String(p).endsWith('.md'))
  .map((p) => String(p))
  .filter((p) => p !== 'INDEX.md')
  .filter((p) => !index.includes(basename(p)))

if (linkProblems.length || unregistered.length) {
  if (linkProblems.length) { console.error(`FAIL: ${linkProblems.length} 条失效的内部链接`); for (const l of linkProblems) console.error('   ' + l) }
  if (unregistered.length) { console.error(`FAIL: ${unregistered.length} 个 docs 文档未在 docs/INDEX.md 登记`); for (const u of unregistered) console.error('   docs/' + u) }
  process.exit(1)
}
console.log(`PASS: 文档门禁（${docFiles.length} 个文档的内部链接可达；docs/ 下所有文档已在 INDEX.md 登记）`)
