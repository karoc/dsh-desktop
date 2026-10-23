# gh 凭据纪律：脚本缺省必须解析到 `scripts/gh`，新增可失败门禁

## 问题

本仓有两个 PAT：项目专用 fine-grained token 在 `~/.config/gh-dsh-desktop/token`（由 `./scripts/gh` 注入
`GH_TOKEN`），全局 `~/.config/gh/hosts.yml` 里还有同一账号的另一个 token（`Active account: false`，权限不同）。
`scripts/dsh-watch.mjs` 曾把 `GH_BIN` 缺省成裸 `gh` ⇒ 定时器静默使用了错误的 PAT；上一版修复又因只改
`const GH` 而漏导入 `existsSync`，使兜底分支在"仓库里没有 wrapper"时运行时 ReferenceError。两件事都说明：
只靠一次性改代码，这类凭据路由错误会反复出现。

## 决定（现状）

- 四个 gh 消费者统一规则：缺省值必须落到仓库内的 wrapper。`dsh-watch.mjs`、`dsh-release-autopilot.mjs`、
  `dsh-sla-report.mjs` 用 `process.env.GH_BIN ?? (existsSync(join(ROOT, 'scripts', 'gh')) ? join(ROOT, 'scripts', 'gh') : 'gh')`
  （绝对路径，存在性检查后才用）；`dsh-doctor.mjs` 用 `GH_RAW = process.env.GH_BIN ?? 'scripts/gh'` 再按相对
  路径拼到 `ROOT`。显式 `GH_BIN` 仍然优先：CI 的 workflow 设 `GH_BIN=gh`（runner 上只有 `GITHUB_TOKEN`、
  没有 token 文件）是**唯一被允许的裸 gh 用法**，它是注入值而不是缺省值。三个脚本末尾的 `: 'gh'` 只是
  "仓库文件不完整"时的显式兜底，正常 checkout 不会走到。
- 新增 `scripts/test-gh-bin-discipline.mjs` 并接入 `npm test`（`test-automation-gates` 之后），三条断言：
  ① `scripts/**/*.mjs` 不得出现 `GH_BIN ?? 'gh'` / `GH_BIN || 'gh'`（命中列 file:line；显式 `GH_BIN: 'gh'`
  的子进程注入不算）；② 上述四个消费者必须保留指向 `scripts/gh` 的兜底（删掉兜底也判红）；③ 仓库里
  写下的 systemd unit 模板（脚本头注释的 `//` 块 + README/CONTRIBUTING/docs 的 fenced block）只要
  `ExecStart=` 启动上述脚本，就必须有 `Environment=GH_BIN=…/scripts/gh`，缺了或写成裸 `gh` 都判红。
- 第 ③ 条不假设模板托管在仓库里：本仓**没有** `.service`/`.timer` 文件，模板只存在于文档与
  `dsh-release-autopilot.mjs` 头注释；因此门禁断言"至少找到 1 个 gh 相关模板"，模板搬家时会因找不到而红，
  提醒把扫描位置一起迁走，而不是静默放行。
- 门禁自带负向对照（合成夹具上判据必须能红能绿），防止把判据改成恒真/恒假后仍然全绿；本次外部验证在
  `/tmp` 副本上做了 4 个变异：判据恒假、重新引入裸 gh 缺省、删掉兜底、删掉模板里的 `Environment=GH_BIN`，
  全部 exit 1，还原后 exit 0。
- 文档同步：README「本地验证」与「维护者」补凭据纪律 + 新套件说明，CONTRIBUTING 的 gh token 小节补同一条；
  `npm test` 链 28 → 29 套，README/CONTRIBUTING 的"全量 N 套"与 plan 文档的链长计数一并更新。

## 被放弃的替代

- **硬编码 `scripts/gh`，去掉 `GH_BIN` 注入点**：CI runner 没有 token 文件，且演练/负向对照需要 gh 桩，
  必须保留显式注入优先。
- **只修 watch、不加门禁**：这正是上一轮"修复版漏导入"能溜过去的原因；没有可失败断言的修复不算闭环。
- **门禁只做正则扫描**：`const GH = process.env.GH_BIN`（无兜底）不落进"裸 gh 缺省"正则，却同样会让
  watch 在最小 checkout 里崩掉；所以补了 ② 的正向兜底断言。
- **只扫脚本头注释里的 unit 模板**：README/docs 也是模板的落点（且用户真正照抄的是它们），所以 ③ 同时扫
  两类载体；代价是模板格式变化时要同步解析器。

## 后果

`npm test` 多一套（~0.1s、纯静态，无网络/无外部依赖）。PR #224 的 `Cargo.lock` 对齐若尚未合并，
干净 checkout 上 `test-manifest-consistency` 的"四处版本一致"仍需先跑 `sync-cargo-lock-version.mjs`
（CI 的 test 作业本来就在 `npm test` 前 sync）；本次没有把该锁文件改动混进本 PR。行为侧只验证到
"缺省的 GH 解析到 wrapper"（用 PATH 上的 gh 桩记录 `GH_TOKEN` 是否由 wrapper 注入），没有断言 GitHub
API 实际接受了哪个 token —— 那需要真实写操作，不在门禁范围内。
