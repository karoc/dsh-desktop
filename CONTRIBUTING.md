# Contributing（dsh-desktop 开发约定）

单开发者项目，但流程与多人协作同构——CI 是第一道审查，PR 记录决策轨迹。

## 分支与合并（GitHub Flow）

- `main` 始终可发布；功能走短分支 + PR。
- 分支命名：`feat/<主题>` / `fix/<主题>` / `ci/<主题>` / `docs/<主题>`。
- PR 合并方式：**squash merge**（main 一提交一功能，提交信息 = PR 标题）。
- main 分支保护：需 PR + CI 快层（check + test）通过才可合并。
- main 保护 `enforce_admins` 关闭（单开发者不卡自己）：owner 直推技术上可绕过 PR，
  但**约定仍走 PR**——直推会触发全量 CI 兜底，仅限紧急 hotfix。
- 本地 `main` 只在合并后 `git pull` 同步，**不要**在本地 main 上直接提交功能。

## 提交规范（Conventional Commits）

```
<type>(<scope>): <中文描述>
```

- type：`feat` / `fix` / `refactor` / `docs` / `ci` / `test` / `chore`（+ 偶尔 `process`/`tools`）
- scope 小写（如 `shell`、`proxy`、`notify`、`dev-build`），可省略
- 标题 ≤ 72 字符，正文列要点；squash 后一条提交对应一个功能
- 规范直接驱动 release-please：`feat` → minor，`fix` → patch，自动 bump 版本 + CHANGELOG

> ⚠️ **release-please 解析陷阱（2026-09-20 实测，丢过一条 fix）**：提交**正文**里写
> `<base64url(sha256(host:port))>` 这类"尖括号 + 圆括号"的技术写法，会让
> conventional-commit 解析器报 `unexpected token '('`；release-please 遇到解析失败的
> 提交会**整条静默丢弃**——CHANGELOG / Release notes 少一条，版本号提升不受影响（其它
> 提交仍会 bump），所以不看日志根本发现不了。两条纪律：
> 1. 正文里避免尖括号与括号混用（写成 `sha256 of host:port` 之类）；
> 2. 合并 fix/feat 后**核对 release PR 是否列出了你的提交**（工作流日志搜
>    `commit could not be parsed`）。漏了就在 `CHANGELOG.md` 该版本段落手动补录
>    （注明"手动补录 + 原因"），再用 `gh release edit <tag> --notes-file <(node scripts/release-body.mjs <ver>)`
>    刷新 Release notes。

## 门禁（提交前本地跑）

```bash
> **机制：禁止在 `main` 上提交。** 本仓安装了一个版控的 pre-commit 钩子，在 `main` 上提交会被直接拒绝
> （确需直推时用 `ALLOW_MAIN_COMMIT=1 git commit …`）。安装一次即可：
> `cp scripts/git-hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit`
> 为什么需要它：2026-09-27 与 2026-10-04 两次误直推 `main`（第二次发生在纪律写进技能之后）——靠自觉不够。

npm test                          # 全量 30 套（29 条 node + 1 条 `[ -f … ]` 条件式；行为 + 契约 + 副本一致性 +
                                  #   清单/补丁目标门禁 + 升级标记 + 自动化链路门禁自证 + gh 凭据纪律）

第 18 套 `scripts/test-silent-failures.mjs` 是**静默失效审计**：它扫描"销毁/写入类操作的结果被忽略"的站点（Rust `let _ = std::fs::remove|copy|write|rename|create_dir*`、`.ok()` 吞错、JS 空 catch），每个站点必须在本行或上一行带 `// fail-open-ok: <理由>`。它**先跑 4 个变异夹具自检再跑审计**（自检不过即失败），也可单独跑 `npm run audit:self-test` —— 恒真的门禁不算门禁。
第 22 套 `scripts/test-bake-bridge-port.mjs` 守**"就地改写别人的源码"**这条路径：manager 把桥端口烘进插件 `client.js` 前，必须先用 `node:vm` 的 `Script` 编译候选（**与浏览器 `<script src>` 同语义**；`new Function` 与 `node --check` 都会放过脚本里非法的顶层 `return` —— 两个都实测过），编译不过就**保留原文件** + 留一行 `bridge port bake ABORTED`。同族的静态门禁在 `scripts/test-launcher-settings.mjs` 末尾：启动页 JS 里 `getElementById` 的每个 id 都必须在对应 HTML 里存在 —— 那个套件的 DOM 桩会**按需自动建元素**，所以光靠它测不出"HTML 里少了一个 id"（生产后果是 `null.addEventListener` 打死该页后续脚本，与顶栏事故同族）。

