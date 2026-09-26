# 官方 dsh 0.1.7-rc.2 桌面端 vs 我们的 dsh-desktop：逐点对比与利弊报告

- **官方侧坐标**：`/srv/deepseek-harness`，HEAD `477b4f4205`（merge PR #5180）、tag `dsh-v0.1.7-rc.2`，`apps/desktop` 与 `apps/desktop-host` 版本 `0.1.7-rc.2`。
- **我方坐标**：`/home/karoc/dsh-desktop`，v0.11.0（HEAD `4b05664`）；宿主机实机现状见 §7.1。
- **取证方式**：源码逐文件通读 + `git log/tag` + npm registry 实查 + 宿主机（`/mnt/c`）只读抽查。官方侧**未做任何修改**，全程只读。
- **标注约定**：`[已验证: 命令]` = 本次实跑得到；`[假设]` = 由代码推断、未端到端核验（**不得作为决策依据**）；`[本机不可验证]` = 缺 Windows/macOS 真机、缺私有 CI、缺 EV 硬件，本环境无法证实；`[未覆盖]` = 本轮没查。
- **原始证据文件**（本次深挖产物，可复核）：
  - `.tmp-investigate/desktop-0.1.7/s1-architecture.md`（官方进程/宿主架构）
  - `.tmp-investigate/desktop-0.1.7/s2-runtime-update.md`（官方运行时准备与更新体系，351 行）
  - `.tmp-investigate/desktop-0.1.7/s3-installer-signing.md`（官方安装器/签名/公证/门禁，280 行）
  - `.tmp-investigate/desktop-0.1.7/s4-feature-surface.md`（官方用户可见功能面，322 行）
  - `.tmp-investigate/desktop-0.1.7/s5-our-baseline.md`（我方事实基线，628 行）
  - `.tmp-investigate/desktop-0.1.7/s6-monorepo-coupling.md`（官方 monorepo 桌面耦合面）
  - `.tmp-investigate/desktop-0.1.7/s7-016-to-017-breaks.md`（0.1.6→0.1.7 对外部壳的影响）

---

## 0. 结论摘要（十一条）

1. **官方桌面端不是「另一个壳」，而是「同一个 Web 应用的签名打包版 + 自持分发链」**：它把 Web 前端、dsh 运行时、私有宿主包、Node/Python/LibreOffice 全部在打包期物化进安装包（`apps/desktop/scripts/prepare-package-set.ts:30-31`、`src/core-package-set.ts:108-115`、README.zh.md:67），运行期不装任何核心包。我们的壳则相反：**壳只出壳，dsh 永远从 npm 现装**（`scripts/server-manager.mjs:28,718-746`）。这是两份方案最大的结构性分野，后面 80% 的差异都由它派生。
2. **版本哲学相反**：官方「桌面版本 == dsh 版本」逐字绑定，升级 dsh 必须发新桌面版本（`apps/desktop/scripts/prepare-dsh.ts:53-58`、README.zh.md:65）；我们「壳版本独立 + 运行时自由选版本」，因此**我们能吃到上游还没进桌面包的修复**，代价是历史上 8 类脆契约全由我们兜（§3.19、§6）。
3. **安全模型是我们最实质的欠账**：官方渲染进程只拿到白名单 IPC，且**令牌不进页面**（WebSocket 握手由主进程在网络层补 cookie/origin，`apps/desktop/src/main.ts:665-676`）；我们的页面直接加载 `http://127.0.0.1:<临时端口>/?token=…`，另有**完全无鉴权的 30 端点环回 HTTP 控制面**（`src-tauri/src/lib.rs:1693-1986`）。我们已挂卡未修（KANBAN `card-29b6f966`），不是新问题，但本次对比给出了上游已有答案。
4. **官方把「桌面顶栏」做进了 Web 客户端的一等契约**：`html[data-windows-titlebar]` + `--dsh-windows-titlebar-height` 由壳设置（`apps/desktop/src/preload-windows.ts:12-13`），客户端自己预留标题栏、把侧栏开关与品牌搬进标题栏、给全屏面板让位（`packages/client/ui-layout/src/client/AppFrame.module.css:26-54`、`packages/client/ui-sidebar/src/client/SidebarRoot.module.css:39-83`）。我们的注入式顶栏只能靠 800ms 探测 + `--dsh-shell-menubar-h` 自觉（`src-tauri/resources/ui/shell-chrome.js:772,823-862`）——**这是本轮最有性价比的借鉴点**（§5 P0-1）。
5. **官方桌面独占能力我们拿不到**：打包期物化的 Python 数据栈（numpy/pandas/python-docx/pptx/openpyxl/Pillow/lxml/XlsxWriter）、`office-docx/pptx/xlsx` 三技能、LibreOffice 转换（`apps/desktop-host/src/office.ts:28-37`、README.zh.md:53-55）。**但它与 Electron 无关**：唯一 Electron 专属的是 `app.asar → app.asar.unpacked` 路径重写（`apps/desktop-host/src/office-engine.ts:12-15,27-41`）。真正门槛是载荷体积与宿主侧集成，不是技术栈（§4.1）。
6. **官方的分发与签名链对我们是「看得到、吃不到」**：EV Token 串行签名 + 内容寻址签名缓存 + 账户级阶段锁 + 一次性探针预检 + COS 托管 + 强制更新（`apps/desktop/scripts/windows-sign.mjs:166-243`、`src/mandatory-update-policy.ts:112-125`），而且**官方自己的仓库里也没有桌面 CI**（`.github/workflows/` 零命中），是私有/人工发布机流程 `[假设]`。我们没有签名与自更新，长期看这是用户信任与分发效率上的真实差距（§3.13、§5 P1）。
7. **官方有而我们没有的「产品级完成度」集中在四件事**：登录/凭据引导（Welcome 三页 + 两条凭据路径 `apps/desktop/src/client/WelcomePage.tsx:9`）、退出前任务检查（Host 回答 `activeTasks`/`scheduledTasks`，2s 截止、查不到按最保守问 `apps/desktop/src/quit-confirmation.ts:15-21`）、原生致命恢复对话框（退出/重启/停用第三方插件三选一 `apps/desktop/src/fatal-recovery.ts:81-86`）、崩溃报告（有界白名单 + 保留 10 份 `apps/desktop/src/crash-report.ts:50,104-137`）。四项都不依赖 Electron 内核能力，属于可移植设计。
8. **我们有而官方没有的收益同样明确**：内置逐主机路由的正向代理（`scripts/proxy.mjs`，官方零用户可见代理配置 `[已验证: grep src/*.ts 仅 update-http-executor/web-document 命中]`）、任务完成/待交互系统通知（官方明确「关闭窗口不发送系统通知」，`apps/desktop/README.zh.md:27`；其 `Notification` 仅用于强更注意力 `src/update-attention.ts:2,43`）、4 个预装插件、Linux 产物（官方 Linux 明确不是发布目标 `apps/desktop/README.zh.md:206`）、中文单语壳的完整本地化、dev/prod 同机并存、把 dsh 停在任意版本的能力。
9. **一个容易被忽略的事实：官方桌面壳的「壳菜单」也是注入式的**，也是 shadow DOM、也要等 Web 客户端发布席位（`apps/desktop/src/preload-menu.ts:11-27,89-97`），Windows 强更 UI 也是注入 iframe（`src/preload-mandatory-overlay.ts:27-36`）。**我们在这条路上并不孤独，差的是「客户端为壳留的契约」而不是「是否注入」**。
10. **战略判断**：官方桌面端在 0.1.7-rc.2 仍是**内测级**（账号登录按钮禁用 `apps/desktop/README.zh.md:436`、发布链要求 EV/COS/公证、无公开下载证据 `[未覆盖]`），且它服务的是「DeepSeek 官方账号 + 官方网关」的用户；我们的壳服务的是「自有/第三方 provider + 复杂网络环境 + 预装插件」的用户（宿主机 `proxy.json` 的 `anyrouter.top`/`new-api.abrdns.com` 路由就是活证据）。**短期不构成替代关系，但中期必须把「签名 + 自更新 + 依赖官方座位」这三件事补上，否则我们的相对价值会随官方桌面端成熟而收窄。**
11. **升到 0.1.7-rc.2 有两件必须先处理的具体后果**（详见 §6）：① **会话持久化格式升到 v4，降级不再可读**（官方文档原文 "V3 readers refuse the newer generation"）→ 我们的「回滚 = 换回旧版本」策略必须改成「升级前全量备份 + 还原」；② **侧边栏浏览器页会被上游按 profile 名门控停用**（`profileContext.name !== 'desktop'`），需要我们在 overlay 里显式 `disabled: false` 才能留住——**这是本次升级唯一一处用户可见功能回退**。另外三条「必须保留」的现状：`--max-http-header-size` 注入、陈旧 cookie janitor（上游零修复）、以及 hoisted 布局修复（上游模块解析机制已重写，需实测确认是否还需要）。

---

## 1. 对比前提（先把两边「现在是什么」说准）

### 1.1 官方 desktop 在 0.1.7-rc.2 的状态

| 事实 | 证据 |
|---|---|
| Electron 44 壳 + 打包内 Web 前端 + RunAsNode 宿主子进程；`dsh-app://app/` 加载页面，HTTP 由主进程转发，WebSocket 只给归属窗口带凭据 | 官方 README.zh.md:5；`apps/desktop/src/ipc.ts:84`（`SCHEME='dsh-app'`） |
| 默认端口 `19387`（与 Web 的 3080 分开），可用 `webserver.config.port` patch 覆盖 | 官方 README.zh.md:5 |
| dsh 版本**逐字等于**桌面版本；`apps/desktop` 与 `apps/desktop-host` 都是 `private: true`，**npm 上不存在** | `[已验证: curl registry.npmjs.org]` → `@deepseek-ai/dsh-desktop`、`@deepseek-ai/dsh-desktop-host` 均 404 |
| npm 上 `@deepseek-ai/dsh` 的 `dist-tags`：`latest=0.1.5-rc.3`、`next=0.1.7-rc.2`（2026-09-24 发布）、`alpha=0.1.7-alpha.2` | `[已验证: curl registry.npmjs.org/@deepseek-ai/dsh]` |
| 独占 `$DSH_HOME/profiles/desktop`；与 CLI 共享 `$DSH_HOME` 下会话/设置/凭据/工作区，但**绝不共享可执行包、插件激活、锁文件、node_modules** | 官方 README.zh.md:68,79 |
| 自持发布链：打包期物化 → 签名/公证 → 腾讯云 COS 上传 → 固定 Nightly 通道 feed；支持服务端强制更新 | s2 §1.2、§2.1-2.4、§4.2 |
| 本仓库**没有**桌面打包/签名 CI；「wine gate」只跑构建与站点、不编 NSIS 不签名、且不参与 PR 判定 | s3 §6.3、§6.4；`.github/workflows/` 零 desktop 命中 |
| 已知限制（官方自己写的）：账号登录尚未接入（登录按钮禁用）；Windows 材质待验证；签名/公证/托管/跨版本验收需生产环境；win32-arm64 宿主上载荷仍是 x64 | 官方 README.zh.md:434-441（另见 :408「真实 Harness 网关/API 联调及 macOS 登录验收仍未完成」——代码路径齐备但验收未完） |
| 只有 `mac-arm64` / `mac-x64` / `win-x64` 三个发布目标，**Linux 不是受支持目标** | `apps/desktop/scripts/desktop-auto-update-environment.mjs:25`；README.zh.md:206 |

### 1.2 我方 v0.11.0 的状态（一句话）

Tauri 2 + WebView2 的独立壳，**自带 Node 24、自建本地正向代理、运行时从 npm 装官方 dsh**，dsh 数据默认私有在 `<runtime>/dsh-home`（`scripts/server-manager.mjs:1256-1263`），版本地板 `MIN_DSH_VERSION='0.1.7-rc.2'`（`scripts/server-manager.mjs:64`），壳更新只报告不下载（`scripts/server-manager.mjs:494-568`），产物 windows NSIS + linux AppImage/deb、**无签名、无 macOS**。

### 1.3 一句话定性

> 官方在做**「一个产品的两种打开方式」**（Web 与桌面共享同一前端与同一宿主，桌面只是签名分发载体）；
> 我们在做**「一个第三方壳」**（dsh 本体是外部依赖，壳的价值在壳独有的网络/通知/插件/取证能力）。
> 因此**「谁抄谁」的问题问错了**——能抄的只有「与 Electron 无关的产品设计与客户端契约」，抄不了的是「打包期物化 + 私有宿主 + EV 签名 + 自有 CDN」。

---

## 2. 二十二个维度的总览表

「谁更优」一栏是**站在我方立场**的价值判断（不是中立描述），依据在该维度正文。

