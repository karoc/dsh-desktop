# Agent Note: a-level-improvements-implementation

Status: implemented

## Problem

A 级改进分析（docs/2026-09-17-official-desktop-takeaways.md）与随后经三角度审计修订的方案 v2 需要落地：4 项 A 级（壳自更新、路径安全判据、卸载/清理、启动页恢复面）加 2 项低成本门禁。用户要求"从第一项开始顺序执行，不可扩散、不可偏离，做好实施结束的审计"。

## Decision

按 docs/2026-09-17-a-level-plans.md v2 的顺序执行 4 项 A 级 + 2 项门禁，全部落地（10 个提交）。**G-1**：test-shell-chrome.mjs 增加真源/副本 manager `strictEqual` 断言（原为逐项子串，漏 sync 时全绿而打包脚本是旧版）。**A-4 分期1**：启动页失败态新增「打开插件管理（禁用出问题的插件后重试）」按钮 = `invoke('open_plugins')`（命令已存在，零新 Rust 代码、不新增破坏性能力）；附带修复实机发现的 plugin-console 桥端口顶层常量缓存 bug（注入晚于脚本执行 → ready() 恒 false → 窗口空白），改为惰性读取 + 超时可操作提示 + 回归断言。**A-2a**：legacy-takeover.nsh 新增 `legacy_pre_running` 分支——旧版正在运行时拒绝接管且**不碰快捷方式**（原共享尾标签 `legacy_pre_done` 会删 lnk，同 2026-09-09 事故症状）；快捷方式路径经 `LEGACY_DESKTOP/LEGACY_PROGRAMS` 可覆盖以便 harness 观测。**A-3 L0**：卸载钩子 `NSIS_HOOK_PREUNINSTALL` 告知数据保留（实测模板 installer.nsi:3196 确实调用），且**仅在非静默且非 /UPDATE 时弹窗**（否则无人值守更新被阻塞）。**A-3 L1**：新增「清理缓存…」菜单项 + `cleanup_caches` 命令 + 桥 `/shell/cleanup-caches`，先 stop_child 再删 node_modules 与历史 dump，保留 .pnpm-store/reports 最新证据/dsh-home，结果含 blocked 列表不假成功。**A-2b**：新增 `path_under()`（组件级比较 + 大小写不敏感）与 `strip_verbatim()`（去 `\\?\`/`\\?\UNC\`），替换三处字符串前缀判定，旧目录回收前加 reparse 判定。**A-1 一期**：manager `check-shell-update` 用 Node 内置 fetch 查 GitHub `/releases/latest`（404 回退 /releases），缓存 6h、复用 `versionGt`（防降级）、dev identifier 跳过；壳经 `--shell-version/--shell-identifier` 传身份，独立 `ShellUpdateStatus` + 桥 `/shell-update-status`、`/check-shell-update`（**绝不复用 update-status**），UI 在检查更新弹窗内加只读「应用（壳）」分区（不新增 open_url）。**G-2**：windows job 增加 `cargo test --lib`（`#[cfg(windows)]` 的 path_under/dump/job-object 在 ubuntu 编译的是另一分支，等于零覆盖），置于 bundle 之前快速失败。
## Alternatives considered

**A-1 一期产出 latest.json（原方案）**——放弃：GitHub `/releases/latest` 响应已含 tag_name + html_url，产出 latest.json 需要改 build.yml 的 FILES 分发（否则"移 tag 重发"路径会遗留旧文件），收益为零、风险为一整类静默回归。**A-1 新增 open_url 打开 Release 页**——放弃：该能力不存在，新建需带 host/scheme 白名单防 `file:`/`ms-msdt:` 本地执行面；改为只展示地址文本。**A-1 复用 update-status 承载壳可用性**——放弃（审计 P0）：其 `update_available` 会翻转托盘文案并让点击发 `update-dsh`，混入壳更新会"看到壳有更新、点下去更新了 dsh"。**A-3 L1 连 .pnpm-store 一起清**——放弃：实测 620MB 但暖 store 重建约 6s，删了要冷装且离线起不来。**A-3 L1 清 reports**——放弃：1.4GB 里 1381MB 是**最新** hang dump，正是未结事故取证卡要的证据。**A-2 新建 guard_removal + 句柄化删除（原方案）**——放弃：当前生产删除是非递归的（remove_file / 空目录 remove_dir），对 junction 天然安全，属过度设计；只收紧三处判定 + 补 reparse 前置判定。**A-4 新增 Rust 命令改 profile bundles（原方案）**——放弃（审计发现两处硬伤）：会删掉 WEB_PROFILE_TEMPLATE 导致 dsh 永久起不来、且写 manifest 无原子性，改为一行 `invoke('open_plugins')` 引导用户去既有插件管理窗口。
## Consequences

代价与边界：① **A-1 只做检查不做安装**——用户看到"有更新"仍需自己去 Release 页下载重装，壳自更新链仍是空白（二期需签名方案 + 私钥隔离 + 多公钥轮换，未启动）；② **A-3 L1 有联网依赖**——清 node_modules 后首次启动必须联网重装（已实测自愈：824 包装完约 3 分钟），离线时启动失败，弹窗已预先告知；③ **A-2 的判定仍有已知局限**——8.3 短名、junction 目标不解析、不做 canonicalize（避免 I/O 与不存在路径问题），reparse 只做"保留现场"不做深入处理；④ **验证缺口**：A-1 弹窗新增分区的像素级渲染未验证（菜单下拉在注入的 shadow DOM 中，UIA 不暴露未展开的下拉项，本会话合成点击未能稳定展开；已覆盖语法/契约/数据链路/版本逻辑/Rust 单测）。购得：4 项 A 级改进落地且每一项都有实测证据（NSIS 六场景 harness、自愈端到端、组件级路径判定单测、壳更新 dev 跳过端到端），并新增两条门禁（manager 副本逐字节相等断言、Windows 专属 Rust 单测进 CI）。

