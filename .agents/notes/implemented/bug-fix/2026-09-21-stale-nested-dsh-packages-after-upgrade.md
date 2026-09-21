# Agent Note: stale-nested-dsh-packages-after-upgrade

Status: implemented

## Problem

版本地板让 dev 运行时真的执行了一次 0.1.5-rc.2 → 0.1.6-alpha.2 升级，升级本身成功（`installed @deepseek-ai/dsh: 0.1.6-alpha.2`），但随后 `dsh web` 启动即崩：`failed to import loader entry session-persistence-jsonl (@deepseek-ai/dsh-session-persistence-jsonl): ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './message-projections' is not defined by "exports"`。定位到 `<runtime>/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/node_modules/@deepseek-ai/` 下留着 3 个 `0.1.5-rc.2` 的内部包（`dsh-session-format-catalog` / `-v0-to-v1` / `-v1-to-v2`）：pnpm 的 hoisted 安装不清理嵌套目录，而 Node 解析嵌套副本优先于提升到根的新版，于是加载到旧版、缺 `./message-projections` 子路径导出。这不是本次改动引入的缺陷（任何跨版本升级都可能踩到），但自动地板升级让它第一次暴露在真实路径上。

## Decision

壳在**升级安装成功后**与**每次启动时**各检查一次 `node_modules/@deepseek-ai/*/node_modules/@deepseek-ai/*`：只要嵌套副本的版本与其父包版本不一致，就判定为上一版的残留并**只删掉那个副本目录**（`removeStaleNestedDshPackages`，判据来自「`@deepseek-ai/dsh-*` 全家族同版本发布」这一事实）。不重建 node_modules、不调用 pnpm、不需要 registry——因此离线也能修好。`dsh.json` 的 `devMode` 冻结时不动。`installDshUpdate` 里另加一条容忍：显式指定版本（`version` 参数）时，registry 元数据查询失败不再中止安装，改为用该显式版本继续（pnpm 可直接从本地 store 取），这条正是为「离线修复」服务的。

负向保证：不删除任何非嵌套残留的包；不动提升到根的正确版本；不修改 profile 或插件启用状态。启动路径上的修复发生在 dsh 拉起之前，因此修复后的树就是本次启动实际使用的树。
## Alternatives considered

**删掉整个 node_modules 重装**（壳在 0.3.4 处理 pnpm isolated 布局时用的就是这招）：能修好，但需要联网 + 跑 pnpm（分钟级），而且一旦重装失败就把一棵「只是有点脏、还能用」的树变成「没有 dsh」——实测踩到的正是这个风险面，所以只用于布局本身不兼容的场景，不用于这里。**升级前先 `rm -rf node_modules`（每次都干净装）**：彻底但让每次升级都付全量重装成本，且离线升级直接不可用。**接受现状、让用户在崩溃后自己删 runtime**：把可自动修复的故障留给用户手工处理，与壳已有的自愈风格不符。**只在升级后检查、不在启动时检查**：已经在装上的用户（含被本次改动自动升到地板的机器）必须等下一次升级才被修好——而他们此刻正处在「dsh 起不来」的状态，等不到下次升级。
## Consequences

代价：启动时多一次文件系统扫描（约 200 个顶层包目录，实测开销可忽略），以及一个启发式判据——「嵌套版本 ≠ 父包版本即视为残留」成立的前提是 `@deepseek-ai/dsh-*` 全家族同版本发布（当前事实，若上游将来允许家族内版本分叉，这条判据需要收紧为「不满足父包声明的 semver 范围」）。收益：跨版本升级不再可能因为 pnpm 的嵌套残留而黑屏；修复不需要联网、不需要 pnpm、不触碰主树。覆盖：scenario 9 造出父包 alpha.2 / 嵌套 0.1.5-rc.2 的树，断言检测→删除→提升副本与 dsh 本体不受影响→dsh 照常启动（registry 指向连不上的地址，证明不需要联网）；负向对照把删除改成 no-op，该断言立刻变红。未覆盖：真实 pnpm 在**下一次**安装时是否会重新创建这些嵌套副本——若会，则每次启动都会清理一次（自愈但每次多几毫秒），这一点留待后续升级时观察。

