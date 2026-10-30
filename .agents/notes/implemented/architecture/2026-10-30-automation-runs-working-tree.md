# Agent Note: automation-runs-working-tree

Status: implemented

## Problem

自动化心跳（systemd user timer）在过去 5 天里每天报告 doctor FAIL（评论探测 404、且失败运行仍推进 last-ok），而仓库侧对应的两处修复（#229 / #231）在 2026-10-24 就已合并、CI 全绿、看板标 done。需要解释「代码已修但线上没修」并给出可复用的判据。

## Decision

机器上的 `dsh-watch` / `dsh-tagdispatch` / `dsh-autopilot` / `dsh-doctor` 四个 systemd user timer 的 `ExecStart` 都是 `run-with-proxy.sh node /home/karoc/dsh-desktop/scripts/<tool>.mjs` —— **执行的是仓库工作树的当前内容，不是 origin/main，也不是任何已发布的 shell 版本**。因此工作树停在哪个分支/哪个提交，线上心跳就跑哪份代码；2026-10-24 到 10-30 期间 ROOT 停在 `feat/autopilot@db71e9d`（比 main 落后 5 个提交），而 `dsh-doctor.mjs` 在 main 上有 #229（评论探测改用 REST 数字 id）与 #231（last-ok 只在全部能力通过后写）两处 248 行改动 ⇒ 线上实际跑的是**旧 doctor**：每天 `✗ 评论 gh: Not Found (HTTP 404)`、失败运行仍把 `last-ok` 推进到当下（违反文件头写明的负向保证），而 repo 侧「已修」的证据在 CI 上是绿的。2026-10-30 把 ROOT 切回 `main@de4bafc` 后，同一条命令 7/7 全 ✓（含评论 PATCH、加 label、关闭/重开、last-ok）。当前纪律：**动这些脚本前先确认 ROOT 在 main 且无未提交的脚本改动**；unit 文件本身仍由用户维护，agent 不改/不重启 systemd。这不是「脚本 bug」，是部署模型（工作树即部署物）的固有风险。
## Alternatives considered

**让各 timer 直接从 origin/main 的临时克隆跑**：每次运行 clone 一次（或 `git -C ... archive`）能保证代码是最新的，但把「脚本来源」和「工作树」解耦后，排障时看到的 `/home/karoc/dsh-desktop/scripts/*.mjs` 就不再是实际运行的代码，反而更难核对；而且每个 timer 每 10 分钟 clone 一次是纯浪费。**要求人记得「先切 main 再改脚本」**：正是这次失效的模式——5 天没人发现。**把 unit 的 WorkingDirectory 改成一个专用 checkout**：需要用户改 unit（agent 不动 systemd），且仍然有「那个 checkout 也会漂」的同款问题，只是把风险挪走。选择：先把工作树切回 main 让线上代码立刻正确，并把「unit 执行工作树脚本」写进技能与 Note；结构性守卫另开卡（运行前比对 HEAD 脚本与 origin/main，漂移则大声告警或 fail-closed）。
## Consequences

买到：一次定位解释了「已合并的修复为何没生效」这类最费时的错觉（不是没修，是没跑），并把 5 天里每天的 doctor FAIL + 违反「失败不推进 last-ok」保证全部归因到同一根因。代价与遗留：① 目前只靠「把工作树留在 main」这条纪律，没有硬门禁——下次谁再在 ROOT 上切分支开发，线上就会静默跑旧代码；② `dsh-rehearse` / `dsh-release-autopilot` 也是从 ROOT 跑的，因此工作树漂移会同时影响探测、适配与心跳三条链，影响面比单个脚本大；③ 结构性守卫（运行前校验 HEAD 与 origin/main 对 `scripts/` 的差异，漂移即告警/停跑）尚未实现，已登记看板。

