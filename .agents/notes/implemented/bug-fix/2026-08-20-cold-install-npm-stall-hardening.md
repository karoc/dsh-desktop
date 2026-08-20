# Agent Note: cold-install-npm-stall-hardening

Status: implemented

## Problem

Windows 0.2.0→0.3.0 升级时，用户在 NSIS 卸载器的确认页勾选「删除应用数据」——Tauri 模板的 un.ConfirmShow 无条件显示该勾选框，勾选后 RmDir /r $APPDATA\dev.dsh.desktop（整个 runtime 连同 dsh 安装一起删掉）。下次启动 main() 走冷安装（npm install 全量 ~500 包）。若 registry 连接"挂着不出数据"（悬挂 TCP、防火墙丢包、镜像抖动），npm 默认 fetch-timeout=300s 且 @npmcli/agent 只对收不到字节的连接计时，manager 唯一的兜底是 600s 硬超时 × 2 个 registry——用户看到启动页"正在安装 dsh… 已进行 511 秒"+ 最后几条 npm http fetch 行后像永久卡死，最长要干等 20 分钟才报错。

## Decision

scripts/server-manager.mjs 的三处加固已落地并全部验证：(1) 所有 npm 调用统一追加 NPM_FETCH_FLAGS = --fetch-timeout=30000 --fetch-retries=2 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=10000（npm 11 的 fetch-timeout 映射为 socket IDLE 超时，实测对悬挂响应抛出 EIDLETIMEOUT@30.2s，慢速但持续流式的下载不受影响）；(2) npm() 增加无输出卡死检测：连续 180s 无任何 stdout/stderr 输出即 killTree 并以"npm 已 180 秒无任何输出"报错，覆盖 cacache 锁/postinstall 挂起等 npm 自身超时管不到的场景，仍远低于 600s 硬超时；(3) installDshUpdate 失败日志明示"正在切换备用镜像 X 重试"。落定路径收敛为单一 finish()（timer/stall/error/exit 只允许第一个触发）。另修复 npmLineToDisplay：新增 registry 元数据 URL 提取（npmmirror 的 /@scope%2fname 与 npmjs 的 /@scope/name），此前这类行提取失败会以原始 URL 滚屏。src/app.js 的 30s 安装提示文案改为说明会自动切换镜像。未做：不改 registry 顺序、不改 600s 硬超时值、不自动重试冷安装（main 只跑一次，重试由启动页按钮触发 restart_server）。
## Alternatives considered

**只用 npm 的 fetch-timeout（不加大 manager 的 stall 检测）**：能解决报告的网络悬挂场景，但 cacache 锁、postinstall 挂起、磁盘 stall 仍会静默等 600s——网络不是唯一卡死源，所以保留 180s 无输出检测作第二道网。**把 npm 放后台 + 纯 UI 心跳（不做任何超时）**：体验上"看似活着"但安装可能永远不结束，放弃。**缩短 600s 硬超时到 120s**：慢速但正常的冷安装（跨国网络下几百 MB 下载）会被误杀，放弃——改用 idle 超时精准打悬挂而非总时长。**installDshUpdate 自动重试 N 次**：与启动页重试按钮重复，且自动重试会掩盖真实网络故障，放弃。**stall 阈值取 60s**：Windows HDD + 杀软扫描时的静默解包期可超 60s，会误杀正常安装，取 180s。
## Consequences

购买：报告场景从"20 分钟静默悬挂"变为 ~30s（悬挂 fetch）到 ~3min（非网络 stall）内出清晰错误并自动切换镜像，安装进度可读（元数据 URL 也转成 ⬇ 下载 <包名>）。代价：npm view/更新检查在弱网下也会 30s 内失败（更新徽标可能短暂显示 unknown，可接受）；fetch-timeout=30s 对"每 30s 以上才来一个字节的极慢流式下载"仍会误杀——实测 npm 11 的 EIDLETIMEOUT 不可重试，此边界明确接受。回归测试 scripts/test-install-stall.mjs 走真实 manager + 假 registry 悬挂 tarball 路径（32.9s 出 install-status error），运行需 ~2min 且依赖本机 DNS/网络做 npmjs 降级快速失败，未接入 CI；test-control-plane（10 场景）与 test-proxy（12 场景）在改动后全绿。Windows 上首次冷安装仍受下载总量限制（无可避免），后续可考虑预置 npm 缓存或离线 bundle 进一步压缩。

