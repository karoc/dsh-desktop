---
name: dsh-upstream-adaptation
description: "Use when an upstream @deepseek-ai/dsh release must be detected, adapted and shipped as a new dsh-desktop shell release（6h SLA 流水线），或当这条流水线卡住/报错时要定位。覆盖双心跳（本机 systemd user timer 为主、GitHub cron 兜底）、dsh-watch / dsh-rehearse / dsh-adapt / dsh-compat-probe / dsh-release-autopilot / dsh-sla-report 的逐条命令、探测 → 适配 → PR → CI → --admin 合并 → release-please 版本 PR → 派发构建 → 资产核验 → issue 回帖 的完整链，以及「症状 → 判据 → 处理」排错表。触发词：dsh 上游发版、抬地板、适配新版 dsh、autopilot、6h SLA、心跳没跑、SLA 报表、rehearse、compat-probe、资产核验。不要用于：壳自身功能开发（用 dsh-desktop-shell-dev）、Windows 装机排障（用 windows-desktop-shell-debugging）、预装插件版本同步（用 dsh-preinstalled-plugin-sync）。"
---

# dsh 上游适配与发版技能（探测 → 适配 → PR → 发版）

来源：2026-10-17 起的自动化方案（`docs/2026-10-17-dsh-upgrade-automation-plan.md`）+ 2026-10-20/21 的
autopilot、双心跳、CI 假绿三批交付。**决策与其理由不在这里重复**，见文末「相关决策记录」；
本技能只回答「现在该敲哪条命令、红绿灯怎么读、卡住了往哪看」。

## 1. 这条流水线是什么（30 秒版）

```
上游 @deepseek-ai/dsh 发新版
  │
  ├─[心跳①本机] systemd --user timer：dsh-watch.timer(*:0/10) → dsh-watch.mjs
  │              dsh-tagdispatch.timer(*:0/10) → gh workflow run tag-dispatch.yml
  │              dsh-autopilot.timer(*:3/10) → dsh-release-autopilot.mjs（整条链）
  ├─[心跳②云端兜底] GitHub Actions schedule：dsh-watch.yml(*/15)
  │                  tag-dispatch.yml(*/10)   实测抖动 2–5h，只在机器关机时顶班
  │
  ▼
dsh-watch 比较「壳地板 MIN_DSH_VERSION vs npm dist-tags」→ 开/更新 issue（dsh-upgrade / sla-breach，
          labels 含 priority:high，assignee + 正文 @mention 双保险）
  ▼
dsh-rehearse 准备临时 runtime（真装目标版本）→ dsh-adapt 在 /tmp 克隆里抬地板 + README + patch 夹具
         + 预装 peer 兼容 + 探针 + 全量门禁（任一步失败立即停，不落半截分支）
  ▼
push auto/dsh-<target> → PR → CI（check/test）→ gh pr merge --squash --admin（本机项目 PAT）
  ▼
release-please 版本 PR `chore(main): release X.Y.Z` → 同样 --admin 合并（该 PR 恒无 checks，见 §6.7）
  │  （2026-10-30 起）autopilot 在「本轮无新版 / 预发布通道跳过」时也检查**停摆的版本 PR**：
  │  有 open 的 `chore(main): release X.Y.Z` ⇒ 同样合并 → 派发构建 → 核验资产（`--no-release-resume` 关）
  ▼
tag vX.Y.Z → Release 无资产 → gh workflow run build.yml --ref vX.Y.Z → 轮询 Release 资产 ≥3
  ▼
在触发 issue 回帖结构化总结（target / 耗时 / 探针 / 门禁 / PR / 版本 / 资产）
```

**四个必须记住的事实**（否则会做错判断）：

1. **`--admin` 不是特权滥用，是唯一可行路径**：CI 的 `secrets.GITHUB_TOKEN` 不能绕过分支保护；
   release-please 的 bot PR 在 GitHub 上恒为 `action_required`，`check`/`test` **永不上报**，分支保护恒
   `BLOCKED`，普通 `gh pr merge` 只会回 `base branch policy prohibits the merge`。
2. **run 级 success ≠ job 级 success**：`continue-on-error` 会把 job 失败吞进 run 级绿（`linux-smoke`
   2026-08-20 起这样假绿过两个月，已删该开关）。判「过没过」只看 `gh run view <id> --json jobs`。
3. **6h SLA 判的是 `total`（上游发布 → 我方 Release publishedAt）**，但它被拆成两段读数：
   **检测**（上游发布 → 首次开 issue）与 **适配**（地板提交 → 我方发布）。检测段依赖「机器开着 +
   心跳在跑」，是平台属性、**常为 unknown**；报告里 `null` 就写「未检测到」，**绝不当 0**。
4. **`--version` 在 rehearse 里是「期望值」不是「注入开关」**：manager 启动期安装的目标恒为
   `max(壳地板, registry latest)`，落地版本不符只会报 `MISMATCH` + exit 1，不会强行判绿。

## 2. 前置与凭据（先读，否则会用错 token）

| 事项 | 做法 |
|---|---|
| gh 命令 | **一律 `./scripts/gh <args>`**（注入 `~/.config/gh-dsh-desktop/token`，仓库级 PAT）。**不要**用裸 `gh`：它读全局 `~/.config/gh/hosts.yml` 里的另一个 token，PR/Actions 权限不同，历史上已因此出错 |
| 跑脚本 | 脚本走 `GH_BIN`（缺省 `gh`），必须显式 `GH_BIN=$PWD/scripts/gh`；autopilot / sla-report 的缺省已指向 `scripts/gh`，但别的脚本没有 |
| git push | 走 SSH（`git@github.com:…`），与 token 无关；systemd 运行环境要能读 SSH key |
| token 本身 | 等同 bearer 凭据：不得写进看板卡 / Note / 提交 / 对话，输出里整段打码 |
| direnv | `.envrc` 只在交互 shell 生效；**Agent 的 bash 不加载 direnv**，必须显式 `./scripts/gh` |
| 权限自证 | 别信 UI。用「故意非法目标」探针：建 PR 用不存在的 head ⇒ 有权限 422 / 无权限 403；dispatch 不存在的 workflow ⇒ 有权限 404 / 无权限 403 |
| 能力自证（issue 写） | **只认 canary 写**：`npm run dsh:doctor`（采用清单 A3）用真实凭据对专用 canary issue 做一次**可逆写**，输出七行能力矩阵（第 7 行是本地 PAT 过期元数据，**不参与退出码**）；必需能力缺失 ⇒ **exit 1**。`--dry-run` 只读（写能力**未验证**）。`admin=true`、`/repos` 的 `permissions`、UI 上的勾选**都不是判据**（GitHub 没有"模拟写"接口） |
| 过期（A4） | 过期时间**读不到**（`GET /user` 不返回 `expires_at`）⇒ 轮换 token 的**最后一步**必须 `node scripts/dsh-token-meta.mjs set --expires YYYY-MM-DD`。检查：`node scripts/dsh-token-meta.mjs check`（>14 ok / ≤14 warn / ≤7 urgent / ≤1 critical / 已过期；**只有后两级非零**）。未录入 = 未知（exit 0，不是故障）。详见下方「凭据过期：录一次，之后由工具查」 |

### 凭据过期：录一次，之后由工具查（A4）

