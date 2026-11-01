# 状态报告：托盘会话聚合 + 通知链路

**日期**：2026-11-02
**分支**：`feat/tray-session-aggregate`（PR #255）
**HEAD**：`cc80fbc`
**状态**：功能可用，4 项已知限制未解决，其中 2 项需要产品决策

> 本文件是交接档案：记录做了什么、验证过什么、没解决什么、以及为什么不继续。
> 结论按「已验证 / 未验证 / 已证伪」标注，不写没有证据的判断。

---

## 1. 需求

初始需求：托盘图标显示会话状态（哪些在跑、哪些在等人），Super-agent 文章第 4 节的"面向人的交互"判据。
后续扩展为：点击通知直达对应会话。

---

## 2. 当前可用功能（均已实机验证）

| 功能 | 状态 | 验证方式 |
|---|---|---|
| 托盘 tooltip 显示会话明细 | ✅ | UIA 读 `NotifyItemIcon` 的 Name |
| 待处理 / 运行中 / 完成 三态 | ✅ | 真实会话进入待审批，tooltip 变化 |
| 点击弹窗 → 立即跳转对应会话 | ✅ | 用户实测 |
| 点击通知中心卡片 → 最终跳转 | ⚠️ 可用但慢 | 用户实测（30–60s） |
| 点击后通知中心卡片消失 | ✅ | 用户实测 |

tooltip 形态（真实数据）：

```
DSH Smoothly Desktop Dev
● 待处理 · 修托盘聚合
▶ 部署验证
○ 代码审查
```

---

## 3. 已修复的问题（按发现顺序）

### 3.1 托盘 tooltip（功能本体）

| 问题 | 根因 | 修复 |
|---|---|---|
| tooltip 只显示产品名 | 托盘 tooltip 从未被设置过 | `POST /state` → `tray_by_id().set_tooltip()` |
| 待审批永远不显示（橙点出现了但 tooltip 仍是 ▶） | **数据源错**：`pendingInteraction` 不在 `SessionSummary`（列表行），而在 `uiSession.sessionStatus` | `inject: ['uiSession']` + `statusOf()` |
| 同上，且**代码从未被唤醒** | **触发源错**：`scan()` 只订阅 `sessions.list`，而会话进入待审批**不改变任何列表行** | 同时订阅 `uiSession.sessionStatus` |

> 这两条是本功能最长的排查：先修数据源、再修触发源。**数据读得到 ≠ 代码会去读**。

### 3.2 通知与点击

| 问题 | 根因 | 修复 |
|---|---|---|
| 点击通知不打开会话 | `ctx.sessions.open` 在 dsh 0.2.x **不存在**（0.1.6 起移除）；旧代码走 `draft.current` 死兜底并记"成功"日志 | 改用 `ctx.uiWorkspace.openSession(sid)` |
| 任意焦点切换都跳上次会话 | `FOCUS_OPEN` 无 TTL，任何 `Focused(true)` 都消费它 | 加 10s TTL |
| 普通二次启动也跳会话 | 单实例回调无条件 stage | 仅在 toast 激活时 stage |
| 通知误抑制（窗口后置仍判为聚焦） | `document.hasFocus()` 在 WebView2 不可靠 | Win32 `GetForegroundWindow` + pid 比较 + 5s 轮询 |
| 通知中心点击无效 | 激活不带 `-ToastActivated` | 持久化 `last-session.txt`，30 分钟内回退 |
| 通知中心卡片不消失 | `History()` 从 Rust 调用返回 `E_UNEXPECTED` | 壳内 spawn PowerShell 执行 `History.Clear(appId)` |
| 轮询挂起导致后续点击全失效 | `polling` 是单向闩锁 | 加 3s 超时 |
| 一次点击触发 8 次 open | dispose 后已排定的 tick 仍执行 | tick 入口检查 `disposed` |

### 3.3 关键教训

**`document.hasFocus()`、Tauri `is_focused()`、`WindowEvent::Focused(false)` 三者都不可靠**，焦点只能靠 Win32 前台窗口 pid 判定。

**`ToastNotificationManager.History` 从 Rust 调用报 `0x8000FFFF`，但 PowerShell 调用同一 API 成功**——说明不是平台限制，是 Rust 侧调用方式问题（未定位）。当前用 PowerShell 绕过。

