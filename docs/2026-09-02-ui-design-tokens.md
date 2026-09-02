# DSH Smoothly Desktop — UI 设计规范（统一样式 token）

唯一真源：本文件。壳内（`shell-chrome.js` 的 `:host` / `@media`）、设置窗/启动页
（`src/styles.css`）、插件管理窗口（`src/plugin-console.js`）三处**独立打包、无法共享
CSS**，统一 = 按本规范同一数值分别实现。改动任一 UI 面的样式时，先按本表对齐，再调。

## 设计原则

1. **几何/层级/动效全局统一**；**颜色**：壳内 + 设置窗跟随系统深浅色（`prefers-color-scheme`），
   插件管理窗口保留 4 套主题（深空/极光/月光/琥珀）**仅作配色**（几何不再随主题变化）。
2. **布局不动**：尤其插件管理窗口——区块顺序（head → 安装 → 预装 → 用户 → dsh 更新 →
   操作 → footer）与信息架构是硬约束，结构测试 `scripts/test-plugin-console-window.mjs` 守护。
3. **主按钮一律纯色 accent**（不用渐变）；渐变仅保留给「组件个性」：开关 on 态、
   升级箭头、安装进度条、主题点。

## 几何 token

| Token | 值 | 用于 |
|---|---|---|
| 圆角 sm | **8px** | 按钮、输入框、下拉条目、toast |
| 圆角 md | **12px** | 卡片行、插件卡片、设置组卡 |
| 圆角 lg | **14px** | 下拉浮层、壳内弹窗卡片、确认框卡片 |
| 圆角 full | 999px | 徽标、主题点、开关、升级箭头 |
| 阴影 float | `0 12px 36px rgba(0,0,0,.16), 0 1px 2px rgba(0,0,0,.08)`（深色 .5/.3） | 下拉、弹窗、toast、确认框 |
| 阴影 card | 主题 `shadow`（配色氛围） | 插件管理卡片/弹窗 |
| backdrop | `rgba(0,0,0,.35) + blur(3px)` | 所有模态遮罩（弹窗/确认框） |

## 按钮

| 规格 | 值 |
|---|---|
| 常规/主按钮 | 圆角 8、`min-width 72px`、`padding 7px 16px`、字号 13px（行内小按钮如「卸载/更新/恢复」可紧凑：圆角 8、字号 12.5px） |
| primary | 纯色 `accent`、白字、hover `brightness(1.08)` |
| danger | 纯色错误色（`--dsh-err` / `--dsh-close`）、白字、hover `brightness(1.1)` |
| secondary | 透明底 + 边框 |

## 字号

11 辅助 / 12 次要 / 12.5–13 正文 / 14 小节标题与弹窗标题 / 15–17 页标题（设置窗 h2 17、插件管理标题 15）。

## 动效 / 焦点 / 无障碍

- hover 120–150ms；浮层/弹窗入场 150–180ms ease-out；`prefers-reduced-motion` 全部降级。
- 交互元素统一焦点环（2px accent、`focus-visible` 触发）。
- 键盘：下拉全键盘导航（↑↓/Home/End/Enter/Esc）；弹窗 Esc 关闭。
- **不使用原生 `confirm()`**——一律用壳内确认弹窗（`showConfirm`，含 [取消][确认(danger)]）。

## 例外（有意保留）

- 启动页（`index.html`/hero）大按钮 14px、`padding 8px 20px`（全屏加载场景的 CTA）。
- 开关 on 态 / 升级箭头 / 安装进度条保留渐变（组件个性，属配色）。

## 三处接入点

| 面 | 文件 | 说明 |
|---|---|---|
| 顶栏/下拉/壳内弹窗/toast/确认 | `src-tauri/resources/ui/shell-chrome.js`（STYLE 常量，Rust include_str 内嵌） | 系统深浅色 `--dsh-*`；`.dd-*`/`.dialog-*`/`.dlg-*`/`.mini-toast` |
| 设置窗/启动页 | `src/styles.css` | 系统深浅色 `--bg/--card/--border/--fg/--muted/--accent` |
| 插件管理窗口 | `src/plugin-console.js`（`injectStyle` + `applyTheme`） | `.dshc-*`；主题只设配色变量，几何固定 |

## 维护约定

- 新界面/组件按本表数值实现，不许引入新的圆角/字号/按钮规格。
- 改插件管理窗口样式后，跑 `node scripts/test-plugin-console-window.mjs`（守护布局顺序 +
  主按钮纯色 + 无原生 confirm + 主题纯配色）。
- 契约测试 `scripts/test-shell-chrome.mjs` 守护壳菜单/弹窗相关标记。
