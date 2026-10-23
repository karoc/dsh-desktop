# Agent Note: ci-apt-cache-retry

Status: implemented

## Problem

`build.yml` 的四个作业（`check` / `rust-coverage` / `linux` / `linux-smoke`）各自内联
`sudo apt-get update && sudo apt-get install -y ...`。实测同一条命令在 GitHub runner 上的耗时
从 **21s 到 27m20s** 不等：run 40024960026 的 `check` apt 步 27m20s、run 40029539904 的
`linux-smoke` apt 步 17m03s（同一 run 的 `check` 只有 21s）。下载源（azure.archive.ubuntu.com）
逐个包慢速/卡住，而 apt 没有总时长上限 ⇒ PR 长时间卡在 `check=pending`，发布日的 6h 预算被
慢步吃掉 8%+，多个 PR 需要重试才能合并。

## Decision

新增 `scripts/ci-apt.sh` 作为 CI 里**唯一**的 apt 安装入口，两个 profile：

- `tauri` = `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`，带
  `--no-install-recommends`（Ubuntu 24.04 实测少装 52 个推荐包，与 cargo 编译无关）；
- `smoke` = `xvfb dbus libwebkit2gtk-4.1-0 libappindicator3-1 librsvg2-2 libgtk-3-0`，**保留
  recommends**：headless WebKit 依赖 xvfb 推荐的 mesa/GL 与 portal 组件，真门禁不做体积优化。

workflow 每个 apt 作业改为三步：`Ubuntu 版本`（`/etc/os-release` 的 `VERSION_ID` 写
`$GITHUB_OUTPUT`）→ `actions/cache@v4`（path `${{ runner.temp }}/apt-archives`，key
`apt-${{ runner.os }}-<VERSION_ID>-<profile>-<hashFiles('scripts/ci-apt.sh')>`，另配同前缀的
`restore-keys`）→ `sudo bash scripts/ci-apt.sh <profile> "$RUNNER_TEMP/apt-archives"`。脚本在
`install` 前把缓存里的 `.deb` 复制进 `/var/cache/apt/archives`（命中时 apt 不再联网下载）、
成功后删掉缓存里的旧 `.deb` 并回写本次归档（缓存不随版本号膨胀）。`apt-get update` 与
`apt-get install` 各自最多 3 次（间隔 15s，`DSH_APT_ATTEMPTS` 可调），预算耗尽 `exit 1`；
另加 `Acquire::Retries=2` 与 30s 连接超时。

负向保证：**没有** `|| true` / skip / new `continue-on-error`；重试预算耗尽必须红。缓存与重试
两条路径都有 `--self-test`（4 个用例：首次成功、瞬时故障恢复、预算耗尽必红、缓存先导入后回写），
挂在 `test` 快层的「CI 辅助脚本自检」步骤里，PR 阶段就能拦住"把这里改成永真"的回归。

实测（同一 job，jobs API 的 step 时间；cache 行取 run 日志）：

- `check`：job 30m19s / apt 27m20s（run 40024960026，冷）→ job 3m09s / apt 27s
  （dispatch run 40035234989，命中）。
- `linux-smoke`：job 17m55s / apt 17m03s（run 40029539904，冷）→ job 1m15s / apt 14s
  （dispatch run 40035234989，命中）。
- `linux`：job 6m14s / apt 24s（run 40029539904）→ job 5m56s / apt 25s（命中；该 job 的
  瓶颈在打包/慢测试，apt 本来就不是主要项）。
- 命中日志：`Cache restored from key: apt-Linux-24.04-tauri-<hash>` /
  `apt-Linux-24.04-smoke-<hash>` + `[ci-apt] restored 174/68 cached .deb`；首次为
  `Cache not found for input keys: ...`。
- **冷缓存 + 慢源仍会慢**：PR #225 第一次 run 40033990080 的 apt 步 22m18s（如实记录，未隐藏）。

## Alternatives considered

**删依赖 / 拆 job**：`check` 与 `linux` 真的编译 Tauri（webkit2gtk/gtk/appindicator/rsvg 的
dev 包），删任何一个都可能在 runner 上编译失败，或让 check 与打包路径的编译变体不一致；按
"宁可留着"的纪律只做 `--no-install-recommends`，不删包。
**直接删 `apt-get update`**：runner 镜像的 apt lists 可能缺失/过期，`install` 会
"Unable to locate package" 或装到旧包；不拿稳定性换速度。
**换成第三方 apt 缓存 action**（如 awalsh128/cache-apt-pkgs-action）：能覆盖同样场景，但增加
供应链面，且任务书指定 `actions/cache`；自己这 30 行脚本还能被 `--self-test` 负向验证。
**给每次 apt 设硬总超时**：慢源下会把"慢但最终成功"的冷启动变成红，且 apt 没有整体超时选项；
缓存命中后下载已消失，故不加硬超时，只保留连接级超时 + 有界重试。
**smoke 档也用 `--no-install-recommends`**：会少掉 mesa/portal 等 headless WebKit 的既有工作
环境，等于用真门禁赌体积，否决（smoke 档只靠缓存消掉下载等待）。

## Consequences

命中时 apt 步从最坏 27m20s 降到 14–27s（剩余时间是 `apt-get update` 索引与本地解包），`check`
job 从 30m19s 降到 3m09s，慢源不再决定 PR 排队。代价与边界：

- 每个 profile 一个 ~60–100MB 的缓存（repo cache 上限 10GB，可忽略）；key 含
  `hashFiles('scripts/ci-apt.sh')`，改包列表或换 Ubuntu 版本会安全地 miss 一次并重建。
- 冷启动（新 key，或合并后 main 的第一次 push）仍可能复现慢下载——本轮没有预置镜像或跨分支
  预热，消除它需要 main 先跑一次（之后 default-branch 缓存对 PR 可见）。
- `--no-install-recommends` 收窄了构建镜像的包面：若以后 tauri 构建真的需要某个推荐包，症状会
  是 pkg-config/编译红（不会假绿），入口是 `scripts/ci-apt.sh` 的 profile 列表；不要在 workflow
  里再写裸 `apt-get`，否则那一步会绕过缓存与重试。
