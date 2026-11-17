# Agent Note: verify-hang-dump-scoped-assertions

Status: implemented

## Problem

`scripts/verify-hang-dump.ps1 -Action check` 原来把整份 `manager.log` / `session.log` 读进来做 `-match`。两个后果：

1. **假绿**：旧 dev 数据目录里，上一次事故留下的 `dump ready — restarting dsh` 行让断言“通过”，即使本次挂起根本没有走到那条路径。
2. **假红**：全新数据目录（隔离实例 `dsh.smoothly.desktop.devw7`）上，manager 实际打的是 `still UNRESPONSIVE after dump (probe TimeoutError, 34670ms, dump ready) — restarting dsh` —— 旧正则要求 `dump ready` 后紧接 em dash，于是真挂起明明 dump+重启了，断言仍失败。

## Decision

- `-Action hang` 在冻结前记录 `manager.log` / `session.log` 的**当前长度**与挂起 URL 到 `<runtime>\.verify-hang-offset`；
- `-Action check` 从偏移处读取两个日志（`Get-TextSince `），只匹配本次挂起产生的行；无 marker 时回退整文件（兼容手工顺序调用）；
- 重启断言接受 manager 的**两条**合法路径：`dump ready — restarting dsh`（壳先回 ack）与 `still UNRESPONSIVE after dump (...) — restarting dsh`（壳已自己 dump、探针仍超时）；
- 新增「live URL 已变化」断言：告警日志说重启了不算，**URL 真的换了**才算。

## Alternatives considered

**只把正则放宽到两条路径、不做偏移**：否 —— 只解决假红，不解决假绿；旧行仍可让断言通过。
**用「最近 N 行」代替偏移**：否 —— N 是猜测，长 dump 等待或并发日志会漂移；偏移是精确边界。
**check 里重新解析 manager.log 的时间戳（只认本次 hang 之后的行）**：否 —— manager 日志时间戳是 ISO、脚本要跨多行匹配多条断言，偏移更简单且无时间格式契约。

## Consequences

买到的：同一脚本在「旧数据目录」与「全新隔离实例」上结论一致；红→绿对照可复现（修复前隔离实例冻结场景 FAIL，修复后 PASS）。

代价：`hang` 会往 runtime 写一个小 marker 文件（`.verify-hang-offset`，几十字节）；若手工只跑 `check` 而不跑 `hang`，会回退整文件匹配（保持旧兼容，但也就没有 scoped 保证）；`resume`/`state` 不读写 marker。
