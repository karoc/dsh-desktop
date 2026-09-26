# Contributing（dsh-desktop 开发约定）

单开发者项目，但流程与多人协作同构——CI 是第一道审查，PR 记录决策轨迹。

## 分支与合并（GitHub Flow）

- `main` 始终可发布；功能走短分支 + PR。
- 分支命名：`feat/<主题>` / `fix/<主题>` / `ci/<主题>` / `docs/<主题>`。
- PR 合并方式：**squash merge**（main 一提交一功能，提交信息 = PR 标题）。
- main 分支保护：需 PR + CI 快层（check + test）通过才可合并。
- main 保护 `enforce_admins` 关闭（单开发者不卡自己）：owner 直推技术上可绕过 PR，
  但**约定仍走 PR**——直推会触发全量 CI 兜底，仅限紧急 hotfix。
- 本地 `main` 只在合并后 `git pull` 同步，**不要**在本地 main 上直接提交功能。

## 提交规范（Conventional Commits）

```
<type>(<scope>): <中文描述>
```

- type：`feat` / `fix` / `refactor` / `docs` / `ci` / `test` / `chore`（+ 偶尔 `process`/`tools`）
- scope 小写（如 `shell`、`proxy`、`notify`、`dev-build`），可省略
- 标题 ≤ 72 字符，正文列要点；squash 后一条提交对应一个功能
- 规范直接驱动 release-please：`feat` → minor，`fix` → patch，自动 bump 版本 + CHANGELOG

> ⚠️ **release-please 解析陷阱（2026-09-20 实测，丢过一条 fix）**：提交**正文**里写
> `<base64url(sha256(host:port))>` 这类"尖括号 + 圆括号"的技术写法，会让
> conventional-commit 解析器报 `unexpected token '('`；release-please 遇到解析失败的
> 提交会**整条静默丢弃**——CHANGELOG / Release notes 少一条，版本号提升不受影响（其它
> 提交仍会 bump），所以不看日志根本发现不了。两条纪律：
> 1. 正文里避免尖括号与括号混用（写成 `sha256 of host:port` 之类）；
> 2. 合并 fix/feat 后**核对 release PR 是否列出了你的提交**（工作流日志搜
>    `commit could not be parsed`）。漏了就在 `CHANGELOG.md` 该版本段落手动补录
>    （注明"手动补录 + 原因"），再用 `gh release edit <tag> --notes-file <(node scripts/release-body.mjs <ver>)`
>    刷新 Release notes。

## 门禁（提交前本地跑）

```bash
npm test                          # 全量 15 套（行为 + 契约 + 副本一致性 + 清单/补丁目标门禁 + 升级标记）
node scripts/test-copy-consistency.mjs  # 副本一致性（改了 scripts/ 或 plugins/ 后先 npm run sync:resources）
node scripts/test-shell-chrome.mjs  # 壳契约（菜单 id ↔ ACTIONS ↔ lib.rs）
# Rust：cargo clippy -D warnings + cargo test --lib（CI 快层会跑；本地有工具链时先跑）
# 注意：cargo fmt --check **不在 CI 里**（build.yml 里被注释：60 处历史格式差异），
# 格式靠自律——禁止提交全仓格式化 diff（会淹没真实改动）。
```

CI 分层：PR 只跑快层（check + test，~5min）；main/tag 跑全量（windows 打包+冒烟、linux）。

**外部网络访问必须走 npm / curl 的传输，不要用裸 `fetch`**：Node 的 `fetch` 不读 npm 的
`.npmrc` 代理配置，且代理变量与 `NODE_USE_ENV_PROXY` 在进程启动时就被采样（脚本内再设无效），
所以在「目标站点只能经代理访问」的网络下它一律超时。2026-09-22 一天内因此踩到三处：
`release-check`（插件仓库）拦下发布、`audit-preinstalled` 在零数据上打印通过、
`fetch-node` 全新构建下不到 Node。判据 grep：`grep -rn "fetch(" scripts/`。

