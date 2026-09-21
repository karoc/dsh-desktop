import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
//#region src/index.ts
/**
* Smoothly OpenCode Session (Smoothly OCS) — 思磨力 OpenCode 会话头.
*
* External DeepSeek Harness HOST plugin: attaches the OpenCode-required
* `x-opencode-session` request header to model calls routed to OpenCode /
* OpenCode Go provider routes. Since 2026-09-05 OpenCode's relay rejects any
* inference request that lacks the header (400 MissingSessionID); the value is
* a stable per-conversation id, which is also what pins a conversation to one
* upstream backend and keeps the prompt cache warm across its turns.
*
* Mechanism (each piece verified against the official contracts):
*   - `llm/stream` is a documented waterfall ("Waterfall around every
*     streaming model call"); LOOP-built options are deep-frozen, so listeners
*     read, never rewrite. This plugin observes provider + sessionId there,
*     drives the downstream stream's pulls inside an AsyncLocalStorage store,
*     and merges the header in one patched `globalThis.fetch`.
*   - Injection is gated by a HOST ALLOW LIST (default `https://opencode.ai`):
*     a request is modified only when it is (a) inside a matched session
*     stream and (b) addressed at an allowed host. A request that already
*     carries the header is never modified (an existing value always wins),
*     and a request whose URL cannot be parsed is never modified.
*   - Both registrations are fiber-scoped (`ctx.on` listener + `ctx.effect`
*     disposer), so stopping / updating / unloading the plugin restores the
*     original `fetch` and removes the listener.
*
* Negative guarantees (what this plugin does NOT do):
*   - A request whose INITIAL url is not an allowed host is never modified.
*     Redirect targets are NOT re-gated: Node's fetch follows redirects and
*     (measured on Node 24) keeps custom headers across origins, so a request
*     that starts on an allowed host and redirects elsewhere carries the
*     header to the redirect target.
*   - The one-shot model listing used by the Models page
*     (`GET <baseURL>/models`) carries no session id; it is untouched unless
*     `discoveryFallback` is explicitly enabled, in which case ONLY `GET`
*     requests whose path ends in `/models` receive a process-stable fallback
*     UUID.
*   - Injection rides on Node's global `fetch`. If a future dsh version swaps
*     its network stack, the header silently stops being sent (the 400 comes
*     back) — uninstall then.
*
* This is an external-plugin stopgap: the long-term fix belongs in the
* provider adapter (pi-ai). See the README "Notes / limitations" section for
* the verifiable retirement procedure.
*/
/** Plugin display metadata (cordis diagnostics). */
const name = "dsh-smoothly-opencode-session";
/**
* The `llm/stream` waterfall lives on the abstract `llm` service (dsh-llm).
* Injecting it keeps this plugin PENDING until that service exists.
*/
const inject = ["llm"];
const SESSION_HEADER = "x-opencode-session";
/**
* Provider route keys whose requests receive the header. A pi-ai catalog
* provider keeps its id as the route key, so both built-in OpenCode ids are
* covered; deployments that serve OpenCode under a custom provider key (e.g.
* `opencode-go-self`) add it through config.
*/
const DEFAULT_PROVIDERS = ["opencode", "opencode-go"];
/** Default host gate: OpenCode's own endpoints (subdomains included). */
const DEFAULT_HOSTS = ["https://opencode.ai"];
/** Normalize one configured host entry; undefined when unusable. */
function ruleFromEntry(entry) {
	const stripped = entry.startsWith("*.") ? entry.slice(2) : entry;
	const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(stripped) ? stripped : `https://${stripped}`;
	try {
		const url = new URL(candidate);
		const host = url.hostname.toLowerCase().replace(/\.$/, "");
		if (host === "") return void 0;
		return url.port === "" ? {
			protocol: url.protocol,
			host
		} : {
			protocol: url.protocol,
			host,
			port: url.port
		};
	} catch {
		return;
	}
}
const DEFAULT_POLICY = {
	rules: [ruleFromEntry(DEFAULT_HOSTS[0])],
	wildcard: false
};
/**
* Normalize the configured host entries:
*   - absent/empty → the default rule;
*   - `*` → the gate is disabled (wildcard);
*   - `*.example.com` → `example.com` (subdomains match anyway);
*   - `host` without a scheme → `https://host`;
*   - IDN entries normalize to punycode and trailing dots are dropped (via URL);
*   - unusable entries are REPORTED (`dropped`) rather than silently ignored;
*   - if every provided entry is unusable, the default rule applies.
*/
function normalizeHosts(input) {
	const entries = Array.isArray(input) && input.length > 0 ? input : DEFAULT_HOSTS;
	const dropped = [];
	const rules = [];
	let wildcard = false;
	for (const raw of entries) {
		const entry = String(raw).trim();
		if (entry === "") continue;
		if (entry === "*") {
			wildcard = true;
			continue;
		}
		const rule = ruleFromEntry(entry);
		if (rule === void 0) dropped.push(entry);
		else rules.push(rule);
	}
	if (wildcard) return {
		policy: {
			rules: [],
			wildcard: true
		},
		dropped
	};
	if (rules.length === 0) return {
		policy: DEFAULT_POLICY,
		dropped
	};
	return {
		policy: {
			rules,
			wildcard: false
		},
		dropped
	};
}
/**
* Whether a request target passes the host gate. Protocol must match the rule;
* the host must equal the rule host or be a subdomain of it; an explicit port
* must match. An unparsable target never passes; `wildcard` passes everything.
*/
function hostAllowed(target, policy) {
	if (policy.wildcard) return true;
	let url;
	try {
		url = target instanceof URL ? target : new URL(String(target));
	} catch {
		return false;
	}
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (host === "") return false;
	for (const rule of policy.rules) {
		if (rule.protocol !== url.protocol) continue;
		if (host !== rule.host && !host.endsWith(`.${rule.host}`)) continue;
		if (rule.port !== void 0 && rule.port !== url.port) continue;
		return true;
	}
	return false;
}
/** Resolve row config against code defaults (missing keys are never required). */
function resolveConfig(config = {}) {
	const providers = Array.isArray(config.providers) && config.providers.length > 0 ? config.providers.map((value) => String(value)) : [...DEFAULT_PROVIDERS];
	const { policy, dropped } = normalizeHosts(config.hosts);
	return {
		providers: new Set(providers),
		hosts: policy,
		droppedHosts: dropped,
		mode: config.mode === "uuid" ? "uuid" : "session-id",
		debug: config.debug === true,
		...typeof config.debugFile === "string" && config.debugFile.length > 0 ? { debugFile: config.debugFile } : {},
		debugRequests: config.debugRequests === true,
		discoveryFallback: config.discoveryFallback === true
	};
}
/** Human-readable description of the effective host gate (startup log). */
function describeHosts(policy) {
	if (policy.wildcard) return "* (gate DISABLED)";
	return policy.rules.map((rule) => `${rule.protocol}//${rule.host}${rule.port === void 0 ? "" : `:${rule.port}`}`).join(", ");
}
/**
* Derive the opaque header value for one DSH session id.
* `session-id` mode returns the raw id (unique per conversation, stable across
* turns, compaction, retries and restarts); `uuid` mode returns a process-
* stable random uuid derived once per session id.
*/
function headerValueFor(sessionId, mode, table) {
	const raw = String(sessionId);
	if (raw.length === 0) return void 0;
	if (mode !== "uuid") return raw;
	let value = table.get(raw);
	if (value === void 0) {
		value = randomUUID();
		table.set(raw, value);
	}
	return value;
}
/** True when an outgoing request already carries the session header. */
function hasSessionHeader(input, init) {
	const source = init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : void 0);
	if (source === void 0) return false;
	try {
		return new Headers(source).has(SESSION_HEADER);
	} catch {
		return false;
	}
}
/** Short, non-reversible fingerprint of an injected value. */
function hashValue(value) {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
/** The request URL as text, when derivable from the fetch input. */
function requestUrl(input) {
	if (typeof input === "string") return input;
	if (typeof URL !== "undefined" && input instanceof URL) return input.href;
	if (typeof Request !== "undefined" && input instanceof Request) return input.url;
}
/** The request host (lowercase, no trailing dot), when the URL is parsable. */
function requestHost(input) {
	const raw = requestUrl(input);
	if (raw === void 0) return void 0;
	try {
		const host = new URL(raw).hostname.toLowerCase().replace(/\.$/, "");
		return host === "" ? void 0 : host;
	} catch {
		return;
	}
}
/** The effective request method (init wins, then a Request's own method). */
function requestMethod(input, init) {
	if (init?.method !== void 0) return String(init.method).toUpperCase();
	if (typeof Request !== "undefined" && input instanceof Request) return input.method.toUpperCase();
	return "GET";
}
/** Request headers to merge into, honoring fetch's own precedence rules. */
function baseHeaders(input, init) {
	return new Headers(init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : void 0));
}
/**
* Build a patched fetch. Decision order (the gate is a conjunction, never a
* bypass of the existing semantics):
*   1. the request already carries the header → untouched (existing value wins);
*   2. inside a session stream → inject only when the host gate allows it;
*   3. no store + discoveryFallback → inject the fallback value only for `GET`
*      requests whose path ends in `/models` and whose host is allowed;
*   4. anything else → untouched.
*/
function patchFetch(original, als, options = {}) {
	const policy = options.hosts ?? DEFAULT_POLICY;
	return function patchedFetch(input, init) {
		const passthrough = () => original.apply(this, [input, init]);
		const host = requestHost(input);
		if (hasSessionHeader(input, init)) {
			const state = als.getStore();
			if (state !== void 0) options.trace?.({
				kind: "skip",
				reason: "already-present",
				host,
				provider: state.provider
			});
			return passthrough();
		}
		const state = als.getStore();
		if (state !== void 0) {
			if (!hostAllowed(requestUrl(input) ?? "", policy)) {
				options.onHostBlocked?.(state.provider, host ?? "(unparsable)");
				options.trace?.({
					kind: "skip",
					reason: "host-not-allowed",
					host,
					provider: state.provider
				});
				return passthrough();
			}
			const headers = baseHeaders(input, init);
			headers.set(SESSION_HEADER, state.value);
			options.trace?.({
				kind: "inject",
				reason: "session",
				host,
				provider: state.provider,
				valueHash: hashValue(state.value),
				valueLen: state.value.length,
				...options.revealValues === true ? { value: state.value } : {}
			});
			return original.call(this, input, {
				...init,
				headers
			});
		}
		if (options.discoveryFallback === true && options.discoveryValue !== void 0) {
			const raw = requestUrl(input);
			let path;
			try {
				path = raw === void 0 ? void 0 : new URL(raw).pathname;
			} catch {
				path = void 0;
			}
			if (requestMethod(input, init) === "GET" && path !== void 0 && path.endsWith("/models") && hostAllowed(raw ?? "", policy)) {
				const headers = baseHeaders(input, init);
				headers.set(SESSION_HEADER, options.discoveryValue);
				options.trace?.({
					kind: "inject",
					reason: "discovery",
					host,
					valueHash: hashValue(options.discoveryValue),
					valueLen: options.discoveryValue.length,
					...options.revealValues === true ? { value: options.discoveryValue } : {}
				});
				return original.call(this, input, {
					...init,
					headers
				});
			}
		}
		return passthrough();
	};
}
/**
* Wrap a downstream async iterable so every operation — `next`, `return` and
* `throw` alike — executes inside an AsyncLocalStorage store. Async generators
* and the promises they create inherit the store as long as the generator body
* is driven from a call made inside `als.run`, which is what this wrapper does
* per operation (so teardown-time requests are covered too).
*
* A teardown (`return`) failure is reported through `onTeardownError` instead
* of being silently discarded: an aborted stream may legitimately already be
* torn down, so consumption still completes, but the failure is never invisible.
*/
function withStore(iterable, store, als, onTeardownError) {
	const iterator = typeof iterable[Symbol.asyncIterator] === "function" ? iterable[Symbol.asyncIterator]() : iterable;
	return {
		[Symbol.asyncIterator]() {
			return this;
		},
		async next() {
			return als.run(store, () => iterator.next());
		},
		async return(value) {
			if (typeof iterator.return === "function") try {
				return await als.run(store, () => iterator.return(value));
			} catch (error) {
				try {
					onTeardownError?.(error);
				} catch {}
			}
			return {
				done: true,
				value
			};
		},
		async throw(error) {
			if (typeof iterator.throw === "function") return als.run(store, () => iterator.throw(error));
			throw error;
		}
	};
}
/** Fire-and-forget append of one JSON record; failures only log a warning. */
function recordDebug(ctx, file, entry) {
	appendFile(file, `${JSON.stringify(entry)}\n`, "utf8").catch((error) => {
		ctx.logger.warn("[%s] debugFile write failed: %s", name, error?.message ?? String(error));
	});
}
function apply(ctx, config = {}) {
	const resolved = resolveConfig(config);
	const als = new AsyncLocalStorage();
	const uuidBySession = /* @__PURE__ */ new Map();
	const discoveryValue = randomUUID();
	const blockedPairs = /* @__PURE__ */ new Set();
	const originalFetch = globalThis.fetch;
	if (typeof originalFetch !== "function") {
		ctx.logger.warn("[%s] globalThis.fetch is unavailable; cannot inject %s", name, SESSION_HEADER);
		return;
	}
	const trace = (record) => {
		if (!resolved.debugRequests && resolved.debugFile === void 0) return;
		const entry = {
			ts: (/* @__PURE__ */ new Date()).toISOString(),
			...record
		};
		if (resolved.debugFile !== void 0) recordDebug(ctx, resolved.debugFile, entry);
		if (resolved.debugRequests) ctx.logger.info("[%s] %s %s (%s)%s", name, record.kind, record.host ?? "(no host)", record.reason, record.provider === void 0 ? "" : ` provider=${record.provider}`);
	};
	const patched = patchFetch(originalFetch, als, {
		hosts: resolved.hosts,
		discoveryFallback: resolved.discoveryFallback,
		discoveryValue,
		trace,
		revealValues: resolved.debug,
		onHostBlocked: (provider, host) => {
			const key = `${provider}|${host}`;
			if (blockedPairs.has(key)) return;
			blockedPairs.add(key);
			ctx.logger.warn("[%s] provider \"%s\" stream targeted a host outside the gate (%s); header NOT attached. Add it to `hosts` (write the full scheme, e.g. https://mirror.example) or set hosts: [\"*\"] to disable the gate.", name, provider, host);
		}
	});
	ctx.effect(() => {
		globalThis.fetch = patched;
		ctx.logger.info("[%s] active for providers [%s] with mode %s", name, [...resolved.providers].join(", "), resolved.mode);
		ctx.logger.info("[%s] host gate: %s", name, describeHosts(resolved.hosts));
		if (resolved.hosts.wildcard) ctx.logger.warn("[%s] host gate is DISABLED (hosts: [\"*\"]) — while a session stream is active, ANY host receives the header", name);
		if (resolved.droppedHosts.length > 0) ctx.logger.warn("[%s] ignored unusable hosts entries: %s", name, resolved.droppedHosts.join(", "));
		if (resolved.discoveryFallback) ctx.logger.info("[%s] discoveryFallback is ON: GET .../models requests get a process-stable id", name);
		return () => {
			if (globalThis.fetch === patched) globalThis.fetch = originalFetch;
		};
	}, `${name}.fetch-patch`);
	ctx.on("llm/stream", (options, next) => {
		if (options === void 0 || options === null || typeof options !== "object") return next();
		const provider = String(options.provider);
		if (!resolved.providers.has(provider)) return next();
		const sessionId = options.sessionId;
		if (sessionId === void 0 || sessionId === null) return next();
		const value = headerValueFor(String(sessionId), resolved.mode, uuidBySession);
		if (value === void 0) return next();
		let downstream;
		try {
			downstream = next();
		} catch (error) {
			throw error;
		}
		if (downstream === void 0 || downstream === null) return downstream;
		if (typeof downstream[Symbol.asyncIterator] !== "function") return downstream;
		if (resolved.debug || resolved.debugFile !== void 0) {
			const entry = {
				ts: (/* @__PURE__ */ new Date()).toISOString(),
				kind: "stream",
				provider,
				model: options.model,
				session: String(sessionId),
				header: SESSION_HEADER,
				value
			};
			if (resolved.debugFile !== void 0) recordDebug(ctx, resolved.debugFile, entry);
			if (resolved.debug) ctx.logger.info("[%s] streaming provider \"%s\" with %s=%s", name, provider, SESSION_HEADER, value);
		}
		return withStore(downstream, {
			value,
			provider
		}, als, (error) => {
			ctx.logger.warn("[%s] teardown of provider \"%s\" stream failed: %s", name, provider, String(error?.message ?? error).split("\n")[0]);
		});
	}, { prepend: true });
}
var src_default = {
	name,
	inject,
	apply
};
//#endregion
export { apply, src_default as default, describeHosts, hasSessionHeader, headerValueFor, hostAllowed, inject, name, normalizeHosts, patchFetch, resolveConfig, withStore };
