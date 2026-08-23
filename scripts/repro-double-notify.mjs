#!/usr/bin/env node
// Regression: the double-toast mechanisms formerly in client.js scan().
//   Case 1: completion + pending in the same snapshot  -> ONE toast (needs-you)
//   Case 2: parent + subagent child both finish        -> ONE toast (root)
//   Case 3: subagent child pending                     -> ONE toast (its own)
//   Case 4: fork child (no origin) completion          -> ONE toast (its own)
// Run: node scripts/repro-double-notify.mjs (asserts exit code 0 when fixed)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const clientJs = readFileSync(new URL('../plugins/dsh-client-notifications/client.js', import.meta.url), 'utf8')

let calls = []
globalThis.__DSH_BRIDGE_PORT__ = '39999'
globalThis.fetch = (url, opts = {}) => {
  if (String(url).includes('/notify')) calls.push(JSON.parse(opts.body || '{}'))
  return Promise.resolve({ ok: true })
}
const windowStub = { __ModuleLoader__: { load(h) { windowStub.__handoff = h } } }
globalThis.window = windowStub
globalThis.document = { hasFocus: () => false, hidden: false }
// eslint-disable-next-line no-eval
eval(clientJs)
const plugin = windowStub.__handoff.factory()

let state = { ids: [], byId: {} }
const listeners = new Set()
const list = {
  getSnapshot: () => state,
  subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
}
const ctx = { sessions: { list } }
function mutate(patch) { state = { ...state, ...patch }; for (const l of [...listeners]) l() }
function session(id, fields) { return { id, displayTitle: id, running: false, updatedAt: 1, ...fields } }
function introduce(id, fields = {}) { mutate({ ids: [id], byId: { [id]: session(id, fields) } }) }

const dispose = plugin.apply(ctx)
const titles = () => calls.map((c) => c.title)

// Case 1: task finishes AND pending question in the SAME snapshot -> 1 toast
introduce('sess-T1', { running: true, title: '写周报' })
calls = []
mutate({ ids: ['sess-T1'], byId: { 'sess-T1': session('sess-T1', { running: false, pendingInteraction: 'question', title: '写周报' }) } })
assert.equal(calls.length, 1, `completion+pending same snapshot -> 1 post, got ${calls.length}`)
assert.deepEqual(titles(), ['dsh 需要你'], `expected needs-you only, got ${JSON.stringify(titles())}`)

// Case 2: parent + subagent child both finish -> 1 toast (parent)
introduce('sess-T2', { running: true, title: '主任务' })
mutate({ ids: ['sess-T2', 'sess-T2c'], byId: { 'sess-T2': session('sess-T2', { running: true, title: '主任务' }), 'sess-T2c': session('sess-T2c', { running: true, origin: 'subagent', parentId: 'sess-T2', cwd: '/work' }) } })
calls = []
mutate({ ids: ['sess-T2', 'sess-T2c'], byId: { 'sess-T2': session('sess-T2', { running: false, completed: true, title: '主任务' }), 'sess-T2c': session('sess-T2c', { running: false, origin: 'subagent', parentId: 'sess-T2', cwd: '/work' }) } })
assert.equal(calls.length, 1, `parent+subagent-child finish -> 1 post, got ${calls.length}`)
assert.equal(calls[0]?.sessionId, 'sess-T2')

// Case 3: subagent child pending -> its own needs-you toast (not silent)
calls = []
mutate({ ids: ['sess-T2c'], byId: { 'sess-T2c': session('sess-T2c', { running: false, pendingInteraction: 'approval', origin: 'subagent', parentId: 'sess-T2', cwd: '/work' }) } })
assert.equal(calls.length, 1, `subagent child pending -> 1 post, got ${calls.length}`)
assert.equal(calls[0]?.title, 'dsh 需要你')
assert.equal(calls[0]?.sessionId, 'sess-T2c')

// Case 4: fork child (parentId, origin absent) completes -> its own toast
introduce('sess-T3', { running: true, title: '原会话' })
mutate({ ids: ['sess-T3', 'sess-T3f'], byId: { 'sess-T3': session('sess-T3', { running: false, completed: true, title: '原会话' }), 'sess-T3f': session('sess-T3f', { running: true, parentId: 'sess-T3', title: '分支' }) } })
calls = []
mutate({ ids: ['sess-T3f'], byId: { 'sess-T3f': session('sess-T3f', { running: false, completed: true, parentId: 'sess-T3', title: '分支' }) } })
assert.equal(calls.length, 1, `fork child completion -> 1 post, got ${calls.length}`)
assert.equal(calls[0]?.sessionId, 'sess-T3f')

dispose()
console.log('PASS — double-notify regressions hold (no double toasts, subagent needs-you preserved)')
process.exit(0)