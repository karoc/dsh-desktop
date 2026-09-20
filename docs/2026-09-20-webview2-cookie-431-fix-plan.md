# 修复方案 v2：WebView2 请求头超限导致 dsh 客户端插件全部加载失败（431）

- 日期：2026-09-20（v2：经四角度审计后修订；审计归档见 `2026-09-20-webview2-cookie-431-fix-audit.md`）
- 状态：**方案待实施**（本文档只描述方案，未改动任何代码；实施后另写 Agent Note：`bug-fix / webview2-cookie-431-prune`）
- 现场：宿主正式版 v0.10.0，dsh `0.1.6-alpha.1`，WebView2 `151.0.4129.107`，Node `24.18.0`（壳内置同大版本）
- 关联看板卡：「根因（待修）：WebView2 请求头超 16KB → dsh 对 2.8KB 的插件批 bundle 返回 431 …」

---

## 0. TL;DR

| 项 | 内容 |
|---|---|
| **根因（已实测复现）** | dsh web 的鉴权 cookie 名绑定 authority（`dsh-auth-` + `base64url(sha256("127.0.0.1:<port>"))`），壳每次用 `--port 0` 起 dsh → 每次**完成的 token 导航**新增一条 cookie（226B/条，Max-Age 30 天，host-only、Path=/、HttpOnly）。dsh web 是 Node HTTP 服务，头块上限 = 默认 `maxHeaderSize` **16384B**，且**请求行计入该预算**；超限时 Node/llhttp 直接回 `HTTP/1.1 431 Request Header Fields Too Large`（无 Date/Content-Type）。客户端插件批 bundle 的 URL 长 **2830–2852 字符**（全页唯一 >1000 字符的 URL），于是它第一个被 431 打掉 → 批 bundle 未注册任何模块 → 61 个客户端插件全部 `import failed` → 页面停在「Failed to load plugins」。 |
| **实测数字** | 单条 cookie 226B；阈值：同一请求行 2811B 下 cookie 13500B→200、**14000B→431**；真实批 URL 2846B + 头块 16407B→200、**16607B→431**。反推现场 jar ≈ **57–68 条（13.0–15.5KB）**。 |
| **放大器** | 壳导航兜底只看桥 `POST /alive`（由客户端插件发出）；插件全挂 → 永不 ready → 每 3s 重载（现场实测 535 次 `nav-fallback: navigate`）。且**任何浏览器**打开同一 URL 都会 ping 同一桥端口 → 用户 Chrome 在 01:29:53Z ping 一次，就把壳兜底关掉、页面永久冻在错误页（01:29:50Z 最后一次 fallback）。 |
| **修复 P0（必须）** | 壳新增**单一 janitor 线程**（非主线程、非 stdout 读线程）做 cookie 清理：① 启动时清一次；② 每次 dsh 地址 authority 变化时再清一次。只删 `dsh-auth-*`（host ∈ 127.0.0.1/localhost/::1）。**删除后用第二次 `cookies()` 复核并打印剩余条数**（`DeleteCookie` 未匹配也返回成功，只数"删了几次"证明不了清理生效）。首次导航前用**有界等待**（≤3s）保证清理已完成，因此不存在"先加载后清理"的竞态。**存量装机下次启动即自愈。** |
| **修复 P1（推荐）** | manager 给 **dsh 子进程**的 `NODE_OPTIONS` 追加 `--max-http-header-size=65536`（现成机制：`scripts/server-manager.mjs:1336-1344` 已在注入 `--report-*`），把硬悬崖变软退化。定位：纵深防御 + 覆盖"单会话内多次重启"的残余增长，**不是**主方案。 |
| **修复 P2（加固，独立提交）** | ① 导航兜底**有界退避**（3s×3 → 6/12/24/30s 封顶 + 放弃日志），任何启动失败不再变无限重载；② `/alive` 就绪信号**绑定窗口 nonce**，杜绝外部浏览器误关兜底。 |
| **上游 P3** | issue 草稿见 `2026-09-20-dsh-upstream-issue-cookie-port-binding.md`（cookie 名绑端口 / 批 URL 随插件数线性增长 / bundle 加载失败被 `prefetchImmediateTier().catch(()=>{})` 吞掉）。 |
| **明确不做** | 不改 dsh 本体、不固定 dsh 端口、不清空 WebView2 profile、不在主线程/`setup`/`on_page_load`/同步 command 里读 cookie（Windows 死锁，见 §4.2）。 |

