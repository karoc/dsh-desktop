# Agent Note: dump-retention-three-dimensions

Status: implemented

## Problem

挂起 dump 是唯一还能拿到内存现场的证据（`dsh web` 挂起时进程还在，被杀之后地址空间已销毁），所以壳在每次挂起时抓一份**全内存 dump** —— 单个可达数百 MB（2026-09-17 实测 `runtime/reports` 1381MB，其中大头就是最新那一份）。但保留策略只有一个维度：`web_dump::prune_dumps` 按文件名只留最新 3 份（`HANG_DUMP_KEEP`）。两个方向都不够：① 长期不产生新 dump 时，旧的 3 份会一直占着磁盘、时间上永远不过期；② "份数少"不等于"总量小"—— 3 份 × 数百 MB 已经能吃掉 1GB+。采用清单 A9（`docs/2026-10-24-alerting-and-idempotency-patterns.md` §5.4 / §7）要求补上时间与总量两个维度；当时 README 与方案文档都把这个缺口写成"未实现（`src-tauri/**` 不在本轮写域）"。

## Decision

`src-tauri/src/retention.rs` 是保留策略的**单一定义点**，零依赖（只用 `std`）：`RetentionPolicy { keep_newest, max_age, max_total_bytes }`、`Candidate`、`RetentionOutcome`、`is_older_than`、`plan`（纯函数：算该删哪些）与 `prune`（扫目录 + 调 `plan` + 真删）。挂起 dump 的策略只有一处：`HANG_DUMP_POLICY = HANG_DUMP_KEEP(3) + HANG_DUMP_MAX_AGE_DAYS(14) + HANG_DUMP_TOTAL_CAP_BYTES(1GiB)`；`lib.rs` 里原来的 `const HANG_DUMP_KEEP` 已删除，`web_dump::prune_dumps(dir, prefix)` 退化成薄封装（签名不再收 `keep`，返回实际删除份数），两个调用点（每次 dump 之后、`cache_cleanup_json`）都引用同一策略。

规则顺序固定为**时间 → 份数 → 总量**：早于 `now - 14d` 的删；按文件名升序只留最新 `keep_newest` 份（dump 名里带单调时间戳 ⇒ 名字序 = 时间序）；存活部分总量超 1GiB 时从最旧的删到不超。同样的输入永远得到同样的删除集合（与输入顺序无关）。只处理文件名以 `dshweb-hang-` 开头的**普通文件** —— 同目录下的 `report*.json` 与子目录不动。

三条负向保证：**永不清空目录**（无论规则怎么叠加，最新一份永远保留；时钟跳变、目录被整体拷回、`mtime` 全旧时这是唯一兜底）；**`mtime` 读不到 ⇒ 保留**（没有判断不等于"很旧"；`now.checked_sub(max_age)` 失败同样保留）；**删除失败只少记一次**（`Removed`/`freed_bytes` 是实际结果，不假成功、不中断其余删除，目录读不到就是 no-op）。

验证：`retention.rs` 自带 8 条单测，由 CI `check` job 的 `cargo test --lib` 常驻执行；因为模块零依赖，只有 rustc 的机器也能 `rustc --test src-tauri/src/retention.rs` 跑同一批断言（本轮实测 8/8 绿、`clippy -D warnings` 干净）。可失败性由 4 条变异对照证明（本轮实跑，每条都让单测变红）：时间判据恒不成立、份数维度失效、总量维度失效、删掉"永不清空目录"边界。

数字取 **1GiB** 而不是清单表里的 2G：README 与看板早先已定「3 份 + 14 天 + 总量 ≤1GB」，同一策略不能留两个数；`hang_dump_policy_matches_the_documented_numbers` 这条测试把三个数字钉在代码里，改数字必须同改文档。

## Alternatives considered

**把策略实现进 `scripts/server-manager.mjs`（Node 侧更易测）**：否决 —— manager **根本没有** dump 保留路径（`grep -n dump` 只命中看护协议：请壳抓 dump / 等 dump-done / 重启），dump 由壳创建、也由壳清理；把策略搬到 Node 等于让"谁写文件谁负责"断掉，还要多一条跨进程契约。

**从文件名解析时间戳，而不是用 `mtime`**：否决 —— 名字是 `dshweb-hang-<pid>-<ts>`，一旦文件被复制/改名，"名字里的时间"和"文件实际年龄"就会分叉；`mtime` 是文件系统自己的年龄信号，不需要额外格式契约。

**策略留在 `web_dump.rs` / `lib.rs` 里就地测**：否决 —— 这两个模块依赖 `tauri`（Linux 上要 gtk/webkit 开发包），本机装不了就**一条断言都跑不了**，"测不了"会被当成"没问题"。单独成零依赖模块后，判据在任何有 rustc 的机器上都能执行。

**加一条 npm 测试套件，用 `rustc --test` 跑这个模块**：否决 —— CI 的 `test` job 没有 Rust 工具链，套件会在每次 CI 里静默 SKIP（假门禁）；永久门禁交给 `check` job 的 `cargo test --lib`，本地再按需用 rustc 复跑。

**时间维度直接把"超过 14 天"的全删（包括最新那份）**：否决 —— 时钟跳变或"把旧 reports 目录整体拷回来"会让唯一的取证文件消失，而保留一份的代价只是有界磁盘；与"没有判断 = 不能删"一致。

## Consequences

买到的：`runtime/reports` 不再可能无界增长（时间 + 总量两道闸），同时"证据永不被清空"这条边界把误删风险压到最低；策略变成可在任何机器上执行的判据，而不是只存在于 README 的一段建议。

代价与边界：① 每次 dump 与每次缓存清理都会 stat 一遍候选文件（目录只有几份，成本可忽略，但它是同步路径）；② 三个数字在文档里另有一份拷贝，靠一条单测钉住同步；③ 只管 `dshweb-hang-` 前缀（其它证据文件刻意不碰，要纳管得显式加前缀）；④ 策略没有运行时开关/CLI 覆盖（可调参数只有代码里的常量）；⑤ `mtime` 语义意味着"后来拷进目录的旧 dump"会按拷贝时间算年龄。

相关：[告警/幂等清单研究](../process/2026-10-24-alerting-idempotency-research.md)、[退避/日志保留（A6/A8）](2026-10-24-automation-backoff-state-machine.md)、[doctor canary 与反向心跳](../feature/2026-10-24-doctor-canary-and-reverse-heartbeat.md)。
