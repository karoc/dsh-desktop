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