| # | 维度 | 官方（0.1.7-rc.2） | 我们（v0.11.0） | 谁更优 | 可否借鉴 |
|---|---|---|---|---|---|
| 1 | 发布身份 | 版本恒等（壳==dsh），一体更新单元 | 壳版本独立 + dsh 运行时可变 | 官方（一致性）/ 我方（时效性） | 部分（地板 + 快照已有） |
| 2 | dsh 来源 | 打包期本地 tarball 闭包 → asar，离线可用、首启零安装 | 运行期 npm 现装 + pnpm hoisted | **官方**（首启/离线/确定性） | 借不了（体积/发布权）→ 用缓存缓解 |
| 3 | 额外运行时 | Node 24.21.0 + pnpm + CPython 3.12.14 + wheels + LibreOffice | 仅 Node 24（`scripts/fetch-node.mjs`） | **官方**（agent 能力） | 可借（解包目录 + skill-office 已上 npm） |
| 4 | 宿主模型 | Electron 主进程 + RunAsNode 宿主，`--expose-internals` | `dsh web` 子进程 + WebView2 直连回环 | 官方（能力/隔离） | 结构不可借，机制可借 |
| 5 | 页面来源 | `dsh-app://` 特权 scheme + 主进程转发（cookie jar、筛头、插件 bundle `no-store`） | `http://127.0.0.1:<端口>/?token=…` | **官方** | 我们无等价物（Tauri）→ 缓解见 §3.3 结论与 §6.6 |
| 6 | 凭据传递 | 令牌不进页面；WS 握手在网络层注入 cookie/origin | 令牌在 URL；cookie 名绑端口 → 431 类问题 | **官方** | 可部分缓解（清 cookie + 64KB 已做） |
| 7 | 数据归属 | 共享 `$DSH_HOME`（会话/设置/凭据），独占 `profiles/desktop` | 私有 `<runtime>/dsh-home`，**不碰 `~/.dsh`** | 各有胜负 | 可加「共享模式」开关 |
| 8 | 渲染安全 | contextIsolation + 白名单 IPC + 主框架/属主校验 + 无 FS/IPC 暴露 | 页面只需 notification 权限，但**桥无鉴权** | **官方** | P0-2 |
| 9 | 壳 UI 契约 | `data-windows-titlebar` + CSS 变量，客户端原生避让 | 注入 shadow DOM + 800ms 探测 + CSS 变量自觉 | **官方** | P0-1（最划算） |
| 10 | 引导/凭据 | Welcome 三页 + 账号/API Key 双路径 + 内嵌 onboarding | 启动页（无凭据引导），配置在 Web 里做 | 官方（完成度） | 可借（轻量版） |
| 11 | 托盘/关窗/退出 | 托盘常驻；关窗隐藏需首次确认；退出前查任务（2s 超时） | 关窗隐藏无确认；退出不查任务 | 官方 | P1-3 |
| 12 | 通知 | 仅强更注意力通知（无完成通知） | 任务完成/待交互系统通知（自研插件） | **我方** | 无需改 |
| 13 | 崩溃取证 | crash-report 白名单 + 保留 10 份 + 原生恢复框三选一 | watchdog + Job Object + MiniDump + 外部 guard + WER 取证 | 各有胜负（我方深、官方 UX 好） | P1-4（恢复框） |
| 14 | 更新载体 | electron-updater + blockmap 差分 + COS | GitHub Releases 手动装；壳更新仅报告 | **官方** | P1-1（自更新） |
| 15 | 更新策略 | 10min 轮询 + 退避抖动 + 强制更新（服务端 40005） | 用户触发；地板闸门（devMode 冻结） | 官方 | 部分（轮询可借） |
| 16 | 安装器 | 自研 NSIS 页面 + C++ DLL + 目录改名事务 + 回滚 + 静默 | Tauri 默认 NSIS + `legacy-takeover.nsh` 静默接管旧版 | **官方** | 部分（事务化太重） |
| 17 | 卸载数据 | 无询问删 3 类（APPDATA/product、作用域目录、更新缓存），护 `DSH_HOME` | Tauri 默认勾选框（默认不勾 = 保留） | 各有取舍（我们更保守） | 不采纳官方口径 |
| 18 | 签名/公证 | EV Token + 缓存 + 阶段锁 + 预检 + DigiCert 时间戳；macOS 公证 | **无** | **官方** | P1-1 的前置 |
| 19 | 宿主专属能力 | primary runtime、office 技能、schedule、quit-inspection | 无（全靠用户自备环境） | **官方** | 可借（office 路线已验证可行） |
| 20 | 插件体系 | 全部经 Web 插件管理器 + 内置 pnpm；无预装第三方 | 4 个预装 bundle（版本锁定）+ 通知插件（`--patch` 注入） | **我方**（开箱可用） | 无需改 |
| 21 | 网络/代理 | 无用户可见代理配置 | 内置正向代理（逐主机路由、Basic、SOCKS5、防自环） | **我方** | 无需改 |
| 22 | 测试/门禁 | 135 测试文件 + 安装器夹具 + C++ 回归 + 真机 smoke（Windows） | 11 个 `test-*.mjs`（9 进 CI）+ Windows 真冷装 smoke + 8 个手工 ps1 | **官方** | P2（补接线与 CI 覆盖） |

---

## 3. 分维度详述

### 3.1 发布身份与版本耦合

**官方**：`apps/desktop/package.json` 的 version 必须与仓库根 `package.json`（即 npm 上的 `@deepseek-ai/dsh`）**逐字相同**，否则准备阶段抛错（`apps/desktop/scripts/prepare-dsh.ts:53-58`）；运行时描述符还要求 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-desktop-host` 的 version 等于 release.version（`apps/desktop/src/runtime-tree.ts:172-176`）。README 把这条写成产品规则：**「即使桌面壳代码不变，升级 dsh 也必须发布新 Desktop 版本」**（README.zh.md:65）。

**我们**：壳版本（0.11.0）与 dsh 版本完全解耦。壳里只有一个**地板** `MIN_DSH_VERSION='0.1.7-rc.2'`（`scripts/server-manager.mjs:64`），低于地板时启动自动升级（`1567-1581`），`devMode` 冻结该闸门；预发布（`next`/`alpha`）只提示、想升才升（`README.md:214`）。

**利**：官方换来「组合可验证」——壳 API、Web 客户端、后端、插件依赖图作为一个整体验证，不存在「用户装了一个从未测过的组合」。我们换来**时效性**：官方桌面包要等打包/签名/公证/上传四道门，我们可以当天把 dsh 的修复吃到用户机器上（本轮宿主机的 dsh 就是 npm 拉来的）。

**弊**：官方的代价是**用户拿不到 dsh 的独立修复**，且必须容忍「壳没变也要重下 ~200MB 级安装包」；我们的代价是**每次 dsh 升级都可能破坏壳的隐含契约**——本仓历史上已因此修过 8 类（`--patch` 路径空格截断、`?token=` 正则、端口绑定的 cookie 命名导致 431、pnpm isolated 布局黑屏、hoisted 残留嵌套包、`.modules.yaml` store 路径失配、`dsh.profile.bundles` 被重建丢插件、预装 bundle peer 门槛）。

**结论**：**设计正确，不要改**。但要把「组合可验证」的收益用别的方式补回来：地板 + 启动自检 + 预装 bundle 快照已经做了三件（`server-manager.mjs:646-656,964-1025`），建议再补一条 **「每次 dsh 升级后跑一次壳级契约冒烟」**（`test-control-plane.mjs` 已经有 11 个 manager 场景，把它接进升级路径即可，见 §5 P1-5）。

### 3.2 运行时来源与首启/离线

**官方**：打包期把 `@deepseek-ai/dsh` + 私有宿主 + 全部生产依赖闭包装好、物化进 `app.asar/dsh`，运行期**禁止**核心包从 registry 解析（`prepare-package-set.ts:30-31,139-158`、`src/core-package-set.ts:108-115,169-181`）；首次启动「不会把核心包复制到 profile 存储或通过 pnpm 安装核心包」（README.zh.md:97）。第三方外部依赖也在打包期由 pnpm 装好（`prepare-dsh.ts:125-143`）。

**我们**：首次启动用内置 pnpm 冷装 dsh（1~3 分钟，之后走 pnpm 缓存），并把 pnpm 11.24.0 懒装进 runtime（`scripts/server-manager.mjs:718-746,1450-1492`）。npm 只用于装 pnpm，**绝不用 npm 装 dsh**（它的解析器在 monorepo 形状的依赖树上会挂起，`REMARKS` 见 `server-manager.mjs:718-746` 与 8 类兜底表）。

**利**：官方**离线可用、首启秒开、版本确定性 100%**；我们**首启依赖网络与两个 registry**（npmjs + npmmirror 自动切换），首启体验受网络支配。

**弊**：官方要背一整套载荷（Electron + dsh 生产依赖树 + pnpm + Python + LibreOffice），并把「换 dsh 版本」变成「发版」；我们的成本转移到用户机器（网络、pnpm 兼容、store 布局），并且**用户可能长期不点更新**。

**结论**：结构不可借（我们没有打包内 dsh 的分发权与签名链），但**可借「确定性与首启体验」两条最小做法**：
1. 把「冷安装」从「首启必经」降级为「可预置」——例如把 dsh tarball 作为**可选资源**随包发布（本地 file 依赖，不签名也可用），命中即跳过网络安装；这与官方 `file:./desktop-packages/<file>` 的做法同构（`core-package-set.ts:108-115`）。
2. 首启把「正在安装 dsh」的事实与失败原因**明确摊开**（我们已经做了 install-status 心跳与 30s 提示，`src/app.js:146`）。

### 3.3 宿主进程与页面加载模型（含 431 问题的结构性解释）

**官方**：页面从 `dsh-app://app/` 加载（自定义 scheme，注册为标准/安全/可 fetch/CORS/stream，`apps/desktop/src/main.ts:128-138`），静态资源取打包 Web dist，其他路径**带 cookie 转发给宿主**；转发时删掉 `host/origin/cookie/sec-fetch-site` 再注入宿主 cookie，`redirect:'manual'`，并 **withhold** `set-cookie` 与连接级头（`transfer-encoding`/`connection`/`keep-alive`/`te`/`trailer`/`upgrade`/`proxy-*`），插件 bundle（`/plugins/*`）强制 `no-store`（`src/web-document.ts:58-92`）。WebSocket（`ws://127.0.0.1/*`）握手头在主进程 `onBeforeSendHeaders` 里被改写：补 cookie、把 origin 改成宿主 origin、`sec-fetch-site: same-origin`，只对主窗口、只对宿主 host:port 生效（`src/main.ts:665-676`）。宿主认证是「一次请求要求 303 + set-cookie，截取第一个 `;` 前的 cookie」（`src/web-document.ts:43-50`）。**宿主进程模型（S1 深挖的结论）**：全壳只有一个 `spawn` —— 宿主子进程就是 Electron 二进制 + `ELECTRON_RUN_AS_NODE=1`（`apps/desktop/src/host-process.ts:189-199`、`node-environment.ts:15`），它 **in-process 以库形式加载 dsh 内核**（`apps/desktop-host/src/index.ts:6,25` 的 `runProfile()`，子路径属 `apps/cli` 包），profile=`desktop`、端口硬编码 `19387`（`apps/desktop-host/src/index.ts:22-30`）；前端就是 `@deepseek-ai/dsh-web-frontend`（`apps/web`）的 dist，桌面**没有独立前端**（`src/main.ts:624`）；启动握手是页面调 `dshDesktopBoot.ready()` → 主进程回 `{injections, streamBaseUrl}` → 页面写 `__DSH_TRANSPORT__={ownsHost:true}` 后才开闸（`src/main.ts:640-645`、`apps/web/src/main.ts:22-35`）。也就是说：**官方桌面端不是「壳 + CLI」，而是「壳 + 同一个进程里的 dsh 内核」** —— 这解释了为什么它不需要任何 CLI 契约，也解释了我们与它的差距为什么是结构性的而不是努力程度的。

**我们**：`dsh web` 子进程监听 `127.0.0.1` 的**临时端口**（`--port 0`），WebView2 直接 `navigate()` 到带 `?token=` 的回环 URL（`scripts/server-manager.mjs:1285`、`src-tauri/src/lib.rs:2188-2238`）。由此产生三个必须在壳里打补丁的后果：
- **cookie 名绑 `host:port`**：`dsh-auth-<base64url(sha256(host:port))>`，而 HTTP cookie 不按端口隔离、且每轮端口不同 → 陈旧 cookie 单调增长 → 请求行+头超过 Node 默认 16KB → `431` → 全部客户端插件 import failed。现在是「导航前清陈旧 cookie」+「子进程 `--max-http-header-size=65536`」双保险（`lib.rs:2472-2566`、`server-manager.mjs:1269-1283`），并有上游 issue 与本仓实施记录。
- **令牌进 URL**：因此**页面内任意脚本（含同源第三方插件）都能读到它**——官方恰恰把这一条从设计上消除了。
- **导航兜底成为必需品**：页面渲染完成没有可靠事件，只能用「桥 `POST /alive`」当权威就绪信号（`lib.rs:1712-1722`），外加 1.5s 轮询兜底（退避 3/3/3/6/12/24→30s）。

**利/弊**：官方方案在**安全、缓存语义、凭据隔离、连接复用**四点上全面领先，代价是需要在主进程里手写一层 HTTP/WS 代理与头处理（约 `web-document.ts` + `main.ts` 若干百行），且**任何转发遗漏都会变成难查的页面级 bug**。我们的方案实现成本低、与 Web 版行为天然一致，但**把浏览器 cookie 语义的坑留给壳长期背**（我们已为此付出 3 个专门的修复与 1 个上游 issue）。

**结论**：
- **不采纳「特权 scheme + 主进程转发」**（Tauri 无等价物，且会重写整个加载层）。
- **采纳「就绪与凭据的最小契约化」**：把已经做对的 `/alive` 就绪信号绑窗口 nonce（KANBAN `card-bd47dc07` 已登记，未实现）；把 token 从 URL 迁到 **仅在导航瞬间注入、随后由壳删除**的短时凭据（`[假设]` 可行，需实测 WebView2 是否允许在导航后重写 URL 而不触发重载）。

### 3.4 数据归属与 profile

**官方**：与 CLI **共享** `$DSH_HOME` 下的会话、设置、凭据、工作区、存储；**独占** `profiles/desktop`（可执行包、插件激活、锁文件、node_modules 都不共享）。单实例锁在任何 profile 访问之前获取（`apps/desktop/src/single-instance.ts:16-26`、`main.ts:1280`），profile 锁用 `<profile>/lock` 存 PID + `process.kill(pid,0)` 探活（`src/project-manager.ts:93-130`）。

**我们**：`DSH_HOME` 默认私有在 `<runtime>/dsh-home`，**刻意不继承**环境里的 `$DSH_HOME`（`server-manager.mjs:1256-1263`），理由是「自包含 + 让 profile 的模块解析沿目录链向上找到注入的插件包」。

**利**：官方共享凭据 → 用户在 CLI 里配好的 API Key，桌面端打开即用，Welcome 只在「两条凭据路都没配」时出现（`welcome-api.ts:64-65`）。我们私有 → **绝不污染浏览器的 `~/.dsh`**，两个客户端可以同时跑不同 dsh 版本互不干扰（这正是我们历史上多次救场的能力：宿主机 dsh 0.1.6-alpha.1 与 shell 开发版的 dsh 各自独立）。

**弊**：我们的代价是**用户要把凭据配两遍**，而且「CLI 里的会话/设置」在桌面端看不到——这恰恰是官方 Welcome/账号登录整条产品线存在的理由。官方的代价是**与 CLI 抢 profile 的复杂度**（他们为此写了单实例锁 + profile 锁 + 「CLI 不能启动或修改此 profile」的硬规则）。

**结论**：**默认私有是对的（避免互踩），但要给一条明确的共享路径**。README 已写了「设 `DSH_HOME=~/.dsh` 并把通知插件装进该 profile」（`README.md:233-236,284-286`），但这是**手工且无引导**的。建议：在设置窗加「与浏览器版共享数据（实验）」开关，切换时自动补装通知插件并提示重启（成本低、收益直接，§5 P1-6）。

### 3.5 权限与安全模型（我们最实质的欠账）

