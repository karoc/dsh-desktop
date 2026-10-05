# 文档索引（唯一入口）

> **规则**：① 新增任何 `docs/**/*.md` 都必须在本文件登记，否则 `npm test` 的 `test-doc-links` 会红；
> ② 每个主题只有**一个真源**，其它地方只写指针，不复制内容；
> ③ 日期化的一次性报告归档到 `docs/archive/`，**不修改历史结论**（只在被当成"现状"引用时才更正）。

## 一、活文档（真源，随行为同步更新）

| 主题 | 真源 | 说明 |
|---|---|---|
| 面向用户的行为、安装、能力边界、dsh 版本地板 | [`../README.md`](../README.md) | 唯一的用户向真源；版本地板数值只在这里维护 |
| 开发与发布流程（PR 纪律、门禁、发布清单、提交规范） | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | 流程真源；技能与方案只引用不复制 |
| 踩过的坑 → 对应防线（工程记录） | [`../ENGINEERING-NOTES.md`](../ENGINEERING-NOTES.md) | 每条"坑"配一条机制；历史事迹保留，失效应标注 |
| 壳自身开发（顶栏/菜单/桥/开发版构建/验收） | [`../.dsh/skills/dsh-desktop-shell-dev/SKILL.md`](../.dsh/skills/dsh-desktop-shell-dev/SKILL.md) | 含 §4.8 用 `invoke`/CDP 验收、§4.9 dsh 0.2 CLI 差异、§4.10 本地验证三陷阱 |
| 预装插件同步（版本审计 / 同步 / 验证 / 三处对齐） | [`../.dsh/skills/dsh-preinstalled-plugin-sync/SKILL.md`](../.dsh/skills/dsh-preinstalled-plugin-sync/SKILL.md) | 含 §4.5 CI 阻断门禁与三处对齐表 |
| Windows 安装/启动排障 | [`../.dsh/skills/windows-desktop-shell-debugging/SKILL.md`](../.dsh/skills/windows-desktop-shell-debugging/SKILL.md) | 装不上/启动失败/卡死 |
| 壳 UI 设计 token | [`2026-09-02-ui-design-tokens.md`](2026-09-02-ui-design-tokens.md) | 设计参考（活文档） |
| 方案与决策记录（含 dsh 升级回归的全过程与当前契约） | [`2026-09-25-shell-improvement-plan.md`](2026-09-25-shell-improvement-plan.md) | **先读文件顶部的「当前状态摘要」**；§13/§15 是历史记录，配方真源在技能里 |
| 上游 issue 报告稿（待提交·渲染成本） | [`reports/2026-10-05-upstream-web-gui-never-idles.md`](reports/2026-10-05-upstream-web-gui-never-idles.md) | 实测空闲仍 ~120 次/秒 style+layout 失效；长会话 + 大图下 GPU 可被拉满 |
| 上游 issue 报告稿（待提交） | [`reports/2026-10-05-upstream-403-misclassified-as-auth.md`](reports/2026-10-05-upstream-403-misclassified-as-auth.md) | 403+`server_error` 被归类 AUTH（GUI 报「API 密钥无效」）；本仓只有读权限，需你提交 |
| 决策理由（为什么这么做、放弃了什么） | [`../.agents/notes/implemented/**`](../.agents/notes/implemented) | 每次非平凡改动一篇；按 class 分目录 |
| 版本变更 | [`../CHANGELOG.md`](../CHANGELOG.md) | release-please 维护 |

## 二、归档（历史，不再更新；结论仍然有效或已被明确取代）

| 文件 | 主题 | 结局 |
|---|---|---|
| [archive/PLUGIN-CONSOLE-PLAN.md](archive/PLUGIN-CONSOLE-PLAN.md) | 壳内插件管理控制台实施计划 | **已废弃**（0.1.6-alpha.2 起 dsh 自带插件管理，壳内控制台整体移除） |
| [archive/2026-09-01-dsh-web-hang-instrumentation.md](archive/2026-09-01-dsh-web-hang-instrumentation.md) | dsh web 卡死取证 | 已实施 |
| [archive/2026-09-01-dsh-web-hang-instrumentation.patch](archive/2026-09-01-dsh-web-hang-instrumentation.patch) | 同上（随附补丁文件） | 已实施 |
| [archive/2026-09-03-legacy-takeover-design.md](archive/2026-09-03-legacy-takeover-design.md) | 旧版接管设计 | 已实施（v0.3.x 起） |
| [archive/2026-09-09-pending-cards-solutions.md](archive/2026-09-09-pending-cards-solutions.md) | 待办卡解决方案汇总 | 已分派完成 |
| [archive/2026-09-17-a-level-plans.md](archive/2026-09-17-a-level-plans.md) | A 级改进方案 v2 | 已全部实施 |
| [archive/2026-09-17-a-level-plan-audit.md](archive/2026-09-17-a-level-plan-audit.md) | A 级方案审计 | 已完成（结论已并入实施） |
| [archive/2026-09-17-a-level-plan-audit-compat-cost.md](archive/2026-09-17-a-level-plan-audit-compat-cost.md) | A 级方案兼容性/成本审计 | 已完成 |
| [archive/2026-09-17-official-desktop-takeaways.md](archive/2026-09-17-official-desktop-takeaways.md) | 官方桌面端可取做法 | 已被 2026-09-25 对比报告取代 |
| [archive/2026-09-20-webview2-cookie-431-fix-plan.md](archive/2026-09-20-webview2-cookie-431-fix-plan.md) | 431/cookie 修复方案 | 已实施（P0/P1/P2） |
| [archive/2026-09-20-webview2-cookie-431-fix-audit.md](archive/2026-09-20-webview2-cookie-431-fix-audit.md) | 431 修复审计 | 已完成 |
| [archive/2026-09-20-dsh-upstream-issue-cookie-port-binding.md](archive/2026-09-20-dsh-upstream-issue-cookie-port-binding.md) | 上游 issue（cookie 端口绑定） | 已提交上游 |
| [archive/2026-09-21-dsh-0.1.6-alpha.2-upgrade-plan.md](archive/2026-09-21-dsh-0.1.6-alpha.2-upgrade-plan.md) | 0.1.6-alpha.2 升级方案 | 已发布并验证 |
| [archive/2026-09-25-official-desktop-0.1.7-rc.2-vs-dsh-desktop.md](archive/2026-09-25-official-desktop-0.1.7-rc.2-vs-dsh-desktop.md) | 官方 0.1.7-rc.2 桌面端 vs 我们（逐点对比） | 对比报告（结论已选择性采纳） |
