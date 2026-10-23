<p align="center">
  <img src="src-tauri/icons/128x128.png" width="128" height="128" alt="DSH Smoothly Desktop logo" />
</p>

# DSH Smoothly Desktop (DSH SD)

DSH Smoothly Desktop（**DSH SD**）把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）打包成可独立运行的 Windows 桌面 App。

- **dsh 更新由你决定**：启动时只检查 npm 上 `@deepseek-ai/dsh` 的稳定版（`latest` tag）与预发布（`next`/`alpha` tag），**不自动安装**。有新版时托盘菜单高亮「有更新 vX → 点击更新」，壳菜单「检查更新…」弹窗也能一键更新（含预发布，想升才升）；点一下即下载安装并自动重启。dsh 永远来自官方 npm 包（经内置 pnpm 安装），本地零改动。**唯一例外是版本地板**：壳要求 dsh ≥ `0.2.1-rc.2`（0.1.6-alpha.2 起 dsh 才自带插件管理；随壳分发的预装插件要能被 dsh 的插件兼容门禁放行；`0.2.0-rc.1` / `0.2.0-rc.2` / `0.2.1-alpha.2` 三版都做过全面回归——overlay 目标行 / CLI / 客户端 seam 与槽位均成立、四个预装插件实机渲染正常；`0.2.1-rc.2` 已完成静态契约核对与 dev 实机验证，**已随 v0.19.0 发布并核验**（`CHANGELOG.md` 的 0.19.0 条目 + 随包 `manager/server-manager.mjs` 同值）。见 `docs/2026-09-25-shell-improvement-plan.md` §15），低于地板的运行时会先自动升到地板，失败则如实提示并继续启动。
- **插件管理在 dsh 自己的页面里**：dsh 0.1.6-alpha.2 起自带插件管理（Web 侧边栏 **Plugins** 页：安装/卸载/启用/停用/行级开关/构建脚本审批/插件配置页）。壳内不再有自建的插件管理窗口——dsh 起不来时用壳菜单「停用全部第三方插件…」自救（会先备份 profile `package.json`）。
- **升级后自动清理残留嵌套包**：pnpm 的 hoisted 安装不清理上一版留下的嵌套目录，而 Node 解析嵌套副本优先于提升到根的新版 —— 实测 0.1.5-rc.2 → 0.1.6-alpha.2 后 `dsh-session-persistence-jsonl/node_modules/@deepseek-ai/*` 仍是旧版（不导出新版需要的 `./message-projections`）→ dsh 启动即崩。壳在**升级后与每次启动**都检查一次，只删版本与父包不一致的嵌套副本（不重建整棵树、不需要联网）。
- **内置 Node 24 运行时**：安装包自带 Node（满足 dsh 的运行要求），用户机器无需装 Node。
- **原生通知**：dsh 需要你问答（`pendingInteraction`：问题 / 批准 / 计划审阅）时，或某个会话结束（`running` 由真变假）时，弹出系统通知；窗口在前台时不打扰。
- **点击通知直达会话**：单击系统通知会把窗口带回前台并打开对应会话（单实例 + 本地桥实现）。
- **托盘常驻**：关窗只是隐藏，服务继续跑；托盘菜单"退出"才真正停止并退出。
- **壳内代理**：所有 dsh 出站流量（模型请求、web 搜索、npm 安装/更新、插件、子代理）都经壳内置的本地正向代理；默认直连，可在设置里勾选哪些主机走上游代理（含可选账号密码），保存即生效。**入口 = 托盘「代理设置…」**（打开独立设置窗口，不打断 dsh 页面）。
- **官方零改动**：通知插件通过 `dsh web --patch` 在运行时注入，更新 dsh 不会冲掉它。
- 桌面端数据自包含（`DSH_HOME` 默认在运行时目录内），与浏览器版各自独立，可随时切回共用。

## 架构

```
┌─ Tauri 2 壳 (Rust, WebView2) ─────────────────────────────┐
│ 本地启动页 → 监听 server-url 事件 → 跳转 http://127.0.0.1   │
│ server-manager.mjs（内置 Node 24 运行）                     │
│   校验/更新 @deepseek-ai/dsh（pnpm 装自 npm registry）       │
│   注入通知插件（--patch，copy 进运行时 node_modules）        │
│   拉起 dsh web --no-open（不开默认浏览器）                   │
│   解析 stdout 里的 http://127.0.0.1:<port> 上报给壳         │
│ 本地通知桥（127.0.0.1:<bridge>）                           │
│   /notify → tauri-plugin-notification 弹系统通知           │
│   /pending-open → 点通知后的"待打开会话"                    │
│   /log /alive → 决策日志 + 心跳（排查用）                   │
│ 自绘顶栏（decorations:false）：窗口三键 + 壳菜单栏           │
│   注入 shell-chrome.js（SHELL_MENUS 定义点，IPC/桥双通道）   │
│ 托盘：显示窗口 / 重启服务 / 打开数据目录 / 退出              │
│ single-instance：toast 点击/二次启动 → 聚焦已有窗口          │
└────────────────────────┬──────────────────────────────────┘
                         │ spawn
                 ┌───────▼────────┐        通知插件（仅 loopback 权限）
                 │  dsh web 服务   │ ◄──── 事件 → 桥 → 系统 toast
                 └────────────────┘        数据 <runtime>/dsh-home
```

## 目录

```
src/                      Tauri 前端加载页（纯静态，无打包器）
  index.html / app.js      启动页：等 dsh 就绪 → 跳转；安装进度 + 滚动日志
  settings.html / settings.js  独立代理设置窗口（顶栏菜单栏 / 托盘打开）
src-tauri/                Tauri 2 壳：
  src/lib.rs               窗口/托盘/单实例/通知桥/服务生命周期/代理桥/壳顶栏注入
  resources/ui/shell-chrome.js  壳顶栏（窗口三键 + 菜单栏；SHELL_MENUS 定义点，编译期内嵌）
  capabilities/            权限（launcher + remote-notifications）
  resources/patch/         --patch 注入文件（dsh-desktop.patch.yml）
  resources/manager/       同步后的 server-manager.mjs + proxy.mjs
  resources/node/          fetch-node.mjs 下载的 Node 24（不入库）
  resources/plugin/        @dsh-desktop 客户端插件（bundle 用）
  resources/preinstalled/  预装插件 bundle（dsh-kanban / model-reasoning / turn-navigator / smoothly-opencode-session）
  icons/                   应用图标全套（含 NSIS 安装器图标/向导横幅）
scripts/
  server-manager.mjs       更新 dsh（pnpm）+ 内置代理 + 拉起服务 + URL/日志上报（核心）
  proxy.mjs                壳内置正向代理（CONNECT/HTTP + 按主机路由 + Basic 认证）
  smoke-windows.mjs        发版门禁：空 runtime 冷安装 dsh → 断言报 URL
  fetch-node.mjs           下载/校验/解压 Node 24（幂等）
  sync-resources.mjs       把 scripts/plugins 同步进 src-tauri/resources
  make-icon-png.mjs        图标源生成工具（开发用）
  test-*.mjs               npm test 全量跑的行为/回归测试
plugins/dsh-client-notifications/
  client.js                浏览器半边：监听 pendingInteraction / running 沿，
                           经桥发通知、消费 /pending-open 打开会话
  index.js                 Node 半边：空实现（占位）
.dsh/skills/               排障技能（Windows 桌面壳安装/启动调试方法论）
.github/workflows/build.yml  windows-latest 出 NSIS；门禁：7z 断言 + runtime smoke；v* tag 发 Release
LICENSE                   MIT
```

## 构建（Windows）

在 Windows 上：

```bash
npm install
npm run bundle        # = tauri build --bundles nsis
```

产出于 `src-tauri/target/release/bundle/nsis/*.exe`。也可以直接推 GitHub 走
`.github/workflows/build.yml`（windows-latest 出 NSIS；ubuntu-latest 顺带出
AppImage/deb，方便 Linux 桌面验证）。

前置：Rust stable（MSVC）、Node 18+（本机工具链）。WebView2 一般已预装。
`tauri build` 前（`beforeBuildCommand`）会自动下载 Node 24 运行时并校验
SHA-256，再同步 manager/plugin/patch 等资源。

## 开发版（与正式版同机并存调试）

Windows 上已装正式版时，覆盖安装会动到工作数据。项目支持打一个**独立身份的开发版**，
与正式版互不干扰、可同时运行：

```bash
npm run bundle:dev        # = tauri build --config src-tauri/tauri.dev.conf.json --bundles nsis
```

`src-tauri/tauri.dev.conf.json` 只覆盖两个顶层字段（深合并到 tauri.conf.json，其余
配置原样继承）：`productName: "DSH Smoothly Desktop Dev"`、`identifier: "dsh.smoothly.desktop.dev"`。
由此带来的隔离：

| 维度 | 正式版 | 开发版 |
|---|---|---|
| 安装目录 / 开始菜单 / 卸载项 | `%LOCALAPPDATA%\DSH Smoothly Desktop` | `%LOCALAPPDATA%\DSH Smoothly Desktop Dev` |
| 应用数据（runtime、dsh 本体、`DSH_HOME`、proxy.json） | `%APPDATA%\dsh.smoothly.desktop` | `%APPDATA%\dsh.smoothly.desktop.dev` |
| 单实例互斥 / 任务栏 AUMID | `dsh.smoothly.desktop-sim` | `dsh.smoothly.desktop.dev-sim` |
| toast 激活 CLSID（随 identifier 派生） | 固定 GUID | 独立派生 GUID |
| dsh web 端口 / 通知桥端口 | 随机 | 随机（互不冲突） |

**应用标识（identifier）统一为 `dsh.smoothly.desktop`**（早期立项用 `dev.dsh.desktop`，`dev`
是命名空间前缀而非"开发版"——旧标识名易误读）。**老版本已装用户升级后自动迁移**：
应用启动时把旧 `%APPDATA%\dev.dsh.desktop` 系目录整体迁入新标识目录（整目录 rename 保持
node_modules 符号链接树、写迁移标记、绝不上移覆盖已有新数据、失败不丢旧数据下次重试），
随后在 `%APPDATA%\dsh.smoothly.desktop` 下正常工作。已装正式版与 dev 版均有同一套迁移保障。

- 两个版本可**同时运行**（各自单实例、各自 runtime、各自端口）。
- 开发版首次启动用自己的 runtime 冷安装一份 dsh（视网络 1~3 分钟），不动正式版数据。
- 顶栏应用菜单、托盘 tooltip、任务栏标题、关于 toast 均显示 "DSH Smoothly Desktop Dev（开发版）"，不会认错。
- 调试入口：顶栏「DSH Smoothly Desktop」→ 开发者模式（devtools）；`DSH_DESKTOP_REGISTRY` 等环境变量照常生效。
- 卸载开发版只清开发版自己的数据（卸载器「删除应用程序数据」只作用于 dev 目录）。
- 开发版版本号与正式版相同（tauri 要求 tauri.conf.json 与 Cargo.toml 版本一致，dev 配置不覆盖 version），以名称区分。
- **构建流程约定**：开发版只在本地构建（固定目录 `D:\Dev\dsh-desktop-dev`），**不上 GitHub Actions**；GitHub 仓库与 Release 只承载正式版（正式版构建 = `npm run bundle`，CI 与本地一致）。

## 本地验证（Linux 可跑的部分）

