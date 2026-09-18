# A 级方案审计报告（多角度独立审计）

> 审计对象：`docs/2026-09-17-a-level-plans.md`
> 审计方式：**两个独立子代理**（安全与失败模式 / 兼容回归与成本）+ 父代理自查（UX 与完备性）
> 审计基线：方案 261 行版本（审计期间该文档被父代理并发修正 11 处）
> 日期：2026-09-17

## 审计结论总览

| 方案 | 安全与失败模式 | 兼容/回归/成本 | 综合 |
|---|---|---|---|
| A-1 壳自更新 | **需修改**（2 处事实错误 + 二期致命缺陷） | **高风险** | 一期可做但需重写；二期暂缓 |
| A-2 路径守卫 | **需修改**（3 类绕过 + 范围错位） | **低风险** | 需重写判据；且被高估为安全边界 |
| A-3 清理数据 | **有致命缺陷**（UDF 路径 + 清理时机） | **高风险** | 需大幅缩减范围 |
| A-4 禁用第三方插件 | **有致命缺陷**（2 处事实错误） | **高风险** | 需重写实现方式 |

**P0 合计 13 项**（安全 8 项 + 兼容 6 项，其中 1 项重叠）。

---

## 一、事实性错误（我方案里写错的事实，已实证）

这些不是"细节待定"，而是**写错了**，必须纠正：

| # | 我写的 | 实际 | 证据 |
|---|---|---|---|
| E1 | 「Rust 用现有 HTTP 能力拉 GitHub，不引入新依赖」 | **Windows 构建无 TLS 客户端**。`Cargo.lock` 中 reqwest 仅来自 tauri 对移动端 target 的依赖（`tauri-2.11.5/Cargo.toml:321`）；rustls/native-tls/schannel/webpki **零命中**。现有"HTTP"是裸 TCP（`test_proxy` 注释自陈"can't be TLS-verified without a TLS crate"） | 审计 + 我方复核 |
| E2 | 「复用现有 `open_url` 能力」 | **该能力不存在**（全仓库 grep 仅命中方案文档自身；`invoke_handler` 21 个命令里没有） | 审计 |
| E3 | 「复用现有 `/plugins/disable` 语义、不新增破坏性能力」 | 该端点**只接受预装插件**（`lib.rs:1608-1628`：非预装 → 400），恰好拒绝 A-4 要禁用的第三方插件 | 我方独立复核 ✓ |
| E4 | 「恢复入口已存在（插件管理窗口可重新启用）」 | **不成立**：用户插件行只有"卸载/更新"两个按钮（`plugin-console.js:740-742`），无启用开关；`/plugins/enable` 对非预装插件返回 400（`lib.rs:1585-1590`） | 我方独立复核 ✓ |
| E5 | 「清理 `%LOCALAPPDATA%\<id>\EBWebView`（停服务即可）」 | **EBWebView 是活的 WebView2 UDF**：实机验证最后写入 10:05:53、有 3 个 `msedgewebview2` 进程占用；且 tauri 强制设 UDF = `LocalData/<identifier>`（`tauri-2.11.5/src/manager/webview.rs:534-544`） | 我方实机验证 ✓ |
| E6 | 「下次启动时由壳在 WebView2 初始化前清理」 | **在 `setup()` 里做不到**：tauri 先建窗口（含 WebView2 environment）再调 setup（`tauri-2.11.5/src/app.rs:2522-2532`）；必须在 `Builder::run()` 之前（现成先例：`lib.rs:3179-3191`） | 审计 |
| E7 | 「`ensureDsh` 路径会自愈」 | **`ensureDsh` 不存在**（grep 零命中）；真门是 `dshInstalled()`（`server-manager.mjs:383-385`）。自愈结论**正确**，但函数名引用错误 | 审计 + 我方复核 ✓ |
| E8 | 「备份在 `%LOCALAPPDATA%\dsh-backup`」 | 实际在 `%LOCALAPPDATA%\<id>\dsh-backup`（父代理已自查修正）；**且另有 fallback 落 `%APPDATA%\<id>\dsh-backup`**（`lib.rs:638-639`）→ 两处口径 | 审计 |

