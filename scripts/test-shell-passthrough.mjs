#!/usr/bin/env node
// 壳不吞页面原生行为的门禁（2026-10-23 起，npm test 的一员）。
//
// 背景：官方客户端对比调研（docs/2026-10-23-official-client-adoption-review.md，PR #194）
// 定性了两处**静默失效** —— 用户看不到报错、也不会有人发现，只有门禁能守住：
//   A1 页面内文件拖放：Tauri 默认 drag_drop_handler_enabled=true 会挂原生处理器并
//      SetAllowExternalDrop(false) ⇒ 页面 HTML5 拖放被关掉，dsh 输入框的"拖文件到这里"
//      无声失效。修法 = main 窗口 `dragDropEnabled:false`（让 WebView 自己处理）。
//   A2 外链/新窗口：无 new-window handler 时 wry 对 NewWindowRequested 直接 deny ⇒
//      window.open / target=_blank 的 http(s) 链接点了没有任何反应。修法 = chrome 拦截后
//      经环回桥 `/shell/open-url` 交 Rust，**只放行 http(s)**，其余 scheme 拒绝并留日志。
//
// 本套件断言四件事：
//   ① 配置（A1）：tauri.conf.json 的 main 窗口 dragDropEnabled 必须为 false；
//      dev 配置不许自带 `app.windows`（`--config` 是数组整体替换 ⇒ 会静默丢掉该标志）；
//      没有别处依赖 Tauri 的原生 drag-drop 事件（配 false 后它们只会是死代码）；
//   ② 判定（A2）：chrome 暴露的 externalUrlVerdict 的正/负用例（安全边界在值上断言，
//      不对源码做字符串匹配）；
//   ③ 接线（A2）：window.open 覆盖 + 外链点击 → ACTIONS['open-url'] → lib.rs 的
//      桥端点 / IPC 命令 / 单一判定函数 validate_external_url；激活意图是纯函数，
//      门禁直接模拟 click / auxclick（**右键 button=2 必须什么都不做**）；
//   ④ 变异自证（本套件自带，**只在临时目录里造变异体，绝不改仓库**）：
//      A1 把 dragDropEnabled 改回 true ⇒ `a1-dragdrop-disabled` 必须变红；
//      A2 把 chrome 的 scheme 白名单放宽（加 file:/javascript:）⇒ `a2-reject-file` 必须变红；
//      A2-rightclick 去掉 auxclick 的 `button !== 1` 判断 ⇒ `a2-auxclick-right-ignored` 必须变红。
//
// 可注入文件（供变异体使用，与 test-chrome-real 的 DSH_CHROME_FILE 同风格）：
//   DSH_TAURI_CONF=<path>  DSH_CHROME_FILE=<path>
//   DSH_PASSTHROUGH_NO_MUTATIONS=1  只跑断言、不跑变异体（变异体子进程用，防递归）
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SELF = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(SELF), '..')
const CONF_PATH = resolve(process.env.DSH_TAURI_CONF || join(ROOT, 'src-tauri', 'tauri.conf.json'))
const CHROME_PATH = resolve(process.env.DSH_CHROME_FILE || join(ROOT, 'src-tauri', 'resources', 'ui', 'shell-chrome.js'))
const LIB_RS = readFileSync(join(ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf8')
const DEV_CONF_PATH = join(ROOT, 'src-tauri', 'tauri.dev.conf.json')

const checks = []
function check(id, label, why, ok, detail = '') {
  checks.push({ id, label, why, ok: !!ok, detail: String(detail) })
}

// ── ① A1：配置门禁 ─────────────────────────────────────────────────────────
let conf = null
let confErr = null
try { conf = JSON.parse(readFileSync(CONF_PATH, 'utf8')) } catch (err) { confErr = err }
const windows = conf && conf.app && Array.isArray(conf.app.windows) ? conf.app.windows : []
const mainWin = windows.find((w) => w && w.label === 'main')
check('a1-main-window', 'tauri.conf.json 里存在 label=main 的窗口',
  '窗口组成变了 ⇒ 下面 dragDropEnabled 的断言会打在错误对象上（静默变空转）',
  !!mainWin, confErr ? `JSON 解析失败: ${confErr.message}` : `windows=${windows.map((w) => w && w.label).join(',') || '(空)'}`)
check('a1-dragdrop-disabled', 'main 窗口必须 dragDropEnabled:false（让 WebView 自己处理 HTML5 拖放）',
  'Tauri 默认 true ⇒ 挂原生拖放处理器 + SetAllowExternalDrop(false) ⇒ 页面拖放静默失效（A1 缺陷本体）',
  !!mainWin && mainWin.dragDropEnabled === false,
  `实测 dragDropEnabled=${mainWin ? JSON.stringify(mainWin.dragDropEnabled) : '(无 main 窗口)'}`)

let devConf = null
let devConfErr = null
try { devConf = JSON.parse(readFileSync(DEV_CONF_PATH, 'utf8')) } catch (err) { devConfErr = err }
const devWindows = devConf && devConf.app && devConf.app.windows
check('a1-dev-config-no-windows', 'dev 配置不得自带 app.windows（--config 是数组整体替换，会静默丢掉 dragDropEnabled）',
  'Tauri --config 深合并时数组整体替换 ⇒ dev 构建会退回默认 dragDropEnabled:true（同一缺陷只在开发版复现）',
  !!devConf && !devWindows, devConfErr ? `dev 配置解析失败: ${devConfErr.message}` : `app.windows=${JSON.stringify(devWindows)}`)

// 配 false 之后，Tauri 的 drag-drop 事件不再派发 ⇒ 任何监听都是死代码（A1 修复前提）。
const nativeDragListeners = [
  ...['src-tauri/resources/ui/shell-chrome.js', 'src-tauri/src/lib.rs'].map((rel) => {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    return { rel, hit: /onDragDropEvent|on_drag_drop_event|tauri:\/\/drag-drop|drag_drop_handler/.test(text) }
  }),
].filter((f) => f.hit)
check('a1-no-native-dragdrop-dependency', '没有别处依赖 Tauri 的原生 drag-drop 事件（配 false 后它们只会是死代码）',
  '若有监听，关掉原生处理器会让它永不触发（新的静默失效），必须先迁移再关',
  nativeDragListeners.length === 0,
  nativeDragListeners.length ? `命中: ${nativeDragListeners.map((f) => f.rel).join(', ')}` : 'chrome / lib.rs 均未引用')

// ── ② A2：chrome 的判定函数（值断言）───────────────────────────────────────
const sandbox = { console, __DSH_CHROME_TEST__: {} }
vm.createContext(sandbox)
vm.runInContext(readFileSync(CHROME_PATH, 'utf8'), sandbox, { filename: 'shell-chrome.js' })
const config = sandbox.__DSH_CHROME_TEST__.config || {}
const verdict = config.externalUrlVerdict
const ACTIONS = config.ACTIONS || {}
check('a2-verdict-exported', 'chrome 暴露 externalUrlVerdict 纯函数（供门禁断言返回值）',
  '判定逻辑没导出 ⇒ 只能对源码做字符串匹配（随实现方式漂移就失效）',
  typeof verdict === 'function')
const call = (raw) => {
  try { return verdict ? verdict(raw) : { ok: false, reason: 'missing-fn' } } catch (err) { return { ok: false, reason: `threw: ${err && err.message}` } }
}

// 正例：只放行 http(s)，且 URL **原样**交给 Rust（不重新拼装）。
for (const good of ['https://example.com/a?b=1#c', 'http://127.0.0.1:3080/x', 'HTTPS://Example.com/A']) {
  const v = call(good)
  check('a2-allow-' + good.split(':')[0].toLowerCase(), `放行 ${good}（原样返回）`,
    '把正常外链误拒 ⇒ 修复等于没做（用户点了还是没反应）',
    v.ok === true && v.url === good, JSON.stringify(v))
}
// 负例：其它 scheme 一律拒绝（安全边界：页面不许把 file:/javascript: 交给系统）。
const rejects = [
  ['a2-reject-file', 'file:///C:/Windows/System32/cmd.exe'],
  // 带 authority 的 file:/ms-settings: —— 它们**只**被 scheme 白名单挡住（authority/userinfo
  // 等形态检查放行它们），所以是"白名单被放宽"这条变异的靶子（`file:///…` 会先被
  // empty-host 拒绝，结构上看不见白名单放宽）。
  ['a2-reject-file-share', 'file://fileserver/share/x'],
  ['a2-reject-ms-settings-authority', 'ms-settings://privacy'],
  ['a2-reject-javascript', 'javascript:alert(1)'],
  ['a2-reject-data', 'data:text/html,<script>alert(1)</script>'],
  ['a2-reject-ms-settings', 'ms-settings:privacy'],
  ['a2-reject-vbscript', 'vbscript:msgbox(1)'],
  ['a2-reject-relative', '/settings/profile'],
  ['a2-reject-no-authority', 'http:example.com'],
  ['a2-reject-empty-host', 'https:///path'],
  ['a2-reject-userinfo', 'https://user:pass@example.com/'],
  ['a2-reject-newline', 'https://example.com\n--evil'],
  ['a2-reject-empty', '   '],
]
for (const [id, raw] of rejects) {
  const v = call(raw)
  check(id, `拒绝 ${JSON.stringify(raw)}`, '页面被注入 / 恶意内容可以构造任意字符串 ⇒ 放行即把系统打开能力交给它',
    v.ok === false && !v.passThrough, JSON.stringify(v))
}
check('a2-reject-non-string', '拒绝非字符串输入（null / 对象 / 数字）',
  'window.open 的参数可以是任意值 ⇒ 非字符串必须按拒绝处理，不能落到 URL 解析里',
  ['null', 'object', 'number'].every((kind) => call(kind === 'null' ? null : kind === 'object' ? { href: 'https://x' } : 42).ok === false))
const aboutBlank = call('about:blank')
check('a2-about-blank-passthrough', 'about:blank 原样交回原生 window.open（OAuth 弹窗形态）',
  '一刀切拒绝会打断"先开空窗再写 location"的登录流程；放行它不增加能力面（wry 无 handler 时本就开不出窗口）',
  aboutBlank.ok === false && aboutBlank.passThrough === true, JSON.stringify(aboutBlank))
check('a2-scheme-set-is-http-https', 'chrome 的 scheme 白名单恰好是 http/https（与 Rust 同一集合）',
  '白名单被放宽（例如加 file:）⇒ 系统打开能力被下放给页面',
  JSON.stringify(config.EXTERNAL_URL_SCHEMES) === JSON.stringify(['http', 'https']),
  JSON.stringify(config.EXTERNAL_URL_SCHEMES))

// ── ②b A2：激活意图（模拟真实事件参数，断言"会不会走 open-url"）────────────
// 2026-10-25 实机回归：右键（auxclick button=2）在菜单弹出前就把外链交了出去。
// 这里直接模拟 handler 收到的 kind/event/anchor 属性，判定 handle=true 等价于
// "右键菜单还没出现就可能调 open-url"，因此 button=2 必须是 handle=false。
const linkIntent = config.linkActivationIntent
check('a2-intent-exported', 'chrome 暴露 linkActivationIntent 纯函数（供门禁模拟 click/auxclick）',
  '激活意图没导出 ⇒ 右键回归只能靠源码字符串匹配，改实现就失效',
  typeof linkIntent === 'function')
const activation = (kind, ev = {}, href = 'https://example.com/a', target = '') => {
  try {
    return typeof linkIntent === 'function'
      ? linkIntent(kind, { button: 0, ctrlKey: false, metaKey: false, ...ev }, href, target, 'https:')
      : { handle: false, reason: 'missing-fn' }
  } catch (err) { return { handle: false, reason: `threw: ${err && err.message}` } }
}
const opens = (r) => r.handle === true && !!r.verdict && r.verdict.ok === true
// 必须是真的"判定为忽略"：函数缺失/抛异常时 handle 也是 false，但那是夹具失效，
// 不能让它冒充"右键被正确忽略"（否则 pre-fix 源会让右键断言假绿）。
const ignores = (r) => r.handle === false && !r.reason

const middle = activation('auxclick', { button: 1 })
check('a2-auxclick-middle-opens', '模拟 auxclick{button:1}（中键）⇒ 必须走 open-url',
  '修右键不能把中键一起修掉：中键打开外链是 A2 的保留能力',
  opens(middle), JSON.stringify(middle))
const right = activation('auxclick', { button: 2 }, 'https://example.com/a', '_blank')
check('a2-auxclick-right-ignored', '模拟 auxclick{button:2}（右键）⇒ 不得走 open-url（哪怕 target=_blank）',
  '右键也要弹页面/WebView 的菜单；旧实现按 _blank 误判成"打开"，于是菜单没出现系统浏览器先开了（用户报告的回归本体）',
  ignores(right), JSON.stringify(right))
const rightMod = activation('auxclick', { button: 2, ctrlKey: true }, 'https://example.com/a', '_blank')
check('a2-auxclick-right-modifier-ignored', '右键带 Ctrl/Meta 也必须忽略（不能靠修饰键让右键复活）',
  'Ctrl+右键仍是右键：修饰键只对左键/中键有意义，不能成为绕过 button 判断的后门',
  ignores(rightMod), JSON.stringify(rightMod))
const ctx = activation('contextmenu', { button: 2 }, 'https://example.com/a', '_blank')
check('a2-contextmenu-never-activates', 'contextmenu 事件本身永不激活外链（只允许 click/auxclick）',
  '把 contextmenu 当激活入口 ⇒ 右键直接开浏览器；未知事件类型必须保守忽略',
  ignores(ctx), JSON.stringify(ctx))
check('a2-click-blank-opens', '模拟 click{button:0} + target=_blank ⇒ 必须走 open-url',
  'A2 的左键主受害面（聊天里的外链通常 target=_blank）不能被右键修复误伤',
  opens(activation('click', {}, 'https://example.com/a', '_blank')),
  JSON.stringify(activation('click', {}, 'https://example.com/a', '_blank')))
check('a2-click-ctrl-opens', '模拟 click{button:0, ctrlKey:true} ⇒ 必须走 open-url',
  'Ctrl/Cmd+左键是 A2 明确保留的新窗口意图',
  opens(activation('click', { ctrlKey: true })), JSON.stringify(activation('click', { ctrlKey: true })))
check('a2-click-same-tab-ignored', '模拟 click{button:0} 无修饰键、target 空 ⇒ 不得走 open-url',
  '同窗口导航不拦（只处理会开新窗口的点击）；否则普通链接也会被丢给系统浏览器',
  ignores(activation('click')), JSON.stringify(activation('click')))
check('a2-click-middle-not-double', '模拟 click{button:1} ⇒ 不处理（中键只由 auxclick 处理，防双开）',
  '某些合成/引擎路径可能同时派发 click 与 auxclick；两边都处理会打开两次',
  ignores(activation('click', { button: 1 })), JSON.stringify(activation('click', { button: 1 })))

// ── ③ A2：接线（chrome ↔ bridge ↔ Rust）───────────────────────────────────
const chromeSrc = readFileSync(CHROME_PATH, 'utf8')
const openAction = ACTIONS['open-url'] || null
check('a2-actions-open-url', 'ACTIONS 有 open-url（ipc open_url + 桥 /shell/open-url，且不经确认窗）',
  '动作表是双通道唯一真源：缺一项 ⇒ 本地页 IPC 或远程页桥静默失效',
  !!openAction && openAction.ipc === 'open_url' && openAction.bridge === '/shell/open-url' && !openAction.confirm,
  JSON.stringify(openAction))
check('a2-window-open-wired', 'chrome 覆写 window.open（http(s) → 桥；about:blank → 原生；其余拒绝留痕）',
  '不覆盖 window.open ⇒ 页面的 new-window 路径仍被 wry 静默 deny',
  chromeSrc.includes('window.open = function') && chromeSrc.includes('nativeOpen.apply') && chromeSrc.includes("tag: 'open-url'"))
check('a2-anchor-wired', 'chrome 捕获 click/auxclick 的外链点击（_blank / 中键 / Ctrl-Cmd），且不抢页面自己的处理',
  '页面内 target=_blank 的链接是 A2 的主要受害面；抢在页面之前处理会双开',
  ['onLinkActivation', 'linkActivationIntent', "'click'", "'auxclick'", '_blank', 'ctrlKey', 'defaultPrevented', "call('open-url'"]
    .every((s) => chromeSrc.includes(s)))
// 右键菜单必须原样留给页面/WebView：任何 window/document 级 contextmenu 监听（尤其是
// preventDefault）都会让"复制链接/在新标签页打开"看不到或失效。chrome 唯一允许的
// contextmenu 监听在壳自己的 host 上（顶栏区域不出页面菜单），不在此列。
const pageContextMenuHooks = [
  /window\.addEventListener\(\s*['"]contextmenu['"]/,
  /document\.addEventListener\(\s*['"]contextmenu['"]/,
  /window\.oncontextmenu\s*=/,
  /document\.oncontextmenu\s*=/,
].filter((re) => re.test(chromeSrc))
check('a2-no-contextmenu-hijack', 'chrome 不在 window/document 级监听或改写 contextmenu（右键菜单归页面/WebView）',
  '抢 contextmenu（监听或 preventDefault）⇒ 右键菜单被我们干扰，"在新标签页打开/复制链接"无从谈起',
  pageContextMenuHooks.length === 0, pageContextMenuHooks.length ? `${pageContextMenuHooks.length} 处命中` : '无 window/document 级 contextmenu 钩子')
check('a2-rust-bridge-arm', 'lib.rs 有 POST /shell/open-url 桥分支',
  '桥缺分支 ⇒ chrome 的 call 打到 404，用户仍然"点了没反应"',
  LIB_RS.includes('("POST", "/shell/open-url")'))
check('a2-rust-ipc-registered', 'lib.rs 有 open_url 命令并注册进 invoke_handler',
  '本地启动页走 IPC；未注册 ⇒ capability 正常但命令不存在（静默失败）',
  LIB_RS.includes('fn open_url(') && /invoke_handler\(tauri::generate_handler!\[[\s\S]*?\bopen_url,/.test(LIB_RS))
check('a2-rust-validator', 'lib.rs 的 validate_external_url 只放行 http/https（Rust 侧唯一安全边界）',
  'chrome 只做拦截；真正的边界在 Rust —— 它若放宽，Node 侧测试拦不住真实执行路径',
  LIB_RS.includes('fn validate_external_url(') &&
    LIB_RS.includes('scheme != "http" && scheme != "https"') &&
    LIB_RS.includes('"userinfo"') && LIB_RS.includes('"control-char"'))
check('a2-rust-opener', 'Windows 用 ShellExecuteW、Linux 用 xdg-open（不经过 shell 拼命令）',
  '经 cmd /c start 之类拼命令 ⇒ 页面给的 URL 变成命令行注入面',
  LIB_RS.includes('ShellExecuteW') && LIB_RS.includes('xdg-open'))
check('a2-open-url-not-dangerous', '/shell/open-url 不在危险动作表里（不是危险动作，但拒绝要留日志）',
  '误纳入危险表 ⇒ 每次点外链都弹确认窗（体验回退）；纳入后必须同步 chrome 的 confirm 标记',
  !LIB_RS.includes('"/shell/open-url" => action('))
check('a2-reject-logged', '两边都留痕：chrome 把拒绝写进 /log，Rust 把拒绝写进会话日志',
  '拒绝却无日志 ⇒ 安全事件无从取证（与 A2 的"静默失效"同形）',
  chromeSrc.includes("bridge('/log'") && LIB_RS.includes('/shell/open-url rejected'))

// ── ④ 汇总 ────────────────────────────────────────────────────────────────
for (const c of checks) {
  console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.id} — ${c.label}${c.detail ? `   [${c.detail}]` : ''}`)
  console.log(`       ↳ 会红条件：${c.why}`)
}
const failures = checks.filter((c) => !c.ok)
if (failures.length) {
  console.log(`\nFAIL: ${failures.length}/${checks.length} 条断言未通过`)
  process.exit(1)
}

// ── ⑤ 变异自证：把缺陷注入临时副本，断言**指定**断言变红（不写仓库）────────
if (process.env.DSH_PASSTHROUGH_NO_MUTATIONS === '1') {
  console.log(`\nPASS（子进程，变异体已禁用）: ${checks.length}/${checks.length} 条断言通过`)
  process.exit(0)
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-passthrough-'))
const runSelf = (env) => {
  try {
    const out = execFileSync(process.execPath, [SELF], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...env, DSH_PASSTHROUGH_NO_MUTATIONS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, out }
  } catch (err) {
    return { status: err.status ?? 1, out: `${err.stdout || ''}${err.stderr || ''}` }
  }
}

const mutations = []
const confRaw = readFileSync(CONF_PATH, 'utf8')
const confObj = JSON.parse(confRaw)
const mutantConf = JSON.parse(confRaw)
const mutantWindows = mutantConf.app && Array.isArray(mutantConf.app.windows) ? mutantConf.app.windows : []
const mutantMain = mutantWindows.find((w) => w && w.label === 'main')
if (!mutantMain) {
  mutations.push({ key: 'A1', ok: false, why: '夹具与被测配置脱钩：找不到 label=main 的窗口（先修 a1-main-window）' })
} else {
  mutantMain.dragDropEnabled = true
  const path = join(tmp, 'tauri.conf.mutant-a1.json')
  writeFileSync(path, `${JSON.stringify(mutantConf, null, 2)}\n`, 'utf8')
  mutations.push({ key: 'A1', label: 'dragDropEnabled 改回 true', env: { DSH_TAURI_CONF: path }, expect: 'a1-dragdrop-disabled' })
}
const CHROME_ANCHOR = "const EXTERNAL_URL_SCHEMES = ['http', 'https'];"
if (!chromeSrc.includes(CHROME_ANCHOR)) {
  mutations.push({ key: 'A2', ok: false, why: `夹具与被测源码脱钩：找不到锚点 ${CHROME_ANCHOR}` })
} else {
  const path = join(tmp, 'shell-chrome.mutant-a2.js')
  writeFileSync(path, chromeSrc.replace(CHROME_ANCHOR, "const EXTERNAL_URL_SCHEMES = ['http', 'https', 'file', 'javascript'];"), 'utf8')
  mutations.push({ key: 'A2', label: 'scheme 白名单放宽（加 file:/javascript:）', env: { DSH_CHROME_FILE: path }, expect: 'a2-reject-file-share' })
}
// 右键回归的负向对照：把 auxclick 的 `button !== 1` 判断去掉（改为恒 false）。
// 期望只有右键相关断言变红；如果整套仍绿，说明门禁没有真的覆盖按钮区分。
const AUXCLICK_GUARD = "if (kind === 'auxclick' ? button !== 1 : button !== 0) return { handle: false };"
if (!chromeSrc.includes(AUXCLICK_GUARD)) {
  mutations.push({ key: 'A2-rightclick', ok: false, why: `夹具与被测源码脱钩：找不到锚点 ${AUXCLICK_GUARD}` })
} else {
  const path = join(tmp, 'shell-chrome.mutant-auxclick.js')
  writeFileSync(path, chromeSrc.replace(AUXCLICK_GUARD, "if (kind === 'auxclick' ? false : button !== 0) return { handle: false };"), 'utf8')
  mutations.push({ key: 'A2-rightclick', label: '去掉 auxclick 的 button===1 判断', env: { DSH_CHROME_FILE: path }, expect: 'a2-auxclick-right-ignored' })
}

try {
  for (const m of mutations) {
    if (m.ok === false) {
      console.log(`\n== 变异体 ${m.key} ==\n  FAIL 夹具失效：${m.why}`)
      process.exitCode = 1
      continue
    }
    console.log(`\n== 变异体 ${m.key}（临时副本，不写仓库）：${m.label} ==`)
    const r = runSelf(m.env)
    // 子进程的 FAIL 行是**预期**的；计入成败的只有"指定断言在失败列表里 + 退出码非 0"。
    const failedIds = [...r.out.matchAll(/^\s*FAIL (\S+)/gm)].map((x) => x[1])
    console.log(`  变异体下失败的断言（预期为红）: ${failedIds.length ? failedIds.join(', ') : '（无！）'}`)
    if (r.status === 0) {
      console.log(`  FAIL 变异体 ${m.key} 没有让套件变红（退出码 0）—— 该门禁是恒真的假门禁`)
      process.exitCode = 1
    } else if (!failedIds.includes(m.expect)) {
      console.log(`  FAIL 变异体 ${m.key} 没让指定断言 "${m.expect}" 变红（实测: ${failedIds.join(', ') || '无'}）`)
      process.exitCode = 1
    } else {
      console.log(`  ok   变异体 ${m.key} ⇒ 指定断言 "${m.expect}" 确实变红（门禁可信）`)
    }
  }
} finally {
  // 测试夹具清理：临时副本，删不掉也不影响结论（fail-open-ok 的语义在这里成立）
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* fail-open-ok: 临时目录清理失败不影响门禁结论 */ }
  void confObj
}

const mutatedOk = mutations.every((m) => m.ok !== false)
if (process.exitCode) {
  console.log('\nFAIL: 变异自证未通过（见上）')
} else {
  const count = mutations.filter((m) => m.ok !== false).length
  console.log(`\nPASS: shell passthrough gate（${checks.length}/${checks.length} 条断言；${count}/${count} 变异体均被判红 —— ` +
    'A1 拖放配置 / A2 外链白名单 / A2 右键不抢跑）')
}
void mutatedOk
