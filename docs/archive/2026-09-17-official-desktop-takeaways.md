# 官方 dsh desktop 的可取做法 & 技术栈差异分析

> 依据：`/srv/deepseek-harness` @ `dsh-v0.1.6-alpha.1`（apps/desktop、apps/desktop-host、7 篇 desktop 架构笔记）
> 对照：`karoc/dsh-desktop` @ `feat/launcher-log-9-lines-final-delay`（Tauri 壳，lib.rs 3652 行 + shell-chrome.js 1259 行 + manager 1697 行）
> 日期：2026-09-17

## 0. 先明确一个前提

官方 desktop **尚未发布**（其笔记原文：*"Desktop has not been released. This is its first installation format."*），
且 `@deepseek-ai/dsh-desktop` 是 `private: true`、不上 npm。所以下面讨论的是**设计意图与已落地的机制**，
不是"已上线产品的成熟度背书"。反过来，我们的壳已经在用户机器上跑了很多个版本（0.3.x → 0.8.0），
有一批官方 desktop 至今没有的能力（见 §4）。

---

## 1. 官方做法清单 → 我们的可采取性（逐项）

评级：**A** 建议采纳 / **B** 值得部分借鉴 / **C** 记录在案但不建议照搬

### A-1. 更新走「签名 + 清单」的单一发布单元

**官方**：Electron shell + 匹配 dsh + Node + pnpm 组成一个**签名更新单元**（`update-coordinator.ts` 用
electron-updater，`release.ts` 定义 `DesktopRelease` 描述符：schemaVersion/version/hostProtocolVersion/
nodeVersion/pnpmVersion，`publish: generic + url`）。理由写在 README：独立版本会制造未经验证的组合、
让"有无更新"语义含糊。

**我们**：**完全没有壳自更新机制**（`Cargo.toml`/`tauri.conf.json` 无 updater 插件，无 GitHub Releases 轮询）。
用户要升级壳只能自己来 GitHub 下载安装包重装。

**可取**：这是**我们最大的缺口**。建议分两步：
① 最小版：壳启动时查 GitHub Releases 最新 tag，有新版本就在「关于/检查更新」里给一条"下载新安装包"的提示
（复用现有 `/check-update` 与壳内模态，零新依赖）；
② 完整版：接入 `tauri-plugin-updater` + 在 CI 里对 NSIS 产物签名（minisign 公钥内置），实现下载即装。
—— 但注意 ② 需要签名密钥管理，属于**供应链安全决策**，得你先拍板。

### A-2. 「版本恒等 + 描述符校验」的思路（不是照搬 Electron 的部分）

**官方**：一个 Desktop release 号同时标识 shell 与它精确依赖的 dsh / desktop-host；
构建期校验（`build-release-validation` 笔记：打包器拥有 schema/版本/平台/架构/hostProtocol/node+pnpm semver 校验），
启动期只读必要字段、**不再重复**做打包期已做的比较（理由是"重复比较无法证明安装字节与描述符一致"）。

**我们**：dsh 版本是**运行时**从 npm 拉的（`ensureDsh` 用 `pnpm install --node-linker=hoisted`），
壳版本与 dsh 版本**天然解耦**——这是我们的产品特性（用户可自选 latest/预发布），不是缺陷。

**可取**：不照搬"版本恒等"，但**可借"描述符 + 边界校验"**：
给壳加一个 `shell-release.json`（壳版本 / 内置 Node 版本 / manager 版本 / 预装插件版本），
构建期生成、启动期读一次用于「关于」弹窗与排障日志。成本极低，收益是排障时不用再猜组合。

### A-3. 路径安全：不跟随 junction/symlink 越界删除

**官方**：`owned-directory.ts` 明确处理 *"Electron's recursive rm follows nested Windows junctions into
installed resources"*；卸载提案里要求校验 case-insensitive 路径、junction/reparse point、清理期间路径被替换、
**不跟随链接进入其它树**、拒绝删除受保护 home 及其祖先。

**我们**：**已知有同类问题**——看板上还挂着「旧版接管加固：① lnk 校验+分支修正 ② path_under 归一化」，
且 `legacy-takeover.nsh` 目前靠 `RMDir`（空目录才回收）来兜底，属"宁可留着也不误删"的保守做法。

**可取**：**直接对齐**。把官方这套判据（保护路径判定、reparse point、不跟随链接）落到
`path_under` 归一化里。这条与我们已挂的加固卡是同一件事，官方给了现成的判据清单可抄。

### A-4. 卸载「保留 home + 清外部应用态」的清单化做法

