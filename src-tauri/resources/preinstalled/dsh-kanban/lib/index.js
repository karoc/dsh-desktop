import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { URL } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
//#region src/board-core.ts
/**
* Core kanban domain: a workspace-scoped KANBAN.json file with card CRUD.
*
* Shared by the model-facing tools (src/index.ts) and the webServer route that
* backs the Web board page (also src/index.ts). The file lives at the workspace
* root so it is git-trackable, human-editable, and survives session switches.
*
* The board shape is deliberately minimal: one flat card list with a three-state
* status. No columns to configure, no per-card nesting — the workspace owns one
* board, and a "plan" is expressed as a tag or a group of cards.
*/
/** The single git-trackable board filename at the workspace root. */
const KANBAN_FILE = "KANBAN.json";
const BOARD_STATUSES = [
	"todo",
	"in_progress",
	"done"
];
/** The resolved board file path for one workspace. */
function boardPath(cwd) {
	if (!isAbsolute(cwd)) throw new TypeError(`kanban: workspace must be an absolute path, got ${JSON.stringify(cwd)}`);
	return join(cwd, KANBAN_FILE);
}
/** Empty board document. */
function emptyBoard() {
	return {
		version: 1,
		cards: []
	};
}
/** Whether a parsed KANBAN.json value is structurally a {@link BoardData}. */
function isBoardData(value) {
	if (typeof value !== "object" || value === null) return false;
	const board = value;
	if (board.version !== 1 || !Array.isArray(board.cards)) return false;
	return board.cards.every(isBoardCard);
}
/** Whether a parsed value is structurally a {@link BoardCard}. */
function isBoardCard(value) {
	if (typeof value !== "object" || value === null) return false;
	const card = value;
	if (typeof card.id !== "string" || card.id === "") return false;
	if (typeof card.title !== "string" || card.title.trim() === "") return false;
	if (!BOARD_STATUSES.includes(card.status)) return false;
	if (!Array.isArray(card.tags) || !card.tags.every((tag) => typeof tag === "string")) return false;
	if (typeof card.createdAt !== "number" || typeof card.updatedAt !== "number") return false;
	if (card.description !== void 0 && typeof card.description !== "string") return false;
	if (card.summary !== void 0 && typeof card.summary !== "string") return false;
	if (card.rationale !== void 0 && typeof card.rationale !== "string") return false;
	if (card.rejected !== void 0 && typeof card.rejected !== "string") return false;
	return card.sourceSessionId === void 0 || typeof card.sourceSessionId === "string";
}
/**
* Read the board document for one workspace. A missing file yields the empty
* board; a structurally invalid document throws (never silently repaired, so a
* hand-edited KANBAN.json that breaks shape fails loud instead of losing data).
* @param cwd - absolute workspace root.
* @returns the parsed board document.
*/
async function readBoard(cwd) {
	const path = boardPath(cwd);
	let raw;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return emptyBoard();
		throw error;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`kanban: ${path} is not valid JSON: ${error.message}`);
	}
	if (!isBoardData(parsed)) throw new Error(`kanban: ${path} does not match the KANBAN.json shape (expected { version: 1, cards: [...] })`);
	return parsed;
}
/**
* Synchronous read for prompt-assembly-time use (systemPrompt.context text is
* a sync `(context) => string`). Same semantics as {@link readBoard}: a missing
* file yields the empty board; a structurally invalid document throws.
* @param cwd - absolute workspace root.
* @returns the parsed board document.
*/
function readBoardSync(cwd) {
	const path = boardPath(cwd);
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return emptyBoard();
		throw error;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`kanban: ${path} is not valid JSON: ${error.message}`);
	}
	if (!isBoardData(parsed)) throw new Error(`kanban: ${path} does not match the KANBAN.json shape (expected { version: 1, cards: [...] })`);
	return parsed;
}
/** Atomically write the board document (tmp + rename). */
async function writeBoard(cwd, board) {
	const path = boardPath(cwd);
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, JSON.stringify(board, null, 2) + "\n", "utf8");
	await rename(tmp, path);
}
/** The archive document path under .agents/notes (git-trackable). */
function archivePath(cwd) {
	if (!isAbsolute(cwd)) throw new TypeError(`kanban: workspace must be an absolute path, got ${JSON.stringify(cwd)}`);
	return join(cwd, ".agents", "notes", "archive.json");
}
/**
* Archive done cards beyond {@link MAX_DONE_CARDS}: the oldest done cards
* (by createdAt) are appended to `.agents/notes/archive.json` and removed from
* the live board. Returns how many were archived (0 when none). Callers must
* write the (mutated) board after this.
*/
async function archiveExcessDone(cwd, board) {
	const done = board.cards.filter((card) => card.status === "done");
	if (done.length <= 100) return {
		count: 0,
		path: archivePath(cwd)
	};
	const excess = done.length - 100;
	const toArchive = [...done].sort((a, b) => a.createdAt - b.createdAt).slice(0, excess);
	const ids = new Set(toArchive.map((card) => card.id));
	board.cards = board.cards.filter((card) => !ids.has(card.id));
	const path = archivePath(cwd);
	await mkdir(dirname(path), { recursive: true });
	let existing = [];
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed.archived)) existing = parsed.archived;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	existing.push(...toArchive);
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, JSON.stringify({
		version: 1,
		archived: existing
	}, null, 2) + "\n", "utf8");
	await rename(tmp, path);
	return {
		count: toArchive.length,
		path
	};
}
/** Build a detached {@link BoardView} from a document. */
function viewOf$1(cwd, board, archived) {
	const counts = {
		todo: 0,
		inProgress: 0,
		done: 0
	};
	for (const card of board.cards) if (card.status === "todo") counts.todo += 1;
	else if (card.status === "in_progress") counts.inProgress += 1;
	else counts.done += 1;
	return {
		path: boardPath(cwd),
		cards: board.cards,
		counts,
		...archived !== void 0 && archived.count > 0 ? { archived } : {}
	};
}
/** Normalize an optional tag list: trim, drop empties, dedupe. */
function normalizeTags(tags) {
	if (tags === void 0) return [];
	const seen = /* @__PURE__ */ new Set();
	for (const tag of tags) {
		const trimmed = tag.trim();
		if (trimmed !== "") seen.add(trimmed);
	}
	return [...seen];
}
/** Include a non-empty optional text field in a card object; empty clears it. */
function optionalText(target, field, value) {
	if (value === void 0) return;
	const trimmed = value.trim();
	if (trimmed === "") delete target[field];
	else target[field] = trimmed;
}
/** Add one card and return the fresh board view. */
async function addCard(cwd, input) {
	const title = input.title.trim();
	if (title === "") throw new TypeError("kanban: card title must be a non-empty string");
	if (input.status !== void 0 && !BOARD_STATUSES.includes(input.status)) throw new TypeError(`kanban: invalid status ${JSON.stringify(input.status)}`);
	const board = await readBoard(cwd);
	const now = Date.now();
	const fields = {};
	optionalText(fields, "description", input.description);
	optionalText(fields, "summary", input.summary);
	optionalText(fields, "rationale", input.rationale);
	optionalText(fields, "rejected", input.rejected);
	const card = {
		id: `card-${randomUUID()}`,
		title,
		...fields,
		...input.sourceSessionId !== void 0 && input.sourceSessionId !== "" ? { sourceSessionId: input.sourceSessionId } : {},
		status: input.status ?? "todo",
		tags: normalizeTags(input.tags),
		createdAt: now,
		updatedAt: now
	};
	board.cards.push(card);
	const archived = await archiveExcessDone(cwd, board);
	await writeBoard(cwd, board);
	return viewOf$1(cwd, board, archived);
}
/** Update one card in place and return the fresh board view. */
async function updateCard(cwd, id, input) {
	if (id === "" || id.trim() !== id) throw new TypeError("kanban: card id must be a non-empty, untrimmed string");
	if (input.title !== void 0 && input.title.trim() === "") throw new TypeError("kanban: card title must be a non-empty string");
	if (input.status !== void 0 && !BOARD_STATUSES.includes(input.status)) throw new TypeError(`kanban: invalid status ${JSON.stringify(input.status)}`);
	if (input.title === void 0 && input.description === void 0 && input.summary === void 0 && input.rationale === void 0 && input.rejected === void 0 && input.status === void 0 && input.tags === void 0) throw new TypeError("kanban: card update requires at least one field");
	const board = await readBoard(cwd);
	const card = board.cards.find((candidate) => candidate.id === id);
	if (card === void 0) throw new Error(`kanban: no card with id ${JSON.stringify(id)}`);
	if (input.title !== void 0) card.title = input.title.trim();
	if (input.description !== void 0) {
		const v = input.description.trim();
		if (v === "") delete card.description;
		else card.description = v;
	}
	if (input.summary !== void 0) {
		const v = input.summary.trim();
		if (v === "") delete card.summary;
		else card.summary = v;
	}
	if (input.rationale !== void 0) {
		const v = input.rationale.trim();
		if (v === "") delete card.rationale;
		else card.rationale = v;
	}
	if (input.rejected !== void 0) {
		const v = input.rejected.trim();
		if (v === "") delete card.rejected;
		else card.rejected = v;
	}
	if (input.status !== void 0) card.status = input.status;
	if (input.tags !== void 0) card.tags = normalizeTags(input.tags);
	card.updatedAt = Date.now();
	const archived = await archiveExcessDone(cwd, board);
	await writeBoard(cwd, board);
	return viewOf$1(cwd, board, archived);
}
/** Remove one card and return the fresh board view. */
async function removeCard(cwd, id) {
	if (id === "" || id.trim() !== id) throw new TypeError("kanban: card id must be a non-empty, untrimmed string");
	const board = await readBoard(cwd);
	const index = board.cards.findIndex((card) => card.id === id);
	if (index < 0) throw new Error(`kanban: no card with id ${JSON.stringify(id)}`);
	board.cards.splice(index, 1);
	const archived = await archiveExcessDone(cwd, board);
	await writeBoard(cwd, board);
	return viewOf$1(cwd, board, archived);
}
/** The closed set of Agent Note classes (mirrors DSH's classification gate). */
const DEFAULT_NOTE_CLASSES = [
	"feature",
	"bug-fix",
	"simplification",
	"architecture",
	"process",
	"testing"
];
/**
* Default note body template. `{{title}}` and the section placeholders are
* replaced by note_add; section placeholders left empty drop their heading.
* Matches the DSH implemented-note shape (## Decision, ## Consequences,
* ## Alternatives considered optional).
*/
const DEFAULT_NOTE_FORMAT = [
	"# Agent Note: {{title}}",
	"",
	"Status: implemented",
	"",
	"## Problem",
	"",
	"{{problem}}",
	"",
	"## Decision",
	"",
	"{{decision}}",
	"{{alternatives_section}}",
	"{{consequences_section}}",
	""
].join("\n");
/** Default "non-trivial change" definition (mirrors DSH's AGENTS.md rule). */
const DEFAULT_NON_TRIVIAL_DEFINITION = "A change is NON-TRIVIAL (so it needs a note) when it changes behavior, architecture, cross-file or cross-package conventions, process or tooling, test strategy, on-disk storage format, wire/protocol format, or configuration format — or makes any decision a maintainer could reasonably revisit later. Mechanical or local-only edits (renames, formatting, pure comments, no behavior change) are exempt.";
/** Resolve the overrides file path for one workspace. */
function noteOverridesPath(cwd) {
	if (!isAbsolute(cwd)) throw new TypeError(`kanban: workspace must be an absolute path, got ${JSON.stringify(cwd)}`);
	return join(cwd, ".agents", "notes", "overrides.json");
}
/** Read a workspace's overrides (missing file => empty). */
async function readNoteOverrides(cwd) {
	try {
		const raw = await readFile(noteOverridesPath(cwd), "utf8");
		const parsed = JSON.parse(raw);
		return {
			...parsed.specVersion !== void 0 && Number.isSafeInteger(parsed.specVersion) ? { specVersion: parsed.specVersion } : {},
			...parsed.noteClasses !== void 0 && Array.isArray(parsed.noteClasses) && parsed.noteClasses.every((c) => typeof c === "string") ? { noteClasses: parsed.noteClasses } : {},
			...parsed.noteFormat !== void 0 && typeof parsed.noteFormat === "string" ? { noteFormat: parsed.noteFormat } : {},
			...parsed.nonTrivialDefinition !== void 0 && typeof parsed.nonTrivialDefinition === "string" ? { nonTrivialDefinition: parsed.nonTrivialDefinition } : {}
		};
	} catch (error) {
		if (error.code === "ENOENT") return {};
		throw error;
	}
}
/** Persist a workspace's overrides (empty overrides removes the file). */
async function writeNoteOverrides(cwd, overrides) {
	const clean = {};
	if (overrides.specVersion !== void 0) clean.specVersion = overrides.specVersion;
	if (overrides.noteClasses !== void 0 && overrides.noteClasses.length > 0) clean.noteClasses = overrides.noteClasses;
	if (overrides.noteFormat !== void 0 && overrides.noteFormat.trim() !== "") clean.noteFormat = overrides.noteFormat;
	if (overrides.nonTrivialDefinition !== void 0 && overrides.nonTrivialDefinition.trim() !== "") clean.nonTrivialDefinition = overrides.nonTrivialDefinition;
	const path = noteOverridesPath(cwd);
	if (Object.keys(clean).length === 0) return;
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, JSON.stringify(clean, null, 2) + "\n", "utf8");
}
/** Compute the effective spec for a workspace. */
async function effectiveNoteSpec(cwd) {
	const overrides = await readNoteOverrides(cwd);
	const noteClasses = overrides.noteClasses !== void 0 ? [...overrides.noteClasses] : [...DEFAULT_NOTE_CLASSES];
	return {
		specVersion: overrides.specVersion ?? 1,
		noteClasses,
		noteFormat: overrides.noteFormat ?? DEFAULT_NOTE_FORMAT,
		nonTrivialDefinition: overrides.nonTrivialDefinition ?? "A change is NON-TRIVIAL (so it needs a note) when it changes behavior, architecture, cross-file or cross-package conventions, process or tooling, test strategy, on-disk storage format, wire/protocol format, or configuration format — or makes any decision a maintainer could reasonably revisit later. Mechanical or local-only edits (renames, formatting, pure comments, no behavior change) are exempt.",
		hasOverrides: overrides.noteClasses !== void 0 || overrides.noteFormat !== void 0 || overrides.nonTrivialDefinition !== void 0
	};
}
//#endregion
//#region src/index.ts
const name = "dsh-kanban";
const inject = [
	"tools",
	"webServer",
	"systemPrompt",
	"commands"
];
const STATUSES = [
	"todo",
	"in_progress",
	"done"
];
/** Build a {@link BoardToolValue} from a {@link BoardView}. */
function toBoardValue(view) {
	return {
		path: view.path,
		cards: view.cards.map((card) => ({
			id: card.id,
			title: card.title,
			...card.description === void 0 ? {} : { description: card.description },
			...card.summary === void 0 ? {} : { summary: card.summary },
			...card.rationale === void 0 ? {} : { rationale: card.rationale },
			...card.rejected === void 0 ? {} : { rejected: card.rejected },
			...card.sourceSessionId === void 0 ? {} : { sourceSessionId: card.sourceSessionId },
			status: card.status,
			tags: card.tags,
			createdAt: card.createdAt,
			updatedAt: card.updatedAt
		})),
		counts: view.counts,
		...view.archived !== void 0 ? { archived: view.archived } : {}
	};
}
/** Canonical board output shared by every tool: the full fresh board view. */
const BOARD_OUTPUT = {
	schema: {
		type: "object",
		additionalProperties: false,
		properties: {
			path: {
				type: "string",
				required: true
			},
			cards: {
				type: "array",
				required: true,
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						id: {
							type: "string",
							required: true
						},
						title: {
							type: "string",
							required: true
						},
						description: { type: "string" },
						summary: { type: "string" },
						rationale: { type: "string" },
						rejected: { type: "string" },
						sourceSessionId: { type: "string" },
						status: {
							type: "string",
							required: true,
							enum: [
								"todo",
								"in_progress",
								"done"
							]
						},
						tags: {
							type: "array",
							required: true,
							items: { type: "string" }
						},
						createdAt: {
							type: "integer",
							required: true
						},
						updatedAt: {
							type: "integer",
							required: true
						}
					}
				}
			},
			counts: {
				type: "object",
				additionalProperties: false,
				required: true,
				properties: {
					todo: {
						type: "integer",
						required: true
					},
					inProgress: {
						type: "integer",
						required: true
					},
					done: {
						type: "integer",
						required: true
					}
				}
			},
			archived: {
				type: "object",
				additionalProperties: false,
				properties: {
					count: {
						type: "integer",
						required: true
					},
					path: {
						type: "string",
						required: true
					}
				}
			}
		}
	},
	render: (_args, value) => [{
		type: "text",
		text: [
			`Board at ${value.path}`,
			...value.cards.map((card) => `- [${card.status}] ${card.title}${card.tags.length > 0 ? ` ${card.tags.map((t) => `#${t}`).join(" ")}` : ""}`),
			...value.cards.length === 0 ? ["(no cards yet)"] : [],
			...value.archived !== void 0 ? [`Archived ${value.archived.count} done card(s) to ${value.archived.path}`] : []
		].join("\n")
	}]
};
/** Resolve the workspace root for a tool call: the owning session's cwd. */
function workspaceOf(cwd) {
	if (cwd === void 0 || cwd === "") throw new Error("kanban: no workspace — this call has no owning session cwd");
	return cwd;
}
function present(title, kind, rawInput) {
	return {
		card: "generic",
		title,
		kind,
		...rawInput === void 0 ? {} : { rawInput }
	};
}
/**
* The system-prompt guidance that tells the model to actually USE the board
* and to keep Agent Notes for non-trivial changes. This is what makes it an
* active maintenance habit instead of a passive tool: record plans as they
* appear, move cards as work progresses, close them when done — across
* sessions — and write a durable decision note for every non-trivial change.
*/
const BOARD_GUIDANCE = `You have a persistent kanban board (the board_* tools) backed by KANBAN.json at the workspace root — it survives session switches and branches, and it is shared with the Web "看板" page. Use it to track plans and todos that should outlive the current turn: when the user states a multi-step plan or a list of tasks, record each step with board_add (title; status todo; tags for grouping). As work progresses, move cards with board_update (status in_progress → done); when a card is finished or superseded, mark it done or remove it. Prefer the board over todo_write for anything the user should still see after switching branches or opening a new session: todo_write is the transient in-turn task list, while the board is the durable cross-session record. Check board_list when resuming work in a workspace to pick up what was planned before.

Close the loop at the end of every work session: when the user's request is done or reaches a clear stopping point, update the board to reflect reality — move completed cards to done, add any new follow-up as a todo card, and update summaries with what was actually done. Do not leave cards in stale states (e.g. in_progress with no work left); the board must be an honest hand-off for the next session, not a backlog that drifts. This wrap-up is what makes the board a durable memory across sessions.

You also maintain Agent Notes (the note_add / note_list tools) at .agents/notes/implemented/<class>/<date>-<topic>.md, mirroring the DeepSeek Harness repository discipline. ${DEFAULT_NON_TRIVIAL_DEFINITION} After completing a non-trivial change, call note_add with: a class from {${DEFAULT_NOTE_CLASSES.join(", ")}}; a short kebab-case topic; the problem being solved; the decision made; what alternatives were rejected and why; and consequences. Write at DSH engineering depth: Decision states shipped reality in present tense with concrete names and negative guarantees (what is NOT done, boundaries, safety rules); Alternatives are real options that lost, each with why; Consequences records what the trade-off cost and bought. Keep it a few paragraphs, not a full essay.`;
/**
* Session-start board snapshot injected into every assembly (systemPrompt
* context, sync — prompt assembly is synchronous). Reads the current agent's
* workspace KANBAN.json and reports the OPEN items (todo + in_progress) so the
* model sees the board without having to remember to board_list. Only open
* items are injected: done cards churn and would disturb the prompt prefix /
* KV-cache stability for no benefit. Returns '' (contributes nothing) when the
* session has no cwd or the board is empty. Swallows read/parse errors — a
* broken KANBAN.json must never crash prompt assembly (the tools/route still
* fail loud on their own paths).
*/
function boardSnapshotText(context) {
	const cwd = context.agent?.session.header.cwd;
	if (cwd === void 0 || cwd === "") return "";
	let board;
	try {
		board = readBoardSync(cwd);
	} catch {
		return "";
	}
	const open = board.cards.filter((card) => card.status === "todo" || card.status === "in_progress");
	if (open.length === 0) return "";
	return "Current workspace board (KANBAN.json) — open items:\n" + open.map((card) => {
		const tags = card.tags.length > 0 ? ` [${card.tags.join(", ")}]` : "";
		const status = card.status === "in_progress" ? " (in progress)" : "";
		return `- [${card.status}] ${card.title}${status}${tags}`;
	}).join("\n");
}
/** Execute the human `/kanban` command against the receiving agent's workspace. */
async function executeBoardCommand(ctx, invocation) {
	const cwd = invocation.agent?.session.header.cwd;
	if (cwd === void 0 || cwd === "") return {
		kind: "error",
		text: "kanban: no workspace — this session has no cwd"
	};
	const input = invocation.rawInput.trim();
	const done = async (id) => {
		try {
			return renderBoardResult("Marked done.", await updateCard(cwd, id, { status: "done" }));
		} catch (error) {
			return {
				kind: "error",
				text: error instanceof Error ? error.message : String(error)
			};
		}
	};
	const run = async () => {
		if (input === "" || input === "list") try {
			const board = await readBoard(cwd);
			return renderBoardResult(void 0, {
				path: `${cwd}/KANBAN.json`,
				cards: board.cards,
				counts: {
					todo: board.cards.filter((c) => c.status === "todo").length,
					inProgress: board.cards.filter((c) => c.status === "in_progress").length,
					done: board.cards.filter((c) => c.status === "done").length
				}
			});
		} catch (error) {
			return {
				kind: "error",
				text: error instanceof Error ? error.message : String(error)
			};
		}
		if (input.startsWith("done ")) {
			const id = input.slice(5).trim();
			if (id === "") return {
				kind: "error",
				text: "Usage: /kanban done <card-id>"
			};
			return await done(id);
		}
		return {
			kind: "error",
			text: "Usage: /kanban [list|done <card-id>]"
		};
	};
	return run();
}
/** Render a board document as a `/kanban` command result. */
function renderBoardResult(heading, view) {
	return {
		kind: "success",
		text: [
			...heading !== void 0 ? [heading] : [],
			`Board at ${view.path}`,
			...view.cards.map((card) => `- [${card.status}] ${card.title}${card.tags.length > 0 ? ` ${card.tags.map((t) => `#${t}`).join(" ")}` : ""}`),
			...view.cards.length === 0 ? ["(no cards yet)"] : []
		].join("\n")
	};
}
/** Register the `/kanban` command (view + quick done). */
function registerBoardCommand(ctx) {
	ctx.commands.register({
		name: "kanban",
		description: "view or update the workspace kanban board",
		input: { hint: "[list|done <card-id>]" },
		handler: (invocation) => executeBoardCommand(ctx, invocation)
	});
}
/**
* The default closed set of Agent Note classes (mirrors DSH's classification
* gate). The tool schema advertises the defaults; at execution time the
* workspace's effective spec (defaults + user overrides) is authoritative.
*/
const NOTE_CLASSES = DEFAULT_NOTE_CLASSES;
/** Canonical note file name: <yyyy-mm-dd>-<kebab-topic>.md */
function noteFileName(topic) {
	const kebab = topic.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return `${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}-${kebab === "" ? "note" : kebab}.md`;
}
/** Resolve a note path under the workspace. */
function notePath(cwd, noteClass, topic) {
	if (!isAbsolute(cwd)) throw new TypeError(`kanban: workspace must be an absolute path, got ${JSON.stringify(cwd)}`);
	return join(cwd, ".agents", "notes", "implemented", noteClass, noteFileName(topic));
}
/** Render the note body template with the note's fields. */
function renderNoteBody(spec, title, body) {
	const alternatives = body.alternatives?.trim() ?? "";
	const consequences = body.consequences?.trim() ?? "";
	const alternativesSection = alternatives === "" ? "" : `## Alternatives considered\n\n${alternatives}`;
	const consequencesSection = consequences === "" ? "" : `## Consequences\n\n${consequences}`;
	return spec.noteFormat.replaceAll("{{title}}", title).replaceAll("{{problem}}", body.problem.trim()).replaceAll("{{decision}}", body.decision.trim()).replaceAll("{{alternatives}}", alternatives).replaceAll("{{consequences}}", consequences).replaceAll("{{alternatives_section}}", alternativesSection).replaceAll("{{consequences_section}}", consequencesSection);
}
/** Write one Agent Note file using the workspace's effective spec. */
async function writeAgentNote(cwd, noteClass, topic, body) {
	const spec = await effectiveNoteSpec(cwd);
	if (noteClass !== void 0 && !spec.noteClasses.includes(noteClass)) throw new TypeError(`kanban: note class ${JSON.stringify(noteClass)} is not in the effective note classes (${spec.noteClasses.join(", ")})`);
	const path = notePath(cwd, noteClass, topic);
	const title = topic.trim();
	if (title === "") throw new TypeError("kanban: note topic must be a non-empty string");
	if (body.problem.trim() === "" || body.decision.trim() === "") throw new TypeError("kanban: note requires a problem and a decision");
	const content = renderNoteBody(spec, title, body) + "\n";
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content, "utf8");
	return path;
}
const NOTE_OUTPUT = {
	schema: {
		type: "object",
		additionalProperties: false,
		properties: {
			path: {
				type: "string",
				required: true
			},
			noteClass: {
				type: "string",
				required: true,
				enum: NOTE_CLASSES
			},
			topic: {
				type: "string",
				required: true
			}
		}
	},
	render: (_args, value) => [{
		type: "text",
		text: `Agent Note written to ${value.path}`
	}]
};
/** List existing Agent Notes under the workspace, grouped by class. */
async function listAgentNotes(cwd) {
	if (!isAbsolute(cwd)) throw new TypeError(`kanban: workspace must be an absolute path, got ${JSON.stringify(cwd)}`);
	const root = join(cwd, ".agents", "notes", "implemented");
	const found = [];
	for (const noteClass of NOTE_CLASSES) try {
		const entries = await readdir(join(root, noteClass));
		for (const entry of entries) if (entry.endsWith(".md")) found.push(join(root, noteClass, entry));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	return found.sort();
}
/** Register the four model-facing board tools. */
function apply(ctx) {
	ctx.systemPrompt.section({
		name: "tool:board",
		order: 113,
		text: BOARD_GUIDANCE
	});
	ctx.systemPrompt.context({
		name: "board:open-items",
		order: 114,
		text: boardSnapshotText
	});
	registerBoardCommand(ctx);
	ctx.tools.register(defineTool({
		name: "board_list",
		description: "Read the current workspace kanban board (all cards with their status, tags, and timestamps). Call this before board_add / board_update / board_remove so you operate on real ids and current state. The board is persisted to KANBAN.json at the workspace root and survives across sessions and branches.",
		parameters: {},
		output: BOARD_OUTPUT,
		execute(_args, exec) {
			const cwd = workspaceOf(exec.agent?.session.header.cwd);
			return readBoard(cwd).then((board) => ({
				path: `${cwd}/KANBAN.json`,
				cards: board.cards.map((card) => ({
					id: card.id,
					title: card.title,
					...card.description === void 0 ? {} : { description: card.description },
					...card.summary === void 0 ? {} : { summary: card.summary },
					...card.rationale === void 0 ? {} : { rationale: card.rationale },
					...card.rejected === void 0 ? {} : { rejected: card.rejected },
					...card.sourceSessionId === void 0 ? {} : { sourceSessionId: card.sourceSessionId },
					status: card.status,
					tags: card.tags,
					createdAt: card.createdAt,
					updatedAt: card.updatedAt
				})),
				counts: {
					todo: board.cards.filter((c) => c.status === "todo").length,
					inProgress: board.cards.filter((c) => c.status === "in_progress").length,
					done: board.cards.filter((c) => c.status === "done").length
				}
			}));
		},
		presentCall: () => present("Read kanban board", "read")
	}));
	ctx.tools.register(defineTool({
		name: "board_add",
		description: "Add a card to the current workspace kanban board. Use it to persist a plan step or todo so it survives session switches and shows up on the Web board page. When the user states a multi-step plan or a list of tasks, record each concrete step here. The board lives at KANBAN.json in the workspace root.",
		parameters: {
			title: {
				type: "string",
				required: true,
				description: "Non-empty card title (a concrete, actionable step)."
			},
			description: {
				type: "string",
				description: "Optional free-form detail for the card."
			},
			summary: {
				type: "string",
				description: "Optional: what was done (Agent-Note style)."
			},
			rationale: {
				type: "string",
				description: "Optional: why it was done (Agent-Note style)."
			},
			rejected: {
				type: "string",
				description: "Optional: what was rejected or given up (Agent-Note style)."
			},
			status: {
				type: "string",
				enum: STATUSES,
				description: "Initial status; defaults to todo."
			},
			tags: {
				type: "array",
				items: { type: "string" },
				description: "Optional labels (e.g. [\"dsh\", \"urgent\"])."
			}
		},
		output: BOARD_OUTPUT,
		execute(args, exec) {
			return addCard(workspaceOf(exec.agent?.session.header.cwd), {
				title: args.title,
				...args.description === void 0 ? {} : { description: args.description },
				...args.summary === void 0 ? {} : { summary: args.summary },
				...args.rationale === void 0 ? {} : { rationale: args.rationale },
				...args.rejected === void 0 ? {} : { rejected: args.rejected },
				...exec.agent !== void 0 ? { sourceSessionId: exec.agent.id } : {},
				...args.status === void 0 ? {} : { status: args.status },
				...args.tags === void 0 ? {} : { tags: args.tags }
			}).then(toBoardValue);
		},
		presentCall: (args) => present("Add kanban card", "other", args.title)
	}));
	ctx.tools.register(defineTool({
		name: "board_update",
		description: "Update one card on the current workspace kanban board by its exact id. Use it to move a card between todo / in_progress / done, or to edit its title, description, or tags. Call board_list first to get the id.",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Exact card id returned by board_list."
			},
			status: {
				type: "string",
				enum: STATUSES,
				description: "New status: todo | in_progress | done."
			},
			title: {
				type: "string",
				description: "Replacement title."
			},
			description: {
				type: "string",
				description: "Replacement description; empty string clears it."
			},
			summary: {
				type: "string",
				description: "Replacement \"what was done\"; empty string clears it."
			},
			rationale: {
				type: "string",
				description: "Replacement \"why it was done\"; empty string clears it."
			},
			rejected: {
				type: "string",
				description: "Replacement \"what was rejected\"; empty string clears it."
			},
			tags: {
				type: "array",
				items: { type: "string" },
				description: "Replacement tags."
			}
		},
		output: BOARD_OUTPUT,
		execute(args, exec) {
			const cwd = workspaceOf(exec.agent?.session.header.cwd);
			const patch = {};
			if (args.status !== void 0) patch.status = args.status;
			if (args.title !== void 0) patch.title = args.title;
			if (args.description !== void 0) patch.description = args.description;
			if (args.summary !== void 0) patch.summary = args.summary;
			if (args.rationale !== void 0) patch.rationale = args.rationale;
			if (args.rejected !== void 0) patch.rejected = args.rejected;
			if (args.tags !== void 0) patch.tags = args.tags;
			return updateCard(cwd, args.id, patch).then(toBoardValue);
		},
		presentCall: (args) => present("Update kanban card", "other", args.status ? `${args.id} → ${args.status}` : args.id)
	}));
	ctx.tools.register(defineTool({
		name: "board_remove",
		description: "Remove one card from the current workspace kanban board by its exact id. Call board_list first to get the id.",
		parameters: { id: {
			type: "string",
			required: true,
			description: "Exact card id returned by board_list."
		} },
		output: BOARD_OUTPUT,
		execute(args, exec) {
			return removeCard(workspaceOf(exec.agent?.session.header.cwd), args.id).then(toBoardValue);
		},
		presentCall: (args) => present("Remove kanban card", "other", args.id)
	}));
	ctx.tools.register(defineTool({
		name: "note_add",
		description: "Write an Agent Note documenting a NON-TRIVIAL change, at .agents/notes/implemented/<class>/<date>-<topic>.md (mirrors the DeepSeek Harness repository discipline). A change is non-trivial when it changes behavior, architecture, cross-file/cross-package conventions, process or tooling, test strategy, storage/wire/config format, or makes a decision a maintainer could reasonably revisit. Call this AFTER completing such a change, alongside any board cards — the note records the why and what was rejected that the code cannot. Write at DSH engineering depth: the Decision states shipped reality in the present tense (concrete names, contracts, boundaries — not a summary); include negative guarantees and edge cases (what is NOT done, permission/ownership boundaries, safety rules); Alternatives must be REAL options that lost, each with why (never invented); Consequences records what the trade-off COST and BOUGHT; cross-link related notes by relative path when they exist under .agents/notes.",
		parameters: {
			class: {
				type: "string",
				required: true,
				enum: NOTE_CLASSES,
				description: "Note class: feature | bug-fix | simplification | architecture | process | testing."
			},
			topic: {
				type: "string",
				required: true,
				description: "Short kebab-case topic (e.g. \"web-kanban-plugin\")."
			},
			problem: {
				type: "string",
				required: true,
				description: "The motivation, written to stand without the solution (one short paragraph)."
			},
			decision: {
				type: "string",
				required: true,
				description: "Shipped reality in present tense: concrete implementation facts, names, contracts, boundaries, and negative guarantees (what is NOT done). A few paragraphs."
			},
			alternatives: {
				type: "string",
				description: "Real alternatives that were rejected, each with why it lost — one bold-led paragraph per alternative. Never invent alternatives."
			},
			consequences: {
				type: "string",
				description: "What the trade-off cost AND bought: side effects, follow-up obligations, named coverage gaps."
			}
		},
		output: NOTE_OUTPUT,
		execute(args, exec) {
			return writeAgentNote(workspaceOf(exec.agent?.session.header.cwd), args.class, args.topic, {
				problem: args.problem,
				decision: args.decision,
				...args.alternatives === void 0 ? {} : { alternatives: args.alternatives },
				...args.consequences === void 0 ? {} : { consequences: args.consequences }
			}).then((path) => ({
				path,
				noteClass: args.class,
				topic: args.topic
			}));
		},
		presentCall: (args) => present("Write Agent Note", "other", args.topic)
	}));
	ctx.tools.register(defineTool({
		name: "note_list",
		description: "List existing Agent Notes under the current workspace (.agents/notes/implemented/**). Use it before note_add to avoid duplicating a note that already covers the decision.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { notes: {
					type: "array",
					required: true,
					items: { type: "string" }
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: value.notes.length === 0 ? "No Agent Notes yet." : ["Agent Notes:", ...value.notes].join("\n")
			}]
		},
		execute(_args, exec) {
			return listAgentNotes(workspaceOf(exec.agent?.session.header.cwd)).then((notes) => ({ notes }));
		},
		presentCall: () => present("List Agent Notes", "read")
	}));
	registerWebApi(ctx);
}
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
/** Write a JSON body with a status code. */
function sendJson(res, status, value) {
	res.writeHead(status, JSON_HEADERS);
	res.end(JSON.stringify(value));
}
/** Collect a request body (bounded). */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > 262144) {
				reject(/* @__PURE__ */ new Error("kanban: request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
/** Shared POST mutation dispatch; every op returns the fresh board view. */
async function applyMutation(cwd, body) {
	switch (body.op) {
		case "add": return await addCard(cwd, {
			title: body.title ?? "",
			...body.description === void 0 ? {} : { description: body.description },
			...body.summary === void 0 ? {} : { summary: body.summary },
			...body.rationale === void 0 ? {} : { rationale: body.rationale },
			...body.rejected === void 0 ? {} : { rejected: body.rejected },
			...body.status === void 0 ? {} : { status: body.status },
			...body.tags === void 0 ? {} : { tags: body.tags }
		});
		case "update": {
			if (body.id === void 0) throw new TypeError("kanban: update requires id");
			const patch = {};
			if (body.title !== void 0) patch.title = body.title;
			if (body.description !== void 0) patch.description = body.description;
			if (body.summary !== void 0) patch.summary = body.summary;
			if (body.rationale !== void 0) patch.rationale = body.rationale;
			if (body.rejected !== void 0) patch.rejected = body.rejected;
			if (body.status !== void 0) patch.status = body.status;
			if (body.tags !== void 0) patch.tags = body.tags;
			return await updateCard(cwd, body.id, patch);
		}
		case "remove":
			if (body.id === void 0) throw new TypeError("kanban: remove requires id");
			return await removeCard(cwd, body.id);
		default: throw new TypeError(`kanban: unknown op ${JSON.stringify(body.op)}`);
	}
}
/** Build the fresh board view for a workspace (the route's read path). */
async function viewOf(cwd) {
	const board = await readBoard(cwd);
	return {
		path: `${cwd}/KANBAN.json`,
		cards: board.cards,
		counts: {
			todo: board.cards.filter((c) => c.status === "todo").length,
			inProgress: board.cards.filter((c) => c.status === "in_progress").length,
			done: board.cards.filter((c) => c.status === "done").length
		}
	};
}
/** Register GET/POST /kanban/api — the Web board page's data channel. */
function registerWebApi(ctx) {
	const server = ctx.get("webServer");
	if (server === void 0) return;
	server.register({
		kind: "prefix",
		path: "/kanban/api",
		handler: (req, res) => {
			handle(req, res).catch((error) => {
				if (!res.writableEnded) sendJson(res, 500, {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				});
			});
		}
	});
	server.register({
		kind: "prefix",
		path: "/kanban/spec",
		handler: (req, res) => {
			handleSpec(req, res).catch((error) => {
				if (!res.writableEnded) sendJson(res, 500, {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				});
			});
		}
	});
	server.register({
		kind: "prefix",
		path: "/kanban/counts",
		handler: (req, res) => {
			handleCounts(req, res).catch((error) => {
				if (!res.writableEnded) sendJson(res, 500, {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				});
			});
		}
	});
	async function handleCounts(req, res) {
		const cwd = new URL(req.url ?? "/", "http://localhost").searchParams.get("cwd");
		if (cwd === null || cwd === "") {
			sendJson(res, 400, {
				ok: false,
				error: "kanban: GET /kanban/counts requires a cwd query parameter"
			});
			return;
		}
		const open = (await readBoard(cwd)).cards.filter((card) => card.status === "todo" || card.status === "in_progress").length;
		sendJson(res, 200, {
			ok: true,
			open,
			cwd
		});
	}
	async function handleSpec(req, res) {
		const method = req.method ?? "GET";
		if (method === "GET") {
			const cwd = new URL(req.url ?? "/", "http://localhost").searchParams.get("cwd");
			if (cwd === null || cwd === "") {
				sendJson(res, 400, {
					ok: false,
					error: "kanban: GET /kanban/spec requires a cwd query parameter"
				});
				return;
			}
			const spec = await effectiveNoteSpec(cwd);
			sendJson(res, 200, {
				ok: true,
				specVersion: spec.specVersion,
				pluginSpecVersion: 1,
				noteClasses: spec.noteClasses,
				noteFormat: spec.noteFormat,
				nonTrivialDefinition: spec.nonTrivialDefinition,
				hasOverrides: spec.hasOverrides,
				overridesPath: noteOverridesPath(cwd)
			});
			return;
		}
		if (method === "POST") {
			const raw = await readBody(req);
			let body;
			try {
				body = JSON.parse(raw);
			} catch (error) {
				sendJson(res, 400, {
					ok: false,
					error: `kanban: invalid JSON body: ${error.message}`
				});
				return;
			}
			if (typeof body.cwd !== "string" || body.cwd === "") {
				sendJson(res, 400, {
					ok: false,
					error: "kanban: POST /kanban/spec requires body.cwd"
				});
				return;
			}
			const overrides = {
				...body.noteClasses !== void 0 ? { noteClasses: body.noteClasses } : {},
				...body.noteFormat !== void 0 ? { noteFormat: body.noteFormat } : {},
				...body.nonTrivialDefinition !== void 0 ? { nonTrivialDefinition: body.nonTrivialDefinition } : {},
				...body.acknowledgeSpecVersion !== void 0 ? { specVersion: body.acknowledgeSpecVersion } : {}
			};
			await writeNoteOverrides(body.cwd, overrides);
			const spec = await effectiveNoteSpec(body.cwd);
			sendJson(res, 200, {
				ok: true,
				specVersion: spec.specVersion,
				pluginSpecVersion: 1,
				noteClasses: spec.noteClasses,
				noteFormat: spec.noteFormat,
				nonTrivialDefinition: spec.nonTrivialDefinition,
				hasOverrides: spec.hasOverrides,
				overridesPath: noteOverridesPath(body.cwd)
			});
			return;
		}
		sendJson(res, 405, {
			ok: false,
			error: `kanban: method ${method} not allowed`
		});
	}
	async function handle(req, res) {
		const method = req.method ?? "GET";
		if (method === "GET") {
			const cwd = new URL(req.url ?? "/", "http://localhost").searchParams.get("cwd");
			if (cwd === null || cwd === "") {
				sendJson(res, 400, {
					ok: false,
					error: "kanban: GET /kanban/api requires a cwd query parameter"
				});
				return;
			}
			sendJson(res, 200, {
				ok: true,
				...await viewOf(cwd)
			});
			return;
		}
		if (method === "POST") {
			const raw = await readBody(req);
			let body;
			try {
				body = JSON.parse(raw);
			} catch (error) {
				sendJson(res, 400, {
					ok: false,
					error: `kanban: invalid JSON body: ${error.message}`
				});
				return;
			}
			if (typeof body.cwd !== "string" || body.cwd === "") {
				sendJson(res, 400, {
					ok: false,
					error: "kanban: POST /kanban/api requires body.cwd"
				});
				return;
			}
			try {
				sendJson(res, 200, {
					ok: true,
					...await applyMutation(body.cwd, body)
				});
			} catch (error) {
				sendJson(res, 400, {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				});
			}
			return;
		}
		sendJson(res, 405, {
			ok: false,
			error: `kanban: method ${method} not allowed`
		});
	}
}
//#endregion
export { NOTE_CLASSES, apply, inject, name };
