# Agent Note: doctor-comment-rest-id

Status: implemented

## Problem

dsh-doctor 的评论探测从 `gh issue view <n> --json comments` 取已存在评论的 id，再拼进 REST `PATCH repos/<repo>/issues/comments/<id>`。但该字段是 GraphQL node id（实测 `IC_kwDOT4z6kM8AAAABfF3P1w`，databaseId 为空），REST 端点只认数字 id ⇒ 404 `{"message":"Not Found"}`。第一次运行创建评论能 PASS，第二次起评论项必红 ⇒ `~/.dsh/heartbeat.json` 不再刷新 ⇒ 云端反向心跳 26h 后误报。自测长期假绿：内置桩让 `issue view --json comments` 返回数字 id，且 PATCH 不存在的 id 也返回成功。

## Decision

`scripts/dsh-doctor.mjs` 的评论探测改为：用 REST `gh api repos/<repo>/issues/<n>/comments?per_page=100` 列出评论（JSON 数组），在 Node 侧按 `COMMENT_MARK` 过滤，PATCH 目标固定为 REST 数字 `id`。负向保证：不再把 `gh issue view --json comments` 的 `id` 用于任何 REST 写路径；列表读取失败或解析失败即 fail-closed（标记该行 ✗、阻断后续写探测），不会退化成"再建一条"。

内置 gh 桩同步改为还原真实行为：`issue view --json comments` 返回 node id（`IC_...`、`databaseId: null`），REST 列表返回数字 `id` + `node_id`，PATCH 只有数字且命中的 id 才成功，否则输出 `gh: Not Found (HTTP 404)` 并 exit 1。新增自测 `[1b]`「评论已存在」回归用例（随 `test-automation-gates.mjs` 的 doctor 组执行）：预置一条已有探测评论，断言 exit 0、走 PATCH 未新增、PATCH 路径含数字 id `6381490135`、正文刷新到本次 `--now`，并显式断言**没有**再调用 `gh issue view ... --json comments` 取 id。

真实 canary #221 连续两次运行均 PASS：第一次与第二次都是 `✓ 更新探测评论 #6381490135（未新增）`，`heartbeat.json` 的 `lastOkAt` 从 `07:32:11Z` → `08:16:58Z` → `08:17:31Z`（第二次确实刷新）。
## Alternatives considered

**改读 `gh issue view --json comments` 的 databaseId**：最省事，但实测该字段为空（token 是 fine-grained PAT；gh 的 comment JSON 也没有暴露可用的数字 id），做不到"改用另一个字段"就修好。

**用 `gh api graphql` 查 comments 的 databaseId**：能拿到数字 id，但比 REST 列表多一层 GraphQL 查询与分页处理，而且同样要 Node 侧过滤；收益为零。

**`gh api ... --paginate --slurp` + jq 过滤**：最初想用 `--slurp` 把分页整成数组，但本机 gh 2.45.0 明确报 `unknown flag: --slurp`（`gh api --help` 只有 `--paginate`），CI 版本不保证更高。改为单页 `?per_page=100`：与旧实现 `gh issue view` 的 100 条上限同界，不是新增限制。

**只加断言、不改桩**：桩继续返回数字 id 且 PATCH 任意 id 成功，回归用例永远假绿（这正是本次缺陷能长期存在的原因），必须同时修桩才有负向对照。

**顺手把自测的时钟炸弹一起修**：不在本 PR 写域内（另有在途 PR 改同一文件的桩时钟），避免两个写者改同一处；本 PR 的分支合并顺序由 Lead 串行处理。
## Consequences

代价：评论列表只读第一页 100 条（与旧实现同界）；多了一个 REST 调用（每次 doctor 一次 GET，量级可忽略）；桩的 PATCH 语义变严格，任何未来"用非数字 id 拼 REST 路径"的写法都会在自测里立即变红。

收益：真实环境第二次起的 404 消失，心跳恢复刷新；自测从"结构上不可能失败"变成可失败（两次变异均红：PATCH 换成 `existing.node_id`、id 来源退回 `viewIssue('comments')`）。

遗留：本 PR 的 CI 在合入前会因既有的自测时间炸弹而红（doctor 组 + mutation baseline 4 条，与 `db71e9d` 基线 62/63 同一条失败），须先合桩时钟修复再 rebase；合并后 CONTRIBUTING 的自测条数应为 72（本 PR 基线 70 + 时钟 PR 的 2 条）。`CONTRIBUTING.md` 的条数已同步为 70（单独合入时正确）。