---

## 1. 根因与证据链（v2 修正了 v1 的两处证据错配）

| # | 证据 | 说明 / 出处 |
|---|---|---|
| 1 | 壳窗口实况：`Failed to load plugins` + `web boot: 61 entries did not activate … import failed (see console for the import error)` | 现场截图（排查目录本地留存，未入库）；页面文本由 DevTools DOM 复核 |
| 2 | **431 指纹 = Node/llhttp**：raw socket 溢出响应恰为 `HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n`（无 Date/Content-Type/Server）；直连 TCP（不经代理）可复现 | `python3 scripts/hdrprobe.py --port <port> --cookie <cookie>`（已入库，D 段） |
| 3 | **请求行计入头预算**：无 cookie 时 16335B 头块→404、16435B→431；真实 cookie + 2846B 批 URL：头块 16205B→200、16605B→431；**同一 ~15.2KB cookie 下短 URL 仍 404（通过）而批 URL 431**（复跑实测） | 同上（A/B/C 段；阈值随 URL 长度线性移动） |
| 4 | **现场 jar 区间 57–68 条**：01:23–01:29Z 兜底每 3s 导航到 `?token=`，session.log 每次都提交 `main page load: http://127.0.0.1:63736/`（无 token）⇒ 303 成立、token 请求未超限；同刻 2830B 批 URL 431 ⇒ jar 落在窄带内 | `dsh-desktop-session.log` + §1#2/#3 |
| 5 | 累积模型（修正 v1 的高估）：cookie 由**完成的 token 导航**产生，不是"启动次数"。prod manager.log 153 条 `dsh web:` 中 **96 条带 `?token=`**（96 个不同端口）；dev profile 实测 **41 条 cookie ↔ 39 个 token 端口（39/39 对应）** | manager.log 解析 + dev `EBWebView/Default/Network/Cookies`（未加锁时可读） |
| 6 | 单条 cookie：226B（name 52 + value 173）、host-only `127.0.0.1`、`Path=/`、`HttpOnly`、`SameSite=Strict`、`Max-Age=2592000`；`Set-Cookie` 只由带 `?token=` 的请求（303）触发 | live dsh 实测 + dev cookie DB |
| 7 | 全量请求枚举（Playwright，28 请求）：>1000 字符**只有**批 bundle（2852）；其余 ≤110 字符。批 bundle 响应头 `cache-control: public, max-age=31536000, immutable`（rev 每轮因桥端口重烘焙而变，所以每轮都是新 URL、不吃缓存） | `.tmp-investigate/audit/urls.cjs` |
| 8 | 时间线：最后一次成功 **9/19 00:25Z**；首次失败 **9/19 23:31Z**（当时 manager 只记 3 个预装包 = 0.9.x 旧壳）→ **与 v0.10.0 / 新预装插件无关** | manager.log / session.log |
| 9 | 放大器现场：最后一次 `nav-fallback` = 01:29:50Z，**3 秒后**（01:29:53Z）出现外部浏览器的 `client-ready (http)` → 壳兜底被外部 `/alive` 关闭，页面冻在错误页 | session.log；`lib.rs:1677`、`plugins/dsh-client-notifications/client.js:325` |

> **v1 的两处证据错配（已修正）**：① DevTools 截图里的 `status`/`state` 200 是**壳环回桥**请求（`shell-chrome.js:90/98/136` → `http://127.0.0.1:${BRIDGE_PORT}/shell/...`），不经过 dsh 的 16KB 限制，不能用来证明"只有长 URL 受害"；`favicon`/app JS 可能命中缓存（文档 `/` 无缓存头）。② "153 次启动 → 153 条 cookie"把"启动数"当成了"产 cookie 的 authority 数"（实际 96 个 token 端口）。**替代证据 = §1#4 + §1#3（协议级复现）**，结论不变、量化更准。

**结论**：431 是唯一阻断点；cookie 头是唯一随运行单调增长的分量，且已越过"16KB − 2.85KB 请求行 ≈ 13.4KB"的悬崖。

---

## 2. 设计目标与约束

