# Agent Note: doctor-canary-and-reverse-heartbeat

Status: implemented

## Problem

2026-10-23 上游 `0.2.1-rc.3` 发版时，本仓自动化同时暴露两层盲区，且都是"检查看起来是绿的"那一类：

1. **能读不能写**：项目 fine-grained PAT 的仓库角色是 `admin=true`，`gh api repos/karoc/dsh-desktop` 的 `permissions` 五项全 true，但 `updateIssue` / `addLabelsToLabelable` 一律 `Resource not accessible by personal access token`。而 `dsh-watch` 的去重、状态更新、assignee 全部依赖"维护"能力 ⇒ issue 建得出来、维护不了。
2. **心跳死了没人知道**：`dsh-watch.service` 只有 `Restart=on-failure`。机器关机、timer 被 disable、或脚本每轮都失败时，systemd 只负责重启，**没有人收到"没有告警"的告警**。

## Decision

**A3 —— 用真实凭据做一次可逆的 canary 写，而不是只读推断。** GitHub 没有 AWS `SimulatePrincipalPolicy` / k8s `SelfSubjectAccessReview` 的等价物；fine-grained PAT 连 classic token 的 `X-OAuth-Scopes` 响应头都没有；个人 fine-grained PAT 的过期时间也没有可编程读取路径。所以 `scripts/dsh-doctor.mjs`（`npm run dsh:doctor`）对一条标题含 `[dsh-doctor] canary` 的专用 issue 做真实写：读列表 → 建 canary（仅首次）→ 改正文（探针行 + `last-ok=<ISO>`，读回复核后还原，**净变化只有 `last-ok`**）→ 评论（有则 PATCH 同一条、无则只建一条）→ 加 label（加→读回→移除）→ 关闭（关→读回 CLOSED→重开→读回 OPEN）。六行矩阵每行给 ✓/✗ + 打码后的真实错误；**任一写失败立即停止后续写探测**（403 是资源级边界，继续试只会重复 403 与次级限流），后续行标 ⊘ 并写明原因。必需能力缺失 ⇒ exit 1 + 一句话结论 + "给 PAT 勾 Issues: Read and write" 的修复建议。仓库级 `permissions` 仍然打印，但**只作对照**，永不作为判据。

**A5 —— 心跳要"能过河"：把时间戳写进云端看得见的对象。** 本机文件云端看不到，所以每次成功运行既写 `~/.dsh/heartbeat.json`（`{lastOkAt, version, didWrite}`），也把 `last-ok=<UTC ISO>` 写进 canary 正文；`.github/workflows/dsh-heartbeat-check.yml`（每日 03:00 UTC + `workflow_dispatch`）只是薄壳，逻辑在 `dsh-doctor.mjs --heartbeat-check`，这样判据能本地复跑。双向判据：`last-ok` ≤ 26h ⇒ 静默 exit 0；> 26h ⇒ 评论 `@owner` + 加 `priority:high` + **exit 3**；canary 不存在 ⇒ 先建（写 `bootstrap-at`）再判断 ⇒ 本次静默。阈值 26h = 24h 周期 + 2h 宽限（Actions `schedule` 官方不保证准时）。`exit 3 = 已报警`、`exit 1 = 检查器坏了` 必须分开，否则红色不可判读。失败运行**不写**本地心跳 —— 否则反向心跳会替坏掉的写路径作伪证。


**A11（2026-10-24）—— 判据从「靠人记得跑」变成常驻门禁。** `npm run test:doctor` 仍在，但自测现在同时是 `scripts/test-automation-gates.mjs` 的 **doctor 组**（`--only doctor`，5 条断言：有 通过/失败 计数、0 失败、断言数 ≥40 且 通过==总数、覆盖到 403 那一段（「该项标 ✗」+「403 之后没有任何写调用」）、自测退出码 0），并配 1 条变异对照：把 `missing.length ? 1 : 0` 改成恒 `0`（「必需能力缺失也判通过」）后，doctor 组**必须变红**。Windows 上该组显式 SKIP 并计入 skipped（不是通过），那条变异也带 `platform: 'posix'`；这样「canary 失败必须阻断」这条出口本身是可失败的，而不是只有一遍绿。
## Alternatives considered