fine-grained PAT 的**过期时间没有可读的 REST 端点**（`GET /user` 只返回身份字段；classic token 能读
`X-OAuth-Scopes`，fine-grained PAT 连这个头都没有）⇒ "这张 token 哪天失效"机器拿不到，只能在**创建/轮换时
人工录一次**，之后由工具检查。**不录 = 未知**（不是"永不过期"，只是没人知道）。

```bash
# ① 创建/轮换 token 后立刻录（这是轮换流程的一部分，不是可选步骤）
node scripts/dsh-token-meta.mjs set --expires 2027-04-01 --note "创建于 2026-10-24，PR+Actions"
#   ⇒ ~/.dsh/token.meta.json（600、原子写、只有 expiresAt/note/recordedAt，**绝不含 token**）

# ② 随时查（--now 可回放五级；--json 给机器读）
node scripts/dsh-token-meta.mjs check
node scripts/dsh-token-meta.mjs check --now 2026-11-07T00:00:00Z --json

# ③ 每日提醒（--if-due 让它可以挂在 10 分钟循环上：今天已跑过就打印 not due 并 exit 0）
node scripts/dsh-token-meta.mjs check --notify --if-due --quiet

# ④ 能力矩阵里的那一行（缺失显示"未知"，**不判红**）
npm run dsh:doctor -- --dry-run
```

判读规则（**别自己发明口径**）：

| 剩余天数 | 级别 | `check` 退出码 | 该做什么 |
|---|---|---|---|
| > 14 | ok | 0 | 什么都不用做 |
| 8–14 | warn | **0** | 排进本周轮换 |
| 2–7 | urgent | **0** | 尽快换 |
| 0–1 | critical | **1** | 今天就换 |
| < 0 | expired | **1** | 已经失效：issue 写会 403/401，先换再谈别的 |
| 读不到 / 读坏了 | unknown | **0** | 跑一次 `set --expires`（**不是**故障，别把它当红处理） |

**warn/urgent 退 0 是刻意的**：天天红会让人开始忽略告警（也会和 systemd 的 `Restart=on-failure` 叠成热循环）。
`--notify` 只在**级别跃迁**时往跟踪单 `[automation] PAT 过期元数据（A4）`（全仓一条）评论，回到 ok 时自动
评论"已解除"并关闭；**写权不足（403）只打印提醒文本 + 建单命令，不重试**。
排错：过期后 `./scripts/gh` 会报 401/403 且**看起来像权限问题** —— 先 `check` 看是不是过期了，再怀疑权限。

**写域纪律（agent 必读）**：执行 agent 只 push + 开 PR，**不许自己合并**；合并由 Lead 看过证据
（真实 run id + job 级结论）后做。`git push` 目标只能是短分支或 `auto/dsh-*`，**任何路径都不对 main
做写或 force**（本仓 pre-commit 钩子在 main 上直接拒绝提交）。

## 3. 常用命令（逐条实跑过；标「未验证」的不要当结论）

下列命令的实跑坐标见 §9（2026-10-23，`origin/main` = ef20752，地板/已装版本 = `0.2.1-rc.2`）。

### 3.1 手动跑一次检测（只读）

```sh
GH_BIN=$PWD/scripts/gh node scripts/dsh-watch.mjs --dry-run --json /tmp/watch.json
```

**实测** exit 0，打印

```
壳地板 `0.2.1-rc.2`；npm dist-tags：latest=`0.2.1-rc.2` next=`0.2.1-rc.2` alpha=`0.2.1-alpha.5`
无需适配（地板不落后于任何通道）
```

`--dry-run` 的语义 = 不写 issue（**不是**「不联网」）。无 `--dry-run` 时会开/更新 issue。
退出码**恒 0**，除非真故障（拿不到 npm packument ⇒ exit 1 且 stderr 明写「这是**真故障**」——
这句是判据：`exit 1` 不许读成「今天没新版」）。
其它参数：`--force-target <v>`（把某版本强制当作需适配，配 `--dry-run` 零副作用走全路径）、
`--registry <url>` / `--floor <v>`（演练注入点）、`--now <iso>`、`--repo <o/r>`、`--assignee <login>`
（属主解析不到时**报错而不是静默跳过**）。

**已适配跟踪单会自动关闭（A12，2026-10-30 起）**：每轮（有 target 与无 target 都算）扫 open 跟踪单，凡标题里
`dsh <版本>` 锚点取到的版本 **<= 当前壳地板**的，执行 `issue close --reason completed` + 一条
「已适配：壳地板已抬到 …」说明评论（幂等：已关的不再碰；`--dry-run` / `PAUSE` 下只列待关清单与可复制命令）。
**负向保证**：只认本脚本标题前缀 + `issue-key` 的锚点/词边界 ⇒ 别人开的 issue、解析不出版本的、以及
**目标比地板新的单（例如 alpha 通道领先时的 #239）一律不碰**。桩测在
`scripts/test-automation-gates.mjs --only watch` 的 A12 组（正/负向各两例）。

### 3.2 预演「抬地板」全链路（bump，写域只在 /tmp）

```sh
node scripts/dsh-rehearse.mjs --scenario bump
```

前置：**真实仓库的「非记录层」必须干净**（记录层 = `KANBAN.json`、`.agents/notes/archive.json`、
未跟踪的 `.agents/notes/**`）—— 有其它改动直接 `exit 3`，绝不带脏状态演练。它做：clone 到 /tmp →
把克隆里的地板降到 `--from-floor`（默认 `0.2.1-alpha.5`）→ 复用 install 场景真装目标版本 →
在克隆里跑 `dsh-adapt`（真写、真跑全量门禁）→ 五项断言（两份地板 / README 替换处数 / 夹具版本 /
**真实仓库夹具指纹未变** / 真实仓库非记录层 `git status` 为空）。

**本轮实跑：exit 1**，两条失败要分开读：

- `[5] adapt` —— 克隆里 `dsh-adapt`（无 `--dry-run`）`exit=1`，`✗ 7 全量门禁：1/24 套失败`，红的是
  `test-manifest-consistency`（根因 §6.9 的 Cargo.lock 漂移），**不是参数错、也不是演练逻辑错**。
- `[10] assert-5-real-repo` —— 报「非记录层 status 1 条」，而关键文件指纹 6/6 未变。本轮的真因是
  **正在写这个技能文件**（未跟踪改动）⇒ 演练前别动工作区；先提交/清理再跑，否则断言会被自己的改动触发。

它的 install 段在**全热 store** 下只用 28.7s（对照 §3.3 冷启动 98.3s）——引用耗时时必须带口径。

### 3.3 装候选版本演练（install）

```sh
node scripts/dsh-rehearse.mjs --scenario install            # 成功即清理临时目录；失败保留现场
node scripts/dsh-rehearse.mjs --scenario install --keep --json /tmp/r.json
```

**实测** exit 0，`结论: GREEN`，`total 99.1s`（install 98.3s + probe 0.5s），八步全 ok；
临时 runtime 装到 `0.2.1-rc.2` == 期望，真实 runtime 四处指纹未变，无残留进程。
它 `mkdtemp` 建**空** runtime，只把真实 dev runtime 的 `.pnpm-store` 与 `node_modules/pnpm` 软链进去
（热 store），用生产同款参数启动随包 `scripts/server-manager.mjs`，**让 manager 走自己的启动期自动
安装路径**；到 `install-status done` / `launching dsh web` 就按**进程组**终止（演练不该顺手起服务）。
`--help` 存在（实测列出全部参数）。热 store 缺省 = Windows dev runtime，本机用
`/mnt/c/Users/<user>/AppData/Roaming/dsh.smoothly.desktop.dev/runtime`；Linux 裸机用 `--warm-store <dir>`。

