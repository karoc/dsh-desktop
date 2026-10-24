# dsh 日常升级自动化方案（目标：官方发布后 6 小时内出稳定版）

Status: implemented（P0/P1/P2 已落地并在 main 运行；P3 可选，未做；2026-10-24 新增 A3 凭据能力探测 + A5 反向心跳 + A6 三态退避 + A7 日志与产物保留）
Date: 2026-10-17（实施状态最后更新 2026-10-24）
相关：`CONTRIBUTING.md`、`.dsh/skills/dsh-desktop-shell-dev/SKILL.md`、`.dsh/skills/dsh-preinstalled-plugin-sync/SKILL.md`、
`scripts/server-manager.mjs` 的 `MIN_DSH_VERSION` 注释（历次适配的现场记录）、
`.agents/notes/implemented/process/2026-09-22-release-pr-gate-and-asset-dispatch.md`

> **读法（2026-10-19 加）**：① §1 的实测基线（含"当前欠账"）是 **2026-10-17 的快照**，属历史记录，别当现状；
> ② §3.x 里**承诺过但没实现**的条目已就地标注 **「设计稿（未实现）」**并写明实际实现是什么——
> 本方案的实施过程本身证明了"文档承诺 ≠ 已实现"，所以这里逐条对齐，不留悬空承诺；
> ③ 脚本注释里把失败语义称作「方案 §6」，那是指 **§0 的「合法失败出口」**（本方案 §6 是负向对照表，
> 不是失败语义）——历史叫法，读到时按 §0 理解；`dsh-watch.mjs` 的适配清单注释写「方案 §4」，
> 实际对应 **§3.4/§3.5**（本方案 §4 是决策记录）——同理按实际章节理解。
> ④ 章节号口径：实测基线在 **§1.1a**、通道口径在 **§1.1b**（`dsh-sla-report.mjs` 的注释引用的就是这两个号）。

## 0. 目标、判据与"达标"的定义

**目标**：上游 `@deepseek-ai/dsh` 发布后 **6 小时内**，我们的壳产出**稳定版**（三平台资产就绪），且**壳内预装插件与新的 dsh 地板同批适配**。

**SLA 的可测量定义**（不定义清楚就没法证明，见 CONTRIBUTING 的"引用绿态必须带坐标"）：

| 项 | 定义 |
|---|---|
| 起点 | **实际实现**：npm `@deepseek-ai/dsh` 的 `time[<该壳版本随包分发的 dsh 地板>]` —— 即"我们把地板抬到哪个版本，就从哪个版本的上游发布时间起算"。⚠️ 该地板**通常是预发布**（我们的地板长期高于 npm `latest`，例如 `0.2.1-rc.2`）；原稿写的是"stable 版本（`dist-tags.latest`）发布时刻"，与实现不符，已按实现改正 |
| 终点 | 我们**首个携带该地板的稳定版**（壳版本）的 GitHub Release `publishedAt`（含 `*_x64-setup.exe` / `AppImage` / `deb`） |
| 达标 | 终点 − 起点 ≤ 6h（`latest` 通道硬指标），且预装插件与地板**同一批**落地（见 §5 的硬规则） |
| 合法失败出口 | 6h 内**要么**出支持新版的稳定版，**要么**：① 开一份公开 issue（含 probe 报告的精确 blocker + ETA）；② 发一个**保持旧地板**的稳定版（hold 策略，用户不受影响）。二者都算"这条 SLA 有交代"，但**月度达标率按前者计**。**已自动化（2026-10-19）**：`dsh-watch.mjs` 到点而地板未动时自动开/更新 `sla-breach` issue（见文末「失败语义：已自动化」一节） |
| 通道 | **已定（2026-10-19，决策 ③C）**：`latest` 走 6h 硬指标；`next`/alpha 走 best-effort ≤24h 且**只开 issue、不开自动 PR**（门槛可用 `--sla-hours` / `--best-effort-hours` 覆盖）。原稿写"待用户确认"，已定 |

**月度判据**：自动生成的 SLA 报表（§3.7）里，stable 版本的 `≤6h` 占比 ≥ 90%，且没有任何 stable 版本"静默错过"（既不发布也不开 blocker issue）。

## 1. 现状与基线（为什么要做）

### 1.1a 实测滞后（逐 tag 配对，6 个样本全有提交证据）

**配对口径（权威）**：Release 与上游版本配对 ⟺ **该 tag 树里的 `MIN_DSH_VERSION` 等于该版本**
（`git show <tag>:scripts/server-manager.mjs`）。不用"地板提交后第一个 Release"那种近似 —— 实测有 6 个
Release（v0.14.0 / v0.16.0 / v0.18.1–v0.18.4）**与抬版无关**（地板与前版同值），近似口径会把它们错算进去。
三条交叉验证一致：CHANGELOG 的 `**dsh:**` 条目、地板提交标题（含 PR 号）、KANBAN 卡 summary。

| 上游版本 | T0 上游发布 | T1 地板提交（main） | T2 Release | 壳版 | 适配段 | 发版段 | 总滞后 |
|---|---|---|---|---|---|---|---|
| 0.1.6-alpha.2 | 09-17T13:52Z | 09-21T03:15Z `f360083` | 09-22T14:01Z | v0.11.0 | 85.40h | 34.75h | **120.15h** |
| 0.1.7-rc.2 | 09-24T14:18Z | 09-26T21:02Z `84269d9` | 09-27T15:36Z | v0.12.0 | 54.75h | 18.56h | 73.30h |
| 0.2.0-rc.1 | 09-28T12:34Z | 09-28T17:15Z `fc89ab5` | 09-30T12:11Z | v0.13.0 | **4.69h** | 42.92h | 47.62h |
| 0.2.0-rc.2 | 09-29T09:56Z | 10-05T08:56Z `3121bed` | 10-05T10:34Z | v0.15.0 | **143.00h** | **1.63h** | **144.63h** |
| 0.2.1-alpha.2 | 10-09T08:18Z | 10-09T15:08Z `9548e0c` | 10-10T01:25Z | v0.17.0 | 6.84h | 10.28h | 17.12h |
| 0.2.1-alpha.3 | 10-14T12:35Z | 10-15T10:08Z `e5d797c` | 10-15T13:08Z | v0.18.0 | 21.55h | 3.01h | 24.55h |

| 统计 | 适配段（T0→T1） | 发版段（T1→T2） | 总滞后 |
|---|---|---|---|
| 中位数 | **38.2h** | **14.4h** | **60.5h** |
| 最快 | **4.69h** | **1.63h** | 17.1h |
| 最慢 | 143.0h | 42.9h | 144.6h |

> 列名对齐（2026-10-22）：上表是**历史快照**，用的是当时的叫法 —— 它的「适配段（T0→T1）」在现在的报表里叫
> **抬地板**，「发版段（T1→T2）」叫 **适配**（`dsh-sla-report.mjs` 里分别是 `adapt` / `release` 字段）。
> 改名是因为"适配延迟"被 §3.7 定为 T1→T2（地板提交 → 我方发布），与这里的历史叫法相反；看旧表时按 T0/T1/T2 三个
> 时间戳对读，不要按列名。

**关键读法**：目标 6h 与**两端各自的最快记录**（4.69h / 1.63h）在同一量级 ⇒ **卡的不是技术能力，是"没人触发 + 发版不为它单独开一趟"**。
中位数之所以是 60.5h：最大一笔 143h 的适配段，其提交信息写的是"npm latest 已从 rc.1 毕业到 rc.2"（`3121bed`）
—— 触发条件是**通道状态**而非验证耗时。⚠️ 诚实边界：packument 只给 publish time + **当前** dist-tags，
**没有历史 dist-tag 变更记录** ⇒ "等毕业"占那 143h 多少**无法量化**，只能确认触发条件来自通道。

**当前欠账（2026-10-17 14:00Z 实测，相对地板 0.2.1-alpha.3）**：`0.2.1-alpha.4` 已 **41.0h**、
`0.2.1-alpha.5` 已 **17.6h**、`0.2.1-rc.1`（10-17T03:17Z）已 **2.9h** —— 三者**均无适配记录**。

**壳不发 dsh 这个事实决定了自动化重心**（grep 实测）：`@deepseek-ai/dsh` 在 `package.json` /
`tauri.conf.json` / `Cargo.toml` 里命中**均为 0**；它是运行时装进 `<runtime>/node_modules/@deepseek-ai/dsh`
（`scripts/server-manager.mjs:32` 的 `PACKAGE`）。所以"适配"= 验契约 + 抬地板 + 重采夹具 +（必要时）改 overlay/插件，
**不涉及依赖重打包** ⇒ 要自动化的是**发现与发版编排**，不是构建。

**约束（实测）**：本机 `npm` CLI 在自动化里**不可用**（`npm error code EROFS`：`~/.npm/_cacache/tmp` 只读；
不是网络问题——响应体已拿到，只是写不了缓存）。探针与报表一律走 registry HTTP（`curl -x $HTTPS_PROXY`）。

### 1.1b 「官方发布」指哪个通道？（**2026-10-19 已定**）

实测（2026-10-17）：我们的地板 `0.2.1-alpha.3` **高于** npm `latest`（仍是 `0.2.0-rc.2`），而 `next=0.2.1-rc.1`。
所以 SLA 起点必须先定义，三种口径的含义完全不同：

| 口径 | 对谁计时 | 当时的现状 |
|---|---|---|
| A. `dist-tags.latest`（稳定通道） | 只对"毕业到 latest"的版本计时 | 6 个样本里只有 `0.2.0-rc.2` 算 ⇒ 唯一真实稳定滞后 = **144.6h** |
| B. 任何 `next`/`alpha` 预发布 | 对每个预发布都计时 | 当时已积压 3 个（alpha.4/alpha.5/rc.1） |
| C. 混合（**已采纳**） | `latest` 走 6h 硬 SLA；`next`/`alpha` 走 best-effort ≤24h 且**只开 issue 不开自动 PR** | 与 §0 的现有定义一致 |

**决策（2026-10-19，用户确认 ③C）**：采纳 C。实现上不再"先定通道再计时"，而是**按实现口径直接算**：
T0 = `time[该壳版本随包地板]`（可能是预发布），终点 = 首个携带该地板的稳定 Release；`dsh-watch.mjs` 按
`latest` / 预发布分别用 6h / 24h 门槛判"是否已违约"。**这样做的代价说清楚**：地板高于 `latest` 时，
我们实际上是在"跟着预发布走"，所以 §1.1a 那张表里的滞后**不等于**"stable 通道滞后"；月度判据（§0）里
的 stable 达标率要按 §3.7 报表的 `gateScoped` 口径读，别把预发布欠账算进 stable 达标率。

### 1.2 链路分段

**今天这条链路是"人 + agent 手工驱动"的**，逐段拆开（按 2026-10-17 的实际状态）：

| 阶段 | 现在的做法 | 谁做 | 耗时量级 |
|---|---|---|---|
| ① 发现上游发版 | 靠人注意到 / 会话里顺手查 | 人 | **小时~天（不可控，是最大不确定项）** |
| ② 静态契约核对 | agent 读上游 tarball + 提交历史，逐项核 overlay 目标行、patch-id 集合、客户端 seam、槽位 | agent | 1–3h（见 `MIN_DSH_VERSION` 注释里的历次记录） |
| ③ 机械适配 | 抬 `MIN_DSH_VERSION`（两份副本）、`--update-fixture` 重采、预装插件同步 | agent | 20–40min |
| ④ 本机验收 | `npm run bundle:dev`（5–10min）→ 静默安装 → 真机核验（chrome 上报/桥/四插件渲染/会话存储） | agent | 30–60min（含返工） |
| ⑤ 发布 | PR → CI（check+test ≈5min）→ squash 合并 → release-please PR → `--admin` 合并 → **手动 `workflow_dispatch --ref <tag>`** → windows 构建 11min → 核验资产 | 人+agent | 30–45min |
| ⑥ 预装插件同步 | 跑 `dsh-preinstalled-plugin-sync` 技能（人工审计 npm latest + 拉 tarball + 同步 + 验证） | agent | 30–60min |

