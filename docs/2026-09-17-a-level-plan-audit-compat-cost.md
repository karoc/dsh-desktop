# A 级方案审计 · 角度三：兼容/回归与成本

> 对应 `docs/2026-09-17-a-level-plans.md`（299 行版）§审计记录「审计角度三」
> 审计基线：工作区当前状态（壳 0.8.0，`scripts/server-manager.mjs` 含未提交的 48 行 fatal-forensics 改动）
> 方法：全部结论均以 `文件:行号` 取证；不确定项显式标「未验证」

---

## 1. 契约漂移风险（A-1 / A-4 新增菜单项、命令、桥端点）

### `scripts/test-shell-chrome.mjs` 的实际强制力

该测试**不解析 Rust AST**，全部是 `readFileSync` + `String.includes`（`test-shell-chrome.mjs:21-24`）。强制项共 5 条：

| 断言 | 位置 | 语义 |
|---|---|---|
| 菜单必须含固定 10 个 id | `test-shell-chrome.mjs:41-43` | 硬编码数组 `['proxy-settings','plugins','check-update','dev-mode','refresh','restart','open-data','legacy-cleanup','about','quit']` |
| 每个可点菜单项必须在 ACTIONS 有条目 | `:45-54` | 白名单 `IN_SHELL_ACTIONS = new Set(['about','legacy-cleanup'])`（`:48`）之外一律要求 |
| 每个 ACTIONS 条目形状合法 | `:57-61` | `ipc` 必须匹配 `/^[a-z_]+$/`；`bridge` 必须以 `/` 开头；`method` 若存在必须是 `'GET'` |
| 跨文件三方一致 | `:64-73` | `libRs.includes("\"" + bridge + "\"")` 且 `libRs.includes(ipc)` —— **纯子串匹配** |
| 弹窗函数名不得改名 | `:122-126` | 断言源码含 `openCheckUpdateDialog` / `openAboutDialog` |

### 新增项必须同步改的文件（A-1 一期为例）

1. `src-tauri/resources/ui/shell-chrome.js:41-64`（SHELL_MENUS）+ `:71-93`（ACTIONS）
2. `src-tauri/src/lib.rs` 的 `handle_bridge_conn` match 臂（现有臂集中在 `:1441-1818`，兜底 `_ => ("404 Not Found", ...)` 在 `:1819`）
3. `src-tauri/src/lib.rs` 的 `invoke_handler` 注册表（`:3628-3650`）
4. `scripts/test-shell-chrome.mjs:41` —— **仅当新增菜单 id 时**；若只扩展 `check-update` 弹窗则无需改
5. `scripts/test-shell-chrome.mjs:48` 的 `IN_SHELL_ACTIONS` —— 若新动作做成「壳内就地、不经 IPC/桥」（如 A-1 的壳更新检查），**必须加进这个集合**，否则 `:52` 直接失败
6. `scripts/server-manager.mjs` **和** `src-tauri/resources/manager/server-manager.mjs`（打包实际运行的是后者）

### 漏改会怎样失败

| 漏改 | 失败表现 |
|---|---|
| 只加菜单项、忘加 ACTIONS | `test-shell-chrome.mjs:52` 断言失败，PR 的 `test` job 红（`build.yml:52-61`） |
| 只加 ACTIONS、忘加 lib.rs 桥臂 | `:66-68` 失败（子串不存在）；运行时远程页点菜单 → 落到 `:1819` 404，chrome 的 `bridge()` 返回 `null`（`shell-chrome.js:129-135`）→ **点击无反应，无任何提示** |
| 只加 ACTIONS、忘注册 invoke_handler | `:70-72` 失败；本地启动页 `invoke` 抛错被 `.catch` 吞掉（`shell-chrome.js:116-119`）→ 同样静默无反应 |
| 改名 `openCheckUpdateDialog` | `:124` 失败（A-1「两个分区」改造最容易顺手改名） |
| 只改 `scripts/server-manager.mjs`、忘 `npm run sync:resources` | **测试全绿**（`:225-231` 只断言两份文件各自包含若干字符串，不做相等性校验）→ 打包内 manager 仍是旧版 → 新命令落到 `server-manager.mjs:1375` `default: log('unknown manager command')` → 壳侧发完即返回成功 → UI 永久停在「正在检查…」 |

### 方案漏掉的同步点

- **方案 §成本只列了 `test-shell-chrome.mjs`(契约更新)**（`a-level-plans.md:74`），没有列 `:41` 的硬编码 id 数组与 `:48` 的 `IN_SHELL_ACTIONS`——这两处是「新菜单项」和「壳内就地动作」的必改点，且都是**加菜单就必须动**的位置。
- **A-1 的异步语义缺一个状态端点**：`handle_bridge_conn` 是「一问一答、同步写响应」（`:1821-1826` 直接拼 HTTP 响应），而方案把实现改成「Rust 转发到 manager 新命令 `check-shell-update`（stdin JSON 行）」（`a-level-plans.md:37-39`）。manager 的回复是异步协议行，桥无法同步等到结果 → 必须像现有 dsh 更新那样配一对「触发端点 + 轮询状态端点」（现成范式：`/check-update` `:1533-1538` + `/update-status` `:1520-1531`）。方案没有定义第二个端点，也没说清是扩 `/shell/state` 还是新增。**未验证**：是否打算让 manager 把结果写进一个壳侧镜像变量再由新端点读。
- **A-4 的「读 bundles」若做成壳内直读、不新增 ACTIONS 条目**，同样受 `:48` 白名单约束（虽然 A-4 走 IPC 命令，`invoke_handler` 是硬要求；如果同时想在远程页可用才需要桥臂）。

### 契约测试的覆盖盲区（两个方案都会踩）

