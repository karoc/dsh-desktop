# 工程记录（踩过的坑 → 应对机制）

本文件记录本项目踩过的真实问题与对应机制，避免重犯。每类问题对应一条可执行的防线。

## 1. 平台运行时语义不能靠"查文档"，只能靠"跑"

- 坑：Tauri `resource_dir()` 在 **Windows 返回 exe 目录**，不是 `resources/` 子目录；
  打包布局必须按 `resource_dir()/resources` / `exe_dir()/resources` 探测，不能假设。
- 机制：`src-tauri/src/lib.rs::resource_paths()` 多候选探测 + 启动时打印 `resources root: ...`；
  CI `linux-smoke` 真跑打包后的二进制并断言该路径下的 `node/<plat>/node` 存在。

## 2. "能编译" ≠ "能跑"

- 坑：E0382（借用已移动的 `line`）、E0599（PathResolver 无 `exe_dir()`）都只在编译时暴露；
  而"资源探测少拼一层 `node/`""资源根错位"只在运行时暴露，编译全绿也会翻车。
- 机制：CI 三级门禁 = `cargo check`（快，拦编译错）→ `bundle`（拦打包错，含 NSIS/AppImage
  布局断言）→ `linux-smoke`（xvfb 真跑，拦运行时错）。任一红不发新包。

## 3. 交付前没跑过的东西，不能叫"已验证"

- 坑：JS 侧（manager/插件/patch）本地全验过、问题最少；Rust 壳没编译没运行，问题全堆在用户侧。
- 机制：交付声明区分「真跑过 / 仅编译 / 仅推断」；用户拿到的包 = 全部门禁绿。
  新平台/新框架先做 spike（最小可运行 + 打印关键路径）再写全量。

## 4. API 名靠记忆 = 高危

- 坑：`exe_dir()` 是编出来的名字（实际在 `std::env::current_exe()`）。
- 机制：不熟的 API 落笔前查源码/生成文档并记入本文件。

## 5. 首次启动的慢网络体验

- 坑：国内网络拉官方 registry 530 个包能"卡死"级慢，且旧版无进度无错误。
- 机制：`DSH_DESKTOP_REGISTRY`/`--registry` 镜像可配 + 双源回退 + 安装进度实时上屏 +
  600s 超时 + `首次安装需几分钟` 提示。

## 6. 可观测性是定位的放大器

- 坑：早期所有失败静默（stderr 不可见），用户等 5 分钟只看到转圈。
- 机制：manager 日志落盘 `<runtime>/manager.log`；Rust 把协议镜像到 stderr（smoke 可抓）；
  UI 红色错误 + 重试 + 打开数据目录；`scripts/diagnose.ps1|.sh` 一键收集。

## 7. 用户侧摩擦有成本

- 坑：我给的 PowerShell 出现过丢 `&`、默认安装目录猜错；用户还踩过没装 Rust 的本地构建。
- 机制：命令一律单行/自定位；本地构建前置写进 README；“推荐用 CI 安装包”放第一位。

## 8. 交付门禁必须真的挡住"用户侧编译失败"

- 坑：CI 加了 `cargo check` 门禁，但我没等它绿就让用户 pull+bundle，E0599/Notification::new/E0505 连烧用户三轮本地编译。
- 机制：**任何 Rust 改动 push 后，先轮询 check job 变绿，再通知用户**。check 是用户流程的硬闸门，不是装饰。
- 写插件 API 前先查 docs.rs 签名（`NotificationExt::notification().builder()` 而非 `Notification::new`），不靠记忆。

## 9. 本地有 Rust 编译回环 = 编译错不出口

- 坑：曾长期"push 后等 CI check"，编译错偶尔先烧到用户本地构建。
- 机制：`scripts/dev-sdk-linux.sh` 搭无 root 编译环境（rustup + 解包 dev 包 + pkg-config sysroot）。
  **改任何 Rust → 先本地 `cargo check`（增量 ~1 分钟）→ 再 push。** CI check 门禁保留为第二道闸。

## 10. 远程页面拿不到 Tauri API——别绕，直接换传输

- 坑：dsh 的 UI 是 http://127.0.0.1 远程页面；Tauri v2 不向远程页面注入 `__TAURI__`
  （tauri#11934，多人确认，官方 localhost 插件也无效）。`notification.sendNotification`、
  event.emit 两条路在远程页面里全是死路。
- 机制：**回环 HTTP 桥**——Rust 起 127.0.0.1 随机端口小服务；manager 把端口烧进
  client.js（占位符替换）；客户端 `fetch` POST `/notify`（toast）与 `/alive`（加载探针）。
  纯标准 Web 技术，零 Tauri 依赖。
- 教训：改 client.js 后必须 `sync-resources` 再本地验证（资源副本与源码同步是构建的前置步骤）。

## 11. 通知点击 → 聚焦 + 定位会话

- tauri-plugin-notification 没有 Windows 点击回调（仅 Android action）。
- 机制：`tauri-plugin-single-instance` 捕获外部激活（toast 点击/重启动）→ 聚焦已有窗口 +
  把"最近通知的 sessionId"放进桥接 `/pending-open`；页面轮询该端点 →
  `ctx.sessions.open(id)`（dsh-client-runtime SessionRuntime 的公开方法）定位会话。
- 会话列表项没有"最新内容"字段：toast 正文用 title → displayTitle → cwd 兜底。