**Rust `let _ =` 的判读标准**（全仓约 108 处，2026-10-07 抽查后定稿、2026-10-17 成文）：以下三类**可接受**，但仍要在静默失效门禁里逐点标注 `// fail-open-ok: <理由>` —— ①纯尽力而为的清理（缓存/临时文件删除，失败无副作用）；②关闭/销毁路径（关窗、kill 进程，失败时已无补救动作）；③日志与通知写入。**不可接受**：任何"用户数据/配置/备份"的写入与移动（丢失不可逆），以及任何"后续逻辑依赖其结果"的调用（例如先建目录再往里写）。判据是**失败后有没有兜底或幂等重试**，不是"能不能忽略"。

**依赖面（2026-10-17 起是机制，不靠谁想起来）**：仓库已开启 Dependabot **漏洞告警** + **自动安全修复**（核验：`gh api -i /repos/<owner>/<repo>/vulnerability-alerts` 返回 204、`/automated-security-fixes` 返回 200；开启命令是同路径的 `-X PUT`），告警出现在仓库 Security 页、修复以 PR 自动开出。本地自查用 `npm audit --omit=dev`（当前 0 漏洞）。**为什么不把 `npm audit` 塞进 CI 必过**：它依赖 registry 网络，上游发一条与我们无关的 advisory 就会红掉整条 PR —— 门禁的信噪比比覆盖率更重要。

`scripts/test-chrome-bootstrap.mjs`（链上紧随 `test-shell-chrome`）是**壳注入脚本"真实初始化路径"的纯 Node
门禁**：`test-shell-chrome.mjs` 设了 `__DSH_CHROME_TEST__` ⇒ chrome 在 TEST_HOOK 处提前 return ⇒ 它后面那段
（挂载守卫 / 契约写入 / MutationObserver 自愈 / 引导上报）在单测里**从不执行**，而真机门禁 `test:chrome-real`
在 CI 里没有浏览器 ⇒ 恒 SKIP —— 0.18.0「注入即死」正是从这条缝里溜过去的。本套件用 `node:vm` + 手写最小 DOM
**不设 TEST_HOOK** 地加载 chrome，断言：上报链 inject→mounted→ready（无 fatal）/ 宿主与顶栏在 shadowRoot 里 /
宿主被移除 + 触发 MutationObserver 回调后自愈重挂 / 契约写入（顶栏契约开与关两态）/ 极早时序
（documentElement 与 body 尚为 null）不抛异常 / 桥请求准入头。它自带 **2 个内存变异体**（删 `if (rootEl)` 守卫、
删自愈 `observe` 注册）并**要求指定断言变红**——没红、或锚点与被测文本脱钩（夹具失效），整条套件判失败。
边界：没有渲染引擎，顶栏几何/菜单尺寸/点击命中仍只由 `test:chrome-real` 判定。