```bash
npm test                 # 全量 29 套（28 条 node 直接可跑 + 1 条条件式）：清单一致性 / overlay 目标行 / 升级标记 /
                         #   通知插件 / 控制面 / 代理 / 代理e2e / 启动页设置 / 壳顶栏契约 / 壳不吞页面原生行为
                         #   （拖放与外链，见下）/ 壳引导桩（纯 Node，无浏览器）/ 启动器扫动 / 请求头预算 /
                         #   半截安装自愈 / 副本一致性 / 版本比较 parity /
                         #   **自动化链路门禁自证**（scripts/test-automation-gates.mjs，见「维护者」小节）
                         #   **挂起看护"dump 后再探一次"**（scripts/test-watchdog-recovery.mjs，含 3 个变异自证）
                         #   **gh 凭据纪律**（scripts/test-gh-bin-discipline.mjs：裸 gh 缺省扫描 + 消费者兜底 + unit 模板）
                         #   条件式那条 = `[ -f scripts/test-version-compare-parity.mjs ]`：文件已提供就真跑，
                         #   尚未提供时打印 SKIP 并只跳过自己（不判红，也不掩盖它的失败 —— 失败码照传）
npm run test:slow        # 安装卡死快速失败（~3 分钟，不进 PR 门禁；CI 的 linux job 会跑）
npm run test:plugin      # 通知插件行为测试（纯 Node，无浏览器）
npm run test:chrome-real    # 壳注入脚本的**真实初始化**自检（不带 TEST_HOOK、真实 Chromium 注入，需本机
                            # dsh 在跑，否则显式 SKIP）：断言无 pageerror + 顶栏宿主与菜单在 + 顶栏真的在
                            # 视口顶部 + 引导上报链完整（inject→mounted→ready，无 fatal）+ **宿主被移除后
                            # 自愈重挂**。2026-10-15 那次"顶栏消失"事故正落在单测的缝里：
                            # test-shell-chrome.mjs 设了 __DSH_CHROME_TEST__ ⇒ chrome 提前 return ⇒ 真实
                            # 初始化路径从不执行。负向对照：`DSH_CHROME_FILE=<别的 chrome> npm run
                            # test:chrome-real` 必须变红（已用 0.18.0 的事故版验过，7 项失败）
npm run test:chrome-bootstrap   # 同一条链路的**纯 Node 门禁**（进 `npm test`，CI 里真的会跑；不设 TEST_HOOK、
                            # 不启动浏览器、零依赖）：手写最小 DOM + vm 沙箱加载 chrome，断言引导上报链
                            # inject→mounted→ready（无 fatal）/ 宿主与顶栏在 shadowRoot 里 / 宿主被移除 +
                            # 触发 MutationObserver 回调后**自愈重挂** / 契约写入（开与关两态）/ **极早时序**
                            # （documentElement 与 body 尚为 null）不抛异常。自带 **2 个内存变异体**自证可失败：
                            # 删契约的 `if (rootEl)` 守卫 ⇒ 极早时序变红；删自愈的 observe 注册 ⇒ 自愈变红。
                            # 做不到的：顶栏"真的在视口顶部"、菜单尺寸/滚动条仍归 test:chrome-real（本套件的
                            # getBoundingClientRect 是桩常量，不对几何下结论）
npm run test:control     # manager 控制面（11 场景，含版本地板闸门）
npm run test:proxy       # 内置正向代理（12 场景）
npm run test:launcher-settings  # 代理设置窗口（6 场景）
npm run test:shell-chrome       # 壳顶栏契约（菜单 id ↔ ACTIONS ↔ lib.rs 桥/命令）
node scripts/test-shell-passthrough.mjs
                         # 壳不吞页面原生行为的门禁（进 `npm test`，纯 Node、零依赖）：① A1：main 窗口
                         #   必须 `dragDropEnabled:false`（Tauri 默认 true 会关掉页面 HTML5 拖放），且 dev
                         #   配置不得自带 `app.windows`（--config 数组整体替换会静默丢掉该标志）、无别处依赖
                         #   Tauri 的原生 drag-drop 事件；② A2：`externalUrlVerdict` 的正/负用例（只放行
                         #   http(s)，file:/javascript:/data:/ms-* 全拒、about:blank 原样交回）、chrome 接线、
                         #   lib.rs 的桥端点/IPC 命令与唯一安全边界 `validate_external_url`。自带 2 个变异体
                         #   自证可失败：把 `dragDropEnabled` 改回 true ⇒ A1 断言红；放宽 chrome 的 scheme
                         #   白名单 ⇒ A2 断言红（都在临时副本里造，绝不改仓库）
npm run test:cargo-lock-sync   # Cargo.lock 版本同步（LF/CRLF 双行尾 / 精确匹配 / 失败诊断；
                               # 它红了 = 打不出安装包，2026-10-16 的发布阻断事故就在这)
npm run test:copies      # 副本一致性（manager / 客户端插件 / 预装 ship list / SKILL.md frontmatter）
npm run fetch:node       # 下载并校验内置 Node 24（win/linux/darwin）
npm run sync:resources   # 同步 manager/plugin/patch 进 src-tauri/resources
```

完整注入链路（与 Windows 运行时同构）可手动复现，或用**一键冒烟脚本**（推荐）：

```bash
# 一键冒烟：空 runtime → manager 用 pnpm 冷安装真实 dsh → 断言 dsh web 报 URL
# （发版门禁，CI 每次出包都跑）
node scripts/smoke-windows.mjs
# 可选换镜像：DSH_SMOKE_REGISTRY=https://registry.npmmirror.com node scripts/smoke-windows.mjs

# 手动链路（注意：dsh 依赖树会让 npm 解析挂起，必须用 pnpm；且要用
# --node-linker=hoisted，否则 isolated 布局下预装插件解析不到 dsh 内部包）
# 1) 装官方 dsh 到临时 runtime（pnpm）
mkdir -p /tmp/dshrt && cd /tmp/dshrt \
  && printf 'allowBuilds:\n  "@deepseek-ai/dsh-subprocess-local": true\n  koffi: true\n  node-pty: true\n  "@google/genai": true\n  protobufjs: true\n' > pnpm-workspace.yaml \
  && pnpm install @deepseek-ai/dsh --node-linker=hoisted --registry https://registry.npmmirror.com
# 2) 用内置/本机 node 跑 manager（自动更新 dsh -> 注入插件 -> 拉起服务 -> 上报 URL）
node scripts/server-manager.mjs \
  --runtime-dir /tmp/dshrt \
  --resource-dir src-tauri/resources \
  --patch src-tauri/resources/patch/dsh-desktop.patch.yml \
  --cwd "$HOME"
# stdout 会输出 {"t":"url","url":"http://127.0.0.1:<port>"}
# 然后 curl http://127.0.0.1:<port>/ 可见 __DSH_BOOT__ 含 desktop-notifications
```

## 运行行为

- 首次启动：用内置 pnpm 冷安装 dsh + 注入插件（视网络 1~3 分钟，之后走 pnpm 缓存秒开）；再启动会快速检测更新（稳定版 + 预发布）。
- 更新失败（离线等）：保留现有版本继续启动，不阻塞；registry 会失败自动切换镜像并给出清晰报错。
- 服务异常退出：加载页显示日志，"重试"按钮 → `restart_server`。
- 关窗（含顶栏关闭键、Alt+F4、任务栏关闭）→ 隐藏到托盘：**Windows 上首次隐藏前会弹一次确认**（说明任务不会中断、可从托盘找回；确认一次后不再询问，标记在数据目录的 `background-close-confirmed`）；Linux 退化为最小化（GNOME 可能没有托盘）。顶栏/托盘"退出" → 杀掉整棵服务进程树并退出。
- 点系统通知 → 窗口回到前台并打开对应会话（不重复启动第二个实例）。
- **服务无响应看护（挂起自动恢复）**：manager 每 3s 探一次 dsh web（任意 2xx–4xx 都算"在听"，401/404 不算挂起）；连续 3 次失败先请壳抓内存 dump，**抓完后、杀进程前再探一次**——若这期间已自行恢复就记
  `watchdog: dsh web recovered after 3 miss(es) (probe 200, <耗时>ms, dump ready) — no restart` 并清零，**不杀、不重启**；只有再探仍失败才 `watchdog: dsh web still UNRESPONSIVE after dump … — restarting dsh`（安全边界：真挂起照旧 dump + 重启）。两者的 URL 只记 `scheme://host:port`，启动 token 不落日志。
- **退出/重启可追溯**：每次退出/重启都写来源——`quit requested by <tray|bridge|chrome|launcher> path=…`、`restart requested by …`；桥的**成功**危险请求也记 `bridge danger accepted: action=… source=… path=… origin=…`（不再只有 reject 才留痕），确认窗执行时沿用登记时的来源（`danger-action: … approved (source=… path=…)`）。

### 页面交互：文件拖放与外链（2026-10-23 起）

壳默认会把 WebView 的**页面级**行为拦在自己手里（Tauri/wry 的默认值），而壳没接管的那部分
就是"点了没反应"的静默失效。这两处已按官方客户端对比调研（`docs/2026-10-23-official-client-adoption-review.md`
的 A1/A2）修掉，并各配了一条会变红的门禁：

- **文件拖放**：主窗口 `dragDropEnabled: false` ⇒ 拖放交给 WebView 自己处理（HTML5 拖放），
  dsh 输入框的"文件或图片拖动到此处即可添加"恢复可用；壳**不再**挂 Tauri 的原生拖放处理器
  （我们从没有监听 `onDragDropEvent`，关掉它零损失）。边界：拖入的文件是**上传附件**，
  不是 `@路径` 引用 —— WebView2 没有 Electron 的 `webUtils.getPathForFile`，页面拿不到真实路径。
- **外链 / 新窗口**：`target="_blank"`、中键、`Ctrl(⌘)+点击` 的 http(s) 链接，以及页面里的
  `window.open(http(s))`，都改由**默认浏览器**打开（经环回桥 `POST /shell/open-url`；本地启动页
  走 IPC `open_url`，两条通道共用同一套校验）。边界：① **同窗口内导航不拦**（dsh 自己的
  `linkOpening` 行为不变）；② `about:blank` 原样交回页面（OAuth 类"先开空窗再写 location"的形态）；
  ③ 只允许 `http:`/`https:`，其余 scheme（`file:` / `javascript:` / `data:` / `ms-*` …）拒绝并写日志。
  点击处理走**冒泡阶段**且延后一拍看 `defaultPrevented`：页面自己接管了（例如侧栏浏览器）就不动，
  避免"系统浏览器 + 页面内面板"双开。

### 壳注入的自证与失败可见性（0.16.x 起）

顶栏与菜单是壳**注入**进页面的（`shell-chrome.js`）。注入失败的历史症状是"顶栏与菜单消失"，
而壳侧 `w.eval()` 即使脚本抛异常也只报"派发成功" ⇒ 现场一无所有。现在有三道可见性：

1. **等 DOM 就绪再注入**（2026-10-15 起）：导航早期注入时 `<body>`/`<html>` 还不存在，chrome 里任何早期 DOM 访问都会抛异常。
2. **派发失败入日志**（2026-10-15 起）：`w.eval` 本身报错会写进 `dsh-desktop-session.log`（`chrome 注入失败…`）。
3. **引导自证**（2026-10-16 起）：chrome 把引导过程分五个点上报到同一个日志（走环回桥 `/log`，
   有界 ≤12 条/次注入、永不抛、无桥时静默放弃）：

| 日志行 | 含义 | 判读 |
|---|---|---|
| `client/log chrome inject boot=bXk2p readyState=… body=…` | eval 真的执行到了 | 没有这一行 ⇒ 根本没注入（看 ② 的报错行） |
| `… chrome mounted … bar=0px h37 hidden=false hostH=36 btns=4` | 宿主与顶栏在 DOM 里 | `bar` 为负 / `hidden=true` ⇒ **挂上了但不可见**（全屏浮层自适应收起） |
| `… chrome ready … btns=12` | 整段引导跑完 | 只有 inject/mounted 而无 ready ⇒ 中途死了，看下一条 |
| `… chrome fatal stage=<阶段> <错误名>: <消息> @<文件:行:列>` | 抛在哪一步 | 直接回答"停在哪一步" |
| `… chrome remount …` | SPA 重渲染清掉顶栏后自愈重挂 | 出现它 = 顶栏**曾经消失又被自动恢复** |

