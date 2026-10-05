# 内部记录（不提交上游）：Web GUI 空闲时仍在持续重排（约 120 次/秒），长会话下 GPU 可被拉满

> 状态：**内部记录 —— 决定不提交上游**（2026-10-05 用户决定）。
> 保留目的：① 我们自己的证据与结论闭环（同样症状再现时直接有依据）；② 若将来改变决定，本文即可直接粘贴的现成材料。
> 上游渠道实测（备查）：`deepseek-ai/deepseek-harness` 的 **`has_issues=false`**（该仓没有 issue 通道）、
> `has_discussions=true`；`POST /issues` 即使带 token 也返回 403 `Resource not accessible by personal access token`
> （请求被拒、未创建任何内容）。可用渠道若将来需要：GitHub Discussions 或 GUI 内「意见反馈」飞书问卷。
> 核对版本：> 核对版本：
## 一、用户侧现象（触发点）

Windows 上以 PWA 使用 dsh web GUI，屏幕上是**一个内容较多的会话**（含 5 张大截图）。GPU 持续 **>90% 近十分钟**，
**关闭并重新打开该 PWA 后立即恢复**（⇒ 消耗方是该页面/其渲染进程，而非外部进程）。
现场取证：`headless` 浏览器残留 0、WebView2 进程归属系统组件（Widgets/SearchHost/clash-verge）、桌面壳未运行；
恢复后 GPU 回落（chrome 3D 3.7% / dwm 2.9%）。

## 二、我的测量（可复现）

方法：Playwright + 新 context 打开 `dsh web` 的带 token URL → 等应用就绪 → 用 CDP `Performance.getMetrics`
取前后差值（5 秒窗口）+ `requestAnimationFrame` 帧间隔 + `PerformanceObserver('longtask')`。
无头 Chromium（因此**不含**真实 GPU 光栅化，见"未测量的部分"）。

| 页面状态 | layout /5s | style recalc /5s | 主线程 task /5s | JS heap | DOM 节点 | 屏上图片 | 帧间隔 p95 |
|---|---|---|---|---|---|---|---|
| **落地页**（会话列表，无交互） | **608** | **608** | 512–597 ms | 27 MB | ~730–800 | 0 | 17 ms |
| **打开一个会话**（正文 6,180 字符） | **607** | **617** | **970 ms（≈19%）** | 53 MB | **5,297** | 0 | 17 ms |

**结论（本次测量直接支持的）**：**页面在完全空闲、无用户交互、也没有图片的情况下，仍然以约 120 次/秒的速率
持续触发 style 失效与 layout**，主线程在打开的会话上约 19% 的时间在执行任务。
这属于"渲染管线永不静默"的形态：持续失效 ⇒ 持续重绘/重合成 ⇒ 在长会话 + 大窗口 + 大图时会稳定压住合成器，
与"GPU 长时间满载、重开页面才复位"的现象一致。

## 三、代码坐标

- **消息列表已经是虚拟化的**（**更正本报告初稿的错误结论**）：`packages/client/ui-chat/package.json:90` 依赖
  `@tanstack/react-virtual`。因此"长会话全量挂载"**不是**本案的缺失环节；需要核对的变成**虚拟窗口的 overscan /
  每屏渲染条目数**（实测打开的会话仍有 5,297 个 DOM 节点）`[已验证: git grep @tanstack/react-virtual]`。
- **空闲期每秒都在跑的表（持续 style/layout 失效最可能的来源）** `[已验证: git grep setInterval -- packages/client]`：
  `ui-chat/src/client/chat/RunningStatus.tsx:25`（`LIVE_RUN_CLOCK_INTERVAL_MS`）、
  `ui-chat/src/client/chat/MessageItem.tsx:91`、
  `ui-schedule/src/client/relative-clock.ts:32`、
  `ui-jobs/src/client/JobListAction.tsx:365`、
  `ui-subagent/src/client/SubagentHeaderLineage.tsx:209`、
  `ui-user-questions/src/client/contract/slots.ts:372` ——
  均为 `setInterval(() => setNow(Date.now()), 1000)` 形态：**每秒多处 `setState` ⇒ 子重渲染 ⇒ 样式失效与 layout**，
  实测 ~120 次/秒即这些子树失效的合计。
  `[假设：这些定时器是空闲失效的主因；请用 DevTools Performance 录 5 秒空闲、看 invalidate 的调用栈确认]`
- 附件尺寸：`ui-conversation/src/client/service.ts:95` 读取 `naturalWidth`（有尺寸探测），但**是否按显示尺寸下采样**再入
  DOM 未核实 `[未核实]`。

## 四、为什么值得修（影响）

1. **笔电/独显机器上直接表现为 GPU 满载与风扇狂转**（用户实测十分钟 >90%），并需要"重开页面"才复位；
2. 空闲 19% 主线程占用意味着**电池与散热成本常驻**，与是否在看内容无关；
3. 长会话（DOM 5,297 节点且持续增长）+ 大图叠加时会放大到"页面不可用"级别。

## 五、建议（可分别评估）

1. **让空闲真正空闲**：定位并消除每秒百次的 style/layout 失效（阈值：空闲 5 秒内 layout/recalc 增量应接近 0）；
2. **长会话**：虚拟化已具备（`@tanstack/react-virtual`）——建议核对 **overscan/每屏条目数**（实测 5,297 节点）、
   以及**每秒时钟 tick 是否必须驱动整棵子树重渲染**（可把相对时间改成订阅式/把 `setNow` 限制在真正显示时钟的叶子节点），
   并考虑对历史消息使用 `content-visibility: auto`；
3. **图片按显示尺寸下采样**（`devicePixelRatio` 上限 + `srcset`/`createImageBitmap`），并给附件固定尺寸避免布局抖动；
4. 加一条**回归门槛**：空闲 5 秒的 layout+recalc 增量与主线程 task 时间上限（例如 <50 次 / <100ms），把"页面永不静默"变成可测指标。

## 六、未测量的部分（诚实边界）

- 无头环境**没有真实 GPU 光栅化**：以上是 main-thread/compositor 侧成本，**不构成**"GPU 一定打满"的直接测量；
  用户侧现象与测量一致，但"GPU 打满"的直接证据需要在**有 GPU 的浏览器**里复现时抓 `chrome://gpu` + GPU trace；
- 本次测的两个页面**屏上都没有图片**（0 images），因此**图片的贡献未被本次量化**；
- 未测超长会话（>10 万节点）与多标签并发。
