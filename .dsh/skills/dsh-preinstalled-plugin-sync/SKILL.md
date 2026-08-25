---
name: dsh-preinstalled-plugin-sync
description: Use when checking, auditing, or updating the shell-bundled "preinstalled" DeepSeek Harness plugins in the dsh-desktop repo (plugins/preinstalled/<pkg> → src-tauri/resources/preinstalled/<pkg>, version-locked with the shell release). Covers the version audit against npm latest, the npm-tarball sync with the shell's file conventions (README pruning, dsh-kanban skill assets), resource re-sync via scripts/sync-resources.mjs, verification, and the commit/push step. Triggers on: 检查/更新/同步预装插件版本、预装插件维护、preinstalled plugin sync.
---

# dsh-desktop 预装插件版本核查与同步技能

预装插件 = 壳**随包分发**的 dsh 外部插件 bundle，随桌面版本锁定（shell-shipped, version-locked）。本技能是「核查 → 更新 → 验证 → 提交」的完整操作手册，下次直接照做。

## 1. 架构背景（先理解再动手）

- **源**：`plugins/preinstalled/<pkg>/`（手工维护的精简拷贝，本仓库唯一真源）。
- **打包链**：`scripts/sync-resources.mjs` 把 `plugins/preinstalled/<pkg>` 原样拷到 `src-tauri/resources/preinstalled/<pkg>`，随 tauri `bundle.resources` 进安装包。
- **运行时**：`scripts/server-manager.mjs` 的 `ensurePreinstalled()` 把 `resources/preinstalled/*` 拷到 `<runtime>/node_modules/<pkg>`，记入 `<runtime>/dsh.json` 的 `preinstalled` 列表；预装包**不是** profile dependency，`dsh plugin` reconcile 永不触碰它们。
- **三层身份**：内置核心（通知插件，常开）＞ 预装可选（三个插件，**默认关**，控制台启用）＞ 用户自装（npm，profile dependency）。
- **三个预装插件**：`dsh-model-reasoning`、`dsh-kanban`、`dsh-turn-navigator`。
  - ⚠️ **包名/目录名陷阱**：仓库目录 `plugins/preinstalled/dsh-turn-navigator/` 对应 npm 包名 `dsh-turn-navigator`（本地 dev 仓库目录叫 `dsh-turn-nav`，但发布/插件 id 是 `dsh-turn-navigator`）。核对以 bundle 自身 `package.json` 的 `name` 为准，不要用目录名猜。

## 2. 核查（audit）

首选一行命令（只读，不写任何东西）：

```sh
node scripts/audit-preinstalled.mjs
```

输出语义化：`UPDATE` = 需要同步，`up-to-date` = 已最新；永远 exit 0（报告工具，不当门禁）。脚本逻辑：读 `plugins/preinstalled/<pkg>/package.json` 的 version → `fetch` npm registry `dist-tags.latest` → 对比。无 bundle 时提示。

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
   npm pack --cache ./.npm-cache dsh-model-reasoning@<latest> dsh-kanban@<latest> dsh-turn-navigator@<latest>
   tar -xzf <pkg>-<ver>.tgz -C <dir>
   ```

2. **按壳内精简约定拷入 `plugins/preinstalled/<pkg>/`**（保持文件集，别全量拖包）：

   | 文件 | 处理 |
   |---|---|
   | `package.json` / `cordis.patch.yml` / `lib/index.js` / `lib/client.js` / `LICENSE` | 原样拷贝（version、dsh.bundle.patch、dsh.client.inject、exports 都在这） |
   | `README.md` | 拷但要**去掉 `English \| [简体中文](README.zh.md)` 行及其后空行**（README.zh.md 不随壳发，留链接是坏链） |
   | `skills/kanban-use/SKILL.md` + `scripts/install-skill.mjs` | **仅 dsh-kanban**：0.2.x 的 host 半区（skill-sync）功能上随包分发技能（`skillSourceFile()` 解析 `<pkg>/skills/kanban-use/SKILL.md`），缺失会每次 dsh web 启动 warn「skill auto-install skipped」且手动兜底提示（引用 `<pkg>/scripts/install-skill.mjs`）失效 |
   | `README.zh.md` / `CHANGELOG.md` / `CONTRIBUTING.md` / `docs/` 图片 / `*.map` / `src/` / `tsdown.config.ts` | **不随包**（非运行时必要，保持精简） |

   任何已是最新的插件**不要动**（连 package.json 也别改 —— 版本/运行内容一致即视为已最新，diff 里出现的 package.json/README 差异是壳内精简，属正常）。

3. **重新同步 resources**：

   ```sh
   node scripts/sync-resources.mjs   # 输出 "resources synced"
   ```

## 4. 验证（缺一不可）

```sh
# 1) 所有随包 lib 语法合法
for f in dsh-model-reasoning dsh-kanban dsh-turn-navigator; do node --check plugins/preinstalled/$f/lib/index.js; node --check plugins/preinstalled/$f/lib/client.js; done

# 2) dsh-kanban bundle 含 skill-sync 字符串（防 rolldown 摇树）
grep -c "kanban-use" plugins/preinstalled/dsh-kanban/lib/index.js      # ≥1
grep -c "skill-version" plugins/preinstalled/dsh-kanban/lib/index.js   # ≥1

# 3) 源树与 resources 完全一致（sync 幂等）
diff -r plugins/preinstalled src-tauri/resources/preinstalled && echo IDENTICAL
```

再加一道心智校验：新版本相对旧版新增了什么**随包资产**（看 npm 包 `files` 字段与 tarball 实际内容）——新增了运行时被引用的文件就必须带上，别让「精简约定」砍掉功能（kanban 技能资产就是这次的教训）。

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
| 已最新插件仍想「顺手同步」 | 别动 —— lib/package.json 一致即已最新，差异只是壳内精简 |
| 只改了源树，用户问「怎么桌面里还是旧版」 | 讲清边界：runtime 拷贝走控制台更新（npm 源、用户门控），源树随下次发版生效 |
