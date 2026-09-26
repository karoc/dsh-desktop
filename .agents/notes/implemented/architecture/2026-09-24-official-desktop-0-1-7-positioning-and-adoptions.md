# Agent Note: official-desktop-0.1.7-positioning-and-adoptions

Status: implemented

## Problem

官方 dsh 的 Electron 桌面线在 0.1.7-rc.2 已完整落地（apps/desktop 59 个 src 文件 / 127 脚本 / 135 测试 / 自研 C++ NSIS / COS 更新链），而本仓 README 的定位还是「官方桌面端出现前的临时壳」（README.md:283）。旧对照结论（docs/2026-09-17-*.md）建立在「官方桌面端未发布」的前提上，继续沿用会让「我们该不该继续维护自己的壳、该抄什么、该放弃什么」这三个问题都没有立场。

## Decision

**定位不改为「临时壳」，而是「不同产品面的独立客户端」**：官方桌面端是「同一 Web 前端 + 进程内 in-process boot 的 dsh 内核 + 打包期物化运行时 + EV 签名与自有 CDN」的一体化分发单位（`apps/desktop-host/src/index.ts:6,25` 用 `runProfile()`；`prepare-package-set.ts:30-31` 闭包进 asar；版本恒等见 `prepare-dsh.ts:53-58`）；我们继续做「Tauri 2 + 外部 `dsh web` 子进程 + 内置代理/通知/预装插件 + 私有 DSH_HOME + Windows 深度取证」的壳。**差距是结构性的而非努力程度的**——官方桌面与我们跑的是同一套 profile bundle（`apps/desktop/src/project-manager.ts:32` 取 `PROFILE_TEMPLATES.web`），差别只在三处宿主外能力：进程内持有 boot 后的 `ctx`、`dsh-app://app` 源 + preload 全局桥、以及一批 Electron 原语 IPC（退出巡检/更新准入/平台凭据）。

**要采纳的（按顺序，见报告 §5）**：① P0-1 注入官方的 Windows 顶栏契约 `html[data-windows-titlebar]` + `--dsh-windows-titlebar-height`（客户端已原生避让，`ui-layout/src/client/AppFrame.module.css:26-54`），**保留**现有 800ms 全屏探测与 `--dsh-shell-menubar-h` 作兜底并加契约断言；② P0-2 把桥上的危险动作（`/shell/quit`、`/restart`、`/restart-dsh`、`/update-dsh`、`/shell/disable-third-party-plugins`、`/devtools`）收进壳内确认窗 + 单次 nonce，对齐官方「页面不能提供更新版本/URL/授权」（`apps/desktop/src/ipc.ts:70`）；③ P0-3 成套注入官方桌面标记族中的安全子集（先 `__DSH_LOCALE__`），`dshOnboarding`+`dshDesktop`+`dshPlatform` 必须同给同不给；④ P1 先代码签名、再做自更新一期（下载 + 哈希/签名校验 + 交安装器，无差分、无强更）；⑤ P1 关窗首次隐藏确认、失败态原生三选一恢复框、dsh 升级后契约冒烟、可选「共享 `$DSH_HOME`」开关。

**负向保证（明确不做，避免后人重开）**：不设 `data-platform`（0.1.7-rc.2 全仓只认 `darwin`，注入 windows 是 no-op、darwin 会激活 macOS 专属拖拽布局）；不把页面换成自定义 scheme（会丢 `isLoopback`，进而丢 settings 文档编辑与 `SettingsDocumentStore`）；不改用 Electron 重写；不打包 dsh 运行时；不做强更（mandatory update）；不 fork NSIS 模板做事务化安装器（2026-08 已论证）；不背 Python/Office 全量载荷；不做 macOS；不采纳官方「卸载无条件删三类数据」的口径（我们默认保留、勾选才删）。

**0.1.7-rc.2 升级带来的三条硬约束（必办，见报告 §6）**：① 会话持久化格式升到 v4 且「V3 readers refuse the newer generation」→ 回滚不再是「换回旧版本」而是「还原升级前备份」；② `ui-sidebar-browser` 被上游按 `profileContext.name !== 'desktop'` 门控，必须靠壳 overlay 的 `disabled: false` 才留住（DOM 注入无效）；③ 新增插件 peer 兼容闸门会在 profile 启动时静默 `disabled` 不兼容插件，而我们的壳用裸 pnpm 安装（绕过 `dsh plugin add` 的安装期拒绝），需壳侧安装后自检 `peerDependencies`。同时**必须保留** `--max-http-header-size=65536` 注入与陈旧 cookie janitor（上游零修复），并实测 hoisted 布局修复在新区模块解析机制下是否仍必要。
## Alternatives considered

