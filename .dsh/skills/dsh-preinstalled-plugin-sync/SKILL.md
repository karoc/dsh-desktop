---
name: dsh-preinstalled-plugin-sync
description: "Use when checking, auditing, or updating the shell-bundled \"preinstalled\" DeepSeek Harness plugins in the dsh-desktop repo (plugins/preinstalled/<pkg> → src-tauri/resources/preinstalled/<pkg>, version-locked with the shell release). Covers the version audit against npm latest, the npm-tarball sync with the shell's file conventions (README pruning, dsh-kanban skill assets), resource re-sync via scripts/sync-resources.mjs, verification, and the commit/push step. Triggers on: 检查/更新/同步预装插件版本、预装插件维护、preinstalled plugin sync."
---

# dsh-desktop 预装插件版本核查与同步技能

预装插件 = 壳**随包分发**的 dsh 外部插件 bundle，随桌面版本锁定（shell-shipped, version-locked）。本技能是「核查 → 更新 → 验证 → 提交」的完整操作手册，下次直接照做。

## 1. 架构背景（先理解再动手）

- **源**：`plugins/preinstalled/<pkg>/`（手工维护的精简拷贝，本仓库唯一真源）。
- **打包链**：`scripts/sync-resources.mjs` 把 `plugins/preinstalled/<pkg>` 原样拷到 `src-tauri/resources/preinstalled/<pkg>`，随 tauri `bundle.resources` 进安装包。
- **运行时**：`scripts/server-manager.mjs` 的 `ensurePreinstalled()` 把 `resources/preinstalled/*` 拷到 `<runtime>/node_modules/<pkg>`，记入 `<runtime>/dsh.json` 的 `preinstalled` 列表；预装包**不是** profile dependency，`dsh plugin` reconcile 永不触碰它们。
- **三层身份**：内置核心（通知插件，常开）＞ 预装可选（四个插件，**默认关**，控制台启用）＞ 用户自装（npm，profile dependency）。
- **四个预装插件**：`dsh-model-reasoning`、`dsh-kanban`、`dsh-turn-navigator`、`@karoc/dsh-smoothly-opencode-session`（host-only，OpenCode `x-opencode-session` 会话头；2026-09-19 随壳加入）。
  - ⚠️ **包名/目录名陷阱**：仓库目录 `plugins/preinstalled/dsh-turn-navigator/` 对应 npm 包名 `dsh-turn-navigator`（本地 dev 仓库目录叫 `dsh-turn-nav`，但发布/插件 id 是 `dsh-turn-navigator`）。核对以 bundle 自身 `package.json` 的 `name` 为准，不要用目录名猜。
  - ⚠️ **scoped 包名**：`@karoc/dsh-smoothly-opencode-session` 的 npm 名带 scope，仓库目录却是不带 scope 的 `plugins/preinstalled/dsh-smoothly-opencode-session/`。运行时拷贝路径由 bundle 的 `package.json` 决定（`<runtime>/node_modules/@karoc/…`），`sync-resources.mjs` 的 ship list 写的是**目录名**；`scripts/test-control-plane.mjs` 覆盖了这条路径。
  - ⚠️ **dsh 升级保护名单是派生的**：`installDshUpdate` 的 `PROTECTED` 由 `preinstalledTopLevelEntries(resourceDir)` 从各 bundle 的 `package.json` 现算（scoped 包贡献其 scope 目录 `@karoc`，非 scoped 贡献包名），**不要**再手写插件名单——手写一定会漏掉 scope 目录那一层，dsh 升级时会把用户的预装包 prune 掉。

## 2. 核查（audit）

首选一行命令（只读，不写任何东西）：

```sh
node scripts/audit-preinstalled.mjs
```

输出语义化：`UPDATE` = 需要同步，`up-to-date` = 已最新；永远 exit 0（报告工具，不当门禁）。**两层比对**，因为只比版本号有盲区：

