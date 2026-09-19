# Agent Note: workspace-cleanup-discipline

Status: implemented

## Problem

会话收尾时我用一条带兜底的命令同步本地 main：`git checkout -b main origin/main 2>/dev/null || { git checkout main && git reset --hard origin/main; }`。因本地 `main` 已存在，`||` 后半段真的执行，**静默丢弃了工作区里不属于本轮的未提交改动**——其中 `scripts/dsh-hang-guard.ps1` 的 `-WaitForAppSec` 修复（2026-09-14 会话的成果，当时只做了宿主机热部署、**仓库侧从未提交**）就此消失，且 git 层无任何找回途径。这类事故的可怕之处在于"静默"：命令输出里没有任何一行提示"你刚刚删除了 4 个文件的改动"，我是事后比对才发现工作区少了两处 ` M`。更根本的成因在上游：那份修复只部署不提交，使仓库长期处于落后于宿主机的状态（其 Note 自己都写了"需要一次正式发版把 scripts/ 的改动带进安装包"）。

## Decision

确立工作区纪律：**清理/切分支前先完整读 `git status`，并把每一项分类**——(a) 本会话自己产生的改动、(b) 更早会话遗留的改动、(c) 派生物（转录、dump、临时目录）。**破坏性操作只允许作用于 (a) 与 (c)**；对 (b) 一律不动，改用提交（有价值）或明确询问用户（无价值）。**禁止把破坏性命令放进 `||` 兜底链**：本会话肇事的正是 `git checkout -b main origin/main 2>/dev/null || { git checkout main && git reset --hard origin/main; }` —— 兜底分支在"本地分支已存在"这种平常情况下静默执行，一次丢弃了 4 个文件的改动。同步远端只用 `git merge --ff-only origin/main`（拒绝快进即报错，不做任何破坏）。**清理动作与诊断动作分开执行**：先单独跑 `git status`/`git stash list`/`git reflog` 看清状态，再决定动不动手，且命令里不吞 stderr。**热部署必须与提交配对**：任何"只部署到宿主机、仓库未提交"的状态都等于把仓库变成落后的一侧，必须当场提交（本次的 guard 修复就是既未提交、又无第二份拷贝，才需要从宿主机反向恢复）。**恢复路径优先级**：先找带外副本（宿主机部署副本、安装目录、已发布产物）→ 再试 git 层面（`reflog` / `fsck --lost-found`，仅对"曾提交过或曾 `git add` 过"的内容有效）→ 都没有则按 Note 重新实现；恢复后必须逐行 diff 验证方向（只能"部署副本 ⊇ 仓库版"，绝不能把旧逻辑倒灌回仓库）。
## Alternatives considered

**"用 `git stash` 当安全网"**——否。stash 只在你记得 `stash pop` 时才安全，且本会话实测更糟：探针调试时 `git stash` 过后，stash 提交（`d426cda`）变成悬空对象、`git stash list` 已空，靠 reflog/dangling commit 才看出它存在过。**"靠 reflog / `git fsck` 恢复"**——否，且已实测证伪：reflog 只记录 **HEAD 的移动**（提交、切分支、reset），**不含工作区文件内容**；`fsck --lost-found` 的悬空 blob 只在内容曾被 `git add` 过时才存在。本次两条路都试过：reflog 只看到 `reset: moving to origin/main` 一行，遍历 40 个悬空 blob 无一含 `WaitForAppSec`。**"干脆禁止 `reset --hard` / `stash`"**——否，过于绝对：工作区**已被核实干净**时、或明确丢弃自己的临时试验时，`reset --hard` 是正当工具；要禁的不是命令，是"未经核对就进破坏性分支"。**"继续沿用 `checkout -b X origin/main || { checkout X && reset --hard origin/main; }` 这条兜底"**——否，这正是本次的肇事写法：兜底链让"本地分支已存在"这种平常情况演变成静默的破坏性操作，而且 `2>/dev/null` 还会把失败原因吞掉。正确写法是分步执行、每步看清结果，同步远端只用 `git merge --ff-only origin/main`。**"只热部署不提交"（上游成因）**——否：任何"已部署到宿主机但仓库未提交"的状态，都意味着仓库是**落后的一侧**，下一次重装/升级就会把它回退掉；热部署必须与提交同时完成。
## Consequences

代价与收获：① 本次损失**差点不可逆**——恢复完全依赖"宿主机部署副本恰好还在"这一巧合（`%LOCALAPPDATA%\dsh-hang-guard\dsh-hang-guard.ps1`）；若该机此前重装过、或按 0.9.1 的安装流程覆盖过，这份修复就永久消失。② 恢复本身代价很小（一条 `Copy-Item` + 一次 diff 验证），但**验证不能省**：必须确认部署副本相对仓库版只有新增、没有删除（本次 +33/−0），否则会把宿主机上的旧逻辑倒灌回仓库、回退掉仓库里更新的修复（本例仓库版最后一次改动是 `9557bce`，恰好在部署之后，所以超集关系需要逐行确认而不是想当然）。③ 副产品：`.forensics/` 的处置边界由此确定——**工具入库（`scripts/decode-session.mjs`）、含会话正文的转录不入库**。④ 仍未做：宿主机的 guard 仍是 09-15 的热替换版本；0.9.1 起 `scripts/dsh-hang-guard.ps1` 已随包分发，但宿主机需要用 `scripts/install-hang-guard.ps1` 重装一次才能拿到带 `-WaitForAppSec` 的版本（属"宿主机事故取证"跟进卡的范围）。

