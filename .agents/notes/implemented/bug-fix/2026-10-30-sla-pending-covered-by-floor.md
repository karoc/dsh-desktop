# Agent Note: sla-pending-covered-by-floor

Status: implemented

## Problem

SLA 报表的「待适配版本」段把上游发过、也开过单、但从未被任何壳版本**恰好**用作地板的版本永久算成 pending。地板是单调上移的：rc.3/rc.4 在 2026-10-29 抬到 rc.5 时被直接跳过，于是报表在 v0.21.1 发布后仍显示「还有两个版本没适配」——这类假信号每次抬地板都会新增一条且永不清零。反向的问题也在：报表「当前状态」用发布时间先后判断通道是否领先地板，而 `0.2.2-alpha.2` 的发布时间早于 `0.2.1-rc.5`（alpha 线先切出来），导致语义上更高的 alpha 被显示成「不晚于地板」。

## Decision

两处都改成**语义化版本比较**，实现共享在 `scripts/lib/version-compare.mjs`（`cmpVersion(a,b)`，语义逐条对齐 `dsh-watch.mjs` 的 `cmp`：正式版 > 同号预发布、预发布数字段按数值、字母段按 ASCII、多段预发布保留）。`scripts/lib/sla-pending.mjs` 的 `classifyPendingVersions` 用 `cmpVersion(floor, version) >= 0` 判定「该版本已被某地板覆盖」，覆盖者取**我方发布最早**的那个壳版本；结果分 `pending` 与 `covered`（附 shell/floor/我 方发布时间）。报表把 covered 单列一段「已被更高地板覆盖（不计入待适配）」，JSON 新增 `detectionStats.pendingCovered`（`--json` 只增不改），"注意"段对 covered 版本改说「已被更高地板覆盖」而不是「没有任何壳版本携带它」。非法/解析不出的版本（如 `0.2.x`）**保守留在 pending**，不静默清账。共享比较器是本仓库第 4 处版本比较调用点 —— 已把它纳入 `test-version-compare-parity.mjs`（该套件从源文本抽函数、与 watch/probe/manager 三份互相比对结论），避免成为没人管的孤本。
## Alternatives considered

**沿用发布时间先后作代理**（第一版实现）：被真实数据当场否决 —— `0.2.2-alpha.2` 发布时间早于 `0.2.1-rc.5`，会被误判成「已被 rc.5 覆盖」，而它语义上更高、仍是待适配版本；跨版本线时发布时间与版本序不单调。**在 `dsh-sla-report.mjs` 里再抄一份 cmp**：否决 —— 仓库的三份实现已经因各自漂移出过事故（审计 P0-1/P0-2），第 4 份若不被 parity 覆盖就是新的漂移面；所以单独成文件并进门禁。**只把「同 core 的更高预发布」算覆盖**（例如 rc.3/rc.4 由 rc.5 覆盖，但 0.3.0 不覆盖 0.2.5）：否 决 —— 会把真正被跨版本跳过的情况永远留在 pending，只是把假信号缩小到更少见，没有解决判据本身。
## Consequences

买到：`pending` 重新等于「真欠账」（当前只剩 `0.2.2-alpha.2`，与决策 ③C「alpha 只跟踪不适配」一致），rc.3/rc.4 从计数里消失但保留检测段数字可追溯；「当前状态」的通道领先判定也不再被发布时间误导（实跑：`alpha=0.2.2-alpha.2 晚于壳地板 ⇒ 已被发现 #239`）。代价与边界：① 版本语义现在依赖 `cmpVersion` 的正确性 —— 由 parity 套件（24 条用例矩阵 + 域外输入记录）与 gates 的 sla 组单测（含「alpha 不得被 rc.5 覆盖」负向对照）双重守护；② `cmpVersion` 对非 semver 输入会把缺段当 0（同其余三份，域外），所以 `sla-pending` 里先做严格形状校验，解析不出的版本留在 pending 而不是「已覆盖」；③ 报表的检测段口径未变（unknown 仍不当 0，门禁仍只看 `total ≤ 6h` + since 窗口）；④ 真实端到端只在开发机跑过一次（`--json` 产物已核对），CI 的周报 job 走同一脚本、无需改工作流。

