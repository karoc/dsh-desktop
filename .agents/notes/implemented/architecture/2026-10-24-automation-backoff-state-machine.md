# Agent Note: automation-backoff-state-machine

Status: implemented

## Problem

三个本机 systemd user timer（dsh-watch / dsh-release-autopilot / dsh-tagdispatch）都是"每 10 分钟一轮"，失败时每轮把同一段完整错误重印一遍（事故 #201–#217 的 16 条重复 issue 与 updateIssue 每轮 403 就是这个形状，systemd 的 Restart=on-failure + RestartSec=60 还把它放大成热循环）。同时 `~/.dsh/logs/*.log` 走 systemd `StandardOutput=append:`（没有轮转），dump 只有份数上限。理论依据：docs/2026-10-24-alerting-and-idempotency-patterns.md（PR #219）§5 与 §6 的采用清单 A6 / A8 / A9。

## Decision

新增 `scripts/lib/backoff-state.mjs`：纯函数状态机（decide / recordOutcome / backoffMinutes / render*）+ 三个 fs 薄封装（loadState / saveState / resetStateFile）。状态 schema=1，落盘 `~/.dsh/state/<tool>.json`（`--state-dir` 的 base、`--state-file` 直指、`DSH_STATE_DIR`；原子写 tmp+rename；文件损坏或 schema 不符 ⇒ 备份 `*.corrupt-<ts>` 后重建 healthy，**fail-open**）。三态 = healthy / degraded（连续失败 1..N-1，默认 N=3）/ broken（≥N；403/404/凭据/权限这类不可重试错误第一次就 broken）。退避 = 5→10→20→40 分钟、封顶 60（公式 5·2^(k-1)，min 60）。broken 之后每轮 stdout **恰好一行**（进入 broken 的那一轮另有「连续 N 次失败」摘要 + 跃迁评论） `still broken (attempt k, next retry in Xm) — heartbeat <iso>`，未到 `nextAttemptAt` 跳过实际工作；完整失败明细进 `<state>.detail.log`（128KB 触发、只留尾部 400 行，不参与 logrotate）；每轮写 `<state>.heartbeat` 一行（`skipped=yes/no`），供反向心跳区分"退避中"与"进程死了"。**通知只在跃迁时**：healthy→degraded、→broken（含首次即 broken）、broken→healthy 各一条 issue 评论；degraded→healthy 静默。评论带 `<!-- <tool>-backoff: state=<to> from=<from> attempt=… digest=<sha> -->`，digest 由 `<tool>|<from>|<to>|<enteredStateAt>` 派生（补发幂等、恢复后再坏仍是新条），写失败进 `pendingNotification` 下一轮补发，发前用 `gh issue view --json comments` 查 digest 防重（autopilot 的 commentIssue 复用同一判据）。退出码：degraded/broken 的**重试轮** 1（CI 该红就红）、**退避跳过轮** 0（不干活也不是新故障，0 是为了不与 systemd restart 叠热循环；健康判据是状态文件 + 跃迁评论）、用法错误 2 与 SIGINT 130 不记账。接入两处：`dsh-watch.mjs`（首选，挂到本脚本自己的 open 跟踪 issue，优先本轮 target 那条）与 `dsh-release-autopilot.mjs`（挂到其 `--issue`/resolveIssue 的 issue，flow 解析出 issue 后 flush 待补发）。`--reset-state` 只重置本地状态、**不写 GitHub**；`--no-backoff` 仅演练/负向对照。**CI 特例（有意）**：`GITHUB_ACTIONS=true` 且未显式给 `--state-dir/--state-file/DSH_STATE_DIR` 时只记账、不发跃迁评论 —— Actions runner 文件系统是临时的，否则每轮都会产生一条 healthy→degraded 评论（比现状更吵）；"任务根本没跑"归 A5 dead man's switch。**A7（CI 降级）**：`schedule` 不是 SLA 主时钟这一点写进 `dsh-watch.yml` 头注释与 `CONTRIBUTING.md` —— `*/15` 只是「本机没在跑时的兜底覆盖」；SLA 的检测段 T0 取同版本**最早** issue 的 `createdAt`（与哪个写者建的无关），检测延迟**不进门禁**。**A8**：`scripts/logrotate.dsh.conf` 模板（daily + maxsize 20M + rotate 7 + compress + delaycompress + copytruncate + missingok + notifempty；copytruncate 是必须的，systemd 一直持有 append fd），README 补用户级安装 + `logrotate -d` 干跑 + systemd **user** timer 模板 + 各状态/日志/dump 的清理路径。保留的**事实校正**：`scripts/server-manager.mjs` 没有任何 dump 保留逻辑（`grep -n dump` 只命中看护协议行），策略在壳里 —— 本轮只落了份数维度（`HANG_DUMP_KEEP = 3`）；**时间/总量维度已于 2026-10-24 由 A9 关闭**（`src-tauri/src/retention.rs` 的 `HANG_DUMP_POLICY` = 3 份 / 14 天 / 总量 ≤1GiB，见 [dump 三维保留](2026-10-24-dump-retention-three-dimensions.md)）。门禁 `scripts/test-backoff-state.mjs` 接进 `npm test`（链 27→28 套，README/CONTRIBUTING 计数同步），含纯函数单测 + 8 轮实测 + autopilot 闸门 + 负向对照。
## Alternatives considered

