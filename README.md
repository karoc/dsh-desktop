<p align="center">
  <img src="src-tauri/icons/128x128.png" width="128" height="128" alt="DSH Smoothly Desktop logo" />
</p>

# DSH Smoothly Desktop (DSH SD)

DSH Smoothly Desktop（**DSH SD**）把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）打包成可独立运行的 Windows 桌面 App。

- **dsh 更新由你决定**：启动时只检查 npm 上 `@deepseek-ai/dsh` 的稳定版（`latest` tag）与预发布（`next`/`alpha` tag），**不自动安装**。有新版时托盘菜单高亮「有更新 vX → 点击更新」，壳菜单「检查更新…」弹窗也能一键更新（含预发布，想升才升）；点一下即下载安装并自动重启。dsh 永远来自官方 npm 包（经内置 pnpm 安装），本地零改动。**唯一例外是版本地板**：壳要求 dsh ≥ `0.1.7-rc.2`（0.1.6-alpha.2 起 dsh 才自带插件管理；0.1.7 起随壳分发的预装插件才能通过 dsh 的插件兼容门禁，见下条），低于地板的运行时会先自动升到地板，失败则如实提示并继续启动。
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
npm test                 # 全量 14 套：清单一致性 / overlay 目标行 / 升级标记 / 通知插件 / 控制面 / 代理 / 代理e2e /
                         #   启动页设置 / 壳顶栏契约 / 启动器扫动 / 请求头预算 / 半截安装自愈 / 副本一致性
npm run test:slow        # 安装卡死快速失败（~3 分钟，不进 PR 门禁；CI 的 linux job 会跑）
npm run test:plugin      # 通知插件行为测试（纯 Node，无浏览器）
npm run test:control     # manager 控制面（11 场景，含版本地板闸门）
npm run test:proxy       # 内置正向代理（12 场景）
npm run test:launcher-settings  # 代理设置窗口（6 场景）
npm run test:shell-chrome       # 壳顶栏契约（菜单 id ↔ ACTIONS ↔ lib.rs 桥/命令）
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
- **dsh 更新**：壳菜单「检查更新…」弹窗显示当前/可升版本。稳定版（`latest` tag）随时可一键升；若 npm 有更新的**预发布**（`next`/`alpha` tag）也会提示「（预发布）」可升，想升才升，不点就保持原版本。**版本地板**：dsh < `0.1.7-rc.2` 时启动会自动升到地板（0.1.6-alpha.2 起才有自带插件管理，0.1.7 起预装插件才被兼容门禁放行），失败会如实提示并继续启动；`dsh.json` 的 `devMode` 会冻结这一自动升级。
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

## 升级与数据安全（0.4.x 起）

**版本演进策略**：正式版安装目录名 / 快捷方式名一经定型不得随版本改动；
升级一律"就地覆盖安装"。标识（identifier）变更属特殊事件，必须配整套旧版接管。

**dsh 升级是单向的（0.1.7 起，重要）**：
- dsh **0.1.7-alpha.1 起**把会话按 **v4** 格式写入，而旧读取器**拒绝读**新代文件；
  写入方式是"旁挂新代文件"，升级前的 v3 快照仍在原地。
- 因此**不要用"装回旧版本"当回滚手段**：回退到 0.1.6 及更早，只会看到**升级前**的
  快照，升级后产生的会话/改动**读不到**。更不能以"旧版本还能打开"判定回滚成功。
- **正确的回滚 = 还原升级前的数据目录备份**：升级前用壳菜单「检查更新…」弹窗里的
  「打开数据目录」复制整个数据目录（或至少 `runtime/dsh-home/`），回滚时整目录还原。
- 升级入口的提示已就位：检查更新弹窗会显示这条警告；托盘「有更新 vX」的标签与
  通知文案也带「建议先备份数据目录」。
- **回退 dsh 会让新版插件可能失效**：回退是降级 dsh；若新版预装插件依赖旧版没有的客户端服务（例如 0.1.7 的 `configForms`），dsh 的插件加载是 fail-closed → **界面会停在「Failed to load plugins」打不开**。自救：启动页点「停用第三方插件」（会先备份 profile 配置），或恢复升级前的数据目录备份。
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
2. 若会话/配置异常：从 `%LOCALAPPDATA%\dsh-backup\` 按时间戳目录恢复
   （sessions/、settings.yaml、storages/ 拷回 `%APPDATA%\dsh.smoothly.desktop\runtime\dsh-home\` 同路径）；
3. 恢复后重启壳；仍有问题请保留 `dsh-backup` 与两份日志再求助。

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
- **CI 分层**：PR 只跑快层（check：`cargo check` + `clippy -D warnings` + `cargo test --lib`；test：`npm test` 全量，~5min）；main push / `v*` tag 跑全量（windows NSIS 打包 + 布局断言 + runtime smoke、linux 打包、linux-smoke canary）。
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