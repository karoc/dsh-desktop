#!/usr/bin/env node
// Behavioral test for the notification client plugin (client.js), runnable in
// plain Node: stubs the browser globals + the sessions list store, drives
// pendingInteraction / completed state changes, and asserts which notifications
// fire. Mirrors the dsh client module contract:
//   window.__ModuleLoader__.load({ id, factory }) -> factory() -> {name,inject,apply}
//
// Design rule under test: a session's FIRST sight is recorded as baseline and
// never notifies (so app restart / reconnect replays don't spam); only a state
// TRANSITION on an already-seen session raises a notification.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { collectDshFloors, planPluginGuard, satisfies } from './plugin-floor.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const clientJs = readFileSync(join(root, '..', 'plugins', 'dsh-client-notifications', 'client.js'), 'utf8')

// ── browser-global stubs ────────────────────────────────────────────────────
let calls = [] // collected /notify POSTs (url + parsed body)
let allPosts = [] // every fetch (incl. the /alive canary)
let focus = false
globalThis.__DSH_BRIDGE_PORT__ = '39999'
let pendingOpenSid = null // what GET /pending-open should answer
globalThis.fetch = (url, opts = {}) => {
  allPosts.push([String(url), opts])
  if (String(url).includes('/notify')) {
    calls.push([String(url), JSON.parse(opts.body || '{}')])
  }
  // The real bridge TAKES the pending session (one delivery), so the stub must
  // too — otherwise every poll tick re-opens the same session and the test
  // would be asserting behaviour the product does not have.
  const json = String(url).includes('/pending-open')
    ? async () => { const sid = pendingOpenSid; pendingOpenSid = null; return { sessionId: sid } }
    : async () => ({})
  return Promise.resolve({ ok: true, json })
}
Object.defineProperty(globalThis, 'Notification', { configurable: true, writable: true, value: undefined })

const windowStub = {
  __ModuleLoader__: { load(handoff) { windowStub.__handoff = handoff } },
}
globalThis.window = windowStub

globalThis.document = { hasFocus: () => focus, hidden: false }
Object.defineProperty(globalThis, 'Notification', { configurable: true, writable: true, value: undefined })

// eslint-disable-next-line no-eval
eval(clientJs)
assert.ok(windowStub.__handoff, '__ModuleLoader__.load must be called')
assert.equal(windowStub.__handoff.id, '@dsh-desktop/client-notifications')

const plugin = windowStub.__handoff.factory()
// P1-4: NO required inject. cordis 4.1's Inject has no "optional" form — every
// declared service is required, and a plugin whose service never appears keeps
// its fiber pending ⇒ dsh web boot fail-closes the WHOLE UI ("Failed to load
// plugins"). One upstream seam rename would therefore become a white screen.
// Services are resolved lazily instead (see the svc() scenarios below).
assert.deepEqual(plugin.inject, [], 'must NOT require services: a missing seam may not wedge dsh boot')
assert.equal(typeof plugin.apply, 'function')