**只在 systemd 层做退避（RestartSteps + RestartMaxDelaySec）**：拿不到"连续失败 N 次"的语义、区分不了可重试/不可重试错误、压不住每轮重印的完整错误，也发不出"只在跃迁时"的通知；且本机 unit 不在仓库里（本仓库不改用户 systemd），无法门禁化。

**用 `continue-on-error` / `|| true` / 静默开关把失败吞掉**：本仓硬规则明确禁止（假绿比没有门禁更糟），而且会丢掉"坏了多久"这一信号。

**每轮都发评论、只靠 digest 去重**：digest 要区分"同一次故障 vs 新一次故障"就必然包含时间/enteredStateAt ⇒ 在临时文件系统的 CI 里每轮都是新 digest，等于恢复刷屏；所以通知必须以"状态跃迁"为事件源，digest 只用于补发/并发的幂等。

**用方案 §6.4 的单一 `~/.dsh/state/automation.json` 按 key 分条**：一个工具的坏状态会扩大爆炸半径（损坏/升级要一起迁移），且并发写同一文件更容易互相覆盖；改成 per-tool 文件，键的语义由文件名承担。

**另开一个 `automation-health` issue 当跃迁通知的固定落点**：会新增第二种 issue 通道，而现有对账逻辑只认 `[dsh-watch]`/`[SLA 未达标]` 两类标题，容易与去重/收敛规则打架；改为挂到既有跟踪 issue，找不到时只记 pending（A5 dead man's switch 兜底）。

**把 dsh-sla-report 也接进来**：它是**每周**一趟的报表 job，且 issue upsert 已用 `dsh-sla-report-state` digest 去重，不存在"每 10 分钟重印同一错误"的路径；接入只多一个要维护的状态文件。已在脚本头注释与方案 §3.8.1 记录为"明确不做"。
## Consequences

买到的：8 轮同一失败从"8 段完整错误 + 0 条通知"变成"2 轮完整错误 + 2 条跃迁评论（degraded/broken）+ 之后每轮一行"，恢复只多 1 条；每轮心跳让"退避中"与"进程死了"可区分；日志有了可验证的轮转模板（`logrotate -d` 通过、`-f` 后原件截断为 0 且生成 `.1`）。

代价与限制：① 多了一个必须维护的落盘格式（schema=1；损坏路径是"备份 + 重建"，会丢退避历史）；② broken 的跳过轮 exit 0 —— 因此**不能**再靠 timer/CI 的红色判断"坏了"，判据变成状态文件 `state` + 跃迁评论（这是刻意的，避免与系统 restart 叠热循环，但读日志的人必须知道）；③ 重试最多被推迟 60 分钟（降噪换延迟）；④ 跃迁评论依赖"已有一条 open 跟踪 issue"，完全没有跟踪单时只写 pending 并明说"暂缓"（兜底是 A5 心跳/死手开关，本轮未实现）；⑤ 本机 systemd 单元仍没有 `RestartSteps`/`RestartMaxDelaySec`、`dsh-logrotate.timer` 也还没装 —— 都是**用户动作**（unit 不在仓库、仓库不改用户 systemd），已在 README 给模板并登记后续卡；⑥ dump 保留的缺口已关闭（A9，2026-10-24：`retention.rs` 的三维策略 + 8 条单测 + 4 条变异对照，见 [dump 三维保留](2026-10-24-dump-retention-three-dimensions.md)）；

相关决策：同目录的同批次止血（确定性去重 / 单写者 / 对账）见 2026-10-24-watch-idempotency-single-writer.md；心跳层的双心跳架构见 2026-10-21-dsh-upgrade-heartbeat-dual.md（纯文本引用：跨目录，本目录门禁不校验）。

