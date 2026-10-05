# 上游 defects 报告稿：Web GUI 空闲时仍在持续重排（约 120 次/秒），长会话下 GPU 可被拉满

> 状态：**待提交**（本仓对 `deepseek-ai/deepseek-harness` 只有读权限）。提交后把 issue 链接回填到这里与看板卡。
> 核对版本：checkout `5badb15`（0.2.1-alpha.1 构建行；**新于 dsh 0.2.0-rc.2**）。

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

- 虚拟化：`packages/client/ui-chat`、`ui-conversation`、`ui-session` 的 `package.json` 中**未见** `react-window`/`virtuoso`/`react-virtual`
  （`git grep` 无命中）`[已验证: git grep 上述三个 package.json]`——即消息列表很可能是全量挂载，长会话下 DOM 持续增长（实测 5,297 节点）。
- 持续重排的来源**未定位**（本次只做了"存在性"测量）：`git grep setInterval -- packages/client` 未命中明显的周期任务，
  因此来源可能是 SSE 订阅的细粒度更新、`requestAnimationFrame` 循环、相对时间刷新或 CSS 动画/`content-visibility` 缺失。
  **请维护者从"谁在每秒 120 次失效样式"入手**（DevTools Performance 录制 5 秒空闲即可看到调用栈）。
- 附件尺寸：`ui-conversation/src/client/service.ts:95` 读取 `naturalWidth`（说明有尺寸探测），但未在本次核对中确认
  是否按**显示尺寸下采样**后再入 DOM `[未核实]`。

## 四、为什么值得修（影响）

1. **笔电/独显机器上直接表现为 GPU 满载与风扇狂转**（用户实测十分钟 >90%），并需要"重开页面"才复位；
2. 空闲 19% 主线程占用意味着**电池与散热成本常驻**，与是否在看内容无关；
3. 长会话（DOM 5,297 节点且持续增长）+ 大图叠加时会放大到"页面不可用"级别。

## 五、建议（可分别评估）

1. **让空闲真正空闲**：定位并消除每秒百次的 style/layout 失效（阈值：空闲 5 秒内 layout/recalc 增量应接近 0）；
2. **长会话虚拟化**（只挂载可视区），或对历史消息使用 `content-visibility: auto` 降低重排成本；
3. **图片按显示尺寸下采样**（`devicePixelRatio` 上限 + `srcset`/`createImageBitmap`），并给附件固定尺寸避免布局抖动；
4. 加一条**回归门槛**：空闲 5 秒的 layout+recalc 增量与主线程 task 时间上限（例如 <50 次 / <100ms），把"页面永不静默"变成可测指标。

## 六、未测量的部分（诚实边界）

- 无头环境**没有真实 GPU 光栅化**：以上是 main-thread/compositor 侧成本，**不构成**"GPU 一定打满"的直接测量；
  用户侧现象与测量一致，但"GPU 打满"的直接证据需要在**有 GPU 的浏览器**里复现时抓 `chrome://gpu` + GPU trace；
- 本次测的两个页面**屏上都没有图片**（0 images），因此**图片的贡献未被本次量化**；
- 未测超长会话（>10 万节点）与多标签并发。