**官方**（proposed 提案，未实现）：卸载保留完整 `~/.dsh`，但**必须清掉**应用自有外部状态：
Electron userData/sessionData（含未发送草稿！）、`<updaterCacheDirName>` 缓存、原生 updater 状态
（Squirrel/ShipIt）、安装目录与注册项；并且明确"**不得**按名字搜盘删含 dsh 的文件"、
"不得用 `deleteAppDataOnUninstall` 当万能钥匙"、要区分 per-user / all-user、失败要如实上报而非假成功。

**我们**：NSIS 用 `installMode: currentUser`，`legacy-takeover.nsh` 注释明确"绝不触碰 dev 版、
`%APPDATA%` 数据目录与本版安装目录"；数据在 `%APPDATA%\<id>` 下。**但没有"卸载清外部态"的清单**。

**可取**：**A（成本低）**。我们缺的正是这份清单：卸载时应清 `%APPDATA%\<id>\runtime`（pnpm store、
node_modules、reports 证据目录）与 WebView2 缓存，**保留**会话/设置/凭据。建议照官方那张
"Candidate → Required treatment" 表，做一份我们自己的清单 + 在 NSIS 里落地。
注意官方那句提醒很关键：**浏览器存储里有未发送的草稿**，删之前要在 UI 里说明。

### A-5. 启动页即「恢复面」：诊断 + 可操作恢复入口

**官方**：`startup-document.ts` 生成**自包含**的恢复文档（不依赖应用资源文件、内联 CSS、
CSP `default-src 'none'`、所有诊断文本转义、`form-action dsh-recovery:` 触发恢复动作），
提供「重启应用 / 禁用第三方插件 / 重置配置」三类恢复动作，且**明确说明重置不备份**。

**我们**：启动页（`src/index.html` + `app.js`）已有：状态文案、异常退出退出码 + 证据目录、
「重试」、「打开数据目录（看 manager.log）」、旧版残留横幅、卡住检测（30s/60s）。**已经不错**。

**可取**：**B（补两项）**：① 「禁用第三方插件后重启」入口（我们已有 `/plugins/disable`，接进启动页即可，
dsh 起不来时最有用）；② 诊断文本**转义**——官方专门 escape，我们的 `appendLog` 用 `textContent`
（安全）但 `stateEl.textContent` 亦然，这点其实已安全，可作为**回归检查项**固化。

### B-1. 进程/端口模型：无监听端口 vs 回环端口

**官方**：不开监听端口（`dsh-app://` 自定义协议 + 分帧字节管道 + Node IPC），理由是"监听 Web 服务会带来
端口归属、认证、CORS、暴露面问题"。

**我们**：`dsh web` 必须监听 127.0.0.1（这是 dsh 的既有产品形态），壳再起一个**环回桥**
（CORS-open、`127.0.0.1:0` 随机端口）供远程页调用壳能力。

**可取**：**C（不照搬）+ B（补强）**。改协议栈等于重写整个壳，收益不足以抵消；但官方点出的
"端口归属/认证/CORS"风险我们**确实存在**——看板已挂「安全：桥端点鉴权（token 挡不住同源插件 →
危险动作改壳内确认窗 + IPC）」。**建议按那张卡推进**，这就是对官方这条理由的正确回应方式。

### B-2. 渲染进程隔离基线

**官方**：`nodeIntegration: false` + `contextIsolation: true` + `sandbox: true`；preload 只暴露
**类型化**动作（RPC/lifecycle/update/locale/plugin），**不暴露**原始 ipcRenderer、文件系统、shell、pnpm 参数。

**我们**：Tauri 模型下等价物是 capabilities：`launcher`（本地页：core:default + window close）、
`remote-notifications`（远程页：**仅** event listen/emit/unlisten + notification:allow-notify）。
**已经是白名单收敛**，且远程页权限极小。

**可取**：**B（做一次对照审计）**：把我们的 capabilities 与官方"不暴露"清单逐条比对，
确认没有多余权限（尤其 `core:default` 在本地页是否过宽）。低成本、高价值。

### B-3. 单实例 = 权威所有者（先锁再做任何事）

**官方**：Electron 在**任何 profile 访问之前**获取进程生命周期锁；后续启动只聚焦/重建主窗口，
**不触碰** profile 状态；包事务另有锁做纵深防御，记录"谁还能改包状态"（Electron 或 pnpm PID），
崩溃后靠 PID 存活性判定，不盲目抢锁。

**我们**：有 `tauri_plugin_single_instance`（按 identifier 隔离，dev/prod 可并存），
manager 有 pnpm store 一致性校验（`ensureStorePathsMatch`）。

**可取**：**B**：我们的单实例回调目前主要做"聚焦窗口/打开 home"，**没有"拿到锁后才允许动 runtime"**
的显式约束；且**没有包事务锁**（两个壳版本并发操作同一 runtime 理论上可能打架，虽然单实例+身份隔离
已大幅降低概率）。建议在 `restart_server`/`update-dsh` 路径上加一个 runtime 级锁文件。

