# Agent Note: preinstalled-plugin-sync-v0.2.8

Status: implemented

## Problem

`scripts/audit-preinstalled.mjs` 报出两项版本级 `UPDATE`，且都带内容级漂移：

- `dsh-kanban` 随包 0.2.6 → npm latest 0.2.8（`lib/client.js` / `lib/index.js` / `skills/kanban-use/SKILL.md` 三处 DRIFT）；
- `@karoc/dsh-smoothly-opencode-session` 随包 0.1.1 → npm latest 0.2.0（`cordis.patch.yml` / `lib/index.js` DRIFT）。

kanban 这一项是上一篇同步 Note（`2026-09-20-preinstalled-plugin-sync-ocs-011.md`）明确留下的未解项：随包副本停在 0.2.6，其 `skills/kanban-use/SKILL.md` 的 `description` 未加引号且含 `": "`，DSH 的 YAML 解析把它读成嵌套 mapping → **整份技能被静默丢弃**（模型目录里没有、界面上也没有任何提示）。当时版本门控判 `up-to-date`（随包版本 == npm latest == 0.2.6），按 §3 纪律「已最新就不要动」无法同步，只能等上游发新版。0.2.7 修了 frontmatter 但从未发布；0.2.8 才真正把修复送到 npm（本 Note 的前提）。

## Decision

按技能 `dsh-preinstalled-plugin-sync` §3 的既有流程同步，固定版本、不发明路径：

1. 工作区内 `npm pack --cache ./.npm-cache dsh-kanban@0.2.8 @karoc/dsh-smoothly-opencode-session@0.2.0`（`~/.npm` 只读，必须指定工作区 cache）；
2. 按壳内精简约定拷入：
   - `dsh-kanban` 8 个文件：`package.json` / `cordis.patch.yml` / `lib/index.js` / `lib/client.js` / `LICENSE` / `README.md`（裁掉 `English | [简体中文](README.zh.md)` 行）/ `skills/kanban-use/SKILL.md` / `scripts/install-skill.mjs`；
   - `dsh-smoothly-opencode-session` 5 个文件：`package.json` / `cordis.patch.yml` / `lib/index.js` / `LICENSE` / `README.md`（0.2.0 的 README 没有语言切换行，裁剪规则不适用，实测确认）；
   - **`docs/guarantees.md`（smoothly 0.2.0 新增）不随包**：纯文档，且 `lib/index.js` 里没有任何 `docs/` 运行时引用（已核对）；
3. `node scripts/sync-resources.mjs` 重建 `src-tauri/resources/preinstalled/`。

验证（技能 §4 全跑）：四个 `lib/*.js` `node --check` 通过；`dsh-kanban/lib/index.js` 含 `kanban-use` 15 处、`skill-version` 6 处（技能投递代码没被摇树）；`diff -r plugins/preinstalled src-tauri/resources/preinstalled` → IDENTICAL；`node scripts/test-copy-consistency.mjs` → PASS（含 `SKILL.md` frontmatter 可解析性，本次该项从告警转为通过）；`audit-preinstalled.mjs` 重跑 → 四个包全部 `up-to-date`，逐字资产 4/4、2/2、3/3、3/3 与已发布 tarball 一致。

## Alternatives considered

**先把 0.2.7 内容 vendor 进壳（不等 npm 发布）**：桌面壳的同步基准是「npm 已发布 tarball」，0.2.7 从未发布、tarball 不存在，vendor 仓库 HEAD 会让随包副本无法被 `audit-preinstalled.mjs` 的内容级比对校验，也让「用户在跑哪一版」失去单一事实来源。已与用户确认：先发 0.2.8，再同步。

**只同步 kanban、把 smoothly 0.2.0 留到下一轮**：两者都是审计报出的真实漂移，分两次提交只会让「哪一版插件引入了什么」更难查；一次同步 + 一篇 Note 即可覆盖。

**顺手把 `docs/guarantees.md` 带上**：违反壳内精简约定，且它不被运行时引用；带了反而扩大随包面。

**把 `KANBAN.json` 一并提交**：工作区里它确实有未提交改动，但那是用户另一条会话在 2026-09-21 19:33 加的两张跟进卡（网关 403 误判 AUTH、宿主断流根因），与本次同步无关——按「只提交自己动过的东西」处理，本次提交不包含 `KANBAN.json`。

**提交时带上 `.tmp-investigate/`**：它是更早会话留下的未跟踪草稿目录（含 build 脚本与 audit 输出），不属于本次改动，保持未跟踪。

## Consequences

买了：随包副本与 resources 副本同时到 `dsh-kanban` 0.2.8 / `@karoc/dsh-smoothly-opencode-session` 0.2.0，audit 的 `UPDATE` 与技能 frontmatter 告警双双归零。kanban 0.2.8 相对 0.2.6 的实质变化会随下一个壳版本交付：看板改为 DSH 0.1.6 的全局面板缝（`sidebar.panellist` + keyed `main`，不再用全屏 overlay）、修掉 DSH 0.1.6-alpha.2 删除 `SessionListState.current` 造成的静默降级、修掉两个根本不存在的设计令牌与一处「用 5% alpha 背景色当文字色」的错误、给 prompt 快照加 `{{` 转义（此前标题含 `{{TOKEN}}` 的卡会让每次请求的上下文快照渲染抛错），以及技能改由 `ctx.skills.register` 从包内投递（因此 `skills/kanban-use/SKILL.md` 必须随包，本 Note 已按此拷入）。

代价与边界：**已安装的桌面应用不因本次提交改变**——runtime 拷贝在 `<runtime>/node_modules/<pkg>`，只能由控制台用户门控的「检查预装插件更新」从 npm 拉取，或等新的壳安装包。本机 `dsh.json` 无 `updates` 字段，说明用户从未点过该更新。另注：桌面运行时已是 DSH 0.1.6-alpha.2，技能由 runtime 注册投递，`~/.agents/skills` 里的旧副本不再生效（项目级副本仍可覆盖）。

未覆盖的相邻缺口：本次未编译/安装壳安装包，也未验证已安装应用经控制台更新到 0.2.8 的实际路径（`test-control-plane.mjs` 覆盖拷贝逻辑，不覆盖真实 npm 拉取）；`dsh-kanban` 的 `docs/screenshots/board-page.png` 仍不进 tarball（README 已改用绝对 URL 引用）。
