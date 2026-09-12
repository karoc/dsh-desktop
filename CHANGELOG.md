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

## [0.8.0](https://github.com/karoc/dsh-desktop/compare/v0.7.0...v0.8.0) (2026-09-12)


### Features

* **guard:** 重写外部守护（G2）—— 新身份 / 去 comsvcs / 500ms 采样抓凶手 / 默认只检测 ([4de27c1](https://github.com/karoc/dsh-desktop/commit/4de27c1ada46c512012202076cb28bb3c0f8301b))
* **shell:** manager 退出检测与取证（try_wait + 证据目录，不自动重启） ([028b77a](https://github.com/karoc/dsh-desktop/commit/028b77aed3fdde91f49138a325d9153ef3b96a6d))
* **shell:** S4b Job 完成端口逐进程通知 + G1 登录启动项安装器 ([be197d4](https://github.com/karoc/dsh-desktop/commit/be197d463e502660a88482318e6896760d15f345))
* **shell:** 挂起 dump（S3）+ Job Object（S4a）+ manager watchdog 去 comsvcs ([ade59f7](https://github.com/karoc/dsh-desktop/commit/ade59f7f92df4e469ea411ee8da44b3dbc0a60e6))


### Bug Fixes

* **build:** dsh_web_pid_for_url 在 Linux 侧 url 未使用（CI 红）—— 解析保留到公共路径 ([3fb4b0a](https://github.com/karoc/dsh-desktop/commit/3fb4b0a1efecef49089326572170a4b7db916281))
* **build:** GENERIC_WRITE 在 Win32::Foundation（windows 0.61） ([857f497](https://github.com/karoc/dsh-desktop/commit/857f497aaf9c9b2d29252fbb1c12e1bfb2da2a1f))
* **build:** JOBOBJECT_ASSOCIATE_COMPLETION_PORT.CompletionKey 是 *mut c_void ([9bee4da](https://github.com/karoc/dsh-desktop/commit/9bee4da7e8977f2552c953c70eacb36862839b73))
* **build:** windows crate feature 补齐（Security/Kernel/Memory）+ OpenProcess 传 bool ([ff61e21](https://github.com/karoc/dsh-desktop/commit/ff61e2103154f28bd680e06b5f9671510cfec7b7))
* **build:** 不能对 MutexGuard 临时值整体赋值（E0070）—— 先绑定再解引用 ([130abd7](https://github.com/karoc/dsh-desktop/commit/130abd716b6c2cc3ecc68fba4521b498b7423118))
* **build:** 消除 Linux 侧 dead_code（CI 红）—— job_object 整模块 cfg(windows)、SERVICE_JOB 同、web_dump 的 port 移入 windows 块 ([37759b8](https://github.com/karoc/dsh-desktop/commit/37759b86478b0959bdc22f2e380ad26c61582665))
* **clippy:** CompletionKey 用 null_mut（manual_dangling_ptr） ([a543015](https://github.com/karoc/dsh-desktop/commit/a543015ec94306c1da45e5875d3b8689b7e00fa4))
* **guard:** 401 被当成挂起 + conhost 噪音淹没日志 ([4a6dd48](https://github.com/karoc/dsh-desktop/commit/4a6dd482d779f0aec990039ff7dbfd430758ed23))
* **guard:** suspect 窗口 UTC/local 混用导致全部命中 + 去掉 conhost 噪音 ([9557bce](https://github.com/karoc/dsh-desktop/commit/9557bce1d82126ba265245d121d951334a852cc8))
* **guard:** 排除自身与父进程作为 suspect（否则证据被自己的命令行淹没） ([f722288](https://github.com/karoc/dsh-desktop/commit/f7222885d5e5c303785d61e8a155e37671ce9bbb))
* **hang:** 回执必须等 dump 真正写完（实测 manager 提前重启 → 现场归零） ([64210df](https://github.com/karoc/dsh-desktop/commit/64210dff5ec6914a5460fe4894d534f736b83de1))
* **installer:** 旧版卸载器按同名 exe 静默杀进程 —— 装 dev 版误杀正式版 ([a8297ac](https://github.com/karoc/dsh-desktop/commit/a8297aca47611c8a04ac8ee4233c2a3995040c50))
* **launcher:** 故障回退后主动查壳状态，不再停在「正在启动」假象 ([a35c3b8](https://github.com/karoc/dsh-desktop/commit/a35c3b8f59abeeaced97e2f398f056508876510b))
* **shell:** EOF 但进程仍存活时不占用上报槽位 + 实机验证脚本 + 单测补 node report 拷贝 ([460bdd8](https://github.com/karoc/dsh-desktop/commit/460bdd8b0a69ff26e3de2587f54f6ee497fb2447))
* **shell:** Windows 本地页是 http://tauri.localhost，不是 tauri:// —— 回退导航仍不生效 ([03592c0](https://github.com/karoc/dsh-desktop/commit/03592c070fadb1cc1ce3a285de9aae1afced840e))
* **shell:** 全屏浮层自动让位——菜单栏收起只留 4px 悬停条，插件零改动 ([56708b8](https://github.com/karoc/dsh-desktop/commit/56708b8f908102c4da7b6425a5c1db0544169b0f))
* **shell:** 取证取 manager 已有的 report.*.json + 修 main 上 clippy doc 缩进门禁 ([d76e3c3](https://github.com/karoc/dsh-desktop/commit/d76e3c393ccdc989853436f5a1ab823e253da056))
* **shell:** 故障回退导航不再落到 about:blank 黑屏（实机验证发现） ([728143a](https://github.com/karoc/dsh-desktop/commit/728143a37ccb8168d1dfb4d2b303d581af04b0aa))
* **verify:** PowerShell 5.1 CimInstance 标量没有 .Count —— 调用点统一 @() 包裹 ([cf6f6fa](https://github.com/karoc/dsh-desktop/commit/cf6f6fa1b20956634b63473a45e33e8be4cf6e59))
* **verify:** summary.json/orphans.txt 显式按 UTF-8 读（PS 5.1 -Raw 按 ANSI 解码会破坏中文） ([16c1e04](https://github.com/karoc/dsh-desktop/commit/16c1e04d4d034860b6dd7310ea5bad31cc15c4a9))
* **verify:** verify-hang-dump.ps1 保持纯 ASCII（em dash 用 [regex]::Unescape 构造） ([6d01fe3](https://github.com/karoc/dsh-desktop/commit/6d01fe3740795a5ffd9d5e970cfecf0e3f7db18b))


### Chores

* **board:** 卡 2 done（附三字段）、卡 1 改为 S3/S4/G/Sysmon 续做 ([b99fdc8](https://github.com/karoc/dsh-desktop/commit/b99fdc8617e7c3227f7a0635719e6243d9fae8a7))
* **board:** 四张待办卡补齐调研结论与决策（D1-D6） ([c03324b](https://github.com/karoc/dsh-desktop/commit/c03324b60ef3dbfe69cb3b37e023f246997de354))
* **board:** 新版本发布计划三卡（dsh 更新/预装插件核查/发布） ([4ddcaa0](https://github.com/karoc/dsh-desktop/commit/4ddcaa0b9d2ff0b8037b9bbda204ac0be1014e65))

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
