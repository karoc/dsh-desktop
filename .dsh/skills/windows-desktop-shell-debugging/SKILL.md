---
name: windows-desktop-shell-debugging
description: 排障 Windows 桌面壳（Tauri + 内置 Node 运行时 + 安装/升级/冷安装）的"装不上/启动失败/安装卡死"类问题。覆盖：如何通过 WSL 挂载直接读取 Windows 宿主机的应用运行时、manager.log、代理配置与 node_modules 现场；如何用受控实验隔离"包管理器挂起"的变量（代理/镜像/工具/Node 版本）；如何端到端验证修复。当用户报告 Windows 版安装卡住、`launch failed: not installed`、升级后白屏/服务退出、冷安装长时间无进展时使用。不要用于纯前端/非 Tauri 项目的调试。
---

# Windows 桌面壳安装/启动排障技能

来源：karoc/dsh-desktop 的 0.3.0→0.3.3 实战（"删本地数据后冷安装卡死"→"半截安装"→"npm 对 monorepo 树挂起，改 pnpm 根治"）。本技能把**能复用的方法论**沉淀下来，任何"Windows 上装了/升级了但起不来"的问题都先按这个走。

## 0. 先拿到 Windows 宿主的"现场"，不要靠猜

用户机器如果开了 WSL（大多数开发者环境有），**直接从 Linux 侧读 Windows 文件系统**，比让用户贴日志快一个数量级：

```bash
/mnt/c/Users/<user>/AppData/Roaming/<app-identifier>/   # 应用数据（Tauri: %APPDATA%）
/mnt/d/Dev/<repo>                                       # 用户在 Windows 的仓库
```

- 关键文件：`<data>/runtime/manager.log`（进程日志，含每次安装的失败原因）、`proxy.json`（上游代理配置）、`dsh.json`（壳清单）、`node_modules/<pkg>/package.json` 与 `lib/bin.js`。
- 判定 dsh 安装状态三分类：`package.json` 缺失 = 未装；`package.json` 在但 `lib/bin.js` 缺 = **半截安装**（被中断的 reify 留下）；都在 = 已装。
- 查 Windows 进程/端口（WSL interop）：`cmd.exe /c "netstat -ano | findstr :PORT"` 拿 PID，`powershell.exe -NoProfile -Command "Get-Process -Id PID | select ProcessName,Path"` 认进程（如 `verge-mihomo` = Clash）。

## 1. 诊断链（按顺序，别跳步）

1. **读完整 manager.log**（不只是启动页 5 行字幕——它只留最后 5 行，真相在文件里）。
2. **读配置文件**：`proxy.json`（是否把 registry 路由进了上游代理）、`dsh.json`。
3. **看现场状态**：`node_modules` 里有什么、dsh 包是否半截、`.pnpm`/`.npm` 缓存里有没有半成品。
4. **看进程/网络**：包管理器子进程还活着吗？CPU 是空转还是干等？连接建到哪一步？
5. **受控实验**（见 §2）定位根因。
6. **端到端验证修复**（见 §4），不是只跑单元逻辑。

## 2. 包管理器"安装挂起"的变量隔离（核心方法论）

症状"装到一半没输出"有无数可能。用**每次只动一个变量**的对照实验定位：

| 变量 | 对照 |
|---|---|
| 代理 | 直连 vs 走上游代理（Clash 等）——注意：绕过一个代理层 ≠ 全链路，真实链路可能是 npm→壳内代理→上游代理→镜像 |
| 镜像 | npmjs vs npmmirror |
| 包管理器 | **npm vs pnpm**（最重要） |
| Node 版本 | Node 22 vs 24 |
| npm 版本 | npm 10 vs 11 |

**关键教训：npm 的依赖解析器对"monorepo 型依赖树"会静默无限挂起**——即几十个互相依赖的 scoped 包（如 `@deepseek-ai/dsh` 的 55-61 个 `@deepseek-ai/*` 包）。特征：
- npm 调试日志停在 `silly placeDep` 后**不再发任何网络请求**（`NODE_DEBUG=http` 确认无新 outgoing message）；
- CPU 空转/干等、无任何输出、任何 registry/代理/Node/npm 版本都复现；
- **换 pnpm 同一个包 5.9s 装完**（dsh 自己就是 pnpm monorepo）。
- 判定法：`npm install <小包>`（如 commander）419ms 正常 + `npm install <目标包>` 挂起 → 是树的问题，不是环境。

看 npm 在干什么的三个工具：
- `~/.npm/_logs/*-debug-*.log`（npm 自己的详细日志，含 `fetch manifest` / `placeDep` 进度与停点）；
- `NODE_DEBUG=http npm ...`（确认是否还在发请求）；
- `npm install` 加 `--loglevel=http`（manager 侧用 `--loglevel=http` 流式）。

