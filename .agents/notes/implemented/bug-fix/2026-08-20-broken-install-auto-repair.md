# Agent Note: broken-install-auto-repair

Status: implemented

## Problem

0.3.1 发布后用户升级仍报 `launch failed: @deepseek-ai/dsh not installed at .../runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`。根因：上次 0.3.0 冷安装被中断（npm 在 Windows 上被 kill）留下"半截安装"——node_modules/@deepseek-ai/dsh/package.json 已写出、lib/bin.js 没解压完。而 manager 判定"是否已装 dsh"只看 installedVersion()（package.json 存在即非空），于是 main() 的自动安装闸门被跳过，启动时 launchDsh 发现 bin.js 缺失 → 抛错 → 用户永久卡在"dsh 服务已退出"，且永远不会自愈。即使走到 installDshUpdate，`current === latestVersion` 也会直接跳过，npm 也可能认为该包已是最新而不重新解压。

## Decision

scripts/server-manager.mjs 现在区分"有 package.json"与"完整可启动"：新增 dshEntry(runtimeDir)=node_modules/@deepseek-ai/dsh/lib/bin.js 与 dshInstalled(runtimeDir)=installedVersion!==null && existsSync(dshEntry)。三处接入：(1) main() 自动安装闸门从 !installedVersion 改为 !dshInstalled，日志改为 "dsh missing or broken — installing automatically"；(2) installDshUpdate 在查到 latest 后，若 current!==null 且 !dshInstalled，先 rmSync 整个 node_modules/@deepseek-ai/dsh 再走 npm install（npm 可能认为同版本已 reify 而不重新解压，必须物理删除强制重装），并 log "dsh 安装不完整（缺启动入口），将重新安装"；"已是最新"跳过条件同步收紧为 current===latestVersion && dshInstalled；(3) launchDsh 复用 dshEntry。未做：不做 bin.js 之外更深的一致性校验（如 lib 其余文件/依赖完整性），缺入口是最常见且可判定的半截形态；不自动无限重试。新增 scripts/test-broken-install.mjs 端到端回归：假 runtime 只有 package.json 无 lib/bin.js，假 registry 提供含 lib/bin.js 的真实最小 dsh.tgz——断言闸门触发、修复日志、重装成功、bin.js 重新落盘、dsh 成功启动并驻留。版本 0.3.1 → 0.3.2。
## Alternatives considered

**把 installedVersion 改成同时校验 bin.js（即让 package.json 存在但 bin.js 缺失时返回 null）**：也能让旧闸门触发，但会污染 update-status 展示与"已是最新"比较语义（版本信息仍真实存在），且语义上"版本号"与"可启动性"是两回事，故选独立的 dshInstalled 概念。**启动失败后自动再触发一次安装（在 supervise 里循环重试）**：可能形成"装失败→launch 失败→再装"的无限循环，掩盖真实网络故障，放弃；修复只保证"能修的都自动修"，网络故障仍由启动页重试按钮 + 清晰报错兜底。**npm install 前对每个半截包做全量 tree 校验**：成本高、误伤面大（npm 自身的 reify 机制本就处理多数不一致），只针对 dsh 包入口做判定即可。
## Consequences

购买：半截安装（0.3.0 卡死时强关留下的破损 runtime）现在会在下次启动时自动检测、清除、重装并正常启动，用户不再被"launch failed: not installed"永久锁死；健康安装路径行为不变（dshInstalled 为真时与旧逻辑等价），test-control-plane（10 场景）、test-proxy（12 场景）、test-install-stall（32s 快失败）全绿。代价：对"package.json 在但 lib 缺"的破损态，启动会多做一次 registry 查询 + 重装（网络正常时数秒）；修复判定只盯 lib/bin.js，其他更隐蔽的半截形态（lib 部分文件缺失但 bin.js 在）仍可能启动时报模块加载错误——已记录为已知覆盖边界，后续如复现再加深校验。Windows 上 rmSync 破损包目录可能因杀软/文件占用失败，此时 rmSync force 静默忽略、后续 launch 仍失败，需用户重试——已接受。

