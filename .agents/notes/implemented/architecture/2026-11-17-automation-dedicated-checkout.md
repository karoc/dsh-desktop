# Agent Note: automation-dedicated-checkout

Status: implemented

## Problem

心跳 timer 的 `ExecStart` 直接指向开发者工作树（`/home/karoc/dsh-desktop/scripts/*.mjs`）。这棵树是
所有开发活动的现场：reflog 显示 30 天内 **516** 次 checkout/switch，且它在
`feat/tray-session-aggregate` 上从 2026-11-01 连续停到 11-16（**15.5 天**）。timer 不看分支，只看文件 ⇒
线上心跳长期跑旧代码：2026-10-24→10-30 的旧 `dsh-doctor`（每天评论 404、失败轮次仍推进 last-ok），
以及 2026-11-01→11-16 的旧 `dsh-watch`/`dsh-adapt`（地板真源修复、门禁修复都没上线）。
tree-guard 只能每轮告警一行，治不了根 —— 它判断的是「这棵树是不是 main」，而问题是「线上不该依赖这棵树」。

## Decision

心跳改跑**专用 checkout** `~/dsh-automation`（独立 clone，常驻 `origin/main`），入口统一为仓库内的
`scripts/automation-runner.sh`：先 `git fetch --no-tags origin main`（**300s 节流**，多个 10 分钟心跳共享
一次）→ `git reset --hard origin/main` → `exec` `run-with-proxy.sh` 目标命令。四个 unit 的
`WorkingDirectory`/`ExecStart`/`GH_BIN` 都指向该 checkout；开发工作树与心跳从此解耦。

**失败语义是刻意的**：fetch/reset 失败**不判失败**，只打一行 `[automation] …可能是旧代码` 并沿用当前
checkout。自动化的第一职责是继续跑；「可能跑的是旧代码」必须可见而不是静默，所以 runner 告警 +
脚本自身 tree-guard 双保险。checkout 不存在 ⇒ exit 3（拒绝在未知目录跑）。

**负向保证**：runner 从不对开发工作树做 `fetch/reset/checkout`；它只操作 `$DSH_AUTOMATION_DIR`
（默认 `~/dsh-automation`）。tree-guard 保留 —— 它对「CI/其他机器上指向工作树的 unit」仍然是正确判据。

## Alternatives considered

**git worktree（`git worktree add ~/dsh-automation origin/main`）**：否决 —— 它共享主仓库的 refs 与
对象库，主仓库的 rebase/force-push/损坏会波及自动化 checkout；独立 clone 的故障域更干净（代价是 ~64MB）。

**每次心跳都 `git pull` 而不 reset**：否决 —— pull 会产生 merge commit / 冲突，且工作树被自动化写得脏；
reset --hard 是「只读生产代码 + 丢弃本地改动」的正确语义（这是专用 checkout，没有人的改动可丢）。

**在 unit 里直接写 `git fetch && reset && node ...` 一行**：否决 —— 无法复用给四个 service，也无法做
节流与失败降级；独立 runner 让语义只有一处、可被文档与技能引用。

**每次心跳都真 fetch（不节流）**：否决 —— 三个 10 分钟心跳 + doctor 会让 GitHub 每分钟收到 0.3 次 fetch；
300s 节流后最多 12 次/小时，且窗口内仍用本地 reset 保证与已知 origin/main 一致。

**让 tree-guard 直接停跑（`--strict-tree`）代替搬迁**：否决 —— 停跑 = 心跳消失，SLA 从「慢」变成「没有」；
而且它仍没回答「线上该跑哪份代码」。

## Consequences

买到的：开发者在工作树里怎么切分支都不再影响线上心跳；「修完了却不生效」这一类事故（技能 §6.14 两次
实录）从结构上消失；unit 的 `ExecStart` 变成自解释的（路径就叫 automation）。

代价与边界：① 多一份 clone（~64MB）与一个新的一步式准备动作（新机器要 clone 一次，否则 unit exit 3）；
② runner 本身来自被 reset 的那份 checkout ⇒ 改 runner 的改动在**下一轮**才生效（自举延迟一轮）；
③ 节流窗口内如果 origin/main 前进，最多晚 300s 才看到（对 10 分钟心跳可接受）；
④ `~/dsh-automation` 里如果有本地改动会被 reset 静默丢弃 —— 这是刻意的，任何需要保留的东西都不该放在那里；
⑤ 本机四个 unit 在用户主目录、不在仓库，仓库只提供 runner 与文档 ⇒ 新机器仍需按
`docs/2026-10-17-dsh-upgrade-automation-plan.md` 的 systemd 小节手动接一次。

相关：技能 `.dsh/skills/dsh-upstream-adaptation/SKILL.md` §4「心跳入口」、§6.14（历史判据保留）；
`2026-11-16-timer-driven-oneshot-restart-policy.md`（同一批 unit 治理的另一半）。
