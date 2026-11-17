window.__ModuleLoader__.load({
	id: "dsh-kanban",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/board-counts.ts
		/**
		* Module-level open-item count for the sidebar badge, shared by the sidebar
		* entry button. Polls the host `/kanban/counts` endpoint for one workspace and
		* exposes a bare observable pair (subscribe/getSnapshot) for
		* useSyncExternalStore — the module-level observable pattern the plugin uses
		* for cross-entry state (the sidebar glyph and any future consumer).
		*/
		const listeners = /* @__PURE__ */ new Set();
		let counts = { open: 0 };
		let pollTimer = null;
		/** Monotonic request sequence: only the latest response may publish a count. */
		let requestSeq = 0;
		/** Trailing coalescing timer for workspace-feed triggers. */
		let coalesceTimer = null;
		/** Subscribe to count changes; returns an unsubscribe. */
		function subscribeCounts(fn) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		}
		/** Current open-item count snapshot. */
		function getCountsSnapshot() {
			return counts;
		}
		/** Fetch the open-item count for one workspace and publish it. */
		async function refreshCounts(cwd) {
			const seq = ++requestSeq;
			try {
				const response = await fetch(`/kanban/counts?cwd=${encodeURIComponent(cwd)}`);
				const body = await response.json();
				if (seq !== requestSeq) return;
				if (response.ok && body.ok === true && typeof body.open === "number") {
					counts = { open: body.open };
					for (const fn of listeners) fn();
				}
			} catch {}
		}
		/** The resolve function of the active poll (undefined before start). */
		let latestResolveCwd;
		/**
		* Start polling. `resolveCwd` is called on each tick to find the current
		* workspace (e.g. from the current session), so the badge follows the active
		* workspace automatically. Refreshes immediately, then every interval.
		* Returns a stop function.
		*/
		function startCountsPolling(resolveCwd, intervalMs = 3e4) {
			if (pollTimer !== null) return () => stopCountsPolling();
			latestResolveCwd = resolveCwd;
			const tick = () => {
				const cwd = latestResolveCwd?.();
				if (cwd !== void 0 && cwd !== "") refreshCounts(cwd);
			};
			tick();
			pollTimer = setInterval(tick, intervalMs);
			return () => stopCountsPolling();
		}
		/**
		* Immediately re-resolve and refresh the count (used when the workspace feed
		* changes, so the badge appears as soon as data is ready instead of waiting
		* for the next poll interval).
		*/
		function triggerCountsPoll() {
			if (coalesceTimer !== null) return;
			coalesceTimer = setTimeout(() => {
				coalesceTimer = null;
				const cwd = latestResolveCwd?.();
				if (cwd !== void 0 && cwd !== "") refreshCounts(cwd);
			}, 250);
		}
		/** Stop polling; keeps the last published count. */
		function stopCountsPolling() {
			if (pollTimer !== null) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
			latestResolveCwd = void 0;
		}
		//#endregion
		//#region src/client/board-view.ts
		/** Column order, left to right. */
		const STATUS_ORDER = [
			"todo",
			"in_progress",
			"done"
		];
		/** Locale-independent string ordering (deterministic across machines). */
		function compareText(left, right) {
			return left < right ? -1 : left > right ? 1 : 0;
		}
		/**
		* Order the board: status bucket first, then the card touched most recently.
		*
		* `updatedAt` decides within a status (a done card is read by its finish day),
		* `createdAt` breaks ties (a card edited in the same millisecond), and the id
		* makes the order total so a poll that returns the same board cannot reshuffle
		* the DOM and drop the reader's scroll position.
		* @param cards - the cards as served by the host route.
		* @returns a new array; the input is never mutated.
		*/
		function sortCards(cards) {
			const rank = {
				todo: 0,
				in_progress: 1,
				done: 2
			};
			return [...cards].sort((left, right) => {
				const byStatus = rank[left.status] - rank[right.status];
				if (byStatus !== 0) return byStatus;
				const byUpdated = right.updatedAt - left.updatedAt;
				if (byUpdated !== 0) return byUpdated;
				const byCreated = right.createdAt - left.createdAt;
				if (byCreated !== 0) return byCreated;
				return compareText(left.id, right.id);
			});
		}
		/** The searchable text of one card (every field the page can show). */
		function searchableText(card) {
			return [
				card.id,
				card.title,
				card.description ?? "",
				card.summary ?? "",
				card.rationale ?? "",
				card.rejected ?? "",
				card.tags.join(" ")
			].join("\n").toLowerCase();
		}
		/**
		* Does a card match a free-text query?
		*
		* Case-insensitive; every whitespace-separated term must appear somewhere in the
		* card (id, title, description, what/why/rejected, tags), so "0.2.14 search"
		* finds the card that mentions both without caring about field boundaries.
		* @param card - one card.
		* @param query - raw user input; empty/blank matches everything.
		*/
		function cardMatchesQuery(card, query) {
			const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== "");
			if (terms.length === 0) return true;
			const haystack = searchableText(card);
			return terms.every((term) => haystack.includes(term));
		}
		/**
		* Apply the status + tag + query filters.
		* @param cards - any card list.
		* @param filters - current filter state.
		* @returns the matching cards, input order preserved.
		*/
		function filterCards(cards, filters) {
			return cards.filter((card) => (filters.status === "all" || card.status === filters.status) && (filters.tag === void 0 || card.tags.includes(filters.tag)) && cardMatchesQuery(card, filters.query));
		}
		/**
		* Tag index for the filter chips: most-used first, then alphabetical.
		* @param cards - usually the unfiltered board, so chips do not vanish as you filter.
		*/
		function collectTags(cards) {
			const counts = /* @__PURE__ */ new Map();
			for (const card of cards) for (const tag of card.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
			return [...counts.entries()].map(([tag, count]) => ({
				tag,
				count
			})).sort((left, right) => right.count - left.count || compareText(left.tag, right.tag));
		}
		/**
		* How many done cards one page step shows.
		* @param total - matching done cards.
		* @param pages - 1-based page count (the page starts at 1 and grows by one click).
		*/
		function doneVisibleCount(total, pages) {
			return Math.min(total, (Number.isFinite(pages) ? Math.max(1, Math.trunc(pages)) : 1) * 20);
		}
		/**
		* Is the done window in force? A query or a tag narrows the board, and then the
		* matching done cards are all shown: a search result that still hides its hit
		* behind "load more" is not a search result.
		* @param filters - current filter state.
		*/
		function doneWindowActive(filters) {
			return filters.query.trim() === "" && filters.tag === void 0;
		}
		/**
		* Build the render model: order, filter, group, then window the done column.
		* @param cards - the cards as served by the host route.
		* @param filters - current filter state.
		* @param pages - done-column page count (ignored while a filter narrows the board).
		*/
		function buildBoardView(cards, filters, pages) {
			const matching = filterCards(sortCards(cards), filters);
			const groups = {
				todo: [],
				in_progress: [],
				done: []
			};
			for (const card of matching) groups[card.status].push(card);
			const totals = {
				todo: groups.todo.length,
				in_progress: groups.in_progress.length,
				done: groups.done.length
			};
			const visible = doneWindowActive(filters) ? doneVisibleCount(totals.done, pages) : totals.done;
			const doneHidden = totals.done - visible;
			if (doneHidden > 0) groups.done = groups.done.slice(0, visible);
			return {
				groups,
				totals,
				doneHidden,
				tags: collectTags(cards),
				narrowed: filters.query.trim() !== "" || filters.tag !== void 0
			};
		}
		//#endregion
		//#region src/client/BoardPage.tsx
		/**
		* The kanban board page: the keyed occupant of the global "main" panel
		* (sidebar.panellist entry + main slot) — not an overlay of its own.
		*
		* Reads the workspace's KANBAN.json through the host webServer route
		* (GET/POST /kanban/api) and renders three columns (todo / in_progress / done)
		* with per-card status moves, delete, and an add composer. Interactive controls
		* use @deepseek-ai/dsh-client-ui-primitives (Button, Input, Menu, Pill, icons)
		* so the page matches the native DSH look; only layout lives in the plugin's
		* own token-based styles.
		*/
		/** The columns, in render order (the view model owns the ordering rules). */
		const STATUSES = STATUS_ORDER;
		/** The status chips of the filter bar, including the "every column" option. */
		const STATUS_FILTERS = ["all", ...STATUS_ORDER];
		/** Status label for a board status (locale-aware). */
		function statusLabel(status, t) {
			if (status === "todo") return t("statusTodo");
			if (status === "in_progress") return t("statusInProgress");
			return t("statusDone");
		}
		/** Compact local timestamp (YYYY-MM-DD HH:mm) for card meta lines. */
		function formatTime(epochMs) {
			const date = new Date(epochMs);
			const pad = (n) => String(n).padStart(2, "0");
			return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}
		/**
		* Which of the three what/why/rejected fields a card is missing — a local
		* mirror of the host's missingCardFields (kept here so the client bundle never
		* imports the node-side board-core): every card needs rationale (why); a done
		* card must carry all three so the next session can pick it up without asking.
		*/
		function missingCardFields(card) {
			const missing = [];
			if (card.rationale === void 0 || card.rationale.trim() === "") missing.push("rationale");
			if (card.status === "done") {
				if (card.summary === void 0 || card.summary.trim() === "") missing.push("summary");
				if (card.rejected === void 0 || card.rejected.trim() === "") missing.push("rejected");
			}
			return missing;
		}
		/** Localized field label for a quality-field name. */
		function qualityFieldLabel(field, t) {
			if (field === "summary") return t("fieldSummary");
			if (field === "rationale") return t("fieldRationale");
			return t("fieldRejected");
		}
		/** Second-resolution timestamp for the header's live auto-refresh indicator. */
		function formatTimeWithSeconds(epochMs) {
			const date = new Date(epochMs);
			const pad = (n) => String(n).padStart(2, "0");
			return `${formatTime(epochMs)}:${pad(date.getSeconds())}`;
		}
		/** The board page component (the board global panel's `main`-slot occupant). */
		function BoardPage({ api, workspace, workspaces, onClose, t, openSession }) {
			const [cards, setCards] = (0, react.useState)([]);
			const [path, setPath] = (0, react.useState)(void 0);
			const [loading, setLoading] = (0, react.useState)(true);
			const [error, setError] = (0, react.useState)(void 0);
			const [lastUpdated, setLastUpdated] = (0, react.useState)(void 0);
			const [draftTitle, setDraftTitle] = (0, react.useState)("");
			const [draftSummary, setDraftSummary] = (0, react.useState)("");
			const [draftRationale, setDraftRationale] = (0, react.useState)("");
			const [draftRejected, setDraftRejected] = (0, react.useState)("");
			const [archivedNotice, setArchivedNotice] = (0, react.useState)(void 0);
			const [workspacePickerOpen, setWorkspacePickerOpen] = (0, react.useState)(false);
			const [query, setQuery] = (0, react.useState)("");
			const [statusFilter, setStatusFilter] = (0, react.useState)("all");
			const [tagFilter, setTagFilter] = (0, react.useState)(void 0);
			const [donePages, setDonePages] = (0, react.useState)(1);
			const [selectedWorkspace, setSelectedWorkspace] = (0, react.useState)(workspace);
			const lastSignature = (0, react.useRef)(null);
			const requestSeq = (0, react.useRef)(0);
			const cwdRef = (0, react.useRef)(void 0);
			const cwd = selectedWorkspace?.cwd;
			cwdRef.current = cwd;
			const refresh = (0, react.useCallback)(async (opts) => {
				if (cwd === void 0) return;
				const seq = ++requestSeq.current;
				const silent = opts?.silent ?? false;
				if (!silent) {
					setLoading(true);
					setError(void 0);
				}
				try {
					const board = await api.get(cwd);
					if (seq !== requestSeq.current) return;
					const sorted = sortCards(board.cards);
					const signature = JSON.stringify(sorted);
					setLastUpdated(Date.now());
					if (silent && lastSignature.current === signature) return;
					lastSignature.current = signature;
					setCards(sorted);
					setPath(board.path);
				} catch (cause) {
					if (!silent) setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					if (!silent) setLoading(false);
				}
			}, [api, cwd]);
			(0, react.useEffect)(() => {
				lastSignature.current = null;
				setArchivedNotice(void 0);
				setQuery("");
				setStatusFilter("all");
				setTagFilter(void 0);
				setDonePages(1);
				refresh();
			}, [refresh]);
			(0, react.useEffect)(() => {
				const timer = setInterval(() => {
					refresh({ silent: true });
				}, 15e3);
				return () => clearInterval(timer);
			}, [refresh]);
			const applyMutation = (0, react.useCallback)(async (body) => {
				if (cwd === void 0) return false;
				setError(void 0);
				try {
					const board = await api.mutate({
						...body,
						cwd
					});
					if (cwdRef.current !== cwd) return false;
					setCards(sortCards(board.cards));
					setPath(board.path);
					setArchivedNotice(board.archived);
					return true;
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
					return false;
				}
			}, [api, cwd]);
			const addCard = (0, react.useCallback)(() => {
				const title = draftTitle.trim();
				if (title === "" || cwd === void 0) return;
				(async () => {
					if (!await applyMutation({
						op: "add",
						title,
						...draftSummary.trim() !== "" ? { summary: draftSummary.trim() } : {},
						...draftRationale.trim() !== "" ? { rationale: draftRationale.trim() } : {},
						...draftRejected.trim() !== "" ? { rejected: draftRejected.trim() } : {}
					})) return;
					setDraftTitle("");
					setDraftSummary("");
					setDraftRationale("");
					setDraftRejected("");
				})();
			}, [
				applyMutation,
				cwd,
				draftTitle,
				draftSummary,
				draftRationale,
				draftRejected
			]);
			const moveCard = (0, react.useCallback)((id, status) => {
				applyMutation({
					op: "update",
					id,
					status
				});
			}, [applyMutation]);
			const removeCard = (0, react.useCallback)((id) => {
				applyMutation({
					op: "remove",
					id
				});
			}, [applyMutation]);
			const filters = (0, react.useMemo)(() => ({
				query,
				status: statusFilter,
				tag: tagFilter
			}), [
				query,
				statusFilter,
				tagFilter
			]);
			const view = (0, react.useMemo)(() => buildBoardView(cards, filters, donePages), [
				cards,
				filters,
				donePages
			]);
			(0, react.useEffect)(() => {
				setDonePages(1);
			}, [
				query,
				statusFilter,
				tagFilter
			]);
			const toggleTag = (0, react.useCallback)((tag) => {
				setTagFilter((current) => current === tag ? void 0 : tag);
			}, []);
			const clearFilters = (0, react.useCallback)(() => {
				setQuery("");
				setStatusFilter("all");
				setTagFilter(void 0);
			}, []);
			const columns = statusFilter === "all" ? STATUSES : [statusFilter];
			const visibleMatches = columns.reduce((total, status) => total + view.totals[status], 0);
			if (selectedWorkspace === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "kb-panel",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BoardHeader, {
					onClose,
					t
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "kb-body",
					children: workspaces.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkspacePicker, {
						workspaces,
						selected: void 0,
						open: workspacePickerOpen,
						onToggle: () => setWorkspacePickerOpen((v) => !v),
						onSelect: (ws) => {
							setSelectedWorkspace(ws);
							setWorkspacePickerOpen(false);
						},
						t
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "kb-empty",
						children: t("noWorkspace")
					})
				})]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "kb-panel",
				"data-testid": "kanban-page",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BoardHeader, {
					onClose,
					t,
					path,
					lastUpdated,
					onRefresh: () => {
						refresh();
					}
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "kb-body",
					children: [
						workspaces.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkspacePicker, {
							workspaces,
							selected: selectedWorkspace,
							open: workspacePickerOpen,
							onToggle: () => setWorkspacePickerOpen((v) => !v),
							onSelect: (ws) => {
								setSelectedWorkspace(ws);
								setWorkspacePickerOpen(false);
							},
							t
						}),
						error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "kb-error",
							children: error
						}),
						archivedNotice !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "kb-archived",
							children: t("archivedNotice", {
								count: String(archivedNotice.count),
								path: archivedNotice.path
							})
						}),
						loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "kb-loading",
							children: t("loading")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "kb-toolbar",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
										className: "kb-toolbar-search",
										value: query,
										placeholder: t("searchPlaceholder"),
										"aria-label": t("searchPlaceholder"),
										onChange: (event) => setQuery(event.target.value)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "kb-toolbar-filters",
										role: "group",
										"aria-label": t("filterStatusLabel"),
										children: STATUS_FILTERS.map((filter) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
											active: statusFilter === filter,
											onClick: () => setStatusFilter(filter),
											children: filter === "all" ? t("filterAll") : statusLabel(filter, t)
										}, filter))
									}),
									tagFilter !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
										active: true,
										onClick: () => toggleTag(tagFilter),
										title: t("filterClearTag"),
										children: [
											"#",
											tagFilter,
											" ×"
										]
									}),
									(view.narrowed || statusFilter !== "all") && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "ghost",
										size: "sm",
										onClick: clearFilters,
										children: t("filterClear")
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: `kb-columns${statusFilter === "all" ? "" : " kb-columns-single"}`,
								children: columns.map((status) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: "kb-column",
									"data-status": status,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "kb-column-head",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `kb-dot kb-dot-${status}` }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
													className: "kb-column-title",
													children: statusLabel(status, t)
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "kb-column-count",
													children: t("counts", { n: String(view.totals[status]) })
												})
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "kb-column-cards",
											children: view.groups[status].map((card) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Card, {
												card,
												t,
												onMove: moveCard,
												onRemove: removeCard,
												onOpenSession: openSession,
												onTagClick: toggleTag,
												activeTag: tagFilter
											}, card.id))
										}),
										status === "done" && view.totals.done > 20 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "kb-column-foot",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: "kb-column-foot-note",
												children: t("doneShowing", {
													shown: String(view.groups.done.length),
													total: String(view.totals.done)
												})
											}), view.doneHidden > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
												variant: "outline",
												size: "sm",
												onClick: () => setDonePages((pages) => pages + 1),
												children: t("loadMore", { n: String(view.doneHidden) })
											})]
										})
									]
								}, status))
							}),
							cards.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "kb-empty",
								children: t("empty")
							}),
							cards.length > 0 && visibleMatches === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "kb-empty",
								children: t("noMatches")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "kb-composer",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "kb-composer-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
										className: "kb-composer-field",
										value: draftTitle,
										placeholder: t("addPlaceholder"),
										onChange: (event) => setDraftTitle(event.target.value),
										onKeyDown: (event) => {
											if (event.key !== "Enter") return;
											const native = event.nativeEvent;
											if (native.isComposing || native.keyCode === 229) return;
											addCard();
										},
										"aria-label": t("addPlaceholder")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "primary",
										size: "md",
										icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutlineRegular, {}),
										disabled: draftTitle.trim() === "",
										onClick: addCard,
										children: t("add")
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "kb-composer-fields",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: "kb-composer-field-col",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "kb-composer-field-label",
												children: t("fieldSummary")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
												className: "kb-composer-field-input",
												rows: 3,
												value: draftSummary,
												placeholder: t("addSummaryPlaceholder"),
												onChange: (event) => setDraftSummary(event.target.value)
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: "kb-composer-field-col",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "kb-composer-field-label",
												children: t("fieldRationale")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
												className: "kb-composer-field-input",
												rows: 3,
												value: draftRationale,
												placeholder: t("addRationalePlaceholder"),
												onChange: (event) => setDraftRationale(event.target.value)
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: "kb-composer-field-col",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "kb-composer-field-label",
												children: t("fieldRejected")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
												className: "kb-composer-field-input",
												rows: 3,
												value: draftRejected,
												placeholder: t("addRejectedPlaceholder"),
												onChange: (event) => setDraftRejected(event.target.value)
											})]
										})
									]
								})]
							}),
							cwd !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(NoteSpecEditor, {
								api,
								cwd,
								t
							})
						] })
					]
				})]
			});
		}
		/** The Agent Note spec editor: editable overrides + upstream source + update warning. */
		function NoteSpecEditor(props) {
			const { api, cwd, t } = props;
			const [open, setOpen] = (0, react.useState)(false);
			const [spec, setSpec] = (0, react.useState)(void 0);
			const [classesDraft, setClassesDraft] = (0, react.useState)("");
			const [formatDraft, setFormatDraft] = (0, react.useState)("");
			const [definitionDraft, setDefinitionDraft] = (0, react.useState)("");
			const [saved, setSaved] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(void 0);
			const load = (0, react.useCallback)(async () => {
				try {
					const view = await api.getSpec(cwd);
					setSpec(view);
					setClassesDraft(view.noteClasses.join(", "));
					setFormatDraft(view.noteFormat);
					setDefinitionDraft(view.nonTrivialDefinition);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			}, [api, cwd]);
			(0, react.useEffect)(() => {
				if (open) load();
			}, [open, load]);
			const save = (0, react.useCallback)(async () => {
				setError(void 0);
				setSaved(false);
				try {
					const classes = classesDraft.split(",").map((s) => s.trim()).filter((s) => s !== "");
					const view = await api.setSpec(cwd, {
						noteClasses: classes,
						noteFormat: formatDraft,
						nonTrivialDefinition: definitionDraft,
						acknowledgeSpecVersion: spec?.pluginSpecVersion
					});
					setSpec(view);
					setSaved(true);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			}, [
				api,
				cwd,
				classesDraft,
				formatDraft,
				definitionDraft,
				spec?.pluginSpecVersion
			]);
			const reset = (0, react.useCallback)(async () => {
				setError(void 0);
				setSaved(false);
				try {
					const view = await api.setSpec(cwd, {
						noteClasses: [],
						noteFormat: "",
						nonTrivialDefinition: "",
						acknowledgeSpecVersion: spec?.pluginSpecVersion
					});
					setSpec(view);
					setClassesDraft(view.noteClasses.join(", "));
					setFormatDraft(view.noteFormat);
					setDefinitionDraft(view.nonTrivialDefinition);
					setSaved(true);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			}, [
				api,
				cwd,
				spec?.pluginSpecVersion
			]);
			const needsUpdateWarning = spec !== void 0 && spec.hasOverrides && spec.specVersion !== spec.pluginSpecVersion;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "kb-spec",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "kb-spec-toggle",
					onClick: () => setOpen((v) => !v),
					"aria-expanded": open,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("specTitle") }), spec !== void 0 && spec.hasOverrides && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "kb-spec-active",
						children: t("specOverrideActive")
					})]
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "kb-spec-body",
					children: [
						needsUpdateWarning && spec !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "kb-spec-warning",
							children: t("specUpdateWarning", {
								plugin: String(spec.pluginSpecVersion),
								current: String(spec.specVersion)
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "kb-spec-intro",
							children: t("specIntro")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: "kb-spec-label",
							children: [
								t("specClassesLabel"),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									className: "kb-spec-input",
									rows: 2,
									value: classesDraft,
									onChange: (event) => setClassesDraft(event.target.value)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "kb-spec-source",
									children: t("specClassesSource")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: "kb-spec-label",
							children: [
								t("specFormatLabel"),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									className: "kb-spec-input kb-spec-monospace",
									rows: 8,
									value: formatDraft,
									onChange: (event) => setFormatDraft(event.target.value)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "kb-spec-source",
									children: t("specFormatSource")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: "kb-spec-label",
							children: [
								t("specDefinitionLabel"),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									className: "kb-spec-input",
									rows: 4,
									value: definitionDraft,
									onChange: (event) => setDefinitionDraft(event.target.value)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "kb-spec-source",
									children: t("specDefinitionSource")
								})
							]
						}),
						error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "kb-error",
							children: error
						}),
						saved && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "kb-spec-saved",
							children: t("specSaved")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "kb-spec-actions",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "primary",
								size: "sm",
								onClick: () => {
									save();
								},
								children: t("specSave")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "ghost",
								size: "sm",
								onClick: () => {
									reset();
								},
								children: t("specReset")
							})]
						}),
						spec !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "kb-spec-source",
							children: t("specOverridesFile", { path: spec.overridesPath })
						})
					]
				})]
			});
		}
		/** Workspace switcher: a Menu listing every registered workspace, with the current one highlighted. */
		function WorkspacePicker(props) {
			const { workspaces, selected, open, onToggle, onSelect, t } = props;
			const items = workspaces.map((ws) => ({
				id: ws.workspaceId,
				label: ws.title
			}));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
				open,
				onClose: onToggle,
				items,
				selectedId: selected?.workspaceId,
				onSelect: (id) => {
					const ws = workspaces.find((w) => w.workspaceId === id);
					if (ws !== void 0) onSelect(ws);
				},
				align: "start",
				portal: true,
				anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "kb-workspace-picker",
					"aria-haspopup": "menu",
					"aria-expanded": open,
					onClick: onToggle,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "kb-workspace-label",
						children: [t("workspaceLabel"), ":"]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "kb-workspace-trigger",
						children: [selected?.title ?? t("workspaceChoose"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, {})]
					})]
				})
			});
		}
		/** One card row: title, the what/why/rejected fields, tags, then an action row
		* (source session + status + delete pinned right). The title + description +
		* the three what/why/rejected fields form the clickable region that opens the
		* detail dialog; the action row is deliberately outside it. */
		const Card = (0, react.memo)(function Card(props) {
			const { card, t, onMove, onRemove, onOpenSession, onTagClick, activeTag } = props;
			const [statusOpen, setStatusOpen] = (0, react.useState)(false);
			const [confirmDelete, setConfirmDelete] = (0, react.useState)(false);
			const [detailOpen, setDetailOpen] = (0, react.useState)(false);
			const statusItems = STATUSES.map((status) => ({
				id: status,
				label: statusLabel(status, t)
			}));
			const fields = [
				[t("fieldSummary"), card.summary],
				[t("fieldRationale"), card.rationale],
				[t("fieldRejected"), card.rejected]
			];
			const missing = missingCardFields(card);
			const openDetail = (0, react.useCallback)(() => setDetailOpen(true), []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
				className: "kb-card",
				"data-card-id": card.id,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						role: "button",
						tabIndex: 0,
						"aria-label": `${card.title} — ${t("detailHint")}`,
						"aria-haspopup": "dialog",
						className: "kb-card-hit",
						onClick: openDetail,
						onKeyDown: (event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								openDetail();
							}
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h4", {
								className: "kb-card-title",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "kb-card-title-text",
									children: card.title
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconInspectOutlineRegular, { className: "kb-card-detail-icon" })]
							}),
							card.description !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "kb-card-desc",
								children: card.description
							}),
							fields.some(([, value]) => value !== void 0) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "kb-card-fields",
								children: fields.map(([label, value]) => value !== void 0 && value !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: "kb-card-field",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "kb-card-field-label",
											children: [label, ":"]
										}),
										" ",
										value
									]
								}, label))
							}),
							missing.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: "kb-card-missing",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutlineRegular, {}), t("missingFields", { fields: missing.map((field) => qualityFieldLabel(field, t)).join("、") })]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "kb-card-actions",
						children: [card.tags.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "kb-card-meta",
							children: card.tags.map((tag) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
								active: activeTag === tag,
								onClick: () => onTagClick(tag),
								title: t("filterByTag", { tag }),
								children: tag
							}, tag))
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "kb-card-row",
							children: [
								card.sourceSessionId !== void 0 && onOpenSession !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: "kb-source-btn",
									onClick: () => onOpenSession(card.sourceSessionId),
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconQueueOutlineRegular, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("sourceSession") })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
									open: statusOpen,
									onClose: () => {
										setStatusOpen(false);
									},
									items: statusItems,
									selectedId: card.status,
									onSelect: (id) => {
										onMove(card.id, id);
										setStatusOpen(false);
									},
									align: "start",
									portal: true,
									anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										size: "sm",
										"aria-haspopup": "menu",
										"aria-expanded": statusOpen,
										onClick: () => {
											setStatusOpen((v) => !v);
										},
										children: statusLabel(card.status, t)
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "ghost",
									size: "sm",
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutlineRegular, {}),
									"aria-label": t("remove"),
									onClick: () => setConfirmDelete(true),
									className: "kb-trash-btn"
								})
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: confirmDelete,
						onClose: () => setConfirmDelete(false),
						title: t("deleteTitle"),
						closeLabel: t("deleteCancel"),
						description: t("deleteConfirm", { title: card.title }),
						footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							size: "sm",
							onClick: () => setConfirmDelete(false),
							children: t("deleteCancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							size: "sm",
							icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutlineRegular, {}),
							onClick: () => {
								onRemove(card.id);
								setConfirmDelete(false);
							},
							children: t("deleteConfirmAction")
						})] })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CardDetail, {
						card,
						t,
						open: detailOpen,
						onClose: () => setDetailOpen(false),
						onOpenSession
					})
				]
			});
		});
		/**
		* The card detail dialog: a reading-friendly, pre-formatted view of one card.
		* Shows the title with status/tags, then the description and each of the three
		* what/why/rejected fields as labeled sections with full (newline-preserving)
		* content, plus the source session and created/updated times. Headless modal —
		* the plugin owns its header chrome so the body can scroll independently.
		*/
		function CardDetail(props) {
			const { card, t, open, onClose, onOpenSession } = props;
			const present = [
				{
					label: t("fieldSummary"),
					value: card.summary,
					icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconGoalOutlineRegular, {})
				},
				{
					label: t("fieldRationale"),
					value: card.rationale,
					icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconThinkOutlineRegular, {})
				},
				{
					label: t("fieldRejected"),
					value: card.rejected,
					icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutlineRegular, {})
				}
			].filter((section) => section.value !== void 0 && section.value !== "");
			const hasDescription = card.description !== void 0 && card.description !== "";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open,
				onClose,
				title: card.title,
				headless: true,
				className: "kb-detail-modal",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "kb-detail",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "kb-detail-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "kb-detail-head-text",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								className: "kb-detail-title",
								children: card.title
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "kb-detail-meta",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "kb-detail-status",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `kb-dot kb-dot-${card.status}` }), statusLabel(card.status, t)]
								}), card.tags.map((tag) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
									active: true,
									children: tag
								}, tag))]
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "kb-detail-close",
							"aria-label": t("close"),
							onClick: onClose,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseOutlineRegular, { size: 14 })
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "kb-detail-scroll",
						children: [
							hasDescription && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: "kb-detail-block",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "kb-detail-block-label",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconListPenOutlineRegular, {}), t("fieldDescription")]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "kb-detail-block-body",
									children: card.description
								})]
							}),
							present.map((section) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: "kb-detail-block",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "kb-detail-block-label",
									children: [section.icon, section.label]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "kb-detail-block-body",
									children: section.value
								})]
							}, section.label)),
							!hasDescription && present.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "kb-detail-empty",
								children: t("detailEmpty")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "kb-detail-foot",
								children: [card.sourceSessionId !== void 0 && onOpenSession !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: "kb-source-btn",
									onClick: () => onOpenSession(card.sourceSessionId),
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconQueueOutlineRegular, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("sourceSession") })]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "kb-detail-times",
									children: [t("detailCreated", { time: formatTime(card.createdAt) }), card.updatedAt !== card.createdAt && ` · ${t("detailUpdated", { time: formatTime(card.updatedAt) })}`]
								})]
							})
						]
					})]
				})
			});
		}
		/** Shared header strip of the board panel (native DSH ghost buttons). */
		function BoardHeader(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
				className: "kb-header",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: "kb-header-title",
						children: props.t("title")
					}), props.path !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "kb-header-sub",
						children: [
							props.t("pathLabel"),
							": ",
							props.path,
							props.lastUpdated !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" · ", props.t("autoUpdatedAt", { time: formatTimeWithSeconds(props.lastUpdated) })] })
						]
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "kb-header-spacer" }),
					props.onRefresh !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "ghost",
						size: "md",
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutlineRegular, {}),
						onClick: props.onRefresh,
						children: props.t("refresh")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "ghost",
						size: "md",
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronLeftOutlineRegular, {}),
						onClick: props.onClose,
						children: props.t("backToChat")
					})
				]
			});
		}
		//#endregion
		//#region src/client/workspace-pick.ts
		/**
		* Resolve the Session currently on stage (the main view's occupant), or
		* undefined when none is — a global panel is open, or the list is still empty.
		* @param sessions - the `useSessions`/`ctx.sessions.list` snapshot, or undefined when absent.
		* @returns the current session id, or undefined.
		*/
		function currentSessionId(sessions) {
			if (sessions === void 0) return void 0;
			const legacy = sessions.current;
			if (typeof legacy === "string" && legacy !== "") return legacy;
			const byId = sessions.byId;
			if (byId === void 0) return void 0;
			for (const [sessionId, summary] of Object.entries(byId)) if ((summary.retainedBy?.mainView ?? 0) > 0) return sessionId;
		}
		/** Pick the most-recently-active workspace id, or undefined when empty. */
		function recentWorkspaceId(items, byId) {
			let selected;
			let selectedTime = Number.NEGATIVE_INFINITY;
			for (const workspace of items) {
				let latest = Number.NEGATIVE_INFINITY;
				for (const sessionId of workspace.sessionIds ?? []) {
					const session = byId?.[sessionId];
					if (session !== void 0 && typeof session.updatedAt === "number") latest = Math.max(latest, session.updatedAt);
				}
				if (latest === Number.NEGATIVE_INFINITY && workspace.createdAt !== void 0) {
					const parsed = Date.parse(workspace.createdAt);
					if (!Number.isNaN(parsed)) latest = parsed;
				}
				if (selected === void 0 || latest > selectedTime) {
					selected = workspace.workspaceId;
					selectedTime = latest;
				}
			}
			return selected;
		}
		//#endregion
		//#region src/client/KanbanSurface.tsx
		/**
		* Sidebar global-panel glyph and the panel wrapper for the board page.
		*
		* Kept in a `.tsx` file so the browser bundle can parse JSX; the plugin entry
		* (src/client/index.ts) stays plain TypeScript and imports these. The board is
		* a DSH "global panel" (DSH ≥ 0.1.6): the sidebar renders the panel row — icon,
		* label, tooltip, selected tint — from the `sidebar.panellist` registration,
		* and the frame renders this file's page component in the `main` column while
		* that panel is selected. Nothing here draws its own button or overlay chrome.
		*/
		/**
		* Sidebar glyph for the board panel: the checklist icon at the size the
		* sidebar asks for, plus the open-item count badge (same count the old footer
		* entry showed, from the /kanban/counts poll).
		*/
		function KanbanPanelIcon(props) {
			const { open } = (0, react.useSyncExternalStore)(subscribeCounts, getCountsSnapshot);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "kb-panel-icon",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChecklistOutlineRegular, { size: props.size }), open > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "kb-panel-badge",
					title: `${open} open`,
					children: open > 99 ? "99+" : String(open)
				})]
			});
		}
		/**
		* The `main` panel occupant: the frame renders it only while the board panel is
		* selected, so it needs no visibility gate of its own.
		*/
		function KanbanPanel(props) {
			const { all, current } = resolveWorkspaces(props.useSessions?.((s) => s) ?? {}, props.useWorkspaces?.((s) => s) ?? {});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BoardPage, {
				api: props.api,
				workspace: current,
				workspaces: all,
				onClose: props.onClose,
				t: props.t,
				openSession: props.openSession
			});
		}
		/**
		* Build the full workspace list plus the default (current-session) workspace
		* from the framework seats. Default: the current session's cwd, then the most
		* recently active workspace, then the first workspace. The list drives the
		* board page's workspace switcher. The current Session is resolved through
		* {@link currentSessionId}, which covers both DSH selection eras (list-snapshot
		* `current` up to 0.1.5, main-view retention from 0.1.6-alpha.2 on).
		*/
		function resolveWorkspaces(sessionList, workspaceList) {
			const items = workspaceList.items ?? [];
			const all = items.map((item) => ({
				workspaceId: item.workspaceId,
				cwd: item.path,
				title: item.title ?? item.path
			}));
			const current = currentSessionId(sessionList);
			if (current !== void 0) {
				const cwd = sessionList.byId?.[current]?.cwd;
				if (cwd !== void 0 && cwd !== "") {
					const base = cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? cwd;
					return {
						all,
						current: all.find((ws) => ws.cwd === cwd) ?? {
							workspaceId: cwd,
							cwd,
							title: base
						}
					};
				}
			}
			const recentId = recentWorkspaceId(items, sessionList.byId);
			return {
				all,
				current: all.find((ws) => ws.workspaceId === recentId) ?? all[0]
			};
		}
		//#endregion
		//#region src/client/locales.ts
		/** Copy dictionaries for the dsh-kanban board page (Smoothly Kanban / 思磨力看板). */
		/** English strings (the key-set source of truth for this pair). */
		const en = {
			nav: "Smoothly Kanban",
			title: "Smoothly Kanban",
			intro: "Cross-session plans and todos, persisted to KANBAN.json at the workspace root.",
			pathLabel: "Board file",
			close: "Close",
			backToChat: "Back to conversation",
			loading: "Loading…",
			empty: "No cards yet. Ask the model to board_add a plan step, or add one below.",
			addPlaceholder: "New card title…",
			addSummaryPlaceholder: "optional",
			addRationalePlaceholder: "optional",
			addRejectedPlaceholder: "optional",
			add: "Add",
			remove: "Remove",
			statusTodo: "To do",
			statusInProgress: "In progress",
			statusDone: "Done",
			statusTooltip: "Move card",
			doneAction: "Done",
			noWorkspace: "No workspace selected. Open a session first.",
			refresh: "Refresh",
			counts: "{n}",
			fieldSummary: "What",
			fieldRationale: "Why",
			fieldRejected: "Rejected",
			specTitle: "Agent Note spec",
			specIntro: "Editable DSH Agent Note defaults. Paste newer upstream content to override; empty fields use the plugin default.",
			specClassesLabel: "Note classes (comma-separated)",
			specClassesSource: "Source: deepseek-harness scripts/agent-note-tree.ts → AGENT_NOTE_CLASSES",
			specFormatLabel: "Note body template ({{title}} {{problem}} {{decision}} {{alternatives}} {{consequences}} {{alternatives_section}} {{consequences_section}})",
			specFormatSource: "Source: deepseek-harness scripts/verify-agent-note-format.ts",
			specDefinitionLabel: "Non-trivial change definition",
			specDefinitionSource: "Source: deepseek-harness .agents/notes/README.md → \"When to write one\" (root AGENTS.md points at it)",
			specSave: "Save overrides",
			specReset: "Reset to defaults",
			specSaved: "Saved.",
			specUpdateWarning: "The plugin now ships Agent Note spec v{plugin} but this workspace has custom overrides (v{current}). Updating the plugin resets overrides to the new defaults — your custom content will be lost.",
			specOverridesFile: "Stored at {path}",
			specOverrideActive: "Custom overrides active.",
			archivedNotice: "Archived {count} done card(s) to {path}",
			sourceSession: "Open handling session",
			workspaceLabel: "Workspace",
			workspaceChoose: "Choose a workspace…",
			deleteTitle: "Delete card",
			deleteConfirm: "Delete \"{title}\"? This removes the card from KANBAN.json permanently. This cannot be undone.",
			deleteCancel: "Cancel",
			deleteConfirmAction: "Delete",
			fieldDescription: "Description",
			detailHint: "View details",
			detailCreated: "Created {time}",
			detailUpdated: "Updated {time}",
			detailEmpty: "No further details on this card.",
			autoUpdatedAt: "auto-refreshed {time}",
			missingFields: "missing: {fields}",
			searchPlaceholder: "Search cards (title, body, tags)…",
			filterAll: "All",
			filterStatusLabel: "Filter by status",
			filterByTag: "Filter by tag {tag}",
			filterClearTag: "Clear the tag filter",
			filterClear: "Clear filters",
			noMatches: "No card matches the current filters.",
			doneShowing: "showing {shown} of {total}",
			loadMore: "Load more ({n} more)"
		};
		/** Chinese strings (same keys as {@link en}). */
		const zh = {
			nav: "思磨力看板",
			title: "思磨力看板",
			intro: "跨会话的计划与待办，持久化到工作区根目录的 KANBAN.json。",
			pathLabel: "看板文件",
			close: "关闭",
			backToChat: "返回会话",
			loading: "加载中…",
			empty: "还没有卡片。可以让模型用 board_add 记录计划步骤，或在下方面板新增。",
			addPlaceholder: "新卡片标题…",
			addSummaryPlaceholder: "可选",
			addRationalePlaceholder: "可选",
			addRejectedPlaceholder: "可选",
			add: "新增",
			remove: "删除",
			statusTodo: "待办",
			statusInProgress: "进行中",
			statusDone: "已完成",
			statusTooltip: "移动卡片",
			doneAction: "完成",
			noWorkspace: "尚未选择工作区。请先打开一个会话。",
			refresh: "刷新",
			counts: "{n}",
			fieldSummary: "做了什么",
			fieldRationale: "为什么",
			fieldRejected: "放弃了什么",
			specTitle: "Agent Note 规范",
			specIntro: "可编辑的 DSH Agent Note 默认值。粘贴更新的上游内容即可覆盖；留空使用插件默认。",
			specClassesLabel: "笔记分类（逗号分隔）",
			specClassesSource: "来源：deepseek-harness scripts/agent-note-tree.ts → AGENT_NOTE_CLASSES",
			specFormatLabel: "笔记正文模板（{{title}} {{problem}} {{decision}} {{alternatives}} {{consequences}} {{alternatives_section}} {{consequences_section}}）",
			specFormatSource: "来源：deepseek-harness scripts/verify-agent-note-format.ts",
			specDefinitionLabel: "非平凡变更定义",
			specDefinitionSource: "来源：deepseek-harness .agents/notes/README.md → \"When to write one\"（根 AGENTS.md 只留一行指针）",
			specSave: "保存覆盖",
			specReset: "恢复默认",
			specSaved: "已保存。",
			specUpdateWarning: "插件现已内置 Agent Note 规范 v{plugin}，但此工作区有自定义覆盖（v{current}）。更新插件会把覆盖重置为新默认值——你自定义的内容会丢失。",
			specOverridesFile: "存储于 {path}",
			specOverrideActive: "自定义覆盖生效中。",
			archivedNotice: "已归档 {count} 张已完成卡片到 {path}",
			sourceSession: "打开处理会话",
			workspaceLabel: "工作区",
			workspaceChoose: "选择工作区…",
			deleteTitle: "删除卡片",
			deleteConfirm: "确定删除「{title}」吗？这会把卡片从 KANBAN.json 永久移除，无法撤销。",
			deleteCancel: "取消",
			deleteConfirmAction: "删除",
			fieldDescription: "描述",
			detailHint: "查看详情",
			detailCreated: "创建于 {time}",
			detailUpdated: "更新于 {time}",
			detailEmpty: "这张卡片没有更多详情。",
			autoUpdatedAt: "自动更新于 {time}",
			missingFields: "缺字段：{fields}",
			searchPlaceholder: "搜索卡片（标题、正文、标签）…",
			filterAll: "全部",
			filterStatusLabel: "按状态过滤",
			filterByTag: "按标签 {tag} 过滤",
			filterClearTag: "清除标签过滤",
			filterClear: "清除过滤",
			noMatches: "没有符合当前过滤条件的卡片。",
			doneShowing: "显示 {shown} / {total}",
			loadMore: "加载更多（还有 {n} 张）"
		};
		//#endregion
		//#region src/client/styles.ts
		/**
		* Design-token styles for the kanban board page (external plugin, no CSS
		* modules available). Re-declared against the official `--dsw-alias-*`
		* semantic tokens, namespaced under `kb-` to avoid collisions. Tokens carry
		* no fallback because the host theme always defines them on the app root.
		*
		* Layout and structure only: interactive controls (buttons, inputs, menus)
		* come from @deepseek-ai/dsh-client-ui-primitives so they match the native
		* DSH look.
		*/
		const KANBAN_STYLES = `
/* Global-panel glyph: the sidebar owns the panel row (button, label, tooltip,
   selected tint); this only draws the icon plus the open-item badge. */
.kb-panel-icon {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.kb-panel-badge {
  position: absolute;
  top: -6px; right: -8px;
  min-width: 14px; height: 14px;
  padding: 0 3px;
  display: inline-flex; align-items: center; justify-content: center;
  box-sizing: border-box;
  border-radius: 7px;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
  font-size: 9px; line-height: 14px; font-weight: 600;
  pointer-events: none;
}
/* The board page is the 'main' global panel's occupant: it fills the centre
   column (no overlay positioning, no z-index — the frame sizes it). */
.kb-panel {
  display: flex; flex-direction: column;
  height: 100%; min-height: 0;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
}
.kb-header {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  flex: none;
}
.kb-header-title { margin: 0; font-size: 16px; line-height: 24px; }
.kb-header-sub { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.kb-header-spacer { flex: 1; }
.kb-body { flex: 1; overflow: auto; padding: 20px; }
/* Workspace switcher strip at the top of the board body: a clearly clickable
   grey capsule (hover darkens) so users can see it opens a menu. */
.kb-workspace-picker {
  display: inline-flex; align-items: center; gap: 8px;
  margin: 0 0 16px;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
  transition: background 120ms ease;
}
.kb-workspace-picker:hover { background: var(--dsw-alias-interactive-bg-hover); }
.kb-workspace-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.kb-workspace-picker .kb-workspace-trigger {
  font-size: 13px; line-height: 18px;
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
  display: inline-flex; align-items: center; gap: 6px;
}
.kb-workspace-trigger svg { flex: none; }
.kb-board-path {
  margin: 0 0 16px; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-markdown-code-font-family, var(--ds-font-family-code, ui-monospace, SFMono-Regular, monospace));
  word-break: break-all;
}
.kb-columns {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px; align-items: start;
}
.kb-column {
  display: flex; flex-direction: column; gap: 10px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  padding: 12px; min-height: 120px;
  background: var(--dsw-alias-bg-module-platform);
}
/* The card list under the column header: at most ~3.5 rows visible, then
   scrolls. The header stays fixed; only the cards area scrolls. */
.kb-column-cards {
  display: flex; flex-direction: column; gap: 10px;
  max-height: 350px; overflow-y: auto;
}
.kb-column-head { display: flex; align-items: center; gap: 8px; flex: none; }
/* Done-column footer: "showing 20 of 80" + the load-more step. Pinned under the
   scrolling card area so the button does not travel with the list. */
.kb-column-foot {
  display: flex; flex-direction: column; gap: 6px; align-items: stretch;
  flex: none;
  border-top: 1px solid var(--dsw-alias-border-l2);
  padding-top: 8px;
}
.kb-column-foot-note { margin: 0; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); text-align: center; }
/* Search + filter toolbar above the columns: one row that wraps on narrow
   widths. The search field grows, the chips stay at their natural size. */
.kb-toolbar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 0 0 16px;
}
.kb-toolbar-search { flex: 1 1 220px; min-width: 160px; }
.kb-toolbar-filters { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.kb-toolbar-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
/* Filtering to one status shows that column alone, full width: a 20-card page
   reads better across the panel than inside a third of it. */
.kb-columns-single { grid-template-columns: minmax(0, 1fr); }
.kb-columns-single .kb-column-cards { max-height: none; }
.kb-column-title { margin: 0; font-size: 13px; line-height: 18px; font-weight: 600; }
.kb-column-count {
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary);
}
.kb-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.kb-dot-todo { background: var(--dsw-alias-label-tertiary); }
.kb-dot-in_progress { background: var(--dsw-alias-brand-primary); }
.kb-dot-done { background: var(--dsw-alias-button-primary-fill); }
.kb-card {
  display: flex; flex-direction: column; gap: 6px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  padding: 10px 12px;
  background: var(--dsw-alias-bg-base);
}
/* The clickable content region (title + description + the three what/why/
   rejected fields) that opens the detail dialog: pointer cursor, hover tint,
   and a subtle "inspect" affordance beside the title. Keyboard reachable
   (role=button). The action row below is outside this region. */
.kb-card-hit {
  display: flex; flex-direction: column; gap: 6px;
  padding: 2px; margin: -2px;
  border-radius: 8px;
  cursor: pointer;
  outline: none;
  transition: background 120ms ease;
}
.kb-card-hit:hover,
.kb-card-hit:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover);
}
.kb-card-title {
  margin: 0; font-size: 13px; line-height: 18px;
  display: flex; align-items: baseline; gap: 6px;
}
.kb-card-title-text { flex: 1; min-width: 0; word-break: break-word; }
.kb-card-detail-icon {
  flex: none; align-self: center;
  color: var(--dsw-alias-label-tertiary);
  transition: color 120ms ease;
}
.kb-card-hit:hover .kb-card-detail-icon,
.kb-card-hit:focus-visible .kb-card-detail-icon {
  color: var(--dsw-alias-label-primary);
}
/* A card's description is clamped to two lines with an ellipsis, like the
   what/why/rejected fields below it: one real card carried a 2,528-character
   description (a ~755px card), which pushed a single row past a full screen and
   made scanning impossible. The untruncated text lives in the detail dialog. */
.kb-card-desc {
  margin: 0; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary); word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.kb-card-fields { display: flex; flex-direction: column; gap: 4px; }
/* Each what/why/rejected field is clamped to at most two lines with an
   ellipsis (webkit-line-clamp); the full text lives in the detail dialog. */
.kb-card-field {
  margin: 0; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary); word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.kb-card-field-label { color: var(--dsw-alias-label-tertiary); font-weight: 600; }
/* Incomplete-card hint: a card missing rationale (or a done card missing any
   of the three what/why/rejected fields) shows a warning line under the
   fields — same rule as the host's missingCardFields, so the Web page and the
   model-facing surfaces agree on what "incomplete" means. */
.kb-card-missing {
  margin: 0; font-size: 12px; line-height: 18px;
  display: flex; align-items: center; gap: 5px;
  color: var(--dsw-alias-state-warn-primary);
}
.kb-card-missing svg { flex: none; color: var(--dsw-alias-state-warn-primary); }
.kb-card-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
/* Card footer: tags on their own line, then one action row holding
   [source-session][status] ... [delete pinned right]. */
.kb-card-actions { display: flex; flex-direction: column; gap: 6px; }
.kb-card-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kb-source-btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 18px;
  cursor: pointer; white-space: nowrap;
}
.kb-source-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.kb-source-btn svg { flex: none; }
.kb-trash-btn { margin-left: auto; }
.kb-composer {
  display: flex; flex-direction: column; gap: 8px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  padding: 12px; margin-top: 16px;
  background: var(--dsw-alias-bg-module-platform);
}
.kb-composer-row { display: flex; gap: 8px; align-items: center; }
.kb-composer-field { flex: 1; min-width: 0; }
/* The three "what/why/rejected" inputs: one row, three equal columns — the
   same rhythm as the board column headers above. */
.kb-composer-fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  align-items: stretch;
}
.kb-composer-field-col {
  display: flex; flex-direction: column; gap: 4px;
  min-width: 0;
}
.kb-composer-field-label {
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary);
  font-weight: 600;
}
.kb-composer-field-input {
  flex: 1;
  min-height: 108px;
  box-sizing: border-box;
  resize: vertical;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  padding: 8px 10px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 18px;
}
.kb-composer-field-input:focus { outline: none; border-color: var(--dsw-alias-border-l3); }
.kb-spec {
  margin-top: 16px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  background: var(--dsw-alias-bg-module-platform);
}
.kb-spec-toggle {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  width: 100%; padding: 10px 12px; border: none; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 18px; cursor: pointer;
}
.kb-spec-toggle:hover { background: var(--dsw-alias-interactive-bg-hover); }
.kb-spec-active { color: var(--dsw-alias-button-primary-fill); font-size: 12px; }
.kb-spec-body { display: flex; flex-direction: column; gap: 12px; padding: 12px; border-top: 1px solid var(--dsw-alias-border-l2); }
.kb-spec-intro { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
/* Spec-drift warning: the shell's warn panel vocabulary (state-warn-tertiary
   fill, state-warn-label text, 20%-alpha state border) rather than a neutral
   card — the previous interactive-bg-hover-danger TEXT color was a 5%-alpha
   hover fill used as a foreground, i.e. unreadable in the light theme. */
.kb-spec-warning {
  margin: 0; padding: 8px 10px; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-state-warn-label);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-label) 20%, transparent);
  border-radius: 8px;
  background: var(--dsw-alias-state-warn-tertiary);
}
.kb-spec-label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.kb-spec-input {
  width: 100%; box-sizing: border-box; resize: vertical;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  padding: 8px 10px; background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 18px;
}
.kb-spec-input:focus { outline: none; border-color: var(--dsw-alias-border-l3); }
/* Official monospace stack: ui-theme's base.css defines --ds-font-family-code
   and exposes it as --dsw-font-markdown-code-font-family; --dsw-font-mono
   was never a DSH token, so the previous declaration silently fell through to
   the generic fallback list. */
.kb-spec-monospace { font-family: var(--dsw-font-markdown-code-font-family, var(--ds-font-family-code, ui-monospace, SFMono-Regular, monospace)); font-size: 12px; }
.kb-spec-source { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); word-break: break-word; }
.kb-spec-saved { margin: 0; font-size: 12px; color: var(--dsw-alias-button-primary-fill); }
.kb-spec-actions { display: flex; gap: 8px; }
.kb-loading, .kb-empty, .kb-error {
  padding: 24px; text-align: center; font-size: 13px; line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}
.kb-empty { border: 1px dashed var(--dsw-alias-border-l3); border-radius: 12px; }
.kb-error { color: var(--dsw-alias-state-error-primary); }
.kb-archived {
  margin: 0 0 12px; padding: 8px 12px; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l3); border-radius: 8px;
  background: var(--dsw-alias-bg-module-platform);
  word-break: break-all;
}
/* Card detail dialog (headless Modal): wider than the 380px default, with a
   fixed head (title + status/tags + close) over an independently scrolling,
   pre-formatted body. Portaled to document.body, so scope under body. */
body .kb-detail-modal { width: min(560px, 100%); }
.kb-detail { display: flex; flex-direction: column; width: 100%; }
.kb-detail-head {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 22px 14px 14px 24px;
  flex: none;
}
.kb-detail-head-text {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column; gap: 10px;
}
.kb-detail-title {
  margin: 0; font-size: 17px; line-height: 26px; font-weight: 600;
  color: var(--dsw-alias-label-primary);
  word-break: break-word; white-space: pre-wrap;
}
.kb-detail-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.kb-detail-status {
  display: inline-flex; align-items: center; gap: 6px;
  height: 20px; padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-module-platform);
  font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.kb-detail-close {
  flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px;
  border: none; border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.kb-detail-close:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.kb-detail-scroll {
  display: flex; flex-direction: column; gap: 16px;
  overflow-y: auto;
  max-height: min(56vh, 520px);
  padding: 0 24px 8px;
}
.kb-detail-block { display: flex; flex-direction: column; gap: 6px; }
.kb-detail-block-label {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; line-height: 18px; font-weight: 600;
  color: var(--dsw-alias-label-tertiary);
}
.kb-detail-block-label svg { flex: none; color: var(--dsw-alias-label-secondary); }
/* Full text with preserved line breaks, on a soft panel for comfortable
   reading; taller line-height than the card preview. */
.kb-detail-block-body {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-module-platform);
  font-size: 13px; line-height: 22px;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap; word-break: break-word;
}
.kb-detail-empty {
  margin: 0; padding: 20px; text-align: center;
  font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  border: 1px dashed var(--dsw-alias-border-l3); border-radius: 10px;
}
.kb-detail-foot {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  margin-top: 2px; padding-top: 12px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.kb-detail-times {
  font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
`;
		/**
		* Inject {@link KANBAN_STYLES} once, tagged by plugin id so re-evaluation
		* and repeated mounts stay idempotent (mirrors how the loader handles plugin
		* CSS — the same pattern dsh-model-reasoning uses).
		* @param pluginId - stable plugin id used as the style tag marker.
		*/
		function injectKanbanStyles(pluginId) {
			if (typeof document === "undefined") return;
			const selector = `style[data-dsh-plugin-css="${pluginId}"]`;
			if (document.querySelector(selector) !== null) return;
			const tag = document.createElement("style");
			tag.setAttribute("data-dsh-plugin-css", pluginId);
			tag.textContent = KANBAN_STYLES;
			document.head.appendChild(tag);
		}
		injectKanbanStyles("dsh-kanban");
		//#endregion
		//#region src/client/index.ts
		/** Dictionary namespace owned by this plugin. */
		const NS = "dsh-kanban";
		/**
		* Global-panel id: the sidebar entry's list id and the `main` slot's key must
		* be the same branded value (ui-sidebar resolves the row's label and the
		* centre column's occupant from it).
		*/
		const PANEL_ID = "kanban";
		/** Required services (cordis fiber inject). */
		const inject = [
			"slots",
			"locale",
			"sessions",
			"workspaces"
		];
		/** Build the fetch-backed board api bound to this origin. */
		function createBoardApi() {
			const endpoint = "/kanban/api";
			const specEndpoint = "/kanban/spec";
			const get = async (cwd) => {
				const response = await fetch(`${endpoint}?cwd=${encodeURIComponent(cwd)}`);
				const body = await response.json();
				if (!response.ok || body.ok !== true || body.cards === void 0) throw new Error(body.error ?? `kanban: GET failed with ${response.status}`);
				return {
					path: body.path,
					cards: body.cards,
					counts: body.counts,
					...body.archived === void 0 ? {} : { archived: body.archived }
				};
			};
			const mutate = async (payload) => {
				const response = await fetch(endpoint, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload)
				});
				const body = await response.json();
				if (!response.ok || body.ok !== true || body.cards === void 0) throw new Error(body.error ?? `kanban: POST failed with ${response.status}`);
				return {
					path: body.path,
					cards: body.cards,
					counts: body.counts,
					...body.archived === void 0 ? {} : { archived: body.archived }
				};
			};
			const getSpec = async (cwd) => {
				const response = await fetch(`${specEndpoint}?cwd=${encodeURIComponent(cwd)}`);
				const body = await response.json();
				if (!response.ok || body.ok !== true || body.specVersion === void 0) throw new Error(body.error ?? `kanban: GET /kanban/spec failed with ${response.status}`);
				return {
					specVersion: body.specVersion,
					pluginSpecVersion: body.pluginSpecVersion,
					noteClasses: body.noteClasses,
					noteFormat: body.noteFormat,
					nonTrivialDefinition: body.nonTrivialDefinition,
					hasOverrides: body.hasOverrides,
					overridesPath: body.overridesPath
				};
			};
			const setSpec = async (cwd, mutation) => {
				const response = await fetch(specEndpoint, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						cwd,
						...mutation
					})
				});
				const body = await response.json();
				if (!response.ok || body.ok !== true || body.specVersion === void 0) throw new Error(body.error ?? `kanban: POST /kanban/spec failed with ${response.status}`);
				return {
					specVersion: body.specVersion,
					pluginSpecVersion: body.pluginSpecVersion,
					noteClasses: body.noteClasses,
					noteFormat: body.noteFormat,
					nonTrivialDefinition: body.nonTrivialDefinition,
					hasOverrides: body.hasOverrides,
					overridesPath: body.overridesPath
				};
			};
			return {
				get,
				mutate,
				getSpec,
				setSpec
			};
		}
		/**
		* Browser plugin body: registers the sidebar entry and the global-panel page.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-kanban: copy dictionaries");
			const api = createBoardApi();
			const t = ctx.locale.bind(NS);
			ctx.effect(() => {
				const stop = startCountsPolling(() => {
					const sessions = ctx.get("sessions");
					let sessionBy;
					try {
						const sessionState = sessions?.list?.getSnapshot();
						const currentId = currentSessionId(sessionState);
						sessionBy = sessionState?.byId;
						const currentCwd = currentId === void 0 ? void 0 : sessionState?.byId?.[currentId]?.cwd;
						if (currentCwd !== void 0 && currentCwd !== "") return currentCwd;
					} catch {}
					const workspaces = ctx.get("workspaces");
					try {
						const items = (workspaces?.list?.getSnapshot())?.items ?? [];
						const recentId = recentWorkspaceId(items, sessionBy);
						return items.find((item) => item.workspaceId === recentId)?.path ?? items[0]?.path;
					} catch {
						return;
					}
				});
				const sessions = ctx.get("sessions");
				const workspaces = ctx.get("workspaces");
				const unsubscribeSessions = sessions?.list?.subscribe(triggerCountsPoll);
				const unsubscribeWorkspaces = workspaces?.list?.subscribe(triggerCountsPoll);
				return () => {
					stop();
					unsubscribeSessions?.();
					unsubscribeWorkspaces?.();
				};
			}, "dsh-kanban: counts polling");
			const panelInjected = () => ({
				api,
				onClose: () => {
					ctx.get("layout")?.selectPanel?.(null);
				},
				t,
				openSession: (sessionId) => {
					ctx.get("layout")?.selectPanel?.(null);
					ctx.get("uiWorkspace")?.openSession?.(sessionId);
				}
			});
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS,
				inject: panelInjected
			}, KanbanPanel));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 10,
				label: () => t("nav"),
				locale: NS
			}, KanbanPanelIcon));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map