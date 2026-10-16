#!/usr/bin/env node
// Behavioral test for the standalone proxy settings window (src/settings.js):
// loads the REAL settings.js in a vm sandbox with a minimal DOM + a mocked
// Tauri bridge, then drives the panel:
//   - upstream fields + provider/observed-host checkboxes render from config;
//   - saving collects exactly the checked hosts and posts upstream + hosts;
//   - the close button closes the current window.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const root = dirname(fileURLToPath(import.meta.url))
const settingsJs = readFileSync(join(root, '..', 'src', 'settings.js'), 'utf8')

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
let closeCalls = 0
const tauriMock = {
  core: {
    invoke: async (cmd, args) => {
      invokeCalls.push({ cmd, args })
      if (cmd === 'get_proxy_config') {
        return {
          upstream: { enabled: true, protocol: 'http', host: '127.0.0.1', port: 7890, username: 'u', password: 'p' },
          // 'api.deepseek.com,' is a historical dirty value (trailing comma)
          // that must still light up the clean 'api.deepseek.com' checkbox.
          proxiedHosts: ['api.deepseek.com,', 'web.example'],
          knownHosts: ['registry.npmjs.org'],
          hosts: ['registry.npmjs.org', 'web.example'],
          providers: [
            { name: 'llm-deepseek', displayName: 'DeepSeek', host: 'api.deepseek.com' },
            // Same host as DeepSeek: must merge into one checkbox.
            { name: 'llm-pi-ai/gw', displayName: 'ACME 网关', host: 'api.deepseek.com' },
            // No displayName -> falls back to the route key (no namespace).
            { name: 'llm-pi-ai/anyrouter', host: 'anyrouter.top' },
            // No displayName AND no route key -> falls back to host label.
            { name: 'llm-pi-ai', host: 'bare.example' },
          ],
        }
      }
      if (cmd === 'set_proxy_config') return {}
      if (cmd === 'test_proxy') return { ok: true, detail: 'upstream proxy can forward (CONNECT 2xx)' }
      return {}
    },
  },
  window: {
    getCurrentWindow: () => ({ close: async () => { closeCalls += 1 } }),
  },
}

