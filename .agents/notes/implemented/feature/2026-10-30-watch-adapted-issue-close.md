# Agent Note: watch-adapted-issue-close

Status: implemented

## Problem

跟踪 / SLA issue 的生命周期只有「开」和「人工关」两半：autopilot 的入口恒为「本轮检测到新版」，适配 PR 合并、地板抬到 target 后，`dsh-watch` 就不再报这个版本，于是那条 issue 永远停在 open。2026-10-30 的实例：#217（rc.3）、#235（rc.4）、#236（rc.5）在 v0.21.1 发布后仍全是 open，只能人工逐条关；再往前 #201–#217 的重复单也靠对账和人工。后果是「issue 状态」不能当作「现在欠不欠账」的读数——红单会一直红到有人记得收拾，和 SLA 报表的闭环也对不上。

## Decision

`scripts/dsh-watch.mjs` 每轮（有 target 与无 target 的代码路径都算）新增 A12「已适配跟踪单收敛」：从每条 open issue 的标题里用 `scripts/lib/issue-key.mjs` 的 `versionInTitle()`（只认本脚本标题前缀 + `dsh <版本>` 锚点 + 词边界）取出目标版本，凡 `cmp(floor, version) >= 0`（壳地板已覆盖该版本）就 `gh issue close --reason completed`，再补一条「已适配：壳地板已抬到 …」评论（带 `<!-- dsh-watch-adapted: version=… floor=… -->` 机器标记）。四条边界是刻意的：① 只关**本脚本自己开的**跟踪单——别人写的 upgrade issue 不碰；② 解析不出版本的单不碰（不猜）；③ **目标比地板新的单不碰**（alpha 通道领先时的 #239 就是当前未适配单，必须保持 open）；④ 走既有的 `runWrite()`（第一次 403 即停写，转成「待人工关闭」清单）并尊重 `--dry-run`/`PAUSE`（只列计划与可复制命令、零写）。为避免和 A10 重复单对账打架，被 A12 覆盖的版本会先从 `reconcilePlans` 里过滤掉——同版本的重复单由 A12 统一关闭（都带「已适配」说明），不会出现「一条说重复于 #N、一条说已适配」。`report.adapted` 进 JSON，便于排障时看它关了谁。桩测加在 `scripts/test-automation-gates.mjs --only watch` 的 A12 组：正向「地板 rc.5 ⇒ rc.3/rc.4 关闭、#239 保持 open」、幂等「再跑不重复关」、`--dry-run` 零写、负向「地板 rc.2（更旧）⇒ 一条都不关」。
## Alternatives considered

**继续人工关**（现状）：否决——这正是问题本身；红单堆积后没人能靠 issue 状态判断欠账。**让 autopilot 在自己流程末尾顺手关**：只覆盖「autopilot 真的跑完 ③–⑧」的那次；`--stage1`、人工合并（v0.21.1 就是人工发的）、以及本机没在跑的时段都不覆盖，而且 autopilot 是「跑完才关」，与 watch 每 10 分钟的常态轮次相比覆盖更差。**用「本轮无 target」当判据**：不对——alpha 领先时每轮都有 target，但 rc.3/rc.4 早该关；判据必须是 `floor >= 该单的版本`，不是「有没有新版本」。**按 label / state 判**：label 在事故 #201–#217 里从未落地，按它判会重演「查不到就再建一条」的漂移。
## Consequences

买到：issue 状态重新可信——地板一抬，下一轮（≤10 分钟）就把被覆盖的跟踪单收掉，SLA 报表读 `state=all` 仍保留历史证据，闭环完整。代价与遗留：① 地板抬升后的第一轮会多出 N 次 close+comment 写（N = 被覆盖的单数，一次性且有界）；② 它依赖读到的 `floor` 正确（来自 `scripts/server-manager.mjs`，与 watch 其余判据同源）——若有人手工改地板却没发布，这些单会被提前关掉，属于「地板即真相」的既有前提；③ `--dry-run`/`PAUSE` 下只给清单，仍需人工执行；④ 关单失败（403）不把整轮判红——因为它是收敛动作而非探测判据，失败会打印可复制命令，权限问题会由其他写路径暴露。