- **版本级**：读 `plugins/preinstalled/<pkg>/package.json` 的 version → **`npm view`**（走 `.npmrc` 的 registry / 代理 / 鉴权，与发布同一条路）取 `dist-tags.latest` → 对比。无 bundle 时提示。**不要改回 `fetch`**：它不读 npm 的代理配置，在「npmjs 只能经代理访问」的网络下会全部超时，见下方 NOT VERIFIED 条。
- **内容级**：对「随包逐字拷贝」的资产（`lib/*.js`、`cordis.patch.yml`、`skills/*/SKILL.md`）与**同版本的已发布 tarball** 做 sha256 比对（tarball 由 `npm pack` 取到系统临时目录再读入内存 gunzip + 极简 tar 解析：临时目录必定删除，npm cache 固定在工作区 `.tmp-investigate/.npm-cache`）。这一层专治版本级的盲区：手工同步拷错/拷漏时版本号照样相等，旧逻辑会判 `up-to-date`；现在报 `content: ⚠️ <file> DRIFT`。四个预装包当前实测 12/12 资产与已发布 tarball 逐字节一致。
- **未能验证 ≠ 通过**：registry 不可达（或 npm 查询失败）时每一行都取不到数据，此时打印 `⚠️ NOT VERIFIED — N of M bundle(s) could not be checked` 并逐行列出原因，**不再**打印「all preinstalled plugins are at the latest published version, with matching content」。旧逻辑只看 `versionUpdates`/`contentDrifts` 两个计数器，全部失败时它们都是 0 → 在**未知数据**上给出绿色结论（2026-09-22 实测并修）。退出码仍是 0（报告工具、不当门禁），但输出不再可能被误读为通过。`DSH_PREINSTALLED_REGISTRY` 可覆盖 registry，是负向对照用的缝。
- **技能 frontmatter**：随包 `skills/*/SKILL.md` 若 frontmatter 无法解析（未加引号的 `description` 含 `": "`），单独报 `skill: ⚠️ …`。这属于**上游包缺陷，同步修不了**，只能发新版本 —— 正是 2026-09-20 那次技能被 DSH 静默丢弃的类别。

不想用脚本时手工等价：

```sh
curl -s https://registry.npmjs.org/<pkg> | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d)['dist-tags']?.latest))"
```

**纪律：registry 探测一律 `fetch`/`curl` 直查，绝不 `npm view`** —— npm CLI 对不存在版本/索引未同步时每次打 9 行 E404 错误块，污染输出（dsh-kanban/dsh-model-reasoning 发布实录）。`404` = 未发布/未同步，不是失败。

## 3. 更新（以 npm latest tarball 为权威基准）

> **基准决策（2026-08-25 起）**：同步目标 = **npm 已发布 latest 的官方 tarball**。历史惯例是「源仓库 HEAD 提交态」（曾为带未发布提交而采用），但三个插件仓库现已干净地停在发布 tag 且与 tarball 逐字节一致，两条基准收敛；「最新版」的权威定义是 npm 发布版。若某插件仓库 HEAD 有**未发布**的功能且用户明确要随壳带上，需先与用户确认，再改用仓库 HEAD（`files` 白名单内的文件）。

1. **拉 tarball**（⚠️ 沙箱下 `~/.npm` 只读，`npm pack` 必须指定工作区内的 cache，否则 EROFS）：

   ```sh
   mkdir -p .tmp-preinstalled && cd .tmp-preinstalled
   npm pack --cache ./.npm-cache dsh-model-reasoning@<latest> dsh-kanban@<latest> dsh-turn-navigator@<latest> @karoc/dsh-smoothly-opencode-session@<latest>
   tar -xzf <pkg>-<ver>.tgz -C <dir>
   ```