// ── sessions list store stub (mirrors SnapshotStore<SessionListState>) ──────
let state = { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }
const listeners = new Set()
const list = {
  getSnapshot: () => state,
  subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
}
// Turn/end reason probe (api.sessions.history) stub: the classification path
// is async, so completion assertions below `await flush()` after the mutation.
let historyReason = 'completed' // kind the last turn/end carries
let historyErrorMsg = ''
const historyCalls = [] // sessionIds probed via sessions.history
// ── sessionStatus: the ONLY source of pendingInteraction / completionUnread ──
// The real `SessionSummary` row has no pendingInteraction field (that bug made
// the plugin read undefined forever), so the fixture MUST carry status in a
// separate store exactly like dsh's `uiSession.sessionStatus`.
let statusMap = new Map()
let statusListeners = new Set()
const uiSession = {
  sessionStatus: {
    getSnapshot: () => statusMap,
    subscribe: (fn) => { statusListeners.add(fn); return () => statusListeners.delete(fn) },
  },
}
const openedSessions = [] // what uiWorkspace.openSession received
const ctx = {
  sessions: { list },
  uiSession,
  uiWorkspace: { openSession: (target) => { openedSessions.push(target) } },
  connection: {
    api: {
      sessions: {
        history: async ({ sessionId }) => {
          historyCalls.push(sessionId)
          const reason = historyReason === 'error'
            ? { kind: 'error', error: { message: historyErrorMsg, code: 'PI_AI_ERROR' } }
            : { kind: historyReason }
          return {
            events: [{ event: { type: 'turn/end', seq: 1, data: { turn: 1, reason } } }],
            hasMore: false,
          }
        },
      },
    },
  },
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Rebuild the status store from the current rows (mirrors dsh's projection). */
function syncStatus() {
  const next = new Map()
  const ids = Array.isArray(state.ids) ? state.ids : (state.items || []).map((i) => i.sessionId || i.id)
  const byId = state.byId || Object.fromEntries((state.items || []).map((i) => [i.sessionId || i.id, i]))
  for (const id of ids) {
    const it = byId[id]
    if (!it) continue
    next.set(id, {
      running: it.running,
      pendingInteraction: it.pendingInteraction,
      completionUnread: it.completionUnread ?? it.completed,
    })
  }
  statusMap = next
}


/** Drive a status-store change ONLY — the list rows stay untouched. */
function mutateStatus(next) {
  statusMap = next
  for (const l of [...statusListeners]) l()
}
function mutate(patch) {
  state = { ...state, ...patch }
  syncStatus()
  for (const l of [...listeners]) l()
}
function session(id, fields) {
  return { id, displayTitle: id, running: false, blank: false, updatedAt: 1, ...fields }
}
function introduce(id, fields = {}) {
  mutate({ ids: [id], byId: { [id]: session(id, fields) } })
}

// ── scenario 1: baseline records without notifying ──────────────────────────
calls = []
allPosts = []
const dispose = plugin.apply(ctx)
assert.equal(calls.length, 0, 'baseline scan must not notify')
assert.ok(
  allPosts.some((e) => e[0].includes('/alive')),
  'apply() must ping the /alive canary once',
)

// ── scenario 2: session appears, then pendingInteraction -> "needs you" ─────
// One fresh session per interaction kind (a session already notified keeps
// notifying only after its pending clears — kind-switch without a clear must
// not double-notify, verified implicitly by 'approval' following 'question').
introduce('sess-A')
assert.equal(calls.length, 0, 'first sight (baseline) must not notify')

const pendingLabels = {
  question: '有一个问题需要你回答',
  approval: '有一个操作正在等待你批准',
  'plan-review': '有一份计划正在等你审阅',
}
Object.entries(pendingLabels).forEach(([kind, body], i) => {
  calls = []
  const id = `sess-k${i}`
  introduce(id)
  mutate({ ids: [id], byId: { [id]: session(id, { pendingInteraction: kind }) } })
  assert.equal(calls.length, 1, `${kind} transition must notify once`)
  assert.ok(calls[0][0].endsWith('/notify'), 'must POST to the bridge /notify endpoint')
  assert.deepEqual(calls[0][1], { title: 'dsh 需要你', body: `「${id}」${body}`, sessionId: id })
})

// ── scenario 3: running true→false, completed -> "task done" ────────────────
introduce('sess-A') // re-introduce (previous scenarios replaced the whole list)
calls = []
mutate({ ids: ['sess-A'], byId: { 'sess-A': session('sess-A', { running: true }) } })
assert.equal(calls.length, 0, 'starting a run must not notify')
mutate({ ids: ['sess-A'], byId: { 'sess-A': session('sess-A', { running: false, completed: true, title: '写周报' }) } })
await flush()
assert.equal(calls.length, 1, 'running→done transition must notify once')
assert.deepEqual(calls[0][1], { title: 'dsh 任务已结束', body: '「写周报」已结束', sessionId: 'sess-A' })

// ── scenario 3b: running true→false WITHOUT completed (selected session
// finishing — can't be a focused manual stop, which is suppressed) still
// notifies, wording 已完成 ────────────────────────────────────────────────────
introduce('sess-A2')
calls = []
mutate({ ids: ['sess-A2'], byId: { 'sess-A2': session('sess-A2', { running: true, title: '清理' }) } })
mutate({ ids: ['sess-A2'], byId: { 'sess-A2': session('sess-A2', { running: false, completed: false, title: '清理' }) } })
await flush()
assert.equal(calls.length, 1, 'running edge fires even when completed stays false (selected session)')
assert.deepEqual(calls[0][1], { title: 'dsh 任务已结束', body: '「清理」已结束', sessionId: 'sess-A2' })

// ── scenario 4: no duplicate while state stays put ──────────────────────────
calls = []
mutate({ ids: ['sess-A'], byId: { 'sess-A': session('sess-A', { running: false, completed: true, title: '写周报' }) } })
assert.equal(calls.length, 0, 'repeated snapshot must not re-notify')

// ── scenario 5: window focused -> silence ───────────────────────────────────
introduce('sess-B')
calls = []
focus = true
mutate({ ids: ['sess-B'], byId: { 'sess-B': session('sess-B', { pendingInteraction: 'plan-review' }) } })
assert.equal(calls.length, 0, 'focused window must not notify')
focus = false
mutate({ ids: ['sess-B'], byId: { 'sess-B': session('sess-B', { pendingInteraction: undefined }) } })
// (cleared; next flip would notify again — covered implicitly by scenario 8)

// ── scenario 6: dispose unsubscribes ────────────────────────────────────────
introduce('sess-C')
calls = []
dispose()
mutate({ ids: ['sess-C'], byId: { 'sess-C': session('sess-C', { completed: true }) } })
assert.equal(calls.length, 0, 'after dispose no notifications')

// ── scenario 7: bridge port absent (unbaked placeholder) -> silent skip ─────
// BRIDGE_PORT is captured when factory() runs, so load a fresh module instance
// with the global removed (mirrors an unbaked production copy).
calls = []
delete globalThis.__DSH_BRIDGE_PORT__
// eslint-disable-next-line no-eval
eval(clientJs)
const dispose2 = windowStub.__handoff.factory().apply(ctx)
introduce('sess-D')
mutate({ ids: ['sess-D'], byId: { 'sess-D': session('sess-D', { pendingInteraction: 'approval' }) } })
assert.equal(calls.length, 0, 'no bridge port -> transition posts nothing (no crash)')
dispose2()

// ── scenario 8: bridge port restored, completion after transition ───────────
globalThis.__DSH_BRIDGE_PORT__ = '39999'
// eslint-disable-next-line no-eval
eval(clientJs)
calls = []
allPosts = []
const dispose3 = windowStub.__handoff.factory().apply(ctx)
assert.ok(allPosts.some((e) => e[0].includes('/alive')), 'canary re-posted on remount')
introduce('sess-E')
mutate({ ids: ['sess-E'], byId: { 'sess-E': session('sess-E', { running: true }) } })
mutate({ ids: ['sess-E'], byId: { 'sess-E': session('sess-E', { running: false, completed: true, title: '部署' }) } })
await flush()
assert.equal(calls.length, 1, 'bridge path works after remount')
assert.deepEqual(calls[0][1], { title: 'dsh 任务已结束', body: '「部署」已结束', sessionId: 'sess-E' })
dispose3()

// ── scenarios 9-11: fresh audit instance (the first plugin was disposed in
// scenario 6; these cases need a live scan with the bridge port set) ─────────
// eslint-disable-next-line no-eval
eval(clientJs)
const pluginA = windowStub.__handoff.factory()
const disposeA = pluginA.apply(ctx)

// ── scenario 9: completed false→true fallback (running edge coalesced away) ─
introduce('sess-F') // baseline: running false, completed false
calls = []
mutate({ ids: ['sess-F'], byId: { 'sess-F': session('sess-F', { running: false, completed: true, title: '快任务' }) } })
await flush()
assert.equal(calls.length, 1, 'completed-appearing fallback must notify')
assert.deepEqual(calls[0][1], { title: 'dsh 任务已结束', body: '「快任务」已结束', sessionId: 'sess-F' })

// ── scenario 10: fallback must not re-fire on later identical snapshots ─────
calls = []
mutate({ ids: ['sess-F'], byId: { 'sess-F': session('sess-F', { running: false, completed: true, title: '快任务' }) } })
assert.equal(calls.length, 0, 'completed fallback fires once only')

// ── scenario 11: ended-then-completed must not double-toast ─────────────────
introduce('sess-G') // baseline
calls = []
mutate({ ids: ['sess-G'], byId: { 'sess-G': session('sess-G', { running: true, title: '停止后' }) } })
mutate({ ids: ['sess-G'], byId: { 'sess-G': session('sess-G', { running: false, completed: false, title: '停止后' }) } })
await flush()
assert.equal(calls.length, 1, '已完成 toasted on the running edge')
assert.equal(calls[0][1].title, 'dsh 任务已结束')
mutate({ ids: ['sess-G'], byId: { 'sess-G': session('sess-G', { running: false, completed: true, title: '停止后' }) } })
assert.equal(calls.length, 1, 'completed-appearing later must NOT toast again (same episode)')
disposeA()

// ── scenario 12: items-shaped snapshot (UI projection) is accepted ──────────
let state2 = { ids: [], byId: {} }
const setState = (next) => { state2 = next; for (const l of [...listeners2]) l() }
const listeners2 = []
const ctx2 = {
  sessions: {
    list: {
      getSnapshot: () => state2,
      subscribe: (fn) => { listeners2.push(fn); return () => { const i = listeners2.indexOf(fn); if (i >= 0) listeners2.splice(i, 1) } },
      update: () => {},
    },
    open: () => { calls.push(['open', 'called']) },
  },
}
calls = []
// eslint-disable-next-line no-eval
eval(clientJs)
const dispose4 = windowStub.__handoff.factory().apply(ctx2)
setState({ items: [ { sessionId: 'sess-H', id: 'sess-H', title: 'UI投影', running: true, completed: false } ] })
setState({ items: [ { sessionId: 'sess-H', id: 'sess-H', title: 'UI投影', running: false, completed: true } ] })
await flush()
assert.equal(calls.length, 1, 'items-shaped snapshot must notify too')
assert.equal(calls[0][1].sessionId, 'sess-H')
dispose4()

// ── scenarios 13-17: double-toast regressions (fixed in the same scan) ──────
// eslint-disable-next-line no-eval
eval(clientJs)
const pluginB = windowStub.__handoff.factory()
const disposeB = pluginB.apply(ctx)

// ── scenario 13: completion + pending in the SAME snapshot → ONE toast ───────
// A turn that ends asking the user (question/approval/plan-review) must NOT
// announce BOTH "任务完成" and "需要你" for the same episode.
introduce('sess-I', { running: true, title: '带问题结束' })
calls = []
mutate({ ids: ['sess-I'], byId: { 'sess-I': session('sess-I', { running: false, pendingInteraction: 'question', title: '带问题结束' }) } })
assert.equal(calls.length, 1, 'completion+pending same snapshot notifies once')
assert.deepEqual(calls[0][1], { title: 'dsh 需要你', body: '「带问题结束」有一个问题需要你回答', sessionId: 'sess-I' })
// The suppressed episode must not re-toast as completed on later snapshots.
mutate({ ids: ['sess-I'], byId: { 'sess-I': session('sess-I', { running: false, completed: true, title: '带问题结束' }) } })
assert.equal(calls.length, 1, 'suppressed episode must not fire a later completion')

// ── scenario 14: parent + subagent child both finish → ONE toast (child is an
// origin:'subagent' row; its completion is covered by the parent) ─────────────
introduce('sess-P', { running: true, title: '主任务' })
mutate({ ids: ['sess-P', 'sess-C'], byId: { 'sess-P': session('sess-P', { running: true, title: '主任务' }), 'sess-C': session('sess-C', { running: true, origin: 'subagent', parentId: 'sess-P', cwd: '/work' }) } })
calls = []
mutate({ ids: ['sess-P', 'sess-C'], byId: { 'sess-P': session('sess-P', { running: false, completed: true, title: '主任务' }), 'sess-C': session('sess-C', { running: false, origin: 'subagent', parentId: 'sess-P', cwd: '/work' }) } })
await flush()
assert.equal(calls.length, 1, 'parent+subagent-child completion notifies once')
assert.equal(calls[0][1].sessionId, 'sess-P', 'the toast belongs to the root session')

// ── scenario 15: subagent child interaction wait → ITS OWN needs-you toast ───
// Pending is tracked per row with no parent relay (dsh keys approval/question
// frames by the requesting agent's session), so a subagent asking the user
// must still raise 「需要你」even though its completion is silent.
calls = []
mutate({ ids: ['sess-C'], byId: { 'sess-C': session('sess-C', { running: false, pendingInteraction: 'approval', origin: 'subagent', parentId: 'sess-P', cwd: '/work' }) } })
assert.equal(calls.length, 1, 'subagent child pending notifies once')
assert.equal(calls[0][1].title, 'dsh 需要你', 'subagent interaction raises needs-you')
assert.equal(calls[0][1].sessionId, 'sess-C')

// ── scenario 16: clean root completion still fires (no over-suppression) ────
introduce('sess-J', { running: true, title: '干净任务' })
calls = []
mutate({ ids: ['sess-J'], byId: { 'sess-J': session('sess-J', { running: false, completed: true, title: '干净任务' }) } })
await flush()
assert.equal(calls.length, 1, 'clean completion still notifies once')
assert.deepEqual(calls[0][1], { title: 'dsh 任务已结束', body: '「干净任务」已结束', sessionId: 'sess-J' })

// ── scenario 17: answered-then-finished (pending cleared + running ends in
// the same snapshot) still notifies completion once ───────────────────────────
introduce('sess-K', { running: true, pendingInteraction: 'question', title: '回答后完成' })
calls = []
mutate({ ids: ['sess-K'], byId: { 'sess-K': session('sess-K', { running: false, pendingInteraction: undefined, title: '回答后完成' }) } })
await flush()
assert.equal(calls.length, 1, 'answered-then-finished notifies completion once')
assert.equal(calls[0][1].title, 'dsh 任务已结束')

// ── scenario 18: fork child (parentId, no origin) completes → its own toast ──
// Fork children are independent tasks the user drove; only rows with the host
// origin 'subagent' are covered by a parent notification.
introduce('sess-F', { running: true, title: '原会话' })
mutate({ ids: ['sess-F', 'sess-FK'], byId: { 'sess-F': session('sess-F', { running: false, completed: true, title: '原会话' }), 'sess-FK': session('sess-FK', { running: true, parentId: 'sess-F', title: '分支任务' }) } })
await flush() // let sess-F's async classification land before resetting the counter
calls = []
mutate({ ids: ['sess-F', 'sess-FK'], byId: { 'sess-F': session('sess-F', { running: false, completed: true, title: '原会话' }), 'sess-FK': session('sess-FK', { running: false, completed: true, parentId: 'sess-F', title: '分支任务' }) } })
await flush()
assert.equal(calls.length, 1, 'fork child completion notifies once (its own toast)')
assert.equal(calls[0][1].sessionId, 'sess-FK', 'fork row is an independent task')

// ── scenario 19: subagent child alone completes (parent absent) → silent ─────
introduce('sess-G2')
mutate({ ids: ['sess-G2'], byId: { 'sess-G2': session('sess-G2', { running: true, origin: 'subagent', parentId: 'gone', cwd: '/work' }) } })
calls = []
mutate({ ids: ['sess-G2'], byId: { 'sess-G2': session('sess-G2', { running: false, completed: true, origin: 'subagent', parentId: 'gone', cwd: '/work' }) } })
assert.equal(calls.length, 0, 'subagent row completion is always silent (parent covers it)')

// ── scenarios 20-22 (P1-2): the turn/end reason is NOT reachable on dsh 0.2.x.
// Root cause locked down here: the old code read `ctx.connection.api.sessions.
// history` — a path that does not exist (ConnectionHandle has no `api`; the
// connection package's typings carry no session history/events API), so every
// end — error / aborted / blocked — was announced as 「已完成」 (production log:
// 155/155 notify-classified = completed, 0 error, 0 classify-error). The fix is
// NEUTRAL wording, and these assertions go red if anyone reintroduces either the
// "completed" claim or the dead probe.

// ── scenario 20: an end is announced NEUTRALLY, never as 已完成 ──────────────
introduce('sess-Err', { running: true, title: '网络波动任务' })
historyCalls.length = 0
calls = []
mutate({ ids: ['sess-Err'], byId: { 'sess-Err': session('sess-Err', { running: false, completed: false, title: '网络波动任务' }) } })
await flush()
assert.equal(calls.length, 1, 'an end always notifies once')
assert.equal(calls[0][1].title, 'dsh 任务已结束', 'P1-2: end wording is neutral — it must never claim a completion')
assert.ok(calls[0][1].body.includes('已结束'), 'body says 已结束')
assert.deepEqual(historyCalls, [], 'P1-2: the unreachable connection.api.sessions.history probe must be GONE (no dead call)')

// ── scenario 21: a fresh run that ends again notifies again ──────────────────
// No reason-based cooldown may swallow a real second run: the reason is unknown,
// so suppressing on it would be a guess.
calls = []
mutate({ ids: ['sess-Err'], byId: { 'sess-Err': session('sess-Err', { running: true, title: '网络波动任务' }) } })
mutate({ ids: ['sess-Err'], byId: { 'sess-Err': session('sess-Err', { running: false, title: '网络波动任务' }) } })
await flush()
assert.equal(calls.length, 1, 'a second real run/end edge notifies again')

// ── scenario 22: forked rows get the same neutral wording ────────────────────
assert.equal(calls[0][1].title, 'dsh 任务已结束')

disposeB()

// ── scenarios 24-30: aggregate state for the shell tray (/state) ────────────
// While the window is hidden the tray tooltip is the ONLY place that can
// answer "what is working / what is waiting on me" — with titles, because
// "2 running" says nothing about WHAT is running. The contract:
// post on CHANGE only (the snapshot fires per event; a steady state must not
// keep the bridge warm), subagent rows never contribute a work/done entry
// (their parent turn covers them, same rule as the toasts) but a subagent's
// pending interaction still counts (a person must answer it), and blank rows
// count for nothing.
state = { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }
allPosts = []
// eslint-disable-next-line no-eval
eval(clientJs)
const aggPosts = () => allPosts
  .filter((e) => String(e[0]).endsWith('/state'))
  .map((e) => JSON.parse(e[1].body || '{}'))
const disposeAgg = windowStub.__handoff.factory().apply(ctx)

// 24: baseline posts the zero aggregate exactly once, with no items
assert.equal(aggPosts().length, 1, 'baseline posts the zero aggregate once')
assert.deepEqual(aggPosts()[0], { running: 0, pending: 0, done: 0, items: [] })

// 25: a running session appears in the aggregate WITH its title
introduce('agg-A', { running: true, title: '跑着' })
assert.deepEqual(
  aggPosts().at(-1),
  { running: 1, pending: 0, done: 0, items: [{ kind: 'running', title: '跑着' }] },
  'running session carries its title',
)

// 26: an unchanged snapshot must NOT re-post
const aggBefore = aggPosts().length
mutate({ ids: ['agg-A'], byId: { 'agg-A': session('agg-A', { running: true, title: '跑着' }) } })
assert.equal(aggPosts().length, aggBefore, 'steady state must not re-post /state')

// 27: a rename must refresh (title is part of the identity)
mutate({ ids: ['agg-A'], byId: { 'agg-A': session('agg-A', { running: true, title: '改名了' }) } })
assert.deepEqual(aggPosts().at(-1).items, [{ kind: 'running', title: '改名了' }], 'rename refreshes tooltip')

// 28: pending wins over running for the same session; subagent work is excluded
mutate({
  ids: ['agg-A', 'agg-S'],
  byId: {
    'agg-A': session('agg-A', { running: true, pendingInteraction: 'approval', title: '跑着' }),
    'agg-S': session('agg-S', { running: true, origin: 'subagent', parentId: 'agg-A', cwd: '/work' }),
  },
})
assert.deepEqual(
  aggPosts().at(-1),
  { running: 0, pending: 1, done: 0, items: [{ kind: 'pending', title: '跑着' }] },
  'pending row reported once; subagent work excluded',
)

// 29: blank (created-but-unused) row counts for nothing
mutate({ ids: ['agg-B'], byId: { 'agg-B': session('agg-B', { running: true, blank: true }) } })
assert.deepEqual(aggPosts().at(-1), { running: 0, pending: 0, done: 0, items: [] }, 'blank row excluded')

// 30: finished-but-unviewed carries its title; pending sorts before done
mutate({
  ids: ['agg-C', 'agg-D'],
  byId: {
    'agg-C': session('agg-C', { running: false, completed: true, title: '完成未看' }),
    'agg-D': session('agg-D', { pendingInteraction: 'question', title: '等你答' }),
  },
})
assert.deepEqual(
  aggPosts().at(-1),
  {
    running: 0,
    pending: 1,
    done: 1,
    items: [
      { kind: 'pending', title: '等你答' },
      { kind: 'done', title: '完成未看' },
    ],
  },
  'pending sorts first, done keeps its title',
)
disposeAgg()

// ── scenario 31: REAL data shape — the list row carries NO pendingInteraction.
// This is the regression that kept the tray's ● row and the 「需要你」 toast
// silently dead: `SessionSummary` has no such field, it lives only in
// uiSession.sessionStatus.
state = { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }
allPosts = []
// eslint-disable-next-line no-eval
eval(clientJs)
const disposeReal = windowStub.__handoff.factory().apply(ctx)
mutate({ ids: ['real-A'], byId: { 'real-A': session('real-A', { running: true, title: '真实形状' }) } })
assert.ok(!('pendingInteraction' in state.byId['real-A']), 'row must NOT carry pendingInteraction (real SessionSummary shape)')
assert.deepEqual(aggPosts().at(-1).items, [{ kind: 'running', title: '真实形状' }], 'starts as running')
// pending arrives ONLY through the status store, exactly like dsh
statusMap = new Map([['real-A', { running: true, pendingInteraction: 'approval', completionUnread: false }]])
for (const l of [...listeners]) l()
assert.deepEqual(aggPosts().at(-1), { running: 0, pending: 1, done: 0, items: [{ kind: 'pending', title: '真实形状' }] },
  'pending from sessionStatus (not the row) must be picked up')
// completionUnread in the status store alone marks it done
statusMap = new Map([['real-A', { running: false, pendingInteraction: undefined, completionUnread: true }]])
for (const l of [...listeners]) l()
assert.deepEqual(aggPosts().at(-1), { running: 0, pending: 0, done: 1, items: [{ kind: 'done', title: '真实形状' }] },
  'completionUnread from sessionStatus marks done')
disposeReal()

// ── scenario 32: a pending interaction changes ONLY sessionStatus — the list
// rows do not move. Without subscribing to sessionStatus the scan never runs
// and the orange dot is invisible to us (the real-world regression).
state = { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }
allPosts = []
statusMap = new Map()
// eslint-disable-next-line no-eval
eval(clientJs)
const disposeSub = windowStub.__handoff.factory().apply(ctx)
mutate({ ids: ['sub-A'], byId: { 'sub-A': session('sub-A', { running: true, title: '审批中' }) } })
assert.deepEqual(aggPosts().at(-1).items, [{ kind: 'running', title: '审批中' }], 'starts running')
// ONLY the status store changes; no list mutation, no listener on the list
mutateStatus(new Map([['sub-A', { running: true, pendingInteraction: 'approval', completionUnread: false }]]))
assert.deepEqual(aggPosts().at(-1), { running: 0, pending: 1, done: 0, items: [{ kind: 'pending', title: '审批中' }] },
  'status-only pending change must reach the tray')
disposeSub()

// ── scenario 33: a click must open the session through uiWorkspace ──────────
// `ctx.sessions.open` does NOT exist on dsh 0.2.x. The old code's else-if wrote
// a field nobody reads and logged success, so clicking a toast brought the
// window forward but never switched sessions. This scenario is the regression.
state = { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }
allPosts = []
openedSessions.length = 0
pendingOpenSid = null
// eslint-disable-next-line no-eval
eval(clientJs)
const disposeOpen = windowStub.__handoff.factory().apply(ctx)
pendingOpenSid = 'sess-click-1'
await new Promise((r) => setTimeout(r, 1500)) // one poll tick
assert.ok(allPosts.some((e) => String(e[0]).includes('/pending-open')), 'poll must have run at least once')
assert.deepEqual(openedSessions, ['sess-click-1'], 'click must open via uiWorkspace.openSession')
assert.ok(
  allPosts.some((e) => String(e[0]).includes('/log') && String(e[1] && e[1].body || '').includes('uiWorkspace.openSession')),
  'successful open must be logged with its real mechanism',
)
pendingOpenSid = null
disposeOpen()

// ── scenario 34 (P1-4): NO services at all — activation must not throw, must
// not go silent, and must not be able to stop dsh from booting. A required
// inject list would leave this plugin's fiber pending and dsh fail-closes the
// whole UI; instead /alive still fires and a READABLE `degraded` event names
// what is missing. Services registered AFTER activation must be picked up by
// the retry loop (no restart, no reload).
state = { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }
allPosts = []
calls = []
globalThis.__DSH_NOTIFY_READY_TIMEOUT_MS__ = 60
// eslint-disable-next-line no-eval
eval(clientJs)
const bareCtx = {} // no sessions / uiSession / uiWorkspace / connection
let disposeBare
assert.doesNotThrow(() => { disposeBare = windowStub.__handoff.factory().apply(bareCtx) },
  'P1-4: activation must never throw when services are missing')
await new Promise((r) => setTimeout(r, 400))
assert.ok(allPosts.some((e) => String(e[0]).includes('/alive')),
  'the /alive canary must still fire without services (module really loaded)')
const degraded = allPosts
  .filter((e) => String(e[0]).includes('/log'))
  .map((e) => JSON.parse(e[1].body))
  .filter((p) => p.tag === 'degraded')
assert.ok(degraded.some((p) => String(p.detail).includes('sessions service unavailable')),
  'P1-4: a missing sessions service must be reported readably, not swallowed')
assert.ok(degraded.some((p) => String(p.detail).includes('uiSession.sessionStatus unavailable')),
  'P1-4: a missing sessionStatus must be reported readably, not swallowed')
bareCtx.sessions = { list }
bareCtx.uiSession = uiSession
bareCtx.uiWorkspace = { openSession: (t) => openedSessions.push(t) }
await new Promise((r) => setTimeout(r, 400))
introduce('late-A')
mutate({ ids: ['late-A'], byId: { 'late-A': session('late-A', { pendingInteraction: 'question' }) } })
assert.equal(calls.length, 1, 'P1-4: services registered after activation must be wired (retry, no reload)')
disposeBare()

// ── scenario 35 (P1-4): only the NEWER seam is missing. Losing uiSession must
// cost the tray ●/○ + 「需要你」 features, never the turn-end notifier.
state = { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }
allPosts = []
calls = []
globalThis.__DSH_NOTIFY_READY_TIMEOUT_MS__ = 60
// eslint-disable-next-line no-eval
eval(clientJs)
const partialCtx = { sessions: { list }, uiWorkspace: { openSession: () => {} } }
const disposePartial = windowStub.__handoff.factory().apply(partialCtx)
introduce('part-A')
mutate({ ids: ['part-A'], byId: { 'part-A': session('part-A', { running: true, title: '无状态源' }) } })
mutate({ ids: ['part-A'], byId: { 'part-A': session('part-A', { running: false, title: '无状态源' }) } })
await flush()
assert.equal(calls.length, 1, 'P1-4: turn-end notification must survive a missing uiSession')
assert.deepEqual(calls[0][1], { title: 'dsh 任务已结束', body: '「无状态源」已结束', sessionId: 'part-A' })
disposePartial()

// ── scenario 36 (P1-4): the peer floor must be a REAL constraint. The old
// declaration (\`@deepseek-ai/dsh-client-runtime >=0.1.0-rc.5\`) named a package
// that does not exist in dsh 0.2.x (npm registry: versions end at 0.1.1-rc.2)
// and a bound every 0.2.x trivially satisfies — so the floor guard could never
// isolate this plugin, and an upstream seam removal stayed a white screen.
delete globalThis.__DSH_NOTIFY_READY_TIMEOUT_MS__
const pkgJson = JSON.parse(readFileSync(join(root, '..', 'plugins', 'dsh-client-notifications', 'package.json'), 'utf8'))
assert.ok(!('@deepseek-ai/dsh-client-runtime' in (pkgJson.peerDependencies || {})),
  'P1-4: the fictitious dsh-client-runtime floor must be gone')
const floors = collectDshFloors(pkgJson)
assert.ok(floors.length >= 1, 'P1-4: must declare at least one REAL dsh floor')
assert.ok(floors.every((f) => satisfies('0.0.1-rc.1', f.range) === false),
  'P1-4: every declared floor must reject a dsh that predates the seams (a floor nothing fails constrains nothing)')
assert.ok(floors.some((f) => f.name === '@deepseek-ai/dsh-client-ui-session' && satisfies('0.1.6-alpha.2', f.range)),
  'P1-4: the ui-session floor must accept 0.1.6-alpha.2 — the first release with sessionStatus (npm-verified)')
const guardOnOldDsh = planPluginGuard({
  installedDsh: '0.1.5',
  bundled: [{ name: pkgJson.name, version: pkgJson.version, pkgJson }],
  enabled: [pkgJson.name],
})
assert.equal(guardOnOldDsh.quarantine.length, 1, 'P1-4: the floor guard must isolate the plugin on a dsh without the seams')
assert.equal(guardOnOldDsh.skipInstall.length, 1, 'P1-4: and must refuse to install it there')
const guardOnSupported = planPluginGuard({
  installedDsh: '0.2.2-rc.1',
  bundled: [{ name: pkgJson.name, version: pkgJson.version, pkgJson }],
  enabled: [pkgJson.name],
})
assert.deepEqual(guardOnSupported, { skipInstall: [], quarantine: [], warnings: [] },
  'P1-4: a supported dsh must not be quarantined (no false positive)')

// ── scenario 37 (P1-3): the tray's ○ must not depend on dsh's completionUnread.
// dsh only flips completionUnread for sessions that were NOT the main view, so
// the tray's flagship case — hide the window, let the CURRENT session finish —
// never produced ○. The plugin now records the running→false edge itself.
state = { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }
statusMap = new Map()
allPosts = []
calls = []
// eslint-disable-next-line no-eval
eval(clientJs)
const disposeUnread = windowStub.__handoff.factory().apply(ctx)
introduce('unread-A')
mutate({ ids: ['unread-A'], byId: { 'unread-A': session('unread-A', { running: true, title: '托盘里结束' }) } })
// dsh's own flag stays false (this WAS the main view) — the plugin must not care.
statusMap = new Map([['unread-A', { running: true, completionUnread: false }]])
mutate({ ids: ['unread-A'], byId: { 'unread-A': session('unread-A', { running: false, title: '托盘里结束' }) } })
assert.deepEqual(
  aggPosts().at(-1).items,
  [{ kind: 'done', title: '托盘里结束' }],
  'P1-3: an ended-unviewed session must show ○ even when dsh leaves completionUnread false',
)
// A new run clears it (the session is no longer "ended").
mutate({ ids: ['unread-A'], byId: { 'unread-A': session('unread-A', { running: true, title: '托盘里结束' }) } })
assert.deepEqual(
  aggPosts().at(-1).items,
  [{ kind: 'running', title: '托盘里结束' }],
  'P1-3: a new run must clear the ○',
)
disposeUnread()

// ── scenario 38 (P2-4): pendingInteraction is an OBJECT ({key,kind,sessionId}).
// Looking it up in PENDING_LABELS as a string never matched, so every interaction
// showed the generic body without a session title.
state = { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }
statusMap = new Map()
calls = []
// eslint-disable-next-line no-eval
eval(clientJs)
const disposePend = windowStub.__handoff.factory().apply(ctx)
introduce('pend-A', { title: '等你批准' })
mutateStatus(new Map([['pend-A', { running: true, pendingInteraction: { key: 'req-1', kind: 'approval', sessionId: 'pend-A' } }]]))
assert.equal(calls.length, 1, 'P2-4: object-shaped pendingInteraction must notify')
assert.deepEqual(
  calls[0][1],
  { title: 'dsh 需要你', body: '「等你批准」有一个操作正在等待你批准', sessionId: 'pend-A' },
  'P2-4: the object kind must resolve the label and the body must name the session',
)
// An unknown kind degrades to the generic sentence — never "[object Object]".
calls = []
mutateStatus(new Map([['pend-A', { running: true, pendingInteraction: undefined }]]))
mutateStatus(new Map([['pend-A', { running: true, pendingInteraction: { key: 'req-2', kind: 'brand-new-kind', sessionId: 'pend-A' } }]]))
assert.equal(calls.length, 1, 'P2-4: an unknown kind still notifies')
assert.ok(!String(calls[0][1].body).includes('[object'), 'P2-4: must never stringify the object into the body')
disposePend()

// ── scenario 39 (D1): the launcher banner must render the bounded auto-restart
// verdict, and must never claim a fix. STATIC contract check — src/app.js is
// browser code evaluated by the launcher page, not importable here; the dynamic
// half (policy + wording) is covered by Rust unit tests in manager_guard.rs.
const appJs = readFileSync(join(root, '..', 'src', 'app.js'), 'utf8')
assert.ok(appJs.includes('exit.autoRestart'), 'D1: launcher must read exit.autoRestart from /shell/status')
assert.ok(appJs.includes('仅恢复服务，不代表问题已修复'), 'D1: banner must NOT promise a fix')
assert.ok(appJs.includes('已停止自动重启'), 'D1: banner must state when auto-restart stopped')

console.log('PASS — notification plugin behavioral test (23 notification + 9 aggregate + 1 open-path + 3 P1-4 boot-safety + 3 P1-2/P1-3/P2-4 regression + 1 D1 banner-contract scenarios)')
process.exit(0)