**`--version` ≠ 壳地板 时（适配前演练，2026-10-30 修）**：探针两条版本判据
（`version-vs-floor` / `version-vs-fixture`）在 target≠floor 时必然 RED，所以脚本此时自动给探针传
`--assume-floor <target> --assume-fixture <target>`，并**断言假设生效**：报告必须 `rehearsal=true` 且
`assumed.floor`/`assumed.fixture` 都等于 target，否则该步失败；**探针没产出报告一律判失败**（旧实现会把
null 读成「非 RED」⇒ 探针崩溃也假绿）。步骤文案会打印 `rehearsal`/`assumed` 实际值——**演练假设不等于
「版本已一致」**。修前该分支不可达：target≠floor 的 install 演练 100% 红，autopilot ② 因此结构性阻塞
（rc.3/rc.4/rc.5 三期未适配）。修后实测 rc.5：`结论: GREEN`、install 22.4s（热 store + 已有 runtime）、
探针 `GREEN`（red 0 / yellow 0 / info 16），报告 `rehearsal=true`、`assumed={floor:"0.2.1-rc.5",fixture:"0.2.1-rc.5"}`。
在沙箱/CI 里跑要做两件事：给 `npm_config_cache` 一个**可写**目录（否则 npm 查询 latest 直接
`EROFS: read-only file system, open '<home>/.npm/_cacache/tmp/…'`），并且**不要**继承宿主的
`NODE_USE_ENV_PROXY=1`（它会让 `test-proxy` 崩在 `proxy.mjs` 的 Host/authority 校验上）。

### 3.4 一条命令适配（抬地板）

```sh
GH_BIN=$PWD/scripts/gh node scripts/dsh-adapt.mjs --version <v> --runtime <已装该版本的 runtime> [--dry-run]
```

八步，任一步失败**立即停**（fail-closed）：① runtime 里装的版本 == 目标 → ② 两份
`MIN_DSH_VERSION` 同步 + 适配记录写进注释块内部 + `node --check`（不过则回滚）→ ③ README 地板数值
→ ④ patch 夹具重采 → ⑤ 预装插件 peer 兼容 → ⑥ 探针非 RED → ⑦ 全量门禁（按 `package.json` 的 test 链
逐条直接跑 `node`，不经 npm）→ ⑧ 汇总 + 剩余人工步骤。

| 开关 | 语义（别误读） |
|---|---|
| `--dry-run` | **只跳过写文件**（地板 / README / 夹具），**只读门禁照样真跑**（探针、插件门禁、全量门禁）。探针在 dry-run 下改成按 `--assume-floor/--assume-fixture = 目标版本` 判定，并打醒目「演练模式」声明 |
| `--canary` | 第 8 步真机验收：读 **两个**日志、断言三个标记（session 日志的 `client/log chrome ready` + `client-ready (http)`；`<runtime>/manager.log` 的 `preinstalled bundles:`）。**只认脚本启动之后新写入的行** ⇒ 前提是 dev 壳在检查期间**新启动**；只读，不启动也不杀进程 |
| `--manager-log <path>` | 随包 manager 的 `log()` 落盘处（`<runtime>/manager.log`）；**缺这个文件 `--canary` 结构上永不通过**（旧实现只读 dev-log 就是这个问题） |
| `--dev-log <path>` | dev 壳的 `dsh-desktop-session.log` |
| `--strict-chain` | 把「本机跳过的非 node 命令」也算失败（跳过 ≠ 通过）。当前链 31 条（29 条 `node scripts/*` + 1 条 `npm run test:cargo-lock-sync` 转 node + 1 条条件式 parity），本机 30 条真跑 + 1 条条件式跳过 |
| `--allow-yellow` | 默认给探针带 `--fail-on-yellow`（YELLOW 即停）；仅在明确接受含糊时放行 |

**实测**（幂等路径：目标 == 地板，`--runtime` 指向 Windows dev runtime）：
`--dry-run` ⇒ **exit 1，`2/24 套失败`**，红的是 `test-manifest-consistency` 与 `test-controls`，根因是
Cargo.lock 漂移（§6.9），**不是适配代码的问题**。这也是「dry-run 只对目标==现状的幂等路径有机会全绿」
这句话当前的实际表现：先修派生文件才有绿可看。

### 3.5 兼容核对（探针）

```sh
node scripts/dsh-compat-probe.mjs --runtime <dir> [--json <out>] [--fail-on-yellow]
```

**实测**（Windows dev runtime）exit 0：

```
已装 dsh=0.2.1-rc.2  壳地板=0.2.1-rc.2  夹具=0.2.1-rc.2（190 id）
seam 搜索范围：@deepseek-ai/** 下 1106 个 JS 文件（深度≤4）
verdict = GREEN（red 0 / yellow 0 / info 16）
```

判据：核对「已装版本 ↔ 壳地板 ↔ patch 夹具」三方一致 + 6 个客户端 seam + CLI 开关 + native 白名单 +
四个预装插件 peer；有 red ⇒ exit 1。`--assume-floor <v>` / `--assume-fixture <v>` **仅演练**（报告里
`rehearsal=true`，非 dry-run 绝不传，否则等于静默假设一致）。CI 只跑裸 `npm run dsh:probe` 时
native 白名单 / CLI 开关只报 yellow ⇒ 要门禁必须加 `--fail-on-yellow`。

### 3.6 全自动发版（autopilot）

```sh
node scripts/dsh-release-autopilot.mjs --dry-run        # 只探测 + 打印计划，不 clone / 不 push / 不调 gh 写接口
node scripts/dsh-release-autopilot.mjs                  # 全自动 ①–⑧
node scripts/dsh-release-autopilot.mjs --stage1         # 停在 ⑤（适配 PR 已合并，版本 PR 留人工）
node scripts/dsh-release-autopilot.mjs --require-canary # ⑤ 之前额外要求 dsh-adapt --canary 通过（默认关）
```

**实测** `--dry-run` ⇒ exit 0：

```
[skip] ① 探测 — 地板 0.2.1-rc.2；latest=0.2.1-rc.2 next=0.2.1-rc.2 alpha=0.2.1-alpha.5
无需适配（当前无新版）—— 地板已不低于 npm 任何通道，未开单、未推分支、未触发发布。
总耗时 1s；退出码 0
```

退出码：`0` 完成（含无新版 / 已发布 / stage1）｜`1` 失败（CI 红 / pending 超时 / 冲突 / 资产<3）｜
`2` 用法｜`3` 前置不满足（探测失败 / runtime 装不上 / 无法解析仓库或 issue / canary 缺日志）。
`--wait-minutes 0`（只看一次）、`--poll-seconds 1` 是测试口子；`--runtime <dir>` 复用已装好的 runtime
（版本不符 ⇒ exit 3）；`--json [<file>]` 结构化输出。
**部署到定时器**：unit 模板在脚本头注释（`Type=oneshot` + `OnUnitInactiveSec=30min` 不重入，
`Environment=GH_BIN=%h/dsh-desktop/scripts/gh`，`TimeoutStartSec=2h`）。**本仓库不改你机器上的 systemd**，
启用是用户动作：`systemctl --user daemon-reload && systemctl --user enable --now dsh-autopilot.timer`。

