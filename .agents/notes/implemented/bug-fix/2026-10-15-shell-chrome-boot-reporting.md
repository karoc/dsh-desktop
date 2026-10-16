# Agent Note: shell-chrome-boot-reporting

Status: implemented

## Problem

生产版 0.18.0（用户机器）出现"顶栏先能看见、随后永久消失，且壳自定义菜单点不开"。排查时发现这类事故**在系统里是不可见的**：壳用 `w.eval()` 注入 `shell-chrome.js`，而 JS 异常根本回不到 Rust（`eval` 只把"派发失败"当 Err），所以 chrome 顶层一旦抛异常，其后整段脚本静默死亡——顶栏挂载点在其之前，于是表现为"顶栏在、但自愈/图标同步/菜单点击分发器全没装上"，日志里一个字都没有。0.18.0 的真实死因是鉴权探针的调度块被误插进 `misleadingAuthHint` 函数体 ⇒ 顶层 `scheduleAuthProbe()` 抛 ReferenceError（`:851`），后续 62 条顶层语句全部不执行。

## Decision

壳 chrome 的注入过程现在**自证**：`shell-chrome.js` 在真实初始化路径上发五类一次性上报，走既有的环回桥 `POST /log` 落进 `dsh-desktop-session.log`（`client/log chrome <stage> boot=<id> …`）。stage 为 `inject`（eval 真的执行到了，带 readyState/body 时序）、`mounted`（宿主在 DOM 里，带 `bar=<top>px h<h> hidden=<bool> hostH=… btns=<n>` 摘要）、`ready`（整段引导跑完，是"chrome 全须全尾活着"的唯一判据）、`fatal`（`stage=<阶段> <错误名>: <消息> @<文件:行:列>`）、`remount`（SPA 重渲染清掉宿主后自愈重挂，是"曾经消失又恢复"的直接证据）。上报有明确负向保证：每次注入**至多 12 条**、整体包在 try/catch 里**永不抛**（诊断不能成为新的死因）、`__DSH_BRIDGE_PORT__` 缺失（单测/桩页）时静默放弃；上报本身不改变任何行为，也不写任何持久状态。

同时把四个加载期动作（`mount` / `auth-probe` / `auth-probe-now` / `observe`）各自包进 `boot(stage, fn)`，并在引导窗口内挂一个 `window` error 兜底（`ready` 后摘掉）。**这里有一条必须记住的边界：`boot()` 买到的是"可见"，不是"不致命"** —— 它只保护这四个调用点，未被包住的顶层语句抛异常仍会吃掉其后全部（0.18.0 就是这种形态），区别只在于现在会被上报成 `fatal stage=…` 而不是无声无息。壳侧**没有**做、也做不到"注入成功与否"的校验：`w.eval` 无返回值通道，页内异常只能由页内自己报出来。

门禁随之补强：`npm run test:chrome-real`（真实 Chromium + 本机活动 dsh 页面，无页面时显式 SKIP）现在断言五件事——无 pageerror、`#dsh-shell-chrome` 宿主与 ≥4 按钮、**顶栏真的在视口顶部可见**（`bar.top∈[-2,4]` 且高度 30–48）、**引导上报链完整**（inject→mounted→ready 且无 fatal）、**宿主被移除后自愈重挂并报 remount**；另加"点唯一菜单触发器 → 下拉出现且条目 ≥5"（直接对着用户症状）与"契约真的落到页面根"。测试内置一个 stub 环回桥（含 OPTIONS 预检与 `access-control-allow-headers: content-type, x-dsh-shell`，缺预检则真正的 POST 根本不发出）。`DSH_CHROME_FILE=<别的 chrome>` 是**负向对照入口**：指向 0.18.0 的版本 ⇒ 7 项红，指向"缺 rootEl 守卫"的变体 ⇒ 早期注入 `TypeError: reading 'dataset'` 2 项红。
## Alternatives considered

