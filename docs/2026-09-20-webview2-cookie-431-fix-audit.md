# 审计归档：WebView2 cookie-431 修复方案（四角度对抗式审计）

- 日期：2026-09-20
- 被审对象：`docs/2026-09-20-webview2-cookie-431-fix-plan.md`（v1 → 修订为 v2）
- 审计方式：4 个独立审计员并行、**对抗式**（目标是证伪）、只读（不改仓库/宿主、不启停进程）；各自独立核验 Tauri/wry/webview2-com 源码、dsh 源码（`/srv/deepseek-harness`）、宿主现场（session.log / manager.log / WebView2 cookie 库 / live dsh HTTP）
- 结论一句话：**方向与根因成立；v1 的调用点、线程模型、验收判据、量化模型 4 处有实质缺陷，均已修入 v2；修后方案能修好存量装机且无不可接受副作用。**

---

## 1. 审计角度与主要发现

### 角度 A｜因果链与方案有效性（证伪导向）
| # | 发现 | 严重度 | 处置 |
|---|---|---|---|
| A1 | **431 指纹 = Node/llhttp**：溢出响应恰为 `HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n`（无 Date/Content-Type/Server），直连 TCP 可复现 ⇒ 限制器是 dsh 的 Node server，非代理/WebView2 | — | 采纳为证据 §1#2 |
| A2 | **请求行计入头预算**：无 cookie 时 16299 字符 URL→431 / 16199→404；真实 cookie + 2830B 批 URL：头块 16407B→200 / 16607B→431 | — | 采纳为证据 §1#3；§6 阈值基线 |
| A3 | **v1 证据错配**：DevTools 里 `status`/`state` 200 是**壳环回桥**请求（`shell-chrome.js:90/98/136`），不经 dsh 的 16KB 限制；`favicon`/app JS 可能命中缓存 ⇒ "短 URL 全 200"不能证明"只有长 URL 受害" | P1 | **采纳**：换成"303 已提交（无 token 的 `main page load`）+ 同刻批 URL 431 ⇒ jar ∈57–68 条"的窄带推断（§1#4） |
| A4 | **"每次启动=一条 cookie"高估**：prod 153 条 `dsh web:` 里仅 96 条带 `?token=`；dev profile 41 条 ↔ 39 个 token 端口（39/39）⇒ cookie 由**完成的 token 导航**产生 | P1 | **采纳**：§1#5 重写；P1 只表述为"延后复发"，不再给"<3 周"的推算 |
| A5 | **P0 调用点时序**：`server-url` 在 `lib.rs:2281` 先 `emit`，而 launcher 监听该事件并 `location.href=url`（`src/app.js:159-166`）+ 1s 轮询 `get_shell_state.liveUrl`（`src/app.js:303-325`）⇒ JS 导航可能先于 prune | **P0** | **采纳**：改为"先清理、后 emit"（§4.1 第 4 条） |
| A6 | **验收信号 `pruned N` 证明不了清理生效**：`DeleteCookie` 未匹配也返回 S_OK | **P0** | **采纳**：删除后二次 `cookies()` 复核 + 打印 `remaining`（§4.1 第 2 条） |
| A7 | **panic 风险**：wry 对 profile 每条 cookie 都 `CookieBuilder::build()`，panic 会打死所在线程（若在读线程 = 壳不再处理 url/install-status/dump-web） | P1 | **采纳**：`catch_unwind` + 独立 janitor 线程（§4.1/§4.2） |
| A8 | **token 闸门**：历史 57 条 URL 无 token；旧版本/冻结更新场景下 prune→导航→401 会锁死 | P1 | **部分采纳**：谓词只删 `dsh-auth-*`（该 cookie 只可能由 token 流程产生，token-less 版本不看它）；并把"绝不在 `w.reload()`（无 token）前清理"写进硬约束（§4.2） |
| A9 | **批 URL 不是稳定性质**：随插件名单线性增长（≈22B/插件） | P2 | 采纳为上游 issue 要点（§4.5） |
| A10 | 放大器现场证实：最后一次 `nav-fallback` 01:29:50Z → 3s 后外部浏览器 `client-ready` ⇒ 兜底被误关 | — | 采纳为证据 §1#9 |