**「停摆版本 PR」兜底（2026-10-30 起，默认开）**：autopilot 的入口恒为「本轮检测到新版」，适配 PR 合并后地板
==target ⇒ ⑥–⑧ 不会自动续走，一次无关 fix 留下的版本 PR 会一直挂到下一次上游发版（实录 #234 停 5 天）。
现在两条「本轮不干活」的早退路径（无新版 / 预发布通道跳过）都会先查 open 的 `chore(main): release X.Y.Z`：
有 ⇒ 走与 ⑥–⑧ **完全相同**的合并（写域白名单 / 冲突 / check 失败同口径 fail）→ 派发构建 → 等资产 ≥3；
没有 ⇒ 照旧 exit 0。**查询 gh 失败按无操作处理**（不让 API 抖动把无新版轮次记成失败）；该路径不回帖 issue
（没有 target 可归因）。`--no-release-resume` 可关。桩测：`node scripts/test-autopilot-release-resume.mjs`
⇒ 0（10 组 / 47 条断言，含「写域越界 / 冲突 / gh 抖动 / --dry-run / release-hold」五组负向/只读对照）。
**真实轮次已验（两次）**：合并 #240/#241 后版本 PR #242（0.22.0）由 release-please 开出 → autopilot 同一轮 `⑥′`
命中并合并（2026-10-30T21:24:00Z）→ 派发 build → 10m59s 后三个资产齐（带 sha256 digest）→ 日志
`✅ 本轮无新版，但已收尾停摆版本 PR：v0.22.0`；21:53Z 的下一轮同路径又自动发了 **v0.23.0**（版本 PR #244 合并 →
build 41134480089 job 级全绿 → 10m05s 后资产齐）。

**发版节奏（重要，2026-10-30 起）**：默认「合并进 main 的提交 ≤10 分钟后就发版」。想攒几个 PR 一起发，
给版本 PR 打 **`release-hold`** 标签即可（autopilot 跳过；确认发版时移除标签，下一轮继续）。因此
「文档/看板类提交不要碎片化发布」这条纪律现在的操作方式是**先别合进 main**（或打 hold），而不是让版本
PR 挂着等——自动兜底不会让版本 PR 一直停着。

### 3.7 SLA 报表（两段延迟，别把 unknown 当 0）

```sh
GH_BIN=$PWD/scripts/gh node scripts/dsh-sla-report.mjs --json /tmp/sla.json   # 只出报表，只读
node scripts/dsh-sla-report.mjs --check /tmp/sla.json                        # 用刚生成的报表判红绿
node scripts/dsh-sla-report.mjs --issue                                       # 幂等更新「dsh 升级 SLA 报表」issue
```

**实测** `--json /tmp/sla.json` ⇒ exit 0，关键字段：

```json
{"slaHours":6,"since":"2026-10-19",
 "detectionStats":{"measured":0,"unknown":7,"median":null,
                   "adaptation":{"measured":7,"median":10.28,"max":42.92},
                   "floorSegment":{"measured":7,"median":21.55,"max":143.0}}}
```

→ **检测段 7/7 全是 unknown**（历史地形：早期 issue 没有能被识别的 label/版本号）。表格里印「未检测到」，
JSON 里是 `null`。**不许**把它当 0 分钟写进结论，也不许用它判红绿 —— 门禁口径仍是 `total ≤ 6h` +
`since` 窗口（检测延迟量的是「机器是否开着」，不是我们的响应能力）。
`--check <json>` 需要**同一次运行**产出的报表：读不到 / 无 `slaHours` / `perVersion` 为空 ⇒ **判红**
（「量不出来」不等于「达标」）。其它：`--fail-on-breach`（最近 N 个超 6h 即非零）、`--recent <n>`
（必须正整数）、`--registry`、`--now <iso>`（钉住「现在」，演练用）。

### 3.8 判读 GitHub 的只读命令（全部实跑过）

```sh
./scripts/gh pr list --state open --limit 5
./scripts/gh issue list --state open --limit 5
./scripts/gh run list --limit 4                                    # run 级
./scripts/gh run view <id> --json jobs --jq '{run:.conclusion, jobs:[.jobs[]|{name,conclusion}]}'   # job 级
./scripts/gh pr view <n> --json number,title,mergeable,headRefName,files,statusCheckRollup
./scripts/gh release view vX.Y.Z --json tagName,assets
./scripts/gh api repos/karoc/dsh-desktop/releases/tags/vX.Y.Z \
  --jq '.assets[] | "\(.name) size=\(.size) digest=\(.digest // "none")"'
```

实跑样例：`v0.20.0` 三个资产 `AppImage size=124439032 digest=sha256:d26b442c…`、
`deb size=54533328`、`x64-setup.exe size=28201821`（digest 字段真实存在，可直接当校验基准）；
main 的 push run 39677256299 job 级 = check/test/rust-coverage/linux/windows/linux-smoke 全 success、
`release` skipped；release-please 分支上的 build run 恒 `action_required`。
**未验证**：`gh api` 资产端点（`-H 'Accept: application/octet-stream'`）的实际下载与断点续传 —— 本轮
不下载 28MB/124MB 资产，命令形态来自 §7 的相关决策记录（那里有 11MB/s 的实测）。

## 4. 标准操作：一条命令全自动

无人值守就靠 timer，人只需要看 issue 与日志。

```sh
# 1) 确认心跳在跑（三条 timer 都应有 NEXT 时间）
systemctl --user list-timers | grep dsh

# 2) 看它最近干了什么
tail -30 ~/.dsh/logs/dsh-autopilot.log

# 3) 想知道「现在这条链会做什么」而不动手
GH_BIN=$PWD/scripts/gh node scripts/dsh-release-autopilot.mjs --dry-run
```

`dsh-autopilot.log` 里出现 `[FAIL] …` 且退出码 3 时，先按 §6.1/§6.2 查心跳与网络；**不要把
「探测失败」当成「没有新版」**。

## 5. 标准操作：分步人工（autopilot 不可用 / `--stage1` / 收尾）

顺序固定，**上一环没验完不进下一环**：

