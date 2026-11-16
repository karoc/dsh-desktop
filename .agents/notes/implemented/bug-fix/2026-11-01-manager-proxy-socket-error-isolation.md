# Agent Note: manager-proxy-socket-error-isolation

Status: implemented

## Problem

宿主机正式版 0.21.0 在 2026-11-01 07:18:43 / 07:24:04（本地）连续两次崩溃：manager 进程死于未捕获的 `Error: read ECONNRESET at TCP.onStreamRead`，壳按 D1「不自动重启」退到启动页，用户两次手动点「重启服务」才恢复。诊断到根因只用了半天，但此前 9 月起四次同类事故全靠猜——因为没人定义过「壳内正向代理在 socket 各阶段的 error 归谁处理」这条契约：Node 的 http server 把 socket 交给 'connect' 监听器时会摘掉自己的 'error' 处理，而 `scripts/proxy.mjs` 从那一刻到 `pipeTunnel` 之间不挂任何监听器，客户端在这段窗口（等上游 CONNECT 握手 / 等 TCP 建连）里 RST 就直接打死整个 manager；manager 是 dsh 子进程的唯一出口与 stdout 监督者，它一死整个应用就下线。

## Decision

代理内的 socket/stream 级 error 处理按「阶段归属」写死，且只清理、绝不上抛（`scripts/proxy.mjs`）：① `server.on('connect')` 的第一行就挂 `clientSocket.on('error')` + `on('close')`（置 `clientGone`，并销毁还在建立中的出站 `pending` socket），覆盖 CONNECT→隧道建立之间的空窗；② 用 `tunneled` 标记做所有权移交——隧道建立前 `origin.on('error')` 走 `rejectClient`（照旧回 502 并写 `connect … failed:` 日志），建立后只由 `pipeTunnel` 处理，`rejectClient` 不再往已建立的隧道里写 502 响应体（旧实现会写坏隧道并误杀正常连接）；③ `openUpstreamTunnel` 成功的 `settle()` 摘掉握手期的 `fail`、换成隧道期「只销毁」监听器，消除 resolve→pipe 的微任务空窗，隧道期 RST 不再被当成握手失败；④ 普通 HTTP 转发路径补齐 `upRes`/`req`/`res` 的 'error' 监听，新增 `failClient`：`headersSent` 之后只截断、不再二次 `writeHead`（旧代码在上游 RST 时会抛 `ERR_HTTP_HEADERS_SENT`，同样是 uncaught）。

负向保证（明确的「不做」）：不加全局 `uncaughtException`/`unhandledRejection` 兜底去吞异常；manager 的 fail-fast（写 `manager-exception-*.txt` + node report 后 exit 1）语义不变；`connect … failed:` 日志与按主机路由语义不变（loopback 永远直连、上游指回自己视为禁用）；proxy.json 的格式与热生效不变。

回归门禁：`scripts/test-proxy.mjs` 新增 scenario 13（socket 层 error 隔离），用 `process.on('uncaughtException')` 把「会不会崩」变成显式断言，覆盖 CONNECT 握手窗口 RST（+ 之后同一实例仍能建隧道）、隧道建立后源站 RST 不得写出 502、上游/直连两条普通 HTTP 响应体中途 RST、客户端 abort 后的迟到响应；`finally` 里摘监听器，保证失败是 exit 1 而不是挂到超时。红→绿已双向验证：还原 proxy.mjs 时输出 `read ECONNRESET | at TCP.onStreamRead`（与线上栈一致、exit 1），修复后 PASS（13 scenarios）。Windows + 宿主同款 node v24.18.0 上另用独立探针复跑同一场景：修前 exit 1、栈坐标 `stream_base_commons:216:20` 与线上完全一致；修后 exit 0、代理仍可服务。跨套件机制化：`scripts/test-controls.mjs` 新增第 ⑦ 条注入对照（删掉 `connect` 监听器第一行的 `clientSocket.on('error', …)` ⇒ `test-proxy.mjs` 必须变红、还原后必须变绿），把「有人手滑删掉这条监听器」也纳入门禁可信度自证。
## Alternatives considered

**全局 `uncaughtException` 兜底 / 按错误码吞掉 ECONNRESET**：最省事，但会把真正的编程缺陷变成静默，且 manager 的 fail-fast + 取证（2026-09-14 那次事故后建立的机制）正是靠退出事件触发；吞掉等于拆掉自己的诊断能力。

**改成自动重启 manager 来代替修根因**：能缩短停机，但每次崩溃都会变成「偶尔闪一下」，下一次未知崩溃更难被发现；且 D1「不自动重启」是显式决策（自动重启与崩溃循环熔断需要单独设计）。

**把代理拆成独立子进程，崩了也不影响 manager**：架构上能隔离，但只是把单点挪了个位置（出口仍然是唯一单点），且要多一套进程生命周期与端口协商；本次缺陷是局部的，修它比挪架构便宜两个数量级。

**去 dsh 一侧修「客户端不要 abort 连接」**：客户端取消请求是合法行为（用户停轮、请求超时、被终止的工具子进程、`Select-Object -First` 提前结束管道都会 RST），壳作为公共出口必须容错；改 dsh 既不可控也不彻底。

**只修 CONNECT 那一条路径**：同类缺陷在普通 HTTP 转发路径上一样存在（`upRes`/`req`/`res` 无 error 监听、headersSent 后 writeHead），只修实例等于留下一次事故——本次把同一缺陷族一次补齐。
## Consequences

代价：`connect` 监听器里多了三个状态变量（`pending`/`tunneled`/`clientGone`）和两处所有权移交，读代码要理解「阶段归属」才能改对；测试场景从 12 涨到 13、单次跑多约 2 秒（有界等待）。买到的：任何客户端在 CONNECT 建连窗口内 RST 都只会让那一条连接被清理，manager 继续服务；被终止的工具子进程 / 取消的模型请求不再能打死整个应用；新增的回归门禁会在有人删掉早期 error 监听时立刻变红（已做定向变异对照验证）。

遗留（已登记、未修）：① `openUpstreamTunnel` 没有取消机制，客户端在 upstream 握手期消失后上游 socket 要等 10s 超时才销毁（不崩，但上游故障时可能堆积 ≤10s 半开连接）；② `proxy.json` 字段类型非法（如 `proxiedHosts: {}`）会让 `shouldProxy().some` 抛 TypeError，属非 socket 层的同类 uncaught，需单独做配置校验；③ 历史文档 `docs/2026-10-23-official-client-adoption-review.md` 仍写「12 场景」（日期快照，未回改）。

交叉链接：`../feature/2026-08-17-shell-builtin-forward-proxy.md`（代理的设计与出口定位）、`../bug-fix/2026-09-14-manager-crash-forensics-and-guard-startup-race.md`（manager 崩溃取证机制，本次正是它第一次抓到真实异常栈）、`../testing/2026-10-30-test-proxy-hermetic-env.md`（test-proxy 的环境隔离）。

