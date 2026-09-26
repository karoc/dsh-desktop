# 壳改进实施方案 v2（P0/P1/0.1.7 必办/P2；已过三角度审计 + 代码级取证）

- 依据：[对比报告](./2026-09-25-official-desktop-0.1.7-rc.2-vs-dsh-desktop.md) §5/§6/§7。
- 我方坐标：v0.11.0 工作副本（HEAD `4b05664` + 未提交的 0.1.7-rc.2 地板改动）。
- 审计证据：`.tmp-investigate/plan-audit/{a-contracts,b-side-effects,c-verifiability,evidence-e1-e2}.md`。
- 本文件 v2 取代 v1；v1 中被证伪的断言见 §1.2。

---

## 1. 修订摘要（v1 → v2）

### 1.1 结构变更

| 变更 | 原因（审计/实测依据） |
|---|---|
| **S2（peer 自检）移出实施** | 实测：4 个预装插件只声明 `react` peer、OCS 无 peer、通知插件声明 `@deepseek-ai/dsh-client-runtime`（满足）→ 上游闸门对现有包**永不触发**；且上游对非法范围 **fail-closed**，手写实现是 fail-open，会漏报（A §3） |
| **S7（locale 注入）移出实施** | 注入形状必须是 `{languages, preference}` 否则 `parseLocaleBootstrap` 抛 TypeError（A §8）；即使写对，`languages:['zh-CN']` 会把"跟随系统语言"的默认钉成中文 = **行为变更**，不满足"无副作用" |
| **S4 改为采用仓库既有分阶段设计** | 2026-09-09 的审计已定稿"槽位 + confirm 窗 + IPC `resolve_pending_action(nonce)`"的非阻塞方案（`docs/2026-09-09-pending-cards-solutions.md:167`）；v1 的"同步等待"是**回退**，且会与同步 IPC 命令一起造成主线程死锁（A §5.5/§14） |
| **S9 落点改为 Rust 读 marker** | `manager-exit`/`server-down`/`/alive` 全在 Rust 手里，manager 塞不进字段（A §10.3/10.4） |
| **S10 改为 manager 写 `dsh.json`** | `ensurePreinstalled` 本来就逐个读 `package.json`（`server-manager.mjs:1063-1066`），版本顺手可得，Rust 只需读 dsh.json（A §11、C §4） |
| **S6 缩小为"按钮指向证据目录"** | 实测/核验：失败态**已有 3 个按钮**（`src/index.html:31-33`）且**已显示完整证据路径**（`src/app.js:180-185`）→ v1 的两条前提都错（A §13 #7/#8） |
| **S8 增加"注入时序"修法与验收** | 客户端在 **render 时**读 `data-windows-titlebar`（`AppFrame.tsx:168-170,263-264`），而我们在 `on_page_load` 之后才 `eval`（`lib.rs:3592-3607`）→ 晚注入时列宽不重算，刷新也救不回来（A §9.5） |
| **Rust 验证路径改为交叉 target** | 本机无 sudo、缺 dbus/webkit → linux 目标不可编译；但 **windows 目标只差 `llvm-rc`**，用本地桩后 `cargo check/clippy --target x86_64-pc-windows-msvc` 实测通过（E3） |

### 1.2 v1 被证伪的断言（13 条，均已修正）

1. S1 验收"stderr 不出现 `disabling/skipping`"→ **恒真**（`disabled:` 行不打印任何东西；E4 实测不存在的 id 也无输出）。改为 `--dump-config` + id 存在性 + 名册计数三重（E1/E4 已实测双向）。
2. S1"恢复到官方桌面端同款浏览器"→ 实际恢复的是 **iframe 版**（`ui-sidebar-browser/src/client/index.ts:68-72,97-99`，A §2）。
3. S2"与上游同规则"→ 不可达（fail-closed vs fail-open），已移出实施。
4. S3 版本水位"≥0.1.7-rc.2"→ 应为 **0.1.7-alpha.1**（该 tag 起 `SESSION_FORMAT_VERSION = 4`，A §4 边界 1）。
5. S3"回退旧版不可读"→ 措辞过强：迁移是**旁挂新代文件**，旧版会读到升级前的 v3 快照（A §4 边界 3）。
6. S4"壳自己的脚本与通知插件都在同源页内"→ **错**：页面端口 ≠ 桥端口 = **跨源**；今天 POST 能过只因 `Allow-Headers: content-type`（A §6.3）。
7. S4"IPC 命令名与桥路径相同"→ **错**（`update_now`/`quit_app`/`restart_server`…），映射应从 `shell-chrome.js:74-104` 的 `ACTIONS` 取（A §5.3）。
8. S4"`/devtools` 可不确认（有 devMode 门）"→ **自相矛盾**：devMode 门由桥上的 `/shell/dev-mode-toggle` 打开 → 该端点必须进危险集（A §5.2）。
9. S4"`confirm_action(action, detail)` 由调用方给 detail"→ 可伪造确认文案；必须 **Rust 按 action id 生成**（A §5.5、2026-09-09 设计）。
10. S4"改 `call()` 加头"→ 应改 **`bridge()`**（`shell-chrome.js:132-141`），`call()` 只是分发（A §6.2）。
11. S7`read: () => 'zh-CN'`→ **抛 TypeError**（A §8）。
12. S8"展开态客户端回退 48px"→ 48 是**消费者回退字面量**（`preload-menu.ts:16`），客户端从不设它（A §9.2）。
13. S9"manager 在事件里带 upgrade"/"复用原子写工具"→ 落点错误 + 无现成工具（A §10）。

---

## 2. 范围

### 2.1 实施（本轮）

| 序 | 项 | 本地验证方式 |
|---|---|---|
| S0 | 仓库卫生：断链 script、`TEST_NODE` 接线、测试子进程清理、Cargo.lock 版本、4 处版本一致性断言 | `npm test` + 新门禁 + 负向对照 |
| S1 | M-1 侧栏浏览器页 overlay 恢复（iframe 版） | `--dump-config` + id 契约 + 名册计数（三重，已实测） |
| S3 | B-1 回滚纪律（README 措辞按 A §4 修正 + 检查更新弹窗警告 + 打开数据目录按钮） | 文案断言 + 负向对照 |
| S6 | 失败态：第三个按钮指向**证据目录**（路径已显示，不动） | 契约断言（命令已注册） |
| S10 | 关于弹窗显示预装插件版本（manager 写 `dsh.json`，Rust 读两处 JSON） | Node 断言 + Rust 类型检查 |
| S4 | 桥收口：阶段 0（Host/Origin 校验 + Allow-Headers/OPTIONS 同步）+ 阶段 1（危险端点→槽位+confirm 窗+IPC 结算）+ 阶段 3（ACAO 收敛） | Rust 单测（平台无关纯函数）+ 契约测试 + 手动预检核对 |
| S5 | 关窗首次确认（复用 S4 的 confirm 窗，异步；决策逻辑抽纯函数） | Rust 纯函数单测 + 手动 |
| S8 | 顶栏契约 caption 模式（flag 门控默认关 + resize nudge + runbook） | 契约测试（纯函数返回值）+ 手动 6 项 |
| S9 | 升级归因：manager 写 `upgrade.json`（原子）+ Rust 读入 `manager-exit` + `/alive` 清除 + 启动页归因与一键回退 | fake-dsh 场景 + Rust 类型检查 |
| S11 | V-1 实验：0.1.7-rc.2 下 hoisted vs isolated | 真机真 dsh（Linux） |
| S12 | 文档总同步（README/CONTRIBUTING/技能/Note/看板映射） | 断言 + 人工走查 |

### 2.2 明确不做（本轮）

| 不做 | 理由 |
|---|---|
| S2 peer 自检 | §1.1（近乎空转 + 不可能与上游等价） |
| S7 locale 注入 | §1.1（形状易错 + 默认语言行为变更） |
| P1-1a/1b 签名与自更新 | 需用户采购证书；无签名先做自更新会把"无鉴权控制面 + 下载执行"叠加 |
| P1-6 共享 DSH_HOME 开关 | 通知插件在 `<runtime>/node_modules`，共享模式下 profile 解析找不到它；改成写用户全局目录是污染 |
| P2-5/2-6/2-7 | 收益真实但不紧急，避免一次改太多面 |
| P2-1 `--patch` 宿主侧插件 spike | 与 S11 合并尝试；不成则留卡 |
| Electron 重写 / 打包内 dsh / 强更 / macOS / 官方卸载数据口径 / fork NSIS | 报告 §5 已论证 |

### 2.3 待用户（一次批齐，见 §7）

---

## 3. 逐项方案（v2）

### S0 仓库卫生

**改动**：
1. 删 `package.json:23` 断链的 `test:console-window`；新增 `scripts/test-package-scripts.mjs`：遍历 `package.json.scripts` 中所有 `node <path>.mjs` 形式（含带参数），路径不存在即失败（**负向对照**：临时把某个路径改坏必须红）。
2. `test-broken-install.mjs` 接线进 `npm test`，**必须**带 `TEST_NODE=$PWD/src-tauri/resources/node/<plat>/node`（实测：系统 node 下 manager 的 npm 回退路径失效 → FAIL；bundled node → PASS 32s）；并修它的清理：`finally { child.kill('SIGKILL'); server.close() }`（实测失败时会**泄漏假 dsh 子进程**）。
3. `test-install-stall.mjs` 进新脚本 `test:slow`（不进 `npm test`）：实测 **190.6s**，加上 broken-install 共 +3.7 分钟，会拖垮 PR 门禁。
4. `src-tauri/Cargo.lock` 的 `dsh-desktop` 版本 0.6.3 → 0.11.0（任何 cargo 命令都会改它；release-please 不 bump）；新增 4 处版本一致性断言（`package.json` / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock`）进 `test-shell-chrome.mjs` 或独立脚本。
5. `cargo fmt --check`：**不改 CI**；`CONTRIBUTING.md:43` 的"CI 快层会跑 fmt"与 `build.yml:41-44` 矛盾 → 改写为"格式靠自律 + 禁全仓格式化提交"。

**验收**：`npm test` 11 套全绿（含新门禁）；负向对照：改坏 script 路径 → 红；删 Cargo.lock 版本行 → 红。
**回滚**：单提交 revert。

### S1 侧栏浏览器页恢复

**patch**（`src-tauri/resources/patch/dsh-desktop.patch.yml` 追加，格式已用 `--dump-config` 实测生效）：
```yaml
# 0.1.7-rc.2 起上游把该行门控到 profileContext.name === 'desktop'；我们只能用 profile web，
# 故按官方 README 的写法显式覆盖回启用（恢复的是 iframe 版浏览器，不是 Electron 版）。
- id: ui-sidebar-browser
  disabled: false
