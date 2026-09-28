# Agent Note: dsh-020-rc1-regression-and-adaptation

Status: implemented

## Problem

dsh 发布线推进到 `next` 通道的 0.2.0-rc.1（261 个提交、2026-09-24→09-28），而 dsh-desktop 依赖 dsh 的三类契约：web profile 的 patch 注入（overlay 定向覆盖 loader 行）、`dsh web` 的 CLI 参数、客户端插件 API（seam 与槽位）。同时我们的四个预装插件也依赖客户端 seam。此前 0.1.7 升级时出现过"sources 全绿但真机 UI 打不开"的教训，因此 0.2 必须**实证回归**而不是假设兼容。

## Decision

对 dsh `next` 通道的 **0.2.0-rc.1** 完成回归与适配，结论与落地如下。

**壳的契约在 0.2.0-rc.1 上成立（实证，非静态判读）**：overlay 的 `insert` 与 `- id: ui-sidebar-browser, disabled: false` 目标行仍在（`--dump-config` 扁平化口径，182→183 个 id；消失的只有 `schedule`/`time-context`/`ui-schedule`，新增 `otel`/`product-analytics`/`desktop-product-telemetry`/`ui-settings-session-log`）；壳的桥准入在 0.2 上 **10/10 PASS**（`allow-origin` 跟随新端口、`x-dsh-shell` 预检放行、危险动作未执行、三条 reject 审计）；shell chrome 注入与 caption 契约在 1924×1243 最大化下无错位；`dsh web` 的启动参数（`--patch/--no-open/--host/--port`，**不带** `--profile`）在 0.2 上正确 —— 而 `dsh web --profile web` 在 0.2 会直接报错（`select a profile only once`）。

**修掉一个门禁自身的假红**：`scripts/test-patch-targets.mjs` 的 runtime 模式此前读 package 里的原始 `cordis.patch.yml` 并用**列首锚定**解析器，而上游很多行嵌在 group 里（缩进 4 空格，`ui-sidebar-browser` 就是），于是"目标行不存在"被误报。抽出 `dumpConfigIds(runtimeDir)`，**两种模式统一走 `--dump-config` 扁平化**（代码注释本来就写着 dump 才是权威口径，此前只有 fixture 路径照做）。对照：0.2 PASS / 0.1.7 PASS / fixture PASS / 两个负向对照红。

**四个预装插件：不需要改代码**（静态 + 运行时双证）。静态：它们用到的 seam（`slots`/`locale`/`remote`/`remote.settings`/`configForms`/`sessions`/`workspaces`/`connection`）与槽位 id（`settings.section`/`settings.general.item`/`conversation.session.header.utilities`/`sidebar.panellist`/`main`）在 0.2.0-rc.1 里全部仍有提供者/声明，`configForms` 仍是 `super(ctx, "configForms")`。运行时：dev 壳的 web profile 启用列表里 `dsh-kanban`/`dsh-model-reasoning`/`dsh-turn-navigator` 三个都在，且侧栏实测渲染出「思磨力看板」；四个包在 runtime 里的版本均已是 0.2.10/0.2.6/0.4.6/0.2.1。`@karoc/dsh-smoothly-opencode-session` 是 host-only 且**用户从未启用**（属用户设置，非断点）。

**设置迁移已用真实配置沙箱实测**：0.2 的导入器（`packages/settings/settings/src/index.ts` 的 `SettingsForms.importLegacyDocument`）**先把 `settings.yaml` 改名 `.imported` 再逐段搬进 profile**，被组合拒绝的段只留在 `.imported`（有 e2e 断言"值到达页面"）。用**正式版那份 15 KB 配置**（含 `llm-pi-ai`/`providers`/`apiKey`）在沙箱跑 0.2：旧文件原样改名保留、web 正常启动。dev 首启要求重填 API Key 是正常的（dev 旧设置只有 52 B 的 `ui-onboarding`/`welcomeNoticeVersion`，密钥在 `.credentials.yaml`）。

**UI 走查的工具学（重要）**：`verify-dev-ui.ps1` 的 `click`（真实鼠标）在 WebView2 内容上不可靠 —— 同一个「继续」按钮点两次都不消失，而 `invoke`（UIA InvokePattern）立即生效；0.2 首启是两步引导（`预览版说明` → `添加一个 API Key 开始使用`），必须用 `invoke` 过。副作用：`设置` 这类侧栏项**没有 InvokePattern**，需要 click 或键盘。
## Alternatives considered

**① 直接把 `MIN_DSH_VERSION` 抬到 0.2.0-rc.1**：否决 —— 0.2 仍在 `next` 预发布通道，抬地板会让所有用户被强制升到预览版；且"值到达页面"这一步还没在副本上验完。改为：**地板保持 0.1.7-rc.2**，0.2 走 `next` 通道由用户可选。**② 刷新 patch id fixture 到 0.2 的 183 个 id**：否决 —— fixture 记录的是"地板版本的上游形状"，地板没动就不该动 fixture（否则门禁会拿 0.2 的 id 集去校验"0.1.7 地板"的兼容性，等于偷换判据）。**③ 用 `click` 继续做 UI 走查**：否决 —— 在 WebView2 内容上两次点击同一按钮均无效，`invoke` 立即生效；继续用 click 只会把工具问题误判成上游 bug（本轮差点就这么结案）。**④ 把 `ui-sidebar-browser` 覆盖删掉**（因为门禁报"id 不存在"）：否决 —— 先用真机 runtime 复跑并读 dump 才定位到是**门禁解析口径**问题，删覆盖会丢掉侧栏浏览器页的恢复能力。


