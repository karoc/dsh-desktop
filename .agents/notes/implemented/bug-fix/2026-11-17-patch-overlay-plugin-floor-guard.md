# Agent Note: patch-overlay-plugin-floor-guard

Status: implemented (2026-11-17, card-f295ecb2 / W5)

## Problem

「插件自己声明的 dsh peer 地板不足 ⇒ 整个 Web UI 白屏」这条防线的运行时那一半漏了 `--patch` 注入的插件。
`applyPluginFloorGuard` 只拿 `src-tauri/resources/preinstalled` 当守卫输入，而 `@dsh-desktop/client-notifications`
是壳通过 `dsh web --patch <overlay>` 注入 loader roster 的 —— 用户回退 dsh、`devMode` 冻结地板升级、或离线
升不到新版时，它的 fiber 停在 pending，dsh 的 web boot 对未激活条目 **fail-closed**，界面停在
「Failed to load plugins」打不开（2026-09-25 真机事故的同族）。W2 已在 #279 用 `planPluginGuard` 证明 0.1.5
下该插件会判 quarantine —— 缺的只是把它的 package.json 递进守卫、并把"隔离"落到注入清单上。

## Decision

**把 patch overlay 里的插件条目纳入同一套地板语义：命中 ⇒ 本次不注入（不是不复制、也不是删文件）。**

- `scripts/plugin-floor.mjs`：新增 `parsePatchOverlay`（找出 `- insert:` 下带 `name:` 的缩进列表项 = 注入的插件包；
  `- id: <row>` 覆盖块永不动）、`stripPatchPlugins`（摘除 + `missing`/`residual` 后置校验）、
  `planPatchPluginGuard({installedDsh, plugins})`（`{drop, warnings}`）；并把原先内联在 `planPluginGuard` 里的
  判定抽成共享的 `judgeDshFloor`，两条路径的语义只有一个来源。
- **摘除是行级手术**：只删目标 insert 项的行；insert 块被摘空时连 `- insert:` 行一起删（YAML 里空 `insert:`
  是 null，"null" 与"没有这条"语义不同）；其余条目、注释、空行逐字节保留。**不解析成结构再序列化**。
- **摘不干净 ⇒ fail-open**：`stripPatchPlugins` 返回 `missing`（点名但没找到）/ `residual`（摘完仍能解析到），
  manager 见到任一非空就照用原 overlay 并打一条点名"请更新解析器"的日志 —— 宁可保留白屏风险，也不整份丢弃
  （整份丢弃会连 `ui-sidebar-browser` 的 `disabled: false` 覆盖一起弄丢，壳失去浏览器页且用户无法自行启用）。
- **manager 接线在 `launchDsh` 开头**（`materializePatchOverlay`，每次拉起 dsh 前重算）：包清单优先读
  `<runtime>/node_modules/<name>/package.json`（dsh 实际加载的那份），缺失回退到 `resources/plugin/<name>`。
  命中时写受控副本 `<runtime>/plugin-floor/dsh-desktop.patch.yml` 并把该路径交给 dsh；**仓库里的原 overlay
  一字不改**、插件包不删。负向保证与预装插件一致：不动 `@deepseek-ai/*`、未声明地板或找不到包清单只告警、
  dsh 版本未知不判断。
- **记账**：`dsh.json.quarantinedPatchPlugins`（`{name, version, requires, floor, source:'patch', overlay, at}`）；
  本轮没有隔离时清空该数组并删掉上一轮的受控副本（`settle()`），避免"上一轮名单"在升级后继续骗人。
  记账**不动** `preinstalled` / `preinstalledVersions`（被隔离项不在 runtime，不进这两份"壳自带"清单）。
- **用户可见面 = 启动页日志区**（manager `{t:'log'}` → `server-log` 事件）：
  `plugin-floor: 隔离 @dsh-desktop/client-notifications@0.1.0（要求 @deepseek-ai/dsh-client-ui-session ">=0.1.6-alpha.2"，已装 dsh 0.1.5 不满足）—— 已从 --patch 注入清单摘掉：本次不加载该插件（文件保留、原 overlay 未改），dsh 升级到满足地板后自动恢复`。

## Alternatives considered

**只在 main 启动时算一次**（与预装插件同一时机）：manager 生命周期里 dsh 会被「检查更新」/兼容闸门升级，
升级到地板以上后插件仍被摘（通知静默消失）直到用户重启壳。放进 `launchDsh` 每次重算让"升级后自动恢复"
成为默认行为，代价只是每次重启多读两个小文件。

**解析成结构化 YAML 再序列化回去**：仓里没有 yaml 依赖；而且会改写注释与上游格式，`test-patch-targets`
锚定的契约行（`- id: ui-sidebar-browser` / `disabled: false`）也可能跟着变形。行级手术让"没被点名的字节"
完全不动，也让 diff 可审。

**摘不干净就整份丢弃 overlay**：最省事的错误实现 —— 会一并丢掉 `ui-sidebar-browser` 的启用覆盖。任务书
明确要求"只摘目标 insert 条目、保留其它 overlay 项"，这也正是代码里 `residual`/`missing` → fail-open 的理由。

**只写纯函数单测**：覆盖不了本缺陷的原状（"守卫没接线"）。所以补了 spawning 真 manager 的 E2E：假 dsh 把
它**实际收到**的 overlay 写进 probe 文件再断言 —— 去掉 manager 侧的插件输入（`plugins: []`）必红。

**把 overlay 摘除逻辑放在一个新 `scripts/lib/` 模块**：会多一处"真源 → resources"同步面；`plugin-floor.mjs`
本来就在 manager 的相对导入闭包里（sync-resources 自动带上），放这里让守卫的语义只有一个文件。

## Consequences

- 代价：每次 dsh 重启多一次 overlay 解析 + 至多一次 pkgJson 读取；命中时写受控副本与 `dsh.json`。
  形状超出支持子集时 fail-open（白屏风险仍在，只有日志点名）。
- 换来：`--patch` 注入的插件与预装插件走同一套地板语义；dsh 升级/回退后自动恢复/自动再隔离，不必重启壳；
  `quarantinedPatchPlugins` 给诊断与后续界面呈现留下落点。
- 覆盖：`scripts/test-plugin-floor.mjs`（8 条原有断言 + 6 条 overlay/patch 纯函数断言 + 双次 manager E2E：
  0.1.5 摘掉且 `ui-sidebar-browser` 保留 / 同一个 runtime 升到 0.2.2-rc.1 后恢复注入并清空记账）；
  `scripts/test-controls.mjs` 新增两条注入对照（整份丢弃 ⇒ 红；去掉 manager 的插件输入 ⇒ 红）。
- 缺口（如实登记）：`quarantinedPatchPlugins` 仍未在界面呈现（与 `quarantinedPlugins` 是同一条待办）；
  overlay 只认壳自己产出的形状（`- insert:` + 缩进列表项），若将来改写成 inline 形式，守卫会 fail-open 并
  打日志点名，而不是静默失效。