- 阶段隔离（`boot(stage, fn)`）包住了四个调用点（mount / auth-probe / auth-probe-now / observe）。
  **注意它的口径是"可见"而不是"不致命"**：未包住的顶层语句抛异常**仍会**吃掉其后全部（这正是
  0.18.0 的形态），区别只在于现在会被兜底上报成 `chrome fatal stage=…`，不再无声无息。新增顶层
  动作时请一并包进 `boot()`，否则至少要知道它是"可见的致命"。
- 回归门禁（两条，口径不同、互补）：
  - `scripts/test-chrome-bootstrap.mjs`（进 `npm test` = **CI 真的会跑**；纯 Node、无浏览器）：守"真实初始化
    路径活着"的结构判据（上报链跑到 ready、宿主与顶栏在、自愈重挂、契约写入、极早时序空安全）；自带 2 个
    内存变异体自证可失败。它**判不了**渲染：顶栏在不在视口顶部、菜单点不点得开。
  - `npm run test:chrome-real`（见上；需本机 dsh + playwright，CI 里无浏览器 ⇒ 显式 SKIP）：守渲染与交互
    口径。它断言的自愈、上报与菜单可打开三条都实测过**会失败**（负向对照：0.18.0 的 chrome ⇒ 7 项红；
    缺 `rootEl` 守卫的变体 ⇒ 早期注入 `TypeError` 2 项红）。

### 误报提示（0.16.0 起）

上游把 **403 + `server_error`**（瞬时故障）归类为 `AUTH` 时，界面只会说「API 密钥无效」。壳改不了 dsh 内部的分类（dsh 永远来自官方 npm 包、本地零改动），但会在**提示层**补一句**不武断**的说明：

> ⓘ 这也可能是上游瞬时故障（403/5xx 被误判为鉴权失败）；若密钥确实正确，可直接重试本轮。 **[重试本轮]** [✕]

- 「重试本轮」= 壳替你点**应用自己的重试按钮**（找不到就提示去哪儿点）；**不自动重试**（那会掩盖真实的鉴权错误、放大请求量）。
- 壳**分不清**「真实密钥错误」与「上游瞬时故障」（两者文案相同），所以措辞**不断言**"不是密钥问题"；只有 dsh 报出「API 密钥无效 / Invalid API key」时才出现，可关闭且关闭后不再弹。

## 壳菜单栏（自绘顶栏）

主窗口无系统标题栏（`decorations: false`），壳在每次页面加载时注入一条 36px 顶栏
（`src-tauri/resources/ui/shell-chrome.js`，编译期内嵌，启动页与 dsh 页面都生效）：

- 左上角**应用 icon**（真实 logo）展开唯一下拉菜单：「品牌头（应用名 + 版本）｜代理设置…
  （独立设置窗口）｜停用全部第三方插件…（**安全网**：dsh 被某个插件搞到起不来时用，
  会先备份 profile `package.json` 再把启用列表回退到 dsh 自带两层）｜检查更新…（壳内弹窗：
  当前/最新版本 + 确定 + 立即更新）｜开发者模式（✓）｜刷新页面｜重启服务｜打开数据目录｜
  关于（壳内弹窗：名称/版本/构建日期/dsh 版本 + 确定）｜退出」；
  有更新时菜单按钮出现橙色角标、条目翻转为「有更新 vX」；
- 右上角窗口三键：最小化 / 最大化(还原) / 关闭（关闭=隐藏到托盘，语义不变）；
- 空白区拖动窗口、双击切换最大化；dsh 页面内路由切换不丢失（MutationObserver 自愈）；
- 下拉与弹窗随系统深浅色，支持全键盘导航（↑↓/Home/End/Enter/Esc）；
- **下拉高度自适应**（2026-10-16 起）：菜单上限 = `min(100vh - 52px, 560px)` —— 上限必须容得下
  当前全部条目（品牌头 + 14 项 + 分隔，实测 466px），否则**每个屏幕尺寸下都会出滚动条**
  （旧值 440px 就是这样；0.18.0 期间菜单打不开，所以这个问题直到 0.18.1 才被用户看到）。
  窗口真的很矮时仍可滚动，但浮层**不会越出视口**；滚动条为 8px 圆角滑块 + 透明轨道。
  两条判据（正常尺寸不出滚动条 / 矮窗口不越界）由 `npm run test:chrome-real` 守护；
- **插件全屏页自动让位**：插件打开全屏浮层（`position: fixed` 覆盖视口，如看板全屏页）
  时，壳自动把菜单栏收进顶缘只留 4px 悬停条——全屏页顶部信息与右上角按钮不再被遮挡；
  悬停窗口顶缘唤出菜单栏（无操作 ~3s 自动收起），浮层关闭后自动恢复。**无需插件感知壳**；
  另向 `:root` 注入 `--dsh-shell-menubar-h`（36px）CSS 变量，供顶部悬浮类 UI 显式适配。
  行为回归由 `scripts/verify-fullscreen-adaptation.mjs` 守护（需 playwright，可选）。

**后续壳独有的菜单就在 `SHELL_MENUS` 数组里定义**（该文件顶部）。动作分两类：
跨壳动作（开窗/服务/设置…）映射到 `ACTIONS` 双通道——本地页走 IPC 命令，远程 dsh 页走
环回桥（`/window/*`、`/shell/*`，远程页没有 `__TAURI__`，tauri#11934）；壳内就地动作
（关于 / 检查更新 / 停用全部第三方插件）不占桥、不进 ACTIONS，直接在壳内完成。契约由
`scripts/test-shell-chrome.mjs` 守护：菜单 id ↔ ACTIONS ↔ lib.rs 桥端点/命令注册三方不漂移。
（Tauri 2 的 `Menu` 在 Windows 不渲染窗口菜单栏，故为自绘注入；托盘菜单保留为窗口
隐藏时的持久入口。代理设置窗口不参与窗口状态记忆——工具窗固定居中弹出。）

## 插件

**插件管理由 dsh 自己提供**：dsh 0.1.6-alpha.2 起自带 `@deepseek-ai/dsh-plugin-manager`，
Web 侧边栏有 **Plugins** 页（安装 / 卸载 / 启用 / 停用 / bundle 内行级开关 / pnpm 构建
脚本审批 / 插件自带配置页），有 HMR 时开关**免重启**生效。壳内**不再有**自建的插件管理
窗口、桥端点或页内面板——避免与 dsh 的插件管理器双写同一份 profile 状态。

- **预装插件（随壳自带，默认关闭）**：`dsh-kanban`（看板）、`dsh-model-reasoning`（按模型推理档位）、`dsh-turn-navigator`（会话轮次导航）、`@karoc/dsh-smoothly-opencode-session`（OpenCode 会话头，无它会 `400 MissingSessionID`）。它们随安装包发布、被复制进运行时并**版本锁定**（离线可用）；在 dsh 的 **Plugins** 页打开开关即可启用。
- **用户自装插件**：在 dsh 的 **Plugins** 页按包名 / Git 地址 / tarball / 本地路径安装与卸载（走壳内置 pnpm，壳已把 pnpm shim 挂到 `dsh web` 子进程的 PATH）。
- **能力边界（相对已移除的壳内控制台）**：① dsh 起不来时无法在图形界面里管理插件（改用壳菜单「停用全部第三方插件…」，它不依赖 dsh）；② 新管理器没有"更新到新版本"操作——需要时用 `dsh plugin --profile web update <包名>`，或卸载后重装；③ 预装插件不再支持"从 npm 升级 / 恢复出厂"，版本随壳发布走。
- **dsh 更新**：壳菜单「检查更新…」弹窗显示当前/可升版本。稳定版（`latest` tag）随时可一键升；若 npm 有更新的**预发布**（`next`/`alpha` tag）也会提示「（预发布）」可升，想升才升，不点就保持原版本。**版本地板**：dsh < `0.2.1-rc.2` 时启动会自动升到地板（0.1.6-alpha.2 起才有自带插件管理；预装插件要能被兼容门禁放行；0.2.0-rc.1 / rc.2 / 0.2.1-alpha.2 均已全面回归，见方案 §15；alpha.3 静态契约核对通过、已随 v0.18.0 发布并核验），失败会如实提示并继续启动；`dsh.json` 的 `devMode` 会冻结这一自动升级。**地板迁移史**：`0.1.7-rc.2`（2026-09-25）→ `0.2.0-rc.1`（2026-09-29）→ `0.2.0-rc.2`（2026-10-05）→ `0.2.1-alpha.2`（2026-10-09，dev 全面验证后随 v0.17.0 发布）→ `0.2.1-rc.2`（2026-10-15 抬升，**已随 v0.19.0 发布并核验**）；patch 目标 id fixture 随之逐版重采，**当前值以 `scripts/fixtures/dsh-web-app-patch-ids.json` 为准**（该文件的 `dshVersion` 与 `ids` 是权威，别抄文档里的数；2026-10-19 实测：`dshVersion=0.2.1-rc.2`、190 个 id）。
- 代理设置入口在**顶栏菜单「代理设置…」**（独立设置窗口，托盘菜单同样可达）。

## 环境变量（可选）

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_NO_UPDATE=1` | 跳过启动时的 dsh 更新检查 |
| `DSH_DESKTOP_NODE_VERSION` | fetch-node 下载的 Node 版本（默认 `v24.18.0`） |
| `DSH_DESKTOP_REGISTRY` | 安装/更新 dsh 用的 npm registry（默认 `https://registry.npmjs.org/`，国内可设 `https://registry.npmmirror.com`） |
| `DSH_SMOKE_REGISTRY` | 冒烟脚本 `smoke-windows.mjs` 用的 registry（默认 npmjs） |

## 安全说明

dsh 页面以纯远程页面加载，只授予 loopback 权限
（capability `remote-notifications`：`notification:allow-notify` +
`core:event` 的 listen/emit/unlisten，无文件/系统/网络 IPC）。
端口只绑定 `127.0.0.1`。

**数据位置**：默认 `DSH_HOME = <runtime>/dsh-home`（桌面端自包含，不碰浏览器版共用的
`~/.dsh`）——这也是必要设计：插件包藏在 `<runtime>/node_modules` 里，profile 的模块解析
沿目录链向上能找到它。想与浏览器版共享数据的用户，可自行在系统环境里放
`DSH_HOME=~/.dsh`（需先把插件装进该 profile，见"注入原理"）。

**外链能力边界（2026-10-23 起）**：页面（含被注入的第三方内容）**只能交出一个 URL 字符串**，
"打开哪个程序、传什么参数"这类 shell 执行能力永不下放。壳在 Rust 侧用 `validate_external_url`
校验后交系统浏览器（Windows `ShellExecuteW`、Linux `xdg-open`）—— 不经过 `cmd`/shell 拼命令，
所以 URL 里不可能夹带命令行。只放行 `http:`/`https:`；拒绝控制字符与换行（防参数走私）、
userinfo（`https://user:pass@host` 的钓鱼形态）、反斜杠与超长串。**拒绝也留痕**：会话日志里
出现 `open-url rejected: <原因>`；正常打开只记 `scheme://host`（URL 的 query 可能带一次性凭据，
日志是长期留存的文件，不该成为凭据副本）。

## 升级与数据安全（0.4.x 起）

**版本演进策略**：正式版安装目录名 / 快捷方式名一经定型不得随版本改动；
升级一律"就地覆盖安装"。标识（identifier）变更属特殊事件，必须配整套旧版接管。