**两个结构性人力税（本方案的核心靶子）**：

1. **②没有脚本** —— 每次抬 dsh 都要 agent 重新读一遍上游产物。这些检查**全是确定性**的（集合 diff / 字符串存在性 / 语义断言），完全可以脚本化。
2. **⑤的 tag 不触发构建** —— `.github/workflows/release-please.yml` 的注释写着"The v* tag then triggers the existing build.yml"，但它用的是 `secrets.GITHUB_TOKEN`；**GitHub 的递归保护会让 GITHUB_TOKEN 创建的 tag 不触发其它 workflow** ⇒ 每次都必须人手动派发（本方案 §3.3 用"定时补派发"绕开，不需要新 secret）。**这条是文档 ↔ 行为不符，实施时一并修正注释。**

**可以直接复用的既成机制**（方案不重造轮子）：

| 机制 | 路径 | 它守什么 |
|---|---|---|
| patch-id 夹具 | `scripts/fixtures/dsh-web-app-patch-ids.json` | 我们 overlay 依赖的 loader id 集合 |
| overlay 目标行门禁 | `scripts/test-patch-targets.mjs`（含 `--update-fixture --runtime <dir>`） | 目标行必须存在且语义正确（`ui-sidebar-browser` 必须 `disabled: false`） |
| 预装插件与地板兼容 | `scripts/test-plugin-dsh-compat.mjs`、`scripts/plugin-floor.mjs`、`scripts/test-plugin-floor.mjs` | 插件声明的 peer 地板 vs 壳强制地板 |
| 请求头预算 | `scripts/test-header-limit.mjs` | 431 事故的回归锚点 |
| 预装插件审计/同步 | `scripts/audit-preinstalled.mjs`、`scripts/sync-preinstalled-plugin.mjs` | 随壳分发的包 vs npm latest |
| 壳注入自检 | `scripts/test-chrome-real-init.mjs`、`scripts/test-chrome-bootstrap.mjs` | 注入即死/自愈/契约（含纯 Node 版，CI 会跑） |
| 真机 UI 探针 | `scripts/verify-dev-ui.ps1`、`scripts/smoke-windows.mjs` | 窗口/控件/冷启动冒烟 |
| 发布链路 | `.github/workflows/release-please.yml` + `build.yml` | 版本号/CHANGELOG/tag/三平台资产 |

## 2. 时间预算：6 小时够不够（分解）

| 段 | 目标耗时 | 说明 |
|---|---|---|
| 发现 | ≤ 15min | cron 15 分钟一轮（§3.2） |
| probe（静态契约核对） | ≤ 5min | §3.1 把 1–3h 的人工核对压成脚本 |
| 机械适配 + 开 PR | ≤ 15min | §3.4 一条命令；CI check+test ≈5min 与其重叠（**实际**：`dsh-adapt` 本机全链 ≈100s，含当时 23 套门禁；2026-10-19 链上新增 `test-automation-gates`（自证套件，≈60s）与条件式 parity 套件 ⇒ 全链相应变长，共 25 条） |
| 本机/CI 真机验收 | ≤ 60min | 原设计：§3.5 canary 并行构建（CI windows 11min）+ 自动验收脚本 ≤10min。**实际**：canary **不上 CI**、无自动验收脚本（§3.5 已标注设计稿未实现）⇒ 这一段是**纯人工** 30–60min，`dsh:adapt --canary` 只能替你做"三个日志标记"这一层断言 |
| 发布 | ≤ 45min | §3.3 自动补派发（≤10min 延迟）+ 构建 11min + merge/资产核验 |
| 预装插件同步 | 与上面重叠 | §3.8 与地板同批维护（硬规则：地板与 bundle 同批落地）。**实际**：`dsh-adapt` 只校验 peer 兼容，真正的同步是 `preinstalled-sync.yml` 每周一次（不同批，靠门禁兜住） |
| **合计（顺利路径）** | **≈ 2h** | 6h 预算留给 1–2 次黄灯迭代 |
| 红灯（破坏性变更） | 不受 6h 约束 | 走合法失败出口（§0） |

## 3. 实施：四批，每批可独立交付

### P0 —— 当天可做，收益最大

**3.1 `scripts/dsh-compat-probe.mjs`（把②脚本化）**

输入：一个 dsh 版本号（或 `latest`/`next`）。输出：`verdict ∈ {green, yellow, red}` + 结构化 findings + 人读摘要（Markdown），并落盘 `dsh-probe-<version>.json`。

检查项（每条都要有"为什么它能失败"的判据，且**用历史版本做负向对照**）：

1. **patch-id 集合 diff** —— 对 `scripts/fixtures/dsh-web-app-patch-ids.json`：新增 id 只记 info；**我们依赖的 id 消失 ⇒ red**。
2. **overlay 目标行** —— 复用 `test-patch-targets.mjs` 的判据（目标行存在 + `ui-sidebar-browser` 的 `disabled: false` 语义）对**新版本 tarball**跑一遍。
3. **客户端 seam/槽位** —— 我们实际用到的那些（`settings.section` / `settings.general.item` / `configForms` / `settings.plugins.tab` / `conversation.chat.reasoning.body` / 预装插件用到的模块加载器契约）：存在性 + 形参个数（少一个 ⇒ red，多一个 ⇒ yellow）。
4. **peer 地板一致性** —— 用新版本的 `plugin allow-version` 语义校验四个预装插件声明的 peer 范围（复用 `plugin-floor.mjs` 的逻辑）。
5. **CLI 面** —— `dsh web --port 0` / `--patch` / `--profile` / `--dump-config` / `--max-http-header-size` 这些我们 manager 依赖的开关仍在（读 `--help` 文本或解包 bin）。
6. **存储代** —— 会话存储版本号（v4 事故类：换代是单向的 ⇒ **red + 强制人工**）。
7. **native 依赖** —— `NATIVE_BUILD_PKGS` 列表里的包是否仍存在（少一个 ⇒ 让 manager 的 allowBuilds 白名单跟着改）。

**3.2 `.github/workflows/dsh-watch.yml`（cron `*/15 * * * *`，把①自动化）** —— **已落地**（逻辑在 `scripts/dsh-watch.mjs`，workflow 只是薄壳）

**实际实现**（2026-10-19 校对）：

- 取 registry 的 `dist-tags` 与 `time`（经 `curl`；`--registry` 可指向 stub，`--floor` 可钉住地板）；
- 与**壳地板**（`scripts/server-manager.mjs` 的 `MIN_DSH_VERSION`）比较，不看任何状态文件：
  `latest` 比地板新 ⇒ 6h 硬指标；否则 `next`/`alpha` 比地板新 ⇒ 24h best-effort；
- 需要适配 ⇒ 开/更新 **`dsh-upgrade`** issue（正文含门槛倒计时 `${threshold}h 截止` 与八步适配清单 +
  `dsh-adapt` 一键命令）；**门槛已过而地板没动** ⇒ 开/更新 **`sla-breach`** issue（正文 = §0 合法失败出口的
  两件事：写清 blocker + ETA、同时发一个保持旧地板的稳定版）；
- 去重：按 issue **标题里版本号的词边界**匹配 —— `contains("0.2.1")` 会命中 `0.2.1-rc.2` 的单子，必须词边界；
  **2026-10-24 修订（事故 #201–#217 之后）**：查询面从「`--label` 过滤 + `--limit 100`」改为
  「`state=open` + `--limit 1000`（到上限会告警可能被截断）」，**不再依赖 label** —— 事故里 16 条 issue 的
  label/assignee 从未落地（create 成功、`addLabelsToLabelable` 403），按 label 过滤查到 0 条 ⇒ 每 10 分钟
  再建一条。现在只用「本脚本的两种标题前缀 + 版本号词边界」这个**与写者无关的确定性键**；
  正文 `<!-- dsh-watch-state: target=… breached=… -->` 只决定"要不要评论"，不是去重键。
  同一轮还加了三样（详见 README「幂等 / 单写者 / 刹车 / 对账」）：本机 `flock` 单写者
  （`~/.dsh/locks/dsh-watch.lock`，拿不到锁打印 `skipped by lock` 后 exit 0）、`~/.dsh/PAUSE` 刹车
  （存在即跳过一切写操作）、以及每轮末尾的**收敛对账**（同版本多条 ⇒ 保留带 label/assignee 的规范单、
  其余评论「重复于 #N（同版本跟踪单），由 autopilot 对账关闭」后关闭；失败只出待人工清单，不报假成功）。
  **双写者（本机 timer + Actions cron）是设计事实**，所以写操作必须是收敛式的，不能假设自己独占；
  flock 只保本机，跨写者的 TOCTOU 由下一轮对账收敛；
- **告警如何送达（2026-10-20）**：issue 由 bot（`GITHUB_TOKEN`）创建，而 GitHub 的推送默认只覆盖
  「参与中 / 被 @ 提及 / 被赋值」的线程 ⇒ 只开 issue **不会**叫醒属主。现在 `gh issue create --assignee <owner>`
  （owner 解析：`--assignee` → `--repo` → `GH_REPO` → `GITHUB_REPOSITORY` → `git remote origin`，取不到
  **exit 2** 而不是静默跳过）+ 正文以 `@<owner>` 开头提及（前面不放中文标点）+ `dsh-upgrade`/`sla-breach` 之外的
  `priority:high` label（label **不产生通知**，只用于 triage；仓库原有 label 里没有优先级标记，只新增这一个）。
  更新路径先 `gh issue edit`（静默刷新正文、补齐 label/assignee），仅当**目标版本变化**或**状态跨级**
  （跟踪中 → SLA 未达标）才补一条**短** comment（comment 会通知 assignee/订阅者）⇒ 同一版本 cron 重复运行
  不重复评论、不重复赋值。
- 取不到 npm 发布时间 ⇒ **fail-closed 记未达标**（`pubUnknown`，"量不出来"不等于"达标"）；npm packument
  直连与代理都失败 ⇒ 非零退出（真故障）；其余情况退出码恒 0（红色只代表 job 坏了）。

**原稿承诺但未实现（设计稿）**，逐条说明实际是什么：

- ❌ 状态文件 `scripts/fixtures/dsh-upstream-state.json`（"已处理到哪个版本/verdict/issue 号"）—— **不存在**；
  去重完全靠 issue 标题匹配（无状态、幂等）。
- ❌ 在 watch 里跑 §3.1 的 probe 并分 green/yellow/red 三态 —— **没做**；watch 只判"比地板新"，
  probe 是独立步骤（`dsh:adapt` 第 6 步或手动跑）。**结构原因**：`dsh-compat-probe.mjs` 需要
  `--runtime <已装候选版本的目录>`（无它 exit 2），而 watch 的 runner 上只有一份 checkout、没有 runtime。
- ✅ `green` 自动建适配 PR —— **2026-10-20 起由 `scripts/dsh-release-autopilot.mjs` 接管**（不是骨架：
  在 /tmp 克隆里跑完整 `dsh-adapt`，推 `auto/dsh-<target>` 分支并开 PR；见文末「全自动流水线」）。
  watch 本身仍然只探测/开 issue，不建 PR（职责分离不变）。
- ❌ `red` 打 `blocked-upstream` 标签 —— **没做**；全链路的 label 只有 `dsh-upgrade` / `sla-breach` /
  `sla-report` 三个业务标签，外加 2026-10-20 为「必然通知」新增的 `priority:high`（只挂在告警单上，
  `sla-report` 周报不挂）。