`test-shell-chrome.mjs:64-73` **只遍历 `ACTIONS` 条目**。chrome 内部还存在**直接调用 `bridge(path)` 的地方**（`shell-chrome.js:122-135` 的 `bridge()` 是局部函数，`:130` 有对 `/shell/open-plugins` 的独立断言）。任何「不走 ACTIONS、直接 `bridge('/xxx')`」的新端点**不受契约测试保护**——A-1 的轮询端点如果这么写，就绕过了三方一致性门禁。

---

## 2. A-1 与现有「检查更新」的冲突

### 现有链路（完整，6 个消费点）

```
菜单 check-update → shell-chrome.js:1124-1126 openCheckUpdateDialog()
  弹窗按需 call('check-update')（:1070）→ ACTIONS(:74) → 桥 /check-update(lib.rs:1533) → manager 'check-update'
  manager checkDshUpdate()（server-manager.mjs:427-450）→ emit update-status(:407-420)
  → lib.rs:2089-2137 写 UpdateStatus(:86-97) + 翻托盘文案(:2106-2118) + 一次性 toast(:2124-2136)
  → 四个读出口：get_update_status(:2943-2962)、get_shell_state(:3056-3076)、桥 /update-status(:1520-1531)、plugins_panel_state(:3130-3160)
  → chrome 轮询 /update-status(:1040-1048) 渲染
```

### 结论：**改造会破坏现有的托盘语义，`update-status` 事件链路必须改**

**回归点 1（高）——托盘文案与点击动作会被污染。**
`lib.rs:2106-2118` 在 `available` 为真时把托盘项翻成 `有更新 {latest}（当前 {current}）→ 点击更新`；`:3440-3451` 的点击处理是：

```rust
let available = ...update.update_available;
let cmd = if available { "update-dsh" } else { "check-update" };
```

即 **`update_available=true` ⇒ 点击直接装 dsh**。若 A-1 把「壳有更新」也塞进同一个 `update_available`，用户看到「有更新 0.9.0（壳版本）」点下去会**去更新 dsh**——静默装错东西。方案 §UI 只说了「菜单项翻转」（`a-level-plans.md:41-42`），没提托盘（`lib.rs:3388/3401`）也要区分。

**回归点 2（高）——「预发布通道」提示会被 UI 重构打断。**
现分支 `shell-chrome.js:1013-1020`：`nextAvailable && next` → 显示「预发布 vX（{nextTag} 通道，非正式版）」并把 `btnUpdate.dataset.version = info.next`；点击时 `:1064` 把 version 塞进 payload → 桥 `/update-dsh`(`lib.rs:1540-1549`) → manager `updateDshAndRestart(version)`(`:1302-1329`) → `installDshUpdate({version})`。语义是「**想升才升**」，`next` 的取值规则在 `:316-341`（所有 dist-tag 中高于 latest 且高于当前的最高者，`nextTag` 记录来源 tag）。
A-1 要把这个弹窗改成「应用（壳）/ dsh 服务」两个分区（`a-level-plans.md:41`），而这段逻辑与 `updateAvailable`/`nextAvailable` 是 if/else 链（`:1005-1029`）——重构时极易把 `nextAvailable` 分支降级或丢掉 `dataset.version`。**方案未把「预发布分支不得回归」写进验收标准**（`:63-69` 的验收 5 条只提到「dsh 更新链路零回归」，粒度太粗）。

**回归点 3（中，既有缺陷，A-1 是修它的时机）——启动页上预发布版本号被丢弃。**
`shell-chrome.js:1064`：`const payload = btnUpdate.dataset.version && !hasTauri ? {...} : undefined;`
`hasTauri` 仅在 `location.protocol === 'tauri:'` 时为真（`:109-110`）。chrome 同时注入启动页与远程页，所以在**启动页**点「立即更新」时 version 不传 → manager 装 `latest` 而非用户选的 `next`。与 A-1 无关，但改造同一个函数时应一并修。

**结论（`update-status` 要不要改）：要。** 且正确做法是**不要复用** `update-status`：
- `update-status` 的载荷被 6 处消费，语义是「dsh 的更新状态」（`server-manager.mjs:406` 注释即如此）；
- 复用则必须给每个消费点加「这是壳还是 dsh」的判据，且托盘点击动作（`:3449`）无法用一个布尔区分两种安装目标；
- 建议新增独立事件（如 `shell-update-status`）+ 独立镜像结构 + 独立桥端点，`renderUpdateItem`（`shell-chrome.js:649-664`）改为「两者任一有更新则翻转徽标」，但**托盘只在 dsh 有更新时翻转并保持 `update-dsh` 语义**，壳更新只出现在菜单弹窗里。

**dev 构建的判定方式未定义。** 方案要求「dev 构建不检查壳更新」（`a-level-plans.md:59`），但 `tauri.dev.conf.json` 只覆盖 `productName`/`identifier`/`mainBinaryName` 三个字段，两版**编译同一份 lib.rs、同一个 `CARGO_PKG_VERSION`**，没有编译期开关。运行时唯一判据是 `app.config().identifier`（现成范式见 `lib.rs:267-268` 的 `toast_clsid`）。方案没写实现方式。

---

## 3. A-1 一期新增 `latest.json` 与 CI 发布链路

### `release-body.mjs` 的现有职责与方案的错配

`release-body.mjs` 是**纯 stdout 生成器**：唯一输出是 `process.stdout.write(body)`（`release-body.mjs:91`），入参只有版本号（`:22-26`，调用点 `build.yml:179` 传的是 `${GITHUB_REF_NAME#v}`）。它**不接触任何构建产物**，也不知道安装包文件名。

方案写「由 `scripts/release-body.mjs` 顺带生成并作为 release asset 上传」（`a-level-plans.md:30`）——这需要该脚本新增「写第二个文件」的能力或新 CLI 模式，而 `build.yml:179` 的重定向 `> "${RUNNER_TEMP}/release-body.md"` 只能承接一份输出。**方案漏了这个改造**。

