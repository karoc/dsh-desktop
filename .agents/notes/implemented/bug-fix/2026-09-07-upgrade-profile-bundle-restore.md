# Agent Note: upgrade-profile-bundle-restore

Status: implemented

## Problem

2026-09-07 dev 版实测：用户升级 dsh（0.1.1-rc.2 → 0.1.2-rc.1）后，预装插件（dsh-kanban / dsh-model-reasoning / dsh-turn-navigator）全部消失。根因是 profiles/web/package.json（dsh.profile.bundles = 插件启用开关）在升级期间缺失，dsh web 启动时 dsh-app-boot 的 initProfile 只在 manifest 不存在时用模板重建（bundles 只剩 @deepseek-ai/dsh-base + dsh-web-app），用户启用过的插件名单全部丢失。升级流程此前完全不校验/备份该 manifest，属产品级缺陷：升级不该静默丢失升级前状态。

## Decision

server-manager.mjs 的更新流程（installDshUpdate，位于 scripts/ 真源，构建时 sync-resources 覆盖到 resources/manager）现在包含升级前后校验：1) installDshUpdate 入口调用 snapshotWebProfileBundles(runtimeDir) 读取 dsh-home/profiles/web/package.json 的 dsh.profile.bundles 快照（manifest 缺失/损坏返回 null 表示快照不可用）；2) 升级成功（pnpm install 完成、protected 插件恢复后、emitUpdateStatus(false) 前）调用 restoreProfileBundlesAfterUpdate(runtimeDir, before)，差量补回——快照里有、升级后缺失的条目追加写回，保留 manifest 其它字段（dependencies/patchReload/name），manifest 整体缺失/损坏时从快照重建完整 doc；不触碰模板自带 bundle 与升级后新增条目。恢复挂载在 installDshUpdate 成功末尾，因此自动安装（dsh missing）、isolated→hoisted 布局迁移、用户点更新三条路径全部覆盖。快照与恢复均不修改 dsh 本体，纯壳层保障。
## Alternatives considered

**整体覆盖恢复（备份整个 manifest，升级后直接还原）**：被拒绝——会覆盖升级意图（例如新版模板引入新默认 bundle 或调整 patchReload），把升级后 manifest 打回旧版。差量补回只加回"快照有/升级后无"的条目，保留升级带来的变化。**仅在 Rust 侧（lib.rs）做校验**：被拒绝——升级由 manager（Node 侧 updateDshAndRestart）驱动，Rust 壳无法感知 pnpm install 完成时机；且预装插件机制本身由 manager ensurePreinstalled 维护，放 manager 内与现有生命周期一致。**不做任何处理、依赖用户手动重新启用**：被拒绝——用户明确要求"升级后要做好校验，不能升级了就丢失未升级前的状态"。
## Consequences

代价：manager 每次 dsh 更新多一次 manifest 读+写（毫秒级，仅更新时发生，不影响日常启动）；恢复逻辑在 updateDsh 流程内多 30 行代码。收益：升级后用户已启用的插件（含自定义插件）不再静默丢失；快照日志（"profile bundles snapshot: ..."）与恢复日志（"profile bundles restored after update: ..."）为升级行为留下可审计痕迹。边界：快照本身不可用（升级前 manifest 已缺失/损坏）时恢复被跳过——该场景下升级前的启用状态信息已不可恢复，属已知覆盖缺口；纯模板 bundles（从未启用插件）升级后无缺失条目，不写文件。验证：单元 5 场景（manifest 被删/模板重建/部分丢失/全新安装/无变化）+ 真实路径端到端（升级前含 3 插件 → 模板重建 → 精确补回 3 插件）PASS，dev 版构建安装后插件加载确认（manager.log [dsh-kanban] skill 同步日志）。相关：dev 版插件丢失的现场恢复见 .agents/notes 无——首次记录；黑屏根因 e3c9336 与闪窗 2617804 为同批 shell 修复。

