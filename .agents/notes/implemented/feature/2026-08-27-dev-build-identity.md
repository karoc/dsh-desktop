# Agent Note: dev-build-identity

Status: implemented

## Problem

用户的 Windows 已安装正式版 DSH Desktop，覆盖安装升级会动到其工作数据；需要一种方式产出一个独立身份的"开发版"安装包，能在同一台 Windows 上与正式版并存安装、各自调试，互不覆盖、互不影响（数据、托盘、通知、单实例）。

## Decision

开发版 = `npm run bundle:dev`（tauri build --config src-tauri/tauri.dev.conf.json --bundles nsis），dev 配置深合并只覆盖两个顶层字段 productName="DSH Desktop Dev" 与 identifier="dev.dsh.desktop.dev"，其余（windows 数组、NSIS、资源等）原样继承。身份驱动全部隔离：应用数据目录 %APPDATA%\<identifier>（runtime/dsh 本体/DSH_HOME/proxy.json 独立）、单实例互斥 {identifier}-sim（tauri-plugin-single-instance 命名规则，两版可同时运行）、NSIS 安装目录/开始菜单/卸载项按 productName、任务栏 AUMID 随 identifier。Rust 侧 toast 激活全面参数化：show_toast 的 notify-rust app_id 与 register_toast_activator 的 AUMID 均取 app.config().identifier；激活 CLSID 由 toast_clsid() 派生——identifier=="dev.dsh.desktop" 时返回历史固定 GUID {7C2F4B1A-…}，其它 identifier 用 FNV-1a×2（种子 0xcbf29ce484222325/0x9e3779b97f4a7c15）拼 16 字节并置 RFC-4122 version/variant 位生成稳定 GUID；ensure_shortcut_toast_activator 按 productName 生成快捷方式候选名（含小写首字母变体）。窗口标题、托盘 tooltip、设置窗口标题、关于 toast 标题全部用 app.package_info().name；is_dev_build()（identifier≠官方）时关于 toast 追加「（开发版）」；chrome 注入前缀增加 __DSH_PRODUCT_NAME__，顶栏应用菜单标签用它渲染。tauri.dev.conf.json 不覆盖 version（tauri-cli 要求与 Cargo.toml 一致）。scripts/test-shell-chrome.mjs 新增第 7 组断言守护 dev 配置与 CLSID/产品名注入。CI 不构建 dev 变体。
## Alternatives considered

**环境变量/编译开关切换身份**：编译期不确定、容易误产出正式包，否决。**单独 Cargo feature + 完整双 tauri.conf**：维护面翻倍（windows 数组等须同步），否决；深合并只覆盖两个顶层标量即可。**dev 配置覆盖 version**：tauri-cli 强制 tauri.conf.json 与 Cargo.toml 版本一致，会报错，故开发版沿用 0.3.10，靠名称区分。**给 toast 激活器换 uuid crate**：为派生一个 CLSID 引入依赖不值，用 FNV-1a×2 拼 16 字节 RFC-4122 形状 GUID（确定性、无碰撞实际风险）。
## Consequences

代价：dev 身份派生 CLSID 仅用于非正式 identifier，正式版 GUID 保持不变（既有注册自愈覆盖）；开发版与正式版版本号相同，区分靠名称与「（开发版）」标识；toast 激活注册按 identifier 分开后，两版通知互不串扰，但同一机器上两版同时收到各自 toast（符合预期）。收益：`npm run bundle:dev` 一条命令产出与正式版完全隔离的安装包：安装目录/开始菜单/卸载项（%LOCALAPPDATA%\DSH Desktop Dev）、应用数据（%APPDATA%\dev.dsh.desktop.dev，含独立 dsh 本体与 DSH_HOME）、单实例互斥（dev.dsh.desktop.dev-sim）与任务栏 AUMID、toast CLSID 全部独立，两版可同时运行互不影响。遗留：开发版首次启动需冷装一份 dsh；CI 不构建 dev 变体（本地脚本，文档已说明）。

