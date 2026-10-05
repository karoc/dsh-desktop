# 内部记录（不提交上游）：403 + `server_error` 被归类为 `AUTH`（GUI 显示「API 密钥无效」）

> 状态：**内部记录 —— 决定不提交上游**（2026-10-05 用户决定）。
> 保留目的：① 我们自己的证据与结论闭环（同样症状再现时直接有依据）；② 若将来改变决定，本文即可直接粘贴的现成材料。
> 上游渠道实测（备查）：`deepseek-ai/deepseek-harness` 的 **`has_issues=false`**（该仓没有 issue 通道）、
> `has_discussions=true`；`POST /issues` 即使带 token 也返回 403 `Resource not accessible by personal access token`
> （请求被拒、未创建任何内容）。可用渠道若将来需要：GitHub Discussions 或 GUI 内「意见反馈」飞书问卷。
> 核对版本：> 核对版本：> `Resource not accessible by personal access token`）。提交后把 issue 链接回填到这里与看板卡。
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
- **确认不重试（复合缺陷）** `[已验证: git grep llm-retry]`：重试由**可重试 code 白名单**决定 ——
  `packages/llm/llm-retry/src/index.ts:215`：
  ```ts
  } else if (!policy.retryableCodes.includes(failure.code)) { /* 不重试 */ }
  ```
  默认策略的 `retryableCodes` 只见 `['RATE_LIMIT','SERVER']`
  （`packages/llm/llm-retry/tests/loader-composition.spec.ts:27`）。**`AUTH` 不在其中** ⇒ 一次上游抖动被
  判成 `AUTH` 之后**不会重试**。与第 1 条合起来即复合缺陷：
  **「403 抖动 → 归类 AUTH → 不重试 → GUI 报『API 密钥无效』」**——用户看到的是配置错误，而不是瞬时故障，
  于是去做无效自救（重填密钥/换 provider）。

## 建议（最小改动）

1. **以 body 的错误类型为先**：`type`/`code` ∈ {`server_error`, …} → `SERVER`（可重试），**与状态码无关**；
   仅在 body 明确是 `authentication_error`/`permission_error`（或 401 且无 body 类型）时归 `AUTH`。
2. **pi-ai 不要对消息文本正则**：改为读结构化字段（status/code/type），或至少只在**响应状态字段**上匹配，
   不要匹配上游提供方回传的自由文本。
3. 把"403 + body `server_error`"映射为 `SERVER`（或直接加入默认 `retryableCodes`）—— 上游抖动应当可重试。

## 我们侧的影响与绕行

DSH 桌面壳（karoc/dsh-desktop）把用户的 1M 通道经本地 relay 转到 sub2api；上游 502/503/403 抖动偶发。
当前绕行只能是人工重试；壳侧无法纠正分类（分类发生在 adapter 内部）。
