# Agent Note: shell-hardening-bridge-confirm-caption

Status: implemented

## Problem

官方 desktop 0.1.7-rc.2 落定后，本仓（Tauri 2 外部壳）暴露出四类必须先处理的欠账：① **桥端点无鉴权** —— 30 个环回 HTTP 端点里有一批能直接退出应用、重启、装更新、停用插件、清缓存、切开发者模式，token 挡不住同源插件（token 随 URL 进页面），2026-09-01「菜单点了没反应」事故已证明这条通道是活的；② **升级单向性**（dsh ≥0.1.7-alpha.1 会话按 v4 写、旧读取器拒读）在 UI 与文档里毫无提示，"装回旧版"会被误当成回滚手段；③ **关窗即隐藏进托盘**没有任何解释，任务栏里窗口消失后用户找不到入口；④ 升级后启动失败无法归因到"刚升级过"，只能看到黑屏。此外官方客户端的顶栏契约（`data-windows-titlebar` + `--dsh-windows-titlebar-height`）与我们自绘顶栏的推挤方案存在结构性冲突。

## Decision

**桥请求面收窄（S4-0，已上线）**：`bridge_request_decision`（纯函数）要求 `Host` 精确等于 `127.0.0.1:<当前桥端口>` 或 `localhost:<当前桥端口>`（挡 DNS rebinding）、`Origin` 缺省放行但出现时必须在白名单（`tauri://localhost` / `http://tauri.localhost` / `http://127.0.0.1:*` / `http://localhost:*`）、非 `GET/HEAD/OPTIONS` 必须带 `X-DSH-Shell: 1`；响应改由 `bridge_cors_headers(origin)` 生成，**不再回 `Access-Control-Allow-Origin: *`**，`Allow-Headers` 含 `content-type, x-dsh-shell`；拒绝时回 403 + 不回 CORS 头 + 记 `bridge reject: <reason>`。负向保证：只读 GET 端点与本地页 IPC 通道不变；不做 IP 白名单以外的网络策略（桥仍只监听 127.0.0.1）。**危险动作收口（S4-1）**：`dangerous_bridge_action` 表 11 项（quit / restart / restart-dsh / update-dsh / disable-plugins / cleanup-caches / legacy-cleanup / dev-mode / gpu-accel / open-data / titlebar-toggle）；桥**不执行**它们，而是登记一次性槽位（`PENDING_CONFIRM`，一次一个、60s TTL、同动作去重聚焦、不同动作回 `busy`）并打开壳拥有的确认窗，立即返回 `202 {pending:true,nonce}`；`get_pending_action` / `resolve_pending_action` 均为 `#[tauri::command(async)]`，后者是**唯一执行点** `execute_danger_action` 的入口，动作文案由 Rust 生成（调用方只能给 action id）。负向保证：托盘与本地页（launcher/settings）的壳内入口不经确认窗；确认窗不接收任何调用方提供的文案。**关窗语义（S5）**：Windows 上首次隐藏到托盘前用同一确认窗确认一次（合成动作 `close-hide`，标记 `<app_data>/background-close-confirmed`；写标记失败只记日志**仍然隐藏**），Linux 仍退化为最小化、永不确认。**升级归因（S9）**：manager 在安装成功后**原子写**（tmp + rename）`<runtime>/upgrade.json`，只在确有旧版本时写，同一 `(from,to)` 重复失败累加 `attempts`，回退记 `kind='rollback'`；Rust 读取后随 `manager-exit` 上报、并在页面 `POST /alive`（启动成功）时删除标记；启动页据此显示「上次升级 vA → vB 后启动失败」并在 `attempts < 2` 时给「回退到 vA」按钮。负向保证：`attempts >= 2` 不再提供版本切换（只留归因 + 证据目录），**回退只切版本、不还原数据**（数据回滚仍走备份还原，README 已写明）。**顶栏契约（S8，默认关）**：`dsh.json` 的 `webview.titlebarContract` 由壳菜单「顶栏契约（实验）」切换（经确认窗）；开启时 `computeCaptionPlan(true)` 返回 `paddingTop: null`（不推挤）+ `html[data-windows-titlebar]` + `--dsh-windows-titlebar-height: 40px` + `:host(.caption)`（`.bar` 透明且 `pointer-events:none`，**仅 `.bar`**，子元素恢复 `auto`），菜单起点用 `var(--dsh-windows-menu-start, 48px)`，拖动/双击最大化挂到显式拖动区，注入晚于首帧故补发一次 `resize`。默认关的原因：视觉/遮挡只能 Windows 实机判定，关着时行为与今天完全一致。
## Alternatives considered

