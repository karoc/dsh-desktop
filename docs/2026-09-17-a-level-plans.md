# A 级改进方案 v2（经多角度审计修订）

> v1：`docs/2026-09-17-a-level-plans.md`（初稿）
> 审计：`docs/2026-09-17-a-level-plan-audit.md`（安全/失败模式 + 兼容/回归/成本 + UX 自查）
> 本文是**审计后修订版**：修正 8 处事实错误、吸收 13 项 P0、采纳 5 条"更省的做法"
> 状态：**待你决策**（每项方案标注了"建议采纳/建议缩减/建议暂缓"）
> 日期：2026-09-17

## 修订摘要（先看这个）

| 方案 | v1 | v2 修订 | 建议 |
|---|---|---|---|
| A-1 壳自更新 | 一期做 `latest.json` + `open_url` 提示 | **砍掉 `latest.json`**（直接用 `/releases/latest` 响应）；**不自动打开 URL**（只显示版本与 Release 页地址）；一期需**新增 TLS 依赖** | **缩减后采纳一期**；二期暂缓 |
| A-2 路径守卫 | 新建 `path_guard.rs` + 三处接入 | **缩到三处字符串判定**（`lib.rs:743/820/986-989`）；`guard_removal` 推迟；**NSIS 范围扩到三分支 + lnk 校验**（修已验证缺陷） | **采纳（含 NSIS 缺陷修复）** |
| A-3 清理数据 | 运行时清 node_modules/EBWebView/reports/backup | **只交付卸载文案 + L1 缓存清理**；**`reports` 永不删**；**EBWebView 交由卸载器**；**默认保留 `.pnpm-store` 与最新备份** | **大幅缩减**；彻底清理留待 A-2 落地后 |
| A-4 禁用第三方插件 | 新增 Rust 命令改 bundles | **改为「打开插件管理」按钮**（一行，复用已有命令）；把"用户插件停用/启用"做进控制台 | **改为最省方案** |

**另外新增两项低成本门禁**（审计发现，独立于上述方案）：
- G-1：两份 manager 副本**相等性断言**（现在漏 `sync:resources` 时测试全绿）
- G-2：`cargo test` 与 `verify-*.ps1` 的 CI 覆盖缺口（当前 Windows 专属验证零门禁）

---

## A-1 壳自更新（修订版）

### 修订要点

| v1 的错误 | v2 修正 |
|---|---|
| 「Rust 用现有 HTTP 能力」 | **Windows 构建无 TLS 客户端**（reqwest 仅移动端 target 依赖；rustls/native-tls 零命中）→ 需新增 `ureq`+`rustls`，或给 `windows` crate 加 `Win32_Networking_WinHttp` feature。**成本承诺改为"1 个新依赖"** |
| 「复用现有 `open_url`」 | **该能力不存在** → v2 **不自动打开 URL**（避免新增 ShellExecute 面）；改为在弹窗里**显示 Release 页地址文本**（用户自行复制/点击浏览器） |
| CI 产出 `latest.json` | **砍掉**：`/releases/latest` 响应已含 `tag_name` + `assets[].browser_download_url` → 删掉 `build.yml`+20 与 `release-body.mjs`+30 的全部改动，**消灭"移 tag 后遗留旧 latest.json"整类回归** |
| 「dev 构建不检查」一句话 | 判别器**不存在**（dev conf 无 `version`，同一份代码 `--config` 构建）→ 明确写：**运行期读 `app.config().identifier`**，含单测 |
| 版本比较未定义 | **复用 manager 现成 `versionGt`**（`server-manager.mjs:353-360`，预发布感知 + 已含降级保护）而不是新写比较器；并明确 **semver 语义**（防 `0.10 < 0.9`） |
| 未提 404 回退 | `releases/latest` 在只有 prerelease 时是 404 → **回退 `/releases` 列表取第一个非 draft** |
| 未提桥是一问一答 | 桥是**同步拼响应**（`lib.rs:1821-1826`），manager 回复是异步协议行 → 需**第二个轮询端点**（范式：`/check-update` + `/update-status`） |
| 未提托盘 | `update-status` 有 **6 个消费点**，且托盘在 `available` 时**点击直接发 `update-dsh`**（`lib.rs:3440-3451`）→ **壳更新必须走独立事件/端点，绝不复用 `update-status`** |