1. **修好存量**：当前这台已损坏装机（jar ≈57–68 条）在下次启动后必须自愈。
2. **零鉴权副作用**：不得造成持续性 401；不得影响"重启 dsh 服务"、首启导航、token 跳转、页面刷新。
3. **绝不引入死锁/挂起**：Windows 上 `cookies()` 是**同步阻塞 + 嵌套消息泵**，官方明确"在同步 command / 事件处理器里调用会死锁"（wry#583）。
4. **最小侵入**：只删 dsh 自己签发的 `dsh-auth-*`；不碰其它 cookie、不碰用户数据、不动 dsh 本体。
5. **失败降级 + 可观测**：cookie API 出错/panic 只记日志、不阻断启动；**日志必须能证明清理结果**（剩余条数），而不是"删了几次"。
6. **可复现、可回归**：先在 dev 版确定性复现（种 90 条 cookie），再验修复；新增能在 CI 抓住该类问题的测试。
7. **可回滚**：P0/P1/P2 独立，回退后回到现状（不会更坏）。

---

## 3. 候选方案对比（含被否理由）

| 方案 | 机制 | 优点 | 代价/风险 | 结论 |
|---|---|---|---|---|
| **A. 专用 janitor 线程清理 `dsh-auth-*`** | 启动 + authority 变化时清理；复核剩余条数 | 直击根因；**存量自愈**；不阻塞主线程与读线程；只碰自家 cookie；API 官方支持（含 HttpOnly） | 一次 Rust 改动 + 一个新线程 | ✅ **选定（P0）** |
| B. 清空整个 WebView2 profile / cookie DB | 启动前删 `EBWebView/.../Cookies` | 实现最短 | 连 12MB 批 bundle 缓存一起丢；文件被 WebView2 独占锁，必须"创建 webview 之前"删，时序脆弱；未来会误伤其它 cookie | ❌ 过粗、时序脆 |
| C. 固定 dsh 端口 | authority 固定 → cookie 名复用 | 治本、无需清理 | 端口冲突（用户另开浏览器版 dsh）会让**启动直接失败**；需"固定失败→回退 0"的复杂逻辑 | ❌ 失败模式更差 |
| D. 只抬高头上限（P1） | 16KB→64KB | 一行、现成机制；也救存量 | 只延后（按实测速率 64KB 可撑数月，非永久；批 URL 还随插件数增长） | ⚠️ 仅作 **P1 纵深** |
| E. 改 dsh 本体 / 缩短批 URL / cookie 名不绑端口 | 上游修复 | 最治本 | 不属本仓库 | ❌ 转 **P3 issue** |
| F. 只改兜底线程 | 退避/不重载 | 消除无限重载 | 页面仍起不来 | ❌ 作 **P2 加固** |
| G. JS 删 cookie | `document.cookie` | 无 Rust | cookie 是 **HttpOnly**，JS 删不掉 | ❌ 不可行 |
| H. 主线程/setup/on_page_load 里清理 | 复用现有钩子 | 少一个线程 | **官方记载的 Windows 死锁**（`setup` 在事件循环前、`on_page_load` 在 COM 回调内）；启动会挂死 | ❌ 明令禁止（§4.2） |
| I. 每次 `server-url` 事件都清理 | 简单 | 逻辑最少 | 同一 authority 重复事件会删掉**正在用**的 cookie（report-url 重发路径），制造可避免的 401 窗口 | ❌ 改为"authority 变化才清" |

---

## 4. 选定方案（分阶段、可独立回滚）

### 4.1 P0：janitor 线程清理陈旧鉴权 cookie

**新增（`src-tauri/src/lib.rs`）**

1. 纯函数（可单测，进 `cargo test --lib`）：

```rust
/// dsh web 的鉴权 cookie 名绑 authority（dsh-auth-<base64url(sha256(host:port))>），
/// 壳用 --port 0 → 每次完成的 token 导航新增一条、30 天才过期 → Cookie 头单调增长，
/// 越过 Node 默认 16KB 头上限即 431（第一个受害者是 2.8KB 的插件批 bundle URL）。
/// 只认 dsh 自己签发、且落在本机回环 host 上的这一类。
fn is_stale_auth_cookie(name: &str, domain: &str) -> bool {
    name.starts_with("dsh-auth-")
        && matches!(
            domain.trim().trim_start_matches('.').to_ascii_lowercase().as_str(),
            "127.0.0.1" | "localhost" | "::1"
        )
}
```