**3.3 `.github/workflows/tag-dispatch.yml`（cron `*/10 * * * *`，去掉手动派发）** —— **已落地**

- 扫**最近 20 个 Release**（不是"所有 `v*` tag"）：对「Release 已存在但资产 <3 **且**该 tag 尚无构建运行」的
  版本执行 `gh workflow run build.yml --ref <tag>`（**用 GITHUB_TOKEN 就够** —— 这是 workflow_dispatch，
  不是 tag push，不受递归保护限制）；`timeout-minutes: 15`。
- **"尚无构建运行"的判据（2026-10-19 修正）**：服务端按 branch 过滤 + 读 `total_count`：
  `gh api "repos/$REPO/actions/workflows/build.yml/runs?branch=$tag&per_page=1" --jq '.total_count'`。
  旧写法拉"最近 100 条运行"再在客户端 `select(.head_branch == tag)`，而本仓 build.yml 的运行数已达 **800** 次
  （审计当时 799）⇒ 老 tag
  （如 `v0.11.0`）的运行早落在 100 条之外、被判成"没有构建"⇒ 资产长期 <3 时**每 10 分钟重复派发**。
  实测：`total_count(v0.11.0)=1`，而旧判据筛出 `0`。
- **已一并修正** `release-please.yml` 顶部那句不符实的注释（原文说 `v*` tag 会触发 `build.yml`；实际
  `GITHUB_TOKEN` 创建的 tag 受递归保护、**不触发**任何 workflow，所以才需要本工作流补派发）。

### P1 —— 本周

**3.4 `scripts/dsh-adapt.mjs`（把③变成一条命令）** —— **已落地**（第 8 步之外全是自动的）

`node scripts/dsh-adapt.mjs --version <版本> [--runtime <已装新版的 runtime 目录>] [--dry-run] [--allow-yellow]
[--canary] [--canary-timeout 180] [--dev-log <…>] [--manager-log <…>] [--strict-chain]`，**实际**依次做：

1. 断言 runtime 里装的 dsh 版本 == 目标版本（`--runtime` 缺省尝试 dev 实例固定路径，**路径不存在且未显式给出 ⇒ exit 2**，不发车）；
2. 抬 `MIN_DSH_VERSION`（**两份副本**：`scripts/server-manager.mjs` + `src-tauri/resources/manager/server-manager.mjs`）+ 在注释块**内部**追加适配记录 + `node --check` 校验（不过则回滚）；
3. 同步 README 里的地板数值（只替换旧地板字符串）；
4. 重采 patch 夹具（`test-patch-targets.mjs --update-fixture --runtime <dir>`）并核对采集版本；
5. 预装插件 peer 兼容（`test-plugin-dsh-compat.mjs`；地板与四个 bundle 必须同批）；
6. 探针非 RED（**没产出报告也算失败**；YELLOW 需显式 `--allow-yellow`）；
7. 全量门禁（**先跑 `node scripts/sync-cargo-lock-version.mjs`（与 CI `test` 作业在 `npm test` 前的那一步一致）**，
   再按 `package.json` 的 `test` 链逐条直接跑 `node`；当前 29 条里 28 条是 `node …` ⇒ 28/28 真跑，
   另 1 条是 `[ -f scripts/test-version-compare-parity.mjs ]` 条件式（parity 套件未提供时只跳过自己），
   它不匹配 `^node` ⇒ 本机把它**跳过并逐条列出**，CI 上由 `npm test` 真跑。默认容忍这种覆盖缺口、
   `--strict-chain` 把跳过也算失败。sync 只把派生的 `Cargo.lock` 对齐到 `Cargo.toml`；`package.json` /
   `tauri.conf.json` / `Cargo.toml` 三者彼此不一致时 sync **不修**、`test-manifest-consistency` 照样判红
   （2026-10-23 负向对照：把 `Cargo.toml` 也改成 9.9.9 ⇒ 门禁仍红）。缺这一步的后果：干净 main 上锁文件
   停在 0.19.0 而三处 manifest 已是 0.20.0，CI 靠 test 前的 sync 掩盖，而 `dsh-adapt` 第 7 步必红 ⇒
   每次真实适配都被误判成"适配失败"；sync 真改了 `Cargo.lock` 时跑链期间工作树是脏的 ⇒ `test-controls` 的
   三个可信度对照会 SKIP（它只在干净树上跑；CI 在 sync 后同理，已知覆盖缺口，跳过 ≠ 通过）；
8. 汇总 + 打印剩余人工步骤（dev 实机验收 / PR / 发布 / 装机）；`--canary` 时在此读**两个日志**断言三个标记
   （session 日志：`client/log chrome ready`、`client-ready (http)`；`<runtime>/manager.log`：`preinstalled bundles:`），
   只认检查开始之后**新写入的行** ⇒ 前提是 dev 壳在检查期间**新启动**。

**原稿承诺但未实现（设计稿）**：

- ❌ "脚本里自动 pnpm 装到临时目录" —— **没做**；第 4 步需要一个**已经装好目标版本**的 runtime（安装走产品自身
  路径，实测本机 ~104s，见 Note `dsh-upstream-release-day-drill`）。
- ❌ 第 4 步"跑 `audit-preinstalled.mjs`，对需要更新的包调 `sync-preinstalled-plugin.mjs`，并把四个包的 peer 地板
  与新 dsh 对齐" —— **`dsh-adapt` 不做**；它只跑 `test-plugin-dsh-compat.mjs`（校验 peer 是否已兼容），
  同步由 `preinstalled-sync.yml`（§3.8）独立承担。
- ❌ 第 6 步"生成 PR 正文 + 推分支" —— **没做**（刻意的：不建 PR、不推分支，避免脚本产生对外副作用）。
- ⚠️ `--dry-run` 只跳过第 2/3/4 步（写文件那几步），**第 5/6/7 步照跑**（第 7 步的 Cargo.lock sync 在
  dry-run 里会临时执行、跑完还原 ⇒ 净值零写入）；也正因第 4 步被跳过，
  **目标版本 ≠ 当前地板/夹具时它必然停在第 6 步探针**（`version-vs-*` RED）⇒ dry-run 只对"目标 == 现状"的
  幂等路径能全绿，**不能**用它演练一次版本变更（这是已知的演练能力缺口）。

**3.5 canary 验收管线（把④压缩）** —— **设计稿（未实现）**，实际实现如下

- ❌ `dsh-adapt` 路径触发 CI 的 **canary 构建**（windows job）—— **没做，且已决策不做**（2026-10-19：CI 是 Linux、
  壳是 Windows 桌面应用，canary 留在本地；理由见 §4）。
- ❌ 本机脚本 `scripts/canary-accept.ps1`（静默安装 canary → 启动 → 断言 chrome 三上报 / 桥 `/shell/state` /
  四插件挂载 / 会话存储 / 无 `fatal` → 产出 verdict 与证据目录）—— **不存在**。
- ❌ "失败即把证据贴回 PR" —— **没做**。
- ✅ **实际实现**：`dsh:adapt --canary`（第 8 步）在**本机**只读 dev 实例的**两个日志**做断言——
  session 日志（默认 `<dev 数据目录>/dsh-desktop-session.log`，`--dev-log` 覆盖）出 `client/log chrome ready`
  与 `client-ready (http)`；`<runtime>/manager.log`（`--manager-log` 覆盖）出 `preinstalled bundles:`。
  只认检查开始之后**新写入的行** ⇒ 前提是 dev 壳在检查期间**新启动**（空闲的壳不产生新标记行）；缺哪个标记
  会指名它来自哪个文件。它**不启动也不杀任何进程**，也不做安装/桥/插件渲染断言（那些仍是人工验收）。

### P2 —— 本月

**3.6 发布自动化（把⑤的人手去掉）**——**已决策（2026-10-19）：维持选项 B（零 secret）**，不引入 PAT/App token：

> 机制事实（实测，比注释更硬）：release-please 的 bot PR 其 workflow run 状态**恒为 `action_required`**
> （GitHub 要求人工批准 bot PR 的 workflow）⇒ `check`/`test` **永不上报** ⇒ 分支保护恒 `BLOCKED` ⇒
> 唯一合并路径就是 `--admin`；而 `release` job 的 `if: startsWith(github.ref,'refs/tags/v')` 因
> **API 创建的 tag 不触发 workflow** 而永不自动跑（实测 v0.18.x 每个 build run 的 `event` 都是
> `workflow_dispatch`，无一 `push`；v0.11.0 的 Release 因此 `assets: []`）。
> ⚠️ 这两步要自动化都必须引入 PAT/App token 或改 Actions 策略 = **凭证面扩张**，而
> `.agents/notes/implemented/process/2026-09-22-release-pr-gate-and-asset-dispatch.md` 已**明文否决过一次**。
> 方案若要碰，必须在决策里**显式推翻并写明理由**，不能顺手改掉。
- 选项 A（原稿推荐，**已否决**）：加一个 `RELEASE_PLEASE_TOKEN`（fine-grained PAT）给 `release-please` 用 ⇒ tag 由 PAT 创建、**能触发** `build.yml`，链路闭环（需要在仓库 Settings 加 secret：**这是用户动作**）；
- 选项 B（**已采纳**）：维持 §3.3 的定时补派发（≤10min 延迟），发布链路保持零 secret。
- release PR 的合并：~~保持 `--admin` 人工合并~~ —— **2026-10-20 部分推翻（仅限本机自动化路径）**：
  `scripts/dsh-release-autopilot.mjs` 用**本机项目 PAT**（`./scripts/gh`）做 `--admin` 合并，默认连版本 PR 一起合并；
  零 secret 的决策**不变**（PAT 只在开发者本机，不进 CI/仓库；CI 里仍是人工 admin 合并）。
  版本 PR 的 bot checks 恒空，autopilot 用「MERGEABLE + 变更文件写域白名单」替代人工审查；
  代价是**零人工审阅**（已知限制，见文末）。`--stage1` 可只合并适配 PR、把版本 PR 留在原人工闸门。

**3.7 `scripts/dsh-sla-report.mjs` + 定期 job（让 SLA 可证明）** —— **已落地**

`node scripts/dsh-sla-report.mjs [--json <out>] [--issue] [--check <json>] [--recent 3] [--since 2026-10-19] [--registry <url>] [--now <iso>]`

- **两段延迟（2026-10-22 加，报表的主读数）**：原来只有一个"合计"数字（上游发布 → 我方发布），它把两件性质不同的事
  混在一起 —— **检测**（上游发出来之后我们多久才发现）与**适配**（开始承诺地板之后多久发出稳定版）。现在拆成两列：
  **检测** = 上游发布 `time[地板]` → **首次为该版本开 issue** 的 `createdAt`（数据源 `gh issue list --state all
  --limit 1000`，**不按 label**；用与 `dsh-watch.mjs` **共用的确定性键** `scripts/lib/issue-key.mjs` 筛：标题前缀
  `[dsh-watch]`/`[SLA 未达标]` + 版本号**词边界** + `dsh <版本>` 锚点 —— watch 标题里通常同时有 target 与"当时的地板"
  两个版本号；**任意 state**，关掉的单同样是历史证据）；**适配** = 地板提交 → 我方发布
  （**沿用旧口径**，即 JSON 里原有的 `release` 字段，旧报表把这一列印成"发布"）。表里保留 抬地板（上游发布 → 地板提交，
  = 原有 `adapt` 字段，旧报表印成"适配"）与 合计（`total`，门禁判它），末行给**两段中位/最大**。
  ⚠️ **找不到对应 issue ⇒ 检测记为 unknown 并在表格里显式打印「未检测到」，绝不当 0**（"没有判断 = 没有验证"）。
