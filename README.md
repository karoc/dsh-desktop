<p align="center">
  <img src="src-tauri/icons/128x128.png" width="128" height="128" alt="DSH Desktop logo" />
</p>

# DSH Desktop

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）打包成可独立运行的 Windows 桌面 App。

- **dsh 更新由你决定**：启动时只检查 npm 上 `@deepseek-ai/dsh` 的稳定版（`latest` tag）与预发布（`next` tag，如 0.1.0-rc.8），**不自动安装**。有新版时托盘菜单高亮「有更新 vX → 点击更新」；插件控制台的「dsh 更新」区显示可升版本（含预发布，想升才升）；点一下即下载安装并自动重启。dsh 永远来自官方 npm 包（经内置 pnpm 安装），本地零改动。
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
  resources/preinstalled/  预装插件 bundle（dsh-kanban / model-reasoning / turn-navigator）
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
plugins/dsh-plugin-console/   插件控制台（预装/自装插件 + dsh 更新，含预发布）
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

## 本地验证（Linux 可跑的部分）

```bash
npm test                 # 全量：通知插件 / 控制面 / 插件控制台 / 代理 / 代理e2e / 启动页设置 / 壳顶栏契约
npm run test:plugin      # 通知插件行为测试（纯 Node，无浏览器）
npm run test:control     # manager 控制面（10 场景）
npm run test:console     # 插件控制台行为（17 场景）
npm run test:proxy       # 内置正向代理（12 场景）
npm run test:launcher-settings  # 代理设置窗口（6 场景）
npm run test:shell-chrome       # 壳顶栏契约（菜单 id ↔ ACTIONS ↔ lib.rs 桥/命令）
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
- 关窗（含顶栏关闭键）→ 隐藏到托盘；顶栏/托盘"退出" → 杀掉整棵服务进程树并退出。
- 点系统通知 → 窗口回到前台并打开对应会话（不重复启动第二个实例）。

## 壳菜单栏（自绘顶栏）

主窗口无系统标题栏（`decorations: false`），壳在每次页面加载时注入一条 36px 顶栏
（`src-tauri/resources/ui/shell-chrome.js`，编译期内嵌，启动页与 dsh 页面都生效）：

- 左上角 **DSH Desktop** 应用菜单：检查更新…（有更新时翻转为「有更新 vX（点击更新）」）、
  开发者模式、退出；
- 其后**可见顶级条目一字向右**：**代理设置…**（点击直开设置窗口）、**视图**（刷新页面 /
  重启服务）、**帮助**（打开数据目录 / 关于）；
- 右上角窗口三键：最小化 / 最大化(还原) / 关闭（关闭=隐藏到托盘，语义不变）；
- 空白区拖动窗口、双击切换最大化；dsh 页面内路由切换不丢失（MutationObserver 自愈）。

**后续壳独有的菜单就在 `SHELL_MENUS` 数组里定义**（该文件顶部），每个条目映射到
`ACTIONS` 的双通道动作：本地页走 IPC 命令，远程 dsh 页走环回桥（`/window/*`、
`/shell/*`，远程页没有 `__TAURI__`，tauri#11934）。契约由 `scripts/test-shell-chrome.mjs`
守护：菜单 id ↔ ACTIONS ↔ lib.rs 桥端点/命令注册三方不漂移。
（Tauri 2 的 `Menu` 在 Windows 不渲染窗口菜单栏，故为自绘注入；托盘菜单保留为窗口
隐藏时的持久入口。）

## 插件（预装 + 用户自装）

dsh 页面右下角有「插件」控制台面板，统一管理：

- **预装插件（默认关闭，随壳自带）**：`dsh-kanban`（看板）、`dsh-model-reasoning`（按模型推理档位）、`dsh-turn-navigator`（会话轮次导航）。在控制台打开开关后**重启服务生效**；控制台里可一键检查/升级预装插件、恢复默认版本。
- **用户自装插件**：控制台输入 GitHub 地址或包名安装、卸载、更新（经内置 pnpm + `dsh plugin` CLI）。
- **dsh 更新**：控制台「dsh 更新」区显示当前/可升版本。稳定版（`latest` tag）随时可一键升；若 npm 有更新的**预发布**（`next` tag，如 0.1.0-rc.8）也会提示「（预发布）」可升，想升才升，不点就保持稳定版。
- 代理设置入口不在控制台里，在**顶栏菜单「代理设置…」**（独立设置窗口，托盘菜单同样可达）。

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

## 发布（CI 自动出包 + GitHub Release）

Windows 安装包由 GitHub Actions（`.github/workflows/build.yml`）在 `windows-latest` 上自动构建：
每次 push 都会产出 setup.exe 并上传为 artifact，并跑两道门禁：
- **7z 布局断言**：安装包内必须含内置 Node 运行时；
- **Runtime smoke**（`scripts/smoke-windows.mjs`）：在空 runtime 上用 pnpm 冷安装真实 dsh，断言 dsh web 报出 URL——拦住"安装挂起 / launch failed: not installed / 启用插件后黑屏"这类回归。

**打 `v*` tag 即自动发布**：

```bash
git tag v0.3.10
git push origin v0.3.10
```

发布完成后在 GitHub Releases 页下载 `DSH Desktop_<版本>_x64-setup.exe`，无需本地构建。
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