**桥端点整体加 token 校验（拒绝无 token 请求）**：被否 —— token 已经随 `dsh web` 的 URL 进入页面，同源插件/页面脚本同样读得到，挡不住我们真正的威胁模型（页面内脚本发起危险动作），却会把远程页首屏请求时序搞复杂。**危险动作同步弹窗（桥线程 wait 用户点击）**：被否 —— 本仓 24 个 IPC 命令是同步命令、在主线程执行，桥线程等主线程 = 死锁；改为"槽位 + 打开窗口 + 立即 202"的非阻塞设计。**复用官方 `background-notice` / dsh 自带确认 UI**：不可得 —— 官方那套是 Electron 主进程原语，而 dsh 的桌面分支 gated 在 `profileContext.name === 'desktop'`（我们是 `web` profile）。**照抄官方 `data-windows-titlebar` 并默认开启**：被否 —— 本机无 Windows 实机可判定观感，且客户端的 `.frame{padding-top:var(--dsh-windows-titlebar-height)}` 与壳自己的 `html{padding-top}` 会**双重让位**（真 Chromium 实测 72px 下移）；改为 flag 默认关 + 菜单可切 + 实机 runbook。**立即去掉 `--node-linker=hoisted`**：被否 —— S11 实验只证明 Linux 下 isolated 可启动（插件可解析），Windows 未验；保留 hoisted，登记为待 Windows 验证项。
## Consequences

代价：桥的一次性槽位是**全局单飞**（一次只能有一个待确认动作，不同动作请求直接回 `busy`），牺牲并发换取"不会叠窗/不会被脚本刷"；顶栏契约切换后必须刷新页面才生效（注入前缀只在页面加载时写入）；升级标记只在"确有旧版本"时写，所以**冷安装失败不会被归因成升级失败**（宁缺勿错）。收益：同源插件再也无法靠 `fetch` 直接达成危险动作（必须有人在壳窗口里点确认），而这条防线完全不依赖 token 的保密性；升级失败从"黑屏/无解释"变成"上次升级 vA→vB 后启动失败 + 一键回退"；关窗进托盘首次有解释，不再出现"窗口消失且找不到"。**覆盖缺口（本机不可验证，已登记）**：浏览器预检的真实行为（`access-control-allow-headers` 是否含 `x-dsh-shell`）、确认窗在 Windows 的观感与 `always_on_top` 置顶效果、**关机路径**（系统关机时 `CloseRequested` 是否会被确认窗拖住）、caption 模式的视觉对照 6 项、`/alive` 清标记的时序、DNS-rebinding 防护的实际有效性。本机只能对 `x86_64-pc-windows-msvc` 做类型检查 + clippy（无 sudo 装不了 dbus/webkit），Rust 单测通过**机械抽取纯函数区域后用 `rustc --test` 真实执行**（6 passed）取得；in-crate 版本由 CI 的 ubuntu `check` job（`cargo test --lib`）执行。


## Addendum · 2026-09-25 Windows 实机（dev 0.11.0 + dsh 0.1.7-rc.2）

