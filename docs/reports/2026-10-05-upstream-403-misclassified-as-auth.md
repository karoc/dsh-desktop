# 上游 defects 报告稿：403 + `server_error` 被归类为 `AUTH`（GUI 显示「API 密钥无效」）

> 状态：**待提交**（我们对该仓库只有读权限：`POST /repos/deepseek-ai/deepseek-harness/issues` 返回
> `Resource not accessible by personal access token`）。提交后把 issue 链接回填到这里与看板卡。
> 核对版本：`deepseek-ai/deepseek-harness` checkout `5badb15`（**新于 dsh 0.2.0-rc.2**，即问题仍在）。

## 现象

网关返回 **HTTP 403**，body 是**上游瞬时故障**而非鉴权问题，但 DSH 把它归类为 `AUTH`，客户端因此显示
「本轮运行失败 / **API 密钥无效**」——用户会去重填密钥、怀疑自己的配置。

实测（2026-09-21 19:33，会话 `session-1ea02a4a` turn 1 step 26，通道 opencode-go-self）：

```
HTTP 403
{"type":"server_error","code":"server_error",
 "message":"Error from provider (Console Go): Upstream request failed: [server_error] Upstream response was not valid JSON"}
```

## 代码坐标（三处同一类假设）

1. `packages/llm/llm-pi-ai/src/stream.ts:43` —— **对错误消息文本做正则**：
   ```ts
   if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
   ```
   消息文本里**任何位置**出现 401/403 都会被判为鉴权失败（上面的 message 来自上游提供方，其内容不可控）。
2. `packages/llm/llm-deepseek/src/transport.ts:29`：
   ```ts
   if (status === 401 || status === 403 || ['authentication_error','permission_error'].includes(type)) code = 'AUTH'
   ```
   **不看 body 的 `type`/`code`**：即便 body 明确写 `"type":"server_error"`，403 仍归 AUTH。
3. 同类：`packages/llm/llm-deepseek/src/files-api.ts:50`（上传路径）、
   `packages/llm/llm-pi-ai/src/discovery.ts:340`（403 时提示 "; check the API key"）。

## 影响

- **误导**：瞬时上游故障被呈现为"密钥无效"，用户做无效的自救（重填密钥、换 provider）。
- **可能不重试**：`AUTH` 在语义上是"重试无用"的类别；若重试策略按 code 排除它，则一次上游抖动会变成硬失败。
  `[本机未验证]`：我未能在 checkout 里定位到按 code 决定重试的判定点（`git grep shouldRetry|retryable` 无命中），
  因此**这一条按假设处理，不作决策依据**——请维护者确认；如成立，与第 1 条合起来就是"抖动 → 不重试 → 报密钥错"的复合缺陷。

## 建议（最小改动）

1. **以 body 的错误类型为先**：`type`/`code` ∈ {`server_error`, …} → `SERVER`（可重试），**与状态码无关**；
   仅在 body 明确是 `authentication_error`/`permission_error`（或 401 且无 body 类型）时归 `AUTH`。
2. **pi-ai 不要对消息文本正则**：改为读结构化字段（status/code/type），或至少只在**响应状态字段**上匹配，
   不要匹配上游提供方回传的自由文本。
3. 若第 2 条成立，把"403 + `server_error`"纳入默认可重试类别。

## 我们侧的影响与绕行

DSH 桌面壳（karoc/dsh-desktop）把用户的 1M 通道经本地 relay 转到 sub2api；上游 502/503/403 抖动偶发。
当前绕行只能是人工重试；壳侧无法纠正分类（分类发生在 adapter 内部）。
