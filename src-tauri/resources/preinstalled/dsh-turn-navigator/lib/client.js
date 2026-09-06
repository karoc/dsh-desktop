window.__ModuleLoader__.load({
	id: "dsh-turn-navigator",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_dom = require("react-dom");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/turns.ts
		const SUMMARY_MAX_CHARS$1 = 80;
		/**
		* Extract the text of the first `type: 'text'` content block from a node's
		* content array.
		*/
		function firstText$1(content) {
			if (content === void 0) return "";
			for (const block of content) if (block.type === "text" && typeof block.text === "string") return block.text;
			return "";
		}
		/**
		* Derive the flat turn list from a chat snapshot.
		*
		* For each turn in `timeline.turnOrder`, the function looks up the turn's
		* chat-node keys via `locations.getTurn`, finds the first node whose `kind`
		* is `'user'`, and extracts the text summary from its content blocks. The
		* timestamp comes from `legacy.turnTimings` (preferred) or `turn.start.time`.
		*
		* Accepts BOTH the new (0.1.2+) ChatSnapshot (from `useChat`) and the legacy
		* `ConversationSnapshot` (which had a `.chat` field) — so an upgrade never
		* crashes if the host is still on the older shape.
		*
		* @param snap - the chat snapshot (structural subset).
		* @returns ordered turn entries (empty when the snapshot has no turns).
		*/
		function extractTurns(snap) {
			const chat = unwrapChat(snap);
			if (chat === void 0) return [];
			const turnTimings = chat.legacy?.turnTimings ?? (snap !== void 0 && "turnTimings" in snap ? snap.turnTimings : void 0);
			const navItems = chat.navigation?.items?.() ?? [];
			if (navItems.length > 0) return navItems.map((item, index) => {
				const loc = chat.timeline.turns.get(item.turn);
				const status = loc?.status ?? "closed";
				return {
					turn: item.turn,
					index: index + 1,
					summary: item.prompt || "(no user message)",
					fullText: item.prompt || "",
					startTime: turnTimings?.get(item.turn)?.startTime ?? loc?.start?.time,
					status
				};
			});
			const timeline = chat.timeline;
			const turnOrder = timeline.turnOrder;
			if (turnOrder.length === 0) return [];
			const entries = [];
			let displayIndex = 0;
			for (const turn of turnOrder) {
				displayIndex += 1;
				const loc = timeline.turns.get(turn);
				const status = loc?.status ?? "unknown";
				const startTime = turnTimings?.get(turn)?.startTime ?? loc?.start?.time;
				let summary = "";
				let fullText = "";
				const keys = chat.locations.getTurn(turn);
				for (const key of keys) {
					const node = chat.nodes.get(key);
					if (node === void 0) continue;
					if (node.kind === "user") {
						const userData = node.data;
						if (userData !== void 0) {
							fullText = firstText$1(userData.content);
							summary = fullText.length > SUMMARY_MAX_CHARS$1 ? `${fullText.slice(0, 79)}…` : fullText;
						}
						break;
					}
					if (summary === "") {
						const peek = peekNodeText(node);
						fullText = peek;
						summary = peek.length > SUMMARY_MAX_CHARS$1 ? `${peek.slice(0, 79)}…` : peek;
					}
				}
				entries.push({
					turn,
					index: displayIndex,
					summary: summary || `[${kindLabel(turn, keys, chat)}]`,
					fullText,
					startTime,
					status
				});
			}
			return entries;
		}
		/** Narrow either the new ChatSnapshot or the legacy `.chat`-wrapped snapshot to a chat. */
		function unwrapChat(snap) {
			if (snap === void 0) return void 0;
			if ("chat" in snap && snap.chat !== void 0) return snap.chat;
			return snap;
		}
		/** Best-effort text peek from a non-user chat node's data (erased shape). */
		function peekNodeText(node) {
			const data = node.data;
			if (data === void 0) return "";
			for (const field of [
				"summary",
				"text",
				"content",
				"message",
				"name"
			]) {
				const value = data[field];
				if (typeof value === "string" && value.trim().length > 0) return value.trim();
				if (Array.isArray(value)) {
					for (const block of value) if (block !== null && typeof block === "object") {
						const b = block;
						if (typeof b.text === "string" && b.text.trim().length > 0) return b.text.trim();
					}
				}
			}
			return "";
		}
		/** Human label for a turn that has no readable first-node text. */
		function kindLabel(turn, keys, chat) {
			return `turn ${turn} (${chat.nodes.get(keys[0] ?? "")?.kind ?? "turn"})`;
		}
		/**
		* Find the chat-node key of the first visible node in a given turn — the
		* scroll target for "jump to turn".
		*
		* @param snap - the conversation snapshot.
		* @param turn - the turn number to jump to.
		* @returns the first node key in that turn (typically the user message), or undefined.
		*/
		function firstNodeKeyOfTurn(snap, turn) {
			const chat = unwrapChat(snap);
			if (chat === void 0) return void 0;
			return chat.locations.getTurn(turn)[0];
		}
		/**
		* Reverse-lookup: given a chat-node key, find which turn it belongs to.
		*
		* Used by the scroll-follow highlight: the scroll listener finds the topmost
		* visible `[data-chat-anchor-key]` row, then this function maps its key back
		* to a turn number so the drawer can highlight the matching entry.
		*
		* @param snap - the conversation snapshot.
		* @param key - the chat-node key from the DOM anchor.
		* @returns the owning turn number, or undefined if not found.
		*/
		function turnOfNodeKey(snap, key) {
			const chat = unwrapChat(snap);
			if (chat === void 0) return void 0;
			const { turnOrder, turns } = chat.timeline;
			for (const turn of turnOrder) if (chat.locations.getTurn(turn).includes(key)) return turn;
		}
		//#endregion
		//#region src/client/history.ts
		const SUMMARY_MAX_CHARS = 80;
		/** Safety cap on history pages read (50 events each). */
		const MAX_HISTORY_PAGES = 500;
		/** Journal page size in MESSAGES (user/assistant count) — no host cap, fewer round trips. */
		const JOURNAL_PAGE_MESSAGES = 200;
		/** Safety cap on journal pages read. */
		const MAX_JOURNAL_PAGES = 100;
		function firstText(content) {
			if (content === void 0) return "";
			for (const block of content) if (block.type === "text" && typeof block.text === "string") return block.text;
			return "";
		}
		function truncate(text) {
			return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, 79)}…` : text;
		}
		/**
		* Read the full persisted history of a session and derive every turn.
		*
		* Pages are requested newest-first (a page walks back via `beforeSeq`); all
		* events are collected, sorted by seq ascending, then folded into turns.
		* `onPage` is called after each page with the turns derived so far (the rail
		* can render incrementally without waiting for the whole history).
		*
		* @param api - the browser→host sessions API.
		* @param sessionId - the session to read.
		* @param onPage - incremental callback (turns so far, in ascending turn order).
		*/
		async function fetchAllTurns(api, sessionId, onPage) {
			if (api === void 0 || typeof api.sessions?.history !== "function") {
				console.warn("[dsh-turn-nav] sessions.history RPC unavailable — falling back to window-only turns");
				return [];
			}
			const allEvents = [];
			let beforeSeq;
			for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
				const response = await api.sessions.history({
					sessionId,
					beforeSeq,
					maxMessages: 50
				});
				if (response.result === void 0 || response.result.ok !== true) {
					console.warn("[dsh-turn-nav] sessions.history page failed", response.error?.code ?? "no result");
					break;
				}
				const value = response.result.value;
				if (value === void 0) break;
				const { events, hasMore } = value;
				if (events.length === 0) break;
				for (const entry of events) allEvents.push(entry.event);
				onPage(buildTurns(allEvents));
				if (!hasMore) break;
				beforeSeq = events[0].event.seq;
			}
			allEvents.sort((a, b) => a.seq - b.seq);
			const turns = buildTurns(allEvents);
			onPage(turns);
			return turns;
		}
		/**
		* Read the FULL persisted history through the 0.1.2+ journal channel
		* (`ctx.remote.session.page`), newest page first, walking back via `beforeSeq`
		* until `hasMore` is false. Only events BELOW the loaded window are fetched
		* (the window itself already covers the tail), so the conversation flow is
		* never touched — this is what keeps very long sessions responsive.
		*
		* Returns `undefined` when the journal channel is unavailable (older dsh), so
		* the caller can fall back to the legacy `sessions.history` RPC or to
		* window-only turns.
		*
		* @param journal - the mounted journal namespace face, or undefined.
		* @param sessionId - the session to read.
		* @param window - oldest/newest event seq of the currently loaded window.
		* @param onPage - incremental callback (turns derived so far, ascending).
		* @param signal - optional caller cancellation.
		*/
		async function fetchJournalTurns(journal, sessionId, window, onPage, signal) {
			if (journal === void 0 || typeof journal.page !== "function") return void 0;
			if (window.lastSeq === void 0 || window.firstSeq === 0) return [];
			const before0 = window.firstSeq !== void 0 && window.firstSeq > 0 ? window.firstSeq - 1 : void 0;
			if (before0 === void 0) return [];
			const allEvents = [];
			let beforeSeq = before0;
			for (let page = 0; page < MAX_JOURNAL_PAGES; page += 1) {
				if (signal?.aborted) break;
				const result = await journal.page({
					address: {
						kind: "session",
						sessionId
					},
					throughSeq: window.lastSeq,
					beforeSeq,
					maxMessages: JOURNAL_PAGE_MESSAGES
				}, signal);
				if (!result.ok || result.value === void 0) {
					console.warn("[dsh-turn-nav] session/page failed", result.error?.code ?? "no result");
					break;
				}
				const { records, hasMore } = result.value;
				if (records.length === 0) break;
				for (const record of records) if (record.type === "event") allEvents.push(record.event);
				onPage(buildTurns(allEvents));
				if (!hasMore) break;
				let minSeq = Infinity;
				for (const record of records) minSeq = Math.min(minSeq, record.event.seq);
				if (!Number.isFinite(minSeq)) break;
				beforeSeq = minSeq;
			}
			const turns = buildTurns(allEvents);
			onPage(turns);
			return turns;
		}
		/** Fold a (seq-ascending) event list into ordered turns. */
		function buildTurns(events) {
			const sorted = [...events].sort((a, b) => a.seq - b.seq);
			const turns = [];
			let current = null;
			for (const event of sorted) switch (event.type) {
				case "turn/start": {
					if (current !== null) turns.push(closeTurn(current));
					const turn = typeof event.data.turn === "number" ? event.data.turn : NaN;
					if (Number.isFinite(turn)) current = {
						turn,
						startSeq: event.seq,
						time: event.time,
						summary: "",
						fullText: ""
					};
					break;
				}
				case "turn/end":
					if (current !== null && event.data.turn === current.turn) {
						turns.push(closeTurn(current));
						current = null;
					}
					break;
				case "user/message": if (current !== null && current.summary === "") {
					const text = firstText(event.data.content);
					current.summary = truncate(text);
					current.fullText = text;
					current.time = event.time;
				}
			}
			if (current !== null) turns.push(closeTurn(current));
			turns.sort((a, b) => a.turn - b.turn);
			return turns.map((turn, i) => ({
				...turn,
				index: i + 1
			}));
		}
		function closeTurn(t) {
			return {
				turn: t.turn,
				index: 0,
				summary: t.summary || "(no user message)",
				fullText: t.fullText,
				startTime: Number.isFinite(t.time) ? t.time : void 0,
				startSeq: t.startSeq,
				status: "closed"
			};
		}
		//#endregion
		//#region src/client/mode.ts
		/** localStorage key owning the persisted mode. */
		const STORAGE_KEY = "dsh-turn-navigator.mode";
		/** Default mode: our rail, official rail hidden (subtractive takeover). */
		const DEFAULT_MODE = "stn";
		const MODES = [
			"stn",
			"official",
			"hidden"
		];
		/** Module-level current mode (stable reference for useSyncExternalStore). */
		let current = readStored();
		const listeners = /* @__PURE__ */ new Set();
		function readStored() {
			try {
				const raw = window.localStorage.getItem(STORAGE_KEY);
				if (MODES.includes(raw)) return raw;
			} catch {}
			return DEFAULT_MODE;
		}
		/** Read the current rail mode (useSyncExternalStore getSnapshot). */
		function getRailMode() {
			return current;
		}
		/** Subscribe to rail-mode changes (useSyncExternalStore subscribe). */
		function subscribeRailMode(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
		/** Persist and publish a new rail mode. */
		function setRailMode(mode) {
			if (mode === current) return;
			current = mode;
			try {
				window.localStorage.setItem(STORAGE_KEY, mode);
			} catch {}
			applyModeToBody();
			for (const listener of [...listeners]) try {
				listener();
			} catch {}
		}
		/**
		* Sync the `tn-hide-official` body class with the current mode. The class
		* drives the stylesheet rule that hides the OFFICIAL rail (our rail is hidden
		* by React instead). The official rail is hidden in every mode except
		* `official` (where the user chose to see it). Called at plugin apply (body
		* exists by then) and on every mode change.
		*/
		function applyModeToBody() {
			if (typeof document === "undefined") return;
			document.body.classList.toggle("tn-hide-official", current !== "official");
		}
		//#endregion
		//#region src/client/TurnNavRail.tsx
		/**
		* Turn navigation rail: a vertical "piano-key" rail floating on the right
		* edge of the conversation. One capsule per turn, stacked vertically.
		* Hovering a capsule makes it glow with the theme color and widen (a wave
		* ripple) and shows the full turn info in a tooltip; clicking a capsule jumps
		* the conversation to that turn's start.
		*
		* Registered into `conversation.session.header.utilities` (session scope), so
		* this component reads the live `ConversationSnapshot` via `useSession`.
		*
		* DATA & PERFORMANCE: the rail's turn list is read from the HOST through the
		* `sessions.history` browser→host RPC — every persisted turn (including ones
		* far outside the conversation's window) is shown as plain data, with ZERO
		* prepends into the conversation flow. The flow window is only extended
		* (via the "Load earlier" paging button) on demand, when a capsule is
		* clicked to jump to a turn that is not yet in the window. This keeps a very
		* long conversation (hundreds of turns) responsive: opening it never re-
		* renders the flow, and jumping loads only what is needed to reach the target.
		*/
		/** Scrollport selector: the active conversation's scroll container. */
		const SCROLL_SELECTOR = "[data-conversation-scroll]";
		/** Chat row anchor attribute: each rendered row carries its node key. */
		const ANCHOR_ATTR = "data-chat-anchor-key";
		/** CSS class for the jump highlight flash. */
		const HIGHLIGHT_CLASS = "tn-jump-highlight";
		/** Delay between loadOlder clicks while expanding the window to a clicked turn. */
		const LOAD_RENDER_SETTLE_MS = 900;
		/** Cap on pages loaded while expanding the window to a clicked turn. */
		const MAX_JUMP_PAGES = 100;
		/** Bounded wait for the official session binding/window to appear on mount. */
		const JOURNAL_BINDING_WAIT_MS = 15e3;
		/** Extra vertical margin when scrolling a target row into view. */
		const JUMP_MARGIN_PX = 16;
		/** Localized "Load earlier" paging button labels — idle AND in-flight. */
		const LOAD_OLDER_TEXTS = /* @__PURE__ */ new Set([
			"加载更早",
			"Load earlier",
			"Load earlier…",
			"加载中",
			"加载中…",
			"Loading",
			"Loading…"
		]);
		function isLoadOlderButton(el) {
			const text = (el.textContent ?? "").trim();
			return LOAD_OLDER_TEXTS.has(text);
		}
		/** Find the scrollport (the conversation's scroll container). */
		function findScrollport() {
			return document.querySelector(SCROLL_SELECTOR) ?? void 0;
		}
		/** Find the "Load earlier" paging button, or null (absent / mid-flight). */
		function findLoadOlderButton() {
			const scrollport = findScrollport();
			if (scrollport === void 0) return null;
			const candidates = scrollport.querySelectorAll("button");
			for (const btn of candidates) if (isLoadOlderButton(btn)) return btn;
			return null;
		}
		/** Promise-based sleep. */
		function sleep(ms) {
			return new Promise((resolve) => {
				setTimeout(resolve, ms);
			});
		}
		/** Keep the jump-feedback bubble inside the viewport vertically. */
		function clampFeedbackY(y) {
			return Math.max(24, Math.min(y, window.innerHeight - 24));
		}
		/** Tooltip body for one turn: turn number, time, full summary. */
		function tooltipText(entry, t) {
			const time = formatTime(entry.startTime);
			const label = t("turnLabel", { n: String(entry.turn) });
			const body = entry.fullText || entry.summary || t("noSummary");
			const lines = [label];
			if (time !== "") lines.push(time);
			lines.push(body);
			return lines.join("\n");
		}
		/** Short HH:MM from a Unix-epoch-ms timestamp. */
		function formatTime(ms) {
			if (ms === void 0 || ms === null || !Number.isFinite(ms)) return "";
			const date = new Date(ms);
			return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
		}
		/**
		* The piano-key rail. Session scope: reads the conversation snapshot directly
		* and renders a floating vertical capsule per turn (full history read from
		* the host as data; the flow window is extended only on click-to-jump).
		*/
		function TurnNavRail({ useSession, useChat, sessionId, t, api, journal, sessionAccess }) {
			const legacySession = useSession?.((s) => s);
			const chat = useChat?.((c) => c);
			const chatRef = (0, react.useRef)(chat ?? legacySession);
			chatRef.current = chat ?? legacySession;
			const windowTurns = (0, react.useMemo)(() => extractTurns(chat ?? legacySession), [chat, legacySession]);
			const [historyTurns, setHistoryTurns] = (0, react.useState)([]);
			const [hoverIndex, setHoverIndex] = (0, react.useState)(-1);
			const [hoverY, setHoverY] = (0, react.useState)(0);
			const [tipTop, setTipTop] = (0, react.useState)(0);
			const [canScrollUp, setCanScrollUp] = (0, react.useState)(false);
			const [canScrollDown, setCanScrollDown] = (0, react.useState)(false);
			const [jumpState, setJumpState] = (0, react.useState)(null);
			const [officialRail, setOfficialRail] = (0, react.useState)(false);
			const railRef = (0, react.useRef)(null);
			const tipRef = (0, react.useRef)(null);
			const hoverScrollRef = (0, react.useRef)(null);
			const pointerOverRailRef = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				let timer = null;
				const check = () => {
					const scroll = document.querySelector("[data-conversation-scroll]");
					const nav = scroll === null ? null : scroll.querySelector("nav[aria-label*=\"轮次\"], nav[aria-label*=\"Turn navigation\"]");
					const visible = nav !== null && getComputedStyle(nav).display !== "none";
					setOfficialRail((prev) => prev === visible ? prev : visible);
				};
				check();
				timer = setInterval(check, 1500);
				const scroll = document.querySelector("[data-conversation-scroll]");
				const observer = scroll !== null && typeof MutationObserver !== "undefined" ? new MutationObserver(check) : null;
				if (observer !== null && scroll !== null) observer.observe(scroll, {
					childList: true,
					subtree: true
				});
				return () => {
					if (timer !== null) clearInterval(timer);
					observer?.disconnect();
				};
			}, []);
			(0, react.useEffect)(() => {
				if (sessionId === void 0) return;
				let cancelled = false;
				const applyPage = (turns) => {
					if (!cancelled) setHistoryTurns(turns);
				};
				const run = async () => {
					let window = sessionAccess?.windowSeq(sessionId) ?? {
						firstSeq: void 0,
						lastSeq: void 0
					};
					if (sessionAccess !== void 0) {
						const deadline = Date.now() + JOURNAL_BINDING_WAIT_MS;
						while (window.lastSeq === void 0 && Date.now() < deadline) {
							await sleep(300);
							if (cancelled) return;
							window = sessionAccess.windowSeq(sessionId);
						}
					}
					const journalTurns = await fetchJournalTurns(journal, sessionId, window, applyPage);
					if (cancelled) return;
					if (journalTurns !== void 0) {
						setHistoryTurns(journalTurns);
						return;
					}
					if (api !== void 0) await fetchAllTurns(api, sessionId, applyPage).then((finalTurns) => {
						if (!cancelled) setHistoryTurns(finalTurns);
					});
				};
				run();
				return () => {
					cancelled = true;
				};
			}, [
				api,
				journal,
				sessionAccess,
				sessionId
			]);
			const railMode = (0, react.useSyncExternalStore)(subscribeRailMode, getRailMode);
			const turns = (0, react.useMemo)(() => {
				if (historyTurns.length === 0) return windowTurns;
				const historySet = new Set(historyTurns.map((entry) => entry.turn));
				const extras = windowTurns.filter((entry) => !historySet.has(entry.turn));
				return [...historyTurns, ...extras].sort((a, b) => a.turn - b.turn).map((entry, i) => ({
					...entry,
					index: i + 1
				}));
			}, [historyTurns, windowTurns]);
			const [activeTurn, setActiveTurn] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				const scroll = document.querySelector("[data-conversation-scroll]");
				if (scroll === null) return;
				let frame = null;
				const compute = () => {
					frame = null;
					const scrollport = document.querySelector("[data-conversation-scroll]");
					if (scrollport === null) return;
					const rect = scrollport.getBoundingClientRect();
					const readingLine = rect.top + Math.min(96, rect.height * .2);
					const rows = Array.from(scrollport.querySelectorAll("[data-chat-anchor-key]"));
					let row = null;
					for (const r of rows) {
						const rr = r.getBoundingClientRect();
						if (rr.bottom > readingLine && rr.top < rect.bottom) {
							row = r;
							break;
						}
					}
					const key = row?.getAttribute("data-chat-anchor-key") ?? null;
					if (key !== null) setActiveTurn(turnOfNodeKey(chatRef.current, key) ?? null);
					else if (rows.length > 0) setActiveTurn(null);
				};
				const schedule = () => {
					if (frame !== null) return;
					frame = requestAnimationFrame(compute);
				};
				scroll.addEventListener("scroll", schedule, { passive: true });
				schedule();
				return () => {
					scroll.removeEventListener("scroll", schedule);
					if (frame !== null) cancelAnimationFrame(frame);
				};
			}, [turns.length]);
			(0, react.useEffect)(() => {
				if (activeTurn === null || pointerOverRailRef.current) return;
				const index = turns.findIndex((entry) => entry.turn === activeTurn);
				if (index < 0) return;
				const rail = railRef.current;
				if (rail === null) return;
				const btn = rail.querySelectorAll(".tn-cap-btn")[index];
				if (btn === void 0) return;
				const railRect = rail.getBoundingClientRect();
				const btnRect = btn.getBoundingClientRect();
				if (btnRect.top >= railRect.top && btnRect.bottom <= railRect.bottom) return;
				centerCapsule(index);
			}, [activeTurn, turns]);
			(0, react.useEffect)(() => {
				const rail = railRef.current;
				if (rail === null) return;
				const update = () => {
					setCanScrollUp(rail.scrollTop > 2);
					setCanScrollDown(rail.scrollTop < rail.scrollHeight - rail.clientHeight - 2);
				};
				update();
				rail.addEventListener("scroll", update, { passive: true });
				const ro = new ResizeObserver(update);
				ro.observe(rail);
				return () => {
					rail.removeEventListener("scroll", update);
					ro.disconnect();
				};
			}, [turns.length]);
			const hoverEntry = hoverIndex >= 0 ? turns[hoverIndex] : void 0;
			(0, react.useEffect)(() => {
				if (hoverEntry === void 0) return;
				const tip = tipRef.current;
				if (tip === null) return;
				const h = tip.offsetHeight;
				setTipTop(Math.max(8, Math.min(hoverY - h / 2, window.innerHeight - h - 8)));
			}, [hoverEntry, hoverY]);
			(0, react.useEffect)(() => () => stopHoverScroll(), []);
			const startHoverScroll = (dir) => {
				stopHoverScroll();
				if (railRef.current === null) return;
				const step = () => {
					const r = railRef.current;
					if (r === null) return;
					if (dir < 0 && r.scrollTop <= 2) {
						stopHoverScroll();
						return;
					}
					if (dir > 0 && r.scrollTop >= r.scrollHeight - r.clientHeight - 2) {
						stopHoverScroll();
						return;
					}
					r.scrollBy({ top: dir * 24 });
				};
				step();
				hoverScrollRef.current = setInterval(step, 120);
			};
			function stopHoverScroll() {
				if (hoverScrollRef.current !== null) {
					clearInterval(hoverScrollRef.current);
					hoverScrollRef.current = null;
				}
			}
			const centerCapsule = (index) => {
				const rail = railRef.current;
				if (rail === null) return;
				const btn = rail.querySelectorAll(".tn-cap-btn")[index];
				if (btn === void 0) return;
				const railRect = rail.getBoundingClientRect();
				const btnRect = btn.getBoundingClientRect();
				const contentTop = railRect.top - rail.scrollTop;
				const target = btnRect.top - contentTop - (rail.clientHeight - btnRect.height) / 2;
				rail.scrollTop = Math.max(0, target);
			};
			const jumpToTurn = async (turn) => {
				const scrollport = findScrollport();
				if (scrollport === void 0) return false;
				const isOldest = turns[0]?.turn === turn;
				const scrollToRow = (row) => {
					const targetTop = row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top + scrollport.scrollTop;
					scrollport.scrollTop = Math.max(0, targetTop - JUMP_MARGIN_PX);
					row.classList.add(HIGHLIGHT_CLASS);
					setTimeout(() => row.classList.remove(HIGHLIGHT_CLASS), 1500);
				};
				const waitForRow = async (timeoutMs) => {
					const deadline = Date.now() + timeoutMs;
					while (Date.now() < deadline) {
						const snap = chatRef.current;
						const key = snap === void 0 ? void 0 : firstNodeKeyOfTurn(snap, turn);
						if (key !== void 0) {
							const row = scrollport.querySelector(`[${ANCHOR_ATTR}="${CSS.escape(key)}"]`);
							if (row !== null) return row;
						}
						await sleep(80);
					}
					return null;
				};
				const settled = (row) => {
					if (row === null) return false;
					if (!isOldest) return true;
					return !(sessionAccess !== void 0 ? sessionAccess.hasMore(sessionId ?? "") : findLoadOlderButton() !== null);
				};
				for (let i = 0; i < MAX_JUMP_PAGES; i += 1) {
					const snap = chatRef.current;
					const key = snap === void 0 ? void 0 : firstNodeKeyOfTurn(snap, turn);
					const row = key === void 0 ? null : scrollport.querySelector(`[${ANCHOR_ATTR}="${CSS.escape(key)}"]`);
					if (settled(row)) {
						scrollToRow(row);
						return true;
					}
					if (sessionAccess !== void 0) {
						if (!sessionAccess.hasMore(sessionId ?? "")) {
							if (row !== null) {
								scrollToRow(row);
								return true;
							}
							return false;
						}
						try {
							await sessionAccess.loadOlder(sessionId ?? "");
						} catch {
							return row !== null ? (scrollToRow(row), true) : false;
						}
						const awaited = await waitForRow(LOAD_RENDER_SETTLE_MS);
						if (awaited !== null && settled(awaited)) {
							scrollToRow(awaited);
							return true;
						}
						continue;
					}
					const btn = findLoadOlderButton();
					if (btn === null) {
						if (row !== null) {
							scrollToRow(row);
							return true;
						}
						return false;
					}
					if (btn.disabled) {
						await sleep(150);
						continue;
					}
					btn.click();
					await sleep(LOAD_RENDER_SETTLE_MS);
				}
				return false;
			};
			const handleCapsuleClick = (turn, index, e) => {
				centerCapsule(index);
				const y = e.currentTarget.getBoundingClientRect().top + e.currentTarget.getBoundingClientRect().height / 2;
				setJumpState({
					turn,
					y,
					phase: "loading"
				});
				jumpToTurn(turn).then((ok) => {
					if (ok) setJumpState(null);
					else {
						setJumpState({
							turn,
							y,
							phase: "error"
						});
						setTimeout(() => setJumpState(null), 2500);
					}
				});
			};
			if (turns.length === 0 || railMode !== "stn") return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: `tn-wrap${officialRail ? " tn-nudge" : ""}`,
				role: "navigation",
				"aria-label": t("rail"),
				onMouseEnter: () => {
					pointerOverRailRef.current = true;
				},
				onMouseLeave: () => {
					pointerOverRailRef.current = false;
					setHoverIndex(-1);
					stopHoverScroll();
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "tn-scroll-btn",
						"aria-label": "scroll rail up",
						disabled: !canScrollUp,
						onClick: () => scrollRail(railRef.current, -1),
						onMouseEnter: () => {
							if (canScrollUp) startHoverScroll(-1);
						},
						onMouseLeave: stopHoverScroll,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronUpOutline14, { size: 12 })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						ref: railRef,
						className: "tn-rail",
						children: turns.map((entry, i) => {
							const dist = hoverIndex === -1 ? Infinity : Math.abs(i - hoverIndex);
							const cls = dist === 0 ? " tn-cap-hot" : dist === 1 ? " tn-cap-warm" : "";
							const loading = jumpState !== null && jumpState.phase === "loading" && jumpState.turn === entry.turn;
							const isActive = activeTurn === entry.turn;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: `tn-cap-btn${cls}${loading ? " tn-loading" : ""}${isActive ? " tn-cap-active" : ""}`,
								onMouseEnter: (e) => {
									setHoverIndex(i);
									const rect = e.currentTarget.getBoundingClientRect();
									setHoverY(rect.top + rect.height / 2);
								},
								onClick: (e) => handleCapsuleClick(entry.turn, i, e),
								"aria-label": tooltipText(entry, t).replace(/\n/g, " — "),
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "tn-cap" })
							}, entry.turn);
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "tn-scroll-btn",
						"aria-label": "scroll rail down",
						disabled: !canScrollDown,
						onClick: () => scrollRail(railRef.current, 1),
						onMouseEnter: () => {
							if (canScrollDown) startHoverScroll(1);
						},
						onMouseLeave: stopHoverScroll,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { size: 12 })
					}),
					jumpState !== null && (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: `tn-jump-feedback${jumpState.phase === "error" ? " tn-jump-error" : ""}`,
						style: { top: clampFeedbackY(jumpState.y) },
						role: "status",
						"aria-live": "polite",
						children: jumpState.phase === "loading" ? t("locatingTurn", { n: String(jumpState.turn) }) : t("locateFailed", { n: String(jumpState.turn) })
					}), document.body),
					hoverEntry !== void 0 && (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						ref: tipRef,
						className: "tn-tip",
						style: { top: tipTop },
						role: "tooltip",
						children: tooltipText(hoverEntry, t)
					}), document.body)
				]
			});
		}
		/** Scroll the rail by roughly one viewport-height (smooth). */
		function scrollRail(rail, dir) {
			if (rail === null) return;
			const step = Math.max(60, rail.clientHeight * .8);
			rail.scrollBy({
				top: dir * step,
				behavior: "smooth"
			});
		}
		//#endregion
		//#region src/client/SettingsNavModeRow.tsx
		/**
		* Settings → General row: WHICH turn-navigation rail to show.
		*
		* Registered into `settings.general.item` (root scope) by the plugin's apply;
		* the General section renders each contribution as one row, so this component
		* draws its own title, description, and a three-way selector:
		*
		*   DSH official | Smoothly TN (Smoothly Turn Nav) | Hide all
		*
		* The choice is persisted browser-locally (see mode.ts) and drives both the
		* rail component (React-side visibility) and the official-rail stylesheet
		* override (body class).
		*/
		const OPTIONS = [
			{
				id: "official",
				label: "modeOfficial"
			},
			{
				id: "stn",
				label: "modeSTN"
			},
			{
				id: "hidden",
				label: "modeHidden"
			}
		];
		/** Render the rail display-mode preference row. */
		function SettingsNavModeRow({ t }) {
			const mode = (0, react.useSyncExternalStore)(subscribeRailMode, getRailMode);
			const [open, setOpen] = (0, react.useState)(false);
			const selectedLabel = OPTIONS.find((option) => option.id === mode)?.label ?? "modeSTN";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "tn-mode-row",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "tn-mode-row-text",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "tn-mode-title",
						children: t("modeRowTitle")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "tn-mode-desc",
						children: t("modeRowDesc")
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
					open,
					onClose: () => {
						setOpen(false);
					},
					items: OPTIONS.map((option) => ({
						id: option.id,
						label: t(option.label)
					})),
					selectedId: mode,
					onSelect: (id) => {
						setOpen(false);
						setRailMode(id);
					},
					align: "end",
					portal: true,
					anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: "tn-mode-selector",
						"aria-haspopup": "menu",
						"aria-expanded": open,
						onClick: () => {
							setOpen((value) => !value);
						},
						children: [t(selectedLabel), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { className: "tn-mode-chevron" })]
					})
				})]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** Copy dictionaries for the dsh-turn-navigator plugin (Smoothly Turn Nav / 思磨力轮次胶囊条). */
		/** English strings (the key-set source of truth for this pair). */
		const en = {
			rail: "Turn navigation",
			turnLabel: "Turn {n}",
			noSummary: "(no user message)",
			locatingTurn: "Locating turn {n}…",
			locateFailed: "Could not locate turn {n}",
			modeRowTitle: "Turn navigation",
			modeRowDesc: "Which turn-navigation rail to display: the DSH built-in, Smoothly TN (Smoothly Turn Nav), or none.",
			modeOfficial: "DSH official",
			modeSTN: "Smoothly TN",
			modeHidden: "Hide all"
		};
		/** Chinese strings (same keys as {@link en}). */
		const zh = {
			rail: "轮次导航",
			turnLabel: "第 {n} 轮",
			noSummary: "（无用户消息）",
			locatingTurn: "正在定位第 {n} 轮…",
			locateFailed: "无法定位第 {n} 轮",
			modeRowTitle: "轮次导航",
			modeRowDesc: "选择显示哪个轮次胶囊条：DSH 官方、思磨力轮次胶囊条（Smoothly Turn Nav），或全部隐藏。",
			modeOfficial: "DSH 官方",
			modeSTN: "思磨力轮次胶囊条",
			modeHidden: "全部隐藏"
		};
		//#endregion
		//#region src/client/styles.ts
		/**
		* Design-token styles for the turn-nav piano-key rail (external plugin, no
		* CSS modules available). Re-declared against the official `--dsw-alias-*`
		* semantic tokens, namespaced under `tn-` to avoid collisions. Tokens carry
		* no fallback because the host theme always defines them on the app root.
		*
		* Wave hover: hovering a capsule makes it glow white and WIDEN (150%);
		* its two neighbours widen a little too (125%), so sliding across the rail
		* ripples like a wave (hot = hovered, warm = adjacent). Height stays ~3px.
		*/
		const TURN_NAV_STYLES = `
/* Wrapper: fixed column on the right edge (scroll buttons + rail + tooltip).
   The whole wrapper is pointer-events:auto so the wheel scrolls the rail
   anywhere on it; buttons sit above and below the rail.
   z-index is deliberately LOW (10): above the conversation flow content
   (max 8) but below full-screen overlays like the kanban board plugin
   (z-index 50) — same order of magnitude as the header's "Session log"
   button, so an open full-screen page always paints over the rail. */
.tn-wrap {
  position: fixed;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  z-index: 10;
  pointer-events: auto;
}
/* When the built-in (official) TurnNavigator rail is present in the transcript
   (right edge, vertically centered on the scrollport band), nudge our rail up
   into the header zone so the two never overlap: same right edge, but pinned
   below the session header instead of the scrollport center. */
.tn-wrap.tn-nudge {
  top: 64px;
  transform: none;
  max-height: calc(100vh - 140px);
}
/* Narrow viewport: mirror the official rail's @container (max-width: 900px)
   hide, so we never fight the compact layout for the right edge. */
@media (max-width: 900px) {
  .tn-wrap {
    display: none;
  }
}
/* Subtractive takeover (settings → Turn navigation = Smoothly TN): hide the
   OFFICIAL built-in rail. The official rail lives inside the conversation
   scroll container (data-conversation-scroll) — our rail is fixed outside
   it — so a container-scoped rule cannot match ours. The tn-hide-official
   body class is toggled by mode.ts; the official rail itself has no
   off-switch, so this stylesheet override is the only way to replace it. */
body.tn-hide-official [data-conversation-scroll] nav {
  display: none !important;
}
/* Settings → General preference row (which rail to show). Mirrors the official
   EnterBehaviorRow tokens. */
.tn-mode-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.tn-mode-row-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 48px;
}
.tn-mode-title {
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.tn-mode-desc {
  font-size: 12px;
  font-weight: 400;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.tn-mode-selector {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: 18px;
  background: var(--dsw-alias-bg-module-platform);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.tn-mode-selector:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.tn-mode-chevron {
  flex: none;
}
/* Up/down scroll controls at the top and bottom of the rail. Disabled (grey,
   no pointer/hover-scroll) when there is nothing to scroll in that
   direction. */
.tn-scroll-btn {
  flex: none;
  width: 26px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.tn-scroll-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.tn-scroll-btn:disabled {
  color: var(--dsw-alias-label-tertiary);
  opacity: 0.45;
  cursor: default;
}
/* Rail: AUTO-SIZING vertical column — its length grows with the turn count,
   capped at 30vh; once the cap is hit it scrolls internally. The scrollbar is
   HIDDEN (scrollbar-width:none + webkit) so its appear/disappear never shifts
   layout; scrolling is via wheel over the rail, the up/down buttons (click or
   hover-hold), or the rail-top auto-load. Buttons are packed flush (no gap)
   so hovering slides continuously without dead zones. */
.tn-rail {
  display: flex;
  flex-direction: column;
  width: 26px;
  height: auto;
  max-height: 30vh;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.tn-rail::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}
/* Per-turn hotspot: a wider/taller transparent button so the tiny capsule
   still has a comfortable hover/click target. Fixed size — excess turns make
   the rail scroll, they never compress it. */
.tn-cap-btn {
  flex: none;
  min-height: 10px;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  outline: none;
}
/* The visible capsule itself: grey, ~3px tall, ~12px wide by default. The
   hover widening uses transform:scaleX (NOT width) with transform-origin on
   the RIGHT, so it grows LEFTWARD only (right-aligned — the right edge never
   moves), never reflows the rail or adds a horizontal scrollbar. */
.tn-cap {
  width: 12px;
  height: 3px;
  border-radius: 2px;
  background: var(--dsw-alias-border-l3);
  transform-origin: right center;
  transition: transform 160ms ease, background 160ms ease, box-shadow 160ms ease;
  flex: none;
}
/* Hovered capsule: glow with the theme's primary label color and widen 150%
   (the wave peak). Theme-following (dark theme = white, light theme = dark). */
.tn-cap-btn.tn-cap-hot .tn-cap {
  transform: scaleX(1.5);
  background: var(--dsw-alias-label-primary);
  box-shadow: 0 0 6px color-mix(in srgb, var(--dsw-alias-label-primary) 55%, transparent);
}
/* Adjacent capsule: slightly wider (125%) — the wave's near neighbours. */
.tn-cap-btn.tn-cap-warm .tn-cap {
  transform: scaleX(1.25);
  background: var(--dsw-alias-label-secondary);
}
/* Active (current) turn following the scroll: a persistent brand tint so the
   reader always knows where they are in the rail, distinct from hover. */
.tn-cap-btn.tn-cap-active .tn-cap {
  background: var(--dsw-alias-state-business-primary);
  width: 14px;
}
/* Custom tooltip bubble: mirrors the DSH tooltip visual (dark plate, white
   text, pre-line for multi-line info), fixed-positioned to the LEFT of the
   rail so it never falls outside the browser window. */
.tn-tip {
  position: fixed;
  right: 40px; /* rail 26px + wrapper right 6px + 8px gap */
  z-index: 100;
  width: max-content;
  max-width: 50vw;
  padding: 3px 7px;
  border-radius: 8px;
  background: var(--dsw-alias-tooltip-bg);
  color: var(--dsw-static-neutral-bluish-00);
  font-size: 13px;
  line-height: 20px;
  white-space: pre-line;
  overflow-wrap: break-word;
  pointer-events: none;
  animation: tn-tooltip-in 150ms var(--ds-ease-in-out);
}
@keyframes tn-tooltip-in {
  from { opacity: 0; }
}

/* On-demand jump feedback: a bubble to the LEFT of the rail showing that a
   turn is being located (loading, with a pulsing dot) or that locating
   failed. Mirrors the tooltip visual but with a status dot. */
.tn-jump-feedback {
  position: fixed;
  right: 40px;
  transform: translateY(-50%);
  z-index: 101;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-tooltip-bg);
  color: var(--dsw-static-neutral-bluish-00);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  max-width: 45vw;
  pointer-events: none;
  animation: tn-tooltip-in 150ms var(--ds-ease-in-out);
}
.tn-jump-feedback::before {
  content: '';
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  animation: tn-loading-pulse 1s ease-in-out infinite;
}
.tn-jump-feedback.tn-jump-error {
  color: var(--dsw-alias-state-error-primary);
}
.tn-jump-feedback.tn-jump-error::before {
  background: var(--dsw-alias-state-error-primary);
  animation: none;
}
/* The clicked capsule pulses while its turn is being located. */
.tn-cap-btn.tn-loading .tn-cap {
  animation: tn-loading-pulse 900ms ease-in-out infinite;
}
@keyframes tn-loading-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}

/* Jump highlight flash on the target row in the conversation flow. */
@keyframes tn-highlight-flash {
  0% { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 26%, transparent); }
  100% { background: transparent; }
}
.tn-jump-highlight {
  animation: tn-highlight-flash 1500ms ease-out;
  border-radius: 4px;
}
`;
		/**
		* Inject {@link TURN_NAV_STYLES} once, tagged by plugin id so re-evaluation
		* and repeated mounts stay idempotent (mirrors the dsh-kanban pattern).
		* @param pluginId - stable plugin id used as the style tag marker.
		*/
		function injectTurnNavStyles(pluginId) {
			if (typeof document === "undefined") return;
			const selector = `style[data-dsh-plugin-css="${pluginId}"]`;
			if (document.querySelector(selector) !== null) return;
			const tag = document.createElement("style");
			tag.setAttribute("data-dsh-plugin-css", pluginId);
			tag.textContent = TURN_NAV_STYLES;
			document.head.appendChild(tag);
		}
		injectTurnNavStyles("dsh-turn-navigator");
		//#endregion
		//#region src/client/index.ts
		/** Dictionary namespace owned by this plugin. */
		const NS = "dsh-turn-navigator";
		/** Required services (cordis fiber inject). */
		const inject = [
			"slots",
			"locale",
			"connection"
		];
		/**
		* Browser plugin body: registers the turn rail into the session header
		* utilities seat.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-turn-navigator: copy dictionaries");
			const t = ctx.locale.bind(NS);
			const api = ctx.get("connection")?.api;
			applyModeToBody();
			let journal;
			let sessionAccess;
			const resolveHandles = () => {
				if (journal !== void 0 && sessionAccess !== void 0) return;
				const sessionNamespace = ctx.get("remote.session");
				if (journal === void 0 && typeof sessionNamespace?.page === "function") journal = { page: (request, signal) => sessionNamespace.page(request, signal) };
				if (sessionAccess === void 0) {
					const sessionsService = ctx.get("sessions");
					if (sessionsService !== void 0 && typeof sessionsService.binding === "function") sessionAccess = {
						windowSeq(sessionId) {
							const entries = sessionsService.binding?.(sessionId)?.eventSource?.getSnapshot?.()?.entries ?? [];
							return {
								firstSeq: entries[0]?.event?.seq,
								lastSeq: entries.at(-1)?.event?.seq
							};
						},
						hasMore(sessionId) {
							return sessionsService.binding?.(sessionId)?.eventSource?.getSnapshot?.()?.hasMore ?? false;
						},
						async loadOlder(sessionId) {
							const face = sessionsService.binding?.(sessionId)?.session;
							if (face === void 0 || typeof face.loadOlder !== "function") return false;
							try {
								await face.loadOlder();
								return true;
							} catch {
								return false;
							}
						}
					};
				}
			};
			resolveHandles();
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "dsh-turn-navigator-mode",
				order: 30,
				locale: NS,
				inject: () => ({ t })
			}, SettingsNavModeRow));
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "dsh-turn-navigator",
				order: 20,
				locale: NS,
				inject: () => {
					resolveHandles();
					return {
						t,
						api,
						journal,
						sessionAccess
					};
				}
			}, TurnNavRail));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map