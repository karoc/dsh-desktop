# dsh-desktop 插件管理控制台 — 实施计划

> 状态：**实施中**（方案已与用户逐点确认）
> 目标：在桌面壳内实现「更新门控 + 插件预装/管理 + 友好操作提示」，零上游 dsh 改动。

## 实施状态（2025-08 更新）

| 阶段 | 状态 | 说明 |
|---|---|---|
| P0 控制面 | ✅ 完成 | manager stdin 命令通道（check-update/update-dsh/restart-dsh）+ 监督循环；Rust 桥端点（refresh/restart-dsh/restart/update-status/check-update/update-dsh/devtools）；`scripts/test-control-plane.mjs`（6 场景） |
| P1 更新门控 | ✅ 完成 | manager 只查不装 + `{t:'update-status'}`；托盘动态项（检查更新⇄有更新）；启动页横幅 + 一键更新；测试覆盖 |
| P2 预装+控制台 | ✅ 完成 | `ensurePreinstalled`（resources→runtime node_modules + dsh.json）；Rust `/plugins/list`、`/plugins/enable`、`/plugins/disable`（文件操作）；控制台 client 插件（悬浮面板，`scripts/test-plugin-console.mjs` 7 场景）；预装 `dsh-model-reasoning` 已进 resources |
| P3 刷新/重启/Dev | ✅ 完成 | 托盘刷新页 + 重启dsh（快速）；Dev 模式 = dsh.json `devMode`（更新冻结 + devtools 门控 + 托盘复选框）；**HMR module-roots 生产不可用**（dsh 硬编码 `root: []`），host 迭代走 restart-dsh 快速回路 |
| P4 预装集成 | 🔶 进行中 | 产物已入 resources + 拷贝验证通过；真机端到端（WebView 内启用→Settings 出现页面）待桌面环境验证 |
| P5 用户自装 | ✅ 完成（方案 X） | manager `ensurePnpm`（懒安装内置 pnpm + PATH shim）→ 复用 `dsh plugin --profile web add/remove/update` CLI（含 reconcile）；Rust `/plugins/install|remove|update` 端点 + op-status 缓存；控制台安装输入框 + 用户插件卸载/更新 + 操作状态/nextAction；控制面测试 7 场景 + 控制台测试 9 场景 |
| P5b 预装更新机制 | ✅ 完成 | **用户门控**（与 D2 一致）：控制台预装卡片"有更新 vX → 更新到 vX" + "恢复默认" + "检查预装插件更新"；manager 临时目录 npm install + 拷贝覆盖 runtime 拷贝（**不能用 `--prefix runtime`，会 prune 纯拷贝插件**）；dsh.json `updates` 记录 + `ensurePreinstalled` 尊重记录不被壳旧版覆盖；`{t:'preinstalled-updates'}` 事件 → Rust 镜像 → /plugins/list 带出；控制面 8 场景 + 控制台 12 场景 |

**两处相对本计划的设计偏差（均已实现，记录备查）：**

1. **控制台 UI 用悬浮面板而非 Settings tab**：Settings 的 slot 契约要求 React 组件，经典脚本插件拿不到 React（不暴露全局，无构建链）。悬浮面板（右下角「⚙ 插件」）与通知插件同款模式，零构建、零上游依赖。
2. **插件开关由 Rust 直接做文件操作**（而非 manager stdin 往返）：`/plugins/enable|disable` 直接读写 `<runtime>/dsh-home/profiles/web/package.json`，无需请求/响应往返，更简单可靠。预装名白名单校验在 Rust 侧完成。
3. **Dev 模式不含 host HMR**：核实 `dsh web` 生产构建无 module-roots 入口（`cordis-plugin-hmr` 以 `root: []` 挂载，仅配置热更）。host 代码迭代 = restart-dsh 快速回路（不查更新、不重装，秒级）。

---

## 0. 已确认决策

