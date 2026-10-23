# dsh-watch：确定性去重键 + 本机单写者 + 收敛对账（事故 #201–#217）

## 问题

上游发布 `0.2.1-rc.3` 后，本机 systemd timer 与 Actions cron（`.github/workflows/dsh-watch.yml`）
**双写**同一个脚本，10 分钟内共开出 **17 条重复 issue（#201–#217）**。其中 16 条由本机项目 PAT 创建，
`gh issue create` 成功但 **label/assignee 从未落地**（`addLabelsToLabelable` 403、`updateIssue` 403）；
而旧实现的去重是「`gh issue list --label dsh-upgrade --state open` 再按标题匹配」——
查到 0 条 ⇒ 每轮再建一条。去重键依赖了一个"创建之后的第二次写"，这是结构性缺陷，不是偶发。
取证与业界对照见 `docs/2026-10-24-alerting-and-idempotency-patterns.md`（§0、§1.5、A1/A2/A10）。

## 决定（已实现，`scripts/dsh-watch.mjs`）

**去重键 = 「本脚本的标题前缀 + 标题里版本号的词边界」**，与写者无关、与 label 无关：
查 `gh issue list --state open --limit 1000`（到上限显式告警"列表可能被截断"），
标题只认 `[dsh-watch]` / `[SLA 未达标]` 两种前缀（不篡改人类开的 issue），
版本号用词边界（`0.2.1-rc.3` 不命中 `0.2.1-rc.30`，`0.2.1` 不命中 `0.2.1-rc.2`）。
命中即 `edit` 复用，未命中才 `create`。正文里的
`<!-- dsh-watch-state: target=… breached=… -->` **只**决定"要不要追加评论"（目标版本变化 / 状态跨级才评论），
**不是**去重键（body 的 edit 同样可能失败）。写入后**读回复核** label/assignee：缺失先做一次幂等
`edit --add-label/--add-assignee` 修复，仍缺失就打印可复制的人工命令（绝不因此再建一条）。

**本机单写者**：非 `--dry-run` 时整个进程 re-exec 到 `flock -n -E 75 <state-dir>/locks/dsh-watch.lock`
（默认 `~/.dsh/locks/dsh-watch.lock`，`-E 75` ⇒ 拿不到锁打印 `skipped by lock` 后 exit 0）。
选 flock 而不是 PID/`open('wx')` 锁文件：进程退出即释放，崩溃不会留"永久死锁"（否则告警会永久静默）。
`flock` 二进制缺失时明确告警并继续 —— 写操作仍是收敛式的，只是失去本机互斥。

**刹车**：`<state-dir>/PAUSE`（默认 `~/.dsh/PAUSE`）存在 ⇒ **跳过一切写操作**，只读探测、去重判定与
重复单报告照常，日志写 `paused by <路径>`。`--state-dir` / `DSH_STATE_DIR` 把锁与 PAUSE 搬到别处（演练/测试）。

**收敛对账（自愈）**：每轮末尾（含"今天没有新版本"的轮次）按标题版本分组扫 open issue，
同一版本 >1 条就保留一条、其余 `close` 后评论 `重复于 #N（同版本跟踪单），由 autopilot 对账关闭`。
保留规则是明确的：**带 `dsh-upgrade`/`sla-breach` label 的优先 → 其次带 assignee → 同优先级取最早创建**
（`createdAt`，等价最小编号）—— 事故里 #217（唯一带 label/assignee）因此被保留、#201–#216 被关掉。
**顺序是先对账、再去重写单**：否则会去 edit 一条马上要被关掉的重复单，正文停在旧状态。
**失败不重试、不报假成功**：任一 close/comment 被 403 ⇒ 本轮停写（`writeBlocked`），
输出"待人工关闭"清单（issue 号 + 可复制的 `./scripts/gh issue close …` 命令），
对账后还会再读一次列表复核；读不到就明说"无法复核"，**绝不**打印"对账完成"。

**双写者是设计事实**（本机 timer + Actions cron）。因此所有写操作必须是收敛式：只依赖「对象身份 + 正文状态」，
不假设自己独占。flock 只保本机；跨写者的 TOCTOU（两边同时查到 0 条再各建一条）无法在客户端根除 ——
那正是对账这一层存在的理由（下一轮收敛）。

**退出码**：0 = 正常（含无事发生、对账失败但已输出待人工清单）；1 = 真故障（拿不到 packument /
读不到 open issue 列表 / 跟踪单没开成或没更新成）；2 = 用法或属主解析失败。

## 放弃的方案

- **继续用 label 做去重键**（或"只认自己赋过 assignee 的单"）：label/assignee 是创建之后的第二次写，
  正是本次静默失败的落点；用它做键 = 把唯一性建立在可能缺失的属性上。
- **PID/`open('wx')` 锁文件**：没有 flock 的自动释放，进程被 kill -9 或崩溃后留下死锁文件 ⇒ 下次告警永不发出。
- **403 后重试 / 换命令再试**：实测 `addComment`、`closeIssue`、`updateIssue` 同时 403（同一条权限边界），
  重试只会产生噪音与 429；一次即停、出清单。
- **把对账失败也算非零退出**：本机 PAT 缺 `Issues: write` 时每次运行都会失败，systemd 的
  `Restart=on-failure`+`RestartSec=60` 会变成 60s 热循环；那该由 A6 改 unit 参数解决，不该在这里放大噪音。
- **按标题 `contains(版本)` 或全文版本号去重**：会误合并 `0.2.1` 与 `0.2.1-rc.2`（旧实现的已知坑），
  且无法区分"我们的跟踪单"与人类开的 issue。
- **本地状态文件记录"某版本已开过单"**：GitHub 是唯一事实源；本地状态会漂移/丢（Renovate 也不维护数据库）。

## 代价与边界

- 每轮多一次 `gh issue list`（`--limit 1000`）；非 dry-run 多一次 re-exec（flock）；有重复时对账多 2 次读 + N 次写。
- 复用路径现在会用 `--title` 刷新标题（前缀随状态变化：`[dsh-watch]` ⇄ `[SLA 未达标]`），修复了
  "状态已改成 SLA 未达标但标题还停在跟踪中"的旧状态不一致。
- **未覆盖**：项目 PAT 仍缺 `Issues: write` ⇒ 本机侧 close/comment/edit 全部 403，只能出待人工清单；
  `scripts/dsh-sla-report.mjs` 仍按 label 取数（label 缺失时检测延迟记为"未检测到"）；
  systemd unit 的 `RestartSec` 不在本仓库（需要 A6 或人工调）。
- 验证：`scripts/test-automation-gates.mjs` 的 watch 组用**有状态 gh 桩**钉住上面每一条
  （`run(); run()` open 数不增、冷启动只建 1 条、事故同构 label/assignee 从未落地时不再建、
  真起两个进程只有一个执行、PAUSE 零写、对账 403 只剩清单）。
- 相关：`docs/2026-10-24-alerting-and-idempotency-patterns.md`（A1/A2/A10 的依据）、
  README「幂等 / 单写者 / 刹车 / 对账」。