2. **按壳内精简约定拷入 `plugins/preinstalled/<pkg>/`**（保持文件集，别全量拖包）：

   | 文件 | 处理 |
   |---|---|
   | `package.json` / `cordis.patch.yml` / `lib/index.js` / `lib/client.js` / `LICENSE` | 原样拷贝（version、dsh.bundle.patch、dsh.client.inject、exports 都在这） |
   | `README.md` | 拷但要**去掉整行含 `README.zh.md` 的那一行及其后的空行**（README.zh.md 不随壳发，留链接是坏链）。⚠️ **不要把格式写死**：各仓不同 —— kanban / model-reasoning 是 `English \| [简体中文](README.zh.md)`，**turn-nav 是 `**English · [简体中文](README.zh.md)**`**（粗体 + 间隔号），**opencode 的 README 根本没有这一行**（规则对它必须是空操作）。2026-09-25 预演时用固定管道式正则，turn-nav 的 README 就残留了坏链。 |
   | `skills/kanban-use/SKILL.md` + `scripts/install-skill.mjs` | **仅 dsh-kanban**：0.2.x 的 host 半区（skill-sync）功能上随包分发技能（`skillSourceFile()` 解析 `<pkg>/skills/kanban-use/SKILL.md`），缺失会每次 dsh web 启动 warn「skill auto-install skipped」且手动兜底提示（引用 `<pkg>/scripts/install-skill.mjs`）失效 |
   | `README.zh.md` / `CHANGELOG.md` / `CONTRIBUTING.md` / `docs/` 图片 / `*.map` / `src/` / `tsdown.config.ts` | **不随包**（非运行时必要，保持精简） |

   任何已是最新的插件**不要动**（连 package.json 也别改 —— 版本/运行内容一致即视为已最新，diff 里出现的 package.json/README 差异是壳内精简，属正常）。

3. **重新同步 resources**：

   ```sh
   node scripts/sync-resources.mjs   # 输出 "resources synced"
   ```

## 3.5 同步有脚本了（2026-09-26 起，优先用它）

```bash
npm run sync:plugin -- dsh-model-reasoning            # 同步 npm latest
npm run sync:plugin -- dsh-model-reasoning 0.2.6      # 指定版本
npm run sync:plugin -- dsh-kanban 0.2.8 --check        # 只比对不落盘（演练）
```
`scripts/sync-preinstalled-plugin.mjs` 把本文约定固化：下载 tarball → 按**包作者在 tarball `package.json` 里声明的 `files`**（registry 元数据不可靠，abbreviated packument 会省略它）减去壳的 denylist（README.zh.md / CHANGELOG / CONTRIBUTING / *.map / docs/）+ npm 隐式文件（package.json / README / LICENSE）→ README 裁剪（删含 `README.zh.md` 的整行**及其后的空行**，保留其前的空行）→ 与现有拷贝逐文件比对 → 落盘 → 跑 `sync-resources.mjs`。host-only 插件（无 `lib/client.js`）同样支持。

**发布前后各一条命令**（发布未完成也能先同步 —— 壳的预装插件不从 npm 取，而 `npm publish` 上传的就是 `npm pack` 的产物，构建确定性已验证：同一 tag 连打三次 sha1 一致）：
```bash
npm pack                                       # 在插件仓：得到待发布 tarball
node scripts/sync-preinstalled-plugin.mjs <pkg> --tarball <该 tgz>          # 发布前：先把壳恢复可用
node scripts/sync-preinstalled-plugin.mjs <pkg> <ver> --check               # 发布后：从 registry 复核，期望零 diff
```
发布后那次 `--check` 若不为零 diff ⇒ **以 registry 上的字节为准重跑同步**（说明本地构建与上传产物不一致，必须查原因）。

**演练判据（务必先跑）**：对一个"已发布且已是最新"的版本做 `--check`，结果必须**零 diff**。这条演练在首次落地时立刻抓出三处偏差：① 我把链接行**之前**的空行也删了（约定是删其后的）→ 标题与徽章贴在一起；② 我最初的硬编码收文件规则会**删掉 dsh-kanban 的技能资产**（`skills/kanban-use/SKILL.md`、`scripts/install-skill.mjs`）——正是本文档记过的历史事故，改按作者 `files` 收集后消失；③ host-only 插件没有 `lib/client.js`，必需文件表写死会误报。四个预装包（model-reasoning / kanban / turn-navigator / opencode-session）演练现已全部零 diff。

## 4. 验证（缺一不可）

