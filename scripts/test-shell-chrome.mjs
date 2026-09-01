#!/usr/bin/env node
// Contract test for the injected shell chrome (src-tauri/resources/ui/shell-chrome.js).
//
// The chrome is the shell menu definition point (SHELL_MENUS) with a
// dual-transport action table (ACTIONS: IPC command for local pages, bridge
// path for the remote dsh page). This test keeps that contract honest:
//   1. the chrome parses and exposes its config in a vm sandbox;
//   2. every menu item / direct action id resolves in ACTIONS;
//   3. every ACTIONS entry has a non-empty IPC command and a '/' bridge path;
//   4. cross-file: every bridge path has a handle_bridge_conn match arm and
//      every IPC command is registered in invoke_handler (both in lib.rs);
//   5. the window controls (minimize / toggle-maximize / close) are wired;
//   6. lib.rs actually embeds and injects the chrome.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const chromePath = join(root, 'src-tauri', 'resources', 'ui', 'shell-chrome.js')
const libRsPath = join(root, 'src-tauri', 'src', 'lib.rs')
const chromeSrc = readFileSync(chromePath, 'utf8')
const libRs = readFileSync(libRsPath, 'utf8')

// ── load the chrome config in a sandbox (render path is skipped) ────────────
const sandbox = { console, __DSH_CHROME_TEST__: {} }
vm.createContext(sandbox)
vm.runInContext(chromeSrc, sandbox, { filename: 'shell-chrome.js' })
const { SHELL_MENUS, ACTIONS } = sandbox.__DSH_CHROME_TEST__.config
assert.ok(Array.isArray(SHELL_MENUS) && SHELL_MENUS.length >= 1, 'SHELL_MENUS is a non-trivial array')
assert.ok(ACTIONS && typeof ACTIONS === 'object', 'ACTIONS table present')

// ── 1. structure: single icon menu; brand name shown first ──────────────────
assert.equal(SHELL_MENUS.length, 1, 'all shell menus live in one app menu (icon dropdown)')
assert.equal(SHELL_MENUS[0].id, 'app', 'the single menu id is app')
assert.ok(Array.isArray(SHELL_MENUS[0].items), 'app menu has dropdown items')
const brand = SHELL_MENUS[0].items[0]
assert.ok(brand && brand.id === 'brand' && brand.type === 'brand', 'dropdown first row shows the app name (brand)')
const ids = SHELL_MENUS[0].items.map((i) => i.id).filter(Boolean)
for (const id of ['proxy-settings', 'check-update', 'dev-mode', 'refresh', 'restart', 'open-data', 'about', 'quit']) {
  assert.ok(ids.includes(id), `app menu contains ${id}`)
}

// ── 2. every clickable menu id resolves in ACTIONS ───────────────────────────
for (const entry of SHELL_MENUS) {
  const clickable = (entry.items || []).filter((i) => i.id && i.type !== 'brand' && i.type !== 'sep')
  for (const item of clickable) {
    assert.ok(ACTIONS[item.id], `menu item "${item.id}" (menu ${entry.id}) has an ACTIONS entry`)
  }
}

// ── 3. every ACTIONS entry has both transports ──────────────────────────────
for (const [id, a] of Object.entries(ACTIONS)) {
  assert.ok(typeof a.ipc === 'string' && /^[a-z_]+$/.test(a.ipc), `action "${id}" has a valid ipc command (${a.ipc})`)
  assert.ok(typeof a.bridge === 'string' && a.bridge.startsWith('/'), `action "${id}" has a '/' bridge path (${a.bridge})`)
  if (a.method) assert.ok(a.method === 'GET', `action "${id}" uses GET explicitly (state queries only)`)
}

// ── 4. cross-file contract: bridge arms + invoke_handler registration ───────
for (const [id, a] of Object.entries(ACTIONS)) {
  assert.ok(
    libRs.includes(`"${a.bridge}"`),
    `bridge path ${a.bridge} (action "${id}") has a match arm in lib.rs`,
  )
  assert.ok(
    libRs.includes(a.ipc),
    `ipc command ${a.ipc} (action "${id}") is registered in lib.rs`,
  )
}

// ── 5. window controls wired ────────────────────────────────────────────────
for (const id of ['minimize', 'toggle-maximize', 'close']) {
  assert.ok(ACTIONS[id], `window control "${id}" has an ACTIONS entry`)
}

// ── 6. lib.rs embeds and injects the chrome ─────────────────────────────────
assert.ok(libRs.includes('include_str!("../resources/ui/shell-chrome.js")'), 'lib.rs embeds the chrome via include_str!')
assert.ok(libRs.includes('inject_shell_chrome'), 'lib.rs has the inject_shell_chrome wiring')

// ── 7. dev build identity (side-by-side install isolation) ──────────────────
const devConfPath = join(root, 'src-tauri', 'tauri.dev.conf.json')
const devConf = JSON.parse(readFileSync(devConfPath, 'utf8'))
const mainConfPath = join(root, 'src-tauri', 'tauri.conf.json')
const mainConf = JSON.parse(readFileSync(mainConfPath, 'utf8'))
assert.ok(
  devConf.productName && devConf.productName !== mainConf.productName,
  'dev config overrides productName',
)
assert.ok(devConf.identifier && devConf.identifier !== 'dev.dsh.desktop', 'dev config overrides identifier')
// NSIS 安装器按 MainBinaryName.exe 检测运行实例——dev 版必须用独立 exe 名，
// 否则正式版在跑时装 dev 版会被误判为 dev 在运行（无法并存安装）。
assert.ok(
  devConf.mainBinaryName && devConf.mainBinaryName !== 'dsh-desktop',
  'dev config sets a distinct mainBinaryName (side-by-side install)',
)
assert.ok(libRs.includes('fn toast_clsid'), 'lib.rs derives the toast CLSID per build identity')
assert.ok(libRs.includes('__DSH_PRODUCT_NAME__'), 'chrome preamble injects the product name')
assert.ok(chromeSrc.includes('__DSH_PRODUCT_NAME__'), 'chrome renders the injected product name')

// ── 8. UI 可读性 + 真实图标（防回归）────────────────────────────────────
// 白色主题 + 显式文字色：shadow root 不继承页面（避免黑字压深底看不清）。
assert.ok(chromeSrc.includes('#1f2328'), 'chrome uses the white-theme text color #1f2328 (no page-inherit)')
assert.ok(chromeSrc.includes("type: 'brand'"), 'chrome renders the brand (app name) dropdown row')
assert.ok(chromeSrc.includes('__DSH_LOGO__'), 'chrome uses the injected real logo')
assert.ok(libRs.includes('__DSH_LOGO__'), 'lib.rs injects the real logo data URI')
assert.ok(chromeSrc.includes('dsh-chrome-push') || chromeSrc.includes('paddingTop'), 'chrome pushes page content below the title bar without extra scrollbar')
assert.ok(chromeSrc.includes('flashHit'), 'chrome has a click-hit diagnostic flash (red ring on chrome hit)')

console.log('PASS — shell chrome contract (menus, actions, bridge, IPC)')
process.exit(0)
