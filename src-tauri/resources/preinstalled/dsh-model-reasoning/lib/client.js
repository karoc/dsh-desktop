window.__ModuleLoader__.load({
	id: "dsh-model-reasoning",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/params.ts
		/**
		* Provider-parameter registry for the settings page (pure logic, no React).
		*
		* One place owns every route-level parameter this plugin manages: the value
		* domains, the effective defaults shown while a field is unset, the local
		* validators that MIRROR the host's own resolution rules (config.ts +
		* retry-policy.ts), and the diff engine that turns a draft into a minimal
		* `settings.mutate` op set. Adding a managed parameter means extending the
		* descriptors here plus copy in locales.ts — the section component stays.
		*
		* Two hard host facts shape this module:
		* - `assertServiceable` runs on every write, refusing an unserviceable profile
		*   with `settings-rejected`. The validators below mirror its rules so the
		*   common mistakes are caught before the RPC round-trip.
		* - The path-op engine addresses object KEYS only (no array indices), so
		*   scalar route fields diff to precise `set`/`unset` ops while composite
		*   values (`retryPolicy`, `thinkingBudgets`, `defaultInput`) and the `models`
		*   array are written whole.
		*/
		/** The pi-ai canonical thinking levels, in escalation order (adapter catalog gate). */
		const REASONING_LEVELS = [
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max"
		];
		/** Stable failure codes the adapter classifier emits; the preset checklist for `retryableCodes`. */
		const RETRYABLE_CODE_PRESETS = [
			"EMPTY_RESPONSE",
			"RATE_LIMIT",
			"SERVER",
			"TIMEOUT",
			"TRANSPORT"
		];
		/** Streaming transports a route may name (schema union order). */
		const TRANSPORTS = [
			"auto",
			"sse",
			"websocket",
			"websocket-cached"
		];
		/** Prompt-cache retention preferences. */
		const CACHE_RETENTIONS = [
			"none",
			"short",
			"long"
		];
		/** Every request modality a profile may declare (catalog modality gate). */
		const MODALITIES = ["text", "image"];
		/** Thinking-budget tiers (route-level dict consumed by budgeted reasoning providers). */
		const BUDGET_KEYS = [
			"minimal",
			"low",
			"medium",
			"high"
		];
		/** Effective defaults the adapter applies where configuration is silent. */
		const EFFECTIVE_DEFAULTS = {
			retryMaxRetries: 5,
			retryInitialDelayMs: 500,
			retryMaxDelayMs: 1e4,
			retryJitterRatio: .1,
			streamIdleTimeoutMs: 3e5,
			defaultContextWindow: 262144,
			defaultMaxTokens: 32768,
			maxRequestImageBytes: 20971520,
			requestImagePixelBudget: 4194304,
			requestImageMaxBytes: 1048576
		};
		const NUMBER_FIELDS = [
			{
				key: "timeoutMs",
				label: "timeoutMs",
				kind: "natural"
			},
			{
				key: "websocketConnectTimeoutMs",
				label: "websocketConnectTimeoutMs",
				kind: "natural"
			},
			{
				key: "streamIdleTimeoutMs",
				label: "streamIdleTimeoutMs",
				kind: "bounded-delay"
			},
			{
				key: "defaultContextWindow",
				label: "defaultContextWindow",
				kind: "positive-int"
			},
			{
				key: "defaultMaxTokens",
				label: "defaultMaxTokens",
				kind: "positive-int"
			},
			{
				key: "maxRequestImageBytes",
				label: "maxRequestImageBytes",
				kind: "positive-int"
			},
			{
				key: "requestImagePixelBudget",
				label: "requestImagePixelBudget",
				kind: "positive-int"
			},
			{
				key: "requestImageMaxBytes",
				label: "requestImageMaxBytes",
				kind: "positive-int"
			}
		];
		/** A fresh draft holding nothing (every field inherits). */
		function emptyParamsDraft() {
			return {
				reasoningDefault: "",
				retry: {
					mode: "normal",
					maxRetries: "",
					codes: [],
					initialDelayMs: "",
					maxDelayMs: "",
					jitterRatio: ""
				},
				numbers: {
					timeoutMs: "",
					websocketConnectTimeoutMs: "",
					streamIdleTimeoutMs: "",
					defaultContextWindow: "",
					defaultMaxTokens: "",
					maxRequestImageBytes: "",
					requestImagePixelBudget: "",
					requestImageMaxBytes: ""
				},
				transport: "",
				cacheRetention: "",
				inputPresent: false,
				inputMods: [],
				budgets: {
					minimal: "",
					low: "",
					medium: "",
					high: ""
				}
			};
		}
		/** Seed a draft from the stored route (absent fields stay ''). */
		function paramsDraftOf(route) {
			const draft = emptyParamsDraft();
			if (route === void 0) return draft;
			draft.reasoningDefault = typeof route.reasoning === "string" ? route.reasoning : "";
			const r = route.retryPolicy;
			if (typeof r === "object" && r !== null) {
				draft.retry.mode = r.mode === "always" ? "always" : "normal";
				draft.retry.maxRetries = numberText(r.maxRetries);
				const codes = r.retryableCodes;
				if (Array.isArray(codes)) draft.retry.codes = codes.filter((c) => typeof c === "string");
				if (typeof r.backoff === "object" && r.backoff !== null) {
					draft.retry.initialDelayMs = numberText(r.backoff.initialDelayMs);
					draft.retry.maxDelayMs = numberText(r.backoff.maxDelayMs);
					draft.retry.jitterRatio = numberText(r.backoff.jitterRatio);
				}
			}
			for (const field of NUMBER_FIELDS) draft.numbers[field.key] = numberText(route[field.key]);
			draft.transport = typeof route.transport === "string" ? route.transport : "";
			draft.cacheRetention = typeof route.cacheRetention === "string" ? route.cacheRetention : "";
			const input = route.defaultInput;
			if (Array.isArray(input)) {
				draft.inputPresent = true;
				draft.inputMods = input.filter((m) => typeof m === "string");
			}
			const budgets = route.thinkingBudgets;
			if (typeof budgets === "object" && budgets !== null) for (const key of BUDGET_KEYS) draft.budgets[key] = numberText(budgets[key]);
			return draft;
		}
		function numberText(value) {
			return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
		}
		/** Parse a draft string into a finite number; '' (or garbage) yields undefined. */
		function parseNumber(text) {
			const trimmed = text.trim();
			if (trimmed.length === 0) return void 0;
			const value = Number(trimmed);
			return Number.isFinite(value) ? value : void 0;
		}
		function issue(field, kind) {
			return {
				field,
				kind
			};
		}
		/** Validate one plain-number field against its host-side bounds. */
		function validateNumberField(key, text) {
			const kind = NUMBER_FIELDS.find((f) => f.key === key)?.kind;
			const field = NUMBER_FIELDS.find((f) => f.key === key)?.label ?? key;
			const value = parseNumber(text);
			if (text.trim() === "") return void 0;
			if (value === void 0) return issue(field, "errNumber");
			switch (kind) {
				case "natural":
					if (!Number.isInteger(value) || value < 0) return issue(field, "errNatural");
					return;
				case "bounded-delay":
					if (!(value > 0) || value > 2147483647) return issue(field, "errDelayBound");
					return;
				case "positive-int":
					if (!Number.isSafeInteger(value) || value < 1) return issue(field, "errPositiveInt");
					return;
				default: return;
			}
		}
		/** Validate the retry draft exactly where the host's `resolveRetryPolicy` would throw. */
		function validateRetryDraft(draft) {
			const issues = [];
			if (draft.mode === "normal") {
				if (draft.maxRetries.trim() !== "") {
					const retries = parseNumber(draft.maxRetries);
					if (retries === void 0 || !Number.isSafeInteger(retries) || retries < 0) issues.push(issue("maxRetries", "errNatural"));
				}
			}
			const initial = draft.initialDelayMs.trim() === "" ? void 0 : parseNumber(draft.initialDelayMs);
			const max = draft.maxDelayMs.trim() === "" ? void 0 : parseNumber(draft.maxDelayMs);
			if (draft.initialDelayMs.trim() !== "" && (initial === void 0 || !(initial > 0) || initial > 2147483647)) issues.push(issue("initialDelayMs", "errDelayBound"));
			if (draft.maxDelayMs.trim() !== "" && (max === void 0 || !(max > 0) || max > 2147483647)) issues.push(issue("maxDelayMs", "errDelayBound"));
			if (initial !== void 0 && max !== void 0 && initial > max) issues.push(issue("initialDelayMs", "errInitialAboveMax"));
			if (draft.jitterRatio.trim() !== "") {
				const ratio = parseNumber(draft.jitterRatio);
				if (ratio === void 0 || ratio < 0 || ratio > 1) issues.push(issue("jitterRatio", "errRatio"));
			}
			return issues;
		}
		/** Validate every managed field of the draft; [] means locally serviceable. */
		function validateParamsDraft(draft) {
			const issues = [];
			for (const field of NUMBER_FIELDS) {
				const found = validateNumberField(field.key, draft.numbers[field.key]);
				if (found !== void 0) issues.push(found);
			}
			issues.push(...validateRetryDraft(draft.retry));
			if (draft.inputPresent && draft.inputMods.length === 0) issues.push(issue("defaultInput", "errInputEmpty"));
			for (const key of BUDGET_KEYS) if (draft.budgets[key].trim() !== "" && parseNumber(draft.budgets[key]) === void 0) issues.push(issue(`budget_${key}`, "errNumber"));
			return issues;
		}
		/** Canonical JSON: object keys sorted, so stored-vs-built comparisons are key-order independent. */
		function stable(value) {
			if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
			if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`;
			const entries = Object.entries(value).filter(([, v]) => v !== void 0);
			entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
			return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
		}
		/**
		* The `retryPolicy` dict a draft produces, or `undefined` when it collapses to
		* the adapter's implicit defaults (normal mode with nothing explicit — writing
		* that object would be noise, and unsetting restores the same behavior).
		* Normal-only fields are dropped in `always` mode, mirroring how the host
		* ignores them there.
		*/
		function retryWireOf(draft) {
			const backoff = {};
			const initial = parseNumber(draft.initialDelayMs);
			const max = parseNumber(draft.maxDelayMs);
			const ratio = parseNumber(draft.jitterRatio);
			if (draft.initialDelayMs.trim() !== "" && initial !== void 0) backoff.initialDelayMs = initial;
			if (draft.maxDelayMs.trim() !== "" && max !== void 0) backoff.maxDelayMs = max;
			if (draft.jitterRatio.trim() !== "" && ratio !== void 0) backoff.jitterRatio = ratio;
			const hasBackoff = Object.keys(backoff).length > 0;
			if (draft.mode === "always") return hasBackoff ? {
				mode: "always",
				backoff
			} : { mode: "always" };
			const maxRetries = parseNumber(draft.maxRetries);
			const hasRetries = draft.maxRetries.trim() !== "" && maxRetries !== void 0;
			const hasCodes = draft.codes.length > 0;
			if (!hasRetries && !hasCodes && !hasBackoff) return void 0;
			const wire = { mode: "normal" };
			if (hasRetries) wire.maxRetries = maxRetries;
			if (hasCodes) wire.retryableCodes = [...draft.codes];
			if (hasBackoff) wire.backoff = backoff;
			return wire;
		}
		function budgetsWireOf(draft) {
			const wire = {};
			for (const key of BUDGET_KEYS) {
				const value = parseNumber(draft[key]);
				if (draft[key].trim() !== "" && value !== void 0) wire[key] = value;
			}
			return Object.keys(wire).length > 0 ? wire : void 0;
		}
		/**
		* Diff the draft against the stored route into a minimal op set covering EVERY
		* managed route-level parameter. Unset wins over set when the draft clears a
		* present key; identical composites produce no op (key-order independent).
		*/
		function buildRouteOps(current, draft) {
			const ops = [];
			const cur = current ?? {};
			const pushScalar = (key, wire, stored) => {
				if (wire === void 0) {
					if (stored !== void 0) ops.push({
						op: "unset",
						path: [key]
					});
					return;
				}
				if (stable(stored) !== stable(wire)) ops.push({
					op: "set",
					path: [key],
					value: wire
				});
			};
			pushScalar("reasoning", draft.reasoningDefault === "" ? void 0 : draft.reasoningDefault, cur.reasoning);
			for (const field of NUMBER_FIELDS) {
				const text = draft.numbers[field.key];
				pushScalar(field.key, text.trim() === "" ? void 0 : parseNumber(text), cur[field.key]);
			}
			pushScalar("transport", draft.transport === "" ? void 0 : draft.transport, cur.transport);
			pushScalar("cacheRetention", draft.cacheRetention === "" ? void 0 : draft.cacheRetention, cur.cacheRetention);
			pushScalar("defaultInput", draft.inputPresent && draft.inputMods.length > 0 ? [...draft.inputMods] : void 0, cur.defaultInput);
			pushScalar("thinkingBudgets", budgetsWireOf(draft.budgets), cur.thinkingBudgets);
			pushScalar("retryPolicy", retryWireOf(draft.retry), cur.retryPolicy);
			return ops;
		}
		/** Seed the per-model draft from a stored models[] entry. */
		function modelParamsOf(entry) {
			const draft = {
				inputPresent: false,
				inputMods: [],
				contextWindow: "",
				maxTokens: ""
			};
			if (entry === void 0) return draft;
			if (Array.isArray(entry.input)) {
				draft.inputPresent = true;
				draft.inputMods = entry.input.filter((m) => typeof m === "string");
			}
			draft.contextWindow = numberText(entry.contextWindow);
			draft.maxTokens = numberText(entry.maxTokens);
			return draft;
		}
		/** Validate the per-model draft where the host would refuse the entry. */
		function validateModelParams(draft) {
			const issues = [];
			const cap = (field, text) => {
				if (text.trim() === "") return void 0;
				const value = parseNumber(text);
				if (value === void 0) return issue(field, "errNumber");
				if (!Number.isSafeInteger(value) || value < 1) return issue(field, "errPositiveInt");
			};
			const cw = cap("contextWindow", draft.contextWindow);
			if (cw !== void 0) issues.push(cw);
			const mt = cap("maxTokens", draft.maxTokens);
			if (mt !== void 0) issues.push(mt);
			return issues;
		}
		/**
		* Merge the per-model draft into a COPY of the stored entry: set/unset each
		* editable field per the tri-state rules (an emptied modality list clears the
		* key — the host refuses an empty list — while blank numbers clear theirs).
		* `id` and `name` pass through untouched; reasoningEfforts is handled by the
		* caller, which owns that editor's state.
		*/
		function buildModelEntry(base, draft) {
			const next = { ...base };
			if (draft.inputPresent && draft.inputMods.length > 0) next.input = MODALITIES.filter((m) => draft.inputMods.includes(m));
			else delete next.input;
			const cw = parseNumber(draft.contextWindow);
			if (draft.contextWindow.trim() !== "" && cw !== void 0) next.contextWindow = cw;
			else delete next.contextWindow;
			const mt = parseNumber(draft.maxTokens);
			if (draft.maxTokens.trim() !== "" && mt !== void 0) next.maxTokens = mt;
			else delete next.maxTokens;
			return next;
		}
		/** Parse a stored `reasoningEfforts` value into an {@link EffortState}, capturing
		* each declared level's wire spelling and whether `off` sends nothing. */
		function effortStateOf(value) {
			if (value === false) return { kind: "off" };
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				const dict = value;
				const levels = /* @__PURE__ */ new Set();
				const wire = {};
				let offEmpty = true;
				for (const level of REASONING_LEVELS) {
					if (!(level in dict)) continue;
					levels.add(level);
					const spelled = dict[level];
					if (level === "off") {
						offEmpty = spelled === null || spelled === void 0;
						if (!offEmpty && typeof spelled === "string") wire[level] = spelled;
					} else if (typeof spelled === "string") wire[level] = spelled;
				}
				return {
					kind: "on",
					levels,
					wire,
					offEmpty
				};
			}
			return { kind: "inherit" };
		}
		/** The wire dict a draft produces, or `false` for an explicitly non-reasoning model.
		* Each level sends its custom wire spelling (defaulting to the level name);
		* `off` sends nothing when {@link offEmpty} is true, else its custom value. */
		function wireOf(levels, wire, offEmpty) {
			const out = {};
			for (const level of levels) out[level] = level === "off" ? offEmpty ? null : wire[level] ?? "off" : wire[level] ?? level;
			return out;
		}
		//#endregion
		//#region src/client/ProviderParamsSection.tsx
		/**
		* The "Provider parameters" settings section (external plugin).
		*
		* A companion page to the built-in Models page: it manages the parameters that
		* page deliberately does not expose — per-route retry/backoff policy, timeouts,
		* transport, caching, thinking budgets, capacities, image-payload budgets, and
		* the per-model reasoning-effort declaration. Everything is written into the
		* exact `llm-pi-ai.providers.<route>.*` fields the adapter reads, through the
		* official `settings.mutate` RPC with revision fencing.
		*
		* Route-level fields are enumerated for EVERY provider profile (the installed
		* catalog is not reachable from the client, so a route's catalog MODELS remain
		* read-only here, while its route-level parameters are fully editable).
		*
		* The managed-field registry, validators, and op-diff engine live in
		* {@link ./params.ts}; this file is the shell (route picker, parameter-group
		* tabs, save engine) plus one panel per parameter group.
		*/
		/** Parameter groups, in panel order; ids index the tab strip. The first tab
		* hosts every PER-MODEL editable dimension (input / caps / reasoning); the
		* rest are route-wide because the schema defines those fields once per route. */
		const GROUPS = [
			{
				id: "permodel",
				label: "groupPerModel"
			},
			{
				id: "retry",
				label: "groupRetry"
			},
			{
				id: "timeouts",
				label: "groupTimeouts"
			},
			{
				id: "cache",
				label: "groupCache"
			},
			{
				id: "capacity",
				label: "groupCapacity"
			}
		];
		/** Scope statement per group: retry/backoff, timeouts, transport, caching,
		* budgets, and capacities exist ONLY at route level in the llm-pi-ai schema
		* (one value shared by every model); the per-model tab writes into the
		* selected model's own declaration. */
		const SCOPE = {
			permodel: {
				chip: "scopePerModel",
				tip: "scopePerModelTip"
			},
			retry: {
				chip: "scopeRoute",
				tip: "scopeRouteTip"
			},
			timeouts: {
				chip: "scopeRoute",
				tip: "scopeRouteTip"
			},
			cache: {
				chip: "scopeRoute",
				tip: "scopeRouteTip"
			},
			capacity: {
				chip: "scopeRoute",
				tip: "scopeRouteTip"
			}
		};
		/** The aspect checkboxes, in display order. */
		const ASPECTS = [
			{
				id: "input",
				label: "applyAspectInput"
			},
			{
				id: "capacity",
				label: "applyAspectCapacity"
			},
			{
				id: "reasoning",
				label: "applyAspectReasoning"
			}
		];
		/**
		* One-control searchable select: the trigger pill opens a panel whose FIRST
		* element is the filter input — searching never leaves the control. Built on
		* raw elements because ui-primitives' Menu has no content slot for an input,
		* and an <input> inside its row <button> would swallow clicks/focus.
		*/
		function SearchSelect(props) {
			const [open, setOpen] = (0, react.useState)(false);
			const [query, setQuery] = (0, react.useState)("");
			const rootRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (!open) return;
				const onDown = (e) => {
					if (!(e.target instanceof Node)) return;
					if (rootRef.current?.contains(e.target) === true) return;
					setOpen(false);
				};
				const onKey = (e) => {
					if (e.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onDown);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("pointerdown", onDown);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);
			const matched = props.options.find((o) => o.id === props.value);
			const needle = query.trim().toLowerCase();
			const shown = needle === "" ? props.options : props.options.filter((o) => o.label.toLowerCase().includes(needle));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mr-sselect",
				ref: rootRef,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "mr-selector",
					disabled: props.disabled,
					"aria-haspopup": "listbox",
					"aria-expanded": open,
					onClick: () => {
						setOpen((v) => !v);
						setQuery("");
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: matched === void 0 ? "mr-selector-label mr-selector-placeholder" : "mr-selector-label",
						children: matched === void 0 ? props.placeholder : matched.label
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { className: "mr-chevron" })]
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "mr-sselect-panel",
					role: "listbox",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
						autoFocus: true,
						className: "mr-search",
						value: query,
						placeholder: props.searchPlaceholder,
						onChange: (e) => {
							setQuery(e.target.value);
						}
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "mr-sselect-list",
						children: shown.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "mr-hint",
							children: props.emptyText
						}) : shown.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							role: "option",
							"aria-selected": option.id === props.value,
							className: `mr-sselect-item${option.id === props.value ? " mr-sselect-item-active" : ""}`,
							onClick: () => {
								props.onChange(option.id);
								setOpen(false);
							},
							children: option.label
						}, option.id))
					})]
				})]
			});
		}
		/** A General-settings-style dropdown: a selector pill opening a Menu, not a native <select>. */
		function Selector(props) {
			const { value, options, onChange, placeholder, disabled } = props;
			const [open, setOpen] = (0, react.useState)(false);
			const matched = options.find((o) => o.id === value);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
				open,
				onClose: () => {
					setOpen(false);
				},
				items: options.map((o) => ({
					id: o.id,
					label: o.label
				})),
				selectedId: matched === void 0 ? void 0 : value,
				onSelect: (id) => {
					onChange(id);
					setOpen(false);
				},
				align: "start",
				anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "mr-selector",
					disabled,
					"aria-haspopup": "menu",
					"aria-expanded": open,
					onClick: () => {
						setOpen((v) => !v);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: matched === void 0 ? "mr-selector-label mr-selector-placeholder" : "mr-selector-label",
						children: matched === void 0 ? placeholder : matched.label
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { className: "mr-chevron" })]
				})
			});
		}
		/** One labeled numeric field; '' renders the effective-default placeholder. */
		function NumberField(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: props.tip,
				side: "top",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
					className: "mr-numfield",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "mr-wire-label",
						children: props.label
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
						className: "mr-wire-input",
						value: props.value,
						placeholder: props.value.trim() === "" ? props.placeholder : void 0,
						disabled: props.disabled,
						onChange: (e) => {
							props.onChange(e.target.value);
						}
					})]
				})
			});
		}
		/** Default-placeholder text for a numeric field backed by an adapter default. */
		function defaultText(t, value) {
			return `${t("effectiveDefault")} ${value}`;
		}
		/**
		* Render the Provider parameters settings page (guarded shell: hooks live in
		* the loaded child, which is only mounted once the slot has injected).
		*/
		function ProviderParamsSection(props) {
			const { api, t, useModelReasoning } = props;
			if (api === void 0 || t === void 0 || useModelReasoning === void 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProviderParamsLoaded, {
				api,
				t,
				useModelReasoning
			});
		}
		/** The mounted editor (all hooks run unconditionally here). */
		function ProviderParamsLoaded(props) {
			const { api, t, useModelReasoning } = props;
			const raw = useModelReasoning((snapshot) => snapshot);
			const value = raw?.value;
			const routes = (0, react.useMemo)(() => Object.entries(value?.providers ?? {}), [value]);
			const [routeKey, setRouteKey] = (0, react.useState)(void 0);
			const [modelIndex, setModelIndex] = (0, react.useState)(void 0);
			const [mode, setMode] = (0, react.useState)("inherit");
			const [levels, setLevels] = (0, react.useState)(/* @__PURE__ */ new Set(["high"]));
			const [wire, setWire] = (0, react.useState)({});
			const [offEmpty, setOffEmpty] = (0, react.useState)(true);
			const [busy, setBusy] = (0, react.useState)(false);
			const [failure, setFailure] = (0, react.useState)(void 0);
			const [saved, setSaved] = (0, react.useState)(false);
			const [draft, setDraft] = (0, react.useState)(() => paramsDraftOf(void 0));
			const [modelDraft, setModelDraft] = (0, react.useState)(() => modelParamsOf(void 0));
			const [applyAspects, setApplyAspects] = (0, react.useState)({
				input: false,
				capacity: false,
				reasoning: true
			});
			const [activeGroup, setActiveGroup] = (0, react.useState)("permodel");
			const [codeInput, setCodeInput] = (0, react.useState)("");
			const activeRoute = routeKey === void 0 ? void 0 : routes.find(([k]) => k === routeKey);
			const activeRouteKey = activeRoute?.[0];
			const models = activeRoute?.[1]?.models ?? [];
			const activeModel = modelIndex === void 0 ? void 0 : models[modelIndex];
			const pickRoute = (key) => {
				setRouteKey(key);
				setModelIndex(void 0);
				setCodeInput("");
				setSaved(false);
				setFailure(void 0);
				setDraft(paramsDraftOf(routes.find(([k]) => k === key)?.[1]));
			};
			const pickModel = (index) => {
				setModelIndex(index);
				setSaved(false);
				setFailure(void 0);
				const model = models[index];
				const state = effortStateOf(model?.reasoningEfforts);
				setMode(state.kind);
				setModelDraft(modelParamsOf(model));
				if (state.kind === "on") {
					setLevels(state.levels);
					setWire(state.wire ?? {});
					setOffEmpty(state.offEmpty ?? true);
				}
			};
			const toggleLevel = (level) => {
				setSaved(false);
				setLevels((current) => {
					const next = new Set(current);
					if (!next.delete(level)) next.add(level);
					return next;
				});
				setWire((current) => level in current ? current : {
					...current,
					[level]: level
				});
			};
			const patch = (mutate) => {
				setSaved(false);
				setDraft((current) => mutate(current));
			};
			/** Tri-state per-model modality toggle: an emptied explicit list clears the
			* key (the host refuses an empty list), back to "inherit". */
			const toggleModelModality = (modality) => {
				setSaved(false);
				setModelDraft((current) => {
					const nextMods = current.inputMods.includes(modality) ? current.inputMods.filter((m) => m !== modality) : [...current.inputMods, modality];
					return {
						...current,
						inputPresent: nextMods.length > 0,
						inputMods: nextMods.length > 0 ? MODALITIES.filter((m) => nextMods.includes(m)) : []
					};
				});
			};
			const onHasLevel = levels.size > 0 && (levels.size > 1 || !levels.has("off"));
			const nextDict = mode === "on" ? wireOf(levels, wire, offEmpty) : mode === "off" ? false : void 0;
			const effortDirty = activeModel !== void 0 && stable(activeModel.reasoningEfforts) !== stable(nextDict);
			const routeOps = (0, react.useMemo)(() => buildRouteOps(activeRoute?.[1], draft), [activeRoute, draft]);
			const mergedModel = (0, react.useMemo)(() => {
				if (activeModel === void 0 || modelIndex === void 0) return null;
				let entry = buildModelEntry(activeModel, modelDraft);
				if (effortDirty) {
					if (nextDict === void 0) {
						const { reasoningEfforts: _dropped, ...rest } = entry;
						entry = rest;
					} else entry = {
						...entry,
						reasoningEfforts: nextDict
					};
				}
				return stable(entry) === stable(activeModel) ? null : entry;
			}, [
				activeModel,
				modelIndex,
				modelDraft,
				effortDirty,
				nextDict
			]);
			const modelOps = (0, react.useMemo)(() => {
				if (mergedModel === null || modelIndex === void 0) return [];
				const newModels = models.map((model, i) => i === modelIndex ? { ...mergedModel } : { ...model });
				return [{
					op: "set",
					path: [
						"providers",
						activeRouteKey ?? "",
						"models"
					],
					value: newModels
				}];
			}, [
				mergedModel,
				modelIndex,
				models,
				activeRouteKey
			]);
			const issues = (0, react.useMemo)(() => [...validateParamsDraft(draft), ...validateModelParams(modelDraft)], [draft, modelDraft]);
			const canSave = !busy && issues.length === 0 && (routeOps.length > 0 || modelOps.length > 0);
			const scopeLoading = raw?.status === "loading";
			const scopeUnavailable = raw?.status === "unavailable";
			const showEmpty = raw?.status === "ready" && routes.length === 0;
			const reseedFrom = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (reseedFrom.current === null || raw === void 0) return;
				if (`${raw.revision}` === reseedFrom.current) return;
				reseedFrom.current = null;
				setDraft(paramsDraftOf(routeKey === void 0 ? void 0 : routes.find(([k]) => k === routeKey)?.[1]));
			}, [
				raw,
				routes,
				routeKey
			]);
			const send = async (ops) => {
				if (api === void 0 || activeRouteKey === void 0 || ops.length === 0) return;
				setBusy(true);
				setFailure(void 0);
				const response = await api.settings.mutate({
					ns: "llm-pi-ai",
					ops,
					...raw?.revision === void 0 ? {} : { expectedRevision: raw.revision }
				});
				setBusy(false);
				if (!response.result.ok) {
					setFailure(response.result.error.code === "settings-conflict" ? t("conflict") : response.result.error.message);
					return;
				}
				reseedFrom.current = `${raw?.revision}`;
				setSaved(true);
			};
			const save = () => send([...routeOps, ...modelOps].map((op) => ({ ...op })));
			/** Whether the "apply to all models" action is available: a selected model
			* whose editor state is valid, and at least one dimension checked. */
			const canApplyAll = !busy && activeRouteKey !== void 0 && modelIndex !== void 0 && models.length > 0 && (mode !== "on" || onHasLevel) && (applyAspects.input || applyAspects.capacity || applyAspects.reasoning);
			/**
			* Copy the CHECKED dimensions of the current model's editor into every model
			* on the route (the whole `models` array is the write unit). Unchecked
			* dimensions keep each model's own declaration.
			*/
			const applyToAll = async () => {
				if (api === void 0 || activeRouteKey === void 0) return;
				setBusy(true);
				setFailure(void 0);
				const nextAll = mode === "on" ? wireOf(levels, wire, offEmpty) : mode === "off" ? false : void 0;
				const newModels = models.map((model) => {
					let entry = { ...model };
					if (applyAspects.input) {
						if (modelDraft.inputPresent && modelDraft.inputMods.length > 0) entry.input = MODALITIES.filter((m) => modelDraft.inputMods.includes(m));
						else delete entry.input;
					}
					if (applyAspects.capacity) {
						const cw = parseNumber(modelDraft.contextWindow);
						if (modelDraft.contextWindow.trim() !== "" && cw !== void 0) entry.contextWindow = cw;
						else delete entry.contextWindow;
						const mt = parseNumber(modelDraft.maxTokens);
						if (modelDraft.maxTokens.trim() !== "" && mt !== void 0) entry.maxTokens = mt;
						else delete entry.maxTokens;
					}
					if (applyAspects.reasoning) {
						if (nextAll === void 0) delete entry.reasoningEfforts;
						else entry.reasoningEfforts = nextAll;
					}
					return entry;
				});
				if (stable(models) === stable(newModels)) {
					setBusy(false);
					return;
				}
				await send([{
					op: "set",
					path: [
						"providers",
						activeRouteKey,
						"models"
					],
					value: newModels
				}]);
			};
			const writable = raw?.writable !== false;
			const issueLine = (found) => `${t(found.field)} ${t(found.kind)}`;
			const renderPerModel = () => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "mr-field",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: "mr-label",
						children: t("routeDefault")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Selector, {
						value: draft.reasoningDefault,
						placeholder: t("routeDefaultUnset"),
						disabled: !writable,
						options: REASONING_LEVELS.map((level) => ({
							id: level,
							label: level
						})),
						onChange: (id) => {
							patch((current) => ({
								...current,
								reasoningDefault: id
							}));
						}
					})]
				}),
				activeRouteKey === void 0 ? null : models.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "mr-empty mr-model-empty",
					role: "status",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "mr-empty-title",
						children: t("emptyModelsTitle")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "mr-empty-body",
						children: t("emptyModelsBody")
					})]
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "mr-field",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: "mr-label",
						children: t("modelLabel")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SearchSelect, {
						value: modelIndex === void 0 ? "" : String(modelIndex),
						options: models.map((model, index) => ({
							id: String(index),
							label: model.name ?? model.id ?? String(index)
						})),
						onChange: (id) => {
							pickModel(Number(id));
						},
						placeholder: t("modelUnset"),
						searchPlaceholder: t("modelSearchPlaceholder"),
						emptyText: t("modelSearchEmpty"),
						disabled: !writable
					})]
				}),
				activeModel === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
					className: "mr-panel",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", {
							className: "mr-panel-title",
							children: activeModel.name ?? activeModel.id ?? `#${modelIndex}`
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "mr-field",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
									label: t("modelInputTip"),
									side: "top",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "mr-label",
										children: t("modelInputLabel")
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "mr-mode-row",
									children: MODALITIES.map((modality) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "mr-radio-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: modelDraft.inputMods.includes(modality),
											disabled: !writable,
											onChange: () => {
												toggleModelModality(modality);
											}
										}), t(`modality_${modality}`)]
									}, modality))
								}),
								!modelDraft.inputPresent ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "mr-wire-title",
									children: t("inheritHint")
								}) : null
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "mr-field",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "mr-wire-title",
								children: t("modelCapacityTitle")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "mr-grid",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberField, {
									label: t("contextWindow"),
									tip: t("contextWindowTip"),
									value: modelDraft.contextWindow,
									placeholder: t("inheritHint"),
									disabled: !writable,
									onChange: (next) => {
										setSaved(false);
										setModelDraft((c) => ({
											...c,
											contextWindow: next
										}));
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberField, {
									label: t("maxTokens"),
									tip: t("maxTokensTip"),
									value: modelDraft.maxTokens,
									placeholder: t("inheritHint"),
									disabled: !writable,
									onChange: (next) => {
										setSaved(false);
										setModelDraft((c) => ({
											...c,
											maxTokens: next
										}));
									}
								})]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "mr-wire-title",
							children: t("modelEfforts")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "mr-mode-row",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
									label: t("modeInheritTip"),
									side: "bottom",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "mr-radio-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "radio",
											name: "effort-mode",
											checked: mode === "inherit",
											disabled: !writable,
											onChange: () => {
												setMode("inherit");
												setSaved(false);
											}
										}), t("modeInheritLabel")]
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
									label: t("modeOffTip"),
									side: "bottom",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "mr-radio-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "radio",
											name: "effort-mode",
											checked: mode === "off",
											disabled: !writable,
											onChange: () => {
												setMode("off");
												setSaved(false);
											}
										}), t("modeOffLabel")]
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
									label: t("modeOnTip"),
									side: "bottom",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "mr-radio-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "radio",
											name: "effort-mode",
											checked: mode === "on",
											disabled: !writable,
											onChange: () => {
												setMode("on");
												setSaved(false);
											}
										}), t("modeOnLabel")]
									})
								})
							]
						}),
						mode === "on" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "mr-levels",
							children: REASONING_LEVELS.map((level) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
								active: levels.has(level),
								disabled: !writable,
								onClick: () => {
									toggleLevel(level);
								},
								children: level
							}, level))
						}), levels.size > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "mr-wire",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "mr-wire-title",
								children: t("wireTitle")
							}), REASONING_LEVELS.filter((level) => levels.has(level)).map((level) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "mr-wire-row",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "mr-wire-label",
									children: level
								}), level === "off" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: "mr-wire-off",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: offEmpty,
										disabled: !writable,
										onChange: () => {
											setOffEmpty((v) => !v);
											setSaved(false);
										}
									}), t("offEmpty")]
								}), offEmpty ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
									className: "mr-wire-input",
									value: wire[level] ?? "off",
									disabled: !writable,
									onChange: (e) => {
										setWire({
											...wire,
											[level]: e.target.value
										});
										setSaved(false);
									}
								})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
									className: "mr-wire-input",
									value: wire[level] ?? level,
									disabled: !writable,
									onChange: (e) => {
										setWire({
											...wire,
											[level]: e.target.value
										});
										setSaved(false);
									}
								})]
							}, level))]
						}) : null] }) : null,
						mode === "on" && !onHasLevel ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "mr-error",
							children: t("needLevel")
						}) : null
					]
				})
			] });
			const renderRetry = () => {
				const retry = draft.retry;
				const normalDisabled = !writable || retry.mode === "always";
				const customCodes = retry.codes.filter((code) => !RETRYABLE_CODE_PRESETS.includes(code));
				const toggleCode = (code) => {
					patch((current) => ({
						...current,
						retry: {
							...current.retry,
							codes: current.retry.codes.includes(code) ? current.retry.codes.filter((c) => c !== code) : [...current.retry.codes, code]
						}
					}));
				};
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "mr-field",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: "mr-label",
							children: t("retryModeLabel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "mr-mode-row",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
								label: t("retryModeNormalTip"),
								side: "bottom",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: "mr-radio-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "radio",
										name: "retry-mode",
										checked: retry.mode === "normal",
										disabled: !writable,
										onChange: () => {
											patch((current) => ({
												...current,
												retry: {
													...current.retry,
													mode: "normal"
												}
											}));
										}
									}), t("retryModeNormal")]
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
								label: t("retryModeAlwaysTip"),
								side: "bottom",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: "mr-radio-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "radio",
										name: "retry-mode",
										checked: retry.mode === "always",
										disabled: !writable,
										onChange: () => {
											patch((current) => ({
												...current,
												retry: {
													...current.retry,
													mode: "always"
												}
											}));
										}
									}), t("retryModeAlways")]
								})
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "mr-grid",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberField, {
							label: t("maxRetries"),
							tip: `${t("maxRetriesTip")} · ${defaultText(t, EFFECTIVE_DEFAULTS.retryMaxRetries)}`,
							value: retry.maxRetries,
							placeholder: retry.maxRetries === "" ? defaultText(t, EFFECTIVE_DEFAULTS.retryMaxRetries) : "",
							disabled: normalDisabled,
							onChange: (next) => patch((current) => ({
								...current,
								retry: {
									...current.retry,
									maxRetries: next
								}
							}))
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: `mr-field${retry.mode === "always" ? " mr-dimmed" : ""}`,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								className: "mr-label",
								children: t("retryableCodes")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "mr-levels",
								children: [RETRYABLE_CODE_PRESETS.map((code) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
									active: retry.codes.includes(code),
									disabled: normalDisabled,
									onClick: () => {
										toggleCode(code);
									},
									children: code
								}, code)), customCodes.map((code) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
									active: true,
									disabled: normalDisabled,
									onClick: () => {
										toggleCode(code);
									},
									children: code
								}, code))]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "mr-inline",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
									className: "mr-wire-input",
									value: codeInput,
									placeholder: t("codePlaceholder"),
									disabled: normalDisabled,
									onChange: (e) => {
										setCodeInput(e.target.value);
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									size: "sm",
									disabled: normalDisabled || codeInput.trim().length === 0 || retry.codes.includes(codeInput.trim()),
									onClick: () => {
										toggleCode(codeInput.trim());
										setCodeInput("");
									},
									children: t("addCode")
								})]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
						className: "mr-panel",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", {
							className: "mr-panel-title",
							children: t("backoffTitle")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "mr-grid",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberField, {
									label: t("initialDelayMs"),
									tip: `${t("initialDelayMsTip")} · ${defaultText(t, EFFECTIVE_DEFAULTS.retryInitialDelayMs)}`,
									value: retry.initialDelayMs,
									placeholder: defaultText(t, EFFECTIVE_DEFAULTS.retryInitialDelayMs),
									disabled: !writable,
									onChange: (next) => patch((current) => ({
										...current,
										retry: {
											...current.retry,
											initialDelayMs: next
										}
									}))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberField, {
									label: t("maxDelayMs"),
									tip: `${t("maxDelayMsTip")} · ${defaultText(t, EFFECTIVE_DEFAULTS.retryMaxDelayMs)}`,
									value: retry.maxDelayMs,
									placeholder: defaultText(t, EFFECTIVE_DEFAULTS.retryMaxDelayMs),
									disabled: !writable,
									onChange: (next) => patch((current) => ({
										...current,
										retry: {
											...current.retry,
											maxDelayMs: next
										}
									}))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberField, {
									label: t("jitterRatio"),
									tip: `${t("jitterRatioTip")} · ${defaultText(t, EFFECTIVE_DEFAULTS.retryJitterRatio)}`,
									value: retry.jitterRatio,
									placeholder: defaultText(t, EFFECTIVE_DEFAULTS.retryJitterRatio),
									disabled: !writable,
									onChange: (next) => patch((current) => ({
										...current,
										retry: {
											...current.retry,
											jitterRatio: next
										}
									}))
								})
							]
						})]
					})
				] });
			};
			const renderTimeouts = () => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mr-grid",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberField, {
						label: t("timeoutMs"),
						tip: t("timeoutMsTip"),
						value: draft.numbers.timeoutMs,
						placeholder: "",
						disabled: !writable,
						onChange: (next) => patch((current) => ({
							...current,
							numbers: {
								...current.numbers,
								timeoutMs: next
							}
						}))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberField, {
						label: t("websocketConnectTimeoutMs"),
						tip: t("websocketConnectTimeoutMsTip"),
						value: draft.numbers.websocketConnectTimeoutMs,
						placeholder: "",
						disabled: !writable,
						onChange: (next) => patch((current) => ({
							...current,
							numbers: {
								...current.numbers,
								websocketConnectTimeoutMs: next
							}
						}))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberField, {
						label: t("streamIdleTimeoutMs"),
						tip: `${t("streamIdleTimeoutMsTip")} · ${defaultText(t, EFFECTIVE_DEFAULTS.streamIdleTimeoutMs)}`,
						value: draft.numbers.streamIdleTimeoutMs,
						placeholder: defaultText(t, EFFECTIVE_DEFAULTS.streamIdleTimeoutMs),
						disabled: !writable,
						onChange: (next) => patch((current) => ({
							...current,
							numbers: {
								...current.numbers,
								streamIdleTimeoutMs: next
							}
						}))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "mr-field",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: "mr-label",
							children: t("transport")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Selector, {
							value: draft.transport,
							placeholder: t("inheritHint"),
							disabled: !writable,
							options: TRANSPORTS.map((v) => ({
								id: v,
								label: v
							})),
							onChange: (id) => {
								patch((current) => ({
									...current,
									transport: id
								}));
							}
						})]
					})
				]
			});
			const renderCache = () => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "mr-field",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: "mr-label",
						children: t("cacheRetention")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Selector, {
						value: draft.cacheRetention,
						placeholder: t("inheritHint"),
						disabled: !writable,
						options: CACHE_RETENTIONS.map((v) => ({
							id: v,
							label: v
						})),
						onChange: (id) => {
							patch((current) => ({
								...current,
								cacheRetention: id
							}));
						}
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "mr-wire-title",
					children: t("budgetsTitle")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "mr-grid",
					children: BUDGET_KEYS.map((key) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberField, {
						label: t(`budget_${key}`),
						tip: t("budgetsTitle"),
						value: draft.budgets[key],
						placeholder: "",
						disabled: !writable,
						onChange: (next) => patch((current) => ({
							...current,
							budgets: {
								...current.budgets,
								[key]: next
							}
						}))
					}, key))
				})
			] });
			const renderCapacity = () => {
				const toggleModality = (modality) => {
					patch((current) => {
						const nextMods = current.inputMods.includes(modality) ? current.inputMods.filter((m) => m !== modality) : [...current.inputMods, modality];
						return {
							...current,
							inputPresent: nextMods.length > 0,
							inputMods: nextMods.length > 0 ? MODALITIES.filter((m) => nextMods.includes(m)) : []
						};
					});
				};
				const modsActive = new Set(draft.inputMods);
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "mr-wire-title",
						children: t("fallbackTitle")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "mr-grid",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberField, {
							label: t("defaultContextWindow"),
							tip: `${t("defaultContextWindowTip")} · ${defaultText(t, EFFECTIVE_DEFAULTS.defaultContextWindow)}`,
							value: draft.numbers.defaultContextWindow,
							placeholder: defaultText(t, EFFECTIVE_DEFAULTS.defaultContextWindow),
							disabled: !writable,
							onChange: (next) => patch((current) => ({
								...current,
								numbers: {
									...current.numbers,
									defaultContextWindow: next
								}
							}))
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberField, {
							label: t("defaultMaxTokens"),
							tip: `${t("defaultMaxTokensTip")} · ${defaultText(t, EFFECTIVE_DEFAULTS.defaultMaxTokens)}`,
							value: draft.numbers.defaultMaxTokens,
							placeholder: defaultText(t, EFFECTIVE_DEFAULTS.defaultMaxTokens),
							disabled: !writable,
							onChange: (next) => patch((current) => ({
								...current,
								numbers: {
									...current.numbers,
									defaultMaxTokens: next
								}
							}))
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "mr-field",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: "mr-label",
							children: t("defaultInput")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "mr-mode-row",
							children: MODALITIES.map((modality) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "mr-radio-row",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: modsActive.has(modality),
									disabled: !writable,
									onChange: () => {
										toggleModality(modality);
									}
								}), t(`modality_${modality}`)]
							}, modality))
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "mr-wire-title",
						children: t("imageBudgetsTitle")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "mr-grid",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberField, {
								label: t("maxRequestImageBytes"),
								tip: `${t("maxRequestImageBytesTip")} · ${defaultText(t, EFFECTIVE_DEFAULTS.maxRequestImageBytes)}`,
								value: draft.numbers.maxRequestImageBytes,
								placeholder: defaultText(t, EFFECTIVE_DEFAULTS.maxRequestImageBytes),
								disabled: !writable,
								onChange: (next) => patch((current) => ({
									...current,
									numbers: {
										...current.numbers,
										maxRequestImageBytes: next
									}
								}))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberField, {
								label: t("requestImagePixelBudget"),
								tip: `${t("requestImagePixelBudgetTip")} · ${defaultText(t, EFFECTIVE_DEFAULTS.requestImagePixelBudget)}`,
								value: draft.numbers.requestImagePixelBudget,
								placeholder: defaultText(t, EFFECTIVE_DEFAULTS.requestImagePixelBudget),
								disabled: !writable,
								onChange: (next) => patch((current) => ({
									...current,
									numbers: {
										...current.numbers,
										requestImagePixelBudget: next
									}
								}))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberField, {
								label: t("requestImageMaxBytes"),
								tip: `${t("requestImageMaxBytesTip")} · ${defaultText(t, EFFECTIVE_DEFAULTS.requestImageMaxBytes)}`,
								value: draft.numbers.requestImageMaxBytes,
								placeholder: defaultText(t, EFFECTIVE_DEFAULTS.requestImageMaxBytes),
								disabled: !writable,
								onChange: (next) => patch((current) => ({
									...current,
									numbers: {
										...current.numbers,
										requestImageMaxBytes: next
									}
								}))
							})
						]
					})
				] });
			};
			const panels = {
				permodel: renderPerModel,
				retry: renderRetry,
				timeouts: renderTimeouts,
				cache: renderCache,
				capacity: renderCapacity
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mr-stack",
				style: { padding: "4px 0" },
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: "mr-title",
						children: t("title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "mr-intro",
						children: t("intro")
					}),
					raw?.writable === false ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "mr-hint",
						children: t("readOnly")
					}) : null,
					scopeUnavailable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "mr-hint",
						children: t("unavailable")
					}) : scopeLoading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "mr-hint",
						children: t("loading")
					}) : showEmpty ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "mr-empty",
						role: "status",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconThinkOutline16, {
								className: "mr-empty-icon",
								size: 16
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "mr-empty-title",
								children: t("emptyNoProvidersTitle")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "mr-empty-body",
								children: t("emptyNoProvidersBody")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "mr-empty-hint",
								children: t("emptyNoProvidersAction")
							})
						]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "mr-field",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								className: "mr-label",
								children: t("routeLabel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Selector, {
								value: routeKey ?? "",
								placeholder: t("routeUnset"),
								disabled: !writable,
								options: routes.map(([key, route]) => ({
									id: key,
									label: route?.displayName ?? key
								})),
								onChange: (id) => {
									pickRoute(id);
								}
							})]
						}),
						activeRouteKey === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "mr-tabs",
							children: GROUPS.map((group) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
								active: activeGroup === group.id,
								onClick: () => {
									setActiveGroup(group.id);
								},
								children: t(group.label)
							}, group.id))
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "mr-group",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "mr-scoperow",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
									label: t(SCOPE[activeGroup].tip),
									side: "top",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "mr-scopechip",
										children: t(SCOPE[activeGroup].chip)
									})
								})
							}), panels[activeGroup]()]
						})] }),
						issues.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "mr-error",
							children: issues.map(issueLine).join(" ")
						}) : null,
						saved ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "mr-success",
							role: "status",
							children: t("saved")
						}) : null,
						failure !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "mr-error",
							children: failure
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "mr-actions",
							children: [
								activeModel !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "mr-inline mr-aspects",
									children: ASPECTS.map((aspect) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "mr-radio-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: applyAspects[aspect.id],
											disabled: busy || !writable,
											onChange: () => {
												setApplyAspects((s) => ({
													...s,
													[aspect.id]: !s[aspect.id]
												}));
											}
										}), t(aspect.label)]
									}, aspect.id))
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "primary",
									size: "md",
									disabled: !canSave,
									onClick: () => {
										save();
									},
									children: t("save")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
									label: t("applyAllTip"),
									side: "top",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										size: "md",
										disabled: !canApplyAll,
										onClick: () => {
											applyToAll();
										},
										children: t("applyAll")
									})
								})
							]
						})
					] })
				]
			});
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* Design-token styles for the Model reasoning settings section.
		*
		* The plugin is external (not part of the DSH repository), so it cannot import
		* the built-in CSS modules; instead it re-declares the same rules against the
		* shared `--dsw-alias-*` tokens, namespaced under `mr-` to avoid any collision
		* with host styles. Classes mirror the built-in Models form's `.input` /
		* `.selectInput` / label / button styling so the page reads as native DSH UI.
		* Tokens carry no fallback because the host theme always defines them on the
		* app root (exactly as the built-in pages use them).
		*/
		const REASONING_STYLES = `
.mr-title { margin: 0 0 4px; font-size: 15px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.mr-intro { margin: 0 0 16px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.mr-field { margin: 0 0 14px; }
.mr-label { display: block; margin-bottom: 6px; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
/* Selector pill — the dropdown trigger, matching the General settings rows
   (figma 'Selector': h36 r18, fill --dsw-alias-bg-module-platform, pad 0/14,
   gap 12), which open a Menu rather than a native <select>. */
.mr-selector {
  display: inline-flex; align-items: center; gap: 12px;
  height: 36px; padding: 0 14px; border: none; border-radius: 18px;
  background: var(--dsw-alias-bg-module-platform);
  font: inherit; font-size: 14px; line-height: 22px;
  color: var(--dsw-alias-label-primary); cursor: pointer;
}
.mr-selector:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.mr-selector:disabled { opacity: 0.6; cursor: default; }
.mr-selector-label { white-space: nowrap; }
.mr-selector-placeholder { color: var(--dsw-alias-label-tertiary); }
.mr-chevron { flex: none; }
.mr-panel { border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; padding: 14px; margin: 0 0 14px; }
.mr-panel-title { margin: 0 0 10px; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-primary); }
.mr-stack { display: flex; flex-direction: column; gap: 10px; }
.mr-radio-row { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-primary); cursor: pointer; }
/* The three mode choices laid out side by side. */
.mr-mode-row { display: flex; flex-wrap: wrap; gap: 18px; }
/* A route with an empty models list reuses the empty-placeholder look, lighter. */
.mr-model-empty { padding: 16px 20px; margin-top: 2px; }
.mr-levels { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
/* Native radio themed like DSH's own forms (RiskConfirmation keeps native
   inputs and colors them via accent-color so they follow the theme instead of
   the browser default). */
.mr-radio-row input[type='radio'] {
  accent-color: var(--dsw-alias-button-primary-fill);
}
/* Per-level wire-spelling editor (customizing what each thinking level sends). */
.mr-wire { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.mr-wire-title { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.mr-wire-row { display: flex; align-items: center; gap: 10px; }
.mr-wire-label { min-width: 64px; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.mr-wire-off { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.mr-wire-off input[type='checkbox'] { accent-color: var(--dsw-alias-button-primary-fill); }
.mr-wire-input { width: 200px; }
/* Fused searchable select (per-model picker): trigger pill + dropdown panel
   whose first element is the filter input — one control, no separate search
   box beside or above it. */
.mr-sselect { position: relative; display: inline-block; max-width: 100%; }
.mr-sselect-panel {
  position: absolute; z-index: 30;
  top: calc(100% + 4px); left: 0;
  min-width: 260px; width: max-content; max-width: min(360px, calc(100vw - 32px));
  display: flex; flex-direction: column; gap: 6px;
  padding: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}
/* The filter input inside the fused panel: full panel width, own block line. */
.mr-search { display: flex; width: 100%; }
.mr-sselect-list {
  display: flex; flex-direction: column; gap: 2px;
  max-height: 220px; overflow-y: auto;
}
.mr-sselect-item {
  padding: 6px 10px; border: none; border-radius: 6px;
  background: transparent; text-align: left;
  font: inherit; font-size: 13px; line-height: 20px;
  color: var(--dsw-alias-label-primary); cursor: pointer;
}
.mr-sselect-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.mr-sselect-item-active { background: var(--dsw-alias-bg-module-platform); }
/* Per-group scope badge row: states whether the group is one route-wide value
   or a route default with per-model overrides. */
.mr-scoperow { display: flex; align-items: center; gap: 8px; min-width: 0; }
.mr-scopechip {
  flex: none;
  padding: 2px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-module-platform);
  font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
/* Empty state: dashed placeholder box matching the built-in Models form's
   empty catalog (modelEmpty: dashed border-l3, centered, tertiary label). */
.mr-empty {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 28px 20px; text-align: center;
  border: 1px dashed var(--dsw-alias-border-l3); border-radius: 8px;
}
.mr-empty-icon { color: var(--dsw-alias-label-tertiary); margin-bottom: 4px; }
.mr-empty-title { margin: 0; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-primary); }
.mr-empty-body { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); max-width: 320px; }
.mr-empty-hint { margin: 4px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.mr-hint { margin: 8px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.mr-error { margin: 8px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.mr-success { margin: 8px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-success-primary); }
/* Parameter-group tab strip (Pill row) and the active group's body. */
.mr-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 4px; }
.mr-group { display: flex; flex-direction: column; gap: 12px; }
/* Two-column grid of labeled numeric fields (wraps on narrow panels). */
.mr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px 24px; }
/* Grid items may shrink below content size, so a long field name engages
   ellipsis instead of stretching the cell or wrapping onto a second line —
   a wrapped label pushes its input down and breaks row alignment. */
.mr-grid > * { min-width: 0; }
.mr-numfield { display: flex; flex-direction: column; gap: 4px; cursor: pointer; }
/* Field names stay on ONE line (full descriptions live in the tooltip): a
   two-line label is what used to misalign inputs across a grid row. */
.mr-numfield .mr-wire-label {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* The Input keeps the primitive's intrinsic ~200px width inside its track —
   stretching it edge-to-edge (width:100%) glued neighboring columns' borders
   together with nothing but the grid gap between them. The unused track tail
   IS the inter-field whitespace, exactly like the built-in forms. */
/* Inline input + button row (custom retryable code entry). */
.mr-inline { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
/* Normal-mode-only controls while Always mode is selected. */
.mr-dimmed { opacity: 0.5; }
.mr-actions { display: flex; gap: 8px; margin-top: 2px; }
`;
		/**
		* Inject {@link REASONING_STYLES} once, tagged by plugin id so re-evaluation
		* and repeated mounts stay idempotent (mirrors how the loader handles plugin
		* CSS). Called from the client `apply`.
		* @param pluginId - stable plugin id used as the style tag marker.
		*/
		function injectReasoningStyles(pluginId) {
			if (typeof document === "undefined") return;
			const selector = `style[data-dsh-plugin-css="${pluginId}"]`;
			if (document.querySelector(selector) !== null) return;
			const tag = document.createElement("style");
			tag.setAttribute("data-dsh-plugin-css", pluginId);
			tag.textContent = REASONING_STYLES;
			document.head.appendChild(tag);
		}
		injectReasoningStyles("dsh-model-reasoning");
		//#endregion
		//#region src/client/locales.ts
		/** Copy dictionaries for the Provider parameters settings section. */
		/** English strings (the key-set source of truth for this pair). */
		const en = {
			nav: "Provider parameters",
			title: "Provider parameters",
			intro: "Manage per-provider and per-model parameters for third-party (pi-ai) providers: reasoning levels, retry and backoff policy, timeouts, transport, caching, capacities. Values are written to llm-pi-ai and picked up by the model picker.",
			readOnly: "The settings document is read-only in this deployment.",
			conflict: "Someone else changed these settings while this page was open. Reopen it to edit the current values.",
			loading: "Loading…",
			unavailable: "The settings document is not available in this deployment.",
			emptyNoProvidersTitle: "No third-party providers yet",
			emptyNoProvidersBody: "Add a custom provider first, then come back here to manage its parameters.",
			emptyNoProvidersAction: "Settings → Models → Add a custom provider",
			routeLabel: "Provider route",
			routeUnset: "Choose a provider…",
			groupPerModel: "Per model",
			groupRetry: "Retry & backoff",
			groupTimeouts: "Timeouts & transport",
			groupCache: "Caching & budgets",
			groupCapacity: "Capacities & budgets",
			routeDefault: "Route default thinking level",
			routeDefaultUnset: "Provider default (unset)",
			modelLabel: "Model",
			modelUnset: "Choose a model…",
			modelSearchPlaceholder: "Search models…",
			modelSearchEmpty: "No models match your search.",
			modelEfforts: "Model thinking levels",
			modelInputLabel: "Input modalities — what THIS model accepts",
			modelInputTip: "Unset inherits the route fallback or the catalog declaration; set exactly what this model accepts.",
			modelCapacityTitle: "Context & output caps for THIS model",
			contextWindow: "contextWindow",
			contextWindowTip: "Context capacity of this model alone.",
			maxTokens: "maxTokens",
			maxTokensTip: "Output capability of this model alone.",
			modeInheritLabel: "Inherit",
			modeOffLabel: "Non-reasoning",
			modeOnLabel: "Reasoning",
			modeInheritTip: "No override — keep whatever is already declared.",
			modeOffTip: "Mark as non-reasoning (reasoningEfforts: false).",
			modeOnTip: "Enable reasoning and pick the supported levels.",
			applyAll: "Apply to all models",
			applyAllTip: "Copy the checked dimensions from this model's editor to every model on the route.",
			applyAspectInput: "Input modalities",
			applyAspectCapacity: "Capacity caps",
			applyAspectReasoning: "Reasoning levels",
			emptyModelsTitle: "Catalog models on this route",
			emptyModelsBody: "This route serves the installed catalog without an explicit models list, so its models cannot be edited here. Catalog reasoning levels stay selectable in the composer.",
			wireTitle: "Wire spelling per level (customize what each level sends, e.g. max → ultra)",
			offEmpty: "off sends nothing",
			needLevel: "At least one level beyond \"off\" must be selected.",
			retryModeLabel: "Retry mode",
			retryModeNormal: "Normal",
			retryModeAlways: "Always",
			retryModeNormalTip: "Bounded retries for transient failures only (rate limits, server errors, timeouts). Default: up to 5 retries.",
			retryModeAlwaysTip: "WARNING: retries every failed request until success or cancellation — an unusable route will retry forever. Prefer Normal.",
			maxRetries: "maxRetries",
			maxRetriesTip: "Maximum eligible retries after the first request (normal mode only).",
			retryableCodes: "retryableCodes — eligible failure codes",
			codePlaceholder: "Custom failure code…",
			addCode: "Add",
			backoffTitle: "Backoff (exponential with jitter)",
			initialDelayMs: "initialDelayMs",
			initialDelayMsTip: "First exponential-backoff delay.",
			maxDelayMs: "maxDelayMs",
			maxDelayMsTip: "Backoff ceiling.",
			jitterRatio: "jitterRatio",
			jitterRatioTip: "Symmetric jitter around each delay (0–1).",
			timeoutMs: "timeoutMs",
			timeoutMsTip: "HTTP/provider-SDK request timeout in milliseconds.",
			websocketConnectTimeoutMs: "websocketConnectTimeoutMs",
			websocketConnectTimeoutMsTip: "WebSocket connection timeout in milliseconds.",
			streamIdleTimeoutMs: "streamIdleTimeoutMs",
			streamIdleTimeoutMsTip: "Maximum idle time during one outstanding stream read.",
			transport: "transport — streaming transport",
			cacheRetention: "cacheRetention — prompt-cache retention",
			budgetsTitle: "thinkingBudgets — token budgets per thinking level",
			budget_minimal: "minimal",
			budget_low: "low",
			budget_medium: "medium",
			budget_high: "high",
			fallbackTitle: "Fallbacks for models that declare nothing — a model with its own value never reads these",
			defaultContextWindow: "defaultContextWindow",
			defaultContextWindowTip: "Context capacity assumed for models that declare none (route fallback, never an override).",
			defaultMaxTokens: "defaultMaxTokens",
			defaultMaxTokensTip: "Output capability assumed the same way.",
			defaultInput: "defaultInput — modalities fallback",
			modality_text: "text",
			modality_image: "image",
			imageBudgetsTitle: "Per-request image payload budgets",
			maxRequestImageBytes: "maxRequestImageBytes",
			maxRequestImageBytesTip: "Total base64 payload cap per request; the oldest images degrade to placeholders beyond it.",
			requestImagePixelBudget: "requestImagePixelBudget",
			requestImagePixelBudgetTip: "Total-pixel budget of each deterministic inline request version.",
			requestImageMaxBytes: "requestImageMaxBytes",
			requestImageMaxBytesTip: "Raw encoded-byte cap of each inline version, before base64 expansion.",
			effectiveDefault: "Default:",
			inheritHint: "Adapter default (unset)",
			restoreField: "Clear",
			restoreFieldTip: "Remove this override so the adapter default applies again.",
			scopeRoute: "Whole route",
			scopeRouteTip: "These exist ONLY at route level in llm-pi-ai — one shared value for every model on it; per-model overrides are not part of the schema here.",
			scopePerModel: "Per model",
			scopePerModelTip: "Written into the selected model's own declaration; a dimension you leave unset inherits the route fallback or catalog value.",
			save: "Save",
			saved: "Saved.",
			errNumber: "must be a finite number.",
			errNatural: "must be a non-negative integer.",
			errDelayBound: "must be a positive number of at most 2147483647 ms.",
			errPositiveInt: "must be a positive integer.",
			errRatio: "must be a number between 0 and 1.",
			errInitialAboveMax: "(initial delay) must be less than or equal to the maximum delay.",
			errInputEmpty: "must name at least one modality, or clear the override."
		};
		/** Chinese strings (same keys as {@link en}). */
		const zh = {
			nav: "提供方参数",
			title: "提供方参数",
			intro: "管理第三方（pi-ai）提供方的路由级与模型级参数：思考等级、重试与退避策略、超时、传输方式、缓存与容量预算。写入 llm-pi-ai，模型选择器会自动识别。",
			readOnly: "此部署中设置文档为只读。",
			conflict: "页面打开期间有其他人修改了这些设置。请重新打开以编辑当前值。",
			loading: "加载中…",
			unavailable: "此部署中设置文档不可用。",
			emptyNoProvidersTitle: "还没有第三方提供方",
			emptyNoProvidersBody: "请先添加自定义提供方，再回来管理它的参数。",
			emptyNoProvidersAction: "设置 → 模型 → 添加自定义提供方",
			routeLabel: "提供方路由",
			routeUnset: "选择提供方…",
			groupPerModel: "按模型",
			groupRetry: "重试与退避",
			groupTimeouts: "超时与传输",
			groupCache: "缓存与预算",
			groupCapacity: "容量与预算",
			routeDefault: "路由默认思考等级",
			routeDefaultUnset: "提供方默认（未设置）",
			modelLabel: "模型",
			modelUnset: "选择模型…",
			modelSearchPlaceholder: "搜索模型…",
			modelSearchEmpty: "没有匹配的模型。",
			modelEfforts: "模型思考等级",
			modelInputLabel: "输入模态（input）— 该模型可接收的请求类型",
			modelInputTip: "不设置则继承路由回退值或目录声明；勾选的即该模型实际支持的。",
			modelCapacityTitle: "该模型的上下文与输出上限",
			contextWindow: "contextWindow",
			contextWindowTip: "仅该模型的上下文容量（token）。",
			maxTokens: "maxTokens",
			maxTokensTip: "仅该模型的输出能力（token）。",
			modeInheritLabel: "继承",
			modeOffLabel: "不思考",
			modeOnLabel: "思考",
			modeInheritTip: "不覆盖——保留已有声明。",
			modeOffTip: "标记为不思考（reasoningEfforts: false）。",
			modeOnTip: "启用思考并选择支持的等级。",
			applyAll: "应用到所有模型",
			applyAllTip: "把勾选维度的编辑器当前值复制到该路由的所有模型。",
			applyAspectInput: "输入模态",
			applyAspectCapacity: "容量上限",
			applyAspectReasoning: "推理强度",
			emptyModelsTitle: "该路由使用内置目录",
			emptyModelsBody: "此路由未携带显式模型列表，服务的是已安装目录，因此无法在这里编辑它的模型。目录模型的推理等级仍可在 composer 中选择。",
			wireTitle: "每个等级的线上拼写（自定义该等级发到上游的值，如 max → ultra）",
			offEmpty: "off 不发送值",
			needLevel: "必须至少选择一个除 \"off\" 之外的等级。",
			retryModeLabel: "重试模式",
			retryModeNormal: "常规",
			retryModeAlways: "总是重试",
			retryModeNormalTip: "仅对瞬时失败（限流、服务端错误、超时等）做有界重试。默认最多重试 5 次。",
			retryModeAlwaysTip: "警告：对每一次失败请求无限重试，直到成功或取消——不可用的路由将永远重试。一般请选「常规」。",
			maxRetries: "maxRetries",
			maxRetriesTip: "首次请求后的最大重试次数（仅常规模式）。",
			retryableCodes: "retryableCodes — 参与重试的错误码",
			codePlaceholder: "自定义错误码…",
			addCode: "添加",
			backoffTitle: "退避（指数 + 抖动）",
			initialDelayMs: "initialDelayMs",
			initialDelayMsTip: "首次指数退避延迟（毫秒）。",
			maxDelayMs: "maxDelayMs",
			maxDelayMsTip: "退避延迟上限（毫秒）。",
			jitterRatio: "jitterRatio",
			jitterRatioTip: "每次延迟的对称抖动比例（0–1）。",
			timeoutMs: "timeoutMs",
			timeoutMsTip: "HTTP/提供方 SDK 请求超时（毫秒）。",
			websocketConnectTimeoutMs: "websocketConnectTimeoutMs",
			websocketConnectTimeoutMsTip: "WebSocket 连接超时（毫秒）。",
			streamIdleTimeoutMs: "streamIdleTimeoutMs",
			streamIdleTimeoutMsTip: "单次流式读取期间允许的最大空闲时间（毫秒）。",
			transport: "transport — 流式传输方式",
			cacheRetention: "cacheRetention — 提示缓存保留策略",
			budgetsTitle: "thinkingBudgets — 各思考等级的 token 预算",
			budget_minimal: "minimal",
			budget_low: "low",
			budget_medium: "medium",
			budget_high: "high",
			fallbackTitle: "未单独声明的模型的回退值——模型自带声明时永不读取这些",
			defaultContextWindow: "defaultContextWindow",
			defaultContextWindowTip: "模型自身未声明上下文时假定的容量（路由回退值，绝不覆盖已有声明）。",
			defaultMaxTokens: "defaultMaxTokens",
			defaultMaxTokensTip: "输出能力按同样规则回退。",
			defaultInput: "defaultInput — 模态回退值",
			modality_text: "文本（text）",
			modality_image: "图像（image）",
			imageBudgetsTitle: "单请求图片负载预算",
			maxRequestImageBytes: "maxRequestImageBytes",
			maxRequestImageBytesTip: "单请求 base64 总负载上限，超出后最旧的图片降级为占位文本。",
			requestImagePixelBudget: "requestImagePixelBudget",
			requestImagePixelBudgetTip: "每个确定性内联请求版本的总像素预算。",
			requestImageMaxBytes: "requestImageMaxBytes",
			requestImageMaxBytesTip: "每个内联版本在 base64 展开前的原始字节上限。",
			effectiveDefault: "默认：",
			inheritHint: "适配器默认（未设置）",
			restoreField: "清除",
			restoreFieldTip: "移除该项覆盖，恢复适配器默认行为。",
			scopeRoute: "整条路由",
			scopeRouteTip: "这组参数在 llm-pi-ai 中只存在于路由级——该提供方下所有模型共享一份值；schema 不支持对单个模型覆盖。",
			scopePerModel: "按模型",
			scopePerModelTip: "写入所选模型自己的声明；留空的维度继承路由回退值或目录声明。",
			save: "保存",
			saved: "已保存。",
			errNumber: "必须是有限数字。",
			errNatural: "必须是非负整数。",
			errDelayBound: "必须是正数且不超过 2147483647 毫秒。",
			errPositiveInt: "必须是正整数。",
			errRatio: "必须是 0 到 1 之间的数字。",
			errInitialAboveMax: "（首次延迟）不能大于退避上限。",
			errInputEmpty: "至少要勾选一种模态，或清除该覆盖项。"
		};
		//#endregion
		//#region src/client/index.ts
		/** Dictionary namespace owned by this plugin. */
		const NS = "provider-params";
		/** The pi-ai settings namespace whose provider profiles this page edits. */
		const PI_AI_NS = "llm-pi-ai";
		/** Required services (cordis fiber inject). The target slot is declared by
		* ui-settings; registration depends on it through `slots.inject()`. */
		const inject = [
			"slots",
			"locale",
			"connection",
			"remote",
			"settingsScope"
		];
		/**
		* Register the Provider parameters section once the `settings.section`
		* declaration is on the ledger, binding the `llm-pi-ai` namespace scope on this
		* plugin's lifecycle.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-model-reasoning: copy dictionaries");
			const connection = ctx.get("connection");
			const scope = ctx.settingsScope.bind({ namespace: PI_AI_NS });
			const t = ctx.locale.bind(NS);
			const injected = () => ({
				api: connection.api,
				t,
				hooks: { modelReasoning: scope }
			});
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "provider-params",
				order: 20,
				label: () => t("nav"),
				inject: injected
			}, ProviderParamsSection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map