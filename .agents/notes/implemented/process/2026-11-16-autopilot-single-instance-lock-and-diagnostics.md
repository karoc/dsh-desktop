# Agent Note: autopilot-single-instance-lock-and-diagnostics

Status: implemented

## Problem

`scripts/dsh-release-autopilot.mjs` 是 10 分钟一轮的 timer 任务，但它与 `dsh-watch` 不同，没有本机互斥：手工起一轮排查时 timer 轮次照样起来，两轮各自 clone、各自装临时 runtime、推同一条 `auto/dsh-<target>`，`dsh-adapt` 第 7 步于是出现**不可复现**的红（资源竞争），当天实测白花 1-2h 分辨"真失败"与"两轮打架"。第二类缺陷在诊断上：子进程失败走 `tail()`，只保留 stderr **末 3 行** —— 真正的根因（`ssh: connect to host github.com …`）在第一行，日志里只剩 `Please make sure you have the correct access rights` 这类尾巴；`dsh-adapt` 第 7 步的 detail 也只有 `2/33 套失败`，没有失败套件的名字，autopilot 转发 adapt 输出时又把 `      FAIL <套件命令>` 行过滤掉了。结果同一次排障要在克隆里手工重跑整条链才能拿到套件名。

## Decision

单实例与诊断两件事都在同一次提交里落地（`fix(automation)`）：

**flock 单实例**（与 `dsh-watch` 的 A2 同一套语义，照抄 re-exec 实现）：非 `--dry-run` 的 autopilot 进程在**任何写操作之前**用 `spawnSync('flock', ['-n','-E','75', <lock>, process.execPath, SELF, ...process.argv.slice(2)])` 把自己重执行为锁内子进程，env `DSH_AUTOPILOT_LOCK_HELD=1` 让子进程认自己已在锁内（不递归）。锁文件固定为 `<state-dir>/locks/dsh-release-autopilot.lock`（默认 `~/.dsh`；`--state-file` 只改状态文件、不搬锁）。语义与负向保证：`--dry-run` **不加锁**（它承诺"不写任何东西"）；锁被占（flock 退出码 75）⇒ 打印一行 `已跳过本轮（skipped by lock）：另一实例在跑…` 并 **exit 0**（本轮没干活、也不是新故障，不让 systemd `Restart=on-failure` 记红/叠热循环）；`flock` 缺失（ENOENT）⇒ **显式告警一行后继续**（写操作仍是收敛式：确定性键 + 对账）；flock 被信号杀死/状态不是数字 ⇒ exit 1（不带着未知互斥状态去写）；父进程把子进程的退出码原样透出。锁内轮次打印 `已获取本机独占锁（flock …）` 一行，作为"走的确实是 flock 路径"的可观察证据。锁位置在退避跳过/`--reset-state` **之后**、运行时守卫**之前**：跳过轮本来就不干活，没必要抢锁；树守卫放在锁内才只由真正干活的实例告警一次。

**诊断不再截断**：`tail()` 从"末 3 行"改成 **首行 + `…` + 末 3 行**（行数 ≤4 时全量；`…` 明确表示中间有省略，不假装全文）；`mustRun` / `gh` / `git` / `dsh-adapt` / `dsh-rehearse` 的失败统一走 `failChild()`：摘要 + 完整 stdout/stderr 追加到 `<state-dir>/<tool>.detail.log`（`tool` 取被调命令：node 跑脚本时用脚本名，否则用命令名；128KB 上限，超过只留尾部 400 行，0600），错误文案末尾带 `（完整输出：<path>）`。`--dry-run` 不落盘（"不写任何东西"是字面承诺）；写不进去只返回 null，不改变退出码。`dsh-adapt` 第 7 步的 abort detail 改成 `N/M 套失败：node scripts/test-a.mjs；…`（按失败顺序逐个列出 raw 命令名），autopilot 转发 adapt 输出时保留 `      FAIL <套件命令>` 与汇总段 `  ✗ …` 行。

## Alternatives considered

**用 `open(path, 'wx')` 的自有锁文件**：否决 —— 进程崩溃后留下永久死锁文件，下一轮告警/发版再也不会发出；flock 的"进程退出即释放"是这里唯一可接受的语义。
**加 `--lock-file` 参数**：否决 —— 锁必须跟着 `--state-dir`（手工轮次与 timer 轮次才会共享同一把），多一个覆盖入口只会制造"两边各锁各的"这种假互斥；测试用 `--state-dir` 就能把锁收进临时目录。
**锁被占时 exit 非零（让 systemd 看见）**：否决 —— 那不是故障，systemd 会按 `Restart=on-failure` + 退避把心跳拖成 1h/轮（今天已真实发生过的形态），反而掩盖真正的失败。
**失败时把完整 stderr 直接打到控制台/issue 评论**：否决 —— `dsh-adapt` 的完整输出可达数 MB，日志与 issue 都不是 dump 的地方；摘要 + detail.log 路径兼顾"一眼看到根因首行"与"完整现场可复查"。
**把 `tail()` 改成返回全文、由调用方自己截**：否决 —— 调用方有 5 处（mustRun/gh/git/runAdapt/prepareRuntime），很容易再次漂移出"某处又只留尾巴"；收敛成一个 `failChild()` 出口才守得住。
**给 adapt 的 FAIL 行单独存一份日志**：否决 —— 完整输出已经整份落 `dsh-adapt.detail.log`，再存一份是同源两份、必然漂移。

## Consequences

买到：手工轮次与 timer 轮次不再互相踩（后到者 exit 0 跳过且零 gh 调用）；子进程失败的根因首行一定出现在日志/issue 摘要里，完整现场固定落在 `<state-dir>/<tool>.detail.log` 可直接贴给排障；`dsh-adapt` 第 7 步失败时一眼看到是哪几套，不用回克隆重跑。闸门是 `scripts/test-autopilot-release-resume.mjs` 的第 11/12 组（真起一个持锁进程 ⇒ 第二个实例 exit 0 且零 gh 调用；多行 ssh 错误 ⇒ 文案含首行、中间省略、detail.log 落盘并含被省略行），并已做三处变异自证（75 分支 exit 改成 1、tail 改回末 3 行、persistDetail 直接返回 null ⇒ 对应用例必红）。代价与边界：① flock 只保**本机**，CI 里的 GitHub 侧写者不在覆盖内（与 watch 相同）；② flock 缺失时只有告警、没有互斥（Windows 开发机直接跑）—— 这是显式降级，不是静默；③ detail.log 是"最近若干次失败"的滚动现场（128KB 自截断），不是按轮次归档，跨轮对比要自己留档；④ `--dry-run` 失败时不落 detail.log，只能看到摘要；⑤ 摘要仍按字符数截断（首行很长时末几行可能被切），完整内容始终以 detail.log 为准。
