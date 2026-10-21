# Agent Note: dsh-upgrade-heartbeat-dual

Status: implemented

## Problem

6h 升级 SLA 的整条链都建立在"上游发版后 15 分钟内被发现"这个假设上，而承载它的唯一心跳是 GitHub Actions 的 `schedule` cron（dsh-watch */15、tag-dispatch */10）。实测该仓库的 schedule 运行间隔是 2–5 小时（120:55/05:54/00:55/22:52/20:54/18:18，dsh-watch 同样），workflow 状态都是 active、不是被禁用。结果是：v0.20.0 的 tag 在 16:10 打上后 16 分钟没有任何 tag-dispatch 运行，资产数一直是 0，只能人肉补派发；按这个延迟，即使代码全对、人即时响应，6h 也永远达不到。

## Decision

心跳改为"本机主 + 云端兜底"，两者都零新增 secret。本机侧是本机 WSL(Ubuntu-24.04) 里的两个 systemd **user** timer：`dsh-watch.timer` 与 `dsh-tagdispatch.timer`，`OnCalendar=*:0/10`、`Persistent=true`（错过的下一次启动补跑一次）、`loginctl enable-linger karoc`（无登录会话也跑）；service 里必须写死三件事——node 绝对路径（systemd 不读 nvm）、`GH_BIN=<repo>/scripts/gh`（否则脚本用裸 gh 落到全局 hosts.yml 的另一个 token）、`HTTPS_PROXY`（服务环境没有 shell 的代理变量）；三个 service 另加 `Restart=on-failure`+`RestartSec=60`+`StartLimitIntervalSec=0`。Windows 侧再加一层登录自启：启动文件夹快捷方式 → `%LOCALAPPDATA%\dsh-wsl-daemon.cmd`（纯 ASCII，最多 6 次重试、间隔 10s），因为它**不会**随 Docker Desktop 自动启动（Docker 只拉起 docker-desktop 自己的发行版），而 schtasks 建计划任务被系统拒绝（需管理员）。GitHub 的 schedule 保留为兜底（2–5h 级但永不归零）。**明确不做**：不给 release-please 配 PAT 去换 `on: release` 事件；不引入外部云调度器（都要多一个 secret）。**盲区如实保留**：Windows 关机/睡眠期间两边都不跑 —— 这段延迟必须由指标显式量出来，而不是假装没有。
## Alternatives considered

**只用 GitHub cron**：最省事，但实测 2–5h 的检测延迟意味着 6h 指标结构上不可达，且 tag 构建会静默不触发（已实际发生）。**Windows 计划任务做心跳**：更耐 WSL 未启动，但本机 `schtasks /create` 被拒绝（需管理员），且 GUI 里不可审计。**release-please 改用 PAT ⇒ `on: release: published` 立刻触发**：事件级最可靠，但用户明确选了零 secret 路线，且新增 PAT 会把发布权限扩散到 Actions。**外部云调度器**：同样要放 token，且把"谁在跑"移出了这台机器。
## Consequences

买到的是：机器开着时 ≤10 分钟确定性检测（实测 service 单次 3–5s 完成），restart 后自动补跑一次，且与 Actions 完全无关地活下去。代价是：心跳的存在性变成"本机 + Windows 登录态"的属性 —— 关机即停；因此 SLA 必须拆成**检测延迟**（上游发布→我们开单）与**适配延迟**（开单→我们发版）两段分别计量，否则测出来的是机器开关机史而不是我们的响应能力（这一项尚未实现，是对 autopilot 报表的待办）。另：`tag-dispatch` 的本地心跳目前只是 `gh workflow run` kick，逻辑仍在 workflow 里，将来应抽成 `scripts/dsh-tag-dispatch.mjs` 与 workflow 共用。相关：[autopilot 决策](2026-10-20-dsh-release-autopilot.md)、发版日干跑（见 process/2026-10-18-dsh-upstream-release-day-drill.md）。

