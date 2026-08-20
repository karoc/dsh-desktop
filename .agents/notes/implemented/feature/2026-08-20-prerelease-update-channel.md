# Agent Note: prerelease-update-channel

Status: implemented

## Problem

用户问 dsh 能否从 GitHub 安装（npm 只有 rc.7、GitHub 是 rc.8）。查实：npm 已发布 0.1.0-rc.8，只是 dsh 团队把它标在 `next`（预发布）tag 而未提升 `latest`——不是发布滞后，是 tag 策略。从 GitHub 安装不可行（monorepo 结构，见 Alternatives）。用户想要的是"有更新的预发布版本时能在 UI 提示、想升就升"。于是做预发布更新通道：管理界面在有 next 新版本时提示可升。

## Decision

给 dsh 版本解析加"预发布通道"：manager 的 resolveRemoteVersions 一次查询 dist-tags.latest 与 dist-tags.next 两个 tag，模块级 latestVersion/nextVersion；update-status 事件/接口新增 next、nextAvailable（next>latest 且 next>current 时为真，versionGt 做 rc 感知比较）；update-dsh 命令与 /update-dsh 端点支持可选 version 目标（装指定版本如 0.1.0-rc.8）；插件控制台 dsh 更新区块新增分支：updateAvailable 时显示稳定更新，否则 nextAvailable 时显示"→ next（预发布）"+ 带 data-version 的升级按钮，点击 POST /update-dsh {version}；zh/en 各加 prerelease 文案。版本 0.3.4 → 0.3.5。端到端验证：npm view 双字段返回 dist-tags.X 键（已按此解析），manager update-status 实测 {"latest":"0.1.0-rc.7","next":"0.1.0-rc.8","nextAvailable":true}；test-plugin-console 新增场景 5b（预发布卡渲染 + 按钮带版本 + 点击传 version），全绿。
## Alternatives considered

**改成从 GitHub 安装 dsh**（用户最初提议）：不可行——deepseek-ai/deepseek-harness 是 monorepo，仓库根包是 @deepseek-ai/dsh-root 不是 @deepseek-ai/dsh；npm/pnpm 的 git 依赖不支持子目录（dsh 在 apps/cli）；apps/cli 有 71 个 workspace:* 依赖，必须克隆整个仓库 + pnpm workspace 全量安装 + 构建。**resolveRemoteVersions 只读 dist-tags.latest**（现状）：rc8 在 next tag 下永远看不到。**默认就追 next（最高版本）**：把所有人推上预发布，可能拿到不稳定构建，被用户否决（用户明确要"UI 提示、想升才升"）。最终：manager 同时解析 latest 与 next，update-status 携带 nextAvailable，控制台显示"预发布可升"卡片，点升级才装指定版本。
## Consequences

购买：npm 有预发布（next tag，如 0.1.0-rc.8）但 latest 停在 rc.7 时，插件控制台会显示"当前 rc.7 → rc.8（预发布）"+ 一键升级按钮；点击才安装指定版本，默认仍用稳定 latest——追新与稳定兼得。代价：控制台 dsh 更新区块多一个分支（u.nextAvailable），Rust UpdateStatus 结构 + 3 处序列化 + /update-dsh 支持 version 参数；manager 多一次 npm view 两个字段的查询（dist-tags.latest + dist-tags.next，键名是带路径的 dist-tags.X，next 缺失时折叠为纯字符串——解析已处理）；versionGt 只覆盖 rc 数字比较，未来若出正式版>rc 的语义（Infinity 处理）已兼容。