- **实时信号（2026-10-22 加）**：报表开头是「当前状态」——最新 watch issue（标题 / `createdAt` / 距今多久 / 是否未关闭）、
  上游 `latest`/`next`/`alpha` 及其发布时间、壳地板（当前 HEAD 的 `scripts/server-manager.mjs`）、**有没有未关闭的跟踪
  issue**，以及"上游最新是否已晚于壳地板（按**发布时间**先后作版本先后的代理，不养第二套 semver）且是否已被发现"。
  地板在 packument 里查不到时间戳时明写"无法比较先后（不猜）"，不默认"无欠账"。
- **取数（实际）**：npm registry 的 `time`（上游发布时间，经 `curl`；`--registry` 可指向 stub）+ `gh api
  repos/<repo>/releases?per_page=100`（我们的发布时间）+ 上面那条 issue 查询（检测延迟）。**配对规则是"tag 树里的地板"**：
  `git show <tag>:scripts/server-manager.mjs` 读 `MIN_DSH_VERSION` —— tag 树里读不到（历史早期 tag）则跳过并给出
  理由，不猜。按 **dsh 版本**聚合（同一地板被多个壳版本携带时只取**最早**那次 Release），全量明细留在 JSON 里。
  ⚠️ **取数口径（2026-10-24 修正，替换原来的 label 方案）**：旧实现按 `--label dsh-upgrade` / `--label sla-breach`
  各查一次再合并（因为 gh 的重复 `--label` 是 AND 语义，合成一条会恒返回空 —— 那个坑仍然真实存在，只是不再是主路径）。
  但按 label 取数**本身就是缺陷**：PAT 缺 Issues:write 时 `issue create` 能过、**label 从未落地**（事故 #201–#216 的
  16 条 issue 没有 label）⇒ 报表查到 0 条、把每个版本的检测延迟都静默判成「未检测到」，而 issue 明明开着。
  现在改为 `--state all` 全量拉取 + 用 `scripts/lib/issue-key.mjs` 的确定性键筛（标题前缀 + 版本号词边界 + `dsh <版本>`
  锚点）—— 与 watch 写/去重时用的**同一份实现**，不会再漂移。同版本多条 ⇒ 按 `createdAt` 取**最早**（同刻按编号小的
  优先），表格「首次 issue」列印 `#编号 + 时间`、`注意` 段逐版本说明取了哪条。命中 `--limit 1000` 上限时**拒绝出数**
  （被截掉的可能包含最早的 issue ⇒ 检测延迟只会偏大）。
- **输出（实际）**：Markdown 报表 = 当前状态块 + 段口径说明 + 统计行（已量出版本数、合计中位/最好/最差、达标率、
  抬地板段中位、适配段中位、门禁口径）+ 表格（首个携带该地板的版本 / 随包地板 / 上游发布 / 首次 issue / 地板提交 /
  我方发布 / 抬地板 / **检测** / **适配** / 合计 / ≤6h）+ 末行两段中位/最大 + 「待适配版本的检测延迟」段（上游已发布 +
  已有跟踪单、但我方还没发版的版本 —— 检测段在发版前就可算）+ 逐条注意（不匹配的 issue、同版本多条取哪条、
  检测为负的时间戳异常）。
  ❌ 原稿的 **p90 没实现**（只有中位/最好/最差）；❌ "落到 `docs/dsh-upgrade-sla.md`（自动生成，进仓库，可 diff）"
  **没做，且 `docs/dsh-upgrade-sla.md` 不存在** —— 实际去处是：step summary + `--issue` upsert 到 `sla-report`
  issue + 可选 `--json <out>`。
- **告警送达（2026-10-20）**：`sla-report` issue 由 bot 创建 ⇒ 创建时 `--assignee <owner>` + 正文
  `@<owner>` 提及（属主解析同 §3.2，取不到 **exit 2**）。weekly 更新走 `edit`（**不推送**），正文末尾带
  `dsh-sla-report-state` digest（量到的版本集合 + 逐版本达标标记）；digest 没变 ⇒ 连 edit 都跳过；
  变了才追加一条短 comment 说明「目标版本 / 达标数」变化。⇒ 同一周重复运行幂等，不会每周刷评论。
- **判据（实际）**：报表由 CI 生成（不许手填）。❌ 原稿的"连续两个 stable 版本无记录 ⇒ job 失败"**没实现**；
  实际门禁口径见下（**无数据即红** + **只判 since 之后首发**）。
- **门禁口径（2026-10-19 两条修正，两个方向都曾失真）**：① **无数据即红** —— 报表缺 `perVersion` 或为空数组
  ⇒ exit 1（旧实现"最近 0 个版本中 0 个超 6h ⇒ exit 0"是假绿：量不出来 ≠ 达标）；② **历史欠账不参与退出码** ——
  只判 `--since`（默认 `2026-10-19`，方案落地日）之后**上游首发**的版本，欠账仍在报表里逐行显示并单列一行
  说明。真实数据实测：7 个已量出版本全是历史欠账（0/7 达标、合计中位 47.62h），`--check` **exit 0** 并列出
  7 条欠账；`since` 之后新首发的版本超时仍会 exit 1。③ `--recent 3` 只看该范围内的最近 3 个。
- **检测延迟不进门禁（2026-10-22 决策）**：`--check` / `--fail-on-breach` 的判定**与旧实现逐位相同**（只看 `total`），
  检测延迟只进报表。理由：检测延迟量的是"上游发出来之后我们多久才发现"，取决于定时探测所在的机器 / runner 在不在跑、
  issue 有没有被限流 —— 那是**平台属性**不是适配能力；写进门禁只会让红绿随平台抖动，把"机器没开"判成"适配不力"。
- ✅ **展示口径的时区缺陷已修（2026-10-19 落地，2026-10-22 复核确认文档没跟上）**：现在三个时间戳列统一是
  **UTC ISO 截到分钟**（`utc(t).slice(0,16)+'Z'`，列头写明 UTC；`utc()` 走 `toISOString()`），不再出现
  「`地板提交 2026-10-18T03:39` / `我方发布 2026-10-17T19:40`」那种"看着差 8 小时、实际差 54 秒"的跨时区混排。
  本段此前写着"未修"是**文档滞后**（修展示口径的改动落在脚本里、没同步到这里），现已改正。
- ✅ **检测段首次拿到真实数据点（2026-10-24 实跑）**：`0.2.1-rc.3` 上游发布 `2026-10-23T07:54Z` → 最早跟踪单
  **#201** `2026-10-23T08:00Z` ⇒ 检测 **0.10h**（旧实现按 label 取数时这里恒为「未检测到」：17 条同版本 issue 里
  只有 #217 带 label，它开于 10:30Z —— 而且即使按 label 看到 #217，算出的也会是 ≈2.60h 而不是 0.10h）。
  该版本还没被任何壳版本携带 ⇒ 进不了两段表（配不到"我方发布"），所以报表单列一段
  「待适配版本的检测延迟」，把**发版前**就能算的检测段暴露出来（`--json` 的 `detectionStats.pending`）。
  7 个**已量出**的历史版本仍全部「未检测到」—— 原因不是"没有 issue"，而是它们的上游发布（2026-09-17…10-17）
  早于 watch 第一次开单（2026-10-23）；检测段在这 7 行上**本来就没有可判定样本**，继续印「未检测到」而不是 0。
- **负向对照（2026-10-24，合成 git 仓库 + stub packument + gh 桩，新旧实现跑同一批夹具）**：
  ① 只有**无 label** 的 issue ⇒ 新实现算出检测 0.10h，旧实现（同一桩）印「未检测到」；
  ② 标题 `dsh 0.2.1-rc.30` 不得匹配 `0.2.1-rc.3`（`versionRe` false、`findTrackingIssue` 返回 null，
  且报表该版本保持「未检测到」）；
  ③ 同版本 3 条（#10 08:10 已关闭、#12 08:10 同刻、#11 09:00 带 label）⇒ 新实现取最早 **#10**（0.26h），
  旧实现只看得到带 label 的 #11（1.09h）—— 两条都会漂，且**关掉的单必须算**。

**3.8 预装插件自动同步 job** —— **已落地**，但实现与原稿不同

**实际实现**：`.github/workflows/preinstalled-sync.yml`（cron **每周一 02:00 UTC**，不是"每天 1 次"；
`timeout-minutes: 20`），复用 `scripts/sync-preinstalled-plugin.mjs`（内部会跑 `sync-resources.mjs`），
**没有**扩展 `audit-preinstalled.mjs`、**不共用**任何状态文件（❌ 原稿的"与 §3.2 共用状态文件"未实现：
`scripts/fixtures/dsh-upstream-state.json` 不存在）。判定分**三态**：

- **漂移**（npm `dist-tags.latest` 比壳内版本新）⇒ 同步 → 过 `test-copy-consistency.mjs` + `test-plugin-dsh-compat.mjs`
  两道门禁 → 开/更新 PR（分支 `chore/preinstalled-sync`，正文写明当前 dsh 地板；已有同分支 PR 则推送更新它）；
- **本地领先**（壳内版本比 npm latest 新）⇒ **不动**（旧实现会把它当漂移、用更旧的版本覆盖已发布的 bundle）；
- **查询失败**（npm 查询报错、或返回值不是版本号）⇒ **逐个记账、跑完所有包，最后判红**（旧实现把失败折成 `?`
  ⇒ 制造假漂移；`set -e` 还让第一个坏查询中断整批）。无漂移 ⇒ 静默 no-op；`src-tauri/resources/preinstalled/`
  下一个目录都没有 ⇒ 判红（那是检出/路径异常，不是"无漂移"）。

三处硬化（2026-10-19）："同步后无差异"看 `git status --porcelain`（含**未跟踪新文件**，`git diff --quiet` 看不见）；
push 前 `git ls-remote` 取期望值 + `git fetch` 建远端跟踪引用 + 显式 `--force-with-lease=refs/heads/<b>:<sha>`
（干净检出没有跟踪引用，裸 lease 会以 stale info 拒绝 ⇒ 旧实现第二次运行必失败、既有 PR 永不更新）；
`workflow_dispatch` 输入一律经 env 进 bash。

**3.8 三态 + 指数退避 + 只在跃迁时通知（A6）/ 日志与产物保留（A8 + A9）** —— **已落地（2026-10-24）**

问题：三个本机 timer 都是"每 10 分钟一轮"，失败时**每轮重印同一段完整错误**；日志/产物也没有保留策略。
理论依据见 [2026-10-24-alerting-and-idempotency-patterns.md](2026-10-24-alerting-and-idempotency-patterns.md)
（PR #219）§5（保留）与 §6（退避/状态机）的采用清单 A6 / A8 / A9。落地范围与**未做**的部分：

**3.8.1 退避状态机**（`scripts/lib/backoff-state.mjs`；接入 `dsh-watch` 与 `dsh-release-autopilot`）

- 状态：`healthy`（最近一次成功）/ `degraded`（连续失败 1..N-1，默认 N=3）/ `broken`（≥N，或在
  不可重试错误上立即 broken）。状态文件 `~/.dsh/state/<tool>.json`（`--state-dir`/`--state-file` 覆盖、
  `DSH_STATE_DIR` 环境变量、原子写 tmp+rename、schema 校验；**损坏 ⇒ 备份 `*.corrupt-<ts>` 后重建
  healthy**，fail-open）。
- 退避：5 → 10 → 20 → 40 → **封顶 60 分钟**。broken 之后每轮 stdout **只有一行**
  `still broken (attempt k, next retry in Xm)`（进入 broken 的那一轮另有「连续 N 次失败」一行摘要 + 跃迁评论），
  未到 `nextAttemptAt` **跳过实际工作**；失败明细进
  `<state>.detail.log`（128KB 触发、只留尾部 400 行）；**每轮**写一行心跳 `<state>.heartbeat`
  （`skipped=yes/no`）供反向心跳区分"在退避"与"进程死了"。