**官方**（三层）：
1. **渲染层**：`contextBridge` 白名单 API，且都做**属主窗口 + 主框架**校验（`preload-app.ts` 全篇；`directory-picker.ts:14-18`、`microphone-permissions.ts:17-30`）。主接口只在 `dsh-app://app` 主框架暴露（`preload-app.ts:99`），明文写「任何渲染进程都不会获得文件系统访问、原始 Electron IPC、shell 或任意 pnpm 参数」（README.zh.md:81）。
2. **网络层**：凭据不进页面（见 §3.3）；浏览器访客 `<webview>` 用租约 + 分区校验，分区内权限全拒、**取消所有指向 DSH 宿主端口的请求**（`src/browser-guests.ts:70-153`）。
3. **策略层**：强更策略由服务端决定，DOM 只是展示层——「共享 DOM 只约束展示，不构成安全边界」（README.zh.md:410）。

**我们**：远程页只被授予 `core:event:*` + `notification:allow-notify`（`src-tauri/capabilities/remote-notifications.json`），这一点是克制的；但**壳的动作控制面是一套裸的环回 HTTP**：31 条 match（30 端点 + OPTIONS），响应固定 `Access-Control-Allow-Origin: *`，**无 Origin/token/nonce/CSRF 校验**，唯一带条件的是 `/devtools`（非 devMode 403）（`src-tauri/src/lib.rs:1693-1986`）。可调用者 = ① 页面内任意 JS（含第三方插件）；② 知道/扫到该临时端口的本机进程。危险动作包括 `/shell/quit`、`/restart`、`/update-dsh`、`/shell/disable-third-party-plugins`、`/window/*`。

**利/弊**：我们的做法换来「远程页无 IPC 也能被壳控制」的简单性（Tauri 不向远程页注入 `__TAURI__`，代码注释引用 tauri#11934，`shell-chrome.js:4-5`）；代价是**控制面等价于本机任意代码可调用**。官方为此付的代价是需要一个完整的主进程（约 6.8k 行 `src/*.ts`）。

**结论**：**必须修，且官方已经给出答案的形状**（危险动作走壳拥有确认窗 + IPC，而不是网络端点）。这也正是 KANBAN `card-29b6f966` 已登记的结论（「token 挡不住同源插件」）。新增建议（§5 P0-2）：即使不改 IPC，**也要先把「可被一次性重放的危险动作」加上壳内确认窗 + 单次 nonce**，并把 `/shell/quit`、`/restart`、`/update-dsh` 三个端点收进确认窗闸门。

### 3.6 窗口/壳 UI 与 Web 客户端席位（本轮最高性价比的借鉴点）

**官方**：
- 壳在页面上**手工设置**一个契约属性与变量：`document.documentElement.dataset.windowsTitlebar = ''`、`--dsh-windows-titlebar-height: 40px`（`apps/desktop/src/preload-windows.ts:12-13`，高度常量 `src/windows-layout.ts:4`）。
- Web 客户端**原生**消费该契约：`.frame` 预留 `padding-top: var(--dsh-windows-titlebar-height)`、侧栏列与拖柄整体下移、左上角 16px 圆角、并把发布 `--dsh-windows-sidebar-width` / `--dsh-windows-content-radius` 供全屏面板避让（`packages/client/ui-layout/src/client/AppFrame.module.css:26-54`、`AppFrame.tsx:263-264`、`ui-sidebar-right/README.zh.md:46`）。
- 侧栏把「侧栏开关」与品牌**搬进标题栏**，并据此切换 tooltip 方向与图标尺寸（`packages/client/ui-sidebar/src/client/SidebarRoot.module.css:39-83`、`SidebarRoot.tsx:112-117,187,272`）。
- 壳自己的菜单栏是注入的 shadow DOM，固定 `top:0; left: var(--dsh-windows-menu-start, 48px); z-index:1100`，且**等客户端发布 `[data-shell-overlay]` 席位后才挂载**（`apps/desktop/src/preload-menu.ts:11-27,89-97`）；打开原生菜单前后保存/恢复编辑器选区与焦点（`:31-51,66`）。
- 客户端另有 `shell.overlay` / `shell.leading` 两个公开客户端插件槽位（`AppFrame.tsx:30,255,289-294`，槽位目录 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:2733,2762`）。

**我们**：`include_str!` 编译期内嵌 + `on_page_load` 注入一段 1429 行的 `shell-chrome.js`（`lib.rs:31,3592-3608`）：自绘 36px 顶栏（`--dsh-shell-menubar-h`）、shadow DOM、`MutationObserver` 自愈、800ms 探针判断「是否有 `position:fixed` 且覆盖视口 ≥90% 的浮层」再收起菜单栏、顶缘 4px 悬停条唤出（`shell-chrome.js:772,823-862,444-450`）。历史上已因这套启发式出过「页面模态被误判全屏浮层而收起菜单栏」的 bug 并修复（Agent Note `2026-09-17-shell-menubar-modal-false-positive.md`）。

**利/弊**：官方靠**客户端为壳留座位**把「壳与页面互相踩」变成契约问题；我们靠**启发式**把同一问题变成概率问题——每加一个全屏插件/模态都要重新评估误判风险。反过来，我们的做法**零依赖上游**，官方桌面版本一变（席位改名/移除）他们自己也要改；而 `data-windows-titlebar` 这类契约目前**没有任何对外承诺**（它服务自有壳），我们采用它属于「吃上游私有契约」，有漂移风险。

**结论**（分两步，见 §5 P0-1）：
1. **立刻可做**：注入脚本里补一句 `document.documentElement.dataset.windowsTitlebar=''` + `--dsh-windows-titlebar-height: 36px`，让客户端自己把顶栏空间留出来、把侧栏开关搬进标题栏；我们的菜单栏对齐到 `--dsh-windows-menu-start`。**收益**：省掉现在的 padding 注入与一部分全屏误判；**风险**：顶栏高度与我们的 36px 一致即可，视觉差异需实机比对（`[假设]`：官方 40 DIP 含原生窗口按钮，我们无边框需自行核对）。
2. **同时保留启发式兜底**（不要删 800ms 探测与 `--dsh-shell-menubar-h`），因为契约可能随上游变化；并给这条依赖建一个**契约测试**（在 `test-shell-chrome.mjs` 里断言注入前缀包含该属性与变量，防漂移）。

### 3.7 引导与凭据（官方完成度最高的部分，也是最不值得照搬的部分）

**官方**：
- 原生 Welcome 窗口（600×700、不可缩放、macOS `vibrancy`/Windows `acrylic`），三页 `entry | key | account`（`src/client/WelcomePage.tsx:9,207-218`），只在 `!loggedIn && !hasApiKey` 时出现（`src/welcome-api.ts:64-65`）。
- API Key 路径：表单 → `welcomeBackend.save()` → 经认证 RPC `credentials/set` 写官方 provider 的 `apiKeyEnv` 引用（`src/welcome-backend.ts:123-134`）；「稍后配置」**不做任何持久化**，下次启动重新判断（README.zh.md:143）。
- 账号路径：浏览器外开 + 复制链接兜底 + `theme=` 跟随应用主题（`src/main.ts:196-200,1105-1111`）；状态流走自建 WebSocket（`src/account-backend.ts:89-121`）；**壳自己不保存任何凭据**（宿主 cookie 是主进程内存变量，`src/main.ts:375`）。
- Web 侧还有第二条 onboarding（4 步 welcome/credit/purpose/process，`packages/client/ui-settings-account/src/client/DesktopOnboarding.tsx:70-86`），并且「用 API Key 进来的用户整段跳过」并落 `completion:'api-key'`（`onboarding-state.ts:227-230`）。

**我们**：没有凭据引导。启动页只在启动/安装/失败态出现；用户在 Web 里自己配 provider。宿主机现状显示用户走的是**第三方 provider + 本地 relay**（`proxy.json` 的 `new-api.abrdns.com`、`anyrouter.top`），与官方「DeepSeek 官方 provider + 账号」路线根本不同。

**结论**：**不照搬账号/欢迎窗**（我们的用户不吃官方账号体系），但**借两条设计**：
1. **「未配置凭据时给出最小引导」**：我们可以在启动页加一条「未检测到可用 provider → 打开设置」的轻量提示（数据源可复用 `proxy.mjs:210-260` 已有的 `settings.yaml` provider 读取逻辑），不做独立窗口。
2. **「不做持久化的『稍后』」**：官方「稍后配置」不写完成标记、下次重判——我们若加引导，也应遵循同样纪律，避免用户被一次性关掉就永远不再提示。

### 3.8 托盘、关窗与退出语义

**官方**：
- 托盘**仅 Windows**、整运行期常驻、菜单只有两项（打开/退出），退出走与所有其他入口同一套确认流程（`apps/desktop/src/tray.ts:18-40`）；macOS 不提供菜单栏图标（README.zh.md:27）。
- 关窗 = 隐藏（页面与宿主继续跑，文档/会话/草稿/滚动位置保留）；**Windows 首次隐藏前弹一次性确认**，标记落 `<userData>/background-close-confirmed`，只有一颗「确认」按钮、`cancelId:-1`（Esc/关窗**不记录**确认）（`src/background-notice.ts:30-52`、`main.ts:940,1019-1027`）。
- 所有普通退出入口先问宿主「退出会打断什么」：`activeTasks`（运行中 agent，含子代理/等待审批/排队消息/running|stopping 后台任务）+ `scheduledTasks`（**仅本次运行已加载会话**里已挂定时器），**2 秒**截止；两者都没有 → 静默退出；**查不到/超时按「有运行中任务」处理**（宁可多问）（`src/host-process.ts:49,254-258`、`src/quit-confirmation.ts:15-21,71-74`、`apps/desktop-host/src/quit-inspection.ts:36-38`）。

**我们**：关窗 = 隐藏到托盘（Linux 退化为最小化，因为 GNOME 可能没有托盘），**没有首次隐藏确认**（`lib.rs:3853-3884`）；退出不查任务（`/shell/quit` 直接杀整树，`lib.rs:1942-1944`）。

**利/弊**：官方的「关窗语义 + 退出前任务检查」是**对用户数据的尊重**（避免静默杀掉正在跑的 agent）；我们目前隐藏后用户可能以为任务停了，或反之在退出时无提示地杀掉任务。代价方面，官方为此要求宿主提供任务谓词 RPC（`apps/desktop-host/src/update-tasks.ts`），我们若要等价能力，需要 dsh 侧有对应的活动任务查询面（我们用的是外部 CLI/HTTP 契约，**这个面我们没有**——属 `[未覆盖]`：本轮未核查 0.1.7 是否有等价的 HTTP/RPC 查询任务状态接口）。

**结论**：**采纳「关窗一次性确认」**（纯壳内实现，无上游依赖，§5 P1-3）；**「退出前任务检查」暂缓**，除非确认 dsh 对外暴露了活动任务查询（否则只能靠猜测，不如不做）。

### 3.9 通知与后台

**官方**：**没有任务完成通知**。`background-notice.ts` 是「首次隐藏确认」，不是通知系统；整个 `apps/desktop/src` 里 `Notification` 只出现一次——强制更新已就绪且窗口/模态都无焦点时的注意力提醒（`src/update-attention.ts:2,23-57`），且明确「从不 restore/focus 窗口」「提醒本身不授予任何授权」。README 还写了负向保证：**关闭窗口不发送系统通知**（README.zh.md:27）。

**我们**：自研客户端插件 `@dsh-desktop/client-notifications`（`--patch` 注入，不碰官方包），订阅 `ctx.sessions.list` 做三类通知：`pendingInteraction` 出现 → 「dsh 需要你」；`running` 真→假 → 异步查 turn/end 原因再决定文案；error 同类 3 分钟冷却；前台可见时抑制；首次见到会话只记基线不通知（`plugins/dsh-client-notifications/client.js:20-46,86-102,107-110`）。点击通知回到对应会话（壳侧 `LAST_SESSION`/`FOCUS_OPEN` + `GET /pending-open` 轮询）。

**结论**：这是**我们明确领先且官方没有的能力**，且实现方式（`--patch` 注入 + 不修改官方包）与官方的「薄壳」哲学不冲突。**无需改**。唯一风险是它依赖 `ctx.sessions.list`/`turn/end` 语义（脆契约之一），已被 `test-client-notifications.mjs` 的 391 行断言覆盖。

### 3.10 崩溃取证与自愈

**官方**：
- 崩溃报告**只写本地、不上传**：`app.getPath('logs')` 下 `crash-<ISO>-<source>.log`，`source ∈ host|web-boot|renderer|main`，错误段硬截 256KiB，宿主自报诊断 ≤64KiB，主窗 console 尾部 ≤64KiB；**保留最新 10 份**（`src/crash-report.ts:14,50,94-137,166-183`）。
- 致命失败：每进程只弹一次原生恢复框，三选一「退出 / 重启 / **停用第三方插件、备份 patch 并重启**」（`src/fatal-recovery.ts:65-104`），`EADDRINUSE` 换成「另一个 DSH 实例在跑」并只给两颗按钮（`:73,78-83`）；禁用插件 = profile 事务锁内把 `cordis.patch.yml` 改名为 `.bak-<timestamp>`（`src/project-manager.ts:76-78`）。
- 单实例锁在任何 profile 生命周期之前（`src/single-instance.ts:16-26`，`main.ts:1280`）。

**我们**：
- **取证更深**：Windows Job Object（kill-on-close + 逐进程日志，`job_object.rs`）、挂起进程 MiniDump（`web_dump.rs`）、`manager_guard` 退出码/日志尾/孤儿/WER 状态、`uncaughtException` 先写 `reports/manager-exception-*.txt` 再 exit（`server-manager.mjs:106-152`）、Node `--report-*` 落 `<runtime>/reports`、外部 guard 脚本。
- **恢复 UX 更弱**：服务异常退出后**绝不自动重启**（决定 D1，契约测试 `test-shell-chrome.mjs` 守着），只回启动页 + 显示退出码 + 「重试 / 停用第三方插件」两个按钮（`src/app.js:189-212,266-307`）。
- 有与官方同构的逃生口：`disable_third_party_plugins` 把 bundles 回退到两层模板，**改前必须先备份成功**（`lib.rs:3486-3526`）。

**利/弊**：我们的取证能力明显强于官方（官方只有文本报告 + console 尾；我们有 dump、Job Object、WER、外部 guard）；官方的**恢复闭环**更好（重启/禁用插件后重启一键完成，我们只给按钮且明确不自动重启）。这里还有一个差异：官方把「崩溃报告」与「更新 journal」分开，且**拒绝把 SIGINT/SIGTERM 当 clean exit**（README.zh.md:270）——与我们「退出码 1 语义天然二义」的问题是同一类困难，官方也没解决得更彻底。

**结论**：**保持不自动重启（D1）**，但**借「三选一恢复框」的形式**：把启动页失败态的「重试 / 停用第三方插件」升级为一个原生对话框（Tauri `dialog`）+ 第三个选项「打开证据目录并退出」。成本低（一个 dialog + 现有动作），收益是用户在「黑屏/起不来」时的操作路径与官方一致（§5 P1-4）。

### 3.11 更新体系

**官方**（完整闭环）：
- 传输：electron-updater + generic provider（`electron-builder-config.mjs:247`），NSIS `differentialPackage:true`、macOS 只消费 ZIP（`:162,166,244`）；固定通道 `nightly`、`allowPrerelease=true`、**显式禁止降级**（`src/update-coordinator.ts:67-70,185-186`）。
- 托管：腾讯云 COS，生产 origin 硬编码 `https://download.deepseek.com`，test 走 `DOWNLOAD_TEST_ORIGIN`；对象前缀 `dsh-desk/{feeds,bin}/<target>/`（test 插 32 位 hex 释放 id）（`desktop-auto-update-environment.mjs:16-23,140-156`）。
- feed：固定名 `nightly.yml`/`nightly-mac.yml`，稳定版另发 `latest.yml`；内容被重写为绝对 URL 的 `{version,files:[{url,size,sha512}],path,sha512}`（`desktop-upload-plan.ts:260-274`）。
- 校验：字节 sha512 + Windows Authenticode `publisherName`（期望值从**本地证书**推导，不取下载的 YAML）（`installed-update-signature.mjs:42-68`、`windows-sign.mjs:82-95`）；传输层只有 60s 空闲超时、无总时长上限（`update-http-executor.ts:11-52`）。
- 策略：10 min 基础间隔 + ±20% 抖动、失败翻倍退避到 1h、启动/唤醒/前台各触发（`update-schedule.ts:18-33,99-109`、`main.ts:867,1269`）；自动检查**不弹窗不下载**。
- 强制更新：服务端 `code===40005` 才阻塞、`0/0/null` 才解除、传输失败保留上次结论（`mandatory-update-policy.ts:112-125,201-204`）；Windows 用主窗内嵌 shell frame，macOS 用独立 overlay；Esc 不关、关窗改为退出应用；**第二次批准**才允许停任务（`mandatory-update-window.ts:52,82-92,197`）。
- 证据：`update-journal` opt-in JSONL，白名单字段 + 固定错误码（不落原文/URL）（`src/update-journal.ts:8-30`），由离线检查器按 10 个里程碑解析（`installed-update-qualification.ts:137-138,170-243`）。

