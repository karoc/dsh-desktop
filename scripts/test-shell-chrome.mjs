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
import { existsSync, readFileSync } from 'node:fs'
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
for (const id of ['proxy-settings', 'plugins', 'check-update', 'dev-mode', 'refresh', 'restart', 'open-data', 'legacy-cleanup', 'about', 'quit']) {
  assert.ok(ids.includes(id), `app menu contains ${id}`)
}

// ── 2. every clickable menu id resolves in ACTIONS ───────────────────────────
// 壳内就地动作（关于/检查更新/旧版清理 = 壳内模态弹窗）不经 IPC/桥，不占
// ACTIONS；其余跨壳动作（含插件管理=打开壳内独立窗口）必须映射。
const IN_SHELL_ACTIONS = new Set(['about', 'legacy-cleanup'])
for (const entry of SHELL_MENUS) {
  const clickable = (entry.items || []).filter((i) => i.id && i.type !== 'brand' && i.type !== 'sep' && !IN_SHELL_ACTIONS.has(i.id))
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
assert.ok(devConf.identifier && devConf.identifier !== mainConf.identifier, 'dev config overrides identifier (side-by-side)')
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
// 随系统配色（浅色默认 #1f2328，深色由 prefers-color-scheme 覆盖）；显式文字色
// 不继承页面（避免黑字压深底看不清）。
assert.ok(chromeSrc.includes('#1f2328'), 'chrome light scheme keeps the #1f2328 text color')
assert.ok(chromeSrc.includes('prefers-color-scheme'), 'chrome follows the OS color scheme (light/dark)')
assert.ok(chromeSrc.includes("type: 'brand'"), 'chrome renders the brand (app name) dropdown row')
assert.ok(chromeSrc.includes('__DSH_LOGO__'), 'chrome uses the injected real logo')
assert.ok(libRs.includes('__DSH_LOGO__'), 'lib.rs injects the real logo data URI')
assert.ok(chromeSrc.includes('dsh-chrome-push') || chromeSrc.includes('paddingTop'), 'chrome pushes page content below the title bar without extra scrollbar')
assert.ok(chromeSrc.includes('--dsh-shell-menubar-h'), 'chrome exposes --dsh-shell-menubar-h so fullscreen plugin overlays clear the menubar')
// ── 全屏浮层自适应：菜单栏自动收起（壳侧通用，插件无需配合）──
assert.ok(chromeSrc.includes('fullscreen-hidden'), 'chrome auto-hides the menubar over fullscreen plugin overlays')
assert.ok(chromeSrc.includes('edge-strip'), 'chrome keeps a 4px top hover strip to reveal the hidden menubar')
assert.ok(chromeSrc.includes('elementFromPoint'), 'chrome probes the viewport to detect fullscreen fixed overlays')
assert.ok(chromeSrc.includes('mini-toast'), 'chrome shows in-shell transient toasts (no flash, no silent actions)')
assert.ok(!chromeSrc.includes('flashHit'), 'chrome has no diagnostic red-ring flash anymore')
assert.ok(chromeSrc.includes('errbanner'), 'chrome renders the failure-disclosure banner (no more blank screen)')
assert.ok(chromeSrc.includes('shell-status'), 'chrome polls shell status for failure disclosure')
// ── 检查更新 / 关于 = 壳内模态弹窗（不再是 toast/瞬时提示）──────────
assert.ok(chromeSrc.includes('dialog-backdrop'), 'chrome has a modal dialog layer')
assert.ok(chromeSrc.includes('openCheckUpdateDialog'), 'check-update opens an in-shell modal (info + 确定 + 立即更新)')
assert.ok(chromeSrc.includes('openAboutDialog'), 'about opens an in-shell modal (name/version/build date/dsh version + 确定)')
assert.ok(chromeSrc.includes('__DSH_BUILD_DATE__'), 'about dialog shows the injected build date')
// ── 插件管理 = 壳内独立管理窗口（全局可用，dsh 崩溃时也可管理）─────
// 窗口页复用原插件控制台渲染核心（src/plugin-console.js），数据走环回桥
// （桥由壳拉起、不依赖 dsh）；桥端口由 lib.rs 对 plugins 窗口注入。
assert.ok(chromeSrc.includes('/shell/open-plugins'), 'chrome opens the plugins window via /shell/open-plugins')
assert.ok(libRs.includes('"/shell/open-plugins"'), 'lib.rs has the /shell/open-plugins bridge arm')
assert.ok(libRs.includes('fn open_plugins_window'), 'lib.rs opens the plugins manager window')
assert.ok(libRs.includes('inject_plugins_preamble'), 'lib.rs injects the bridge port into the plugins window (global availability)')
assert.ok(existsSync(join(root, 'src', 'plugin-console.html')), 'plugins window page exists (src/plugin-console.html)')
assert.ok(existsSync(join(root, 'src', 'plugin-console.js')), 'plugins window script exists (src/plugin-console.js)')
assert.ok(chromeSrc.includes('dshc-btn'), 'chrome defensively hides a leftover legacy fab (.dshc-btn)')
// ── 工具窗不被窗口状态记忆覆盖居中（修复"闪一下居中又跳回左边"）───
assert.ok(libRs.includes('with_denylist'), 'window-state plugin excludes utility windows via denylist')
assert.ok(libRs.includes('"settings"') && libRs.includes('"plugins"'), 'settings & plugins windows are denylisted from window-state restore')
assert.ok(libRs.includes('__DSH_BUILD_DATE__'), 'lib.rs injects the build date into the chrome preamble')
assert.ok(readFileSync(join(root, 'src-tauri', 'build.rs'), 'utf8').includes('DSH_BUILD_DATE'), 'build.rs emits the DSH_BUILD_DATE env (About build date)')

// ── 9. 旧版接管安全契约（2026-09-09 事故防回归）────────────────────────────
// 旧版卸载器（0.3.9）的 Section Uninstall 首句是 CheckIfAppIsRunning
// "dsh-desktop.exe"，静默模式直接 TerminateProcess **按 exe 名匹配的所有进程**
// （不看路径）—— 与正式版同名。因此装包钩子与壳内清理都绝不能无条件执行它。
const nsh = readFileSync(join(root, 'src-tauri', 'resources', 'nsis', 'legacy-takeover.nsh'), 'utf8')
// 只看代码行（NSIS 注释以 ';' 开头），避免注释里的字样干扰断言
const nshCode = nsh.split('\n').filter((l) => !l.trim().startsWith(';')).join('\n')
assert.ok(!/ExecToStack[^\n]*wmic/i.test(nshCode), 'legacy hook no longer runs a wmic probe (absent on Win11 24H2+, failed open)')
assert.ok(
  nshCode.includes('nsis_tauri_utils::FindProcessCurrentUser "dsh-desktop.exe"'),
  'legacy hook gates the legacy uninstaller behind a same-name process check',
)
const gateIdx = nshCode.indexOf('FindProcessCurrentUser "dsh-desktop.exe"')
const execIdx = nshCode.indexOf('ExecWait')
assert.ok(gateIdx > 0 && execIdx > gateIdx, 'ExecWait only appears AFTER the same-name process gate')
assert.ok(nshCode.includes('legacy_pre_orphan'), 'legacy hook deletes an orphan uninstaller when the legacy main exe is gone')
assert.ok(libRs.includes('legacy-app-present'), 'rust cleanup refuses when the legacy main exe is still present')
assert.ok(!libRs.includes('Command::new(&uninstaller)'), 'rust cleanup never spawns the legacy uninstaller')

// ── 10. manager 退出看护契约（2026-09-09：退出无证据 + UI 分不清死活）──────
// 只检测 + 取证 + 提示，**绝不自动重启**（决定 D1：自动重启会掩盖复现）。
// 两条检测路径（stdout EOF / try_wait 看护线程）共享世代围栏，先到者登记。
const guardRsPath = join(root, 'src-tauri', 'src', 'manager_guard.rs')
assert.ok(existsSync(guardRsPath), 'manager_guard.rs exists (lifecycle guard module)')
const guardRs = readFileSync(guardRsPath, 'utf8')
assert.ok(libRs.includes('mod manager_guard'), 'lib.rs declares the manager_guard module')
assert.ok(libRs.includes('fn handle_manager_exit'), 'lib.rs has the manager exit handler')
assert.ok(libRs.includes('fn start_manager_watchdog'), 'lib.rs has the try_wait watchdog thread')
assert.ok(libRs.includes('try_wait'), 'lib.rs uses try_wait (authoritative liveness/exit code)')
assert.ok(libRs.includes('reported_generation'), 'exit reporting is idempotent across the two detectors')
assert.ok(libRs.includes('"managerAlive": alive'), '/shell/status exposes the real managerAlive')
assert.ok(libRs.includes('"hasServer": alive'), 'hasServer is derived from the real liveness (bug ① fixed)')
assert.ok(libRs.includes('"lastManagerExit"'), '/shell/status exposes lastManagerExit (code + evidence dir)')
assert.ok(libRs.includes('"/shell/open-evidence"'), 'bridge has the /shell/open-evidence arm')
assert.ok(libRs.includes('fn open_evidence_dir'), 'lib.rs opens the latest evidence directory')
assert.ok(guardRs.includes('manager-crash-'), 'evidence dirs are named manager-crash-<ts>-gen<N>')
assert.ok(guardRs.includes('EVIDENCE_KEEP'), 'evidence dirs are pruned to a bounded count')
assert.ok(guardRs.includes('orphans.txt') && guardRs.includes('wer.txt'), 'evidence includes orphans + WER state')
// 不自动重启：退出处理区域（handle_manager_exit / watchdog / status）不得拉起服务。
const crashStart = libRs.indexOf('fn handle_manager_exit')
const crashEnd = libRs.indexOf('fn restart_server')
assert.ok(crashStart > 0 && crashEnd > crashStart, 'locate the crash-handling region in lib.rs')
const crashRegion = libRs.slice(crashStart, crashEnd)
assert.ok(!/start_server\(|restart_server\(/.test(crashRegion), 'manager exit path never restarts the service (D1)')
assert.ok(!/Command::new/.test(crashRegion), 'manager exit path spawns nothing (forensics only)')
assert.ok(!/start_server|restart_server/.test(guardRs), 'manager_guard.rs never spawns/restarts the manager')
// bug ②：stop_child 必须先 try_wait，已退出的 PID 绝不再 taskkill（PID 复用面）。
const stopStart = libRs.indexOf('fn stop_child(')
const stopEnd = libRs.indexOf('fn no_console_window')
const stopRegion = libRs.slice(stopStart, stopEnd)
assert.ok(stopRegion.includes('try_wait'), 'stop_child checks try_wait before killing')
assert.ok(
  stopRegion.indexOf('try_wait') < stopRegion.indexOf('taskkill'),
  'stop_child only taskkills a process that is still alive',
)
// UI：条幅常驻显示退出码/证据目录 + 手动「重启服务」。
assert.ok(chromeSrc.includes('open-evidence'), 'chrome can open the evidence dir from the banner')
assert.ok(chromeSrc.includes('evidenceDir'), 'chrome reads the evidence dir from shell-status')
assert.ok(chromeSrc.includes('重启服务'), 'chrome banner offers a manual restart button')
assert.ok(readFileSync(join(root, 'src', 'app.js'), 'utf8').includes('lastManagerExit'), 'launcher shows the exit code + evidence hint')
// 故障回退导航只认真实本地页：setup 时 w.url() 可能是 about:blank，若被当成
// 启动页 URL，manager 被杀后窗口会落到 about:blank 黑屏（2026-09-09 实机验证）。
assert.ok(libRs.includes('fn is_shell_local_url'), 'launcher URL accepts both tauri:// and http://tauri.localhost (Windows)')
assert.ok(libRs.includes('fn navigate_back_to_launcher'), 'crash fallback navigates back to the launcher page')

console.log('PASS — shell chrome contract (menus, actions, bridge, IPC)')
process.exit(0)