**dsh 起不来时壳不会自毁（0.18.3 起）**：把 webview 从死端口拉回 live 端口的**导航守卫
按退避窗口去重** —— 同一目标在窗口内不重复导航，曲线与导航兜底一致（3/3/6/12/24/30s 封顶）。
此前只看"origin 不同就导航"，而**失败的导航不会改变 webview 的 URL**，于是以连接被拒的速度
死循环：2026-10-16 实测约 **160 次/秒**、单次事故 **25,708 行** `main page load`，CPU 打满、
连危险动作确认窗都渲染不出来（触发条件很常见：dsh 启动失败 / 刚清过缓存 / 升级出错）。
现在日志里有 `nav-guard: navigate -> … (attempt N)`；若看到 `main page load` 每秒成百上千行，
就是这条兜底失控（排查手册见 `.dsh/skills/dsh-desktop-shell-dev/SKILL.md`）。

**dsh 升级是单向的（0.1.7 起，重要）**：
- dsh **0.1.7-alpha.1 起**把会话按 **v4** 格式写入，而旧读取器**拒绝读**新代文件；
  写入方式是"旁挂新代文件"，升级前的 v3 快照仍在原地。
- 因此**不要用"装回旧版本"当回滚手段**：回退到 0.1.6 及更早，只会看到**升级前**的
  快照，升级后产生的会话/改动**读不到**。更不能以"旧版本还能打开"判定回滚成功。
- **正确的回滚 = 还原升级前的数据目录备份**：升级前用壳菜单「检查更新…」弹窗里的
  「打开数据目录」复制整个数据目录（或至少 `runtime/dsh-home/`），回滚时整目录还原。
- 升级入口的提示已就位：检查更新弹窗会显示这条警告；托盘「有更新 vX」的标签与
  通知文案也带「建议先备份数据目录」。
- **低于地板无法停留**：地板已抬到 `0.2.1-rc.2`（v0.17.0 发布时是 `0.2.1-alpha.2`），手动降级到 0.1.x 后**下次启动会被地板自动升回**——0.1.x 只适合临时排障，不能作为长期状态。
- **回退 dsh 会让新版插件可能失效**：回退是降级 dsh；若新版预装插件依赖旧版没有的客户端服务（例如 0.1.7 的 `configForms`），dsh 的插件加载是 fail-closed → **界面会停在「Failed to load plugins」打不开**。自救：启动页点「停用第三方插件」（会先备份 profile 配置），或恢复升级前的数据目录备份。**0.15.0 起壳会自动检测这个失败页并在顶部给出条幅**：条幅点名是哪个插件没起来，并提供一键「停用第三方插件并重启」（先备份 profile `package.json`，再重启 dsh 服务）——不必再手工改 profile。
- **升级后启动失败会自动归因**：manager 在装完成后写 `<runtime>/upgrade.json`，
  启动成功（页面就绪）即被壳删除；若这次启动失败且标记仍在，启动页会显示
  「上次升级 vA → vB 后启动失败」并提供「回退到 vA」（装回旧版本，**不还原数据**
  —— 数据回滚仍走备份还原）。同一对版本反复失败（attempts ≥ 2）时不再提供一键
  切换，只保留归因与证据目录，避免两版本之间来回跳。

**顶栏契约（实验项，默认关）**：壳菜单「顶栏契约（实验）」可切换
`dsh.json` 的 `webview.titlebarContract`。开启后壳**不再自己推挤**顶栏高度，而是给
页面设 `html[data-windows-titlebar]` + `--dsh-windows-titlebar-height: 40px`，由 Web
客户端（0.1.7 起支持该契约）自己预留标题栏并把侧栏开关搬进标题栏 —— 与官方
Electron 壳一致。切换后**必须刷新页面**（注入前缀只在页面加载时写入）。默认关的
原因：这是观感/遮挡问题，只能 Windows 实机判定；若出现「侧栏开关点不到 / 内容被
标题栏压住 / 菜单起点错位」请关掉该项并回报。

**数据迁移**：0.3.x → 0.4.x 品牌统一时，旧数据目录（`%APPDATA%\dev.dsh.desktop`）
在首次启动整体搬入新目录（`%APPDATA%\dsh.smoothly.desktop`），原子 rename + marker，
目标已存在则跳过（新数据优先）。

**数据备份（双保险）**：
- 迁移前：旧 `dsh-home` 的关键数据（sessions / settings.yaml / storages /
  credentials / web profile 配置）自动复制到 `%LOCALAPPDATA%\dsh-backup\migration-<时间戳>\`；
- 旧版清理前：若旧数据目录被旧壳重建（空壳分叉），同样先备份到
  `%LOCALAPPDATA%\dsh-backup\cleanup-<时间戳>\`。
- 数据目录（%APPDATA%）在任何路径下都不会被删除。

**旧版接管（静默卸载 + 明确提示）**：
- 安装新版时（NSIS 钩子）：旧版未运行 → 自动静默卸载（`uninstall.exe /S _?=`，
  不触发"删除应用数据"页，AppData 数据保留）；运行中 → 弹窗提示先退出再装。
- 首次启动/菜单/设置页：检测旧安装残留与快捷方式 → 启动页横幅 + 壳菜单
  「旧版清理…」+ 设置页按钮，一键完成"备份 → 静默卸载 → 删指向旧版的快捷方式"。
- 旧壳被误启动 → 新壳检测到空壳重建迹象（`dev.dsh.desktop` 再现）→ 记录日志并提示。

**数据出问题时的处理**：
1. 先看 `dsh-desktop-session.log` 与 `runtime/manager.log`（壳菜单「打开数据目录」）；
2. 若怀疑"服务/应用被谁重启或退出了"：在 `manager.log` 里搜 `requested by`（退出/重启来源，tray / bridge / chrome / launcher）与 `watchdog:`（挂起看护：`recovered` = 已恢复未重启；`still UNRESPONSIVE` = 确实重启过）——每次退出/重启都有来源，不再只有"重启发生了"这一条；
3. 若会话/配置异常：从 `%LOCALAPPDATA%\dsh-backup\` 按时间戳目录恢复
   （sessions/、settings.yaml、storages/ 拷回 `%APPDATA%\dsh.smoothly.desktop\runtime\dsh-home\` 同路径）；
4. 恢复后重启壳；仍有问题请保留 `dsh-backup` 与两份日志再求助。

## 注入原理（为什么更新 dsh 不会冲掉通知）

1. `dsh web --patch <file>` 把一行 loader 条目插入 web profile：
   `{ id: desktop-notifications, name: '@dsh-desktop/client-notifications' }`。
2. `dsh-client-modules` 节点半端扫描 loader 条目里声明了
   `dsh.client.platform: web` 的包，读取其 `exports["./client"]`，以
   `/plugins/<id>/client.js` 提供到浏览器（`window.__DSH_BOOT__` 名册）。
3. 浏览器内核以 classic script 加载该 bundle，bundle 调用
   `window.__ModuleLoader__.load({ id, factory })` 注册；客户端插件订阅
   `ctx.sessions.list`，检测 `pendingInteraction` 出现、`running` 真→假（会话结束）后，
   经桥向壳发通知请求；点通知时壳把"待打开会话"写进桥，客户端轮询后调用
   `ctx.sessions.open(id)` 打开对应会话。
4. 全程不修改 `@deepseek-ai/dsh` 任何文件，官方包从 npm 重新安装/升级天然无损。

## 与官方的关系

这是官方桌面端出现前的临时壳：dsh 本体永远是官方 npm 包，届时替换壳即可。
数据说明：官方版本地数据在 `~/.dsh`；桌面端默认把 `DSH_HOME` 独立在运行时目录
（避免两个客户端互踩）。想无缝沿用官方数据，设 `DSH_HOME=~/.dsh` 并把通知插件
装进该 profile 即可（见"安全说明"）。

## 开发流程（GitHub Flow）

- **分支/合并**：功能走短分支 + PR，**squash merge** 进 main（一提交一功能）；main 有分支保护（需 PR + CI 快层通过）。
- **提交规范**：Conventional Commits（`feat/fix/docs/ci/refactor/test/chore` + 中文描述），规范直接驱动版本发布。详见 `CONTRIBUTING.md`。
- **CI 分层**：PR 只跑快层（check：`cargo check` + `clippy -D warnings` + `cargo test --lib`；test：`npm test` 全量，~5min）；main push / `v*` tag 跑全量（windows NSIS 打包 + 布局断言 + runtime smoke、linux 打包、linux-smoke canary）。Ubuntu 系统依赖统一走 `scripts/ci-apt.sh`（apt `.deb` 缓存 + 有界重试；缓存 key 含 Ubuntu 版本与脚本哈希），慢源不再把 PR 卡在 `check=pending`。
- **发布**：release-please 自动 bump 三处版本（Cargo.toml / tauri.conf.json / package.json）→ CHANGELOG.md → release PR → admin 合并 → 打 tag + 建 Release → **在 tag 上派发一次 `build.yml` 才有安装包**（见下）。

## 发布（release-please 自动出包 + GitHub Release）

Windows 安装包由 GitHub Actions（`.github/workflows/build.yml`）在 `windows-latest` 上自动构建：
每次 push 到 main 或打 `v*` tag 都会产出 setup.exe 并上传为 artifact，并跑两道门禁：
- **7z 布局断言**：安装包内必须含内置 Node 运行时；
- **Runtime smoke**（`scripts/smoke-windows.mjs`）：在空 runtime 上用 pnpm 冷安装真实 dsh，断言 dsh web 报出 URL——拦住"安装挂起 / launch failed: not installed / 启用插件后黑屏"这类回归。

**发布流程（release-please 接管，无需手动改版本/打 tag）**：

```text
1) 功能合并进 main 后，release-please 依据 Conventional Commits 自动开 release PR
   （版本 bump 三处：Cargo.toml / tauri.conf.json / package.json + CHANGELOG.md）
2) 在发布分支上跑一遍本地门禁（四处版本一致 / CHANGELOG 有该版本段 / npm test / 预装审计），
   再用 `gh pr merge --squash --admin` 合并 —— 该 PR 由 bot 创建，它的 CI run 恒为
   `action_required`（GitHub 不自动跑 bot PR 的 workflow），所以 check/test 永不上报、
   分支保护恒为 BLOCKED，admin 合并是唯一路径（详见 CONTRIBUTING「发布」）。
   > 全自动替代：`node scripts/dsh-release-autopilot.mjs`（默认连版本 PR 一起合并；`--stage1`
   > 停在适配 PR 合并之后）。它用**本机项目 PAT** 做 `--admin`，不把 PAT 放进 CI；版本 PR 无 check 时
   > 用「mergeable + 变更文件白名单」兜底（已知限制见「维护者：dsh 升级自动化」）。
3) 合并后 release-please 打 vX.Y.Z tag 并创建 GitHub Release —— 但 tag 是用 API 创建的，
   不触发 workflow，此时 Release 的 assets 是空的。补一步：
   `gh workflow run build.yml --ref vX.Y.Z`
   → 全量构建 windows/linux 产物、挂到 Release、并用 release-body.mjs 重写说明。
