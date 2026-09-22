# Agent Note: audit-registry-transport-and-verdict

Status: implemented

## Problem

`scripts/audit-preinstalled.mjs` 用裸 `fetch` 访问 registry。Node 的 fetch 不读 npm 的 `.npmrc` 代理配置，而代理变量与 `NODE_USE_ENV_PROXY` 在进程启动时就被采样（Node 24.18 实测：脚本内再设无效），于是它走直连。在「registry.npmjs.org 只能经代理访问」的网络下（2026-09-22 本机：直连 IPv4 超时、IPv6 无路由，经 `.npmrc` 里的代理 200/3.8s），四个预装包的 `latest` 全部变成 `<unknown>`、内容级比对一次都没跑，而脚本仍然打印 "all preinstalled plugins are at the latest published version, with matching content" 并 exit 0 —— **一次建立在零数据上的绿色结论**。同一天同一根因还拦下了 turn-navigator 的 `npm publish`（release-check 也是裸 fetch）。

## Decision

`scripts/audit-preinstalled.mjs` 的 registry 访问全部改走 **npm CLI**：`npm view <pkg> dist-tags.latest dist.tarball --json` 取版本与 tarball URL，`npm pack <pkg>@<version> --pack-destination <tmp>` 取 tarball 内容（读入内存后 gunzip + 现有极简 tar 解析不变）。两者都带 `--registry <REGISTRY>` 与 `--cache <workspace>/.tmp-investigate/.npm-cache`（`~/.npm` 可能被拒），临时目录在 `finally` 里必定删除。`REGISTRY` 由 `DSH_PREINSTALLED_REGISTRY` 覆盖（默认 npmjs），这是负向对照的缝。

同时新增**"未能验证 ≠ 通过"**判定：统计 `error !== null || contentError !== null` 的行，只要存在这样的行，就打印 `⚠️ NOT VERIFIED — N of M bundle(s) could not be checked against the registry:` 并逐行列出原因，**绝不**打印 "all preinstalled plugins are at the latest published version, with matching content"。退出码保持 0（脚本头部明确写着 report-only; never a gate），但输出不再可能在未知数据上给出绿色结论。

同一天、同一根因的另外两处也一并修掉，并把它升格为**仓库级纪律**（写进 `CONTRIBUTING.md` 的「门禁」一节）：

- **`scripts/release-body.mjs`**：发布说明里的「内置 dsh 版本」原来也用裸 `fetch` 拉 `@deepseek-ai/dsh` 的 dist-tags。改走 `npm view`（`DSH_RELEASE_BODY_REGISTRY` 可覆盖）；降级时**在正文里明说「发版时未能查询 npm registry」**，不再打印裸 `unknown` —— 那段文字会进永久的 GitHub Release，一个像版本号的 `unknown` 会被当成事实读。
- **`scripts/fetch-node.mjs`**：内置 Node 运行时的下载同样用裸 `fetch`。本机 `nodejs.org` 直连超时、经 npm 代理 200/4.6s，也就是说**全新构建根本下不到 Node**；它一直没暴露，是因为二进制已缓存、脚本早退打印 `node already present`。改为 curl（带 npm 配置的代理）优先、curl 缺失时回退 fetch。
- **`scripts/audit-preinstalled.mjs` 的另一个崩溃路径**：`plugins/preinstalled` 缺失时，发现循环直接 `readdirSync` 抛 ENOENT，裸栈取代了脚本自己的诊断（"no preinstalled bundles found" 永远到不了）。改为先判存在、打印 `⚠️ NOT VERIFIED — no preinstalled bundle directory at …` 并 exit 0（报告工具契约不变；副本门禁 `test-copy-consistency.mjs` 已对同一情形 exit 1）。

**扫描结论**（用同一句 grep 全仓复查 `grep -rn "fetch(" scripts/`）：壳仓库只剩 `server-manager.mjs` 的两处 GitHub API（Windows 侧直连 200；失败时载荷带 `error` 字段、`latest: null`，UI 先判 `s.error` 再判「已是最新」，无假绿）与一处回环 watchdog 探活；插件仓库只剩 `post-publish-check.mjs` 的 fetch 主路径，它带 curl 兜底且已在真实环境验证能读到 registry 数据。

负向保证：不改变内容级比对的语义（比哪些资产、sha256 判等、`DRIFT` / `not-in-tarball` 的措辞）；不把 audit 变成门禁；不写工作区里的任何持久文件（临时目录在系统 tmp，cache 目录是既有的工作区缓存约定）。
## Alternatives considered

**保留 `fetch`，在脚本内设 `HTTPS_PROXY`/`NODE_USE_ENV_PROXY`**：实测无效 —— Node 在**进程启动时**采样这两个值（Node 24.18 上两种设法都失败），所以"脚本里补环境"这条路根本走不通。**保留 `fetch`，引入 `undici` 的 ProxyAgent**：可行，但要为一次审计查询给仓库加依赖，且仍需自己从 npm 配置解析代理、自己处理 auth；`npm view` 已经把这些都做对了。**只加 curl 兜底、不动 fetch 主路径**：在插件仓库（turn-navigator）用了这个形状，但那是因为它的 post-publish 检查有 15 场景夹具锁着错误语义；audit 没有这层约束，直接换成 npm 更简单、语义更一致。**把 audit 变成门禁（非 0 退出）**：仍被否，理由同旧 Note —— 内容漂移需要人判断哪一侧权威；但"未验证"必须与"已验证通过"区分开，这正是本次修的点。**只修 transport、不改 verdict**：那会留下"查询成功但部分行仍失败"时继续打印绿灯的窗口（例如某个包被 unpublish 而其他正常），所以两者一起改。
## Consequences

代价：① audit 不再是"只读、不落任何文件"——`npm pack` 会往系统临时目录写一个 .tgz（必定删除），npm cache 固定在工作区 `.tmp-investigate/.npm-cache`；这是对旧 Note 那条"只读契约"的有意取舍，理由是"能真正验证"比"不写文件"更值钱。② 每个包多两次子进程（`npm view` + `npm pack`），四包合计约 +10s；可接受，因为同步是低频人工步骤。③ 退出码仍为 0（报告工具），所以**调用方不能只看退出码**——必须看 verdict 行；技能里已写明。买到：代理网络下四个包能真正比对（实测 12/12 资产 match，含新同步的 turn-navigator 0.4.4 3/3）；"未知数据"不再伪装成绿色结论；`DSH_PREINSTALLED_REGISTRY` 提供了负向对照的缝。覆盖：负向对照三条都已实跑——registry 不可达 → `NOT VERIFIED`（4/4，且不打印通过）、注入 drift → `lib/index.js DRIFT`、恢复后回到 match。未覆盖：`npm view` 在"包存在但被 unpublish"等边缘形态下的错误串未逐一分类，统一按 error 处理（会走 NOT VERIFIED，方向安全）。