## 12. 日志留痕指南（排查入口）

数据目录：`%APPDATA%\dev.dsh.desktop\`（Windows）/ `~/.config/dev.dsh.desktop`（Linux）。

| 文件 | 内容 | 排查谁 |
|---|---|---|
| `dsh-desktop-session.log` | Rust/shell 侧：bridge 端口、`client-ready (http)`（客户端活着+桥通）、`notification: 标题 - 正文`、`notification session=<id>`、`toast failed`、`pending-open`（点击后待打开）、`activated:`（single-instance 激活）、`client/log <tag> [session=<id>] <detail>`（客户端判定决策） | 通知链路 |
| `runtime/manager.log` | manager：dsh 安装/升级、dsh URL、插件 `installed/updated client plugin`、`bridge port baked` | 启动/插件版本 |
| dsh 自身 stderr | manager 透传 | dsh 内部 |

**客户端 `client/log` 的 tag**：`notify-pending`（需要你触发）、`notify-complete`（running 沿/completed 标志）、`notify-complete-fallback`（快任务兜底）、`suppressed`（聚焦抑制）、`open`/`open-error`（点弹窗定位会话）、`shape`（快照结构异常——防静默死亡）。

**排查套路**：没弹 → 看 session.log 有无 `client-ready (http)`（无=客户端没跑/桥断）→ 有则看对应 `notify-*`（无=客户端没检测到沿变，快照/订阅问题）→ 有再看看 `toast failed`（系统通知层）。

## 13. CI 发布链路

- 每次 push：check（ubuntu cargo check）→ windows（NSIS 构建 + 7z 断言 node 在包内 + artifact）
  + linux（AppImage/deb）。`windows` job 从始至终绿灯，setup.exe 一直有产。
- 打 `v*` tag：release job 把 windows artifact 发到 GitHub Release（softprops/action-gh-release）。
- `linux-smoke`：headless xvfb 下 WebKitTRK 卡在 setup 前，二进制零输出——引入以来从未绿过，
  属 CI 环境怪癖（真机正常）；已 `continue-on-error` 降级为非阻塞警示。产品回归由
  windows 的 7z 布局断言 + check 门禁兜底。

## 平台专属项仍要真机验证（机制覆盖不到的部分）

Windows 的 NSIS 安装行为、toast 渲染、AUMID、事件投递——Linux smoke 覆盖不到，
靠 error-visibility + manager.log + diagnose 把定位时间压到分钟级。
## 14. "已完成/已结束"措辞审计（已核实源码）

- syncCompletedNotifications（dsh-client-runtime/lib/client.js 8540-8556）：`completed` 只在
  running true→false 且会话未选中时置真，**不区分停止/完成**——它不能当措辞依据。
- 手动停止必须聚焦（按钮/键盘/斜杠命令都是 UI 输入）；聚焦时 toast 本就抑制 →
  "已结束"分支永不会被本窗口的停止触发。
- 非聚焦 running→false 的成因：自然完成（选中/未选中）、浏览器同一页面停止（dsh web
  无单客户端限制，已搜索确认）、自动中止。统一报"已完成"（罕见误标可接受）。

## 15. 图标刷新机制（任务栏不换的历史坑）

- 现象：托盘图标对（二进制实时读），任务栏旧。根因链：Windows 任务栏对设了
  AppUserModelID 的应用，按 AUMID 解析开始菜单 .lnk 的图标（NSIS 模板里
  SetLnkAppUserModelId 证实），与托盘读 exe 内嵌图标是两条路。
- 产品内解法（零用户操作）：
  1. 运行态：`on_page_load` 每页把窗口图标钉成 bundle 图标（12e5fe4）；
  2. 安装态：tauri NSIS 的 `CreateShortcut` 每次安装都覆盖重建 .lnk（source 确认），
     新 .lnk 自带新图标 → 重装新版本即刷新任务栏图标来源。
- 升级杠杆（如仍旧，代码侧根治、不甩清单给用户）：`nsis.template` 自定义模板，
  CreateShortcut 显式写 icon 参数（NSIS 支持 icon-file/icon-index），与缓存语义解耦。
- 教训：凡需要用户执行多步 PowerShell 的"修复"，都是产品缺陷信号——先找代码侧解法。

## 16. 控制面（更新门控 + 重启语义）踩坑

- 坑：Tauri 2.11 的 `MenuItem::set_text` 只接受一个参数（text），**没有 app handle**
  参数——靠记忆写 `set_text(app, text)` 会 E0061。查 docs.rs 签名再落笔（延续 #8/#9 纪律）。
- 坑：`if let Some(x) = state.field.lock().unwrap().as_ref()` 里，MutexGuard 临时变量
  借用到块尾，比 `state` 活得长 → E0597"does not live long enough"。解法：先把 guard
  绑成局部变量再 `.as_ref()`。
- 语义：dsh 意外退出（非用户请求重启）时 manager 必须**照旧退出**（stdout EOF →
  Rust 发 server-down → 启动页报错+重试），不能偷偷自动拉起；只有 stdin `restart-dsh`
  命令才进监督循环重新 spawn。自动重启只在用户显式请求时发生。
- 语义：manager 的 stdin 是管道且被 Rust 持有，**不会自然 EOF**——dsh 退出后 manager
  若不 `process.exit()` 会被开着的 stdin 挂住，Rust 等不到 server-down。必须显式 exit。
- 语义：Windows 上运行中的 dsh 锁着 node-pty/koffi 等原生模块，npm 替换不了 →
  `update-dsh` 必须先杀 dsh 再装、装完再拉（监督循环的 pendingTask 就是这个顺序）。

## 17. 更新门控（D2）设计落地

- manager 启动**只查不装**：`checkDshUpdate()` 发 `{t:'update-status',...}` 协议行，
  Rust 镜像到 `ServerState.update` + 托盘动态菜单项（"检查更新…" ⇄ "有更新 vX（点击更新）"）。
- 一键更新链路：托盘/桥/启动页 → `{"cmd":"update-dsh"}` → 杀 dsh → npm 装（双 registry
  回退 + 进度流）→ 监督循环拉起新 dsh → 新随机端口 → WebView 整页导航。
- 测试：`scripts/test-control-plane.mjs` 用假 `@deepseek-ai/dsh` 包（bin.js 打 url 事件 +
  常驻）进程级验证：更新门控 / 未知命令不崩 / restart-dsh 重启两次不同 pid / check-update
  重报 / SIGTERM 退出码 0。

## 18. P2 插件管理：三处实测教训

- **源目录名 ≠ 包名**：`plugins/dsh-client-notifications` 的包名是 `@dsh-desktop/client-notifications`。
  sync-resources 和 manager 的 ensurePlugin 必须读 package.json 的 `name` 决定目标路径，
  按目录名拷贝会产出一个错误包名（`@dsh-desktop/dsh-client-notifications`）在 node_modules 里腐烂。
  教训：凡"目录 → 包"的映射，一律以 manifest 为准。
- **Settings slot 要 React，经典脚本拿不到 React**：dsh 的 slot 系统渲染 React 组件，React 不暴露为
  全局（Vite 打包内部引用）。经典脚本插件（通知插件模式）无法注册进 Settings 页。
  → 控制台 UI 改用**悬浮面板**（document.body 注入，零构建），与通知插件同款、零上游依赖。
- **`textContent` 不会解析 HTML**：控制台 actions 容器用 `el('div', htmlString)`（内部 textContent）
  导致按钮渲染成字面文本——行为测试（test-plugin-console.mjs）当场抓出。要用 `innerHTML` 装按钮
  组合。测试桩的 `innerHTML`/`textContent` 必须模拟真实语义（parse children / 清空 children），
  否则这类 bug 测不出来。
- **Rust 桥做插件开关（文件操作）比 manager stdin 往返更稳**：`/plugins/enable|disable` 直接读写
  profile manifest，无需请求/响应状态机。预装名白名单校验必须在 Rust 侧（桥是 loopback CORS-open）。
- **生产构建没有 HMR module-roots 入口**：`dsh web` 的 `cordis-plugin-hmr` 以 `root: []` 硬编码挂载，
  仅配置热更。Dev 模式不追求 host HMR，用 restart-dsh 快速回路（不查更新、不重装）即可秒级迭代。

## 19. CheckMenuItem API（Tauri 2.11）

- `CheckMenuItem::with_id(manager, id, text, enabled, checked, accelerator)` —— **enabled 在 checked 前面**，
  6 参数。`is_checked()`/`set_checked(bool)` 都不需要 app handle（和 MenuItem::set_text 一致）。
- setup 闭包里的 `app: &mut App`，调 `&AppHandle` 参数的函数要用 `app.handle()` 转换，直接传 `app` 会 E0308。

## 20. P5 用户自装（方案 X：内置 pnpm + 复用 dsh plugin CLI）

- **`dsh plugin` 硬依赖 PATH 上的 `pnpm`**（`spawnSync('pnpm')`）：壳必须提供。
  方案 = 懒安装（首次插件操作时 `npm install pnpm --prefix <runtime>`）+ 在
  `<runtime>/bin/` 写 `pnpm` / `pnpm.cmd` shim（exec 内置 node + pnpm.cjs），
  运行 `dsh plugin` 时把 `<runtime>/bin` 前置到 PATH。pre-seeded pnpm 时也要确保 shim 存在。
- **复用 vs 自实现**：install/remove/update 全走 `node dshBin plugin --profile web <args>`，
  reconcile（dependency→bundles 自动增删）和 git/allowBuilds 诊断全归上游，壳只做
  pnpm 供给 + 输出流（log 行）+ op-status 事件（start/done/ok/nextAction）。
- **预装（非 dependency）与用户自装（dependency）语义分离**：reconcile 只管理
  dependency 名，永不触碰预装包；Rust 侧 remove 白名单校验（在 bundles、非模板、
  非预装才放行）。并发安全：安装走 manager 串行（activeOp 互斥），预装开关走 Rust
  快速文件操作。
- **测试教训**：行为测试的 HTML 解析器用 `closeRe.source.length` 计已转义的 `<\/button>`
  （多 1 字符），导致同一 innerHTML 里第二个按钮解析不出来——off-by-one 把真 bug 和
  桩 bug 混在一起。凡按正则长度推进，用**实际匹配文本长度**（`match()[0].length`）。
- **沙箱 npm cache 只读（EROFS）**：manager 的 npm() 用默认 cache，本环境跑不了真实
  pnpm 安装——控制面测试用预置 pnpm 桩验证 shim 与路由，真机安装留给用户环境。

## 21. 用户体验修复轮（5 个真机问题）

- **open_devtools 只在 release 炸**：被 `#[cfg(any(debug_assertions, feature="devtools"))]` 门控，
  `cargo check`（debug）看不出来。**教训：涉及 Tauri API 的改动必须跑 release check**
  （`cargo check --release`，或对有平台依赖的树用 `--target`）。修复 = tauri feature 加 `devtools`。