node scripts/test-copy-consistency.mjs  # 副本一致性（改了 scripts/ 或 plugins/ 后先 npm run sync:resources）
node scripts/test-shell-chrome.mjs  # 壳契约（菜单 id ↔ ACTIONS ↔ lib.rs）
node scripts/test-chrome-bootstrap.mjs  # 壳"真实初始化路径"（纯 Node、无浏览器；自带 2 个变异体）
# Rust：cargo clippy -D warnings + cargo test --lib（CI 快层会跑；本地有工具链时先跑）
# 注意：cargo fmt --check **不在 CI 里**（build.yml 里被注释：60 处历史格式差异），
# 格式靠自律——禁止提交全仓格式化 diff（会淹没真实改动）。
```

CI 分层：PR 只跑快层（check + test，~5min，含三套 CI 辅助脚本自检）；main/tag 跑全量（windows 打包+冒烟、linux 打包、**阻断式** linux-smoke）。

**外部网络访问必须走 npm / curl 的传输，不要用裸 `fetch`**：Node 的 `fetch` 不读 npm 的
`.npmrc` 代理配置，且代理变量与 `NODE_USE_ENV_PROXY` 在进程启动时就被采样（脚本内再设无效），
所以在「目标站点只能经代理访问」的网络下它一律超时。2026-09-22 一天内因此踩到三处：
`release-check`（插件仓库）拦下发布、`audit-preinstalled` 在零数据上打印通过、
`fetch-node` 全新构建下不到 Node。判据 grep：`grep -rn "fetch(" scripts/`。

## 发布（release-please 自动）

1. 合并到 main 后，release-please 依据 Conventional Commits 自动：
   版本 bump（Cargo.toml / tauri.conf.json / package.json 三处同步）→ CHANGELOG.md → 提 release PR。
2. **合并 release PR 前，先在发布分支上跑一遍本地门禁**（见下「release PR 的门禁」）。
3. 合并 release PR（**只能 admin 合并**，原因见下）→ release-please 自动打 `vX.Y.Z` tag。
     ⚠️ **Cargo.lock 必须手工同步（实测结论，非兜底）**：release-please **不会**更新
     `src-tauri/Cargo.lock` 里 `dsh-desktop` 的版本 —— `extra-files` 里的 toml+jsonpath 写法
     在 **v0.12.0 与 v0.13.0 两次发布上都不生效**（该条目已被删除，免得让人误以为它会自动做）。
     所以合并前**必须**在发布分支上把它改成新版本（`[[package]] name = "dsh-desktop"` 的 version），
     再跑 `node scripts/test-manifest-consistency.mjs`（「四处版本一致」门禁会立刻抓到遗漏）。
     为什么不能自动化替代：release-please 是 bot PR，其 workflow run 恒为 `action_required`，
     所以 CI 门禁**在发布 PR 上根本不上报** —— 这一步只能靠这份清单 + 手工执行。
   **并创建一个不带安装包的 GitHub Release**。
4. **在 tag 上派发一次构建**，否则 Release 永远没有安装包：
   ```bash
   gh workflow run build.yml --ref vX.Y.Z
   ```
   该 run 会编译 windows/linux 产物、把安装包挂到 Release、并用 `scripts/release-body.mjs`
   重写说明（说明里的 dsh 版本行由它查询 npm 得出）。约 15-20 分钟。
5. 不再手动改版本号、不打手动 tag（tag 归 release-please 所有）。

### release PR 的门禁（为什么必须 admin 合并）

release-please 是 bot 创建的 PR，它触发的 build run 状态是 **`action_required`**（GitHub 要求
人工批准 bot PR 的 workflow 才启动），因此 `check`/`test` **永远不会上报**，分支保护恒为
`BLOCKED`，`gh pr merge` 只会回 "base branch policy prohibits the merge"。人类 PR 的 build
则正常 success。所以发布 PR 的唯一合并路径是 `gh pr merge <n> --squash --admin`。

**替代验证（合并前必做）**：把发布分支取下来，跑

```bash
git fetch origin release-please--branches--main
git checkout FETCH_HEAD
node -e "…四处版本一致性…"        # package.json / .release-please-manifest.json / tauri.conf.json / Cargo.toml
grep -n "^## \[<version>\]" CHANGELOG.md
npm test                          # 25 条（另：npm run test:slow 跑安装卡死用例，约 3 分钟，不进 PR 门禁）
node scripts/audit-preinstalled.mjs
```

四处版本一致 + CHANGELOG 有该版本段 + 门禁全绿，才 admin 合并。2026-09-22（v0.11.0）是第一次
按这个流程走：本地门禁全绿 → admin 合并 → tag/Release 生成 → `workflow_dispatch` 补上三个平台
安装包。

> 过渡期说明：release-please 接管前发布的 `v0.3.x` 是手动 tag 流程；接入后以 release PR 为准。

## 开发版（同机并存调试）

开发版只本地构建（`D:\Dev\dsh-desktop-dev`，`npm run bundle:dev`），**不上 GitHub Actions**，
GitHub 只承载正式版。详见 README「开发版」小节与 `dsh-desktop-shell-dev` Skill。

## gh token（按项目隔离）

gh CLI 默认读全局 `~/.config/gh/hosts.yml`。本项目使用**项目专用 fine-grained PAT**
（仅授权 karoc/dsh-desktop，Permissions：Pull requests / Administration / Actions → write）：

1. 创建 token 后粘贴到 `~/.config/gh-dsh-desktop/token`（权限 600；`#` 注释行自动忽略）。
2. 进入项目目录时 direnv 自动 `export GH_TOKEN`（`.envrc`，已 gitignore，首次需 `direnv allow`）；
   或显式用包装命令 `./scripts/gh <args>`（不依赖 direnv）。
   脚本若走 `GH_BIN`，**缺省值必须指向 `./scripts/gh`，禁止默认裸 `gh`**（裸 gh 用全局 `hosts.yml`
   里的另一个 PAT，权限不同）；CI 里显式 `GH_BIN=gh` 是唯一例外。门禁：`node scripts/test-gh-bin-discipline.mjs`。
