# 上游 issue 草稿（deepseek-ai/deepseek-harness）：dsh web 鉴权 cookie 名绑端口 → 无界累积 → 431

> 状态：**草稿，未提交**。用户确认后再发。可作为 issue 正文直接粘贴（英文正文 + 中文摘要）。
> 相关：`docs/2026-09-20-webview2-cookie-431-fix-plan.md`（壳侧修复）、`docs/2026-09-20-webview2-cookie-431-fix-audit.md`（审计）

---

## 摘要（中文）

`dsh web` 的鉴权 cookie 名绑定 authority（`dsh-auth-` + `base64url(sha256("127.0.0.1:<port>"))`），而每次启动的端口由 `--port 0` 随机分配 ⇒ 每次"完成的 token 导航"都新增一条 30 天不过期的 cookie，`Cookie` 请求头单调增长。当它把 Node 默认 16KB 头预算顶满后，**客户端插件批 bundle 的 URL（68 插件 ≈2.85KB，是页面上唯一 >1KB 的 URL）第一个被 `431 Request Header Fields Too Large` 打掉**，表现为页面停在 `Failed to load plugins / web N entries did not activate … import failed`——而真正的失败原因（bundle script 加载失败）被 `prefetchImmediateTier().catch(()=>{})` 吞掉，错误页不显示，排查成本极高。

## Suggested title

`dsh web: auth cookie name is bound to the port, so cookies accumulate unboundedly and long bundle URLs start failing with 431`

## Body (English)

### Summary

`dsh web` issues its auth cookie with a name derived from the **authority** (`dsh-auth-<base64url(sha256("host:port"))>`) and a 30-day `Max-Age`. Any embedder that starts `dsh web --port 0` (a new random port per run — e.g. a desktop shell supervising `dsh web`) therefore **adds one more cookie per completed token navigation, forever**. Because HTTP cookies are not port-scoped, every request to `127.0.0.1:<new-port>` carries *all* of them.

Node's default `http.maxHeaderSize` is 16384 bytes and the request line counts toward that budget. Once the accumulated `Cookie` header pushes a request over it, Node/llhttp answers:

```
HTTP/1.1 431 Request Header Fields Too Large
Connection: close
```

(with no `Date`/`Content-Type`/`Server`). The first victim is the **client-plugin batch bundle** — a single `GET /plugins/??<all specs>&rev=…` whose URL is ~2.85 KB with 68 plugins (measured: 2852 chars; every other URL on the page is ≤110 chars). Its failure is not reported as a load error: `prefetchImmediateTier()` swallows it (`.catch(r => {})`), the boot then marks every plugin as failed, and the user sees only:

```
Failed to load plugins
web boot: 61 entries did not activate
@deepseek-ai/dsh-api-gateway: import failed (see console for the import error)
…
```

So the visible symptom is "all client plugins fail to import" while the actual cause is a 431 on one subresource.

### Environment / measurements (reproducible)

- `dsh web` (0.1.6-alpha.1), Node 24.18.0, Windows 11 + WebView2 151.
- One cookie ≈ 226 bytes on the wire (`name` 52 + `value` 173); `Set-Cookie` is only emitted on `GET /?token=…` (303 See Other), attributes `Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`, host-only `127.0.0.1`.
- Threshold measured with a raw socket against a live `dsh web`:
  - request line 2811 B: `Cookie` 13500 B → 200, 14000 B → **431**
  - real batch URL 2846 B: header block 16407 B → 200, 16607 B → **431**
  - no cookie: URL 16299 chars → 431, 16199 → 404
  ⇒ the limit is 16384 B total (request line + headers), i.e. Node's default.
- Affected installation had ~57–68 accumulated cookies (13–15.5 KB) after ~1 month of a desktop shell starting `dsh web` a few times per day (96 token-bearing URLs in `manager.log`).
- A fresh browser profile (1 cookie) loads the same page in <1 s — the server and bundle content are healthy.

### Why it is hard to diagnose

1. The 431 only hits the *longest* URL, so the page itself renders (the boot error card comes from the app bundle), and it looks like a plugin/module-system problem.
2. `prefetchImmediateTier()`'s `catch(() => {})` discards the bundle-load error, and `Xy()` reports every entry as `import failed (see console for the import error)` — the real error is only in the browser console.
3. Nothing on the server side logs the 431 (no access log), so `manager.log`/`session.log` show only a page that never becomes ready.

### Suggested fixes (in priority order)

1. **Do not bind the cookie name to the port.** Use a stable name per host (e.g. `dsh-auth`), or scope it to the authority via `Path`/`Domain` semantics that do not multiply. If a per-authority name is intentional, then also **delete the previous authority's cookie** when issuing a new one.
2. **Make the batch URL short.** The `??`-combo URL grows ~22 B per plugin (68 plugins ≈ 2.85 KB) and is the first casualty of any header limit. A short hash / POST body / manifest indirection would remove this class of failure entirely.
3. **Surface bundle-load failures.** Have `prefetchImmediateTier`/the boot path keep the load error and render it on the boot error card (or at least include the failed URL) instead of a generic `import failed`.
4. (Nice to have) Emit an access-log line for 4xx responses, so a 431 on a subresource is diagnosable from the embedder's logs.

### Workarounds an embedder can apply today

- Prune stale `dsh-auth-*` cookies for the loopback host before navigating the webview (this is what we ship in the desktop shell; it keeps the jar at ~1 cookie).
- Raise the child's header limit: `NODE_OPTIONS=--max-http-header-size=65536` for the `dsh web` process (buys headroom; does not stop the accumulation).

---

## 提交前检查清单

- [ ] 用户确认是否提交、用哪个账号/仓库
- [ ] 附上最小复现脚本（raw socket 阈值探针，见 `scripts/hdrprobe.py`，可脱敏后作为 gist）
- [ ] 附上 `Failed to load plugins` 截图与 DevTools 431 截图（`.tmp-investigate/evidence/*.png`）
- [ ] 是否需要同时给 discussion #5495（OpenCode session 头相关）留链接——不相关，跳过
