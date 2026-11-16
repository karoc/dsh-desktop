# Agent Note: adaptation-gates-host-env-coupling

Status: implemented

## Problem

上游 dsh 0.2.2-rc.1 于 2026-11-04T09:20Z 发布，检测段只用 10 分钟就开了跟踪单 #259，但适配段在此后 12 天里每一轮都红的——`dsh-autopilot` 连续 178 轮失败、壳 16 天无版本，6h SLA 欠到 280.0h。 更麻烦的是同一套门禁在 `main` 的 CI 与交互 shell 里全绿：`dsh-adapt` 第 7 步只报「2/33 套失败」，autopilot 又把子进程 stderr 截成末 3 行，失败套件名与 ssh 首行诊断都被丢掉，导致「明明本地能过、定时器就是红」无法定位。

## Decision

根因是两条门禁断言对**宿主环境**有隐含依赖，而不是适配逻辑或 dsh 0.2.2-rc.1 的兼容性问题；两处都已按 `main` 上的最小改动修掉，并各自带「修前必红」的对照。

（1）`scripts/test-automation-gates.mjs` 的两条 `[watch]` 断言（同号 rc 转正、next 超前）以前**读仓库的 `MIN_DSH_VERSION`**。`dsh-adapt` 第 2 步会先把地板抬到**目标版本**，于是目标 ≥ 0.2.2-rc.1 时 `0.2.1` 与 `0.2.2-rc.1` 都不再比地板新，`dsh-watch` 按设计返回「无需适配」⇒ 断言退化成 `null|null`。现在两条断言显式注入 `--floor 0.2.1-rc.2`——它们要验的是通道选择判据，不是仓库当前地板。落点 #260 / 0fe2cd7。

（2）`scripts/test-proxy-e2e.mjs` 给子进程设的是大写 `HTTP_PROXY`/`HTTPS_PROXY`，但 env 由 `...process.env` 起底，宿主的小写 `http_proxy`/`https_proxy`/`all_proxy` 会原样继承；undici 的 env-proxy 认小写那套 ⇒ 子进程把请求发给**宿主的**代理而不是 manager 的内置代理，`proxied fetch succeeds end to end` 稳定失败。本机 systemd 的 `run-with-proxy.sh` 同时导出大小写两份，交互 shell 只有大写 ⇒ 「人肉绿、定时器红」。现在 manager 与 fetch 两个子进程都走新增的 `cleanProxyEnv()`（清掉大小写 `http(s)_proxy`/`all_proxy`/`no_proxy` 与 `NODE_USE_ENV_PROXY`，再注入测试自己的值）。落点 #262 / 4afd4dab。

两处修复后同一轮 autopilot **20m28s** 走完 ②–⑧：#263 适配 PR（33/33 门禁、探针 GREEN）→ 合并 → 版本 PR #261 → 0.24.2 → build 10m41s → 3 个资产 → #259 回帖；tag 内 `MIN_DSH_VERSION = 0.2.2-rc.1` 已核实。

**负向保证**：没有放宽任何一条判据——没有 `|| true`、没有 skip、没有把地板压回低于目标、也没有只给本机 unit 加环境变量来「让绿的留在家门口」。修的是断言对宿主环境的依赖，断言本身仍然会在通道选择/代理链路真坏时变红（修前的 2/33 与 1/33 就是负向对照）。

**同时确认的两件边界**：`dsh-adapt` 第 7 步仍然是 fail-closed；`--version` 仍是「期望值」而不是注入开关（失败会 `MISMATCH` + exit 1，不会判绿）。
## Alternatives considered

**跳过或放宽第 7 步门禁**（例如 `--skip-gates`、`|| true`）：最快能发出 v0.24.2，但等于把「适配是否真的成立」的唯一判据废掉，而且下次还会以同样方式卡住。否决。

**把仓库地板压回低于目标让断言通过**：只需要改两行 `MIN_DSH_VERSION`，但那样适配过程永远看不到目标版本，`dsh-watch` 与探针的三方一致也会失真。否决。

**给 systemd unit 加 `Environment=NODE_USE_ENV_PROXY=1` / 只导出大写代理**：能让本机变绿，但换台机器、换个人跑 `npm test` 照样红，等于把缺陷藏进环境配置。否决。

**继续每轮人工适配**：SLA 的定义就是无人值守；人工路径只在排障窗口里用来复现，不作为常态。否决。

**改 autopilot 先 `git stash` 或强制跳过脏树检查**：与 fail-closed 的写域纪律冲突，且掩盖真实状态。否决。
## Consequences

买到的：适配段首次端到端跑通并沉淀成技能条目（§6.15 floor 耦合、§6.16 host 代理耦合），§8 的「②–⑤ 从未真机跑过」被改写成「只跑通过一次」；两个缺陷的触发条件都是「适配/定时器特有的环境」，所以以后同类假红可以直接按症状查表。

代价与遗留：① 这次发布是**迟到的补发**——280.0h，超过 6h 门槛 274h，SLA 报表里会记成一笔明确违约（检测段 10 分钟，全部欠在适配段）；② `dsh-adapt` 仍不告诉你**是哪几套**失败（只报 `N/33`），autopilot 的 `mustRun` 仍用 `tail(3)` 截断 stderr 首行——本轮排障各多花 1–2h，已登记为看板卡（P2）；③ 期间撞到的 `git fetch autopilot main` 瞬时 exit=128 至今不可复现（ssh 直连、`run-with-proxy`、systemd scope 三条路径各跑一次都 rc=0），只能记为环境抖，手工一轮即自愈；④ `pnpm` 装临时 runtime 时 `ERR_PNPM_ENOMEM`（7.9G 内存 + swap 吃紧）⇒ 现在可以复用 `--runtime <已装好的 /tmp/dsh-rehearse-*>` 绕过，但这意味着 rehearse 步骤在低内存机器上不可靠；⑤ systemd `Restart=on-failure`+`RestartSteps` 与脚本自身退避叠加，失败后服务卡在 `activating` 最长 1h、期间 timer 触发被吞（心跳实际退化成 ~1h/轮），unit 侧改动属用户动作，已登记；⑥ autopilot 仍没有 `dsh-watch` 那样的 flock 单实例，手工轮次与 timer 轮次并发时门禁会因资源竞争假红（本轮实测两次）。

相关：`2026-10-22-adapt-gate-cargo-lock-sync.md`（同类「门禁与适配流程耦合」）、`2026-10-30-dsh-adapt-rewrite-guards.md`（改写边界守卫）、`2026-10-18-dsh-upgrade-automation-defect-batch.md`（自动化缺陷批次）。