**让 Rust 侧确认 eval 是否成功。** 被否：`w.eval` / WebView2 `ExecuteScript` 对页内 JS 异常没有返回通道（`Result::Err` 只覆盖派发失败），壳侧无凭据可判；除非引入 CDP（生产不启用），否则唯一出路是页内自报。

**新开一个桥端点 `/shell/chrome-report`。** 被否：`POST /log` 已经就是"页内 → 会话日志"的既定通道（`{tag, detail}`，插件也在用），复用它零新增路由、零新增契约测试面；新端点只是把同一件事换个名字。

**把自愈观察者提到挂载点正后方**（让"被 SPA 清掉"这一失效模式在结构上不可能发生，即使后面还有语句抛异常）。被否：`startObserve` 是 `const` 箭头函数，提前调用会踩 TDZ，必须整块搬移；而观察者回调里调的 `closeMenus()` 又依赖 `dropdowns`/`openMenuId`，搬太早会在"引导中途死亡 + 恰好发生 body 变更"时把 TDZ 异常引进回调。权衡后保留现有顺序，靠"上报可见 + 门禁覆盖整条引导链"来兜这个类，而不是靠搬代码。

**把真实初始化自检搬进 `npm test` / CI。** 被否（本轮）：仓库没有 playwright 依赖、CI 也不装浏览器 ⇒ 搬过去只会永远 SKIP，等于假门禁。真正的 CI 缺口是"纯 Node 的完整引导桩"（现有 `test-shell-chrome.mjs` 因 `__DSH_CHROME_TEST__` 提前 return，恰恰测不到这条路径），已作为跟进项登记。

**重写 `fa59ae6` 的历史消息来更正"阶段隔离"的过强表述。** 被否：改用后续提交显式更正（README / 技能 / 提交信息三处同步），历史可追溯比"看起来干净"重要。
## Consequences

代价：每次页面加载多 4–5 条日志（有界，但生产日志会略增）；上报依赖注入前缀里的 `__DSH_BRIDGE_PORT__`，桥未起来时静默无输出（此时"没有 inject 行"本身也是信息）；`remount` 会在长会话里如实暴露"顶栏被清掉又恢复"的频率，属于噪声换可见性。收益：一次"顶栏消失"类故障现在能从日志直接判到三分（没注入 / 挂上了但不可见 / 中途死在某阶段），fatal 行给出错误名+文件:行:列；并且这条链路在真机上被验证过——把 dev 壳装成修复版后，日志如实出现 `client/log chrome mounted … bar=0px h37 hidden=false btns=4` 与 `ready … btns=12`，而注入一个顶层 `throw` 的变体会写出 `fatal stage=mount:ok uncaught Error: probe-fatal-after-mount @<anonymous>:664:9`。

遗留义务（已登记看板）：① ~~CI 可跑的"完整引导桩"缺位（当前门禁需要本机 dsh 在跑，CI 里恒 SKIP）⇒ 事故类回归仍靠 agent 手动跑~~ —— **2026-10-17 关闭**：`scripts/test-chrome-bootstrap.mjs`（进 `npm test`、纯 Node 且不设 TEST_HOOK、自带 2 个内存变异体）已覆盖引导上报链 / 自愈重挂 / 契约写入 / 极早时序空安全；真机渲染口径仍留在 `test:chrome-real`。设计取舍见 `.agents/notes/implemented/testing/2026-10-17-chrome-bootstrap-gate.md`；② `boot()` 之外仍有约 190 条顶层语句未被隔离，其中已修掉两处（`scheduleAuthProbe` 作用域、`rootEl.dataset` 漏守卫），剩余单条风险见 chrome-audit 的顶层清单（`.tmp-investigate/audit/toplevel.*.json`，未入库）。

相关：`.agents/notes/implemented/feature/2026-08-27-shell-menu-bar.md`（注入式顶栏的起源与双通道设计）、`.agents/notes/implemented/bug-fix/2026-09-17-shell-menubar-modal-false-positive.md`（同一段全屏浮层探测的既有缺陷）。

