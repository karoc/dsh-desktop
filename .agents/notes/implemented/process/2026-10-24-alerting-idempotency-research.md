# 自动化发版/告警链路：先出可核验清单，再改生产力代码

- 日期：2026-10-24
- 类别：process
- 相关文档：[`docs/2026-10-24-alerting-and-idempotency-patterns.md`](../../../../docs/2026-10-24-alerting-and-idempotency-patterns.md)
- 相关笔记：[`2026-10-18-dsh-upstream-release-day-drill.md`](2026-10-18-dsh-upstream-release-day-drill.md)、[`../feature/2026-10-21-sla-two-segment-latency.md`](../feature/2026-10-21-sla-two-segment-latency.md)

## 问题

2026-10-23 上游 dsh `0.2.1-rc.3` 发版时，本仓自动化链路同时暴露三件事：同一版本产生 17 条重复 issue（去重查询按 label 过滤，而 label 没写上去）；项目 fine-grained PAT 缺 `Issues: write`，导致更新 #217 时 `updateIssue` / `addLabelsToLabelable` 被拒，脚本每 60 秒重试；告警只有 issue 一个通道，没有“任务没跑 / 告警没发出来”的 dead man's switch。根因不是某一行代码写错，而是“幂等键、凭据能力、送达检测”三层的设计假设没有被逐条核验。

## 决定

本轮只交付一份带官方文档/源码坐标的防错清单（`docs/2026-10-24-alerting-and-idempotency-patterns.md`），不改 `scripts/dsh-watch.mjs`、`scripts/dsh-release-autopilot.mjs` 或 systemd unit。清单给出 11 条采用项（S=7 / M=4 / L=0），方向是：**单一写者 + 确定性 issue 键（标题/正文 marker，不依赖 label）+ canary 写探测 + dead man's switch + 按 target 的三态状态机 + 独立 reconcile 收敛重复对象**。外部 SaaS（PagerDuty / healthchecks.io 托管）明确不采用，只吸收其 `dedup_key` / grouping / heartbeat 语义。

清单里的事实分三档：`[已验证: URL/文件:行]`、`[假设]`、`[本机不可验证]`；`[假设]` 不得作为采用依据，全部单列在文档 §9。本文档不实现任何修复，也不新增门禁；实施顺序建议见文档 §7.1（先一次性收敛 17 条，再加 PAT 权限与 canary，然后才是去重/单写者/心跳）。

## 放弃的方案

- **直接改 `dsh-watch` 代码**：本轮写域只允许文档 + 看板 + Note；且方案未定前改代码会与进行中的 autopilot 工作冲突，重复踩“label 当唯一键”的坑。
- **引入 PagerDuty / healthchecks.io 托管**：用户明确不采用，且告警内容会离开本机；只借鉴机制，不引入服务。
- **自建 Prometheus + Alertmanager**：规模不匹配；grouping/inhibition 的语义已落到“一个 target 一个 issue + 只在状态跃迁时通知”。
- **继续用 label 作为去重键并补权限了事**：本次 16 条无 label issue 已证明 label 是创建后的第二次写，不能承担唯一键职责；标题/正文 marker 是创建请求的一部分，失败语义更强。
- **依赖 GitHub Actions `schedule` 做 SLA 时钟**：官方明确会延迟/丢弃，社区实测小时级 cron 可拉到 3–9 小时；本机 timer 保留为主路径。

## 代价与后续

代价是这一轮没有止血代码：17 条重复 issue 仍在，PAT 权限仍需用户去 GitHub 设置里补，告警仍然只有 issue 通道。换来的是一份可复核的依据链，避免“拍脑袋修一版、下次发版再炸”。后续 A1–A11 每条都要配可失败验证（canary 用只读 token 必须红、心跳过期必须告警、重复注入最多一条），其中 H1–H8 是明确的未验证假设，落地前先转成可核验步骤。
