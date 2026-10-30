# Agent Note: autopilot-release-resume

Status: implemented

## Problem

整条「上游发版 → 适配 → 发壳」流水线的**发布半程**在「本轮没有可自动适配的目标」时不运行：autopilot 的入口恒为「检测到新版」，适配 PR 合并后地板==target、dsh-watch 不再报它，⑥–⑧（合并 release-please 版本 PR → 派发构建 → 核验资产）就不会再执行。于是任何一次无关 fix 合并留下的版本 PR 会一直挂到下一次上游发版：实录 #234 从 2026-10-24 挂到 10-30，v0.21.0 之后 5 天没有任何新壳，而 v0.21.1 最终是人工作为「一次性事故处理」合并的。这不属于任何一次适配的失败，而是「空闲轮次无事可做就退出」这个设计缺口。

## Decision

`scripts/dsh-release-autopilot.mjs` 在两条「本轮不干活」的早退路径——`!probe.target`（无新版）与 `channel === 'best-effort'`（预发布通道，按决策 ③C 不适配）——之后新增 `resumeStrandedRelease(reason)`：查 open 的 `chore(main): release X.Y.Z`，命中就走与 ⑥⑦⑧ **完全同一套**收尾逻辑（`mergeReleasePr()` 的写域白名单/冲突/check 判定不变；`shipTag()` 从 flow 里提出来共用，避免两处漂移）。三条边界是刻意的：① gh 查询失败按「本轮无操作 + 告警」处理，**不**把无新版轮次记成失败（否则一次 API 抖动会污染退避状态机）；② 该路径**不回帖 issue**，因为此时没有 target 可归因，回帖只会把版本 PR 的收尾挂到预发布跟踪单上；③ `--no-release-resume` 是显式逃生口，人工接管/演练时关掉。写域越界、冲突、check 失败一律 `fail(1)`（与 ⑥ 同口径），不静默跳过。④ 版本 PR 带 `release-hold` 标签时 `resumeStrandedRelease()` 跳过（批次刹车：默认合并即发版，想攒版时打标签；移除后下一轮继续，不需要改 systemd）。新增 `scripts/test-autopilot-release-resume.mjs`（`npm test` 链上第 31 条）用 GH_BIN/GIT_BIN/DSH_AUTOPILOT_WATCH_JSON 桩覆盖 **10 组 / 47 条断言**，其中 5 组是负向/只读对照（写域越界 / 冲突 / gh 抖动 / `--dry-run` / `release-hold`）。
## Alternatives considered

**每一轮都无条件去查并合并版本 PR（包括有 target 的正常轮次）**：否决——有 target 时整条 flow 会一直走到 ⑥，再在别处重复查一次只会引入「适配 PR 还在 CI、版本 PR 先被合并」的竞态。**让 dsh-watch 开一条「请人工合并版本 PR」的 issue**：否决——只是把人工动作再提醒一遍，发布半程仍未自动化，而且与 SLA 单叠加成噪音。**在 CI 里用 `secrets.GITHUB_TOKEN` 合并**：不可行，bot PR 恒 `action_required` + 分支保护，普通 merge 会被拒（本项目一贯依赖本机项目 PAT 的 `--admin`）。**只在无新版分支补，不管预发布跳过分支**：否决——alpha 通道一旦领先（本机 2026-10-30 就是 `0.2.2-alpha.2` 领先 `latest`），所有轮次都会走 best-effort 早退，版本 PR 会永远停在那里，等于没修。
## Consequences

买到：发布半程重新闭环——「有可合并的版本 PR」成为 idle 轮次的可执行动作，不再依赖下一次上游发版或人工记得；同时把 `shipTag` 去重成唯一实现，⑥ 与兜底不会各自漂移。**2026-10-30 21:23Z 的真实轮次已验证**（这篇 note 首版写的是"尚未验证"，现补上坐标）：合并 #240/#241 后 release-please 开出版本 PR #242（0.22.0）→ autopilot 下一轮 `⑥′` 命中 → 按 bot 无 check 例外合并（21:24:00Z）→ 等 tag v0.22.0 → `dispatch — 已派发 build.yml @ v0.22.0` → 轮询 10m59s → 三个资产齐（AppImage 124,451,320 / deb 54,562,640 / x64-setup.exe 28,212,920，均带 sha256 digest）→ 日志 `✅ 本轮无新版，但已收尾停摆版本 PR：v0.22.0`，exit 0，状态 `healthy`。build run 41130819836 job 级全绿（check/test/windows/linux/linux-smoke/release）。**同日 21:53Z 的下一轮同路径再验一次**：版本 PR #244（0.23.0）→ 21:54:22Z 合并 → build run 41134480089 全绿 → 10m05s 后三个资产齐（均带 sha256 digest）→ 日志 `✅ … v0.23.0`，状态保持 `healthy`——即「发布半程」现在可以无人值守连续跑。

代价与遗留：① 每个空闲轮次多一次 `gh pr list`（10 分钟一轮，可忽略）；② 找到一个但合不了的版本 PR 会让该轮 `exit 1` 并进入退避（这是有意的 fail-visible，逃生口是 `--no-release-resume`）；③ 该路径仍然**不读 diff 语义**，审查只剩「mergeable + 写域白名单 + 无失败 check」——这是既有的「版本 PR 零人工审阅」缺口，没有因本次改动扩大也没有被解决；④ **发版节奏被改变了**：过去是「攒若干 PR → 人工合并版本 PR 才发版」，现在是「任何合并进 main 的提交 ≤10 分钟后就发版」。攒版需要一个刹车——`findReleasePr()` 现在会读 `labels`，版本 PR 带 `release-hold` 标签时 `resumeStrandedRelease()` 直接跳过（移除标签后下一轮继续），这是刻意的「按 PR 生效、不动 systemd」的设计；若不想要自动发版，`--no-release-resume` 仍是全局开关。⑤ 桩测已扩到 10 组 / 47 条断言（新增 `release-hold` 用例）。

