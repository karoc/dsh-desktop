# Agent Note: cargo-lock-version-sync-eol

Status: implemented

## Problem

`npm run bundle`（= `npm run sync:cargo-lock && tauri build --bundles nsis`）在 Windows CI 上连续多日红在第一步：`scripts/sync-cargo-lock-version.mjs` 报 `FAIL: Cargo.lock 里找不到 dsh-desktop 包段`。它意味着**打不出 NSIS 安装包**，即整条发版链路（含用户当时急需的 v0.18.1）被卡死。失败只在 CI 的 windows job 出现，ubuntu job 与本地 Linux 全绿；同一脚本在 v0.18.0 的 tag 构建里却是绿的，很容易被误读成"偶发"。

## Decision

脚本改为**按文件实际行尾解析、按原行尾写回**：先探测 `\r\n` 是否存在决定 EOL，再用该 EOL 构造 `[[package]] / name = "dsh-desktop" / version = "…"` 的匹配（仍是精确匹配，不会误伤 `dsh-desktop-helper` 这类同前缀包），写回时沿用同一 EOL —— 否则 CRLF 检出的文件会被整份改写成 LF，git 会把整份文件看成"改了"。真的找不到包段时不再只说一句"找不到"，而是打出四项判据：`size` / `CRLF行` / `出现包名` / `采用EOL`，让下一个人一眼归因（本次就是靠它确认"文件在、包名在、EOL 判 LF"）。真实故障成因：GitHub 的 Windows runner 以 `core.autocrlf=true` 检出 ⇒ Cargo.lock 到手是 CRLF ⇒ 旧实现硬编码 `\n` 的正则匹配不上；v0.18.0 那次之所以绿，是因为当时 lock 里 `dsh-desktop` 还是 0.17.0、`cargo test --lib` 先把它整份重写成了 LF（同一脚本在 tag 构建打印 PASS、在 main 构建打印 FAIL，内容差异只有版本号与这次重写）。

附带落了两件配套：`DSH_LOCK_ROOT` 环境变量（**只给测试用**，指向临时目录，正常构建不设）与 `scripts/test-cargo-lock-sync.mjs`（5 条判据：LF 落后→FIXED 且保持 LF；**CRLF 落后→FIXED 且必须保持 CRLF**；CRLF 已一致→PASS 且文件零改动；缺包段→exit 1 且 stderr 带四项判据；同前缀包段不被改写），接入 `npm test` 成为第 21 套，README/CONTRIBUTING 的"全量 N 套"同步更新（`test-manifest-consistency` 会核对这个数字）。
## Alternatives considered

**加 `.gitattributes` 把 `src-tauri/Cargo.lock` 钉成 `text eol=lf`。** 能让 CI 变绿且一劳永逸，但已把该文件检出为 CRLF 的开发机在下次 pull 时会被 git 显示成"已修改"，给用户制造新的困惑；脚本自身对行尾免疫是更小的爆炸半径，所以选了后者。

**让 windows job 跳过 `sync:cargo-lock`（改 CI）。** 本仓 CI 文件曾两次因块级编辑被弄成"零作业"，且那只是绕过失败而不是修复失败。

**只把错误信息写得更清楚（保留 `\n` 硬编码）。** 诊断会变好，但安装包仍然打不出来。

**把 `sync:cargo-lock` 从 `npm run bundle` 里摘掉，改由 CI 在 tag 构建前单独跑。** 本地构建（`bundle:dev` / 宿主正式版本地构建）同样依赖这一步，摘掉等于把漂移留给本地与用户的机器。
## Consequences

代价与边界：脚本现在接受两种行尾，因此**不再**充当"行尾一致性"的守卫（它本来也不该是）；Cargo.lock 在 release-please 合并后仍会漂移，那张流程卡（"每次发布合并后 main 的 Cargo.lock 必然漂移（需自动化）"）依然独立存在，本修复只保证"漂移了也能同步、且同步不再因平台行尾而失败"。收益：windows job 从连续红转为 12m9s 绿（run 38776333991，日志 `PASS: Cargo.lock 的 dsh-desktop 已是 0.18.0` + `Finished 1 bundle`），发版通道恢复；并且这条失败模式从此有回归测试钉住 —— 把 EOL 构造退回 LF 硬编码（保留测试钩子）跑一次，CRLF 两条立刻变红并打印与 CI 完全一致的错误串。

相关：`scripts/sync-cargo-lock-version.mjs`、`scripts/test-cargo-lock-sync.mjs`、`npm run test:cargo-lock-sync`。既有同族修复见 `.agents/notes/implemented/bug-fix/…`（release-please 不更新 Cargo.lock 的那次）。

