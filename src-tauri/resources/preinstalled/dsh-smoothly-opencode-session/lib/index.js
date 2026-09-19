import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
//#region src/index.ts
/**
* Smoothly OpenCode Session (Smoothly OCS) — 思磨力 OpenCode 会话头.
*
* External DeepSeek Harness HOST plugin: attaches the OpenCode-required
* `x-opencode-session` request header to model calls routed to OpenCode /
* OpenCode Go provider routes. Since 2026-09-05 OpenCode's relay rejects any
* inference request that lacks the header (400 MissingSessionID); the value
* is a stable per-conversation id, which is also what pins a conversation to
* one upstream backend and keeps the prompt cache warm across its turns.
*
* Mechanism (each piece verified against the official contracts):
*   - `llm/stream` is a documented waterfall ("Waterfall around every
*     streaming model call", api-catalog), signature
*     `(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>)`.
*     LOOP-built options are deep-frozen: listeners read, never rewrite.
*   - The header therefore cannot be added by mutating options. This plugin
*     observes provider + sessionId at the waterfall, then drives the
*     downstream stream's pulls inside an AsyncLocalStorage store while one
*     patched `globalThis.fetch` merges the header onto the outbound request
*     (unless it already carries one — an existing value always wins).
*   - Registrations are fiber-scoped (ctx.on listener + ctx.effect disposer),
*     so stopping / updating / unloading the plugin restores the original
*     fetch and removes the listener.
*
* Scope notes / honest limitations:
*   - Requests NOT routed to a configured OpenCode provider, or carrying no
*     session id (some auxiliary hand-built calls), pass through untouched.
*   - The header attaches to chat/streaming requests inside an `llm/stream`
*     call. The one-shot model listing used by the Models page
*     (`GET <baseURL>/models`) is a separate flow and does not receive the
*     header.
*   - Injection rides on Node's global `fetch`. If a future dsh version swaps
*     its network stack, the header silently stops being sent (the 400 comes
*     back) — uninstall then. This is an external-plugin stopgap until the
*     provider adapter itself (pi-ai) sends the header.
*/
/** Plugin display metadata (cordis diagnostics). */
const name = "dsh-smoothly-opencode-session";
/**
* The `llm/stream` waterfall lives on the abstract `llm` service (dsh-llm).
* Injecting it keeps this plugin PENDING until that service exists, so the
* waterfall is already registered by its provider when we listen.
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
/** Resolve row config against code defaults (missing keys are never required). */
function resolveConfig(config = {}) {
	const providers = Array.isArray(config.providers) && config.providers.length > 0 ? config.providers.map((value) => String(value)) : [...DEFAULT_PROVIDERS];
	return {
		providers: new Set(providers),
		mode: config.mode === "uuid" ? "uuid" : "session-id",
		debug: config.debug === true,
		...typeof config.debugFile === "string" && config.debugFile.length > 0 ? { debugFile: config.debugFile } : {}
	};
}
/**
* Derive the opaque header value for one DSH session id.
* `session-id` mode returns the raw id (unique per conversation, stable across
* turns, compaction, retries and restarts); `uuid` mode returns a process-
* stable random uuid derived once per session id (opaque, resets on restart).
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
/**
* Build a patched fetch that injects the header while a store is active.
* Header precedence mirrors native fetch: when `init.headers` is present it
* wins; otherwise a Request's own headers are the base. A request that already
* carries the header is never modified (an existing value always wins).
*/
function patchFetch(original, als) {
	return function patchedFetch(input, init) {
		const state = als.getStore();
		if (state !== void 0 && !hasSessionHeader(input, init)) {
			const headers = new Headers(init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : void 0));
			headers.set(SESSION_HEADER, state.value);
			return original.call(this, input, {
				...init,
				headers
			});
		}
		return original.apply(this, arguments);
	};
}
/**
* Wrap a downstream async iterable so every pull executes inside an
* AsyncLocalStorage store. Async generators and the promises they create
* inherit the store as long as the generator body is driven from a pull made
* inside `als.run`, which is exactly what this wrapper does per `next()`.
*/
function withStore(iterable, store, als) {
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
				return await iterator.return(value);
			} catch {}
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
/** Fire-and-forget append of one debug record; failures only log a warning. */
function recordDebug(ctx, file, entry) {
	appendFile(file, `${JSON.stringify(entry)}\n`, "utf8").catch((error) => {
		ctx.logger.warn("[dsh-smoothly-opencode-session] debugFile write failed: %s", error?.message ?? String(error));
	});
}
function apply(ctx, config = {}) {
	const { providers, mode, debug, debugFile } = resolveConfig(config);
	const als = new AsyncLocalStorage();
	const uuidBySession = /* @__PURE__ */ new Map();
	const originalFetch = globalThis.fetch;
	if (typeof originalFetch !== "function") {
		ctx.logger.warn(`[${name}] globalThis.fetch is unavailable; cannot inject ${SESSION_HEADER}`);
		return;
	}
	const patched = patchFetch(originalFetch, als);
	ctx.effect(() => {
		globalThis.fetch = patched;
		ctx.logger.info("[%s] active for providers [%s] with mode %s", name, [...providers].join(", "), mode);
		return () => {
			if (globalThis.fetch === patched) globalThis.fetch = originalFetch;
		};
	}, `${name}.fetch-patch`);
	ctx.on("llm/stream", (options, next) => {
		if (options === void 0 || options === null || typeof options !== "object") return next();
		if (!providers.has(String(options.provider))) return next();
		const sessionId = options.sessionId;
		if (sessionId === void 0 || sessionId === null) return next();
		const value = headerValueFor(String(sessionId), mode, uuidBySession);
		if (value === void 0) return next();
		let downstream;
		try {
			downstream = next();
		} catch (error) {
			throw error;
		}
		if (downstream === void 0 || downstream === null) return downstream;
		if (typeof downstream[Symbol.asyncIterator] !== "function") return downstream;
		if (debug || debugFile !== void 0) {
			const entry = {
				ts: (/* @__PURE__ */ new Date()).toISOString(),
				provider: options.provider,
				model: options.model,
				session: String(sessionId),
				header: SESSION_HEADER,
				value
			};
			if (debugFile !== void 0) recordDebug(ctx, debugFile, entry);
			if (debug) ctx.logger.info("[%s] streaming provider \"%s\" with %s=%s", name, options.provider, SESSION_HEADER, value);
		}
		return withStore(downstream, { value }, als);
	}, { prepend: true });
}
var src_default = {
	name,
	inject,
	apply
};
//#endregion
export { apply, src_default as default, hasSessionHeader, headerValueFor, inject, name, patchFetch, resolveConfig, withStore };