### 与「移 tag 修复」逻辑的冲突：**会冲突，且是具体的漏更新**

release job 有三个分支，每个都**显式枚举资产**：

| 分支 | 位置 | 资产处理 |
|---|---|---|
| 全新创建 | `build.yml:180-182` | `gh release create "$TAG" "${FILES[@]}"` |
| 孤儿删除后重试 | `:193-199` | 同样 `"${FILES[@]}"` |
| 已挂载 → 原地刷新 | `:201-205` | `gh release upload "$TAG" "${FILES[@]}" --clobber` + `gh release edit --notes-file` |

`FILES` 定义在 `:174`：`(dist-win/**/*.exe dist-linux/**/*.AppImage dist-linux/**/*.deb)`——**只扫下载下来的构建产物目录**。`latest.json` 若由 `release-body.mjs` 写到 `${RUNNER_TEMP}`，它**不在 `FILES` 里**：

- 全新创建/孤儿重试分支：除非显式追加，否则 `latest.json` 根本不会上传；
- **已挂载分支（移 tag 重发的正常路径）**：`--clobber` 只覆盖 `FILES` 里的名字 → 旧 `latest.json` 原样保留 → 客户端读到的还是**上一版**（甚至指向已被删除的 asset URL）。这正是方案说的「不改发布流程」不成立的地方。

**必须的修改**：把 `latest.json` 追加进 `FILES`（或建 `EXTRA` 数组）并在**三个** `gh release create/upload` 调用点一致使用；`:213` 的资产回显可用于断言。

### 其他两处具体风险

- **URL 必须与实际资产名一致**。实测 v0.8.0 的资产名是 `DSH.Smoothly.Desktop_0.8.0_x64-setup.exe`（productName 含空格 → 打包成点号）。`latest.json` 里 `assets.windows-x86_64` 若手写模板会错。可行做法是在 bash 里从 `${FILES[@]}` 取 basename 与 `https://github.com/${GITHUB_REPOSITORY}/releases/download/${GITHUB_REF_NAME}/<basename>` 拼出 URL 后传给脚本（`${RUNNER_TEMP}` 写文件），**不能**在 node 脚本里凭空拼。
- **`releases/latest` 的语义**。GitHub 的 `/releases/latest` **排除 prerelease 与 draft**。当前仓库只有正式 release（实测 v0.8.0 `prerelease=false`），所以一期可用；但一旦将来用 release-please 发预发布，壳侧会静默看不到。方案未提。
- `concurrency: cancel-in-progress: true`（`build.yml:14-16`）会在重推同一 tag 时取消正在跑的 run。若被取消的 run 已经 `create` 了 release 但只上传了部分资产，下一次 run 会走「已挂载」分支——**又是那条漏更新 `latest.json` 的路径**，风险叠加。
- 「清扫 draft/untagged」（`:218-223`）对 `latest.json` 无影响。

---

## 4. A-3 的数据清理与升级链路自愈

### 先纠正方案的一处引用错误

`a-level-plans.md:204` 写「服务正常重建 node_modules（已有 `ensureDsh` 路径）」——**`ensureDsh` 在全仓库不存在**（grep 零命中）。真正的门是 `dshInstalled()`（`server-manager.mjs:383-385`，要求 `node_modules/@deepseek-ai/dsh/package.json` 存在 **且** `lib/bin.js` 存在）+ `main()` 的自动安装（`:1621-1628`）。结论方向对，引用错了。

### 逐函数结论

| 函数 | 删 `node_modules` 后 | 删 `.pnpm-store` 后 | 判定 |
|---|---|---|---|
| `dshInstalled`（`:383-385`） | `installedVersion` 读不到 → `false` → **不会被误判成"已安装"** → `main()` 自动装（`:1621`） | 无影响（仍 true） | ✅ 正确自愈 |
| `installDshUpdate` 早退门（`:525-527`） | `current===null`，不会命中早退 | 同左 | ✅ |
| `ensurePnpm`（`:1414-1419`） | `pnpmEntry` 不存在 → 走 npm 装 `pnpm@11.24.0`（`:1436`） | 无影响（store 与 pnpm 包无关） | ✅ 但**需要网络** |
| `ensureStorePathsMatch`（`:465-467`） | `node_modules/.modules.yaml` 不存在 → **首行早退**，不误改 | 文件仍在 → 路径仍匹配 → 不重写 | ✅ 幂等安全 |
| `ensurePnpmWorkspace`（`:740-746`） | 目标文件在 `<runtime>/pnpm-workspace.yaml`（**不在 node_modules 内**）→ 保留 | 保留 | ✅（但见下方负向测试建议） |
| `isIsolatedPnpmLayout`（`:394-397`） | `.pnpm` 不存在 → false，不误触发重建 | `.pnpm` 在 node_modules 内，若同时删了 node_modules 则不触发 | ✅ |

**不会被误判成「已安装」→ 不会因此黑屏。** 但存在两条**真实的新失败路径**：

**回归点 A（高）——离线清理 = 确定性启动失败，且 UI 给出误导文案。**
`installDshUpdate` 第一件事是 `resolveRemoteVersions()`（`:510`，内部 `npm view ... dist-tags`，`:317`），离线时抛 `无法查询最新版本`（`:512`）→ 被 `main()` 的 catch 吞掉（`:1625-1627` 只 log）→ 继续走到 `launchDsh`，`dsh not installed at ...` 抛错（`:1480`）→ `supervise` 返回 1（`:1284-1287`）→ `process.exit(2)`（`:1687`）。
壳侧表现：`server-down` → 启动页显示「dsh 服务异常退出（退出码 0x2）」（`app.js:174-185`），**完全没有「node_modules 被你自己清掉了」的线索**。方案 §失败语义只列了「文件被占用/服务未停/守卫拒绝」三种（`a-level-plans.md:199-204`），漏了「清理后离线无法重建」。

