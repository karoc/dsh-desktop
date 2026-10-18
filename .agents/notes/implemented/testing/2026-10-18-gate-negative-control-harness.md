# Agent Note: gate-negative-control-harness

Status: implemented

## Problem

dsh 升级自动化链路的判据（dsh-compat-probe / dsh-sla-report --check / dsh-watch 违约判定 / dsh:adapt 失败即停 / preinstalled-sync 漂移检测）此前只有"正向跑通"与静态审读两类证据，没有任何一条被证明**在该失败时真的会失败**。既有审计（见 .agents/notes/implemented/testing/2026-10-18-workflow-dry-run-audit-harness.md）解决的是"workflow 的路径在真实 runner 上跑没跑过"，回答不了"这条判据在恶意/残缺输入下会不会仍然报绿"——而后者才是"没有判断 = 没有验证"所指的失效模式：返回空、null、缺文件、缺字段、查询失败，全部可能被下游当成"通过"。

## Decision

判据审计固定为"注入 → 看具体红条目 + 退出码"的负向对照法，全部在 /tmp 下手，仓库零改动（`git archive HEAD | tar -x -C /tmp/...` 拿干净副本；`git status` 复核）。五个注入面各自定型：① probe 用 `/tmp/gateaudit/mkrt.sh` 造最小假 runtime（只有 `node_modules/@deepseek-ai/dsh/package.json` + 一个把 fixture id 打成 `- id: <x>` 的假 `lib/bin.js` + 一个含全部 seam 字符串的 js 文件），每次只注入一个缺陷（版本、seam、peer、native 白名单、CLI 开关），并保留一个"全绿正向对照"；② watch 用 PATH 前置的 `curl` 桩只拦 `registry.npmjs.org`（其余 `exec /usr/bin/curl`），配合 `--force-target/--force-published/--now/--sla-hours` 构造门槛前后 5.998h/6.0017h、门槛 0、负数 elapsed、垃圾时间；③ SLA 用合成 JSON 覆盖"全达标/全超/窗口外/缺 perVersion/缺 ok 字段/`--recent 0|abc`"，并与联网模式 `--fail-on-breach` 在同数据上逐条比对；④ adapt 在副本里跑，用"崩掉的假 gate（bin.js exit 3）""换成 `process.exit(7)` 的探针""伪造的 test 链"分别打第 4/6/7/8 步，canary 用"日志不存在/只有旧标记/启动后新写入"三态；⑤ 漂移段用 `sed -n '36,57p'` **逐字抽取** workflow 的 bash，配假 `npm` 与极简 `jq`（只实现 `-r .name`/`-r .version`，其它表达式 exit 3，避免替身静默给出与真 jq 不同的结果）。全部断言收进 `/tmp/gateaudit/repro.sh`，以 PASS/FAIL 计数收口（当前 49 条）。
判据边界同时被固化成一条规则：**"无法判定"不得等于"通过"**。探针没写出 `--json` 报告、报告里没有 `perVersion`、glob 一个目录都没展开、npm 查询失败折叠成 `?` —— 这些都要显式判失败或至少产出带标签的结果，禁止落进 exit 0。本方法的产物是 `/tmp/gateaudit/FINDINGS.md` 与 4 张看板卡；harness 本身刻意不进仓库（用户本轮要求不修改任何已跟踪文件），"把它变成常驻门禁"归 #质量防线机制化 卡。
## Alternatives considered

**只读代码下结论**：否决——正是这种强度让"`verdict = existsSync(report) ? ... : '(no report)'`"看起来像防御性兜底，而不是"探针崩了就整轮绿"的放行分支；`--now` 垃圾输入同理（`NaN > deadline` 恒 false）。**用真 npm / 真 runtime 覆盖全部用例**：否决——真数据无法构造"本地版本领先 npm latest""published 是垃圾字符串""装了不满足范围的 peer 包"（真 runtime 恰好全都满足），只能用真 runtime 做一次正向对照（1089 个 JS 文件、overlay 门禁通过）。**就地改仓库脚本注入缺陷**：否决——违反"不改被跟踪文件"，且会与并行会话的工作互相污染；改用 archive 副本，代价是副本无 `.git` 导致 `test-controls.mjs` 无法在其中运行。**直接把 harness 提交进仓库当测试套件**：本轮未做——用户明确要求不改被跟踪文件；而且它依赖假 runtime/假 npm/jq 替身，进仓前需要先解决"替身与真实现的语义差"。**用 mock 掉整个 registry 的 HTTP 层**：否决——`sync-preinstalled-plugin.mjs` 用 Node 原生 `fetch`（不经 curl、不认 HTTPS_PROXY），改成 `NODE_OPTIONS=--require` 打桩 `globalThis.fetch`，只用于验证它对 `?`/`''` 的 fail-closed 行为。
## Consequences

买到：每条判据都有了"注入即变红"或"注入仍为绿（缺陷）"的可复现证据，且探针/adapt 的崩溃分支被区分为"被编排者正确包装成 RED"（探针：好）与"被编排者判成 ok"（adapt 第 6 步：缺陷）；顺带证实两条原本只是怀疑的结论 —— `--check` 与 `--fail-on-breach` 在同数据上口径完全一致（消除一个猜想），而 preinstalled-sync 的 npm 失败**不会**造成"静默无漂移"（`?` 与非空版本号必然不等），真正的假绿在 glob 未展开那一侧。代价与遗留：harness 在 /tmp，**不durable**，本 note 是唯一可重建的配方，重跑必须整段重建；本机无 jq、无可用 npm CLI，漂移段的"runner 侧行为"仍属未验证；首次跑出的 5 条 FAIL 全是我自己的断言/正则 bug（harness 必须先自证，否则会把自身缺陷当成仓库缺陷上报）；副本无 `.git`，`test-controls.mjs` 与任何依赖真仓的套件在副本里不可判。修复落地后必须重跑 `bash /tmp/gateaudit/repro.sh` 并核对原绿判据仍绿、原假绿判据已变红。