**我们**：
- **没有 Tauri updater**（`src-tauri/Cargo.toml:15-18` 无该依赖、`tauri.conf.json` 无 `plugins` 段、全仓无 `createUpdaterArtifacts`；`server-manager.mjs:499` 明确「不产出也不依赖 `latest.json`」）。
- 壳自更新 = **只报告不下载**（A-1 一期）：查 GitHub `/releases/latest`（404 时回退 release 列表取第一个非 draft）、结果缓存 6h、dev 构建跳过、版本比较防降级，独立端点 `/shell-update-status`，**与 dsh 更新严格分离**（否则会出现「看到壳有更新、点下去却更新了 dsh」）（`server-manager.mjs:494-568`、`lib.rs:2329-2342`）。
- dsh 更新 = 用户触发（托盘/壳菜单），启动时只检查不安装；唯一自动升级是地板闸门（`server-manager.mjs:1567-1581`）。
- 分发 = GitHub Releases + 手动下载安装包；release-please 管三处版本 + CHANGELOG；release PR 只能 admin 合并、tag 由 API 创建不触发 workflow，必须手动 `gh workflow run build.yml --ref vX.Y.Z`（`CONTRIBUTING.md:59-89`）。

**利/弊**：官方闭环的收益是**用户侧的更新体验与可控性**（差分下载、静默检查、强更兜底、失败分类提示），代价是自持全套基础设施（COS + 凭据 + 签名）与固定 Nightly 通道（**没有 stable/rc 切换**，只有 test/production 两套部署）。我们的收益是**分发零基础设施**（GitHub 免费）、用户对版本有完全控制权，代价是**用户永远要自己去 GitHub 下载安装包**（壳只能提示），以及**无法强制修复**任何客户端问题。

**结论**：**自更新是当前最大的产品级短板**（也是 docs/2026-09-17 的 A-1 二期、当时建议暂缓的那件事）。现在的情况变了：官方已经用 `electron-updater + 签名 + blockmap` 证明了这条路的形态，而它的前置条件（代码签名）我们现在也没有。所以正确顺序是 **先签名（P1-1a）→ 再自更新（P1-1b）**，且自更新必须**先只做「下载 + 校验 + 交给安装器」**，不做差分（差分是省流量，不是必需品）。
**强更（mandatory update）明确不采纳**：我们的用户群是开发者自用/自建 provider，强更会直接破坏「把 dsh 停在任意版本」这一核心自由度。

### 3.12 安装器与卸载

**官方**（自研程度极高）：
- 每用户**硬拒绝**每机器（`/allusers` 或 HKLM 已有安装 → 退出码 2，`installer.nsh:33-44,79-84`）；可编辑安装目录走自研欢迎页（`allowToChangeInstallationDirectory:false`），路径校验一整套（固定盘、拒 reparse point 祖先、保留设备名、Windows/Program Files 自身、长度 4–180，`installer/path.nsh:4-116`）+ 归属校验（非空目录必须是已注册目录且含目标 exe）+ 写探针与空间预检（`path.nsh:126-167`）。
- 覆盖安装 = **同卷改名事务**：解到 `.new-<guid>` → 旧目录改名 `.old-<guid>` → 新目录上位，失败回滚（`installer-directories.nsh:30-60,73-93,95-127`）；`${isUpdated}` 时跳过欢迎页并最多等应用退出 10s，否则退出码 2（`installer.nsh:174-189`）。
- UI = NSIS + **自研 x86 C++ DLL**（`window-frame.dll`，`/LD /MT /O1 /W4 /WX` 编译）：去 NC 边框保 DWM 阴影/圆角、隐藏全部 NSIS 标准控件、GDI+ 自绘按钮/进度/复选框、16ms 重绘、7-Zip `-bsp1` 真实百分比驱动、阶段权重 `{0,2,94,96,98,99}`、成功才允许 100%、750ms 完成动画（`installer.nsh:68,122-130`、`window-frame.cpp:123,150-152,222-242,244-282`、`progress.h:31-53`）。
- 解压器被整体替换为随包投放并签名的 `dsh-7za.exe`（`windows-directory-installer.mjs:22-26,70-73`）；7-Zip 过滤器固定 `BCJ` 以兼容内置解码器（`package-target.ts:104`）。
- 解压失败：写 `%LOCALAPPDATA%\<updater-cache>\installer-logs\extract-failure-<时间戳>.log` + 自绘对话框（首行结论 + 复制 + 展开详情，上限 16MiB/160 字符/10 行），静默安装只落盘（`installer.nsh:135-149`、`extract-report.h:13-18,115,292`）。
- 卸载**不询问**、无条件删三类数据（`%APPDATA%\<product>`、Electron 作用域目录及空父目录、`%LOCALAPPDATA%\<updater-cache>`），**只保护 `DSH_HOME`**；占用文件留残留且**永不**中止卸载；清理器拒绝 shell 根/与安装目录或 home 重叠的路径、遇重解析点只 unlink 不进入（`installer/uninstall.nsh:12-36`、`uninstall-data.h:99-150`）。

**我们**：Tauri 默认 NSIS + `installMode: currentUser`，一个自研钩子 `legacy-takeover.nsh`（114 行）在安装时**静默接管旧版**：`ExecWait '"${LEGACY_DIR}\uninstall.exe" /S "_?=${LEGACY_DIR}"'`，并在文件头记录了 2026-09-09 的误杀事故与「勿回退成无条件 ExecWait」的负向约束（`legacy-takeover.nsh:11-14,56`）；卸载数据靠 Tauri 默认的「删除应用程序数据」勾选框（默认不勾 = 保留），我们已决策接受现状（Agent Note `2026-08-20-nsis-delete-data-checkbox-accepted.md`）。

**利/弊**：官方安装器是**产品级**的（事务化、可回滚、失败可诊断、进度真实）；我们的安装器是**上游默认 + 一个补丁**，好处是随 Tauri 升级自动维护、零额外 C++ 维护成本，坏处是**没有事务与回滚**（Tauri 直接往 `$INSTDIR` 写）、**失败只有一句错误**、并且**升级时的「删除应用数据」勾选框是我们已知的用户误操作风险**（已文档化）。

**结论**：
- **不抄事务化安装器**（fork 模板 + 自研 C++ 的维护成本对我们不划算——这一点在 2026-08 的决策里已经论证过，本次对比不改变结论）。
- **可抄一条最小做法**：在安装前检测「同级目录残留的 `.new-*`/`.old-*` 或半截安装」并给出可诊断提示（官方把「强制终止安装器/断电会留下 `.new-*`/`.old-*`」明确写进文档，README.zh.md:224）。我们已经有一整套「半截安装自动修复」（`server-manager.mjs:394-402`），把同样的检测前移到安装器会更早失败。
- **卸载数据口径不采纳官方**：官方无条件删 `%APPDATA%` 下产品数据，与我们「默认保留、勾选才删」相反。我们的用户数据里有大量自建 provider 配置与会话，保守是对的。

### 3.13 签名、公证与分发门槛

**官方**：
- Windows：硬件 SafeNet Token **串行**签名（`windows-sign.mjs:166-243`），签 `window-frame.dll`、`7za.exe`、appOutDir 全部 PE（只签 `NotSigned`、拒绝其他状态）、primary runtime 与 dsh 树（签后重封哈希清单）、NSIS 安装器/卸载器与 bootstrap 临时 exe；时间戳走 DigiCert RFC3161（`timestamp /tr http://timestamp.digicert.com /td sha256`，私有副本最多 3 次、每次验签、原子替换）。**内容寻址签名缓存**（`inputDigest=sha256(未签名字节)`，key 由 inputDigest + 证书/SignTool/三个签名脚本的哈希组成，**不含 PIN**；命中也要重验 Valid+时间戳+指纹）+ **账户级阶段锁** + **一次性探针预检**（编译一个永不执行的探针签一次）。
- macOS：临时钥匙串导入 p12 并前插搜索列表 + 逐 Mach-O `codesign --timestamp --options runtime`（只有 node 与 libreoffice-kit 加 `allow-jit` entitlement）+ DMG/ZIP 两份独立签名副本**并行公证**（`submit --no-wait` + `wait`，仅 Accepted 算过）+ 钉票与 `spctl` 终验 + 临时系统代理绕行（`macos-signing-keychain.mjs:48-84`、`macos-runtime.ts:43-45`、`logged-notarytool.mjs:46-73`、`package-macos.ts:89-129`、`macos-notarization-proxy.ts:151-217`）。
- 无证书路径：`DSH_DESKTOP_UNSIGNED=1` **仅 Windows**，产物名强制 `-unsigned`、不写更新配置、不签名但仍做 asar/PE 校验；签名构建缺任一凭据或 preflight 失败即整轮失败、不产出发布完成记录（`electron-builder.config.mjs:58-62,93,111,194`、`package-target.ts:441-449,499`）。
- **本仓库没有任何桌面打包/签名 CI**；「wine gate」是 master-only 的构建/站点作业（含 `apps/desktop` 的 tsdown），**不编译 NSIS、不签名、不参与 PR 判定**（`.github/workflows/ci-master.yml:44-48,116-121`、`scripts/wine-windows-gates.sh:252`、`ci.yml:695-699`）。

**我们**：**零签名、零公证**（`.github/` 全仓无 signtool/codesign/notarize；`README.md:323` 明说会触发 SmartScreen「未知发布者」）。安装包由 GitHub Actions 在 `windows-latest` 上 `tauri build` 出 NSIS，断言「安装器内含 node runtime」并跑真冷装 smoke 后挂 Release。

**利/弊**：签名对**用户信任**（SmartScreen）、**企业环境可安装性**、以及**自更新的前置条件**都是硬需求；官方的三层门禁（打包门禁 / 上传前离线校验 / 人工 in-place 升级演练）说明他们已经为此付出很高成本。我们的现实约束是：**我们没有 EV 证书**，也没有 COS/公证的凭据与发布机；但「一个 OV/EV 证书 + signtool + GitHub Actions secret」在国内是可采购的。

**结论**：这是**唯一一件「花钱就能追上、不花就一直落后」的事**。建议按成本排序推进（§5 P1-1a）：① 买代码签名证书（OV 即可让 SmartScreen 过渡期可用，EV 立刻生效但需硬件 Token）→ ② CI 里对 exe/安装器签名 + 时间戳 → ③ 再谈自更新。**不抄**签名缓存/阶段锁/探针预检那套复杂度（那是「每天多次签名构建」的团队才需要的优化）。

### 3.14 桌面专属宿主能力（官方最强的一块，也是最贵的一块）

**官方**：
- **primary runtime**：打包期下载并 sha256 校验 Node 24.21.0 + pnpm + CPython 3.12.14 + 一批 wheels（numpy/pandas/python-docx/python-pptx/openpyxl/Pillow/lxml/XlsxWriter），锁在 `scripts/primary-runtime/lock.json:2-4`；`load_workspace_dependencies` 工具首次使用时**离线安装**到 `$DSH_HOME/dsh-runtimes/dsh-primary-runtime` 并返回解释器/库/pnpm 脚本的绝对路径（README.zh.md:53-59）。
- **office 技能**：默认注册 `office-docx`/`office-pptx`/`office-xlsx`，用随包 Python 库创建与定点编辑文件，交付前重开 + 跑共享结构检查器；有 LibreOffice kit 时可 `render_document` 做视觉检查与 PDF 转换（README.zh.md:55；装配点 `apps/desktop-host/src/office.ts:28-37`）。
- **宿主自挂 4 项**：office 插件、更新准入锁（connection/request 503）、退出巡检、平台会话发布（`apps/desktop-host/src/index.ts:93-102`）——注意都是**宿主侧 cordis 插件**，通过 `runProfile()` 以库形式挂进同一个 Node 进程。
- 关键的技术事实：**宿主不是子进程跑 CLI，而是 Electron RunAsNode 子进程 in-process 加载 dsh 内核**（`host-process.ts:189-199` + `apps/desktop-host/src/index.ts:6,25`，`runProfile()` 来自 `@deepseek-ai/dsh/profile-boot`，该子路径属 `apps/cli` 包）——全壳只有**一个** spawn。

**我们**：**完全没有这一层**。宿主是 `dsh web` 子进程（CLI 文本契约），我们注入的唯一宿主侧内容是 `--patch` 里的一行客户端插件条目（`resources/patch/dsh-desktop.patch.yml:8-10`）。用户需要 Python/Office 能力时只能自己装。