```sh
# ① 检测
GH_BIN=$PWD/scripts/gh node scripts/dsh-watch.mjs --dry-run --json /tmp/watch.json

# ② 装候选版本（演练，写域只有 /tmp）
node scripts/dsh-rehearse.mjs --scenario install --json /tmp/r.json

# ③ 适配（真写：地板 / README / 夹具；第 7 步跑全量门禁）
GH_BIN=$PWD/scripts/gh node scripts/dsh-adapt.mjs --version <v> --runtime <install 报出的临时 runtime>
#   若 runtime 已被清理，用真机 dev runtime（已装该版本）：
#   node scripts/dsh-adapt.mjs --version <v> --runtime "$APPDATA/dsh.smoothly.desktop.dev/runtime"

# ④ 提交 + 开 PR（只提交已跟踪、非看板文件）
git status --porcelain
git add -u && git commit -m "fix(dsh): 适配上游 dsh <v>"
git push -u origin <branch>
./scripts/gh pr create --base main --title "fix(dsh): 适配上游 dsh <v>" --body "..."

# ⑤ 等 CI —— 看 job 级，不看 run 级
./scripts/gh pr view <n> --json statusCheckRollup
#   SUCCESS/SKIPPED/NEUTRAL = 非失败；FAILURE/CANCELLED/TIMED_OUT/ACTION_REQUIRED/pending 超时 = 不合

# ⑥ 合并（确认 MERGEABLE + job 级全绿之后）
./scripts/gh pr view <n> --json mergeable        # 必须 MERGEABLE；CONFLICTING/DIRTY ⇒ 停，绝不 force
./scripts/gh pr merge <n> --squash --admin
./scripts/gh pr view <n> --json state            # 复核 MERGED

# ⑦ 版本 PR（bot 建的，无 checks，见 §6.7）
./scripts/gh pr list --state open --search 'chore(main): release' --limit 3
./scripts/gh pr view <n> --json mergeable,headRefName,files     # 写域必须全在 release-please 白名单内
./scripts/gh pr merge <n> --squash --admin

# ⑧ 派发构建（只在「该 tag 尚无运行」时）
./scripts/gh api 'repos/karoc/dsh-desktop/actions/runs?branch=vX.Y.Z' --jq '.total_count'
./scripts/gh workflow run build.yml --ref vX.Y.Z

# ⑨ 资产核验（≥3 且 size/digest 对得上）
./scripts/gh release view vX.Y.Z --json assets --jq '.assets|length'
```

**合并之后动下一轮前必须**：`git fetch origin && git -c rebase.autostash=true rebase origin/main`
（squash 合并会让旧基线分支被判 `CONFLICTING`，而 **CONFLICTING 的 PR 完全不跑 CI** —— 「没有 check
上报」不等于「check 通过」）。

## 6. 排错表（症状 → 判据 → 处理）

### 6.1 timer 在跑，但每 10 分钟都失败（今天本机的实际状态）

- **症状**：`systemctl --user list-timers | grep dsh` 正常显示 NEXT；但日志里刷屏
  `curl: (7) Failed to connect to 127.0.0.1 35377` ⇒ `拿不到 npm packument … 这是**真故障**，故非零退出`，
  autopilot 则是 `[FAIL] ① 探测（失败） — dsh-watch 没有产出 JSON（exit=1）` / 退出码 3。
- **判据**：`ss -ltn | grep 35377` 无输出；`echo $HTTPS_PROXY` 已是**另一个端口**（实时代理每次启动换端口，
  本机复现当天 shell 是 `127.0.0.1:34037`）。即 unit 里的 `Environment=HTTPS_PROXY=…` 是**写死的快照**。
- **处理**：改 `~/.config/systemd/user/dsh-{watch,tagdispatch,autopilot}.service` 的 `HTTPS_PROXY`
  （或让 unit 不设代理，前提是直连可达）→ `systemctl --user daemon-reload` → `systemctl --user start dsh-watch.service`
  看一次日志。**这是用户动作**：仓库脚本不改你机器上的 systemd，agent 也不要擅自改/重启。
- **为什么容易误判**：`dsh-watch` 退出码恒 0 的设计（红色只代表 job 坏了）在这里**反而是好消息**——
  它 exit 1 且 stderr 带「这是**真故障**」，说明判据在正常工作，不是「今天没新版」。

### 6.2 心跳根本没跑

- **判据**：`systemctl --user list-timers | grep dsh` 无输出或 `Active: inactive (dead)`；
  `~/.dsh/logs/dsh-*.log` 最后一行时间停在几小时/几天前；`loginctl show-user "$USER" -p Linger` 为 `no`。
- **处理**：① 先确认 WSL 发行版被拉起 —— 心跳跑在 **WSL(Ubuntu-24.04)** 里，Windows 侧登录自启是
  启动文件夹快捷方式 → `%LOCALAPPDATA%\dsh-wsl-daemon.cmd`（**不会**随 Docker Desktop 自动启动，
  `schtasks` 建计划任务会被系统拒绝）；从 WSL 内部调 `wsl.exe --list --running` 本机实测
  `command not found`（interop 不可用），只能从 Windows 侧看。② `systemctl --user daemon-reload` 后
  `systemctl --user enable --now dsh-watch.timer`。③ `loginctl enable-linger karoc`（无登录会话也要跑）。
- **盲区如实保留**：Windows 关机/睡眠期间两边都不跑。这段延迟必须由 SLA 的「检测段」量出来，
  不是假装没有 —— 也正因如此检测段常是 unknown（§3.7）。
- **云端那一层（反向心跳 / A5）**：`dsh-heartbeat-check.yml` 每日 03:00 UTC 读 canary 正文的
  `last-ok`：>26h ⇒ 评论 `@owner` + `priority:high`、**exit 3**。`3` = **已报警**（设计内的失败），
  `1` 才是检查器自己坏了 —— 别用 `continue-on-error` 把 3 吞成绿。本机心跳与 canary `last-ok`
  同时陈旧 ⇒ 先按上面①–③修本机 timer，再跑一次 `npm run dsh:doctor` 把 `last-ok` 推新。

### 6.3 issue 开了但没人知道（推送没生效）

- **判据**：`./scripts/gh issue view <n> --json assignees,labels` ⇒ `assignees: []`，正文里也没有 `@` 提及。
- **处理**：GitHub 的推送只覆盖「参与中 / 被 @ 提及 / 被赋值」的线程，**label 不产生通知**。
  `dsh-watch` 已经是 assignee + 正文 `@owner` 双保险（并显式 `--add-label priority:high`），
  所以 assignee 为空通常意味着**不是 `dsh-watch` 建的**（例如 SLA 报表 issue 由 CI 的 `GITHUB_TOKEN`
  创建，本来就没有 assignee，那属预期）。手工补：`./scripts/gh issue edit <n> --add-assignee <login>`。

### 6.4 PR 冲突 ⇒ CI 压根不跑

- **判据**：`./scripts/gh pr view <n> --json mergeable` = `CONFLICTING`；`./scripts/gh run list --branch <branch>`
  只有你推送后那一条 run。**「没有 check 上报」不等于「check 通过」**。
- **处理**：先 `git fetch origin`，把分支 rebase 到 `origin/main` 再 `--force-with-lease` 推回**同一分支**
  （不留 merge commit、不重建 PR）。前置判据用**树比对**而不是 patch-id：`git diff <旧 main> <新 main>` 为空
  ⇒ 两侧没有真分歧，rebase 会把「patch contents already upstream」的提交直接丢弃、零冲突。
  `KANBAN.json` / `.agents/notes/archive.json` 是被跟踪的活跃文件：只用
  `git -c rebase.autostash=true`，事前备份 + 事后用 JSON 解析证明卡集合无损（**不能用 sha256 代替卡集合校验**）。

### 6.5 CI 红了但看不出原因

- **判据**：`./scripts/gh run view <id> --json jobs --jq '.jobs[] | {name,conclusion}'`。
  run 级 success + 某 job failure 的典型成因就是 `continue-on-error`（已从 `linux-smoke` 删除，
  其余作业仍可能带）。
- **处理**：先分清确定性 vs flake —— 连续 3 次同结论 = 确定性缺陷；只出现一次才谈 flake。
  修 flake 的方向是缩小等待/依赖（有界轮询、去外部源、提前断言早退），**不是**吞错
  （`continue-on-error` / `|| true` / skip 都是假绿）。`linux-smoke` 现在会真让 push/tag 变红，
  失败路径最坏多花 ~180s（`SMOKE_WAIT_SECONDS` / `SMOKE_TIMEOUT_SECONDS` 可调）。

