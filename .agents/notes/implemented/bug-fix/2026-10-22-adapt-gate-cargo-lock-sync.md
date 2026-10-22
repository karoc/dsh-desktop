# Agent Note: adapt-gate-cargo-lock-sync

Status: implemented

## Problem

干净 origin/main 上 package.json / tauri.conf.json / Cargo.toml 都是 0.20.0，而派生的 Cargo.lock 停在 0.19.0（release-please 不改派生文件）。CI 的 test 作业在 `npm test` 之前先跑 `node scripts/sync-cargo-lock-version.mjs` 掩盖了漂移，但 `dsh-adapt.mjs` 第 7 步（全量门禁）与 `dsh-rehearse.mjs --scenario bump` 的克隆内 adapt 都不跑 sync ⇒ 每一次真实适配都在最后一步假红，并被读成"适配失败"。

## Decision

`scripts/dsh-adapt.mjs` 第 7 步现在先以 `spawnSync(process.execPath, [join(ROOT,'scripts/sync-cargo-lock-version.mjs')], { cwd: ROOT })` 复用既有同步脚本，再按 `package.json` 的 test 链逐条跑——与 CI `test` 作业的顺序完全一致。sync exit≠0 直接 `abort('7 全量门禁', …)`，绝不以"sync 成功"代替门禁结论；只允许它修"派生物落后/超前于真源"这一种漂移：sync 只写 `src-tauri/Cargo.lock`、只对齐 `Cargo.toml`，`package.json` / `tauri.conf.json` / `Cargo.toml` 彼此不一致时它不修，`test-manifest-consistency` 仍按四处版本一致判红（负向对照：把 Cargo.toml 改成 9.9.9 ⇒ sync PASS、manifest 红、adapt exit 1）。

真实运行里 sync 若打印 `FIXED`，脚本提示把 `Cargo.lock` 一起提交并保留文件；`--dry-run` 为守住"不落盘"契约，先快照字节，临时 sync 让门禁跑在与 CI 相同的状态，跑完（成功、门禁失败、strict-chain 失败）都把原内容写回，并在 step 明细里说明"临时同步、已还原"。`scripts/dsh-rehearse.mjs` bump 场景第 4 步直接调克隆里的 `dsh-adapt`，因此自动继承该行为；rehearse **不**再实现一份 sync（避免两处语义漂移），只把 `前置 sync Cargo.lock` 的输出收进 JSON 的 `adaptResult.syncLine` 作为继承证据。

已知边界：sync 真改了文件时，跑链期间工作树是脏的 ⇒ `test-controls` 的三个可信度对照按既有规则 SKIP（CI 在 sync 之后同理），脚本出口与 README/方案文档显式说明，不把跳过说成通过。`test-automation-gates.mjs` 本次不在写域，未新增针对该行为的回归断言；干净 main 的 `Cargo.lock` 仍是 0.19.0（该文件也不在写域），需要者单独跑 sync 连同提交。相关：`2026-10-15-cargo-lock-version-sync-eol.md`（同步脚本的 CRLF 行为）、`../process/2026-10-19-automation-gate-self-verification-suite.md`（自证套件）。
## Alternatives considered

**去掉 CI 里的 sync 让门禁重新抓漂移**：被否决——release 合并后每个基于 main 的 PR 会恒红（2026-10-16 已实测过的死循环），红着会淹没真回归。

**让 release-please 顺带改 Cargo.lock**：被否决——它不处理派生文件，且等于给 bot 扩写域，行为不受我们控制。

**只靠技能/文档提醒"先手动 sync"**：被否决——"记得"不是机制，这正是本次缺陷的来源。

**在 dsh-rehearse 里再写一份 sync**：被否决——两处逻辑迟早漂移，演练就不再等价于真实运行；直接调 adapt 才是同一份语义。

**dry-run 也永久改写 Cargo.lock**：被否决——破坏 README 承诺的"运行前后 git status 一致"；采用临时同步 + 跑完还原。

**在 adapt 里自己解析并改写 Cargo.lock**：被否决——按要求复用 sync 脚本，不重写同步逻辑（CRLF/包段定位等细节已有单一真源）。
## Consequences

买到：干净 main 上的真实适配不再在第 7 步假红；门禁前的准备顺序与 CI 完全同构；两个负向对照（锁漂移被修 / manifest 真不一致仍红）证明它没有掩盖真问题；dry-run 保持净写入为零。代价：dry-run 的门禁是在"临时同步过"的树上跑的（失败时也会还原，因此结果对应的不是磁盘最终态）；`test-controls` 在 sync 改动文件的那些运行里会 SKIP 三个对照（既有覆盖缺口，现在被显式打印）；进程若在 sync 与还原之间被杀，Cargo.lock 会保持已修复状态——那仍是一份正确的派生物，但 dry-run 的"零写入"承诺在这种中断下不成立。后续义务：合并后干净 main 的 Cargo.lock 仍是 0.19.0，需要单独跑一次 sync 并提交；把本次 A/B 两个对照并入 `test-automation-gates` 需要修改写域外的测试文件。

