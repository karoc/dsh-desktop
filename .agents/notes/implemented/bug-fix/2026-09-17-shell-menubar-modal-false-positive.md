# Agent Note: shell-menubar-modal-false-positive

Status: implemented

## Problem

壳把 dsh 页面上的**模态弹窗**误判为「插件全屏浮层」，在弹窗打开时自动收起菜单栏（用户看不到菜单栏，只有顶缘悬停才能唤出）。触发场景是首次使用/未配 API Key 时的「添加一个 API Key 开始使用」弹窗——而 dsh 自己在这类场景明确要求保留顶部栏（其 OnboardingSurface 的遮罩从 top:80px 起就是为此）。该行为与 dsh 版本无关，是壳侧探测判据过粗；排查时我先误判为 0.1.6 引入的回归，后经 A/B 复核与探针实测纠正。

## Decision

壳注入的菜单栏（`src-tauri/resources/ui/shell-chrome.js`，include_str! 编译期内嵌）在判「插件全屏浮层」时不再只看「是否覆盖视口」。`probeFullscreen()` 现在要求同时满足：命中点向上找到的 fixed 全视口祖先 ① 不内含 `[role="dialog"][aria-modal="true"]`（`isModalCover()`），② 且有子元素越过菜单栏区域（`blocksMenubarBand()`，`MENUBAR_H = 36`）。①排除 dsh Modal（API Key 引导、设置弹窗等：对话框居中、遮罩自 top:0，`pointer-events` 属页面级语义）；②排除 OnboardingSurface 这类 `role="presentation"` 的引导浮层（其 mask 自 top:80px 起，dsh CSS 明确要保留产品顶栏）。插件全屏页（看板 `.kb-overlay`）两条都不满足，仍按原行为收起菜单栏并在顶缘留 4px 悬停条。负向保证：探测只在主窗口、页面可见、壳内模态未打开时进行；不改变菜单栏 36px 浮层高度契约、不引入推挤布局、不依赖任何插件配合。调试用探针输出（`TEMP-DEBUG` 覆层）只存在于一次性分支 tmp/probe-debug，已删除、未进入发布分支。
## Alternatives considered

**只按「内容是否触及菜单栏区域」判定（首版方案）**——实测无效：dsh Modal 的遮罩层自身自 top:0 起，band 判据恒为 true，弹窗仍在收起菜单栏。**按类名/选择器识别遮罩**（如 `[class*=mask]`）——放弃：dsh 的 CSS Module 类名带哈希（`_mask_w1urq_14`），跨版本不稳定。**改为推挤式布局**（菜单栏占位而非浮层）——放弃：会改变所有页面的高度契约，波及插件全屏页与已验收的顶缘悬停交互。**把问题当作 0.1.6 回归去改探测阈值**——放弃：实测 0.1.5 行为相同，阈值调整治不了模态遮罩。
## Consequences

代价：探测多了一次 `querySelector` + 子元素 rect 计算（每 800ms 一次，可忽略）；语义依赖 dsh Modal 保留 `role="dialog"` + `aria-modal="true"`（官方 a11y 语义，若将来移除则该模态会重新触发让位）；`blocksMenubarBand` 依赖「插件全屏页内容贴顶」这一经验事实——若某插件把内容整体下移 >36px，其全屏页将不再让位（届时菜单栏会浮在其顶部，属可接受退化）。已用真实 WebView2 验证模态、普通页、看板全屏三态；未加入自动化测试（playwright 未安装，`scripts/verify-fullscreen-adaptation.mjs` 仍是可选脚本，本次未执行）。