### 6.6 下载的资产 0 字节 / 被截断

- **判据**：`gh release download` 对慢链路**没有续传**（实测走代理 240s 只拿到 6.8MB / 28.2MB）；
  `curl -x $HTTPS_PROXY https://github.com/...` 直接 0 字节 60s 超时（代理对 `github.com:443` 不放行）。
- **处理**：改走 **GitHub API 资产端点**（`Accept: application/octet-stream`，302 到官方 CDN，实测 11MB/s），
  下载后必须核对 `size` 与 `sha256` **等于** `releases` 里的 `size` / `digest`（§3.8 那条命令能直接读到，
  实跑 `v0.20.0` 三个资产都有 `sha256:` digest），不一致不装。
  「核对不了」= 失败，不是「未知」。
- **注**：本轮未实际下载资产（见 §3.8「未验证」），命令形态来自 §7 的发版-验证决策记录。

### 6.7 版本 PR 挂着没人合 / autopilot 每 10 分钟说「无需适配」

- **症状**：`chore(main): release X.Y.Z` 的 PR 开了好几天（实录 #189 挂 4 天、#234 从 2026-10-24 挂到 10-30），
  而 autopilot 日志一直是「无需适配（当前无新版）」。
- **判据**：历史上这是**结构性行为**：autopilot 的入口恒为「本轮检测到新版」，适配 PR 合并后地板已等于 target
  ⇒ `dsh-watch` 不再报这个 target ⇒ ⑥ 之后（或用了 `--stage1`）**不会自动续走**。
- **处理（2026-10-30 起默认自动）**：autopilot 现在会在「无新版 / 预发布跳过」轮次检查并合并停摆版本 PR
  （见 §3.6）。若日志仍显示 `[skip] ⑥′ 停摆版本 PR — …没有 open 的 …` 而确实有 PR，按序查：
  ① 工作树是否在 `main`（§6.14：timer 跑的是工作树脚本）；② 是否加了 `--no-release-resume`；
  ③ 写域白名单 / 冲突失败（日志会点名）⇒ 人工处理后再让它重跑。
- **人工兜底（autopilot 不可用 / 写域失败）**：确认版本 PR 的 `mergeable=MERGEABLE`、head 是
  `release-please--branches--*`、`files` 全在写域白名单（`package.json` / `src-tauri/tauri.conf.json` /
  `Cargo.toml` / `Cargo.lock` / `CHANGELOG.md` / `.release-please-manifest.json` / `KANBAN.json`）
  → `--admin` 合并 → 派发构建 → 核验资产。
- **别被骗**：该 PR 的 `statusCheckRollup` **恒为 `[]`**（bot PR ⇒ workflow `action_required`；
  实测 #189/#234 = `[]`）。日志/文档里写的是「按 bot PR 无 check 例外合并」，**不要**说成「checks 绿」。

### 6.8 版本比较把正式版判旧（rc/stable 关系错）

- **判据**：仓库里有**三份**独立实现 —— `dsh-watch.mjs` 的 `cmp`、`dsh-compat-probe.mjs` 的 `cmp`、
  `server-manager.mjs` 的 `versionGt`。跑 `node scripts/test-version-compare-parity.mjs`：
  它从三个文件的**源文本**里抽函数（不复制粘贴），要求三份结论完全一致；源文本被改名/改写导致抽不出来
  时**抛错即失败**，不静默跳过。
- **处理**：任何一份被改就必须三份同改并跑 parity；负向对照（必须变红）见脚本头注释（把副本里
  `x.length === 0` 的分支改坏 ⇒ 必须失败并指名是哪一份）。
- **历史教训**：三份曾同时错（正式版被判比同号预发布旧），修的时候又只改了两份 ⇒ 转正（rc→stable）
  这一最典型动作会**静默不触发**。

### 6.9 本机/克隆里 `npm test` 红在「四处版本一致」

- **判据**：`node scripts/test-manifest-consistency.mjs` 打印
  `版本不一致: {"package.json":"0.20.0",…,"Cargo.lock":"0.19.0"}`。
- **成因**：release-please 只改 `package.json` / `tauri.conf.json` / `Cargo.toml`，**不动 `Cargo.lock`**；
  CI 的 `test` 作业因此在 `npm test` **之前**先跑 `node scripts/sync-cargo-lock-version.mjs`。
  本机与 `dsh-adapt`/`dsh-rehearse` 的克隆里没有这一步 ⇒ 第 7 步连带 `test-controls` 一起红。
- **处理**：`node scripts/sync-cargo-lock-version.mjs` 后再跑（实测 `FIXED: 0.19.0 → 0.20.0`，
  `test-manifest-consistency` 立刻 exit 0；**注意它把工作树改成脏的** ⇒ 会跳过 `test-controls` 的三个
  可信度对照）。
- 这条**不是适配回归**：判据里必须能指出是哪条文件漂移，否则按真回归处理。

### 6.10 `--canary` 永远不通过

- **判据**：报错指名缺哪个标记、来自哪个文件（session 日志 vs `<runtime>/manager.log`）。
- **处理**：canary 只认**脚本启动之后新写入**的行 ⇒ 必须**在窗口期内新启动 dev 壳**（早就开着且空闲的壳
  不会产生新标记行）。定时器给不了这个前提，所以 autopilot 的 `--require-canary` **默认关**。
  人工窗口用：`--require-canary --dev-log <dev 数据目录>/dsh-desktop-session.log --manager-log <runtime>/manager.log`。

### 6.11 自动合并被拒

- **症状**：`base branch policy prohibits the merge`。
- **判据**：① 没带 `--admin`；或 ② 用了错凭据（裸 `gh` 落到全局 token，缺 Administration:write）。
- **处理**：确认是 `./scripts/gh pr merge <n> --squash --admin`，且当前目录的 `scripts/gh` 能读到
  `~/.config/gh-dsh-desktop/token`。`--admin` 只在前一步已确认 `MERGEABLE` + job 级全绿时用。

### 6.12 issue 写不进：`Resource not accessible by personal access token`

- **症状**：`dsh-watch` / autopilot 建了 issue 但 label / assignee / 评论 / 关闭失败；日志里
  `updateIssue 403` / `addLabelsToLabelable 403`；`gh api repos/<repo> --jq .permissions` 却显示 `admin: true`。
- **判据**：`npm run dsh:doctor`（A3）。矩阵里凡是 `✓` 以外的写能力都失败 ⇒ **PAT 缺 Issues:write**；
  矩阵会如实区分「实测不可用」与「撞到 403 后按纪律停止探测（未验证）」，两者都让退出码非零。
- **处理**：fine-grained PAT → Repository permissions → **Issues: Read and write**；改完重跑
  `npm run dsh:doctor` 直到 `结论：PASS`。这不是脚本能修的（凭据在你手里）。
  在此之前**不要**用「多开几次就好」绕过：重复 issue #201–#216 就是这么来的（去重键曾依赖 label）。

### 6.13 退避卡在 `broken` / 想人工重置

- **症状**：日志每轮只有一行 `still broken (attempt k, next retry in Xm)`，退出码 0；状态文件
  `~/.dsh/state/<tool>.json` 里 `state=broken`。