- 通知：**只在跃迁时**发一条 issue 评论 —— healthy→degraded、degraded→broken（或首次即 broken）、
  broken→healthy；degraded→healthy **静默**（还没通知过任何人）。评论带
  `<!-- <tool>-backoff: state=<to> … digest=<sha> -->`，digest 由 `<tool>|<from>|<to>|<enteredStateAt>`
  派生 ⇒ 补发/并发幂等，恢复后再次坏掉仍是新的一条。写失败进 `pendingNotification`，下一轮补发。
- 退出码：degraded/broken 的**重试轮** 1；**退避跳过轮 0**（没干活、也不是新故障 —— 0 是为了不与
  systemd `Restart=on-failure`+`RestartSec=60` 叠成热循环）。健康判据 = 状态文件 + 跃迁评论。
- **CI 特例（有意）**：Actions runner 文件系统临时 ⇒ 状态每轮从 healthy 开始；脚本在
  `GITHUB_ACTIONS=true` 且未显式给 `--state-dir/--state-file/DSH_STATE_DIR` 时**只记账、不发**
  跃迁评论（否则每轮一条 degraded 评论，比现状更吵）。"任务没跑"那一层归 A5 dead man's switch。
- 人工：`--reset-state`（只重置本地状态、**不写 GitHub**）；`--no-backoff` 仅供演练/负向对照。
- **未做（明确登记）**：`dsh-sla-report.mjs` **不接入** —— 它是**每周**一趟的报表 job（`dsh-sla-report.yml`
  周一 01:00 UTC），且 issue upsert 已用 `dsh-sla-report-state` digest 去重，不存在"每 10 分钟重复错误"
  的路径；接入只会多一个要维护的状态文件。本机 systemd 单元的 `RestartSteps=4` +
  `RestartMaxDelaySec=3600` 只在 README 给模板（**不改用户机器**，unit 不在仓库里）；
  `dsh-watch.service` 改 unit + `daemon-reload` 属**用户动作**。
- 门禁：`scripts/test-backoff-state.mjs`（`npm test` 链上；纯函数单测 + 8 轮实测 + 负向对照
  `--no-backoff` 必须退回"8 轮全量错误 + 0 条跃迁评论"，另外覆盖 autopilot 的同一闸门）。

**3.8.2 日志与产物保留**

- `~/.dsh/logs/*.log`：systemd `append:` **没有轮转**（§5.1）。模板 [scripts/logrotate.dsh.conf](../scripts/logrotate.dsh.conf)
  （`daily` + `maxsize 20M` + `rotate 7` + `compress` + `delaycompress` + `copytruncate` + `missingok`
  + `notifempty`）；用户级安装 + `logrotate -d` 干跑 + systemd user timer 模板写在 README
  「日志与状态文件在哪、怎么清理」。本机实测 `logrotate -d` 通过、`-f` 后原件截断为 0 且生成 `.1`。
- journald：本机上限 ~100M 且会 vacuum（`AGENTS.md`）⇒ journal 不能当长期取证源，关键日志落文件。
- 退避状态/心跳/锁/PAUSE：可安全删除（删状态 = 忘掉退避历史，职能不丢），正规入口 `--reset-state`。
- hang dump：**三档保留已在壳里落地**（采用清单 A9，2026-10-24）：策略单一定义在
  `src-tauri/src/retention.rs` 的 `HANG_DUMP_POLICY` = **最新 3 份 + 14 天 + 总量 ≤1GiB**，
  `web_dump::prune_dumps` 只是薄封装（每次 dump 与「清理缓存」各跑一次）。两条安全边界：
  **永不清空目录**（策略再严也只删到剩最新一份）与 `mtime` 读不到 ⇒ 保留（没有判断不能删）。
  验证：`retention.rs` 的 8 条单测（CI `check` job 的 `cargo test --lib`）+ 4 条变异对照
  （关掉时间/份数/总量任一维度、删掉安全边界 ⇒ 单测必须变红）。
  `scripts/server-manager.mjs` **仍然没有** dump 保留逻辑（`grep -n dump` 只命中看护协议行：请壳抓 dump /
  等 dump-done / 重启）—— "manager 管 dump 保留"是误解，它只发协议。
- 插件升级备份 `.plugin-backup` + `.plugin-backup.prev` 至多两份（`server-manager.mjs:763-774`），天然有界。

### P3 —— 可选/降级预案

**3.9 双地板测试矩阵**：同一壳版本同时验"地板版 dsh"与"最新版 dsh"（用户可能停在地板）。触发条件：连续两次抬地板后老版本用户占比仍不可忽略。
**3.10 上游 alpha 跟踪节奏**：把 `next` 的探测频率降到每天 1 次并只做 probe 不开 PR（避免为 alpha 花掉 stable 的预算）。

## 4. 三件已决策的事（2026-10-19，原为"待用户决策"）

1. **canary 构建不上 CI** —— 决定：**不上**。理由：CI 是 Linux、壳是 Windows 桌面应用，把 windows 构建额度
   花在"每个适配 PR 都跑一遍 canary"上不划算；canary 保持本地 `dsh:adapt --canary`（见 §3.5 的实际实现）并作为
   流程硬门槛。代价：验收与 CI 不并行，顺利路径多 ~10–20min（§2 的预算里已含）。
2. **发布链路：选项 B（零 secret）** —— 决定：**不加 PAT**，维持 §3.3 的定时补派发（多 ≤10min 延迟）；
   release PR 仍人工 `--admin` 合并。理由：2026-09-22 的凭证面否决依然有效，且 B 的延迟在 6h 预算里可接受。
3. **6h SLA 的失败语义：接受"hold 旧地板 + 公开 blocker issue"** —— 决定：**接受**（否则遇到上游破坏性变更时
   SLA 会变成"假装达标"）。**已自动化**：`dsh-watch.mjs` 在门槛已过而地板未动时自动开/更新 `sla-breach` issue，
   正文就给出这两件事（写清 blocker + ETA；同时发一个保持旧地板的稳定版）。

## 5. 硬规则与诚实边界

- **地板与预装 bundle 必须同一批落地**（来源：`MIN_DSH_VERSION` 注释里的历史事故——旧 bundle 用了新版已删除的图标名，单独抬地板会让它们在新运行时上崩）。自动化里表现为：§3.4 的第 2 步（抬地板两份）与第 5 步（`test-plugin-dsh-compat.mjs`）**在同一个 PR**，且该门禁必须绿；真正把 bundle 版本抬上去的是 `preinstalled-sync.yml`（§3.8），它同样是独立 PR、同样过这道门禁。
- **破坏性变更不自动适配**：存储代换代、客户端插件 API 重写、overlay 目标行消失 ⇒ probe 判红 ⇒ 走合法失败出口。自动化能保证的是"**15 分钟内知道红在哪、红到什么程度**"，不是"什么都能自动改"。
- **不能从 CI 派发 agent**（本仓没有 agent runner）⇒ 黄/红处置仍需一次会话介入；方案把它压成"一条命令 + 一份自动生成的报告"，而不是"人肉复现"。
- **不许跳过门禁直发**（含"为了赶 6h 而 --admin 绕过 check"—— 本方案的实施里我本人犯过一次，已记录）。
- **不做**：自动改上游代码、自动合并 red 判定的 PR、为 alpha 版本开自动 PR。

## 6. 每个机制怎么证明它真的работает（负向对照）

| 机制 | 负向对照（**实际跑过的**用 ✅ 标出；未做的保留为待办） |
|---|---|
| §3.1 probe | ✅ 用**历史版本**跑（如 `0.2.0-rc.1`）⇒ 报出与当年人工核对一致的差异（锚点）；再人为删掉 overlay 目标行 ⇒ red。另：探针**没产出报告**从"通过"改成失败（假绿修正） |
| §3.2 watch | ✅ 本地桩掉 registry（`--registry` 指 stub，无需改仓库代码）⇒ 走完开 issue 的路径；同一版本跑两次 ⇒ 只开一次（**按标题词边界**，非状态文件）。`green ⇒ 自动建 PR` 已由 autopilot 接管（2026-10-20，见文末）；`red ⇒ blocked-upstream` 仍未做 |
| §3.3 tag-dispatch | ✅ 服务端判据实测：`total_count(v0.11.0)=1`，而旧的"最近 100 条运行"筛出 `0`（这正是"每 10 分钟重复派发"的成因）。未做：真删一条 build run 记录来验证补派发（需要写操作，留给人工） |
| §3.5 canary 验收 | ⚠️ 未做（`scripts/canary-accept.ps1` 不存在）。已做的等价验证：`dsh:adapt --canary` 对**空闲的** dev 实例必须红，且错误信息指名"哪个标记来自哪个文件"（实测两个日志路径都解析到、新增字节数 session 0 / manager 0 ⇒ 红） |
| §3.7 SLA 报表 | ✅ 用历史配对数据回算，与手工核算（本方案 §1）一致（实测 7 个版本、合计中位 47.62h）；门禁侧：`perVersion: []` ⇒ exit 1（无数据即红）、只有历史欠账 ⇒ exit 0 并列出欠账、`since` 之后新首发的超时版本 ⇒ exit 1。**两段延迟（2026-10-22）**：合成 git 仓库 + 合成 packument + gh 桩跑了 4 条负向对照（26 条断言全过）—— ① 有 issue 且时间可算 ⇒ 检测 6.00h / 3.50h（标题里同时有 target 与地板两个版本号时，`dsh <版本>` 锚点取对）；② 无 issue ⇒ `detection=null` + 表格印「未检测到」（不是 0）；③ issue 标题版本 `7.7.7` 不在 packument ⇒ 明说"不匹配"且不参与任何一行；④ 同一版本多条 issue（跨两个 label）⇒ 取最早那条并打印取哪条。另断言：`--check` 在同样数据上只看 `total`（输出里不出现"检测"）、`--now` 垃圾 ⇒ exit 2、`--json` 旧字段与改造前逐值相同。**2026-10-24 追加（去 label 化 + 共享键）**：真实仓库实跑 ⇒ `0.2.1-rc.3` 检测 **0.10h**（#201，`07:54Z → 08:00Z`，17 条同版本 issue 全部无 label 也照样命中）；同一批夹具上新旧实现 A/B ⇒ ① 无 label ⇒ 新 0.10h / 旧「未检测到」；② `rc.30` 不匹配 `rc.3`（`versionRe`=false）；③ 3 条同版本 ⇒ 新取最早 #10（0.26h）/ 旧只看得到带 label 的 #11（1.09h），且**已关闭**的 #10 必须算。`test-automation-gates` watch 组 32 条断言全绿（行为未变） |
| §3.8 preinstalled-sync | ✅ 坏输入夹具：查询失败/返回值不是版本号 ⇒ 判红且不再造出假漂移；"本地领先"不再被降级同步 |
| A3 凭据能力探测（2026-10-24） | ✅ 真实仓库 + 项目 PAT：`建 canary` ✓（#221）、`改正文` ✗（`updateIssue` 403）⇒ 矩阵 1 ✓/1 ✗/3 ⊘、exit 1 —— 正是"能读不能写"的现场证据；紧接着再跑 ⇒ `复用 #221`、canary 计数不变（幂等）。**`last-ok` 只在全部必需能力通过后的末尾一步写**（失败运行不写）。内置 gh 桩（`npm run test:doctor`，**82 条断言**）：403 注入到"改正文" ⇒ 该项 ✗、exit 1、**PATCH 调用数 1**、其后**零写调用**；评论 403（改正文已成功）⇒ `last-ok` 不前进、心跳判据仍判陈旧；错误里塞假 token ⇒ 输出不出现原文且出现 `<redacted>`。变异自证：① 删掉"403 后阻断后续写" ⇒ 自测变红（期望 0 实际 6）；② 把 `last-ok` 挪回"改正文"处 ⇒ 自测在"失败运行不推进 last-ok"等 3 条变红（已固化进 gates 的 doctor 变异） |
| A5 反向心跳（2026-10-24） | ✅ 真实 canary #221（PAT 写不进 `last-ok`）+ `bootstrap-at` 距今 0.02h ⇒ **静默** exit 0；`--now` 推到 +51.4h ⇒ 判定陈旧、dry-run 打印"会评论 @karoc + 加 `priority:high`"。**只有全流程成功才写 `last-ok`**；失败运行后 `last-ok` 不前进 ⇒ 心跳判据按真实陈旧度报警（不许被伪造新鲜）。桩：`last-ok` 48h 前 ⇒ exit 3 + 评论 1 条 + label 已加 + 再跑不重复评论；5min 前 ⇒ exit 0 + 零评论 + 零 label；canary 缺失 ⇒ 创建 1 条且 exit 0；dry-run 零写；评论 403 的失败运行 ⇒ `last-ok` 不前进、`--heartbeat-check` 仍 exit 3。变异自证：把"新鲜"判据改成恒真 ⇒ 自测在"陈旧必须报警"处变红（期望 3 实际 0） |

