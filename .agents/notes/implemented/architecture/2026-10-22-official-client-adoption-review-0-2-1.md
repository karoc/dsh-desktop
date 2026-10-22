# Agent Note: official-client-adoption-review-0.2.1

Status: implemented

## Problem

官方 DSH 桌面端已从 0.1.7-rc.2 演进到 0.2.1-rc.2（Electron 44，apps/desktop 66 个 src 文件、260 个 tests 文件），而本仓上一轮定位 note 与 0.1.7 对比报告只覆盖旧版本；团队需要一个可执行答案：哪些官方机制值得抄、具体改哪些文件、哪些明确不抄。此前的结论（不重写 Electron、不打包运行时、不做强更）仍然成立，但不能直接推出"下一步做什么"。

## Decision

本轮以只读源码 + `文件:行` 证据产出 `docs/2026-10-23-official-client-adoption-review.md`，并按"对壳越来越好用的边际收益"定下 5 条采用项（全部不依赖 Electron、不改上游契约、不破坏零 secret）：

① 恢复页面文件拖放：Tauri 默认 `drag_drop_handler_enabled:true` 会挂原生处理器并 `SetAllowExternalDrop(false)`，我方无 `onDragDropEvent` 监听，dsh 输入框的"拖文件/图片到此处"在壳内无声失效；改 `src-tauri/tauri.conf.json` 的 `dragDropEnabled:false` + 可失败配置门禁。
② 外链/新窗口交系统浏览器：wry 在无 new-window handler 时对 `NewWindowRequested` 直接 deny，而 dsh 多个路径用 `window.open`；在 chrome 捕获 click/auxclick + 覆盖 `window.open`，走新的 `/shell/open-url` 桥端点，只放行 http(s)。
③ 壳菜单键盘连续性：移植官方 `preload-menu.ts` 的 rememberEditor 焦点/选区恢复，并增加显式 `SHELL_ACCELERATORS`（Ctrl+W 隐藏、Ctrl+Q 退出确认、F12/Ctrl+Shift+I、Ctrl+R/F5），纯函数 + 变异对照。
④ 升级取证 JSONL + 失败分类：仿官方 `update-journal.ts`/`update-presentation.ts`，白名单字段（phase/version/percent/failedOperation/errorCode）落 `<app_data>/evidence/`，保留 10 份，绝不写 URL/token/路径/原始错误；写入失败不得改变升级结果。
⑤ 壳 UI 跟随 dsh 语言：`html[lang]` → `resolveShellLocale` 纯函数 + zh/en 字符串表，原生窗口经 `/shell/locale` 持久化；默认 `auto`，可用 `shellLocale=zh` 回滚。

负向边界（写进报告 §4，防止后人重开）：不整体注入 `dshDesktop`/`dshOnboarding`（会切换快捷键运行时并抛错、改 transcript 默认、关掉 dsh 凭据 onboarding）；不实现 `__DSH_BOOT_READY__` + `dshDesktopBoot` 握手（要求壳自供 index 与 Host injections，会劫持外部 `dsh web` 启动模型）；不做退出前任务巡检（`inspectQuit` 只存在于 desktop-host 私有 IPC，CLI/HTTP 无契约）；不搬 Electron 原生标题栏覆盖/WebContentsView guest/自定义 scheme/electron-updater；不做强制更新与飞书测试登录；不做首启原生欢迎窗/Platform 账号；不把 `dsh` 装进 PATH；不做 `__DSH_HOST_PATHS__` 真实路径引用（WebView2 无等价物，伪造路径比上传更糟）。
## Alternatives considered

**按官方优先级逐项追平**：官方有签名、强制更新、原生欢迎窗、账号登录、PATH 命令安装器；这些依赖其自有 feed/签名链/账号体系，与本仓"版本自由、用户决定、零 secret"三条约束冲突，逐项追等于把资源投在对方赛道上。
**直接复用 0.1.7 报告结论**：旧报告没有 0.2.1 的 update-journal/键位注册表/托盘/任务感知退出，且当时"官方不做完成通知"等判断需要按新源码复核；沿用会漏掉本轮最高收益的 G1/G2（拖放与外链，均为功能级失效）。
**注入 `dshDesktop` 以解锁桌面专属 UI**：看似一条注入就能拿到快捷键设置/更新入口，实际会把 shortcuts 运行时切成 desktop（缺 `keyboard` 桥即抛错）、改 transcript 默认模式、关掉 dsh 的模型凭据 onboarding、开启 analytics 分支；副作用与收益不对等。
**把退出确认做成"任务感知"**：需要 `ctx.agents`/`ctx.jobs`，只有 desktop-host 进程内可见；没有公开契约时只能猜，明确不做假的感知。
## Consequences

成本：本轮不改代码，5 条采用项都需后续单独实施并在 Windows 实机验收（拖放、外链、菜单焦点/加速键）；`__DSH_HOST_PATHS__` 路径引用被明确放弃，拖放恢复后非图片文件仍走上传而非 `@` 引用。收获：把"官方有什么"转成 5 个可执行文件级动作，并留下 10 条不采用理由与 6 条 `[假设]` 清单（Windows 运行时行为未实机验证，故未作为采用依据）。仍存的缺口：壳自更新与代码签名（G6）、任务感知退出（G7，等上游契约）、首启离线（G8，已知权衡）；均不在本轮范围。覆盖缺口：官方安装包签名/强制更新/安装器未实机运行；本机为 Linux，无法验证 Windows 拖放/新窗/焦点行为——已写进报告 §5.2 与各采用项验证方式。上一轮定位 note 仍然有效，本 note 只增量记录 0.2.1 的采用决策。

