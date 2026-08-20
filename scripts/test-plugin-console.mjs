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

// Real DOM dataset semantics: `data-upd-pre` -> dataset.updPre.
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())

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
    getAttribute(name) { return el[name] !== undefined ? String(el[name]) : null },
    contains(node) {
      if (node === el) return true
      return el.children.some((c) => (c.contains ? c.contains(node) : c === node))
    },
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
            const prop = key && key.startsWith('data-') ? camel(key.slice(5)) : key
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
    set(v) { el._html = v; el.children = []; parseChildren(el, v) }, // 真实 DOM 语义：替换，不是追加
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
      else if (a[1].startsWith('data-')) child.dataset[camel(a[1].slice(5))] = a[2]
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
  preinstalled: [
    { name: 'dsh-model-reasoning', description: 'per-model reasoning effort settings' },
    { name: 'dsh-kanban', description: 'workspace kanban board' },
    { name: 'dsh-turn-navigator', description: 'conversation turn navigation rail' },
  ],
  preinstalledUpdates: {
    'dsh-model-reasoning': { installed: '0.1.1', latest: '0.1.3', updateAvailable: true, userUpdated: false },
    'dsh-kanban': { installed: '0.1.0', latest: '0.1.0', updateAvailable: false, userUpdated: false },
    'dsh-turn-navigator': { installed: '0.1.1', latest: '0.1.1', updateAvailable: false, userUpdated: false },
  },
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
const docListeners = {} // document-level listeners (click-outside-close)
function makeDoc(b) {
  return {
    body: b,
    head,
    createElement: (t) => makeEl(t),
    getElementById: () => null,
    appendChild: (c) => { b.appendChild(c) },
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn) },
  }
}
globalThis.document = makeDoc(body)
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

// ── scenario 3: preinstalled row renders with a toggle switch ───────────────
const toggle = panel.querySelectorAll('[data-toggle]')
assert.equal(toggle.length, 3, 'three preinstalled plugin rows with toggles')
assert.equal(toggle[0].dataset.toggle, 'dsh-model-reasoning')
assert.equal(toggle[1].dataset.toggle, 'dsh-kanban')
assert.equal(toggle[2].dataset.toggle, 'dsh-turn-navigator')
assert.ok(toggle[0].className.includes('dshc-switch'), 'the toggle is a switch, not a text button')
assert.ok(!toggle[0].className.includes(' on'), 'switch starts off (plugin not enabled)')
assert.ok(!toggle[1].className.includes(' on'), 'dsh-kanban switch starts off too')
assert.ok(!toggle[2].className.includes(' on'), 'dsh-turn-navigator switch starts off too')

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

// ── scenario 5b: pre-release (next tag) update option ───────────────────────
// When only a pre-release is newer (latest tag is current), the console offers
// upgrading to it via a versioned /update-dsh call.
calls.length = 0
listPayload.update = { current: '0.1.0-rc.7', latest: '0.1.0-rc.7', updateAvailable: false, next: '0.1.0-rc.8', nextAvailable: true }
btn.click() // close
await new Promise((r) => setTimeout(r, 10))
btn.click() // reopen -> refresh() re-fetches /plugins/list and re-renders
await new Promise((r) => setTimeout(r, 10))
const preBtn = panel.querySelector('#dshc-update')
assert.ok(preBtn, 'pre-release update button shown when only next is newer')
assert.equal(preBtn.dataset.version, '0.1.0-rc.8', 'pre-release button carries the target version')
preBtn.click()
const preCall = calls.find((c) => c[0] === '/update-dsh')
assert.ok(preCall, 'pre-release update POSTs /update-dsh')
assert.equal(preCall[1], 'POST')
assert.deepEqual(preCall[2], { version: '0.1.0-rc.8' }, 'pre-release update passes the target version')

// ── scenario 6: action buttons map to the right endpoints ───────────────────
calls.length = 0
btn.click()
await new Promise((r) => setTimeout(r, 10))
assert.equal(panel.querySelector('#dshc-proxy'), null, 'no proxy settings button in the console (entry lives in the shell settings window + tray)')
const refreshBtn = panel.querySelector('#dshc-refresh')
refreshBtn.click()
const raBtn = panel.querySelector('#dshc-restart')
raBtn.click()
assert.ok(calls.some((c) => c[0] === '/refresh'), 'refresh action POSTs /refresh')
assert.ok(calls.some((c) => c[0] === '/restart'), 'restart action POSTs /restart')
await new Promise((r) => setTimeout(r, 10))
assert.ok(
  body.children.some((c) => c.className === 'dshc-overlay'),
  'restart shows an immediate full-screen loading veil',
)

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

// ── scenario 8b: preinstalled update badge + update button (P5) ─────────────
listPayload = {
  ...listPayload,
  preinstalledUpdates: { 'dsh-model-reasoning': { installed: '0.1.1', latest: '0.1.3', updateAvailable: true, userUpdated: false } },
  op: { op: null, done: true },
}
btn.click(); btn.click() // close + reopen for a fresh render
await new Promise((r) => setTimeout(r, 10))
const updPre = panel.querySelector('[data-upd-pre]')
assert.ok(updPre, 'preinstalled row renders an update button when a newer version exists')
assert.equal(updPre.dataset.updPre, 'dsh-model-reasoning')
calls.length = 0
updPre.click()
await new Promise((r) => setTimeout(r, 10))
const updPreCall = calls.find((c) => c[0] === '/plugins/update-preinstalled')
assert.ok(updPreCall, 'update-preinstalled posts /plugins/update-preinstalled')
assert.deepEqual(updPreCall[2], { name: 'dsh-model-reasoning' })

