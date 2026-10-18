# dsh 日常升级自动化方案（目标：官方发布后 6 小时内出稳定版）

Status: implemented（P0/P1/P2 已落地并在 main 运行；P3 可选，未做）
Date: 2026-10-17（实施状态最后更新 2026-10-19）
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
| 机械适配 + 开 PR | ≤ 15min | §3.4 一条命令；CI check+test ≈5min 与其重叠（**实际**：`dsh-adapt` 本机全链 ≈100s，含 23 套门禁） |
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
- 去重：按 issue **标题里版本号的词边界**匹配（`gh issue list --json title,number --limit 100` 取回后在 node
  里过滤）—— `contains("0.2.1")` 会命中 `0.2.1-rc.2` 的单子，必须词边界；
- 取不到 npm 发布时间 ⇒ **fail-closed 记未达标**（`pubUnknown`，"量不出来"不等于"达标"）；npm packument
  直连与代理都失败 ⇒ 非零退出（真故障）；其余情况退出码恒 0（红色只代表 job 坏了）。

**原稿承诺但未实现（设计稿）**，逐条说明实际是什么：

- ❌ 状态文件 `scripts/fixtures/dsh-upstream-state.json`（"已处理到哪个版本/verdict/issue 号"）—— **不存在**；
  去重完全靠 issue 标题匹配（无状态、幂等）。
- ❌ 在 watch 里跑 §3.1 的 probe 并分 green/yellow/red 三态 —— **没做**；watch 只判"比地板新"，
  probe 是独立步骤（`dsh:adapt` 第 6 步或手动跑）。**结构原因**：`dsh-compat-probe.mjs` 需要
  `--runtime <已装候选版本的目录>`（无它 exit 2），而 watch 的 runner 上只有一份 checkout、没有 runtime。
- ❌ `green` 自动建**适配 PR 骨架** —— **没做**（刻意的：脚本不建 PR，对外副作用留给人和产品流程）。
- ❌ `red` 打 `blocked-upstream` 标签 —— **没做**；全链路只有两个 label：`dsh-upgrade` 与 `sla-breach`。

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
7. 全量门禁（按 `package.json` 的 `test` 链逐条直接跑 `node`；当前 23 条全是 node ⇒ 23/23 真跑。非 node 条目
   本机会**跳过并逐条列出**，默认容忍、`--strict-chain` 把跳过也算失败）；
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
- ⚠️ `--dry-run` 只跳过第 2/3/4 步（写文件那几步），**第 5/6/7 步照跑**；也正因第 4 步被跳过，
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
- release PR 的合并：**保持 `--admin` 人工合并**（自动化前需决定的三条选项里选③）。它是"发版前的最后一道闸"，且 6h 预算里只占几分钟。

**3.7 `scripts/dsh-sla-report.mjs` + 定期 job（让 SLA 可证明）** —— **已落地**

`node scripts/dsh-sla-report.mjs [--json <out>] [--issue] [--check <json>] [--recent 3] [--since 2026-10-19] [--registry <url>]`

- **取数（实际）**：npm registry 的 `time`（上游发布时间，经 `curl`；`--registry` 可指向 stub）+ `gh api
  repos/<repo>/releases?per_page=100`（我们的发布时间）。**配对规则是"tag 树里的地板"**：
  `git show <tag>:scripts/server-manager.mjs` 读 `MIN_DSH_VERSION` —— tag 树里读不到（历史早期 tag）则跳过并给出
  理由，不猜。按 **dsh 版本**聚合（同一地板被多个壳版本携带时只取**最早**那次 Release），全量明细留在 JSON 里。
- **输出（实际）**：Markdown 报表（每对：上游发布 / 地板提交 / 我方发布 / 适配段 / 发布段 / 合计 / ≤6h），
  加统计行（已量出版本数、合计中位/最好/最差、达标率、适配段中位、发布段中位、门禁口径）。
  ❌ 原稿的 **p90 没实现**（只有中位/最好/最差）；❌ "落到 `docs/dsh-upgrade-sla.md`（自动生成，进仓库，可 diff）"
  **没做，且 `docs/dsh-upgrade-sla.md` 不存在** —— 实际去处是：step summary + `--issue` upsert 到 `sla-report`
  issue + 可选 `--json <out>`。