### B-4. 打包期校验 vs 启动期校验的分工

**官方**：把重校验放**打包期**（描述符 schema、平台架构、协议版本、node/pnpm semver、签名与哈希清单），
**启动期只读必要字段**，理由是"每次启动重复比较无法证明安装字节与描述符一致"，且拖慢启动。

**我们**：我们有"构建期 sync-resources（真源→副本）+ 运行时兜底校验"的组合，并且**踩过
"打包旧 manager"的真事故**（0.5.0/0.6.0），因此我们的策略是**两端都查**。

**可取**：**B**：官方这条理由在"打包器拥有完整校验"的前提下成立；我们目前**构建期校验不足**
（真源/副本漂移靠人工 `cmp` 与事后事故发现）。建议把 `cmp scripts/server-manager.mjs
src-tauri/resources/manager/server-manager.mjs` 变成 **CI 强制门禁**（现在是技能里的自查项）。

### B-5. 更新/安装的失败语义：保留部分变更、显式修复、不假装成功

**官方**：包或 Host 失败**保留部分变更**供显式修复重试，**没有** staging/回滚；用
`desktop-packages-pending` 标记记录"未完成"，下次启动重装并重试（即使记录的运行时元数据已匹配）；
失败要"如实上报"，不允许出现假成功。

**我们**：升级前后有 `snapshotWebProfileBundles` / `restoreProfileBundlesAfterUpdate` 快照恢复
（防"升级丢插件"），失败时 `emitOpStatus({ok:false, error})` 如实回报 UI，安装卡住有 30s/60s 提示。

**可取**：**A（补 pending 标记）**。我们的恢复是"事后对比快照补回"，官方是"先写 pending 标记、
下次启动确保重装"。**两者可叠加**：给我们的 update 流程加一个 `.dsh-update-pending` 标记，
写于替换前、清于校验后；下次启动若发现标记则强制走一次校验恢复。能覆盖"升级中进程被杀"这类
我们目前无解的场景。

### C-1. Electron 作为壳（不照搬，见 §2）

### C-2. 首方包用 symlink/junction 链入 profile（不照搬）

**官方**：首方包以目录符号链接/junction 链入 profile，使宿主与插件**共享模块实例**；
外部插件必须把共享宿主包声明为 peer，校验会拒绝"祖先目录解析/嵌套副本/私有链/peer 不兼容"。

**我们**：`--node-linker=hoisted` 把包提升到根（正是为了修 ERR_MODULE_NOT_FOUND 黑屏），
预装插件 peer 只声明了 `react`，未声明 `@deepseek-ai/dsh-*` 共享包。

**可取**：**C（现在不照搬）+ 记录**。理由：hoisted 是我们在 pnpm 布局下验证过的解法，
改成 symlink 会重新引入解析风险；但如果将来要兼容官方 desktop 的插件校验，
**必须给三个预装插件补 peer 声明**（这件事已记在 desktop 核查卡里）。

---

## 2. 为什么官方技术栈与我们不同

不是"谁更先进"，而是**四个约束不同**导致的必然分叉：

| 约束 | 官方 | 我们 |
|---|---|---|
| **要交付什么** | 一个**面向大众用户的完整桌面产品**（含自己的更新、签名、插件市场式管理） | 一个**围绕 dsh web 的 Windows 增强壳**（用户已用官方 dsh CLI/web） |
| **dsh 从哪来** | 构建期**物化进安装包**（`extraResources/dsh`，含完整生产依赖树） | **运行时**从 npm 拉（`ensureDsh`，用户可自选版本/预发布通道） |
| **依赖边界** | 不许依赖系统 Node/pnpm（"system runtimes and package-manager state are uncontrolled"） | 壳内**已捆绑** Node 24，但 pnpm store/布局仍与用户环境交互 |
| **发布通道** | 一个签名 release 单元（shell+runtime 恒等） | 壳走 GitHub Releases，dsh 走 npm dist-tags（**两条独立通道**） |

### 具体到技术选型的因果

1. **为什么官方用 Electron 而不是 Tauri？**
   - **需要自带上游 Node + pnpm 并直接执行 dsh**：Electron 自带 Node（`process.execPath` 可跑
     `ELECTRON_RUN_AS_NODE`），且有成熟的 `electron-builder`/`electron-updater` 签名更新链。
     Tauri 用系统 WebView + Rust，要跑 Node 必须**自带 node 二进制**（我们正是这么做的：`fetch-node.mjs`
     下载 v24.18.0 并随包分发）。
   - **需要跨三平台一致的自定义协议与进程模型**：`dsh-app://` + 分帧管道在 Electron 里是原生能力。
   - **团队已选 Electron 并投入了大量打包/签名/更新工程**（650 行架构笔记几乎全在讲这些）。
   - ⚠️ 注意：官方**从未声称 Electron 优于 Tauri**；这是"要交付完整产品"的路径依赖。

