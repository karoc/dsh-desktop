# Agent Note: preinstalled-plugin-sync-skill

Status: implemented

## Problem

预装插件同步是 dsh-desktop 的周期性维护任务（0.1.1→0.1.4、v0.3.0、本次 0.2.1 三次都是手工走，且每次都有可复现的坑：npm pack 沙箱 EROFS、npm view E404 污染、壳内精简约定、kanban 技能资产缺失、dsh-turn-nav 目录名≠包名）。需要把流程沉淀成技能 + 核查脚本，让下次维护一行命令核查、照手册执行、少踩坑。

## Decision

「预装插件版本核查与同步」流程已沉淀为可复用技能，双通道接入：真源在仓库 .dsh/skills/dsh-preinstalled-plugin-sync/SKILL.md（工作区技能目录，与 windows-desktop-shell-debugging 同款，随 dsh-desktop 版本控制），~/.agents/skills/dsh-preinstalled-plugin-sync 为指向真源的全局 symlink（kanban-use 同款，保证跨工作区/新会话在技能目录可见）。配套 scripts/audit-preinstalled.mjs：只读核查脚本，读 plugins/preinstalled/<pkg>/package.json 的 version，用 fetch 直查 npm registry dist-tags.latest 对比，语义化输出 UPDATE/up-to-date，永远 exit 0（报告工具不当门禁）。技能内容覆盖：架构背景（源→sync-resources→resources→runtime 链路、三层身份、包名/目录名陷阱）、核查（脚本或 curl 等价，禁 npm view）、更新（npm pack --cache 工作区内目录防 EROFS、按壳内精简约定拷文件、kanban 技能资产例外）、验证（node --check、grep 防摇树、diff -r 幂等）、提交推送约定、技能自身维护（真源/symlink/更新流程）、常见坑速查。
## Alternatives considered

只放 ~/.agents/skills/ 全局目录（dsh-plugin-development 同款）——放弃：本技能是 dsh-desktop 专属流程，仓库内 .dsh/skills/ 是既有工作区技能约定（windows-desktop-shell-debugging 同款），放仓库才随 clone/版本控制走。只放 .dsh/skills/ 工作区目录——放弃：无法保证跨工作区/新会话在技能目录可见（本会话目录列表就不含 windows-desktop-shell-debugging），故加 ~/.agents/skills/ 全局 symlink 双通道。更新流程保持手工（脚本只做核查）——暂不自动化更新步骤，等下次实际执行验证稳定后再脚本化。
## Consequences

下次「检查/更新预装插件」直接 node scripts/audit-preinstalled.mjs 一行核查，按 .dsh/skills/dsh-preinstalled-plugin-sync/SKILL.md 手册执行；新会话/跨工作区经 ~/.agents/skills/ symlink 可见技能。新机器 clone 后需手动重链 symlink（技能 §6 有命令）。audit 脚本只读、永远 exit 0，不阻塞任何流程。技能真源在 .dsh/skills/ 随仓库提交，改技能 = 改仓库文件 + 提交，零漂移。