**利/弊**：
- 官方的收益是**开箱即可让 agent 处理 Office 文档与数据分析**（这是「桌面版比浏览器版强在哪」的核心卖点之一）。
- 官方的代价是**巨大载荷**（Electron + Python + wheels + LibreOffice 原生引擎）与**跨平台构建复杂度**（每个目标要下对应 wheel/引擎，macOS 还要给每个 Mach-O 签名 + JIT entitlement）。
- 好消息（本次验证）：**这条路对我们部分可行**——`@deepseek-ai/dsh-skill-office`（0.1.6-alpha.2）与 `@deepseek-ai/libreoffice-kit`（0.1.1）**都发布在 npm 上** `[已验证: curl registry.npmjs.org]`，且官方等价的 `apps/desktop-host` 源码只有 **342 行**（`src/*.ts`：122+44+38+36+40+62，另有 4 个测试文件）。唯一 Electron 专属的是 `app.asar → app.asar.unpacked` 的引擎路径重写（`office-engine.ts:12-15,27-41`）——我们以解包目录发布 resources，这段可以整段不要。
- 坏消息：**我们无法 in-process 挂宿主插件**（我们是 CLI 子进程），只能靠 `--patch` 注入宿主侧 cordis 插件——`[假设]`：`--patch` 的 `insert` 是否允许宿主侧（非客户端）插件条目，本轮未验证（**这是一个值得做的 spike**，见 §5 P2-1）。

**结论**：**不做 Python/Office 全量载荷**（对「个人开发者的第三方壳」性价比太低，且会让我们每次发版都背上跨平台构建坑）；但**做一次 spike 验证 `--patch` 注入宿主侧插件的可行性**，因为它是我们通往「壳级宿主增强」（例如任务/计划查询、文件对话框、退出任务检查）的唯一通道——一旦可行，§3.8 的「退出前任务检查」和 §3.11 的部分能力都可能以插件形式补齐。

### 3.15 插件体系

