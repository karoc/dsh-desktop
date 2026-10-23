# PAT 过期元数据（A4）：人工录一次 + 分级检查 + 每日门控 + 跃迁式提醒

## 问题

项目专用 fine-grained PAT（`~/.config/gh-dsh-desktop/token`）一旦过期，`./scripts/gh` 的写操作会开始 401/403，
而**症状与"权限不足"完全同形** —— 2026-10-24 那次"能读不能写"事故（#201–#217 重复 issue）里，排障者第一反应
就是去查 Issues 权限。过期时间这个事实 GitHub **不告诉我们**：个人 fine-grained PAT 没有可读的 REST 端点
（`GET /user` 只返回身份字段，不返回 `expires_at`；classic token 能读 `X-OAuth-Scopes`，fine-grained 连这个头
都没有），UI 上的 Expiration 只给人看。⇒ 机器唯一能做的，是让人在创建/轮换时**录一次日期**，之后由工具检查
并提前告警。这是防错清单 A4，也是清单里唯一"不需要新权限"的采用项（[取证](../architecture/2026-10-24-automation-backoff-state-machine.md)
之外的调研记在 `docs/2026-10-24-alerting-and-idempotency-patterns.md` §4.2 / 采用清单 A4）。

## 决定

**数据源是本地文件，不是 GitHub。** `scripts/dsh-token-meta.mjs set --expires YYYY-MM-DD [--note …]` 写
`~/.dsh/token.meta.json`：tmp+rename **原子写**、**mode 600**（父目录 700）、字段**恰好三个**
`expiresAt` / `note` / `recordedAt` —— 没有 token、没有 scope、没有用户名。`--note` 里出现 token 形状
（`ghp_…` / `github_pat_…`）**直接拒绝写入**（exit 2 + 不落盘），不靠"人会记得别粘"。工具**不读 token 文件、
不联网**，除非显式 `--notify`。

**分级与退出码是分层设计的。** `scripts/lib/token-meta.mjs` 是纯函数库（doctor 与 CLI 共用）：
`expires=YYYY-MM-DD` 按"该 UTC 日**结束**前有效"折算（`expiryEndMs = 次日 00:00 UTC`），
`daysLeft = floor((end - now) / 24h)`，`grade()` 用 **`>`** 而不是 `>=`：`>14 ok / 8..14 warn / 2..7 urgent /
0..1 critical / <0 expired`。**只有 critical 与 expired 让退出码非零**；ok/warn/urgent 一律 **0**。
这不是遗漏：warn 也非零 ⇒ cron 每天红 ⇒ 人开始忽略 ⇒ 告警失效，而且会与 systemd 的
`Restart=on-failure` 叠成热循环。**未知（文件缺失 / JSON 坏 / `expiresAt` 不是合法日历日）⇒ 输出"未知"且
exit 0** —— 没启用这个功能不是故障，但输出必须明说原因（`missing` / `corrupt`，`--json` 里带 `reason`）。

**每日门控 + 只在跃迁时提醒。** `check --notify --if-due` 用 `~/.dsh/state/token-meta.json` 的
`lastCheckedDate`（UTC 日）门控：今天已跑过就打印 `not due` 并 exit 0 —— 因此它**可以安全地挂在 10 分钟循环
上**，不必把检查塞进 `dsh-watch` 的主循环。提醒落在**一条**跟踪 issue（标题 `[automation] PAT 过期元数据（A4）`，
正文带 `<!-- dsh-token-meta:tracking -->`，全仓只允许一条）：新建即当次通知、之后**只在级别跃迁时**评论
（warn→urgent→critical→expired 各一条；`lastNotifiedLevel` 落状态文件），回到 ok 时评论"已解除"并关闭该单，
下次非 ok 时**重开同一条**而不是再建。**读不到 issue 列表 = exit 3**（检查器自己坏了，≠ token 快过期）；
**写失败（403）⇒ 只打印提醒正文 + 一条可复制的建单命令，本轮不再追加写请求**（issue 写权限缺着的时候，
不要把 cron 变成日志洪水），退出码仍按级别给。`--dry-run` 不写 issue、不写状态文件。

**doctor 集成但**不**判红。** `scripts/dsh-doctor.mjs` 矩阵新增第 7 行 `PAT 过期（本地 token.meta）`，
`--token-meta` / `DSH_TOKEN_META` 可指向别处；该行 `required=false`，不进退出码 —— 缺失显示
`· 未录入 ⇒ 未知 —— 建议 set --expires 录一次（不判红）`，expired/critical 也只是打提示。

**"安静"的语义被明确固定**：`--quiet` 只在级别**非 ok** 时输出；而"提醒没能写进 issue"这类失败路径
用 `always()` 打印，**不受 --quiet 影响** —— 否则安静正好掩盖了"提醒没发出去"。

## 放弃的方案

**用 `GET /user` / `GET /repos/{owner}/{repo}` 推断过期。** 实测无字段（`permissions` 只是仓库角色，
不是 PAT 的资源级权限快照，更不含过期日）—— A3 事故已经证明"读到的权限≠能写"，这里同理：读不到的事实
不能靠推断补，推断出来的日期只会制造假安全感。

**让 `dsh-watch` 每 10 分钟顺带查一次。** 检查本身很便宜（读一个本地文件），但**提醒**不便宜：塞进主循环
就得靠状态文件去噪，而 `dsh-watch` 的主循环已经承担去重/单写者/退避/对账四件事，再加一个"每日一次"的
语义会把它的退出码口径搅浑（主循环退出码 = 探测是否失败，不该被"token 快过期"影响）。⇒ 独立脚本 +
`--if-due` 门控，谁调度谁决定频率。

**把过期日放进 token 文件本身（`~/.config/gh-dsh-desktop/token.meta`）。** 与 secret 同目录会让
"哪些文件是凭据"这条边界变模糊（备份/同步脚本按目录取文件时会连元数据一起搬走）。选 `~/.dsh/`
（与本仓其它运行时状态同一处），且**先于调研文档**里写的 `~/.config/gh-dsh-desktop/token.meta` 落地 ——
文档已按实现口径改写。

**把未知也做成非零退出。** 会让"还没录入"的门禁天天红，恰好训练人忽略告警；而且 doctor 的退出码语义是
"必需能力是否可用"，元数据缺失不属于能力缺失。

## 后果

代价：① 录入是**人手动作**，换了 token 忘了 `set` ⇒ 元数据是旧日期（对策：CONTRIBUTING 的凭据纪律把
"轮换的最后一步是 set"写成流程，且 `recordedAt` 可事后取证）；② 工具无法校验"这个日期是否真的是当前 token
的"—— 没有可比对的来源，这是这条链最硬的天花板；③ 本仓库**不代装 timer**（systemd 属用户资产），README
只给模板（含 `Environment=GH_BIN=<仓库>/scripts/gh`，已纳入 `test-gh-bin-discipline` 的第 3 条判据扫描）；
④ 五级分级与退出码口径同时散落在 README / CONTRIBUTING / 技能里，靠 `scripts/test-token-meta.mjs`（POSIX 下 124 条
断言：五级实测、缺失/损坏、600 与三字段、`--if-due`、`--notify` 的 gh 桩）与 **3 条变异自证**钉住
（改坏退出码表 / 14 天边界 / 未知的退出码，临时副本必须给出不同结论）。换来的是：过期这件事第一次
有了**机器可检查、提前 14/7/1 天分级、且不会天天刷屏**的表达。
