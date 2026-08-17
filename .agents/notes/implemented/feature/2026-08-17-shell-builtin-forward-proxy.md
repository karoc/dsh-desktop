# Agent Note: shell-builtin-forward-proxy

Status: implemented

## Problem

dsh-desktop 的壳需要"全部代理 dsh 的请求"：包括启动时 dsh 的 npm 安装/更新、进去后的模型请求、web 搜索、插件安装、子代理进程。关键难点是 dsh 的模型请求走 Node 全局 fetch (undici)，而 undici 默认不读 HTTP(S)_PROXY 环境变量；且 dsh 官方 npm 包必须零改动。

## Decision

方案 B：manager（壳自己的 Node 进程，非 dsh 代码）内嵌一个 127.0.0.1 正向代理作为 dsh 全部出站流量的唯一出口。三块实现：(1) scripts/proxy.mjs —— 纯函数 forward proxy（CONNECT 隧道 + 非 CONNECT 绝对 URI 转发 + 按主机路由 + 上游 Basic 认证 + 观测主机 + 持久化 knownHosts），路由每请求实时读 <runtime>/proxy.json，所以设置面板勾选"保存即生效"无需重启 dsh；硬性安全规则：loopback 目标永远直连、upstream 指向本代理端口视为禁用（防自环）、代理自身用 raw net/http 不走 undici env-proxy。(2) manager 启动时先起代理并给自己 process.env 注入 NODE_USE_ENV_PROXY=1 + HTTP(S)_PROXY=http://127.0.0.1:<port> + NO_PROXY=127.0.0.1,localhost,::1 —— 实测内置 Node v24.18.0 的 undici 在 NODE_USE_ENV_PROXY=1 下会尊重 *PROXY 变量，于是 dsh/npm/pnpm/git/子代理全链路继承；默认全直连，勾选的主机才走上游代理。所有子进程 env 继承现有代码已满足（npm()/launchDsh/runDshPlugin 都传 ...process.env）。(3) Rust 桥 get/set_proxy_config 读写 proxy.json + 托盘「代理设置…」导航到启动页 ?view=settings 设置面板（上游地址/端口/可选 user/password + 按主机勾选列表，列表 = settings.yaml 解析出的模型提供方 host + 代理观测到的主机）。零改动 @deepseek-ai/dsh：只注入 Node 运行时环境变量（dsh 官方把 *PROXY 列为 bootstrap-only 变量，本就是留给启动环境的口子）。
## Alternatives considered

方案 A（只注入环境变量让 dsh 直连用户已有代理）改动最小但"勾选哪些提供方走代理"需要按主机维护 NO_PROXY 且切换要重启 dsh，不满足用户"保存即生效"的要求；把代理做进 Rust 异步层则实现量大、端口/env 跨层传递。实测排除了一个疑点：设置 ALL_PROXY 不会破坏 undici env-proxy 路由（早期一次测试失败是玩具代理自身问题，受控重测证明 ALL_PROXY 无影响，照常设置三个 *PROXY 变量以覆盖 curl 类工具）。undici env-proxy 对 http:// 目标也走 CONNECT 隧道（非绝对 URI GET），真实流量以 CONNECT 为主，符合预期。
## Consequences

所有 dsh 出站流量先过壳内代理再决定直连/上游，实现"壳是唯一出口"；代价是每请求多一跳本地代理（可忽略）且代理若崩会让 dsh 断网（代理极简 + 全量测试覆盖；manager 里 startForwardProxy 失败时降级继续、不阻塞启动）。NODE_USE_ENV_PROXY 在 v24.18.0 是实验特性（实测无告警输出）。上游代理仅支持 Basic 认证，NTLM/Kerberos 企业代理需用户侧再套本地转接。测试：scripts/test-proxy.mjs（11 场景：转发/CONNECT/路由/认证/loopback/防自环/观测/持久化/死上游/实时生效/provider 解析）、test-proxy-e2e.mjs（真实 undici→manager 代理→假上游全链路 + loopback 直连）、test-control-plane.mjs 新增代理注入断言、test-launcher-settings.mjs（vm 加载真实 app.js 验证设置面板渲染与保存）。sync-resources 新增拷贝 proxy.mjs。下一步遗留：WebView2 若加载外部 CDN 资源仍走系统代理（dsh UI 自包含，当前无此需求）。

