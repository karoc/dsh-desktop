# Agent Note: dev-process-standardization

Status: implemented

## Problem

项目此前 main 直推、CI 每次 push 全量 25 分钟、无 clippy/fmt 门禁、版本三处手动维护、无 changelog、main 上 linux-smoke 长期红、gh token 全局唯一且权限不足无法走 PR 流程。用户要求按经过实践检验、符合未来趋势且贴合项目的方式做开发流程规范化调整。

## Decision

dsh-desktop 开发流程已切换为 GitHub Flow + 自动化发布，全链路实测通过：main 受保护（需 PR + check/test 快层，禁 force push/删除），PR squash 合并；build.yml 分层（PR 触发快层 check[含 clippy -D warnings，fmt --check 暂缓待格式化 PR] + test；main/tag 触发全量 windows/linux/linux-smoke-canary）；release-please.yml（push main + workflow_dispatch）用 release-please-action@v4 自动 bump 三处版本（extra-files jsonpath：package.json/tauri.conf.json `$.version`、Cargo.toml `$.package.version`——17.x 起 toml 也用 jsonpath 字段）→ CHANGELOG.md → release PR → 合并即打 v* tag → build.yml release job 自动发 GitHub Release；仓库 Actions 设置 can_approve_pull_request_reviews=true（API 设置，default_workflow_permissions 保持 read）；项目专用 fine-grained PAT 按目录隔离（~/.config/gh-dsh-desktop/token 600 权限 + .envrc direnv 注入 + scripts/gh 兜底），CI 用 secrets.GITHUB_TOKEN 与个人 token 无关。
## Alternatives considered

**手动 tag + release-check 脚本（C2）**：用户直接选定 release-please 全自动方案（C1），未采用保守路线。**fmt 门禁立即启用**：60 处存量格式漂移会阻塞合并，先移除并注释恢复条件（一次性格式化 PR 后恢复），clippy 保留并修掉 9 处存量 lint。**全局 token 加权限**：用户倾向按项目隔离，采用 GH_TOKEN+direnv/scripts/gh 双通道，全局 token 不动。**release-please 16.x 兼容写法（toml-path）**：实测 action 实际跑 17.3.0，toml-path 已废，统一 jsonpath 字段（含 GenericToml 也用 JSONPath 语法）。
## Consequences

代价：规范化后所有 main 改动必须走 PR（单开发者自审 + CI 快层门禁，合并成本略增）；fmt 门禁暂缺，格式化欠账靠用户 Windows 侧一次 cargo fmt 偿还；release-please 接管版本号后，三处版本文件不能再手动改（release PR 是唯一途径）；linux-smoke canary 永远红是预期（注释已解释，勿再当故障）。收益：PR #1-3 已实际演练完整闭环（分支→PR→快层 CI→squash→main 全量→release-please 自动 release PR），release PR #4（0.4.0）三处版本同步+CHANGELOG 正确；ci 反馈从 25min 降到 ~5min；clippy 门禁消除存量 lint；项目专用 token 机制（~/.config/gh-dsh-desktop/token + .envrc + scripts/gh）按项目隔离不污染全局；KANBAN 零缺字段。