**已实机验证**（`D:\Dev\_shots\` 截图 + UIA dump + 回环 curl + 落盘文件）：桥准入 10/10（含 `OPTIONS` 预检 204 且 `access-control-allow-headers: content-type, x-dsh-shell`）；危险确认窗文案由 Rust 生成、取消/确认可用；关窗首次确认（确认前不落标记、确认后写 `background-close-confirmed` 并隐藏、第二次静默隐藏）；caption 几何（菜单按钮 x 5→77、窗口三键高 54→60、内容上移 27px、不双重让位）与视觉；升级标记写出 → 启动成功被 `/alive` 清除 → 注入启动失败后启动页显示「上次升级 vA → vB 后启动失败」+「回退到 vA」。

**新增的四道"跨文件枚举必须双向一致"门禁**（每个都先证明会红再修）：① `sync-resources.mjs` 按 manager 的**相对导入闭包**拷贝（此前硬编码两个文件名 → 新增 `upgrade-marker.mjs` 未随包 → 装机后 manager 启动即 `ERR_MODULE_NOT_FOUND`）；② 危险表 id ↔ `execute_danger_action` 分支 id **双向**一致（此前新增 `titlebar-contract` 无执行分支 → 用户点「确认执行」静默失败）；③ 关于弹窗必须走**带该字段的端点**（`shell-state`，而非 `/shell/status`）；④ 归因字段必须出现在**启动页真正读的结构**里（`shell_status_json`，而非只加在 `manager-exit` 事件负载上 = 死代码）。

**关窗确认的边界（负向保证）**：只覆盖**用户发起**的关闭（☓ / Alt+F4 / 任务栏 / 第三方 `WM_CLOSE`）。系统关机与注销**不经过** `CloseRequested` —— `tao 0.35.3` 不处理 `WM_QUERYENDSESSION`（`platform_impl/windows/event_loop.rs:2382` 注释掉），只在 `WM_ENDSESSION` 销毁事件循环并回 `LRESULT(0)`，因此本次改动**不会**造成"应用阻止关机"。该结论来自源码，**未做真实 `shutdown /s` 实测**（用户决定先不做，已登记在方案 §12.1）。

**关联**：`architecture/2026-09-24-official-desktop-0-1-7-positioning-and-adoptions.md`（定位与采纳清单）。**未决阻断项**：dsh 0.1.7 移除 `settingsScope` 服务 → 预装 `dsh-model-reasoning` 卡死 Web UI（看板有独立卡，需选路）。

## Addendum 2 · 2026-09-26 预装插件与 dsh 地板的耦合门禁

**决策**：壳仓新增静态门禁 `scripts/test-plugin-dsh-compat.mjs`（接在 `npm test` **链尾**，其余套件照跑），把"预装插件要求的能力"与"壳强制的 dsh 地板（`MIN_DSH_VERSION`）"放在一起判定：① 客户端产物（**去注释后**）不得再出现"在地板版本行里已被移除"的服务（当前表：`settingsScope`，0.1.7 移除，替代 `ctx.configForms.get(ns)`）——命中即 FAIL；② 插件声明的 `@deepseek-ai/dsh*` peer 地板必须被壳地板满足——否则 FAIL；③ 完全未声明地板 → 仅警告并列出（缺声明不是破坏性证据，做成 FAIL 会让门禁退化成噪音）。门禁内含 13 条比较器自检；**判"移除是否生效"用版本行比较（忽略 prerelease）**，因为严格 semver 会把 `0.1.7-rc.2` 判成"还没到 0.1.7"从而漏掉真实事故。

**负向保证**：门禁**不**判断"插件在运行时是否真的会激活"（那要真机）；它只拦"静态可判的必然不兼容"。它**不**要求插件补齐 peer 声明（只警告）。它**不**覆盖 dsh 内部服务以外的 API 变化（如 DOM 约定、图标改名）——那些只能靠真机/类型检查。

**当前状态（刻意红）**：仓库里 `dsh-model-reasoning@0.2.4` 仍含 `settingsScope` → 门禁 FAIL、`npm test` exit 1。这是真实状态：**该组合（0.2.4 + 地板 0.1.7-rc.2）装出来就是打不开的 UI**；把插件同步到 0.2.6（已适配，真机验证通过）后自动转绿（正向对照已用本地构建预演）。

**关联**：`dsh-preinstalled-plugin-sync` 技能 §6.5（同步前必查三条 + 本门禁）；方案 §13.3/§13.4/§13.5。