**官方**：桌面 profile 的插件全部经**共享 Web 插件管理器** + **内置 pnpm**（README.zh.md:70,102-105）；首启不复制核心包、profile 只装外部插件；原生兼容性问题在加载时报错、可通过 pnpm 修复；宿主起不来时仍有原生恢复可禁用第三方 bundle。**没有任何预装第三方插件**（桌面模板里只有核心两层 bundle：`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，`apps/desktop/src/project-manager.ts:32,142,167`）。

**我们**：**4 个预装插件 + 1 个自研通知插件**，是本壳相对官方的最大「开箱能力差」：
- 预装（版本锁定随壳发布）：`dsh-kanban 0.2.8`、`dsh-model-reasoning 0.2.4`、`dsh-turn-navigator 0.4.4`、`@karoc/dsh-smoothly-opencode-session 0.2.0`（`plugins/preinstalled/*/package.json`）。
- 机制：`ensurePreinstalled` 把 resources 拷进 `<runtime>/node_modules/<包名>`，**刻意不进 profile dependencies**（这样 `dsh plugin` 的 reconcile 既不会自动启用也不会删掉它们），包名列表写进 `<runtime>/dsh.json` 的 `preinstalled`（`server-manager.mjs:940-947,1051-1080`）。
- `PROTECTED = ['@dsh-desktop', ...从各 bundle package.json 派生的顶层目录]`（**派生而非第二份硬编码清单**），安装 dsh 前后 copy 到 `.plugin-backup` 再恢复，防 npm/pnpm prune（`server-manager.mjs:697-790,1027-1049`）。
- 用户启用状态真源是 dsh 自己的 `dsh.profile.bundles`（壳不另存）；升级前快照、升级后补回（`server-manager.mjs:964-1025`）。

**利/弊**：官方的形态是「干净的零预装 + 全靠插件市场」，代价是**新用户第一次打开什么都没有**；我们的形态是「开箱 4 个可用插件」，代价是**每次发版都要同步 4 个包 + 处理 peer 门槛**（`[已验证: 0.1.7 起 bundle 声明 >=0.1.7-rc.1 的可选 peer，dsh 兼容门禁会拒绝不满足的包]` → 地板与 bundle 必须同批抬）以及**用户不能通过界面把预装包升级到 npm 最新**（README 已把这条列为能力边界）。

**结论**：**保持预装路线**（这是我们的差异化），但补两条卫生：
1. **预装包与地板版本必须成对抬升**这条纪律目前写在 README 与代码注释里，建议加进 CI 断言（例如：`test-control-plane.mjs` 已有版本地板场景，可扩一条「bundle peer 声明 ≥ 地板」的断言）。
2. 给预装包一条**用户可自升级**的逃生说明（现在是「卸载后重装」），可考虑在「关于」弹窗里显示 4 个预装包版本，方便用户与 npm 对比（成本极低）。

### 3.16 网络与代理（我们明显领先）

**官方**：**没有用户可见的代理配置**。`[已验证: grep -rn "proxy" apps/desktop/src/*.ts]` 只命中两处——更新传输器继承 electron-updater 的代理处理（`src/update-http-executor.ts:5-12`）与转发时筛掉的 `proxy-authenticate/proxy-authorization` 头（`src/web-document.ts:61`）。打包链有 macOS 公证代理与下载代理，但那是**发布机**的事，与用户无关。

**我们**：manager 进程内嵌一个**正向代理**（HTTP + CONNECT + SOCKS5 上游 + Basic 认证），支持**逐主机路由**、实时读配置（改完即生效、不需重启 dsh）、loopback 目标永不走上游、指回自己的上游视为禁用（`scripts/proxy.mjs`，494 行；`test-proxy.mjs` 435 行 12 场景 + `test-proxy-e2e.mjs` 端到端）；配置来自 `<runtime>/proxy.json`，主机清单从 `settings.yaml` 的 provider `baseURL`/`displayName` 派生 + 实测流量（`proxy.mjs:210-260`）；入口在壳菜单「代理设置…」与托盘。

**利/弊**：这是**唯一一项「官方做不到而我们做得好」的基础设施能力**，而且对国内用户是刚需（宿主机 `proxy.json` 的实际路由就是活证据：`anyrouter.top`、`new-api.abrdns.com` 走上游 `127.0.0.1:20172`）。官方用户若用第三方 provider + 需要分流，只能靠系统代理/TUN，粒度与可控性都差一档。代价是我们多维护 500 行代理代码 + 一个设置窗。

**结论**：**保持并写进 README 的卖点**。建议只补一条：代理的**失败可见性**（路由命中但上游不可达时，用户在壳里能看到「哪个主机走了代理、失败原因」）——目前只有日志。

### 3.17 平台与本地化

**官方**：`mac-arm64`/`mac-x64`/`win-x64` 三个发布目标（`desktop-auto-update-environment.mjs:25`），**Linux 明确不是发布目标**；壳文案 en/zh-CN 双语（`src/locale.ts:288-299`），启动解析顺序 = 共享设置 `locale.preference` → 系统语言 → 英文兜底（`resolveDesktopStartupLocale`）；自动选择的语言**不写偏好**；Platform 内嵌页语言 `en_US`/`zh_CN`（`platform-ipc.ts:12`）；macOS 用 `CFBundleLocalizations` 声明支持英/简中。Windows 上还有一条**反向通道**：页面把 `document.documentElement.lang` 回传，用于菜单/恢复/更新提示（`preload-windows.ts:40,45`）。

**我们**：Windows 主目标（NSIS）+ Linux（AppImage/deb），**macOS 代码路径存在但从不打包**（`node_rel_path()` 有 darwin 分支 `lib.rs:1992-2006`，`bundle.targets` 无 dmg，CI 无 macOS job）；壳文案**只有中文、硬编码在 `shell-chrome.js` 的 `SHELL_MENUS` 里**，无 i18n 层。

**利/弊**：官方 i18n 与其 Web 前端语言联动（跟随设置、运行中切换、Platform 页跟随）；我们只有中文，若未来面向英文用户需要重做菜单层（目前是常量数组）。官方放弃 Linux，我们反而在 Linux 上有产物（虽然 Linux 侧没有托盘语义、关窗退化为最小化，属于「尽力可用」）。

**结论**：**中文单语可接受**（目标用户是中文开发者），但建议把 `SHELL_MENUS` 的 label 抽成字典对象（**纯结构改动、成本分钟级**），为将来 i18n 与「菜单文案随页面语言变化」留出接缝。**macOS 不做**（无签名/公证链则 macOS 上寸步难行）。

### 3.18 测试、门禁与开发体验

**官方**：`apps/desktop` 135 个测试文件 + `apps/desktop-host` 4 个；安装器有 PowerShell + C++ 双夹具（用**生产 NSIS 配置**编译独立测试载荷、支持 `--signed`）；本地更新资格用真 `NsisUpdater` + 私有回环服务器跑负向对照（错误 publisher 必须被拒、字节损坏必须在验签前失败、4 种差分场景回落完整下载）；开发入口 `dev:desktop` 一次性构建 + 一次性 npm 项目 + 隔离 home + 调试端口 9229/9222/9230（README.zh.md:119-133）。

**我们**：`npm test` 9 套（`test-*.mjs`，共 11 个脚本，2 个未接线）；CI 五 job；Windows job 有**真冷装 dsh 的 runtime smoke**（这是我们的「运行时门禁」，与官方安装器夹具同级）；**缺口清单**：`test-broken-install.mjs`、`test-install-stall.mjs` 存在但未接线；`package.json:23` 的 `test:console-window` 指向**不存在的** `scripts/test-plugin-console-window.mjs`（插件管理移除时漏删）；`cargo fmt --check` 被注释掉；8 个 `verify-*.ps1`（Windows 实机行为验证）**零 CI 门禁**；无 e2e 驱动真实 WebView2 UI。

**结论**：差距是**量级的**（官方 135 vs 我们 11），但更值得补的是**孤儿与断链**（§7.2 已列，属「发现即修」级别），以及**把 Windows 行为验证接进 CI**（官方也只是人工 smoke，我们与官方在同一条船上）。

### 3.19 可维护性与「脆契约」账本

我方对 dsh 的依赖面（`[已验证: s5 §5]`）：CLI 参数 `web/--patch/--no-open/--host/--port/--home`、`dsh --patch` 的**参数顺序语义**（`--patch` 必须排在 web-app 参数之前，否则被透传）、URL 形状（含 `?token=`）、**cookie 命名规则**（绑定 `host:port`）、`<runtime>/dsh-home/profiles/web/package.json` 的 `dsh.profile.bundles`、`settings.yaml` 的文本结构、`lib/bin.js` 入口路径、pnpm 的 `--node-linker=hoisted` 行为与 hoisted 残留、`window.__ModuleLoader__.load` 与 `ctx.sessions.list/open` 客户端 API、`dsh.client.platform: web` + `exports["./client"]` 的 bundle 提供方式。

对照官方：这些「内部实现」它全是**同仓调用**（`runProfile()` 库形式 + 共享包），只有 `hostProtocolVersion` 一个显式协议版本号需要维护（`src/release.ts:7-14,21-34`）。**这就是「外部壳 vs 内部壳」的本质代价**：我们用 8 类兜底补丁（`server-manager.mjs:394-402,404-457,606-644,697-790,964-1025,1240-1255,1269-1283` + `lib.rs:2472-2566`）换取「不依赖官方发布节奏」的自由。

**结论**：**接受这个代价**，但要把账本变成机制：把「脆契约清单」升级为**每次 dsh 升级后自动跑的契约测试**（§5 P1-5），并给客户端插件 API 依赖（`ctx.sessions.*`、`__ModuleLoader__`）单独一门断言（现在只有通知插件的 391 行单测，是**桩**，不是真实页面 —— `[已验证: test-client-notifications.mjs 用 vm/桩 DOM]`）。

### 3.20 官方桌面端与 dsh 主体的耦合面（为什么差距是结构性的）

来自 S1/S6 的关键事实：
- **官方桌面与 Web 的宿主插件树是同源的**：`apps/desktop/src/project-manager.ts:32` 直接取 `PROFILE_TEMPLATES.web`，`:142/:167/:175` 把它写进 desktop profile 的 `dsh.profile.bundles`；而 web 模板就是 `['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']`（`packages/boot/app-boot/src/profile.ts:183-185`）。**差距不在插件树，而在三处宿主外能力**：① Electron/宿主在**进程内**持有 boot 后的 `ctx`；② 页面源是 `dsh-app://app` 而不是 `http://127.0.0.1:<port>`，所以有 preload 全局桥；③ 一批 Electron 原语 IPC（退出取证、更新准入、平台会话凭据、托盘/单实例/协议处理器/自更新）。
- 官方桌面端依赖的 workspace 包里，**只有 5 个进运行时 `dependencies`**（electron-updater/semver/ws/dsh-api-gateway/cordis），其余 workspace 包（`dsh-app-boot`、`dsh-home-paths`、`dsh-deepseek-account` 等）**全部在 devDependencies 里被内联进 `lib/main.js`**（`apps/desktop/package.json:40-46`、`tsdown.config.ts:16,37-38`）——即桌面壳直接消费内部包的**源码级 API**。
- 私有的 `@deepseek-ai/dsh-desktop-host`（**总计只有 342 行**）就是把宿主专属能力挂进内核的那一层：office 插件、更新准入锁、退出巡检、平台会话（`apps/desktop-host/src/index.ts:93-102`）。它的 12 个 workspace 依赖**全部是 npm 公开包**（逐个核 `publishConfig.access`）——**它不是「秘密 API」，而是一份可读的小组合**；唯二不公开的是两个 app 本身（`scripts/check-workspace-constraints.ts:59,61-62`；`[已验证: curl]` 两个包在 npm 上均 404）。
- 由此产生一条**策略级判断**：`@deepseek-ai/dsh` 公开导出 `./profile-boot`（`apps/cli/package.json:154-158`，README 明写「供 Desktop host 的生命周期」），而 `runProfile` 接受 `resolvedProfile` 会**跳过 `desktop` 名的 CLI 封锁**（`apps/cli/src/profile-boot.ts:203-204`，官方测试自证 `apps/cli/tests/resolved-profile-boot.spec.ts:69-72`）。也就是说「进程内嵌入」在技术上可行，但那是**换掉我们壳的整个宿主模型**，不是本次报告建议的方向（§5「明确不做」）。
- 前端侧的桌面感知**不是 flag，而是一组 `globalThis` 契约**：`dshDesktopBoot`（`apps/web/src/main.ts:5-11,21-36`，全文唯一分支点）、`dshDesktop`（含 `updates`/`keyboard`/`shortcuts`）、`__DSH_LOCALE__`、`dshOnboarding` + `dshPlatform`、`__DSH_DIRECTORY_PICKER__`、`__DSH_HOST_PATHS__`（生产端 `apps/desktop/src/preload-app.ts:61,75,81,84,88,99,102`）。官方**自己的 e2e 用 init script 注入最小集合**就把普通网页变成桌面页面（`apps/web/tests/desktop-onboarding.e2e.ts:88-97`、`desktop-updates.e2e.ts:34-41`、`shortcuts-desktop.e2e.ts:47-67`、`desktop-locale.e2e.ts:35-52`）——**这就是官方自证的可复刻 seam**，对我们的含义见 §5 P0-3 与 §6.6 的三条陷阱。
- index 注入这一层**我们已经等价**：桌面走 IPC 拿 `ctx.webServer.collectIndexInjections()`，我们走 HTTP，服务端已把同一批注入渲染进 HTML（`packages/host/webserver/src/index.ts:361`、`injections.ts:96-119`）。

**对我们的含义**：官方桌面端能「顺手拿到」的能力（任务巡检、宿主插件、席位、模板 bundle），我们只能通过**已经发布到 npm 的包**或**`--patch` 注入口**去争取；其余一律不可得。**因此我们的路线只能是「契约层最大化 + 壳层自足」，而不是逐项对齐官方功能面。**

### 3.21 键盘、深链与原生集成（容易被漏掉的三块）

**键盘/快捷键**：官方把快捷键做成**壳级原生能力**：`before-input-event` 拦截主文档 + 内嵌 iframe + 浏览器访客，支持单键与**双键组合（chord）**，识别录制态 / 输入法组合 / dead key / auto-repeat，窗口失焦或覆层阻挡时重置；绑定持久化在 `app.getPath('userData')/keybindings.json`（原子写、`0o600`、目录 `0o700`、profile 名 `desktop`），菜单里的「关闭页面或窗口」加速键由用户当前绑定决定（`apps/desktop/src/keyboard.ts:18-39,48-49,95,139-178,199-202,242-249`、`keybindings.ts:17,25`）。可配置绑定来自共享包 `@deepseek-ai/dsh-client-shortcuts` 的协议类型。

**我们**：**没有壳级快捷键拦截**，只有窗口控制（最小化/最大化/关闭/拖动）与 Web 应用自带的快捷键。用户可见的差异是：官方可以在「浏览器 guest / 内嵌 frame / 编辑器」之前统一拦截并保证不与输入法冲突，我们完全依赖页面自身行为；一旦 dsh 前端改了快捷键或用户在 iframe/guest 里操作，行为不可控。

**结论**：**不抄整套键盘服务**（它需要与客户端快捷键服务协议对接，且官方那套是为「原生菜单加速键 + 多 frame 拦截」服务的，我们没有原生菜单行列）。但值得记一条低优先项：给「关闭窗口/刷新/重启服务」这类**壳动作**注册真正的全局加速键（Tauri `global_shortcut` 或窗口级 `on_menu_event`），让用户能用键盘而不是只能点菜单（P2-6）。

**深链**：官方注册 `dsh://open`，只显示窗口、不传凭证；打包应用重新注册为默认处理器，开发版通过临时签名的 `Harness Dev.app` 在 `Info.plist` 声明并注册（README.zh.md:445）。**我们**：有单实例插件（`tauri-plugin-single-instance`），但**没有自定义协议/深链**——「第二次启动」能把窗口带到前台（因为单实例回调），但外部链接无法唤起到具体会话。

**结论**：我们已有的「通知点击 → 打开对应会话」链路（`/pending-open` 轮询 + `ctx.sessions.open`）其实**已经具备深链的能力内核**，缺的只是协议注册与参数解析。若将来要做 `dshsd://session/<id>`，成本主要在 Windows 注册表与协议白名单，属 P2-7（收益：从浏览器/其他应用直接跳到某个会话）。

**其他原生集成**：
- **目录选择器**：官方用 Electron 文件夹对话框并绑窗口（`directory-picker.ts:12-29`）。**但我们不需要做**：dsh 自身的 `directory-picker-auto` 会在「本地绑定 + 本地显示会话 + Windows」时选 `native` 后端，主机侧用 koffi COM `IFileOpenDialog`（还带一次合成的 Alt 按键以确保前台激活）打开真实 Win32 对话框（`packages/host/directory-picker-native/src/index.ts:1-30`）；客户端 `ui-directory-picker-native` 只在存在 `globalThis.__DSH_DIRECTORY_PICKER__` 时优先用它，否则回落宿主选择器（`packages/client/ui-directory-picker-native/src/client/index.ts:20-24`）。**我们是后者**——功能对等、只是没有「父窗口绑定与 restore/focus」这一层体验优化。**这是本次对比中一个「看起来是差距、实际不是」的典型**。
- **麦克风权限**：官方把 `media` 权限收窄到「主窗口 + 主 frame + `dsh-app://app` + `audio` + macOS 系统已授权」（`microphone-permissions.ts:17-30`）。我们不做权限收窄（WebView2 默认语义）。`[未覆盖]`：我们在 WebView2 下语音输入是否可用未验证。
- **内嵌账号视图（用量/充值）**：官方用 `WebContentsView` + 按账号持久分区 + 每次打开前清 Cookie/存储 + 关闭后异步清理（`platform-view.ts:101-110,138-142,211-250`）。我们**没有**（我们的用户走第三方 provider，用量页在 Web 里）。**不采纳**。

---

## 4. 结构性差距：三类，不要混着谈

### 4.1 我们拿不到的（决定「不要照着做」的边界）

| 能力 | 官方实现 | 我们为什么拿不到 | 有无替代 |
|---|---|---|---|
| 打包内 dsh 运行时（离线、首启零安装） | tarball 闭包 → asar（`prepare-package-set.ts:30-31,139-158`） | 需要「发布权 + 签名 + 体积预算」；我们没有 dsh 的再分发授权判断，也没有签名链 | 可选资源包（本地 file 依赖）可部分替代 |
| 主进程级 HTTP/WS 转发与凭据注入 | `dsh-app://` scheme + cookie jar + WS 头改写（`main.ts:617-632,665-676`） | Tauri/wry 无等价的同源代理与网络层钩子（`[假设]`，未做 Tauri API 审计） | 只能靠「清 cookie + 放大头部上限 + 就绪 nonce」缓解 |
| 渲染进程零凭证 | 令牌不进页面 | 我们的 URL 必须带 `?token=` 才能登录 dsh web | `[假设]` 可做成「导航后擦除」 |
| 宿主侧插件（office/quit-inspection/准入锁） | in-process `runProfile()` 挂插件 | 我们是 CLI 子进程；`--patch` 能否注入宿主侧插件**未验证** | 做一次 spike（P2-1） |
| Web 客户端为壳预留的席位（`data-windows-titlebar`、`shell.leading/overlay`） | 客户端原生消费 | 席位服务的是官方自有壳，对外无承诺 | **部分可用**（P0-1，但需契约测试防漂移） |
| 桌面标记族（preload 全局桥） | `dsh-app://app` + contextBridge（`preload-app.ts:61,75,81,84,88,99,102`） | 我们没有 preload；但官方 e2e 自证这组契约可用 init script 注入 | **可复刻**（P0-3，必须成套注入，见 §6.6） |
| 拖拽/粘贴/选择文件 → `@真实路径` 引用 | `__DSH_HOST_PATHS__.pathFor(file)` = `webUtils.getPathForFile`（`preload-app.ts:81-83`） | Tauri 的 `File`/`DataTransfer` 拿不到真实绝对路径（`[假设]`，未实测） | **无替代**：非图片文件一律走 HTTP 字节上传（`ui-conversation/src/client/apply.ts:96-98,107` 有注释背书），大文件/大目录场景会明显 |
| EV 签名 + COS + 强制更新 | 完整发布链 | 无证书、无 CDN、无发布机 | 买证书 + GitHub Releases 自更新（P1-1） |
| macOS 产物 | 公证 + JIT entitlement + DMG/ZIP 双路 | 无 Apple 开发者账号与公证流水线 | 不做 |

### 4.2 官方没有的（我们的独有收益，别在借鉴中丢掉）

1. **内置逐主机路由正向代理**（§3.16）——官方零用户可见代理配置，这是国内环境的刚需，也是宿主机实际在用的能力。
2. **任务完成/待交互系统通知**（§3.9）——官方明确不做完成通知。
3. **4 个预装插件 + 版本锁定**（§3.15）——官方零预装第三方。
4. **Linux 产物**（AppImage/deb）——官方明确不支持 Linux 发布。
5. **版本自由**：用户可以把 dsh 停在任意版本（含预发布），官方必须整包升级。
6. **私有 DSH_HOME**：绝不污染浏览器版 `~/.dsh`，两个客户端可同时跑不同版本（宿主机实测：壳 runtime 是 0.1.6-alpha.1，而本会话的 checkout 是 0.1.7-rc.2，互不影响）。
7. **Windows 深度取证**：Job Object + MiniDump + WER + 外部 guard + manager 退出证据目录（官方只有文本报告 + console 尾）。
8. **dev/prod 同机并存**（`tauri.dev.conf.json` 覆盖 identity + 独立 binary 名）。
9. **不自动重启的退出纪律（D1）**：宁可让用户看到失败与证据，也不静默重启掩盖问题——这是官方「一键重启」UX 的对偶选择，各有代价。

### 4.3 同题不同解（容易盲抄错的五条）

| 议题 | 官方选择 | 我们的选择 | 判断 |
|---|---|---|---|
| 数据归属 | 共享 `$DSH_HOME`，独占 `profiles/desktop` | 完全私有 `<runtime>/dsh-home` | 都对；我们缺「可选共享」的入口 |
| 卸载数据 | 无询问删 3 类，护 `DSH_HOME` | 默认保留，勾选才删 | 我们更保守，**不改** |
| 失败恢复 | 原生三选一 + 一键重启 | 显示失败 + 重试/停用插件，**不自动重启** | 借形式（P1-4），保留 D1 精神 |
| 更新粒度 | 壳与 dsh 一体、差分更新 | 壳与 dsh 分离、全量安装包 | 一体化更强一致性与体验，分离更灵活；**短期保持分离** |
| 壳 UI 挂载 | 注入 + 等客户端席位 | 注入 + 启发式探测 | 我们该往「契约」靠（P0-1），但保留探测兜底 |

---

## 5. 建议清单（按性价比排序，每条带为什么现在）

### P0-1 采用官方顶栏契约 `data-windows-titlebar`（成本：小；收益：立刻消除一类误判与 padding hack）

- **做法**：在 `shell-chrome.js` 的注入前缀里补 `document.documentElement.dataset.windowsTitlebar=''` 与 `--dsh-windows-titlebar-height: 36px`；把菜单栏 `left` 对齐 `--dsh-windows-menu-start`；**保留**现有 800ms 全屏探测与 `--dsh-shell-menubar-h` 作为兜底。
- **为什么现在**：客户端已经原生支持（`ui-layout/AppFrame.module.css:26-54`、`ui-sidebar/SidebarRoot.module.css:39-83`），我们只需一句注入；而我们自己的 padding 方案已经出过一次「模态被误判」的 bug。
- **风险与验收**：需要 Windows 实机比对顶栏视觉（36px vs 官方 40 DIP 且官方保留原生窗口按钮，我们无边框自绘三键）；在 `test-shell-chrome.mjs` 加契约断言（注入前缀必须含该属性与变量）。

### P0-2 桥的危险动作收口（成本：中；收益：消除「本机任意代码可 quit/更新/禁用插件」）

- **做法（对齐官方）**：官方页面**无法**提供「更新版本 / 包 URL / 安装授权」，只能请主进程弹原生确认窗（`apps/desktop/src/ipc.ts:70`、`main.ts:741-744`）。我们把 `/shell/quit`、`/restart`、`/restart-dsh`、`/update-dsh`、`/shell/disable-third-party-plugins`、`/devtools` 六个动作改为**壳内确认窗 + 单次 nonce**；`/window/*` 保留（可恢复、无破坏性）。
- **为什么现在**：KANBAN `card-29b6f966` 已登记且未修；本次对比确认上游早已把这类动作放在 IPC 上，而且给出「页面不得持有授权」这条明确原则。**这一步与 §5 P1-1 的自更新是同一个前置**（自更新一旦上线，`/update-dsh` 类的无鉴权端点的风险等级会立刻上升）。

### P0-3 注入「桌面标记族」，解锁官方桌面专属 UI 分支（成本：小-中；收益：一次性打开多块能力）

- **做法**：用 WebView2 的文档创建期脚本注入（与现有 `on_page_load` 注入同源）一组 `globalThis` 契约，**成套给、不能只给一半**：
  - `__DSH_LOCALE__ = {read, onChange}` → 让客户端语言跟随壳（`desktop-locale.e2e.ts:35-52`）；
  - `dshDesktop = {protocolVersion:1, updates:{status,open,subscribe}}`（可选，仅当我们愿意实现更新呈现桥时）；
  - `dshOnboarding = {hasApiKey, setActive}` + `dshPlatform = {open,setBounds,close}` → **解锁整个账号设置区的 RPC 路径**（`ui-settings-account/src/client/index.ts:43,211`）。注意：我们不做 Platform 内嵌视图，因此这两个桥要么给「空实现 + 明确禁用」，要么**干脆不给**（§6.6 第 3 条：不给会走浏览器引导，是安全的默认）。
- **不要注入 `data-platform`**：该标记在本版本**只认 `darwin`**（全仓 `darwin` 命中 90 次，`windows`/`win32`/`linux` 零命中），注入 `'windows'` 是 no-op，注入 `'darwin'` 会在 Windows 上激活一整套 macOS 专属拖拽布局（`packages/client/web/src/base.css:55,67,72,89` + `recall.ts:63`）。Windows 侧真正能解锁布局的键是 `data-windows-titlebar`（P0-1）。若将来确实要给 `data-platform`，必须同时实现 `dshDesktop.keyboard` 桥，否则客户端 shortcuts 会直接抛 `Desktop keyboard bridge unavailable`（`packages/client/shortcuts/src/client/index.ts:46`）。
- **验收**：dev 版实测「设置页语言跟随」「账号区是否注册」两处行为；在 `test-shell-chrome.mjs` 加契约断言（注入的全局集合与 `preload-app.ts` 的清单不漂移）。**必须先做 spike 验证注入时机早于 `apps/web/src/main.ts:11` 的读取**（S6 不确定点 2）。
- **为什么现在**：这是官方**自己用 e2e 证明过**的可复刻 seam，而且我们已有注入通道；不做的代价是「普通 Web 页面」永远比官方桌面端少一截行为。
- **风险**：吃上游私有契约（无对外承诺），且**成套性**要求高——半套注入会造成「引导消失 / 账号区抛错」这类难查故障。建议先用最保守的一组（仅 `__DSH_LOCALE__`）试点。

### P1-1a 代码签名 → P1-1b 自更新（成本：大，需花钱；收益：用户信任 + 更新体验）

- **P1-1a**：采购 OV/EV 代码签名证书 → CI 里对 exe + NSIS 安装器签名 + RFC3161 时间戳。**不抄**官方那套签名缓存/阶段锁/探针预检（那是高频签名团队的优化）。验收：`signtool verify /pa` 通过 + 实机 SmartScreen 不再报「未知发布者」。
- **P1-1b（一期）**：自更新只做「检查 → 提示 → 下载到缓存 → 校验哈希 → 交给安装器静默安装」，**不做差分、不做强更、不自动安装**。官方的一期形态（`test-local-updater.mjs` + 本地回环 feed + 负向对照：错误 publisher 必须被拒、字节损坏必须在验签前失败）可直接作为我们测试设计的模板。
- **为什么现在**：这是唯一「花钱就能追上、不花就一直落后」的项；且它必须是 P0-2 之后做，否则给无鉴权控制面再加一个「下载并执行」的端点。

### P1-3 关窗首次确认（成本：小）

- **做法**：Windows 首次隐藏前弹一次性确认（Tauri `dialog`），文案「任务不会中断，可从托盘找回」，标记写 `<app_data>/background-close-confirmed`；Esc/关闭不记录。
- **为什么现在**：官方已证明这是「后台常驻语义」的必要告知（`background-notice.ts:30-52`）；我们现在是**静默隐藏**，用户可能以为应用已退出。

### P1-4 失败态原生三选一（成本：小）

- **做法**：把启动页失败态的「重试 / 停用第三方插件」升级为原生对话框 + 第三项「打开证据目录并退出」；沿用我们已有的证据目录（`lib.rs` 的 manager 退出取证）与「改前必须备份成功」的逃生口。
- **为什么现在**：官方把这条做成了首屏恢复闭环（`fatal-recovery.ts:81-86`），而我们已经具备全部底层能力，只差一层 UI。

### P1-5 dsh 升级后跑契约冒烟（成本：小-中）

- **做法**：把 `test-control-plane.mjs` 的 11 个 manager 场景（真 spawn manager + 假 dsh/pnpm）与「脆契约清单」绑定：`--patch` 参数顺序、URL 形状含 token、cookie 命名、`dsh.profile.bundles` 快照恢复、pnpm hoisted 布局探测。在**升级动作完成后、导航之前**跑一遍轻量版（例如「用新版本 dsh 起一个临时 profile 并断言 URL/补丁生效」），失败则回滚到旧版本 + 如实提示。
- **为什么现在**：我们把「组合可验证」换成了「版本自由」，就必须用机制补回验证（§3.1、§3.19）。

### P1-6 共享数据开关（实验）（成本：小-中）

- **做法**：设置窗加「与浏览器版共享数据（`DSH_HOME=~/.dsh`）」，切换时提示需要把通知插件装进该 profile（README 已有手工步骤），并在切换后校验 profile 可写。
- **为什么现在**：这是我们的「私有 DSH_HOME」与官方「共享」之间唯一缺失的桥；用户若想「CLI 配一次、桌面直接可用」，现在只能手改环境变量。

### P2 级（有空再做）

1. **P2-1 `--patch` 注入宿主侧插件 spike**：验证能否用 patch 挂宿主侧 cordis 插件（决定我们是否可能补齐「退出前任务检查」之类的宿主能力）。**这是本轮唯一一个「可能改变架构判断」的未验证项**，建议优先于其他 P2。
2. **P2-2 仓库卫生**：接线 `test-broken-install.mjs`、`test-install-stall.mjs`；删 `package.json:23` 断链的 `test:console-window`；恢复 `cargo fmt --check` 或明确写进 CONTRIBUTING 说明为何关闭。
3. **P2-3 菜单文案抽字典**：`SHELL_MENUS` 的 label 改为字典键（为 i18n 与「跟随页面语言」留接缝）。
4. **P2-4 预装包版本可视化**：「关于」弹窗列出 4 个预装包版本与 npm 最新对比（用户现在无法从界面知道预装包是否需要更新）。
5. **P2-5 代理失败可见性**：壳内显示「哪些主机走了代理、最近失败原因」。
6. **P2-6 壳动作的全局加速键**：给「刷新页面 / 重启服务 / 打开数据目录 / 退出」注册窗口级加速键（官方有原生菜单加速键；我们只有鼠标路径）。
7. **P2-7 深链**：注册 `dshsd://session/<id>`（或复用 `dsh://open` 语义），复用已有 `/pending-open` + `ctx.sessions.open` 链路，从浏览器/其他应用直接跳会话。

### 明确不做（附理由，避免后人重开议题）

| 不做 | 理由 |
|---|---|
| 改用 Electron 重写壳 | 我们 4.9k 行 Rust + 1.6k manager 已覆盖 Windows 深度集成；重写等于放弃 Job Object/MiniDump/代理/预装插件四条既有资产 |
| 打包内 dsh 运行时 | 无再分发授权判断 + 无签名链 + 体积/构建代价；用「可选资源包」代替 |
| 强更（mandatory update） | 直接破坏「把 dsh 停在任意版本」这一核心自由度 |
| 事务化自研安装器（C++ DLL + 目录改名 + 回滚） | 2026-08 已论证 fork 维护成本不划算；本次对比不改变结论 |
| Python/Office 全量载荷 | 跨平台构建坑 + 巨大载荷；改为「spike 宿主插件通道，能力交给插件生态」 |
| macOS 产物 | 无签名/公证链则寸步难行 |
| 无条件删用户数据（官方口径） | 我们数据里有大量自建 provider 配置与会话 |
| 签名缓存/阶段锁/探针预检 | 那是「每天多次签名构建」的团队优化，我们一版一次 |

---

## 6. 升级到 0.1.7-rc.2 的动作清单

> 本章依据 S7（`dsh-v0.1.6-alpha.2..dsh-v0.1.7-rc.2`，**1963 个提交**、626 个 merge、6783 文件变更）定向检索「壳依赖的外部契约面」得出；每条带依据与风险等级。

### 6.1 好消息：`dsh web` 的启动参数面零破坏

- `packages/bundle/web-app/src/startup.ts` 在该区间**零 diff**；参数族仍是 `--host` / `--port`（`0`=OS 选）/ `--no-open` / `--trusted-host`；启动 URL 行格式 `dsh web: <url> (LAN: <url>)` 未变（`packages/bundle/web-app/src/index.ts:271,274`）。
- `--patch <path>`（可重复、叠加在 profile layer 之后）语义不变（`apps/cli/src/args.ts:169`）；我们的 overlay 只做 `insert:`，**不引用任何上游 row id**，因此上游删行/改名对我们不构成失效。
- `dsh.client` manifest schema 逐字段未变；`dsh.bundle.patch` 从 `string` 扩展为 `string | string[]`（老写法合法）（`packages/util/package-manifest/src/types.ts:81-94`、`packages/boot/app-boot/src/profile.ts:59-62`）。
- **`dsh web:` 那一行是文档级承诺**：`packages/bundle/web-app/README.md:84` 写「supervisors RPC as soon as they observe the line」——我们的 URL 解析踩在正式契约上（`[已验证: 文档]`），只是「格式永不变」没有专门测试锁（S6 不确定点 3）。

### 6.2 阻断项（不处理就会出事）

| # | 动作 | 依据 | 为什么是阻断 |
|---|---|---|---|
| **B-1** | **把「降级」从回滚方案里删掉，改为「升级前全量备份 `$DSH_HOME` + 还原」** | 会话持久化格式升到 **v4**（`packages/session/session-format-catalog/src/generated.ts:17`），新增 `session-format-v3-to-v4`；官方文档写明 **"V3 readers refuse the newer generation"**（`docs/persistence-changes/2026-09-16-session-format-v4.md`） | 升到 0.1.7-rc.2 后写出的会话，**用 0.1.6 读不了** → 我们的「版本地板 + 手动更新」模型下，用户一旦升级就无法简单回退 |
| **B-2** | **保留 `NODE_OPTIONS=--max-http-header-size=65536` 注入** | 上游在 `packages/**/src`、`apps/**/src` 对 `max-http-header-size` / `maxHeaderSize` / `431` **零命中**（未做任何修复）；壳侧注入在 `server-manager.mjs:1279-1284` | 撤掉就回到 431 |
| **B-3** | **保留陈旧 `dsh-auth-*` cookie 清理** | cookie 名仍是 `dsh-auth-<base64url(sha256(authority))>`（`packages/client/connection/src/browser-auth.ts:16,69,106-107`），authority 绑 host:port + 我们 `--port 0` → 每次启动换名、旧 cookie 永不覆盖 | 同上，431 的另一半 |

### 6.3 需改项（要动壳的代码或配置）

| # | 动作 | 依据 | 影响 |
|---|---|---|---|
| **M-1** | **`ui-sidebar-browser` 在我们 profile 下会被停用**：该行新增 `disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"`（`packages/bundle/web-app/cordis.patch.yml`，commit `3eab1714bc`）。我们跑 `dsh web`（profile=`web`）→ 侧边栏浏览器页**从可用变为停用**。要保留须在 `resources/patch/dsh-desktop.patch.yml` 里加 `- id: ui-sidebar-browser` + `disabled: false` | 官方 `ui-sidebar-browser/README.md:28,36`；CLI 硬拒 `--profile desktop`（`apps/cli/src/args.ts:83-85`） | 用户可见功能回退（浏览器面板消失），**这是本次升级最需要主动决策的一条** |
| **M-2** | **核对 `dsh: pnpm failed` 字符串匹配**：rc.2 改为 `dsh: plugin command failed; diagnostics: <path>`（`apps/cli/src/plugin.ts`） | 若日志门禁/测试按旧文案断言会失配 | 低（但我们有大量字符串契约测试，需 grep 一遍） |
| **M-3** | **补一套「peer 兼容」自检**：0.1.7 新增插件 peer 闸门——manifest 里声明 `@deepseek-ai/dsh*` peer 且不满足当前 runtime 的插件会在 **profile 启动时被静默 `disabled`**（stderr 一行 `dsh: disabling profile plugin …`），`dsh plugin add` 还会在安装前直接拒装（`packages/boot/app-boot/src/plugin-compatibility.ts:61-88`、`compatibility-preflight.ts:79-84,114-118`、`packages/boot/plugin-manager/src/operations.ts:326-334`，commit `2c67633990`）。**我们的壳绕过 `dsh plugin add`、直接 pnpm install** → 拿不到「安装时拒绝」，但**绕不过「启动时停用」**；用户会看到「装上了、启用了、没效果」 | 壳的安装路径 `server-manager.mjs:745` | 中-高（新的静默失效模式）；对现有 4 个预装插件**当前无影响**（它们只声明 `react` peer，或根本没有 peer） |
| **M-4** | **确认 profile 目录里新增的 `compatibility.json` 不被我们的 profile 手术误删**（豁免记录文件，损坏时不阻断启动只警告：`packages/boot/app-boot/src/profile-compatibility.ts:10,64-70`） | 我们只重建 `profiles/web/package.json`（`server-manager.mjs:965`）并清嵌套残留，**未见删未知文件**——需复核 | 低-中 |