| # | 决策 | 说明 |
|---|---|---|
| D1 | **功能走壳内，零上游改动** | 管理控制台 = `--patch` 注入的 client 插件 + 回环桥 + manager，与通知插件同款模式 |
| D2 | **去掉启动自动更新** | 改为启动时只检查、红点/菜单提示，用户决定是否一键更新（含自动重启） |
| D3 | **预装插件默认关闭** | 预装包从 resources 拷贝进 `<runtime>/node_modules`（随壳锁定版本），不写 profile dependencies；启用 = 写入 `web` profile 的 `dsh.profile.bundles` |
| D4 | **事件后友好提示** | 写操作返回结构化「下一步动作」，壳把它变成 toast + 一键按钮（重启/刷新） |
| D5 | **增加「只重启 dsh」第三级** | 不动 manager、不查更新、不重装插件，插件迭代的快速回路 |
| D6 | **增加「刷新页面」** | 托盘 + Ctrl+R；client bundle 已 `no-cache`，普通 reload 即拿到磁盘新内容 |
| D7 | **Dev 模式开关** | 冻结 dsh 版本 +（验证可行性）HMR roots + WebView2 devtools |
| D8 | **首个预装插件**：`dsh-model-reasoning` | 纯 client bundle、自包含无依赖、作者自持，适合预装；默认关闭 |

**层级模型（三层身份）：**

| 类别 | 位置 | 状态 | 可管理 |
|---|---|---|---|
| 内置核心（通知插件） | `--patch` + runtime node_modules | 常开 | 否 |
| 预装可选（model-reasoning） | runtime node_modules + bundles 开关 | **默认关** | 启用/关闭 |
| 用户自装（Phase 5） | profile + pnpm | 用户决定 | 增删改 |

---

## 1. 架构总览

```
┌─ dsh web（WebView2 远程页面）─────────────────────────────┐
│  Settings → 插件 页：管理控制台（client 插件，--patch 注入） │
│      └─ fetch ──┐（远程页面拿不到 Tauri API，一律走桥）      │
└─────────────────┼─────────────────────────────────────────┘
                  ▼
┌─ Rust 壳 ───────┴────────────────────────────────────────┐
│  回环桥（已有，扩展端点）                                    │
│    /refresh /restart-dsh /restart /update-dsh              │
│    /update-status /plugins/* /devtools                    │
│  托盘：检查更新/一键更新/刷新页面/重启服务/Dev 模式           │
│  写 manager.stdin 下发命令（JSON 行）                      │
└─────────────────┬─────────────────────────────────────────┘
                  ▼
┌─ server-manager.mjs（Node 24，拥有 dsh 子进程）──────────┐
│  命令通道：restart-dsh / update-dsh / check-update        │
│  ensurePreinstalled()：resources/preinstalled/* →         │
│    <runtime>/node_modules/*（字节对比幂等）                 │
│  插件开关：读/写 <runtime>/dsh-home/profiles/web/          │
│    package.json 的 dsh.profile.bundles（保字段，不碰       │
│    dependencies → reconcile 永远不会动预装包）             │
│  updateDsh → 只检查上报，不安装                            │
└──────────────────────────────────────────────────────────┘
```

**状态落点：**

| 状态 | 位置 |
|---|---|
| dsh 当前/最新版本 | manager 启动时检查 → stdout 事件 → Rust state → 桥只读 |
| 预装清单 + 用户开关 + dev 模式 | `<runtime>/dsh.json`（壳自有 manifest） |
| 已启用插件层 | `<runtime>/dsh-home/profiles/web/package.json` → `dsh.profile.bundles` |
| 预装包实体 | `<runtime>/node_modules/<pkg>`（resources 拷贝，随壳锁定） |
| 操作日志 | `<runtime>/manager.log`（沿用） |

---

## 2. 分阶段实施

### Phase 0 — 控制面基础设施（前置，无 UI）