### 角度 B｜副作用 / 回归 / 安全
| # | 发现 | 严重度 | 处置 |
|---|---|---|---|
| B1 | 漏掉其它导航路径：`nav-fallback`（实测 535 次）、launcher 两条自导航 | **P0** | **采纳**：v2 用"启动清理 + 首次导航前有界等待 + 先清理后 emit"覆盖全部路径，不再逐点插入 prune |
| B2 | `setup` 里 `cookies()` = Windows 死锁（主线程 + 无超时嵌套泵） | **P0** | **采纳**：明令禁止（§4.2），v1 的 setup 兜底已删 |
| B3 | 无条件 prune（每次 `server-url`）会删掉在用的 cookie → 周期性 401 | **P0** | **采纳**：只在**启动**与**authority 变化**时清理（§4.1 第 3 条、§3-I） |
| B4 | P1 与仓库"壳不注入 NODE_OPTIONS"约定的关系需说明；追加顺序会覆盖用户更小值 | P1 | **采纳**：§4.3 写明"只作用于 dsh 子进程、沿用 manager 既有注入点、与约定不冲突"，并打印最终值 |
| B5 | "只影响 dsh web"不准确（MCP/stdio 继承；PTC packaged 分支自行覆盖） | P1 | **采纳**：§4.3 范围说明修正 |
| B6 | 测试探针需先扩（`DSH_TEST_ENV_PROBE` 现只写 4 个 proxy 变量） | P1 | **采纳**：§5#3 |
| B7 | 数据丢失面：受信 `/` 不设任何其它 cookie；settings/plugins 窗口只 fetch 桥（无 credentials）；用户 Chrome 独立 jar | — | 采纳为副作用边界（§4.1） |
| B8 | 日志只在 `pruned>0` 时写 → 失败分支不可见 | P2 | **采纳**：无论 0/失败都写（§4.1 第 2 条） |
| B9 | 性能：152 次删除 = 1 次 GetCookies + 152 次 DeleteCookie（每次一条窗口消息） | P2 | 采纳：janitor 串行 + 只在启动/authority 变化触发；复核读一次 |
| B10 | `::1` 未覆盖；`localhost` 对本壳是死代码 | P2 | **采纳**：谓词加 `::1`（成本近零） |
| B11 | 若把 prune 挪到前端 invoke 会被 capability 挡（`capabilities/launcher.json`） | P2 | 记录：本方案走 Rust，不涉及 |

### 角度 C｜实现可靠性 / 平台正确性（源码级核验）
| # | 发现 | 严重度 | 处置 |
|---|---|---|---|
| C1 | API 面成立：`WebviewWindow::{cookies, cookies_for_url, set_cookie, delete_cookie}` 存在于 tauri 2.11.5，**无 cfg/feature 门**；`cookies()` 含 HttpOnly/secure；`GetCookies(NULL)` = 同 profile 全部 cookie；`DeleteCookie` 按 name+domain/path 匹配（round-trip 必匹配） | — | 采纳为方案前提 |
| C2 | `delete_cookie` 是 fire-and-forget（入队即 `Ok`），真正删除在主线程执行、失败被 `log::error!` 吞（本 crate 无 logger） | **P0** | **采纳**：复核读 + 日志（同 A6） |
| C3 | `setup` 死锁（`app.rs:1475-1481` setup 在事件循环前；主线程 inline 快路径 → `wait_with_pump` 无超时 `GetMessageA`） | **P0** | **采纳**：禁止（§4.2） |
| C4 | `on_page_load` 在 COM 回调内同步触发 → 文档点名的死锁场景，绝不能放 prune | **P0** | **采纳**：禁止（§4.2） |
| C5 | 读线程若被 `cookies()` 阻塞 → manager stdout 队头阻塞（url/down/dump-web 全停）；**禁止每事件 `thread::spawn`**（乱序 prune 会删掉新 authority 的 cookie，且兜底在 `CLIENT_READY=true` 时 `continue`、不自愈） | P1 | **采纳**：janitor 单线程串行；读线程只做判断+有界等待（≤3s） |
| C6 | 删除会连当前 authority 的 cookie 一起删，仅因导航带 token 才安全；唯一无 token 路径是 `w.reload()` | P1 | **采纳**：硬约束写进注释（§4.2 第 3 条） |
| C7 | Node flag 实测有效且在白名单（`allowedNodeEnvironmentFlags` 为 true）；request line 计入预算 | — | 采纳（P1） |
| C8 | 代码形态：`get_webview_window` 返回 `Option`；`tauri::webview::Cookie` 是"v3 将移除"的 re-export，建议用 `tauri::webview::cookie::Cookie` 或不写类型名；domain 匹配需大小写不敏感 + 容忍前导点 | P2 | **采纳**：§4.1 谓词实现 |
| C9 | Linux/GTK：cookie 实现忙转，cookie manager 为 None 时可能死循环 | P2 | 记录为知情项（§8）；不按 cfg 关闭清理 |
| C10 | 宿主实证：dev WebView2 库 **41 条** cookie，全 `host_key=127.0.0.1`、`path=/`、HttpOnly、非 secure、30 天过期，≈250B/条 | — | 采纳为 §1#5/#6 的实测支撑 |