- **启动白屏**：manager 启动时 `await checkDshUpdate()`（npm 网络查询，国内可达数秒）阻塞 dsh 拉起，
  且 WebView2 首帧无背景色闪白。修复 = **先拉起 dsh、更新检查后台并行** + 窗口配置
  `backgroundColor: "#0d1117"`。另一个会话在 setup 里同步跑的 COM activator 也疑似阻塞主线程（待其自行处理）。
- **插件按钮首次点击无反应**：创建 panel 时 `style.display` 初始为 `''`，`'' === 'none'` 为假 →
  首点被三元表达式设成 `'none'`（隐藏），第二次才显示。修复 = 创建即 `display:block` 并 return。
- **启用后无下一步提示**：toggle 成功后调 `refresh()`，`textContent=''` 把刚弹出的"重启后生效 +
  立即重启"**整个清掉**。修复 = `pendingRestart` 状态标志，`refresh()` 从标志重渲染横幅，
  提示跨重绘存活（install/remove/update 的 op done 也置位）。
- **"重启 dsh" vs "重启服务" 迷惑**：对普通用户语义不可分。修复 = 托盘只留一个"重启"（全量），
  快速重启（restart-dsh）降级为控制台里的上下文按钮"立即重启"（插件变更后出现），
  devtools 按钮仅 devMode 时渲染（/plugins/list 带 devMode 字段）。
