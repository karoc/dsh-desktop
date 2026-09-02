# 迁移后旧版接管方案（legacy takeover）设计

状态：M1+M2 已实现（2026-09-03，待 CI 编译验证与发版）；M3 待办。
日期：2026-09-03
目标版本：0.4.1（M1/M2）与 0.5.0+（M3）
关联：看板卡「迁移后旧版接管：检测残留 + 提示清理（防空壳分叉）」；Agent Note `2026-09-02-migration-junction-breakage-fix.md`

---

## 1 背景与问题定义

0.4.0 品牌统一（identifier `dev.dsh.desktop` → `dsh.smoothly.desktop`、productName/安装目录名 `dsh Desktop` → `DSH Smoothly Desktop`）时，迁移逻辑（`migrate_legacy_data_dir`）只负责把 AppData 数据目录整目录 rename，**没有接管旧安装**：

- 旧 exe 与旧安装目录（`%LOCALAPPDATA%\dsh Desktop\`）原封不动；
- 桌面与开始菜单残留 "DSH Desktop.lnk"；
- 旧壳（0.3.10）被启动后，因其 single-instance 按 identifier 隔离（`tauri-plugin-single-instance` 不跨标识互斥）、且其 manager 会自动重建空 `dev.dsh.desktop\runtime`，出现"数据看似全丢"的空壳分叉事故（2026-09-02 已实发一次）。

**目标**：升级到 0.4.1 后，"旧版可启动"成为不可能或至少被强提示，旧壳空壳分叉被阻断/发现，数据安全不回归。

## 2 已验证的技术事实（方案的前提）

| 事实 | 来源 |
|---|---|
| Tauri 2（crate `tauri = "2"`，CLI 2.11.4），NSIS 构建 | `src-tauri/Cargo.toml`、`node_modules/@tauri-apps/cli` |
| NSIS 配置：`installMode=currentUser`、`languages=[SimpChinese,English]`、`displayLanguageSelector=false` | `tauri.conf.json` |
| **NSIS 自定义钩子可用**：`bundle.windows.nsis.installerHooks`（.nsh 文件），支持 `NSIS_HOOK_PREINSTALL / POSTINSTALL / PREUNINSTALL / POSTUNINSTALL` | `config.schema.json` `NsisConfig.installerHooks` |
| NSIS 额外字段：`template`、`startMenuFolder`、`minimumWebview2Version` 等 | 同 schema |
| single-instance 已启用，**按 identifier 隔离**（跨标识互不冲突） | `lib.rs` `.plugin(tauri_plugin_single_instance...)` |
| 数据迁移在 `setup()` 最前执行，先于一切服务启动 | `lib.rs` `run()` setup 内 `migrate_legacy_data(app.handle())` |
| 迁移实现：`LEGACY_IDENT_MIGRATIONS`（正式 `dev.dsh.desktop`→`dsh.smoothly.desktop`；dev `dev.dsh.desktop.dev`→`dsh.smoothly.desktop.dev`），整目录 rename + `.dsh-migration-ok` marker，目标已存在则跳过 | `lib.rs:490-563` |
| 日志机制：Rust 侧 `dsh-desktop-session.log`（`log_line`，append-only）、manager `manager.log`；桥 `/restart` 可热重启服务 | `lib.rs`、`server-manager.mjs` |
| 壳命令注册：`invoke_handler(tauri::generate_handler![...])`（已有 20+ command）；桥端点 `handle_bridge_conn` match 分支；菜单/动作表 `SHELL_MENUS` + `ACTIONS`（双通道，契约测试守） | `lib.rs:2408`、`shell-chrome.js:36/58`、`scripts/test-shell-chrome.mjs` |
| 启动页：`src/index.html` + `app.js`，有 `setState` / `showActionable(text, hint)`（红字+重试/打开数据目录）可复用为提示区 | `src/app.js:14/141` |
| 设置页：`src/settings.html/js`，`<section class="set-group">` 卡片式区块 | `src/settings.html:17/39` |
| 旧安装物证：旧目录 `%LOCALAPPDATA%\dsh Desktop\`（exe+resources+uninstall.exe）；快捷方式 `Desktop/DSH Desktop.lnk`、Start Menu 同 | 2026-09-02 现场确认 |
| dev 版独立：`tauri.dev.conf.json`（productName "DSH Smoothly Desktop Dev"、`mainBinaryName=dsh-desktop-dev`、identifier `dsh.smoothly.desktop.dev`）→ **本方案绝不触碰 dev 身份** | `tauri.dev.conf.json` |
| CI：`build.yml`（PR 快门禁 check+test；main push / v* tag 全门禁出包挂 Release）；release-please 自动发版 | `.github/workflows/` |

## 3 目标与非目标

**目标**
1. 升级 0.4.1 后，旧版可执行入口（exe/快捷方式）被安装器接管或首启强力提示清理；
2. 空壳分叉（旧壳重建空 `dev.dsh.desktop`）可被检测并提示；
3. 全程零数据风险：任何一步失败都不改/不删用户数据；
4. dev 版身份完全不受影响。

**非目标**
- 不自动迁移第三方/用户自定义符号链接（junction 断链仍按 09-02 事故的手工处置路径）；
- 不为旧壳（0.3.10 二进制）打补丁/改资源来"阻止启动"——不可控、不可维护；
- 不在本次实现"未来版本自动检测并卸载其他残留"（只处理已知精确路径，白名单制）。

## 4 总体方案（四层）

```
安装 0.4.1
 ├─ L1 安装器接管（NSIS installerHooks）：
 │      PREINSTALL 检测旧安装 → 旧版未运行：静默卸载 + 清快捷方式；
 │                         → 旧版运行中：弹窗提示先退出（安装中止可重试）
 ├─ L2 首启兜底（Rust + 启动页）：
 │      启动时检测旧安装/旧快捷方式/空壳重建迹象
 │      → 启动页横幅（一次性）+ 壳菜单「旧版清理…」+ 设置页按钮
 │      → cleanup_legacy command（白名单校验后：静默卸载/删lnk/删残留）
 ├─ L3 防分叉日志与提示：
 │      旧数据目录（dev.dsh.desktop）意外存在 → 记日志 + 横幅提示（说明旧壳跑过）
 └─ L4 版本与快捷方式策略固化：
       后续版本安装目录名/快捷方式名保持稳定，升级回归"就地替换"