**回归点 B（中）——用户手动更新过的预装插件会被静默回滚，且 UI 状态失真。**
清理删掉 `node_modules` 后，`dsh.json.updates`（记录用户把某个预装插件升到了哪个版本）仍在，但 `ensurePreinstalled` 的判定是：

```js
// server-manager.mjs:893-901
if (userUpdated[pkgName] !== undefined) {
  const installed = installedVersionOf(dest)      // 清理后 = null
  if (installed === userUpdated[pkgName]) { ... continue }
  // Stale record (runtime missing or version mismatch): fall through and
  // restore the bundled copy below.
}
```

`null !== "1.2.3"` → **落到「恢复随包版本」**。结果：插件被降级回壳内置版本，而 `dsh.json.updates` 没清 → `checkPreinstalledUpdates` 仍报 `userUpdated: true`（`:954`）→ 插件管理窗口继续显示「已手动更新」+「恢复默认」按钮（`plugin-console.js:702-708`），但实际装的是随包版本。**假状态**。

**回归点 C（中）——启动页文案无法区分「清理后正在重装」与「真的挂了」。**
清理后首次启动会走完整 npm/pnpm 安装（`:587`，可能数分钟），期间 `install-status` 心跳（`:533-537`）会让启动页显示「正在安装 dsh… 已进行 N 秒」（`app.js:225-228`）。这本身是好的，但如果安装失败（离线），落到的是「安装失败：无法查询最新版本」（`:250`）——**文案没提这是用户主动清理的结果**。建议清理命令返回时把「已清理，下次启动将重新安装（需要网络）」写进确认结果，并在启动页失败态给出「重新安装」动作。

### `%LOCALAPPDATA%\<id>\dsh-backup\` 被删对 `migrate_legacy_data_dir` 的影响

**结论：对迁移逻辑零影响；但它删除的是 README 承诺的用户恢复路径，且清理清单自相矛盾。**

- 备份目录是 `app_local_data_dir()/<BACKUP_ROOT_DIR_NAME>` = `%LOCALAPPDATA%\<id>\dsh-backup`（`lib.rs:635-639`，`BACKUP_ROOT_DIR_NAME` 定义 `:684`）。方案已修正为带 `<id>`（`a-level-plans.md:170-171`），**核实无误**。
- `migrate_legacy_data_dir`（`:575-607`）的判据只有三件事：`old_dir.is_dir()`、`new_dir/MIGRATION_MARKER` 是否存在、`new_dir` 是否存在。**从不读备份目录**。备份写在 rename 之前（`:628-654`），是纯写侧、单向的「双保险」。
- 全仓库消费者 grep：`dsh-backup` 只出现在**写侧**（`lib.rs:640-653` 迁移备份、`:956` 清理前备份）与**文案侧**（`app.js:318/335`、`settings.js:201/220`、`settings.html:51`、`README.md:245-261`）。**没有任何代码从它恢复**。
- 因此：删 `migration-*` 不破坏迁移，但会让 README 的「从 `%LOCALAPPDATA%\dsh-backup\` 按时间戳目录恢复」步骤（`README.md:259-261`）失效。
- **清单不一致（必修）**：方案删 `dsh-backup\migration-*`（`:187`），却**没删** `dsh-backup\cleanup-*`（由 `lib.rs:956` 的旧版清理产生，通常比 migration 更新、更大）。而方案 §卸载默认行为又承诺「`%LOCALAPPDATA%\<id>`（含 `EBWebView` 与 `dsh-backup`）全部保留」（`:180`）——同一份文档里「保留」与「删除」并存，需要明确「菜单清理」与「卸载」是两套语义，并在弹窗文案里写清。

### 其他

- **`reports\*` 的删除与取证语义冲突（中）**。`manager_guard` 把 `reports/manager-crash-*` 保留最近 `EVIDENCE_KEEP = 5` 个（`manager_guard.rs:106/180-193`），`open_evidence_dir` 从 `state.guard.last_exit.evidence_dir` 取路径，**取不到时回退到 `runtime/reports` 并 `create_dir_all`**（`lib.rs:2646-2661`）。若用户清理 `reports\*` 后壳仍持有旧 `evidence_dir` 字符串，点击「打开证据目录」会打开一个空目录（`create_dir_all` 成功），**不报错但无内容**——可接受，但应在清理结果里显式提示「历史取证记录已删除」。
- 负向测试建议：把 `pnpm-workspace.yaml`、`.npmrc`、`runtime/package.json` 加进「清理后仍存在」断言。三者都在 `<runtime>` 根而非 `node_modules` 内（`ensureRuntimeDir:718-731`、`ensurePnpmWorkspace:740-746`），当前白名单不碰它们——但一旦有人把清理扩成「整个 runtime」，`allowBuilds`/`allow-scripts` 丢失会导致 koffi/node-pty 的 postinstall 被跳过（注释 `:724-730`、`:733-739` 已说明该故障类），dsh 运行时加载原生模块失败。

---

## 5. A-4 的 profile manifest 写入

### 现有读写语义

- 路径：`<runtime>/dsh-home/profiles/web/package.json`（Rust `profile_manifest_path:1148-1154`；manager `webProfileManifestPath:799-801`；两者一致）。
- 快照 `snapshotWebProfileBundles`（`:807-817`）：文件不存在/损坏/`bundles` 非数组 → 返回 **`null`**（与「空列表」刻意区分）。
- 恢复 `restoreProfileBundlesAfterUpdate`（`:829-860`）：`missing = before.filter(n => !after.includes(n))` → `doc.dsh.profile.bundles = [...after, ...missing]`（`:850`）。
- 调用时机：**只在 `installDshUpdate` 内部**——快照在函数开头（`:505`），恢复在安装成功后（`:632`）。

### 「从 bundles 移除第三方插件」的正确写法

必须满足三条：

1. **保留 manifest 其它字段**：复用 Rust 的 `write_web_profile_bundles`（`lib.rs:1232-1258`），它是 read-modify-write、只替换 `dsh.profile.bundles`，已满足；**不要**新建「整体重写 manifest」的路径（会丢 `dependencies`/`patchReload`/`name`，`:845-846` 的注释明确点了这三个字段）。
2. **第三方 = bundles − preinstalled − WEB_PROFILE_TEMPLATE**。模板常量在 `lib.rs:1200`（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`），`plugin-console.js:637` 已用同一算式。A-4 必须镜像它，**不能**只减 `preinstalled`（否则会把两个 host bundle 也停用 → dsh web 起不来）。
3. **`dsh.json` 缺失时必须拒绝执行**。`preinstalled_names`（`lib.rs:1261-1269`）在文件缺失/解析失败时返回 **空数组**（`.unwrap_or_default()`）。此时「第三方」会退化成「除模板外的全部 bundle」——**包括三个壳自带预装插件**。必须区分「读不到」与「确实没有预装」：读不到 → 中止并报错（fail-safe），否则这个「救援按钮」会把壳自带插件一起关掉。

