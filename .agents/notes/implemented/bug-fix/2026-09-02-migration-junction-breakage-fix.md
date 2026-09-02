# Agent Note: migration-junction-breakage-fix

Status: implemented

## Problem

用户安装 0.4.0 后启动即报错（dsh web exited code 1）。0.4.0 首次引入了品牌统一迁移（dev.dsh.desktop → dsh.smoothly.desktop），迁移后 dsh web 启动时 cordis 加载器导入用户本地注册的 bundle（D:\Dev\test\dsh-smoothly-anyrouter-claude）失败：Cannot find package '@deepseek-ai/dsh-settings'。需要定位断链层级并恢复服务，同时沉淀恢复方法。

## Decision

0.4.0（identifier dsh.smoothly.desktop）安装后启动报错的修复已固化：根因是 LEGACY_IDENT_MIGRATIONS 迁移把 %APPDATA%\dev.dsh.desktop 整体 rename 为 dsh.smoothly.desktop，而 D:\Dev\test\dsh-smoothly-anyrouter-claude（profiles/web/package.json 里以 link: 注册的本地 bundle）的 node_modules\@deepseek-ai 下 12 个 dsh-* 依赖是用户手动创建的 Windows junction，绝对路径指向旧 runtime → 迁移后全断 → dsh web 启动加载该 bundle 时 ERR_MODULE_NOT_FOUND（Cannot find package '@deepseek-ai/dsh-settings'）→ exit code 1。修复动作（一次性、已执行）：用 cmd mklink /J 重建 12 个 junction 指向 C:\Users\qqwto\AppData\Roaming\dsh.smoothly.desktop\runtime\node_modules\@deepseek-ai\*（Set-Location 'C:\' 规避 WSL UNC cwd 导致 cmd 无法启动的问题）；node 实测 import OK 后由桥 POST /restart 恢复，dsh web 49832 HTTP 200。NOT done：New-Item -ItemType Junction 路径被证不可靠（PowerShell 5.1 静默失败），不再使用；迁移代码未改动，外部 junction 断链仍是已知边界。
## Alternatives considered

**重新 npm/pnpm 安装插件依赖**：会把插件的 @deepseek-ai/* 依赖实体化到插件 node_modules，脱离 runtime 版本对齐，改变用户既定开发方式，放弃。**给迁移逻辑加"启动时扫描并重建外部 junction"**：迁移在 rename 后无法枚举任意盘上的用户链接（范围不可控、权限复杂），只记录为已知边界，放弃本轮实现。**New-Item -ItemType Junction 重建**：实测在 PowerShell 5.1 + UNC 工作目录互操作下静默失败（删除成功、创建失败且无报错），导致 12 个链接短暂全失——教训：junction 创建必须用 cmd mklink /J 且先 Set-Location 到 Windows 目录。
## Consequences

代价：插件开发环境仍依赖手建 junction，正式版未来再迁移（标识再变）会重现；已建议用户开发期用 dev 版、正式版用已发布插件，降低暴露面。收获：0.4.0 迁移"整目录 rename"对 runtime 内部（真实目录/pnpm hoisted）无损，仅破坏跨盘绝对链接；本次崩溃完整堆栈被 manager.log 捕获（instrumentation 首次实战验证）；确认 mklink 是 Windows junction 唯一可靠创建路径。遗留：迁移代码（lib.rs migrate_legacy_data_dir）不处理也无法预知外部链接，文档未提示——后续可在迁移日志或 README 加警示。

