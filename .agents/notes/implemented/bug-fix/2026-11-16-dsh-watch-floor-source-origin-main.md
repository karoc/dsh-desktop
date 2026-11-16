# Agent Note: dsh-watch-floor-source-origin-main

Status: implemented

## Problem

`scripts/dsh-watch.mjs` 的壳地板（`MIN_DSH_VERSION`）默认从**工作树**的 `scripts/server-manager.mjs` 读，但"上游版本是否已适配"这件事的真源是发布状态 `origin/main`，不是某台机器上正在开发的那棵树。2026-11-16 实测：`origin/main` 地板已随 v0.24.2 抬到 `0.2.2-rc.1`，而用户工作树漂在 `feat/tray-session-aggregate`（地板 `0.2.1-rc.5`）⇒ `dsh-watch` 每轮把**已经关闭**的 #259 当成"未适配"静默 edit；`dsh-release-autopilot` 调 `dsh-watch --dry-run` 取 `floor`，也跟着把已适配的版本重新当欠账重跑。误报不是红色告警，而是**持续的写噪音 + 读数骗人**：日志里的地板比真实发布地板旧一档，而没有任何字段说明"这份读数是从哪儿读的"。

## Decision

地板默认真源改为 **`origin/main` 的 `scripts/server-manager.mjs`**，优先级 `--floor`（演练覆盖） > `origin/main` > 工作树（回退）。取值路径：先做一次**有界** `git fetch --no-tags origin main`（`spawnSync` 20s 超时、`GIT_TERMINAL_PROMPT=0`、剔除 `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_OBJECT_DIRECTORY`），再 `git show origin/main:scripts/server-manager.mjs` 用原正则解析；fetch 超时/失败**只跳过 fetch**（仍读本地已有的 `origin/main` ref，并在 stderr 留一行"可能不是最新"），`git show` 失败或解析不到才回退工作树。任何回退都在 stderr 打**一行**告警（真源 + 原因 + 读数 + 修复命令），且 `--json` 报告新增 `floorSource: "arg" | "origin/main" | "worktree"`；人读输出改为 `壳地板 <v>（真源 origin/main）`（回退时 `（真源 worktree·回退：取不到 origin/main）`）。`--floor` 命中时**完全不跑 git**（演练可离线复刻）。git 的唯一注入点是 `GIT_BIN`（沿用 autopilot / `test-autopilot-release-resume` 的既有约定），门禁用桩接管 `fetch` / `show`，其余命令转交真 git —— GIT_SLUG 与 tree-guard 行为不变。

负向保证：不回退时**不读工作树**；回退**不静默**（必须有一行 stderr + `floorSource=worktree`）；`--dry-run` 的"不写 issue / 不写退避状态"契约不变（fetch 只更新远端跟踪 ref，不碰工作树与 index）；flock 单写者、`~/.dsh/PAUSE`、tree-guard、`--strict-tree` 语义全部不动；脚本不自动切分支、不自动 `pull`（那会改写用户的 WIP 工作树）。可失败性：`scripts/test-automation-gates.mjs` 的 watch 组新增 (a) 工作树与 origin/main 地板不同 ⇒ 取 origin/main、(b) git 取不到 ⇒ 回退且告警文案命中、(c) `--floor` 覆盖且不 fetch、(d) `floorSource` 三种取值、(e) fetch 失败但仍用本地 origin/main —— 全部用 `GIT_BIN` 桩构造，不联网、不碰真仓库。本地负向对照实测：强制走回退分支 ⇒ 4 条断言变红；删掉回退告警 ⇒ (b) 变红。

## Alternatives considered

**继续读工作树，只靠 tree-guard 告警**：否决 —— tree-guard 的语义是"线上跑的代码是不是 main 的代码"，它告警后仍照常干活；读数本身错了，每轮仍会去 edit 已关闭的单。告警不能替代正确读数。**读 `HEAD` 而不是 `origin/main`**：否决 —— 工作树 HEAD 就是会漂的那一份，等于换个名字的同一个缺陷。**fetch 失败就判红/停跑**：否决 —— 心跳每 10 分钟一轮，网络抖动会让整个探测进入退避；地板读数是 SLA 的输入，不是 SLA 判据，拿不到时应该降级到"已知但可能旧"的读数并明说，而不是停摆。**不 fetch，直接读本地 `origin/main` ref**：否决 —— 本地 ref 落后与工作树漂移是同一类假象（只是更少见），而且 CI 浅克隆里 ref 可能不存在；**无界 fetch** 又会把心跳卡死。折中是 20s 上限 + 跳过不阻塞 + 显式告警。**抽成 `scripts/lib/floor-source.mjs`**：否决（暂）—— 目前只有 `dsh-watch` 一个消费者，抽模块要新增文件/门禁面；等第二个消费者（例如 `dsh-sla-report` 的"当前状态"也改读发布地板）出现时再抽。

## Consequences

买到：地板读数回到发布状态的真源，已关闭的跟踪单不再被误 edit；autopilot 的 `STATE.floor` 自动跟着修正（未改 autopilot 一行代码）；报告里"地板是多少"与"读的是谁"同时可见，回退不再是静默行为。代价与边界：① 每轮多一次有界网络 fetch —— 离线/无凭据时最多等 20s 再降级，并留一行告警；② CI 的 `actions/checkout` 若拿不到 `origin/main` ref（浅克隆 + 非 main 事件）会走回退 —— 那时 checkout 出来的就是 main，读数仍正确，但会多一行告警；③ `dsh-sla-report` 的「当前状态」块仍按 HEAD 读地板（它回答"这棵树的地板"），与 watch 的发布地板可能不同，口径差已写进 `.dsh/skills/dsh-upstream-adaptation/SKILL.md` §6.18；④ 测试面：gates watch 组 43 → 48 条断言，且 `test-backoff-state.mjs` 的两处 `dsh-watch` 调用显式 `GIT_BIN=/bin/false` 隔离网络（否则每次跑套件都会真 fetch）；⑤ 没有改 autopilot 的探测字段解析 —— `floorSource` 目前只有 `dsh-watch` 报告与人工输出消费，autopilot 仍只读 `floor`。
