# Agent Note: workflow-dry-run-audit-harness

Status: implemented

## Problem

dsh 升级自动化链路（dsh-watch / tag-dispatch / dsh-sla-report / preinstalled-sync）合并后只有静态审读。这四条 cron 一旦在真实 runner 上静默失败或假绿，整条自动化等于不存在，而"读代码"无法区分"这条路径跑过"与"这条路径从未执行"——例如 tag-dispatch 的三次真实运行里所有 Release 的 assets 都恰好 =3，补派发分支从未进入；preinstalled-sync 唯一一次运行里四个包版本恰好全部一致，"同步并开 PR"步骤被 skip。缺的是一套可复现的干跑方法，以及一份"哪些路径没有真实运行证据"的清单。

## Decision

审计方法固定为三步，全部只读。① 真实 runner 证据优先：`./scripts/gh run list --workflow=<f>.yml --json headSha,event,conclusion` 对齐 HEAD，再用 `./scripts/gh api repos/<o>/<r>/actions/jobs/<job_id>/logs` 取原始 job 日志（`gh run view --log` 在本机返回空，只有 jobs/logs 端点可用）；日志里的 `GITHUB_TOKEN Permissions` 块是权限声明的权威事实来源，比 YAML 更可信。② 用 PyYAML 把每个 `run:` 抽到 /tmp 后**按 GitHub 的纯文本替换语义**渲染 `${{ }}`（`render.py`），在 `GH_BIN` 指向的 gh 桩下执行；桩的规则是**写操作一律拦截记录、读操作透传真实 `./scripts/gh`**（桩内必须用 `/usr/bin/gh` 绝对路径，否则 `scripts/gh` 里的 `exec gh` 会递归回桩自身而挂死）。③ 用本地 bare 仓库 + `git clone --depth 1 --single-branch file://` 复刻 actions/checkout 的浅检出条件来测 push 语义。实测结论（4 条缺陷已落看板）：`--force-with-lease` 在"远端分支已存在但检出无该分支的远端跟踪引用"时必被拒（stale info），所以 preinstalled-sync 的第二次运行必然红、既有 PR 永不更新；tag-dispatch 的 `runs?per_page=100` + 客户端过滤只看 799 次运行里最新 100 次（该页只有 7 条 tag 分支），正确写法是服务端 `?branch=<tag>`；漂移检测把 `npm view` 失败折叠成 `?` 从而与非空版本号必然不等，制造假漂移并让一次坏查询阻塞整批同步；dsh-watch 的 `${{ inputs.force_target }}` 直接插进 bash，`$(...)` 会被执行而 step 仍绿。

真实运行证据的边界必须显式记录：当前四个文件版本都被 GitHub 解析并跑过（`git diff --stat <run_sha> HEAD -- <file>` 为空），但 dsh-watch 的 **workflow_dispatch 输入渲染路径从未在真实 runner 上执行过**——唯一一次 dispatch（run 39106566078）用的是脚本提取之前的旧版本，唯一一次跑当前版本的运行是 schedule，日志里渲染出的是 `[ -n "" ] && args+=(--force-target "")`。sla-report 与 preinstalled-sync 的周一 cron 同样尚无真实触发记录（只有 workflow_dispatch）。
## Alternatives considered

**只读代码 + YAML lint 下结论**：被否决——正是这种方法让"补派发分支从未跑过""同步步被 skip"两个覆盖缺口在合并评审里看不见，而它们恰恰是本次审计出缺陷最多的两处。**在真实仓库上触发一次 workflow_dispatch 来验证输入渲染**：被否决——触发 workflow 是写操作，且需要构造注入载荷，等于对生产仓库做攻击性测试；改用本地 render.py 复刻替换语义，代价是"GitHub 侧非空输入的渲染"只能标为未验证。**用 mock 掉 gh 的全部调用来跑干跑**：被否决——那样连"该 tag 到底有没有构建运行"这种事实都要自己编，分页缺陷就无法被证明；改成读透传真实 API，只有写操作被拦截，于是缺陷可以用真实数据（799 次运行 / v0.11.0 的 run 35737586066 存在）来证明。**为审计写一个常驻仓库的测试套件**：本次未做（用户明确要求不修改任何已跟踪文件），只在 Agent Note 里留下可重建的配方；把它变成 CI 门禁属于"质量防线机制化"那张卡的范围。
## Consequences

买到：每条结论都带可复现命令与观察输出，且区分了"真实 runner 证据"与"本地干跑复刻"两类强度；顺带确认了若干原本只是假设的点（`fetch-depth: 0` 确实拉全量 tag 与全历史、`gh pr view/comment` 接受分支名、仓库 `can_approve_pull_request_reviews=true` 所以 Actions 能开 PR、含空格/中文的输入不拆词、`"${args[@]}"` 在 bash 5.2 + `set -u` 下安全）。代价与遗留：本机无 jq（runner 有），漂移步的干跑用了只实现 `-r .name/.version` 的 shim，因此"jq 表达式在真实 runner 上的行为"只有 preinstalled-sync 那次真实运行作为证据；file:// origin 能证明 `--force-with-lease` 的 ref 检查失败，但证明不了 GitHub 传输层的凭证行为。未覆盖：非空 dispatch 输入的 GitHub 侧渲染、周一 cron 的真实触发、以及四条缺陷的修复后回归（修复后必须重跑本配方并核对 `git diff --stat <new_run_sha> HEAD` 为空）。

