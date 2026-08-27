# Agent Note: skill-distillation-shell-dev

Status: implemented

## Problem

本轮会话（壳顶栏/壳菜单栏/开发版身份隔离/本地构建工作流）积累了可复用经验与踩坑，用户要求沉淀为 Skill 便于后续快速推进，并明确维护机制确保常用常新。

## Decision

新 Skill 真源为仓库 .dsh/skills/dsh-desktop-shell-dev/SKILL.md（已提交推送 feat/shell-menu-bar@7cf027d），由 dsh-skill-filesystem 的 projectRoot/.dsh/skills 扫描自动发现（source=project-dsh），本会话 catalog 已验证即时生效，无需写全局目录。SKILL.md 结构：frontmatter（name+description 含触发词与反触发，指向 dsh-plugin-development / windows-desktop-shell-debugging / dsh-preinstalled-plugin-sync）＋正文八节：架构三事实、菜单开发手册（SHELL_MENUS/ACTIONS 定义点、注入机制、窗口控制、桥端点约定）、开发版身份隔离、本地构建工作流（含 WSL /mnt/d 只读 → Windows interop、PowerShell $ 陷阱）、Tauri 2 踩坑速查表、验证门禁（test-shell-chrome.mjs 契约 + npm test + CI 分层，linux-smoke 为既有失败）、维护章节（触发更新场景、改动后四步、自检命令）、相关产物清单。维护约定：改菜单/桥端点必须同步更新契约测试断言（契约测试即"常新"守护）；新坑追加踩坑表；流程变化同步 README 与 §4。
## Alternatives considered

**写入全局 ~/.dsh/skills**：本环境 HOME 大部只读（实测 .pkgconfig-shim、~/.dsh/skills 均 EROFS），且 dsh-skill-filesystem 按 projectRoot/.dsh/skills（project-dsh 层）自动发现，无需全局拷贝——否决，真源放仓库。**并入既有 windows-desktop-shell-debugging**：职责不同（安装排障 vs 壳功能开发），触发语境完全不同，否决。**为 skill 单独建自检脚本**：契约测试 test-shell-chrome.mjs 已是"常新"守护，skill 内以自检命令段替代独立脚本，避免维护面膨胀。
## Consequences

代价：Skill 随仓库分发，仅本仓库工作区会话可见（其他项目/全局会话需另行部署）；维护依赖 §7 自律节奏（无强制门禁）。收益：加菜单/出开发版等高频操作有了完整手册；本会话 catalog 已发现（available_skills 即时出现 dsh-desktop-shell-dev），后续会话可直接 skill 加载；踩坑表避免重复踩 set_title/app_id &str、E0716、dev 配置合并等 Windows 专属坑；流程约定（开发版不上 GitHub、D:\Dev\dsh-desktop-dev）随 README + skill 双处固化。

