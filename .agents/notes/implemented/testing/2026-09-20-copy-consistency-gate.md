# Agent Note: copy-consistency-gate

Status: implemented

## Problem

本仓库存在多组「源 → 随包副本」关系，而 tauri 只打包 `src-tauri/resources/` 下的副本：`scripts/{server-manager,proxy}.mjs` → `resources/manager/`；`plugins/<dir>` → `resources/plugin/@dsh-desktop/<rel>`；`plugins/preinstalled/<pkg>` → `resources/preinstalled/<pkg>`。

这条不变量此前只存在于散文里（技能 `dsh-preinstalled-plugin-sync` §4 的手工 `diff -r`、ENGINEERING-NOTES 的提醒），靠"改完记得跑 sync-resources"维持。漏跑时**所有源侧检查仍然全绿**，只有安装包里的资源是旧的——2026-09-06 的 plugin-console 副本滞后就是这样发生的（悬浮按钮已从源码删掉，打包副本还带着）。

同一时期还有第二类**完全没有门禁**的静默失败：`.dsh/skills/*/SKILL.md` 的 `description` 若未加引号且含 ASCII `": "`，YAML 会把它读成嵌套 mapping，DSH 的 skill provider 只写一条服务端 warn 就丢弃整个文件——技能从模型目录和用户界面同时消失，没有任何可见报错（2026-09-20 两个技能中招，其中一个还是 harness 系统提示要求加载的技能）。

## Decision

新增 `scripts/test-copy-consistency.mjs`，并接入 `npm test`（`test:copies` 单跑）。因为 CI 的 PR 快层本来就跑 `npm test`，接进去即同时成为本地门禁与 CI 门禁，不需要额外 workflow。

检查项：① manager 两个真源文件逐一与副本逐字节比对（只比这两个——`sync-resources.mjs` 只拷它们，`scripts/` 下其它脚本本来就不随包）；② 每个 `plugins/<dir>` 与其 `resources/plugin/@dsh-desktop/<rel>` 副本目录镜像比对，`<rel>` 取自 bundle 自己的 `package.json` 的 `name`（源目录名不是包名），并拒绝非 `@dsh-desktop/*` 的包名；③ `plugins/preinstalled/<pkg>` 与副本目录镜像比对，**外加两个目录的集合双向相等**——这样"新插件加进了 `plugins/preinstalled` 却忘了加进 `sync-resources.mjs` 的 ship list"会以专门的消息失败，而不是悄悄不随包；④ `.dsh/skills/*/SKILL.md` 的 frontmatter 规则：未加引号的 `description` 不得含 `": "`。每条失败消息都带上修复命令（`npm run sync:resources`）。

验证按"门禁必须能失败"做双向：一致树 PASS；在 `resources/manager/proxy.mjs` 追加一个字节 → FAIL 且精确指向该文件；在 `resources/preinstalled/dsh-kanban/lib/index.js` 追加一个字节 → FAIL 且指向该文件；frontmatter 规则对加引号的 description PASS（无假阳性）、对未加引号的 FAIL（探针目录用后即删）。

未做的事（负向保证）：**不**校验随包副本与 npm 已发布 tarball 的内容一致性（那是 `audit-preinstalled.mjs` 的版本级职责，内容级校验是另一项工作）；**不**跑 tauri 构建；**不**遍历 `node_modules`；**不**把副本比对扩到 `~/.dsh/skills` 这类仓库外路径（那里已改用软链，见工作区 note）。

## Alternatives considered

**扩写 `test-shell-chrome.mjs`**：它已经锁了 manager 真源/副本一致。被否——那个文件的主题是壳顶栏契约（菜单 id ↔ ACTIONS ↔ lib.rs），把副本一致性和技能 frontmatter 塞进去会让失败面难以定位；独立脚本 + `test:copies` 单跑更清晰。

**只做 CI workflow 步骤**：被否——接进 `npm test` 让本地与 CI 免费同时获得，且与仓库既有的"门禁（提交前本地跑）"约定一致。

**只比对 preinstalled（即技能 §4 那一条 diff）**：被否——manager 与客户端插件副本的失败模式完全相同，2026-09-06 的事故正是发生在客户端插件上。

**用 YAML 解析库做 frontmatter 校验**：被否——仓库无 YAML 依赖，为一条结构性规则引入依赖不划算；规则本身（未加引号 + 含 `": "`）与 YAML 规范一致，等价且零依赖。

## Consequences

买了：漏跑 `sync:resources` 从"靠纪律"变成"测试红"；ship list 漏项有专门报错；技能 frontmatter 的静默丢弃类别有了回归门禁（这条规则此前谁都没查，两次事故都源于它）。

代价与边界：门禁只查**结构与字节**，查不了语义——例如"随包副本是否等于 npm 上那一版"仍需 `audit-preinstalled.mjs`（且它受版本门控限制），"技能内容是否该 bump `skill-version`"仍靠维护者自觉。

同提交的文档同步（遵循「文档与行为同步」纪律）：`CONTRIBUTING.md` 的门禁清单（原文写"全量 7 套"而当时实际已是 10 套，一并订正为 11 套并列出新门禁）、`README.md` 的本地验证清单（原文漏列 launcher-sweep / header-limit，现补全并加入 `npm run test:copies`）、技能 `dsh-preinstalled-plugin-sync` §4（说明该不变量已并入 `npm test`，手工 diff 降级为二次确认）。