```

## 5 详细设计

### 5.1 L1 安装器接管（NSIS）

**5.1.1 新增文件** `src-tauri/resources/nsis/legacy-takeover.nsh`：

```nsh
; 旧版接管：0.3.x（install dir "dsh Desktop"，USERPROFILE/AppData/Local 下）。
; 仅在 currentUser 安装路径下精确命中，命中即接管，绝不触碰 dev 版目录。

!ifndef LEGACY_DIR
  !define LEGACY_DIR "$LOCALAPPDATA\dsh Desktop"
!endif

!macro NSIS_HOOK_PREINSTALL
  ; 检测旧 uninstaller（uninstall.exe 存在 = 旧版确实装过）
  IfFileExists "${LEGACY_DIR}\uninstall.exe" 0 legacy_done
  ; 旧版进程是否在运行：tasklist 检索 exe 路径前缀（路径精确匹配）
  nsExec::ExecToStack 'cmd /c wmic process where "ExecutablePath='"${LEGACY_DIR}\dsh-desktop.exe"'" get ProcessId /value'
  Pop $0 ; exit code
  Pop $1 ; output
  StrCpy $2 ""
  ${If} $1 != ""
    StrCpy $2 "running"
  ${EndIf}
  ${If} $2 == "running"
    MessageBox MB_OK|MB_ICONEXCLAMATION "检测到旧版 DSH Desktop 正在运行。请先退出旧版，再继续安装。"
    Abort  ; 中止安装（用户退出后重跑安装器）
  ${Else}
    ; 静默卸载旧版：/S 静默；_?= 让卸载器不删自身/不遗留自身进程（标准 NSIS 静默卸载）
    ExecWait '"${LEGACY_DIR}\uninstall.exe" /S _?=${LEGACY_DIR}'
    ; 兜底：卸载器理论上已删其快捷方式；这里再删一次已知 lnk（存在才删）
    Delete "$DESKTOP\DSH Desktop.lnk"
    Delete "$SMPROGRAMS\DSH Desktop.lnk"
    ; 卸载器不会删残留空目录，清理仅限确认为空的旧目录
    RMDir "${LEGACY_DIR}"
  ${EndIf}
