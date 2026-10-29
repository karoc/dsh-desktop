# Agent Note: rehearse-probe-version-assumptions

Status: implemented

## Problem

适配新上游版本时，`dsh-rehearse --scenario install --version <target>`（target > 壳地板）必然失败：探针的 `version-vs-floor` 与 `version-vs-fixture` 两条判据在 target≠floor 时必然 RED，而 rehearse 的判定只在 target==floor 时要求 GREEN、否则写的是「只要求非 RED」——这个「非 RED」分支不可达，因为 rehearse 从不给探针传 `--assume-floor/--assume-fixture`。后果是 autopilot ② 结构性阻塞：2026-10-23 起 rc.3/rc.4/rc.5 三期未适配、SLA issue #217/#235/#236 连开，直到 2026-10-30 逐层排查才定位。脚本文案「只要求非 RED，见下」还让人以为它在容错。

## Decision

`scripts/dsh-rehearse.mjs` 在 target≠壳地板时给探针传 `--assume-floor <target> --assume-fixture <target>`（只替换这两条版本判据的期望值），并把「假设确实生效」当断言：报告必须 `rehearsal=true` 且 `assumed.floor`、`assumed.fixture` 都等于 target，否则该步判失败；**报告缺失一律判失败**（旧实现在 target≠floor 时把 `readJson` 的 null 读成 verdict=null，落进 `!== 'red'` 分支 ⇒ 探针崩溃也能假绿）。target==floor 时维持严格路径：必须 GREEN，且禁止出现 `rehearsal=true`。步骤文案打印 `rehearsal` 与 `assumed.floor/fixture` 实际值，避免把演练假设读成「版本已一致」。头注释与 `--help` 的 `--version` 语义同步写明这条。真实一致性证据仍在 `dsh-adapt`：第 4 步真重采夹具、第 6 步非 dry-run 禁止带假设（拿到 rehearsal=true 直接 abort）、第 7 步全量门禁。
## Alternatives considered

**把判定放宽成「接受 RED」**：会同时吞掉真正的兼容性 RED（客户端 seam / CLI 开关 / native 白名单 / 预装 peer），等于取消适配前兼容核对的全部价值。**让 autopilot 跳过探针或改 autopilot 的 ok 判定**：只治症状——`dsh-rehearse` 单独跑仍然红，且 autopilot 的步骤结果直接取 rehearse JSON 的 `ok`，掩盖后下次别处读 probe 仍然误判。**用 `--registry` 指向一个 latest 更高的假镜像来演练**：需要维护一个假 registry，且 manager 的启动期目标恒为 `max(floor, latest)`，仍然装不出「目标版本 + 地板未抬」的组合，演练前提本身不成立。
## Consequences

适配前的 install 演练现在可信：0.2.1-rc.5 实测 `GREEN`（red 0 / yellow 0 / info 16），install 段 22.4s（热 store + 已有 runtime），并让 autopilot ② 重新可达。代价：演练里「夹具版本一致」这一条被假设掉——真正的夹具一致性由 `dsh-adapt` 第 4 步重采 191 id + 第 6 步探针（非 dry-run）证明。覆盖缺口未变：`--canary` 实机验收需要检查窗口期内**新启动**的 dev 壳，本次 rc.5 发版因此在「dev 实机验收」一栏留空；另发现 `test-proxy.mjs` 在宿主 `NODE_USE_ENV_PROXY=1`（DSH harness 注入）下必崩于 `proxy.mjs:555` 的 Host/authority 校验（Node 24.22），属测试环境脆弱，未在本改动里处理。