### 会不会被升级后的 restore 逻辑又加回来？——**取决于顺序，且存在真实竞态**

- **安全顺序**：A-4 移除 → 之后才发生 `installDshUpdate`。因为快照在 `:505` 取，取到的是**已移除后**的列表，`missing` 里不含被移除项 → 不会被加回。✅
- **危险竞态（中，必修）**：若 A-4 的写入发生在一次 `installDshUpdate` **进行中**，`restoreProfileBundlesAfterUpdate` 会用**移除前**的快照把名字补回（`:843-850`）。`installDshUpdate` **没有并发互斥**——manager 的 `activeOp` 互斥只覆盖 `runPluginOp`（`:1548-1551`）与 `updatePreinstalled`（`:969-972`），不覆盖 `installDshUpdate`。
  **建议**：A-4 命令在写入前先检查壳侧镜像的安装/更新状态（壳已镜像 `install-status` 与 `op-status`，见 `lib.rs:2081-2087`、`:2138-2153`），有进行中的安装就拒绝并提示「dsh 正在安装/更新，请稍后重试」。

### 方案的可逆性论证有一处实质缺口（高）

`a-level-plans.md:243-246` 称「恢复入口**已存在**——插件管理窗口（`plugin-console.js:791` 已有 `/plugins/disable|enable` 开关）」。核实：

- `plugin-console.js:787-791` 的 enable/disable 开关**只属于预装插件行**（`:688-695` 的 `data-toggle`，遍历在 `:787`）；
- **用户自装插件行只有「卸载」和「更新」两个按钮**（`:740-742`：`data-remove` / `data-update`），事件绑定在 `:836` / `:851`；
- 更关键：窗口里「已安装插件」列表本身就是 **`bundles` 推导出来的**（`:637`：`bundles.filter(b => !preNames.includes(b) && !TEMPLATE.includes(b))`）。

**推论**：A-4 把第三方插件从 bundles 移除后，该插件**同时从插件管理窗口的列表中消失**（既不在 `preinstalled` 也不在 `bundles`），用户**在 UI 里找不到「重新启用」入口**，只能回到「安装」输入框重新敲包名。所以方案 §可逆性 3 的「恢复入口沿用现有插件管理窗口（`/plugins/enable`）」**不成立**。

且 `/plugins/enable` 本身也走不通：`lib.rs:1585-1590` 对非预装插件直接返回 `400 {"error":"not a preinstalled plugin"}`。方案 `a-level-plans.md:231` 写「后端能力已存在 `lib.rs:1608 POST /plugins/disable`」——**该端点只接受预装插件**（`:1611-1613` 同样的守卫），对第三方插件不可用。

**必须的修改（二选一）**：
- (a) A-4 把被移除的名字写进壳侧清单（如 `dsh.json.disabledThirdParty`），并让插件管理窗口渲染一个「已禁用」分组 + 启用按钮（写回 bundles）——真正可逆，但工作量比方案估的 80 行大；
- (b) 明确降级承诺：文案改为「插件包与依赖保留，但需在插件管理里按名称重新安装才能恢复」，并把这一句放进二次确认弹窗。

**次要不一致**：bundles 的移除用精确字符串比较（Rust `retain(|b| b != &name)`，`lib.rs:1616`；JS `includes`，`:790`）。npm 包名按惯例小写但未强制，大小写不一致时移除会静默失效（按钮点了没反应）。低概率，建议比较时统一 `to_ascii_lowercase`。

---

## 6. 成本与维护

### 一次性成本 vs 长期负债

