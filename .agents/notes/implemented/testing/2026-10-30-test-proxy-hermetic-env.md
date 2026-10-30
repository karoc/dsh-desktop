# Agent Note: test-proxy-hermetic-env

Status: implemented

## Problem

`scripts/test-proxy.mjs` 在宿主/agent 注入了 env 代理的环境里必崩（本机 harness：`NODE_USE_ENV_PROXY=1` + `HTTP(S)_PROXY`/`ALL_PROXY`）：forward proxy 的「经上游转发」分支用**绝对 URI** 调 `httpRequest`，Node 会把它按 env 代理再做一次改写，撞 `validateRequestAuthority`（ERR_INVALID_ARG_VALUE，栈落在 `proxy.mjs` 的上游请求），12 个场景全部失败。CI 不注入这些变量 ⇒ 门禁在 CI 是绿的，本机开发/agent 环境却红，属于典型的“环境依赖型假红”。

## Decision

`test-proxy.mjs` 开头检测 `PROXY_ENV_KEYS`（`NODE_USE_ENV_PROXY` / `HTTP(S)_PROXY` / `ALL_PROXY` 大小写各一份）；命中则用**干净环境重跑自身**（`spawnSync(process.execPath, [自身, ...args], { env: 删掉这些键 + DSH_TEST_PROXY_ENV_CLEANED=1, stdio: 'inherit' })`，`process.exit(child.status)`），子进程里断言逻辑与判据完全不变。为什么必须是“重跑”而不是 `delete process.env.*`：Node 在**进程启动时**读取 `NODE_USE_ENV_PROXY`（Node 24.22 实测，运行中删除无效），而生产侧 manager 是在运行中才设置这些变量，所以生产不受影响 —— 这个差异同时解释了“为什么只修测试、不动 `proxy.mjs`”。
## Alternatives considered

**在 `proxy.mjs` 里给上游请求加显式 agent 或清空 env 绕过**：否决——本次失败只发生在“进程启动时继承了 env 代理”的测试进程；生产 manager 的 env 代理是运行时设置的，`http.request` 在启动时已缓存开关，不会二次改写。为测试场景改产品代码等于把边界搞反。**在 `package.json` 的 test 链里前置 `env -u ...`**：否决——只覆盖 `npm test` 入口，直接跑 `node scripts/test-proxy.mjs` 仍红；且跨平台（Windows）不可移植。**允许这个套件在 env 代理下 SKIP**：否决——跳过不是通过，会把本机唯一的旁路代理门禁变成默认关闭。
## Consequences

买到：本机（含 agent/harness 环境）与 CI 上 `test-proxy` 行为一致，12 场景全绿可复现；不需要改任何产品代码或单元文件。代价与边界：① 测试进程多一次 exec（毫秒级），输出与退出码透传；② `DSH_TEST_PROXY_ENV_CLEANED` 是内部哨兵，用户正常不会设置；③ 该套件仍把“进程启动时继承 env 代理”视为测试环境污染而非被测行为 —— 生产侧 `proxy.mjs` 与 env 代理的交互边界没有新增自动化覆盖（当前无已知缺陷：manager 运行时设置变量，`http.request` 不生效；真实模型流量走 CONNECT，不经该分支）。

