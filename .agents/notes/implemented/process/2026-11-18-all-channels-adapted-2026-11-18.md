# Agent Note: all-channels-adapted-2026-11-18

Status: implemented

## Problem

原决策 ③C（2026-10-19）规定 npm `next`/`alpha` 通道只开 issue、不自动适配，理由是「manager 安装目标 = max(地板, latest)，结构上装不到更高的预发布」。后果：`next` 已到 0.2.2-rc.4 而壳地板长期停在 0.2.2-rc.1（检测到但永远不适配），用户在预发布通道上只能手动跟进。2026-11-18 用户明确要求「去掉这个决策，next/Alpha 通道也得适配」。

## Decision

`scripts/dsh-watch.mjs` 与 `scripts/dsh-release-autopilot.mjs` 现在对 `latest`/`next`/`alpha` 一视同仁：watch 取三通道中**高于地板的最高版本**为 target（新增机器可读字段 `report.channel`，`kind` 形如 `SLA 6h（next 通道）`），门槛统一 6h；autopilot 删除 `channel === 'best-effort'` 的早退分支（原 `pre-release-skip` 阶段不复存在），预发布目标走与 latest 完全相同的 ②–⑧ 链。适配抬地板后 manager 的 `max(地板, latest)` 自然装上该版本。`--best-effort-hours` / `--force-pre` 废弃（传入无效）。`dsh-sla-report.mjs` 无需改动：它本来就按 channels 全量统计。
## Alternatives considered

**保留 ③C、只把 next 通道放开、alpha 继续只登记**：用户要求「next/Alpha 都得适配」，且 alpha 往往领先 next（0.2.2-alpha.3 早于 rc.4 切出），漏掉 alpha 等于漏掉真正在前的版本。
**按通道给不同 SLA（latest 6h / next 12h / alpha 24h）**：用户要求「去掉这个决策」，保留分档等于保留同一个歧义；且三通道共用一条链，分档只会让报表与判据再分叉。
**只在 next 晋升到 latest 时才适配**：那正是原 ③C 的实质，等于没改。
## Consequences

代价：预发布（含 alpha）自身的 bug 会被自动发成壳版本，门禁链 + canary 成为唯一防线；每个预发布都会触发一次完整适配（更多 PR / CI 分钟数）。
买到的：检测到即适配，`next`/`alpha` 不再积压（0.2.2-rc.4 已被 watch 识别为 target 并命中现有的 #292 跟踪单）。
门禁：`test-automation-gates` 的 watch 断言改为「统一 6h + channel=next」；`test-autopilot-release-resume` 用源码契约断言跳过分支不再出现（旧 case 3 的「预发布适配确实被跳过」已删除）。
已知缺口：`test-autopilot-release-resume` 只在 dry-run 下验证通道解析，真实适配路径仍由线上 timer 首轮验证。

**跟进（同日，策略上线第一轮就撞到）**：autopilot 的 `findPublished` 同时匹配 Release 正文里的
「发版时 npm latest = X」与「`next` 预发布 = Y」两处；新策略让 `next` 也自动适配后，rc.4 刚被识别就被判
「已发布」（正文只是记录当时 npm 的 next tag，不代表壳里装了它）⇒ 适配被跳过。修法：解析抽到
`scripts/lib/release-floor.mjs`，**只有 `latest` 算「随包分发过该地板」**；gates 新增 4 条断言
（next 不算证据 / latest 算 / 资产 <3 不算 / 两处解析口径）。

