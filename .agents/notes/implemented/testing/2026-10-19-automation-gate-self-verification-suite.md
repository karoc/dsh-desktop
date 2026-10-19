# Agent Note: automation-gate-self-verification-suite

Status: implemented

## Problem

2026-10-19「假门禁猎手」审计用 49 条注入断言 + 负向对照矩阵证明了 dsh 升级自动化链路的判据**该失败时会失败**（probe 的版本/seam/peer、`--check` 的"没有数据"、`dsh-watch` 的违约判定、`dsh:adapt` 的失败即停、preinstalled-sync 的漂移检测；见 testing/2026-10-18-gate-negative-control-harness.md）。但那份 harness 只在 `/tmp`（抢救到 `.tmp-investigate/audit/repro.sh` + `FINDINGS.md`，被 gitignore、CI 从不跑），结论无法重复验证，判据回归也没人拦——"把它变成常驻门禁"当时被显式留给后续卡片。

## Decision

`scripts/test-automation-gates.mjs` 现在是 `package.json` 的 `test` 链上的一员（插在 `test-bake-bridge-port` 与 `test-controls` 之间；链因此变成 25 条，`test-manifest-consistency` 的"文档套数=链长"门禁要求 README/CONTRIBUTING 都写"全量 25 套"）。它**纯 node、零外部依赖**：不依赖 jq、不依赖本机 npm CLI；`npm` / `curl` / `gh` 一律是写进 `mkdtemp` 目录的**桩**，通过 `PATH` / `GH_BIN` / `FAKE_*` 环境变量注入，仓库文件只读。默认约 60s，104 条断言分六组：probe 28 / sla 17 / watch 20 / adapt 15 / drift 14 / mutation 10。
断言分两级：**CORRECT**（红即套件红）与 **KNOWN_GAP**（只逐条打印、绝不判红；行为一旦变化打 `GAP?` 提醒把它升级成 CORRECT）——2026-10-19 这一轮里 4 条 KNOWN_GAP 就是这样被并行落地的修复"自动升级"成正断言的（探针 peer 读已装包本体、`--fail-on-yellow`、SLA 的 `slaHours`/`--recent` 校验、`dsh-adapt --dry-run` 演练假设）。drift 组不重抄工作流：它按 YAML 缩进从 `.github/workflows/preinstalled-sync.yml` 抽出 `id: drift` 那一步的 `run: |` 块，写进临时目录、在合成 `src-tauri/resources/preinstalled/**` 上用 bash 跑，**抽不到就判失败**（结构变了必须改套件，不许静默跳过）；缺 bash 或 GNU `sort -V` 时打印**响亮 SKIP**并计入单独计数（不是通过）。adapt 组在**工作树的临时副本**（`tar` 排除 `.git`/`node_modules`/`src-tauri/target`/`.tmp-investigate`/`dist`，`node_modules` 软链）里跑，并把副本的 `test` 链换成短链，避免第 7 步递归跑本套件；adapt 与 watch 的子进程还拿到一个**私有 `TMPDIR`**（`<临时目录>/os-tmp`，同时设 `TMP`/`TEMP`）——因为 `dsh-adapt` 的探针报告路径是 `join(os.tmpdir(), 'dsh-adapt-probe-<TARGET>.json')`，**同机并发跑两个同 TARGET 的 adapt 会互相删/读对方正在写的报告**（实测：短链副本里 8 个并发 `--dry-run`，4 个报"探针没有产出报告"；方向是 fail-closed，不是假绿，但会让门禁随机变红）。变异自证 5 条（探针 seam 判据、"探针 RED 却继续"、"探针没出报告却继续"、SLA"没有数据即绿"、漂移"目录不存在=无漂移"），每条都配"**同一份副本、未注入时必须绿**"的对照；子跑一律 `--only <组> --fast --no-mutation` + `DSH_GATES_CHILD=1`。负向保证：绝不修改仓库任何文件、绝不写到临时目录之外、不依赖网络与 git、不静默跳过。
## Alternatives considered

**沿用 `repro.sh`（bash + `sed -n '36,57p'` 逐行抽取 + jq 替身）**：否决——本机无 jq，行号抽取随工作流改动即静默失真，且 `jq` 替身遇到未实现的表达式会给出与真 jq 不同的结果。**副本继续用 `git archive HEAD`**：实测否决——副本测的是 HEAD 而不是工作树，并行会话里未提交的 `dsh-adapt --dry-run` 演练改动在副本中完全不可见（adapt 组因此判成"旧行为"）⇒ 改成拷工作树。**把 4 条 KNOWN_GAP 直接写成正确性断言**：否决——当时它们确实仍未修（且别的 agent 正在改），硬写会把 `npm test` 判红，等于用假红换假绿。**parity 条目写成 `[ -f X ] && node X || echo SKIP`**：否决——`||` 会把 X 的真实失败吞掉（假绿）；最终形态 `if [ -f X ]; then node X; else echo …; fi`，两个分支都实测过（缺文件 ⇒ 打印 SKIP、exit 0；存在且失败 ⇒ exit 3 原样传出）。**像 `test-controls.mjs` 那样就地在真仓改被跟踪文件**：否决——那套件因此在脏树上必须 SKIP（本轮它就 SKIP 了），而且并行会话正在改同一批 `scripts/dsh-*.mjs`；本套件只在副本上注入。
## Consequences

买到：那份只在 `/tmp` 的 harness 变成 CI 每次 PR 都跑的 104 条断言，其中 5 条证明**本套件自己会红**；审计里"已知仍不完美"的行不再靠人记（7 条 KNOWN_GAP 打着标签在输出里），而并行落地的修复被自动锁进正断言。顺带抓到一个真缺陷：**`dsh-adapt` 的探针报告用系统 tmpdir 里的固定文件名**（首轮进链时那条无法复现的红就是它，已单开看板卡，最小修复 = 报告名加 `process.pid` 或 `mkdtemp`）。代价与遗留：链上多了约 60s 与 5 份临时仓库副本；**本套件对着工作树判分**，所以并行会话里半成品的改动会让它红（这是有意的语义，但并行开发时会变吵）；drift 组需要 bash + GNU `sort -V`，非该类平台上是响亮 SKIP（CI 的 ubuntu runner 与 Windows Git Bash 都满足）；parity 那条条件式不匹配 `dsh-adapt` 第 7 步的 `^node` 解析器 ⇒ 它会出现在"本机跳过"清单里，并使真仓上的 `--strict-chain` 必然失败（覆盖缺口如实可见）；`test-controls.mjs` 在脏树上仍会 SKIP，所以"本套件所在的工作树是否干净"这件事它管不了 —— 本轮无法在真仓验证 test-controls 的三个对照。未验证：真实 GitHub Actions runner 上的 bash/`sort -V` 行为、Windows `cmd.exe` 下 `npm test`（条件式条目依赖 POSIX shell）——本机是 Linux，未实测。

