# Agent Note: doctor-selftest-stub-clock

Status: implemented

## Problem

`scripts/dsh-doctor.mjs --self-test` 把"现在"钉死在固定值（`fixNow = 2026-10-24T04:00:00Z`），但同一个文件里内置的 gh 桩用**真实墙钟**（`new Date().toISOString()`）写报警评论的 `createdAt`。这两条时间轴一旦交叉，反向心跳的去重判据 `sinceLastAlarmH >= 0`（"上一条报警晚于现在"）就恒不成立，同一段停更期被判定需要发**第二条**报警评论 ⇒ `同一段停更期不重复评论`（期望 1 实际 2）超时变红。真实 UTC 越过 2026-10-24T04:00Z 的那一秒起，`--self-test` 与 `test-automation-gates` 的 doctor 组（断言"自测 0 失败"）从此永久红 —— 一颗时间炸弹，而且红的是"判据套件自己"，会把真回归淹没掉。

## Decision

**桩时钟与被测时钟同源：`STUB_NOW` 是自测里唯一的"桩认为的现在"。** 内置 gh 桩（`STUB_SOURCE` 顶部）里所有时间戳（issue `createdAt`、评论 `createdAt`、PATCH 的 `updatedAt`、调用记录的 `at`）统一取 `const at = process.env.STUB_NOW || new Date().toISOString()`，不再各自读墙钟。`STUB_NOW` 由 `selfTest()` 的 `run()` 从**同一条** `--now` 派生（`stubNowOf(args)` → `new Date(args[i+1]).toISOString()`，非法值返回空串让桩退回墙钟），因此断言侧的 `--now` 和桩侧的 `STUB_NOW` 不可能各说各话。桩顶注释写明"桩时钟必须与断言时钟同源，否则门禁会随时间变红"。

**两条防回归断言钉住同源关系**（`[3]` 段）：`桩写入的 createdAt == 钉死的 now（单一时间源，不是墙钟）`（`createdAt === new Date(fixNow).toISOString()`）与 `桩的调用记录也全部来自同一个钉死的 now`（该段所有桩调用记录的 `at` 去重后恰好一条且等于 `pinnedIso`）。前者是机制断言，后者是"整个桩而不只是评论字段"的广度断言。**负向对照已实测**：把桩改回 `new Date().toISOString()` ⇒ 上述两条 + 原来的 `同一段停更期不重复评论` 同时变红（62/65）。

负向保证（刻意不做）：**自测的 `--now` 仍被忽略**——`--self-test` 自己钉日期，`--now` 只作用于功能模式，所以"加 `--now` 覆盖"不是让自测改日期的手段；`STUB_NOW` 也**不参与**功能代码（`runGH` 只透传 `process.env`，生产路径的时间全部来自 `NOW`/`NOW_ISO`），它纯属自测夹具；桩没有引入"冻结计时器/假时钟库"，只是让时间从一个更窄的入口进来。

## Alternatives considered

- **把钉死的日期后移一天再交付**：AU1 实测只会把红转移到另外 3 条钉死日期的断言（`last-ok=...` 正文字面量、`bootstrap-at`、PAT 过期天数），且本质是同一颗炸弹换引信；不解决"两条时间轴"这个根因。
- **删掉/放宽 `sinceLastAlarmH >= 0`**：去重判据本身是对的（"上一条报警发生的**时间**要晚于最后一次成功心跳"才说明这段停更期报过），为了让门禁变绿去削弱判据就是把假门禁换成了假功能。
- **让自测整体改用真实 `now`**：`48.0h`、`剩余 159 天`、`已过期 1 天` 全部变成动态计算，被测语义（"阈值边界"）会被搅进时间算术里，且失败时的期望值不可复现。
- **在医生进程里把 `NOW_ISO` 注进 `runGH` 的 env（生产代码路径）**：改动会伸进功能代码，而同一文件当时另有并行写者修"评论 PATCH 用 node id 当 REST id"的问题；写域必须互斥，所以把同源关系关在 `selfTest()` 的 `run()` 里。

## Consequences

买到的是：这条门禁**不再随真实时间变红**——自测里的"现在"只有一个来源，钉死点既是断言时钟也是桩时钟；两种证法都实测过（正常时 65/65；把钉死日期整体 +30 天临时改到未来仍 65/65、gates 125 断言/0 失败/7 KNOWN_GAP），再叠加墙钟变异的红证，形成"改回墙钟必红 / 改钉死日期仍绿"的双向对照。断言数从 63 变 65（`test-automation-gates` doctor 组仍只看 `0 失败` + `通过 == 总数`，无需改套件）。

代价与未完成项：`STUB_NOW` 只是**约定**而非强制——将来若有新的桩内时间读取不经过它，同源关系会静默失效；防线是那两条断言会红，但只在 `[3]` 段（报警）上咬得住，其它段引入墙钟不会被发现（本文件其它段不依赖时间，故当下无覆盖缺口）。`--self-test --now <iso>` 的 `--now` 依旧无效，本次没有改成"尊重 `--now`"（会扩大写域，且会让自测的行为依赖调用参数）。相关：[doctor canary 与反向心跳](../feature/2026-10-24-doctor-canary-and-reverse-heartbeat.md)、[自动化门禁自证套件](2026-10-19-automation-gate-self-verification-suite.md)、[门禁负向对照 harness](2026-10-18-gate-negative-control-harness.md)。
