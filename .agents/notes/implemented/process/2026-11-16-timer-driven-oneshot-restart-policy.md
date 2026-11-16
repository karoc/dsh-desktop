# Agent Note: timer-driven-oneshot-restart-policy

Status: implemented

## Problem

本机三条拼在 *:0/10 / *:3/10 墙钟上的 systemd user timer（dsh-watch / dsh-tagdispatch /
dsh-release-autopilot）都是 Type=oneshot，却照着 2026-10-24 的 A6 设计加了
`Restart=on-failure` + `RestartSec=60` + `RestartSteps=4` + `RestartMaxDelaySec=3600`。
2026-11-16 实测：一轮失败后 unit 进入 `activating (auto-restart)`，而 systemd 对已经 active/activating
的 unit 不会另起 start job ⇒ 期间每一次 timer 触发都是 no-op，心跳被整段吞掉最长 1 小时；再叠加脚本
自身的状态文件退避，实际重试退化成 ~1h/轮。当天 dsh 0.2.2-rc.1 的适配 SLA 事故里，这放大了「明明有
10 分钟心跳却 8 天才被发现」的观感。

## Decision

**timer 驱动的 oneshot 一律 `Restart=no`**，退避只保留在脚本内部（`~/.dsh/state/*.json` 的三态机 +
跃迁评论）。本机三份 unit 已按此改并验证：失败轮次结束后 unit 直接 `failed`（不再是 activating），
下一次 timer 触发能正常起新轮次；删掉了 `RestartSec` / `RestartSteps` / `RestartMaxDelaySec` 与
`StartLimitIntervalSec` / `StartLimitBurst`（回默认 10s 窗口）。

验证不是推理：用两个临时 unit（`ExecStart=/bin/bash -c 'exit 3'`，一个照旧配置、一个 `Restart=no`）
做对照——旧配置第二次 `start` 被合并进 auto-restart（journal 只有 1 条 Starting，状态恒
`activating/auto-restart`）；`Restart=no` 两次 start 都真跑（journal 2 条 Starting）。实验后临时
unit 已删除，真 unit 的备份在 `~/.dsh/backup/dsh-systemd-units-20261116/`。

**负向保证**：没有引入任何「systemd 层重启」；unit 里保留显式 `Restart=no`（而不是删行），
`systemctl show -p Restart` 可审计。**这不表示放弃重试**：脚本级退避仍在，且「任务根本没跑」由反向
心跳（canary `last-ok` 陈旧 >26h ⇒ 报警 exit 3）兜底。

## Alternatives considered

**把 `RestartMaxDelaySec` 调小（如 300s）**：否决——只要 `Restart=` 存在，失败轮次期间 timer 触发
就会被合并，只是被吞的时长变短；问题的形状没变。

**把 timer 改成 `OnUnitInactiveSec=10min`**：否决——去掉 Restart 后 activating 问题已经消失；改法会
破坏墙钟对齐（`*:3/10` 是让人肉排障可预期的心跳相位）与 `Persistent=true` 的补跑语义，零收益、
新增风险。

**在 unit 里加 `Restart=always` 处理「脚本没跑」**：否决——脚本正常退出（exit 0，例如「无新版」）
会被当成需要重启，制造热循环；「没跑」应由反向心跳发现。

**把退避搬进 timer（由脚本自报下一次时间）**：否决——systemd timer 不支持「由脚本决定下次时间」；
要那样得自己实现调度，等于把 systemd 换掉。

## Consequences

买到的：10 分钟心跳不会因为一次失败被吞掉最长 1 小时；失败仍然是「unit failed + 日志 + 状态文件 +
反向心跳」四路可见，不靠 systemd 的重启来制造「好像还在跑」的假象。

代价与边界：① 失去 systemd 层的自动重启，脚本崩在启动早段（还没写状态文件）时只能等下一轮 10 分钟
（可接受：timer 本来就是 10 分钟）；② 三份 unit 在用户主目录、不在仓库里，新机器/重装要按
`docs/2026-10-17-dsh-upgrade-automation-plan.md` 的模板重建（该模板与本注记同批更新）；③
`docs/2026-10-24-alerting-and-idempotency-patterns.md` §6.2 里「应改成 RestartSteps +
RestartMaxDelaySec」的建议已被 2026-11-16 的更正块覆盖，A6 行仍作为历史保留。
