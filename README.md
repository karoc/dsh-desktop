# DSH Desktop

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）打包成可独立运行的 Windows 桌面 App。

- **dsh 本体自动更新**：每次启动检查 npm 上的 `@deepseek-ai/dsh` `latest`，有新版本就在运行时目录里更新到最新，然后再启动服务。dsh 永远来自官方 npm 包，本地零改动。
- **内置 Node 24 运行时**：安装包自带 Node（满足 dsh 的运行要求），用户机器无需装 Node。
- **原生通知**：dsh 需要你问答（`pendingInteraction`：问题 / 批准 / 计划审阅）时，或某个会话结束（`running` 由真变假）时，弹出系统通知；窗口在前台时不打扰。
- **点击通知直达会话**：单击系统通知会把窗口带回前台并打开对应会话（单实例 + 本地桥实现）。
- **托盘常驻**：关窗只是隐藏，服务继续跑；托盘菜单"退出"才真正停止并退出。
- **官方零改动**：通知插件通过 `dsh web --patch` 在运行时注入，更新 dsh 不会冲掉它。
- 桌面端数据自包含（`DSH_HOME` 默认在运行时目录内），与浏览器版各自独立，可随时切回共用。

## 架构

```
┌─ Tauri 2 壳 (Rust, WebView2) ─────────────────────────────┐
│ 本地启动页 → 监听 server-url 事件 → 跳转 http://127.0.0.1   │
│ server-manager.mjs（内置 Node 24 运行）                     │
│   校验/更新 @deepseek-ai/dsh@latest（npm）                 │
│   注入通知插件（--patch，copy 进运行时 node_modules）        │
│   拉起 dsh web --host 127.0.0.1 --port 0（随机端口）        │
│   解析 stdout 里的 http://127.0.0.1:<port> 上报给壳         │
│ 本地通知桥（127.0.0.1:<bridge>）                           │
│   /notify → tauri-plugin-notification 弹系统通知           │
│   /pending-open → 点通知后的"待打开会话"                    │
│   /log /alive → 决策日志 + 心跳（排查用）                   │
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
src-tauri/                Tauri 2 壳：
  src/lib.rs               窗口/托盘/单实例/通知桥/服务生命周期
  capabilities/            权限（launcher + remote-notifications）
  resources/patch/         --patch 注入文件（dsh-desktop.patch.yml）
  resources/manager/       同步后的 server-manager.mjs
  resources/node/          fetch-node.mjs 下载的 Node 24（不入库）
  resources/plugin/        通知插件（bundle 用）
  icons/                   应用图标全套（含 NSIS 安装器图标/向导横幅）
scripts/
  server-manager.mjs       更新 dsh + 拉起服务 + URL/日志上报（核心）
  fetch-node.mjs           下载/校验/解压 Node 24（幂等）
  sync-resources.mjs       把 scripts/plugins 同步进 src-tauri/resources
  make-icon-png.mjs        图标源生成工具（开发用）
plugins/dsh-client-notifications/
  client.js                浏览器半边：监听 pendingInteraction / running 沿，
                           经桥发通知、消费 /pending-open 打开会话
  index.js                 Node 半边：空实现（占位）
.github/workflows/build.yml  windows-latest 出 NSIS 安装包；v* tag 自动发 Release
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
npm run test:plugin       # 通知插件行为测试（12 个场景，纯 Node，无浏览器）
npm run fetch:node        # 下载并校验内置 Node 24（win/linux/darwin）
npm run sync:resources    # 同步 manager/plugin/patch 进 src-tauri/resources
```

完整注入链路（与 Windows 运行时同构）可手动复现：

```bash
# 1) 装官方 dsh 到临时 runtime
npm install --prefix /tmp/dshrt @deepseek-ai/dsh
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

- 首次启动：装 dsh + 通知插件（约几十秒，之后被 npm 缓存）；再启动会快速检测更新。
- 更新失败（离线等）：保留现有版本继续启动，不阻塞。
- 服务异常退出：加载页显示日志，"重试"按钮 → `restart_server`。
- 关窗 → 隐藏到托盘；托盘"退出" → 杀掉整棵服务进程树并退出。
- 点系统通知 → 窗口回到前台并打开对应会话（不重复启动第二个实例）。

## 环境变量（可选）

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_NO_UPDATE=1` | 跳过启动时的 dsh 更新检查 |
| `DSH_DESKTOP_NODE_VERSION` | fetch-node 下载的 Node 版本（默认 `v24.18.0`） |

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
每次 push 都会产出 setup.exe 并上传为 artifact（附 7z 布局断言：内置 Node 必须在包内）；
**打 `v*` tag 即自动发布**：

```bash
git tag v0.1.0
git push origin v0.1.0
```

发布完成后在 GitHub Releases 页下载 `DSH Desktop_<版本>_x64-setup.exe`，无需本地构建。
（注：installer/exe 未做代码签名，SmartScreen 可能提示"未知发布者"。）

## License

MIT