3. git push 走 SSH，不受 token 影响；CI 用 `secrets.GITHUB_TOKEN`，与个人 token 无关。
4. **过期纪律（A4）**：fine-grained PAT 的过期时间**没有 REST 端点可读**（`GET /user` 不返回
   `expires_at`）⇒ **创建/轮换 token 的最后一步必须把日期录进去**，否则没人知道它哪天失效：
   ```bash
   node scripts/dsh-token-meta.mjs set --expires YYYY-MM-DD [--note "创建于 <日期>，<用途>"]
   node scripts/dsh-token-meta.mjs check          # >14 天 ok / ≤14 warn / ≤7 urgent / ≤1 critical / 已过期
   ```
   录进 `~/.dsh/token.meta.json`（600、原子写、**只有 `expiresAt`/`note`/`recordedAt`，绝不含 token**；
   `--note` 里粘 token 形状会被**拒绝写入**）。**未录入 = 未知**（`check` 与 `npm run dsh:doctor` 都显示
   "未知"，**exit 0**）—— 这不是故障，但等于这一层防线没启用。每日检查用
   `check --notify --if-due --quiet`（可安全挂在 10 分钟循环上；只在级别跃迁时评论，写权不足只打印）。
   门禁：`npm run test:token-meta`（POSIX 下 124 条断言 + 3 条变异自证；Windows 上权限/gh 桩两组显式 SKIP）。

## 自动化链路的运维契约（A1 / A3 / A4 / A5 / A6 / A8 / A9）

依据 `docs/2026-10-24-alerting-and-idempotency-patterns.md` 的采用清单。这一节只写**判据和命令**
（"现在的事实 + 自己怎么验"）；为什么这样设计、放弃了什么，见该文档与
`.agents/notes/implemented/architecture/` 下的 Note。