## 3. 常见"装了还是起不来"的三层原因（按出现频率）

1. **半截安装**：被 kill 的 reify 留下 `package.json` 无 `lib/bin.js`。修复要"双检"：`dshInstalled = package.json 存在 AND lib/bin.js 存在`；自动安装闸门和"已是最新"跳过都要用它；破损时先物理删掉包目录再重装（npm 可能认为同版本已 reify 而跳过重新解压）。
2. **包管理器对依赖树挂起**（§2）：把 dsh 这类包的安装切到 pnpm，并用 `pnpm-workspace.yaml` 的 `allowBuilds` 放行原生 postinstall（koffi/node-pty 等；npm 11 对应 `.npmrc` 的 `allow-scripts`）。
3. **网络/镜像/上游代理**：`--fetch-timeout`（npm 11 是 socket 空闲超时，慢速流式下载不受影响）+ registry 降级链 + 无输出卡死检测（如 180s 无输出即 kill）。

## 4. 端到端验证（必须做）

不要只改代码 + 跑单测。用"真实 manager + 空 runtime + 真实 registry"复刻用户场景：

```bash
node scripts/server-manager.mjs \
  --runtime-dir <空runtime> --resource-dir <resources> --patch <patch> \
  --cwd <tmp> --home <tmp>/home --registry https://registry.npmmirror.com
```

断言：`install-status done` + dsh 启动上报 `"t":"url"` + 页面含注入插件（curl `/` 找 `__DSH_BOOT__` 与插件名）。dsh 的插件注入走 profile 模块向上解析，pnpm isolated 布局（`.pnpm` 符号链接）不影响它——**已验证**。

## 5. 沙箱/环境坑（本技能踩过，别再踩）

- **只读 HOME**：沙箱 HOME 只读 → npm 报 `EROFS .../_cacache`，先设 `HOME=<可写目录>` 再跑 npm/pnpm。
- **`/tmp` 每次命令被清**：跨命令的临时文件放 workspace，别放 /tmp。
- **pnpm 向上找 workspace**：在仓库子目录跑 `pnpm install` 会向上找到 `pnpm-workspace.yaml` 并把整棵树装进仓库根 `node_modules`，污染仓库（还会改写 package.json/lockfile！）。测试目录自建 `pnpm-workspace.yaml` 或删掉仓库根的多余 workspace 文件。
- **管道吞退出码**：`timeout 120 cmd | tail` 的 `$?` 是 tail 的，不是 cmd 的——要 `$PIPESTATUS` 或重定向到文件再取码。
- **`pkill -f` 自杀**：模式匹配到当前命令自身的命令行会 kill 自己，改用精确 PID。
- **npm debug 日志中的 `fetch manifest` 顺序**与显示顺序可能不一致（显示节流 300ms），以日志为准。

## 6. 相关产物

- `scripts/diagnose.ps1`：Windows 一键诊断（装在哪、装了什么版本、dsh 状态分类、manager.log 标记、30s 实跑 manager）。**保持纯 ASCII**（Windows PowerShell 5.1 把无 BOM 的 UTF-8 当 GBK 读，中文会炸解析）。
- `scripts/smoke-windows.mjs`：Windows 运行时冒烟（真实 manager 冷安装 + 报 URL），CI 发布门禁用。
- 发布检查清单见仓库 `ENGINEERING-NOTES.md` 相关章节。

## 7. 反模式

- 只改"超时/检测"不解决根因：卡死检测能把"20 分钟静默"变"3 分钟报错"，但**装不上还是装不上**——要找到"为什么解析器挂起"并用能装的工具（pnpm）替换。
- 在用户机器上反复让用户跑命令贴日志：先尝试 WSL 直读现场。
- 把"勾选框/卸载器行为"当成自己的 bug 修：Tauri NSIS 模板的行为（如"删除应用数据"勾选框）是上游无条件默认，先用自定义 NSIS 模板评估成本再决定是否 fork，别默认是我们的问题。

## 8. dsh 启动器 flag 顺序坑（--no-open 引发 unknown option '--patch'）

`dsh web` 的启动器**解析到第一个它不认识的 flag 就停止**，把剩余参数原样透传给被启动的应用。
所以**启动器自己的 flag（`--patch`、`--profile`）必须放在 web 应用的 flag（`--host`、`--port`、`--no-open`）之前**。
否则 `dsh web --no-open --patch x.yml` 会让 `--patch` 被透传给 web 应用 → `error: unknown option '--patch'`。
正确顺序：`dsh web --patch x.yml --no-open --host 127.0.0.1 --port 0`。这也是"桌面壳要用 `--no-open` 防止默认浏览器被打开一遍"时的必踩坑。

## 9. 宿主机实操速查（2026-09 黑屏/升级/导航多轮实战沉淀）

