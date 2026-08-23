# Agent Note: notification-double-toast-scan-mutex

Status: implemented

## Problem

DSH Desktop（Windows）用户报告系统通知 toast 每次都会弹两次。需要定位双弹来源并给出无副作用、经多方独立验证的修复方案。桌面壳的通知链路：注入 dsh Web 的客户端插件 @dsh-desktop/client-notifications 订阅会话 store，在 pendingInteraction 出现或 running true→false 时 POST /notify 到回环 HTTP 桥，Rust 端 show_toast 弹原生 toast。

## Decision

根因定位（三独立子代理 + 实测复现 scripts/repro-double-notify.mjs 交叉验证）：双弹不在 Rust 桥（/notify 一次一 toast、notify-rust 与 tauri-plugin fallback 互斥）、不在插件双加载（dsh 加载链每层去重/loud error，单页只 apply 一次）、不在 Web 内部 toast（InputBar 与 ModelSelect 无双通道），而在 plugins/dsh-client-notifications/client.js 的 scan() 两个活机制：①完成边沿与 pending 边沿不互斥（pending 分支无 continue，dsh Notifier 将 N 次 mutation 折叠为一次 microtask flush，任务收尾+提问/审批/审阅帧同快照 → 一次 scan 发两条 POST「任务完成」+「需要你」）；②父会话与嵌套 subagent 子会话在 lineage 投影中各占一行、各自 running/completed 独立，子行标题回退共享 cwd → 同一任务弹多条文案相同的 toast。

修复（确定性、零时序副作用，已落地并同步两份拷贝：plugins/ 为源，scripts/sync-resources.mjs 镜像到 src-tauri/resources/plugin/；经两轮独立审查修订）：
- **规则A（完成通知仅限非 subagent 行）**：`const isSubagentRow = item.origin === 'subagent'`；完成类分支（主路径 + completed fallback）在子代理行上静默（notify-complete-suppressed，ended:true）。判根用 origin 而非 parentId——`origin?: 'subagent'` 是 host 唯一 origin 值，fork 子会话（parentId 在、origin 空）是独立任务，完成必须照常弹；第一版 `!parentSessionId && !parentId` 判根把 fork/孤儿完成也静默（审查 SE2/SE3），改为 origin 语义恢复。
- **规则B（完成与 pending 互斥，同快照）**：完成边沿若本行 pending 为真则不发「任务完成」（只发「需要你」）并置 ended:true + continue 防 completed fallback 误补发，fallback 分支同样加 !pending，且加 !isSubagentRow。
- **规则C（pending 全行通知）**：pending 分支不受 subagent 限制——approval/question 帧按请求方会话记账（api-proxy.ts:1417），客户端无父级中继，子代理提问只落子行；第一版整行跳过导致「子代理在等你批准/回答」完全静默（审查 SE1，原注释"root row too"为假），修订后保留子代理交互的「需要你」。
- 测试：scripts/test-client-notifications.mjs 由 12 扩至 19 场景（13 同快照互斥、14 父+子代理单发、15 子代理 pending 单发、16 干净完成、17 回答后完成、18 fork 子会话完成单发、19 子代理行完成静默），新增 scripts/repro-double-notify.mjs 断言修复后单发与子代理需要你不丢失；npm run test:plugin 全绿。
- residual：① 分快照交付（running→false 与 pending 分帧，间隔>1 flush）时完成 toast 先弹、需要你后弹——生产 Notifier 将同 tick mutation 合并为一次 microtask flush（notifier.ts:37-42），同批帧即同快照，主场景已覆盖；若真分帧需 ~1s settle 窗口延迟完成 toast，本轮未做。② 双页面实例（webview 之外浏览器 tab 开同一 dsh URL）各自 POST，完全相同 toast 双弹——client 内无法去重，需 Rust /notify 桥短窗口去重或关闭多余 tab，日志可区分。ENGINEERING-NOTES.md §33 已记录根因、修法与用户侧日志验证步骤（%APPDATA%\dev.dsh.desktop\dsh-desktop-session.log 的 notification:/client/log notify-* 行）。
## Alternatives considered

- **双订阅/双实例假设**：最初怀疑插件被注册两次（两份拷贝、patch 重复、bundles+patch 同插件）→ 被加载链子代理逐层证伪：roster 同 id 重复即 loud boot error（vendor/loader/src/config/group.ts:64），浏览器 graph 按包名去重（client/modules/src/index.ts:491），register 对重复 factory 抛错（client/system.ts:104-110），materialize/arrive 幂等；仅当 webview 之外另有浏览器 tab 开着同一 dsh URL（两个页面实例各一个插件）才会真双发，属需日志确认的残余，非主因。
- **Rust 双弹假设**：notify-rust 成功 + tauri-plugin fallback 同时弹、或 desktop-notification 事件路径复活 → lib.rs 中 match 互斥（:371-403）且全仓无该事件 producer，排除。
- **settle 窗口方案**：用 ~1s 定时器延迟完成 toast 以覆盖分离交付 M1b → 正确但引入时序副作用（完成通知延迟）与定时器清理复杂度，本轮未做；作为可选加固记录在案。
- **Web 内部 toast 双弹**：promptError 与 notice 双通道是否同事件双 toast → 子代理 3 证伪（互斥），不属于此问题范围。
## Consequences

- 修复后：交互型回合结束（提问/审批/计划审阅）只弹「需要你」一条；带子代理的任务只弹父会话一条「任务完成」；干净完成不受影响；fork 分支任务照常弹自己的完成；子代理（origin:'subagent'）完成静默（由父会话覆盖）。
- 生产分发依赖重打包：client.js 烘焙在 desktop bundle 的 resources 里，用户需更新桌面壳版本生效；dev 侧 sync-resources 已双向一致。
- 若用户升级后仍偶发双弹（完全相同文案、成对 notification: 行），为双页面实例残余（浏览器 tab），按 ENGINEERING-NOTES §33 的日志区分步骤处理，与本次修复无关。