2. 清理 + **复核**（`delete_cookie` 是入队即返回，未匹配也返回成功，所以必须回读）：

```rust
/// 返回 (清理前条数, 尝试删除条数, 清理后剩余条数)。
/// ⚠️ 只能在后台线程调用：Windows 上 cookies() 是同步阻塞 + 嵌套消息泵，
/// 官方明确"在同步 command / 事件处理器里调用会死锁"（wry#583）。
fn prune_stale_auth_cookies(app: &AppHandle) -> (usize, usize, usize) { /* cookies() → 过滤 → delete_cookie → 再 cookies() 复核 */ }
```

- 复核仍 >0 时**有界重试一次**，再记日志；整段用 `std::panic::catch_unwind` 包住（wry 对 profile 里**每一条** cookie 都会 `CookieBuilder::build()`，panic 会打死所在线程）。
- 日志（**无论 0/失败都写**，便于机读与复发自诊断）：
  `dsh-auth cookies: before=<B> pruned=<P> remaining=<R>`

3. **单一 janitor 线程**（`setup` 里 `std::thread::spawn`，经 mpsc 串行收活；**禁止每事件 spawn**：两个 worker 会乱序，迟到的 prune 可能删掉新 authority 刚签发的 cookie，而那次导航成功后兜底线程会 `continue`、不自愈）：

```rust
enum CookieJob { Startup, AuthorityChanged(String) }
```

- **Job::Startup**：进程启动立即执行一次（`setup` 末尾发送；此时 dsh 还没起来）。
- **Job::AuthorityChanged(origin)**：在 `server-url` 分支里判断 authority 是否变化（内存里的 `LAST_ANNOUNCED_ORIGIN`，每进程初始为 `None` → 首次必清），变化才发送。

4. **顺序保证**：`server-url` 分支在 `handle.emit("server-url", url)`（`lib.rs:2281`）**之前**完成"启动清理已完成"的**有界等待**（`AtomicBool` + 最长 3s，超时则记日志继续）。理由：launcher 页自己监听 `server-url` 并 `location.href=url`（`src/app.js:159-166`），另有 1s 轮询 `get_shell_state.liveUrl`（`src/app.js:303-325`，LIVE 在 2282 行写入）——**先清理、后 emit** 才能让"清理先于任何加载"成为硬保证。正常路径下启动清理早已完成（dsh 启动需 ≥2s，清理是 ms 级），等待几乎零成本。
5. **不做**（并在代码注释里写明理由）：不在 `setup` 主体、不在 `on_page_load`、不在任何同步 command（含 `get_shell_state`）、不在 `nav-fallback`/origin 守卫里调用（那些导航同 authority，且兜底本身会重试）。

**副作用边界（已核对）**
- 只删 `dsh-auth-*`；live dsh 的受信 `/` **不设任何其它 cookie**（`Set-Cookie` 仅出现在 `?token=` 的 303 分支），因此不会登出任何东西。
- 三窗口（main/settings/plugins）共享同一 WebView2 profile，但只有 main 持有 dsh cookie；settings/plugins 只 fetch 环回桥（无 credentials）→ 不受影响。
- 用户自己的浏览器用独立 cookie jar → 不受影响。
- 删掉当前 authority 的 cookie 只在"authority 变化"或"进程启动"时发生，且紧接着就是带 `?token=` 的导航（303 重签）；同一 token 可重复使用（实测连用 3 次成功、84 分钟后仍有效）。

### 4.2 P0 的硬约束（写进代码注释 + 契约测试）

1. `cookies()` **禁止**在：`setup`（事件循环未启动、主线程 inline 快路径 → `GetMessageA` 无超时嵌套泵 → 启动挂死）、`on_page_load`（COM 回调内同步调用，文档点名的死锁场景）、任何同步 `#[tauri::command]`/IPC handler。
2. `prune` 与 `navigate` 必须**同线程紧邻**（janitor 内部串行 + 读线程的"先清理后 emit"保证）。
3. 依赖前提：导航 URL 带 `?token=`（本壳固定如此；`w.reload()` 是唯一无 token 路径——所以绝不能在 reload 前清理）。