```

**Release 说明（What's Changed）**：发布 job 用 `scripts/release-body.mjs <version>`
自动生成详细 body——版本概要（发版时 npm 上 `@deepseek-ai/dsh` 的 latest/next 版本 +
随包预装插件版本）+ 该版本完整 CHANGELOG 提交清单 + Full Changelog 对比链接
（不再用 `gh release create --generate-notes` 的 PR 标题短列表）。
发布后若需补充人工撰写的「本次亮点」，可直接在 GitHub 页面编辑该 Release。

（注：installer/exe 未做代码签名，SmartScreen 可能提示"未知发布者"。）

## Windows 安装 / 升级须知（「删除应用程序数据」勾选框）

升级安装时，NSIS 向导第一页默认选中「**安装前卸载**」——这一步会运行旧版卸载器，
其确认页上有一个「**删除应用程序数据**」勾选框（**默认未勾选**）。

- 这是 Tauri 2 默认 NSIS 模板的固定行为（每个 Tauri 2 应用都有），我们没有定制安装器；
- **普通升级**：不改勾选框、直接点下一步，所有本地数据（dsh 本体 + `DSH_HOME` 数据 + 设置）都会保留；
- **勾选「删除应用程序数据」= 清空全部本地数据**，下次启动会重新冷安装 dsh（0.3.3 起用内置 pnpm，不卡死；
  失败会自动切换镜像并给出清晰报错）——但你的会话/配置数据不会恢复；
- 若升级后报 `launch failed: @deepseek-ai/dsh not installed`（半截安装），0.3.2 起会自动检测并修复，
  无需手动删数据。

## License

MIT

## 维护者：dsh 升级自动化

- **探针**：`node scripts/dsh-compat-probe.mjs --runtime <已装新版的 runtime>`（等价 `npm run dsh:probe -- --runtime …`）
  —— 核对「已装版本 ↔ 壳地板 ↔ patch 夹具」三方一致、6 个客户端 seam、CLI 开关、native 白名单、
  四个预装插件的 peer 范围。GREEN 才算过；RED 时退出码 1。**已在本机用真实数据校准**：
  已知良好 runtime（rc.2）⇒ GREEN；仍是旧版的正式版 runtime ⇒ RED。
- **一条命令适配**：`node scripts/dsh-adapt.mjs --version <版本> [--runtime <已装新版的 runtime 目录>]`
  `[--dry-run] [--allow-yellow] [--canary] [--canary-timeout 180] [--dev-log <session.log>] [--manager-log <runtime/manager.log>] [--strict-chain]`
  （等价 `npm run dsh:adapt -- --version <版本> …`）
  —— 依次做：地板两份 + 适配记录（写进注释块内部，`node --check` 校验，不过则回滚）→ README 地板数值 →
  patch 夹具重采 → 预装 peer 兼容 → 探针非 RED（YELLOW 需显式 `--allow-yellow`，探针**没产出报告**也算失败）→
  全量门禁（**跑链前先 sync 派生的 `Cargo.lock`**，与 CI 的 `test` 作业一致）。**任一步失败立即停**；
  `--runtime` 缺省时会尝试 dev 实例的固定 runtime 路径，**路径不存在且未显式给出 ⇒ 直接 exit 2**（不发车）。
  第 7 步（全量门禁）按 `package.json` 的 `test` 链**逐条直接跑 `node`**（不经 npm，与 `npm test` 是同一条链），
  当前这条链 29 条里 28 条是 `node …` ⇒ 本机 28/28 真跑；剩下 1 条是条件式
  （`[ -f scripts/test-version-compare-parity.mjs ] && …`，parity 套件尚未提供时只跳过自己）——
  它不匹配 `^node`，因此本机会把它**跳过并逐条列出**（CI 上由 `npm test` 真跑）。
  将来链上若出现别的非 node 条目（如 cargo），处理方式相同：默认容忍这种覆盖缺口，
  `--strict-chain` 则把"跳过"也算失败（跳过 ≠ 通过）。
  第 7 步在跑链**之前**先执行 `node scripts/sync-cargo-lock-version.mjs`（与 CI `test` 作业在 `npm test`
  前的那一步一致）：把 `src-tauri/Cargo.lock` 里的派生版本对齐到 `Cargo.toml`。**它只修"派生物落后/超前于
  真源"这一种漂移**：`package.json` / `tauri.conf.json` / `Cargo.toml` 三处若彼此不一致，sync 修不了，
  `test-manifest-consistency` 照常判红（2026-10-23 负向对照实测：把 `Cargo.toml` 也改成 9.9.9 ⇒ 门禁仍红）——
  所以它不是用来掩盖真不一致的。为什么需要这一步：干净 main 上这四处曾长期是 0.20.0 / 0.20.0 / 0.20.0 /
  **0.19.0**，CI 靠 `npm test` 前的 sync 掩盖了它，本脚本不跑 sync 就在第 7 步**必红**、每次真实适配都被
  误判成"适配失败"。sync 改动了 `Cargo.lock` 时明细会打印 `FIXED …` 并提示把该文件一起提交；sync 自身
  失败（exit≠0）同样立即停在第 7 步。⚠️ 与 CI 相同的副作用：sync 真的改了 `Cargo.lock` 时，跑链期间工作树是
  脏的 ⇒ `test-controls` 的三个「门禁可信度对照」会按既有规则 SKIP（它们只在干净树上跑；CI 在 sync 步骤之后
  同理，属已知覆盖缺口，**跳过 ≠ 通过**）。
  `--dry-run` **只跳过写文件（地板/README/夹具那几步），只读门禁照样真跑**——插件门禁、探针、全量门禁
  都会实际执行（第 7 步会为门禁**临时** sync `Cargo.lock`，跑完立即还原 ⇒ 净写入仍为零），探针判 RED 时
  仍然 exit 1；所以它不是"只打印计划"，而是"不落盘地走一遍真实门禁"
  （2026-10-19 实测 `--version 0.2.1-rc.2 --runtime <dev runtime> --dry-run` ⇒ exit 0、当时 23 套通过，
  且运行前后 `git status --porcelain` 完全一致；此后链上新增了 `test-automation-gates` 与 parity 两条，
  数字相应变成 25）。⚠️ 也正因第 4 步（夹具重采）被跳过，**目标版本 ≠ 当前地板/夹具时它
  必然停在第 6 步探针**（`version-vs-*` RED）⇒ dry-run 只对"目标 == 现状"的幂等路径能全绿，
  **不能**用它演练一次版本变更。
  `--canary`（第 8 步）**读两个日志、断言三个标记**：session 日志（默认 `<dev 数据目录>/dsh-desktop-session.log`，
  可 `--dev-log` 覆盖）出 `client/log chrome ready` 与 `client-ready (http)`；`<runtime>/manager.log`
  （可 `--manager-log` 覆盖，是随包 manager 的 `log()` 落盘处）出 `preinstalled bundles:`。**只认检查开始之后
  新写入的行** ⇒ 前提是 dev 壳必须在检查期间**新启动**（早就开着且空闲的壳不产生新标记行）；缺哪个标记会
  指名它来自哪个文件。只读，不启动也不杀进程。装版本、发版、装机刻意不做（汇总里会打印剩余人工步骤）。
- **三种演练场景（install / bump / upgrade）**：`node scripts/dsh-rehearse.mjs --scenario install|bump|upgrade`
  —— 三个场景都**复用产品自身路径**，脚本只读真实仓库与真实 runtime（写操作全在临时目录）：
  - `install`（默认）：空临时 runtime → manager 启动期自动安装 → 断言落地版本 → 探针；
  - `bump`：`/tmp` 克隆里降地板 → 复用 `install` 装目标版本 → 克隆里跑 `dsh-adapt` → 五项断言；
  - `upgrade`（2026-10-24 加，补上"已有 dsh 的**升级覆盖**分支"这一覆盖缺口）：建 Windows `Local\Temp`
    下的临时 runtime（必须与 `.pnpm-store` **同设备**，跨设备 exit 3）→ 用
    `pnpm add @deepseek-ai/dsh@<old> --node-linker=hoisted` **绕过 manager 装旧版**（manager 的启动期目标
    恒为 max(地板, latest)，装不了旧版；hoisted 是生产布局，用默认 isolated 会让 manager 走
    "删光重建"分支 ⇒ 升级覆盖断言就成了假演练）→ 复用 `install` 让 manager 走**兼容闸门**
    （已装 < 地板 ⇒ 升到地板）→ 四条断言：① 落地 == 目标；② **无残留嵌套副本**
    （`find <runtime>/node_modules -path …@deepseek-ai/dsh/package.json` 计数 == 1，**并对真实 dev runtime
    跑同一命令作对照**，基线是实测值不是硬编码的 1）；③ `dsh-compat-probe --runtime <tmp>` ⇒ GREEN；
    ④ 真实仓库非记录层 `git status` 前后一致 + 真实 runtime 关键文件 sha256/mtime/size 未变。
    两条负向自证（**必须能红**）：`--upgrade-from` 指 registry 里不存在的版本 ⇒ 装旧版一步明确失败；
    `--fault nested-copy` 在升级后的树里塞一份同版本嵌套副本 ⇒ 断言 ② 必须变红。
    退出码：0 全绿 / 1 任一步或断言不达标 / 2 用法错误（旧版不低于地板 = 假演练，直接拒绝）/
    3 前置不满足（热 runtime 缺件、没有同设备临时目录、读不到真实仓库 status）。
- **全自动流水线（autopilot，2026-10-20）**：`node scripts/dsh-release-autopilot.mjs`（等价
  `npm run dsh:autopilot`）—— 把「探测 → 适配 → 开 PR → 合并 → 发版 → 核验资产」收成一条可装进
  systemd user timer 的命令（unit 模板在脚本头注释，本仓库不改你机器上的 systemd）：
  ① `dsh-watch --json --dry-run`（不碰 issue）→ 无新版直接打印「无需适配」exit 0；
  ② `git clone --local --shared` 到 /tmp → `dsh-rehearse --scenario install` 准备临时 runtime →
     克隆里跑 `dsh-adapt`（只写克隆，不碰工作区/真实 runtime）；
  ③ 只提交 `git status --porcelain` 里的**已跟踪、非看板**文件 → push `auto/dsh-<target>` →
     `gh pr create`（正文含 target / 探针 verdict / 门禁套数 / 耗时 / 自动生成声明）；
  ④ `gh pr view --json statusCheckRollup` 等 CI（默认 40 分钟；任一明确失败 ⇒ 不合并、回帖、exit 1。
     本机 gh 2.45 的 `gh pr checks` 不支持 `--json`，故用方案允许的等价形式；SKIPPED/NEUTRAL 不算失败）；
  ⑤ `mergeable=MERGEABLE` 才 `gh pr merge --squash --admin`（**必须**用 `./scripts/gh` 的项目 PAT；
     冲突/UNKNOWN 超时都停下，绝不 force）；
  ⑥ 等标题 `chore(main): release X.Y.Z` 的 release-please 版本 PR（≤15 分钟）→ MERGEABLE 后 `--admin` 合并。
     **该 PR 是 bot 创建的，GitHub 结构上不给它跑 workflow ⇒ checks 恒空**；此时用「MERGEABLE + head 必须是
     release-please 分支 + 变更文件全在写域白名单（三处版本文件 / Cargo.lock / CHANGELOG /
     .release-please-manifest.json）」替代，日志会明写「按 bot PR 无 check 例外」，不假装 checks 绿；
  ⑦ 从版本 PR 标题解析 tag → 等 Release 出现 → **该 tag 尚无构建运行才** `gh workflow run build.yml --ref <tag>`
     （已有运行不重复派发：build 的 `concurrency` 是 cancel-in-progress）→ 轮询 Release 资产 ≥3（≤30 分钟）；
  ⑧ 在触发 issue 回帖结构化总结（target / 适配耗时 / 探针 / 门禁 / PR 号 / 版本号 / 资产 / 总耗时 / 是否已发布）。
  **安全阀**：`--dry-run` 只探测 + 打印计划（不 clone / 不 push / 不调 gh 写接口）；`--stage1` 在 ⑤ 之后停下
  （适配 PR 已合并、版本 PR 留给人工；因为地板此时已等于 target，dsh-watch 不会再报这个 target，
  **不要**指望重跑自动续走 ⑥–⑧）；`--require-canary` 在 ⑤ 之前额外要求 `dsh-adapt --canary` 通过
  （默认关：canary 只认检查开始后新写入的两个 dev 日志标记 ⇒ 需要 dev 壳在窗口期内**新启动**；
  缺日志 ⇒ 停在 ⑤ 之前、回帖「等真机验收」、exit 3）。
  **幂等**：分支 `auto/dsh-<target>` + `gh pr list --state all` 判断——OPEN 复用（**不重复开 PR**）、
  MERGED 从 ⑥ 续走、CLOSED 才重新适配并更新分支；更新既有分支用
  `--force-with-lease=refs/heads/auto/dsh-<target>:<远端 sha>`（只限这条自动化分支，**绝不对 main 做任何写/force**）；
  最新 Release 正文记录的 dsh `latest`/`next` == target 且资产 ≥3 ⇒ 直接打印「已发布」exit 0。
  **回滚**：合并前的全部副作用都在 `auto/` 分支与 open PR（不碰 main），删分支/关 PR 即回滚；合并后按常规
  revert PR 回滚（脚本不自动回滚、不删已合并提交）。
  **失败时人看到什么**：失败阶段 + 原因 + 已完成步骤 + PR 是否保持打开 + 重跑提示会回帖到 issue；
  ④/⑥ 的失败项会逐条列出 check 名与状态；⑦ 超时会写「资产仍 <3，去 Actions 看构建」。退出码
  0 完成 / 1 失败 / 2 用法 / 3 前置不满足（探测失败、runtime 装不上、canary 缺日志等）。
  **已知限制**：canary 默认关（定时器给不了「窗口期内新启动 dev 壳」这个前提）；进程在 ⑤ 之后被中断
  （或用了 `--stage1`）不会自动续走——地板已等于 target，watch 不再报它，版本 PR 留在 open，需人工合并/派发；
  版本 PR 自动合并 =
  **零人工审阅**（只靠变更范围白名单 + mergeable 兜底）；资产 <3（如 windows job flake）就停在 ⑦、不自动重试；
  `next`/alpha 通道按决策 ③C **不自动适配**（安装路径只装 max(地板, latest)）；合并/建 issue 依赖本机项目
  PAT（`GH_BIN` 缺省自动指向 `scripts/gh`；CI 的 `GITHUB_TOKEN` 不能 `--admin`）。**凭据纪律：脚本若走
  `GH_BIN`，必须默认指向 `scripts/gh`，禁止默认裸 `gh`（裸 gh 落到全局 `hosts.yml` 里的另一个 PAT，
  权限不同；CI 里显式 `GH_BIN=gh` 是唯一例外），门禁 `scripts/test-gh-bin-discipline.mjs` 守这条。
  systemd 运行环境需能读 SSH key（`git push` 走 SSH）与网络。演练/测试注入点：`GH_BIN` / `GIT_BIN` / `NODE_BIN` 与
  `DSH_AUTOPILOT_WATCH_JSON`（见脚本头注释）。
- **门禁自证**（`node scripts/test-automation-gates.mjs`，`npm test` 链上的一员，约 60s）：它覆盖的是
  **"自动化链路判据的可失败性"** —— 把 2026-10-19「假门禁猎手」审计的 49 条注入断言落成可重复运行的一道门禁：
  用合成 runtime + npm/gh/curl **桩**（写在临时目录、经 PATH/GH_BIN 注入，零外部依赖：不要 jq、不要本机 npm），
  断言上探针 / `--check` / `dsh-watch` / `dsh:adapt` / preinstalled-sync 漂移检测这些判据**该失败时会失败**
  （该 RED 就 RED + exit 1、该 FATAL 就 exit 2、该停在第 N 步就停在第 N 步、"没有数据"就判红）。
  **为什么存在**：恒真的门禁比没有门禁更糟 —— 那份 harness 原本只在 `/tmp`，CI 从不跑它，判据回归没人拦。
  单跑：`node scripts/test-automation-gates.mjs`（`--only probe|sla|watch|doctor|adapt|drift|mutation` 只跑一组、
  `--fast` 跳过等待型用例、`--keep` 保留临时目录排障）。它自带 **6 条变异自证**（其中 doctor 组证明「凭据 canary 写失败 ⇒ 退出码非零」真的在阻断；在**工作树临时副本**上
  **临时副本**上把判据改坏 ⇒ 本套件必须变红；绝不改仓库文件），已知仍不完美的判据标 `KNOWN_GAP`
  —— 只逐条打印、**不判红**（既不用"跳过"掩盖假绿，也不会因为别的 agent 正在修它而把链判红；
  行为一旦变化会打 `GAP?` 提醒把它升级成正确性断言）。
- **两个定时工作流**（零 secret，只用 `GITHUB_TOKEN`）：`dsh-watch.yml` 每 15 分钟探测 npm dist-tags
  （它是 `dsh-watch` 的**第二个写者**，与下方本机 timer 并行 —— 见「幂等 / 单写者 / 刹车 / 对账」），
  比地板新就开/更新 `dsh-upgrade` issue（含门槛倒计时与适配清单）——门槛文案按**实际门槛**打印
  `${threshold}h 截止`：`latest` 通道默认 6h（硬指标）、预发布通道默认 24h（best-effort），
  可用 `--sla-hours` / `--best-effort-hours` 覆盖（2026-10-19 前这里写死 "6h"，预发布单上照印 6h）；
  `tag-dispatch.yml` 每 10 分钟扫最近 20 个 Release，对「有 tag 但资产 <3 且尚无构建运行」的版本补派发
  `workflow_dispatch`（release-please 用 API 打 tag ⇒ 不触发 push 事件，故必须补派发）。"尚无构建运行"的判据是
  **服务端过滤**：`runs?branch=<tag>&per_page=1` 的 `total_count`（不是"拉最近 100 条运行再在客户端筛"——
  本仓 build.yml 的运行数已达 800 次（审计当时 799），老 tag 的运行早落在 100 条之外：实测
  `total_count(v0.11.0)=1`，而旧判据筛出 `0` ⇒ 资产长期 <3 时每 10 分钟重复派发）。

- **告警如何送达**（2026-10-20 起，`dsh-watch` / `dsh-sla-report` 共用）：这两个脚本的 issue 都是 bot
  （`GITHUB_TOKEN`）创建的，而 GitHub 的推送默认只覆盖「参与中 / 被 @ 提及 / 被赋值」的线程 ——
  **只开 issue 不赋值、不提及，很可能根本不会叫醒人**。现在三件事一起做：
  ① `gh issue create --assignee <owner>`（赋值**一定**会通知被赋值者；owner 解析顺序
  `--assignee` → `--repo` → `GH_REPO` → `GITHUB_REPOSITORY` → `git remote origin`，**取不到直接 exit 2**，
  不静默跳过）；② 正文以 `@<owner>` 开头（第二重保险；前面不放中文标点，mention 需要行首/空白才成立）；
  ③ 高优先级 label：`dsh-upgrade` / `sla-breach`
  之外再加 `priority:high`（先 `gh label list` 查过，仓库原有 label 里没有任何优先级标记，所以只新增这一个；
  `sla-report` 是周报，不挂 high）。**label 本身不产生通知**，只用于 triage。
  更新路径也保证可达：先 `gh issue edit`（静默刷新正文/标题/补齐 label 与 assignee；**写后读回复核**，
  见下一条），只有**目标版本变化**或**状态跨级**（跟踪中 → SLA 未达标）时才追加一条短 `comment`
  （comment 会通知 assignee / 订阅者）—— 同一版本 cron 重复运行**不会重复评论**；SLA 周报靠正文里的 `dsh-sla-report-state` digest 判断
  「量到的版本集合 + 达标状态」是否真的变了，没变时连 edit 都跳过。⚠️ 本机无法验证"推送是否真的到达手机"
  （取决于该账号的 GitHub 通知设置）；**可验证**的是命令确实带上了 assignee / 提及 / label（门禁用 gh 桩断言）。

- **SLA 报表**：`node scripts/dsh-sla-report.mjs [--json <out>] [--issue] [--check <json>] [--recent 3] [--since 2026-10-19] [--registry <url>] [--now <iso>]`
  —— 按 **dsh 版本**聚合，把「随包地板版本的上游发布 → 我们发出首个携带该地板的稳定版」拆成**两段可指导行动的数字**：
  **检测** = 上游发布 → **首次为该版本开 issue**（数据源 `gh issue list --state all --limit 1000`，**不按 label**：
  用与 `dsh-watch` **共用的确定性键** `scripts/lib/issue-key.mjs` 筛 —— 标题前缀 `[dsh-watch]` / `[SLA 未达标]` +
  版本号**词边界** + `dsh <版本>` 锚点 —— 再与 packument 的 `time[该版本]` 相减）；**适配** = 地板提交 →
  我方发布（**沿用旧口径**，就是 JSON 里原有的 `release` 字段 —— 旧报表把这一列印成"发布"）。表里另有
  **抬地板**（上游发布 → 地板提交，= 原有 `adapt` 字段，旧报表印成"适配"）与 **合计**（上游发布 → 我方发布），
  末行给**两段中位/最大**（中位口径与旧实现一致：偶数个取上半；unknown 不计入、只报条数）。
  **为什么不能按 label 取数（2026-10-24 修）**：PAT 缺 Issues:write 时 `issue create` 能过、**label 从未落地**
  （事故 #201–#216 的 16 条 issue 都没有 label）⇒ 旧实现查到 0 条、把每个版本的检测延迟都静默判成「未检测到」。
  现在 `--state all` 且**不看 label / assignee / state**（关掉的单同样是"当时被发现过"的历史证据）；筛选只认标题前缀，
  所以报表自己的 `sla-report` issue 与人类手写的 issue 不会被误当成"首次发现"。
  ⚠️ **找不到对应 issue ⇒ 检测记为 unknown 并在表格里显式打印「未检测到」，绝不当 0**（"没有判断 = 没有验证"）。
  同版本多条 issue ⇒ **取最早创建**那条（"这一版第一次被发现"；同刻创建按编号小的优先）；表格「首次 issue」列直接印
  `#编号 + 时间`，`注意` 段再逐版本说明取了哪条。命中 `--limit 1000` 上限会**拒绝出数**（被截掉的可能包含最早的
  issue ⇒ 检测延迟只会偏大）。
  **待适配版本的检测延迟**：上游已发布、已有跟踪单，但我方还没发版（配不到"我方发布"、进不了两段表）的版本单列一段 ——
  检测延迟在**发版前**就能算出来。2026-10-24 真实数据：`0.2.1-rc.3`（上游 `07:54Z` → 最早跟踪单 #201 `08:00Z`）
  ⇒ 检测 **0.10h**；17 条同版本 issue 里只有 #217 带 label（旧实现一条都看不到）。
  **起点口径说清楚**：T0 = npm registry 上 **`time[该版本随包地板]`**，即"我们把地板抬到哪个版本，就从哪个版本的上游
  发布时间起算"——**该地板很可能是预发布**（如 `0.2.1-rc.2`），因为地板长期高于 npm `latest`；终点 = 该地板的
  **首个稳定 Release** 的 `publishedAt`。
  报表开头的**当前状态**是实时信号：最新 watch issue（标题 / 开单时间 / 距今多久 / 是否未关闭）、上游各通道最新版本
  及其发布时间、壳地板（当前 HEAD 的 `scripts/server-manager.mjs`）、**有没有未关闭的跟踪 issue**，以及"上游最新是否
  已晚于壳地板（按**发布时间**先后比较，不再养第二套 semver）且是否已被发现"。紧跟两段表的
  「待适配版本的检测延迟」段列出"上游已发布 + 已有跟踪单、但我方还没发版"的版本（原因见上）。
  `--issue` 把报表 upsert 到 `sla-report` issue（创建时 `--assignee` + 正文 @ 提及属主；weekly 更新走
  `edit`，仅当目标版本/达标状态变化才追加一条短 comment —— 见上一条「告警如何送达」）；
  `--registry` 只为演练/离线复核指向 stub registry；`--now <iso>` 只为演练钉住"现在"（只影响"距今多久"，坏输入 exit 2）。
  **门禁口径**（CI 用 `--check <json>`；`--fail-on-breach` 是同口径的脚本内变体）：① **无数据即红**——报表缺
  `perVersion` 或为空数组 ⇒ exit 1（"量不出来"不等于"达标"；旧实现 0/0 判绿是假绿）；② "历史欠账不会让门禁
  恒红"是这么实现的：只有 `--since`（默认 `2026-10-19`，方案落地日）之后**上游首发**的版本参与退出码，
  欠账仍在报表里逐行显示并单列一行说明（真实数据实测：7 条历史欠账、`--check` exit 0；since 之后新首发的
  版本超时仍会红）；③ `--recent 3` 只看该范围内的最近 3 个。
  **检测延迟不进门禁**：它量的是"上游发出来之后我们多久才发现"，而发现取决于定时探测所在的机器 / runner 在不在跑、
  issue 有没有被限流 —— 那是**平台属性**，不是适配能力；写进 `--check` / `--fail-on-breach` 只会让门禁随平台抖动而红绿。
  门禁判定**与旧实现逐位相同**：仍只看 `total`（上游发布 → 我方发布 ≤ 6h）+ since/recent 两条窗口规则。
  报表里三个时间戳列**统一是 UTC ISO 截到分钟**（`toISOString().slice(0,16)+'Z'`，列头写明 UTC）——2026-10-19 已修掉
  "npm 给 `Z`、`git log --format=%cI` 给本地偏移、截断后两者都看不出时区后缀"的混排；要看绝对时间以 `--json` 原值为准。