| 层 | 现在的事实 | 自己怎么验 |
|---|---|---|
| **单写者（A1）** | `dsh-watch` 非 `--dry-run` 时整个进程包在 `flock -n -E 75 <state-dir>/locks/dsh-watch.lock`（默认 `~/.dsh/locks/`）；锁被占 ⇒ re-exec 的退出码 **75**，进程退出即释放（不会留"崩溃后永久死锁"）。`~/.dsh/PAUSE` 存在 ⇒ **跳过一切写**（只读探测 + 重复单报告照常，日志写明原因）。CI 的 `dsh-watch.yml` 是**设计上的第二个写者**，幂等靠"确定性去重键 + 每轮收敛对账"，**不是**靠锁 | 同时起两个：第二个 exit 75；`touch ~/.dsh/PAUSE` 后跑一轮 ⇒ 无写、日志带 PAUSE |
| **canary 凭据探测（A3）** | `npm run dsh:doctor` 用**真实凭据**对专用 canary issue（标题含 `[dsh-doctor] canary`，全仓只允许一条）做**可逆写**，输出八行能力矩阵（前 7 行必需；第 8 行是本地 PAT 过期元数据，**不参与退出码**）。`last-ok` 只在**全部必需能力通过之后**的末尾一步写（任一步失败 ⇒ 不写）。必需能力缺失 ⇒ **exit 1**；`--dry-run` 只读（写能力**未验证**，也不写心跳）。`admin=true` 与 UI 上的权限**永远不是判据**（GitHub 没有"模拟写"接口） | `npm run dsh:doctor -- --dry-run`；`npm run dsh:doctor`（真写，会留 `last-ok` 心跳）。`npm run test:doctor` 是它的 **82 条自测**（含「失败运行不得推进 `last-ok`」与「桩时钟 == 断言时钟」的防回归断言） |
| **PAT 过期元数据（A4）** | 过期时间**读不到**（个人 fine-grained PAT 没有 REST 端点）⇒ 创建/轮换时 `set --expires` 手录一次到 `~/.dsh/token.meta.json`（600、原子写、**不含 token**，只有 `expiresAt`/`note`/`recordedAt`）。分级 `>14 ok / ≤14 warn / ≤7 urgent / ≤1 critical / 已过期 expired`；**退出码只有 critical/expired 非零**，**缺失或损坏 ⇒ "未知" + exit 0**（没启用功能不是故障）。`check --notify --if-due` 每日门控 + **只在跃迁时**在跟踪单 `[automation] PAT 过期元数据（A4）` 里评论（回到 ok 自动关闭；403 ⇒ 只打印不重试）；doctor 矩阵第 8 行读同一文件，**不参与退出码** | `node scripts/dsh-token-meta.mjs set --expires YYYY-MM-DD`；`node scripts/dsh-token-meta.mjs check`（`--now <iso>` 可回放五级）；`npm run test:token-meta` |
| **反向心跳（A5）** | **只有全部必需能力通过（整轮 PASS）**才写 `~/.dsh/heartbeat.json`（`{lastOkAt, version, didWrite}`）并把 `last-ok=<ISO>` 写进 canary 正文（**末尾一步**）；**任一步失败 ⇒ 两者都不推进**（失败运行不伪造心跳新鲜）。诊断走 stdout / `--json` 的 `lastFailAt`/`lastFailReason`，**不进心跳判据**；云端只读 `last-ok`。`.github/workflows/dsh-heartbeat-check.yml`（每日 03:00 UTC）读该字段：>26h ⇒ 评论 `@owner` + `priority:high`、**exit 3**（3 = 已报警，设计内的失败）；canary 缺失 ⇒ 先建再判断（26h 宽限，不误报） | `cat ~/.dsh/heartbeat.json`；`./scripts/gh issue view <canary> --json body` 看 `last-ok` |
| **三态退避（A6）** | `~/.dsh/state/<tool>.json` 记 `healthy`/`degraded`/`broken` + 退避 5→10→20→40→**封顶 60 分钟**；**只在跃迁时**发一条 issue 评论；broken 之后每轮 stdout 只有一行、**退出码 0**（否则与 systemd `Restart=on-failure` 叠成热循环）；403/404 这类不可重试错误**立即 broken**。`--reset-state` 只重置本地状态；`--no-backoff` 是负向对照 | `node scripts/dsh-watch.mjs --dry-run` 前先看状态文件；`node scripts/test-backoff-state.mjs`（`--no-backoff` 必须退回"每轮全量错误 + 0 条跃迁评论"） |
| **保留（A8 / A9）** | 日志：模板 `scripts/logrotate.dsh.conf` + README 的用户级安装与 timer（**装不装是用户动作**，仓库不动你的 systemd）。hang dump：**最新 3 份 + 14 天 + 总量 ≤1GiB**（`src-tauri/src/retention.rs` 的 `HANG_DUMP_POLICY`，单测钉住这三个数；"**永不清空目录**"是硬边界）。`.detail.log` 自带 128KB 截断 | `systemctl --user list-timers | grep logrotate`；`du -sh <应用数据目录>/runtime/reports`；Rust 侧由 CI `check` job 的 `cargo test --lib` 覆盖 |
| **Actions `schedule` 不是时钟（A7）** | 官方明确 `schedule` 不保证准时（可延迟数小时，也可能丢弃）。`dsh-watch.yml` 的 `*/15` 是"本机没在跑时的兜底覆盖"，**不是 SLA 主时钟**；SLA 的检测段 T0 取同版本**最早** issue 的 `createdAt`（与哪个写者建的无关），检测延迟**不进门禁** | `./scripts/gh run list --workflow dsh-watch.yml --json createdAt,startedAt` 与本机 timer 日志时间对比 |