## 发布（release-please 自动）

1. 合并到 main 后，release-please 依据 Conventional Commits 自动：
   版本 bump（Cargo.toml / tauri.conf.json / package.json 三处同步）→ CHANGELOG.md → 提 release PR。
2. **合并 release PR 前，先在发布分支上跑一遍本地门禁**（见下「release PR 的门禁」）。
3. 合并 release PR（**只能 admin 合并**，原因见下）→ release-please 自动打 `vX.Y.Z` tag
   **并创建一个不带安装包的 GitHub Release**。
4. **在 tag 上派发一次构建**，否则 Release 永远没有安装包：
   ```bash
   gh workflow run build.yml --ref vX.Y.Z
   ```
   该 run 会编译 windows/linux 产物、把安装包挂到 Release、并用 `scripts/release-body.mjs`
   重写说明（说明里的 dsh 版本行由它查询 npm 得出）。约 15-20 分钟。
5. 不再手动改版本号、不打手动 tag（tag 归 release-please 所有）。

### release PR 的门禁（为什么必须 admin 合并）

release-please 是 bot 创建的 PR，它触发的 build run 状态是 **`action_required`**（GitHub 要求
人工批准 bot PR 的 workflow 才启动），因此 `check`/`test` **永远不会上报**，分支保护恒为
`BLOCKED`，`gh pr merge` 只会回 "base branch policy prohibits the merge"。人类 PR 的 build
则正常 success。所以发布 PR 的唯一合并路径是 `gh pr merge <n> --squash --admin`。

**替代验证（合并前必做）**：把发布分支取下来，跑

```bash
git fetch origin release-please--branches--main
git checkout FETCH_HEAD
node -e "…四处版本一致性…"        # package.json / .release-please-manifest.json / tauri.conf.json / Cargo.toml
grep -n "^## \[<version>\]" CHANGELOG.md
npm test                          # 15 套（另：npm run test:slow 跑安装卡死用例，约 3 分钟，不进 PR 门禁）
node scripts/audit-preinstalled.mjs
```

四处版本一致 + CHANGELOG 有该版本段 + 门禁全绿，才 admin 合并。2026-09-22（v0.11.0）是第一次
按这个流程走：本地门禁全绿 → admin 合并 → tag/Release 生成 → `workflow_dispatch` 补上三个平台
安装包。

> 过渡期说明：release-please 接管前发布的 `v0.3.x` 是手动 tag 流程；接入后以 release PR 为准。

## 开发版（同机并存调试）

开发版只本地构建（`D:\Dev\dsh-desktop-dev`，`npm run bundle:dev`），**不上 GitHub Actions**，
GitHub 只承载正式版。详见 README「开发版」小节与 `dsh-desktop-shell-dev` Skill。

## gh token（按项目隔离）

gh CLI 默认读全局 `~/.config/gh/hosts.yml`。本项目使用**项目专用 fine-grained PAT**
（仅授权 karoc/dsh-desktop，Permissions：Pull requests / Administration / Actions → write）：

1. 创建 token 后粘贴到 `~/.config/gh-dsh-desktop/token`（权限 600；`#` 注释行自动忽略）。
2. 进入项目目录时 direnv 自动 `export GH_TOKEN`（`.envrc`，已 gitignore，首次需 `direnv allow`）；
   或显式用包装命令 `./scripts/gh <args>`（不依赖 direnv）。
3. git push 走 SSH，不受 token 影响；CI 用 `secrets.GITHUB_TOKEN`，与个人 token 无关。

## 知识沉淀

- 改壳功能/新踩坑 → 更新 `.dsh/skills/dsh-desktop-shell-dev/SKILL.md`（加菜单、桥端点同步契约测试）
- 非平凡改动 → Agent Note（`.agents/notes/implemented/<class>/`）+ 看板卡片（三字段齐全）