| 方案 | 一次性成本 | **长期负债**（需要持续跟进的部分） |
|---|---|---|
| A-1 一期 | 菜单/ACTIONS/桥臂/IPC 四件套同步（改错即 CI 红，成本低）；`test-shell-chrome.mjs` 两处硬编码同步 | ① `latest.json` **格式契约**——一旦二期接 `tauri-plugin-updater`，其 schema 与本方案不同（需 `signature`/`pub_date`），要么改格式要么长期维护两套；② GitHub API 限流 60/h 的缓存策略（6h 缓存 = 用户最长 6h 才看到新版本）；③ `releases/latest` 排除 prerelease 的语义；④ 第二套 semver 比较（见下） |
| A-2 | `path_guard.rs` ~150 行 + 单测，纯逻辑，**一次性** | Windows 语义跟进：junction / symlink / mount point 的差异、`\\?\` 扩展前缀（仓库已有 `simplify_path:1852-1861` 处理，但 `Path::components()` 对 `\\?\C:\...` 的分段行为与普通路径不同）、`eq_ignore_ascii_case` 对非 ASCII 段的局限。方案把 `guard_removal(target, protected)` 定为通用 API，但**当前根本没有递归删除**（唯一的删除是 `remove_file` 与「空目录才 `remove_dir`」，`lib.rs:963/974/986-989`）→ 保护列表 + 反向包含判定是为尚不存在的调用方写的 |
| A-3 | ~120 行 + 菜单 + 弹窗 | **最高的长期负债**：这是删除操作，等价于新增一条永久不变量「这些路径永远安全可删」。需要长期维护：清理清单与 runtime 布局的同步（`<runtime>` 下任何新增目录都要重新判断该不该清）、dev/prod 身份、离线、占用、部分失败、以及「清理后重建失败」的用户支持路径。方案自己实测了 EBWebView = 217.5 MB，但 `node_modules`/`.pnpm-store` 的体积**未实测**（`:172-173` 自认），收益未量化 |
| A-4 | ~80 行 Rust + ~40 行 JS | 中等：新命令 + 新的 manifest 写入者（与 `write_web_profile_bundles` 共用则低）、与 `restoreProfileBundlesAfterUpdate` 的顺序不变量（需要长期靠注释/测试守住）。若按方案的可逆性承诺做「已禁用分组」，成本翻倍 |

### 更省的做法

**A-1（省掉整个 CI 改动）**：**不做 `latest.json`**。方案自己已把数据源定为 `https://api.github.com/repos/<owner>/<repo>/releases/latest`（`a-level-plans.md:39`）——同一个响应里就带 `tag_name` 和 `assets[].browser_download_url`。直接用它取版本 + 取 Windows 安装包 URL，**删掉 `build.yml`(+20) 与 `release-body.mjs`(+30) 的全部改动**，同时消灭「移 tag 后 `latest.json` 漏更新」这一整类回归（§3）。二期要 `signature` 时再引入 `latest.json`——那时格式由 tauri-plugin-updater 定，不会白做。
另：**复用 manager 已有的 `versionGt`（`server-manager.mjs:353-360`）**，不要新写一个比较器；它是预发布感知的（`preOrder:343-350`），且已处理「当前在预发布线上、latest 反而更旧」的降级保护（`:413-415` 注释）。
再另：壳版本号在 Rust 侧现成（`env!("CARGO_PKG_VERSION")`，`lib.rs:1795/3064`），比较应在 manager 侧一次完成，避免两端各持一个比较器。

**A-2（缩范围）**：当前**没有递归删除**。把方案拆成两半：
- 立刻做（小、纯收紧、无新 API）：把 `lib.rs:743` 与 `:820` 的两处字符串前缀换成 `Path` 组件级比较 + Windows 大小写不敏感，并在 `:986-989` 的实际删除路径前加 reparse 检查。这直接消灭方案 §风险 1/2/3 里的 1 和 3。
- 推迟到 A-3 落地时再做：`guard_removal` + 保护列表 + 「目标包含受保护路径」的反向判定（`:122-126`）。**因为只有 A-3 才会产生真正的递归删除**，在那之前这套 API 没有调用方，属于为想象中的需求付维护费。

**A-3（先做零风险的一半）**：方案已经把「卸载默认保留全部数据」定为核心决策（`:177`）。那就先只交付**不可逆性最低**的部分：卸载页文案 + 现有「打开数据目录」入口的指引（`open_data_dir` 已存在，`lib.rs:2634-2641`），**暂不实现运行时清理命令**。理由：① 收益未量化（`:172-173` 自认未实测）；② 它依赖 A-2 的守卫；③ 它会引入 §4 的回归点 A/B。等 A-2 落地 + 体积实测出来，再决定值不值得这条长期负债。

**A-4（最省的替代）**：**不加新 Rust 命令，改为在启动页失败态放一个「打开插件管理」按钮**（一行：`invoke('open_plugins')`，命令已存在 `lib.rs:3116-3120`）。依据是方案自己的取证：「该窗口设计上『dsh 崩溃/未启动时同样能管理插件』」（`:245`），且窗口数据走环回桥、不依赖 dsh 进程（`lib.rs:3097-3100` 注释）。这样：
- 删掉 ~80 行新 Rust 命令、新 manifest 写入者、以及与 `restoreProfileBundlesAfterUpdate` 的顺序不变量；
- 顺带修掉 §5 发现的可逆性缺口——在插件管理窗口给用户插件行加一个「停用」动作（复用现成的 `data-toggle` 渲染与 `/plugins/disable` 语义，只是放开预装守卫）比在启动页写一个一次性命令更省，且**对用户是可发现、可逆的**。
- 启动页只需多一行文案：「可打开插件管理禁用可疑插件后重试」。

### 新增测试负担

| 方案 | 方案自报 | 实际还需要 |
|---|---|---|
| A-1 | `test-shell-chrome.mjs` 契约更新 | ① manager 新命令的行为测试（现成范式 `test-control-plane.mjs:173-175` 的 `send({cmd:'check-update'})` + `waitFor`）；② **两份 manager 副本的一致性断言**（当前完全没有，见 §1 最后一格）；③ `latest.json` 解析/降级/缓存单测（若保留该文件） |
| A-2 | 7 项单测（`:143-145`） | 目标包含受保护路径、junction 负向用例在 Linux CI 上跑不了（`cargo test` 在 `build.yml:47` 的 **ubuntu** job）——Windows 专属行为只能靠 `scripts/verify-*.ps1` 那类本地脚本，而**那些脚本一个都没进 CI**（grep 全部 workflow 零命中）。方案验收 2/3（实机验证、junction 负向用例）**不会**被任何 CI 门禁覆盖 |
| A-3 | 4 项验收 | 上述全部为实机手测。建议补：清理清单的**白名单快照测试**（断言 `pnpm-workspace.yaml`/`.npmrc`/`package.json`/`dsh-home` 在清理后仍存在），以及「离线清理」的负向测试 |
| A-4 | 契约测试更新 | ① `restoreProfileBundlesAfterUpdate` 与 A-4 写入的顺序测试（并发场景）；② `dsh.json` 缺失时拒绝执行的负向测试；③ 模板 bundle 不被误删的断言 |

