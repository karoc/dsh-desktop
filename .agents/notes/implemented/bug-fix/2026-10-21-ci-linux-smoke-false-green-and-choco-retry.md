# Agent Note: ci-linux-smoke-false-green-and-choco-retry

Status: implemented

## Problem

main 的 push 构建长期"红/绿说不清"：linux-smoke 的步骤判据用固定 `sleep 18` 赌打包后的 app 已打印首行，在 GitHub runner 的 headless xvfb 下 WebKitGTK 初始化没走完，于是每次都报 `FAIL: resources root missing or node absent`；而该作业带 `continue-on-error: true`，job 级 failure 在 run 级显示 success，所以这条 canary 自 2026-08-20 起从未真正绿过却一直被当成绿。同时 windows job 用 `choco install 7zip -y --no-progress` 直连社区源，一次 HTTP 499 就把 windows（以及 tag 上依赖它的 release）拖红。两者共同效果：外部偶发 + 假绿一起把真回归淹没。

## Decision

linux-smoke 的判据从 build.yml 内联块移到 `scripts/ci-linux-smoke.sh`，并且**删掉 `continue-on-error: true`** —— 它现在是 push/tag 的阻断式门禁（条件仍是 `github.event_name != 'pull_request'`）。脚本做三件事：① 从 artifact 里递归找 `.deb`（不再假设 `deb/` 目录层级）并解包，按 deb 的 `usr/bin` 入口定位 app；② 在 headless 环境启动（`dbus-run-session` 有则用、`LIBGL_ALWAYS_SOFTWARE=1` + `GALLIUM_DRIVER=llvmpipe`、兜底私有 `XDG_RUNTIME_DIR`），**有界轮询**（`SMOKE_WAIT_SECONDS`，默认 180s）等待 `resources root:` 与 URL 事件，app 提前退出即失败，超时打印进程/GL/日志诊断；③ 断言强度不降：resources root 目录必须真实存在且含 `node/linux-x64/node`，URL 事件必须出现在 manager 协议流里。没有 skip、没有 `|| true`、没有 continue-on-error。实测 run 39672157891（workflow_dispatch @ 9f1f893）：app 5s 打出 resources root、13s 出 URL，linux-smoke 绿 —— 说明之前的"卡死"主要是 headless 环境（session bus / runtime dir / GL 探测）而非单纯慢。windows 侧改为 `node scripts/ci-choco-install.mjs 7zip`：7-Zip 已在 `C:\Program Files\7-Zip\7z.exe`（断言步骤用的同一个路径）就**完全不联网**，否则最多 3 次、间隔 25s 的有界重试（每次打印失败原因与输出尾巴，单次 `timeout 180s`），预算耗尽仍 `exit 1`（不吞错：缺 7-Zip 时 NSIS 布局断言会静默失效）。实测该 runner 上 7-Zip 本就预装，日志为 `7-Zip already present … skipping Chocolatey entirely`，社区源依赖被整段去掉。两条逻辑都带可执行负向对照并挂进 `build.yml` 的 `test` 作业：`node scripts/ci-choco-install.mjs --self-test`（2 失败后成功 ⇒ 绿 / 3 次全失败 ⇒ 红 / 已装 ⇒ 0 次调用 / 首次成功 ⇒ 只跑 1 次）与 `node scripts/test-ci-linux-smoke.mjs`（静默 app / 假 resources / 缺 node / 无 URL / 早退 / 缺 deb / 缺 artifact ⇒ 必须红；完整链路 ⇒ 绿，用桩二进制 + 桩 xvfb/dbus）。两份自检都做过变异验证（把"耗尽后 return 1"改成 return 0、把重试循环改成 1 次、把 `die()` 改成 exit 0、把超时分支改成 return 0，自检均变红）。
## Alternatives considered

**把 `sleep 18` 加长（如 60s）**：仍然是赌固定时序，runner 变慢就再红一次，且无法区分"慢"与"真挂"；有界轮询 + 早退检测才有判断力。**保留 `continue-on-error` 保 run 级绿**：这正是本次要修的假绿本身，绿了也没人知道 canary 失效。**只在 `linux` 作业的「Verify packaged Linux layout」里查包内容**：它能证明 `.deb` 里有内置 node，但证明不了 app 能起来、能报 URL —— 那等于放弃这条 canary 的全部价值（历史缺陷正是"包内容对但启动链断"）。**改 Rust 让 `resources root` 在 webview 初始化之前打印**：为了迁就 CI 日志去改生产启动顺序，越界且会掩盖"启动链真的断了"这一类回归。**直接删掉 choco 那一步、赌 7-Zip 预装**：没有可核验证据就删门禁的工具准备，且缺 7-Zip 时断言会静默失效（比红更糟）。**在 pwsh 里内联重试 / 对整 job 做 workflow 级重试**：前者无法在本地与快层证伪，后者会把 20 分钟的 windows 打包重跑一遍，成本与信号都不对。**`--source` 换成别的 Chocolatey 镜像**：仍是外部源，只是换了个可能同样抖的地址，没有减少依赖。
## Consequences

代价：linux-smoke 现在真的会让 push/tag 变红（这正是目的，但意味着 headless 初始化回归会直接红 run，而不再被掩盖）；失败路径最坏多花 ~180s（旧脚本 18s 就下结论）；windows 侧若 runner 不再预装 7-Zip，会多花最多 3×25s 的重试预算。`release` 的依赖仍是 `needs: [windows, linux]`，**没有**把 linux-smoke 加进去 —— 刚恢复的 canary 不宜立刻决定"能不能发版"，等它连续绿几轮再升格。覆盖缺口如实登记：① 本次没有隔离出到底是 dbus / XDG_RUNTIME_DIR / 软件 GL 里哪一个解开了 headless 卡顿，只证明"三者齐备时 5s 就绪"；② PR 事件不跑 linux-smoke（成本考虑），PR 阶段只能靠 `test` 作业里的桩自检挡住判据腐化；③ workflow_dispatch 与 push 在受影响作业上同源（条件都是 `event_name != 'pull_request'`），但 push 专属的 `rust-coverage` 本次被 skipped，最终 push 路径验收要等合并后的首次 push。相关决策见 ../testing/2026-10-18-gate-negative-control-harness.md（门禁必须能失败）与 ../process/2026-09-22-release-pr-gate-and-asset-dispatch.md（发布派发链）。

