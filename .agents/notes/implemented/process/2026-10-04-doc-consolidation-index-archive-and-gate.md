# Agent Note: doc-consolidation-index-archive-and-gate

Status: implemented

## Problem

本仓 markdown 已有 84 个（README/CONTRIBUTING/ENGINEERING-NOTES + 16 篇 `docs/*.md` + 3 个技能 + 62 篇 Agent Note）。其中 `docs/` 顶层混着"活参考"与"一次性、日期化的方案/报告"（约 3,700 行），**16 篇里 13 篇没有任何仓内入链**；唯一入口缺失——新人（或下一个会话）无法从任何一页判断"这件事的当前真源在哪"。方案文件 `2026-09-25-shell-improvement-plan.md` 已膨胀到 928 行、§1–§15 按时间累积，读者必须通读才能拼出"现状"；而"文档腐烂"（失效链接、孤儿文档）此前没有任何机制拦截——上一轮的一致性清仓（§15.10）证明这类问题只能靠人肉扫描发现。

## Decision

对本仓 84 个 markdown 做了一次"单一真源 + 归档 + 门禁"的整合，落地形态如下。

**`docs/INDEX.md` 是唯一文档入口**，两张表：① **活文档表**给出"主题 → 真源"映射——用户行为与 dsh 版本地板 = `README.md`；开发与发布流程 = `CONTRIBUTING.md`；坑→机制 = `ENGINEERING-NOTES.md`；壳开发/验收/本地构建 = `.dsh/skills/dsh-desktop-shell-dev/SKILL.md`；预装插件同步 = `.dsh/skills/dsh-preinstalled-plugin-sync/SKILL.md`；Windows 安装排障 = `.dsh/skills/windows-desktop-shell-debugging/SKILL.md`；UI 设计 token = `docs/2026-09-02-ui-design-tokens.md`；方案与决策记录 = `docs/2026-09-25-shell-improvement-plan.md`；决策理由 = `.agents/notes/implemented/**`；版本变更 = `CHANGELOG.md`。② **归档表**列出 `docs/archive/` 的 13 篇日期化报告及各自结局（已实施/已废弃/已提交上游/已被取代）。

**归档用 `git mv`，正文一字不改**：13 篇已完成或被取代的报告从 `docs/` 顶层移入 `docs/archive/`（脚本实施计划、旧版接管设计、待办卡方案、A 级方案三篇与审计两篇、官方桌面端两份报告、431/cookie 方案与审计、上游 issue 记录、0.1.6-alpha.2 升级方案）。移动时唯一允许的编辑是**修正仓内入链**（实测 5 篇 Note + 1 个技能受影响，已改）。`docs/` 顶层因此只剩 3 个文件：`INDEX.md`、`2026-09-02-ui-design-tokens.md`（活的设计参考）、`2026-09-25-shell-improvement-plan.md`。

**方案文件改为"摘要 + 只追加正文"**：`docs/2026-09-25-shell-improvement-plan.md`（928 行）文件名不动（有入链），但在正文前插入 **15 行《当前状态摘要》**，写明 dsh 版本地板 `0.2.0-rc.1`、四个预装插件版本、门禁套数（17）、已发布版本（v0.14.0）、当前契约面（overlay 两条目 / id 集合 183 / `dsh web` 不接受 `--profile` / 桥 10-10）与各配方真源指向；§1–§15 保持原样作为按时间累积的记录，凡标注「本节已过期」的以标注为准。

**新增门禁 `scripts/test-doc-links.mjs`（`npm test` 第 17 套）**，两条断言：① 文档内**内部相对链接**必须可达；② `docs/**/*.md` 必须在 `docs/INDEX.md` 登记。边界：扫描前先剥离行内代码与围栏代码块（技能里合法地引用插件自己的 `English | [简体中文](README.zh.md)` 行作示例，不剥离就会误报）；跳过 `http(s)/mailto/#` 与锚点；覆盖 84 个文档（README/CONTRIBUTING/ENGINEERING-NOTES + `docs/**` + 三个技能的 SKILL.md + `.agents/notes/implemented/**`）。**它不判断内容正确性**，只保证"链接可达 + 已登记"。首次运行即抓出 3 条真失效链接（1 条是我归档造成的路径失效、2 条是指向插件仓库 `README.zh.md` 的陈旧引用），两个负向对照（未登记文档 / 不存在链接）均如期变红。
## Alternatives considered

**① 直接删除已完成的日期化方案**（`docs/` 从 16 篇降到 3 篇）：否决 —— 本仓的纪律是"日期化记录不可修改、更不可删除"，它们是"为什么这么做、放弃了什么"的唯一载体（§15.x 里大量"已过期/被取代"标注正是这种留痕）；删掉等于把复盘能力一起删掉。**② 把所有文档合并成一份大文档**：否决 —— 技能必须能被独立加载（`dsh-desktop-shell-dev` / `dsh-preinstalled-plugin-sync` / `windows-desktop-shell-debugging` 是 agent 按需载入的操作手册），合并后既破坏按需加载，也让"哪个是流程真源"更难判断。**③ 把 928 行的方案改写成一份新的《当前状态》文档、废弃 §1–§15**：否决 —— 有 3+ 处入链（README、两篇 Note）指向它，且会丢掉 §13/§15 的过程证据；改为"文件头加 15 行摘要 + 正文保持只追加"。**④ 用 frontmatter + 生成器自动产出索引**：否决 —— 要给 84 个文档加 YAML 前置块并维护生成脚本，机械成本高于问题本身；"索引必须手工登记 + 门禁兜底"能拿到绝大部分收益。
## Consequences

**代价**：① 新增任何 `docs/**/*.md` 都要在 `docs/INDEX.md` 加一行，否则 `npm test` 红（这是刻意的摩擦，用来阻止再次堆积）；② 归档用 `git mv`，历史保留但**外部**（聊天、旧提交里的绝对路径）引用会 404 —— 实测只有 2 篇归档文档有仓内入链，均已修正；③ 门禁**不判断内容是否过时/正确**，也不检查锚点（`#section`）与外部链接 —— 内容准确性仍靠人工与评审（见方案 §15.10 的"操作性陈述必须与出货现实一致"）。**买到**：① 一页 `docs/INDEX.md` 回答"这件事的真源在哪"，`docs/` 顶层从 16 篇混杂降到 3 篇活文档；② 928 行的方案不再要求读者从头翻找现状（头部 15 行摘要 + 明确指向 README/CONTRIBUTING/技能）；③ 链接腐烂与"孤儿文档"从此有门禁兜底（首次上线即抓出 3 条真失效链接，且两个负向对照都能变红）。**后续义务**：活文档的**归属变更**（例如某主题的真源从技能搬到 README）必须同步更新 INDEX 的映射表 —— 门禁只能发现"未登记"，发现不了"登记错了"。