### 最终方案（一期）

1. **数据源**：manager 新命令 `check-shell-update`（Node 内置 `fetch`，走用户代理配置），
   请求 `https://api.github.com/repos/<owner>/<repo>/releases/latest`；404 时回退 `/releases`。
   - **缓存 6 小时**（未认证限流 60/h/IP）。
   - **不产出、不依赖 `latest.json`**。
2. **Rust 侧**：新桥端点 `GET /shell/shell-update`（**独立于 `/update-status`**）+ 第二个
   轮询端点（对齐现有 `check-update` → `update-status` 范式）。
3. **dev 判别**：`app.config().identifier == "dsh.smoothly.desktop.dev"` → 不检查（含单测）。
4. **版本比较**：复用 `versionGt`；**低于或等于当前一律不提示**（防降级）。
5. **UI**：现有「检查更新…」对话框（标题已是「检查更新（dsh 本体）」）**新增一个只读分区**
   「应用（壳）」显示：当前版本 / 最新版本 / Release 页地址（纯文本）。**不新增按钮、不打开 URL**。
   托盘与菜单项翻转**保持只反映 dsh 更新**（零回归）。

### 二期（签名自更新）：**建议暂缓**，若要做则必须先补三节

审计指出的致命缺陷（若二期启动，必须先写进方案）：
- **私钥隔离**：不能放在跑 `fetch-node`/`npm`/`pnpm` 的 job（任意代码执行面）或
  `contents: write` 的 release job → 独立 job，只做"下载产物 → 签名 → 上传"；
- **多公钥轮换**：一开始就内置**公钥数组**（单公钥 → 密钥丢失即死锁）；
- **签名验证失败的行为**：必须明确"静默丢弃 + 记日志 + **不提示有更新** + **绝不降级为无签名也装**"，
  并加负向测试。

### 验收标准（一期）

1. 菜单对话框显示壳与 dsh 两个分区，各自独立；
2. 壳分区显示 Release 页地址文本（**不自动打开**）；
3. 断网/限流时壳分区如实报错，**不影响 dsh 分区**；
4. dev 版不检查壳更新（单测覆盖 `identifier` 判别）；
5. **预发布通道零回归**：验证「选 next 能装到该版本」（v1 验收粒度太粗，已细化）；
6. `npm test` 全绿 + 实机验证。

---

## A-2 路径安全判据（修订版）

### 修订要点

