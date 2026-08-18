# Agent Note: preinstalled-plugin-sync

Status: implemented

## Problem

预装插件（dsh-model-reasoning / dsh-kanban）的 bundles 随壳锁定在 plugins/preinstalled/，需要定期与作者仓库的最新构建同步；本轮检查发现 dsh-model-reasoning 停在 0.1.1，落后仓库 HEAD（0.1.4，含 empty states / apply-to-all / 模式 tooltip / 模型搜索）。

## Decision

同步基准 = 源仓库 HEAD 构建（tsdown bundle 产物 + 裁剪的 package.json + README/LICENSE），而不是只看 npm 已发布版本：dsh-kanban 的 bundle 本来就携带 npm 0.1.0 尚未发布的特性（systemPrompt 快照注入、删除确认），npm latest 并非其"最新"。做法：把两个仓库拷进 workspace 构建（源仓库目录在沙箱外只读），lib/* 与 cordis.patch.yml 逐字节对比；dsh-kanban 确认已与仓库 HEAD 一致（无改动），dsh-model-reasoning 升级 0.1.1→0.1.4 并同步 README（裁掉 README.zh.md 语言链接，与 kanban bundle 的裁剪约定一致）；npm run sync:resources 刷 resources 副本。同时把 test-control-plane.mjs 里硬编码的 '0.1.1'/'0.1.0' 断言改为从 resources 实际 bundle 读取版本，今后版本升级不再需要改测试。
## Alternatives considered

按 npm 最新发布版同步（model-reasoning 0.1.4 但缺未发布的搜索筛选、kanban 0.1.0 会丢掉未发布特性）——被拒绝：bundle 语义是随壳锁定作者最新开发态，降级会丢失已有能力。
## Consequences

桌面壳将随下个发布携带 dsh-model-reasoning 0.1.4（含模型搜索筛选）；dsh-kanban 保持 0.1.0 开发态。控制面测试不再因版本号漂移而失效。