legacy_done:
!macroend
```

> 说明：`wmic` 在 Win11 24H2+ 可能缺省，稳妥做法是 `tasklist /fi "IMAGENAME eq dsh-desktop.exe" /fo csv` 后无法直接比对路径 —— 因此在 L2（Rust）中做权威的"运行中"检测（按 exe 真实路径），安装器里 wmic 失败（exit code $0 != 0）时按"未运行"继续（卸载器对运行中的 exe 会失败且不删文件，风险可控，安装器随后正常装新）。**L1 是"尽力接管"，L2 是"权威兜底"**：即便 L1 全部跳过，L2 仍会在首启完成检测与清理。

**5.1.2 配置**：`tauri.conf.json`

```json
"nsis": {
  ...现有字段...,
  "installerHooks": "resources/nsis/legacy-takeover.nsh"
}
```

注意：`resources/nsis` 目录**不加入** `bundle.resources`（那是运行时资源，installerHooks 是构建期脚本，加了会导致多余拷贝；构建由 beforeBuildCommand 的 `sync-resources.mjs` 无关）。

**5.1.3 决策与理由**

| 决策点 | 选择 | 理由 |
|---|---|---|
| 接管主体 | 安装器优先 + 首启兜底 | 安装器是"进程最干净"时刻（旧版多半已退出）；首启兜底覆盖"安装器跳过/用户中途取消/旧版安装器仍被双击"等残余路径 |
| 卸载 vs 提示 | 未运行→自动静默卸载；运行中→弹窗并中止 | 自动卸载是升级主流程的应有步骤（用户已明确安装新版）；运行中强卸会导致旧壳文件半删、用户困惑，必须人工退 |
| 卸载数据 | `/S` 静默不触发"删除应用数据"确认页 → **数据目录不动** | NSIS 卸载器设计如此；AppData（dev.dsh.desktop）即使空壳重建过也保留（数据零风险优先） |

### 5.2 L2 首启兜底（Rust）

**5.2.1 新 command**（命名沿用现有风格：`get_shell_status` / `open_data_dir` 等）

`#[tauri::command] fn check_legacy_install(app: AppHandle) -> LegacyCheck`
`#[tauri::command] fn cleanup_legacy_install(app: AppHandle) -> LegacyCleanupResult`

```rust
/// legacy_install.rs（或 lib.rs 内新段）
struct LegacyCheck {
    legacy_dir: Option<PathBuf>,        // %LOCALAPPDATA%\dsh Desktop，uninstall.exe 存在才算
    legacy_running: bool,               // 进程扫描：dsh-desktop.exe 且 ExePath 前缀 == legacy_dir
    legacy_shortcuts: Vec<PathBuf>,     // 桌面/开始菜单两个已知 lnk（存在才列）
    legacy_data_recreated: bool,        // dev.dsh.desktop 存在（空壳重建迹象）
    can_cleanup: bool,                  // legacy_dir 存在 && !legacy_running
}
struct LegacyCleanupResult { removed_dir: bool, removed_shortcuts: usize, uninstaller_exit: Option<i32>, skipped: Vec<String> }
```

**5.2.2 白名单与安全规则（硬约束）**

- 旧目录判定：`base == %LOCALAPPDATA%`（`local_data_dir` 的 parent）且 `name == "dsh Desktop"` 且其中存在 `uninstall.exe`；三者缺一 → 不认为旧安装，cleanup 拒绝执行。
- 快捷方式删除：仅允许两个精确路径（`Desktop\DSH Desktop.lnk`、Start Menu Programs\`DSH Desktop.lnk`），且**读取 lnk 的目标**（`WScript.Shell` COM 经 `windows` crate 或直接调 `IShellLink`，Rust 侧可用 `std::os::windows` 无现成 API——方案：用 PowerShell 一行读 target）确认以 `dsh Desktop\dsh-desktop.exe` 结尾才删；读不到 target 的不删（跳过并记录）。
- 运行中检测：枚举进程（`windows` crate 的 `EnumProcesses` + `QueryFullProcessImageName`，或转调 PowerShell `Get-CimInstance`——Rust 侧优先 `sysinfo`/`windows-rs` 还是保持零依赖？本项目 Cargo.toml 目前无 sysinfo；**倾向新增 `sysinfo = "0.30"`**（纯 Rust、跨平台、已有生态；或最小化走 `windows` crate？看 tauri 已依赖 windows-rs 系列，可直接 `use windows::Win32::System::ProcessStatus` —— 但 tauri 不暴露 windows crate 依赖名。务实选择：`sysinfo` 一行依赖，代价小）。
- 模式 A（推荐，零新依赖）：调用一次 `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='dsh-desktop.exe'\" | % { $_.ExecutablePath }"`，stdout 匹配前缀。启动时一次性的百毫秒级调用完全可接受（现有 toast activator 已有 reg.exe 先例）。**采用 A，避免新增依赖**。

**5.2.3 cleanup 执行流**