---

## 7. dev/prod 双身份

**共同事实**：四个方案的路径都源自 `app.path().app_data_dir()` / `app_local_data_dir()`，Tauri 2.11.5 的实现是 `dirs::data_dir().join(identifier)`（`~/.cargo/.../tauri-2.11.5/src/path/desktop.rs:247-258`），WebView2 数据目录同样解析为 `LocalData + identifier`（`src/manager/webview.rs:534-544`）。dev 身份是 `dsh.smoothly.desktop.dev`（`tauri.dev.conf.json`）。**因此所有 `<id>` 作用域内的路径天然隔离。**

| 方案 | dev 身份下是否正确 | 说明 |
|---|---|---|
| A-1 | ⚠️ **需要实现才能正确** | 方案要求 dev 不提示壳更新（`:59`），但两版编译同一份 lib.rs、同一 `CARGO_PKG_VERSION`，无编译期开关。必须在运行时比 `app.config().identifier == "dsh.smoothly.desktop"`（范式见 `lib.rs:267-268`）。**方案未给实现方式**；漏做则 dev 版会提示安装正式版安装包——而 dev 版存在的意义就是与正式版同机并存（`test-shell-chrome.mjs:84-99` 专门守这条） |
| A-2 | ✅ 无身份依赖 | 但注意：`legacy_install_dir`（`lib.rs:687-694`）与快捷方式候选（`:697-709`）**刻意与身份无关**（指向旧版 `%LOCALAPPDATA%\dsh Desktop`）；NSIS 钩子已按 `MAINBINARYNAME` 正向门禁（`legacy-takeover.nsh` 的 `!if "${MAINBINARYNAME}" == "dsh-desktop"`）。A-2 **不得**给守卫加身份检查，否则会破坏方案自己的验收 2（dev 版旧版清理仍要成功） |
| A-3 | ✅ 不会误删 dev 数据（作用域内） | `%APPDATA%\<id>`、`%LOCALAPPDATA%\<id>\EBWebView`、`%LOCALAPPDATA%\<id>\dsh-backup` 全部带 identifier（`lib.rs:635-639` 已核实）。方案 §负向保证「不删 dev 身份目录」（`:195`）对作用域内路径自动成立。**但**：若实现时为了「清干净」改成硬编码 `%APPDATA%\dsh.smoothly.desktop`（字面量而非 `app_data_dir()`），dev 版就会去删正式版数据——这是本条唯一真实的误删面，建议在验收里加「dev 版清理不得触碰 `%APPDATA%\dsh.smoothly.desktop`」的负向测试 |
| A-4 | ✅ | runtime 目录含 identifier；`dsh.json` 的 `preinstalled` 按 runtime 写入（`server-manager.mjs:911-912`），无跨身份影响 |

---

# 必修项清单

## P0（不修会静默做错事 / 破坏现有链路）

| # | 项 | 证据 | 修法 |
|---|---|---|---|
| P0-1 | **A-1 不得复用 `update-status`** | 托盘点击在 `available=true` 时发 `update-dsh`（`lib.rs:3440-3451`），文案翻转在 `:2106-2118`；`update-status` 有 6 个消费点 | 新增独立事件/镜像/端点；托盘语义保持「只反映 dsh 更新」 |
| P0-2 | **A-1 的 `latest.json` 必须进 `FILES` 并在三个发布分支一致使用** | `build.yml:174`（FILES 定义）、`:180/:197/:202`（三个调用点）、`:201-205`（`--clobber` 只覆盖 FILES 内名字） | 追加到 `FILES` 或建 `EXTRA` 数组，三处同改；用 `:213` 的资产回显做断言 |
| P0-3 | **A-4 的「恢复入口已存在」不成立** | `plugin-console.js:637`（列表由 bundles 推导）、`:740-742`（用户插件只有 remove/update）、`lib.rs:1585-1613`（enable/disable 仅限预装） | 二选一：(a) 记录到 `dsh.json` 并让控制台渲染「已禁用」分组；(b) 把可逆性承诺降级为「需按名称重新安装」，写进二次确认弹窗 |
| P0-4 | **A-4 必须在 `dsh.json` 读不到时拒绝执行** | `lib.rs:1261-1269` 缺失即返回空数组 → 「第三方」退化为「除模板外全部」，会关掉三个壳自带插件 | 区分「读不到」与「确实没有」；读不到 → 中止报错 |
| P0-5 | **A-4 必须避开 `installDshUpdate` 进行中的窗口** | 快照 `:505` 在函数开头、恢复 `:632` 在末尾（`server-manager.mjs`）；`installDshUpdate` 无互斥（对比 `runPluginOp:1548-1551`） | 写入前检查壳侧 `install-status`/`op-status` 镜像（`lib.rs:2081-2087`、`:2138-2153`），有进行中的安装就拒绝 |
| P0-6 | **`scripts/server-manager.mjs` 与 `resources/manager/` 副本缺一致性门禁** | `test-shell-chrome.mjs:225-231` 只做子串断言，不做相等；漏 `npm run sync:resources` 时测试全绿 | 在 `test-shell-chrome.mjs` 加一行 `assert.equal(readFileSync(a), readFileSync(b))` |

## P1（正确性/可用性缺口，应在同一批修）

