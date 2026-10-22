# Agent Note: watchdog-recheck-and-lifecycle-source

Status: implemented

## Problem

两个已定性的取证缺陷（时间线 2026-10-23 05:54）：

1. **watchdog 误杀**：壳侧探针在 `05:54:47` 已记 `dsh web probe recovered after 3 miss(es)`，manager 侧却在 `05:54:50` dump 出 409MB 后于 `05:54:51` 仍执行 `restarting dsh`。旧实现把"dump 完成/等待超时"当成"确认死亡"，实际它只证明抓现场的那一刻曾经无响应；一次已自行恢复的短暂卡顿被打断成 400MB dump + 重启级联。
2. **退出/重启静默**：`quit_app` / `restart_server` 不记录来源；桥只在**拒绝**时写 `bridge reject: …`，成功的危险请求不记 origin + path。事后无法回答"这次退出/重启是谁触发的"（tray / bridge / chrome / launcher）。

## Decision

**watchdog（`scripts/server-manager.mjs` + 随包副本）**：探活抽成 `probeLiveness(url) -> {ok,status|error}`（2xx–4xx 算活着，与既有判据一致），`watchdogTick(hooks)` 在 dump 等待结束后、kill 之前**再探一次** `stuckUrl`。恢复 ⇒ 清零 `watchdogMisses`、用 `stuckUrl` 重新 arm、`watchdogArmedAt=now`（重给 30s 启动宽限，避免恢复瞬间再判挂起），并记 `watchdog: dsh web recovered after <n> miss(es) (probe <status>, <elapsed>ms, dump <ready|unconfirmed>) — no restart`。仍无响应 ⇒ 记 `still UNRESPONSIVE after dump … — restarting dsh` 并照旧 kill+restart（安全边界不堵）；`dumped=false`（壳不在/超时）同样先再探。新增两条日志纪律：耗时从**首次 miss** 起算；URL 只记 `scheme://host:port`（`logSafeUrl`），启动 `?token=…` 不再落 manager.log。`--self-test-watchdog` 把桩（probe 序列 / waitDumpDone / kill / log）注入**同一个 `watchdogTick`**，覆盖"3 次 miss → dump 窗口内恢复（kill=0）"与"dump 后仍无响应（kill=1）"；`scripts/test-watchdog-recovery.mjs` 进 `npm test` 链，并在临时副本上做三个变异自证（恢复分支恒假/恒真、`recovered` 措辞被改）——每个都必须变红。

**来源可追溯（`src-tauri/src/lib.rs`）**：新增 `lifecycle_log_line`/`log_lifecycle_request`（纯格式化 `{action} requested by {source} path={path}`，不写完整 URL/token）、`restart_server_from`/`quit_app_from`。`#[tauri::command]` 的 `restart_server`/`quit_app` 保持**原参数形状**，作为 IPC 入口固定记 `source=launcher path=ipc:<cmd>`；内部调用点改传真实来源：托盘 = `tray`（`tray:restart`/`tray:quit`）、桥直连臂 = `bridge`。危险动作经确认窗执行时，`PendingConfirm` 新增 `source`/`path`，由桥在登记时传入（`bridge_danger_source`：回环 http Origin = 注入的顶栏/菜单 → `chrome`；无 Origin/其他 → `bridge`；关窗确认 = `shell`），`approved/declined` 日志与 `quit/restart` 来源日志都用它。桥在**准入通过后**立即写 `bridge danger accepted: action=… source=… method=… path=… origin=…`（origin 是 `scheme://host:port`，无 token）。

**未做**：不新增 IPC 命令参数让前端自报来源（会扩 ABI 且可被任意页面伪报）；不把来源升级为授权判断；不动壳侧 dump 链路与 `dump-web/dump-done` 协议。

## Alternatives considered

**dump 前探一次 / 用固定等待代替再探**——放弃：无响应到 dump 完成之间才是恢复窗口，探在 dump 前等于没修；固定等待只是延后误杀。**只对 `dumped=true` 再探**——放弃：壳不在时等待上限 30s 同样可能跨过恢复窗口，反而漏掉最常见的"壳没回执"路径。**两次 miss 就恢复判定**——放弃：会引入新的假阴性（真挂起时把服务当活着），与安全边界冲突。**给 Tauri command 加 `source: String` 参数由前端传入**——放弃：前端（chrome/launcher）自报来源可伪造且扩 ABI；IPC 入口固定 `launcher` 已能回答"是本地页面还是托盘/桥"，Windows 主窗口的菜单动作走桥、仍能被归为 `chrome`。**只给 `quit_app/restart_server` 加日志、不记录桥 origin/path**——放弃：那只能回答"是桥"，回答不了"哪个页面、哪条端点"，而拒绝路径本来就记这两项，成功路径不记正是缺口。**把 watchdog 判定抽到独立模块便于单测**——放弃：随包 manager 是单文件 + 字节一致副本，新增模块会破坏 `sync-resources` 的模块图门禁；自测钩子留在同一文件、只在显式 flag 下运行。

## Consequences

买到：已恢复的卡顿不再被 kill（负向对照证明 kill=0），真挂起仍会重启（kill=1）；两条日志线把"谁触发"从不可知变成 `tray/bridge/chrome/launcher + path`，并顺手堵住 watchdog 旧日志把带 token 的完整 URL 写进 `manager.log` 的泄漏。代价与边界：① 自测钩子随包发布（约 2KB，只有 `--self-test-watchdog` 触发；判定逻辑与生产路径共用同一函数，避免"测试通过、生产另一条路"）；② 恢复后再探成功时会重给 30s 宽限，真挂起若恰好卡在宽限内会晚 30s 才处理（可接受：宽限是为加载期误判设的）；③ `path` 对 IPC 只能是 `ipc:<cmd>`，无法区分 launcher/settings 具体页面；④ Rust 单测（来源归类/日志格式）在 CI ubuntu job 跑，本机缺 `javascriptcoregtk-4.1` 开发库无法 `cargo check`（已如实登记）。相关笔记：../feature/2026-09-09-dsh-web-hang-dump-and-service-job.md（其"dump 完成即重启"的 manager 侧策略被本条部分取代）、../feature/2026-09-09-manager-exit-guard-forensics.md。