### 角度 D｜验证方案是否足以证明"真修好了"
| # | 发现 | 严重度 | 处置 |
|---|---|---|---|
| D1 | v1 的"60 次启停"恰好压在悬崖上（60 条 ≈13.56KB vs 悬崖 ≈13.4–13.5KB），且 dev jar 已有 41 条 → 与"断言 pruned 60"自相矛盾 | **P0** | **采纳**：门禁改为**实测字节 ≥16KB（种子 ≥90 条）**，留 ≥30% 余量；废弃"跑 60 次"（§6 S2/S3） |
| D2 | 种子方案：DPAPI v10 直写 SQLite 可行（应用必须关闭）；stub dsh 次优；`hdrprobe.py` 零成本标定阈值 | P0 | **采纳**：S1（hdrprobe）+ S2（DPAPI 种 90 条） |
| D3 | V5 控制实验在 P1 同版时必然失败（64KB 掩盖 P0） | **P0** | **采纳**：S6 必须"P0+P1 同时关"，并以"同 jar 同 URL 431→200"为因果闭环判据 |
| D4 | `client-ready` 不是可用性判据（外部浏览器可置位；现场同时存在 ready 与坏页面） | P1 | **采纳**：S5 增加 `verify-dev-ui.ps1 -Action dump`（无 boot 错误文本 + 有真实控件） |
| D5 | 零个可机读的 431 证据（DevTools 只截图） | P1 | **采纳**：S3/S6 用 raw socket 机读；壳日志输出 `before/pruned/remaining`（复发可自诊断） |
| D6 | 已安装 dev 壳的 manager 资源副本与仓库漂移 → 不改安装目录就无法验证 P1 | P1 | **采纳**：S4 显式同步 `安装目录\resources\manager\*` 并比 md5 |
| D7 | 回归覆盖缺口：现有 9 套 + cargo test 均不涉及 cookie/头上限 | P1 | **采纳**：§5#3/#4/#5（探针扩展 + 纯 Node 头上限契约测试 + 调用点源级契约测试 + Rust 单测 + E2E） |
| D8 | 判据不明确/无超时/无基线 | P2 | **采纳**：S0 基线 + S5/S8 明确 PASS/FAIL（`remaining==0`、`client-ready ≤90s`、`nav-fallback ≤2`、其它 cookie 与基线逐项相同） |
| D9 | 重复 `url` 事件会删掉在用的 cookie | P2 | **采纳**（同 B3） |
| D10 | 归档缺口：阈值知识、上游 issue 正文、回滚演练、看板拆分、Note 主题 | P2 | **采纳**：本文件 + issue 草稿 + §7 回滚演练（S6）+ 看板拆卡 + Note 主题 `bug-fix/webview2-cookie-431-prune` |

---

## 2. 审计结论对方案的净影响（v1 → v2）

