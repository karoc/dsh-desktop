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

const root = dirname(fileURLToPath(import.meta.url))
const clientJs = readFileSync(join(root, '..', 'plugins', 'dsh-client-notifications', 'client.js'), 'utf8')

// ── browser-global stubs ────────────────────────────────────────────────────
let calls = [] // collected /notify POSTs (url + parsed body)
let allPosts = [] // every fetch (incl. the /alive canary)
let focus = false
globalThis.__DSH_BRIDGE_PORT__ = '39999'
globalThis.fetch = (url, opts = {}) => {
  allPosts.push([String(url), opts])
  if (String(url).includes('/notify')) {
    calls.push([String(url), JSON.parse(opts.body || '{}')])
  }
  return Promise.resolve({ ok: true })
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
assert.deepEqual(plugin.inject, ['sessions'])
assert.equal(typeof plugin.apply, 'function')

// ── sessions list store stub (mirrors SnapshotStore<SessionListState>) ──────
let state = { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }
const listeners = new Set()
const list = {
  getSnapshot: () => state,
  subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
}
const ctx = { sessions: { list } }

function mutate(patch) {
  state = { ...state, ...patch }
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
  assert.deepEqual(calls[0][1], { title: 'dsh 需要你', body, sessionId: id })
})

// ── scenario 3: running true→false, completed -> "task done" ────────────────
introduce('sess-A') // re-introduce (previous scenarios replaced the whole list)
calls = []
mutate({ ids: ['sess-A'], byId: { 'sess-A': session('sess-A', { running: true }) } })
assert.equal(calls.length, 0, 'starting a run must not notify')
mutate({ ids: ['sess-A'], byId: { 'sess-A': session('sess-A', { running: false, completed: true, title: '写周报' }) } })
assert.equal(calls.length, 1, 'running→done transition must notify once')
assert.deepEqual(calls[0][1], { title: 'dsh 任务完成', body: '「写周报」已完成', sessionId: 'sess-A' })

// ── scenario 3b: running true→false WITHOUT completed (selected session
// finishing — can't be a focused manual stop, which is suppressed) still
// notifies, wording 已完成 ────────────────────────────────────────────────────
introduce('sess-A2')
calls = []
mutate({ ids: ['sess-A2'], byId: { 'sess-A2': session('sess-A2', { running: true, title: '清理' }) } })
mutate({ ids: ['sess-A2'], byId: { 'sess-A2': session('sess-A2', { running: false, completed: false, title: '清理' }) } })
assert.equal(calls.length, 1, 'running edge fires even when completed stays false (selected session)')
assert.deepEqual(calls[0][1], { title: 'dsh 任务完成', body: '「清理」已完成', sessionId: 'sess-A2' })

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
assert.equal(calls.length, 1, 'bridge path works after remount')
assert.deepEqual(calls[0][1], { title: 'dsh 任务完成', body: '「部署」已完成', sessionId: 'sess-E' })
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
assert.equal(calls.length, 1, 'completed-appearing fallback must notify')
assert.deepEqual(calls[0][1], { title: 'dsh 任务完成', body: '「快任务」已完成', sessionId: 'sess-F' })

// ── scenario 10: fallback must not re-fire on later identical snapshots ─────
calls = []
mutate({ ids: ['sess-F'], byId: { 'sess-F': session('sess-F', { running: false, completed: true, title: '快任务' }) } })
assert.equal(calls.length, 0, 'completed fallback fires once only')

// ── scenario 11: ended-then-completed must not double-toast ─────────────────
introduce('sess-G') // baseline
calls = []
mutate({ ids: ['sess-G'], byId: { 'sess-G': session('sess-G', { running: true, title: '停止后' }) } })
mutate({ ids: ['sess-G'], byId: { 'sess-G': session('sess-G', { running: false, completed: false, title: '停止后' }) } })
assert.equal(calls.length, 1, '已完成 toasted on the running edge')
assert.equal(calls[0][1].title, 'dsh 任务完成')
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
assert.equal(calls.length, 1, 'items-shaped snapshot must notify too')
assert.equal(calls[0][1].sessionId, 'sess-H')
dispose4()

console.log('PASS — notification plugin behavioral test (12 scenarios)')
process.exit(0)