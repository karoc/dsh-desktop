# Agent Note: sla-detection-label-to-issue-key

Status: implemented

## Problem

SLA 报表的"检测延迟"（上游发布 → 我们第一次为这一版开 issue）通过 `gh issue list --label dsh-upgrade` / `--label sla-breach` 取数。真实事故 #201–#217 里 PAT 缺 Issues:write：`issue create` 能过、label 从未落地（16 条 issue 无 label）⇒ 报表查到 0 条、把每个版本的检测延迟都静默判成「未检测到」，而 issue 明明开着。同时 `dsh-watch.mjs` 按标题去重、报表按 label 取数 —— 同一件"这是哪一版"的判断有两份实现，口径必然漂移。

## Decision

新增 `scripts/lib/issue-key.mjs`，作为跟踪 issue 确定性键的**唯一实现**，`dsh-watch.mjs`（写/去重/对账/跃迁评论落点）与 `dsh-sla-report.mjs`（读/算检测延迟）都从这里导入：只认标题前缀 `[dsh-watch]` / `[SLA 未达标]`；版本号用词边界（前后不能是 `[0-9A-Za-z.-]`，故 `0.2.1` 不匹配 `0.2.1-rc.2`/`0.2.10`，`0.2.1-rc.3` 不匹配 `0.2.1-rc.30`）；`dsh <版本>` 锚点优先于全文唯一版本号，多个版本号且无锚点则返回 null 不猜。报表改为一次 `gh issue list --state all --limit 1000` 全量拉取后按该键筛选：**不看 label / assignee / state**（关掉的单同样是"当时被发现过"的历史证据，检测取 `createdAt`）；`--limit` 命中上限仍拒绝出数（被截掉的可能是最早的 issue ⇒ 检测只会偏大）。同版本多条 issue 取**最早创建**（`earliestTrackingIssue`，同刻创建按编号小的优先，与列表顺序无关），表格「首次 issue」列印 `#编号 + 时间`，`注意` 段逐版本说明取了哪条。新增「待适配版本的检测延迟」段（上游已发布 + 已有跟踪单、但我方还没发版的版本，配不到"我方发布"故不进两段表），`--json` 增 `detectionStats.pending`；这是检测段在发版前唯一能露出的窗口。`dsh-watch.mjs` 只把本地正则/函数换成导入，行为零变化（既有 watch 组 32 条断言全绿）。负向保证：不靠 label（label 缺了也出数）、不猜版本号、不把 unknown 折成 0、`--state all` 但只认本脚本标题前缀（不误把人类 issue 或 `sla-report` 周报单当跟踪单）。
## Alternatives considered

**保留 label 方案、只修 AND 语义（各 label 查一次再合并）**：否决 —— OR 合并只解决"查不到"的一半；事故里 label 根本没落地，任何 label 查询都恒空，必须彻底不依赖 label。**按"每个地板版本用 versionRe 匹配标题"取 issue**：否决 —— watch 的 SLA 标题里会写"地板仍停在 0.2.1-rc.2"，按地板版本做子串/词边界匹配会把该单误配给旧地板；必须用 `dsh <版本>` 锚点取出 target。**两份实现各自保留、只改报表那份**：否决 —— 这次漂移正是两份实现造成的（watch 去重一套、报表取数另一套），共享模块是唯一能长期防复发的结构。**把 `--state all` 换成 `--state open`**：否决 —— 检测延迟要历史证据，关掉的单也证明"当时被发现过"。**把检测延迟写进门禁**：否决 —— 它是平台属性（探测机器是否在跑、API 是否限流），写进 `--check` 会让红绿随平台抖动；门禁口径保持只看 `total`。**把 17 条同版本 issue 的"已开单未适配"逐条打印**：否决 —— 一条事实刷成 17 行噪音；改为按版本报一次并给条数。
## Consequences

买到：检测段第一次在真实仓库上有可判定样本 —— 2026-10-24 实跑 `0.2.1-rc.3`（上游 `07:54Z` → 最早跟踪单 #201 `08:00Z`）**0.10h**，而旧实现同一数据下恒为「未检测到」（17 条同版本 issue 里只有 #217 带 label，且它开于 10:30Z，即使看到了也会算出 ≈2.60h）；负向对照在同一批夹具上跑新旧两版：无 label ⇒ 新 0.10h / 旧未检测到，`rc.30` 不匹配 `rc.3`（`versionRe=false`、`findTrackingIssue=null`），3 条同版本 ⇒ 新取最早 #10（0.26h）/ 旧只看得到带 label 的 #11（1.09h），且**已关闭**的 #10 必须算。代价与遗留：`gh issue list` 从两个 label 各 100 条变成一次全量 1000 条（本仓库 20 条 issue，规模无关紧要）；7 个历史已量出版本仍全部「未检测到」——原因变成"它们的上游发布早于 watch 第一次开单"，检测段在这 7 行本来就没有样本；#201–#216 这 16 条无 label 的重复单仍需人工关闭（PAT 权限问题不在本改动范围）；本改动没有把新旧 A/B 断言并入 `scripts/test-automation-gates.mjs`（任务写域不含该文件），负向对照目前只是 /tmp 一次性夹具 —— 归入看板"把 sync/负向对照并入 test-automation-gates"卡。

