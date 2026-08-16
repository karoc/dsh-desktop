#!/usr/bin/env node
// Behavioral test for the plugin-console client (client.js), runnable in plain
// Node: stubs the browser globals + a minimal DOM, drives the floating panel,
// and asserts which bridge calls fire and with which payloads.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = dirname(fileURLToPath(import.meta.url))
const clientJs = readFileSync(join(root, '..', 'plugins', 'dsh-plugin-console', 'client.js'), 'utf8')

// ── minimal DOM stub (createElement / appendChild / querySelector) ──────────
function makeEl(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    listeners: {},
    className: '',
    _text: '',
    _html: '',
    id: '',
    title: '',
    disabled: false,
    classList: {
      toggle(cls, force) {
        const has = el.className.split(/\s+/).includes(cls)
        const want = force === undefined ? !has : Boolean(force)
        if (want && !has) el.className = (el.className + ' ' + cls).trim()
        if (!want && has) el.className = el.className.split(/\s+/).filter((c) => c !== cls).join(' ')
      },
      add(cls) { this.toggle(cls, true) },
      remove(cls) { this.toggle(cls, false) },
    },
    appendChild(c) { el.children.push(c); return c },
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn) },
    click() { (el.listeners.click || []).forEach((fn) => fn()) },
    querySelector(sel) { return el.querySelectorAll(sel)[0] || null },
    querySelectorAll(sel) {
      const out = []
      const walk = (n) => {
        for (const c of n.children) {
          if (sel.startsWith('#')) { if (c.id === sel.slice(1)) out.push(c) }
          else if (sel.startsWith('[')) {
            const key = sel.match(/\[([\w-]+)\]/)?.[1]
            // `[data-x]` maps to dataset.x (real DOM dataset semantics).
            const prop = key && key.startsWith('data-') ? key.slice(5) : key
            if (prop && c.dataset[prop] !== undefined) out.push(c)
          } else if (sel.startsWith('.')) {
            if (c.className.split(/\s+/).includes(sel.slice(1))) out.push(c)
          } else if (c.tagName === sel.toUpperCase()) out.push(c)
          walk(c)
        }
      }
      walk(el)
      return out
    },
  }
  // Real DOM semantics the panel relies on: setting textContent replaces
  // children; setting innerHTML parses the markup into children.
  Object.defineProperty(el, 'textContent', {
    get() { return el._text },
    set(v) { el._text = v; el.children = [] },
  })
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html },
    set(v) { el._html = v; parseChildren(el, v) },
  })
  return el
}

// Tiny HTML parser: <tag attrs>text|children</tag> -> stub elements.
function parseChildren(el, html) {
  const out = []
  let rest = html
  const openRe = /<([a-z0-9]+)([^>]*)>/i
  while (rest.length) {
    const m = openRe.exec(rest)
    if (!m) break
    const [full, tag, attrs] = m
    const afterOpen = m.index + full.length
    const closeRe = new RegExp(`</${tag}>`, 'i')
    const restAfter = rest.slice(afterOpen)
    const cm = restAfter.search(closeRe)
    const child = makeEl(tag)
    const attrRe = /([\w-]+)="([^"]*)"/g
    let a
    while ((a = attrRe.exec(attrs))) {
      if (a[1] === 'class') child.className = a[2]
      else if (a[1] === 'id') child.id = a[2]
      else if (a[1].startsWith('data-')) child.dataset[a[1].slice(5)] = a[2]
      else child[a[1]] = a[2]
    }
    if (cm >= 0) {
      const inner = restAfter.slice(0, cm)
      // Use the ACTUAL matched close-tag length (the regex source escapes the
      // slash: `<\/button>` is one char longer than `</button>`).
      const closeText = restAfter.slice(cm).match(closeRe)?.[0] ?? ''
      if (/<[a-z]/i.test(inner)) parseChildren(child, inner)
      else child.textContent = inner
      out.push(child)
      rest = rest.slice(afterOpen + cm + closeText.length)
    } else {
      out.push(child)
      rest = rest.slice(afterOpen)
    }
  }
  el.children.push(...out)
}