// ── scenario 8e: typed install input survives a re-render (5s poll bug) ─────
btn.click(); btn.click()
await new Promise((r) => setTimeout(r, 10))
const inA = panel.querySelector('#dshc-spec')
inA.value = 'keep-me-plugin'
btn.click() // close
btn.click() // reopen -> refresh re-renders the panel
await new Promise((r) => setTimeout(r, 10))
const inB = panel.querySelector('#dshc-spec')
assert.ok(inB, 'input re-rendered')
assert.equal(inB.value, 'keep-me-plugin', 'typed install input must survive the re-render')

// ── scenario 8c: user-updated preinstalled shows reset-to-default ───────────
listPayload = {
  ...listPayload,
  preinstalledUpdates: { 'dsh-model-reasoning': { installed: '0.1.3', latest: '0.1.3', updateAvailable: false, userUpdated: true } },
}
btn.click(); btn.click()
await new Promise((r) => setTimeout(r, 10))
const resetPre = panel.querySelector('[data-reset-pre]')
assert.ok(resetPre, 'user-updated preinstalled renders a reset-to-default button')
assert.equal(resetPre.dataset.resetPre, 'dsh-model-reasoning')
calls.length = 0
resetPre.click()
await new Promise((r) => setTimeout(r, 10))
const resetCall = calls.find((c) => c[0] === '/plugins/reset-preinstalled')
assert.ok(resetCall, 'reset-preinstalled posts /plugins/reset-preinstalled')
assert.deepEqual(resetCall[2], { name: 'dsh-model-reasoning' })

// ── scenario 8d: check-preinstalled-updates button ──────────────────────────
calls.length = 0
btn.click(); btn.click()
await new Promise((r) => setTimeout(r, 10))
const checkPre = panel.querySelector('#dshc-check-pre')
assert.ok(checkPre, 'check-preinstalled-updates button rendered')
checkPre.click()
await new Promise((r) => setTimeout(r, 10))
assert.ok(
  calls.some((c) => c[0] === '/plugins/check-preinstalled-updates'),
  'check button POSTs /plugins/check-preinstalled-updates',
)

// ── scenario 9: custom tooltip on hover (no native title) ───────────────────
btn.click(); btn.click()
await new Promise((r) => setTimeout(r, 10))
const subEl = panel.querySelector('.dshc-sub')
assert.ok(subEl, 'description line rendered')
assert.equal(subEl.title, '', 'no native title attribute on descriptions')
const enter = (subEl.listeners.mouseenter || [])[0]
assert.ok(enter, 'mouseenter tooltip handler attached')
enter()
const tipEl = body.children.find((c) => c.className === 'dshc-tip')
assert.ok(tipEl, 'custom tooltip element created on hover')
assert.equal(
  tipEl.textContent,
  '为第三方（pi-ai）模型提供按模型配置思考等级（reasoning effort）的设置页',
  'tooltip carries the (zh) full description',
)

// ── scenario 11: clicking outside the panel closes it ───────────────────────
for (let i = 0; i < 3 && !panelElVisible(); i++) { btn.click(); await new Promise((r) => setTimeout(r, 10)) }
assert.ok(panelElVisible(), 'panel is open before the outside click')
const outsideClick = (docListeners.click || []).slice(-1)[0] // the console's own listener
assert.ok(outsideClick, 'document click listener attached')
// simulate a click on an element outside the panel and the button
const someEl = makeEl('div')
body.appendChild(someEl)
outsideClick({ target: someEl })
await new Promise((r) => setTimeout(r, 10))
assert.ok(!panelElVisible(), 'clicking outside closes the panel')
function panelElVisible() {
  const p = body.children.find((c) => c.className === 'dshc-panel')
  return p && p.style.display !== 'none'
}

// ── scenario 12: language toggle switches zh -> en (default is zh) ───────────
for (let i = 0; i < 3 && !panelElVisible(); i++) { btn.click(); await new Promise((r) => setTimeout(r, 10)) }
let langBtn = panel.querySelector('#dshc-lang')
assert.ok(langBtn, 'language toggle rendered')
assert.equal(langBtn.textContent, 'EN', 'default zh shows EN as the switch target')
assert.equal(panel.querySelector('.dshc-title').textContent, '插件与更新', 'title is zh by default')
langBtn.click() // switch to en
await new Promise((r) => setTimeout(r, 10))
langBtn = panel.querySelector('#dshc-lang')
assert.equal(langBtn.textContent, '中文', 'after switching, target is 中文')
assert.equal(panel.querySelector('.dshc-title').textContent, 'Plugins & updates', 'title switched to en')
const enSub = panel.querySelector('.dshc-sub')
assert.ok(enSub && enSub.textContent.includes('Settings page'), 'preinstalled description switched to en')
// switch back to zh so later scenarios stay deterministic
panel.querySelector('#dshc-lang').click()
await new Promise((r) => setTimeout(r, 10))

// ── scenario 13: unbaked bridge port -> no fetch, no crash ──────────────────
delete globalThis.__DSH_BRIDGE_PORT__
const body2 = makeEl('body')
globalThis.document = makeDoc(body2)
calls.length = 0
// eslint-disable-next-line no-eval
eval(clientJs)
window.__handoff.factory().apply({})
body2.children.find((c) => c.className === 'dshc-btn')?.click()
assert.equal(calls.length, 0, 'unbaked bridge port must not fire fetches')

console.log('PASS — plugin console behavioral test (17 scenarios)')
process.exit(0)
