# dsh 日常升级自动化方案（目标：官方发布后 6 小时内出稳定版）

Status: proposed（待用户审批后实施）
Date: 2026-10-17
相关：`CONTRIBUTING.md`、`.dsh/skills/dsh-desktop-shell-dev/SKILL.md`、`.dsh/skills/dsh-preinstalled-plugin-sync/SKILL.md`、
`scripts/server-manager.mjs` 的 `MIN_DSH_VERSION` 注释（历次适配的现场记录）、
`.agents/notes/implemented/process/2026-09-22-release-pr-gate-and-asset-dispatch.md`

## 0. 目标、判据与"达标"的定义

**目标**：上游 `@deepseek-ai/dsh` 发布后 **6 小时内**，我们的壳产出**稳定版**（三平台资产就绪），且**壳内预装插件与新的 dsh 地板同批适配**。

**SLA 的可测量定义**（不定义清楚就没法证明，见 CONTRIBUTING 的"引用绿态必须带坐标"）：

| 项 | 定义 |
|---|---|
| 起点 | npm `@deepseek-ai/dsh` 的 **stable** 版本发布时刻（registry 的 `time[version]`；stable = `dist-tags.latest`） |
| 终点 | 我们对应壳版本的 GitHub Release `publishedAt`（含 `*_x64-setup.exe` / `AppImage` / `deb`） |
| 达标 | 终点 − 起点 ≤ 6h，且预装插件与地板**同一批**落地（见 §5 的硬规则） |
| 合法失败出口 | 6h 内**要么**出支持新版的稳定版，**要么**：① 开一份公开 issue（含 probe 报告的精确 blocker + ETA）；② 发一个**保持旧地板**的稳定版（hold 策略，用户不受影响）。二者都算"这条 SLA 有交代"，但**月度达标率按前者计** |
| 通道 | **待用户确认**（见 §1.1b）：建议 stable 走 6h；`next`/alpha 走 best-effort ≤24h 且只做 probe 不开自动 PR。注意现状：我们的地板 **高于** npm `latest`，所以"官方发布"到底指哪个通道必须先定 |

**月度判据**：自动生成的 SLA 报表（§3.7）里，stable 版本的 `≤6h` 占比 ≥ 90%，且没有任何 stable 版本"静默错过"（既不发布也不开 blocker issue）。

## 1. 现状与基线（为什么要做）

### 1.1 实测滞后（逐 tag 配对，6 个样本全有提交证据）

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

### 1.1b 一个必须先定的问题：「官方发布」指哪个通道？

实测：我们的地板 `0.2.1-alpha.3` **高于** npm `latest`（仍是 `0.2.0-rc.2`），而 `next=0.2.1-rc.1`。
所以 SLA 起点必须先定义，三种口径的含义完全不同：

| 口径 | 对谁计时 | 现状 |
|---|---|---|
| A. `dist-tags.latest`（稳定通道） | 只对"毕业到 latest"的版本计时 | 6 个样本里只有 `0.2.0-rc.2` 算 ⇒ 唯一真实稳定滞后 = **144.6h** |
| B. 任何 `next`/`alpha` 预发布 | 对每个预发布都计时 | 当前已积压 3 个（alpha.4/alpha.5/rc.1） |
| C. 混合（推荐） | `latest` 走 6h 硬 SLA；`next`/`alpha` 走 best-effort ≤24h 且**只做 probe 不开自动 PR** | 与 §0 的现有定义一致 |

**我建议 C**：跟预发布是必要的（否则每次"毕业"都等于一次性处理 3 个版本的变更），但不该用 6h 硬指标绑架它。

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
| 机械适配 + 开 PR | ≤ 15min | §3.4 一条命令；CI check+test ≈5min 与其重叠 |
| 本机/CI 真机验收 | ≤ 60min | §3.5 canary 并行构建（CI windows 11min）+ 自动验收脚本 ≤10min；留一次返工 |
| 发布 | ≤ 45min | §3.3 自动补派发（≤10min 延迟）+ 构建 11min + merge/资产核验 |
| 预装插件同步 | 与上面重叠 | §3.8 在 adapt 里同批完成（硬规则：地板与 bundle 同批落地） |
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

