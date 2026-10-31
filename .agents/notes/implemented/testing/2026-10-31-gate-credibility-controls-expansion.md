# Agent Note: gate-credibility-controls-expansion

Status: implemented

## Problem

`scripts/test-controls.mjs` 是"注入真实缺陷 ⇒ 对应套件必须红；还原 ⇒ 必须绿"的门禁可信度对照，但 2026-10-31 盘点有三个缺口：① 只覆盖 3 条（copy / manifest / silent-failures），而链上已有 34 套、新增了 tree-guard / version-compare / logrotate 这类"守行为"的门禁却没有对照；② **本地几乎永远跳过** —— 脏树检查用 `git status --porcelain --untracked-files=no` 看全仓，而记录层 `KANBAN.json` / `.agents` 在每个会话里都是脏的，于是本机跑 `npm test` 时这一套永远 SKIP（输出只有一行，容易被滚过去），对照实际上只在 CI 跑；③ 没有约定要求"新增门禁必须带注入对照"，后来者可以只写断言不证明可失败。

## Decision

扩到 6 条，并把"能失败"变成可本地执行的默认：④ 让 `scripts/lib/tree-guard.mjs` 的 `drifted` 只看 diff、忽略 dirtyFiles ⇒ `test-tree-guard` 必红（dirty 判定是守卫的一半判据）；⑤ 让 `scripts/lib/version-compare.mjs` 的 `cmpVersion` 把正式版判成与同号预发布相等（`if (x.length === 0) return 0`）⇒ `test-version-compare-parity` 必红（审计 P0-1 的核心）；⑥ 关掉 `scripts/install-logrotate.mjs` 的 `@HOME@` 残留检查（`if (false)`）⇒ `test-install-logrotate` 必红（事故形态的防线）。三条都按"改语义"而不是"改精确字符串"，且都验证过 mutate ≠ original（夹具与被测文本脱钩即判失败）。脏树检查**收窄到对照可触达的路径** `['scripts','src-tauri/resources','package.json']`：记录层与 Cargo.lock 不算（前者永远脏，后者在发布后本来就旧），否则本机对照永远 SKIP；同时把跳过文案改成明确写出"哪些路径脏了"。CONTRIBUTING 新增约定：新增/修改一个守行为的门禁，就同时给 `test-controls.mjs` 加一条注入对照；确实不能加（纯静态文档门禁）在 PR 写明理由。本地跑前先 `node scripts/sync-cargo-lock-version.mjs` 的既有要求也写进脚本头注释（② 的"还原后必须绿"会读 manifest 门禁）。验证：本机 sync 后 `node scripts/test-controls.mjs` ⇒ **6/6 PASS（注入必红、还原必绿）**；依赖面机制复核仍在线（Dependabot vulnerability-alerts 204 / automated-security-fixes 200），`npm audit` 不塞进 CI 的理由不变。
## Alternatives considered

**保持只有 CI 跑对照**：否决 —— 本机 `npm test` 是主要开发入口，本地从不跑等于把可失败性验证外包给 CI，且开发者看不到 RED；**脏树检查继续看全仓**：否决 —— 记录层天然脏，会永久 SKIP（本轮实测：提交后仍因 KANBAN 改动跳过）；**在对照里自己 sync Cargo.lock**：否决 —— 那会把"发布后 Cargo.lock 漂移"这个 manifest 门禁本该抓的问题藏起来；**一次性给全部 34 套都加对照**：否决 —— 成本高且很多是静态/文档门禁，先把"守行为"的 6 条做扎实并立下约定；**把 npm audit 塞进链**：否决（既有结论）—— 网络依赖 + 上游 advisory 噪声，改用 Dependabot 告警/自动修复 + 本地自查。
## Consequences

买到：本机跑 `npm test` 时对照真的执行（不再因看板脏而静默跳过）；tree-guard / 版本比较 / logrotate 三个新门禁第一次有了"注入必红"的证据；约定让后续门禁默认带上可失败性证明，而不是靠人想起。代价与边界：① 对照②在本地仍需先 sync Cargo.lock，否则"还原后必须绿"会因发布后锁文件漂移而假红（已写进脚本头注释与 CONTRIBUTING）；② 对照只覆盖 6 个门禁，其余套件靠各自的内置自检或属纯静态检查，未纳入本套；③ 每次 `npm test` 多跑约 10 秒（3 个快套件各两遍）；④ 对照会短暂改写工作树里的真实文件，靠 try/finally 还原；如果进程被强杀，需要 `git checkout -- scripts src-tauri/resources package.json` 手动复位。