2. **为什么我们选 Tauri？**
   - **复用 Windows 上已有的 WebView2**：安装包 ~28MB（官方 Electron 是百 MB 级），
     冷启动与内存占用更友好。
   - **Rust 侧能做 Windows 深度集成**：我们真正值钱的东西都在这里——MiniDumpWriteDump 挂起取证（43 处引用）、
     Job Object 进程树管理、CREATE_NO_WINDOW 防闪窗、注册表/快捷方式接管旧版、AUMID 通知激活参数化。
     Electron 做这些要写 native 模块或依赖第三方。
   - **无端口桥的替代方案更轻**：我们不需要 Electron 那套管道，直接用 `dsh web` 的 HTTP + 环回桥。

3. **为什么"无监听端口"我们做不到（也不必做）？**
   官方自己写了 dsh 后端与匹配 client，可以选传输方式；我们的后端就是 `dsh web`，
   它的产品形态**就是**监听回环 HTTP + token。要改就得 fork dsh 或写一个 desktop-host 等价的
   组合层——那是把我们的定位从"壳"变成"发行版"，属于**战略级决策**，不是技术优化。

4. **为什么更新模型完全不同？**
   官方把 dsh 打包进安装包 → 更新 dsh 必须发新 Electron release（"a dsh upgrade is a Desktop release"），
   所以它有强动机做签名自更新。我们把 dsh 留在 npm → **dsh 可以独立、即时、按 tag 更新**
   （这是我们的特色：预发布通道、用户可选），代价是**壳自身的更新链是空白**（见 A-1）。

---

## 3. 优先级建议（若要动手）

| 优先级 | 事项 | 成本 | 理由 |
|---|---|---|---|
| **P0** | 壳自更新（先做"检查+提示下载"，再评估签名自更新） | 中 | 唯一"用户会因此吃亏"的缺口 |
| **P0** | 路径安全判据对齐（reparse point / 保护路径 / 不跟随链接） | 低 | 已有挂账卡，官方给了现成判据清单 |
| **P1** | 卸载清外部态清单（保留 home，清 runtime/缓存/证据） | 低 | 影响磁盘占用与隐私，官方清单可直接参考 |
| **P1** | update pending 标记（防"升级中被杀"） | 低 | 补我们现有快照恢复覆盖不到的场景 |
| **P1** | 启动页加「禁用第三方插件后重启」 | 低 | dsh 起不来时最有用的恢复动作 |
| **P2** | capabilities 对照审计（对齐官方"不暴露"清单） | 低 | 安全基线复核 |
| **P2** | runtime 包事务锁 | 低 | 纵深防御，概率低但后果重 |
| **P2** | 真源/副本 `cmp` 进 CI 强制门禁 | 极低 | 我们为此出过两次事故 |
| **P3** | 壳 release 描述符（关于/排障用） | 极低 | 排障体验 |
| **不采纳** | 改 Electron / 无端口传输 / symlink 共享 / 版本恒等 | 高 | 与我们的定位和已验证方案冲突 |

---

## 4. 我们已领先的地方（别在借鉴中丢掉）

官方 desktop 目前**没有**的能力，全在我们的壳里：

1. **崩溃取证与挂起诊断**：`MiniDumpWriteDump` 全内存 dump（保留 3 份）、manager 未捕获异常取证、
   `manager-crash-*-genN` 证据目录、probe miss 3/3 判据、外部守护（`dsh-hang-guard.ps1`）——
   官方笔记里**完全没有**这一层。
2. **旧版接管**：`legacy-takeover.nsh` 静默卸载 0.3.x 旧版 + 快捷方式回收 + 数据先备份，
   并明确"绝不递归删非空目录"。官方 desktop 无此需求（它还没有历史包袱）。
3. **内置正向代理**（`proxy.mjs`，CONNECT + HTTP + 路由 + Basic 认证 + 防自环）——
   官方 desktop 没有代理能力。
4. **预发布通道**：从全部 dist-tags 里挑"高于 latest 的最高预发布"提示用户，想升才升。
5. **dsh 版本自管理**：hoisted 布局修复、pnpm store 一致性、profile bundles 快照恢复、
   半截安装自动重装——这些都是我们踩坑后沉淀的，官方走"打包物化"路线不需要。
6. **已在用户机上长期运行**：0.3.x → 0.8.0 的迭代与实机验收记录（官方 desktop 尚未发布）。
