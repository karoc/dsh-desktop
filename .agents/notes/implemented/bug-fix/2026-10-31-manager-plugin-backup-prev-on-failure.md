# Agent Note: manager-plugin-backup-prev-on-failure

Status: implemented

## Problem

`scripts/server-manager.mjs` 的 `installDshUpdate` 在恢复循环末尾把 `backupDir` 和 `prevBackupDir` 并排删除，**不区分安装成败**。若上一次安装在"恢复插件"前被打断，`.plugin-backup.prev` 可能是用户插件的唯一拷贝；本次安装又跑完但失败（两个 registry 都失败）时，恢复循环只把 `backupDir` 的内容放回 node_modules，随后 `.prev` 被删 ⇒ 唯一拷贝永久丢失。注释写的是"安装成功 ⇒ 上一周期的保留副本可清"，代码却无条件执行。该缺陷由端到端套件 `scripts/test-plugin-backup-preserve.mjs` 的场景 B 复现（先看到 `.prev`、再等到 `install-status=error`，两条断言红）。

## Decision

`installDshUpdate` 里改为**仅 `lastErr === null`（安装成功）时** `rmSync(prevBackupDir)`；失败时保留并 `log('安装失败 ⇒ 保留 .plugin-backup.prev 供下次启动恢复（不删除唯一可能的插件拷贝）')`。两份 manager（`scripts/` 与 `src-tauri/resources/manager/`）同步改，`test-copy-consistency` 保持绿。保留的 `.prev` 由 `main()` 既有的 `recoverFrom` 兜底恢复（该分支早就是「主备份不存在而 `.prev` 存在」时用 `.prev`，正好接上）；失败安装的当前备份仍由恢复循环 + `finally` 安全网放回 node_modules，行为不变。套件 `test-plugin-backup-preserve.mjs` 扩展为两个场景（A 打断 / B 跑完但失败），并新增负向对照：临时副本把条件删改回无条件 `rmSync` ⇒ 场景 B 两条断言变红、exit 1。
## Alternatives considered

**永不删除 `.prev`**：否决 —— 无界堆积备份目录、占用户磁盘；**失败时把 `.prev` 也恢复进 node_modules**：否决 —— 会把用户更新过的插件版本回退（2026-10-07 审计明确否决过的反向风险）；**失败时把 `.prev` 改名为带时间戳的残留**：否决 —— 仍然堆积，且启动恢复路径不会消费它，不如保留原文件名让 `recoverFrom` 接住；**只登记不修**：否决 —— 套件已能稳定复现、且是用户数据面。
## Consequences

买到：失败安装不再删掉"可能是唯一拷贝"的 `.prev`，下一次启动会用既有恢复分支把它放回 node_modules；套件场景 B 与负向对照把这条行为钉死。代价与边界：① 失败后磁盘上会多留一个 `.plugin-backup.prev`，直到下次启动恢复它（有界，每轮至多一份）；② 若失败之后紧接着一次**成功**安装，成功路径仍会删除 `.prev`（与"安装成功才清"的意图一致，但此时上一轮失败的 `.prev` 可能仍含唯一拷贝 —— 这是已知的剩余边界，未在本轮扩展到"成功后也保留"）；③ `.prev` 的结构假设仍是"目录里是 node_modules 顶层条目"，与恢复逻辑一致。