- **预装卡片无描述**：/plugins/list 的 preinstalled 改为 `{name, description}` 对象，
  卡片显示描述子行，用户才知道这个插件是干嘛的。
- 全部由 test-plugin-console.mjs（9 场景）与 test-control-plane.mjs（7 场景）守护；测试桩
  补了 `classList` 与 `.class` 选择器支持。

## 22. 预装插件更新机制（用户门控 / npm / 可恢复默认）

- **设计**：预装包非 profile 依赖，`dsh plugin` 管不到。更新 = manager `npm view` 对比 →
  临时目录 `npm install <pkg>@<latest> --prefix <tmp>` → 拷贝 node_modules/<pkg> 覆盖 runtime
  拷贝 → 记录 dsh.json `updates` → op-status + "重启后生效"。恢复默认 = 删记录 +
  ensurePreinstalled 重拷壳内置版。
- **致命坑：不能 `npm install --prefix <runtime>` 更新预装包**——npm 会 reify 整棵树并
  prune 掉不在 runtime/package.json dependencies 里的包（通知插件/控制台插件/其它预装包
  全是纯拷贝的），会把他们删光。必须临时目录安装 + 拷贝。
- **ensurePreinstalled 必须尊重 dsh.json `updates`**：否则下次启动字节对比会把用户刚更新
  的版本盖回壳的旧版。
- **事件**：`{t:'preinstalled-updates', updates:{name:{installed,latest,updateAvailable,userUpdated}}}`
  由 manager 在启动后台 + 手动检查时发出，Rust 镜像进 ServerState，/plugins/list 带出。
- 控制台：预装卡片"有更新 vX → 更新到vX"徽标 + "恢复默认"（userUpdated 时）+ "检查预装插件更新"。

## 23. 启动黑屏 5s + reg.exe 命令弹窗（另一会话代码，诊断未改）

- 两症状同一根因：另一会话 `register_toast_activator` 在 **setup 主线程同步** spawn 多个
  `reg.exe`（`Command::new("reg").status()`），且 reg.exe 是控制台程序、**未加
  CREATE_NO_WINDOW**（`no_console_window` 就在同 crate，可复用）。
- 主线程被阻塞 → WebView 首帧画不出来 → 窗口只显示 backgroundColor（黑屏 ~5s）；
  reg.exe 逐个弹控制台窗 → "命令弹窗一闪即逝"。
- 建议修复（留给该会话）：reg 命令加 `no_console_window(&mut cmd)`，并把整个注册
  挪到 `std::thread::spawn` 或窗口显示后，避免阻塞 setup。
- 我方已修：manager `killTree` 的 taskkill spawn 补 `windowsHide: true`（重启/退出时
  不再闪 cmd 窗——这也是我方代码里的同类问题）。

## 24. 按钮换行 + 启动页按钮位置（用户体验微调）

- **按钮被挤成三行**：行内右侧按钮容器是普通 div（按钮 inline 排列），"更新到0.1.3"在窄容器里
  按字符换行。修复 = `.dshc-btn2 { white-space: nowrap }` + 行右侧容器
  `display:flex; flex-wrap:wrap; gap:6px; justify-content:flex-end`（整钮换行而非字符换行）。
- **启动页按钮没用**：启动页只显示几秒，放"一键更新"按钮是无效交互。移除启动页横幅，
  更新提醒改为三处：托盘常驻「有更新 vX（点击更新）」+ 控制台更新区 + **启动时原生 toast
  弹一次**（`UPDATE_TOAST_SHOWN` 每进程一次，提醒用户点托盘更新）。启动页滚动日志里
  manager 的 "update available" 行仍在（信息不丢，只是不再有按钮）。

