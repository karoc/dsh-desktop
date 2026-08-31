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
assert.ok(Array.isArray(SHELL_MENUS) && SHELL_MENUS.length >= 3, 'SHELL_MENUS is a non-trivial array')
assert.ok(ACTIONS && typeof ACTIONS === 'object', 'ACTIONS table present')

// ── 1. structure: app menu first, top-level proxy-settings direct entry ─────
assert.equal(SHELL_MENUS[0].id, 'app', 'first menu is the app menu (DSH Smoothly Desktop)')
assert.ok(Array.isArray(SHELL_MENUS[0].items), 'app menu has dropdown items')
const proxyEntry = SHELL_MENUS.find((e) => e.id === 'proxy-settings')
assert.ok(proxyEntry, 'top-level 代理设置… entry exists')
assert.equal(typeof proxyEntry.action, 'string', '代理设置… is a direct-action entry (opens the settings window)')
assert.ok(SHELL_MENUS.some((e) => e.id === 'view' && e.items), '视图 dropdown menu exists')
assert.ok(SHELL_MENUS.some((e) => e.id === 'help' && e.items), '帮助 dropdown menu exists')

// ── 2. every menu id resolves in ACTIONS ────────────────────────────────────
for (const entry of SHELL_MENUS) {
  const ids = entry.items ? entry.items.map((i) => i.id).filter(Boolean) : [entry.action]
  for (const id of ids) {
    assert.ok(ACTIONS[id], `menu item "${id}" (menu ${entry.id}) has an ACTIONS entry`)
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

console.log('PASS — shell chrome contract (menus, actions, bridge, IPC)')
process.exit(0)