### 6.4 高优先级待验证（可能改变既有设计）

**V-1（最高）模块解析机制被重写**：上游删除了 `PROFILE_MODULE_FALLBACK_DIR` / `healProfilesModuleFallback` / `profiles/node_modules` 投影，改为**内存内** `createRuntimeResolution()`（注释原文 "without writing module-resolution files"，`packages/boot/app-boot/src/profile.ts:426-431`），`PluginPackages` 构造参数也从 `{generation, behavior}` 变为 `{resolution}`。

→ **我们的「pnpm isolated → hoisted 重链」修复（`server-manager.mjs:723-745,1552-1559`）是为旧解析路径修的，语义基础已变**：可能已不必要、可能有害、也可能黑屏换了触发条件。
→ **核验步骤（可失败）**：dev 版装 0.1.7-rc.2，分别用 `hoisted` 与 `isolated` 两种布局冷启，断言页面 mounted（用壳自己的 `/alive`）——两种布局都必须绿，才算结论成立。

### 6.5 仅需验证（预期无碍，但必须实测）

1. `--patch` 顺序与叠加仍生效（我们保持 `web --patch <f> --no-open --host … --port 0`）。
2. 启动 URL 仍带 token：`authenticatedUrl` 改为「保留 authority + mount」、303 落点 `'/'→'./'`——对 root mount（`localWebUrl()` 无尾斜杠）与旧行为**等价**，但壳有 URL watchdog（历史误判过一次）。
3. `/alive` 链路不受影响（**`/alive` 是壳自有端点，上游不存在就绪 HTTP 端点**；上游信号仍是 stdout 行）。
4. 4 个预装插件使用的槽位全部有效：`sidebar.panellist` / `settings.section` / `settings.general.item` / `conversation.session.header.utilities` 的 kind+scope 均未变；唯一被删的槽位是 `conversation.session.header.leading` → 改名 `conversation.header.leading`（引入 commit `8019d37d3f`），**我方（含通知插件）无人注册该槽**，但**「插件侧可选增强」卡里提到的 `plugins.*` 迁移现在多了 3 个新槽位可选**（`plugins.detail.actions|badge|section`；槽位总数 70 → 89）。
5. 新增 stderr 行（`dsh: skipping profile bundle "<pkg>"` / `dsh: disabling profile plugin …`）不得被壳的日志分类误判为致命。
6. 若文档/脚本引用 `@deepseek-ai/dsh-agent-presets` bundle 名，需更新（已改名 `agent-preset-registry`，presets 移入 `presets/*.patch.yml`）。

### 6.6 本轮新增的「负面约束」（别做）

- **不要为了复刻官方 preload 而把页面换成自定义 scheme**（如 `tauri://localhost`）：我们现在的 `http://127.0.0.1:<port>` 源天然满足 `isLoopback`，这是 settings 文档编辑等能力的**前提**；官方因为源是 `dsh-app://app` 反而要显式声明 `ownsHost=true` 才能把 `isLoopback` 拿回来（`apps/web/src/main.ts:26`、`packages/client/connection/src/client/index.ts:96-104,248`）。**我们这一行反而占优**。
- **若注入 `dataset.platform`，必须同时提供 `dshDesktop.keyboard` 桥**，否则客户端短路抛错 `Desktop keyboard bridge unavailable`（`packages/client/shortcuts/src/client/index.ts:46`）——若不打算做原生键拦截，就**不要设** `data-platform`。
- **不要只设 `dshDesktop` 而不设 `dshOnboarding`**：前者会关掉浏览器凭据引导（`ui-settings-models/src/client/index.ts:81,147`），后者缺失又会让账号区抛 `desktop login bridge unavailable`（`ui-settings-account/src/client/index.ts:43,211`、`onboarding-credentials.ts:8-12`）。**这三个全局要一起给或一起不给。**
- **不要指望用 DOM 注入修回侧边栏浏览器页**：它是**服务端 Cordis 门控**（`profileContext.name !== 'desktop'` 即停用），Inject 任何全局/属性都无效——唯一解法是壳 overlay 里的 `- id: ui-sidebar-browser` + `disabled: false`（§6.3 M-1）。

