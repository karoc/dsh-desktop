#!/usr/bin/env node
// 让 src-tauri/Cargo.lock 里 dsh-desktop 的版本与 src-tauri/Cargo.toml 一致。
// 为什么需要：release-please 的 extra-files 对 Cargo.lock 的过滤式 jsonpath 实测**未被应用**
// （2026-10-06：Cargo.lock 停在 0.15.0，而 package.json/Cargo.toml 已 0.16.0 ⇒ 发布构建的
// test-manifest-consistency 红、资产为空）。Cargo.toml 是版本真源，Cargo.lock 的这一行是派生物。
// generic 逐字替换有误伤同版本依赖的风险，所以这里**精确定位到 dsh-desktop 包段**再改。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const toml = readFileSync(join(root, 'src-tauri', 'Cargo.toml'), 'utf8')
const version = toml.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
if (!version) { console.error('FAIL: src-tauri/Cargo.toml 里找不到 version'); process.exit(1) }
const lockPath = join(root, 'src-tauri', 'Cargo.lock')
const lock = readFileSync(lockPath, 'utf8')
const re = /(\[\[package\]\]\nname = "dsh-desktop"\nversion = ")([^"]+)(")/
const m = lock.match(re)
if (!m) { console.error('FAIL: Cargo.lock 里找不到 dsh-desktop 包段'); process.exit(1) }
if (m[2] === version) { console.log(`PASS: Cargo.lock 的 dsh-desktop 已是 ${version}`); process.exit(0) }
writeFileSync(lockPath, lock.replace(re, `$1${version}$3`))
console.log(`FIXED: Cargo.lock 的 dsh-desktop ${m[2]} → ${version}`)