- **判据**：`cat ~/.dsh/state/<tool>.json` 看 `state` / `failures` / `nextAttemptAt`；
  失败明细在 `<state>.detail.log`（128KB 截断）。**退出码 0 不是"好了"**——退避跳过轮故意返回 0，
  避免与 systemd `Restart=on-failure` 叠成热循环。
- **处理**：先把真故障修掉（代理端口 / 凭据 / 网络），再 `--reset-state`（只重置本地状态，不写 GitHub）；
  下一轮成功会自己 reset 并只在跃迁时发一条恢复评论。**不要**删整个 `~/.dsh/state/` 来"图快"：
  删状态 = 忘掉退避历史，但也会丢掉"已通知过谁"的上下文。
- **实录（2026-10-30，autopilot 连败 6h）**：`~/.dsh/state/dsh-release-autopilot.json` 里
  `lastError=git fetch autopilot main 失败（exit=128）：fatal: Could not read from remote repository`。
  该仓库的 `git fetch` 走 SSH ⇒ `~/.ssh/github-proxy.sh` 的 `nc -X connect -x 127.0.0.1:20172`，与 npm
  用的 HTTP 代理**不是同一条通道**（当天 HTTP 侧一直 `[proxy] … (cached, verified)`，只有 20172 抖）。
  复现/判据：`git -C <repo> fetch --no-tags autopilot main` 手动跑一次；`nc -z -w1 127.0.0.1 20172` 看端口。
  退避阶梯到 60min/轮 ⇒ 网络一抖就停摆一小时；**修好网络后不必等**，手动跑一次成功即自愈（成功轮会 reset）。
  注意 `/tmp` 在 DSH 沙箱里是**每次 bash 调用一个私有 tmpfs**：日志里"现场保留 /tmp/…"的路径在
  沙箱 shell 里通常看不到，排障要用服务自己的日志/state，不要靠翻 /tmp。

### 6.14 心跳跑的是**工作树**脚本（「修完了却不生效」的真实原因）

- **判据**：四个 timer 的 `ExecStart` 都是 `run-with-proxy.sh node $ROOT/scripts/<tool>.mjs`
  （`$ROOT=/home/karoc/dsh-desktop`）。**工作树停在哪个分支/提交，线上心跳就跑哪份代码** ——
  既不是 `origin/main`，也不是已发布的壳版本。
- **实录（2026-10-24 → 10-30）**：工作树停在 `feat/autopilot@db71e9d`（落后 main 5 个提交），而
  `dsh-doctor.mjs` 在 main 上有 #229/#231 两处 248 行改动 ⇒ 线上跑的是**旧 doctor**：每天
  `✗ 评论 HTTP 404`、失败运行仍推进 `last-ok`（违反它自己写明的负向保证），而仓库侧 CI 全绿、看板标 done。
  把工作树切回 `main` 后同一条命令 **7/7 ✓**。
- **处理**：动这些脚本前先 `git -C /home/karoc/dsh-desktop status -sb` 确认在 `main` 且 `scripts/` 无未提交改动；
  切分支开发前先想到「线上会跟着跑」。结构性守卫（运行前校验 HEAD 与 `origin/main`）仍是看板上的 todo。

## 7. 纪律（硬规则，别绕过）

1. **一律 `./scripts/gh`**（项目 PAT）；跑脚本显式 `GH_BIN=$PWD/scripts/gh`。禁止裸 `gh`。
2. **agent 不自己合并 PR**：执行方只 push + 开 PR；合并方必须看过真实 run id 与 job 级结论。
3. **`--admin` 合并的前提**：`mergeable=MERGEABLE` **且** job 级无 FAILURE/CANCELLED/TIMED_OUT/
   ACTION_REQUIRED/超时 pending。`CONFLICTING`/`DIRTY` 一律停，**绝不 force**。
4. **合并后先 `git fetch` + rebase 再动下一轮**（squash 合并 ⇒ 旧基线分支冲突 ⇒ CI 静默不跑）。
5. **不直推 main**（pre-commit 钩子会拒绝；`main` 保护 `enforce_admins` 关闭 ⇒ 直推会**静默绕过门禁**，
   历史上因此把红灯 check 送进过 main）。只有 CI 本身坏掉、必须自举时才直推并明确声明绕过了门禁。
6. **演练不碰真环境**：`dsh-rehearse` 只在 /tmp 写；`--scenario bump` 要求真实仓库非记录层干净，
   脏了就 exit 3 —— 不许用「先 stash 一下」绕过指纹断言。
7. **「没有判断 = 没有验证」**：空/null/截断/超时报错一律计失败并重跑，或显式登记为覆盖缺口。
   `--dry-run` 的探针假设值、`unknown` 的检测段都**不代表一致/达标**。
8. **写能力只认 canary 写**（A3）：`npm run dsh:doctor` 没绿之前，任何 issue 写路径（label / assignee /
   评论 / 关闭）都不算可用；`admin=true` 与 UI 上的勾选不作证据。
9. **手动补 issue 前先刹车**（A1）：本机 `dsh-watch` 是 flock 单实例，CI 是第二个写者 —— 手动改 issue
   前 `touch ~/.dsh/PAUSE`，干完 `rm ~/.dsh/PAUSE`，否则会和 10 分钟一轮的定时器抢同一批写。

## 8. 已知覆盖缺口（如实写，别当成已验证）

| 缺口 | 影响 / 应对 |
|---|---|
| **canary 默认关** | 定时器给不了「窗口期内新启动 dev 壳」的前提；`--require-canary` 只给有人值守的窗口 |
| **autopilot 的适配段（②–⑤）仍未真机跑过** | 发布半程（⑥–⑧ + 停摆版本 PR 兜底）已**两次真机验证**（v0.22.0 / v0.23.0，见 §9）；但「检测到新版 → 建适配 PR → 合并适配 PR」这条 ②–⑤ 仍只有桩（历史真实轮次都停在 ②，rehearse 死分支 2026-10-30 已修）。桩：`test-autopilot-release-resume.mjs` 10 组 / 47 条断言（`GH_BIN`/`GIT_BIN`/`NODE_BIN`/`DSH_AUTOPILOT_WATCH_JSON` 注入）⇒ **首次上游发版实战仍需有人在旁边看** |
| **`dsh-rehearse` 只覆盖全新安装** | 空 runtime ⇒ `dshInstalled()=false`。**升级覆盖**分支、isolated→hoisted 布局迁移、兼容闸门（已装 < 地板）都没走到 |
| **rehearse 只到探针** | 在 `launching dsh web` 处按进程组终止 ⇒ 「装完 dsh web 能否真起来」仍靠真机验收 |
| **`release` 的 `needs` 不含 smoke** | `needs: [windows, linux]` ⇒ `linux-smoke` 红**不会**阻止出包。刚恢复的 canary 要先连续绿几轮才升格 |
| **检测段只有 1 个真实样本** | 2026-10-30 首次拿到实测：rc.5 检测 **1.82h**（#236 创建）；历史 7 条仍是 unknown（早期 issue 没有可识别 label/版本号） |
| **`--version` 不可注入** | manager 启动期目标恒 `max(地板, latest)` ⇒ 结构上装不到更高的预发布；`next`/alpha 不自动适配，只开 issue |
| **版本 PR 合并 = 零人工审阅** | 替代审查只有「mergeable + 写域白名单 + 非失败 check」，不读 diff 语义。CONTRIBUTING 里那份人工清单（四处版本一致 / CHANGELOG 段 / `npm test` / `audit-preinstalled`）在自动路径上**不执行** |
| **进度看板/归档文件的边界** | `KANBAN.json`、`.agents/notes/archive.json` 被 git 跟踪 ⇒ autopilot 提交时跳过、rebase 时 autostash；改动它们不算适配写域 |
| **心跳 timer 执行工作树脚本** | 见 §6.14：工作树漂移 ⇒ 线上跑旧代码（2026-10-24→30 实际发生 5 天）。目前只靠「ROOT 留在 main」的纪律；运行前校验守卫仍是看板 todo |
| **`dsh-doctor` 的每日轮次依赖工作树正确** | timer 已装（每日 06:23），执行的是工作树脚本（§6.14）。2026-10-31 06:23 CST（22:23Z）**系统轮次 PASS 7/7**、`last-ok=2026-10-30T22:23:23.255Z` ⇒ §6.14 的修复在真实 timer 上已生效；工作树若再漂移会退回「每天 FAIL」 |