1. `check` 通过（目录+非运行）或用户强制（目录存在但运行中 → 返回 `{blocked: true, reason: "running"}`，UI 提示退出）；
2. 静默卸载：`Command::new(legacy_dir.join("uninstall.exe")).args(["/S", &format!("_?={}", legacy_dir)])`，`CREATE_NO_WINDOW`（复用 `no_console_window`），超时 60s（超时则记录并继续下一步——不阻塞清理快捷方式）；
3. 删快捷方式（白名单+target 校验）；
4. `RMDir` 式清空旧目录中**确定的残留**：只删 `legacy_dir` 自身若为空；非空不递归删除（卸载器失败时保留现场，记日志）；
5. 每步写 `log_line`（session.log）+ eprintln；结果返回 UI。

**5.2.4 启动时自动检测（L3 防分叉）**

`setup()` 中 `migrate_legacy_data` 之后：

```rust
// 迁移已完成后，旧数据目录若再次出现 → 说明旧壳被启动过（空壳重建）
let legacy_data = app_data_dir 的 parent.join("dev.dsh.desktop");
if legacy_data.is_dir() { log_line(... "legacy data dir recreated (old shell ran?)"); 置 FLAG; }
```

启动页通过 `get_shell_status` 扩展字段（或新桥 GET `/legacy`）读取 → 横幅：

> "检测到旧版（DSH Desktop 0.3.x）曾在本机运行，可能重建了空数据目录。建议在「DSH Desktop」菜单 →「旧版清理…」中清理。" + 按钮 [立即清理] [稍后]

### 5.3 UI 三入口

1. **启动页横幅**（一次性，`app.js`：新增 `showLegacyBanner(check)`，复用 `showActionable` 的风格，非红字——横幅样式 +「清理」「稍后」按钮；数据挂在 `get_shell_status` 扩展 JSON 或单独 invoke `check_legacy_install`）；
2. **壳菜单** `SHELL_MENUS` + `ACTIONS`（双通道，契约测试同步）：`{ id: 'legacy-cleanup', label: '旧版清理…' }` → ipc `check_legacy_install` 结果渲染壳内模态（复用 about/check-update 的 Shadow DOM 模态模式），按钮调 `cleanup_legacy_install`；
3. **设置页**（`settings.html` 新 `set-group`："升级与旧版"）：只读状态 +「清理旧版」按钮（dev/正式均有菜单，但正式才显示有效状态）。

### 5.4 桥端点与契约测试

- 桥 GET `/shell/legacy`（check）+ POST `/shell/legacy-cleanup`（cleanup）——与现有 `/shell/status` 同模式；
- `scripts/test-shell-chrome.mjs` 契约测试补：菜单项存在、ACTIONS 映射存在、桥端点被实现；
- `migration_tests` 风格补 Rust 单测：白名单判定（目录名/父级/uninstall.exe 三条件）、lnk target 校验函数、路径组合表。

### 5.5 版本与快捷方式策略固化（M3）

- 文档约定（README / ENGINEERING-NOTES / dsh-desktop-shell-dev 技能）：**正式版 productName 与 NSIS 安装目录名、快捷方式名一经定型不得随版本改动**；标识变更必须配本次"旧版接管"全套；
- 快速检查加入 CI 冒烟：`check` 脚本断言 `tauri.conf.json` 的 productName 与上一发布 tag 相同（首次引入时记录基线）。

## 6 异常与边界（失败安全表）

| 场景 | 行为 | 结果 |
|---|---|---|
| 旧版运行中装新版 | L1 弹窗中止；L2 按钮阻塞并提示退出 | 不半删，用户退后重试 |
| uninstall.exe 静默卸载失败 | L2 记录 exit code，继续删快捷方式，保留目录；横幅提示"旧版卸载未完成，请手动卸载" | 数据零风险 |
| lnk target 读不到 | 跳过删除，记日志 | 残留 lnk 无害（指向失效 exe，点开报错引导卸载） |
| dev 版目录被误判 | 不可能：白名单精确到 "dsh Desktop"，与 "DSH Smoothly Desktop Dev" 名不同 | — |
| 数据目录（AppData/dev.dsh.desktop）| 永不删除，仅检测+提示 | 数据零风险 |
| 迁移未发生（全新机）| 检测无旧安装 → 全链路空转 | 无感 |

## 7 测试计划

1. **Rust 单测**（`migration_tests` 旁）：`is_legacy_install_dir`、`legacy_shortcut_candidates`、`should_delete_shortcut(target, legacy_dir)` 表格化用例（含常见误判：同名前缀目录、dev 目录、无 uninstall.exe）。
2. **契约测试**：`test-shell-chrome.mjs` 补菜单/桥断言。
3. **手工冒烟矩阵**（M1/M2 完成后跑一遍）：
   - 全新机装 0.4.1 → 无横幅；
   - 预置 0.3.10（装旧包+造数据）→ 装 0.4.1：L1 静默卸载旧版、快捷方式消失、0.4.1 首启数据完整（5 会话可见）；
   - 旧版运行中装 0.4.1：弹窗中止；退出后重装成功；
   - 双击旧版残留 exe（未卸载场景）→ 新壳首启横幅出现 → 「旧版清理…」→ 卸载完成、lnk 消失、dev.dsh.desktop 仍在（数据保留）→ 会话完整。
