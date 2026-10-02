# 预装插件同步：dsh-turn-navigator 0.4.6 → 0.4.7

## 问题

壳内预装的 `dsh-turn-navigator` 停在 **0.4.6**，而 npm latest 已是 **0.4.7**（2026-09-30 发布；另三个预装包 model-reasoning 0.2.6 / kanban 0.2.10 / smoothly-opencode-session 0.2.1 已是最新）。

0.4.7 不是常规小版本：它修掉了用户报告的**轮次胶囊 hover 提示显示 `(no user message)`** 缺陷——根因是插件在数据层伪造了英文占位符（无人类提示词的轮次：goal 续跑 / plugin 唤醒 / 后台子代理回报 / compaction 检查点，本机日志实测 2168 轮里 108 轮属此类），且 journal 折叠把注入正文（`<goal_round> Objective: …`）当成"用户消息摘要"；0.4.7 改为：数据层保留空标签、渲染层回退本地化轮次号（与官方 `TurnNavigator` 同语义）、并接入宿主 `turnOutline` 投影作第三来源。**壳内副本不更新，桌面用户就仍拿到带该缺陷的版本**——这不是"版本号落后"，而是"缺陷修复没随包分发"。

## 决策

按技能 §3.5 走仓库脚本，不手工拷贝：

```sh
npm run sync:plugin -- dsh-turn-navigator 0.4.7   # 基准 = npm 已发布 tarball
node scripts/sync-resources.mjs
```

- 收录 6 个文件（`lib/index.js`、`lib/client.js`、`cordis.patch.yml`、`README.md`、`LICENSE`、`package.json`），按壳 denylist 丢弃 4 个（`CHANGELOG.md`、`CONTRIBUTING.md`、`README.zh.md`、`docs/turn-nav-rail.png`）——与 0.4.6 的文件集完全一致，**0.4.7 没有新增随包资产**（插件仓新加的 `scripts/*.mjs` 是开发期工具，不在包作者 `files` 白名单内，因此不进壳）。
- README 的双语链接行按通用规则裁剪：实测 diff 只有 `**English · [简体中文](README.zh.md)**` 这一行 + 其后的空行被删除，其前的空行保留（技能记过的格式坑，turn-nav 是"粗体·式"）。
- `package.json` 与已发布 tarball 逐字节相同（壳内不需要任何改写）；`src-tauri/resources/preinstalled/` 由 `sync-resources.mjs` 重同步。

验证（缺一不可，全部实测）：`node --check` 两个 lib ✅；壳副本 `lib/client.js` sha256 = `11cc70e734d3a8f6…`，与**已发布 tarball** 及**插件仓构建**三方一致，且不含 `no user message`、含 4 处 `turnLabel` ✅；`diff -r plugins/preinstalled src-tauri/resources/preinstalled` → IDENTICAL ✅；`test-copy-consistency.mjs` PASS、`test-plugin-dsh-compat.mjs` PASS（4 包 0 警告；壳地板 `0.2.0-rc.1` 满足插件 peer `@deepseek-ai/dsh-client-ui-conversation >= 0.1.7-rc.1`，§6.5 的 fail-closed 耦合无风险）✅；全量 `npm test`（16 套）exit 0 ✅；`audit-preinstalled.mjs` 复核报四个包 `up-to-date`，turn-nav **3/3 随包资产与已发布 tarball 逐字节一致** ✅。

## 被放弃的方案

- **手工 `npm pack` + 逐文件拷贝**（技能 §3 的老流程）：历史上正是它丢了 dsh-kanban 的技能资产、删错 README 空行；§3.5 的脚本把这些约定固化了，本轮零手工拷贝。
- **以插件仓 HEAD 为基准**：权威定义是"npm 已发布 latest"。本轮 HEAD（`699d7d8`）之上还有发布后提交（CHANGELOG 修正、门禁脚本、技能回写），但**都不在随包 `files` 白名单内**——两条基准对随包资产一致，因此无需为它改基准；若将来 HEAD 有未发布的运行时改动，按技能要先与用户确认再改基准。
- **顺手把另外三个包也"同步一遍"**：它们已是最新（`audit-preinstalled.mjs` 报 up-to-date 且内容匹配），差异只是壳内精简，动了只会制造噪声 diff。
- **把插件的 `scripts/*` 一并带进壳**：它们不是随包资产（不在 `files` 里），带进去等于让壳分发开发期工具，违背精简约定。

## 后果

- 壳的下一个版本将随包分发 0.4.7；**已安装桌面应用的 runtime 拷贝不受本次影响**——那走控制台「检查预装插件更新」的用户门控路径（从 npm 取），源树改动随下次壳发版生效。
- 四个预装包现已全部与 npm latest 对齐且内容逐字节一致，`audit-preinstalled.mjs` 不再有 `UPDATE`/`DRIFT` 行。
- 操作提示（本机沙箱特有，不是脚本缺陷）：agent 沙箱会把 `HTTPS_PROXY`/`NODE_USE_ENV_PROXY` 指向 harness 自己的代理，而 npm 走 `.npmrc` 里的 `127.0.0.1:20172`；`sync-preinstalled-plugin.mjs` 的 `fetch` 因此会 502。运行时显式覆盖为 npm 的代理即可：`HTTPS_PROXY=http://127.0.0.1:20172 npm run sync:plugin -- …`。用户本机 shell 无该冲突。
