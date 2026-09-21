# Agent Note: preinstalled-plugin-sync-ocs-011

Status: implemented

## Problem

`scripts/audit-preinstalled.mjs` 报出唯一一项被版本门控正常识别的漂移：`@karoc/dsh-smoothly-opencode-session` 随包版本 0.1.0，而 npm `dist-tags.latest` 已是 0.1.1。0.1.1 不是补丁级小改：`cordis.patch.yml` 新增/改写了三个配置键（`hosts` host 门控，默认 `['https://opencode.ai']`，`['*']` 会关闭门控；`debugRequests` 请求级记录；`discoveryFallback` 对裸 `/models` 发现请求注入进程稳定 UUID），`lib/index.js` 由 8579 字节增至 17566 字节。随包副本停在 0.1.0，意味着桌面壳用户拿到的是没有 host 门控的那一版。

## Decision

按技能 `dsh-preinstalled-plugin-sync` §3 的既有流程同步，不发明新路径：

1. `.tmp-preinstalled` 内 `npm pack --cache ./.npm-cache @karoc/dsh-smoothly-opencode-session@0.1.1`（沙箱 `~/.npm` 只读，必须指定工作区内 cache）；
2. 按壳内精简约定只拷 5 个文件：`package.json` / `cordis.patch.yml` / `lib/index.js` / `LICENSE` / `README.md`。**0.1.1 的 README.md 里没有「English | [简体中文](README.zh.md)」链接行，所以本次无需裁剪**（该规则只在存在该行时适用）；`README.zh.md` / `CHANGELOG.md` / `CONTRIBUTING.md` 按约定不随包；
3. `node scripts/sync-resources.mjs` 重建 `src-tauri/resources/preinstalled/`。

验证（技能 §4 全部执行）：`node --check lib/index.js` 通过；`diff -r plugins/preinstalled src-tauri/resources/preinstalled` → IDENTICAL；manager 真源副本（server-manager.mjs / proxy.mjs）与两个桌面客户端插件副本 → IDENTICAL；`npm test` 八套全绿（含覆盖预装路径的 `test-control-plane.mjs`）。本次同步只动源树捆绑内容。

## Alternatives considered

**手改 `plugins/preinstalled/` 里的版本号或文件来"对齐"**：随包副本必须来自 npm 已发布 tarball，手改会与发布包内容不一致，且下次同步被覆盖——正是这套流程要防的漂移。

**等 dsh-kanban 的 0.2.7 一起同步**：两者无依赖，且分开提交能让每轮同步的 Agent Note 各自可追溯；混在一起会让"哪一版插件引入了什么"变得难查。

**按"最新"而不按固定版本取 tarball**（`npm pack <pkg>` 不带版本）：会拿到不可复现的结果，且与 audit 的 `dist-tags.latest` 比对失去意义；本次固定 `@0.1.1`。

**顺手把 `README.zh.md` 一起带上**：违反壳内精简约定（中文 README 不随壳发，带了反而留下坏链风险）。

## Consequences

买了：随包副本与 resources 副本同时到 0.1.1，与 npm latest 一致，audit 的 `UPDATE` 项归零；host 门控（默认只对 `https://opencode.ai` 注入会话头）随下一个壳版本交付给用户。

代价与边界：**已安装的桌面应用不会因本次提交而改变**——它们的 runtime 拷贝在 `<runtime>/node_modules/<pkg>`，只能由控制台用户门控的「检查预装插件更新」（`updatePreinstalled()`：`npmViewVersion` + `npm install <pkg>@latest`，从 npm 拉）或新的壳版本安装包更新。本机实测 `dsh.json` 没有 `updates` 字段，说明用户从未点过该更新，随包副本就是用户实际在跑的版本。

未覆盖的相邻缺口：dsh-kanban 的随包副本仍是坏 frontmatter（技能会被 DSH 静默丢弃），它**不受本次同步影响**，且因为"随包版本 == npm latest == 0.2.6"被 audit 判为 `up-to-date`、按 §3 纪律"不要动"——必须先把 dsh-kanban 升到 0.2.7 并发布，版本门控才会放行。
