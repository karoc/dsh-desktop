# 自动化发版 / 告警链路防错清单（幂等 · 告警 · 定时 · 凭据 · 保留 · 退避）

> 日期：2026-10-24
> 范围：本仓 `dsh-watch`、`dsh-release-autopilot`、本机 systemd user timer、GitHub Actions `schedule`、项目 fine-grained PAT，以及 `~/.dsh/logs` 与 hang dump。
> 目的：把 2026-10-23 真实发版事故里暴露的**重复对象、权限错觉、告警漏送**三类问题，逐条对上业界可核验的做法，再给出可执行的采用清单。
>
> **事实标注约定**
> - `[已验证: URL / 文件:行]`：本次调研实际打开过官方文档，或本机实际执行过命令 / 读到源码。
> - `[假设]`：有合理依据但本机无法证明；**不得作为采用清单的依据**，只能作为待验证项。
> - `[本机不可验证]`：需要 GitHub 官方确认、真实通知渠道或另一台机器才能验证。
>
> 采用清单里的每一条都只引用 `[已验证]` 事实或本机观测；`[假设]` 全部单列在第 9 节。

---

## 0. 先把事故说清楚（本地取证）

### 0.1 不是 5 条，是 17 条重复 issue

截至 2026-10-24 01:40 CST，对 `karoc/dsh-desktop` 全量 issue 统计（open + closed）：

| 指标 | 值 | 取证 |
|---|---|---|
| 同标题重复 issue | **17 条**（#201–#217） | `./scripts/gh issue list --state all --limit 100 --json number,title,labels,createdAt` |
| 标题 | `[dsh-watch][best-effort 24h（预发布通道）] dsh 0.2.1-rc.3 比地板 0.2.1-rc.2 新` | 同上 |
| 创建节奏 | 2026-10-23T08:00:22Z → 10:30:22Z，每 10 分钟一条 | 同上，`createdAt` |
| 带 label / assignee | **只有 #217**（作者 `github-actions[bot]`） | `gh api repos/karoc/dsh-desktop/issues/217` |
| 无 label / assignee | **16 条**（作者 `karoc`） | #201/#205/#210/#216 抽样 `gh api` |

[已验证: `gh issue list` / `gh api repos/karoc/dsh-desktop/issues/{201,205,210,216,217}`，2026-10-24]

### 0.2 去重为什么失效：去重键是 label，而 label 没写上去

`scripts/dsh-watch.mjs` 的去重查询是“**按 label 过滤，再按标题匹配**”：

```js
// scripts/dsh-watch.mjs:239-241
const titlePattern = new RegExp(...)
const listing = JSON.parse(execFileSync(GH, ['issue', 'list', '--label', label, '--state', 'open',
  '--json', 'number,title,body,labels', '--limit', '100'], ...))
const existing = listing.find((i) => titlePattern.test(i.title ?? '')) ?? null
```

而本机日志连续 16 次打印同一句：

```text
（已扫描 0 个 open issue，无 0.2.1-rc.3 的词边界命中 ⇒ 新建）
已开跟踪 issue（已赋值并 @ 提及属主）
```

[已验证: `~/.dsh/logs/dsh-watch-timer.log:2190-2191`（首次），之后每 10 分钟重复；全文 16992 行]

这 16 条 issue 的正文完整、带 `<!-- dsh-watch-state: target=0.2.1-rc.3 breached=false -->` 和 `@karoc`，**唯独没有 label**。也就是说：`issue create` 成功了，但 `--label` / `--assignee` 没有落地；下一次运行用 `--label` 查，自然查到 0 条，于是再建一条。**去重键依赖了一个“创建时可能静默失败”的属性**，这是结构性缺陷，不是偶发。

### 0.3 PAT 的权限错觉

`CONTRIBUTING.md` 写明了项目 PAT 的权限集合：

> 仅授权 karoc/dsh-desktop，Permissions：Pull requests / Administration / Actions → write
>
> [已验证: `CONTRIBUTING.md:134-135`]

**没有 Issues → write**。但只读检查又显示“看起来什么都能干”：

```text
GET /repos/karoc/dsh-desktop
{"permissions":{"admin":true,"maintain":true,"pull":true,"push":true,"triage":true}}
```

[已验证: `./scripts/gh api repos/karoc/dsh-desktop`，2026-10-24]

于是运行到 #217（唯一带 label 的 issue）时，脚本走更新分支，直接撞墙：

```text
failed to update https://github.com/karoc/dsh-desktop/issues/217:
GraphQL: Resource not accessible by personal access token (updateIssue)
failed to update 1 issue
```

以及：

```text
GraphQL: Resource not accessible by personal access token (addLabelsToLabelable)
```

[已验证: `~/.dsh/logs/dsh-watch-timer.log:2350` 起（addLabelsToLabelable），以及其后的 updateIssue 重复失败]

这两条合起来说明：**“能建 issue” ≠ “能维护 issue”**；而本仓的去重、状态更新、assignee 全部依赖“维护”能力。

### 0.4 告警可达性

