# Changelog

> ## ⚠️ 安全修复提示：请尽快升级到包含该修复的新版本
>
> **0.7.0 及更早版本**的安装器存在缺陷：机器上残留 0.3.x 旧版卸载器
> （`%LOCALAPPDATA%\dsh Desktop\uninstall.exe`）时，安装/升级会去执行它，而该
> 卸载器会**按程序名**（`dsh-desktop.exe`）静默结束正在运行的正式版进程——
> 表现为"应用无故消失"（无提示、无报错、无崩溃记录），并可能中断正在进行的会话。
>
> - **触发条件**：存在该旧版残留卸载器时安装任意版本；**安装开发版**时会把正式版杀掉
>   （开发版与正式版 exe 名不同，本应并存）。
> - **修复内容**（本次 `fix(installer)`）：安装器不再无条件执行旧版卸载器——改用与
>   卸载器同源的按名检测（`FindProcessCurrentUser "dsh-desktop.exe"`），命中即绝不
>   执行；旧版主程序已不存在时直接删除孤儿卸载器（切断复发）；壳内「旧版清理」也不再
>   执行它。防回归断言与验证脚本随版本发布。
> - **升级建议**：**请升级到包含该修复的版本**（本条目下方的下一个发布版本）。
> - **临时规避**：安装前退出所有 DSH 实例，或手动删除
>   `%LOCALAPPDATA%\dsh Desktop\uninstall.exe`。
> - **注意**：已发布的历史安装包/卸载器（0.1.0–0.7.0，含 Release 资产）本身仍保留
>   按名结束进程的行为，**请勿手动运行旧的 `uninstall.exe` / 旧 setup**。
>
> 详情见 `.agents/notes/implemented/bug-fix/2026-09-08-legacy-uninstaller-name-kill.md`。

## [0.7.0](https://github.com/karoc/dsh-desktop/compare/v0.6.3...v0.7.0) (2026-09-07)


### Features

