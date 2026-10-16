# Agent Note: chrome-bootstrap-gate

Status: implemented

## Problem

壳注入脚本（`src-tauri/resources/ui/shell-chrome.js`）的"真实初始化路径"在 CI 里没有任何门禁：契约测试 `scripts/test-shell-chrome.mjs` 设了 `__DSH_CHROME_TEST__`，chrome 在 TEST_HOOK 处提前 `return`，它后面那段（挂载守卫、契约写入、MutationObserver 自愈、引导上报、事件分发）在单测里从不执行；唯一覆盖它的 `scripts/test-chrome-real-init.mjs` 需要本机 dsh 在跑 + playwright，CI 里没有浏览器 ⇒ 恒 SKIP（exit 0）。0.18.0「注入即死」（顶层 ReferenceError ⇒ 顶栏与菜单永久消失、日志一字不留）正是从这条缝里溜过去的，当时的补救（引导上报）只买到"可见"，买不到"CI 会拦"。

## Decision

新增 `scripts/test-chrome-bootstrap.mjs`，已进 `npm test` 链（紧随 `test-shell-chrome`，全量 23 套），纯 Node、零 npm 依赖、不联网、不写盘、不启动浏览器。它在 `node:vm` 里**不设 `__DSH_CHROME_TEST__`** 加载 chrome，配一个手写最小 DOM + 可控时钟 + stub fetch：`document.createElement/getElementById/body/documentElement/querySelector(All)/addEventListener/elementFromPoint`、`attachShadow({mode})`、`append(Child)/remove/replaceChildren/contains/closest`、`classList`、`dataset`、`style`（`setProperty` 与属性赋值两种写法）、`innerHTML`（迷你嵌套解析，`.menu-btn .logo img` 这类后代查询必须命中）、`getBoundingClientRect`、`MutationObserver`（回调由 harness 手动触发）、`matchMedia`、`getComputedStyle`、`Event`、`setTimeout/setInterval`（虚拟时钟，`advance(ms)` 确定性推进）、`window` 事件、`location.protocol='http:'`（远程 dsh 页分支）、`__DSH_BRIDGE_PORT__`（字符串，与 lib.rs 注入一致）。

跑三个场景，全部可失败：① 正常时序 + 顶栏契约开 —— 引导上报链 `inject→mounted→ready` 且无 `fatal`、宿主在 body 里、shadowRoot 有 `.bar` + `.menu-btn` + 窗口三键、契约写入落 `documentElement`（`--dsh-shell-menubar-h=36px` / `--dsh-windows-titlebar-height=40px` / `data-windows-titlebar` / `host.caption`）、所有非 GET 桥请求（含 `/log` 上报）带 `X-DSH-Shell`、宿主被移除 + 触发 MutationObserver 回调后**自愈重挂并上报 `remount`**、重复注入不产生第二个宿主、全屏浮层让位与顶缘唤出；② **极早时序**（注入时 `documentElement` 与 `body` 均为 null，+50ms 后树才出现）—— 不抛异常、仍跑到 `ready`、契约写入被安全跳过、随后挂载重试真的把宿主接上；③ **出厂默认**（顶栏契约关）—— `html.style.paddingTop=36px` + `boxSizing=border-box`，仍给 `--dsh-shell-menubar-h`，不进 caption 模式。

两条硬规则：**(a) 桩缺任何 chrome 真调用的 API 都必须响亮失败**（未实现入口抛异常 ⇒ 缺 ready/fatal ⇒ 变红），且把"实际被调用的入口清单"用计数实测出来打印，再把必要子集钉成断言（`REQUIRED_API`），避免"桩缺 API"被误读成"被测缺陷"；**(b) 负向对照内建**：两个变异体在**内存里**用字符串替换造（绝不写盘）—— 删掉契约 dataset 写入的 `if (rootEl)` 守卫、删掉 `observer.observe(document.body, {childList:true})` 注册 —— 并且要求**指定**断言变红（`early-no-throw` / `self-heal`）；变异体没红、或锚点与被测源码脱钩（字符串替换未生效），整条套件判失败。外部负向对照入口 `DSH_CHROME_FILE=<别的 chrome>`：指向 `.tmp-investigate/chrome-0.18.0.js` 实测 exit 1（`ReferenceError: scheduleAuthProbe is not defined`，无上报、无自愈）。