```

**验收（三重，全部已实测双向）**：
1. 离线：`dsh --profile web --dump-config --patch <patch> | grep -A3 'id: ui-sidebar-browser'` 必须显示 `disabled: false`（删掉 overlay 两行 → 变回 `disabled: !!js …`）。
2. 契约：新增 `scripts/test-patch-targets.mjs` 解析 overlay 里每个 `- id: <x>`，断言 x ∈ 已安装 `@deepseek-ai/dsh-web-app/cordis.patch.yml` 的 id 集合（防上游改名后静默打空——**实测打空无任何日志**）；负向对照：把 id 改坏 → 红。
3. 运行期（S11 同一次跑）：起真 dsh 后取首页 HTML，`grep -c 'dsh-client-ui-sidebar-browser/client.js'` = 1；无 override = 0。
**回滚**：删两行。**副作用**：无（仅覆盖一行 `disabled`）；`/plugins/<id>/client.js` 状态码**不可**作为验收（两种情况都 200，已实测）。

### S3 回滚纪律

**改动**：
1. README「升级与数据安全」改写为（按 A §4 修正）：0.1.7 系列（**alpha.1 起**）把会话写成 **v4**，旧读取器**拒绝**读新代文件；迁移是**旁挂新代文件**，所以回退旧版会看到升级前的旧快照——**不要以"还能打开"判断回滚成功**；回滚 = 还原升级前的数据目录备份。
2. 「检查更新」弹窗（`shell-chrome.js` 的 `openCheckUpdateDialog`）在"立即更新"附近加一行警告 + 「打开数据目录」按钮（复用 `call('open-data')`）。
3. 不自动打包备份（避免为 GB 级会话做 zip 的失败面）。

**验收**：契约断言文案含"v4/不可回退/备份"三个关键词 + 弹窗含 `open-data` 调用；负向对照：删关键词 → 红。
**回滚**：文案 revert。

### S6 失败态按钮指向证据目录

**改动**：`src/app.js` 失败态：把「打开数据目录」按钮改为**优先打开证据目录**（有 `exit.evidenceDir` 时调 `/shell/open-evidence`，否则回落 `open-data`）；`src/index.html` 的按钮文案随状态切换；路径显示保持现状（已实现）。
**验收**：契约断言：`open_evidence_dir`/`open_data_dir` 均在 `invoke_handler` 注册且被 `src/app.js` 引用；负向对照：把命令名改坏 → 红。
**回滚**：revert。**副作用**：无（仅失败态）。

### S10 preinstalled 版本可视化

**改动**：
1. `server-manager.mjs` 的 `ensurePreinstalled()` 顺手写 `manifest.preinstalledVersions = { name: version }`（**新增字段**，不动 `preinstalled: string[]`）。
2. Rust 两处 JSON（桥 `/shell/state` `lib.rs:1946-1967`、IPC `get_shell_state` `:3439-3458`）**都**加 `preinstalled`（读 dsh.json，读不到给 `{}`）。
3. `shell-chrome.js` «关于»弹窗渲染列表。
**验收**：Node 契约断言（manager 写入字段名 + 两处 Rust 片段都含该字段）；负向对照：只改一处 → 红。
**回滚**：revert。

### S4 桥收口（阶段 0 + 1 + 3）

**危险集（唯一定义点，9 项）**：`/shell/quit`、`/restart`、`/restart-dsh`、`/update-dsh`、`/shell/disable-third-party-plugins`、`/shell/legacy-cleanup`、`/shell/cleanup-caches`、`/shell/dev-mode-toggle`、`/shell/gpu-accel-toggle`。
（`/shell/legacy-cleanup` 实测比 v1 描述安全：旧版 exe 在时会拒绝 `legacy-app-present` 且先备份；`/shell/cleanup-caches` 会停服务并删 `node_modules`（下次启动重装 ~590 包）→ 确认文案必须写明。）
**豁免**：`/window/*`、GET 只读、`/alive`、`/log`、`/notify`、`/pending-open`、`/devtools`（其门由 `dev-mode-toggle` 把关，而后者进危险集）。

**阶段 0（零行为变更的部分）**：
- `handle_bridge_conn` 加 **Host 校验**（必须 `127.0.0.1:<bridgePort>` 或 `localhost:<bridgePort>`）与 **Origin 白名单**（无 Origin（非浏览器，如测试脚本）放行；`tauri://localhost`/`http://tauri.localhost`/`http://127.0.0.1:*`/`http://localhost:*` 放行；其余 403）。
- `Access-Control-Allow-Headers` 加 `x-dsh-shell`；OPTIONS 分支改为**回显**允许的 Origin（不再无条件 `*`）。
- **阻断风险（A §6.3）**：`shell-chrome.js:135-138` 与通知插件 `client.js:53-55` 的 POST 必须同步带 `X-DSH-Shell: 1`，**两份插件副本都要改**（`plugins/...` + `src-tauri/resources/plugin/...`，由 `test-copy-consistency` 守）。否则浏览器预检会拦掉壳自己的所有非 GET 动作（症状：菜单点了没反应）。
- 验收：Rust 单测（纯函数 `bridge_request_decision(method, path, host, origin, headers) -> Allow | Reject(reason)`）+ 契约断言（两份 client.js 都含 `X-DSH-Shell`；`bridge()` 含该头）；**手动**：远程页点一次壳菜单动作，看 DevTools 预检 200 且 `access-control-allow-headers` 含 `x-dsh-shell`。

**阶段 1（对同源插件唯一有效）**：采用 2026-09-09 定稿设计——
- 危险端点**不再直接执行**：登记一次性槽位（`PENDING_CONFIRM`，一次一个 + 60s 过期）→ 打开**壳拥有的 confirm 窗口**（`src/confirm.html` + `WebviewWindowBuilder`，照 `open_settings_window` 模式；`capabilities/launcher.json` 的 windows 加 `"confirm"`）。
- 真正执行移到新 IPC **`resolve_pending_action(nonce)`**（confirm 窗调用；**非阻塞**，避免主线程死锁：24 条现有命令全是同步 fn，0 async）。
- **动作描述由 Rust 按 action id 生成**（不接受调用方文案）。
- 壳菜单 `ACTIONS` 里危险项标 `confirm: true`；**托盘菜单**作为免确认的壳内入口保留（用户真正的退出/重启通道）。页面发起的危险动作一律确认（`D4` 已定：页面主世界无法区分请求来自壳 chrome 还是插件）。
- 验收：Rust 单测（槽位：登记→结算→过期；重复登记被拒）+ 契约断言（9 个端点 match 臂内**不再直接调**执行函数、`ACTIONS` 危险项 `confirm:true`）；手动：页面控制台 `fetch(.../shell/quit)` → 弹 confirm 窗；托盘退出 → **不**弹。

**阶段 3**：ACAO 从 `*` 收窄为回显白名单 Origin（含 OPTIONS）。

**回滚**：阶段 0/3 单提交 revert；阶段 1 为新增文件 + 端点改造，revert 后回到当前行为。
**副作用**：页面发起的危险动作多一次点击（可接受，托盘/壳菜单不受影响）；confirm 窗被脚本刷时只弹一次（单飞）。

### S5 关窗首次确认

**改动**：抽纯函数 `close_decision(marker_exists) -> { show_confirm: bool }`（平台无关，CI 可跑单测）；Windows 分支：`CloseRequested` → `prevent_close()` → 异步任务弹 S4 的 confirm 窗（单飞）→ 确认则写标记（`<app_data>/background-close-confirmed`）+ `hide()`；取消则不动；标记写失败只记日志**仍然 hide**（与官方一致）。
**验收**：Rust 纯函数单测三分支；契约断言标记文件名；手动（Windows）：首次关窗弹窗、取消后窗口仍在、确认后隐藏、第二次直接隐藏；**关机路径需实测**（官方用 `query-session-end` 不等确认，我们无等价物 → 若确认窗拖住关机，加会话结束旁路）。
**回滚**：revert。

### S8 顶栏契约 caption 模式（flag 门控，默认关）

**改动（4 处，C 审计确认已是最小可行）**：
1. flag：`dsh.json` 新增 `webview.titlebarContract`（默认 false）；Rust 在注入前缀里带出（3 行）。
2. caption 模式：**不设** html paddingTop；设 `document.documentElement.dataset.windowsTitlebar=''` + `--dsh-windows-titlebar-height: 40px`（**40**，与客户端设计几何一致；改为常量便于调整）；设完后 `window.dispatchEvent(new Event('resize'))` 触发一次布局重算（缓解 A §9.5 的时序陷阱）。
3. 菜单按钮 `left: var(--dsh-windows-menu-start, 48px)`（**自带 48 回退**，因为 48 是消费者回退值）；bar host `pointer-events:none`（子元素 auto）+ 不画整条背景；新增显式 drag 区（菜单按钮右缘→窗口三键左缘，mousedown→桥 `/window/drag`）。
4. 保留 `--dsh-shell-menubar-h: 36px`（插件全屏页）与 800ms 全屏探测兜底。
**抽纯函数**：`computeCaptionPlan({caption}) -> { paddingTop?, cssVars, dataset, menuLeftVar }`（vm 内断言返回值，而不是源码字符串 contains）。
**验收**：契约测试断言返回值（caption 模式无 paddingTop、有属性与高度变量、menuLeft 用变量）；手动 runbook 6 项（侧栏开关可点/拖动正确/两态菜单起点 48 与 84/内容不双推/插件全屏让位/观感）。
**已知边界**：`on_page_load` 注入晚于客户端 render 的**竞态仍在**（resize nudge 只是缓解）；若实机发现列宽错位 → 走 fallback：主窗口改为 Rust 创建并挂 initialization script（记为后续卡，不在本轮）。
**回滚**：flag 置 false（无需发版）。

### S9 升级归因 + 一键回退

**改动**：
1. manager：`installDshUpdate` 成功后写 `<runtime>/upgrade.json`（**自己实现 tmp+rename 原子写**，5 行；manager 里 `renameSync` 目前只 import 未用）；仅在"确有旧版本"时写（冷安装/地板抬升不算升级）。
2. Rust：`/alive` 臂里删除该文件（启动成功即确认）；`handle_manager_exit` 组装 `manager-exit` 时读该文件，带 `upgrade: {from,to}`（`:2781-2792`）。
3. 启动页：失败态若带 `upgrade` → 显示「上次升级 vA → vB 后启动失败」+ 「回退到 vA」按钮（走 `/update-dsh` with version=vA；**回退也要过 S4 的确认窗**）+ 既有「停用第三方插件」；回退提示复用 S3 的 v4 口径。
4. **不自动回退**（与 D1 一致）。
**验收**：fake-dsh 场景（升级成功 → 启动失败 → 事件带 `upgrade` / 启动成功 → marker 被清）；负向对照：不写 marker → 事件无 `upgrade`。
**回滚**：revert。

### S11 V-1 实验（hoisted vs isolated）

**步骤**（只写 `/tmp`）：① 用壳的 manager 冷装 0.1.7-rc.2（floor 决定版本）；② 断言 URL + 首页 200 + 名册含通知插件；③ 改 `--node-linker=isolated` 重装同一 runtime（需绕过 manager 里硬编码的 hoisted 与 isolated 自动迁移 → 直接调 pnpm 或临时改脚本副本）；④ 重复断言；⑤ 结论回写方案 §5 与看板；⑥ **更新已有 Note** `.agents/notes/implemented/bug-fix/2026-08-20-pnpm-hoisted-layout-plugins.md`（不新建重复档案）。
**验收**：两布局都要真跑；任一失败即为有效发现。

---

## 4. 门禁

| 门禁 | 命令 | 备注 |
|---|---|---|
| Node | `npm test`（S0 后 11 套） | 含新增 `test-package-scripts`、`test-patch-targets` |
| 慢测试 | `npm run test:slow`（stall 190s + broken-install 32s） | 不进 PR 门禁 |
| 副本一致 | `node scripts/test-copy-consistency.mjs` | 改 manager/插件后必跑 `npm run sync:resources` |
| Rust 类型检查（**本机可行**） | `PATH=/tmp/dsh-plan-audit/stubbin:$HOME/.cargo/bin:$PATH cargo check --target x86_64-pc-windows-msvc --lib --tests` | 需要 llvm-rc 桩（仅 check 用，不进仓库）；覆盖 `#[cfg(windows)]` 与测试代码 |
| Rust lint | `cargo clippy --target x86_64-pc-windows-msvc --lib --tests -- -D warnings` | 已实测通过 |
| Rust 单测**执行** | CI ubuntu `check` job（PR 阶段跑） | 本机只能类型检查，不能运行 Windows 目标二进制 |
| CI | push 后 `check`/`test` job；windows job 仅 main/tag | 本机不能替代 |

**已验证的边界**：本机 `cargo check`（linux 目标）**不可用**（缺 dbus/webkit + 无 sudo）；因此新增 Rust 单测**必须是平台无关纯函数**，才能落到 PR 阶段会跑的 ubuntu `check` job。

---

## 5. 审计记录

### 5.1 三角度审计

| 角度 | 文件 | 主要发现 | 处理 |
|---|---|---|---|
| A 契约事实 | `a-contracts.md`（494 行） | 16 条"无依据断言"、3 条阻断（S4 同源误判/同步死锁、S8 时序）、S1 最佳验收是 `--dump-config` | 全部并入 v2（§1.2） |
| C 可验证性 | `c-verifiability.md`（565 行） | S1/S2/S7 验收恒真或前提错、S8 断言写法、S9 落点、S10 更省方案、漏项 20 条、门禁与环境事实 | 全部并入 v2；S2/S7 移出实施 |
| B 副作用 | `b-side-effects.md` | 见 §5.3（完成后补） | 待完成 |

### 5.2 本轮新增的代码级取证（我自己跑的，全部可复现）

| 编号 | 结论 | 影响 |
|---|---|---|
| E1 | overlay `- id: ui-sidebar-browser` + `disabled: false` **能覆盖**上游 `!!js`；名册计数 1（有）/0（无） | S1 可行 |
| E2 | 顶栏几何实测（真 Chromium 1280×820）：只设属性→`frame padding 0`（无回退）；属性+36px→`padding 36`、toggle(12,4)、sidebarTop 36；再加 html padding 36→`frameTop 36`、`sidebarTop 72`（**双重让位**）；收起态 `--dsh-windows-menu-start: 84px` | S8 设计依据；`36 vs 40` 决策 |
| E3 | `cargo check/clippy --target x86_64-pc-windows-msvc --lib --tests` 本机**可跑**（llvm-rc 桩） | 推翻"Rust 不可验证" |
| E4 | 打空 patch（不存在的 id）**无任何日志**；`--dump-config` 可离线断言 `disabled: false` vs `!!js` | S1 验收改为三重 |
| E5 | 孤儿测试：`TEST_NODE=<bundled node>` 下 broken-install **PASS(32s)**、install-stall **PASS(190.6s)**；系统 node 下 broken-install FAIL；失败时**泄漏子进程** | S0 设计 |

### 5.3 B 角度（副作用）

（待 B 完成后填入；若 B 未在实施 S4/S8 前返回，则先做 S0/S1/S3/S6/S10/S11，S4/S8/S5/S9 等 B 的结论。）

---

## 6. 顺序与提交切分

```
P0-A（可独立、无损）: S0 → S1 → S11（同一次真机跑）→ S3 → S6 → S10
P0-B（桥与窗，需 B 结论）: S4-阶段0 → S4-阶段1 → S5
P1: S8（flag 门控，风险自限）→ S9
收尾: S12 文档同步 + 看板映射 + Note
```
- 每项一个提交（Conventional Commits，中文描述）。
- 必须串行：S1 → S11（同一次跑）；S4-0 → S4-1 → S5；S3 → S9（口径一致）。
- 可并行：S0/S3/S6/S10 之间；S8 与 S4 互不依赖。

## 7. 待用户动作（一次批齐）

1. 装含本轮改动的构建（或 v0.11.0 + 本轮 dev 构建）。
2. **S8 runbook**：开「顶栏契约」→ 刷新 → 6 项对照（含首帧 `hasAttribute` 自查）。
3. 实机确认 4 项：关窗首次确认、桥危险动作确认窗（页面发起 vs 托盘不弹）、升级归因回退按钮、失败态证据目录按钮。
4. 关机路径实测（S5）；若被确认窗拖住 → 我加会话结束旁路。
5. （后续卡）代码签名证书 + CI secret。

## 8. 实施记录

（实施时逐项填入：提交/改动文件/门禁结果/遗留）

---

## 9. v3 修订（B 角度副作用审计并入）

来源：`.tmp-investigate/plan-audit/b-side-effects.md`（279 行，73 条结论）。B 独立复现了 S0 的 npmViaCli 根因（与我的实测一致），并给出下列**必须遵守**的修正：

### 9.1 阻断级（实现时必须照做）

| # | 修正 | 影响项 |
|---|---|---|
| B1 | `pointer-events:none` **只能加在 `.bar`**，不能加在 `:host`：下拉/壳内模态/故障条幅/mini-toast 都是 shadow root 的直接子节点，`:host` 上置 none 会让它们全部点不动（B 用真实 Chromium 实测：`.dd` 计算值 none、`elementFromPoint` 命中页面元素）→ 各浮层各自 `auto` | S8 |
| B2 | 加 `X-DSH-Shell` 必须同批改 `Access-Control-Allow-Headers`（`lib.rs:1984`）与 OPTIONS 分支（`:1694`）回显 Origin；否则远程页整条壳菜单**静默失效**（＝2026-09-01 事故形态） | S4-0 |
| B3 | 被闸门的 IPC 命令必须改 `#[tauri::command(async)]`：Tauri 的同步命令在**投递线程（主线程）**执行，内联等待会让确认窗自己也无法响应 | S4-1 |
| B4 | 确认文案由 **Rust 按 action id 生成**（与 D4 一致），不接受调用方 detail | S4-1 |
| B5 | S7 放弃（形状错误会让 locale 插件挂载失败；且会改"从未选过语言"用户的默认语言）——**v2 已移出，B 复核一致** | S7 |
| B6 | S11 的 isolated 实验必须**绕过 manager**（manager 里有 isolated→hoisted 自动迁移，会掩盖结论） | S11 |

### 9.2 需改（逐项决议）

| 项 | 决议 |
|---|---|
| S0 时长 | `test:slow` 单独脚本；实测 stall 180–260s、broken-install 32–35s，合计 +3.6min，**不进 PR 门禁**；接线位置：`linux` job（有 fetch-node） |
| S1 文案 | README 补一句：该页由壳显式覆盖为启用，**用户无法再从界面自行禁用它**（服务端门控） |
| S3 断言 | 升级文案不在 `SHELL_MENUS`（在 `openCheckUpdateDialog`）；断言要取源码片段；**托盘 `update-dsh` 路径也要弹同一确认**（否则文档口径与行为不一致）；`/update-dsh`、`disable-plugins`、`cleanup-caches`、`legacy-cleanup` 已有页内确认 → **统一由壳确认窗接管，页内确认对这几项关闭**，避免双重确认 |
| S4 危险集 | 采 D4 原清单 **9 项**（含 `/shell/dev-mode-toggle`、`/shell/gpu-accel-toggle`、`/shell/open-data-dir`）；槽位**一次一个** + 同动作去重（照官方 `background-notice.ts:22-40`、`quit-confirmation.ts:44-56`） |
| S4 契约测试 | 三方断言只对**在 ACTIONS 里有映射**的端点做（`/restart-dsh` 无调用点 → 不做存在性断言） |
| S5 | `with_denylist` 加 `confirm` 窗口，并同批改 `test-shell-chrome.mjs:150` 的断言；答复后**先关确认窗再 hide**；退出路径清 pending；我们自己的 ☓/Alt+F4 也走首次确认（明确写进 README） |
| S6 | **不加第 4 个按钮**：`.shell` 是 `height:100%` + `justify-content:center` 且无滚动，加项 + 长路径会不可达；改为把现有「打开数据目录」在失败态下指向**证据目录**，并用 IPC 名 `open_evidence_dir`（不是桥路径） |
| S8 | 拖动保持现有 mousedown 路径（宿主机日志实证 `/window/drag` 命中 5/6 次 = 活的）；新 drag 区**必须同时绑 dblclick**（最大化）；36 与 40 常量统一（采用 40，客户端几何按 40 设计）；菜单项需 checkbox 状态镜像；验收用源码片段 + 纯函数返回值断言（**不做逐字节快照**）；captions 下客户端默认**展开**侧栏（`AppFrame.tsx:168-172`）需写进 runbook |
| S9 | marker 清除放 **Rust `/alive`**；回退**不再写同种 marker**，marker 带 `kind`/`attempts`，`attempts>=2` 只给取证不再给版本切换（避免 ping-pong）；失败判定沿用现有 60s（`LAUNCH_STALL_MS`），不用 90s |
| S10 | 两处 JSON 同步（`:1946` / `:3439`）；断言只覆盖静态 label（`brand` 是动态 `PRODUCT_NAME`、`check-update` 会被改写 → 不纳入断言） |
| S12 | 必须同批改 `.dsh/skills/dsh-desktop-shell-dev/SKILL.md`（它现在写着"不要叠加 app-region"，与新代码/文档矛盾） |

### 9.3 B 的未核验项（需真机/实测，登记为覆盖缺口）

WebView2 下 `pointer-events` 与 `app-region` 的相互作用；最大化态拖动/Aero snap；36 vs 40 的视觉；"桥线程建窗 + 阻塞等结果"的组合；Host 校验对 DNS rebinding 的实际效果；S5 确认窗的键盘/退出清理；`applyEntryPatches` 是否保留被覆盖行的 `config`（→ 用 `--dump-config` 验，S1 验收第 1 条已覆盖）；手写 satisfies 与上游 semver 的 fixtures 对跑（S2 已移出）；900×600 启动页真实溢出；`/alive`→清 marker 的时序。

---

## 10. 实施记录（v3 定稿后开始）

### S0 仓库卫生 —— 已完成（本地门禁全绿）

| 改动 | 文件 | 验证 |
|---|---|---|
| npm CLI 定位回退：`<nodeDir>/node_modules/npm/...` + `<nodeDir>/../lib/node_modules/npm/...`；再退化到 PATH 上的 npm（绝对路径解析）；`runChild` 增 `exe` 参数 | `scripts/server-manager.mjs` | 修复前 `node scripts/test-broken-install.mjs` EXIT=1；修复后 **EXIT=0 / 23s**（系统 node） |
| 两个孤儿测试的进程树回收（`detached` + `killTree`：POSIX 进程组 / Windows `taskkill /T`；`process.on('exit')` 兜底） | `scripts/test-broken-install.mjs`、`test-install-stall.mjs` | 之前实测泄漏 2 个常驻 node；修复后 `ps` 无残留 |
| 新增清单门禁：script 目标存在 + 四处版本一致（含 Cargo.lock） | `scripts/test-manifest-consistency.mjs`（新） | 正例绿；**负向对照**：改坏 script 路径 → 红；Cargo.lock 版本回退 → 红 |
| 接线：`test:manifest` / `test:patch-targets` 进 `npm test`；broken-install 进 `npm test`；stall 进 `test:slow`（CI 加进 linux job） | `package.json`、`.github/workflows/build.yml` | `npm test` **11 套全绿 / 65s** |
| 删除断链 script `test:console-window` | `package.json` | 清单门禁覆盖该类 |
| `Cargo.lock` 的 `dsh-desktop` 版本 0.6.3 → 0.11.0 | `src-tauri/Cargo.lock` | 四处版本门禁守住 |
| 文档：fmt 门禁现状（CI 不跑、格式靠自律）、测试套数 9→11、`test:slow` 说明 | `README.md`、`CONTRIBUTING.md` | — |

### S1 侧栏浏览器页恢复 —— 已完成（代码 + 门禁；真机断言已双向取证）

- overlay 追加 `- id: ui-sidebar-browser` + `disabled: false`（含注释说明"恢复的是 iframe 版"）。
- 新增契约门禁 `scripts/test-patch-targets.mjs`：① overlay 的 id ⊆ 上游扁平化 id 集合（fixture 由 `--dump-config` 生成，采集自 dsh 0.1.7-rc.2 / 182 个 id）；② 关键覆盖必须 `disabled: false`；③ 结构完整（结尾换行、无粘连行）。
- **负向对照**：独立 bogus id → 红；`disabled: true` → 红；粘连行 → 红（该断言正是因第一次负向对照"没变红"才补的）。
- **真机验收（Linux，真实 dsh 0.1.7-rc.2）**：`--dump-config` 显示 `disabled: false`（无 overlay 时为 `!!js …`）；首页名册 `dsh-client-ui-sidebar-browser/client.js` 计数 **1（有覆盖）/ 0（无覆盖）**。`/plugins/<id>/client.js` 两种情况都 200 → 已确认**不可**作为验收。

### S11 V-1 实验 —— 已完成，结论"保持现状 + 登记跟进"

- 方法：绕过 manager（避免 isolated→hoisted 自动迁移），`--node-linker=isolated` 全新安装 dsh 0.1.7-rc.2（9.3s，复用 store）。
- 结果：dsh 正常启动出 URL、stderr 无 `ERR_MODULE_NOT_FOUND`、名册含通知插件与 sidebar-browser（各 1）。
- 处置：**不移除 hoisted 强制**；更新既有 Note（`bug-fix/2026-08-20-pnpm-hoisted-layout-plugins.md`）记录 0.1.7 的机制变更与本次实测，并留 Windows 实机验证为跟进项。

### S6 失败态指向证据目录 —— 已完成

- 改动：`src/app.js` 失败态复用「打开数据目录」按钮：有 `exit.evidenceDir` 时改调 `open_evidence_dir`（IPC）并把按钮文案/标题切成证据目录；**不新增第四个按钮**（启动页 `.shell` 是 height:100% + 居中且无滚动，多一项 + 长路径会不可达 —— B 审计指出）。
- 验证：`test-shell-chrome.mjs` 新增 3 条断言（app.js 引用两个命令 + 跟踪 evidenceDir）；**负向对照**：把 `open_evidence_dir` 改名 → 红。

### S10 关于弹窗显示预装插件版本 —— 已完成

- 改动：① `server-manager.mjs` 的 `ensurePreinstalled()` 顺手记 `versions[pkgName]` 并写入 `dsh.json` 的 `preinstalledVersions`（新增字段，不动 `preinstalled: string[]`，保留其它壳字段）；② Rust 新增 `preinstalled_versions()`，在**两处** JSON（桥 `/shell/state`、IPC `get_shell_state`）都带 `preinstalled`；③ 关于弹窗渲染「预装插件（随壳发布，界面不提供升级）」逐包版本，首次打开异步补拉一次（失败静默）。
- 验证：契约断言——manager 写字段、Rust 两处调用点**计数必须为 2**、chrome 读 `r.preinstalled`；**负向对照**：删掉 IPC 那一处 → 红。Rust 侧 `cargo check/clippy --target x86_64-pc-windows-msvc --lib --tests` 通过。

### 本轮门禁汇总（截至 S0/S1/S6/S10/S11）

| 门禁 | 结果 |
|---|---|
| `npm test`（12 套） | **exit 0 / 57s** |
| `cargo check --target x86_64-pc-windows-msvc --lib --tests` | Finished（含新增 Rust 代码与测试代码） |
| `cargo clippy --target x86_64-pc-windows-msvc --lib --tests -- -D warnings` | Finished（无告警） |
| 新增门禁的负向对照 | 清单门禁 2/2 变红；patch 目标门禁 3/3 变红；S6 断言 1/1 变红；S10 断言 1/1 变红 |
| 真机取证（Linux + 真实 dsh 0.1.7-rc.2） | S1 三重验收双向；S11 isolated 实验 |

### 尚未实施（按 v3 顺序）

S3（回滚纪律）→ S4-0（桥 Host/Origin + 头）→ S4-1（槽位 + 确认窗 + IPC）→ S5（关窗首次确认）→ S8（caption 模式，flag 门控）→ S9（升级归因）→ S12（文档总同步 + 技能文件修正 + 看板映射）。

### S3 回滚纪律 —— 已完成

- README 新增「dsh 升级是单向的（0.1.7 起，重要）」：v4 自 **0.1.7-alpha.1** 起生效；回退旧版只会看到升级前快照；**回滚 = 还原升级前的数据目录备份**，「还能打开」不是回滚成功的判据；并写明升级入口的提示位置。
- 检查更新弹窗：新增 `UPGRADE_ROLLBACK_WARNING` 常量，在**两个**可更新分支（稳定版 / 预发布）各渲染一次；actions 行新增「打开数据目录」按钮（`call('open-data')`）——把"先备份"做成动作而不是说明文字。
- 托盘通道：标签改为「有更新 vX（当前 vY）→ 点击更新（建议先备份数据目录）」，更新通知文案同步加「升级后无法回退读取新数据，建议先备份数据目录」。
- 验证：契约断言 4 条（常量存在、渲染 ≥2 处、备份按钮、README 三关键词、托盘文案）；**负向对照 3/3 变红**（删常量 / 只留一处渲染 / README 去 v4 措辞）。

### S4 阶段 0（桥请求面收窄）—— 已完成（源码级 + 纯函数单测真实执行）

- `lib.rs` 新增三个**平台无关纯函数**：`bridge_request_decision`（Host 必须等于 `127.0.0.1:<bridgePort>`/`localhost:<bridgePort>`；Origin 缺省放行、出现须命中白名单；非 GET/HEAD/OPTIONS 必须带 `X-DSH-Shell: 1`）、`bridge_origin_allowed`、`bridge_cors_headers`（不再通配 `*`，只回显白名单 Origin，`Allow-Headers` 含 `content-type, x-dsh-shell`）。
- `handle_bridge_conn`：解析 Host / Origin / `X-DSH-Shell`；准入失败 → 403 + 不回 CORS 头 + 记 `bridge reject: <reason>` 日志；响应头改由 `bridge_cors_headers(origin)` 生成。
- 调用方：`shell-chrome.js` 的 `bridge()` 与通知插件 `post()` 的非 GET 请求都加 `X-DSH-Shell: 1`（真源 + resources 副本同步）；GET `/pending-open` 不变。
- **执行证据**：4 个新 Rust 单测（Host 矩阵 / Origin 白名单与伪装 / 可变方法缺头 / CORS 头语义）——本机把三个纯函数与测试模块**机械抽取**后用 `rustc --test` 真实执行：**4 passed / 0 failed**；同时 `cargo check/clippy --target x86_64-pc-windows-msvc --lib --tests` 通过（CI 的 ubuntu `check` job 会执行 in-crate 版本）。
- 契约断言 6 条（两个调用方带头、Allow-Headers、响应走 `bridge_cors_headers`、纯函数与测试模块存在）；**负向对照 3/3 变红**。
- **未覆盖（缺口）**：浏览器预检的真实行为（需 Windows 实机：远程页点一次壳菜单动作，看 DevTools 里预检 200 且 `access-control-allow-headers` 含 `x-dsh-shell`）已列入 §7 实机清单。

### 本轮门禁汇总（S0/S1/S3/S4-0/S6/S10/S11）

| 门禁 | 结果 |
|---|---|
| `npm test`（12 套） | **exit 0 / 67s** |
| `cargo clippy --target x86_64-pc-windows-msvc --lib --tests -- -D warnings` | Finished（无告警） |
| 桥纯函数单测（rustc 抽取执行） | **4 passed / 0 failed** |
| 负向对照总数 | 14 个 mutation，全部按预期变红 |

### 经验（写下来避免重犯）

1. **门禁先证明会变红，再信任它**：本轮 3 次出现"负向对照没变红"——① overlay 缺末尾换行导致粘连行被静默少解析（补了结构断言）；② `UPGRADE_ROLLBACK_WARNING\)` 正则漏了紧跟的逗号（正例就红，立刻发现）；③ `X-DSH-Shell` / `x-dsh-shell` 的子串断言让"改名式变异"仍为真（改为精确到整条 header 字面量）。
2. **正例先绿再看负例**：否则会把"因为别的原因红"当成门禁有效。

### 仍待实施

S4-1（槽位 + 壳确认窗 + `resolve_pending_action` IPC，含 `#[tauri::command(async)]` 与「动作描述由 Rust 生成」）→ S5（关窗首次确认，复用确认窗；`with_denylist` 加 `confirm` 并同批改 `test-shell-chrome.mjs:150`）→ S8（caption 模式，flag 门控默认关 + resize nudge + runbook）→ S9（升级归因：manager 原子写 `upgrade.json`、Rust `/alive` 清除、启动页归因与一键回退）→ S12（文档总同步，含 `.dsh/skills/dsh-desktop-shell-dev/SKILL.md` 与看板映射）。

### S4 阶段 1（危险动作 → 槽位 + 壳确认窗 + 异步 IPC）—— 已完成（源码级 + 单测真实执行）

- **Rust（`lib.rs`）**：
  - `DangerAction` + `dangerous_bridge_action(method, path)`（纯函数，**10 项**：quit / restart / restart-dsh / update-dsh / disable-plugins / cache-cleanup / legacy-cleanup / dev-mode / gpu-accel / open-data；`GET` 与只读端点一律不拦），文案**全部由 Rust 生成**（调用方只能给 action id）。
  - 一次性槽位 `PENDING_CONFIRM`（一次一个 + `CONFIRM_TTL_SECS = 60` 过期 + 同动作去重：重复请求聚焦已有窗口而不是叠窗；不同动作占位时回 `busy`）。
  - 桥在准入检查之后拦危险路径：读出 body 存进槽位 → 打开/聚焦确认窗 → **202 + `{ok:false,pending:true,nonce}` 立即返回**（非阻塞，天然规避"同步 IPC + 主线程互等"）。
  - 确认窗 IPC：`get_pending_action`（返回 Rust 生成的 title/detail/nonce；过期返回 null）与 `resolve_pending_action(nonce, approved)`（**`#[tauri::command(async)]`** 两个都是；校验 nonce + 过期 → 先关确认窗 → 批准才执行）。
  - 唯一执行点 `execute_danger_action(app, id, body)`：`update-dsh` 回放 body 里的 version；`quit`/`restart` 复用既有实现；其余调既有 `*_impl`。
  - 单测 `danger_action_tests`：10 项全覆盖 + 文案非空 + 9 个非危险端点/GET 不误拦。
- **前端**：新增壳拥有的确认窗 `src/confirm.html` + `src/confirm.js`（文案来自 IPC、Esc = 取消并默认聚焦「取消」、过期/已结算显示"操作已失效"、批准失败如实显示错误）；`capabilities/launcher.json` 的 windows 加 `confirm`；`window-state` denylist 改 `["settings", "confirm"]`；`SHELL_MENUS` 的 8 个危险 ACTIONS 标 `confirm: true`；`call()` 对 `{pending:true}` 弹 mini toast（否则用户以为"点了没反应"）。
- **验证**：契约断言 12 条（ACTIONS 标 confirm 的桥路径必须都在 Rust 危险表里、危险表关键路径存在、两个 IPC 必须是 async 且注册、唯一执行点存在、桥确实走 `dangerous_bridge_action`、capabilities/denylist/confirm.html/confirm.js/pending 反馈）；**负向对照 4/4 变红**（去掉 confirm 标记 / 危险表改名 / 去掉 async / capabilities 去掉 confirm）；抽取的 5 个纯函数单测（危险表 + 桥准入）**rustc 真实执行 5 passed**；`npm test` exit 0/58s；clippy 无告警。
- **连带修正**：既有断言 `with_denylist(&["settings"])` 随 denylist 变更同批改为 `["settings", "confirm"]`（B 审计已预警，实际确实变红）。
- **未覆盖（缺口）**：确认窗的真实观感/键盘行为、`always_on_top` 在 Windows 的置顶效果、桥 202 在远程页的真实表现（DevTools 里看到 `{pending:true}` + 确认窗弹出）——均列入 §7 实机清单。

### S5 前置说明（下一步）

确认窗与 `with_denylist` 已就位；S5 只需：抽 `close_decision(marker_exists)` 纯函数 + `CloseRequested` 异步分支（首次弹确认窗 → 确认写标记并 `hide()` / 取消不动；写标记失败只记日志**仍然 hide**）+ 单测三分支 + 实机验收（含关机路径）。

### S5 关窗首次确认 —— 已完成

- 纯函数 `close_needs_confirmation(marker_exists, linux)`；标记 `<app_data>/background-close-confirmed`（读不到就多问一次；写失败只记日志**仍然隐藏**，与官方一致）。
- `CloseRequested`：`prevent_close()` 后，Windows 首次 → 复用 S4 的确认窗（合成动作 `close-hide`，文案 Rust 生成）；已确认 → 直接隐藏；Linux → 最小化（不确认）。我们自己的菜单 ☓ / Alt+F4 / 任务栏关闭走同一事件，行为一致。
- `execute_danger_action("close-hide")`：写标记 + 隐藏主窗口（隐藏失败如实返回错误）。
- 验证：契约断言 5 条 + README 同步（"首次隐藏前会弹一次确认"）；**负向对照 3/3 变红**；抽取单测 `close_confirm_tests`（4 组输入矩阵）**rustc 真实执行通过**。

### S9 升级归因与一键回退 —— 已完成

- 新增纯逻辑模块 `scripts/upgrade-marker.mjs`：`nextUpgradeMarker`（**冷安装/同版本不写标记**；同一 `(from,to)` 重复失败累加 `attempts`；换目标重置并记 `kind`）、`allowsVersionSwitch`（`attempts >= 2` 停用版本切换，防两版本 ping-pong）、`upgradeMarkerPath`。
- manager：安装成功后**原子写**（tmp + rename）`<runtime>/upgrade.json`；回退（target < current）也写标记并记 `kind='rollback'`。
- Rust：`upgrade_marker_json()` 随 `manager-exit` 上报；`/alive`（启动成功）删除标记；`update_now` 增加可选 `version`（回退入口）。
- 启动页：失败态若带标记 → 标题改成「上次升级 vA → vB 后启动失败」；`attempts < 2` 时显示「回退到 vA」（`invoke('update_now', {version})`，title 明说**不还原数据**）；按钮行加 `flex-wrap` + `overflow-y`（防第四次按钮溢出不可达 —— B 审计的关切）。
- 验证：`scripts/test-upgrade-marker.mjs`（4 组断言）+ **负向对照 3/3 变红**（冷安装也写标记 / 不累加 attempts / attempts≥2 仍可切换）；契约断言 9 条 + **负向对照 5/5 变红**（非原子写 / 少 upgrade 字段 / 不清标记 / 不限制 attempts / 去掉按钮）。
- **过程中被门禁抓到的真问题**：① clippy `needless_borrow`（`upgrade_marker_json(&app)` → `app`）——lint 门禁是活的；② 我的断言 `attempts < 2` 被**注释文本**误匹配 → 收紧到代码行（第 2 次同类教训，已记入 §10 经验）。

### 本轮门禁汇总（S0/S1/S3/S4-0/S4-1/S5/S6/S9/S10/S11）

| 门禁 | 结果 |
|---|---|
| `npm test`（13 套） | **exit 0 / 65s**（21 条 PASS/ok） |
| `cargo clippy --target x86_64-pc-windows-msvc --lib --tests -- -D warnings` | **0 error**（并抓到一处真实 lint） |
| `cargo check`（同目标） | Finished |
| 抽取纯函数单测（rustc 真实执行） | **6 passed / 0 failed**（桥准入 4 + 危险表 1 + 关窗 1） |
| 负向对照 | 本轮累计 **31 个 mutation**，最终全部按预期变红（其中 4 次因"谓词太松/变异不匹配/注释误匹配"被自我纠正后才变红） |

### 仍待实施

S8（caption 模式：flag 门控默认关 + `pointer-events` 只加 `.bar` + 显式 drag 区含 dblclick + resize nudge + runbook）→ S12（文档总同步：`.dsh/skills/dsh-desktop-shell-dev/SKILL.md` 修正、README/CONTRIBUTING 复查、看板映射、Agent Note 收口）。

### S8 顶栏契约（caption 模式，flag 门控默认关）—— 已完成

- **决策点纯函数** `computeCaptionPlan(captioned)`（并**导出到测试钩子**，契约测试断言**返回值**而不是源码字符串）：
  - 关（默认）：`paddingTop = 36`（壳照旧推挤）+ `--dsh-shell-menubar-h`；
  - 开：`paddingTop = null`（**绝不推挤** —— 客户端 `.frame{padding-top:var(--dsh-windows-titlebar-height)}` 会自己预留，两边都留就是 72px 双重让位，真 Chromium 实测）+ `html[data-windows-titlebar]` + `--dsh-windows-titlebar-height: 40px`（与官方 Electron 壳同值）+ `:host(.caption)`。
- CSS：`:host(.caption) .bar { background: transparent; pointer-events: none }` —— `pointer-events:none` **只加在 `.bar`**（加在 `:host` 上会让 shadow root 的子节点下拉/模态/条幅全部点不动，B 用真 Chromium 实测）；`.bar > *` 恢复 `auto`；菜单起点 `var(--dsh-windows-menu-start, 48px)`（客户端只在折叠态设 84px，未设时回退 48px 是 A 的发现）；`:host(.caption) .dragger`/`.spacer` 显式拖动区 + 双击最大化（`.bar` 已不接收事件）；注入晚于首帧 → 补发一次 `resize` 让客户端重算列宽。
- 开关：`dsh.json` 的 `webview.titlebarContract`（Rust `titlebar_contract`/`set_titlebar_contract` 保留其它字段；两处 shell-state JSON 都带 `titlebarContract`；注入前缀带 `__DSH_TITLEBAR_CONTRACT__`）；壳菜单新增「顶栏契约（实验）」checkbox（ACTIONS 标 `confirm: true` → 走 S4-1 确认窗）；桥端点 `/shell/titlebar-toggle` 纳入危险表（危险表单测同步为 11 项）；切换后 toast 提示「刷新页面生效」。
- 验证：**6 个变异全部按预期变红**（caption 也推挤 / `pointer-events` 挪到 `:host` / 不给 `--dsh-windows-titlebar-height` / 菜单起点写死 48px / 拖动仍挂 `bar` / IPC 那处 JSON 少字段）；vm 里真实执行 `computeCaptionPlan` 的 10 条断言；`npm test` exit 0；clippy 0 error；危险表单测抽取执行 6/6 通过。
- **默认关**：关着时行为与今天完全一致（零回归风险），Windows 实机 6 项对照（侧栏开关可点 / 内容不被压 / 菜单起点 / 拖动与双击最大化 / 全屏下隐藏 / 窗口三键 hover）列入 §7。

### S12 文档/技能/Note 总同步 —— 已完成

- `.dsh/skills/dsh-desktop-shell-dev/SKILL.md`：新增 §5.5「桥的准入与危险动作确认」与 §5.6「升级归因与顶栏契约」，写清"加桥端点/加危险端点各要改哪几处"与两个 flag 的边界；测试套数同步。
- README：新增「顶栏契约（实验项，默认关）」runbook（含开启后必须刷新、出现何种异常应关掉并回报）与「升级后启动失败会自动归因」说明；升级单向性一节已在 S3 落地。
- CONTRIBUTING/README 的套数统一为 **13 套**，并**新增门禁**：`test-manifest-consistency.mjs` 断言"README/CONTRIBUTING 里的 全量 N 套 == npm test 链长"（本次实施中出现过 9/11/12/13 四个数字并存，靠人眼同步不可靠）；**2 个变异变红**。
- Agent Note：`.agents/notes/implemented/architecture/2026-09-25-shell-hardening-bridge-confirm-caption.md`（承载桥准入契约、危险确认槽位/唯一执行点、关窗语义、升级标记语义、caption 决策点与默认关的负向保证；与定位 Note `2026-09-24-official-desktop-0-1-7-positioning-and-adoptions.md` 互补）。

### §7 实机验收清单（Windows，本机不可验证 → 覆盖缺口，交付前必须逐条走）

| # | 项 | 判据 |
|---|---|---|
| 1 | 桥准入预检真实行为 | 远程页点一次壳菜单动作，DevTools 看到预检 200 且 `access-control-allow-headers` 含 `x-dsh-shell`；本地页 IPC 动作不受影响 |
| 2 | 危险动作确认窗 | 远程页点「退出/重启/更新」→ 弹出确认窗、文案由 Rust 生成；取消 = 什么都不发生；确认 = 动作执行；重复点 = 只聚焦不叠窗 |
| 3 | 确认窗观感 | `always_on_top` 在主窗口全屏时仍可见；Esc = 取消；默认焦点在「取消」 |
| 4 | 关窗首次确认（含**关机路径**） | 首次点 ☓/Alt+F4/任务栏关闭 → 确认窗；确认后隐藏且**不再问**；系统关机时不应被确认窗拖住（若被拖住 = 缺陷，需改为关机时直接隐藏） |
| 5 | 顶栏契约 6 项对照 | 开启后：侧栏开关可点、内容不被压、菜单起点正确、拖动/双击最大化可用、全屏下顶栏隐藏、窗口三键 hover 正常 |
| 6 | 升级归因与回退 | 升级到新版本后启动失败 → 启动页显示「上次升级 vA → vB」+「回退到 vA」；`attempts ≥ 2` 时按钮消失；`/alive` 之后 `upgrade.json` 被删除 |
| 7 | 关于弹窗预装版本 | 关于弹窗显示各预装包版本，与 `runtime/node_modules/<pkg>/package.json` 一致 |
| 8 | 失败态证据目录按钮 | 崩溃后按钮文案变「打开证据目录」并打开正确的目录 |
| 9 | isolated 布局 | 去掉 `--node-linker=hoisted` 后冷安装 + 插件可解析（S11 只在 Linux 验证过） |

## §11 Windows 实机验证（2026-09-25，dev 版 0.11.0 真机跑通）

**方法**：WSL interop + 仓库自带 `scripts/verify-dev-ui.ps1`（UIA：dump/windows/text/invoke/click/shot，PrintWindow 截图不抢焦点）；新增 `scripts/verify-bridge-guards.ps1`（在 Windows 回环内用 curl.exe 打桥，8 项断言 + 审计留痕）。dev 检出 `D:\Dev\dsh-desktop-dev` 同步后 `npm run bundle:dev` → 静默安装 → 启动。

**已验证（真机，非源码推断）**：桥准入 10/10（伪 Host 403 / 非白名单 Origin 403 / 缺 `X-DSH-Shell` 403 / 合法请求 202 pending 且**未执行** / **预检 204 且 allow-headers 含 x-dsh-shell** / 只读 GET 正常）+ `bridge reject` 审计留痕；危险确认窗（文案由 Rust 生成、取消/确认执行、Esc 提示）；确认 → `dsh.json` 写入 `webdriver.titlebarContract`（见下缺陷 2）；关窗首次确认（标记未写、点确认后才写 `background-close-confirmed` 并隐藏）+ 第二次关窗**静默隐藏不再询问**；caption 模式几何（菜单按钮 x 5→77、三键高度 54→60、内容上移 27px 不再双重让位）+ 视觉对照（透明栏、客户端正常渲染、无遮挡）；S9 归因（标记 → 升级 → 启动成功被 `/alive` 清除；注入启动失败后启动页显示「上次升级 v0.1.6-alpha.2 → v0.1.7-rc.2 后启动失败」+「回退到 v0.1.6-alpha.2」）；S10 数据面（`dsh.json` `preinstalledVersions` 四包版本 + `/shell/state` 字段）；S6 失败态按钮变「打开证据目录」。

**真机抓出 4 个本地门禁全绿却真实存在的缺陷（全部已修 + 已补门禁 + 负向对照）**：
1. **打包漏模块** —— `sync-resources.mjs` 只硬编码拷 `server-manager.mjs`/`proxy.mjs`，新增的 `upgrade-marker.mjs` 没进 resources → 装机后 manager 启动 1 秒内 `ERR_MODULE_NOT_FOUND` 退出（启动页直接显示该堆栈）。修：改为**按相对导入闭包递归拷贝**；门禁：copy-consistency 改查模块图（缺文件即红）。
2. **危险表没有执行分支** —— 表里新增 `titlebar-contract` 但 `execute_danger_action` 无对应分支 → 用户在确认窗点「确认执行」后静默失败（`dsh.json` 无变化）。修：补分支；门禁：危险表 id ↔ 执行分支 id **双向**一致。
3. **关于弹窗读错端点** —— 弹窗用 `call('shell-status')`（`/shell/status` 的 JSON 不含 `preinstalled`）→ 真机上「预装插件」几行完全不渲染。修：改用 `shell-state`；门禁：断言弹窗必须走 `shell-state`。
4. **归因字段进了没人读的结构** —— `upgrade` 只加到 `manager-exit` 事件负载，而启动页读 `get_shell_status`/`/shell/status`（`shell_status_json`）→ 归因是死代码。修：`shell_status_json` 带上该字段（函数加 `AppHandle` 参数）；门禁：断言该函数体内含该字段（去掉即红）。

**真机发现的升级阻断项（与本仓代码无关，但影响升级决策）**：dsh **0.1.7 客户端把服务 `settingsScope` 换成了 `settingsSchema` + `configForms`**（0.1.6 的 `@deepseek-ai/*` 有 18 个文件提供/使用它，0.1.7 全树 0 命中；官方 0.1.7 源码 `src/` 也 0 命中）。预装插件 `dsh-model-reasoning` 0.2.4 仍等 `settingsScope` → 在 0.1.7 下**永不激活**，且 dsh 会停在「Failed to load plugins」页 → **整个 Web UI 不可用**（受控实验：从 `profiles/web/package.json` 摘掉该插件后 UI 立即正常）。其余三个预装插件不依赖该服务。**结论**：`MIN_DSH_VERSION='0.1.7-rc.2'` 与该插件当前版本冲突 → 发版前必须二选一（修插件改用新服务 / 暂缓抬高地板 / 该插件先不进预装）。

## §12 用户决定"先不做"的三项（登记，含精确步骤）

2026-09-25 用户明确：这三项先不做，只登记。**不是缺陷、不是阻断项**，是"实机未复核"的待办。

### 12.1 关机/注销路径确认（机制已核实 → 降级为假设复核）

**要回答的问题**：S5 的「首次关窗 → 确认窗（`prevent_close` + `always_on_top`）」会不会在系统关机/注销时把关机拖住（Win10/11 的"以下应用阻止关机"）。

**已核实的机制**（不看实机也能定的部分）：`tao 0.35.3`（Tauri 的窗口层）在
`~/.cargo/registry/src/*/tao-0.35.3/src/platform_impl/windows/event_loop.rs:2382-2391` 明确**不处理 `WM_QUERYENDSESSION`**（源码里被注释掉，注释原话："We don't process `WM_QUERYENDSESSION` yet until we introduce the same mechanism as Tauri's `ExitRequested` event"），只在 `WM_ENDSESSION` 时销毁事件循环并返回 `LRESULT(0)`。
⇒ 关机/注销流程**不产生 `CloseRequested`** ⇒ 我们的确认分支不会被关机走进 ⇒ **"阻止关机"在机制上不成立**。
[假设，待实机复核] 该结论在真实关机下成立（未做 `shutdown /s` 实测）。

**已登记的残余面**（值得顺手看，非阻断）：
- 注销：同一条 `WM_QUERYENDSESSION`，推理同上；
- **直接发 `WM_CLOSE` 的第三方路径**（任务管理器「结束任务」、`taskkill /IM dsh-desktop-dev.exe` 不带 `/F`）：**会**走进确认分支 → 预期弹确认窗、点确认只**隐藏**不退出 → 任务管理器会报"无法结束任务"（关窗本来就不退出应用，属已知代价）。

**若将来要做（约 2 分钟）**：删 `%APPDATA%\dsh.smoothly.desktop.dev\background-close-confirmed` → 启动 dev 版 → `shutdown /s /t 30`（`shutdown /a` 可取消）→ 判据：关机照常完成、无确认窗拖住；做完读 `session.log` + 标记文件即可（壳与 dev 数据目录在 WSL 下可直读）。

### 12.2 关于弹窗「预装插件」行的渲染复验（10 秒）

代码与数据面已验证（`shell_status_json` 现带 `upgrade`/`preinstalled` 相关字段、`/shell/state` 有 `preinstalled`、`dsh.json` 有 `preinstalledVersions` 四包版本），**只剩"那几行真的渲染出来"没被眼睛确认**：UIA 对 shadow DOM 按钮不支持 `InvokePattern`，物理点击偶发被吞（`click -Key menu` 有时不展开下拉）。

**前置**：dev runtime 的 dsh 已是 0.1.7-rc.2，而预装 `dsh-model-reasoning`（见 §11 阻断项）会让 UI 卡在「Failed to load plugins」→ 先把 `runtime/dsh-home/profiles/web/package.json` 的 `dsh.profile.bundles` 里的 `"dsh-model-reasoning"` 摘掉再启动 dev 版。
**步骤**：点左上角 DSH 图标（壳菜单）→「关于 DSH Smoothly Desktop Dev」。
**判据**：出现「预装插件（随壳发布，界面不提供升级）」+ 四行版本（kanban 0.2.8 / model-reasoning 0.2.4 / opencode-session 0.2.0 / turn-navigator 0.4.4）= 通过；没有 = 缺陷（登记回本方案 + 看板）。

### 12.3 isolated 布局冷安装（15–20 分钟，可由我代做）

去掉 manager 的 `--node-linker=hoisted` → 冷装（约 590 包）→ 验证预装插件可解析、UI 起得来。代价：重装 dev runtime 的 `node_modules`（不动正式版）；失败则回滚为 hoisted。**用户说一句即可开工**。

### 12.4 本轮证据落点（截图在 Windows 侧，WSL 下可直读）

`D:\Dev\_shots\`（=`/mnt/d/Dev/_shots/`）：`s6-failure-state.png`（失败态 + 打开证据目录）、`confirm-window.png` / `confirm-titlebar.png`（确认窗文案与按钮）、`s8-caption-on.png`（caption 几何）、`no-model-reasoning.png`（caption 真实 UI 视觉）、`s9-attribution-fixed.png`（升级归因 + 回退按钮）、`s10-about2.png`（关于弹窗）。桥验证脚本输出：`scripts/verify-bridge-guards.ps1`（真机 10/10）。

## §13 预装插件适配 0.1.7（用户选路①：改插件）—— 进展与链路

**用户决定**：走"插件做改动"这条路（另两条：暂缓抬地板 / 插件不进预装），目标是"确保适配最新版本的 dsh"。

### 13.1 事实（2026-09-26 核实）

- 插件仓 `/home/karoc/dsh-model-reasoning` **已完成迁移**：commit `3ba7105 fix(compat): migrate to the dsh 0.1.7 settings-forms service (configForms)`，随后 `ee62335 feat(compat): declare the dsh >= 0.1.7 floor as an optional peer - 0.2.6`；版本 **0.2.6**，工作树干净，`v0.2.6` tag 指向 HEAD `dd811d9`，`release-check` 全绿（version/docs/changelog/tag/tree/build/registry 一致，且确认"0.2.6 未发布"）。
- 源码现状：`export const inject = ['slots','locale','remote','remote.settings','configForms']`；读取改 `ctx.configForms.get<PiAiSection>(PI_AI_NS)`（`ConfigForm` 与旧 `SettingsScope` 同形）；写入仍走 `ctx.remote.settings`。产物里 `settingsScope` 仅剩说明文案（0 处实际用法）。
- **npm `latest` 仍是 0.2.4**（2026-09-06 发布）→ 0.2.5/0.2.6 **从未发布**。这就是壳打包的 0.2.4 在 0.1.7 下卡死的根因。
- 服务可见性：`configForms` 在 dsh **0.1.7** 有 33 个文件提供/使用，在 **0.1.6** 为 **0** → 0.2.5+ 需要 dsh ≥ 0.1.7（与仓里声明的 optional peer 一致）。

### 13.2 真机验证（dsh 0.1.7-rc.2，dev 壳 0.11.0）

方法：重建插件产物（`pnpm bundle`，产物字节与已提交一致 → 工作树无 diff）→ 把它装进**装机版**的 `resources/preinstalled/dsh-model-reasoning`（备份在 `/tmp/preinstalled-mr-0.2.4`）→ 由 manager 自己更新 runtime（日志 `updated preinstalled dsh-model-reasoning`，runtime 版本变 0.2.6）→ 重启壳。
结果（截图 `D:\Dev\_shots\mr-026-real-ui.png`、`mr-026-settings2.png`、`mr-026-section.png`）：
- 页面**不再停在**「Failed to load plugins」→ 正常 UI（会话列表 + 引导窗 + 我们的壳栏）；
- 设置页导航出现插件分区 **「思磨力提供方参数」** → `settings.section` 注册成功；
- 进入该分区，标题/说明/空状态（"还没有第三方提供方…"）正常渲染 → `configForms.get('llm-pi-ai')` 读取路径可用。
⇒ **插件侧的 0.1.7 适配在真实 dsh 上通过**。

### 13.3 剩余链路（按顺序）

1. **发布 0.2.6 到 npm**（**用户动作**，2FA/OTP）：仓内已准备到"一条命令可发"——`cd ~/dsh-model-reasoning && npm publish`（会再跑 `prepublishOnly` 门禁）。发布后 `postpublish` 自动验证（索引延迟可达数分钟，脚本按此设计）。
2. **壳侧预装拷贝同步 0.2.4 → 0.2.6**（**可代做**，按 `dsh-preinstalled-plugin-sync` 技能：npm tarball 逐字节 + README 裁剪 + `npm run sync:resources` + 门禁）。
3. **壳发新版本**（含本会话全部改动 + 新插件）→ 用户在 Web 合并 PR → CI 出包。
4. **注意**：本会话只改了**装机版**的 preinstalled 目录用于验证，**仓库里的 `src-tauri/resources/preinstalled/dsh-model-reasoning` 仍是 0.2.4**（未动），所以仓库状态仍与已发布版本一致。

### 13.4 兼容边界（已登记，低severity）

dsh 0.1.6 **没有** `configForms` → 若"插件已升 0.2.6 而 dsh 仍是 0.1.6"（例如地板升级失败/离线），插件会同样停在 `pending (waiting for service: configForms)` → UI 卡住。壳的 `MIN_DSH_VERSION='0.1.7-rc.2'` 会在启动时强制升级 dsh，多数情况下两者同步前进；升级失败时用户看到的是「安装失败」而不是静默坏界面（自曝性）。若将来真的咬到，两个可选修法：(a) manager 在 `ensurePreinstalled` 前校验 dsh 版本 ≥ 插件声明的地板（按插件维护地板映射）；(b) 插件侧双路（`ctx.get('configForms') || ctx.get('settingsScope')`）——与插件仓"声明 0.1.7 地板"的现有决策冲突，需先改那边的决策。

### 13.5 新增静态门禁：`scripts/test-plugin-dsh-compat.mjs`（④ 的落点）

**它把"插件与 dsh 版本耦合"从"真机才发现"变成"发包前就红"**。检查三件事：

1. **已移除服务的残留用法**：地板 ≥ 某服务被移除的版本行时，插件 `lib/client.js` **去掉注释后**不得再出现该服务名（当前表：`settingsScope`，dsh 0.1.7 移除，替代 `ctx.configForms.get(ns)`）。命中即 FAIL，报错文案直接给出替代品、证据与两种修法。
2. **声明的 peer 地板必须被壳地板满足**：插件的 `@deepseek-ai/dsh*` peerDependencies（如 0.2.6 的 `@deepseek-ai/dsh-client-ui-settings: ">=0.1.7-rc.1"`）必须被 `MIN_DSH_VERSION` 满足，否则 FAIL。前提是 dsh 与 `@deepseek-ai/*` **同版本行发布**（lockstep）——已实测 0.1.6-alpha.1 / 0.1.7-rc.2 两套运行时均成立。
3. **完全未声明 dsh 地板 → 只警告**并列出（缺声明不是破坏性证据；做成 FAIL 会让门禁变成"四个插件都得先改一遍"的噪音门禁）。

**门禁自身的可信度**：脚本内置 **13 条比较器自检**（含 prerelease 排序、caret 在 `0.x`/`0.0.x` 的特例、tilde 上界、区间），自检失败即整体失败。构建过程中自检立刻抓出我两个 bug：
- caret 上界写成了"永远 bump major"→ `^0.1.7` 误判 0.2.0 满足（semver 规则：`0.x` 的最左非零位才是破坏性轴）；
- 用**严格 semver** 判"服务移除是否生效"→ `0.1.7-rc.2` 被误判成"还没到 0.1.7"，**会漏掉本次真实事故**。改为按**版本行**（忽略 prerelease）比较后命中。

**对照（都做过）**：正向 —— 临时换入本地构建的 0.2.6 → **PASS**（且注释里的服务名不误报，证明去注释有效）；负向 —— ① 把 0.2.6 的 peer 抬到 `>=0.1.8` → FAIL；② 往 `inject` 里塞回 `settingsScope` → FAIL；③ 当前仓库状态（0.2.4）→ FAIL。仓库文件已逐字节还原。

**位置与当前状态**：接在 `npm test` **链尾**（其余套件照跑，总体仍红）——`npm test` 现在 **exit 1**，唯一失败项就是本门禁，且报错里写明"同步插件到已适配版本"或"下调 MIN_DSH_VERSION"。**这道红是刻意的**：当前树（插件 0.2.4 + 地板 0.1.7-rc.2）装出来就是打不开的 UI，红着才对；**0.2.6 同步完成后应自动转绿**（正向对照已预演）。README/CONTRIBUTING 的套数同步为 14。

### 13.6 同步器脚本 + 演练判据（③ 的可执行化）

③ 需要一条**可复用、可演练**的命令，而不是每次手抄文档步骤（这条流程此前踩过两次坑：README 双语链接行格式因仓而异 → 坏链；精简约定砍掉运行时资产）。新增 `scripts/sync-preinstalled-plugin.mjs`（`npm run sync:plugin -- <pkg> [ver] [--check]`）：
下载 tarball → 按**包作者在 tarball `package.json` 里的 `files`**（registry 元数据不可靠）+ npm 隐式文件（package.json / README / LICENSE）减去 denylist（README.zh.md / CHANGELOG / CONTRIBUTING / *.map / docs/）→ README 裁剪（删含 `README.zh.md` 的整行及其**后**的空行，保留其**前**的空行）→ 逐文件比对 → 落盘 → `sync-resources.mjs`。

**演练判据**：对"已发布且已是最新"的版本做 `--check`，必须**零 diff**。首次落地时这条判据立刻抓出三处偏差（都已修）：① 我多删了链接行**之前**的空行（标题与徽章贴在一起）；② 最初的硬编码收文件规则会删掉 **dsh-kanban 的技能资产**（`skills/kanban-use/SKILL.md`、`scripts/install-skill.mjs`）——正是技能文档记过的历史事故；③ **host-only 插件**（`@karoc/dsh-smoothly-opencode-session` 没有 `lib/client.js`）被写死的必需文件表误报。

**结果**：四个预装包（model-reasoning 0.2.4 / kanban 0.2.8 / turn-navigator 0.4.4 / opencode-session 0.2.0）演练**全部零 diff** ⇒ 同步器可逐字节复现已发布拷贝。0.2.6 发布后，③ 就是 `npm run sync:plugin -- dsh-model-reasoning 0.2.6`，随后 `test-copy-consistency` 与 `test-plugin-dsh-compat`（应转绿）两道门禁验证。

### 13.7 发布预检（2026-09-26 第 3 轮）：两个硬事实 + 0.2.6 同步的真实预演

**① 发布被 auth 挡住（用户动作，非代码问题）**：`~/.npmrc` 里有绑定 `//registry.npmjs.org/` 的 `_authToken`，但
`npm whoami` 与直测 `GET /-/whoami`（带该 token）**都返回 401** ⇒ **token 已失效/被吊销**。因此 `npm publish` 会直接失败；
用户需先 `npm login`（或换一个新 token）再发布。registry 配置本身正常（`registry.npmjs.org` + 本地代理 `127.0.0.1:20172`）。
附带发现：`npm publish --dry-run` 也会跑 `postpublish` → 它在"未发布"状态下会按设计轮询 registry ~5 分钟才结束，
**dry-run 的 5 分钟停顿是预期的**，不是失败（真正的发布才会让轮询很快成功）。

**② 0.2.6 同步的真实预演（用本地 `npm pack` 的 tarball + 新增的 `--tarball` 模式）**：
tarball 的 `package.json` 声明 `files: [lib/index.js, lib/client.js, cordis.patch.yml, README.zh.md, CHANGELOG.md, CONTRIBUTING.md]`
（**registry 元数据里看不到 `files`** —— abbreviated packument 会省略它，所以同步器必须读 tarball 内的 package.json，已在 §13.6 修正）；
同步器收录 6 个（两个半区 + cordis.patch.yml + package.json + 裁剪后的 README.md + LICENSE），按约定丢弃 3 个（CHANGELOG / CONTRIBUTING / README.zh.md）。
**预演 diff：变更 3 个（`lib/client.js`、`package.json`、`README.md`），新增 0、删除 0** —— 正是"适配版本"应有的形状（客户端产物 + peer 声明 + 兼容性文案），无意外文件。
四个已发布版本（model-reasoning 0.2.4 / kanban 0.2.8 / turn-navigator 0.4.4 / opencode-session 0.2.0）回归演练**仍全部零 diff**。

**同步器增强**：新增 `--tarball <路径|URL>`（发布后 registry 索引延迟时可直接用本地 tarball 同步；也用于发布前预演），版本/包名以**包内声明**为准并校验一致性。

### 13.8 ④ 的运行时缺口：回退（降级 dsh）与新版插件的冲突（2026-09-26 第 4 轮补）

**问题**：静态门禁（§13.5）只管"**打包时**的搭配"。但 S9 的「回退到 vA」是**运行时把 dsh 降级**——回退后的 dsh 可能缺少新版预装插件所需的服务（例：0.1.6 没有 `configForms`），而 dsh 的 web boot 对未激活条目 fail-closed ⇒ **界面停在「Failed to load plugins」打不开**。这条路径静态门禁拦不住（它是用户主动动作 + 运行时状态），也不能靠"禁止回退"来规避（回退本身是升级失败时的救命手段）。

**处置（本轮实施）**：把根因与自救路径写在用户看得到的地方，而不是只写在文档里——
- 启动页回退按钮的 `title`：`装回升级前的版本。注意：① 升级后写入的新数据旧版读不到；② 若旧版 dsh 缺少新版插件所需的服务，界面可能打不开 —— 可在启动页点「停用第三方插件」自救。详见 README「升级与数据安全」`；
- 点击后的日志（`appendLog`）同样写明根因与自救（`停用第三方插件`，会先备份 profile 配置）；
- README「升级与数据安全」新增一条同义说明；
- 契约断言 3 条（**按钮 title 那处**必须含自救提示、必须点出根因、README 必须写明后果），**2 个负向对照变红**（删按钮提示 / 删 README 那句）。
  ⚠️ 断言第一次写宽了（只查 `停用第三方插件」自救`，被 `appendLog` 里的同文案放过 → 变异不变红），已收紧到按钮 title 的完整片段——同一类错误在本会话已出现 3 次，规则重申：**断言必须匹配到"唯一会因该变异而改变"的代码行**。

**仍未做（登记为可选加固）**：manager 在 `ensurePreinstalled` 前校验"已装 dsh ≥ 插件声明的地板"，不满足则**跳过该插件的启用**并日志告警（更自动，但会"悄悄禁用用户的插件"，需要先设计恢复路径，故本轮不做）。

### 13.9 ③ 已执行（2026-09-26 第 5 轮）：从**本地 tarball** 同步 0.2.6，壳恢复可发布

**为什么可以用本地 tarball 而不等 npm 发布**：发布被用户的 npm 凭据挡住（401，见 §13.7），但
① 壳的预装插件**不从 npm 取**（`ensurePreinstalled` 从 `resources/preinstalled` 拷贝），所以同步本地 tarball 立刻让壳恢复到"装出来能用"的状态；
② `npm publish` 上传的就是 `npm pack` 的产物，而**构建是确定性的**——连打三次包 sha1 完全一致：`49dc4a3d5deb3846d38b2b48eae8b30f0d892912`（本地 tarball 40988 字节，tag `v0.2.6` = HEAD `dd811d9`，工作树干净）。
③ 因此"仓库字节 == 将来发布字节"这条不变量可以**在发布后用一条命令复核**（见下），不需要在发布前建立。

**执行结果**：`node scripts/sync-preinstalled-plugin.mjs dsh-model-reasoning --tarball <本地 tgz>` → 变更 3（`lib/client.js`、`package.json`、`README.md`）、新增 0、删除 0（与 §13.7 的预演完全一致）；`sync-resources.mjs` 已跑；**幂等复核零 diff**；`plugins/preinstalled/` 与 `src-tauri/resources/preinstalled/` 两处都是 **0.2.6**；`test-copy-consistency` 绿、**`test-plugin-dsh-compat` 由红转绿**（真实产物上的红→绿转换，不只是正向对照）；`npm test` 14 套全绿。

**发布后必须做的复核（一条命令，写进技能 §3.5）**：
```bash
node scripts/sync-preinstalled-plugin.mjs dsh-model-reasoning 0.2.6 --check   # 从 registry 拉 0.2.6 比对
# 期望：CHECK PASS — 零 diff（否则说明 registry 上的字节与仓库不一致 → 以 registry 为准重跑同步）
```

**仍未完成**：② 发布本身（用户 `npm login` → `npm publish`）。它不影响壳的可发布性，但影响两件事：
(a) 第三方用户 `dsh plugin add dsh-model-reasoning` 拿到的还是 0.2.4（在 0.1.7 下打不开界面）；
(b) "仓库字节 == registry 字节"这条不变量尚未建立（发布后用上面那条命令复核即可）。

### 13.10 交接状态（2026-09-26 第 6 轮，目标判 blocked）

**已完成且验证**：① 0.2.6 真机验证（dsh 0.1.7-rc.2：UI 正常 + 设置分区「思磨力提供方参数」注册渲染，截图 `D:\Dev\_shots\mr-026-*.png`）；③ 壳同步 0.2.4→0.2.6（本地 tarball，构建确定性 sha1 `49dc4a3d5deb3846d38b2b48eae8b30f0d892912`；幂等零 diff；两处副本均 0.2.6；`npm test` 14 套全绿 exit 0）；④ 静态兼容门禁（红→绿实测）+ 运行时回退缺口（按钮/日志/README + 3 断言 2 变异）；⑤ 看板卡、Note Addendum 2、技能 §3.5/§6.5、方案 §13.1–§13.10。

**阻塞项（唯一剩余，用户动作，超出 agent 能力）**：`dsh-model-reasoning@0.2.6` 发布到 npm。具体阻塞条件：本机 npm 凭据失效（`npm whoami` 与直测 `GET /-/whoami` 均 401，`~/.npmrc` 的 token 已失效），而登录需要用户的账号 + 2FA/OTP。**已连续 5 轮（第 2–6 轮）核验同一条件**。
- 解除方式：`npm login` → `cd ~/dsh-model-reasoning && npm publish`（仓内就绪：干净树、tag `v0.2.6`=HEAD、`release-check` 全绿）。
- 解除后我要做的唯一一步：`node scripts/sync-preinstalled-plugin.mjs dsh-model-reasoning 0.2.6 --check`（期望零 diff；不为零则以 registry 字节为准重跑同步）。

**登记为"未做"的两项（非本目标完成条件，留待需要时做）**：
1. **不一致态的恢复路径 E2E 验证**：当 UI 真停在「Failed to load plugins」时，用壳菜单「停用全部第三方插件…」（确认窗 → 唯一执行点）或启动页安全网把界面救回来。能力都在（菜单在失败页仍渲染、确认窗/桥端点/执行分支均已验证），但**没有端到端实测过**；要实测需在 dev runtime 装回 dsh 0.1.6 并置 `devMode: true` 冻结地板升级（约 590 包安装 + 两次重启）。
2. **manager 侧运行时守卫**：`ensurePreinstalled` 前校验"已装 dsh ≥ 插件声明的地板"，不满足则跳过启用并日志告警 —— 更自动，但会"悄悄禁用用户的插件"，需先设计恢复路径（故仅登记）。

## §14 两项待办的处置（2026-09-26，用户指令）

### 14.1 「不一致态的恢复路径 E2E 实测」→ 梳理后判为已解决

用户指令：梳理清楚、确认没问题就标记解决（以后不生效再说）。**梳理结论：恢复路径成立，且第 14.2 项把它从"手动自救"升级为"自动自愈"。**

已核实的证据链（每一环都在本会话实测过，不是推断）：
1. **失败页上壳的 UI 仍可用**：页面停在「Failed to load plugins」时，注入的壳菜单栏照常渲染（`dump` 仍列出 `[Button] 菜单 @ 77,2 60x60`；截图 `s8-caption-on.png` 即该状态）。
2. **菜单动作在远程页可用**：菜单可点开（Menu 项实测列出「停用全部第三方插件…」「重启服务」等），且这些动作走壳确认窗（S4-1，实测批准过 `titlebar-contract`）。
3. **停用逻辑本身正确**：`disable_third_party_plugins`（Rust）**先备份** profile manifest（`package.json.bak-disable-plugins-<时间戳>`）再写回两层模板 bundles；`preinstalled` 与用户自装插件分别统计、提示措辞不同。
4. **需要一次重启才生效**：该函数只改 manifest，不重启 dsh web（符合"改配置不隐式重启"的既有约定）；重启入口存在（菜单「重启服务」→ 确认窗；manager 死时启动页有「重试」）。
5. **manager 死亡时另有启动页安全网**：失败态截图显示启动页有「停用第三方插件」（会先备份）。

⇒ 手动恢复 = 菜单「停用全部第三方插件…」→ 确认 → 菜单「重启服务」→ 确认。**该路径标记为已解决**；若将来不生效，按用户约定回报即可。

### 14.2 「manager 侧地板守卫」→ 方案 + 已实施（运行时自愈）

**问题**：静态门禁只管"打包时的搭配"；运行时仍可能不一致（用户回退 dsh、离线导致地板升级失败、插件与 dsh 被单独升降级）→ 插件 fiber 永 pending → dsh web boot fail-closed → 界面打不开。

**方案（已实现）**：
- 纯逻辑模块 `scripts/plugin-floor.mjs`：`collectDshFloors`（只取 `@deepseek-ai/dsh*` 的 peer 声明）+ `planPluginGuard({installedDsh, bundled, enabled})` → `{skipInstall, quarantine, warnings}`；内置 9 条 semver 自检。
- manager 在 `ensurePreinstalled` 开头调用 `applyPluginFloorGuard`：
  - **skipInstall**：地板不被满足的预装插件**不装进 runtime**（装了也不激活）；
  - **quarantine**：已启用且地板不被满足的插件**从 profile bundles 摘掉**（先 `package.json.bak-plugin-floor-<ts>` 备份，再原子写回；记录到 `dsh.json` 的 `quarantinedPlugins`），使 dsh web 能起来；
  - 新增 `writeWebProfileBundles`（JS 侧等价写入器：保留其它字段 + tmp/rename 原子写，避免 2026-09-07 的"半截 manifest → 模板重建 → 插件全丢"）。
- **负向保证**：不动 `@deepseek-ai/*`（dsh 自身）；不动**未声明地板**的插件（没有证据就绝不改用户状态，只告警）；不删除任何文件（隔离只改启用列表，dsh 升上去后自动不再隔离，用户可在插件页重新启用）；dsh 版本未知时不做任何判断。
- **验证**：`scripts/test-plugin-floor.mjs`（8 组断言：semver 自检 / prerelease 排序 / 只取 dsh peer / 四态计划 / 不误伤）接入 `npm test`（现 **15 套**）；**4 个负向对照变红**（忽略 prerelease 排序 / 未声明地板也隔离 / 隔离 `@deepseek-ai/*` / caret 上界退化）。
- **副产品验证**：manager 模块图同步**自动**带上了 `plugin-floor.mjs`（S0 的"按相对导入闭包拷贝"修复在真实新增模块上生效）。

**仍未做（登记）**：把 `quarantinedPlugins` 呈现到界面（当前只在 `dsh.json` + manager 日志里）；不一致态下的守卫 E2E 实测（需在 dev runtime 装回 dsh 0.1.6 + `devMode: true` 冻结地板）。