**3.2 `.github/workflows/dsh-watch.yml`（cron `*/15 * * * *`，把①自动化）**

- 查 registry `dist-tags` 与 `time`；与仓库里的状态文件 `scripts/fixtures/dsh-upstream-state.json`（记录"已处理到哪个版本/哪个 verdict/issue 号"）比对；
- 有新版本 ⇒ 跑 §3.1 的 probe ⇒
  - `green`：自动建**适配 PR 骨架**（§3.4）+ 开 issue 记录 SLA 起点；
  - `yellow`：开 issue，正文贴 probe 报告 + 待办清单（人/agent 接手）；
  - `red`：开 issue 并打 `blocked-upstream` 标签（走合法失败出口）。
- **同一版本只开一次**（状态文件去重）；网络失败 ⇒ job 失败（不静默），因为"没探测到"与"没发布"必须可区分。

**3.3 `.github/workflows/tag-dispatch.yml`（cron `*/10 * * * *`，去掉手动派发）**

- 列出所有 `v*` tag，与"已有 build run 的 tag"做差集；对没有构建记录的 tag 执行 `gh workflow run build.yml --ref <tag>`（**用 GITHUB_TOKEN 就够** —— 这是 workflow_dispatch，不是 tag push，不受递归保护限制）；
- 顺带修正 `release-please.yml` 里那句不符实的注释（文档 ↔ 行为纪律），并把"为什么需要这个补派发"写在那句旁边。

### P1 —— 本周

**3.4 `scripts/dsh-adapt.mjs`（把③变成一条命令）**

`npm run dsh:adapt -- <version>` 做机械部分：
1. 抬 `MIN_DSH_VERSION`（**两份副本**：`scripts/server-manager.mjs` + `src-tauri/resources/manager/server-manager.mjs`，随后跑 `test-copy-consistency.mjs`）；
2. 在 `MIN_DSH_VERSION` 注释块**追加一行适配记录**（版本 + probe verdict 摘要 + 日期）—— 这条注释是历次适配的现场记录，必须继续保持自动追加，不要退化；
3. `--update-fixture --runtime <dir>` 重采 patch-id 夹具（需要一个装好新版的 runtime，脚本里自动 pnpm 装到临时目录）；
4. 预装插件：跑 `audit-preinstalled.mjs`，对"需要更新"的包调 `sync-preinstalled-plugin.mjs`，并把四个包的 peer 地板与新 dsh 对齐（**同批**，见 §5 硬规则）；
5. 跑 `npm test`（23 套）；
6. 生成 PR 正文（probe 报告 + 变更摘要 + 验收清单），推分支。

**3.5 canary 验收管线（把④压缩）**

- `dsh-adapt` 路径触发 CI 的 **canary 构建**（windows job，仅此路径；为不破坏"dev 构建不上 CI"的日常约定，用独立 workflow + 手动/被 watch 触发）；
- 本机脚本 `scripts/canary-accept.ps1`：静默安装 canary → 启动 → 断言（chrome 三上报 `inject/mounted/ready` + `digest-late`、桥 `/shell/state`、四个预装插件在页面里挂载、会话存储可读、无 `fatal`）→ 产出 verdict 与证据目录；
- 失败即把证据贴回 PR（人不再需要手工截图）。

### P2 —— 本月

**3.6 发布自动化（把⑤的人手去掉）**——需要用户决策，两个选项（**注意：这里有历史否决记录，不能默认推翻**）：