**改用 Electron 重写壳**：能一次拿到官方全部机制，但要放弃 4.9k 行 Rust 里已交付的 Windows 资产（Job Object kill-on-close、挂起 MiniDump、manager 退出取证、外部 guard、内置代理、预装插件注入），且等于承认「重做一遍官方已经做过的事」，收益是别人的、成本是我们的。

**改成 in-process 嵌入 `@deepseek-ai/dsh/profile-boot`**：技术上确有口子——该导出是 npm 公开的（`apps/cli/package.json:154-158`），且 `runProfile` 接受 `resolvedProfile` 会跳过 `desktop` 名的 CLI 封锁（`apps/cli/src/profile-boot.ts:203-204`，官方测试 `resolved-profile-boot.spec.ts:69-72` 自证）。放弃原因：它要求我们把「起一个 CLI 子进程」换成「自己管一个 Node 宿主 + 自渲染 index + 自造 preload 等价物」，等于重写宿主模型；而官方 README 的口径仍是 desktop 归 Electron 独占，吃这个口子等于长期对抗官方定位。

**打包内 dsh 运行时（离线可用/首启零安装）**：收益确实最大（官方首启不装任何核心包），但需要再分发授权判断、签名链、体积与跨平台构建预算；改用「可选资源包（本地 file 依赖）+ 首启失败可见」作为折中。

**逐项对齐官方功能面**：官方 135 个测试文件、自研 C++ 安装器、Python/LibreOffice 载荷、macOS 公证——逐项追等于把团队资源投在对方的赛道上；改为只采纳「与自己技术栈无关、且能补上真实缺口」的 6 项（见 Decision）。

**照搬官方的签名缓存 / 账户级阶段锁 / 一次性探针预检**：那是「每天多次签名构建」的团队优化；我们的发布频率是「一版一次」，先买证书 + CI 签名 + 时间戳即可。
## Consequences

**代价（我们继续背的）**：外部契约税不会消失——对 dsh 的依赖面是 CLI 参数顺序、`?token=` URL、`dsh-auth-<sha256(authority)>` cookie 命名、`dsh.profile.bundles`、`settings.yaml` 文本结构、pnpm hoisted 布局、`__ModuleLoader__`/`ctx.sessions.*` 客户端 API，现又新增「插件 peer 兼容闸门」与「profile 目录里的 compatibility.json」两项；我们仍然无签名、无自更新、无 macOS 产物，首启依赖网络安装。

**收获（我们保持的）**：版本自由（用户可停在任意 dsh 版本，含预发布）、内置逐主机路由正向代理（官方零用户可见代理配置）、任务完成/待交互系统通知（官方明确不做完成通知）、4 个版本锁定的预装插件、Linux 产物、私有 DSH_HOME（绝不污染浏览器版 `~/.dsh`）、Windows 深度取证、以及「不自动重启、如实暴露失败」的退出纪律（D1）。

**后续义务（已落卡）**：P0-1 顶栏契约（card 已建）、P0-3 桌面标记族（s6 卡，已被 s7 更正 `data-platform` 前提）、「升级 0.1.7-rc.2 必办三项」（card 已建）；另需在 dev 版做一次**V-1 验证**：0.1.7-rc.2 下 hoisted 与 isolated 两种布局各冷启一次并用 `/alive` 断言页面 mounted——这是本轮唯一「可能改变既有设计」的未验证项。

**覆盖缺口（不得当成通过）**：报告中 17 条不确定性未消除，尤其「Tauri/WebView2 能否保证注入脚本早于页面读取 `dshDesktopBoot`」「官方安装包实机行为（强更/加密材质/公证）」「我方 `verify-*.ps1` 当前是否仍全绿」；官方侧全程只读，未跑任何构建或实机验证。证据与逐点论证见 [报告](../../../../docs/2026-09-25-official-desktop-0.1.7-rc.2-vs-dsh-desktop.md)，深挖原文在 `.tmp-investigate/desktop-0.1.7/s1-s7`；相关的既有决策见 [插件管理移交 dsh](./2026-09-21-plugin-management-moves-to-dsh.md)。

