#!/usr/bin/env node
// 让 src-tauri/Cargo.lock 里 dsh-desktop 的版本与 src-tauri/Cargo.toml 一致。
// 为什么需要：release-please 的 extra-files 对 Cargo.lock 的过滤式 jsonpath 实测**未被应用**
// （2026-10-06：Cargo.lock 停在 0.15.0，而 package.json/Cargo.toml 已 0.16.0 ⇒ 发布构建的
// test-manifest-consistency 红、资产为空）。Cargo.toml 是版本真源，Cargo.lock 的这一行是派生物。
// generic 逐字替换有误伤同版本依赖的风险，所以这里**精确定位到 dsh-desktop 包段**再改。
//
// 2026-10-16 修复（**发布阻断级**）：原实现把行尾硬编码成 `\n`，于是同一份内容在 ubuntu job 绿、
// 在 windows job 红 —— GitHub 的 Windows runner 用 core.autocrlf=true 检出，Cargo.lock 到手是 CRLF，
// 正则匹配不上 ⇒ `npm run bundle`（= sync:cargo-lock && tauri build）在第一步就退出 ⇒ **打不出
// NSIS 安装包**（main 上连续多次 CI 因此失败；v0.18.0 那次侥幸绿，是因为当时 lock 里的
// dsh-desktop 还是 0.17.0、cargo 先把它重写成了 LF）。现在：按实际行尾解析、按原行尾写回，
// 并在真的找不到时把判据（大小 / CRLF 数 / 是否出现包名 / 采用的 EOL）打出来，不再只说一句"找不到"。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// DSH_LOCK_ROOT 只给回归测试用（scripts/test-cargo-lock-sync.mjs 指向临时目录）；正常构建不设。
const root = process.env.DSH_LOCK_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..')
const toml = readFileSync(join(root, 'src-tauri', 'Cargo.toml'), 'utf8')
const version = toml.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
if (!version) { console.error('FAIL: src-tauri/Cargo.toml 里找不到 version'); process.exit(1) }
const lockPath = join(root, 'src-tauri', 'Cargo.lock')
const lock = readFileSync(lockPath, 'utf8')
// 行尾跟随文件本身：CRLF 检出的文件必须仍以 CRLF 写回（否则 git 会把整份文件看成"改了"）。
const eol = /\r\n/.test(lock) ? '\r\n' : '\n'
const re = new RegExp(`(\\[\\[package\\]\\]${eol}name = "dsh-desktop"${eol}version = ")([^"]+)(")`)
const m = lock.match(re)
if (!m) {
  const crlf = (lock.match(/\r\n/g) || []).length
  console.error('FAIL: Cargo.lock 里找不到 dsh-desktop 包段'
    + `（size=${lock.length} CRLF行=${crlf} 出现包名=${lock.includes('name = "dsh-desktop"')}`
    + ` 采用EOL=${eol === '\r\n' ? 'CRLF' : 'LF'}）`)
  process.exit(1)
}
if (m[2] === version) { console.log(`PASS: Cargo.lock 的 dsh-desktop 已是 ${version}`); process.exit(0) }
writeFileSync(lockPath, lock.replace(re, `$1${version}$3`))
console.log(`FIXED: Cargo.lock 的 dsh-desktop ${m[2]} → ${version}`)