const sandbox = {
  document: doc,
  location: { search: '', href: 'tauri://localhost/settings.html' },
  window: {},
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

vm.runInContext(settingsJs, vm.createContext(sandbox), { filename: 'settings.js' })
await new Promise((r) => setTimeout(r, 30)) // let the async loadSettings() settle

// ── scenario 1: upstream fields loaded from config ──────────────────────────
assert.equal(getEl('proxyEnabled').checked, true, 'upstream enabled checkbox reflects config')
assert.equal(getEl('proxyProtocol').value, 'http', 'upstream protocol loaded')
assert.equal(getEl('proxyHost').value, '127.0.0.1', 'proxy host loaded')
assert.equal(getEl('proxyPort').value, '7890', 'proxy port loaded')
assert.equal(getEl('proxyUser').value, 'u', 'proxy username loaded')
assert.equal(getEl('proxyPass').value, 'p', 'proxy password loaded')

// ── scenario 3: host checkboxes rendered from providers + observed ──────────
const providerList = getEl('providerHosts')
// Two providers share api.deepseek.com → ONE merged checkbox; two more entries
// with friendly-name fallbacks (route key / host label).
const providerLabels = providerList.querySelectorAll('.host-check').map((l) => l.querySelector('span').textContent)
assert.deepEqual(providerLabels, [
  'DeepSeek / ACME 网关（api.deepseek.com）',
  'anyrouter（anyrouter.top）',
  'bare（bare.example）',
], 'providers render merged same-host label + route-key/host-label fallbacks')
const providerCb = providerList.querySelector('input')
assert.equal(providerCb.checked, true, 'provider host checked because it is in proxiedHosts')
assert.equal(providerCb.closest('.host-check').dataset.host, 'api.deepseek.com', 'host kept in data-host for saving')
// No displayName / no namespace prefix in ANY label.
assert.ok(providerLabels.every((l) => !l.includes('llm-')), 'no llm-pi-ai namespace text leaks into provider labels')

const otherList = getEl('otherHosts')
const otherLabels = otherList.querySelectorAll('.host-check').map((l) => l.querySelector('span').textContent)
assert.deepEqual(otherLabels, ['registry.npmjs.org', 'web.example'], 'observed hosts rendered (deduped, providers excluded)')

// ── scenario 4: saving posts upstream + the checked hosts ───────────────────
// switch protocol to socks5, uncheck the provider, check the second observed host
getEl('proxyProtocol').value = 'socks5'
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
assert.equal(save.args.upstream.protocol, 'socks5', 'protocol posted from the select')
assert.deepEqual([...save.args.proxiedHosts], ['web.example'], 'only the checked host is saved')
assert.match(getEl('saveStatus').textContent, /已保存/, 'save status feedback shown')

// ── scenario 4b: test connection button invokes test_proxy with the form ─────
getEl('testProxy').click()
await new Promise((r) => setTimeout(r, 20))
const testCall = invokeCalls.find((c) => c.cmd === 'test_proxy')
assert.ok(testCall, 'test_proxy invoked on 测试连接')
assert.equal(testCall.args.upstream.protocol, 'socks5', 'test uses the selected protocol')
assert.equal(testCall.args.upstream.host, '127.0.0.1', 'test uses the host field')
assert.match(getEl('testStatus').textContent, /连接成功/, 'test result shown')

// ── scenario 5: close button closes the current window ──────────────────────
getEl('settingsClose').click()
await new Promise((r) => setTimeout(r, 20))
assert.equal(closeCalls, 1, 'close button calls window.close()')

// ── scenario 6: search filters the host lists ───────────────────────────────
const search = getEl('hostSearch')
search.value = 'anyrouter'
;(search.listeners.input || []).forEach((f) => f())
let labelsAfter = getEl('providerHosts').querySelectorAll('.host-check').map((l) => l.querySelector('span').textContent)
assert.deepEqual(labelsAfter, ['anyrouter（anyrouter.top）'], 'search filters providers by name/host')
search.value = ''
;(search.listeners.input || []).forEach((f) => f())
assert.equal(getEl('providerHosts').querySelectorAll('.host-check').length, 3, 'clearing the search restores the full list')

console.log('PASS — proxy settings window (6 scenarios)')
// ── 静态门禁（2026-10-17，审计遗留②）：JS 里 getElementById 的每个 id 都必须在对应 HTML 里 ──
// 为什么必须单独做：本文件的 DOM 桩**按需自动创建**元素（见上面的 getEl），所以从 HTML 里删掉一个
// id ⇒ 本套件静默通过 ⇒ 生产里 `null.addEventListener` 直接打死该页后续脚本（与 0.18.0 顶栏事故
// 同族：整段静默死亡）。判据故意做成**静态**的（比对源码，不经过桩）。
// 真的由 JS 在运行时创建/注入的 id，要在这里显式登记并写明理由 —— 不允许"加个白名单就算了"。
const DYNAMIC_IDS = new Map([
  // ['settings.html', new Set(['example'])],  // 例：运行时应由 xx 注入
])
const pairs = [['index.html', 'app.js'], ['confirm.html', 'confirm.js'], ['settings.html', 'settings.js']]
let idCount = 0
for (const [htmlName, jsName] of pairs) {
  const htmlSrc = readFileSync(join(root, '..', 'src', htmlName), 'utf8')
  const jsSrc = readFileSync(join(root, '..', 'src', jsName), 'utf8')
  const ids = [...jsSrc.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  const allow = DYNAMIC_IDS.get(htmlName) ?? new Set()
  const missing = [...new Set(ids)].filter(
    (id) => !new RegExp(`id=["']${id}["']`).test(htmlSrc) && !allow.has(id),
  )
  assert.equal(
    missing.length,
    0,
    `${jsName} 引用了 ${htmlName} 里不存在的 id: ${missing.join(', ')}`
      + '（若确为运行时注入，请登记进 DYNAMIC_IDS 并写明理由；否则补回 HTML）',
  )
  idCount += new Set(ids).size
}
console.log(`ok   启动页 id↔DOM 存在性（app/confirm/settings 共 ${idCount} 个 id 全部在对应 HTML 中）`)

process.exit(0)
