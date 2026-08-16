window.__ModuleLoader__.load({
	id: "dsh-model-reasoning",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/ReasoningSection.tsx
		/**
		* The "Model reasoning" settings section (external plugin).
		*
		* A companion page to the built-in Models page: it lets you configure the
		* per-model reasoning-effort (thinking level) declaration for third-party
		* pi-ai providers, which the built-in Models form deliberately does not expose.
		* It writes the exact same `llm-pi-ai.providers.<route>.models[].reasoningEfforts`
		* (and route-level `reasoning`) fields the adapter reads, so the composer's
		* 「推理等级」 picker and route defaults pick the values up with no other change.
		*
		* Enumerates only routes that carry an explicit `models` list (custom /
		* hand-declared providers) — the installed catalog is not reachable from the
		* client, so catalog-only routes list no models here and keep using the
		* composer picker, which already offers their catalog levels.
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
		/**
		* Render the Model reasoning settings page (guarded shell: hooks live in the
		* loaded child, which is only mounted once the slot has injected).
		* @param props - the inject face.
		* @returns the section, or null while the shell has not injected yet.
		*/
		function ReasoningSection(props) {
			const { api, t, useModelReasoning } = props;
			if (api === void 0 || t === void 0 || useModelReasoning === void 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ReasoningSectionLoaded, {
				api,
				t,
				useModelReasoning
			});
		}
		/** The mounted editor (all hooks run unconditionally here). */
		function ReasoningSectionLoaded(props) {
			const { api, t, useModelReasoning } = props;
			const raw = useModelReasoning((snapshot) => snapshot);
			const value = raw?.value;
			const editable = (0, react.useMemo)(() => Object.entries(value?.providers ?? {}), [value]).filter(([, route]) => Array.isArray(route?.models));
			const [routeKey, setRouteKey] = (0, react.useState)(void 0);
			const [modelIndex, setModelIndex] = (0, react.useState)(void 0);
			const [mode, setMode] = (0, react.useState)("inherit");
			const [levels, setLevels] = (0, react.useState)(/* @__PURE__ */ new Set(["high"]));
			const [wire, setWire] = (0, react.useState)({});
			const [offEmpty, setOffEmpty] = (0, react.useState)(true);
			const [routeDefault, setRouteDefault] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [failure, setFailure] = (0, react.useState)(void 0);
			const [saved, setSaved] = (0, react.useState)(false);
			const activeRoute = routeKey === void 0 ? void 0 : editable.find(([k]) => k === routeKey);
			const activeRouteKey = activeRoute?.[0];
			const models = activeRoute?.[1]?.models ?? [];
			const activeModel = modelIndex === void 0 ? void 0 : models[modelIndex];
			activeModel?.id;
			const pickRoute = (key) => {
				setRouteKey(key);
				setModelIndex(void 0);
				setSaved(false);
				setFailure(void 0);
				const route = editable.find(([k]) => k === key)?.[1];
				setRouteDefault(route?.reasoning ?? "");
			};
			const pickModel = (index) => {
				setModelIndex(index);
				setSaved(false);
				setFailure(void 0);
				const model = models[index];
				const state = effortStateOf(model?.reasoningEfforts);
				setMode(state.kind);
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
			const onHasLevel = levels.size > 0 && (levels.size > 1 || !levels.has("off"));
			const nextDict = mode === "on" ? wireOf(levels, wire, offEmpty) : mode === "off" ? false : void 0;
			const routeDefaultDirty = activeRouteKey !== void 0 && routeDefault !== (activeRoute?.[1]?.reasoning ?? "");
			const modelDirty = activeModel !== void 0 && JSON.stringify(activeModel.reasoningEfforts) !== JSON.stringify(nextDict);
			const canSave = !busy && (mode !== "on" || onHasLevel) && (routeDefaultDirty || modelDirty);
			const save = async () => {
				if (api === void 0 || activeRouteKey === void 0) return;
				setBusy(true);
				setFailure(void 0);
				const ops = [];
				if (activeModel !== void 0 && modelIndex !== void 0) {
					const current = activeModel.reasoningEfforts;
					const next = mode === "inherit" ? void 0 : mode === "off" ? false : wireOf(levels, wire, offEmpty);
					if (JSON.stringify(current) !== JSON.stringify(next)) {
						const newModels = models.map((model) => ({ ...model }));
						const entry = newModels[modelIndex];
						if (next === void 0) {
							const { reasoningEfforts: _dropped, ...rest } = entry;
							newModels[modelIndex] = rest;
						} else newModels[modelIndex] = {
							...entry,
							reasoningEfforts: next
						};
						ops.push({
							op: "set",
							path: [
								"providers",
								activeRouteKey,
								"models"
							],
							value: newModels
						});
					}
				}
				if (activeRouteKey !== void 0) {
					const current = activeRoute?.[1]?.reasoning;
					if (routeDefault !== (current ?? "")) {
						if (routeDefault === "") ops.push({
							op: "unset",
							path: [
								"providers",
								activeRouteKey,
								"reasoning"
							]
						});
						else ops.push({
							op: "set",
							path: [
								"providers",
								activeRouteKey,
								"reasoning"
							],
							value: routeDefault
						});
					}
				}
				if (ops.length === 0) {
					setBusy(false);
					return;
				}
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
				setSaved(true);
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
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "mr-field",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: "mr-label",
							children: t("routeLabel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Selector, {
							value: routeKey ?? "",
							placeholder: t("routeUnset"),
							disabled: !raw?.writable,
							options: editable.map(([key, route]) => ({
								id: key,
								label: route?.displayName ?? key
							})),
							onChange: (id) => {
								pickRoute(id);
							}
						})]
					}),
					activeRouteKey === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "mr-field",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: "mr-label",
							children: t("modelLabel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Selector, {
							value: modelIndex === void 0 ? "" : String(modelIndex),
							placeholder: t("modelUnset"),
							disabled: !raw?.writable,
							options: models.map((model, index) => ({
								id: String(index),
								label: model.name ?? model.id ?? String(index)
							})),
							onChange: (id) => {
								pickModel(Number(id));
							}
						})]
					}),
					activeRouteKey !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
						className: "mr-panel",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", {
							className: "mr-panel-title",
							children: t("routeDefault")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Selector, {
							value: routeDefault,
							placeholder: t("routeDefaultUnset"),
							disabled: !raw?.writable,
							options: REASONING_LEVELS.map((level) => ({
								id: level,
								label: level
							})),
							onChange: (id) => {
								setRouteDefault(id);
								setSaved(false);
							}
						})]
					}) : null,
					activeModel === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
						className: "mr-panel",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", {
								className: "mr-panel-title",
								children: `${t("modelEfforts")} — ${activeModel.name ?? activeModel.id ?? modelIndex}`
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "mr-stack",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "mr-radio-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "radio",
											name: "effort-mode",
											checked: mode === "inherit",
											disabled: !raw?.writable,
											onChange: () => {
												setMode("inherit");
												setSaved(false);
											}
										}), t("modeInherit")]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "mr-radio-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "radio",
											name: "effort-mode",
											checked: mode === "off",
											disabled: !raw?.writable,
											onChange: () => {
												setMode("off");
												setSaved(false);
											}
										}), t("modeOff")]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "mr-radio-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "radio",
											name: "effort-mode",
											checked: mode === "on",
											disabled: !raw?.writable,
											onChange: () => {
												setMode("on");
												setSaved(false);
											}
										}), t("modeOn")]
									})
								]
							}),
							mode === "on" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "mr-levels",
								children: REASONING_LEVELS.map((level) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
									active: levels.has(level),
									disabled: !raw?.writable,
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
											disabled: !raw?.writable,
											onChange: () => {
												setOffEmpty((v) => !v);
												setSaved(false);
											}
										}), t("offEmpty")]
									}), offEmpty ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
										className: "mr-wire-input",
										value: wire[level] ?? "off",
										disabled: !raw?.writable,
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
										disabled: !raw?.writable,
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
					}),
					saved ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "mr-success",
						role: "status",
						children: t("saved")
					}) : null,
					failure !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "mr-error",
						children: failure
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "mr-actions",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							size: "md",
							disabled: !canSave,
							onClick: () => {
								save();
							},
							children: t("save")
						})
					})
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
.mr-hint { margin: 8px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.mr-error { margin: 8px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.mr-success { margin: 8px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-success-primary); }
.mr-actions { display: flex; gap: 8px; }
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
		/** Copy dictionaries for the Model reasoning settings section. */
		/** English strings (the key-set source of truth for this pair). */
		const en = {
			nav: "Model reasoning",
			title: "Model reasoning",
			intro: "Set per-model thinking levels (reasoning efforts) for third-party (pi-ai) providers. Values are written to llm-pi-ai and picked up by the model picker.",
			readOnly: "The settings document is read-only in this deployment.",
			conflict: "Someone else changed these settings while this page was open. Reopen it to edit the current values.",
			routeLabel: "Provider route",
			routeUnset: "Choose a provider…",
			modelLabel: "Model",
			modelUnset: "Choose a model…",
			routeDefault: "Route default thinking level",
			routeDefaultUnset: "Provider default (unset)",
			modelEfforts: "Model thinking levels",
			modeInherit: "Inherit (no override — keep whatever is already declared)",
			modeOff: "Non-reasoning (reasoningEfforts: false)",
			modeOn: "Reasoning — select supported levels:",
			wireTitle: "Wire spelling per level (customize what each level sends, e.g. max → ultra)",
			offEmpty: "off sends nothing",
			needLevel: "At least one level beyond \"off\" must be selected.",
			save: "Save",
			saved: "Saved."
		};
		/** Chinese strings (same keys as {@link en}). */
		const zh = {
			nav: "模型思考等级",
			title: "模型思考等级",
			intro: "为第三方（pi-ai）提供方的每个模型设置思考等级（推理强度）。写入 llm-pi-ai，模型选择器会自动识别。",
			readOnly: "此部署中设置文档为只读。",
			conflict: "页面打开期间有其他人修改了这些设置。请重新打开以编辑当前值。",
			routeLabel: "提供方路由",
			routeUnset: "选择提供方…",
			modelLabel: "模型",
			modelUnset: "选择模型…",
			routeDefault: "路由默认思考等级",
			routeDefaultUnset: "提供方默认（未设置）",
			modelEfforts: "模型思考等级",
			modeInherit: "继承（不覆盖——保留已有声明）",
			modeOff: "不思考（reasoningEfforts: false）",
			modeOn: "思考——选择支持的等级：",
			wireTitle: "每个等级的线上拼写（自定义该等级发到上游的值，如 max → ultra）",
			offEmpty: "off 不发送值",
			needLevel: "必须至少选择一个除 \"off\" 之外的等级。",
			save: "保存",
			saved: "已保存。"
		};
		//#endregion
		//#region src/client/index.ts
		/** Dictionary namespace owned by this plugin. */
		const NS = "model-reasoning";
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
		* Register the Model reasoning section once the `settings.section` declaration
		* is on the ledger, binding the `llm-pi-ai` namespace scope on this plugin's
		* lifecycle.
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
				id: "model-reasoning",
				order: 20,
				label: () => t("nav"),
				inject: injected
			}, ReasoningSection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map