> 机制事实（实测，比注释更硬）：release-please 的 bot PR 其 workflow run 状态**恒为 `action_required`**
> （GitHub 要求人工批准 bot PR 的 workflow）⇒ `check`/`test` **永不上报** ⇒ 分支保护恒 `BLOCKED` ⇒
> 唯一合并路径就是 `--admin`；而 `release` job 的 `if: startsWith(github.ref,'refs/tags/v')` 因
> **API 创建的 tag 不触发 workflow** 而永不自动跑（实测 v0.18.x 每个 build run 的 `event` 都是
> `workflow_dispatch`，无一 `push`；v0.11.0 的 Release 因此 `assets: []`）。
> ⚠️ 这两步要自动化都必须引入 PAT/App token 或改 Actions 策略 = **凭证面扩张**，而
> `.agents/notes/implemented/process/2026-09-22-release-pr-gate-and-asset-dispatch.md` 已**明文否决过一次**。
> 方案若要碰，必须在决策里**显式推翻并写明理由**，不能顺手改掉。
- 选项 A（推荐）：加一个 `RELEASE_PLEASE_TOKEN`（fine-grained PAT）给 `release-please` 用 ⇒ tag 由 PAT 创建、**能触发** `build.yml`，链路闭环（需要在仓库 Settings 加 secret：**这是用户动作**）；
- 选项 B（零 secret）：维持 §3.3 的定时补派发（≤10min 延迟）。
- release PR 的合并：现在是 `--admin` 人工合并。自动化前需决定（① 也交给 PAT 自动合并；② 给 `chore(main): release` 类 PR 放宽 required review；③ 保持人工）。**默认保持人工**，因为它同时是"发版前的最后一道闸"，且 6h 预算里它只占几分钟。

**3.7 `scripts/dsh-sla-report.mjs` + 定期 job（让 SLA 可证明）**

- 取数：npm registry（上游发布时间）+ `gh release list`（我们的发布时间）；配对规则：壳版本 CHANGELOG 里出现的 `dsh <version>` 行（release-please 的正文已含）→ 落到 `docs/dsh-upgrade-sla.md`（自动生成，进仓库，可 diff）；
- 输出：每对 `滞后 h`、中位数、p90、达标率；
- 判据：报表由 CI 生成（不许手填）；**连续两个 stable 版本无记录 ⇒ job 失败**（防"报表烂掉没人看"）。

**3.8 预装插件自动同步 job**

扩展 `audit-preinstalled.mjs`：cron（每天 1 次）→ 发现"npm latest 领先于随壳版本"⇒ 自动开 PR（走 §3.4 的同一套机械流程 + 门禁）。与 §3.2 共用状态文件，避免同一天开两份 PR。

### P3 —— 可选/降级预案

**3.9 双地板测试矩阵**：同一壳版本同时验"地板版 dsh"与"最新版 dsh"（用户可能停在地板）。触发条件：连续两次抬地板后老版本用户占比仍不可忽略。
**3.10 上游 alpha 跟踪节奏**：把 `next` 的探测频率降到每天 1 次并只做 probe 不开 PR（避免为 alpha 花掉 stable 的预算）。

## 4. 需要用户决策的三件事

1. **canary 构建是否上 CI**（打破"dev 版本地构建"的约定，仅限适配路径）—— 收益：验收与 CI 并行，省 10–20min；代价：windows 构建额度。
2. **发布链路用选项 A（加 PAT secret）还是选项 B（定时补派发）** —— A 更快更干净但需要你在仓库里加 secret；B 零配置、多 ≤10min 延迟。
3. **6h SLA 的失败语义** —— 是否接受"hold 旧地板 + 公开 blocker issue"作为达标（我建议接受，否则遇到上游破坏性变更时 SLA 会变成"假装达标"）。

## 5. 硬规则与诚实边界

- **地板与预装 bundle 必须同一批落地**（来源：`MIN_DSH_VERSION` 注释里的历史事故——旧 bundle 用了新版已删除的图标名，单独抬地板会让它们在新运行时上崩）。自动化里表现为：§3.4 的第一步与第四步**在同一个 PR**，且 `test-plugin-dsh-compat.mjs` 必须绿。
- **破坏性变更不自动适配**：存储代换代、客户端插件 API 重写、overlay 目标行消失 ⇒ probe 判红 ⇒ 走合法失败出口。自动化能保证的是"**15 分钟内知道红在哪、红到什么程度**"，不是"什么都能自动改"。
- **不能从 CI 派发 agent**（本仓没有 agent runner）⇒ 黄/红处置仍需一次会话介入；方案把它压成"一条命令 + 一份自动生成的报告"，而不是"人肉复现"。
- **不许跳过门禁直发**（含"为了赶 6h 而 --admin 绕过 check"—— 本方案的实施里我本人犯过一次，已记录）。
- **不做**：自动改上游代码、自动合并 red 判定的 PR、为 alpha 版本开自动 PR。