- **探测逻辑脚本**：`node scripts/dsh-watch.mjs [--dry-run] [--json <out>] [--force-target <v>]
  [--force-published <iso>] [--force-pre] [--now <iso>] [--sla-hours <n>] [--best-effort-hours <n>]
  [--registry <url>] [--floor <ver>] [--state-dir <dir>] [--lock-file <path>] [--pause-file <path>]`
  （`dsh-watch.yml` 只是薄壳）。**退出码**：0 = 正常（含"今天没有新版本"与"对账失败但已输出待人工清单"）；
  1 = 真故障（取不到 npm packument / 读不到 open issue 列表 / 跟踪单没开成或没更新成）；2 = 用法或属主解析失败。
  —— 提取成脚本是为了让「建 issue 那条路径」可本地演练。`--registry` / `--floor` / `--now` / `--force-*`
  都是**演练注入点**（本机 npm CLI 不可用、直连 npmjs 会超时 ⇒ 演练指向本地 stub registry 的 packument）。
  **演练路径（零副作用）**：`--force-target X --force-published <ISO> --dry-run` 会走完"门槛已过而地板没动"
  的违约分支，并打印会开的 label / 标题 / 正文长度，但**不执行任何写操作**（实测：8h 前发布 ⇒
  `breached=true`、label `sla-breach`、exit 0；换成 `--force-pre` 则按 24h best-effort 判 ⇒ `breached=false`）。