### 4.3 P1：抬高 dsh web 头上限（纵深防御）

`scripts/server-manager.mjs`（**真源**；改完 `node scripts/sync-resources.mjs` 同步 `src-tauri/resources/manager/`）：

```js
NODE_OPTIONS: [
  process.env.NODE_OPTIONS ?? '',
  '--max-http-header-size=65536',
  `--report-on-fatalerror --report-uncaught-exception --report-compact --report-dir=…`,
].filter(Boolean).join(' '),
```

- 实测：`NODE_OPTIONS=--max-http-header-size=65536` → `require('http').maxHeaderSize === 65536`（默认 16384）；`process.allowedNodeEnvironmentFlags.has('--max-http-header-size') === true`。
- **范围说明（v1 表述修正）**：只作用于 **dsh web 子进程**（与既有注释"Only the dsh web child gets NODE_OPTIONS; the manager itself stays clean"一致）；壳自身（Rust/manager）**不注入** `NODE_OPTIONS`——这与 `docs/2026-09-09-pending-cards-solutions.md` 的"壳不注入 NODE_OPTIONS"约定**不冲突**（该约定针对壳进程树；此处沿用 manager 既有注入点）。dsh 的子进程（MCP/stdio）会继承该无害 flag；PTC packaged 分支会自行覆盖 `NODE_OPTIONS`。
- 顺序语义：追加在用户值之后（Node 取最后一个同名 flag）⇒ 用户若显式设了更小的值会被我们覆盖；在 `manager.log` 打印最终 `NODE_OPTIONS` 便于取证与回滚。
- 只影响 Node `http` 解析上限（`fetch`/undici 不吃此 flag），服务仅监听 `--host 127.0.0.1` ⇒ 不构成安全退化。

### 4.4 P2：加固（独立提交、独立回滚）

1. **兜底退避**：导航兜底线程固定 3s → 前 3 次 3s，之后 6/12/24/30s 封顶，并写 `nav-fallback: giving up after N attempts`（不再无限刷）。
2. **就绪信号绑定窗口**：壳在主窗口页面注入一次性 nonce（`w.eval("window.__DSH_SHELL_NONCE__='<rand>'")`），`plugins/dsh-client-notifications/client.js` 在 `POST /alive` 回带 nonce，桥仅在 nonce 匹配时置 `CLIENT_READY`；nonce 缺失（旧 bundle）回退旧行为，避免版本错配导致永不 ready。

### 4.5 P3：上游 issue（草稿已存档）

`docs/2026-09-20-dsh-upstream-issue-cookie-port-binding.md`：① cookie 名绑 authority → 无界累积；② 批 bundle URL 随插件数线性增长（68 插件 ≈2.85KB，≈22B/插件），是头上限的第一个受害者（建议改 POST/短 hash 清单）；③ bundle 加载失败被 `prefetchImmediateTier().catch(()=>{})` 吞掉，只报 `import failed`，掩盖真因。

---

## 5. 实施步骤（文件级清单）