```sh
# 1) 所有随包 lib 语法合法（host-only 插件只有 lib/index.js）
for f in dsh-model-reasoning dsh-kanban dsh-turn-navigator dsh-smoothly-opencode-session; do node --check plugins/preinstalled/$f/lib/index.js; [ -f plugins/preinstalled/$f/lib/client.js ] && node --check plugins/preinstalled/$f/lib/client.js; done

# 2) dsh-kanban bundle 含 skill-sync 字符串（防 rolldown 摇树）
grep -c "kanban-use" plugins/preinstalled/dsh-kanban/lib/index.js      # ≥1
grep -c "skill-version" plugins/preinstalled/dsh-kanban/lib/index.js   # ≥1

# 3) 源树与 resources 完全一致（sync 幂等）
#    该不变量现已并入 npm test 的「副本一致性」门禁（scripts/test-copy-consistency.mjs，
#    CI 的 PR 层也跑）：它同时覆盖 manager 真源副本、桌面客户端插件副本、预装 ship list
#    完整性，以及 .dsh/skills/*/SKILL.md 的 frontmatter 可解析性。这条 diff 作二次确认：
diff -r plugins/preinstalled src-tauri/resources/preinstalled && echo IDENTICAL
```

再加一道心智校验：新版本相对旧版新增了什么**随包资产**（看 npm 包 `files` 字段与 tarball 实际内容）——新增了运行时被引用的文件就必须带上，别让「精简约定」砍掉功能（kanban 技能资产就是这次的教训）。

**流程已端到端预演过（2026-09-25）**：在 dsh-desktop@HEAD 的 scratch clone 里用当时已发布的四个版本走完整条链（`npm pack` → 按 §3 拷入 → `node scripts/sync-resources.mjs` → §4 的验证），结果 `git status` **完全干净**。判据就取这个：**同步「已发布且已是最新」的版本应当零 diff**；出现 diff 就是拷贝约定没对齐（README 裁剪格式的坑正是这样发现的）。

## 5. 提交推送

按仓库约定（conventional commit）：

```sh
git add plugins/preinstalled src-tauri/resources/preinstalled .agents/notes/implemented/process/2026-08-25-*.md KANBAN.json
git commit -m "chore(plugins): sync preinstalled bundles to latest — model-reasoning <v>, kanban <v>"
git push origin main
```

提交说明要点：改了哪些插件到哪个版本、是否带了技能资产、验证结论。**边界要讲清**：本次只改源树捆绑内容，**不影响已安装桌面应用的 runtime 拷贝**（那由控制台「检查预装插件更新」用户门控地从 npm 更新）；发布新的 dsh-desktop 版本后才随安装包生效。每轮同步写一条 Agent Note（`.agents/notes/implemented/process/<date>-preinstalled-plugin-sync-v<ver>.md`），记录基准、改动、放弃的方案。

## 6. 维护本技能（下次复用前先看这里）

- **唯一真源**：仓库 `.dsh/skills/dsh-preinstalled-plugin-sync/SKILL.md`（工作区技能目录，与 `windows-desktop-shell-debugging` 同款），随 dsh-desktop 版本控制。
- **接入（双通道）**：
  - 工作区级：`.dsh/skills/` 下即生效（dsh-desktop 工作区会话可发现）；
  - 全局：`~/.agents/skills/dsh-preinstalled-plugin-sync` 是指向 `.dsh/skills/dsh-preinstalled-plugin-sync` 的 **symlink**（kanban-use 同款模式，保证跨工作区/新会话也能在技能目录里出现）。新机器/新 clone 后重链：

  ```sh
  ln -s /home/karoc/dsh-desktop/.dsh/skills/dsh-preinstalled-plugin-sync ~/.agents/skills/dsh-preinstalled-plugin-sync
  ```

- **更新流程**：改 `.dsh/skills/dsh-preinstalled-plugin-sync/SKILL.md` → `git add .dsh/skills/` 提交推送 → 确认 symlink 仍指向该路径（内容走 symlink，天然零漂移）。技能本身有内容变更时，顺带更新本节的「决策」记录。
- **配套脚本**：`scripts/audit-preinstalled.mjs`（核查）；更新流程目前是手工按 §3 走 —— 若下次发现更新步骤可脚本化，优先把脚本沉淀进仓库并在这里补引用。

