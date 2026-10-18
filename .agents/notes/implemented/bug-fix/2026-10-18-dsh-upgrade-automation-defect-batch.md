# Agent Note: dsh-upgrade-automation-defect-batch

Status: implemented

## Problem

dsh 升级自动化链路的 12 项已定性缺陷会在关键路径上静默失效：watch 与壳把"同号正式版"判成比预发布旧（上游 rc→stable 转正 ⇒ 无提醒、无安装，而那正是 6h 硬 SLA 唯一生效的时刻）；`dsh:adapt --canary` 的三个标记分居两个日志文件（结构上永不通过）；SLA 门禁无数据判绿、真实数据恒红（两个方向都失真）；preinstalled-sync 第二次运行必失败（stale info）且把 npm 查询失败折成 `?` 制造假漂移；tag-dispatch 只看最新 100 次运行而仓库已有 799 次（老 tag 被反复重复派发）；dsh-watch 把 workflow_dispatch 输入直接插进 bash（`$(...)` 被执行且 step 仍绿）。

## Decision

三处版本比较统一为同一口径并各自就地修正（不新建共享模块，写域只允许改这 6 个脚本）：`pre`/`preParts` 对无预发布返回**空数组**（`String(v).split('-').slice(1).join('-')` 为空 ⇒ `[]`），从而"正式版 > 同号任何预发布、rc 序号按数值比、alpha<rc"全部按 semver 成立。三处分别是 `scripts/dsh-watch.mjs` 的 `pre`/`cmp`、`scripts/dsh-compat-probe.mjs` 的 `preParts`/`cmp`（peer 判据）、`scripts/server-manager.mjs` 的 `preParts`/`preCmp`/`versionGt`（`preOrder` 已删除）。**产品面**：manager 的这一处直接决定壳"提不提示/装不装"转正版，随包副本 `src-tauri/resources/manager/server-manager.mjs` 已同步为字节一致（copy-consistency 门禁覆盖）。

其余各项现状：`dsh-adapt.mjs` 第 8 步读**两个文件**（session 日志给 `client/log chrome ready` + `client-ready (http)`，`<runtime>/manager.log` 给 `preinstalled bundles:`，新增 `--manager-log` 覆盖；两文件都记起始长度，只认检查开始后新写入的行，缺哪个标记指名哪个文件）；第 6 步"探针没出报告"从 ok 改为 abort（假绿）；第 7 步把跳过项显著列出并新增 `--strict-chain`（跳过即失败），默认仍容忍。`dsh-sla-report.mjs` 的 `--check`：`perVersion` 为空即红；`--since`（默认 2026-10-19）只让该日之后**首发**的版本进退出码，历史欠账照常逐行显示并单列一行说明；报表 JSON 增 `since`/`gateScoped`/`gateHistory`。`dsh-watch.mjs`：issue 去重改成标题里按版本号**词边界**正则匹配（`(^|[^0-9A-Za-z.-])<v>([^0-9A-Za-z.-]|$)`），`gh issue list --json title,number --limit 100` 后在 node 里过滤；摘要按 `${threshold}h 截止`；`--now` 非法即 exit 2；取不到 npm 发布时间改为 fail-closed 判未达标（`pubUnknown`）；新增 `--registry`/`--floor` 两个**只用于演练**的注入点。四个 workflow：输入一律走 env 后由 bash 引用变量；`preinstalled-sync` push 前 `git ls-remote` 取期望值 + `git fetch` 建远端跟踪引用 + 显式 `--force-with-lease=refs/heads/<b>:<sha>`（远端不存在时用空期望）；漂移检测不再用 `set -e`（跑完所有包）、查询失败逐个记账后判红、返回值必须匹配版本号正则、本地领先不算漂移；名称/版本改用 node 读（去掉 jq 依赖，使该步在开发机可原样重跑）；无差异判断改用 `git status --porcelain`（含未跟踪文件）；tag-dispatch 改服务端 `?branch=<tag>` + `.total_count`；四个 workflow 都加 `timeout-minutes`（10/15/15/20）。
## Alternatives considered

**新建共享 semver 模块供三处 import**——放弃：写域只允许改 6 个脚本，新增文件还要连带改随包副本一致性门禁与 sync-resources，超出授权；且三处的调用形态不同（返回数/布尔）。**只修 watch、把 manager 留给后续版本**——放弃：manager 的 `versionGt` 是产品行为，不修就等于壳"永不提示/永不安装"转正版，而这正是本次修复的主要动机。**SLA 门禁只加 `--since` 不改无数据判绿**——放弃：`perVersion: []` 与"since 之后无新版本"是两种语义，前者是"量不出来"，后者才是"无欠账"，混为一谈会再造一个假绿（现在两者分支不同、文案不同）。**preinstalled-sync 把"本地领先"也当漂移**——放弃：那会用更旧的版本覆盖壳内已发布的 bundle（实测旧实现确实把 0.2.10 降级同步到 0.2.5）。**查询失败时只记 unknown 继续开 PR**——放弃：那会让"有包没查成"与"有漂移"共用一个绿灯，审计要求的正是区分并判红；代价是任一包查询失败时本轮不同步其它真漂移（下一轮自愈）。**给 `--force-with-lease` 加 `--force`**——放弃：等于放弃 lease 的安全语义（并发推送会互相覆盖）。**dsh-watch 去重继续用 gh --jq**——放弃：`--jq` 无法与服务端 `--limit` 组合成"取回后在本地按正则过滤"，且本机无 jq 就跑不了。
## Consequences

买到：三项 P0 各有可复现的负向对照（旧实现失败/新实现通过），且都落在"最要紧的那一次运行"上——转正版的探测、canary 硬门槛、SLA 门禁。跨文件口径统一后，`0.2.1 > 0.2.1-rc.2` 在 watch/探针/壳三处一致，未来任一处单独改动都会被"三处断言矩阵"暴露（drill 已在 /tmp，未入库）。代价与遗留：① 词边界去重只按**标题**匹配，若历史 issue 的标题不含版本号（例如手写的跟踪单）仍会新建一条 —— 这是可知边界，不猜。② manager 的 `versionGt` 是布尔，`==` 与 `>` 无法区分，本次只保证"相等不判 >"；调用点都按语义正确使用。③ `--since=2026-10-19` 是硬编码默认值，若方案落地日变更需同时改脚本与文档（README 侧由另一 agent 同步）。④ `dsh-adapt --dry-run` **结构上仍无法**演练版本变更（第 4 步跳过 ⇒ 第 6 步探针必报 `version-vs-fixture` RED ⇒ 提前 abort），本轮未修，属"演练能力缺口"卡的剩余部分；⑤ 真实 runner 回归（`git diff --stat <new_run_sha> HEAD` 为空）无法本机完成——需要一次真实 push/CI 运行。相关笔记：../process/2026-10-18-dsh-upstream-release-day-drill.md、../testing/2026-10-18-workflow-dry-run-audit-harness.md、../feature/2026-08-20-prerelease-update-channel.md。

