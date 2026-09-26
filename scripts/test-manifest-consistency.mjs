#!/usr/bin/env node
// 仓库清单一致性门禁（S0）：
//   1. package.json 里所有 `node <path>.mjs` 形式的脚本目标必须存在
//      （防"插件管理移除时漏删 script 条目"这类断链）；
//   2. 四处版本号必须一致：package.json / src-tauri/tauri.conf.json /
//      src-tauri/Cargo.toml / src-tauri/Cargo.lock
//      （Cargo.lock 曾长期停在 0.6.3，任何 cargo 命令都会把它改脏）。
//
// 负向对照（必须变红）：
//   - 把任一 script 的路径改成一个不存在的文件；
//   - 把 Cargo.lock 里 dsh-desktop 的 version 改回 0.6.3。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

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

// ── 1. script 目标存在 ─────────────────────────────────────────────────────
const targets = new Set()
for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
  for (const m of String(cmd).matchAll(/node\s+(\.\/)?(scripts\/[\w./-]+\.mjs)/g)) {
    targets.add(m[2])
  }
}
check(`script 目标存在（${targets.size} 个 .mjs）`, () => {
  const missing = []
  for (const rel of targets) {
    try {
      readFileSync(join(root, rel))
    } catch {
      missing.push(rel)
    }
  }
  assert.equal(missing.length, 0, `缺失的脚本目标: ${missing.join(', ')}`)
})

// ── 2. 四处版本一致 ───────────────────────────────────────────────────────
const tauri = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const cargoToml = readFileSync(join(root, 'src-tauri', 'Cargo.toml'), 'utf8')
const cargoLock = readFileSync(join(root, 'src-tauri', 'Cargo.lock'), 'utf8')

const tomlVersion = cargoToml.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? null
const lockBlock = cargoLock.split(/^\[\[package\]\]$/m).find(b => /^\s*name\s*=\s*"dsh-desktop"\s*$/m.test(b)) ?? ''
const lockVersion = lockBlock.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? null

check('四处版本一致（package.json / tauri.conf.json / Cargo.toml / Cargo.lock）', () => {
  const versions = { 'package.json': pkg.version, 'tauri.conf.json': tauri.version, 'Cargo.toml': tomlVersion, 'Cargo.lock': lockVersion }
  const distinct = new Set(Object.values(versions))
  assert.equal(distinct.size, 1, `版本不一致: ${JSON.stringify(versions)}`)
  assert.ok(pkg.version, 'package.json 没有 version')
})

// ── 文档里的测试套数必须等于 npm test 的真实链长 ──────────────────────────
// 加一套测试却忘了改 README/CONTRIBUTING 是反复发生的漂移（本次实施中就出现
// 过 9/11/12/13 四个数字并存）。这条门禁把"文档数字"变成可失败断言。
check('文档中的测试套数与 npm test 链一致', () => {
  const chain = (pkg.scripts?.test ?? '').split(' && ').map(s => s.trim()).filter(Boolean)
  const expected = chain.length
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const contributing = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8')
  const claimed = [...readme.matchAll(/全量 (\d+) 套/g), ...contributing.matchAll(/全量 (\d+) 套/g)]
    .map(m => Number(m[1]))
  assert.ok(claimed.length >= 2, `README/CONTRIBUTING 至少各要有一处"全量 N 套"（找到 ${claimed.length} 处）`)
  for (const n of claimed) assert.equal(n, expected, `文档写 ${n} 套，npm test 实际 ${expected} 套`)
})

if (failures > 0) {
  console.error(`\nFAILED: ${failures} 项`)
  process.exit(1)
}
console.log('\nPASS: manifest 一致性（script 目标 + 四处版本）')
