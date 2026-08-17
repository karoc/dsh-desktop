#!/usr/bin/env node
// Behavioral test for the launcher's settings view (src/app.js under
// `?view=settings`): loads the REAL app.js in a vm sandbox with a minimal DOM
// + a mocked Tauri bridge, then drives the proxy settings panel:
//   - settings view renders the provider + observed-host checkboxes;
//   - saving collects exactly the checked hosts and posts upstream + hosts;
//   - the auto-navigate on server-url is suppressed while in the settings view.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const root = dirname(fileURLToPath(import.meta.url))
const appJs = readFileSync(join(root, '..', 'src', 'app.js'), 'utf8')

// ── minimal DOM ─────────────────────────────────────────────────────────────
function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    listeners: {},
    className: '',
    id: '',
    title: '',
    disabled: false,
    value: '',
    checked: false,
    hidden: false,
    scrollHeight: 0,
    clientHeight: 0,
    _text: '',
    appendChild(c) { el.children.push(c); c._parent = el; return c },
    append(...cs) { cs.forEach((c) => el.appendChild(c)) },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1) },
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn) },
    querySelector(sel) { return el.querySelectorAll(sel)[0] || null },
    querySelectorAll(sel) {
      const parts = sel.trim().split(/\s+/)
      const out = []
      const matchOne = (n, part) => {
        const checked = part.includes(':checked')
        const base = part.replace(':checked', '')
        let ok = false
        if (base.startsWith('.')) ok = n.className.split(/\s+/).includes(base.slice(1))
        else if (base.startsWith('#')) ok = n.id === base.slice(1)
        else ok = n.tagName === base.toUpperCase()
        if (checked && (n.tagName !== 'INPUT' || !n.checked)) ok = false
        return ok
      }
      const walk = (n, ancestors) => {
        for (const c of n.children) {
          const chain = [...ancestors, c]
          if (chain.length >= parts.length) {
            const suffix = chain.slice(chain.length - parts.length)
            if (suffix.every((x, i) => matchOne(x, parts[i]))) out.push(c)
          }
          walk(c, chain)
        }
      }
      walk(el, [])
      return out
    },
    closest() { return el._parent || null },
    classList: { contains: (c) => el.className.split(/\s+/).includes(c) },
    click() { (el.listeners.click || []).forEach((fn) => fn()) },
    change() { (el.listeners.change || []).forEach((fn) => fn()) },
  }
  Object.defineProperty(el, 'textContent', {
    get() { return el._text },
    set(v) { el._text = String(v); el.children = [] }, // real DOM: replace children
  })
  return el
}

// elements by id (auto-created on first access so getElementById is stable)
const byId = new Map()
function getEl(id) {
  if (!byId.has(id)) {
    const el = makeEl('div')
    el.id = id
    byId.set(id, el)
  }
  return byId.get(id)
}

const doc = {
  getElementById: (id) => getEl(id),
  querySelector: (sel) => (sel === '.credits-viewport' ? getEl('credits-viewport') : makeEl()),
  createElement: (t) => makeEl(t),
  body: makeEl('body'),
}

// ── sandbox globals ─────────────────────────────────────────────────────────
let invokeCalls = []
const tauriMock = {
  event: { listen: () => Promise.resolve() },
  core: {
    invoke: async (cmd, args) => {
      invokeCalls.push({ cmd, args })
      if (cmd === 'get_proxy_config') {
        return {
          upstream: { enabled: true, host: '127.0.0.1', port: 7890, username: 'u', password: 'p' },
          proxiedHosts: ['api.deepseek.com'],
          knownHosts: ['registry.npmjs.org'],
          hosts: ['registry.npmjs.org', 'web.example'],
          providers: [{ name: 'llm-deepseek', host: 'api.deepseek.com' }],
        }
      }
      if (cmd === 'set_proxy_config') return {}
      if (cmd === 'back_to_dsh') return {}
      return {}
    },
  },
}

const sandbox = {
  document: doc,
  location: { search: '?view=settings', href: 'tauri://localhost/?view=settings' },
  window: { location: { search: '?view=settings', href: 'tauri://localhost/?view=settings' } },
  globalThis: null, // set below
  URL,
  URLSearchParams,
  requestAnimationFrame: () => 0,
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  console,
}
sandbox.globalThis = sandbox
sandbox.window.__TAURI__ = tauriMock
sandbox.globalThis.__TAURI__ = tauriMock

vm.runInContext(appJs, vm.createContext(sandbox), { filename: 'app.js' })
await new Promise((r) => setTimeout(r, 30)) // let the async loadSettings() settle

// ── scenario 1: settings view is shown, launch view hidden ──────────────────
assert.equal(getEl('launchView').hidden, true, 'launch view hidden in settings view')
assert.equal(getEl('settingsView').hidden, false, 'settings view shown')
assert.equal(getEl('settingsBtn').hidden, true, 'settings button hidden while in settings view')

// ── scenario 2: upstream fields loaded from config ──────────────────────────
assert.equal(getEl('proxyEnabled').checked, true, 'upstream enabled checkbox reflects config')
assert.equal(getEl('proxyHost').value, '127.0.0.1', 'proxy host loaded')
assert.equal(getEl('proxyPort').value, '7890', 'proxy port loaded')
assert.equal(getEl('proxyUser').value, 'u', 'proxy username loaded')
assert.equal(getEl('proxyPass').value, 'p', 'proxy password loaded')

// ── scenario 3: host checkboxes rendered from providers + observed ──────────
const providerList = getEl('providerHosts')
assert.equal(providerList.querySelectorAll('.host-check').length, 1, 'one provider host rendered')
const providerCb = providerList.querySelector('input')
assert.equal(providerCb.checked, true, 'provider host checked because it is in proxiedHosts')
assert.equal(providerCb.closest('.host-check').querySelector('span').textContent, 'api.deepseek.com', 'provider checkbox label is the host')

const otherList = getEl('otherHosts')
const otherLabels = otherList.querySelectorAll('.host-check').map((l) => l.querySelector('span').textContent)
assert.deepEqual(otherLabels, ['registry.npmjs.org', 'web.example'], 'observed hosts rendered (deduped, providers excluded)')

// ── scenario 4: saving posts upstream + the checked hosts ───────────────────
// uncheck the provider, check the second observed host
providerCb.checked = false
providerCb.change()
const otherCbs = otherList.querySelectorAll('input')
otherCbs[1].checked = true // web.example
otherCbs[1].change()
getEl('saveProxy').click()
await new Promise((r) => setTimeout(r, 20))
const save = invokeCalls.find((c) => c.cmd === 'set_proxy_config')
assert.ok(save, 'set_proxy_config invoked on save')
assert.equal(save.args.upstream.host, '127.0.0.1', 'upstream object posted')
assert.deepEqual([...save.args.proxiedHosts], ['web.example'], 'only the checked host is saved')
assert.match(getEl('saveStatus').textContent, /已保存/, 'save status feedback shown')

console.log('PASS — launcher settings view (4 scenarios)')
process.exit(0)