本套件**不做**的事（负向保证）：不下任何几何/可见性结论（`getBoundingClientRect` 是桩常量，只为让 chrome 自己的 mounted 摘要有值）；不验证真实点击命中、菜单尺寸/滚动条；不建模 MutationObserver 的微任务批量投递（回调同步触发，因为 chrome 的回调体是纯同步 DOM 操作）；全屏让位那条是"桩注入布局事实（`position:fixed` + 覆盖视口 + 内容越过 36px 带）⇒ 断言 chrome 的判定"，判的是决策逻辑而非真实布局。

## Alternatives considered

**把 playwright 装进 CI。** 被否：要装浏览器（体积/时长），而这条路径的判据（跑到 ready、自愈重挂、契约落地）并不需要真实渲染引擎 —— 需要渲染的那几条继续留在 `test:chrome-real`（真机口径）。

**把 `test:chrome-real` 直接塞进 `npm test`。** 被否：没有活动 dsh 页面时它打印 SKIP 并 exit 0 ⇒ 变成"看起来跑了其实没跑"的假绿灯，这正是本仓已记录过的假门禁形态。

**不设 TEST_HOOK 复用 `test-shell-chrome.mjs` 的桩。** 被否：那个桩只覆盖到 TEST_HOOK 之前，真实引导会撞上一堆桩缺失报错（失败信息指向桩而不是被测缺陷）—— 与卡上登记的原因一致，所以要另建完整桩。

**用 jsdom / happy-dom 之类的现成 DOM。** 被否：本仓 scripts/ 的门禁脚本一直零依赖（CI 只 `npm ci` 装 tauri CLI），且这里还需要 call-level 的 API 使用计数与"未实现 API 直接抛"的语义，库给不了；自己写 ~700 行还换来"抛异常即红"的可控失败模式。

**照 `test-controls.mjs` 那样把变异体写成"改盘上文件 + 子进程跑套件"。** 被否：那需要干净工作树、会写盘、还会因开发中工作树脏而 SKIP；内存替换 + 同进程跑场景，既只读又不受工作树状态影响，且能要求"指定断言变红"而不是"整体非零退出"。

**顺便断言桩几何（如 `bar.top===0 && h===36`）。** 被否：那是桩常量的同义反复（由我们自己喂给 chrome 的值派生），属于恒真断言；顶栏真实位置只能由真机门禁判。
## Consequences

买到：0.18.0 那一类"注入即死"从"要 agent 手动跑真机才知道"变成 **CI 每次 PR 都会拦**；同时补上了契约写入的极早时序空安全（漏 `if (rootEl)` 守卫时结构上必红）与默认配置（契约关）的推挤路径 —— 后者此前没有任何门禁跑到。代价：多一个约 1000 行的桩要跟着 chrome 的 API 面维护（新增 DOM API 会立刻以"未实现 ⇒ 变红"暴露，这是有意的：失败信息明确是桩的缺口）；两个变异体锚点是两条精确源码字符串，chrome 改这两行会让套件以"夹具与被测文本脱钩"报红 —— 这是维护告警而非假阴性，但也意味着改 chrome 的自愈/契约行时必须同步更新锚点。仍然存在的覆盖缺口：视觉与交互口径（顶栏是否真的在视口顶部、菜单是否点得开、下拉会不会出滚动条）只在 `npm run test:chrome-real`（本机 + playwright，CI 里 SKIP）；全屏让位的真实布局判定同样如此。

相关：`.agents/notes/implemented/bug-fix/2026-10-15-shell-chrome-boot-reporting.md`（引导上报这条可见性链路的设计与它留下的"CI 可跑引导桩缺位"义务，本改动即关闭该义务）、`.agents/notes/implemented/bug-fix/2026-09-17-shell-menubar-modal-false-positive.md`（同属全屏浮层探测段的判定逻辑）。

