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
const { SHELL_MENUS, ACTIONS, computeCaptionPlan, WINDOWS_TITLEBAR_H, SHELL_BAR_H } = sandbox.__DSH_CHROME_TEST__.config
assert.ok(Array.isArray(SHELL_MENUS) && SHELL_MENUS.length >= 1, 'SHELL_MENUS is a non-trivial array')
assert.ok(ACTIONS && typeof ACTIONS === 'object', 'ACTIONS table present')

// ── 1. structure: single icon menu; brand name shown first ──────────────────
assert.equal(SHELL_MENUS.length, 1, 'all shell menus live in one app menu (icon dropdown)')
assert.equal(SHELL_MENUS[0].id, 'app', 'the single menu id is app')
assert.ok(Array.isArray(SHELL_MENUS[0].items), 'app menu has dropdown items')
const brand = SHELL_MENUS[0].items[0]
assert.ok(brand && brand.id === 'brand' && brand.type === 'brand', 'dropdown first row shows the app name (brand)')
const ids = SHELL_MENUS[0].items.map((i) => i.id).filter(Boolean)
for (const id of ['proxy-settings', 'disable-plugins', 'check-update', 'dev-mode', 'refresh', 'restart', 'open-data', 'legacy-cleanup', 'cache-cleanup', 'about', 'quit']) {
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
// ── 插件管理已整体移除（0.1.6-alpha.2 起交给 dsh 自带的 Web 侧边栏「插件」页）──
// 负向断言：这些入口一旦回潮就是回归（会与 dsh 的插件管理器双写 profile 状态）。
assert.ok(!chromeSrc.includes('/shell/open-plugins'), 'chrome no longer opens a shell-side plugins window')
assert.ok(!libRs.includes('"/shell/open-plugins"'), 'lib.rs has no /shell/open-plugins bridge arm')
assert.ok(!libRs.includes('"/plugins/'), 'lib.rs has no /plugins/* bridge arms')
assert.ok(!libRs.includes('fn open_plugins_window'), 'lib.rs has no plugins manager window')
assert.ok(!libRs.includes('inject_plugins_preamble'), 'lib.rs has no plugins-window preamble injection')
assert.ok(!existsSync(join(root, 'src', 'plugin-console.html')), 'no shell-side plugin console page')
assert.ok(!existsSync(join(root, 'src', 'plugin-console.js')), 'no shell-side plugin console script')
assert.ok(!existsSync(join(root, 'plugins', 'dsh-plugin-console')), 'no in-page plugin console plugin')
// 安全网（唯一保留的插件相关动作）：不依赖 dsh 的逃生口。
assert.ok(chromeSrc.includes('/shell/disable-third-party-plugins'), 'chrome wires the disable-third-party-plugins safety net')
assert.ok(libRs.includes('"/shell/disable-third-party-plugins"'), 'lib.rs has the /shell/disable-third-party-plugins bridge arm')
assert.ok(libRs.includes('fn disable_third_party_plugins'), 'lib.rs implements the safety net command')
assert.ok(libRs.includes('fn disable_third_party_plugins(app: AppHandle) -> Result<serde_json::Value, String>'), 'the safety net is a registered tauri command')
assert.ok(libRs.includes('disable_third_party_plugins,'), 'the safety net is in the invoke_handler list')
// 备份先于改动：没有备份就绝不改用户文件（负向保证）。
const safetyNet = libRs.slice(libRs.indexOf('fn disable_third_party_plugins'))
const copyAt = safetyNet.indexOf('std::fs::copy(&path, &backup)')
const writeAt = safetyNet.indexOf('write_web_profile_bundles(&runtime, &template)')
assert.ok(copyAt > 0 && writeAt > copyAt, 'the safety net backs up the manifest BEFORE rewriting the bundles')
// ── 工具窗不被窗口状态记忆覆盖居中（修复"闪一下居中又跳回左边"）───
assert.ok(libRs.includes('with_denylist'), 'window-state plugin excludes utility windows via denylist')
// 工具窗（设置 / 确认）都不能被 window-state 记忆位置 —— 否则"闪一下居中又跳回左边"。
assert.ok(libRs.includes('with_denylist(&["settings", "confirm"])'),
  'the settings + confirm windows are denylisted from window-state restore')
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
const appJs = readFileSync(join(root, 'src', 'app.js'), 'utf8')
assert.ok(appJs.includes('lastManagerExit'), 'launcher shows the exit code + evidence hint')
assert.ok(appJs.includes("invoke('get_shell_status')"), 'launcher re-checks shell status on load (the crash event precedes the fallback navigation)')
// S6：失败态复用「打开数据目录」按钮，改指崩溃证据目录（不新增按钮 —— 启动页
// .shell 是 height:100% + 居中且无滚动，多一项 + 长路径会不可达）。
assert.ok(/open_evidence_dir/.test(appJs), 'launcher app.js can open the evidence dir on failure')
assert.ok(/open_data_dir/.test(appJs), 'launcher app.js keeps the data-dir fallback')
assert.ok(/let evidenceDir/.test(appJs), 'launcher tracks whether a crash evidence dir exists')

// ── 预装插件版本（S10）──────────────────────────────────────────────────
// 真源是 manager 写进 <runtime>/dsh.json 的 preinstalledVersions；Rust 有**两处**
// 独立 JSON（桥 /shell/state 与 IPC get_shell_state）必须同步，chrome 的关于
// 弹窗从 get_shell_status 的结果里读 preinstalled。这里守"两处都要有"。
const managerSrc = readFileSync(join(root, 'scripts', 'server-manager.mjs'), 'utf8')
assert.ok(/manifest\.preinstalledVersions = versions/.test(managerSrc), 'manager records preinstalled versions into dsh.json')
assert.ok(/versions\[pkgName\] =/.test(managerSrc), 'manager reads each preinstalled package version')
assert.equal((libRs.match(/"preinstalled": preinstalled_versions\(/g) || []).length, 2,
  'both shell-state JSON sites expose preinstalled (bridge /shell/state + IPC get_shell_state)')
assert.ok(/fn preinstalled_versions\(/.test(libRs), 'lib.rs reads preinstalledVersions from dsh.json')
// 关于弹窗必须走**带 preinstalled 的那个端点**：call('shell-status') → /shell/status
// (shell_status_json) 不含该字段，真机上「预装插件」几行因此完全不渲染（2026-09-25
// dev 实测）；带 preinstalled 的是 shell-state（/shell/state 与 IPC get_shell_state）。
{
  const aboutStart = chromeSrc.indexOf('function openAboutDialog')
  const aboutBody = chromeSrc.slice(aboutStart, chromeSrc.indexOf('// 旧版接管双通道', aboutStart))
  assert.ok(/call\('shell-state'\)/.test(aboutBody), 'About dialog must fetch preinstalled via shell-state (the endpoint that carries it)')
  assert.ok(!/call\('shell-status'\)/.test(aboutBody), 'About dialog must NOT use shell-status (it has no preinstalled field)')
}

// ── 升级单向性与回滚纪律（S3）──────────────────────────────────────────
// dsh ≥0.1.7-alpha.1 把会话写成 v4，旧读取器拒读；迁移是"旁挂新代文件"，所以
// "装回旧版"不是回滚、且"还能打开"不能作为回滚成功的判据。这条纪律必须同时
// 出现在 ① 检查更新弹窗（含备份入口）② 托盘标签/通知 ③ README。
assert.ok(/UPGRADE_ROLLBACK_WARNING/.test(chromeSrc), 'chrome defines the v4 rollback warning')
assert.ok((chromeSrc.match(/UPGRADE_ROLLBACK_WARNING,/g) || []).length >= 2,
  'the warning is rendered on every branch that offers an update (stable + prerelease)')
assert.ok(/btnData\.addEventListener\('click', \(\) => \{ call\('open-data'\)/.test(chromeSrc),
  'update dialog offers a data-directory backup entry before upgrading')
const readmeSrc = readFileSync(join(root, 'README.md'), 'utf8')
assert.ok(/0\.1\.7-alpha\.1 起/.test(readmeSrc) && /回滚/.test(readmeSrc) && /备份/.test(readmeSrc),
  'README documents that dsh upgrades are one-way and rollback = restore a backup')
assert.ok(/建议先备份数据目录/.test(libRs), 'tray update label / toast carries the backup hint')

// ── 桥阶段 0 准入（S4-0）──────────────────────────────────────────────
// 非 GET 必须带 X-DSH-Shell；服务端 Allow-Headers 必须放行它，否则浏览器预检
// 会拦掉壳自己的所有动作（2026-09-01 事故同形，症状是「菜单点了没反应」）。
const notifSrc = readFileSync(join(root, 'plugins', 'dsh-client-notifications', 'client.js'), 'utf8')
assert.ok(/opts\.headers = \{ 'Content-Type': 'application\/json', 'X-DSH-Shell': '1' \}/.test(chromeSrc),
  'chrome bridge() sends X-DSH-Shell on non-GET')
assert.ok(/headers: \{ 'Content-Type': 'application\/json', 'X-DSH-Shell': '1' \}/.test(notifSrc),
  'notification plugin sends X-DSH-Shell on POST')
assert.ok(libRs.includes('Access-Control-Allow-Headers: content-type, x-dsh-shell'),
  'lib.rs Allow-Headers admits x-dsh-shell (preflight would fail otherwise)')
// 通配 ACAO 的**语义**由 Rust 单测守（cors_headers_echo_only_whitelisted_origins）；
// 这里只守"响应构造确实改用了那个函数"（源码里还含字面量是单测自身的断言文本）。
assert.ok(/bridge_cors_headers\(origin\.as_deref\(\)\)/.test(libRs),
  'the bridge response builder routes through bridge_cors_headers(origin)')
assert.ok(/fn bridge_request_decision\(/.test(libRs) && /fn bridge_origin_allowed\(/.test(libRs),
  'lib.rs carries the pure Host/Origin/header decision functions')
assert.ok(/mod bridge_guard_tests/.test(libRs), 'lib.rs carries the bridge guard unit tests (run by CI)')

// ── S4-1：危险动作的壳内确认（槽位 + 确认窗 + 异步 IPC）──────────────────
// 两个方向都要守：ACTIONS 里标了 confirm 的必须真的在 Rust 危险表里（否则点了
// 没反应/绕过确认），危险表里的也必须能被执行（否则确认后无事发生）。
const confirmActions = Object.entries(ACTIONS).filter(([, a]) => a.confirm === true)
assert.ok(confirmActions.length >= 8, `至少 8 个危险项要标 confirm（实际 ${confirmActions.length}）`)
const dangerPaths = [...libRs.matchAll(/^\s*"(\/[a-z/-]+)"\s*=>\s*action\(/gm)].map(m => m[1])
for (const [id, a] of confirmActions) {
  assert.ok(dangerPaths.includes(a.bridge), `ACTIONS['${id}'] 的桥路径 ${a.bridge} 必须在 Rust 危险表里`)
}
for (const path of ['/shell/quit', '/restart', '/restart-dsh', '/update-dsh', '/shell/legacy-cleanup']) {
  assert.ok(dangerPaths.includes(path), `Rust 危险表必须包含 ${path}`)
}
assert.ok(/#\[tauri::command\(async\)\]\s*\nfn resolve_pending_action\(/.test(libRs),
  'resolve_pending_action 必须是 async 命令（同步命令在主线程执行，会冻住确认窗自己）')
assert.ok(/#\[tauri::command\(async\)\]\s*\nfn get_pending_action\(/.test(libRs), 'get_pending_action 必须是 async 命令')
assert.ok(libRs.includes('get_pending_action,') && libRs.includes('resolve_pending_action,'), '两个 IPC 命令都注册到 invoke_handler')
assert.ok(/fn execute_danger_action\(/.test(libRs), '危险动作有唯一执行点 execute_danger_action')
// 危险表 id ↔ 执行分支 id 必须双向一致（2026-09-25 dev 实机缺陷：表里新增
// titlebar-contract，execute_danger_action 却没有该分支 → 用户在确认窗点「确认执行」
// 后动作静默失败，dsh.json 毫无变化；源码侧所有断言当时都是绿的）。
{
  const tableBody = libRs.slice(libRs.indexOf('fn dangerous_bridge_action'), libRs.indexOf('/// 待确认的一次性槽位'))
  const tableIds = [...tableBody.matchAll(/action\(\s*"([a-z-]+)"/g)].map((m) => m[1])
  const execStart = libRs.indexOf('fn execute_danger_action')
  const execBody = libRs.slice(execStart, libRs.indexOf('\n}\n', execStart))
  const execIds = [...execBody.matchAll(/"([a-z-]+)"\s*=>/g)].map((m) => m[1])
  assert.ok(tableIds.length >= 10, `危险表至少 10 项（实际 ${tableIds.length}）`)
  for (const id of tableIds) {
    assert.ok(execIds.includes(id), `危险表里的 "${id}" 必须有执行分支（否则确认窗点确认后静默失败）`)
  }
  for (const id of execIds) {
    assert.ok(tableIds.includes(id) || id === 'close-hide',
      `执行分支 "${id}" 必须来自危险表或合成动作 close-hide（孤立分支 = 死代码/潜在误用）`)
  }
}
assert.ok(libRs.includes('dangerous_bridge_action(method, path)'), '桥在危险路径上走确认而不是直接执行')
const confirmCap = JSON.parse(readFileSync(join(root, 'src-tauri', 'capabilities', 'launcher.json'), 'utf8'))
assert.ok(confirmCap.windows.includes('confirm'), 'capabilities 必须包含 confirm 窗口（否则 IPC 不可用）')
assert.ok(/\.with_denylist\(&\["settings", "confirm"\]\)/.test(libRs), 'window-state denylist 必须排除 confirm 窗口')
assert.ok(existsSync(join(root, 'src', 'confirm.html')), 'src/confirm.html 存在')
const confirmJs = readFileSync(join(root, 'src', 'confirm.js'), 'utf8')
assert.ok(/invoke\('get_pending_action'\)/.test(confirmJs) && /invoke\('resolve_pending_action'/.test(confirmJs),
  'confirm.js 读取待确认动作并作答')
assert.ok(/pending === true/.test(chromeSrc), 'chrome 对 {pending:true} 给出可见反馈（否则用户以为点了没反应）')

// ── S8：顶栏契约（caption 模式，flag 门控默认关）────────────────────────
// 关键行为用**函数返回值**断言（vm 里真的执行 computeCaptionPlan），不是字符串匹配。
{
  const off = computeCaptionPlan(false)
  assert.equal(off.paddingTop, SHELL_BAR_H, '默认（未启用契约）仍由壳推挤顶栏高度')
  assert.equal(off.hostClass, '', '默认不进入 caption 模式')
  assert.equal(Object.keys(off.dataset).length, 0, '默认不设 data-windows-titlebar')
  assert.equal(off.cssVars['--dsh-windows-titlebar-height'], undefined, '默认不给客户端标题栏高度变量')

  const on = computeCaptionPlan(true)
  assert.equal(on.paddingTop, null, 'caption 模式必须 NOT 推挤（否则与客户端 .frame padding 叠加 = 双重让位）')
  assert.equal(on.hostClass, 'caption', 'caption 模式给 host 加类（bar 透明 + 不接收指针事件）')
  assert.equal(on.dataset.windowsTitlebar, '', 'caption 模式设 html[data-windows-titlebar]（客户端契约）')
  assert.equal(on.cssVars['--dsh-windows-titlebar-height'], WINDOWS_TITLEBAR_H + 'px',
    '客户端按 --dsh-windows-titlebar-height 预留标题栏，壳必须给同一个值')
  assert.equal(on.cssVars['--dsh-shell-menubar-h'], SHELL_BAR_H + 'px', '两种模式都保留壳自己的高度契约')
  assert.equal(WINDOWS_TITLEBAR_H, 40, '与官方 Electron 壳的 40px 对齐（客户端几何依赖它）')
}
assert.ok(/:host\(\.caption\) \.bar \{ background: transparent; pointer-events: none; \}/.test(chromeSrc),
  'pointer-events:none 只加在 .bar 上（加在 :host 上会点不动下拉/模态 —— 真 Chromium 实测）')
assert.ok(/\.bar > \* \{ pointer-events: auto; \}/.test(chromeSrc), 'bar 的子元素恢复可点（菜单按钮/窗口三键）')
assert.ok(/:host\(\.caption\) \.menus \{ margin-left: var\(--dsh-windows-menu-start, 48px\); \}/.test(chromeSrc),
  '菜单起点用客户端变量（客户端只在折叠态设 84px，未设时回退 48px）')
assert.ok(/if \(TITLEBAR_CONTRACT\) \{\n    spacer\.addEventListener\('mousedown', onBarMouseDown\)/.test(chromeSrc),
  'caption 模式下拖动挂在显式拖动区（.bar 已不接收事件）')
assert.ok(/spacer\.addEventListener\('dblclick', onBarDblClick\)/.test(chromeSrc), '显式拖动区同时支持双击最大化')
assert.ok(/window\.dispatchEvent\(new Event\('resize'\)\)/.test(chromeSrc),
  '注入晚于首帧 → 补一次 resize 让客户端重算布局')
assert.ok(ACTIONS['titlebar-contract'] && ACTIONS['titlebar-contract'].confirm === true,
  '顶栏契约切换也走壳确认窗（改的是布局契约，不是只读项）')
assert.ok(libRs.includes('__DSH_TITLEBAR_CONTRACT__') && /fn titlebar_contract\(/.test(libRs),
  'Rust 读取 dsh.json 并把开关注入页面前缀')
assert.equal((libRs.match(/"titlebarContract": titlebar_contract\(/g) || []).length, 2,
  '两处 shell-state JSON 都要带 titlebarContract')

// S9 归因字段必须出现在**启动页真正读的那个 JSON** 里（shell_status_json），
// 只加到 manager-exit 事件负载上等于死代码（2026-09-25 dev 实测：标记文件在、
// 失败态无任何升级文案，因为启动页读的是 /shell/status）。
{
  const stStart = libRs.indexOf('fn shell_status_json(')
  const stBody = libRs.slice(stStart, libRs.indexOf('\n}\n', stStart))
  assert.ok(/"upgrade": upgrade_marker_json\(app\),/.test(stBody),
    'shell_status_json 内部必须带 upgrade（启动页读的是它，不是 manager-exit 事件负载）')
}
assert.ok(/fn shell_status_json\(app: &AppHandle, state: &ServerState\)/.test(libRs), 'shell_status_json takes the AppHandle so it can read the marker')

// ── S5：关窗首次确认（复用确认窗的合成动作）────────────────────────────
assert.ok(/fn close_needs_confirmation\(/.test(libRs), 'lib.rs carries the pure close-confirmation decision')
assert.ok(/close_needs_confirmation\(close_confirmed\(&handle\), false\)/.test(libRs),
  'CloseRequested asks before the first hide (Windows)')
assert.ok(libRs.includes('background-close-confirmed'), 'the confirmation marker file is named')
assert.ok(/"close-hide" => \{/.test(libRs), 'the synthetic close-hide action has an executor branch')
const readme2 = readFileSync(join(root, 'README.md'), 'utf8')
assert.ok(/首次隐藏前会弹一次确认/.test(readme2), 'README documents the first-hide confirmation')

// ── S9：升级归因与一键回退 ─────────────────────────────────────────────
// manager 写标记（原子）→ Rust 随 manager-exit 上报、启动成功即清 → 启动页归因 + 回退。
assert.ok(/nextUpgradeMarker/.test(managerSrc) && /upgradeMarkerPath/.test(managerSrc),
  'manager computes/writes the upgrade marker via the pure module')
assert.ok(/renameSync\(tmp, markerPath\)/.test(managerSrc), 'the marker is written atomically (tmp + rename)')
assert.ok(/fn upgrade_marker_json\(/.test(libRs), 'lib.rs reads <runtime>/upgrade.json')
assert.ok(/"upgrade": upgrade_marker_json\(app\),/.test(libRs), 'manager-exit carries the upgrade marker')
assert.ok(/fn clear_upgrade_marker\(/.test(libRs) && /clear_upgrade_marker\(app\);/.test(libRs),
  'a successful startup (/alive) clears the marker')
assert.ok(/fn update_now\(state: State<'_, ServerState>, version: Option<String>\)/.test(libRs),
  'update_now accepts an optional target version (rollback entry)')
const indexHtml = readFileSync(join(root, 'src', 'index.html'), 'utf8')
assert.ok(/id="rollback"/.test(indexHtml), 'launcher has the rollback button')
assert.ok(/invoke\('update_now', \{ version: m\.from \}\)/.test(appJs), 'rollback calls update_now with the previous version')
assert.ok(/const canSwitch = !!m && attempts < 2;/.test(appJs),
  'rollback is gated on attempts < 2 (no ping-pong)')

// 回退是**降级 dsh**：新版预装插件可能因缺少旧版 dsh 的客户端服务而 pending（fail-closed
// → 界面打不开）。静态门禁管不到这条运行时路径，所以按钮必须写明自救路径。
assert.ok(/界面可能打不开 —— 可在启动页点「停用第三方插件」自救。/.test(appJs),
  'rollback button title warns that newer plugins may break the UI and names the recovery path')
assert.ok(/旧版 dsh 缺少新版插件所需的服务/.test(appJs), 'rollback warning names the root cause (old dsh missing the service newer plugins need)')
const readme3 = readFileSync(join(root, 'README.md'), 'utf8')
assert.ok(/界面会停在「Failed to load plugins」打不开/.test(readme3), 'README documents the rollback → plugin breakage path')
// 故障回退导航只认真实本地页：setup 时 w.url() 可能是 about:blank，若被当成
// 启动页 URL，manager 被杀后窗口会落到 about:blank 黑屏（2026-09-09 实机验证）。
assert.ok(libRs.includes('fn is_shell_local_url'), 'launcher URL accepts both tauri:// and http://tauri.localhost (Windows)')
assert.ok(libRs.includes('fn navigate_back_to_launcher'), 'crash fallback navigates back to the launcher page')

// ── 11. 挂起取证 + Job Object 契约（卡 1 剩余项）────────────────────────────
// S3：壳探活 → MiniDumpWriteDump（只 dump 不重启）；manager 不再用 comsvcs
// （本机 20s 超时零产出，是 L3 重启风暴的根因）。
const webDumpRs = readFileSync(join(root, 'src-tauri', 'src', 'web_dump.rs'), 'utf8')
const jobRs = readFileSync(join(root, 'src-tauri', 'src', 'job_object.rs'), 'utf8')
assert.ok(libRs.includes('mod web_dump'), 'lib.rs declares the web_dump module')
assert.ok(libRs.includes('fn start_hang_watchdog'), 'lib.rs has the dsh web hang watchdog')
assert.ok(libRs.includes('fn dump_dsh_web') && libRs.includes('ack_dump_done'), 'hang dump is idempotent and acks the manager')
assert.ok(webDumpRs.includes('MiniDumpWriteDump'), 'web_dump uses MiniDumpWriteDump directly (no rundll32/comsvcs)')
assert.ok(webDumpRs.includes('MiniDumpWithFullMemory'), 'hang dumps are full-memory (debugger-ready)')
assert.ok(webDumpRs.includes('OpenProcess') && webDumpRs.includes('PROCESS_VM_READ'), 'dump opens the process with VM_READ only')
assert.ok(libRs.includes('HANG_STARTUP_GRACE_SECS'), 'hang probing has a startup grace (no false hang during boot)')
assert.ok(libRs.includes('"dump-web"'), 'manager protocol line dump-web is handled by the shell')
const mgrRs = readFileSync(join(root, 'scripts', 'server-manager.mjs'), 'utf8')
const mgrCopy = readFileSync(join(root, 'src-tauri', 'resources', 'manager', 'server-manager.mjs'), 'utf8')
for (const [name, src] of [['scripts/server-manager.mjs', mgrRs], ['resources/manager copy', mgrCopy]]) {
  assert.ok(!src.includes('comsvcs.dll'), `${name} no longer calls comsvcs (proven broken on this machine)`)
  assert.ok(!src.includes('spawnSync'), `${name} no longer blocks on spawnSync`)
  assert.ok(src.includes('WATCHDOG_STARTUP_GRACE_MS'), `${name} has the watchdog startup grace`)
  assert.ok(src.includes("t: 'dump-web'"), `${name} asks the shell for the dump`)
  assert.ok(src.includes("case 'dump-done'"), `${name} waits for the shell's dump ack before restarting`)
}
// 真源/副本必须逐字节一致：上面是逐项子串检查，新增内容漏同步时仍然全绿——而 tauri
// 打包只带 resources/manager 副本，漂移会让新命令在安装包里不存在（0.5.0/0.6.0 事故同类）。
assert.strictEqual(mgrCopy, mgrRs, 'resources/manager/server-manager.mjs is byte-identical to scripts/server-manager.mjs (run: npm run sync:resources)')
// 挂起处理同样不得自动重启（D1：manager 的重启是既有行为，壳不参与）。
const hangStart = libRs.indexOf('fn start_hang_watchdog')
const hangEnd = libRs.indexOf('fn shell_status_json')
assert.ok(hangStart > 0 && hangEnd > hangStart, 'locate the hang-watchdog region in lib.rs')
const hangRegion = libRs.slice(hangStart, hangEnd)
assert.ok(!/start_server\(|restart_server\(/.test(hangRegion), 'hang path only dumps; it never restarts the service (D1)')
// S4：Job Object（kill-on-close）——壳死则整棵服务树被系统清掉。
assert.ok(libRs.includes('mod job_object') && libRs.includes('SERVICE_JOB'), 'lib.rs creates and keeps the service job object')
assert.ok(jobRs.includes('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE'), 'job kills the tree when the shell dies')
assert.ok(jobRs.includes('JOB_OBJECT_LIMIT_BREAKAWAY_OK'), 'job allows breakaway/nested jobs (dsh sandbox compatibility)')
assert.ok(libRs.includes('job_object::assign'), 'manager is assigned to the job right after spawn')

// ── cookie-431 修复（P0）契约 ───────────────────────────────────────────────
// dsh web 的鉴权 cookie 名绑定端口 → 壳每轮新端口 → Cookie 头单调增长 → 越过
// Node 默认 16KB 头上限后，页面上唯一 >1KB 的 URL（插件批 bundle ≈2.85KB）
// 第一个被 431 打掉 → 全部客户端插件 import failed。修复 = 导航前清理陈旧
// `dsh-auth-*`。三条硬约束由本契约锁死：
//   1) 清理只能在**后台 janitor 线程**里调用（Windows 上 cookies() 在同步
//      command / 事件处理器里会死锁，Tauri 官方 wry#583）；
//   2) server-url 分支必须"先清理、后交付 URL"（launcher 页自己也监听该事件
//      并 location.href，晚清理会让它用脏 jar 加载）；
//   3) 复核读（remaining）必须存在——delete_cookie 是入队即返回，只数"删了几次"
//      证明不了清理生效。
assert.ok(libRs.includes('fn is_stale_auth_cookie'), 'lib.rs has the pure cookie predicate (unit-tested)')
const pruneCallSites = (libRs.match(/prune_stale_auth_cookies\(/g) || []).length
assert.equal(pruneCallSites, 2, 'prune_stale_auth_cookies is defined once and called from exactly one place')
const janitorStart = libRs.indexOf('fn spawn_auth_cookie_janitor')
const janitorEnd = libRs.indexOf('\nfn ', janitorStart + 10)
const janitorBody = libRs.slice(janitorStart, janitorEnd > 0 ? janitorEnd : undefined)
assert.ok(janitorStart > 0, 'lib.rs has the cookie janitor')
assert.ok(janitorBody.includes('std::thread::spawn'), 'the janitor owns a background thread')
assert.ok(janitorBody.includes('prune_stale_auth_cookies('), 'the janitor body is the only prune call site')
assert.ok(janitorBody.includes('catch_unwind'), 'the janitor wraps the prune in catch_unwind (wry builds a Cookie per profile entry)')
assert.ok(libRs.includes('fn count_stale_auth_cookies'), 'the prune re-reads the jar to verify the deletion')
const urlBranchStart = libRs.indexOf('Some("url") =>')
const urlBranchEnd = libRs.indexOf('Some("dump-web") =>')
assert.ok(urlBranchStart > 0 && urlBranchEnd > urlBranchStart, 'locate the server-url branch in lib.rs')
const urlBranch = libRs.slice(urlBranchStart, urlBranchEnd)
assert.ok(urlBranch.includes('wait_for_startup_auth_prune()'), 'server-url waits for the startup prune')
assert.ok(
  urlBranch.indexOf('wait_for_startup_auth_prune()') < urlBranch.indexOf('handle.emit("server-url"'),
  'the startup cookie prune completes BEFORE the URL is handed to any page (launcher self-navigates)',
)
assert.ok(urlBranch.includes('LAST_ANNOUNCED_ORIGIN'), 'only an authority change triggers another prune (never the live cookie)')
assert.ok(
  /spawn_auth_cookie_janitor\(/.test(libRs) && libRs.includes('request_auth_cookie_prune();'),
  'setup spawns the janitor and asks for the startup prune',
)

console.log('PASS — shell chrome contract (menus, actions, bridge, IPC)')
process.exit(0)
