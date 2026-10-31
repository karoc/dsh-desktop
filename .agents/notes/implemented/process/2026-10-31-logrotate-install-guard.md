# Agent Note: logrotate-install-guard

Status: implemented

## Problem

`scripts/logrotate.dsh.conf` 是带 `@HOME@` 占位符的模板。本机曾把模板**原样拷贝**成 `~/.dsh/logrotate.dsh.conf`（没有替换），logrotate 报 `lines must begin with a keyword or a filename`、日志长期不轮转；安装路径没有任何守卫，一个字符的引号/漏步就会得到一条难读的失败。另外模板只列了三个 timer 日志，`dsh-doctor.log`（每日任务 append，正在增长）没被纳管。

## Decision

新增 `scripts/install-logrotate.mjs`：读模板 → `split('@HOME@').join(home)` **全局替换**（等价 replaceAll；`String.replace` 只换第一处，正是事故形态）→ 校验：①输出不得残留 `@HOME@`（报处数/行号）②非空 ③顶层日志路径必须是绝对路径（支持一行多路径/引号/`path {` 同行，块内指令跳过）④系统有 logrotate 时把替换后内容写临时文件跑 `logrotate -d`，失败即不落盘 → 通过后 `mkdir -p` + 同目录 tmp（0600 + fsync）原子 rename 到目标。任何校验失败 exit 1 且**旧文件逐字节不变**，`--dry-run` 只打印（会为 `-d` 写临时文件，但绝不创建目标/目标目录）；用法错误 exit 2。logrotate 查找先 PATH、再回退 `/usr/sbin`、`/sbin`、`/usr/local/sbin`、`/usr/bin`、`/bin`（本机 `command -v logrotate` 为空而 `/usr/sbin/logrotate` 存在，这个回退是必要的）；非 POSIX 只 warn。模板同步：路径清单加 `@HOME@/.dsh/logs/dsh-doctor.log`（覆盖 watch/autopilot/tagdispatch/doctor 四个日志；`dsh-web.out.log` 仍不纳管 —— 服务自身有 `.prev.log` 轮转，两份配置会抢文件），顶部用法改为推荐安装器、保留手动 sed 作为等价备用并写明「脚本会拒绝安装仍含 @HOME@ 的配置」。零依赖自检 `scripts/test-install-logrotate.mjs`：临时 HOME + 假 logrotate 桩（PATH 注入，可控 exit/stderr）7 条断言 + 4 个变异（只换第一处 / 删残留守卫 / 允许非 0600 / 忽略 `-d` 失败码）各自变红；并用本机真实 `/usr/sbin/logrotate` 验证：原始模板 `-d` 失败（精确复现事故），替换后成功。
## Alternatives considered

**只在 README 的 sed 管道上加 `grep -q @HOME@` 守卫**：否决 —— 仍靠复制粘贴执行，守不住空内容/相对路径/语法错误，且没有"失败保留旧文件"的语义；**在文档里强调"必须 sed"**：否决 —— 这正是事故前的状态；**安装器硬编码 `$HOME` 路径写进模板**：否决 —— 模板要能跨用户/`/etc` 复用，占位符是必要的；**纳入 `dsh-web.out.log`**：否决 —— 与 dsh-web.service 自身的轮转会抢同一批文件；**直接改本机 `~/.dsh/logrotate.dsh.conf` 加第 4 条**：否决 —— 与模板分叉，下一次安装会被覆盖回退（本轮只在仓库侧做，用户需要跑一次安装器）。
## Consequences

买到：安装从"复制粘贴 + 眼力"变成一条命令，@HOME@ 残留 / 相对路径 / logrotate 语法错误三类失败都在落盘前被拦住，且失败时旧配置原样保留；`dsh-doctor.log` 进入轮转（用户执行一次安装器后生效）。代价与边界：① **用户动作**：本机 `~/.dsh/logrotate.dsh.conf`（仍是 3 条日志）不会被仓库改动自动更新，需要跑一次 `node scripts/install-logrotate.mjs`；② 全局替换会把注释里提到的 `@HOME@` 字样也替换成具体路径（源模板保持占位符，这是满足"输出无残留"的必然代价）；③ `HOME` 含空白字符时模板路径未加引号，没有 logrotate 的机器上不会被检出（已知未覆盖）；④ Windows 平台不适用（logrotate 不存在），只做生成校验；⑤ "系统完全没有 logrotate" 的 warning 分支未自动化覆盖。