const body = makeEl('body')
const head = makeEl('head')
let navigatorLang = 'zh-CN'
let bridgePort = '39999'
const calls = [] // [path, method, body]
let listPayload = {
  bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'some-user-plugin'],
  preinstalled: [{ name: 'dsh-model-reasoning', description: 'per-model reasoning effort settings' }],
  update: { current: '1.0.0', latest: '1.1.0', updateAvailable: true },
  op: { op: null, done: true },
  devMode: false,
}

// Node 24 exposes navigator as a getter-only global; override via defineProperty.
Object.defineProperty(globalThis, 'navigator', { value: { language: navigatorLang }, configurable: true, writable: true })
globalThis.__DSH_BRIDGE_PORT__ = bridgePort
globalThis.fetch = (url, opts = {}) => {
  const path = String(url).replace(/^http:\/\/127\.0\.0\.1:\d+/, '')
  calls.push([path, opts.method || 'GET', opts.body ? JSON.parse(opts.body) : null])
  if (path === '/plugins/list') return Promise.resolve({ text: () => Promise.resolve(JSON.stringify(listPayload)) })
  if (path === '/plugins/enable' || path === '/plugins/disable') {
    return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ ok: true, nextAction: 'restart' })) })
  }
  if (path === '/update-status') return Promise.resolve({ text: () => Promise.resolve('{}') })
  return Promise.resolve({ text: () => Promise.resolve('{}') })
}
globalThis.document = {
  body,
  head,
  createElement: (t) => makeEl(t),
  getElementById: () => null,
  appendChild: (c) => { body.appendChild(c) },
}
globalThis.window = { __ModuleLoader__: { load(h) { window.__handoff = h } } }

// eslint-disable-next-line no-eval
eval(clientJs)
assert.ok(window.__handoff, '__ModuleLoader__.load must be called')
assert.equal(window.__handoff.id, '@dsh-desktop/plugin-console')
const plugin = window.__handoff.factory()
assert.deepEqual(plugin.inject, [], 'console plugin needs no dsh services')

// ── scenario 1: apply mounts the floating button ───────────────────────────
plugin.apply({})
const btn = body.children.find((c) => c.className === 'dshc-btn')
assert.ok(btn, 'floating button must be mounted')

// ── scenario 2: clicking the button opens the panel and fetches /plugins/list ─
btn.click()
const panel = body.children.find((c) => c.className === 'dshc-panel')
assert.ok(panel, 'panel must be created on first click')
const listCall = calls.find((c) => c[0] === '/plugins/list')
assert.ok(listCall, 'opening the panel fetches /plugins/list')
assert.equal(listCall[1], 'GET')
await new Promise((r) => setTimeout(r, 10)) // let the async render finish

// ── scenario 3: preinstalled row renders with a toggle button ───────────────
const toggle = panel.querySelectorAll('[data-toggle]')
assert.equal(toggle.length, 1, 'one preinstalled plugin row with a toggle')
assert.equal(toggle[0].dataset.toggle, 'dsh-model-reasoning')

// ── scenario 4: toggle posts enable (name not in bundles) then disable ──────
toggle[0].click()
await new Promise((r) => setTimeout(r, 15))
const enableCall = calls.filter((c) => c[0] === '/plugins/enable')
assert.equal(enableCall.length, 1, 'enable POST fired')
assert.deepEqual(enableCall[0][2], { name: 'dsh-model-reasoning' }, 'enable body carries the package name')

// now it's enabled -> clicking again disables
listPayload = { ...listPayload, bundles: [...listPayload.bundles, 'dsh-model-reasoning'] }
calls.length = 0
btn.click() // re-open triggers refresh
btn.click() // close
btn.click() // open
await new Promise((r) => setTimeout(r, 10))
toggle[0].click()
await new Promise((r) => setTimeout(r, 15))
const disableCall = calls.filter((c) => c[0] === '/plugins/disable')
assert.equal(disableCall.length, 1, 'disable POST fired after enable state')
assert.deepEqual(disableCall[0][2], { name: 'dsh-model-reasoning' })

