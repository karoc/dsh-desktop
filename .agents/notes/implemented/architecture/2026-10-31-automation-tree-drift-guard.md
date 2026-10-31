# Agent Note: automation-tree-drift-guard

Status: implemented

## Problem

本机四个 systemd user timer 直接执行**工作树**里的 `$ROOT/scripts/*.mjs`：ROOT 停在哪个分支，线上就跑哪份代码。2026-10-24→30 实际发生 5 天漂移（ROOT 在 `feat/autopilot@db71e9d` 落后 main），表现为 doctor 每天 FAIL、失败运行仍推进 `last-ok`（反向心跳一直显示新鲜），而仓库 CI 全绿、看板标 done。「ROOT 留在 main」此前只写在文档与技能里，靠人记忆 —— 一次漂移同时污染探测、适配、心跳三条链，症状还是「已修的问题又出现」，极易误诊。

## Decision

新增 `scripts/lib/tree-guard.mjs`（纯逻辑、只读、不 exit），`checkTreeDrift({root, mainRef='origin/main', paths=['scripts','src-tauri/resources/manager','src-tauri/resources/preinstalled']})` 返回 `{drifted, unknown, head, main, branch, diffFiles, dirtyFiles, reasons, root, mainRef}`；`formatTreeDrift()` 生成中文告警（点名文件 + 修复命令 `git -C <root> switch main && git -C <root> merge --ff-only origin/main` + 停跑开关提示）。判据是**路径过滤后的差异**：`git diff --name-only HEAD <mainRef> -- <paths>` 非空，或 `git status --porcelain -- <paths>` 非空。**刻意不是 `HEAD == origin/main`**（发布合并后本地 ref 落后是常态，逐轮比会产生假警报；假警报等于没有守卫），也**不用分支名**（分支名不是代码状态的证据，游离 HEAD 没有分支名）；记录层（`KANBAN.json` / `.agents/notes/**`）不在 paths 里 ⇒ 日常看板/笔记改动不触发。三态：干净 / drifted / **unknown**（非 git 树、root 非顶层、HEAD 或 ref 解析不到、git 缺失或失败、paths 为空）——unknown 时 `drifted=false` 但必须由入口打印告警，**不猜成漂移、也不静默通过**。守卫剔除 `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_OBJECT_DIRECTORY` 劫持变量，git 命令带 `--no-optional-locks` 与 20s 超时。接入三个有仓库脚本的入口（`dsh-watch` / `dsh-release-autopilot` / `dsh-doctor`，位置在参数解析后、真正干活前；autopilot 在退避跳过/`--reset-state` 之后）：默认**告警一行（stderr）后照常干活、退出码不变**；`--strict-tree` 或 env `DSH_TREE_GUARD=strict` 才告警后 exit 1。`dsh-doctor --self-test` **不接**（自测要求零外部依赖，且门禁套件在无 `.git` 的副本里跑它）；`dsh-tagdispatch` 在仓库侧没有脚本，不受覆盖。判据可失败性由 `scripts/test-tree-guard.mjs`（62 条断言：临时 git 仓库上逐条正例 + 负向对照「换 paths / mainRef=HEAD ⇒ 必须变干净」+ porcelain 首空格/重命名/删除/非 ASCII 路径）与 gates 的 watch/doctor 组守护。
## Alternatives considered

**`HEAD == origin/main` 直接判红**：否决 —— 发布合并后本地 ref 落后是常态，每轮 tick 都会假警报，很快被当噪音忽略；**只看分支名是否 main**：否决 —— 分支名不是代码状态证据，游离 HEAD 无分支名；**只告警不给停跑开关**：否决 —— 事故里需要的是"有人必须来看"的止血手段；**每次运行前 `git fetch`**：否决 —— 给每轮心跳加网络依赖与超时风险（守卫必须 20s 内结束且零网络）；**把守卫写进 `run-with-proxy.sh`（unit 侧）**：否决 —— unit 不在仓库、agent 不改用户 systemd，且那样只覆盖 timer 不覆盖手工运行。
## Consequences

买到：漂移在下一次 tick（≤10 分钟）就会在日志里点名文件与修复命令，不再需要五天后靠"症状复现"倒推；HTTP 写路径、探测、适配、心跳共用同一实现，不会各自漂移。代价与边界：① 默认**不停跑**（只告警），要自动止血必须在用户 unit 里加 `--strict-tree`（unit 是用户维护的，仓库只能给建议）；② `unknown`（非 git 树 / 无 origin/main）按"无法判断"处理，不会阻止运行 —— 这是刻意的，但意味着在裸导出目录里跑守卫等于静默；③ 判据只看 `scripts/` 与 `src-tauri/resources/{manager,preinstalled}`，改 `src-tauri/src/**` 或 README 不算漂移（线上 timer 只执行前两类）；④ 守卫本身依赖 `git` 可执行与 `origin/main` ref 存在，仓库目录被整体搬走/改名后会落到 unknown。