**0.1 manager 命令通道**
- `scripts/server-manager.mjs`：增加 `process.stdin` 逐行 JSON 命令解析：
  - `{cmd:'restart-dsh'}` → 只 `killTree(dshChild)` + 重新 spawn dsh（**跳过 updateDsh / ensurePlugin**）
  - `{cmd:'update-dsh'}` → 跑安装（复用现有 npm 安装 + 双 registry 回退 + 进度流）+ 自动 restart-dsh
  - `{cmd:'check-update'}` → 重跑 `latestRemoteVersion()`，发 `{t:'update-status',...}` 事件
- 现状 `updateDsh()` 改为 `checkDshUpdate()`：只查并 emit，**不安装**。

**0.2 Rust 桥扩展**（`src-tauri/src/lib.rs::handle_bridge_conn`）
- 新增端点：
  - `GET /update-status` → 当前/最新版本、是否可更新
  - `POST /check-update` → 通知 manager 重查，回最新状态
  - `POST /update-dsh` → 下发 manager `update-dsh`（进度经现有 `/log` 通道回流 UI）
  - `POST /restart-dsh` → 下发 manager `restart-dsh`
  - `POST /refresh` → `webview.reload()`（普通 reload 即可，bundle 已 no-cache）
  - `POST /restart` → 复用现有 `restart_server`
  - `POST /devtools` → dev 模式下 `webview.openDevTools()`
  - `GET/POST /plugins/*` → 见 Phase 2
- 端点鉴权：全部仅 loopback 绑定（沿用现有桥的约束），`/plugins/*` 与 `/update-dsh` 这类写端点不做额外鉴权但记日志（本地回环 = dsh 进程同等信任域）。

**0.3 目录/资源**：`src-tauri/resources/preinstalled/` 预留；`sync-resources.mjs` 增加预装目录与 console 插件同步。

### Phase 1 — 更新门控（D2）

- manager：启动只检查，emit `{t:'update-status', current, latest, updateAvailable}`；`DSH_DESKTOP_NO_UPDATE=1` 时连检查都跳过（离线/冻结）。
- Rust：缓存 update-status；托盘菜单项：
  - `检查更新…`（触发 `/check-update`）
  - `有更新 vX.Y.Z（当前 vA.B.C）`（有更新时高亮显示，点即 `/update-dsh`）
  - 更新进度沿用现有 `server-log` → 启动页/托盘日志视图。
- 启动页（`src/index.html` + `app.js`）：有更新时显示 banner + 「一键更新」按钮。
- **一键更新 = 下载安装（进度）+ 自动重启 dsh**，用户无需第二步。
- 兼容声明：更新提示里带「预装插件兼容性：已验证于 dsh ≤ vX」备注（由壳发版声明）。

### Phase 2 — 预装机制 + 插件管理控制台（D1/D3/D4/D8）

**2.1 预装机制**
- 目录：`src-tauri/resources/preinstalled/@karoc/dsh-model-reasoning/`（构建产物：`package.json` + `cordis.patch.yml` + `lib/`）。
- manager `ensurePreinstalled()`：逐包拷贝到 `<runtime>/node_modules/<pkg>`，字节对比幂等（复用 `sameTree`）；写 `<runtime>/dsh.json`：
  ```json
  { "preinstalled": ["dsh-model-reasoning"], "devMode": false }
  ```
- **关键机制（坑位备忘）**：预装包**不进** profile dependencies → `reconcilePlugins` 只增删 dependency 列表里的名字，**永远不会动预装包**；启用时只写 `bundles`，解析靠安装锚点 parent-walk 命中 `<runtime>/node_modules`，无需 pnpm。