## 7. 里程碑

- **M1（P0，1–2 天）**：probe 脚本 + watch job + tag 补派发。此时"发现"从小时~天压到 ≤15min，"发布"去掉手动派发。
- **M2（P1，2–3 天）**：`dsh:adapt` 一条命令 + canary 验收。此时顺利路径 ≈2h（§2）。
- **M3（P2，3–5 天）**：SLA 报表 + 预装插件自动同步 PR + （按决策）发布链路自动化。
- **M4（P3，可选）**：双地板矩阵 / alpha 节奏。

---

## 实施状态（2026-10-19 更新）

- **P0 已落地**：`scripts/dsh-compat-probe.mjs`（按 runtime 架构重写，校准 GREEN + 真实负向对照）、
  `.github/workflows/dsh-watch.yml`（cron `*/15`，开/更新 `dsh-upgrade` issue，零 secret）、
  `.github/workflows/tag-dispatch.yml`（cron `*/10`，补派发 `workflow_dispatch`，零 secret）。
- **P1 已落地**：`scripts/dsh-adapt.mjs`（一条命令，八步里第 1–7 步自动，第 8 步人工）+ `--canary` 本地硬门槛
  （读**两个日志**断言三个标记；`scripts/canary-accept.ps1` 与 CI canary 构建是设计稿，见 §3.5）。
- **P2 已落地**：`scripts/dsh-sla-report.mjs` + `dsh-sla-report.yml`（cron 每周一 01:00 UTC，报表与门禁分两步）、
  `preinstalled-sync.yml`（cron 每周一 02:00 UTC，三态判定 + 零 secret 开/更新 PR）。
- **P2+ 已落地（2026-10-20）**：`scripts/dsh-release-autopilot.mjs` —— 探测/适配/PR/CI/合并/版本 PR/派发构建/资产核验/issue 回帖
  一条命令；本机 systemd user timer 模板在脚本头注释。它是**本机编排**，不是 GitHub workflow。
- 三个自动化 workflow 都带 `workflow_dispatch`，可在 Actions 页手动触发做首次实跑验证（cron 只在默认分支生效）。
- **仍未做（P3，可选）**：§3.9 双地板测试矩阵、§3.10 alpha 跟踪降频。
- 清欠账侧：地板已到 `0.2.1-rc.2`，并已随 **v0.19.0** 发布（`CHANGELOG.md` 的 0.19.0 条目「地板抬到 0.2.1-rc.2」；
  `git show v0.19.0:src-tauri/resources/manager/server-manager.mjs` 的 `MIN_DSH_VERSION` 同值 ⇒ 随包副本一致）。

## 失败语义：已自动化（2026-10-19）—— 即 §0 的「合法失败出口」

决策 ③C：保留失败语义的措辞，并把它从「承诺」变成「必然发生」—— `scripts/dsh-watch.mjs`（cron `*/15`）
在**门槛已过而地板没动**时自动开/更新 blocker issue（label `sla-breach`，标题形如
`[SLA 未达标] dsh X 已发布 Nh（门槛 Mh），地板仍停在 Y`），正文直接给出 **§0 合法失败出口**要求的两件事
（写清具体 blocker + ETA；同时发一个保持旧地板的稳定版）。门槛：`latest` 6h 硬指标，预发布通道 24h
best-effort（可 `--sla-hours` / `--best-effort-hours` 覆盖，标题与正文都印实际门槛）。取不到该版本的上游
发布时间时 **fail-closed 记未达标**（`pubUnknown`）。**该行为不改变退出码**（红色仍然只代表 job 坏了 ——
与 SLA 流拆开信号的决策一致）。

> 叫法说明：`scripts/dsh-watch.mjs` 的注释里把这段写成「方案 §6」——**它指的是本文件 §0 的「合法失败出口」**
> （本文件 §6 是上面的负向对照表）。脚本注释不在本轮文档同步的写域内，故只在此处对齐口径。

## 全自动流水线（autopilot，2026-10-20）—— §3.2 / §3.6 的人工步骤收成一条命令

`node scripts/dsh-release-autopilot.mjs [--dry-run] [--stage1] [--require-canary] [--issue <n>] [--json [<file>]]
[--wait-minutes 40] [--poll-seconds 20] [--runtime <dir>] [--repo <owner/name>] [--assignee <login>]
[--canary-timeout 180] [--dev-log <session.log>] [--manager-log <runtime/manager.log>]`

### 默认行为（全自动）

检测到 npm 有比地板新的 `latest` ⇒ 一条路走到发布，不需要人：

1. **探测**：`dsh-watch --json --dry-run`（不带 `--dry-run` 它会开 issue；autopilot 只在需要时自己回帖）。
   无新版 ⇒ 打印「无需适配（当前无新版）」exit 0 —— 这是常态，不开单、不报红。
2. **适配**：`git clone --local --shared` 到 /tmp（从 **GitHub 远端 main** fetch/checkout，避免工作区分支/脏树影响）→
   用 `dsh-rehearse --scenario install --version <target> --keep --json <f>` 准备临时 runtime（复用它的安装机制，
   不重写）→ 在克隆里 `dsh-adapt --version <target> --runtime <tmp>`。任一步失败 ⇒ issue 回帖 + exit，
   **不 push、不留半截分支**（clone/临时 runtime 只写 /tmp）。
3. **推送 + PR**：只提交 `git status --porcelain` 里**已跟踪、非看板**的文件（`KANBAN.json` 与未跟踪文件跳过并打印）；
   push 到 `auto/dsh-<target>`（更新既有分支时 `--force-with-lease=refs/heads/auto/dsh-<target>:<远端 sha>`）；
   `gh pr create` 正文含 target、探针 verdict、门禁套数、适配耗时、触发 issue 与「autopilot 自动生成」声明。
4. **等 CI**：`gh pr view <n> --json statusCheckRollup` 轮询（默认 40 分钟）。**任一 check 明确失败 ⇒ 不合并**、
   回帖失败项、exit 1；超时/pending 同样不合并。`SKIPPED` / `NEUTRAL` 视为非失败（PR 事件下 windows/linux/release
   作业本来就 SKIP；把它们当失败会让任何 PR 永不可合并）。
   > 实测事实：本机 gh 2.45 的 `gh pr checks` **不支持 `--json`**（`unknown flag: --json`），所以用方案允许的
   > 等价形式 `gh pr view --json statusCheckRollup`，而不是硬编码一个在本机跑不了的命令。
5. **合并适配 PR**：先 `git fetch`/`gh pr view` 确认 `mergeable=MERGEABLE`（`CONFLICTING`/`DIRTY` 直接停，**不 force**）
   → `gh pr merge <n> --squash --admin` → 复核 `state=MERGED`。合并必须用本机项目 PAT：CI 的 `GITHUB_TOKEN`
   不能绕过分支保护。`GH_BIN` 缺省自动指向 `scripts/gh`。
6. **版本 PR**：等标题 `chore(main): release X.Y.Z` 的 open PR（≤15 分钟）→ `MERGEABLE` 后同样 `--admin` 合并。
   **bot PR 例外必须说清**：release-please 用 `GITHUB_TOKEN` 建 PR，GitHub 结构上不跑它的 workflow ⇒
   `statusCheckRollup` 恒空（实测 PR #178 = `checks: []`）。autopilot 不假装它绿：替代门禁是
   ① `MERGEABLE`；② 若真有 check 上报必须全非失败；③ head 必须是 `release-please--branches--*`；
   ④ `gh pr view --json files` 的变更必须全在写域白名单
   （`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` /
   `CHANGELOG.md` / `.release-please-manifest.json` / `KANBAN.json`）。任何一条不满足 ⇒ 不合并、回帖、exit 1。
7. **发版**：从版本 PR 标题解析 `X.Y.Z` → `vX.Y.Z`，等 Release 出现（≤10 分钟）→
   **该 tag 尚无构建运行才** `gh workflow run build.yml --ref vX.Y.Z`（`gh api .../runs?branch=<tag>` 的 `total_count`；
   已有运行不重复派发 —— build 的 `concurrency` 是 `cancel-in-progress`，重复派发会取消在跑的构建）。
   然后轮询 Release 资产数（≤30 分钟）：`>=3` 完成；`<3` 停在 ⑦、回帖、exit 1（不自动重试，避免抖动）。
8. **收尾**：在触发 issue 回帖结构化总结（target / 适配耗时 / 探针 / 门禁 / 适配 PR / 版本 PR / 版本号 / Release 链接 /
   资产 / 总耗时 / 是否已合并发布）。成功与失败评论都带内容摘要标记，同内容重跑不重复刷屏。

### 两个安全阀（外加 dry-run）

- `--dry-run`：只走 ① + 打印计划；不 clone、不写文件、不 push、不调 gh 写接口。无新版时只打印「无需适配」。
- `--stage1`：停在 ⑤ 之后（适配 PR 已合并，**不合并版本 PR**）。给「先建立信任」用。⚠️ 因为适配 PR 合并后
  地板已等于 target，`dsh-watch` 不会再报这个 target ⇒ **不要**指望去掉 `--stage1` 重跑就能续走 ⑥–⑧；
  这一点在成功回帖里明写。后续由人工合并版本 PR + 派发构建。
- `--require-canary`：⑤ 之前额外要求 `dsh-adapt --canary` 通过。默认**关**：canary 只认检查开始之后
  **新写入**的两个 dev 日志行 ⇒ 前提是 dev 壳在窗口期内**新启动**，无人值守的定时器给不了这个前提。
  开启时需要 `--dev-log` / `--manager-log` 指向真实 dev 壳；缺日志或 canary 断言失败 ⇒ 停在 ⑤ 之前、
  回帖「等真机验收」、**exit 3**（前置不满足，不是静默红也不是假绿），PR 保持打开。

### 幂等规则

- **同一 target 不重复开 PR**：按分支 `auto/dsh-<target>` + `gh pr list --state all --head` 判断。
  `OPEN` ⇒ 复用（跳过 ②③，直接等 CI）；`MERGED` ⇒ 复用（从 ⑥ 续走）；`CLOSED` ⇒ 视为无 PR，重新适配并更新分支。
- **同一 target 已发布**：最新 Release 正文记录的 dsh `latest`/`next` == target 且资产 ≥3 ⇒ 直接打印
  「已发布」exit 0；不再克隆/推送。