## 9. 本技能实测坐标（2026-10-31 06:40 CST）

- 仓库：`origin/main` = **5637e1e**（`chore(main): release 0.23.0`）；壳地板 `MIN_DSH_VERSION = 0.2.1-rc.5`；
  npm `latest`/`next` = `0.2.1-rc.5`，`alpha` = `0.2.2-alpha.2`（alpha 领先 ⇒ 按决策 ③C 只跟踪、不适配，issue #239）。
- **发布半程已真机验证两次（无人值守，autopilot 自己合并版本 PR）**：
  - **v0.22.0**：版本 PR #242 → autopilot 于 2026-10-30T21:24:00Z 合并 → 派发 build → **10m59s** 后 3 个资产齐
    （AppImage 124,451,320 / deb 54,562,640 / x64-setup.exe 28,212,920，均带 sha256 digest）；日志
    `✅ 本轮无新版，但已收尾停摆版本 PR：v0.22.0`。
  - **v0.23.0**：版本 PR #244 → 21:54:22Z 合并 → build run 41134480089 **job 级全绿**（check/test/windows/linux/
    linux-smoke/release）→ 3 个资产齐 → 22:04:33Z 日志同样的 `✅`；autopilot 状态 `healthy`。
  - 闸门：`node scripts/test-autopilot-release-resume.mjs` ⇒ **0（10 组 / 47 条断言）**；
    `test-automation-gates --only watch` ⇒ **41 条断言全绿**（含 A12 正向/幂等/--dry-run/负向四例）。
- 心跳现场（2026-10-31 06:23 CST = 2026-10-30T22:23Z）：`dsh-doctor` **系统轮次 PASS 7/7**（评论 PATCH / label /
  关闭重开 / last-ok 全 ✓，canary `last-ok=2026-10-30T22:23:23.255Z`）——证明 §6.14「工作树切回 main」真的生效。
  四条 timer 在跑、autopilot `healthy`。**timer 执行工作树脚本（§6.14）**，工作树必须留在 `main`。
- 其它实跑坐标（2026-10-30，命令见 §3 / §5）：`dsh-rehearse --scenario install --version 0.2.1-rc.5` ⇒ **GREEN**
  （22.4s，热 store；探针 red0/yellow0/info16、`rehearsal=true`）｜`dsh-adapt --version 0.2.1-rc.5` ⇒ **0**（29/29 门禁）｜
  `dsh-sla-report --json` ⇒ 0（检测段首次实测 1.82h）｜`test-manifest-consistency` ⇒ PASS（含「文档套数 == 链长」门禁）｜
  `v0.21.1` 为人工补发（rc.5 发布 14:15Z → 发布 23:58Z = **9.71h**，SLA 6h 未达标）。
- 未验证：资产端点的真实下载/续传（§3.8）；`dsh-rehearse --scenario bump` 的成功路径；`--require-canary` 的真实通过；
  **autopilot 的适配段 ②–⑤（检测到新版 → 建 / 合并适配 PR）**；A12 的**真实关闭动作**（自 v0.23.0 起没有
  「已被地板覆盖」的 open 跟踪单可关，只有桩测）。

## 10. 维护本技能

- **唯一真源**：仓库 `.dsh/skills/dsh-upstream-adaptation/SKILL.md`（与 `dsh-preinstalled-plugin-sync`、
  `windows-desktop-shell-debugging` 同款工作区技能目录，随 dsh-desktop 版本控制）。
- **frontmatter 引号规则（会静默失效，务必遵守）**：`description` 一律用双引号 YAML 标量，内部不要出现
  未转义的 ASCII `": "` —— DSH 的 skill provider 对解析失败的 `SKILL.md` 是**静默丢弃**（无报错、无提示，
  技能与它的用户界面同时消失）。详见 `.agents/notes/implemented/bug-fix/2026-09-20-skill-frontmatter-quoting.md`。
- **全局可见**：`~/.agents/skills/dsh-upstream-adaptation` 指向本目录的 symlink（新机器/新 clone 后重建）：
  `ln -s /home/karoc/dsh-desktop/.dsh/skills/dsh-upstream-adaptation ~/.agents/skills/dsh-upstream-adaptation`
- **更新时机**：改了这 6 个脚本的参数/退出码/判据语义、改了 workflow 的 schedule 或作业依赖、
  或新增/关闭了 §8 的某个缺口 ⇒ **同一次提交**里改本技能（文档是交付物的一部分）。
- **写新命令前后的自检**：技能里出现的每条命令要么本轮实跑过并贴一行结果，要么明确标「未验证」；
  `--help` 不存在时不要编造（这 6 个脚本里只有 `dsh-rehearse.mjs` 提供 `--help`，其余靠头注释与参数表）。

## 相关决策记录（要理解「为什么这样设计」读这些，本技能不复述论证）

- `../../../.agents/notes/implemented/architecture/2026-10-20-dsh-release-autopilot.md` —— autopilot 的 ①–⑧、
  幂等、`--admin`、bot PR 例外、退出码
- `../../../.agents/notes/implemented/architecture/2026-10-21-dsh-upgrade-heartbeat-dual.md` —— 本机心跳为主 +
  GitHub cron 兜底、WSL 登录自启、关机盲区
- `../../../.agents/notes/implemented/process/2026-10-21-shell-release-install-verify.md` —— 下载/构建/五项链式验收
- `../../../.agents/notes/implemented/process/2026-10-18-dsh-upstream-release-day-drill.md` —— 桩 + 副本 + 临时 runtime
  的演练手法与真实时间预算
- `../../../.agents/notes/implemented/process/2026-10-19-pr-branch-rebase-after-squash-merge.md` —— squash 合并后
  必须 rebase 的树比对判据
- `../../../.agents/notes/implemented/bug-fix/2026-10-21-ci-linux-smoke-false-green-and-choco-retry.md` ——
  run 级 vs job 级假绿、有界轮询、choco 有界重试
- `../../../.agents/notes/implemented/process/2026-09-19-project-scoped-gh-token.md` —— 项目 PAT、权限探针、
  直推 main 会静默绕过门禁
- `../../../docs/2026-10-17-dsh-upgrade-automation-plan.md` 的「全自动流水线（autopilot）」节 —— 权威参数与限制清单
