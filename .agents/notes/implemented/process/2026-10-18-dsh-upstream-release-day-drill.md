# Agent Note: dsh-upstream-release-day-drill

Status: implemented

## Problem

上游 dsh 发版是**不可控窗口期**：6h SLA 要求"发布后 6 小时内出稳定版"，但链路（dsh-watch / dsh-adapt / dsh-compat-probe / dsh-sla-report + 4 个 workflow）从未在"上游真的发版"条件下跑过完整推演。等窗口来了才发现"很多准备其实可以提前做"，正是要避免的失败模式。需要一套**不触发真实上游发布**就能把发版日走一遍的方法，以及各步骤的真实时间预算。

## Decision

本仓采用"桩 + 副本 + 临时 runtime"三件套做发版日演练，三者都**不修改已跟踪文件**。① **packument 桩**：dsh-watch.mjs 用 `execFileSync('curl', ...)` 取 packument，因此在 `.tmp-investigate/drill/bin/` 放一个只做 `cat packument.json` 的 curl 壳并把该目录前置到 PATH，就能让**未经修改的**真实脚本对着任意 dist-tags 跑；配合 `.tmp-investigate/drill/scripts/` 下的字节级副本（`sha256sum` 必须与仓库文件一致）与可 sed 的 MIN_DSH_VERSION 副本，即可穷举比较边界。这是当前**唯一**能演练比较逻辑的手法，因为 dsh-watch 的 registry URL 与地板来源都写死。② **临时 runtime 真装**：`--runtime-dir /tmp/rt-rehearsal`（空目录）+ `.pnpm-store` 与 `node_modules/pnpm` 软链到真实 runtime 的对应物，直接以真实参数启动 `scripts/server-manager.mjs`，走它自己的启动期自动安装路径（`if (!dshInstalled(...)) installDshUpdate()`）。实测把 `@deepseek-ai/dsh@0.2.1-rc.2` 真装成，安装段 103.8s（reused 522 / downloaded 36）。**绝不**指向真实 runtime。③ **版本戳假 runtime**：`dsh-adapt` 第 1 步判据只是读 `<runtime>/node_modules/@deepseek-ai/dsh/package.json` 的 version 字段，故一个只含该单文件的目录即可通过——可用它演练"目标版本≠地板"时的分支行为，但它不证明安装可用（探针随后会因缺 dsh-web-app 判 RED，这是**正确**行为）。边界事实：manager 侧 registry **可注入**（`--registry` > `DSH_DESKTOP_REGISTRY` > npmjs）；dsh-watch / dsh-sla-report 侧**当时不可注入**（URL 写死）——**2026-10-19 已补上** `--registry`（两者）与 `--floor`（仅 dsh-watch，钉住地板），因此"PATH 劫持 curl 壳"不再是唯一手法，见 ../bug-fix/2026-10-18-dsh-upgrade-automation-defect-batch.md。时间预算是：安装 ~104s（非 Windows 宿主口径）> 23 套门禁 64.4s（其中 test-broken-install 32.6s + test-control-plane 29.2s 占 96%）≈ 探针 29.1s >> 夹具重采 0.93s ≈ 只读校验 0.95s >> peer 兼容 0.04s；CI 出包 ~10–11min（push 与 tag 运行同量级）。**演练明确不做**：不碰真实 runtime、不建 PR、不发版、不对真实 GitHub 写。
## Alternatives considered

**用本地 stub registry 装一个"假的新 dsh 版本"**——放弃：`@deepseek-ai` 家族 305 个包锁步同版本发布，手写 packument 无法复刻整族 tarball 与完整性哈希，缺的是整族制品而非脚本能力。**改仓库脚本加"演练开关"**——放弃：会在被测物上开洞，绿色不再可信；改为在 /tmp 与 .tmp-investigate 下操作字节级副本。**等下一次真实上游发版来验证**——放弃：窗口不可控，且这正是要避免的"临时抱佛脚"。**跳过探针的 --dry-run 深度选项**——放弃：那会把唯一的真实判据也关掉，属假绿。**整份复制 546MB node_modules 做临时 runtime**——放弃：软链 store/pnpm + 空目录已足够复现安装路径，成本低一个数量级。
## Consequences

买到的：把"能不能提前演练"从推测变成已验证事实——装候选版本这一步**能**提前演练（实测 103.8s，而非代码注释里沿用的 31.9s，说明该常量是 Windows 宿主+全热 store 口径，跨环境引用会低估）；比较逻辑边界可用桩穷举，并据此抓出两个 P0（`watch` 的 `pre()` 对无预发布版本返回 `['']` 使三个 `length===0` 分支成死代码 ⇒ `cmp('0.2.1','0.2.1-rc.2')=-1`；manager 的 `preOrder` 让 `preOrder('0.2.1')=999 < preOrder('0.2.1-rc.2')=2002` ⇒ `updateAvailable=false`，两侧口径"一致地错"，rc→stable 转正这一最典型的发版动作会静默不触发）。代价与遗留：① 桩手法依赖 `PATH` 劫持 `curl`，属**旁路**而非脚本支持的注入点，脚本一旦改用 Node `fetch` 即失效——建议仍给 dsh-watch / dsh-sla-report 加 `--registry`（对本地 stub 已验证 2 行改动可行）。② `dsh-adapt --dry-run` **结构上无法**演练版本变更：它只跳过第 2/3/4 步，而这三步恰是唯一能消掉第 6 步探针 `version-vs-floor` / `version-vs-fixture` 两条 RED 的动作，故只要 target≠floor 必然停在第 6 步；能全绿的只有 target==floor 的幂等路径，那恰恰不是发版日。③ 临时 runtime 演练会拉起一个真实 manager+dsh 进程（须自己收尾 kill，本笔记所述演练已确认无遗留进程）。④ 未覆盖：`--canary` 实机验收需要 dev 壳在检查期间**新启动**（脚本只认启动后新增的日志行），本轮未跑；SLA 历史基线 0/7 达标、中位 47.62h，说明瓶颈在人工反应延迟（适配段中位 21.55h）而非机械流水线（本机全链 ~2min + CI ~11min）。相关笔记：../testing/2026-10-18-workflow-dry-run-audit-harness.md、../testing/2026-10-18-gate-negative-control-harness.md。