## 6. 每个机制怎么证明它真的работает（负向对照）

| 机制 | 负向对照 |
|---|---|
| §3.1 probe | 用**历史版本**跑（如 `0.2.0-rc.1`）⇒ 必须报出与当年人工核对一致的差异（锚点）；再人为删掉 overlay 目标行 ⇒ 必须 red |
| §3.2 watch | 本地桩掉 registry（改 dist-tags 返回值）⇒ 必须开 issue；同一版本跑两次 ⇒ 只能开一次 |
| §3.3 tag-dispatch | 删掉某 tag 的 build run 记录 ⇒ 必须 ≤10min 自动补派发 |
| §3.5 canary 验收 | 装一个**故意坏**的 canary（去掉 chrome 注入）⇒ 必须红并贴证据 |
| §3.7 SLA 报表 | 用历史配对数据回算，与手工核算（本方案 §1）一致；连续两个版本无记录 ⇒ job 必须失败 |

## 7. 里程碑

- **M1（P0，1–2 天）**：probe 脚本 + watch job + tag 补派发。此时"发现"从小时~天压到 ≤15min，"发布"去掉手动派发。
- **M2（P1，2–3 天）**：`dsh:adapt` 一条命令 + canary 验收。此时顺利路径 ≈2h（§2）。
- **M3（P2，3–5 天）**：SLA 报表 + 预装插件自动同步 PR + （按决策）发布链路自动化。
- **M4（P3，可选）**：双地板矩阵 / alpha 节奏。

---

## 实施状态（2026-10-18 更新）

- **P0 已落地**：`scripts/dsh-compat-probe.mjs`（按 runtime 架构重写，校准 GREEN + 真实负向对照）、
  `.github/workflows/dsh-watch.yml`（cron `*/15`，开/更新 `dsh-upgrade` issue，零 secret）、
  `.github/workflows/tag-dispatch.yml`（cron `*/10`，补派发 `workflow_dispatch`，零 secret）。
- 二者都带 `workflow_dispatch`，合并后可在 Actions 页手动触发一次做首次实跑验证（cron 只在默认分支生效）。
- 仍未做：P1（`dsh:adapt` 一条命令 + canary 验收）、P2（SLA 报表 + 预装插件自动同步 PR）。
- 清欠账侧：地板已到 `0.2.1-rc.2` 并随 **v0.19.0** 装入正式版（随包 manager 地板已核验）。

## §6 失败语义：已自动化（2026-10-19）

决策 ③C：保留 §6 的措辞，并把它从「承诺」变成「必然发生」—— `scripts/dsh-watch.mjs`（cron `*/15`）
在**门槛已过而地板没动**时自动开/更新 blocker issue（label `sla-breach`，标题形如
`[SLA 未达标] dsh X 已发布 Nh（门槛 Mh），地板仍停在 Y`），正文直接给出 §6 要求的两件事
（写清具体 blocker + ETA；同时发一个保持旧地板的稳定版）。门槛：`latest` 6h 硬指标，预发布通道 24h
best-effort。**该行为不改变退出码**（红色仍然只代表 job 坏了 —— 与 SLA 流拆开信号的决策一致）。

另两项决策（同日确认）：① 发布链路**维持零 secret**（人工 approve 一次 + `tag-dispatch` 补派发），
不引入长期 PAT；② canary **不进 CI**（CI 是 Linux、壳是 Windows 桌面应用），保持本地
`dsh:adapt --canary` 并作为流程硬门槛。