---

## 7. 现状核查、缺口与已登记问题

### 7.1 宿主机（Windows）实机现状 `[已验证: /mnt/c 只读抽查，2026-09-25]`

| 观测 | 值 | 含义 |
|---|---|---|
| 已安装壳 | `%LOCALAPPDATA%\DSH Smoothly Desktop\dsh-desktop.exe`，构建日期 2026-09-21 | 是 v0.11.0 **之前**的版本（看板卡「待用户：关闭应用后安装 v0.11.0」仍未完成） |
| 运行时 dsh | `@deepseek-ai/dsh 0.1.6-alpha.1` | **低于仓库地板 `0.1.7-rc.2`** |
| 地板闸门 | `<runtime>/dsh.json` 里 `devMode: true` | **devMode 冻结了地板自动升级** → 安装 v0.11.0 后，运行时会继续停在 0.1.6-alpha.1，除非关掉 devMode 或手动点更新 |
| 内置插件管理器 | `<runtime>/node_modules/@deepseek-ai/dsh-plugin-manager` **不存在**（该目录下只有 `dsh-host-plugin-inventory`、`dsh-client-ui-settings-plugins` 等更早的组件） | 0.1.6-alpha.1 早于「插件管理进 dsh」（我们的 README/调研记录把门槛定在 0.1.6-alpha.2）→ 当前实机缺少「安装/卸载/bundle 行级开关/构建脚本审批」，需要确认用户当前在图形界面里的插件管理能力边界 |
| 预装插件 | dsh.json `preinstalled` = kanban / model-reasoning / @karoc/smoothly-opencode-session / turn-navigator | 与仓库 4 包一致 |
| 用户启用列表 | `dsh.profile.bundles` = base + web-app + model-reasoning + kanban + turn-navigator + `dsh-smoothly-anyrouter-relay-proxy` + `@karoc/...-opencode-session` | 有一个**用户自装插件** `dsh-smoothly-anyrouter-relay-proxy`（第三方 relay），说明用户实际走的是第三方 provider 路线 |
| 代理 | `proxy.json`：上游 `127.0.0.1:20172`，`proxiedHosts` = `new-api.abrdns.com`、`anyrouter.top` | **内置代理正在实际使用**，且是逐主机路由（印证 §3.16 的判断） |
| 最近启动 | `manager.log` 末行 `dsh web: http://127.0.0.1:58994/?token=…`（2026-09-21T03:46） | 令牌进 URL 的事实（§3.3/§3.5）在实机上成立 |

**由此得到两条待办**（本轮新发现，见 §7.2）：
1. **devMode 冻结地板 → 实机长期停在旧 dsh**：需要决定「地板闸门是否应该在 devMode 下也生效一次」，或在 README/关于弹窗里明确提示当前版本低于地板。
2. **实机 dsh 0.1.6-alpha.1 缺插件管理器**：与我们已移除壳内插件控制台的事实叠加，可能出现「用户没有图形化插件管理入口」的窗口期。建议在「关于/检查更新」弹窗里显示当前 dsh 版本 + 地板，并把「低于地板」做成显式提示。

### 7.2 本轮新发现的问题（可直接进看板）

| # | 问题 | 证据 | 严重度 |
|---|---|---|---|
| 1 | `package.json:23` 的 `test:console-window` 指向**不存在的** `scripts/test-plugin-console-window.mjs`（插件管理移除时漏删） | `package.json:23` + 文件不存在 | 低（断链） |
| 2 | `test-broken-install.mjs`（130 行）、`test-install-stall.mjs`（143 行）存在但**未进 `npm test` / CI** | `package.json:21` 列表 | 中（覆盖缺口） |
| 3 | `cargo fmt --check` 在 CI 里被注释掉（注释：60 处历史格式差异） | `.github/workflows/build.yml:41-44` | 低 |
| 4 | 8 个 `verify-*.ps1`（Windows 行为验证）**零 CI 门禁**，全靠人工 | s5 §8.3 | 中（已知，已放弃纳入） |
| 5 | 启动页 chrome 的传输通道判定可能与注释不符：`shell-chrome.js:119` 用 `location.protocol === 'tauri:'` 判本地页，而 Windows 本地页是 `http://tauri.localhost` | `shell-chrome.js:119-121` vs `lib.rs:2458-2470`（注释说 Windows 是 `http://tauri.localhost`） | 中（`[假设]`：若成立则首帧壳菜单可能静默无效，需实机验证） |
| 6 | 实机 dsh 低于仓库地板（0.1.6-alpha.1 < 0.1.7-rc.2）且 devMode 冻结 | §7.1 | 中（见 7.1 待办 1、2） |
| 7 | 桥无鉴权（已知卡）在本次对比中有了**明确的官方对照**：官方页面连更新版本号都不能提供 | `lib.rs:1665-1990` vs `apps/desktop/src/ipc.ts:70` | 高（已有卡，建议本轮升级为 P0） |

### 7.3 已登记未修（KANBAN，本次未处理）

- 桥端点鉴权（`card-29b6f966`）——本报告 §5 P0-2 给出对齐目标的形状。
- 旧版接管加固 ①②④（`card-2506a383`）。
- 恢复宿主服务 + 第 5 次事故取证判定（`card-c12f05be`，依赖用户动作）。
- `/alive` 就绪信号绑定窗口 nonce（`card-bd47dc07`）。
- DSH 上游 403 误判为 AUTH（`card-c01ae2ba`，上游问题）。
- 宿主断流：本地 sub2api 60 秒规则（`card-2e1da17b`，环境问题）。
- 预装插件迁移到 `plugins.*` 槽位（`card-9f56e152`，非必须）。
- 待用户安装 v0.11.0（`card-f47019c7`）。

---

## 8. 附录

### 8.1 关键事实速查（官方侧）

```
版本恒等/一体更新     apps/desktop/scripts/prepare-dsh.ts:53-58 ; README.zh.md:65
宿主 in-process       apps/desktop-host/src/index.ts:6,22-30,93-102 ; src/host-process.ts:189-199
页面/凭据模型         src/main.ts:128-138,617-632,665-676 ; src/web-document.ts:43-92
安全基线/IPC 双门     src/main.ts:225-233 ; src/ipc.ts:91-97 ; src/preload-app.ts:99
Windows 顶栏契约      src/preload-windows.ts:12-13 ; src/windows-layout.ts:4
客户端避让规则        packages/client/ui-layout/src/client/AppFrame.module.css:26-54
席位                  packages/client/ui-layout/src/client/AppFrame.tsx:30,255,289-294
引导（Welcome 三页）  src/client/WelcomePage.tsx:9,207-218 ; src/welcome-api.ts:64-65
关窗隐藏+首次确认     src/main.ts:1019-1027 ; src/background-notice.ts:30-52
退出前任务检查        src/host-process.ts:49,254-258 ; src/quit-confirmation.ts:15-21
崩溃报告/恢复框       src/crash-report.ts:50,94-137 ; src/fatal-recovery.ts:65-104
更新体系              src/update-coordinator.ts:65-73,185-186 ; src/update-schedule.ts:18-33
强制更新              src/mandatory-update-policy.ts:112-125,201-204 ; src/mandatory-update-window.ts:52,82-92
更新托管/feed         scripts/desktop-auto-update-environment.mjs:16-23,73-81 ; scripts/desktop-upload-plan.ts:260-274
安装器（含事务）      scripts/installer.nsh:33-44,122-130 ; scripts/installer-directories.nsh:30-60,73-127
安装器 UI（C++）      installer/window-frame.cpp:123,150-152,222-242,244-282 ; installer/progress.h:31-53
卸载数据              installer/uninstall.nsh:12-36 ; installer/uninstall-data.h:99-150
签名链                scripts/windows-sign.mjs:166-243 ; windows-signature-cache.mjs:13-15,147-148
macOS 公证            scripts/macos-signing-keychain.mjs:48-84 ; scripts/package-macos.ts:89-129
primary runtime       scripts/primary-runtime/lock.json:2-4 ; scripts/primary-runtime/prepare.ts:23-35,145-158
Office                apps/desktop-host/src/office.ts:28-37 ; src/office-engine.ts:12-41
桌面打包 CI（不存在） .github/workflows/ 零命中 ; ci-master.yml:44-48,116-121 ; ci.yml:695-699
```

### 8.2 关键事实速查（我方）

```
启动链路              src-tauri/src/lib.rs:3645-4004（setup 序）; 2069-2114（start_server）
就绪信号              lib.rs:1712-1722（/alive）; 2440-2456（导航兜底退避）
dsh 获取/升级         scripts/server-manager.mjs:28,64,718-746,1450-1492,1567-1581
预装/保护             server-manager.mjs:697-790,1027-1080 ; lib.rs:3486-3526
壳 UI/注入            src-tauri/resources/ui/shell-chrome.js:41-103,772,823-862 ; lib.rs:31,3592-3608
桥（30 端点无鉴权）   lib.rs:1642-1663,1665-1990（响应头 1983-1986）
通知插件              plugins/dsh-client-notifications/client.js:20-46,86-110
代理                  scripts/proxy.mjs ; src-tauri/src/settings.js ; src-tauri/src/lib.rs:3065-3068
测试/CI               package.json:21 ; .github/workflows/build.yml:26-61,93-143,249-301
发布                  .github/workflows/release-please.yml ; CONTRIBUTING.md:59-89 ; README.md:295-324
```

### 8.3 不确定性清单（不得当作结论使用）

1. `[本机不可验证]` 官方桌面打包/签名的 CI 实体：本仓库 workflows 无该 job，README 只提「CI 从密钥存储生成证书文件」（README.zh.md:264）→ 报告只说「本仓库不可见」，不推断其形态。
2. `[本机不可验证]` 官方安装包体积与实际安装耗时：仓库只有机制证据（解压占进度权重 94%、`differentialPackage:true`、README 把测量列为人工验收）→ 本报告**不给任何体积/耗时数字**。
3. `[假设]` NSIS 安装器/卸载器走同一 SafeNet 自定义签名器：证据链在依赖源码（`app-builder-lib` 的 `NsisTarget.js:302,376` + `windowsSignToolManager.js:158`），未端到端验证。
4. `[假设]` macOS 运行期更新验签由 electron-updater 的 `MacUpdater` 承担：`apps/desktop/src` 无 macOS 专属校验代码，显式验签只在 Windows-only 脚本中。
5. `[假设]` Tauri 侧无「同源代理/网络层钩子」等价物（S4 §9.1 的 5 条），未做 Tauri v2 API 审计 → 若要据此外推，需各做一个 spike。
6. `[假设]` `--patch` 能否注入宿主侧（非客户端）插件条目 → 这正是 §5 P2-1 的 spike。
7. `[假设]` 官方 19387 端口被占用时无回退；`[假设]` `dsh web` 的 `?token=` 与 cookie 命名在 0.1.7-rc.2 仍成立（本仓有代码与文档证据，但本轮未逐行核对 0.1.7-rc.2 上游源码）。
8. `[未覆盖]` 官方桌面端是否已对外公开发布/可下载（本轮只确认 npm 包不存在、仓库内无 CI，未查证公开下载渠道）。
9. `[未覆盖]` 官方 desktop 在 macOS 实机上的材质/权限/公证最终表现（无 macOS 主机）。
10. `[未覆盖]` 我方 `verify-*.ps1` 在 Windows 实机上的当前通过状态（本轮未跑）。
11. `[假设]` **模块解析重写后我们的 hoisted 布局修复是否仍必要/是否已有害**：上游删除了 `$DSH_HOME/profiles/node_modules` 投影、改为内存内 `createRuntimeResolution()`（`packages/boot/app-boot/src/profile.ts:426-431`）——核验步骤见 §6.4（同一包在 hoisted 与 isolated 两种布局下都必须能冷启）。
12. `[假设]` `api-request-trust.ts`（`/api` 浏览器信任栅栏）的逐行差异未核对：机制存在、`packages/bundle/web-app/src/startup.ts` 零 diff，但内部是否新增更严的 Origin/Sec-Fetch 校验未证实 → 核验：`git diff` 该文件逐行读。
13. `[假设]` 我们是否可能落在「子路径 mount」上（影响 `authenticatedUrl` 改动的等价性）：`localWebUrl()` 无尾斜杠 → root mount 下与旧行为等价；若前端支持子路径则前提变化 → 核验：`grep -rn "mountPath\|basePath" packages/host/frontend-static/src`。
14. `[假设]` Tauri 2 / WebView2 能否稳定复刻官方 preload 语义：尤其**注入脚本的执行时机**能否早于页面读取 `dshDesktopBoot`，以及原生键拦截能否抢在嵌入 frame 之前（官方是 Electron 主进程级拦截）。**未在本机 WebView2 实测**。
15. `[假设]` `dsh web` 的 stdout URL 行是否被官方视为对第三方 supervisor 的稳定承诺：`packages/bundle/web-app/README.md:84` 是文档级承诺，但 `Config.printUrl` 可关（`src/index.ts:62`）、格式无测试锁（我方 `lib.rs:3441` 的解析依赖它）。
16. `[未覆盖]` 我方在 WebView2 下语音输入/麦克风是否可用（官方有权限收窄逻辑，我们未做）。
17. `[未覆盖]` 官方桌面端在 Windows 实机上的加密材质（acrylic）/`titleBarOverlay` 观感与其 README 自称「仍需平台验证」的状态（无官方安装包）。

### 8.4 本次方法与边界

- 官方侧：`/srv/deepseek-harness` 只读（HEAD `477b4f4205`）；由 7 条独立深挖线分别通读源码（s1–s7），每条论断带 `file:line`；本轮对关键行号做过抽检，但**未逐行复核全部引用**（s4 自述抽检 22 条、s5 全量实测行号）。
- 我方：`/home/karoc/dsh-desktop` 只读；宿主机 `/mnt/c/...` 只读抽查。
- **未做**：任何代码修改、任何构建、任何实机启动验证、任何网络写操作；官方侧未运行任何脚本。
- **本报告不替代验证**：所有「建议」都只是建议，落地前需要各自的可失败验证（负向对照），尤其 P0-1（顶栏契约视觉）与 P1-5（契约冒烟）。


