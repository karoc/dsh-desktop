# Agent Note: preinstalled-smoothly-opencode-session

Status: implemented

## Problem

壳内预装插件此前只有三个（dsh-model-reasoning / dsh-kanban / dsh-turn-navigator）。新插件 @karoc/dsh-smoothly-opencode-session 0.1.0 是 host-only bundle：在 llm/stream 上给 OpenCode / OpenCode Go 路由补 x-opencode-session 会话头——自 2026-09-05 起缺它会被网关拒为 400 MissingSessionID，且该头是会话粘性 + prompt cache 命中的依据。用户要求把它按「预装」处理（随壳分发、控制台一键启用），而不是让用户自己 npm 安装；它是四个预装包里第一个 scoped 包名，正好撞上壳内几处「按目录名/顶层名硬编码」的假设。

## Decision

以 npm 已发布 tarball 为权威基准（0.1.0；package.json / cordis.patch.yml / lib/index.js 与插件仓库 HEAD 018e123 逐字节一致），按壳内精简约定落 plugins/preinstalled/dsh-smoothly-opencode-session/：只随包 package.json + cordis.patch.yml + lib/index.js + LICENSE + README.md（该 README 无 "English | [简体中文]" 切换行，无需裁剪）；README.zh.md / CHANGELOG.md / CONTRIBUTING.md 不随包。host-only 意味着没有 lib/client.js、没有 dsh.client manifest。scripts/sync-resources.mjs 的 ship list 写**目录名**并同步到 src-tauri/resources/preinstalled/；运行时落点由 bundle 自身 package.json 的 name 决定，所以拷贝进的是 <runtime>/node_modules/@karoc/dsh-smoothly-opencode-session（ensurePreinstalled 用 join(node_modules, name)，天然 scope-correct）。关键结构修正：installDshUpdate 里保护插件不被 dsh 安装 prune 的 PROTECTED 列表改为从 bundle 派生（新增 preinstalledTopLevelEntries(resourceDir)：scoped 包贡献其 scope 目录 @karoc，非 scoped 贡献自身包名），不再手写第二份名单——手写名单每加一个预装包都要改一处，且一定会漏掉 scope 目录这一层。控制台（src/plugin-console.js 与 plugins/dsh-plugin-console/client.js 两处 DESC 双语简介）显式收录该插件简介；默认关闭（D3：启用 = 包名写入 web profile 的 dsh.profile.bundles），Rust 侧零改动（preinstalled 列表由 runtime dsh.json 动态下发）。scripts/test-control-plane.mjs 新增断言覆盖首个 scoped 预装包的运行时落点（node_modules/@karoc/…）与 preinstalled-updates 条目；README、docs/PLUGIN-CONSOLE-PLAN.md（D11）、.dsh/skills/dsh-preinstalled-plugin-sync/SKILL.md 同步。
## Alternatives considered

**按插件仓库 HEAD 同步**——拒绝：沿用 2026-08-25 定的「npm 已发布 latest tarball 为权威基准」；两条基准本次收敛，没有理由破例。**默认启用该插件**——拒绝：预装插件一律默认关（D3）；该头只对 OpenCode 路由有意义，对其它 provider 多发一个头是噪音，启用权应留给用户。**随包带 README.zh.md / CHANGELOG / CONTRIBUTING**——拒绝：既有精简约定（README.zh.md 不随壳发，留链接就是坏链）。**把 '@karoc' 直接加进硬编码 PROTECTED 列表**——拒绝：那只是把「每个预装包都要手改一处」的漂移面再扩大一次（本仓库已经因「真源/副本漂移」出过 0.5.0/0.6.0 打包旧版事故）；改成从 bundle 派生，新增/改名预装包不再需要动 PROTECTED。**改 Rust 侧或给插件补 peer/依赖声明**——不必要：preinstalled 名单与简介都从 runtime 动态读，host-only 插件也没有 client 半区需要注入。
## Consequences

发布新桌面版本后，ensurePreinstalled 会把该 bundle 拷进 <runtime>/node_modules/@karoc/dsh-smoothly-opencode-session，dsh.json 的 preinstalled 变成四项，插件管理窗口渲染四行预装插件（默认关，打开开关后重启服务生效）；此后 dsh 升级（pnpm install --prefix runtime 会 prune 纯拷贝包）不再有丢掉这个 scoped 包的风险。代价与边界：PROTECTED 现在依赖 resources/preinstalled 在安装时存在（随包资源，缺失时退化为只剩 @dsh-desktop —— 但那种情况下也没有 bundle 可保护，ensurePreinstalled 会直接报 no preinstalled bundles）；本次只改源树捆绑内容，**不影响已安装桌面应用的 runtime 拷贝**（那仍由控制台「检查预装插件更新」用户门控地从 npm 更新）；npm 上出现更新版本时由控制台提示、用户点击才升级，壳内不带自动升级。验证：audit-preinstalled 四个包全部 up-to-date、node --check 全 lib、diff -r plugins/preinstalled vs resources/preinstalled 一致、manager/console 副本 cmp 一致、npm test 9 套全绿（含新增 scoped 断言）。