**门禁侧的对应要求**：这七层里凡是"能失败"的判据都必须带负向对照。`scripts/test-automation-gates.mjs`
新增的 **doctor 组**跑 `dsh-doctor --self-test`（内置 gh 桩，不碰真实仓库），并用 **2 条变异对照**证明
「必需能力缺失（403）⇒ 退出码非零」与「`last-ok` 挪回"改正文"处 ⇒ 失败运行伪造心跳新鲜」这两条出口真的在判 —— 把它们改坏，整条套件变红。

## 知识沉淀

- 改壳功能/新踩坑 → 更新 `.dsh/skills/dsh-desktop-shell-dev/SKILL.md`（加菜单、桥端点同步契约测试）
- 非平凡改动 → Agent Note（`.agents/notes/implemented/<class>/`）+ 看板卡片（三字段齐全）


## CI 里的度量作业（非必过）

`rust-coverage`（2026-10-15 起）：在 push 到 main / tag 时跑 `cargo llvm-cov --lib --summary-only`，**只报告不设阈值**（先有数字再谈门槛）。它**不在 PR 的必过检查里** —— 度量不该拖慢每个 PR。基线（2026-10-15，main run 38605299315）：`lib.rs` 行覆盖 **15.72%**、`manager_guard.rs` 86.88%、`web_dump.rs` 72.38%，**TOTAL 行 23.68%**。含义：Rust 侧被测到的主要是纯函数，**桥 / 安装器 / 进程与窗口生命周期基本没有测试**。

## CI 冒烟与外部源重试（2026-10-22）

**`linux-smoke` 现在是阻断式门禁**（`continue-on-error` 已删除）。它执行 `scripts/ci-linux-smoke.sh`：
解出 artifact 里的 `.deb` → 定位 `usr/bin` 入口 → 在 headless xvfb（+ 有则用 `dbus-run-session`、软件渲染环境）
里启动**打包后的 app** → 有界轮询（默认 180s，`SMOKE_WAIT_SECONDS` / `SMOKE_TIMEOUT_SECONDS` 可调）直到
① `resources root:` 出现且该目录里真有 `node/linux-x64/node`；② URL 事件出现在 manager 协议流里。
app 提前退出即失败；超时打印进程/GL/日志诊断。历史教训写在该作业的注释里：旧的固定 `sleep 18`
在 runner 上必然早于 app 的首行输出，这条 "canary" 于是每天红、又因 `continue-on-error` 在 run 级显示绿
——**假绿比红更贵**（它让真回归无从分辨）。