| 步骤 | 文件 | 内容 |
|---|---|---|
| 1 | `src-tauri/src/lib.rs` | `is_stale_auth_cookie` + `prune_stale_auth_cookies`（含复核/重试/catch_unwind）+ janitor 线程 + `LAST_ANNOUNCED_ORIGIN` + `server-url` 分支的"先清理后 emit"有界等待 + `#[cfg(test)] mod cookie_tests`（真值表：`dsh-auth-x`/127.0.0.1 ✓；`.LOCALHOST` ✓；`::1` ✓；`dsh-auth-x`/`evil.com` ✗；`session`/127.0.0.1 ✗；空 domain ✗） |
| 2 | `scripts/server-manager.mjs` + `src-tauri/resources/manager/server-manager.mjs` | P1 的 `NODE_OPTIONS` 追加 + 最终值落 `manager.log`（真源改完跑 `sync-resources.mjs`，`test-shell-chrome.mjs:234` 已锁真源/副本一致） |
| 3 | `scripts/test-control-plane.mjs` | 先扩 `DSH_TEST_ENV_PROBE`（现只写 http/https/nodeEnvProxy/noProxy）→ 断言子进程 `NODE_OPTIONS` 含 `--max-http-header-size=65536` 且 manager 自身未变 |
| 4 | `scripts/test-header-limit.mjs`（新增，纯 Node、秒级、进 `npm test`） | 契约测试：默认上限下"2830B 请求行 + 13.6KB cookie → 431"、`--max-http-header-size=65536` 子进程下同例 → 200（**CI 里唯一能抓这类 bug 的测试**） |
| 5 | `scripts/test-shell-chrome.mjs`（或新契约测试） | 源级契约：`prune_stale_auth_cookies` 只在后台 janitor 调用；`server-url` 分支里"清理/等待"出现在 `handle.emit` 之前；`setup`/`on_page_load` 内不得出现 `cookies(` |
| 6 | `.dsh/skills/windows-desktop-shell-debugging/SKILL.md` | §9 补：431 症状与指纹、jar 只能在应用关闭后读、DPAPI v10 种子法、`/alive` 外部误置陷阱、安装目录 `resources/manager` 同步（交叉引用 §9.10.5） |
| 7 | `docs/` | 本方案 + 审计归档 + 上游 issue 草稿 |
| 8 | 发布 | 走 PR（fix）→ release-please → CI 出包；**先在 dev 版完成 §6 S0–S7 再发正式版** |

---

## 6. 验证计划（v2：阈值/判据按实测数字重写）

**阈值基线（实测）**：cookie 226B/条；请求行计入头预算；批 URL 2846B 时头块 16407B→200、16607B→431 ⇒ **悬崖 ≈13.4KB ≈ 59–60 条**。**复现门禁：种子 ≥90 条（20.3KB），留 ≥30% 余量**（v1 的"跑 60 次"恰好压在悬崖上，且 dev 现成 jar 已有 41 条，已废弃）。

| 编号 | 内容 | 判据 |
|---|---|---|
| **S0** | 基线（**应用关闭后**读 SQLite）：壳自带 `resources\node\win32-x64\node.exe` + `node:sqlite` 打开 `EBWebView\Default\Network\Cookies` | 记录 `total / dsh_auth / other_names[]`（dev 预期 41/41/[]；prod 运行期 EACCES，需关闭后读） |
| **S1** | 阈值标定（秒级、只读）：`python3 scripts/hdrprobe.py --port <port> --token <token>` | A 段 16335→404/16435→431；B 段批 URL 16205→200/16605→431；**C 段同 cookie 下短 URL 通过、批 URL 431**；D 段 431 指纹 |
| **S2** | **确定性种子**：关闭 dev 壳 → 备份 Cookies → DPAPI（v10，用户级 `ProtectedData::Protect`）加密后直写 SQLite 到 **90 条** → 回读断言 | `dsh_auth == 90`；其它 cookie 逐项未变 |
| **S3** | **复现（控制组）**：起未修复的 dev 壳（或 P0 调用点注释掉） | 窗口出现 boot 错误页；`session.log` 每 ~3s 一条 `nav-fallback`；raw socket 带真实 cookie 打同一批 URL → **431**（机读，不靠 DevTools 目测）；记录 `client-ready` 有无（**注明它不可信**） |
| **S4** | 部署修复：构建 dev exe → `taskkill /T /F` 杀进程树 → 覆盖 `dsh-desktop-dev.exe` → **同步安装目录 `resources\manager\*`** → 两侧比 md5 | hash 一致（SKILL §9.10.1/2/5；否则 V3 会拿旧 manager "通过 P1"） |
| **S5** | **修复验证**：起 dev 壳 | `session.log` 出现 `dsh-auth cookies: before=90 pruned=90 remaining=0`（remaining 必须为 0）→ 90s 内 `client-ready` → 窗口内 `nav-fallback` ≤2 → `verify-dev-ui.ps1 -Action dump` **无** boot 错误文本、**有**真实 UI 控件 → 关壳回读 DB：`dsh_auth ≤2` 且其它 cookie 与 S0 基线逐项相同 |
| **S6** | **因果闭环（控制实验）**：在 **P1 关闭**的前提下注释掉 P0 → 重建 → 同 jar 同 URL 再现 431 → 恢复 P0 → 同 jar 同 URL 转 200 | "同一条 2.83KB URL：431 → 200"才算证明 P0 起效（P1 同版会掩盖 P0，必须一起关） |
| **S7** | 回归底线：`npm test`（含新增 §5#3/#4/#5）+ `cargo test --lib` + `cargo clippy -D warnings` | 全绿 |
| **S8** | 副作用：菜单「重启 dsh 服务」（新端口）→ 再验一次；插件管理窗口/托盘/菜单/通知 UIA 无回归；`devMode` 开关正常 | 出现第二条 `dsh-auth cookies: …` 且再次 `client-ready`；其余无变化 |
| **S9** | **存量自愈（prod）**：装新版（版本号需 bump，否则 NSIS 同版本跳过 → 用 exe+resources 覆盖法） | 首启 `before≈57–68 pruned=N remaining=0`、cookie ≤2、页面可用；"不影响用户 Chrome 已开页面"由用户确认 |
| **S10** | 归档：看板拆卡（P0/P1/P2/验证，带实测数字）+ 实施后 Agent Note（`bug-fix / webview2-cookie-431-prune`，写明两条硬约束：非主线程、authority 变化/启动才清） | 看板与 Note 三字段齐全 |