**2.2 管理控制台（client 插件 `@dsh-desktop/plugin-console`）**
- 结构同 `plugins/dsh-client-notifications`：`client.js` + `package.json`（`dsh.client` 声明 + exports["./client"]）+ `index.js`（host no-op）。
- 注册进 Settings → Plugins 区（`settings.plugins.tab` slot，与上游 inventory 同款接入，零上游改动）。
- 界面（zh/en 双语，对齐现有设计 token）：
  - **预装（默认关）**：model-reasoning 卡片，显示「预装 · 默认关闭 · 纯 UI 插件」徽标 + 描述 + 「启用」按钮
  - **已启用**：读 profile bundles，每行可「关闭」
  - **更新区**：当前/最新版本 + 「一键更新」
  - **操作按钮**：立即重启 / 刷新页面（仅在有 nextAction 时出现）
- 通信：全部 `fetch` 桥端点（复用 `__DSH_BRIDGE_PORT__` 占位符烧录机制）。

**2.3 manager 插件开关**
- `GET /plugins/list` → 合并三源：预装清单（dsh.json）+ 已启用 bundles（profile manifest）+ 内置核心（patch roster 已知项），返回结构化列表。
- `POST /plugins/enable {name}` / `POST /plugins/disable {name}` → 读写 `<runtime>/dsh-home/profiles/web/package.json` 的 `dsh.profile.bundles`（**保字段**：name/dependencies/其他 bundles 原样；web profile 缺失时按模板 `['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']` 初始化——与上游 `initProfile` 同语义的壳侧镜像）。
- 返回 `{ ok, nextAction: 'restart' }`；console 弹 toast + 「立即重启」按钮（→ `/restart-dsh`）。

### Phase 3 — 刷新 / 只重启 dsh / Dev 模式（D5/D6/D7）

- 托盘 + 设置项：`刷新页面`（`/refresh`）、`重启 dsh（快速）`（`/restart-dsh`）；Ctrl+R 快捷键（Rust 侧捕获转发 webview.reload）。
- Dev 模式（`<runtime>/dsh.json` 的 `devMode` + 托盘/设置开关）：
  - manager：`devMode=true` 时跳过版本检查（冻结）
  - HMR roots：**可行性待验证**（见 §6）——`dsh web` 是否有 flag/env 挂载 `cordis-plugin-hmr` module roots；若无，退路 = 「restart-dsh 快速回路」（已足够快）
  - devtools：`/devtools` → `openDevTools()`，仅 dev 模式放行
  - 客户端迭代回路：改源码 → build → F5 刷新（bundle 已 no-cache，刷新即生效）

### Phase 4 — 预装 dsh-model-reasoning 集成与端到端验证（D8）

- 构建：`dsh-model-reasoning` 仓库 `tsdown build` → 产物拷入 `resources/preinstalled/@karoc/dsh-model-reasoning/`。
- `sync-resources.mjs` 增加预装同步。
- 端到端验证矩阵（见 §4）。

### Phase 5（后续，原需求收尾）— 用户自装（npm / GitHub / 本地路径）

- 前置决策（已冻结待定）：**方案 X（壳内置 pnpm，复用上游 `dsh plugin` 全部逻辑）vs 方案 Y（manager 用 npm + 自实现 reconcile）**——建议 X。
- GUI：「安装新插件」对话框 → 源识别（npm 包名 / `github:user/repo` / `git+...` / 本地路径）→ `npm view` 预检（是否声明 `dsh.bundle`，非插件提前警告）→ 确认 → manager 执行 → reconcile → 提示重启。
- 卸载 / 更新 / 已装列表与 Phase 2 控制台合并。
- **与 D3 的关键差异**：用户自装包是 profile **dependency** → 受 reconcile 管理（自动加入 bundles、可卸载），与预装（非 dependency、reconcile 不碰）语义严格分离。

---

## 3. 关键机制备忘（防止踩坑）

