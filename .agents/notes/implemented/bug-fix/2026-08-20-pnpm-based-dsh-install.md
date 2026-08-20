# Agent Note: pnpm-based-dsh-install

Status: implemented

## Problem

用户 0.3.2 仍报 `launch failed: @deepseek-ai/dsh not installed`。深入排障（经用户 WSL 挂载 /mnt/c 直读 Windows 运行时）发现真正根因：`npm install @deepseek-ai/dsh` 在 npm 依赖解析（buildIdealTree/placeDep）阶段无输出地无限挂起——npm 10/11、Node 22/24、npmjs/npmmirror、代理/直连全部复现，任何 dsh 版本都卡；npm 调试日志停在 placeDep 后不再发任何网络请求；而 `npm install commander`（小树）419ms 完成。dsh 是 pnpm monorepo 发布的 55-61 个互相依赖的 @deepseek-ai 包，npm 解析器对此图挂起。用户机器（Windows 经 Clash 代理）与 WSL 复现一致。

## Decision

scripts/server-manager.mjs 的 dsh 安装从 npm 切换为 pnpm：(1) 新增 runChild()（从 npm() 重构出通用子进程执行器：spawn 捆绑 node、输出节流流式、600s 硬超时、180s 无输出卡死检测、单一 settle），npm() 与新增 pnpm() 共用；(2) pnpm() 用 runtime 内 ensurePnpm 装的 pnpm.cjs（--reporter=append-only，throttleAll 节流），cwd=runtime；(3) installDshUpdate 的 registry 降级循环改调 pnpm install <pkg>@<ver> --registry <reg> --store-dir <runtime>/.pnpm-store（pnpm isolated 布局，已端到端验证 dsh 启动+插件注入+URL）；(4) 新增 ensurePnpmWorkspace()：写 <runtime>/pnpm-workspace.yaml 的 allowBuilds（pnpm 11.22 的原生 postinstall 授权机制，替代 npm 11 的 .npmrc allow-scripts，NATIVE_BUILD_PKGS 共享）。npm 仍用于：版本查询（npm view）、pnpm 引导（npm install pnpm，小树不受影响）、单包安装（preinstalled 更新）。版本 0.3.2 → 0.3.3。
## Alternatives considered

**给 npm 加超时/重试/降级（0.3.1/0.3.2 已做）**：只能"检测并快失败"，治不了根——npm 在 buildIdealTree/placeDep 阶段直接挂起（无网络请求、无输出、CPU 空转），任何超时都只是把"20 分钟静默"变成"3 分钟报错"，装不上就是装不上。**换成 Node 22/npm10/官方 npmjs registry**：全部实测同样挂起，排除环境/版本/镜像因素。**预置 dsh 进安装包**：体积爆炸、与官方 npm 包更新机制冲突，否决。**改 dsh 依赖树**（上游问题）：不是我们的代码，且等待上游不可控。**pnpm（最终采用）**：dsh 本身就是 pnpm monorepo（100+ 包密集互依），pnpm 天然能装；manager 已有 pnpm 机制（插件管理用），复用之。end-to-end 验证：空 runtime 冷安装真实 dsh@0.1.0-rc.7 仅 5.9s，插件注入、启动、URL 全通。
## Consequences

购买：dsh 安装从"npm 永远挂起（0.3.0 卡 511s、0.3.2 卡 180s）"变为"pnpm 数秒装完"；0.3.1/0.3.2 的 fetch 快失败/卡死检测/registry 降级/半截安装修复全部保留（runChild 统一承载）。代价：首次冷安装需要先 npm 装 pnpm（小树，1s）并额外下载 ~590 包到 <runtime>/.pnpm-store（自包含，占用略增）；runtime/node_modules 变为 pnpm isolated 布局（@deepseek-ai/dsh 是到 .pnpm 的符号链接）——已端到端验证 dsh 启动/插件注入/URL 均正常，插件解析走 profile 向上查找不受影响；测试 test-broken-install/test-install-stall 改为预置假 pnpm 桩适配。遗留：dsh 官方包若有其它 npm 无法解析的依赖变化仍会卡 npm（preinstalled 更新等单包安装仍用 npm，小树不受影响）；pnpm 11.22 的 allowBuilds 机制若变，需同步 ensurePnpmWorkspace。