| v1 的问题 | v2 修正 |
|---|---|
| `Path::components()` 逐段比 | **不足以归一化**：`\\?\C:\`（VerbatimDisk ≠ Disk）、`C:\a\..\Windows`（ParentDir 不折叠）、8.3 短名 均可绕过。**本仓库自己见过 `\\?\`**（`simplify_path`，`lib.rs:1852`）→ 必须先规范化：`dunce::canonicalize`（**显式加依赖**）+ `GetLongPathNameW`（`Win32_Storage_FileSystem` 已启用） |
| 保护列表 | **补 `%LOCALAPPDATA%\<identifier>` 自身**（A-3 正要删它下面 —— 交叉处最大单点风险）、壳安装目录、`%TEMP%`、`--cwd`；保护根**改用 `app.path().home_dir()`**（不读 `USERPROFILE` 环境变量，`lib.rs:891-896` 可被注入） |
| 范围：新建 `guard_removal` | **缩减**：当前生产删除是**非递归**的（`remove_file`/`remove_dir`，`lib.rs:963/974/986-989`），对 junction 天然安全 → `guard_removal` + 反向包含判定**推迟到 A-3 落地**；本次只修三处判定 |
| NSIS「`RMDir` 前加检查」 | **范围写窄了**：三分支全部汇到共享尾标签 `legacy_pre_done`（53-57 行），删 lnk 就在尾标签里 → **"旧版在跑→拒绝卸载"分支照样删快捷方式**（同 2026-09-09 事故）。**必须一并修分支 + 加 `IsShortcutTarget`** |
| 威胁模型 | **诚实化**：`installMode: currentUser` 无提权边界 → A-2 的价值是**防误删 + 为未来递归删除立地基**，不是安全边界 |

### 最终方案

1. **规范化前置**：`normalize_path()` —— `dunce::canonicalize` → 失败则**拒绝**（不降级）；
   消 `\\?\`/`\\?\UNC\`；`GetLongPathNameW` 展开 8.3；词法折叠 `..`。
2. **三处判定收紧**（只改这三处）：
   - `lib.rs:743`（`legacy_process_running` 的路径比较）；
   - `lib.rs:820`（`should_delete_shortcut` 的 `starts_with` → 归一化 `is_under`，补分隔符边界 + 大小写不敏感）；
   - `lib.rs:986-989`（空目录回收前复核）。
3. **保护列表**（含 `%LOCALAPPDATA%\<id>` 自身）+ 保护根改 `app.path().home_dir()`。
4. **NSIS 修复**（独立价值，可先做）：
   - 修共享尾标签分支缺陷（旧版主程序在跑时**不删 lnk**）；
   - `Delete` 前加 `IsShortcutTarget`（模板 `utils.nsh:160-184` 自带）；
   - **先跑 `scripts/verify-legacy-hook.nsi` 实测 `GetFileAttributes` 能否暴露 REPARSE_POINT**（未验证项，不得假设）。
5. **不做**：`guard_removal` / 句柄化删除 / TOCTOU 消除（当前无递归删除调用方，属过度设计）。

### 验收标准

1. 单测（新增 5 个负向用例）：`\\?\C:\`、`\\?\UNC\`、`C:\a\..\b`、`DSHDES~1`、
   OneDrive 占位（`ReparsePoint` 非 symlink，**`is_symlink()` 返回 false** → 必须用
   `FILE_ATTRIBUTE_REPARSE_POINT` 属性位做主判据）；
2. 实机验证：dev 版「旧版清理」在真实旧版残留上仍成功（不误拒）；
3. NSIS：旧版在跑时**不删** lnk（用 `verify-legacy-hook.nsi` harness 验证）；
4. **不得给守卫加身份检查**（`legacy_install_dir`/快捷方式候选刻意与身份无关）。

---

## A-3 卸载与数据清理（修订版，大幅缩减）

### 修订要点

| v1 的问题 | v2 修正 |
|---|---|
| 运行时清 `EBWebView` | **实机验证：EBWebView 是活 UDF**（最后写入 10:05:53、3 个 `msedgewebview2` 进程占用）→ **交由卸载器处理**，不在运行时清 |
| 「下次启动 WebView2 前清」 | **`setup()` 做不到**（窗口先于 setup 创建）→ 若要做必须放 `Builder::run()` 之前（先例 `lib.rs:3179-3191`）；v2 **不做**，交给 NSIS |
| 删 `runtime\reports` | **永不删**：那是 manager 崩溃证据与挂起 dump 落点，看板有**未结**取证卡正等证据 |
| 删 `.pnpm-store` | **默认保留**：暖 store 重建 ~6s vs 冷装数分钟（且冷装**需联网**） |
| 删 `dsh-backup\migration-*` | **至少保留最新一份**：含 `sessions/`/`storages/`/`.credentials.yaml`，rename 失败时是**唯一副本**；且**漏了 `cleanup-*`**（`lib.rs:956` 产生，通常更大）；两处备份根口径需统一（`lib.rs:638-639` fallback 落 `%APPDATA%\<id>`） |
| 未写"清理后需联网" | **失败语义必须写明**：`dshInstalled` false → `installDshUpdate` 冷装（超时 600s），离线则**起不来** |
| 与官方 takeaways 矛盾 | 官方要求卸载**必须**清应用自有外部态；v1 只写"请手动删" → v2 给出**卸载器入口**（见下） |

### 最终方案

**L0（默认，卸载时）**：保持现状 —— 只删程序目录与快捷方式，**保留全部数据**；
卸载界面文案明确说明保留路径与手动清理方式。

**L1（新增菜单项「清理可重建缓存」，低风险）**：
- 清理：`runtime\node_modules`、`runtime\reports\` 中**除最新 N 份外**的历史报告、
  `%LOCALAPPDATA%\<id>\dsh-backup\` 中**除最新一份外**的 `migration-*` 与 `cleanup-*`；
- **保留**：`.pnpm-store`（暖重建）、`dsh-home\`、`proxy.json`、`dsh.json`、**最新备份**；
- 前置：先停服务（`stop_child` + 等待退出）；清理期间**加互斥**（防与 `restart_server` 竞争）；
- 失败语义：被占用 → 列出剩余项 + 支持重试；**不假成功**；清理后首次启动**需联网**（弹窗预先告知）。

**L2（卸载器内，交由 NSIS）**：`EBWebView` 清理放在**卸载时**（应用已退出，无 WebView2 占用），
由 NSIS 钩子处理；**需先实测确认卸载时无残留占用**（未验证项）。

**不做**：运行时删 `EBWebView`；删 `reports` 全部；删 `.pnpm-store`；递归删 `%APPDATA%\<id>` 整棵树。

### 验收标准

1. 清理后 `dsh-home\` **逐字节不变**（会话可正常打开）；
2. 最新一份备份仍在；`reports` 至少保留最新一份；
3. 被占用场景返回可操作错误；
4. 离线场景有明确提示（不是"退出码 0x2"这种无解释失败）；
5. 不做任何全盘搜索（代码审查 + 负向测试）。

---

## A-4 启动页恢复面（修订版，改为最省方案）

### 修订要点（审计发现两处事实错误，v1 方案的核心论证不成立）

| v1 的说法 | 实际 |
|---|---|
| 「复用现有 `/plugins/disable` 语义」 | 该端点**只接受预装插件**（`lib.rs:1608-1628`）→ 恰好拒绝要禁用的第三方插件 |
| 「恢复入口已存在（插件管理窗口可重新启用）」 | 用户插件行**只有卸载/更新按钮**（`plugin-console.js:740-742`），无启用开关；`/plugins/enable` 对非预装返回 400 |
| 「移除非预装 bundles」 | **会删掉 `WEB_PROFILE_TEMPLATE`（base bundle）→ dsh 永远起不来** |
| 未提原子性 | `write_web_profile_bundles` 直接覆盖写 + 解析失败静默丢 `dependencies` |
| 未提持久性 | `dsh plugin` 的 `reconcilePlugins` 会把坏插件**重新加回**（用户下次装插件即复发） |

### 最终方案（采纳审计建议的"更省做法"）

**v2 不再新增 Rust 命令改 bundles**，改为：

1. **启动页失败态新增一个按钮**：「打开插件管理…」→ `invoke('open_plugins')`
   （命令**已存在** `lib.rs:3116-3120`，一行调用，**零新 Rust 代码**）。
   理由：插件管理窗口**不依赖 dsh 运行**（走环回桥），是"dsh 起不来时"的既有正确入口。
2. **把"用户插件停用/启用"补进插件管理窗口**（这是**真正**缺的能力）：
   - 用户插件行增加启用/禁用开关（对齐预装行已有的 `data-toggle` 交互）；
   - 需要**新端点**支持非预装插件的 bundles 增删（`/plugins/enable|disable` 目前只收预装）；
   - **必须**：显式保留 `WEB_PROFILE_TEMPLATE` + 持久禁用列表（`dsh.json.disabledPlugins`，
     启动前强制剔除，防 `reconcilePlugins` 加回）+ 原子写（临时文件 + rename + `.bak`）。
3. **启动页按钮文案**：「打开插件管理（禁用出问题的插件后重试）」——明确它是**引导**而非
   自动修复，避免"点了没用"的期待落差。

**分期**：1 可以**立即做**（一行 + 文案）；2 需要新端点与持久化设计，**建议单独立项**。

### 验收标准

1. dsh 起不来时，启动页按钮能打开插件管理窗口（实机验证）；
2. 插件管理窗口在 dsh 未运行时可用（**已具备**，回归验证即可）；
3. 分期 2 落地后：禁用第三方插件 → 启动成功 → **再装其它插件后仍保持禁用**（防复发）；
4. `WEB_PROFILE_TEMPLATE` 永不被删（单测断言）。

---

## 新增门禁（审计发现，独立立项）

### G-1 两份 manager 副本相等性断言（成本：1 行）

`test-shell-chrome.mjs:225-231` 现在只做**子串**断言 → 漏 `npm run sync:resources` 时**测试全绿**，
打包内 manager 仍是旧版，新命令落到 `default: unknown manager command`，UI 永久停在"正在检查…"。
**加一行相等断言**，把这类事故变成 CI 红灯。

### G-2 Windows 专属验证的 CI 覆盖缺口

审计发现：`cargo test` **只在 ubuntu job 跑**（`build.yml:47`），**所有 `verify-*.ps1`
一个都没进 CI**（grep 全部 workflow 零命中）→ A-2 的实机验证、junction 负向用例、
`verify-legacy-hook.nsi` 的 NSIS 能力确认**不会有任何门禁覆盖**。
建议：至少在 windows job 里跑 `cargo test --lib`（Rust 单测含平台相关逻辑）。

---

## 建议的执行顺序（按性价比）

| 顺序 | 事项 | 成本 | 价值 |
|---|---|---|---|
| 1 | **G-1 副本相等断言** | 1 行 | 消灭一类已发生过的静默事故 |
| 2 | **A-4 分期 1（打开插件管理按钮）** | 极低 | dsh 起不来时给出正确入口 |
| 3 | **A-2 NSIS 分支缺陷修复** | 低 | 修一个**已验证**的现存缺陷（同 2026-09-09 事故） |
| 4 | **A-3 L0 卸载文案 + L1 缓存清理** | 低-中 | 兑现"保留数据"决策 + 回收磁盘 |
| 5 | **A-2 三处判定收紧 + 规范化** | 中 | 防误删 + 立地基 |
| 6 | **A-1 一期（无 latest.json、不打开 URL）** | 中（1 新依赖） | 补最大缺口 |
| 7 | **G-2 Windows 单测进 CI** | 低 | 门禁覆盖 |
| 8 | A-4 分期 2 / A-1 二期 / A-3 L2 | 高 | 需单独决策 |

---

## 附：v1 中被证伪的假设（供后人查阅）

1. Rust 有 HTTP/TLS 能力 —— **错**（仅裸 TCP）；
2. 存在 `open_url` 能力 —— **错**；
3. `/plugins/disable` 可禁第三方插件 —— **错**（只收预装）；
4. 插件管理窗口能重新启用被禁的第三方插件 —— **错**（用户插件行无开关）；
5. `EBWebView` 停服务即可删 —— **错**（活 UDF，实测有进程占用）；
6. `setup()` 可在 WebView2 前清理 —— **错**（窗口先建）；
7. `ensureDsh` 是自愈入口 —— **函数名错**（真名 `dshInstalled`；结论对）；
8. 备份在 `%LOCALAPPDATA%\dsh-backup` —— **错**（在 `<id>\dsh-backup`，另有 `%APPDATA%` fallback）。