- **SLA 未达标自动开 blocker issue**：`dsh-watch.mjs` 在「门槛已过而地板没动」时自动开/更新 `sla-breach`
  issue（门槛随通道：`latest` 6h / 预发布 24h，可用 `--sla-hours` / `--best-effort-hours` 覆盖；issue 标题与
  正文都印**实际门槛**，退出码不变）。**取不到该版本的上游发布时间时 fail-closed 记为未达标**（JSON 里的
  `pubUnknown`；"量不出来"不等于"达标"）。幂等与去重的完整口径见下一条（**确定性键 + 单写者 + 对账**）：
  只按标题里版本号的**词边界**匹配（`contains("0.2.1")` 会把评论挂到 `0.2.1-rc.2` 的单子上），
  **不再按 label 过滤**。

- **幂等 / 单写者 / 刹车 / 对账（2026-10-24 起；事故 #201–#217 的止血）**：**双写者是设计事实** ——
  本机 systemd user timer（`~/.config/systemd/user/dsh-watch.timer`，10 分钟）与 Actions
  `dsh-watch.yml`（cron `*/15`）各跑一份**同一个脚本**。所以**所有写操作必须是收敛式（幂等）**：
  只依赖「对象身份 + 正文状态」，**不能假设自己独占**。四件事：
  ① **确定性去重键（与写者无关）**：查全部 `state=open` 的 issue（`--limit 1000`，到上限会告警"可能被截断"），
  用**词边界**匹配标题里的版本号（`0.2.1-rc.3` 不命中 `0.2.1-rc.30`、也不命中 `0.2.1-rc.2`；且只认本脚本
  自己的两种标题前缀 `[dsh-watch]` / `[SLA 未达标]`，不会去改写人类开的 issue），命中即 `edit` 复用、
  未命中才 `create`。**不依赖 label** —— 事故里 16 条 issue（本机 PAT 创建）的 label/assignee 从未落地
  （create 成功、`addLabelsToLabelable` 403），旧实现按 `--label` 过滤查到 0 条 ⇒ 每 10 分钟再建一条。
  正文里的 `<!-- dsh-watch-state: target=… breached=… -->` 只用于判断**要不要评论**（目标版本变化 /
  状态跨级才评论），**不是**去重键（body 的 edit 同样可能失败）。写后**读回复核** label/assignee，
  缺了先尝试一次幂等修复（`edit --add-label/--add-assignee`），仍失败就打印可复制的人工命令（不会因此再建一条）。
  ② **本机单写者（flock）**：非 `--dry-run` 时整个进程包在 `flock -n ~/.dsh/locks/dsh-watch.lock` 里
  （util-linux flock；进程退出即释放，不会留"崩溃后永久死锁"）。拿不到锁 ⇒ 打印 `skipped by lock` 后 exit 0
  （另一轮正在写，本轮无事可做）。`flock` 缺失（如 Windows 侧直接跑）⇒ 明确告警后继续：写仍是收敛式的，
  只是失去本机互斥。**它只保本机**：跨写者的 TOCTOU（两边同时查到 0 条再各建一条）无法在客户端根除 ——
  那正是下一层对账存在的理由。
  ③ **刹车 `~/.dsh/PAUSE`**：文件存在 ⇒ **跳过一切写操作**（只读探测、去重判定、重复单报告照常），
  日志写 `paused by <路径>`。排障 / 上游事故期间用它停写，不需要改 systemd。`--state-dir <dir>`
  （或 `DSH_STATE_DIR`）可把锁与 PAUSE 挪到别处（演练/测试用）。
  ④ **收敛对账（自愈）**：每轮末尾（**含"今天没有新版本"的轮次**）按版本分组扫一遍 open issue；同一版本
  >1 条就保留一条、其余 `close` 后评论 `重复于 #N（同版本跟踪单），由 autopilot 对账关闭`。保留规则**明确**：
  带 `dsh-upgrade`/`sla-breach` label 的优先 → 其次带 assignee → 同优先级取最早创建（`createdAt`，等价最小编号）。
  事故里 #217（唯一带 label/assignee）因此被保留、#201–#216 被关掉。**失败不重试、不报假成功**：任何
  close/comment 被 403 ⇒ 本轮停写，输出"待人工关闭"清单（issue 号 + 可复制的 `./scripts/gh issue close …` 命令）；
  对账后还会**再读一次列表复核**，读不到就明说"无法复核"，绝不打印"对账完成"。
  **退出码口径**：跟踪单没开成/没更新成 ⇒ 1（CI 真红）；对账失败只出清单 ⇒ 0 —— 否则本机 PAT 缺
  Issues:write 时每次运行都非零退出，systemd 的 `Restart=on-failure` 会 60s 一次热循环（那是 A6 要改 unit
  的 `RestartSec`/`RestartSteps`，不该在这里放大噪音）。
  **验证**：`scripts/test-automation-gates.mjs` 的 watch 组用**有状态 gh 桩**钉住这四条 ——
  `run(); run()` ⇒ open 数量不增加；空状态冷启动只建 1 条；事故同构（label 从未落地 + edit 403）下仍不再建；
  真起两个进程 ⇒ 只有一个执行、另一个 `skipped by lock` 且零 gh 调用；PAUSE ⇒ 零写；对账 403 ⇒ 只剩待人工清单。
- **凭据能力探测（canary 写，A3，2026-10-24）**：`node scripts/dsh-doctor.mjs [--dry-run] [--json <out>]
  [--repo <owner/name>] [--now <iso>] [--heartbeat-file <path>] [--timeout <sec>]`（等价 `npm run dsh:doctor`；
  自测 `npm run test:doctor`）—— **回答"这张 token 到底能不能写 issue"**。必须真写一次的原因：`gh api
  repos/<repo>` 的 `permissions.admin=true` 只是**仓库角色**，fine-grained PAT 的资源级权限不在里面
  （2026-10-24 事故：admin=true 仍 `updateIssue` 403）；classic token 能从 `X-OAuth-Scopes` 头读 scope，
  fine-grained PAT 连这个头都没有，而 GitHub **没有**"模拟写"接口（AWS `SimulatePrincipalPolicy` /
  k8s `SelfSubjectAccessReview` 的等价物不存在）⇒ 唯一可靠的判据是 canary 写。脚本对一条**专用 canary
  issue**（标题含 `[dsh-doctor] canary`；首次自动创建、之后只复用）做**可逆写**：改正文（写入探针行 +
  `last-ok=<ISO>` → 读回复核 → 还原，**净变化只有 last-ok**）→ 评论（有则 PATCH 同一条、无则只建一条）→
  加 label（加 → 读回 → 移除）→ 关闭（关 → 读回 CLOSED → 重开 → 读回 OPEN），输出 **6 行矩阵**：读 issue
  列表 / 建 canary / 改正文 / 评论 / 加 label / 关闭，每行 ✓/✗ + 实际错误（**错误信息里的 token 一律
  打码**）。**fail-loud**：任一必需能力不可用 ⇒ exit 1 + 一句话结论 + 修复建议（"给 PAT 勾 Issues: Read and
  write"）。**遇 403 立即停止后续写探测**（资源级权限是边界，继续试只会制造重复 403 与次级限流）；
  `--dry-run` 只读、**不写**心跳文件；`--json <out>` 出机器可读矩阵（`--json -` 打 stdout）。
  ⚠️ 当前实测（2026-10-24）：**建 issue 可用、改正文 403**（`Resource not accessible by personal access
  token (updateIssue)`）⇒ 1 ✓ / 1 ✗ / 3 ⊘、exit 1 —— 这就是"能读不能写"的现场证据；修权限前 `dsh-watch`
  与 autopilot 的 issue 维护仍会失败。
- **反向心跳（A5，"没消息也报警"，2026-10-24）**：本机侧 `dsh-doctor` 每次**成功**运行后写
  `~/.dsh/heartbeat.json`（`{lastOkAt, version, didWrite}`；失败运行**不写** —— 不替坏链路作伪证），并把
  `last-ok=<ISO>` 写进 canary 正文；云端侧 `.github/workflows/dsh-heartbeat-check.yml`（**每日一次**
  03:00 UTC + `workflow_dispatch`）跑 `node scripts/dsh-doctor.mjs --heartbeat-check --grace-hours 26`
  —— 云端**看不到**本机文件，唯一可见的信号就是 canary 正文那个字段。**双向判据**（缺一不可）：心跳新鲜
  （age ≤ 26h）⇒ **静默** exit 0；心跳陈旧 ⇒ 在 canary 评论 `@owner` + 加 `priority:high` + **exit 3**；
  canary 不存在 ⇒ **先创建再判断**（正文带 `bootstrap-at`，26h 宽限期）⇒ 本次静默、**不误报**。阈值 26h =
  24h 周期 + 2h 宽限（Actions `schedule` 本身可能延迟数小时，见方案 §3）；改 cron 周期要同时改
  `--grace-hours`。**exit 3 是"已报警"不是"job 坏了"**（exit 1 才是检查器自己坏了：读不到 issue / 报警
  手段全部失败）；同一段停更期只发一条报警评论（`priority:high` 每次确保；`--repeat-hours` 默认 168h 兜
  "从未成功过"），避免每日刷屏。判据的负向对照在 `npm run test:doctor` 的内置 gh 桩里：`last-ok` 48h 前 ⇒
  必须报警（评论 + label）、5min 前 ⇒ 必须静默、canary 缺失 ⇒ 创建且不误报、403 注入 ⇒ 该项 ✗ 且
  **后续零写调用**、错误里带 token ⇒ 必须被打码（53 条断言；另有两条变异自证确认它会红）。
  ⚠️ 诚实边界：① **PAT 过期时间读不到**（个人 fine-grained PAT 没有 REST 查询端点，`GET /user` 不返回
  `expires_at`）；② "issue 创建/评论是否真的叫醒人"取决于该账号 GitHub 通知设置，本机**不可验证**；
  ③ "本机每天有人跑 doctor"**不由本仓库安装**（systemd unit 属用户资产，模板参见 autopilot 头注释）；
  ④ 在 PAT 拿到 Issues:write 之前 `last-ok` 永远写不进去 ⇒ 反向心跳会在 26h 后**如实报警**——这是设计要的
  信号，不是噪音；要么修 PAT，要么在排障期手动 disable 该 workflow。