排障时**直接在宿主机上操作**（WSL 直读 + Windows interop + 本地构建），比等 CI/让用户贴日志快一个数量级。以下全是踩过弯路的正确姿势。

### 9.1 Windows interop 调用（最关键，绕路最多）

- WSL 里调 Windows exe：`/mnt/c/Windows/System32/<exe>` 全路径；`powershell.exe` 不在 PATH 时同理。
- **PowerShell 输出编码**：powershell 对管道输出 UTF-16LE，直接看乱码。**统一方案 = EncodedCommand**（绕开所有引号/中文/$ 转义）：
  ```bash
  PS='<PowerShell 代码>'; ENC=$(printf '%s' "$PS" | iconv -f utf-8 -t utf-16le | base64 -w0)
  /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -EncodedCommand "$ENC"
  ```
- **输出到文件再读**（跨域最稳）：PS 里 `... | Out-File (Join-Path $env:TEMP "x.txt") -Encoding utf8` → WSL 侧 `cat /mnt/c/Users/<u>/AppData/Local/Temp/x.txt`。中文输出必须 UTF-8 BOM（PS 5.1 无 BOM 按 GBK 读 → 乱码/解析崩）。
- **cmd.exe 继承 WSL UNC 工作目录会崩**（"当前目录无效"）→ 先 `Set-Location 'C:\'` 再 `cmd /c ...`。
- **WSL 环境变量不传给 Windows 进程**（除非 WSLENV）→ 手动传 env 用 `Start-Process` + 先 `$env:VAR=...`，或在 PS 内设环境变量。
- **9p 只读挂载**：`/mnt/c`、`/mnt/d` 只读 → 写 Windows 侧必须经 PowerShell（Windows 用户身份）；在 WSL 侧改文件则放 workspace。

### 9.2 宿主机状态速查

```bash
# 进程（壳/node）：
PS='Get-CimInstance Win32_Process | Where-Object { $_.Name -match "^dsh|^node" -and $_.CommandLine -match "dsh|manager|web" } | ForEach-Object { $_.ProcessId.ToString()+" | "+$_.Name+" | "+$_.CreationDate.ToString("HH:mm:ss") } | Out-File ...'
# 壳 exe 版本：
(Get-Item "C:\Users\<u>\AppData\Local\DSH Smoothly Desktop\dsh-desktop.exe").VersionInfo.FileVersion
# 当前 dsh web 端口（manager.log 尾部 URL 行）
```

### 9.3 日志与转录（三处现场）

