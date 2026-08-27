# Agent Note: dev-build-local-workflow

Status: implemented

## Problem

用户要求开发版构建完全本地化：不上 GitHub Actions，GitHub 只放正式版；开发版固定部署在 /mnt/d/Dev/dsh-desktop-dev 编译。首次需要落实该流程并产出可安装的开发版安装包。

## Decision

开发版构建流程固定为：在 Windows 侧（D:\Dev\dsh-desktop-dev，与 /mnt/d/Dev/dsh-desktop-dev 同一目录）git clone 仓库并检出 feat/shell-menu-bar → npm install → npm run bundle:dev，产物 src-tauri\target\release\bundle\nsis\DSH Desktop Dev_<version>_x64-setup.exe。本环境 WSL 的 /mnt/c、/mnt/d 为 9p 只读挂载，D 盘写入必须经 /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe 以 Windows 身份执行；调 powershell 时命令字符串不得含 $ 变量（会被 bash 展开）。GitHub Actions 不构建 dev 变体（CI 仅 npm run bundle 正式版）；README「开发版」小节记录了该约定。开发版部署/编译完成后必须告知用户。
## Alternatives considered

**WSL 侧直接写 /mnt/d/Dev**：实测该环境 /mnt/c、/mnt/d 均为 9p `ro` 只读挂载，git clone 写 .git 即失败——否决，一切 D 盘操作改走 Windows interop（powershell.exe）。**WSL 侧 tauri build --bundles nsis**：NSIS bundler 仅支持 Windows 宿主，Linux 上只会产出 deb/appimage——否决，编译必须在 Windows 侧。**GitHub Actions 出 dev 包**：用户明确要求 dev 版不上 Actions，GitHub 只放正式版——否决。
## Consequences

代价：开发版构建不经过 CI，每次出包需本机 Windows 侧执行 npm run bundle:dev（首次编译 ~2 分钟 + 下载 Node 运行时；产物 27.9MB）；部署目录 D:\Dev\dsh-desktop-dev 与 GitHub 仓库通过 git 同步（需手动 git pull 更新）；PowerShell interop 调用注意 bash 变量展开陷阱（$LASTEXITCODE/$? 会被 bash 吃掉，命令里避免使用）。收益：开发版完全本地化，GitHub 仓库/CI/Release 只承载正式版，两版身份隔离不受影响；流程可复现（README + 本卡记录）。