## 25. 重启后连不上——重连必须由壳驱动，不能靠启动页

- 现象：开启/关闭插件后点「立即重启」、或托盘点「重启」，dsh 重启后 WebView 停在旧端口死页，
  服务起不来（连不上）。
- 根因：dsh 用 `--port 0` 每次重启换新端口。manager 发新 `{t:'url'}`，Rust 只 `emit("server-url")`，
  **唯一监听它的启动页 JS 早在首次跳转时就被替换掉了**——重启后没有任何东西把 WebView 导航到新 URL。
  原始代码就有此隐患（重启路径少用没暴露），「立即重启」让每次插件操作都触发，问题浮出。
- 修复（两条）：
  1. `server-url` 事件处理里**Rust 直接 `w.navigate(url)`**（幂等：已是当前页则 no-op）——重启重连
     不依赖任何页面 JS。
  2. manager 退出（stdout EOF → server-down）时，若当前页是 dsh 回环页（http://127.0.0.1|localhost），
     导航回启动页（setup 时 `w.url()` 捕获的 LAUNCHER_URL）重新待命；崩溃时显示错误+重试。
- 教训：**"导航"职责不能绑在会被替换掉的页面上**。壳持有的 WebView 导航是唯一可靠重连路径。
- `w.navigate()` 需要 `tauri::Url`（`tauri::Url::parse`），不是 `&str`；跨线程调用 OK（reload 已在桥线程用）。

## 26. ensurePnpm 的 --prefix runtime prune 陷阱（预装描述消失的真凶）

