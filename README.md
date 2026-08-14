# dsh Desktop

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）打包成可独立运行的 Windows 桌面 App。

- **dsh 本体自动更新**：每次启动检查 npm 上的 `@deepseek-ai/dsh` `latest`，有新版本就在运行时目录里更新到最新，然后再启动服务。dsh 永远来自官方 npm 包，本地零改动。
- **内置 Node 24 运行时**：安装包自带 Node（与 dsh 的 `engines` `^22.19 || >=24` 匹配），用户机器无需装 Node。
- **原生通知**：dsh 需要你问答（`pendingInteraction`：问题 / 批准 / 计划审阅）时、或某个会话完成（`completed`）时，弹出系统通知。窗口在前台时不打扰。
- **托盘常驻**：关窗只是隐藏，服务继续跑；托盘菜单"退出"才真正停止并退出。
- **官方零改动**：通知插件通过 `dsh web --patch` 在运行时注入，更新 dsh 不会冲掉它。
- 桌面端数据自包含（`DSH_HOME` 在运行时目录内），与浏览器版各自独立。

## 架构

```
┌─ Tauri 2 壳 (Rust, WebView2) ────────────────────────────┐
│ 本地启动页 → 监听 server-url 事件 → 跳转 http://127.0.0.1 │
│ server-manager.mjs（内置 Node 24 运行）                    │
│   校验/更新 @deepseek-ai/dsh@latest（npm）                │
│   注入通知插件（--patch，copy 进运行时 node_modules）       │
│   拉起 dsh web --port 0（127.0.0.1，随机端口）             │
│   解析 stdout 里的 http://127.0.0.1:<port> 上报给壳         │
│ 托盘：显示窗口 / 重启服务 / 打开数据目录 / 退出             │
└────────────────────────┬─────────────────────────────────┘
                         │ spawn
                 ┌───────▼────────┐       通知：tauri-plugin-notification
                 │  dsh web 服务   │ ◄──── 注入的客户端插件（仅 loopback 权限）
                 └────────────────┘       数据 ~/.dsh（$DSH_HOME）
```

## 目录

```
src/                      Tauri 前端加载页（纯静态，无打包器）
src-tauri/                Tauri 2 壳：
  src/lib.rs               窗口/托盘/服务生命周期
  capabilities/            权限（launcher + remote-notifications）
  resources/patch/         --patch 注入文件
  resources/manager/       同步后的 server-manager.mjs
  resources/node/          fetch-node.mjs 下载的 Node 24（不入库）
  resources/plugin/        通知插件（bundle 用）
scripts/
  server-manager.mjs       更新 dsh + 拉起服务 + URL/日志上报（核心）
  fetch-node.mjs           下载/校验/解压 Node 24（幂等）
  sync-resources.mjs       把 scripts/plugins 同步进 src-tauri/resources
  make-icon-png.mjs        生成占位图标源
plugins/dsh-client-notifications/
  client.js                浏览器半边：监听 pendingInteraction/completed
  index.js                 Node 半边：空实现（占位）
.github/workflows/build.yml  windows-latest 出 NSIS 安装包
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
`tauri build` 前会自动下载 Node 24 运行时并校验 SHA-256。

## 本地验证（Linux 可跑的部分）

```bash
npm run test:plugin       # 通知插件行为测试（8 个场景，纯 Node，无浏览器）
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
- 关窗 → 隐藏到托盘；托盘"退出" → `taskkill /T /F` 杀掉整棵服务进程树并退出。

## 环境变量（可选）

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_NO_UPDATE=1` | 跳过启动时的 dsh 更新检查 |
| `DSH_DESKTOP_NODE_VERSION` | fetch-node 下载的 Node 版本（默认 `v24.18.0`） |

## 安全说明

dsh 页面以纯远程页面加载，只授予"到 loopback 的通知权限"
（capability `remote-notifications`，仅 `notification:allow-notify`，无文件/系统/网络权限）。
端口只绑定 `127.0.0.1`。

**数据位置**：默认 `DSH_HOME = <runtime>/dsh-home`（桌面端自包含，不碰浏览器版共用的
`~/.dsh`）——这也是必要设计：插件包藏在 `<runtime>/node_modules` 里，profile 的模块解析
沿目录链向上能找到它。想与浏览器版共享数据的用户，可自行在系统环境里放 `DSH_HOME`（需先
把插件装进其 profile，见"注入原理"）。

## 注入原理（为什么更新 dsh 不会冲掉通知）

1. `dsh web --patch <file>` 把一行 loader 条目插入 web profile：
   `{ id: desktop-notifications, name: '@dsh-desktop/client-notifications' }`。
2. `dsh-client-modules` 节点半端扫描 loader 条目里声明了
   `dsh.client.platform: web` 的包，读取其 `exports["./client"]`，以
   `/plugins/<id>/client.js` 提供到浏览器（`window.__DSH_BOOT__` 名册）。
3. 浏览器内核以 classic script 加载该 bundle，bundle 调用
   `window.__ModuleLoader__.load({ id, factory })` 注册；客户端插件订阅
   `ctx.sessions.list`，检测 `pendingInteraction` / `completed` 变化后，
   经 `window.__TAURI__.notification` 发系统通知。
4. 全程不修改 `@deepseek-ai/dsh` 任何文件，官方包从 npm 重新安装/升级天然无损。

## 与官方的关系

这是官方桌面端出现前的临时壳：dsh 本体永远是官方 npm 包，届时替换壳即可，数据
（`~/.dsh`）可无缝沿用。

## License

MIT