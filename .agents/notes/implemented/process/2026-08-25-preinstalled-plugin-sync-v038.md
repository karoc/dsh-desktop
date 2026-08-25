# Agent Note: preinstalled-plugin-sync-v038

Status: implemented

## Problem

壳内预装插件（plugins/preinstalled/ → src-tauri/resources/preinstalled/，随壳版本锁定）落后于各插件在 npm 上的最新发布版：dsh-model-reasoning 0.1.4（最新 0.2.1）、dsh-kanban 0.1.2（最新 0.2.1）、dsh-turn-navigator 0.1.1（最新 0.1.1）。需要核查并同步到最新版，保证桌面端内置插件与仓库/registry 功能一致。

## Decision

本次同步基准改为「npm 已发布 latest 的官方 tarball」（npm pack 拉取），而非历史惯例的「源仓库 HEAD 提交态」——因为三个插件仓库现均干净地停在发布 tag（dsh-kanban@v0.2.1、dsh-model-reasoning@v0.2.1、dsh-turn-nav@v0.1.1），且 tarball 的 lib/index.js、lib/client.js、cordis.patch.yml 与仓库逐字节一致（已验证 SAME），两条基准收敛。已写入 plugins/preinstalled/ 与（经 sync-resources.mjs 同步的）src-tauri/resources/preinstalled/：dsh-model-reasoning→0.2.1、dsh-kanban→0.2.1、dsh-turn-navigator 保持 0.1.1 不动。保留壳内既有精简约定：README.md 去掉「English | [简体中文](README.zh.md)」链接行（README.zh.md 不随壳发），只随包发 package.json + cordis.patch.yml + lib/* + LICENSE + README.md。对 dsh-kanban 0.2.1 例外追加随包技能资产 skills/kanban-use/SKILL.md 与 scripts/install-skill.mjs——0.2.x 的 host 半区（skill-sync）功能上随包分发技能（lib 里 skillSourceFile() 解析 <pkg>/skills/kanban-use/SKILL.md，缺失时每次启动 warn「skill auto-install skipped」，手动兜底提示引用 <pkg>/scripts/install-skill.mjs）；不带上会让桌面端 kanban 静默缺技能且兜底命令失效。验证：node --check 全部 lib、bundle 内 grep kanban-use/skill-version 字符串防摇树、diff -r plugins/preinstalled vs resources/preinstalled 完全一致。未改 dsh-turn-navigator（lib 与 0.1.1 tarball 逐字节一致，仅 package.json/README 差异属壳内精简）。
## Alternatives considered

按源仓库 HEAD 同步（历史惯例）——本次被拒绝：请求语义是「更新到最新版」，npm tarball 才是「已发布最新版」的权威定义；且仓库 HEAD 在发布 tag 之后只有 test/docs 提交（未动 src），与 tarball 收敛，无内容损失。保持最小精简、不随 kanban 发技能资产——被拒绝：0.2.x host 半区把技能作为随包功能（自动装 + 手动兜底），精简会导致桌面端 kanban 每次启动告警且无兜底脚本，功能残缺。改 README 全量（含 zh/CHANGELOG/CONTRIBUTING）——被拒绝：保持既有只发 README.md 且去 zh 链接行的精简约定。
## Consequences

下次桌面构建将随壳发布 dsh-model-reasoning 0.2.1、dsh-kanban 0.2.1、dsh-turn-navigator 0.1.1；启用桌面端 kanban 后会在 dsh web 启动时向 ~/.agents/skills/kanban-use/SKILL.md 自动安装技能（skill-version 指纹保护用户编辑）。本改动只更新源树捆绑内容，不影响已安装桌面应用的 runtime 拷贝（那由控制台「检查预装插件更新」用户门控地从 npm 更新）；发布 dsh-desktop 新版本后才随新安装包生效。后续同步应继续以 npm latest tarball 为基准，并复查各插件 files 字段是否新增随包资产。

