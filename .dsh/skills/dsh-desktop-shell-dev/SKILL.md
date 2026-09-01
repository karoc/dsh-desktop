---
name: dsh-desktop-shell-dev
description: 开发 karoc/dsh-desktop（Tauri 2 桌面壳）的壳自身功能：无边框顶栏与窗口三键、注入式壳菜单栏（SHELL_MENUS 定义点）、环回桥端点（/window/*、/shell/*）、本地/远程双通道动作、独立开发版打包（tauri.dev.conf.json 身份隔离，与正式版同机并存）、开发版本地构建工作流（D:\Dev\dsh-desktop-dev，不上 GitHub Actions）。触发词：加壳菜单、改顶栏、窗口控制、开发版打包、bundle:dev、同机并存、环回桥、注入 chrome、SHELL_MENUS、壳独有功能。不要用于：外部 dsh 插件开发（用 dsh-plugin-development）、Windows 安装/启动排障（用 windows-desktop-shell-debugging）、预装插件版本同步（用 dsh-preinstalled-plugin-sync）。
---

# dsh-desktop 壳开发技能（顶栏 / 菜单栏 / 注入 chrome / 桥 / 开发版身份）

来源：2026-08-27 一轮实战（自定义壳顶栏 + 壳菜单栏 + 独立开发版 + 本地构建约定，提交见
feat/shell-menu-bar 分支）。本技能是"改壳自身功能"的操作手册：加菜单、加桥端点、出开发版、
同机调试，照这个走，不要重新发明。

## 1. 架构速览（先记住这三个事实）

1. **主窗口（label `main`）两个阶段**：启动页 `index.html`（tauri://localhost，**有** `__TAURI__`）→
   就绪后 `w.navigate()` 到 `http://127.0.0.1:<port>` 的 dsh 远程页（**没有** `__TAURI__`，tauri#11934）。
   所以壳功能必须"双通道"：本地页走 `tauri.core.invoke`，远程页走环回桥。
2. **环回桥**：`start_bridge()` 起的 127.0.0.1:0 HTTP 服务（CORS-open，std 实现），`BRIDGE_PORT`
   静态变量持有端口。远程页动作全部经它转发（客户端通知插件就是这个模式）。
3. **壳 chrome 是注入的**：`src-tauri/resources/ui/shell-chrome.js` 被 lib.rs `include_str!`
   编译期内嵌，`on_page_load` 里对 `label=="main"` 的 webview `w.eval()` 注入（启动页和 dsh 页
   每次都注入）。Tauri 2 的 `Menu` 在 **Windows 不渲染窗口菜单栏**（只用于托盘/上下文菜单），
   所以菜单栏必须自绘注入——这是本架构的根因。

## 2. 壳顶栏与菜单栏开发

### 2.1 菜单定义点（加菜单只改一个文件）

`src-tauri/resources/ui/shell-chrome.js` 顶部两个常量：

- `SHELL_MENUS`：菜单结构。条目形态：`{id, label, items:[...]}`（下拉，items 内支持
  `{id,label}` / `{type:'sep'}` / `{type:'checkbox',id,label}`）或 `{id, label, action:'actionId'}`
  （直开动作，如「代理设置…」）。
- `ACTIONS`：每个 id → `{ipc:'<命令>', bridge:'/路径'}` 双通道映射；只读状态查询加 `method:'GET'`。
- **壳内就地动作不进 ACTIONS、不占桥**：纯壳内完成的菜单项（插件管理=就地触发原插件
  控制台 `globalThis.__DSH_PLUGIN_CONSOLE__.toggle()`；关于/检查更新=壳内模态弹窗）——
  契约测试对它们豁免，避免为 UI 造无意义的 IPC/桥端点。

**加一个壳菜单 = SHELL_MENUS 加条目 + ACTIONS 加一行 + lib.rs 加对应命令/桥端点**
（或明确归入"壳内就地动作"豁免并同步契约测试）。
契约测试 `scripts/test-shell-chrome.mjs` 守护三方不漂移（见 §6）。

### 2.2 注入机制要点

- **include_str! 编译期内嵌**（`const SHELL_CHROME: &str = include_str!("../resources/ui/shell-chrome.js")`）
  —— 编辑 JS 触发 cargo 增量重建；不要改成运行时读 resource 文件（多一层探测失败面）。
- **注入前缀**：`window.__DSH_SHELL_VERSION__`、`window.__DSH_PRODUCT_NAME__`（serde_json 转义）、
  `window.__DSH_BRIDGE_PORT__`（桥端口，`BRIDGE_PORT>0` 时才写；首帧竞态时本地页走 IPC 兜底）。
- **Shadow DOM**（`attachShadow({mode:'open'})`）：隔离第三方页面 CSS 双向污染，顶栏样式全在
  shadow root 内。
- **MutationObserver 自愈**：dsh SPA 重渲染 body 会清掉注入 DOM → 观察 body childList，宿主被移除
  就重挂（shadow root 跟随宿主元素，重挂不丢）。
- **防重复**：`if (document.getElementById('dsh-shell-chrome')) return;`。
- 顶栏是**浮层**（fixed 36px + 半透明 + backdrop-filter），盖住页面顶部 36px，不推挤第三方布局。

### 2.3 窗口控制（无边框）

- `tauri.conf.json` main 窗口：`decorations:false` + `shadow:true`（Windows 阴影），保留
  `resizable:true`（边缘拖拽缩放仍可用）。settings 窗口保持原生边框（默认）。
- 三键动作：Rust 命令 `window_control(action)` + 桥端点 `/window/minimize|toggle-maximize|close|drag`
  与 `GET /window/state`。`close` = `w.close()` → 现有 CloseRequested 处理 → **隐藏到托盘**（语义不变）。
- **拖动**：远程页没有 `data-tauri-drag-region` 的 JS API（那是 `__TAURI_INTERNALS__` 注入的，
  只在本地页存在）→ 顶栏空白区 mousedown → 桥 `POST /window/drag` → `w.start_dragging()`。
  这是远程页唯一可靠路径；**不要**叠加 CSS `-webkit-app-region`（与 mousedown 互斥、平台支持不一）。
- **最大化图标同步**：Aero 拖拽/Win+↑ 会漂移 → `resize`/`focus` 事件重查 `/window/state` 换图标；
  双击空白区切换最大化。
- chrome 区域 `contextmenu` preventDefault；菜单 Esc/点外关闭（document mousedown 用
  `composedPath().includes(host)` 穿透 shadow 边界）。

### 2.4 桥端点约定

- 扁平 `match (method, path)`，动作都是固定字符串（CORS-open 端点不许参数化动作）。
- 已有：`/window/*`、`/shell/open-settings|dev-mode-toggle|open-data-dir|about|quit`、
  `GET /shell/state`；复用 `/refresh` `/restart` `/check-update` `/update-dsh`。
- 新端点命名按现有风格，别造新路由族。
- **E0716 陷阱**：`app.state::<ServerState>().update.lock().unwrap()` 直接取锁会因临时 State
  被提前释放而编译失败——**先 `let state = app.state::<ServerState>()` 再锁**（`/shell/state` 踩过）。

## 3. 开发版身份隔离（与正式版同机并存）

正式版已装时，覆盖安装会动工作数据。开发版 = **独立 identity 的安装包**，全维度隔离：

```bash
npm run bundle:dev   # = tauri build --config src-tauri/tauri.dev.conf.json --bundles nsis
```

- `src-tauri/tauri.dev.conf.json` 只放两个顶层标量：`productName:"DSH Smoothly Desktop Dev"`、
  `identifier:"dsh.smoothly.desktop.dev"`（正式版 `dsh.smoothly.desktop`，2026-09 品牌统一；
  早期曾为 `dev.dsh.desktop`，`dev` 是命名空间前缀并非"开发版"）。`--config` 是**深合并**：
  对象键合并、数组整体替换——**不要**在 dev 配置里写 `windows` 数组（会整组覆盖主配置，
  丢 decorations 等）。
- **不要覆盖 version**：tauri-cli 强制 tauri.conf.json 与 Cargo.toml 版本一致，覆盖会报错。
- **改 identifier 必须带数据迁移**（已内置 `migrate_legacy_data`：启动时把旧
  `%APPDATA%\<legacy-id>` 整目录 rename 到新目录、写 `.dsh-migration-ok` 标记、
  新目录已有内容则不覆盖、rename 失败不丢旧数据下次重试。改 identifier 前先扩
  `LEGACY_IDENT_MIGRATIONS` 表并补 `migration_tests` 单测）。
- identifier 驱动的隔离（全部自动）：应用数据 `%APPDATA%\<identifier>`（runtime/dsh 本体/
  DSH_HOME/proxy.json 独立）、单实例互斥 **`{identifier}-sim`**（源码核实，两版可同时运行）、
  任务栏 AUMID、NSIS 安装目录/开始菜单/卸载项（按 productName）。
- **toast 激活必须参数化**（否则两版互抢注册）：AUMID 用 `app.config().identifier`；
  激活 CLSID 用 `toast_clsid(identifier)`（正式版保持历史固定 GUID，其它 identifier 用 FNV-1a×2
  派生稳定 GUID）；开始菜单快捷方式名按 productName 生成候选。窗口标题/托盘 tooltip
  用 `app.package_info().name`；「关于」是**壳内模态弹窗**（chrome 内，数据来自注入前缀
  `__DSH_SHELL_VERSION__`/`__DSH_BUILD_DATE__`/`__DSH_PRODUCT_NAME__` + `/update-status`
  的 dsh 当前版本）——开发版标识随 productName 自带「Dev」，无需 Rust 侧 is_dev_build。
- chrome 应用菜单标签用注入的 `__DSH_PRODUCT_NAME__`；下拉/弹窗有明显的 `SHELL_MENUS`、
  `dialog-backdrop`、`__DSH_PLUGIN_CONSOLE__`（插件管理=就地触发原控制台）等标记。

## 4. 开发版本地构建工作流（流程约定，用户指定）

**开发版不上 GitHub Actions；GitHub 仓库/Release 只承载正式版。** 开发版固定本机构建：

- 目录：`D:\Dev\dsh-desktop-dev`（= WSL 的 `/mnt/d/Dev/dsh-desktop-dev`，同一目录）。
- 步骤：`git pull` + 检出目标分支 → `npm install` → `npm run bundle:dev`。
- 产物：`src-tauri\target\release\bundle\nsis\DSH Smoothly Desktop Dev_<version>_x64-setup.exe`（~28MB）。
- **本机 WSL 的 `/mnt/c`、`/mnt/d` 是 9p 只读挂载**——D 盘任何写入（clone/install/build）必须
  经 Windows interop：`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile
  -Command "..."`（以 Windows 用户身份运行，可写 D:\）。
- **PowerShell 调用陷阱**：命令字符串里**不能出现 `$` 变量**（`$LASTEXITCODE`/`$?` 会被 bash
  展开成空）——避免 if 分支，用顺序执行 + 看输出判断。
- 完成后必须**告知用户**安装包位置。

## 5. Tauri 2 踩坑速查（本轮新踩，先查再写）

| 坑 | 真相 |
|---|---|
| Windows 菜单栏 | `Menu` 只在 macOS 渲染窗口菜单栏；Windows 仅托盘/上下文 → 自绘注入 |
| 远程页无 `__TAURI__` | tauri#11934；一切走环回桥，桥端口靠注入前缀传递 |
| `set_title` / notify-rust `app_id` | 接收 **`&str`** 不是 `Into<String>`；Windows 专属路径的错误只在 Windows 侧编译暴露（Linux cargo check 发现不了）→ 改了通用代码后必须等 CI windows job |
| E0716 | `app.state()` 临时值先 `let` 绑定再锁 |
| drag region | `data-tauri-drag-region` 是 JS API（本地页才有）；远程页用桥 `/window/drag`→`start_dragging` |
| 工具窗居中闪跳 | window-state 插件在窗口创建时 `restore_state` 会**覆盖 builder 的 `.center()`**（弹窗先闪一下居中、又跳回上次的旧位置）→ 工具窗（如 settings）用 `Builder::with_denylist(&["settings"])` 排除跟踪；主窗口保留记忆 |
| 构建日期/版本信息 | `build.rs` 用 civil_from_days 算法（无 chrono）输出 `cargo:rustc-env=DSH_BUILD_DATE`，注入前缀带 `__DSH_BUILD_DATE__`，壳内「关于」弹窗展示 |
| dev 配置合并 | `--config` 深合并数组整体替换；version 不许覆盖（与 Cargo.toml 强制一致） |
| 单实例互斥名 | `{identifier}-sim`（Windows），改 identifier 即隔离 |

## 6. 验证与门禁

- 快速契约：`node scripts/test-shell-chrome.mjs`（vm 沙箱加载 chrome 暴露配置——文件内有
  `__DSH_CHROME_TEST__` 测试钩子，命中则只暴露不渲染；断言菜单 id ↔ ACTIONS ↔ lib.rs
  桥端点/命令注册三方不漂移 + dev identity 配置）。
- 全量：`npm test`（7 套，含 manager/代理/通知插件/契约）。
- 改 chrome 渲染逻辑后：用最小 DOM 桩跑渲染路径（createElement/attachShadow/querySelector 等
  手写桩，注意 createTextNode 也要桩；断言宿主/下拉数/按钮数）。
- CI：`cargo check`（ubuntu，系统依赖齐全）→ windows（NSIS + 布局断言 + runtime smoke，**真正的
  编译门禁，Windows 专属代码错误在这暴露**）→ linux。`linux-smoke` 是 main 上**既有的失败**
  （空日志，与改动无关，不阻塞），别被它误导。
- 本容器无 cargo/系统库 → 本地只能跑 node 测试，Rust 编译靠 CI。

## 7. 维护（常用常新）

**触发更新的场景**：加/改壳菜单或桥端点、改顶栏交互、改开发版身份逻辑、新踩 Tauri 坑。

每次改动后：
1. 同步更新 `SHELL_MENUS`/`ACTIONS` 与 `scripts/test-shell-chrome.mjs` 的断言（契约测试就是
   "常新"的守护，别让它漂移）。
2. 新踩的坑追加到 §5 表格（一行）。
3. 流程/路径变了（如部署目录、产物名）同步改 §4 与 README「开发版」小节。
4. 发布正式版后：`git pull` 同步 `D:\Dev\dsh-desktop-dev`，下次出开发版前先确认最新。

自检命令（改动后跑一遍）：
```bash
node scripts/test-shell-chrome.mjs          # 契约
npm test                                     # 全量（可选，慢）
git status --short                           # 确认无意外文件
```

真源：本文件（仓库 `.dsh/skills/`，dsh-skill-filesystem 自动发现 project-dsh 层）。相关技能：
- 安装/启动排障 → `windows-desktop-shell-debugging`
- 预装插件版本同步 → `dsh-preinstalled-plugin-sync`
- 外部 dsh 插件开发 → `dsh-plugin-development`

## 8. 相关产物

- `src-tauri/resources/ui/shell-chrome.js` —— 顶栏全部前端（SHELL_MENUS/ACTIONS 定义点）
- `src-tauri/tauri.dev.conf.json` + `package.json` 的 `bundle:dev` —— 开发版打包
- `scripts/test-shell-chrome.mjs` —— 壳↔壳契约测试
- `src-tauri/src/lib.rs` —— `inject_shell_chrome` / `window_control` / `get_shell_state` /
  `toggle_dev_mode_impl` / `toast_clsid` / 桥端点
- 验收清单：README「壳菜单栏」「开发版」小节（Windows 实机：拖动/三键/Aero 最大化图标/SPA 自愈）
