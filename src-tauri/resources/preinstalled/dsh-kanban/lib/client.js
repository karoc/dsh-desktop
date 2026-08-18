window.__ModuleLoader__.load({
	id: "dsh-kanban",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/board-state.ts
		/**
		* Module-level board visibility state shared by the sidebar entry button and
		* the full-screen overlay page. A bare observable pair (subscribe/getSnapshot)
		* consumed through React's useSyncExternalStore — no store machinery needed for
		* a single boolean that two sibling entries must agree on.
		*/
		const listeners = /* @__PURE__ */ new Set();
		let open = false;
		/** Subscribe to visibility changes; returns an unsubscribe. */
		function subscribeBoard(fn) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		}
		/** Current visibility snapshot. */
		function getBoardOpen() {
			return open;
		}
		/** Open the board page (called from the sidebar entry). */
		function openBoard() {
			if (open) return;
			open = true;
			for (const fn of listeners) fn();
		}
		/** Close the board page (called from the overlay's close control). */
		function closeBoard() {
			if (!open) return;
			open = false;
			for (const fn of listeners) fn();
		}
		//#endregion
		//#region src/client/BoardPage.tsx
		/**
		* The full-screen kanban board page (external plugin).
		*
		* Reads the workspace's KANBAN.json through the host webServer route
		* (GET/POST /kanban/api) and renders three columns (todo / in_progress / done)
		* with per-card status moves, delete, and an add composer. Interactive controls
		* use @deepseek-ai/dsh-client-ui-primitives (Button, Input, Menu, Pill, icons)
		* so the page matches the native DSH look; only layout lives in the plugin's
		* own token-based styles.
		*/
		const STATUSES = [
			"todo",
			"in_progress",
			"done"
		];
		/** Sort cards so done trails the open ones, and newest first within a status. */
		function sortCards(cards) {
			return [...cards].sort((left, right) => {
				const order = {
					todo: 0,
					in_progress: 1,
					done: 2
				};
				const d = order[left.status] - order[right.status];
				if (d !== 0) return d;
				return right.createdAt - left.createdAt;
			});
		}
		/** Status label for a board status (locale-aware). */
		function statusLabel(status, t) {
			if (status === "todo") return t("statusTodo");
			if (status === "in_progress") return t("statusInProgress");
			return t("statusDone");
		}
		/** The board page component (rendered inside the shell.overlay seat). */
		function BoardPage({ api, workspace, workspaces, onClose, t, openSession }) {
			const [cards, setCards] = (0, react.useState)([]);
			const [path, setPath] = (0, react.useState)(void 0);
			const [loading, setLoading] = (0, react.useState)(true);
			const [error, setError] = (0, react.useState)(void 0);
			const [draftTitle, setDraftTitle] = (0, react.useState)("");
			const [draftSummary, setDraftSummary] = (0, react.useState)("");
			const [draftRationale, setDraftRationale] = (0, react.useState)("");
			const [draftRejected, setDraftRejected] = (0, react.useState)("");
			const [archivedNotice, setArchivedNotice] = (0, react.useState)(void 0);
			const [workspacePickerOpen, setWorkspacePickerOpen] = (0, react.useState)(false);
			const [selectedWorkspace, setSelectedWorkspace] = (0, react.useState)(workspace);
			const cwd = selectedWorkspace?.cwd;
			const refresh = (0, react.useCallback)(async () => {
				if (cwd === void 0) return;
				setLoading(true);
				setError(void 0);
				try {
					const board = await api.get(cwd);
					setCards(sortCards(board.cards));
					setPath(board.path);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setLoading(false);
				}
			}, [api, cwd]);
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			const applyMutation = (0, react.useCallback)(async (body) => {
				if (cwd === void 0) return;
				setError(void 0);
				try {
					const board = await api.mutate({
						...body,
						cwd
					});
					setCards(sortCards(board.cards));
					setPath(board.path);
					setArchivedNotice(board.archived);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			}, [api, cwd]);
			const addCard = (0, react.useCallback)(() => {
				const title = draftTitle.trim();
				if (title === "" || cwd === void 0) return;
				applyMutation({
					op: "add",
					title,
					...draftSummary.trim() !== "" ? { summary: draftSummary.trim() } : {},
					...draftRationale.trim() !== "" ? { rationale: draftRationale.trim() } : {},
					...draftRejected.trim() !== "" ? { rejected: draftRejected.trim() } : {}
				});
				setDraftTitle("");
				setDraftSummary("");
				setDraftRationale("");
				setDraftRejected("");
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
			const grouped = (0, react.useMemo)(() => {
				const groups = {
					todo: [],
					in_progress: [],
					done: []
				};
				for (const card of cards) groups[card.status].push(card);
				return groups;
			}, [cards]);
			if (selectedWorkspace === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "kb-overlay",
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
				className: "kb-overlay",
				"data-testid": "kanban-page",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BoardHeader, {
					onClose,
					t,
					path,
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
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "kb-columns",
								children: STATUSES.map((status) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: "kb-column",
									"data-status": status,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "kb-column-head",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `kb-dot kb-dot-${status}` }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
												className: "kb-column-title",
												children: statusLabel(status, t)
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "kb-column-count",
												children: t("counts", { n: String(grouped[status].length) })
											})
										]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "kb-column-cards",
										children: grouped[status].map((card) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Card, {
											card,
											t,
											onMove: moveCard,
											onRemove: removeCard,
											onOpenSession: openSession
										}, card.id))
									})]
								}, status))
							}),
							cards.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "kb-empty",
								children: t("empty")
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
											if (event.key === "Enter") addCard();
										}
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "primary",
										size: "md",
										icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutline16, {}),
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
						children: [selected?.title ?? t("workspaceChoose"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {})]
					})]
				})
			});
		}
		/** One card row: title, the what/why/rejected fields, tags, status Menu + delete. */
		function Card(props) {
			const { card, t, onMove, onRemove, onOpenSession } = props;
			const [statusOpen, setStatusOpen] = (0, react.useState)(false);
			const [confirmDelete, setConfirmDelete] = (0, react.useState)(false);
			const statusItems = STATUSES.map((status) => ({
				id: status,
				label: statusLabel(status, t)
			}));
			const fields = [
				[t("fieldSummary"), card.summary],
				[t("fieldRationale"), card.rationale],
				[t("fieldRejected"), card.rejected]
			];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
				className: "kb-card",
				"data-card-id": card.id,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
						className: "kb-card-title",
						children: card.title
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
					card.sourceSessionId !== void 0 && onOpenSession !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "kb-card-meta",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "kb-source-btn",
							onClick: () => onOpenSession(card.sourceSessionId),
							children: t("sourceSession")
						})
					}),
					card.tags.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "kb-card-meta",
						children: card.tags.map((tag) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
							active: true,
							children: tag
						}, tag))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "kb-card-actions",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
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
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "ghost",
							size: "sm",
							icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}),
							"aria-label": t("remove"),
							onClick: () => setConfirmDelete(true)
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
							icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}),
							onClick: () => {
								onRemove(card.id);
								setConfirmDelete(false);
							},
							children: t("deleteConfirmAction")
						})] })
					})
				]
			});
		}
		/** Shared header strip of the overlay (native DSH ghost buttons). */
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
							props.path
						]
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "kb-header-spacer" }),
					props.onRefresh !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "ghost",
						size: "md",
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline16, {}),
						onClick: props.onRefresh,
						children: props.t("refresh")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "ghost",
						size: "md",
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseOutline16, {}),
						onClick: props.onClose,
						children: props.t("close")
					})
				]
			});
		}
		//#endregion
		//#region src/client/KanbanSurface.tsx
		/**
		* Sidebar entry button and overlay wrapper for the kanban board page.
		*
		* Kept in a `.tsx` file so the browser bundle can parse JSX; the plugin entry
		* (src/client/index.ts) stays plain TypeScript and imports these. The sidebar
		* entry mirrors the Settings footer trigger (icon + label, left-aligned,
		* 34px compact row) so it lines up with the Settings entry below it.
		*/
		/**
		* Sidebar footer entry button: icon + label, left-aligned, styled exactly
		* like the Settings trigger (34px compact row, 12px radius, 10px left pad)
		* so it sits flush with the Settings entry below it. The rail (collapsed)
		* state shows only the icon, like the other rail controls.
		*/
		function SidebarKanbanButton(props) {
			const wide = props.wide ?? true;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: wide ? "kb-sidebar-trigger" : "kb-sidebar-trigger kb-sidebar-trigger-rail",
				"aria-label": props.t(),
				onClick: props.onClick,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChecklistOutline14, { size: wide ? 16 : 18 }), wide && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "kb-sidebar-trigger-label",
					children: props.t()
				})]
			});
		}
		/**
		* Build the full workspace list plus the default (current-session) workspace
		* from the framework seats. Default: the current session's cwd, then the most
		* recent workspace, then the first workspace. The list drives the board page's
		* workspace switcher.
		*/
		function resolveWorkspaces(sessionList, workspaceList) {
			const all = (workspaceList.items ?? []).map((item) => ({
				workspaceId: item.workspaceId,
				cwd: item.path,
				title: item.title ?? item.path
			}));
			const current = sessionList.current;
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
			const recentId = workspaceList.recentWorkspaceId;
			return {
				all,
				current: all.find((ws) => ws.workspaceId === recentId) ?? all[0]
			};
		}
		/** Overlay wrapper: renders the board page only while open. */
		function KanbanOverlay(props) {
			const open = (0, react.useSyncExternalStore)(subscribeBoard, getBoardOpen);
			const { all, current } = resolveWorkspaces(props.useSessions?.((s) => s) ?? {}, props.useWorkspaces?.((s) => s) ?? {});
			if (!open) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BoardPage, {
				api: props.api,
				workspace: current,
				workspaces: all,
				onClose: props.onClose,
				t: props.t,
				openSession: props.openSession
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** Copy dictionaries for the dsh-kanban board page. */
		/** English strings (the key-set source of truth for this pair). */
		const en = {
			nav: "Kanban",
			title: "Kanban board",
			intro: "Cross-session plans and todos, persisted to KANBAN.json at the workspace root.",
			pathLabel: "Board file",
			close: "Close",
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
			specDefinitionSource: "Source: deepseek-harness AGENTS.md (\"Non-trivial changes MUST include an Agent Note…\")",
			specSave: "Save overrides",
			specReset: "Reset to defaults",
			specSaved: "Saved.",
			specUpdateWarning: "The plugin now ships Agent Note spec v{plugin} but this workspace has custom overrides (v{current}). Updating the plugin resets overrides to the new defaults — your custom content will be lost.",
			specOverridesFile: "Stored at {path}",
			specOverrideActive: "Custom overrides active.",
			archivedNotice: "Archived {count} done card(s) to {path}",
			sourceSession: "Open source session",
			workspaceLabel: "Workspace",
			workspaceChoose: "Choose a workspace…",
			deleteTitle: "Delete card",
			deleteConfirm: "Delete \"{title}\"? This removes the card from KANBAN.json permanently. This cannot be undone.",
			deleteCancel: "Cancel",
			deleteConfirmAction: "Delete"
		};
		/** Chinese strings (same keys as {@link en}). */
		const zh = {
			nav: "看板",
			title: "看板",
			intro: "跨会话的计划与待办，持久化到工作区根目录的 KANBAN.json。",
			pathLabel: "看板文件",
			close: "关闭",
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
			specDefinitionSource: "来源：deepseek-harness AGENTS.md（\"非平凡变更必须包含 Agent Note…\"）",
			specSave: "保存覆盖",
			specReset: "恢复默认",
			specSaved: "已保存。",
			specUpdateWarning: "插件现已内置 Agent Note 规范 v{plugin}，但此工作区有自定义覆盖（v{current}）。更新插件会把覆盖重置为新默认值——你自定义的内容会丢失。",
			specOverridesFile: "存储于 {path}",
			specOverrideActive: "自定义覆盖生效中。",
			archivedNotice: "已归档 {count} 张已完成卡片到 {path}",
			sourceSession: "打开来源会话",
			workspaceLabel: "工作区",
			workspaceChoose: "选择工作区…",
			deleteTitle: "删除卡片",
			deleteConfirm: "确定删除「{title}」吗？这会把卡片从 KANBAN.json 永久移除，无法撤销。",
			deleteCancel: "取消",
			deleteConfirmAction: "删除"
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
/* Sidebar footer trigger, mirroring the Settings trigger (34px compact row,
   12px radius, 10px left pad, icon + left-aligned label). */
.kb-sidebar-trigger {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  width: calc(100% + 8px);
  height: 34px;
  margin: 4px -4px 4px;
  padding: 6px 2px 6px 10px;
  box-sizing: border-box;
  border: none;
  border-radius: 12px;
  background: transparent;
  cursor: pointer;
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
}
.kb-sidebar-trigger:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
/* Rail trigger: the same 36x36 circle box as the other rail controls. */
.kb-sidebar-trigger-rail {
  width: 36px;
  height: 36px;
  margin: 8px 0 10px;
  justify-content: center;
  gap: 0;
  padding: 0;
  border-radius: 50%;
}
.kb-sidebar-trigger-label {
  overflow: hidden;
  white-space: nowrap;
}
.kb-overlay {
  position: fixed; inset: 0; z-index: 50;
  display: flex; flex-direction: column;
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
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, monospace);
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
.kb-card-title { margin: 0; font-size: 13px; line-height: 18px; word-break: break-word; }
.kb-card-desc { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); word-break: break-word; }
.kb-card-fields { display: flex; flex-direction: column; gap: 4px; }
.kb-card-field { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); word-break: break-word; }
.kb-card-field-label { color: var(--dsw-alias-label-tertiary); font-weight: 600; }
.kb-card-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.kb-source-btn {
  display: inline-flex; align-items: center;
  height: 22px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11px; line-height: 16px; cursor: pointer;
}
.kb-source-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.kb-card-actions { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
.kb-composer-field { flex: 1; min-width: 0; }
.kb-composer {
  display: flex; flex-direction: column; gap: 8px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  padding: 12px; margin-top: 16px;
  background: var(--dsw-alias-bg-module-platform);
}
.kb-composer-row { display: flex; gap: 8px; align-items: center; }
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
  background: var(--dsw-alias-bg-input, transparent);
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
.kb-spec-warning {
  margin: 0; padding: 8px 10px; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-interactive-bg-hover-danger);
  border: 1px solid var(--dsw-alias-border-l3); border-radius: 8px;
  background: var(--dsw-alias-bg-module);
}
.kb-spec-label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.kb-spec-input {
  width: 100%; box-sizing: border-box; resize: vertical;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  padding: 8px 10px; background: var(--dsw-alias-bg-input, transparent);
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 18px;
}
.kb-spec-input:focus { outline: none; border-color: var(--dsw-alias-border-l3); }
.kb-spec-monospace { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, monospace); font-size: 12px; }
.kb-spec-source { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); word-break: break-word; }
.kb-spec-saved { margin: 0; font-size: 12px; color: var(--dsw-alias-button-primary-fill); }
.kb-spec-actions { display: flex; gap: 8px; }
.kb-loading, .kb-empty, .kb-error {
  padding: 24px; text-align: center; font-size: 13px; line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}
.kb-empty { border: 1px dashed var(--dsw-alias-border-l3); border-radius: 12px; }
.kb-error { color: var(--dsw-alias-interactive-bg-hover-danger); }
.kb-archived {
  margin: 0 0 12px; padding: 8px 12px; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l3); border-radius: 8px;
  background: var(--dsw-alias-bg-module);
  word-break: break-all;
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
					counts: body.counts
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
					counts: body.counts
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
		* Browser plugin body: registers the sidebar entry and the full-screen page.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-kanban: copy dictionaries");
			const api = createBoardApi();
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "kanban",
				order: 10,
				locale: NS,
				inject: () => ({
					onClick: openBoard,
					t: () => t("nav")
				})
			}, SidebarKanbanButton));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "kanban",
				order: 10,
				locale: NS,
				inject: () => ({
					api,
					onClose: closeBoard,
					t,
					openSession: (sessionId) => {
						const sessions = ctx.get("sessions");
						if (sessions === void 0) return;
						closeBoard();
						sessions.open(sessionId);
					}
				})
			}, KanbanOverlay));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map