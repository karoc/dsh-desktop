# Agent Note: auth-hint-device-verification-403-stub

Status: implemented

## Problem

壳侧对「上游 403 server_error 被误判为 AUTH ⇒ GUI 报『API 密钥无效』」的缓解（提示条幅 + 重试按钮）自 2026-10-05 起只有纯逻辑门禁与变异对照，从未在真实失败轮次上看过；看板卡 record 的配方卡在「harness 凭据存储写入方式未知」，导致无法让请求以 AUTH 失败（怕走到 MISSING_CREDENTIAL）。用户可见文案「可直接重试本轮」在真机上是否成立，一直无法回答。

## Decision

2026-10-31 在 Windows dev 壳（0.24.0 + dsh 0.2.1-rc.5）上用 `stub403` provider + 本地桩完成设备级验证，并把配方固化进技能 §4.11。具体：dev profile 的 `profiles/web/cordis.patch.yml` 里 `agent-default-model` 临时指向已存在的 `stub403/stub-model`（baseURL `http://127.0.0.1:41803/v1`、`apiKeyEnv: STUB_KEY`，值在 `dsh-home/.env`），并**删掉 `reasoningEffort: max`** —— stub 模型不支持推理等级，旧配置会在发请求前直接 `UNSUPPORTED_REASONING_EFFORT`（这是原配方缺的一条，也是"请求不出网"的真因）。桩返回 `HTTP 403 {"type":"server_error","code":"server_error","message":"Error from provider ... not valid JSON"}`；驱动用临时 `additionalBrowserArgs=--remote-debugging-port=9333` + CDP（Windows node 全局 WebSocket），在页面里 `el.focus()` + `Input.insertText` + Enter 发消息，不依赖 OS 焦点。断言四路：页面文本（`API 密钥无效`/`AUTH`）、壳 shadowRoot 的条幅（`document.getElementById('dsh-shell-chrome').shadowRoot`，`.errbanner` hidden=false + 文案）、桩的 POST 计数、以及重试点击后的请求增量。负向对照：桩改 404（非 AUTH）→ 新建会话 + `Page.reload`（重置 authShown）后发消息 ⇒ 页面无「API 密钥无效」、条幅 absent。
**实测结果**：403 正例通过（条幅按时出现，文案与设计一致）；负向对照通过；**重试按钮失败** —— 点击后 toast「未找到重试入口：请在失败的那一轮上点「重试」」、桩请求数 2→2。全 DOM 枚举（含 shadow root、hover）确认 dsh 0.2.1-rc.5 在 AUTH 失败态只渲染 `Sixlwa_turnErrorCopy`（本轮运行失败/API 密钥无效），**没有任何重试/重新生成控件**（AUTH 不在 dsh 的可重试白名单，UI 本就不提供）⇒ 壳的 `findRetryControl()` 按文本匹配必然找不到，该按钮在它唯一出现的状态里是死按键，文案「可直接重试本轮」属过度承诺。已另立卡 `card-d9ec479a`（待产品决策：改文案 / 实现真重试 / 删按钮）。证据：`D:\\Dev\\_accept\\p2-result.json`、`stub403.jsonl`。收尾已还原 `cordis.patch.yml`、revert CDP 配置、重建干净并覆盖安装、停桩与 dev 壳。
## Alternatives considered

**Playwright 连 Windows 的 dsh web**：WSL 到 Windows loopback 不通（服务只绑 127.0.0.1），否决；**UIA/SendKeys 驱动页面**：重启后实测文本送不进 WebView2 composer，且 SetForegroundWindow 受前台锁影响会误触用户其它应用，否决；**在页面 DOM 里伪造错误文本**：不是真实失败轮次，无法校准"提示出现的时机与真实文案"，否决；**截屏证明条幅**：条幅在 shadow DOM，且用户正在用桌面时 CopyFromScreen 抓到前台别的窗口（实测两次抓到浏览器/微信），否决；**注入 mock provider 到 dsh 源码**：违背"dsh 永远来自官方 npm 包"的边界，否决。
## Consequences

买到：403 误报的提示条幅第一次在真实失败轮次上被看到并逐字验证；配方（provider/桩/驱动/断言/回滚）固化后，下一次同类验证约 15 分钟可复跑；同时**暴露出重试按钮的死键问题**——这是设备级验证的直接价值。代价与边界：① 验证用临时 CDP 配置（行为代码与发布版一致，只多 localhost 调试口），每次都要 revert + 重建干净；② 桩端口固定 41803，运行前要确认空闲、跑完要停；③ 条幅状态按页面存（`authShown`），负向对照必须"新建会话 + reload"才干净；④ 结论依赖 dsh 0.2.1-rc.5 的 UI；重试控件若在后续版本出现，壳的文本匹配可能仍然找不到（需要按 aria/结构匹配，属待决策卡的范围）；⑤ `reasoningEffort` 与 stub 模型不兼容这条只写在技能 §4.11，没有门禁能自动发现配置漂移。

