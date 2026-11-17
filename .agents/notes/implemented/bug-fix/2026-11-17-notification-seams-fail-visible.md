# Agent Note: notification-seams-fail-visible

Status: implemented (P1-4 #279 / P1-2·P1-3·P2-4 #281)

## Problem

通知插件的三个客户端 seam 全都是「读得到就当它永远在」的假设：

1. `inject: ['sessions','connection','uiSession','uiWorkspace']` —— cordis 里 required inject 缺一个，插件 fiber 就停在 pending，而 dsh web boot 对 pending 条目是 fail-closed（`web boot: N entries did not activate`）。上游只要改一个服务名，**整个 UI 白屏**（连 dsh 自己的插件页都打不开），不是"通知失效"。
2. 版本地板是 `@deepseek-ai/dsh-client-runtime >=0.1.0-rc.5`，但该包在 dsh 0.2.x 依赖图里**不存在**（npm registry 版本止于 0.1.1-rc.2），而 `>=0.1.0-rc.5` 对任何 0.2.x 恒真 —— 守卫永远判"满足"，等于没有守卫。
3. 结束原因分类读 `ctx.connection.api.sessions.history`，而 `ConnectionHandle` **没有 `api` 成员**（`@deepseek-ai/dsh-client-connection@0.2.2-rc.1` 类型里也没有 session history/events API）。于是分类永远走 catch/fallback，"完成"是硬编码默认值：生产日志 155/155 `notify-classified = completed`，0 error。错误/中断/被阻止全被播报成「任务完成」。

## Decision

**把"seam 可能不在"当成常态，失败必须可见、绝不可升级成整站故障。**

- `inject: []`。cordis 4.1 的 `Inject` 是 `string[] | { [name]: interceptConfig }`，**没有 optional 形式**（不是 `{required, optional}`），所以"标成可选"这条路不存在；唯一能保证"缺 seam 不卡 boot"的做法是零 required 依赖。四个服务改为运行时 `svc(ctx, name)` 解析（`ctx.get` 优先，回退 `ctx[name]`，服务晚注册也能拿到）。
- 两个 observable 独立就绪：`sessions.list` 与 `uiSession.sessionStatus` 各自 200ms 重试订阅，20s 后各打一条可读 `/log degraded`（测试用 `globalThis.__DSH_NOTIFY_READY_TIMEOUT_MS__` 缩短窗口）。缺 `sessions` ⇒ 通知器空转；缺 `uiSession` ⇒ 只损失托盘 ●/○ 与「需要你」toast，回合结束通知照发；缺 `uiWorkspace` ⇒ 点击时记可读错误。**任何一项都不能阻止 dsh 启动。**
- 地板改成真实包 + 真实下限：`@deepseek-ai/dsh-client-ui-session` / `@deepseek-ai/dsh-client-ui-workspace` `>=0.1.6-alpha.2`（下载 npm tarball 逐版本 grep 证实：`sessionStatus` 与 `openSession` 都首次出现于 0.1.6-alpha.2，0.1.2-alpha.2 里都没有），并按预装插件惯例标 `peerDependenciesMeta.optional`。
- 结束通知只承诺能证明的事：文案统一「dsh 任务已结束 / 「X」已结束」，**永不**说「已完成」。`END_KINDS`、基于原因的 `ERROR_COOLDOWN`、死探针全部删除。
- 托盘 ○ 由插件自己记录 `running` true→false 的 ended-unviewed 集合（新 run 清除），不再依赖 dsh 的 `completionUnread`（后者只对非 main view 会话置位，招牌场景永远不出现）。视图选择在 session Controller 之外（`service.d.ts` 明说 view selection remains outside the Controller），无法检测"用户打开"，所以语义改称「已结束未查看」。
- `pendingInteraction` 是对象 `{key, kind, sessionId}`：取 `.kind`（兼容字符串旧形状），body 拼 `「标题」`，日志记 `pendingKind`（对象被 Rust `as_str` 丢弃是另一个静默点）。

## Alternatives considered

**把 inject 标成 optional**：不存在。cordis 4.1 的 `Inject` 对象形式是 intercept config，不是 `{required, optional}` —— 先读类型再动手，否则会写出"看起来可选、实际仍 required"的假修复。

**保留 `ctx.remote.session.events(...)` 做分类**：无法在本机核实该 seam 存在（connection 包类型里没有，dsh 源码不在本机），按纪律未验证的断言不得作为修复依据；宁可中性文案，也不猜。

**用 `item.completed` 兜底漏掉的快速任务**：`SessionSummary` 没有 `completed` 字段，该分支在 0.2.x 恒不成立，已注释说明，等上游提供 start/end 流再修。

**把守卫逻辑改到 manager**：`applyPluginFloorGuard` 只扫 `resources/preinstalled`，而本插件是 `--patch` 注入的，需要改 `scripts/plugin-floor.mjs`/`server-manager.mjs`（W1/W3 写域，lead 已登记为后续任务）。本批次只保证地板声明真实、可判定（用守卫的纯函数证明了 quarantine 行为）。

## Consequences

- 代价：缺 `sessions` 时通知完全静默（只有日志可查）；结束文案失去"完成"的区分度（这是诚实的代价，不是遗漏）；托盘 ○ 不会因"用户打开"而消失（只能等新 run），README 已如实改写。
- 换来：上游任意一个 seam 改名/移除都不会再白屏；结束通知不再把失败说成完成；地板声明终于能拦住旧 dsh。
- 覆盖：`scripts/test-client-notifications.mjs` scenario 20-22、34-38（含三条负向对照）；`test-automation-gates` 等既有门禁全绿。