改判据前先跑自检（CI 快层也会跑）：

    node scripts/test-ci-linux-smoke.mjs   # 静默 app / 假 resources / 缺 node / 无 URL / 早退 / 缺 deb ⇒ 必须红；完整链路 ⇒ 绿

**windows 的 7-Zip 不再直连社区源**：`node scripts/ci-choco-install.mjs 7zip` —— 已装则完全不联网；
否则最多 3 次、间隔 25s 的有界重试（每次打印原因 + 输出尾巴）；预算耗尽仍 exit 1（不吞错 —— 缺 7-Zip
时 NSIS 布局断言会静默失效）。自检：`node scripts/ci-choco-install.mjs --self-test`
（2 失败后成功 ⇒ 绿；3 次全失败 ⇒ 红；已装 ⇒ 0 次调用；首次成功 ⇒ 只跑 1 次）。
两条自检都挂在 build.yml 的 `test` 作业上，所以"把门禁改成永真"的回归会在 PR 阶段被挡住。

## CI 的 Ubuntu 系统依赖（2026-10-24）

四个作业（`check` / `rust-coverage` / `linux` / `linux-smoke`）的 apt 安装统一走
`scripts/ci-apt.sh <tauri|smoke>`，workflow 里不再内联 `apt-get`。动因是实测出来的极端抖动：
同一条 `apt-get install` 在 runner 上从 **21s** 到 **27m20s**（run 40024960026 的 `check`）、
`linux-smoke` 17m03s（run 40029539904）——下载源逐个包卡住，而 apt 没有总时长上限，PR 于是
卡在 `check=pending`，发布日的 6h 预算也被慢步吃掉。

脚本做三件事：

- **缓存**：workflow 用 `actions/cache` 持久化 `$RUNNER_TEMP/apt-archives`；脚本在安装前把缓存
  里的 `.deb` 放进 apt 归档目录、安装后回写（只留本次实际用到的版本，缓存不随版本膨胀）。缓存 key
  含 **Ubuntu `VERSION_ID`**、profile 与 `hashFiles('scripts/ci-apt.sh')` ⇒ 改包列表/换 Ubuntu 版本
  会自动 miss 一次，不会拿旧包装新环境；命中时 apt 直接本地安装，**慢源对已缓存版本不再有影响**。
- **`--no-install-recommends`**（`tauri` 档）：Ubuntu 24.04 上实测少装 52 个推荐包（与编译无关）。
  `smoke` 档**故意保留 recommends**：headless WebKit 依赖 xvfb 推荐的 mesa/GL 与 portal 组件，
  它是阻断式真门禁，不拿它做体积优化。
- **有界重试**：默认 3 次（`DSH_APT_ATTEMPTS` 可调），每次打印失败原因；预算耗尽仍 exit 1 ——
  没有 `|| true` / skip / continue-on-error。

自检（不联网、不需 root，CI 快层会跑）：`bash scripts/ci-apt.sh --self-test` —— 首次成功、瞬时故障
恢复、预算耗尽必须红、缓存命中先导入后回写共 4 个用例。

**改系统依赖的入口**：编辑 `scripts/ci-apt.sh` 里对应 profile 的包列表，不要回到 build.yml 写裸
`apt-get`（否则那一步会绕过缓存与重试，慢源问题原样复现）。

## 门禁自身的验证（2026-10-07 起，硬规则）

**任何新增的门禁/断言，必须在同一个 PR 里带一个"注入对应缺陷 ⇒ 必须变红"的夹具**，否则视为未验证（恒真的门禁比没有门禁更糟：它给出虚假的安心）。本仓已有先例：`scripts/test-silent-failures.mjs` 的 4 个变异夹具、`test-shell-chrome.mjs` 的变异对照。反面教材（2026-10-07）：静默失效审计脚本的前两版试图"自动跳过 `#[cfg(test)]` 区域"，两次都判错 —— 一次**漏检生产代码**（假阴性），一次把 20 条测试区命中当生产报出；是夹具把这两次都钉了出来。