- **判据（实际）**：报表由 CI 生成（不许手填）。❌ 原稿的"连续两个 stable 版本无记录 ⇒ job 失败"**没实现**；
  实际门禁口径见下（**无数据即红** + **只判 since 之后首发**）。
- **门禁口径（2026-10-19 两条修正，两个方向都曾失真）**：① **无数据即红** —— 报表缺 `perVersion` 或为空数组
  ⇒ exit 1（旧实现"最近 0 个版本中 0 个超 6h ⇒ exit 0"是假绿：量不出来 ≠ 达标）；② **历史欠账不参与退出码** ——
  只判 `--since`（默认 `2026-10-19`，方案落地日）之后**上游首发**的版本，欠账仍在报表里逐行显示并单列一行
  说明。真实数据实测：7 个已量出版本全是历史欠账（0/7 达标、合计中位 47.62h），`--check` **exit 0** 并列出
  7 条欠账；`since` 之后新首发的版本超时仍会 exit 1。③ `--recent 3` 只看该范围内的最近 3 个。
- ⚠️ **展示口径的一个已知缺陷（2026-10-19 复核发现，未修）**：报表三个时间戳列的时区口径**不统一**。
  `上游发布` 是 npm 原样 ISO（`…Z`）；`地板提交` 是 `git log --format=%cI` 的提交**本地时区**再 `slice(0,16)`
  截到分钟（偏移被截掉）；`我方发布` 是 Release `publishedAt`（UTC）再截到分钟。实测 v0.19.0 那行印成
  「地板提交 `2026-10-18T03:39` / 我方发布 `2026-10-17T19:40`」，看着像地板提交晚了 8 小时，其实两者相差
  **54 秒**（JSON 里是 `floorCommitAt=2026-10-18T03:39:11+08:00`、`publishedAt=2026-10-17T19:40:05Z`）。
  要看绝对时间以 `--json` 里的原值为准；修展示口径要改 `scripts/dsh-sla-report.mjs`（本轮文档同步的写域不含脚本）。

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
| §3.2 watch | ✅ 本地桩掉 registry（`--registry` 指 stub，无需改仓库代码）⇒ 走完开 issue 的路径；同一版本跑两次 ⇒ 只开一次（**按标题词边界**，非状态文件）。未做：`green ⇒ 自动建 PR` / `red ⇒ blocked-upstream`（见 §3.2 的设计稿标注） |
| §3.3 tag-dispatch | ✅ 服务端判据实测：`total_count(v0.11.0)=1`，而旧的"最近 100 条运行"筛出 `0`（这正是"每 10 分钟重复派发"的成因）。未做：真删一条 build run 记录来验证补派发（需要写操作，留给人工） |
| §3.5 canary 验收 | ⚠️ 未做（`scripts/canary-accept.ps1` 不存在）。已做的等价验证：`dsh:adapt --canary` 对**空闲的** dev 实例必须红，且错误信息指名"哪个标记来自哪个文件"（实测两个日志路径都解析到、新增字节数 session 0 / manager 0 ⇒ 红） |
| §3.7 SLA 报表 | ✅ 用历史配对数据回算，与手工核算（本方案 §1）一致（实测 7 个版本、合计中位 47.62h）；门禁侧：`perVersion: []` ⇒ exit 1（无数据即红）、只有历史欠账 ⇒ exit 0 并列出欠账、`since` 之后新首发的超时版本 ⇒ exit 1 |
| §3.8 preinstalled-sync | ✅ 坏输入夹具：查询失败/返回值不是版本号 ⇒ 判红且不再造出假漂移；"本地领先"不再被降级同步 |

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