- **三态 + 指数退避 + 只在跃迁时通知（2026-10-24，A6）**：本机三个 timer 都是"每 10 分钟一轮"，
  失败时旧行为是**每轮重印同一段完整错误**（并且 systemd 的 `Restart=on-failure` + `RestartSec=60`
  会把它变成热循环）。现在 `dsh-watch` / `dsh-release-autopilot` 共用 `scripts/lib/backoff-state.mjs`
  （纯函数状态机；`scripts/test-backoff-state.mjs` 含 8 轮实测与负向对照）：
  ① **healthy → degraded**（连续失败 1–2 次）：仍打印完整错误（还在诊断窗口），**只发一次**跃迁评论；
  ② **degraded → broken**（第 3 次连续失败；403/404/凭据这类**不可重试**错误第一次就 broken）：
     **只发一次**跃迁评论，进入退避；
  ③ **broken 之后**：每轮 stdout **只有一行** `still broken (attempt k, next retry in Xm)`（进入 broken 的那一轮
     另外给一行「连续 N 次失败」摘要 + 一条跃迁评论），到
     `nextAttemptAt` 之前**跳过实际工作**（不探 npm / 不 clone / 不 push / 不写 issue）；失败明细进
     `<state>.detail.log`，心跳每轮一行写 `<state>.heartbeat`（`skipped=yes/no` —— 反向心跳据此区分
     "进程还在、只是退避中"与"进程死了"）；退避 **5 → 10 → 20 → 40 → 封顶 60 分钟**；
  ④ **broken → healthy**（任一次成功）：**只发一次**恢复评论，计数清零（成功即 Forget）。
  **通知只在跃迁时发生**：评论带机器标记 `<!-- dsh-watch-backoff: state=broken … digest=<sha> -->`，
  digest 幂等（补发不重复；恢复后再次坏掉是新的一条），写失败会记进状态文件、下一轮补发。
  **退出码**：degraded / broken 的**重试轮**仍是 1（CI 该红就红）；**退避跳过轮是 0**（它没干活、
  也不是新故障 —— 0 是为了不与 systemd 的 restart 叠成热循环；健康判据是状态文件的 `state` + 跃迁评论）。
  **状态文件**：`~/.dsh/state/dsh-watch.json` 与 `~/.dsh/state/dsh-release-autopilot.json`
  （`--state-dir`/`--state-file` 覆盖；原子写 tmp+rename；损坏时备份成 `*.corrupt-<ts>` 并**重建为
  healthy** —— fail-open，坏状态不该让告警永远静默）。**人工恢复**：`--reset-state`（只重置本地状态、
  **不写 GitHub**）；排障时可加 `--no-backoff` 看"没有状态机时"的行为（门禁的负向对照就用它）。
  **CI 特例**：Actions runner 的文件系统是临时的 ⇒ 状态每轮从 healthy 开始，脚本在 CI 里**只记账、
  不发**跃迁评论（显式给 `--state-dir`/`--state-file`/`DSH_STATE_DIR` 才算持久化环境），
  "任务根本没跑"那一层仍归 A5 的 dead man's switch。
  **systemd 单元的推荐值**（本仓库不改你机器上的 systemd）：在 `[Service]` 里加
  `RestartSteps=4` + `RestartMaxDelaySec=3600`（systemd 254+ 的指数重启：60s→120s→240s→480s→960s，
  封顶 1h，与脚本内 60 分钟退避同尺度）—— 只加 `RestartSec=60` 时，不可重试错误会一直热循环。
  **验证**：`node scripts/test-backoff-state.mjs` —— 8 轮实测断言"第 1–2 轮完整错误 / 第 3 轮 broken /
  评论只有 2 条 / 第 4–8 轮每轮一行 / 恢复只多 1 条 / `--reset-state` 回 healthy"，
  外加一条**负向对照**（`--no-backoff` 时同一串失败必须退回"8 轮全量错误 + 0 条跃迁评论"。
- **日志与状态文件在哪、怎么清理（2026-10-24，A7）**：三个 timer 的 service 都用
  `StandardOutput=append:` / `StandardError=append:` 指向 `~/.dsh/logs/*.log` —— systemd 的 `append:`
  **只保证不截断，不保证不涨破磁盘**（man page 里没有任何 rotate/maxsize 选项），轮转必须外部做。
  - **重复日志**（`~/.dsh/logs/`，2026-10-24 实测）：`dsh-watch-timer.log` ≈ 976KB / 1.7 万行
    （约 4 天）、`dsh-autopilot.log` ≈ 229KB、`dsh-tagdispatch.log` ≈ 12KB。按这个节奏一年几十 MB：
    不致命，但**没有上限**。
  - **轮转模板**：[scripts/logrotate.dsh.conf](scripts/logrotate.dsh.conf)（`daily` + `maxsize 20M` +
    `rotate 7` + `compress` + `delaycompress` + `copytruncate` + `missingok` + `notifempty`；
    `copytruncate` 是必须的：systemd 一直持有 append 模式的 fd，不能通知它 reopen，复制后原地截断是标准解，
    代价是"复制 → 截断"之间极小的丢数据窗口）。安装与干跑（**用户级，不需要 root**）：
    `sed "s|@HOME@|$HOME|g" scripts/logrotate.dsh.conf > ~/.dsh/logrotate.dsh.conf`，
    `/usr/sbin/logrotate -d ~/.dsh/logrotate.dsh.conf`（只检查语法/匹配，不动文件），
    再 `/usr/sbin/logrotate -s ~/.dsh/logrotate.status ~/.dsh/logrotate.dsh.conf` 真跑一次。
    定时用 systemd **user** timer（模板，别装到 `/etc/systemd/system`）：
    ```ini
    # ~/.config/systemd/user/dsh-logrotate.service
    [Unit]
    Description=dsh 自动化日志轮转（logrotate，用户级）
    [Service]
    Type=oneshot
    ExecStart=/usr/sbin/logrotate -s %h/.dsh/logrotate.status %h/.dsh/logrotate.dsh.conf
    # ~/.config/systemd/user/dsh-logrotate.timer
    [Unit]
    Description=每天 04:17 轮转 dsh 日志
    [Timer]
    OnCalendar=*-*-* 04:17:00
    Persistent=true
    Unit=dsh-logrotate.service
    [Install]
    WantedBy=timers.target
    ```
    （`systemctl --user enable --now dsh-logrotate.timer`。也可以装到 `/etc/logrotate.d/dsh` 交给系统
    每天那趟 —— 二选一，别同时装：两份配置会互相抢文件。模板头注释里写了 `--dsh` 版本要补 `su <user>`。）
  - **journald**：本机 journal 上限只有 ~100M（`AGENTS.md` 记录）且会 vacuum 旧日志 ⇒ **不要把 journal
    当长期取证源**；关键日志落在 `~/.dsh/logs/` 并交给上面的轮转。
  - **退避状态与心跳**：`~/.dsh/state/dsh-watch.json` / `dsh-release-autopilot.json`
    （+ 同名 `.heartbeat`、`.detail.log`；`~/.dsh/locks/*.lock`、`~/.dsh/PAUSE`）。
    都可以安全删除：**删状态文件 = 忘掉退避历史**（下一轮从 healthy 重新数，不丢功能）；正规做法是
    `--reset-state`。`.detail.log` 自带 128KB 触发 / 只留尾部 400 行的自截断，不参与 logrotate。
  - **dump / 备份**：hang dump 落在 `<应用数据目录>/runtime/reports/dshweb-hang-<pid>-<ts>.dmp`
    （全内存 dump 单个可达数百 MB）。**真实保留策略在壳里且是三维的**（采用清单 A9，2026-10-24）：
    `src-tauri/src/retention.rs` 的 `HANG_DUMP_POLICY` = **最新 3 份 + 14 天 + 总量 ≤1GiB**，
    由 `web_dump::prune_dumps` 在每次 dump 与「清理缓存」时执行（`cargo test --lib` 覆盖，
    "**永不清空目录**"是硬边界：策略再严也只删到剩最新一份）。**另一个仍然存在的边界**：`scripts/server-manager.mjs` **没有任何 dump 保留逻辑**（`grep -n dump` 只命中
    看护协议行：请壳抓 dump / 等 dump-done / 重启），所以"manager 管 dump"是误解 —— 它只发协议。
    插件升级备份 `.plugin-backup` + `.plugin-backup.prev` 至多两份（`server-manager.mjs:763-774`），
    天然有界，无需清理。
  - **清理命令速查**：`rm -rf ~/.dsh/logs/*.log.*`（只删轮转出来的旧档）、
    `du -sh ~/.dsh/logs ~/.dsh/state <应用数据目录>/runtime/reports`（先看谁在长）、
    `find <应用数据目录>/runtime/reports -name 'dshweb-hang-*.dmp' -mtime +14 -print`（**先 print 再 -delete**，
    删除取证文件前确认真的是旧档）。
- **另三个定时工作流**：`dsh-sla-report.yml`（每周一 01:00 UTC 出 SLA 报表；门禁是独立一步 `--check`，
  只有它红才代表"有版本超 6h 或根本没量出来"）与 `preinstalled-sync.yml`（每周一 02:00 UTC 检测四个预装
  bundle 与 npm `dist-tags.latest` 的漂移，**有漂移才**同步 → 过 `copy-consistency` + `plugin-dsh-compat`
  两道门禁 → 开/更新 PR，PR 正文写明当前 dsh 地板；无漂移则静默 no-op）。漂移判定分**三态**：漂移（npm 更新
  ⇒ 同步）/ 本地领先（不动 —— 否则会用旧版覆盖已发布的 bundle）/ **查询失败**（逐个记账、跑完所有包，最后
  判红；把失败折成 `?` 会制造假漂移，而 `set -e` 会在第一个坏查询就中断整批）。漂移判定与心跳判据无关（心跳见上一条）。
  另外四处：同步后"无差异"
  看 `git status --porcelain`（含未跟踪新文件，`git diff --quiet` 看不见）；push 前 `git ls-remote` 取期望值 +
  `git fetch` 建远端跟踪引用 + 显式 `--force-with-lease=refs/heads/<b>:<sha>`（干净检出没有跟踪引用，裸 lease
  会以 stale info 拒绝 ⇒ 旧实现第二次运行必失败、既有 PR 永不更新）；五个自动化工作流
  （`dsh-watch` / `dsh-sla-report` / `tag-dispatch` / `preinstalled-sync` / `dsh-heartbeat-check`）都加了
  `timeout-minutes`，
  `workflow_dispatch` 的输入一律经 env 进 bash（直接插进 `run:` 文本会让 `$(...)` 被执行且 step 仍绿）。