// ── scenario 5: update section shows one-click update when available ────────
calls.length = 0
btn.click()
await new Promise((r) => setTimeout(r, 10))
const updateBtn = panel.querySelector('#dshc-update')
assert.ok(updateBtn, 'one-click update button shown when an update is available')
updateBtn.click()
const updateCall = calls.find((c) => c[0] === '/update-dsh')
assert.ok(updateCall, 'update button POSTs /update-dsh')
assert.equal(updateCall[1], 'POST')

// ── scenario 6: action buttons map to the right endpoints ───────────────────
calls.length = 0
btn.click()
await new Promise((r) => setTimeout(r, 10))
const refreshBtn = panel.querySelector('#dshc-refresh')
refreshBtn.click()
const raBtn = panel.querySelector('#dshc-restart')
raBtn.click()
assert.ok(calls.some((c) => c[0] === '/refresh'), 'refresh action POSTs /refresh')
assert.ok(calls.some((c) => c[0] === '/restart'), 'restart action POSTs /restart')

// ── scenario 7: install input + user-installed row (P5) ─────────────────────
calls.length = 0
btn.click()
await new Promise((r) => setTimeout(r, 10))
const specInput = panel.querySelector('#dshc-spec')
assert.ok(specInput, 'install input rendered')
specInput.value = 'my-awesome-plugin'
const installBtn = panel.querySelector('#dshc-install')
installBtn.click()
await new Promise((r) => setTimeout(r, 10))
const installCall = calls.find((c) => c[0] === '/plugins/install')
assert.ok(installCall, 'install posts /plugins/install')
assert.deepEqual(installCall[2], { spec: 'my-awesome-plugin' }, 'install body carries the spec')
assert.equal(installCall[1], 'POST')

const removeBtn = panel.querySelector('[data-remove]')
assert.ok(removeBtn, 'user-installed row renders a remove button')
assert.equal(removeBtn.dataset.remove, 'some-user-plugin')
removeBtn.click()
await new Promise((r) => setTimeout(r, 10))
const removeCall = calls.find((c) => c[0] === '/plugins/remove')
assert.ok(removeCall, 'remove posts /plugins/remove')
assert.deepEqual(removeCall[2], { name: 'some-user-plugin' })

calls.length = 0
const updateBtn2 = panel.querySelector('[data-update]')
assert.ok(updateBtn2, 'user-installed row renders an update button')
updateBtn2.click()
await new Promise((r) => setTimeout(r, 10))
const updateCall2 = calls.find((c) => c[0] === '/plugins/update')
assert.ok(updateCall2, 'update posts /plugins/update')
assert.deepEqual(updateCall2[2], { name: 'some-user-plugin' })

// ── scenario 8: completed op with nextAction shows "restart now" ────────────
listPayload = { ...listPayload, op: { op: 'install', spec: 'my-awesome-plugin', done: true, ok: true, nextAction: 'restart' } }
btn.click()
btn.click() // close + reopen to force a fresh render
await new Promise((r) => setTimeout(r, 10))
const restartNow = panel.querySelector('#dshc-restart-now')
assert.ok(restartNow, 'completed install with nextAction renders an immediate-restart button')

// ── scenario 9: unbaked bridge port -> no fetch, no crash ───────────────────
delete globalThis.__DSH_BRIDGE_PORT__
const body2 = makeEl('body')
globalThis.document = { body: body2, head, createElement: (t) => makeEl(t), getElementById: () => null }
calls.length = 0
// eslint-disable-next-line no-eval
eval(clientJs)
window.__handoff.factory().apply({})
body2.children.find((c) => c.className === 'dshc-btn')?.click()
assert.equal(calls.length, 0, 'unbaked bridge port must not fire fetches')

console.log('PASS — plugin console behavioral test (9 scenarios)')
process.exit(0)