- **更新既有分支**：`--force-with-lease=refs/heads/auto/dsh-<target>:<远端 sha>`（只限这条自动化分支；
  远端被别人推过就失败而不是覆盖）。**绝不对 main/master 做任何写操作或 force**；不删任何非本次新建的分支。
- **构建派发**：`total_count == 0` 才派发；已有运行就只轮询资产，避免取消在跑的构建。

### 回滚

- **合并前**：全部副作用都在 `auto/dsh-<target>` 分支与 open PR；关 PR + 删分支即回滚（脚本自己只在「本次新建分支
  且 PR 创建失败」时删分支，且删前会再查一次 PR，避免并发误删）。
- **合并后**：按常规流程 revert 适配 PR / 版本 PR；autopilot 不做自动回滚，也不改写 main 历史。
- **不变量**：任何路径都不对 main/master 执行 push/force；不改仓库设置/分支保护/密钥；不动真实 runtime；不 kill 进程。

### 失败时人看到什么

- issue 回帖：**失败阶段 + 原因 + 已完成步骤 + PR 是否保持打开 + 重跑提示**（`<!-- dsh-autopilot-failure -->` 标记）。
- ④：逐条列出失败的 check 名与状态（如 `test=FAILURE`），不合并。
- ⑤：明确写 `mergeable=CONFLICTING/CONFLICTING…` 或 `mergeStateStatus=DIRTY`，不 force。
- ⑥：没等到版本 PR / 有失败 check / 变更超出 release-please 写域 / 冲突，分别有指名原因，不合并。
- ⑦：超时写明「资产仍 <3，去 Actions 看构建」，不自动重试。
- 退出码：0 完成（含无新版 / 已发布 / stage1）｜1 失败｜2 用法｜3 前置不满足（探测失败、runtime 装不上、
  canary 缺日志/未通过、仓库或 issue 解析失败）。

### 已知限制（诚实清单）

- **canary 默认关**：自动定时器无法保证「窗口期内新启动 dev 壳」；`--require-canary` 是给有人值守的窗口用的。
- **⑤ 之后中断不会自动续走**：适配 PR 合并后地板已等于 target，`dsh-watch` 不再报这个 target；release-please
  版本 PR 会留在 open（或已合并但构建未核验）。重跑脚本无法知道该续哪个 target ⇒ 需人工合并版本 PR / 派发构建。
  这是「可中断」的准确语义：中断前已 push 的分支/PR 不会被破坏，但后续阶段不保证自动恢复。
- **版本 PR 自动合并 = 零人工审阅**：替代审查只有「写域白名单 + mergeable + 非失败 check」，不读 diff 语义。
  这是默认全自动的代价；要保留人工闸门用 `--stage1`。
- **资产 <3 就停在 ⑦**：Windows 打包/Chocolatey 外部源 flake 会让构建失败；autopilot 不做无限重试，
  人工去 Actions 重跑后再重跑脚本（已发布检查会短路）。
- **`next`/alpha 不自动适配**：manager 的启动期安装目标 = `max(地板, registry latest)`，结构上装不到更高的预发布；
  按 §0 决策 ③C，预发布只开 issue。若 `latest` 本身是 rc（当前就是），仍按 latest 通道自动适配。
- **依赖本机项目 PAT**：`--admin` 合并只能由本机 `./scripts/gh` 做；CI 的 `GITHUB_TOKEN` 不行。PAT 不进 CI，
  零 secret 决策不变。systemd 运行环境还需要 SSH key（`git push`）与网络。
- **release-please 版本 PR 没有 check**：bot PR 在 GitHub 上恒为 `action_required`，autopilot 用上述白名单兜底；
  这不是"checks 绿"，日志与文档都如实写明。
- **未覆盖**：真实 GitHub 写操作（建 PR/合并/派发构建）在本机验收时用桩验证；真实合并需要真仓库写权限
  （本轮刻意没有对真实仓库执行任何写操作）。CONTRIBUTING 里「release PR 只能人工合并」的清单仍是**无 autopilot
  时**的手工路径（本轮写域不含 CONTRIBUTING，未改；autopilot 走同一把本机 PAT 的 `--admin` 并加了范围白名单）。

### 验证（2026-10-20 实跑，坐标）

- `node --check scripts/dsh-release-autopilot.mjs` ⇒ exit 0。
- **真实 dry-run**：`node scripts/dsh-release-autopilot.mjs --dry-run` ⇒ exit 0，打印
  「无需适配（当前无新版）」；运行前后 `git status --porcelain` 完全一致（零仓库改动）。
- **桩测 27 条断言**（/tmp 的 `GH_BIN` / `GIT_BIN` / `NODE_BIN` / `DSH_AUTOPILOT_WATCH_JSON` 注入，不碰真仓库）：
  - 正向 CI 绿 ⇒ exit 0；push 目标分支 `auto/dsh-0.2.2`；`pr create` 正文含 target 与 verdict；
    两次 `pr merge --squash --admin`（适配 PR 201 + 版本 PR 300）；`workflow run build.yml --ref v0.20.1`；
    成功回帖含 3 个资产；JSON 模式 stdout 可解析。
  - CI 红 ⇒ exit 1、无 `pr merge`、issue 回帖含失败 check。
  - CI pending + `--wait-minutes 0` ⇒ exit 1、无 `pr merge`。
  - PR 冲突（`CONFLICTING`）⇒ exit 1、无 `pr merge`、不 force。
  - 目标版本装不上（runtime 桩 exit 3）⇒ 停在 ②、exit 3、无 `git push`、issue 回帖含原因。
  - 重复运行（已有 `auto/dsh-0.2.2` 分支与 open PR）⇒ 不 `pr create`、不重跑 adapt/rehearse，直接合并既有 PR。
  - 已发布幂等 ⇒ exit 0、无写操作。
  - 默认 issue 查找：dsh-watch 已开的标题命中 ⇒ 复用它回帖，不新建；找不到 ⇒ 新建并在新 issue 回帖。
  - `--require-canary` 缺日志 / canary 失败 ⇒ exit 3、不合并、回帖「等真机验收」。
- `node scripts/test-automation-gates.mjs` ⇒ 104 条断言全部按预期（97 通过 / 0 失败 / 7 条 KNOWN_GAP），exit 0。

### systemd user unit（模板）

本仓库**不**改你机器上的 systemd；模板在 `scripts/dsh-release-autopilot.mjs` 头注释（service + timer）。
要点：`Type=oneshot`、`OnUnitInactiveSec=30min`（不会重入）、`Environment=GH_BIN=%h/dsh-desktop/scripts/gh`、
`TimeoutStartSec=2h`。启用由用户执行 `systemctl --user daemon-reload && systemctl --user enable --now dsh-release-autopilot.timer`。

## 演练覆盖：install / bump / upgrade（2026-10-24 补 upgrade）

**背景（为什么现在补）**：`scripts/dsh-rehearse.mjs` 原来只有 `install`（空 runtime → 全新安装）与 `bump`
（克隆里抬地板）两个场景，**已有 dsh 的「升级覆盖」分支没有任何演练** —— 而老用户每天走的正是它
（manager 启动期兼容闸门：已装 < 地板 ⇒ `installDshUpdate({ version: MIN_DSH_VERSION })`）。全新安装
通过不代表覆盖安装通过：pnpm 的 hoisted 安装**不会清理上一版留下的嵌套目录**，而 Node 解析嵌套副本优先，
旧内部包会让 dsh 启动即 `ERR_PACKAGE_PATH_NOT_EXPORTED`（黑屏）。所以这次补的是"升级后树干不干净"，
不是再装一遍。

**命令**：`node scripts/dsh-rehearse.mjs --scenario upgrade [--upgrade-from <old>] [--version <target>]
[--temp-base <dir>] [--fault nested-copy] [--keep] [--json <out>] [--warm-store <dir>] [--registry <url>]`
（`--upgrade-from` 默认 `0.2.1-alpha.5`；`--version` 默认壳地板）。步骤：
① 建 Windows `Local\Temp` 下的临时 runtime（与 `.pnpm-store` **同设备**，跨设备 exit 3；不静默降级）；
② 用随包 pnpm 绕过 manager 装旧版（`--node-linker=hoisted`，生产布局）；
③ 复用 `install` 场景（子进程 `--scenario install --runtime-dir <tmp>`）让 manager 走兼容闸门升到地板；
④ 四条断言：落地版本 == 目标；`find <tmp>/node_modules -path '*/node_modules/@deepseek-ai/dsh/package.json'`
计数 == 1 **且对真实 dev runtime 跑同一命令作对照**；探针 GREEN；真实仓库非记录层 `git status` 前后一致
+ 真实 runtime 关键文件指纹未变。
⑤ 负向自证：`--upgrade-from` 指 registry 里不存在的版本 ⇒ 装旧版一步明确失败；`--fault nested-copy`
在升级后的树里塞一份**同版本**嵌套副本（manager 的 stale 清理只删版本不一致的，所以它会留下）⇒ 断言 ②
必须红。两条都 exit 非 0；"没跑成"不会被报成通过。

**两条环境事实（2026-10-24 本机实测 pnpm 11.24；照配方跑之前必须知道）**：
1. 在**空 `node_modules`** 上直接 `pnpm add @deepseek-ai/dsh@<old> --store-dir <热 store>` 会因
   `ERR_PNPM_IGNORED_BUILDS` 以 **exit 1** 收场（版本仍然落地、`find` 计数 1）—— 即"pnpm add exit 0"这条
   配方事实在本机不成立。判成功必须看**落地版本 + `lib/bin.js`**，不能只看退出码（否则会把"装成了"报成失败）。
2. 同一次 `pnpm add` 会在 runtime 根目录生成 `pnpm-workspace.yaml`，内容是
   `allowBuilds: …: set this to true or false` 的提示桩；manager 的 `ensurePnpmWorkspace` 见文件已存在就
   不重写 ⇒ 随后 manager 的**升级安装**同样以 `ERR_PNPM_IGNORED_BUILDS` + exit 1 结束（树其实已到目标
   版本，但 `install-status error` 会让演练判红）。所以 upgrade 在装旧版**之前**按 manager 的
   `ensureRuntimeDir` / `ensurePnpmWorkspace` 写好 `.npmrc` / `pnpm-workspace.yaml`（放行名单**从 manager 的
   `NATIVE_BUILD_PKGS` 派生**，不抄第二份）—— 这同时更贴近真实 runtime（升级前本来就有这两份文件）。

**覆盖缺口（诚实清单）**：只走兼容闸门，不覆盖壳自更新与"registry latest > 地板"的更新检查路径；
旧版由脚本直接装，不能证明真实老用户机器上的每一处状态；与真实 runtime 共享 `.pnpm-store`（pnpm 只追加
内容寻址条目）；探针只判结构/兼容性，**不验证升级后 dsh web 能否真起来**（仍靠真机验收）。

## 凭据能力探测（A3，2026-10-24 落地）

**问题**：上游真发版那次，`dsh-watch` **能建 issue、不能改 issue** —— 项目 PAT 的仓库角色是 `admin=true`，
`gh api repos/karoc/dsh-desktop` 返回 `{"permissions":{"admin":true,"maintain":true,"pull":true,"push":true,"triage":true}}`
看起来"什么都能干"，但 `updateIssue` / `addLabelsToLabelable` 一律
`Resource not accessible by personal access token`。而本仓的去重、状态更新、assignee **全部依赖"维护"能力**
⇒ 只读检查给出的绿是**假绿**（取证见 `docs/2026-10-24-alerting-and-idempotency-patterns.md` §0.3）。

**为什么不能只读地问**（同上 §4）：
- `permissions.admin` 是**仓库角色**，不含 fine-grained PAT 的资源级授权（本次反例已证伪"admin ⇒ 可写"）；
- classic token 能读 `X-OAuth-Scopes` 响应头，fine-grained PAT **没有**这个头；
- GitHub 没有 `SimulatePrincipalPolicy` / `SelfSubjectAccessReview` 的等价物；
- 个人 fine-grained PAT 的**过期时间**没有可编程读取路径（组织级 PAT 端点只对 GitHub App 开放）。