* **shell:** GPU 加速开关收进壳——托盘菜单可切换，替代全局 --disable-gpu ([8fe9cbd](https://github.com/karoc/dsh-desktop/commit/8fe9cbd977292803fab457311d9df59b9b0f1212))
* **shell:** GPU 开关暴露 toggle_gpu_accel command（与 toggle_dev_mode 同模式，供 IPC/桥复用） ([46d09e7](https://github.com/karoc/dsh-desktop/commit/46d09e7a4211ea86d845f641a3a7189377068ae0))
* **shell:** 启动清理本身份残留 node 树（孤儿防驻留） ([d848a3b](https://github.com/karoc/dsh-desktop/commit/d848a3bb8ca9cc9fd022b71e13ce48b197cdc085))
* **shell:** 壳菜单栏加「GPU 加速」勾选项——与托盘开关同一 impl，双通道（IPC+桥） ([379635e](https://github.com/karoc/dsh-desktop/commit/379635eeadbfc5388d6d25c4342ef0f2d20c585b))


### Bug Fixes

* **manager:** 升级后校验恢复 profile bundles——升级不丢用户已启用的插件 ([cdd8a15](https://github.com/karoc/dsh-desktop/commit/cdd8a15a5206d57f529d4e33542d8e4da5eb5717))
* **shell:** generate_context 显式类型标注 Context&lt;Wry&gt;（E0283） ([3e5554f](https://github.com/karoc/dsh-desktop/commit/3e5554fa81ef70ecd0a6786f5b0f4fd9000255bc))
* **shell:** 启动闪命令窗口——powershell.exe/taskkill 补 CREATE_NO_WINDOW ([2617804](https://github.com/karoc/dsh-desktop/commit/2617804bd0dd57218166d62d69de041b0c54310d))
* **shell:** 启动页前黑屏——孤儿清理移出 setup 主线程 + WMI 过滤下推 + 迁移备份条件收紧 ([e3c9336](https://github.com/karoc/dsh-desktop/commit/e3c9336b6c4a8a1000a083158c8ea166dcbbc0ee))
* **shell:** 孤儿清理精确匹配加固——正则边界防误杀（runtime-backup 等） ([2a96fa6](https://github.com/karoc/dsh-desktop/commit/2a96fa64b38f2e0fdd01b0db553c9b0b901f2251))
* **shell:** 导航兜底以 /alive（client-ready）为页面可用信号 ([6570e0d](https://github.com/karoc/dsh-desktop/commit/6570e0d3c46345082b8546b5c455bd4d6c1cadb8))
* **shell:** 导航兜底以 on_page_load 为准——修复 navigate 空转导致的首启黑屏 ([6d37632](https://github.com/karoc/dsh-desktop/commit/6d37632dab13326393a2c55deebc9e515b1adf7a))

## [0.6.3](https://github.com/karoc/dsh-desktop/compare/v0.6.2...v0.6.3) (2026-09-06)


### Bug Fixes

* **release:** make chore commits visible in release PRs — plugin syncs were silently dropped ([159d5ca](https://github.com/karoc/dsh-desktop/commit/159d5ca14d7a3aae26b614165041eec2dd829b71))


### Chores

* **plugins:** sync preinstalled bundles to latest — kanban 0.2.5, model-reasoning 0.2.4, turn-navigator 0.4.3 ([918673b](https://github.com/karoc/dsh-desktop/commit/918673b066e1aba58894d58ccd2f1be1cd6cb54f))

## [0.6.2](https://github.com/karoc/dsh-desktop/compare/v0.6.1...v0.6.2) (2026-09-06)


### Bug Fixes

* **shell:** 首启 URL 索要——根治重开壳黑屏（URL 事件丢失链） ([711cefb](https://github.com/karoc/dsh-desktop/commit/711cefb269daefff78a353e85ab90ad7b9f1b70a))

## [0.6.1](https://github.com/karoc/dsh-desktop/compare/v0.6.0...v0.6.1) (2026-09-05)


### Bug Fixes

* **manager:** 真源同步——scripts/server-manager.mjs 落后导致 0.5.0/0.6.0 打包旧 manager ([dbcaea6](https://github.com/karoc/dsh-desktop/commit/dbcaea6c5121bb2492b86114741be9fb6422f236))

## [0.6.0](https://github.com/karoc/dsh-desktop/compare/v0.5.0...v0.6.0) (2026-09-05)


### Features

* **manager:** 预发布通道携带 dist-tag 名（alpha/next 显示明确） ([c1e5aaf](https://github.com/karoc/dsh-desktop/commit/c1e5aaf8915de97f6531f00bc7b0698caaec3b58))


### Bug Fixes

* **manager:** dsh 升级修复三连——迁移后 pnpm store 失配 / 预发布通道只认 next / UI 假成功 ([3440e5d](https://github.com/karoc/dsh-desktop/commit/3440e5d1d3e291603155bddf8493580de7e36ab8))
* **manager:** 适配 dsh 0.1.2-rc.1——patch 空格路径截断 + 带 token URL 的 watchdog 误判 ([6876b01](https://github.com/karoc/dsh-desktop/commit/6876b01fe44a8e0897ca0150b430389c66dedf0c))
* **shell:** launcher 导航兜底——修复重开壳黑屏（WebView2 冷启动 navigate 竞态） ([996d777](https://github.com/karoc/dsh-desktop/commit/996d777ff17aae965eb9d554e0da50197af60055))

## [0.5.0](https://github.com/karoc/dsh-desktop/compare/v0.4.0...v0.5.0) (2026-09-02)


### Features

* **plugins:** 插件管理改壳内独立窗口——dsh 崩溃时也能管理插件 ([#19](https://github.com/karoc/dsh-desktop/issues/19)) ([b96420e](https://github.com/karoc/dsh-desktop/commit/b96420efc80095b16a90763648ac98f6d0e48741))
* **shell:** 旧版接管——迁移前备份 + 安装器静默卸载 + 启动页/菜单/设置三入口清理 ([58611bf](https://github.com/karoc/dsh-desktop/commit/58611bf12a0ec2c019484bde113fa929f8363d6d))


### Bug Fixes

* **shell:** clippy 门禁——powershell_lines 非 Windows 分支 unused var + needless_borrow ([5afc697](https://github.com/karoc/dsh-desktop/commit/5afc697da04c31cff2e827163e7c15c5f86ad819))
* **shell:** 修正旧版接管单测断言（白名单只认 dsh Desktop，dev 目录不被作为识别对象） ([8a7a63b](https://github.com/karoc/dsh-desktop/commit/8a7a63bbe1ddc34f5e9420f0101e130fa62a424f))
* **ui:** 检查更新弹窗标明检查对象为 dsh；下拉品牌头去掉版本号 ([#20](https://github.com/karoc/dsh-desktop/issues/20)) ([8b86378](https://github.com/karoc/dsh-desktop/commit/8b863782d64e08d5427ebfeba79cdd7a0f74ee54))

## [0.4.0](https://github.com/karoc/dsh-desktop/compare/v0.3.10...v0.4.0) (2026-09-01)


### Features

* **ident:** 标识统一 dsh.smoothly.desktop + 启动时旧数据自动迁移 ([#12](https://github.com/karoc/dsh-desktop/issues/12)) ([eef8e32](https://github.com/karoc/dsh-desktop/commit/eef8e329f89d196a7aaea0a29501a2185d1cc098))
* **manager:** dsh web 崩溃取证与自愈（watchdog + node report + 守护脚本） ([93fc961](https://github.com/karoc/dsh-desktop/commit/93fc961796adf3a8cea45253ad67bd9d2af2d05c))
* **shell:** 去掉插件悬浮按钮（改全局接口）+ 启动页改回黑底 ([#15](https://github.com/karoc/dsh-desktop/issues/15)) ([375712d](https://github.com/karoc/dsh-desktop/commit/375712d0f2fad518ab6da6b416020465e5c7260a))
* **shell:** 壳顶栏/壳菜单栏/开发版身份隔离 + 流程规范化（CI 分层/发布自动化） ([#1](https://github.com/karoc/dsh-desktop/issues/1)) ([ee61ae4](https://github.com/karoc/dsh-desktop/commit/ee61ae4b19a6959f3c7cf2b6bfb402b8a68fe7e0))
* **shell:** 插件管理挪入壳菜单栏 + 故障信息披露（不再一片黑） ([#13](https://github.com/karoc/dsh-desktop/issues/13)) ([6ac76f3](https://github.com/karoc/dsh-desktop/commit/6ac76f33857c4376a8ed162ab05f6b08eb39576f))
* **theme:** 取消固定白色主题，改为跟随系统配色 ([#16](https://github.com/karoc/dsh-desktop/issues/16)) ([0c13638](https://github.com/karoc/dsh-desktop/commit/0c13638e3d913cc70e7081a348d2112babe1cc07))


### Bug Fixes

* **dev-build:** dev 版独立 exe 名 + BRIDGE_PORT 字符串注入 + 顶栏通透化 + 品牌统一 ([#6](https://github.com/karoc/dsh-desktop/issues/6)) ([2288785](https://github.com/karoc/dsh-desktop/commit/2288785e47e66847cc9c68c3034364aa219d0fda))
* **release:** release-please 17.x toml extra-file 改用 jsonpath 字段 ([#2](https://github.com/karoc/dsh-desktop/issues/2)) ([5bccac5](https://github.com/karoc/dsh-desktop/commit/5bccac5edbaecdc3b5c4f32c81cb8911f518961c))
* **shell:** 字号 12px + 无滚动条推挤 + 拖动回 app-region + 点击诊断 ([#10](https://github.com/karoc/dsh-desktop/issues/10)) ([3f2d315](https://github.com/karoc/dsh-desktop/commit/3f2d31547724fe86b03106fd47d16014e5551bed))
* **shell:** 插件管理只换入口——撤回自研窗口，改为就地触发原插件控制台 ([#14](https://github.com/karoc/dsh-desktop/issues/14)) ([94cf89f](https://github.com/karoc/dsh-desktop/commit/94cf89f30b883d2f6b9542c7f0884f88b8a73510))
* **shell:** 点击交互改为 window capture 统一分发 + 窗口状态记忆 ([#8](https://github.com/karoc/dsh-desktop/issues/8)) ([48762d3](https://github.com/karoc/dsh-desktop/commit/48762d346b0107f276d68db6c522f219abc75d8d))
* **shell:** 白色主题（#FAFAFA 定为主题色）+ 页面推挤防遮挡 ([#9](https://github.com/karoc/dsh-desktop/issues/9)) ([98ef75d](https://github.com/karoc/dsh-desktop/commit/98ef75dd150b94ac45da10eb1ea831aff39c0631))
* **shell:** 菜单重构 + 真实 logo + app-region 拖动 + 显式浅色文字 ([#7](https://github.com/karoc/dsh-desktop/issues/7)) ([6e4cea3](https://github.com/karoc/dsh-desktop/commit/6e4cea38185c929110523be46e147c1c862886ee))
* **shell:** 远程页强制走桥（修复 capability 拒 invoke 致点击全无反应） ([#11](https://github.com/karoc/dsh-desktop/issues/11)) ([ae8b935](https://github.com/karoc/dsh-desktop/commit/ae8b9350b16e1a982fd2af51a2240d3a27ed3c2c))
* **ui:** 去红闪/更新与关于可见反馈/菜单对齐/下拉去图标/两窗口统一居中 ([#17](https://github.com/karoc/dsh-desktop/issues/17)) ([57cf67a](https://github.com/karoc/dsh-desktop/commit/57cf67a506e0c7558953b692aef81e47259505e7))
* **ui:** 检查更新/关于改壳内弹窗；插件管理撤回自研窗口（原控制台就地触发）；下拉对齐+现代化；设置窗口居中修复 ([#18](https://github.com/karoc/dsh-desktop/issues/18)) ([1288f71](https://github.com/karoc/dsh-desktop/commit/1288f712714fc967f0ebd918858d736cb46480be))