**测试 fixture 必须匹配真实类型形状**：早期 fixture 在列表行上写了真实不存在的 `pendingInteraction` 字段，导致测试全绿而功能全废。

---

## 4. 未解决的问题

### 4.1 通知中心点击延迟 30–60 秒 ⚠️

**现象**：弹窗点击即时；通知中心卡片点击慢，但最终生效。

**根因**（已定位）：`tauri-winrt-notification` 在 `show()` 里注册 `ToastNotification.Activated` handler，但 `show()` 返回后对象被 drop。弹窗还在屏幕上时事件有效；进入通知中心后 handler 失效，点击落到系统级 COM 激活（日志中的 `-Embedding`），Windows 等待 OLE 超时。

**未验证的关键点**：自建 toast 并持有对象后，通知中心的旧卡片**是否还会触发 `Activated` 事件**。若不会，只能注册 COM activator 服务器（风险高）。

**建议**：做一次有边界的实验（自建 + 持有 + 注册 handler，只验证事件是否触发），失败即回退。

### 4.2 per-toast sessionId（点旧卡片开对会话）⚠️

**现状**：打开"最近一条通知"的会话，不是被点的那张卡片的会话。

**根因**：`launch="dsh-session=..."` 不传命令行——Windows 走 COM 激活，args 只有 `-Embedding`（日志已验证）。

**修复方向**：需要 `ToastNotification.Activated` 的 COM 事件参数，与 4.1 是同一件事。

### 4.3 审计发现的 4 个 P1（未修）

| 编号 | 问题 | 影响 |
|---|---|---|
| P1-2 | `ctx.connection.api` 不存在 → turn/end 原因分类从未工作 | **所有失败都播报"已完成"** |
| P1-3 | `completionUnread` 只在 `!isMain` 时置位 → "藏着等会话跑完"永远不出现 ○ | 托盘完成态不可用 |
| P1-4 | `inject` 是整站单点，peer 地板恒满足使 plugin-floor 失效 | 上游改服务名 → **整页白屏** |
| P2-4 | `pendingInteraction` 是对象却当字符串查表 | 「需要你」文案永不命中 |

### 4.4 单实例回调会清空全部卡片

`Clear(appId)` 无 tag 支持，所以任何落入 `staged` 分支的激活都会清空所有通知卡片（包括用户手动二次启动）。**未验证是否会困扰用户**。

---

## 5. 验证状态

| 项目 | 状态 |
|---|---|
| 行为测试 | `PASS (23 notification + 9 aggregate + 1 open-path)` |
| 负向对照 | 3 处变异全部精确命中预期断言 |
| 弹窗点击 | 用户实测即时 ✅ |
| 通知中心点击 | 用户实测延迟 ⚠️ |
| 卡片消失 | 用户实测 ✅ |
| 冷启动路径（壳退出后点通知） | **未验证** |
| 多通知场景（点较早的卡片） | **未验证**（且已知会开错会话） |

---

## 6. 关键证据位置

| 内容 | 位置 |
|---|---|
| 运行时日志 | `%APPDATA%\dsh.smoothly.desktop.dev\dsh-desktop-session.log` |
| 最近会话持久化 | `%APPDATA%\dsh.smoothly.desktop.dev\last-session.txt` |
| 实机验证手法 | UIA 读任务栏 `AutomationId=NotifyItemIcon` 的 `Name`（需 `SetProcessDPIAware`） |
| 审计报告 | 看板卡「多角度审计：托盘会话聚合 + 通知链路」 |
| 实现决策 | `.agents/notes/implemented/feature/2026-10-31-shell-tray-session-aggregate.md` |
| 测试方法论 | `.agents/notes/implemented/testing/2026-11-01-fixture-must-match-real-shape.md` |

---

## 7. 下一步（按优先级）

1. **决定 4.1 是否继续**：做有边界的实验，或接受现状。
2. **修 P1-2 / P1-3**：通知内容正确性，比点击延迟更影响信任（失败被说成完成）。
3. **修 P1-4**：白屏风险，与上游升级赛跑。
4. 处理 4.4：把清空限制为确实由通知触发的场景。

---

## 8. 备注

- PR #255 含一个无关提交 `2f1218a`（他人 release 校验器工作），已用分支 `feat/release-publish-verifiers` 保存引用，未擅自删除。
- `.tmp-superagent-md/` 为另一任务的产物（文章转 Markdown），与本功能无关。