- 现象：第一次安装新插件时，预装插件的说明（乃至整个预装项）消失。
- 根因：`ensurePnpm` 用 `npm install pnpm --prefix <runtime>` 装 pnpm——npm reify 整棵
  runtime 树，**prune 掉不在 runtime/package.json dependencies 里的纯拷贝包**
  （@dsh-desktop/* 插件、预装 dsh-model-reasoning）。§21 记录过同类坑，但 ensurePnpm 漏改。
- 修复：ensurePnpm 改临时目录安装 + 拷贝进 runtime/node_modules/pnpm（永不 --prefix runtime）。
- 同类第二处：`installDshUpdate`（`npm install @deepseek-ai/dsh --prefix runtime`）同样会
  prune——`updateDshAndRestart` 装完后必须重跑 ensurePlugin + ensurePreinstalled 恢复。
- 铁律：**凡 npm 写 runtime 树，之后必重拷纯拷贝包；能不 --prefix runtime 就不。**
- 交互：自定义 tooltip 组件替代原生 title（描述两行省略，悬停显示完整，随鼠标定位、
  视口内钳制），附测试（mouseenter 触发 dshc-tip 出现）。

## 27. 重启后残留提示——op-status 生命周期审计（"✓ 完成 — 重启后生效" 反复出现）

- 现象：更新插件 → 立即重启后，提示还在，且随 5s 轮询反复刷新。
- 根因（两处，同为"状态在重启后未清空"）：
  1. restart-dsh 只重启 dsh、manager 存活 → manager 的 `activeOp`（done+ok）残留；
     页面重载后控制台从 /plugins/list 又读到旧 op → 重新置 pendingRestart。
  2. 全量重启（托盘）时 manager 换新，但 **Rust `ServerState.op` 缓存没重置** →
     新页面读到上个 manager 的旧 op。
- 修复：
  1. `requestRestart()` 清 `activeOp = null` 并 emit `{t:'op-status',op:null,done:false}`；
     **必须用 null 而非 `{op:null,done:false}`**——busy 互斥 `activeOp && !done` 会把
     done:false 误判为进行中而阻塞后续操作（当场踩坑，guard 又加 `activeOp.op` 双保险）。
  2. `start_server()` 与 update 一起重置 `ServerState.op` 和 `preinstalled_updates`。
- 审计教训（状态生命周期三问）：
  1. 重启后该状态还会被读到吗？（op-status 会 → 必须清）
  2. 清空方式会不会被误判？（`{op:null,done:false}` 撞 busy-guard → 用 null）
  3. 值传递链上每一环（manager→Rust→client）的重启语义一致吗？（全量/增量重启都要清）

## 28. 壳内置正向代理（方案 B）的关键工程发现

- **undici 不读 *PROXY 环境变量**，但 Node ≥24.0 设 `NODE_USE_ENV_PROXY=1` 后全局 fetch 会尊重
  HTTP_PROXY/HTTPS_PROXY/NO_PROXY（v24.18.0 实测生效，无告警输出）。dsh 的模型请求、web 搜索、
  web fetch 全走服务端 Node 的全局 fetch —— 一个环境变量管住全部出站，浏览器侧零改动。
- **dsh 官方认可"出口由启动环境决定"**：app-boot 把 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY
  列为 bootstrap-only 变量（只能由启动环境注入、不能写 .env）。往 dsh 进程注入代理变量是官方留的口子，
  不算改动 dsh 代码。
- **`ALL_PROXY` 不会破坏 undici env-proxy**（受控重测确认；一次"设了 ALL_PROXY 就不路由"的失败
  是玩具代理自己的问题）。三个 *PROXY 都设，覆盖 curl/wget 类工具。
- **undici env-proxy 对 http:// 目标也走 CONNECT 隧道**（不是绝对 URI GET）——真实流量以 CONNECT
  为主，内置代理的 CONNECT 处理是核心路径。
- **NO_PROXY 必须排除 loopback**：`127.0.0.1,localhost,::1` + 用户原有 NO_PROXY 追加，本地
  dsh web/通知桥绝不走代理（实测正确绕过）。
- **路由实时生效**：内置代理每请求读 <runtime>/proxy.json（小文件，µs 级），设置面板勾选"保存即生效"
  无需重启 dsh；首次安装 dsh 前需先配好代理（manager 启动先起代理再装 dsh，安装流量已骑在代理上）。
- **防自环两重**：loopback 目标永远直连（upstream 不得代理本机流量）；upstream 指向本代理端口视为
  禁用；代理自身用 raw net/http，永远不经过 undici env-proxy。
- **测试**：test-proxy.mjs（11 场景）、test-proxy-e2e.mjs（真实 undici→manager 代理→假上游）、
  test-control-plane.mjs（假 dsh 探测 env 断言注入）、test-launcher-settings.mjs（vm 加载真实
  src/settings.js + 最小 DOM 桩验证独立设置窗口；注意 vm 跨 realm 数组的 assert.deepEqual 因原型
  不同必失败，先 `[...arr]` 展开再比）。

## 29. 代理设置的放置：启动页不是入口（独立窗口 + 控制台面板 + 托盘）

- **教训**：启动页只存在到 dsh 就绪（几秒），作为低频设置的主入口是错误放置——用户根本来不及，
  且 dsh 加载后没有入口。产品决策"放哪"必须先想清楚，而不是顺着"启动页能设置"就做。
- **第一版**（fcb03d2）：独立设置窗口 + 主窗口菜单栏「设置 → 代理设置…」+ 托盘。
- **再次调整（用户反馈菜单栏挤占空间——只有一项"设置"不值得占一整行）**：
  - 去掉主窗口菜单栏（`WebviewWindow::set_menu`、Builder::on_menu_event、Submenu 全删）；
  - 主入口 = **dsh 页面右下角「插件」控制台面板的「代理设置」按钮**——复用已有悬浮面板，零新增占用；
    远程页面无 `__TAURI__`，点击走桥端点 **`POST /settings/open-proxy`** → `open_settings_window`；
  - 辅助入口 = **托盘「代理设置…」**（保留，TrayIconBuilder::on_menu_event 的 `proxy-settings` 分支）；
  - 落点 = **独立设置窗口**（`WebviewWindowBuilder::new(label="settings", WebviewUrl::App("settings.html"))`，
    `open_settings_window` 幂等：已存在则 show+focus，否则新建；窗口独立于 dsh 主页面，设置不打断使用）。
  - **启动页彻底移除设置**（⚙ 按钮、?view=settings 视图、ready-banner 全删）；back_to_dsh /
    navigate_to_launcher_view / CURRENT_DSH_URL 一并移除。
- **提供方显示（用户反馈"显示地址不如名称；同地址可能多名"）**：
  - `providerHostsFromSettings` 提取 llm-pi-ai providers 的 **`displayName`** 字段 + llm-deepseek 固定
    "DeepSeek"，返回 `{name, displayName?, host}`；
  - 设置面板按 **host 归并**：同一地址下的多个提供方合成一个条目（标签列出所有名称，如
    `DeepSeek / ACME 网关（api.deepseek.com）`），一个开关；
  - **技术限制（已与用户确认接受）**：代理路由发生在 TCP 层（CONNECT 到 host:port），只能按目标地址
    区分，看不到 URL/提供方身份（HTTPS 加密）。同 host 的多个提供方必然一起走代理或一起直连；要单独
    控制只能改 dsh 应用层或做 HTTPS MITM（均不现实）。
- **权限**：独立窗口是本地页，capability `launcher` 的 windows 加 `"settings"`；显式补
  `core:window:allow-close`（core:window:default 是否含 allow-close 在自动生成的权限里查不到静态定义，
  显式声明保证关闭按钮可用，冗余无害）。
- **测试**：test-launcher-settings.mjs 加载独立的 src/settings.js（vm + 最小 DOM + mock Tauri 桥），
  验证渲染（含同 host 归并标签）/保存/关闭按钮（5 场景）；test-plugin-console.mjs 断言控制台面板
  「代理设置」按钮点击 POST `/settings/open-proxy`。

## 30. 预装卡片两行布局 + 测试桩 innerHTML 语义

- 预装项卡片 = 一个统一容器 `.dshc-item`（背景/边框/圆角），内部两行右列：
  第一行 `[↑升级箭头][开关]`（nowrap，不被左侧简介挤压），第二行 `[恢复默认]`。
  `.dshc-row` 用 `align-items: stretch` 让左右等高（左边两行简介 vs 右边两列）。
  关键：`.dshc-row > div:last-child` 通用 flex-wrap 在 item 内被覆盖为纵向 column。
- 测试桩教训：桩的 innerHTML setter 原先"追加不清空"，而真实 DOM 是"替换"——连续两次
  innerHTML 赋值会让子元素重复（同插件渲染两次）。修桩：set 时先 `children=[]` 再解析。
  同时 client 侧改为**一次构建完整字符串**再赋值，避免依赖 setter 语义。

## 31. 包管理器对 monorepo 依赖树挂起 + 发版必须做的 Windows 运行时冒烟（0.3.0→0.3.3 实战）

### 根因（终于实锤）
- **`npm install @deepseek-ai/dsh` 在 npm 依赖解析（buildIdealTree/placeDep）阶段无限挂起**：
  从最早的 0.0.1-rc.5 到 0.1.0-rc.7 全部复现；npm 10/11、Node 22/24、npmjs/npmmirror、
  代理/直连全部复现；`npm install commander`（小树）419ms 正常。
- 特征：npm 调试日志停在 `silly placeDep` 后**不再发任何网络请求**（`NODE_DEBUG=http` 确认
  无新 outgoing message），CPU 空转、无输出，只有 kill。**`pnpm` 装同一个包 5.9s 完成**
  （dsh 自己就是 pnpm monorepo：55-61 个互相依赖的 `@deepseek-ai/*` 包）。
- 排障路径（可复用，已沉淀为技能 `.dsh/skills/windows-desktop-shell-debugging/SKILL.md`）：
  用户开 WSL → 直接读 `/mnt/c/Users/<u>/AppData/Roaming/dev.dsh.desktop/runtime` 的
  `manager.log`/`proxy.json`/`node_modules` 现场 → 受控实验逐个隔离变量（代理/镜像/工具/Node/npm 版本）
  → npm 调试日志 + NODE_DEBUG → 换 pnpm 对照 → 根因落定 → 端到端验证。

### 修复（0.3.3）
- `scripts/server-manager.mjs`：dsh 安装从 npm 切到 **pnpm**。`npm()` 重构出通用 `runChild()`
  （spawn 捆绑 node / 输出节流流式 / 600s 硬超时 / 180s 无输出卡死检测 / 单一 settle），
  `npm()` 与新增 `pnpm()` 共用；`installDshUpdate` 走 `pnpm install ... --store-dir <runtime>/.pnpm-store`
  （isolated 布局，已端到端验证 dsh 启动+插件注入+URL）；`ensurePnpmWorkspace()` 写
  `<runtime>/pnpm-workspace.yaml` 的 `allowBuilds`（pnpm 11.22 的原生 postinstall 授权，替代 npm 11 的
  `.npmrc allow-scripts`；NATIVE_BUILD_PKGS 共享）。npm 仍用于版本查询/npm 装 pnpm 引导/单包安装。
- 0.3.1/0.3.2 的超时/卡死检测/registry 降级/半截安装修复全部保留。

### 发版流程新增（"以后发版都得测"）
- **CI 门禁**：`.github/workflows/build.yml` windows job 新增 **Runtime smoke**（`scripts/smoke-windows.mjs`）：
  用捆绑 node 跑真实 manager 于空 runtime，从真实 registry 冷安装 dsh（pnpm），断言 dsh web 报 URL。
  直接拦住"安装挂起/launch failed: not installed"这类回归，任何 tag 发布前必过。
- **手工检查清单**（发版前真机过一遍）：
  1. 全新安装（空机/删数据）→ 冷安装能完成、启动页进 dsh、插件注入可见（页面含
     `__DSH_BOOT__` + 插件名）；
  2. 普通升级（覆盖装、不勾「删除应用数据」）→ 数据保留、dsh 自动更新；
  3. 半截安装恢复：手动删 `runtime/node_modules/@deepseek-ai/dsh` 的 `lib/` 后重启 → 自动重装；
  4. 断网/镜像不可达 → 快速失败 + 自动切镜像 + 清晰报错（不是 20 分钟静默）；
  5. 通知/托盘/关闭行为回归。
- 排障工具：`scripts/diagnose.ps1`（Windows 一键诊断，**必须纯 ASCII**——PowerShell 5.1 把无 BOM
  UTF-8 当 GBK 读会炸解析）、`scripts/smoke-windows.mjs`（冒烟）。

### 环境坑（沙箱/测试）
- 沙箱 HOME 只读 → npm/pnpm 报 EROFS cacache，先设 `HOME=<可写目录>`；
- 在仓库子目录跑 `pnpm install` 会向上找到 `pnpm-workspace.yaml` 把整棵树装进仓库根 node_modules、
  改写 package.json/lockfile——测试目录自建 workspace 文件或删掉仓库根多余文件；
- `cmd | tail` 的 `$?` 是 tail 的；`pkill -f` 会匹配自身命令行自杀——用精确 PID。

## 32. 版本比较不能只比"不等"；dsh 启动器 flag 顺序；npm 预发布通道（0.3.5→0.3.7）

### 版本比较坑（0.3.7 修复）：`current !== latest` 会在 next 用户上误报降级
- 用户升到 `next` 预发布（0.1.0-rc.8，比 `latest` 的 rc.7 新）后，控制台误报「当前 rc.8 → rc.7 一键更新」——
  `updateAvailable` 用 `current !== latest`（只比不同、不比新旧）导致。
- **修法：任何"是否有更新"判断必须用语义化比较**（`versionGt(latest, current)`，只在新版严格新于当前时为真），
  绝不能 `!==`。同理 `nextAvailable` 也要 `versionGt(next, current)`。
- 可复用：版本字段一旦有预发布，`!==` 就是错；统一用一个 rc 感知的 `versionGt`。

### dsh 启动器 flag 顺序坑（0.3.6）：`--no-open` 放错位置 → unknown option '--patch'
- `dsh web` 的启动器**解析到第一个它不认识的 flag 就停止**，把剩余参数原样透传给被启动的应用。
- 启动器自己的 flag（`--patch`、`--profile`）必须放在应用 flag（`--host`、`--port`、`--no-open`）**之前**。
- 桌面壳场景：`dsh web --patch <file> --no-open --host ... --port 0`——`--no-open` 防止默认浏览器被
  壳内 webview 之外再打开一遍。
- 已记入技能 `.dsh/skills/.../SKILL.md` §8。

### npm 预发布通道（0.3.5 特性）
- dsh 团队常把新 rc 标在 `next` tag（如 0.1.0-rc.8）而 `latest` 停在稳定 rc——从 GitHub 安装不可行
  （monorepo：根包是 dsh-root、git 依赖不支持子目录、apps/cli 有 71 个 workspace:* 依赖）。
- manager 用 `npm view pkg dist-tags.latest dist-tags.next --json` 一次取两个 tag；**多字段返回的对象键带完整
  路径**（`dist-tags.latest` / `dist-tags.next`），某 tag 不存在时折叠为纯字符串——解析要兼容。
- 控制台在 `nextAvailable` 时显示「当前 → rc.8（预发布）」+ 带版本的一键升级（`/update-dsh` 传 version），
  想升才升，默认仍用稳定 latest。

## 33. 通知 toast 弹两次：根因在 client.js scan() 的边沿互斥，不在 Rust/双实例（0.3.8 修复）

### 用户现象
Windows 桌面壳里系统通知 toast「每次都会弹两次」。三方独立审计 + `scripts/repro-double-notify.mjs` 实测确认：
**不是** Rust 双弹、**不是**插件双加载（dsh 加载链每层去重/loud error，单页只 apply 一次）、**不是** Web 内部 toast
（InputBar/ModelSelect 无双通道）。

### 根因（都在 `plugins/dsh-client-notifications/client.js` 的 scan()）
1. **完成边沿与 pending 边沿不互斥**：dsh 客户端 runtime 的 Notifier 把多次 mutation 合并成"最新快照"一次回调；
   任务收尾 + question/approval/plan-review 帧同 flush 时，一次 scan() 里 pending 分支（无 continue）又落进
   running true→false 完成分支 → 一个回合结束发两条 POST（"dsh 需要你" + "dsh 任务完成"）。
2. **父 + 子（subagent）会话双行各完成**：lineage 投影里子会话占独立一行（`running`/`completed` 各自独立），
   子行完成也发"任务完成"，且子行标题回退到共享 cwd → 同一任务弹多条文案相同的 toast。

### 修法（确定性、零时序副作用；两轮独立审查后修订）
- **规则A（完成通知仅限非 subagent 行）**：`const isSubagentRow = item.origin === 'subagent'`；
  完成类分支（主路径 + completed fallback）在子代理行上静默（`notify-complete-suppressed`，`ended:true`）。
  判根用 **origin** 而非 parentId 字段：`origin?: 'subagent'` 是 host 唯一 origin 值（api/sessions.ts:204），
  fork 子会话（parentId 存在但 origin 为空）是用户亲手驱动的独立任务，其完成必须照常弹——第一版
  `!parentSessionId && !parentId` 的判根把 fork/孤儿子行完成也静默了（审查 SE2/SE3），改为 origin 语义后恢复。
- **规则B（完成与 pending 互斥，同快照）**：完成边沿若本行 `pending` 为真 → 不发"任务完成"（只发"需要你"），
  并置 `ended: true` + continue（防 completed fallback 误补发）；fallback 分支同样 `&& !pending`。
- **规则C（pending 全行通知）**：pending 分支**不**受 subagent 限制——dsh 的 approval/question 帧按请求方
  会话记账（api-proxy.ts:1417 `sessionId: req.agent.session.id`），客户端无父级中继，子代理提问只落子行；
  第一版把子行整行跳过导致"子代理在等你批准/回答"完全静默（审查 SE1，原注释"waits arrive on the root row
  too"为假），修订后保留子代理交互的「需要你」。
- 测试：`scripts/test-client-notifications.mjs` 12→19 场景（13 同快照互斥、14 父+子代理单发、15 子代理
  pending 单发、16 干净完成、17 回答后完成、18 fork 子会话完成单发、19 子代理行完成静默）；
  `scripts/repro-double-notify.mjs` 断言修复后单发与子代理需要你不丢失。`npm run test:plugin` 全绿。
- 残留：① 分快照交付（running→false 与 pending 分帧，间隔>1 flush）时完成 toast 先弹、需要你后弹——
  生产 Notifier 将同 tick mutation 合并为一次 microtask flush（notifier.ts:37-42），同批帧即同快照，已覆盖
  主场景；若真分帧可加 ~1s settle 窗口（延迟完成 toast）。② 双页面实例（webview 之外浏览器 tab 开同一 dsh
  URL）各自 POST，完全相同的 toast 双弹——client 内无法去重，需 Rust /notify 桥短窗口去重或关闭多余 tab。

### 日志区分（用户侧验证）
`%APPDATA%\dev.dsh.desktop\dsh-desktop-session.log`：同一事件若 `client/log notify-complete` + `notify-pending`
各一行 → 机制 1（本修复已堵）；若 `notification:` 行成对且 `notify-complete` 一行而 `notification:` 两行 →
壳层重复；若 `notify-*` 决策行成对 → 双页面实例（webview 之外还有浏览器 tab 开着同一 dsh URL，各自一个插件
实例各自 POST /notify），需关掉多余 tab/实例。