---

## 7. 回滚

- P0：删除 janitor 与调用点即回到现状（纯新增，无既有行为依赖）；P1：去掉一个 flag；P2：退避参数可调、nonce 有旧版回退。
- 三阶段互不依赖、可分别回滚；**回滚后最坏等于当前状态**。
- S6 同时充当**回滚演练**（记录耗时）。
- 已发布版本无法撤回 → 必须先在 dev 版跑完 S0–S7 再发正式版。

---

## 8. 风险登记（v2）

| 风险 | 影响 | 缓解 |
|---|---|---|
| `delete_cookie` 入队即返回、失败被 `log::error!` 静默吞（本 crate 无 logger） | 误报"已清理" | **删除后二次 `cookies()` 复核 + 打印 remaining**；>0 时有界重试一次 |
| wry 对 profile 每条 cookie 都 `CookieBuilder::build()`，panic 会打死所在线程 | 壳不再处理 manager 事件（比 431 更糟） | janitor 独立线程 + `catch_unwind`；读线程只在 janitor 之外做判断 |
| 主线程被 WebView2 卡住时 janitor 阻塞在 `cookies()` | 清理延迟（不影响读线程） | 清理不阻塞读线程（janitor 独立）；首次导航用**有界等待**（≤3s，超时记日志继续） |
| 同 authority 重复事件删掉在用 cookie | 可避免的 401 窗口 | **只在 authority 变化 / 进程启动时清理**（I 方案已否） |
| 无 token 的 dsh 版本（历史 57 条 URL） | 清理后无法重签 → 锁死 | 谓词只删 `dsh-auth-*`（该 cookie 只可能由 token 流程产生）；token-less 版本本就不看它 |
| `NODE_OPTIONS` 覆盖用户更小值 | 用户设置被盖 | 打印最终值；文档写明顺序语义；可一键回滚 |
| 单会话内大量重启仍会累积 | 极端情况下复发 | P1 64KB 余量（按实测速率可撑数月）+ authority 变化即清 |
| 上游改 cookie 命名/加前缀 | 清理失效 | 前缀 + host 双条件；失效最坏 = 回到现状（不误删） |
| Linux（GTK）cookie 实现忙转、cookie manager 为 None 时可能死循环 | Linux 侧异常 | 知情项：不按 cfg 关闭清理；实现里避免在 GTK 上高频调用（每次启动/authority 变化各一次）；后续如需可在 Linux 上禁用 |
| prod jar 运行期不可读 | 无法离线数条数 | 用壳自身日志（`before/pruned/remaining`）+ S0（关闭后读 DB）交叉验证 |

---

## 9. 待用户决策

1. 实施范围：**P0+P1（最小闭环）** 还是 **P0+P1+P2**？
2. 是否现在执行"立即恢复"（清当前 WebView2 里 `127.0.0.1` 的 `dsh-auth-*`）——当前壳内页面仍冻在错误页，清完重启即恢复。
3. 是否授权在 dev 版执行 S2/S3/S6（需要关闭/启动 dev 壳、直写 dev profile 的 cookie DB；不动正式版与用户 Chrome）。