⇒ 唯一可靠的判据是 **canary 写**：用真实凭据对一条专用 issue 做**可逆**写，失败就 fail-closed。

**实现**：`scripts/dsh-doctor.mjs`（`npm run dsh:doctor`；自测 `npm run test:doctor`）。canary 标题含
`[dsh-doctor] canary`，**首次自动创建、之后只复用**（全仓只允许一条；发现多条只用最小编号并提示人工关闭）。
矩阵前七行都是**真实探测**（不是 API 文档推断）：

| 行 | 怎么证明 | 可逆性 |
|---|---|---|
| 读 issue 列表 | `gh issue list --state all --limit 100`；命中上限会显式告警"可能截断" | 只读 |
| 建 canary | `gh issue create`（不存在时；已存在则复用，不重复建） | 建完即长期复用 |
| 改 canary 正文 | PATCH 正文（**只加探针行**）→ 读回复核 → PATCH 还原 | **净变化 0**；探针行不残留（残留时下轮自愈）。**这一步不动 `last-ok`** |
| 评论 | 已有探测评论 ⇒ `gh api PATCH .../issues/comments/<id>`；没有 ⇒ 建一条 | 全仓只维护一条，不刷屏 |
| 加 label | `label create --force` → `--add-label` → 读回 → `--remove-label` | 加完删掉 |
| 关闭 | `close` → 读回 CLOSED → `reopen` → 读回 OPEN | 关完重开；若卡在 CLOSED，下轮开跑先自愈重开 |
| 写心跳 `last-ok` | 以上**全部通过后**，末尾单独 PATCH 正文 `last-ok=<UTC ISO>` → 读回复核 | 任一步失败 ⇒ **不写**；写后读回失败 ⇒ 尝试回滚旧值（失败运行绝不伪造心跳新鲜） |

**纪律（都是写在脚本注释里的负面保证）**：任一写操作失败 ⇒ **立即停止后续写探测**（资源级权限是边界，
继续试只会重复 403 与次级限流），矩阵把后续行标 ⊘ 并写明原因；退出码非零 + 一句话结论 + 修复建议。
`last-ok` **只在全部必需能力通过之后的末尾一步写**，失败运行不推进它；诊断信息（`--json` 的 `lastFailAt` /
`lastFailReason`）与心跳判据分离，云端 `--heartbeat-check` **只读 `last-ok`**。
错误信息里的 token 一律打码（已知值按值替换 + token 形状兜底）。`--dry-run` 只读、**不写远端也不写心跳
文件**（写能力"未验证"，不能说成通过）；`--json <out>` 出机器可读矩阵（`--json -` 打 stdout）。仓库级
`permissions` 照常打印，但**只作对照**，不作判据。

**实测（2026-10-24，真实仓库 + 项目 PAT）**：
- 正向/负向同一次运行：`建 canary` ✓（**#221**）、`改正文` ✗（`failed to update
  https://github.com/karoc/dsh-desktop/issues/221: GraphQL: Resource not accessible by personal access token
  (updateIssue)`）⇒ **1 ✓ / 1 ✗ / 3 ⊘、exit 1**。与 §0.3 的日志一致 ⇒ "能读不能写"被复现。
- **2026-10-24 09:12Z / 09:13Z 复测（PAT 补上 Issues:write 后）**：真实仓库连续两次运行 ⇒ 7 项必需能力全 ✓、
  exit 0，`~/.dsh/heartbeat.json` 的 `lastOkAt` 与 canary 的 `last-ok` 两次都前进；随后用临时 gh 包装把
  "写评论"打成 403（**未改真实凭据**）⇒ 评论 ✗、exit 1，`last-ok` 保持 `09:13:39.262Z` 不动、本地
  heartbeat.json 不写；`--heartbeat-check --now <last-ok+27h>` 判"心跳陈旧（27.0h > 26h）"。
- 幂等：紧接着再跑一次 ⇒ `复用 #221（已存在，未新建）`；`gh issue list` 统计 canary 数量仍为 **1**。
- 负向（内置 gh 桩，`npm run test:doctor`，**82 条断言**）：403 注入到"改正文"⇒ 该项 ✗、exit 1、**改正文 PATCH
  调用数 = 1**、其后**零写调用**；错误里塞假 token ⇒ 输出**不出现**原文且出现 `<redacted>`；
  **评论 403（改正文已成功）⇒ `last-ok` 保持运行前的旧值、本地 heartbeat.json 不落盘、同一份状态跑
  `--heartbeat-check` 仍判陈旧 exit 3**（回归：旧实现会让失败运行把 `last-ok` 推进到"现在"，云端静默放过）。
- 变异自证（证明断言不是恒真）：① 删掉"403 后阻断后续写"⇒ 自测在 `403 之后没有任何写调用` 变红
  （期望 0 实际 6）；② 把"心跳新鲜"改成恒真 ⇒ 自测在 `陈旧 ⇒ exit 3` 变红（期望 3 实际 0）；
  ③ 把 `last-ok` 写回"改正文"处 ⇒ 自测在 `[2b] 失败运行不推进 last-ok` 等 3 条变红（实际 `last-ok` 被推进到
  本次 `--now`，`--heartbeat-check` 由 exit 3 变成 exit 0）；该变异已固化为 `test-automation-gates.mjs` 的 doctor 组第 2 条。

**未做 / 不可验证**：`评论` / `加 label` / `关闭` 三行在 2026-10-24 早先的 PAT 下**从未被探测到**（403 后按纪律停止）；
同日晚些 PAT 补齐 Issues:write 后已在真实仓库探测通过（见上）。PAT 过期时间读不到（见上）；
canary 是长期资产，需人别删（标题写明"勿删"，缺失时脚本会重建，`bootstrap-at` 保证不误报）。

## 反向心跳（A5，"没消息也报警"，2026-10-24 落地）

**问题**：`dsh-watch.service` 只有 `Restart=on-failure`，timer 只有 `OnCalendar`。机器关机、timer 被
disable、或脚本每轮都失败但 systemd 只负责重启时，**没有任何人会收到"没有告警"的告警**。这一层补的是
"任务是否按时发生"（Healthchecks.io 的 dead man's switch 语义），不是"任务失败时有没有报错"（同上 §2.3）。

**信号怎么过河**：云端看不到本机文件。所以本机 `dsh-doctor` **只有在全部必需能力（读/建/改/评论/label/
关闭）都通过之后**（末尾一步）才：① 写 `~/.dsh/heartbeat.json`（`{lastOkAt, version, didWrite}`）；
② 把 `last-ok=<UTC ISO>` 写进 canary 正文。**任一步失败 ⇒ 两者都不推进**（失败运行不写 `last-ok`，否则反向
心跳会替一个坏掉的链路作伪证）。诊断信息走 stdout / `--json` 的 `lastFailAt`/`lastFailReason`，**不参与心跳
判据**。云端 `.github/workflows/dsh-heartbeat-check.yml`（**每日 03:00 UTC + `workflow_dispatch`**）跑
`node scripts/dsh-doctor.mjs --heartbeat-check --grace-hours 26`，**只读 canary 正文的 `last-ok`**。

**双向判据（下表每一行都有桩覆盖；新鲜/宽限/陈旧三支另在真实 canary #221 上验过）**：

| canary 状态 | 判定 | 行为 | 退出码 |
|---|---|---|---|
| `last-ok` 距今 ≤ 26h | 心跳新鲜 | **静默**：不评论、不加 label | 0 |
| `last-ok` 距今 > 26h | 心跳陈旧 | 评论 `@owner` + 加 `priority:high` | **3（已报警）** |
| 从未写过 `last-ok`，`bootstrap-at` ≤ 26h | 宽限期（刚建/刚换载体） | 静默 | 0 |
| `bootstrap-at` 也 > 26h / 字段缺失 / 非法 / 时间在未来 | 无法判定 | 按陈旧报警（fail-loud） | 3 |
| canary 不存在 | 无载体 | **先创建**（写 `bootstrap-at`）**再判断** ⇒ 本次静默、不误报 | 0 |

阈值 **26h** = 24h 周期 + 2h 宽限。为什么不是 24h：Actions 的 `schedule` 官方明确不保证准时（可能延迟、
高负载时丢弃，见 §3），用 24h 会把"平台排队"判成"心跳死了"；26h 让一天一次的正常运行仍落在窗口内。
**改 cron 周期必须同时改 `--grace-hours`**（workflow 里显式传了 26，不是靠默认值）。

**降噪与信号分离**：同一段停更期只发一条报警评论（判据：上一条报警评论晚于最后一次成功心跳；label 每次
确保），`--repeat-hours`（默认 168h）兜"从未成功过"的情况，避免每天刷屏。**exit 3 是"报警"，不是"job
坏了"** —— 与 SLA 报表把"报表"和"门禁"拆成两步是同一原则：exit 1 只留给检查器自己坏掉（读不到 issue /
评论与 label 全部失败），这样红色才可以区分。

**实测**：
- 真实 canary #221（当时本机 PAT 写不进 `last-ok`）：`--heartbeat-check` 读到 `bootstrap-at` 距今 **0.02h**
  ⇒ **静默** exit 0 —— "canary 在但从未写入过心跳"没有被误报成"心跳死了"。
- **2026-10-24 复测（失败运行不得伪造新鲜）**：两次成功运行把 `last-ok` 从 `08:17:31.595Z` 推进到
  `09:12:57.854Z`、`09:13:39.262Z`；紧接着"写评论 403"的失败运行后 `last-ok` 仍是 `09:13:39.262Z`；
  `--heartbeat-check --now <last-ok+27h> --dry-run` 输出"判定：**心跳陈旧** —— last-ok 距今 27.0h > 26h"。
- 同一条 canary + `--now 2026-10-26T00:00:00Z` ⇒ `bootstrap-at 距今 51.42h > 26h` 判陈旧；`--dry-run` 打印
  "会评论 @karoc + 加 `priority:high` + exit 3"，**零写**。
- 桩（`npm run test:doctor`，82 条断言）：`last-ok` 48h 前 ⇒ exit 3、评论 1 条含 `@o` 与 `48.0h`、`priority:high` 已加、
  再跑一次**不重复评论**；`last-ok` 5min 前 ⇒ exit 0、零评论、零 label；canary 不存在 ⇒ 创建 1 条且 exit 0；
  dry-run 零写；**评论 403 的失败运行 ⇒ `last-ok` 不前进，心跳判据仍判陈旧（exit 3）**。

**未做 / 不可验证**：
- **本机 timer 未安装**：谁每天跑 `dsh-doctor` 由用户决定（systemd unit 属用户资产；模板做法同 autopilot
  头注释）。装上之前，云端读到的 `last-ok` 会停在最后一次手工运行 ⇒ 26h 后如实报警。
- **PAT 的 Issues:write 会漂移**：2026-10-24 早先实测 403，晚些修复后复测 7 项全 ✓；若它再丢失，
  `last-ok` 写不进去 ⇒ 本 workflow 会在 26h 后开始**每日报警**。这是**设计内的信号**（"写路径坏了"），
  不是误报；修 PAT 或临时 disable workflow，二者之一（**不要**手写 `last-ok` 绕过）。
- "评论 / issue 是否能真的叫醒人"取决于该账号的通知设置，本机不可验证（与 §0.4 的边界相同）。
- 只覆盖"canary 心跳"这一条链路：CI 侧 `GITHUB_TOKEN` 的心跳、字面意义的"runner 没跑"（需要第二检查者 /
  另一台机器）未做。