- **用 issue 的 `updated_at` 当心跳**（`docs/2026-10-24-alerting-and-idempotency-patterns.md` A1 的原稿）：任何评论/label/编辑都会刷新它，**包括报警评论自己** ⇒ 报警即自愈、永远陈旧不了。必须用显式的 `last-ok=` 字段，且该字段只能由成功写操作的路径更新。
- **只做 label 加/删探测**（同上 §4.4 配方）：副作用最小，但 label 往返不携带任何可读数据，A5 需要的"时间戳过河"必须落在一个云端可读字段上；正文写入正好同时证明 `updateIssue` 能力（本次真正被拒的就是它）。
- **把心跳判据直接写在 workflow 的 `run:` 里**：与仓库既有约定冲突（`dsh-watch.yml` / `dsh-sla-report.yml` 都是薄壳），YAML 里的逻辑没法用 gh 桩做负向对照。做成 `--heartbeat-check` 模式后可 `npm run test:doctor`。
- **只写本机 `~/.dsh/heartbeat.json`**：云端看不到；而"云端兜底"正是这次要补的（本机整机不跑时只有云端能发现）。
- **引入 healthchecks.io / PagerDuty**：用户明确不采用外部 SaaS，且告警内容会离机；只吸收 dead man's switch 语义。
- **在 canary 缺失时报"心跳陈旧"**：首次部署必然误报一次，且会训练人忽略这条告警。改为"先创建（写 `bootstrap-at`）再判断"，宽限期内的静默有明确到期时间。
- **陈旧时每天刷一条评论**：日报式刷屏会让人关掉通知。同一段停更期只发一条报警评论（判据：上一条报警评论晚于最后一次成功心跳），`--repeat-hours`（默认 168h）只兜"从未成功过"。

## Consequences

买到的是：写能力有了**真实**判据（不是 `admin=true` 的推断）；"任务没按时发生"有了独立于 `Restart=on-failure` 的检测通道；两条判据都能在本地用内置 gh 桩跑 72 条断言（2026-10-24 补两条"桩时钟 == 断言时钟"防回归断言，见 [自测桩时钟同源](../testing/2026-10-24-doctor-selftest-stub-clock.md)）（另有两条变异自证证明断言会红）；2026-10-24（A11）起还常驻 `test-automation-gates` 的 doctor 组（5 条断言 + 1 条变异对照），不再只靠 `npm run test:doctor` 记得跑。

代价与未完成项：canary issue 变成长期资产（需人别删；脚本发现缺失会重建、发现多条只用最小编号并提示人工关闭）；**本机 timer 不由本仓库安装**，在用户把 `dsh-doctor` 挂进 timer 之前，云端的 `last-ok` 会停在最后一次手工运行 ⇒ 26h 后如实报警；**当前 PAT 缺 Issues:write ⇒ `last-ok` 写不进去**，合并后该 workflow 会在 26h 后开始每日报警 —— 这是设计内的信号（"写路径坏了"），修 PAT 或临时 disable workflow 二者之一；`评论` / `加 label` / `关闭` 三行在真实凭据上从未被探测到（403 后按纪律停止），"矩阵 6 项全绿"尚未在真实 PAT 上出现过一次；PAT 过期时间仍不可读（个人 fine-grained PAT 无 REST 端点）；"issue/评论是否真的叫醒人"取决于账号通知设置，本机不可验证。相关：[研究清单](../process/2026-10-24-alerting-idempotency-research.md)、[双心跳架构](../architecture/2026-10-21-dsh-upgrade-heartbeat-dual.md)、[watch 单写者](../architecture/2026-10-24-watch-idempotency-single-writer.md)。
