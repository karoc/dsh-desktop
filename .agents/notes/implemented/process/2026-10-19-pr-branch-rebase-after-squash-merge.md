# Agent Note: pr-branch-rebase-after-squash-merge

Status: implemented

## Problem

PR #186（分支 feat/automation-round2，提交 1309d7f）在 GitHub 上是 `mergeable=CONFLICTING`，而 conflicting 的 PR **完全不会跑 CI**：`gh run list --branch feat/automation-round2` 在该分支上只有一条 run，就是我推送后产生的 521296fc ⇒ 第二轮交付在此之前是零 CI 证据的。成因是 origin/main 用 squash 合并落地了第 185 号 PR（5f15ae3 = 分支自己祖先 8aa9ee6 + feb5130 的压缩版），分支基线停在 926fb6b，于是"分支带旧版同一处改动 + main 带新版"被判冲突。

## Decision

收敛口径固定为：**把分支 rebase 到 origin/main 并 force-push 回同一分支**（不留 merge commit、不重建 PR）。现状：HEAD=521296f 落在 5f15ae3 上，PR #186 `mergeable=MERGEABLE state=CLEAN`，`check`/`test` 均 SUCCESS，main 保持 5f15ae3 未动。决定性的前置判据是**树比对而非 patch-id**：`git diff feb5130 5f15ae3` 为空 ⇒ 分支父提交的树与 main 逐字节相同，两侧根本不存在需要人工合并的分歧；因此 `git rebase` 把 8aa9ee6 与 feb5130 以 "patch contents already upstream" 直接丢弃，只重放 1309d7f，全程零冲突。事后以两条硬证据自证：tree(HEAD)==tree(1309d7f)==`0ced95dd…`（第二轮内容逐字节保留），且 `git diff origin/main HEAD` 与 `git diff 5f15ae3 1309d7f` 的 sha256 同为 `042096e5…`（delta 未被放大或缩小）。**负向保证：四个文档文件没有做过任何手工合并**——因为 #185 的"文档同步"是以 feb5130 这个更早的提交存在于分支自身历史里的，所以"两边都保住"在树层面是自动成立的；手工去合并反而会制造重复段落与互相矛盾的计数。顺带纠正一处口径：任务书说 rebase 后应恰好 13 个文件，实测是 **12 个**（`docs/INDEX.md` 只被 main 侧改动、第二轮没碰它；`.gitignore`、`.github/**` 全程未出现在 delta 里）。
## Alternatives considered

**把 main merge 进分支**——被放弃：merge commit 既不能改变 GitHub 对 CONFLICTING 的判定（仍要解同一处冲突），又会在 PR 里留下一个与"rebase 后单提交"语义不符的合并节点，后续 round 的 `git log` 更难读。**关掉重开 PR / 另建分支 cherry-pick**——被放弃：丢 PR 号、review 上下文与既有 CI 历史，而任务明确要求同一分支。**按"两边各改一处"的假设逐段手工合并四个文档**——被放弃：树比对证明分歧不存在，手工合并是纯粹的风险来源（重复段落 / 计数矛盾），并且无法像树 hash 那样被验证。**只 rebase 不校验树**——被放弃：`rebase` 成功且无冲突并不等于内容无损，必须用 tree hash 与 delta digest 双重自证（本仓"没有判断 = 没有验证"纪律）。
## Consequences

买到的是：分支内容逐字节无损、CI 在 rebase 后的 head 上真跑并 check+test 双绿、PR 回到可合并状态，且整个过程有一条可复算的证据链（tree hash + delta digest + #185 文档行存活审计 MISSING=0）。代价与后续义务有三条：① 分支本地历史丢掉两个提交 subject（8aa9ee6 / feb5130），其内容以 5f15ae3 存活，但 `git log` 考古从此指向 squash 提交；② **凡以 squash 合并落地的轮次，下一轮分支在动工前必须先 rebase**，否则 GitHub 静默不跑 CI——"没有 check 上报"≠"check 通过"，这条要当作常规前置步骤而不是事后救火；③ `KANBAN.json` 与 `.agents/notes/archive.json` 是**被 git 跟踪的活跃看板文件**，rebase 时它们通常是脏的：本仓只允许用 `git -c rebase.autostash=true` 让它们随 rebase 暂存/弹回，且必须事先备份 + 记 sha256，事后用 JSON 解析证明卡集合无损（本次 0 张丢失、+1 张新增）——**不能拿 sha256 校验代替卡集合校验**，因为期间的看板写入会合法地改变哈希。已知覆盖缺口：本次 `dsh-adapt` 演练跑的是幂等路径（地板已是目标版本 ⇒ 第 2/3 步 skip、第 7 步"24 套通过 + 1 条非 node 本地跳过"），**没有演练真实的抬地板流程**，该缺口仍挂在看板"演练覆盖缺口（下一轮）"卡上。

相关：[release-pr-gate-and-asset-dispatch.md](./2026-09-22-release-pr-gate-and-asset-dispatch.md)（同样是 squash/`--admin` 合并路径，但机制不同：那边是 release-please bot PR 的 run 停在 `action_required` ⇒ 恒 BLOCKED，不是 CONFLICTING）。

