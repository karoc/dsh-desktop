# 预装插件同步：dsh-turn-navigator 0.4.7 → 0.4.8

## 问题

壳内预装的 `dsh-turn-navigator` 是 **0.4.7**，npm latest 已是 **0.4.8**（2026-10-02 发布；其余三个预装包 model-reasoning 0.2.6 / kanban 0.2.10 / smoothly-opencode-session 0.2.1 均已最新）。0.4.8 带来两件与用户直接相关的事：

1. **tooltip 增加回复预览**——用户在 49 轮会话里报告「官方胶囊条在 turn 46 有内容，我们只显示轮次号」。根因：turn 46 根本没有人类提示词（唯一 `user/message` 是后台作业回报），官方那点"内容"其实是它的回复预览行；0.4.8 按官方口径（窗口 `response` 优先 → `turnOutline.response` 兜底、120 字上限）补上了这一行，并保持"插件不自行摘取助手正文"。
2. **a11y 与官方设计对齐**——官方 mark 的可访问**名称**是动作（`chat.turnNavigation.jump` / `jumpLoad`），内容经 `aria-describedby` 指向 `role="tooltip"` 节点，另有 `aria-current`/`aria-busy`，focus 也出预览。此前我们把整条 tooltip 塞进 `aria-label`、无描述链接、预览只在 hover。0.4.8 改为官方同款（文案逐字对齐：`跳转到第 N 轮` / `加载并跳转到第 N 轮`）。

不更新则桌面用户仍拿到"缺回复预览 + a11y 未对齐"的 0.4.7。

## 决策

走仓库脚本，不手工拷贝：

```sh
npm run sync:plugin -- dsh-turn-navigator 0.4.8   # 基准 = npm 已发布 tarball
node scripts/sync-resources.mjs
```

- 收录 6 个文件（`lib/index.js`、`lib/client.js`、`cordis.patch.yml`、`README.md`、`LICENSE`、`package.json`），按壳 denylist 丢弃 4 个；**文件集与 0.4.7 完全一致**（0.4.8 也没有新增随包资产：插件仓新增的门禁脚本不在包作者 `files` 白名单内）。
- README 双语链接行按通用规则裁剪（实测只删该行 + 其后的空行）。
- 本次**从 main（0.4.7）直接跳到 0.4.8**：0.4.7 已由 PR #69 合入 main，早先那条 `chore/preinstalled-turn-nav-0.4.7` 分支（内容相同、PR 未开）已被取代。

验证（全部实测）：`node --check` ×2 ✅；壳副本 `lib/client.js` sha256 = `cd6b3932f03b59d2…`，与**已发布 0.4.8 tarball**及**插件仓构建**三方一致（发布物 `lib/index.js` 校验和亦与仓库一致）✅；`diff -r plugins/preinstalled src-tauri/resources/preinstalled` → IDENTICAL ✅；`test-copy-consistency.mjs` PASS、`test-plugin-dsh-compat.mjs` PASS（4 包 0 警告；壳地板 `0.2.0-rc.1` 满足插件 peer `>=0.1.7-rc.1`）✅；全量 `npm test` exit 0 ✅；`audit-preinstalled.mjs` 报四个包 `up-to-date`，turn-nav **3/3 随包资产逐字节一致** ✅。

## 被放弃的方案

- **手工 `npm pack` + 逐文件拷贝**：历史上丢过 kanban 技能资产、删错 README 空行；仓库脚本已把这些约定固化（本次零手工拷贝）。
- **以插件仓 HEAD 为基准**：权威定义是 npm 已发布版；本轮插件仓 HEAD 只比 tag 多出 CHANGELOG/门禁脚本/Agent Note，均不在随包 `files` 内，两条基准对随包资产一致。
- **把两个版本拆成两个 PR**（先 0.4.7、再 0.4.8）：0.4.7 已经合入 main，再补一条 0.4.8 分支即可；拆两条只会让同一个文件在同一周被改两次。
- **顺手同步另外三个包**：它们已最新，动它们只产生噪声 diff。

## 后果

- 壳的下一个版本将随包分发 0.4.8；**已安装桌面应用的 runtime 拷贝不受本次影响**——那走控制台「检查预装插件更新」的用户门控路径（从 npm 取），源树改动随下次壳发版生效。
- 四个预装包全部与 npm latest 对齐且内容逐字节一致，`audit-preinstalled.mjs` 无 `UPDATE`/`DRIFT` 行。
- 操作提示（agent 沙箱特有，不是脚本缺陷）：沙箱把 `HTTPS_PROXY` 指向 harness 代理，而 npm 走 `.npmrc` 的 `127.0.0.1:20172`，`sync-preinstalled-plugin.mjs` 的 `fetch` 会 502；运行时把代理变量覆盖成 npm 的那一个即可。
- 遗留：早先的分支 `chore/preinstalled-turn-nav-0.4.7`（远端）已被本分支取代，可删除。