## 7. 常见坑速查

| 坑 | 解法 |
|---|---|
| `npm pack` 报 EROFS（`~/.npm` 只读） | 沙箱/只读 home 下必须 `--cache <工作区内目录>`（如 `.tmp-preinstalled/.npm-cache`） |
| registry 探测打 E404 错误块 | 别用 `npm view`，`fetch`/`curl` 直查；404 = 未发布/未同步 = 预期 |
| 目录名 ≠ npm 包名（dsh-turn-nav vs dsh-turn-navigator） | 一律读 bundle 自身 `package.json` 的 `name` |
| 精简约定砍掉了运行时被引用的资产（kanban 技能） | 每次对照 npm 包 `files`/tarball 内容，新增随包资产要带上 |
| README 双语链接行格式因仓而异（管道式 / 粗体·式 / 没有） | 用「删除含 `README.zh.md` 的整行」这条通用规则，别写死某种格式 |
| 已最新插件仍想「顺手同步」 | 别动 —— lib/package.json 一致即已最新，差异只是壳内精简 |
| 只改了源树，用户问「怎么桌面里还是旧版」 | 讲清边界：runtime 拷贝走控制台更新（npm 源、用户门控），源树随下次发版生效 |

## 6.5 预装插件与 dsh 版本存在**服务级耦合**（2026-09-26 新增，同步前必查）

插件不是"任何 dsh 版本都能跑"：客户端服务的增删会直接决定插件能否激活，而 dsh 的 web boot 对**未激活**的条目是 fail-closed —— 一个插件 pending 就会让整个 Web UI 停在「Failed to load plugins」（不是"少个功能"，是"打不开"）。

实录：dsh **0.1.7 移除**了客户端服务 `settingsScope`（0.1.6 有 18 个文件、0.1.7 为 0），改用 `settingsSchema` + `configForms`；预装 `dsh-model-reasoning` 0.2.4 仍在等 `settingsScope` → 真机 0.1.7 下 UI 全黑（诊断页给出 `pending (waiting for service: settingsScope)`）。插件仓 0.2.6 已迁移（`ctx.configForms.get(ns)`），因此 **0.2.5+ 要求 dsh ≥ 0.1.7**。

**同步插件时必做的三件事**：
1. 读目标插件版本的 `package.json` 里对 `@deepseek-ai/dsh` 的 peer 声明（可能是 optional peer）与 README 的兼容性小节，确认它要求的 dsh 下限；
2. 与壳的 `scripts/server-manager.mjs` 里 `MIN_DSH_VERSION` 对照：**壳会把 dsh 抬到哪个版本**，插件的地板必须 ≤ 它；
3. 同步后做一次真机/等价验证：dsh 起来后页面**不出现** `Failed to load plugins`，插件的设置分区/控件真的渲染（`scripts/verify-dev-ui.ps1 -Action dump` 找分区标题即可，无需人工看）。

⚠️ 反向风险同样存在：把**新插件**发给**旧 dsh**（地板升级失败、离线、用户锁在旧版）会得到同样的 pending + 卡死界面。所以"插件版本"与"dsh 地板"要在同一版壳里成对抬升。

**壳仓已有静态门禁替你拦这一类**：`scripts/test-plugin-dsh-compat.mjs`（在 `npm test` 链尾）会 ① 检查已移除客户端服务在插件产物里的残留用法（去注释后匹配，按**版本行**判移除是否生效）② 检查插件声明的 `@deepseek-ai/dsh*` peer 地板是否被壳的 `MIN_DSH_VERSION` 满足（缺声明只警告）。它当前对 `dsh-model-reasoning@0.2.4` **是红的**——这是刻意的：插件 0.2.4 + 地板 0.1.7-rc.2 装出来就是打不开的 UI；同步到 0.2.6 后应自动转绿。同步完成后**先跑这道门禁**再看别的。
