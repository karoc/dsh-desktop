# Agent Note: watchdog-bounded-stall-tolerance

Status: implemented

## Problem

dsh 0.2.2 的 Web 侧栏「插件」页**首次打开**会让 dsh web 的事件循环同步阻塞 2–12s：页面一开就并发发起
pluginInventory/list、pluginManager/listBundles、pluginManager/listPlugins 三条 Remote，每条都要对全部
Loader entry 做一遍 metaOf() → readPluginMeta() → dictionariesOf()（readdirSync + 逐 locale 文件 ESM
resolveSync + readFileSync，**无缓存**）。上游代码在 rc.1→rc.3 未变；复现与 profile 数据见
.agents/notes/upstream-issues/2026-11-17-plugin-page-first-open-blocks-event-loop.md。

壳侧 manager watchdog 用「每 3s 探一次 /、单次 1.5s 超时、连续 3 次 miss ⇒ 请壳抓全内存 dump → 再探 →
仍无响应就 kill + 重启」判定。事件循环被同步扫盘卡住时连 GET / 都无法服务，于是**一次会自恢复的停顿被
升级成 357MB dump + 重启 dsh**，用户会话被中断（manager.log：22:59:51 miss1 → 22:59:57 miss3 →
23:00:02 recheck 仍超时 → 23:00:03 restarting；dump 357,659,395 字节）。

## Decision

把判定从 supervisor 循环里抽成纯逻辑 scripts/lib/watchdog-policy.mjs（阈值只此一份），manager 只把事实
喂进去、按结论执行：

- 启动静默期（URL arm 后 30s）不变：不计数 miss（2026-09-05 重启风暴的历史修法）。
- **启动宽限（arm 后 120s 内）**：连续 **5 次 miss（≈15s）** 才进入恢复路径（旧规则是 3 次）。
- **宽限外**：维持 **3 次 miss（≈9s）**，与既有行为一致。
- 进入恢复路径后、**在请壳抓 dump 之前**，先用 **15s 长窗口再探一次**（PRE_DUMP_PATIENCE_MS）：应答了就记
  watchdog: dsh web slow but alive after N miss(es) … — no dump, no restart 并重新 arm；仍然无响应才走原来的
  dump → 再探 → kill+restart。真挂起的重启边界没有放宽，只是判定最多推迟 15s（外加 dump 本身耗时）。
- miss 日志带相位与真实无应答时长：watchdog: dsh web miss 2/5 (startup, 3.0s without an answer) (host:port)
  —— 既能看出「处于启动宽限」也能看出「第 N 次 miss」；URL 仍只记 scheme://host:port，token 不落日志。

可失败门禁：scripts/test-watchdog-policy.mjs（纯函数边界：120s 边界、宽限内外、窗口不足、非法输入）接入
npm test；scripts/test-watchdog-recovery.mjs 从 2 场景扩到 5 场景，变异自证从 3 个扩到 5 个（新增：慢探针
恢复分支恒假 ⇒ 场景 3 必红；启动宽限阈值退回 3 miss/9s ⇒ 场景 4 必红）。dump 前耐心再探与 dump 后再探是
两个独立分支（if (patient.ok) / if (recheck.ok)），各有自己的变异对照，避免共用一个恒真断言。

## Alternatives considered

**只把单次探针超时从 1.5s 抬到 15s**：否 —— 超过 3s 的探针会与 3s 的 tick 重叠，且真挂起时第一次判定被
拖到 15s；不如保持探针快，把「耐心」只放在破坏性动作之前。
**完全取消 dump（只重启）**：否 —— dump 是真挂起唯一的现场证据；本轮反而**减少**了无意义 dump（自恢复
停顿不再产生 300MB+ 文件）。
**manager 启动后预热一次插件 API**（任务书候选）：否 —— 需要 manager 实现 typert WebSocket RPC 客户端
（与服务端帧格式耦合、版本脆弱），收益只是把 2–12s 从「用户点击时」挪到「启动时」；真正的修法在上游
（缓存/异步化），壳侧不应为绕过一个可诊断的停顿复制协议。
**「最近有用户交互就不重启」**：否 —— 需要壳侧上报交互状态，跨进程契约变大且不可单测。
**直接把上游 patch 进 runtime**：否 —— 会破坏「官方包不被修改」的升级前提（dsh-desktop 既有约定）。

## Consequences

买到的（真机验证）：① 首开插件页（5944ms，GET / 单次最长 2.1s）不再触发 dump/重启——manager.log 只有
miss 1/5 (startup) 且无 UNRESPONSIVE；② 真挂起（NtSuspendProcess 冻结 dsh web）在宽限外（URL 后 142s）
仍然 dump + restart（miss 1/3 (steady) → … → still UNRESPONSIVE after dump (22504ms) → restarting），宽限内
（101s）走 5 miss/15s 同样能重启（28508ms 完成）。

代价与边界：真挂起的重启判定最多推迟**约 15s** + dump 耗时；**页面首开仍然慢**（本 note 只治误重启，不治
慢）；宽限内阈值比宽限外宽（4 次 miss 不重启）是刻意取舍。**未做**：不改 src-tauri/src（壳侧 dump 逻辑与
HangDump 状态机保持原样）、不改 proxy/安装/重启路径、不向上游提 PR（只在 .agents/notes/upstream-issues/
留 issue 草稿）。

配套结构改动：sync-resources.mjs 与 test-copy-consistency.mjs 现在保留 manager 模块图的相对子目录
（lib/watchdog-policy.mjs 随包进 resources/manager/lib/），否则新模块源码侧全绿、安装包里
ERR_MODULE_NOT_FOUND（2026-09-25 同类事故）；test-shell-chrome.mjs 的契约断言从「manager 里有
WATCHDOG_STARTUP_GRACE_MS」改为「manager 走 decideWatchdogRestart + policy 文件与副本字节一致」；
README/CONTRIBUTING 的测试套数 34→35 与看护行为描述同步更新。
