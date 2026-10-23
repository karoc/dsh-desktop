# Agent Note: sla-two-segment-latency

Status: implemented

## Problem

SLA 报表（`scripts/dsh-sla-report.mjs`）此前只给一个混合数字：上游发布 → 我方发布（`total`）。它把两件性质不同、要采取不同动作的事混在一起 —— "上游发了我们多久才发现"（探测/值守）与"发现之后多久发出稳定版"（适配/发布）。实测瓶颈常常在前者（如 0.15.0 的 143h 抬地板段），但报表读不出这一点；同时任务书给出的取数命令 `gh issue list --label dsh-upgrade --label sla-breach` 在本仓库恒返回空（gh 的重复 `--label` 是 AND，而 `dsh-watch.mjs` 对同一个 issue 只挂其中一个 label），会把"查不到 issue"伪装成"确实没有 issue"。

## Decision

报表现在输出**两个数字 + 一段实时信号**，口径写在脚本头注释里：**检测**（`detection`）= 上游发布 `time[地板]` → **首次为该版本开 issue** 的 `createdAt`；**适配**（沿用原 `release` 字段）= 地板提交 → 我方发布；另保留**抬地板**（原 `adapt` 字段）= 上游发布 → 地板提交与**合计**（`total`，门禁判它）。表头只改列名（旧"适配"→抬地板、旧"发布"→适配），JSON 字段名与语义**只增不改**：新增 `detection/detectionStatus/detectionIssue/detectionIssueAt/detectionIssueClosedAt/detectionAnomaly`（逐行）、`detectionStats`、`currentStatus`、`warnings`、`segments`、`now`。检测的数据源**不再按 label**（2026-10-24 修正，见 `../bug-fix/2026-10-23-sla-detection-label-to-issue-key.md`）：`gh issue list --state all --limit 1000` 全量拉取后用与 `dsh-watch.mjs` 共用的确定性键 `scripts/lib/issue-key.mjs` 筛选（标题前缀 + 版本号词边界 + `dsh <版本>` 锚点优先，watch 标题里同时有 target 与"当时的地板"两个版本号）—— 原 label 方案在 PAT 缺 Issues:write、label 从未落地时恒查到 0 条，会把每个版本的检测延迟静默判成「未检测到」。**找不到对应 issue ⇒ `detection=null` + `detectionStatus='unknown-no-issue'`，表格印「未检测到」，绝不当 0**；同一版本多条 issue 取**最早**那条并打印取哪条；标题版本不在 packument 里、标题里没有版本号、检测为负，三种情况都逐条打印原因而不是静默丢。`gh issue list` 命中 `--limit 100` 上限时**拒绝出数**（gh 返回最新 100 条，被截掉的恰是最早的 issue ⇒ 检测只会偏大）。报表开头的「当前状态」给出：最新 watch issue（标题/开单时间/距今多久/是否未关闭）、`latest`/`next`/`alpha` 及发布时间、壳地板（当前 HEAD 的 `scripts/server-manager.mjs`）、未关闭跟踪 issue 列表，以及"上游最新是否已晚于壳地板（用**发布时间先后**作版本先后的代理，不引入第二套 semver 比较）且是否已被发现"；地板在 packument 里查不到时间戳时明写"无法比较先后（不猜）"。`--check` / `--fail-on-breach` **判定与旧实现逐位相同**（只看 `total` + since/recent 窗口），检测延迟不进门禁；`GH_BIN` 缺省改为 `scripts/gh`（CI 的 workflow 显式设 `GH_BIN=gh`，不受影响）；新增 `--now <iso>` 只为演练钉住"距今多久"（坏输入 exit 2）。负向保证：不猜版本号、不把 `unknown` 折成 0、不因 issue 列表取不到就断言"没有 issue"（取不到即抛错，不出报表）。
## Alternatives considered

**把检测延迟写进 `--check` / `--fail-on-breach`**：否决 —— 检测延迟受探测机器/runner 是否在跑、issue 是否被 GitHub 限流影响，是平台属性不是适配能力；写进门禁会让红绿随平台抖动，把"机器没开"判成"适配不力"。**按任务书字面用一条 `--label dsh-upgrade --label sla-breach` 查询**：实测否决 —— 本仓库 `--label sla-report` 1 条、再加 `--label priority:high` 变 0 条，证明是 AND；而 watch 只挂其一 ⇒ 恒空，所有版本的检测延迟会被静默变成 unknown。**unknown 记 0 或在表里印 `—`**：否决 —— "没有判断 = 没有验证"，0 等于宣称"上游一发我们就发现了"，`—` 又读不出是"没数据"还是"没这一列"；改成显式「未检测到」+ 汇总行写"未检测到（0/N 可判定）"。**重命名或改写已有 JSON 字段**：否决 —— 下游（CI 门禁、历史报表对比、人工核对）按名字读，改成只增不改。**为"上游是否超前"再抽一个共享 semver 模块**：否决 —— 会与 `dsh-watch.mjs` 的 `cmp` 形成两套口径（且写域只允许三个文件）；改用发布时间先后作代理，取不到时间戳就明说不比较。**把 `--limit` 截断的结果照算**：否决 —— 会得到一个偏大的检测数字，比"量不出来"更糟。
## Consequences

买到：报表第一次能分开回答"我们没发现"与"我们发现了但发版慢"，并把"是否已被发现、卡了多久"放在报表开头（实时信号），而不是只给一个事后混合数字；unknown 是可见的一等状态。代价与遗留：报表变长（每次运行多两次 `gh issue list`）、表头列名与方案 §1.1a 的历史叫法相反（已在 §1.1a 加列名对齐注）；**检测段在 7 个已量出版本上仍是 0/7 可判定**（它们上游发布早于 watch 第一次开单），但真实样本已经出现：2026-10-24 实跑 `0.2.1-rc.3`（上游 07:54Z → 最早跟踪单 #201 08:00Z）⇒ **0.10h**，单列在「待适配版本的检测延迟」段（旧 label 方案下这里恒为「未检测到」）；`--now` 与 `--registry` 都是演练注入点，正常跑不要设。未验证：真实 GitHub Actions runner 上的行为（未触发 workflow，只在本机按 `GH_BIN=gh` 的等价路径跑过）、`--issue` upsert 到 issue 的渲染（未执行写操作）。验证坐标：/tmp 合成 git 仓库 + 合成 packument + gh 桩，30 条断言（4 条负向对照 + 负值异常 + 门禁只看 total + 旧 JSON 字段逐值相同）全过；`node scripts/test-automation-gates.mjs --only sla` 17/17 绿；全量 104 条里 8 条红全部是 HEAD 上已存在的 `test-doc-links` 失效（干净克隆复现同样 8 条）。

