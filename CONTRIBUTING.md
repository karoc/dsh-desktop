# Contributing（dsh-desktop 开发约定）

单开发者项目，但流程与多人协作同构——CI 是第一道审查，PR 记录决策轨迹。

## 分支与合并（GitHub Flow）

- `main` 始终可发布；功能走短分支 + PR。
- 分支命名：`feat/<主题>` / `fix/<主题>` / `ci/<主题>` / `docs/<主题>`。
- PR 合并方式：**squash merge**（main 一提交一功能，提交信息 = PR 标题）。
- main 分支保护：需 PR + CI 快层（check + test）通过才可合并。
- 本地 `main` 只在合并后 `git pull` 同步，**不要**在本地 main 上直接提交功能。

## 提交规范（Conventional Commits）

```
<type>(<scope>): <中文描述>
```

- type：`feat` / `fix` / `refactor` / `docs` / `ci` / `test` / `chore`（+ 偶尔 `process`/`tools`）
- scope 小写（如 `shell`、`proxy`、`notify`、`dev-build`），可省略
- 标题 ≤ 72 字符，正文列要点；squash 后一条提交对应一个功能
- 规范直接驱动 release-please：`feat` → minor，`fix` → patch，自动 bump 版本 + CHANGELOG

## 门禁（提交前本地跑）

```bash
npm test                          # 全量 7 套（行为 + 契约）
node scripts/test-shell-chrome.mjs  # 壳契约（菜单 id ↔ ACTIONS ↔ lib.rs）
# Rust：cargo fmt --check + cargo clippy -D warnings（CI 快层会跑，本地有工具链时先跑）
```

CI 分层：PR 只跑快层（check + test，~5min）；main/tag 跑全量（windows 打包+冒烟、linux）。

## 发布（release-please 自动）

1. 合并到 main 后，release-please 依据 Conventional Commits 自动：
   版本 bump（Cargo.toml / tauri.conf.json / package.json 三处同步）→ CHANGELOG.md → 提 release PR。
2. 审阅合并 release PR → 自动打 `vX.Y.Z` tag → 现有 CI 全量构建 + 自动发 GitHub Release（带安装包）。
3. 不再手动改版本号、不打手动 tag。

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