1. **reconcile 与预装不打架**：预装包非 dependency → reconcile 的增/删循环都只处理 dependency 名字，预装 bundles 永不被误删，也不会被自动启用。
2. **预装包解析**：写进 bundles 后，`resolveBundleDir` 从安装锚点（`<runtime>/node_modules/@deepseek-ai/dsh/package.json`）parent-walk 命中 `<runtime>/node_modules/<pkg>`；client-modules 的 `createRequire(ctx.baseUrl)` 同样能一路 parent-walk 找到，host 挂载 + client bundle 发现都成立。
3. **profile bundles 读写保字段**：必须 read→JSON 改→write，绝不整文件覆写；web profile 缺失时按模板初始化，但模板列表要镜像上游（`dsh-base` + `dsh-web-app`），上游换模板名时壳要跟随（版本兼容声明的一部分）。
4. **远程页面无 Tauri API**：console 一律走桥；桥端口照旧用占位符 `'__DSH_BRIDGE_PORT__'` 烧录（注意只替换带引号字面量，避免 SyntaxError——ENGINEERING-NOTES #10 的教训）。
5. **更新/重启的进度回流**：npm 安装进度走现有 stdout 协议 `{t:'log'}` → Rust → 启动页/托盘日志，避免「点了更新像卡死」。
6. **`--port 0` 随机端口**：restart-dsh 后端口变化 → WebView 整页导航，天然等价全新 boot；无需额外处理，但 UI 文案要说明「重启后页面会刷新」。
7. **`no-cache` 的 client bundle**：刷新即拿磁盘新内容（`serveBundle` 每次读盘 + 无 ETag），无需硬清缓存。

---

## 4. 验证矩阵

| 场景 | 预期 | 验证方式 |
|---|---|---|
| 首次安装，有预装插件 | 插件管理页显示「预装·默认关」；通知插件照常工作 | 手动 + `linux-smoke` |
| 启用 model-reasoning | 写 bundles → toast「重启后生效」→ 点「立即重启」→ Settings 出现「模型思考等级」页 | 手动 |
| 关闭 model-reasoning | 从 bundles 移除 → 重启 → 页面消失 | 手动 |
| 有 dsh 新版本 | 托盘高亮 + 启动页 banner + 不自动安装 | 手动（mock registry） |
| 一键更新 | 进度显示 → 自动重启 dsh → 版本号更新 | 手动 + CI |
| restart-dsh | 不触发 npm 查询、不重装插件、端口变化、页面刷新 | 手动 + 断言 manager.log |
| 刷新页面（Ctrl+R） | WebView 重载，client bundle 取到磁盘新内容 | 手动 |
| Dev 模式 | 跳过版本检查；devtools 可开；host 改动经 restart-dsh 生效 | 手动 |
| reconcile 边界 | 预装包在 `dsh plugin` 操作后不被删/不被自动启用 | 单元/手动 |
| profile bundles 保字段 | 开关操作后其他字段原样 | 单测 + 快照 |

---

## 5. 非目标 / 延期项

- 不做源码级 client HMR（与「官方零改动」冲突）；dev 用「build + 刷新」回路。
- 不引入插件市场/目录搜索（P2 之后再说）。
- 不做「新装即热挂载」（client 侧无运行时 rescan，属上游能力；壳内不做）。
- 浏览器版（非桌面）不提供此控制台（壳内功能）。

## 6. 风险与待验证点

1. **`dsh web` 是否暴露 HMR module-roots 入口**（D7）——实现时验证；退路 = restart-dsh 快速回路，不阻塞。
2. **上游模板 bundles 变更**（`dsh-base`/`dsh-web-app` 换名）——壳侧镜像会失配；靠版本兼容声明兜底，并在更新时提醒。
3. **`dsh-model-reasoning` 对 dsh client API 的依赖**（slot/locale/design token/settings RPC）随 dsh 手动升级漂移——预装版本随壳锁定 + 兼容性备注；作者（用户本人）掌控升级节奏。
4. **pnpm 决策（Phase 5 前置）**：内置 pnpm（方案 X）体积 +30MB 左右 vs 自实现 reconcile（方案 Y）状态一致性风险——建议 X，实现 Phase 5 前再最终确认。