| # | 项 | 证据 | 修法 |
|---|---|---|---|
| P1-1 | A-1 契约同步点漏 `test-shell-chrome.mjs:41`（菜单 id 硬编码）与 `:48`（`IN_SHELL_ACTIONS`） | `:41-43`、`:45-54` | 写进方案的改动清单；新增壳内就地动作必须进 `IN_SHELL_ACTIONS` |
| P1-2 | A-1 需要第二个（轮询）端点，方案未定义 | 桥是一问一答（`lib.rs:1821-1826`），manager 回复异步 | 明确定义，或把结果并入 `/shell/state`（`lib.rs:1787-1808`） |
| P1-3 | A-1 dev 构建判据未定义 | `tauri.dev.conf.json` 仅覆盖 3 个字段；无编译期开关 | 运行时比 `app.config().identifier`（范式 `lib.rs:267-268`） |
| P1-4 | 「预发布通道」分支不得回归，未进验收标准 | `shell-chrome.js:1013-1020`、`:1064`；manager `:316-341` | 验收补一条：dev 态下选 next 版本能装到该版本 |
| P1-5 | A-3 清理后**离线**必然启动失败，UI 无解释 | `server-manager.mjs:510-512`→`:1625-1627`→`:1480`→`:1284-1287`→`:1687`；启动页 `app.js:174-185` | 清理命令返回「需联网重装」的明确结果；启动页失败态加「重新安装」动作 |
| P1-6 | A-3 会静默回滚用户手动更新的预装插件并留下假状态 | `server-manager.mjs:893-901`（`null !== recorded` → 恢复随包版本）；`:954`（`userUpdated` 仍为 true）；`plugin-console.js:702-708` | 清理时同步清掉 `dsh.json.updates` 对应项，或保留插件包不删 |
| P1-7 | A-3 清单漏了 `cleanup-*`，且与 §卸载「全部保留」自相矛盾 | `lib.rs:956`（cleanup 备份）；`a-level-plans.md:180` vs `:187` | 统一清单，并在弹窗区分「菜单清理」与「卸载」两套语义 |
| P1-8 | A-3 删 `reports\*` 与取证语义冲突 | `lib.rs:2646-2661`（回退 `create_dir_all`，不报错）；`manager_guard.rs:106/180-193` | 清理结果显式提示「历史取证已删除」 |
| P1-9 | A-2 的验收 2/3（实机、junction 负向）无 CI 门禁 | `cargo test` 只在 ubuntu（`build.yml:47`）；`verify-*.ps1` 全部未进 workflow（grep 零命中） | 要么把 junction 用例做成 Windows job，要么在方案里标注「本地手测，CI 不覆盖」 |

## P2（清理/一致性，可延后）

| # | 项 | 证据 |
|---|---|---|
| P2-1 | A-1 的 `latest.json` 与二期 `tauri-plugin-updater` schema 不一致，会长期维护两套 | `a-level-plans.md:26-29` vs `:46-51` |
| P2-2 | `releases/latest` 排除 prerelease，方案未提 | 实测 v0.8.0 `prerelease=false`；将来发预发布即静默不可见 |
| P2-3 | bundles 移除用精确字符串比较，大小写不一致会静默失效 | `lib.rs:1616`（`retain`）、`plugin-console.js:790`（`includes`） |
| P2-4 | A-1 启动页上预发布版本号被丢弃（既有缺陷） | `shell-chrome.js:1064` 的 `!hasTauri` |
| P2-5 | `ensureDsh` 引用不存在 | `a-level-plans.md:204`；实际门是 `dshInstalled`（`:383-385`） |
| P2-6 | A-3 未实测 `node_modules`/`.pnpm-store` 体积，收益未量化 | `a-level-plans.md:172-173` 自认 |

---

# 更省的做法建议（按性价比排序）

1. **A-1 砍掉 `latest.json`**：直接用 `/releases/latest` 响应里的 `tag_name` + `assets[].browser_download_url`。删掉 `build.yml`(+20) 与 `release-body.mjs`(+30) 的全部改动，并消灭 P0-2 整类回归。二期再引入该文件。
2. **A-4 改为「打开插件管理」按钮**：`invoke('open_plugins')` 一行（命令已存在 `lib.rs:3116-3120`），删掉 ~80 行新 Rust 命令与顺序不变量；顺带把「用户插件停用/启用」做进插件管理窗口，同时修掉 P0-3。
3. **A-2 缩到「只修两处比较 + 一处删除前检查」**：`lib.rs:743`、`:820`、`:986-989`。`guard_removal` + 保护列表推迟到 A-3 落地（当前无递归删除，API 无调用方）。
4. **A-3 先只交付卸载文案**：不实现运行时清理命令，等 A-2 落地 + 体积实测后再决策。核心决策（默认保留全部数据）本身已经达成，不需要删除能力来兑现。
5. **加两条低成本门禁**：① 两份 manager 副本相等性断言（P0-6，一行）；② 清理白名单快照测试（断言 `pnpm-workspace.yaml`/`.npmrc`/`package.json`/`dsh-home` 清理后仍在）——这两条把上面最贵的几个风险变成 CI 可拦。

---

## 未验证项（明确列出）

- A-1 一期是否真的需要第二个轮询端点，取决于实现者是否选择让 manager 主动推送（当前方案文本未定）。
- `%LOCALAPPDATA%\<id>\EBWebView` 的实际路径：由 Tauri 解析为 `LocalData + identifier`（`tauri-2.11.5/src/manager/webview.rs:534-544`），**未在真实 Windows 机器上确认目录名就是 `EBWebView`**（方案称实测 217.5 MB）。
- `latest.json` 若保留，其在「移 tag」后是否被 `gh release list` 的 draft/untagged 清扫（`build.yml:218-223`）影响：**判定为无影响**，但未实机演练。
- A-3 清理 `node_modules` 后 pnpm 重装的实际耗时与是否需要 `pnpm-workspace.yaml` 重建（`ensurePnpmWorkspace` 早退，`server-manager.mjs:740-746`）：逻辑上不需要，**未实机验证**。
- Windows 上 junction 场景下 `Path::components()` 与 `symlink_metadata()` 的具体行为：**未验证**（无 Windows 机器可跑）。