| 变更 | 原因 |
|---|---|
| 调用点从"`navigate` 之前"改为"**`emit` 之前**（先清理、后交付 URL）" | A5（launcher 自导航） |
| 删除 `setup` 兜底；明确禁止主线程/`on_page_load`/同步 command 调用 | B2、C3、C4 |
| 引入**单一 janitor 线程**（启动 + authority 变化触发，串行、`catch_unwind`） | A7、C5、B3 |
| 删除动作后**二次 `cookies()` 复核**并打印 `remaining`，0/失败也写日志 | A6、C2、B8 |
| 谓词加 `::1`、domain 大小写/前导点归一化 | B10、C8 |
| P1 的范围/顺序/约定关系写清，并打印最终 `NODE_OPTIONS` | B4、B5 |
| 证据链修正：431 指纹、请求行计入预算、jar 57–68 条、cookie 计数模型（96 token 端口 / dev 39↔41） | A1–A4 |
| 验证计划重写：S0 基线 → S1 阈值 → S2 种 90 条 → S3 复现 → S4 部署（含 resources 同步）→ S5 修复验证（UIA 可用性）→ S6 因果闭环（P0+P1 同关）→ S7 回归 → S8 副作用 → S9 存量自愈 → S10 归档 | D1–D10 |
| 新增交付物：上游 issue 草稿、技能更新项、看板拆分 | D10 |

**未采纳/降级的建议**（记录理由）：
- "把 prune 改成每次 navigate 的公共出口"（B1 的另一种修法）：会与 C5 的"读线程不得阻塞"冲突，且需要改 launcher JS/新增 command（capability 风险）→ 用"先清理后 emit + 有界等待"达到同等保证，改动更小。
- "把读线程改成单一 worker + channel"（C5 的彻底方案）：本轮不必要（janitor 已把阻塞移出读线程）；作为 P2 备选记录。
- "只做 P1 不做 P0"：D3/A4 证明 P1 只是延后且会掩盖 P0，不能作为主方案。

---

## 3. 审计后仍**未验证**的假设（实施时必须实测闭环）

1. **prod jar 的精确条数**：运行期 cookie DB 被 WebView2 独占（PowerShell 六种 share 模式全 sharing violation，9p EACCES）；S0 需在应用关闭后读。当前只能给 57–68 条区间。
2. **`delete_cookie` 对 host-only cookie 的实际匹配**（wry 把 `Domain()` 原样回传；理论匹配，未在 Windows 实机跑过）→ S5 的 `remaining==0` 是判据。
3. **`cookies()` 在真实 WebView2 上的耗时**（推断 ms 级）→ S5 观察首次导航延迟。
4. **dsh token 的 TTL/失效规则**（实测：连用 3 次成功、84 分钟后仍有效；签发代码未在 `@deepseek-ai` 树中找到）→ 与"删了立刻重签"结论无关，但影响 P2 的评估。
5. **DPAPI 直写后的行是否被 Chromium 原样保留**（S2 回读断言覆盖）。
6. **Windows 实机时序结论**（审计员本机无 Windows Rust 运行环境，均为源码级 + Node 行为实测）→ S3/S5/S6 在 dev 版实机闭环。
7. **V4/S9"不影响用户 Chrome 已开页面"** → 需用户确认。

---

## 4. 审计方法与可复核产物

- 只读核验源：`~/.cargo/registry/src/*/tauri-2.11.5`、`tauri-runtime-wry-2.11.4`、`wry-0.55.1`、`webview2-com-0.38.2`、`tao-0.35.3`；`/srv/deepseek-harness/packages/client/connection/src/browser-auth.ts`、`packages/ptc-runtime/*`；本仓库 `src-tauri/src/lib.rs`、`src/app.js`、`scripts/server-manager.mjs`、`scripts/test-*.mjs`。
- 现场只读核验：`%APPDATA%\dsh.smoothly.desktop\{dsh-desktop-session.log,runtime\manager.log}`、`%LOCALAPPDATA%\dsh.smoothly.desktop.dev\EBWebView\Default\Network\Cookies`（未加锁可读）、live dsh `http://127.0.0.1:63736/`。
- 审计产出：阈值/431 指纹探针已整理入库为 **`scripts/hdrprobe.py`**（`--port/--token|--cookie`，stdlib、只读、可复跑）；其余现场快照（页面 HTML、226B cookie 样本、进程/无 CDP 证据、请求枚举脚本、两张截图）保留在排查目录 `.tmp-investigate/`（**未入库**）。