- issue 创建会触发通知（官方原文：`This endpoint triggers notifications.`）[已验证: <https://docs.github.com/en/rest/issues/issues>，“Create an issue”段]。
- 但 bot 建的 issue 默认只通知**参与者 / 被 @ / 被 assign**。本仓已经加了 assignee + 正文 @ 提及 [已验证: `scripts/dsh-watch.mjs:266-269`；#217 的 assignee=karoc]。
- 仍然没有“**任务根本没跑 / 跑了但没发出来**”这一层的检测：`dsh-watch.service` 只有 `Restart=on-failure`，失败就 60 秒后重跑；`dsh-watch.timer` 只有 `OnCalendar=*:0/10` [已验证: `~/.config/systemd/user/dsh-watch.service:8-9`、`dsh-watch.timer:5-8`]。如果整台机器关机、timer 被 disable、或脚本每次都失败但 systemd 只负责重启，**没有人会收到“没有告警”的告警**。

### 0.5 本地链路（现状）

```text
systemd user timer (每 10 分钟)
  ├─ dsh-watch.timer       → dsh-watch.mjs --issue   → GitHub issue（本地 PAT）
  ├─ dsh-autopilot.timer   → dsh-release-autopilot   → auto/dsh-<target> 分支 + PR（本地 PAT）
  └─ dsh-tagdispatch.timer → gh workflow run tag-dispatch.yml
GitHub Actions (每 15 分钟)
  └─ dsh-watch.yml         → 同一个 dsh-watch.mjs    → GitHub issue（GITHUB_TOKEN）
```

[已验证: `~/.config/systemd/user/dsh-watch.timer:5`、`dsh-autopilot.timer:4`、`dsh-tagdispatch.timer:4`；`.github/workflows/dsh-watch.yml:16-17`]

**同一时刻有两个写者**（本机 + CI）在跑同一个脚本、写同一类 issue；CI 的 #217 带 label，本机的 #216 不带 label，两者同一秒创建。这是重复的第二个放大器。

---

## 1. 幂等 / 去重：Renovate、Dependabot、Kubernetes reconcile

### 1.1 Renovate：不存状态，用“分支名 + PR 标题”当缓存键

官方文档把机制写得很直白：

> Renovate does not need to maintain any database/state about open or closed Pull Requests. Instead, it uses the code platform's APIs to search and find such PRs.
>
> Renovate finds existing PRs (open or closed) by matching both:
> - the branch name, for example: `renovate/lodash-4.x`,
> - *and* the Pull Request title, for example: `Update lodash to v4.17.21`
>
> [已验证: <https://docs.renovatebot.com/key-concepts/pull-requests/>，“How Renovate finds existing PRs”]

收敛多余对象也写明了：

> Renovate normally cleans up its own branches and PRs once it decides they are no longer needed, for example after you merge or close a PR. Depending on the state of the branch, Renovate either autocloses the PR and deletes the branch, or, if the branch has been modified, flags the PR as abandoned.
>
> [已验证: 同上，“Abandoned PRs”]

要点：
- **幂等键 = (branchName, PR title)**，不是数据库主键。两者都是确定性的（由依赖名 + 目标版本生成），所以重跑会命中同一条。
- **TOCTOU**：文档没有承诺“查询 + 创建”是原子的；它靠“同一仓库同一时刻通常只有一个 Renovate 进程”来避免并发。自托管多副本并跑同一仓库不在文档保证范围内 → 我们把它标 `[假设]`，不照搬。
- **收敛**：合并/关闭后自动删分支、关 PR；人改过的分支标 `abandoned` 而不强删（保护人的工作）。这是“收敛但不破坏”的边界。

### 1.2 Dependabot：确定性分支名 + 对既有 PR 操作

Dependabot 的开源核心 `dependabot-core` 里，分支名是确定性拼出来的：

```ruby
# dependabot-core/common/lib/dependabot/pull_request_creator/branch_namer/solo_strategy.rb:17-46
def new_branch_name
  ...
  @name ||= "#{template_dependency_name}-#{branch_version_suffix}"
  sanitize_branch_name(File.join(prefixes, @name))
end

def prefixes
  [prefix, package_manager, files.first&.directory&.tr(" ", "-"), target_branch].compact
end
```

[已验证: <https://github.com/dependabot/dependabot-core/blob/main/common/lib/dependabot/pull_request_creator/branch_namer/solo_strategy.rb#L17-L46>]

即默认 `dependabot/<package_manager>/<directory>/<dependency>-<version>`。随后所有命令都是对**既有 PR** 操作，而不是再开一条：

> `@dependabot rebase` Rebases the pull request.
> `@dependabot recreate` Recreates the pull request, overwriting any edits that have been made to the pull request.
> `@dependabot ignore this dependency` Closes the pull request and prevents Dependabot from creating any more pull requests for this dependency...
>
> [已验证: <https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-pull-request-comment-commands>]

并发上限也由配置控制（默认最多 5 条 open PR）：

> Dependabot raises a maximum of five pull requests to start bringing dependencies up to the latest version... You can change the maximum number of open pull requests by setting the `open-pull-requests-limit` configuration option.
>
> [已验证: <https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-pull-requests>]

要点：
- **幂等键 = (ecosystem, directory, dependency, target version) → 确定性分支名**；PR 是这条分支的从属对象。
- **TOCTOU**：托管侧的具体“查重 + 创建”实现闭源，官方没有给出唯一键定义 → **托管侧去重实现标 `[本机不可验证]`**；但“确定性分支 + 对既有 PR 的 rebase/recreate/ignore”是可核验的行为面。
- **收敛**：`ignore` 关 PR 并阻止后续同类 PR；超过 `open-pull-requests-limit` 的更新排队等下一次。没有“自动关掉重复 PR”的承诺。

### 1.3 Kubernetes controller：名字唯一 + 409 + ownerReferences + apply

Kubernetes 的幂等不是靠“查一下有没有”，而是把唯一性下沉到 API server：

> All objects you can create via the API have a unique object name to allow idempotent creation and retrieval...
> Within a namespace, an object's unique identity is defined by the tuple of its API Group, Resource, Namespace, and Name.
>
> [已验证: <https://kubernetes.io/docs/reference/using-api/api-concepts/>，“Object names”]

更新用 `resourceVersion` 做乐观并发：

> In the event that the resource has changed (the resourceVersion the client provided is stale), the API server returns a 409 Conflict error response.
>
> [已验证: 同上，“Resource versions”]

Server-Side Apply 把“创建或更新”合并成一个动作：

> To Kubernetes, this is a create operation if the object does not exist, or a patch operation if the object already exists.
>
> [已验证: 同上，“Server Side Apply”]

收敛多余对象靠 ownerReferences + GC：

> Kubernetes checks for and deletes objects that no longer have owner references, like the pods left behind when you delete a ReplicaSet.
>
> [已验证: <https://kubernetes.io/docs/concepts/architecture/garbage-collection/>，“Cascading deletion”]

controller 本身是 level-triggered 控制循环：

> In Kubernetes, controllers are control loops that watch the state of your cluster, then make or request changes where needed. Each controller tries to move the current cluster state closer to the desired state.
>
> [已验证: <https://kubernetes.io/docs/concepts/architecture/controller/>]

要点：
- **幂等键 = (apiGroup, resource, namespace, name)**；name 由 controller 确定性地生成（或由用户给出），重复 `POST` 同名对象会被 API server 拒绝/合并。
- **TOCTOU 被 API server 消灭**：不是“客户端先查再建”，而是“直接建，冲突就 409 / apply 合并”。
- **收敛**：ownerReferences 让子对象随父对象删除；controller 每轮都从 desired state 重新计算，不依赖事件历史。
- **边界**：这不是“同一事件只处理一次”（K8s 明确是 at-least-once），而是“同一事件重复处理不会产生重复对象”。对告警的启示：**要幂等的是“对象身份”，不是“事件次数”**。

### 1.4 三种模式对照

| 维度 | Renovate | Dependabot | Kubernetes controller |
|---|---|---|---|
| 幂等键 | branchName + PR title | 确定性分支名（ecosystem/dir/dep/version） | (group, resource, namespace, name) |
| 防 TOCTOU | 单进程串行（文档未承诺原子） | 托管侧串行 + 确定性分支（实现闭源） | API server 原子 create / 409 / apply |
| 多余对象收敛 | 自动关 PR + 删分支；人改过则标 abandoned | `ignore` 关闭并阻止；限额排队 | ownerReferences + GC |
| 失败重试 | 下一轮重新查 | 下一轮对同一分支 rebase/recreate | workqueue 指数退避 + reconcile |
| 对我们的可迁移点 | “确定性键 + 先查后改” | “确定性键 + 对既有对象操作” | “把唯一性下沉到平台，别在客户端查” |

### 1.5 对我们的结论

1. **issue 没有平台级唯一约束**。GitHub 的 `POST /issues` 不会因为“同标题已存在”而 409；`gh issue list --label` 只是普通查询。因此 issue 的去重只能靠“**单一写者 + 确定性标题/正文 marker + 创建后复核**”，不能靠“查一下再建”做到严格原子。
2. **不要把 label 当唯一键**。本次事故已经证明：label 是“创建之后的第二次写”，可能失败；用 label 过滤 = 把去重建立在可能缺失的属性上。标题/正文 marker 是创建请求的一部分，失败会整体失败，语义更强。
3. **收敛要有独立的 reconcile 步骤**。K8s 的 GC 和 Renovate 的 autoclose 都不是“创建逻辑的副产品”，而是独立的一轮“把多余对象关掉”。本仓也需要一次（可 dry-run 的）重复 issue 收敛。
4. **同一 target 的“对象身份”应固定**：一个 target 一个 issue / 一个 PR 分支；版本变化时改正文 + 状态评论，而不是新建。`dsh-release-autopilot` 已经用 `auto/dsh-<target>` + `--force-with-lease` 做对了 PR 侧 [已验证: `scripts/dsh-release-autopilot.mjs:60-65`、`:707-717`、`:764`]，issue 侧还没有。

---

## 2. 告警可靠性：dedup_key、grouping/inhibition、dead man's switch

### 2.1 PagerDuty `dedup_key`：解决“同一故障重复开 incident”

> For services with an Events API v2 integration, you can group related alerts into a single incident by including a `dedup_key` value, a case-sensitive string that identifies an alert, in the trigger event's body. Subsequent alerts with a matching `dedup_key` value deduplicates into the same incident...
>
> If there are no open incidents with this key, PagerDuty will create a new incident. Additionally, if two events having the same `dedup_key` are sent to **two different integrations** within the same service, they will not be deduplicated...
>
> If the event key field is blank or absent, PagerDuty will automatically create a new incident with a unique key.
>
> [已验证: <https://docs.pagerduty.com/incident-management/incidents/event-management>，“Deduplicate Alerts”]

要解决的问题：**同一故障的多次上报合并成一个 incident**，而不是每次上报都开新单。
边界：dedup 只在**同一 service 的同一 integration** 内生效；跨 integration 不合并；空 key = 每次都新建。

### 2.2 Alertmanager grouping / inhibition：解决“告警风暴”和“因果淹没”

Grouping：

> Grouping categorizes alerts of similar nature into a single notification. This is especially useful during larger outages when many systems fail at once and hundreds to thousands of alerts may be firing simultaneously.
>
> [已验证: <https://prometheus.io/docs/alerting/latest/alertmanager/>，“Grouping”]

Inhibition：

> Inhibition is a concept of suppressing notifications for certain alerts if certain other alerts are already firing.
>
> [已验证: 同上，“Inhibition”]

配置原文：

> Inhibition allows muting a set of alerts based on the presence of another set of alerts. This allows establishing dependencies between systems or services such that only the most relevant of a set of interconnected alerts are sent out during an outage.
>
> [已验证: <https://prometheus.io/docs/alerting/latest/configuration/>，“Inhibition-related settings”]

要解决的问题：
- **grouping**：把同一集群/同一服务的 N 条告警合成 1 条通知（降噪），但仍保留“哪些实例受影响”的细节。
- **inhibition**：已知上游故障时，压掉下游派生告警（降因果噪音），避免“真正根因被 100 条下游告警淹没”。
- 另有 **silence**：按 matcher 在指定时间内静音（维护窗口）。

### 2.3 dead man's switch / heartbeat：解决“没有告警”的告警

Healthchecks.io 把模式说得很清楚：

> your cron job sends an HTTP request ("ping") to Healthchecks.io every time it completes. When Healthchecks.io does not receive the HTTP request at the expected time, it notifies you. This monitoring technique, sometimes called "heartbeat monitoring", is a type of dead man's switch. It can detect various failure modes:
> - The whole machine goes down...
> - The cron daemon is not running or has an invalid configuration.
> - Cron does start your task, but the task exits with a non-zero exit code.
> - The cron job runs for an abnormally long time.
>
> [已验证: <https://healthchecks.io/docs/monitoring_cron_jobs/>]

两个关键参数：

> **Period** is the expected time between pings.
> **Grace Time** is the additional time to wait before sending an alert when a check is late.
>
> [已验证: <https://healthchecks.io/docs/configuring_checks/>，“Simple Schedules”]

通知冗余：

> Redundancy: if one notification channel fails (e.g., an email message gets delivered to spam), you will still receive notifications over the other channels.
>
> [已验证: <https://healthchecks.io/docs/monitoring_cron_jobs/>，“Notifications”]

要解决的问题：**监控“任务是否按时发生”**，而不是“任务失败时是否报错”。前者能抓到“机器挂了 / timer 没启用 / 脚本没跑 / 跑太久”，后者只能抓到“脚本自己知道自己失败”。

### 2.4 三者对照与我们的缺口

| 机制 | 解决 | 不解决 |
|---|---|---|
| PagerDuty `dedup_key` | 同一故障合并为一个 incident | 故障根本没上报（dedup 不产生事件） |
| Alertmanager grouping | 同一类告警合成一条通知 | 上游根因与下游告警的因果关系（要靠 inhibition） |
| Alertmanager inhibition | 已知根因时压掉派生告警 | 根因告警本身没发出来 |
| heartbeat / dead man's switch | 任务没跑、机器挂、跑太久 | 任务跑了但业务结果错（要靠任务内断言） |

本仓缺口：
- 只有“脚本失败 → systemd 重启”，没有“**脚本没跑** → 告警”。`dsh-watch.service` 没有 `OnFailure=`，timer 也没有独立的 watchdog [已验证: `~/.config/systemd/user/dsh-watch.service:1-18`、`dsh-watch.timer:1-12`]。
- 只有“issue”一个通道；issue 创建成功不等于人看到（通知设置、折叠、bot 过滤都可能）。healthchecks 文档明确建议多通道冗余。
- 没有“同一 target 一个 issue”的 dedup，导致 17 条重复（见 §0）。

---

## 3. GitHub Actions 定时任务的真实可靠性

### 3.1 官方原文（逐字）

> **Note**
> The `schedule` event can be delayed during periods of high loads of GitHub Actions workflow runs. High load times include the start of every hour. If the load is sufficiently high enough, some queued jobs may be dropped. To decrease the chance of delay, schedule your workflow to run at a different time of the hour.
>
> This event will only trigger a workflow run if the workflow file exists on the default branch. Scheduled workflows will only run on the default branch. In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days.
>
> Scheduled workflows run on the latest commit on the default branch. The shortest interval you can run scheduled workflows is once every 5 minutes.
>
> [已验证: <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows>，“schedule”段，2026-10-24 抓取]

关键措辞：
- **can be delayed**：会延迟，不是“偶尔慢一点”；
- **some queued jobs may be dropped**：高负载下**可能被丢弃**（不是“一定补跑”）；
- **only on the default branch**：工作流文件必须在默认分支；
- **60 days inactivity**：公开仓库 60 天无活动会自动 disable；
- **最短 5 分钟**：`*/1` 不会真的每分钟跑。

### 3.2 社区量化数据

GitHub Community Discussion #210012 的标题本身就是量化结论：

> Hourly scheduled workflow runs only every 3–9 hours: how to investigate gaps?
>
> [已验证: <https://github.com/orgs/community/discussions/210012>]

正文进一步给出观察：

> Scheduled runs appear at roughly 3–9-hour intervals rather than hourly. The recorded runs complete successfully and take only about 10–25 seconds... The visible gap is therefore before run creation in the available run history...
>
> [已验证: 同上，帖子正文]

这是社区单点观测，不是官方 SLA；但足以说明：**“每小时”的 cron 在真实平台上可能变成 3–9 小时一次**。本仓的 15 分钟 cron 同理，不能拿它当 6h SLA 的时钟。

### 3.3 Kubernetes CronJob 的同类语义（可借鉴的边界）

K8s 对“错过调度”的处理有明确文档：

> If there are more than 100 missed schedules, then it does not start the Job and logs the error "too many missed start times"...
>
> After missing the deadline, the CronJob skips that instance of the Job (future occurrences are still scheduled).
>
> [已验证: <https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/>，“Deadline for delayed Job start”]

并且明确要求任务本身幂等：

> Jobs should be idempotent.
>
> [已验证: 同上]

对我们的含义：
- 定时器只保证“**尝试触发**”，不保证“**恰好一次**”；错过就是错过，不会无限补。
- 所以任务必须幂等（重复跑不产生重复对象），并且要有独立的“没跑”检测（dead man's switch），不能靠“上一次失败会重试”来兜底。

### 3.4 结论

1. **`schedule` 不能作为 SLA 计时器**，也不能作为唯一告警路径。官方明确会延迟/丢弃，社区实测小时级 cron 可拉到 3–9 小时。
2. 本仓应把**本机 systemd timer 作为主路径**（10 分钟、可控、日志在本地），GitHub Actions `schedule` 降级为**备份/演练**；主路径挂了用 heartbeat 检测，而不是等 CI 的 cron。
3. 如果一定要用 CI 做备份，备份逻辑必须是“**检查主路径心跳是否过期，再决定是否接管**”，而不是“两边都无脑跑”（现在就是两边都跑，见 §0.5）。

---

## 4. 凭据能力探测：能不能只读地问“这个 token 能不能写”？

### 4.1 能查到的：仓库级 `permissions` 与 classic token 的 scope

- `GET /repos/{owner}/{repo}` 返回当前认证主体的仓库权限对象：

```json
{"permissions":{"admin":true,"maintain":true,"pull":true,"push":true,"triage":true}}
```

[已验证: `./scripts/gh api repos/karoc/dsh-desktop`，2026-10-24]

但它**只说明仓库角色**，不说明 fine-grained PAT 被授予了哪些资源级权限；本次就是 `admin:true` 但 `updateIssue` 被拒。

- Classic PAT 的 scope 可以从响应头读：

> Check headers to see what OAuth scopes you have, and what the API action accepts:
> `X-OAuth-Scopes` lists the scopes your token has authorized. `X-Accepted-OAuth-Scopes` lists the scopes that the action checks for.
>
> [已验证: <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps>，“Check headers...”]

本机实测：项目 fine-grained PAT 调 `GET /user` 时**没有** `X-OAuth-Scopes`，只有：

```text
X-Accepted-Github-Permissions: allows_permissionless_access=true
```

[已验证: `./scripts/gh api -i user`，2026-10-24；token 已打码，未落盘]

结论：**classic token 能读 scope，fine-grained PAT 不能从 `/user` 读权限**。

### 4.2 查不到的：fine-grained PAT 的“某资源是否可写”与过期时间

- 官方按 endpoint 列权限，而不是给“当前 token 的权限快照”：

> If you are using a fine-grained personal access token, your fine-grained personal access token requires specific permissions in order to access each REST API endpoint. The REST API reference document for each endpoint states whether the endpoint works with fine-grained personal access tokens and states what permissions are required...
>
> [已验证: <https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api>]

- “Create an issue”页的 fine-grained 权限写的是 `Issues (write)` [已验证: <https://docs.github.com/en/rest/issues/issues>，“Create an issue”→“Fine-grained access tokens”]；但同一页又写“Any user with pull access to a repository can create an issue.” [已验证: 同上]。**两处口径不完全一致，且本机观测到 create 成功、update/label 失败**。这说明“能建”与“能维护”是两条不同的权限边界，不能互相推断。
- 过期时间：创建 fine-grained PAT 时在页面上选 `Expiration` [已验证: <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens>，“Creating a fine-grained personal access token”]；`GET /user` 返回字段里没有 `expires_at`（本机实测字段列表无此项）。唯一能批量看到 `token_expires_at` 的 REST 端点是**组织级**的 PAT 管理端点，且仅 GitHub App 可用：

> Lists approved fine-grained personal access tokens owned by organization members that can access organization resources. **Only GitHub Apps can use this endpoint.**
>
> [已验证: <https://docs.github.com/en/rest/orgs/personal-access-tokens>，“List fine-grained personal access tokens with access to organization resources”]

对本仓（个人仓库 `karoc/dsh-desktop`）来说，这个端点**不可用**。因此：**个人 fine-grained PAT 的过期时间没有可编程的读取路径** [本机不可验证：未找到官方“无此接口”的明文，但 REST 参考与本机实测均不支持]；可行做法是创建时把 `expires_at` 记进本地元数据并提前告警（见采用清单 A4）。

### 4.3 业界怎么做“只读的能力探测”

- **AWS**：`SimulatePrincipalPolicy` 只做授权评估，不执行 API：

> The simulation does not perform the API operations; it only checks the authorization...
>
> [已验证: <https://docs.aws.amazon.com/IAM/latest/APIReference/API_SimulatePrincipalPolicy.html>]

- **Kubernetes**：`SelfSubjectAccessReview` / `kubectl auth can-i` 直接问“我能不能做这个动作”：

> The command uses the SelfSubjectAccessReview API to determine if the current user can perform a given action...
>
> [已验证: <https://kubernetes.io/docs/reference/access-authn-authz/authorization/>，“Checking API access”]

- **GitHub 没有等价的“模拟写”接口**（至少对个人 fine-grained PAT 没有）。所以业界对 GitHub 的常见兜底是 **canary write**：用最小副作用做一次真实写，再清理；失败则 fail-closed。

### 4.4 本仓可执行的 canary 写探测配方

目标：在每次自动化写 issue 之前，先证明“当前 token 能改 issue”。

1. 准备一个**固定的 canary issue**（标题如 `[automation-canary] do not delete`，仅用于探测；关闭通知/不加 watcher）。
2. 每次运行先做：
   - `POST /repos/{owner}/{repo}/issues/{canary}/labels`，加一个 `canary-probe` label；
   - `DELETE /repos/{owner}/{repo}/issues/{canary}/labels/canary-probe` 清理。
3. 任一步 403/404 → **exit 3，不写真实 issue**，并走本地通知 / 心跳失败路径。
4. 反向对照（必须做）：拿一个只读 token 跑同一探测，断言它**必须失败**；否则这个探测是恒真的假门禁。
5. 过期提醒：在 `~/.config/gh-dsh-desktop/token.meta` 记 `expires_at`（创建时手填），每日检查，14/7/1 天各提醒一次。

为什么用 label 而不是“新建 issue 再删”：新建 issue 会触发通知，且失败时留下垃圾；label add/remove 的副作用最小，且正好覆盖本次出问题的 `addLabelsToLabelable` 能力。代价是它只证明“能改 label”，不能证明“能改正文/assignee”；所以真实写入后还要**读回复核**（见 A2）。

### 4.5 结论

- **不要用 `GET /repos/...` 的 `permissions.admin=true` 推断 Issues 可写**；本次已经反例。
- **不要用 `GET /user` 判断 fine-grained PAT 的权限或过期时间**；它只返回身份字段。
- **能查到的是**：classic token 的 scope 头、仓库级角色、按 endpoint 的权限要求；**查不到的是**：fine-grained PAT 的当前权限快照与个人 token 过期时间。
- 因此：**canary 写探测 + 写后复核 + 本地过期元数据**，是本仓唯一可靠的三件套。

---

## 5. 日志 / 产物保留

### 5.1 `StandardOutput=append:` 没有内置轮转

systemd 的定义只有“打开方式”：

> `append:path` is similar to `file:path` above, but it opens the file in append mode.
>
> [已验证: <https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#StandardOutput=>]

man page 里没有任何 `rotate` / `maxsize` / `keep` 选项；`StandardOutput=` 的取值只有 `inherit / null / tty / journal / kmsg / file: / append: / truncate: / socket / fd:` [已验证: 同上]。所以：**append 只保证不截断，不保证不涨破磁盘；轮转必须外部做**。

本仓现状：三个 timer 的 service 都用 `StandardOutput=append:` + `StandardError=append:` 指向同一个文件 [已验证: `~/.config/systemd/user/dsh-watch.service:16-17`、`dsh-autopilot.service:14-15`、`dsh-tagdispatch.service:12-13`]，但 `/etc/logrotate.d/` 里没有 dsh 条目 [已验证: `ls /etc/logrotate.d/`，2026-10-24]。`dsh-watch-timer.log` 已 788KB / 16992 行（约 4 天）[已验证: `wc -l`、`du -h`]，按当前节奏一年会到几十 MB——不致命，但没有上限。

### 5.2 journald 的默认上限

> `SystemMaxUse=` and `RuntimeMaxUse=` control how much disk space the journal may use up at most... The first pair defaults to 10% and the second to 15% of the size of the respective file system, but each of the calculated default values is capped to 4G.
>
> `MaxRetentionSec=` ... default of 0 (which turns off this feature).
>
> [已验证: <https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html>]

本机：`/etc/systemd/journald.conf` 里 `SystemMaxUse` 仍是注释默认 [已验证: `grep -n SystemMaxUse /etc/systemd/journald.conf` → `27:#SystemMaxUse=`]；`journalctl --disk-usage` 已 94.0M。`AGENTS.md` 记录本机 journald 限 100M 且会 vacuum [已验证: `~/.dsh/AGENTS.md` 的「GUI 访问与启动令牌」段]。这意味着 **journal 里的旧日志随时可能被清掉**，不能把 journal 当长期取证源；关键日志要么落文件 + 轮转，要么另存。

### 5.3 logrotate 的正确用法

本机 `logrotate 3.21.0`（`/usr/sbin/logrotate`），`logrotate.timer` 已 enabled + active [已验证: `dpkg -l logrotate`、`systemctl status logrotate.timer`]。对“进程一直持有 fd、不能通知它 reopen”的 append 文件，标准做法是 `copytruncate`：

> `copytruncate` — Truncate the original log file to zero size in place after creating a copy, instead of moving the old log file and optionally creating a new one. It can be used when some program cannot be told to close its logfile and thus might continue writing (appending) to the previous log file forever. Note that there is a very small time slice between copying the file and truncating it, so some logging data might be lost.
>
> [已验证: 本机 `man 8 logrotate`（logrotate 3.21.0），“copytruncate”段；在线参考 <https://man7.org/linux/man-pages/man8/logrotate.8.html>]

`maxsize` 可以在时间条件之外按大小触发：

> `maxsize size` — Log files are rotated when they grow bigger than size bytes even before the additionally specified time interval...
>
> [已验证: 同上，“maxsize”段]

对本仓：`~/.dsh/logs/*.log` 适合 `daily` + `maxsize 50M` + `rotate 7` + `compress` + `copytruncate` + `missingok` + `notifempty`。注意 `copytruncate` 有极小丢数据窗口；对“取证优先”的 manager/dump 日志，可以改用 `create` + 让 systemd 重新打开（需要 restart，代价更大），或者接受窗口。

### 5.4 coredump / hang dump 的保留

systemd-coredump 的默认值：

> `MaxUse=` ... defaults to 10% of the total disk size, capped at 4GiB, minimum 1MiB. `KeepFree=` ... defaults to 15% of the total disk size, limited to a maximum of 4GiB.
>
> [已验证: <https://www.freedesktop.org/software/systemd/man/latest/coredump.conf.html>，“MaxUse=, KeepFree=”]

时间维度由 tmpfiles 管：本机 `/usr/lib/tmpfiles.d/systemd.conf:36` 是 `d /var/lib/systemd/coredump 0755 root root 2w`，即 **2 周** [已验证: 本机文件]。本仓自己的 hang dump 已经按“**保留最新 3 份**”实现：

```rust
// src-tauri/src/lib.rs:3828
const HANG_DUMP_KEEP: usize = 3;
// src-tauri/src/web_dump.rs:152
pub(crate) fn prune_dumps(dir: &Path, prefix: &str, keep: usize) -> usize
```

[已验证: `src-tauri/src/lib.rs:3828`、`src-tauri/src/web_dump.rs:150-175`；`test-shell-chrome.mjs` 也断言 full-memory dump]

全内存 dump 单个可达数百 MB，3 份是合理上限；再加一条时间上限（例如 14 天）可以覆盖“长期没有新 dump、旧 dump 一直占着”的情况。

### 5.5 建议值（本仓）

| 对象 | 保留策略 | 依据 |
|---|---|---|
| `~/.dsh/logs/*.log` | daily + maxsize 50M + rotate 7 + compress + copytruncate | logrotate 语义 + 当前 788KB/4 天 |
| journald | `SystemMaxUse=200M`、`MaxRetentionSec=14day`（按磁盘余量调） | 官方默认 10%/4G + 本机 100M 现状 |
| hang dump | 最新 3 份 + 14 天 + 总量 2G | 本仓 `HANG_DUMP_KEEP=3` + coredump 2 周默认 |
| 自动化日志（autopilot） | 同上，单独文件 | 当前 220KB |

> 表中 50M/200M/14day/2G 是**本仓建议值**，不是官方推荐值；官方只给了 journald 10%/4G 与 coredump 10%/4G、tmpfiles 2 周这些默认基线。

---

## 6. 退避与降噪：指数退避 + healthy/degraded/broken 状态机

### 6.1 Kubernetes client-go：按 key 的指数退避

`workqueue` 的默认 controller rate limiter 是“每项指数退避 + 整体令牌桶”：

```go
// kubernetes/client-go/util/workqueue/default_rate_limiters.go:50-55
func DefaultTypedControllerRateLimiter[T comparable]() TypedRateLimiter[T] {
    return NewTypedMaxOfRateLimiter(
        NewTypedItemExponentialFailureRateLimiter[T](5*time.Millisecond, 1000*time.Second),
        // 10 qps, 100 bucket size...
        &TypedBucketRateLimiter[T]{Limiter: rate.NewLimiter(rate.Limit(10), 100)},
    )
}
```

退避计算是 `baseDelay * 2^failures`，封顶 `maxDelay`；成功后 `Forget(item)` 清零：

```go
// 同文件:116-150
backoff := float64(r.baseDelay.Nanoseconds()) * math.Pow(2, float64(exp))
...
if calculated > r.maxDelay { return r.maxDelay }
...
func (r *TypedItemExponentialFailureRateLimiter[T]) Forget(item T) { delete(r.failures, item) }
```

[已验证: <https://github.com/kubernetes/client-go/blob/master/util/workqueue/default_rate_limiters.go#L50-L55>、同文件 `#L116-L150`；包文档 <https://pkg.go.dev/k8s.io/client-go/util/workqueue>]

要点：
- 退避是**按 item（key）**记的，不是全局；一个 target 的失败不会拖慢其他 target。
- `Forget` 是“成功即重置”的显式动作；没有它，成功一次后仍会保留失败计数。
- 默认值 5ms → 1000s 是给 controller 的高频重试用的；我们的定时任务应该用分钟级。

### 6.2 systemd 自带的指数退避

systemd 254+ 的 `RestartSteps=` + `RestartMaxDelaySec=` 就是指数退避：

> `RestartSteps=` Configures the number of exponential steps to take to increase the interval of auto-restarts from `RestartSec=` to `RestartMaxDelaySec=`... Example: `RestartSec=10s RestartSteps=4 RestartMaxDelaySec=160s` → 10s, 20s, 40s, 80s, 160s, 160s...
>
> [已验证: <https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#Restart=>，“RestartSteps=”]

本仓的 service 目前是 `Restart=on-failure` + `RestartSec=60` [已验证: `~/.config/systemd/user/dsh-watch.service:8-9`]，失败后每 60 秒硬重试——PAT 权限错误这种“重试不会好”的失败会变成热循环（日志里 #217 的 updateIssue 反复失败就是证据）。本机是 systemd 255 [已验证: `systemctl --version` → `systemd 255 (255.4-1ubuntu8.18)`]，已支持 254+ 的 `RestartSteps`/`RestartMaxDelaySec`；应改成 `RestartSteps` + `RestartMaxDelaySec`，或把“不可重试错误”直接转成 broken 状态并停手。

### 6.3 状态机：Argo CD 的 health 模型

Argo CD 把资源健康度定义为有限状态：

> The custom health check might return one of the following health statuses: Healthy / Progressing / Degraded / Suspended...
>
> [已验证: <https://argo-cd.readthedocs.io/en/stable/operator-manual/health/>，“Custom Health Checks”]

并且对 CronJob 有直接映射：

> CronJob: If the last scheduled job for this CronJob failed, the CronJob will be marked as "Degraded". If the last scheduled job for this CronJob is running, the CronJob will be marked as "Progressing".
>
> [已验证: 同上]

App 级别取“最差子资源”：

> The App health will be the worst health of its immediate child resources, based on the following priority (from most to least healthy): Healthy, Suspended, Progressing, Missing, Degraded, Unknown.
>
> [已验证: 同上]

对我们的含义：
- **状态机应该由“最近一次运行结果 + 连续失败次数”驱动**，不是由“当前这次是否抛异常”驱动。
- **三态足够**：`healthy`（最近成功）/ `degraded`（失败但还在重试窗口）/ `broken`（超过阈值或不可重试）。不需要 Argo 的 6 态。
- **降噪**：只在状态**跃迁**时发通知（degraded→broken、broken→healthy），同一状态的重复失败只更新状态文件/issue 正文，不刷评论。Argo 的 “worst-of” 和 CronJob 的 “last job failed → Degraded” 就是这种“状态而非事件”的思路。

### 6.4 本仓建议的状态机

状态文件：`~/.dsh/state/automation.json`（原子写：tmp + rename），每个 unit/target 一条：

```json
{
  "dsh-watch:0.2.1-rc.3": {
    "state": "degraded",
    "consecutive_failures": 3,
    "last_success_at": "2026-10-23T10:20:00Z",
    "last_error": "Resource not accessible by personal access token (updateIssue)",
    "next_attempt_at": "2026-10-23T11:20:00Z"
  }
}
```

退避序列（分钟）：`5, 10, 20, 40, 80, 160, 320`，封顶 `360`（6h）；成功即 `Forget`（清零 + 回 healthy）。
状态迁移：
- `healthy --(1 次可重试失败)--> degraded`（不通知，只记状态）
- `degraded --(连续 3 次失败或不可重试错误)--> broken`（**通知一次**，开/更新一个 issue）
- `broken --(成功)--> healthy`（**通知一次**，关 issue 或评论 recovery）
- `broken --(继续失败)--> broken`（不重复通知；只更新状态文件/issue 正文）

不可重试错误（权限 403、404、参数错误）**直接 broken**，不进退避；可重试错误（网络超时、5xx、429）才退避。这与 client-go 的“按 key 退避 + Forget”和 Argo 的“Degraded/Progressing”一致。

### 6.5 结论

1. **退避要按 key**，不要全局 sleep；否则一个坏 target 会拖慢所有 target。
2. **成功必须显式 reset**；否则一次失败会永久污染退避。
3. **状态机比“每次失败发一条”更能降噪**；只在跃迁时通知。
4. **不可重试错误不要退避**，直接 broken 并停手；否则就是现在的 60 秒热循环。
5. **dead man's switch 是状态机之外的独立一层**：状态机只能处理“任务跑了但失败”，处理不了“任务没跑”。

---

## 7. 采用清单（只列有 `[已验证]` 依据的改动）

> 工作量：S ≤ 半天；M = 1–2 天；L > 2 天。风险按“误伤 / 漏报 / 维护成本”综合。
> 所有条目都**不改生产力代码**；本轮只出方案，落地另开 PR。

| # | 改法 | 工作量 | 风险 | 验证方式 | 依据 |
|---|---|---|---|---|---|
| A1 | **单一写者**：本机 `dsh-watch` 为主；CI `dsh-watch.yml` 改为“读心跳，主路径过期才接管”，不再两边无脑写。心跳写在一个固定 `automation-heartbeat` issue 的正文时间戳（`gh issue edit` 不推送，见 `dsh-watch.mjs:249` 的同类注释），CI 读 `updated_at` 判定；本机恢复后用 lease/代际号阻止 CI 继续写 | M | 中：接管逻辑本身可能抖动；lease 失效会导致双写 | 停本机 timer > grace：CI 接管并只开 1 条；恢复本机：CI 不再写；注入双写场景：最多 1 条 | §0.5、§3.1；`dsh-watch.yml:16-17` |
| A2 | **去重键改为标题 + 正文 marker**：`issue list --state all` 取全量（分页），按 `target=<v>` 匹配；创建后**读回**并断言 label/assignee，缺则视为未创建、走修复而不是再建 | M | 中：标题/正文格式变更需兼容旧 issue；分页上限 | 桩 `gh` 让 create 丢 label：脚本仍能按标题找到同一条（负向对照必须红 → 修好后绿） | §1.5、§0.2；`dsh-watch.mjs:239-241`、`:267` |
| A3 | **PAT 加 Issues:write + canary 写探测**：启动先对 canary issue 加/删 label，失败 exit 3，不写真实 issue | S | 低：canary 本身要维护；label 变更可能产生通知 | 只读 token 跑 canary 必须失败；当前 token 必须成功；失败时真实 issue 数不变 | §4.1–4.4；`CONTRIBUTING.md:135`；日志 `:2350` |
| A4 | **过期元数据**：创建/轮换 token 时把 `expires_at` 写进 `~/.config/gh-dsh-desktop/token.meta`（0600，非 secret），每日检查，14/7/1 天提醒 | S | 低：手填会漂移；需和实际轮换绑定 | 把 meta 过期日改成昨天：必须告警；改回：不告警 | §4.2；PAT 文档“Expiration” |
| A5 | **dead man's switch**：每个 timer 成功后写 `~/.dsh/heartbeat/<unit>`（时间戳+exit code）；独立 `dsh-heartbeat-check.timer` 每 5 分钟检查 `now - mtime > period + grace`，过期开/更新单条 P1 issue + 本地通知；service 加 `OnFailure=` | M | 中：checker 自己死掉 → 需第二检查者（CI 备份或另一台机） | `touch -d '2 hours ago'` 心跳：5 分钟内告警；恢复后自动恢复；停 checker：第二检查者告警 | §2.3；`dsh-watch.timer:5-8`；`systemd.unit` OnFailure |
| A6 | **退避 + 三态状态机**：按 target 记 `state/failures/next_attempt_at`；5→10→20→40→80→160→320 分钟封顶 6h；成功 reset；403/404 直接 broken；只在跃迁时通知。service 层同时设 `RestartSteps=4` + `RestartMaxDelaySec=3600`（本机 systemd 255 支持 254+ 的指数重启） | M | 中：状态文件损坏/陈旧；需 schema + 原子写 + 清理 | 桩失败：next_attempt 翻倍并在 6h 封顶；成功：清零；broken 只通知一次 | §6.1–6.4；client-go 源码；systemd `RestartSteps`；Argo health |
| A7 | **Actions schedule 降级为备份**：文档/工作流注释写明“不保证准时、可能丢弃”；SLA 计时只看本机 timer 的首次运行时间；CI 只做“心跳过期接管” | S | 低：主机长时间关机时无人接管（由 A5 的第二检查者补） | 对比 `gh run list --json createdAt,startedAt` 与本地 timer 时间；停本机 2h：CI 接管一次 | §3.1–3.2 |
| A8 | **日志轮转**：新增 `/etc/logrotate.d/dsh`（或用户级 `logrotate` 配置）：`daily`、`maxsize 50M`、`rotate 7`、`compress`、`copytruncate`、`missingok`、`notifempty`；journald 设 `SystemMaxUse=200M`、`MaxRetentionSec=14day` | S | 低：copytruncate 有极小丢数据窗口 | `logrotate -d` 语法通过；`logrotate -f` 后文件数/大小符合；重启服务后仍能写 | §5.1–5.3；logrotate man；journald 文档 |
| A9 | **dump 保留**：保留最新 3 份 + 14 天 + 总量 2G；在现有 `prune_dumps` 上增加时间/总量维度 | S | 低：删太早会丢取证；保留 3 份已够 | 造 5 个假 dump：只留 3；造 15 天前的：被删；总量超 2G：最旧被删 | §5.4；`lib.rs:3828`、`web_dump.rs:152` |
| A10 | **一次性收敛 17 条重复 issue**：dry-run 列出 #201–#216，保留 #217（唯一带 label/assignee），其余评论“canonical #217”后关闭；不删除 | S | 中：误关有人回复的 issue；本批均无评论，仍要 dry-run | 先 `--dry-run` 出清单；人工核对后执行；执行后 `count == 1` | §0.1；`gh issue list` |
| A11 | **文档/门禁同步**：把 A1/A3/A5/A6 写进 `CONTRIBUTING.md` 的发布流程与 `dsh-upstream-adaptation` 技能；`test-automation-gates` 增一条“canary 失败必须阻断”的变异对照 | S | 低：文档漂移；门禁本身要可失败 | 注入 canary 失败：门禁红；恢复：绿 | 本仓 `CONTRIBUTING.md:152-157` 门禁纪律 |

**工作量分布：S = 7（A3/A4/A7/A8/A9/A10/A11），M = 4（A1/A2/A5/A6），L = 0。**

### 7.1 建议实施顺序

1. **A10**（先把 17 条收敛掉，止血）
2. **A3**（PAT 加权限 + canary，防止边修边炸）
3. **A2 + A1**（去重键 + 单写者，根治重复）
4. **A5**（dead man's switch，补上“没告警”的告警）
5. **A6 + A7**（退避/状态机 + CI 降级）
6. **A8 + A9 + A4 + A11**（保留与文档，收尾）

---

## 8. 不采用（明确排除）

| 方案 | 为什么不用 | 依据 |
|---|---|---|
| 引入 PagerDuty / healthchecks.io / Opsgenie 等外部 SaaS | 用户已明确不采用；告警内容会离开本机；多一个外部依赖和凭据 | 任务约束；§2 的机制只用来自建，不引入服务 |
| 把 GitHub Actions `schedule` 当 SLA 主时钟 | 官方明确会延迟/丢弃；社区实测小时级 cron 可到 3–9h | §3.1–3.2 |
| 用 label 作为唯一去重键 | 本次 17 条重复的直接原因；label 是第二次写，可能静默失败 | §0.2 |
| 直接 `gh issue create --label ...` 当“原子创建” | create 与 label/assignee 是不同权限边界；本次 create 成功、label 缺失 | §0.2、§4.2 |
| 依赖 `GET /repos/...` 的 `permissions.admin=true` 判断 Issues 可写 | 本机反例：admin=true 仍 `updateIssue` 403 | §4.1；日志 `:2350` |
| systemd `StandardOutput=append` 自带轮转 | man page 只有打开模式，没有 rotate/maxsize；会无限增长 | §5.1 |
| `Restart=on-failure` + 固定 60s 当退避 | 不可重试错误会热循环；本次 #217 的 updateIssue 反复失败就是证据 | §0.3；`dsh-watch.service:8-9` |
| 自动关闭重复 issue 且不 dry-run | 可能误关有人回复/有人引用的单；本批虽无评论，仍应先 dry-run + 人工核对 | §7 A10 |
| 用 `continue-on-error` / `\|\| true` 让告警 step 变绿 | 假绿比没有门禁更糟；本仓已有“门禁必须可失败”的硬规则 | `CONTRIBUTING.md:152-157` |
| 让 CI 的 `GITHUB_TOKEN` 修 issue 来绕开 PAT 权限 | CI token 不能 `--admin` 合并；且本地/CI 双写者正是重复来源 | `scripts/dsh-release-autopilot.mjs:20-22`；§0.5 |
| 自建 Prometheus + Alertmanager 只为这一个仓库 | 规模不匹配；但 grouping/inhibition 的**语义**已吸收进 A2/A6 的“一个 target 一个 issue + 状态跃迁才通知” | §2.2 |

---

## 9. 假设与不可验证项（不得进采用清单）

| # | 事项 | 标注 | 验证方式 |
|---|---|---|---|
| H1 | 16 条 issue 的 label/assignee 缺失，是 `gh issue create --label` 在权限不足时“先创建、后失败但不报错”的行为 | `[假设]` | 用一个只读 token 对测试仓库跑一次 `gh issue create --label`，看 exit code 与 issue 实际 label；或读 gh CLI 对应版本源码 |
| H2 | 个人 fine-grained PAT 的过期时间没有 REST 查询端点 | `[本机不可验证]` | 向 GitHub Support 确认；或在组织 PAT 管理页验证 `token_expires_at` 只对 App 可用 |
| H3 | issue 的 assignee + @ 提及在当前账号通知设置下一定能送达 | `[假设]` | 用 canary issue 实测一次（需要人看 GitHub 通知/邮件）；不能只看 API |
| H4 | 本仓 Actions `schedule` 的实际延迟分布 | `[本机不可验证]` | 连续 7 天采集 `gh run list --json createdAt,startedAt` 做分布；不要用社区数据代替 |
| H5 | 标题/正文 marker 去重能覆盖“两个写者同时创建”的竞态 | `[假设]` | A1 单写者落地后仍要跑并发注入测试；单靠 A2 不能证明 |
| H6 | `gh issue list --state all --limit 100` 对这个仓库足够；超过 100 条会漏 | `[假设]` | A2 落地时加分页；用 >100 条 fixture 测 |
| H7 | `logrotate` 的 `copytruncate` 不会导致 systemd append 文件丢关键行 | `[假设]` | 演练：高频写日志 + 强制 rotate，对比 rotate 前后行数/关键标记 |
| H8 | “保留 3 份 dump + 14 天”足够取证 | `[假设]` | 按真实 hang 复盘频率评估；当前只发生 1 次，样本不足 |

> 采用清单 A1–A11 **没有**依赖 H1–H8 中的任何一条来成立：A1 依赖“双写者存在”（已验证），A2 依赖“label 缺失导致查不到”（已验证），A3 依赖“update/label 403”（已验证），A5 依赖“heartbeat 定义”（已验证），A6 依赖“指数退避语义”（已验证），A8/A9 依赖“没有轮转/已有 keep 3”（已验证）。

---

## 10. 取证命令（可复跑）

```bash
# 重复 issue 统计
./scripts/gh issue list --state all --limit 100 \
  --json number,title,labels,createdAt \
  --jq '[.[]|select(.title|contains("0.2.1-rc.3"))]|{count:length,with_labels:([.[]|select((.labels|length)>0)]|length),first:.[-1].number,last:.[0].number}'

# 单条 issue 的作者 / label / assignee
./scripts/gh api repos/karoc/dsh-desktop/issues/217 \
  --jq '{number,user:.user.login,labels:[.labels[].name],assignees:[.assignees[].login]}'

# 仓库级权限（注意：admin=true 不代表 Issues 可写）
./scripts/gh api repos/karoc/dsh-desktop --jq '.permissions'

# classic scope 头（fine-grained PAT 没有这个头）
./scripts/gh api -i user | grep -i 'x-oauth-scopes\|x-accepted-github-permissions'

# 失败日志
grep -n "Resource not accessible" ~/.dsh/logs/dsh-watch-timer.log | head
grep -n "已扫描 0 个 open issue" ~/.dsh/logs/dsh-watch-timer.log | head

# timer / 日志 / 磁盘
systemctl --user list-timers --all | grep dsh
du -h ~/.dsh/logs/*
journalctl --disk-usage
grep -n SystemMaxUse /etc/systemd/journald.conf
```

---

## 附：本仓相关坐标

| 主题 | 坐标 |
|---|---|
| watch 去重查询 | `scripts/dsh-watch.mjs:239-241` |
| watch 更新（会 403 的那步） | `scripts/dsh-watch.mjs:251-252` |
| watch 创建 | `scripts/dsh-watch.mjs:267-268` |
| autopilot 分支/PR 幂等 | `scripts/dsh-release-autopilot.mjs:60-65`、`:707-717`、`:764` |
| autopilot issue 回退创建 | `scripts/dsh-release-autopilot.mjs:535-541` |
| CI watch cron / 权限 / 并发 | `.github/workflows/dsh-watch.yml:16-17`、`:29-31`、`:33-35` |
| 项目 PAT 权限说明 | `CONTRIBUTING.md:134-140` |
| 门禁必须可失败 | `CONTRIBUTING.md:152-157` |
| hang dump 保留份数 | `src-tauri/src/lib.rs:3828`、`src-tauri/src/web_dump.rs:152` |
| 本机 timer | `~/.config/systemd/user/dsh-watch.timer:5-8`、`dsh-autopilot.timer:4`、`dsh-tagdispatch.timer:4` |
| 本机 append 日志 | `~/.config/systemd/user/dsh-watch.service:16-17` |
| 本机日志/事故 | `~/.dsh/logs/dsh-watch-timer.log:2190`、`:2350` |