**本条已被 `scripts/test-automation-gates.mjs` 遵守**（2026-10-19 起，`npm test` 链上的一员）：它是"自动化链路判据的可失败性"自证套件，自带 **7 条变异对照** —— 在**工作树临时副本**（`tar` 排除 `.git`/`node_modules` 等）上分别把「探针的 seam 判据」「`dsh:adapt` 第 6 步"探针 RED 却继续"」「`dsh:adapt` 第 6 步"探针没出报告"的放行分支」「SLA `--check` 的"没有数据即红"」「漂移检测的"目录不存在"守卫」「`dsh-doctor` 的"必需能力缺失（403）仍以 0 退出"」「`dsh-doctor` 的"改正文时就写 `last-ok`"」改坏，断言**本套件在副本上变红**，且每条都配一个"未注入时该组必须是绿的"对照（同一份副本）。它**绝不修改仓库文件**（副本 + `--only <组> --fast --no-mutation` 子跑）；已知仍不完美的判据标 `KNOWN_GAP`（只逐条打印、不判红，既不掩盖假绿、也不因为别的 PR 正在修它而把链判红）。用法见 `README.md` 的「维护者：dsh 升级自动化」小节。

**行为改动必须同步文档（这道门禁是活的）**：`.github/workflows/build.yml` 的 `test` job 里有一条步骤
**「文档同步」**（只在 `pull_request` 事件、且非"板卡专属 PR"时跑）：本 PR 的变更文件里出现
`src-tauri/resources/ui/shell-chrome.js` 或 `scripts/server-manager.mjs` 时，**必须同 PR 改 `README.md`**，
否则该步骤红（可用 PR 标签 `docs-not-needed` 显式放行）。判据是 `git diff --name-only origin/<base>...HEAD`，
而 `test` job 的 checkout 是 `fetch-depth: 0`（2026-10-15 的**一行级**修复）—— 早先的浅克隆拿不到 base 对象、
"取不到就跳过"= 静默放行的假阴性门禁，已修掉。结构校验只能保证"文档存在"，语义一致性仍由交付前逐句走查负责。

> ⚠️ **已知覆盖缺口（2026-10-19 登记）**：白名单目前**只有** `src-tauri/resources/ui/shell-chrome.js` 与
> `scripts/server-manager.mjs` 两个文件。而维护者向的行为面还包括 `scripts/dsh-adapt.mjs` /
> `scripts/dsh-compat-probe.mjs` / `scripts/dsh-sla-report.mjs` / `scripts/dsh-watch.mjs` 与四个自动化 workflow
> （`dsh-watch` / `dsh-sla-report` / `tag-dispatch` / `preinstalled-sync`）—— 改它们的**参数名、issue label、
> 门槛数值、判据**都不会被要求同步任何文档（README / 本文件 / 方案文档都不查）。2026-10-19 那批
> 「参数名与门槛文案漂移」能长期存活，结构原因就在这里：**门禁的覆盖面比"行为面"窄**。
> 补白名单之前先想清楚哪些文件**真的需要**文档同步：README 是用户向真源，维护者向的自动化细节可以只由
> 方案文档（`docs/2026-10-17-dsh-upgrade-automation-plan.md`）与 Agent Note 承载 —— 若要扩白名单，
> 应同时定义"改了它必须改哪份文档"，否则只是把假阴性换成假阳性。

**板卡专属 PR**：只改 `KANBAN.json` 的 PR 会跳过 `check`/`test` 的重步骤（`cargo`/`npm test`），但两个必过检查仍照常上报（分支保护要求 `check`+`test`，用 `paths-ignore` 会让它们永不上报、PR 卡死 —— 所以是"作业照跑、步骤条件化"）。