4. **CI 冒烟门禁**：release 工作流加一步（可选 M3）：构建产物内含 installerHooks（`strings|grep '$LOCALAPPDATA\dsh Desktop'` 或直接检查产物体积/标志位）。

## 8 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1（0.4.1）| L2+L3：Rust check/cleanup、启动页横幅、菜单+设置、桥、契约/单测 | 冒烟矩阵 4 场景全绿 |
| M2（0.4.1）| L1：installerHooks .nsh + 配置 | 安装器自动接管旧版（未运行）；运行中提示 |
| M3（0.5.0）| L4：版本策略文档 + CI 断言 + README 升级章节 | 文档落地、CI 绿 |

## 9 风险登记

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| wmic/tasklist 在安装器环境不可用 | 中 | L1 检测失效（落到 L2） | 设计上 L2 权威兜底；卸载失败不致命 |
| 静默卸载弹窗残留 | 低 | 打断安装 | `/S` + `_?=` 组合为 NSIS 标准静默；冒烟验证 |
| NSIS hook 宏与 Tauri 打包器版本的兼容 | 低 | 构建失败 | M2 先行在 dev 工作流构建验证再发布 |
| 用户已卸载但 lnk 残留 | 高（现状）| 点旧图标报错 | L1/L2 都覆盖 lnk 删除；报告给用户 |
| 误删用户同名 lnk（自定义 "DSH Desktop.lnk"）| 极低 | 删了用户快捷方式 | target 校验才删 + 删除前记录日志 |

## 10 代码位置索引（实现时对照）

- 迁移与 setup：`src-tauri/src/lib.rs:490-563`（迁移）、`:2185`（调用）、`:2099`（run）
- 命令注册：`lib.rs:2408` `invoke_handler`
- 桥端点：`lib.rs:821-920`（`start_bridge`/`handle_bridge_conn`）
- 菜单/动作表：`src-tauri/resources/ui/shell-chrome.js:36/58`
- 启动页：`src/app.js:14/141`（setState/showActionable）
- 设置页：`src/settings.html:17/39`（set-group）
- 契约测试：`scripts/test-shell-chrome.mjs`
- NSIS 配置：`src-tauri/tauri.conf.json` `bundle.windows.nsis`
- 迁移单测：`lib.rs` `mod migration_tests`（:586+）
## 附录：M1/M2 实现记录（2026-09-03）

**已落地（与设计稿的偏差说明）**
- Rust（`src-tauri/src/lib.rs`）：`legacy_check_json` / `legacy_cleanup_json` 纯函数 + 两个
  `#[tauri::command]`（`check_legacy_install` / `cleanup_legacy_install`）+ 桥端点
  `GET /shell/legacy` / `POST /shell/legacy-cleanup`；`migrate_legacy_data` 增加迁移前备份；
  `user_home()` 用 USERPROFILE/HOME 环境变量（未依赖 tauri PathResolver.home_dir 的版本差异）；
  运行中检测与 lnk target 读取走 PowerShell（`powershell_lines` 辅助，cfg(windows) 内含）。
- UI：壳菜单「旧版清理…」（壳内模态弹窗，就地动作，不入 ACTIONS，契约测试 IN_SHELL_ACTIONS 豁免）；
  启动页横幅（`index.html` + `app.js`，sessionStorage"稍后"一次性）；设置页「升级与旧版接管」区块。
- NSIS：`src-tauri/resources/nsis/legacy-takeover.nsh` 挂 `NSIS_HOOK_PREINSTALL`
  （wmic 检测运行中→弹窗 Abort；否则 `uninstall.exe /S _?=` 静默卸载 + 删快捷方式 + 空目录回收），
  `tauri.conf.json` 加 `installerHooks`。
- 单测：`migration_tests` 内新增 4 个（白名单判定 / 快捷方式候选 / 备份清单与复制 / target 前缀语义）。
- 文档：README「升级与数据安全」章节（迁移/备份/接管/数据故障处理预案）。

**验证状态**：本地 JS 语法 + 契约测试 + tauri.conf JSON 校验全绿；Rust 编译与单测依赖 CI
（本地缺 libdbus/llvm-rc 且无 sudo）。M1/M2 合并为一个提交，CI check 通过即具备发布条件。
