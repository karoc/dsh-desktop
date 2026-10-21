# Agent Note: shell-release-install-verify

Status: implemented

## Problem

在这台机器上"发一个壳版本 → 装到 dev → 验一遍 → 装到正式版"这条操作反复出错且每次都要重新摸索：下载被截断（`gh release download` 走代理 240s 只拿到 6.8MB/28.2MB，`curl -x` 到 `github.com:443` 直接 0 字节 60s 超时）；dev 版构建位置搞错（WSL 没有 makensis，Tauri NSIS 必须在 Windows 侧）；装完不知道验什么才算"没问题"（只看进程活着会把"服务没起来"当成通过）；以及没有先 dev 后正式版的硬规矩，导致 0.20.0 差点直接覆盖用户正在用的 0.19.0。

## Decision

固化一条可重复的发布-验证流程，四段都带硬判据。**下载**：`github.com:443` 经代理不可用 ⇒ 改走 GitHub API 资产端点（`Accept: application/octet-stream`，得到 302 到官方 CDN，实测 11MB/s），下载后必须核对 `size` 与 `sha256` 等于 `gh api .../releases` 里的 `size`/`digest`，不一致不装。**构建**：dev 与正式版安装包都只能在 **Windows 侧**构建（WSL 无 makensis），源码用 `git worktree add /tmp/<tag> <tag>` 取干净副本、1:1 复制到 Windows 临时目录再 `npm ci` + `npm run bundle:dev`（dev 身份）/`bundle`（正式）。**顺序**：必须先装 dev 身份并跑通验证，才能动正式版；正式版安装前必须整目录 `tar` 备份 + 单独备份 exe，并核对"现场/备份/包内"三方 sha256 一致。**验证（五项链式，缺一不算通过）**：① exe `FileVersion` 等于目标版本且 mtime 是新写入；② 安装目录内 `resources/manager/server-manager.mjs` 的 `MIN_DSH_VERSION` 等于随包地板；③ 启动后 `manager.log` 出现「<旧版本> 低于最低要求 <地板>」→「installed @deepseek-ai/dsh: <地板>」→「launching dsh web」→ URL，且无 `manager-exception`/`crash`/`ECONN`；④ runtime 的 `node_modules/@deepseek-ai/dsh/package.json` 等于地板（这是自动升级是否真的发生）；⑤ `dsh-compat-probe --runtime <该 runtime>` 判 GREEN，且 `session.log` 出现 `client-ready (http): {"loaded":true}`、带 cookie 的 GET 返回 200 且含 `__DSH_BOOT__`。**验收纪律**：GUI 像素与插件交互未做就是未验证，不许用"client-ready 出现了"代替；只允许 kill 自己刚启动的 PID 树。
## Alternatives considered

**用 `gh release download`**：实现最省事，但它对慢链路没有续传，且 240s 超时会把 28MB 截成 6.8MB —— 正是它让第一次装配失败。**用 `curl -x $HTTPS_PROXY` 直连 `github.com`**：实测 0 字节，代理对该域名不放行。**在 WSL 里交叉构建 NSIS**：缺 makensis，只能退回"Windows 侧构建"这一既有文档路线。**只看进程存活当验收**：会把"manager 起来了但 dsh web 没起"判成通过 —— 这次五项链式正是因为它才抓到 `alpha.3 → rc.2` 的自动升级确实发生。**跳过 dev 直接装正式版**：0.20.0 发布时 dev 实例最后启动是 10-17、早于发布，等于零验证 —— 用户否决了这种做法。
## Consequences

买到的是：任何一次"装壳"都变成按清单执行、每步可回滚（0.20.0 的正式版安装 8.55s、五项链式全绿、dsh 从 alpha.3 自动升到 rc.2、探针 GREEN，dev 侧 0.18.1→0.20.0 同样全绿）。代价与遗留：每次要多花一次 dev 构建（~8 分钟）与两份备份；GUI 视觉/插件交互仍需人眼，不在本清单内；`--report-on-fatalerror` 会让 `manager.log` 里出现噪音式 `error` 字样，判读时要看完整行而不是 grep 关键字。相关：[双心跳](2026-10-21-dsh-upgrade-heartbeat-dual.md)、[发版日干跑](2026-10-18-dsh-upstream-release-day-drill.md)、[项目级 gh token](2026-09-19-project-scoped-gh-token.md)。

