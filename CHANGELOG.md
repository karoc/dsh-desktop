# Changelog

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
