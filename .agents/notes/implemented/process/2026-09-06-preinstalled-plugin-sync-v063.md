# Agent Note: preinstalled-plugin-sync-v063

Status: implemented

## Problem

壳内预装插件（plugins/preinstalled/ → src-tauri/resources/preinstalled/，随壳版本锁定）再次落后于 npm latest：dsh-kanban 0.2.1→0.2.5、dsh-model-reasoning 0.2.1→0.2.4、dsh-turn-navigator 0.1.1→0.4.3（跨 0.4 大版本）。同时 board 跟进卡片「resources/plugin 插件同步拷贝滞后」确认存在：plugins/dsh-plugin-console/client.js 在 #15 已去掉悬浮按钮，但 src-tauri/resources/plugin/@dsh-desktop/plugin-console/ 打包副本仍是旧版（带悬浮按钮），一直未经 sync-resources 重新同步。

## Decision

以 npm latest tarball 为权威基准同步 3 个预装插件（npm pack 到工作区 .tmp-preinstalled，cache 指定 --cache ./.npm-cache 规避沙箱只读 ~/.npm）：dsh-kanban→0.2.5、dsh-model-reasoning→0.2.4、dsh-turn-navigator→0.4.3。按既有精简约定只随包发 package.json + cordis.patch.yml + lib/index.js + lib/client.js + LICENSE + 裁剪后的 README.md（去「English | [简体中文]」链接行及后空行）；dsh-kanban 继续随包带 skills/kanban-use/SKILL.md + scripts/install-skill.mjs（0.2.x host 半区 skill-sync 必需）。dsh-turn-navigator 0.4.3 tarball 新增 docs/turn-nav-rail.png，仅在 package.json files 声明（发布用），lib 无运行时引用，按约定不随包。随后跑 scripts/sync-resources.mjs 一次性同步：3 个预装副本 + manager 真源副本 + 修复 plugin-console 打包副本滞后（此前一直漏同步）。验证：node --check 全部 lib（源树+resources 两处）、bundle 内 grep kanban-use(10)/skill-version(5) 防摇树、diff -r plugins/preinstalled vs resources/preinstalled 完全一致、diff 确认 plugin-console/client-notifications/manager/proxy 全部一致、npm test 8 套全绿。board 跟进卡片可关闭。
## Alternatives considered

按源仓库 HEAD 同步（历史惯例）——本次拒绝：继续沿用 2026-08-25 定下的「npm 已发布 latest tarball 为权威基准」，三个插件仓库 HEAD 与发布 tag 一致、基准收敛。不随包带 turn-navigator 的 docs/turn-nav-rail.png——确认仅 files 声明、非运行时资产，精简约定成立。单独手工改 plugin-console 副本——拒绝：正解是跑 sync-resources.mjs 统一同步，避免继续用「改一处、拷一处」的易漏模式（本次滞后正是手工拷贝漏掉造成的）。
## Consequences

下次桌面构建（发布新版本后）随壳发 dsh-kanban 0.2.5、dsh-model-reasoning 0.2.4、dsh-turn-navigator 0.4.3，且插件管理窗口（plugin-console 打包副本）将与源树一致（去掉悬浮按钮、面板开关走全局接口）。本次只改源树捆绑内容，不影响已安装桌面应用的 runtime 拷贝（由控制台「检查预装插件更新」用户门控从 npm 更新）。plugin-console 的 README/package.json 与源树一致，无版本漂移。