---

## 二、P0 必修项（阻断发布）

### A-1（3 项）

**P0-A1-1｜无 TLS 客户端**：一期必须新增依赖（`ureq`+`rustls`）或给 `windows` crate 加
`Win32_Networking_WinHttp` feature；「零新依赖」的成本承诺不成立。

**P0-A1-2｜`open_url` 必须白名单**：新建时强制 host 白名单（`github.com/karoc/dsh-desktop/releases/`）
+ scheme 仅 https。若把上游 JSON 的 `url` 直接喂 `ShellExecute`，等于让上游内容决定打开什么
（`file:` / `ms-msdt:` / `search-ms:` 在 Windows 属本地代码执行/钓鱼面）。

**P0-A1-3｜二期私钥位置 + 三处空白**：私钥**不能**放在跑 `fetch-node`/`npm`/`pnpm` 的 job
（任意代码执行面）或 `contents: write` 的 release job；必须隔离到只做"下载→签名→上传"的 job。
且缺：**多公钥轮换**（单公钥 → 密钥丢失即死锁）、吊销预案、**签名验证失败的行为**
（失败语义表里完全没有这一行）。

### A-2（3 项）

**P0-A2-1｜`Path::components()` 不足以归一化**：三类绕过——
`\\?\C:\`（`Prefix(VerbatimDisk)` ≠ `Prefix(Disk)`）、`C:\a\..\Windows`（`ParentDir` 不折叠）、
8.3 短名（`DSHDES~1`）。**本仓库自己就见过 `\\?\`**（`simplify_path`，`lib.rs:1852`，注释说是
`current_exe()` 返回值）。需：`dunce::canonicalize`（显式依赖）+ `GetLongPathNameW` + 词法折叠 `..`。

**P0-A2-2｜保护列表缺关键项 + 来源不可信**：缺 `%LOCALAPPDATA%\<identifier>` 自身
（**A-3 正要删它下面的东西**——这是 A-2×A-3 交叉处的最大单点风险）、壳安装目录、`%TEMP%`、`--cwd`；
且 `user_home()` 读 `USERPROFILE` 环境变量（`lib.rs:891-896`）→ 保护根可被注入。

**P0-A2-3｜NSIS 范围写窄了，漏掉已验证的现存缺陷**：`legacy-takeover.nsh` 三个分支
（旧版在跑→拒绝卸载 / 执行卸载器 / 孤儿清理）**全部汇到共享尾标签 `legacy_pre_done`（53-57 行），
而删 lnk 就在尾标签里** → "旧版在跑→拒绝卸载"这条分支**照样删掉旧版快捷方式**
（症状同 2026-09-09「应用凭空消失」事故）。且 `Delete` 无 `IsShortcutTarget` 校验
（NSIS 模板 `utils.nsh:160-184` 自带该宏）。我方案只写"`RMDir` 前加检查"，**恰好绕过这个更严重的缺陷**。

### A-3（3 项）

**P0-A3-1｜UDF 语义不明**：`EBWebView` 经实机验证**确实存在且是活 UDF**；但方案在
"删子目录"与"删整个 `%LOCALAPPDATA%\<id>`"之间语义模糊，两者爆炸半径差一个数量级
（后者含 A-3 明说要保留的 `dsh-backup`）。

**P0-A3-2｜清理时机落点错误**（同 E6）：必须在 `Builder::run()` 之前，不是 `setup()`。

**P0-A3-3｜删 `reports` 会销毁事故取证证据**：看板上**未结**的"第 5 次事故取证判定"卡正等证据，
而 `reports/` 是 manager 崩溃证据与挂起 dump 的落点（`HANG_DUMP_KEEP = 3`）。
→ **`reports` 移出清理清单**。

### A-4（4 项）

**P0-A4-1｜必须显式保留 `WEB_PROFILE_TEMPLATE`**：`["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`
（`lib.rs:1200`）**不在** `preinstalled_names` 里 → 照我方案字面实现"移除所有非预装"会**删掉 base bundle
= dsh 永远起不来**，正是 A-4 要防的灾难。

**P0-A4-2｜写 manifest 无原子性 + 静默丢数据**：`write_web_profile_bundles`（`lib.rs:1232-1258`）
直接 `std::fs::write` 覆盖；更糟的是 `unwrap_or_else(|_| Object::default())` 在 manifest 已损坏时
**静默丢弃用户的 `dependencies` 与其它字段**。需：同目录临时文件 + `fs::rename` + 写前校验 + `.bak`。

**P0-A4-3｜禁用不持久（高价值发现）**：dsh CLI 的 `reconcilePlugins`（`apps/cli/src/plugin.ts:59-91`）
会把"声明了 `dsh.bundle` 的 dependency"**重新加回 bundles**；而壳的插件控制台装/删/更新正是走 `dsh plugin`。
→ 用户禁用坏插件 → 启动成功 → 之后装任意插件 → **坏插件被自动重新启用 → 又起不来**。
需壳侧持久禁用列表（`dsh.json` 的 `disabledPlugins`），启动前强制剔除。

**P0-A4-4｜`dsh.json` 缺失时必须拒绝执行**：`preinstalled_names` 缺失时返回**空数组**
（`lib.rs:1261-1269`）→ "第三方 = 非预装"退化成"除模板外全部" → 连壳自带预装插件一起关掉。

### 兼容侧 P0（6 项，与上重叠 1 项）

- **P0-C1｜A-1 不得复用 `update-status`**：`lib.rs:3440-3451` 在 `available` 时托盘点击直接发
  `update-dsh` → 若把"壳有更新"塞进同一布尔，用户看到"有更新 0.9.0"点下去会**去更新 dsh**。
  该状态有 **6 个消费点**（`get_update_status`/`get_shell_state`/桥/插件面板/托盘/chrome 轮询）。
- **P0-C2｜`latest.json` 必须进 `FILES`**：`build.yml:174` 定义 `FILES=(...)`，三个发布分支
  （create / 孤儿重试 / `--clobber`）只处理 `FILES` → 写进 `RUNNER_TEMP` 的 `latest.json`
  **在"移 tag 重发"路径下会留下上一版**。方案说"不改发布流程"不成立。
- **P0-C3｜A-4 可逆性承诺不成立**（同 E4）。
- **P0-C4｜A-4 避开 `installDshUpdate` 窗口**：`snapshotWebProfileBundles`（`:505`）→
  `restoreProfileBundlesAfterUpdate`（`:632`）会把刚移除的名字**补回来**（`missing = before.filter(...)`，`:843`），
  而 `installDshUpdate` **无互斥**（`activeOp` 只覆盖 `runPluginOp` 与 `updatePreinstalled`）。
- **P0-C5｜两份 manager 副本缺一致性门禁**：`test-shell-chrome.mjs:225-231` 只做子串断言不做相等 →
  漏 `npm run sync:resources` 时**测试全绿**，打包内 manager 仍是旧版，新命令落到
  `default: unknown manager command`，UI 永久停在"正在检查…"。**加一行相等断言**（成本极低）。
- **P0-C6｜契约同步点漏两处**：`test-shell-chrome.mjs:41`（菜单 id 硬编码数组）与 `:48`
  （`IN_SHELL_ACTIONS` 白名单）——方案 §成本只写"契约更新"，漏了这两处。

---

## 三、P1 应修项（择要）

- **A-1**：dev 判别器不存在（dev conf **无 `version`**，同一份代码 `--config` 构建，无编译期 cfg）
  → 必须运行期读 `identifier`；semver 语义比较（防 `0.10 < 0.9`）；`releases/latest` 404 需回退
  `/releases`；桥是一问一答（`lib.rs:1821-1826`）→ 需**第二个轮询端点**（范式 `/check-update` + `/update-status`）。
- **A-2**：`.lnk` 校验用归一化 `is_under` 替换 `starts_with`（`lib.rs:817-822`）+ 旧版在跑时不删；
  TOCTOU 未解（`guard_removal` 返回 Ok 后调用方才删）；威胁模型需诚实化（**当前删除是非递归的**
  `remove_file`/`remove_dir`，对 junction 天然安全 → A-2 价值是**防误删 + 为未来递归删除立地基**，
  不是安全边界，`installMode: currentUser` 无提权边界）；NSIS `GetFileAttributes` 能否暴露
  REPARSE_POINT **未验证**（需先跑 `verify-legacy-hook.nsi`）。
- **A-3**：清理后**需联网自愈**（`dshInstalled` false → `installDshUpdate` 冷装，超时 600s，
  离线则起不来）→ 失败语义必须写明；建议**默认保留 `.pnpm-store`**（暖 store 重建 ~6s vs 冷装数分钟）；
  `dsh-backup\migration-*` 含 `sessions/`/`storages/`/`.credentials.yaml`，**rename 失败时是唯一副本**
  → 至少保留最新一份；漏了 `cleanup-*`（`lib.rs:956` 产生，通常更大）；清理与重启之间缺互斥；
  缺"用户就是要彻底清理"的受支持路径（与官方 takeaways 矛盾）。
- **A-4**：`op.done === false` 时必须拒绝（否则 kill 正在跑的安装）；失败态文案需区分
  "与插件无关的失败"；写入前备份 manifest 供回滚。

---

## 四、审计给出的「更省的做法」（采纳）

1. **A-1 砍掉 `latest.json`**：数据源已定为 `/releases/latest`，同一响应就带 `tag_name` +
   `assets[].browser_download_url` → **删掉 `build.yml`+20 与 `release-body.mjs`+30 的全部改动**，
   消灭 P0-C2 整类回归。二期再引入。另**复用 manager 现成 `versionGt`**（`server-manager.mjs:353-360`，
   预发布感知 + 已处理降级保护）而不是新写比较器。
2. **A-4 改为「打开插件管理」按钮**：`invoke('open_plugins')` 一行（命令已存在 `lib.rs:3116-3120`），
   删掉 ~80 行新 Rust 命令与全部顺序不变量；顺带把"用户插件停用/启用"做进控制台，**同时修掉 P0-C3/E4**。
3. **A-2 缩到三处**：`lib.rs:743`、`:820`、`:986-989`；`guard_removal` 推迟到 A-3 落地。
4. **A-3 先只交付卸载文案**（核心决策"默认保留全部数据"已达成，不需要删除能力兑现），
   等 A-2 落地 + 体积实测再决策。
5. **两条低成本门禁**：① 两份 manager 副本相等断言（P0-C5，一行）；② 清理白名单快照测试。

---

## 五、未验证项（不得当结论使用）

1. `EBWebView` 子目录语义（**父代理已实机验证存在且是活 UDF**，但"是否应整体删"仍待定）；
2. `tauri-plugin-updater` 是否拒绝降级（本机无该 crate 源码）；
3. NSIS `GetFileAttributes` 是否暴露 `FILE_ATTRIBUTE_REPARSE_POINT` 可比较属性名；
4. `preinstalled_names` 读 `dsh.json` 的时序（`ensurePreinstalled` 每次启动重写 → 失败态下
   `dsh.json` 可能不存在，**加重 P0-A4-4**）；
5. junction 下 `components()`/`symlink_metadata()` 的实机行为（本机无 Windows 构建环境跑 Rust）；
6. 清理后 pnpm 重装耗时。

## 六、审计顺带发现（与本方案无关但应记录）

- `cargo test` **只在 ubuntu job 跑**（`build.yml:47`），**所有 `verify-*.ps1` 一个都没进 CI**
  （grep 全部 workflow 零命中）→ A-2 的实机验证与 junction 负向用例**不会有任何 CI 门禁覆盖**。
- `installMode: currentUser` 无提权边界 → 同用户攻击者本就能删自己的文件，安全模型需诚实表述。