- `%APPDATA%\dsh.smoothly.desktop\dsh-desktop-session.log`：壳侧（epoch 秒；`date -d @ts` 换算）
- `%APPDATA%\dsh.smoothly.desktop\runtime\manager.log`：manager（UTC ISO；+8 转本地）；关键行：`dsh web:` URL、`watchdog:`、`report-url:`、`update failed:`、`dsh exited with code`
- `%APPDATA%\dsh.smoothly.desktop\runtime\dsh-home\sessions\<ws>\<sid>\session.jsonl.zstd`：**会话转录，多帧 zstd**（每次落盘一帧，魔数 `28 B5 2F FD` 切帧）→ 用内嵌 node（`DSH Smoothly Desktop\resources\node\win32-x64\node.exe`）的 `node:zlib` `zstdDecompressSync` 逐帧解压后 grep——**这是"死前最后动作"的唯一权威来源**（工具调用/时间戳/崩溃恢复标记）
- 崩溃恢复语义：会话被非正常中断后，重启的新 web 会补写 `turn/end reason:interrupted` + `session/end-seed`（**复用最后事件时间戳**）——看到"interrupted"≠用户停止，是崩溃恢复修补。
- watchdog/崩溃产物：`runtime/reports/`（node report + watchdog dump dshweb-*.dmp）；`%LOCALAPPDATA%\CrashDumps\dsh\`（WER LocalDumps，需管理员配置 HKLM）。

### 9.4 黑屏/导航类问题（本季最重灾区）

**机制**：壳冷启动 → WebView2 初始化需数秒 → manager 1.5s 就报 dsh web URL → **Rust `w.navigate()` 在窗口就绪前调用会丢失** → 界面停黑色启动页（黑屏）；"重启 dsh 服务"时窗口已就绪 → navigate 成功 → 恢复。**web 服务本身健康**（看 URL+watchdog 即可区分，别误判成服务挂）。

**判据**：
- `session.log` 有无新 `client-ready`（=webview 到达 dsh 页）：有=导航成功；无=仍黑屏
- watchdog miss 行：区分"web 不响应"vs"导航问题"（web 响应正常但黑屏 = 导航问题）

**治本机制（已在壳内）**：Rust 导航兜底守护线程（每 2s：主窗口仍在本页且有 live URL → 强制导航）+ 首启 URL 索要（`report-url`：壳启动早期向 manager 重发 URL，防首个 URL 事件在 stdout reader 就绪前丢失）+ launcher 轮询（`get_shell_state.liveUrl`）。**出现黑屏先查这三层是否工作**（manager.log 的 report-url 行、session 的 client-ready）。

**0.1.2-rc.1 起的两个 dsh 侧回归（壳必须适配）**：
- `--patch` 空格路径截断（`C:\...\DSH Smoothly Desktop\...` 被按空白切）→ manager 把 patch 复制到无空格路径（`<runtime>/dsh-desktop.patch.yml`）再传
- web URL 带 `?token=` → **watchdog/导航快照必须保留完整 URL**（URL_RE `\d+[^\s]*`），存活判定放宽到 2xx-4xx（401/404 也是"在听"）

### 9.5 升级/安装侧新坑（2026-09）

- **真源/副本漂移（发布内容错的元凶）**：manager 真源是 `scripts/server-manager.mjs`，`sync-resources.mjs` 构建时覆盖到 `resources/manager/`（tauri 打包副本）。**改 manager 必须改 scripts/ 真源**，否则 CI 构建的安装包是旧版（0.5.0/0.6.0 实测：用户装新版反而回退旧 manager → 症状加重）。git 里 `M resources/manager/...` 不代表构建生效。
- **pnpm store 路径失配**：0.3→0.4 标识迁移 rename runtime 后，`node_modules/.modules.yaml` 里 `storeDir/virtualStoreDir` 还是旧绝对路径 → pnpm 报 `ERR_PNPM_UNEXPECTED_STORE` → **升级永远失败但 UI 显示"成功"**（只看 update-status 的远端版本）。修复：升级前 `ensureStorePathsMatch` 重写这两个字段（幂等）。
- **pnpm 版本必须固定**：`ensurePnpm` 用 `npm install pnpm`（不固定）→ 上游发 pnpm 12.x 后，node 24.18 上 cjs loader 启动崩溃（cold-install/升级全挂）。固定 `pnpm@11.24.0`。
- **预发布通道**：`resolveRemoteVersions` 读全量 `dist-tags`（不是只读 next）；只提示"高于 latest 的预发布"（避免 alpha 比 rc 旧还引导升级）；`versionGt` 的 pre-release 排序 alpha<beta<rc<正式。npm 上版本 ≠ GitHub tag（`dsh-v0.1.3-alpha.1` 可能只在仓库 tag，未 publish → 壳看不到是正常的）。
- **迁移连带断链**：标识迁移 rename 整目录 → 用户手动 link 到 runtime 的 junction（`node_modules/@deepseek-ai/*`）断链 → dsh web 启动 `ERR_MODULE_NOT_FOUND`。重建用 `cmd mklink /J`（**PowerShell `New-Item -ItemType Junction` 会静默失败**：删除成功、创建失败无报错）。
- **预发布升级后黑屏三连排查顺序**：patch 空格 → token/watchdog → store 失配 → pnpm 版本（按 §9.4/9.5 逐项查 manager.log 关键字）。

### 9.6 本地构建与安装验证（宿主机，别等 CI）

```powershell
# 宿主机 D:\Dev\dsh-desktop（正式版）或 D:\Dev\dsh-desktop-dev（开发版）：
Set-Location "D:\Dev\dsh-desktop"
git fetch origin; git merge --ff-only origin/main   # 先同步；本地杂散改动可 checkout -- 丢弃
npm install
npm run tauri -- build --bundles nsis               # 约 40s-5min（Rust 缓存后）
# 产物：src-tauri\target\release\bundle\nsis\DSH Smoothly Desktop_<v>_x64-setup.exe
# 静默安装 + 启动 + 验证（首启导航）：
Start-Process -FilePath "<setup>" -ArgumentList "/S" -Wait
Start-Process "C:\Users\<u>\AppData\Local\DSH Smoothly Desktop\dsh-desktop.exe"
# 验证：session.log 出现新 client-ready = 首启导航成功（黑屏根治判据）
```
比 GitHub CI（15-20min）快得多，且能直接安装验证"包内容对不对"（绕过打包漂移）。

### 9.7 截屏查看宿主机

模型不支持读图时，用 vision 辅助：PowerShell 截屏（System.Drawing CopyFromScreen）→ PNG → `node ~/.agents/skills/image-vision/vision.js <png> "描述窗口内容"`。

### 9.8 反模式补充

- 别在 WSL 里 `cat`/`grep` Windows 侧大文件（9p 慢）；用 grep 工具/分页。
- 别改 `resources/manager/*` 后不修真源（§9.5）。
- 别在 `curl` 时用无 token 的 URL 判断 web 存活（0.1.2-rc.1 起 401 是正常）；用 manager.log 的完整 URL。
