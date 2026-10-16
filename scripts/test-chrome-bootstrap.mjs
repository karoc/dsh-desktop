#!/usr/bin/env node
// 壳注入脚本（src-tauri/resources/ui/shell-chrome.js）的**真实初始化路径**门禁 —— 纯 Node、零 npm
// 依赖、不联网、不启动浏览器（2026-10-17，卡 card-b126fb84-9d3a-4a12-a601-2227ecce028e）。
//
// 为什么需要它（缺口在哪）：`scripts/test-shell-chrome.mjs` 设 `__DSH_CHROME_TEST__` ⇒ chrome 在
// TEST_HOOK 处**提前 return** ⇒ 真实初始化路径（挂载守卫 / 契约写入 / MutationObserver 自愈 /
// 引导上报 / 事件分发）在单测里**从不执行**；唯一的真机门禁 `npm run test:chrome-real`
// （scripts/test-chrome-real-init.mjs）需要本机 dsh 在跑 + playwright ⇒ **在 CI 里恒 SKIP（exit 0）**。
// 0.18.0 的「注入即死」正是从这条缝里溜过去的。本套件用 `node:vm` + 手写最小 DOM，在**不设
// TEST_HOOK** 的前提下加载 chrome，把「跑到 ready / 宿主与顶栏在 / 宿主被移除后自愈重挂 / 契约真的
// 落到页面根 / 极早时序不抛」变成 CI 里真的会跑的断言。
//
// 覆盖（每条断言都附「会红条件」，逐条打印）：
//   ① 引导上报链真的跑到 ready（stub fetch 收到 inject → mounted → ready，顺序正确，且**无 fatal**）；
//   ② 宿主 #dsh-shell-chrome 在 body 里、shadowRoot 里有顶栏 .bar + 菜单触发器 + 窗口三键；
//   ③ 宿主被移除 + 手动触发 MutationObserver 回调 ⇒ 宿主被重新挂上（0.18.0 里静默死掉的那段）；
//   ④ 契约写入（--dsh-shell-menubar-h / --dsh-windows-titlebar-height / data-windows-titlebar /
//      host.caption）在 documentElement 存在时确实发生；**极早时序**（documentElement/body 尚为
//      null）下不抛异常（漏 `if (rootEl)` 守卫 ⇒ 立刻红）；
//   ⑤ 补充：桥请求准入头（X-DSH-Shell）/ 防重复注入 / 全屏浮层让位与顶缘唤出 / 定时器与 Promise 无异常。
//
// 负向对照（硬要求；两个变异体都在**内存里**用字符串替换造，绝不写盘）：
//   A. 删掉契约 dataset 写入的 `if (rootEl)` 守卫（= 还原 0.18.0 的写法）⇒ 极早时序断言必须变红；
//   B. 删掉自愈的 `observer.observe(document.body, …)` 注册 ⇒ 自愈断言必须变红。
//   两个变异体都必须让**指定**断言变红（不是"随便红一条"）：没红、或变异体压根没应用上（夹具与
//   被测文本脱钩），都判本套件失败 —— 恒真的门禁不算门禁（CONTRIBUTING「门禁（提交前本地跑）」）。
//
// **做不到的部分（诚实声明，不用恒真断言糊过去）**：
//   · 没有渲染引擎：顶栏"真的在视口顶部且可见"、菜单尺寸/滚动条、真实点击命中判定仍只能由
//     `npm run test:chrome-real`（Playwright）判定。这里的 getBoundingClientRect 是**桩返回的常量**
//     （只为让 chrome 自己的 mounted 摘要有值可取），本套件**不对任何几何/可见性下结论**；
//   · 全屏让位那条是「桩注入布局事实（position:fixed + 覆盖视口 + 内容越过 36px 带）⇒ 断言 chrome
//     的决策」——判的是 chrome 的判定逻辑，不是真实布局；
//   · MutationObserver 的回调由本套件**同步**触发（真实浏览器在微任务里批量投递）。chrome 的回调体
//     是纯同步 DOM 操作、不依赖投递时机，所以这条断言不需要真实微任务时序；但"批量合并投递"这一
//     浏览器行为本套件不建模。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 负向对照入口（与 test-chrome-real-init.mjs 同款）：`DSH_CHROME_FILE=<别的 chrome> node 本脚本`
// 必须变红（例如 .tmp-investigate/chrome-0.18.0.js）。
const CHROME_PATH = process.env.DSH_CHROME_FILE || join(ROOT, 'src-tauri', 'resources', 'ui', 'shell-chrome.js')
const CHROME_SRC = readFileSync(CHROME_PATH, 'utf8')
const BRIDGE_PORT = '59999'
// Rust 侧注入的是 **data URI**（lib.rs：`data:image/png;base64,<logo.png>`）。永远走这条分支，
// 才能让 logoDigest 的 `logoSrc=png` 判据有意义（内联 SVG 兜底字符串会被 HTML 解析咬坏）。
const LOGO_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

// ══════════════════════════════════════════════════════════════════════════
// 一、最小 DOM —— 只实现 chrome 真实初始化路径真的用到的 API
//     任何**没实现**的入口会抛异常 ⇒ 表现为 fatal/缺 ready ⇒ 本套件变红（响亮失败，不静默放过）。
//     实际被调用的入口清单由 api.names 实测出来并在末尾打印（不是靠人猜）。
// ══════════════════════════════════════════════════════════════════════════

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'rect', 'path', 'circle', 'use', 'line', 'polygon', 'stop'])

// dataset.key ⇄ data-key 属性互映（真实 DOM 行为；chrome 的点击分发与菜单项查询都读 data-* 选择器）。
const dataAttrName = (key) => 'data-' + String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
const datasetKeyOf = (attr) => String(attr).slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())

const cssKey = (prop) => (/^--/.test(String(prop)) ? String(prop) : String(prop).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()))

/** style：既能 `style.paddingTop = '36px'` 也能 `style.setProperty('--x','y')`（chrome 两种都用）。 */
function makeStyle(api) {
  const props = new Map()
  const target = {
    setProperty(name, value) {
      api.use('style.setProperty')
      props.set(String(name), String(value))
    },
    getPropertyValue(name) {
      return props.has(String(name)) ? props.get(String(name)) : ''
    },
    removeProperty(name) {
      props.delete(String(name))
    },
    get cssText() {
      return [...props].map(([k, v]) => `${k}: ${v}`).join('; ')
    },
  }
  return new Proxy(target, {
    set(t, prop, value) {
      if (typeof prop !== 'string' || prop in t) {
        t[prop] = value
        return true
      }
      api.use('style.assign')
      props.set(cssKey(prop), String(value))
      return true
    },
    get(t, prop) {
      if (prop in t) return t[prop]
      const k = cssKey(prop)
      return props.has(k) ? props.get(k) : ''
    },
  })
}

/**
 * 最小 CSS 选择器引擎：只支持 chrome 真正用到的语法 —— `tag` / `.class` / `[attr]` /
 * `[attr="v"]` / 后代组合（空格）/ 逗号分组。遇到不支持的东西（`>`、`+`、`~`、伪类）
 * **直接抛**，而不是悄悄匹配不到 —— 后者会把"桩不支持"伪装成"被测缺陷"。
 */
const SELECTOR_TOKEN = /\[([^\]]*)\]|\.([\w-]+)|#([\w-]+)|([a-zA-Z][\w-]*)/g
function parseCompound(part, full) {
  const compound = { tag: null, id: null, classes: [], attrs: [] }
  let consumed = 0
  let m
  SELECTOR_TOKEN.lastIndex = 0
  while ((m = SELECTOR_TOKEN.exec(part))) {
    if (m.index !== consumed) throw new Error(`最小 DOM 的选择器引擎不支持这段语法: "${full}"`)
    consumed = m.index + m[0].length
    if (m[1] !== undefined) {
      const am = /^([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?$/.exec(m[1])
      if (!am) throw new Error(`最小 DOM 的选择器引擎不支持这个属性选择器: "[${m[1]}]"（来自 "${full}"）`)
      compound.attrs.push({ name: am[1], value: am[2] ?? am[3] ?? am[4] ?? null })
    } else if (m[2] !== undefined) {
      compound.classes.push(m[2])
    } else if (m[3] !== undefined) {
      compound.id = m[3]
    } else {
      compound.tag = m[4].toLowerCase()
    }
  }
  if (consumed !== part.length || !part.length) throw new Error(`最小 DOM 的选择器引擎解析不了: "${full}"`)
  return compound
}
function parseSelector(sel) {
  const full = String(sel)
  if (full.includes(',')) return full.split(',').flatMap((s) => parseSelector(s))
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) throw new Error('空选择器')
  for (const p of parts) {
    if (/[>+~]/.test(p.replace(/\[[^\]]*\]/g, ''))) {
      throw new Error(`最小 DOM 的选择器引擎只支持后代组合（空格），不支持组合符: "${full}"`)
    }
  }
  return [parts.map((p) => parseCompound(p, full))]
}
function matchCompound(el, compound) {
  if (el.nodeType !== 1) return false
  if (compound.tag && el.localName !== compound.tag) return false
  if (compound.id !== null && el.id !== compound.id) return false
  for (const c of compound.classes) if (!el._classes.has(c)) return false
  for (const a of compound.attrs) {
    const v = el.getAttribute(a.name)
    if (v === null) return false
    if (a.value !== null && v !== a.value) return false
  }
  return true
}
function matchesSelector(el, seq) {
  let i = seq.length - 1
  if (!matchCompound(el, seq[i])) return false
  i -= 1
  let node = el.parentNode
  while (i >= 0 && node) {
    if (matchCompound(node, seq[i])) i -= 1
    node = node.parentNode
  }
  return i < 0
}
function collectDescendants(root, out) {
  for (const c of root.childNodes || []) {
    if (c.nodeType === 1) {
      out.push(c)
      collectDescendants(c, out)
    }
  }
  return out
}
function queryAll(root, sel) {
  if (!root) return []
  const groups = parseSelector(sel)
  return collectDescendants(root, []).filter((el) => groups.some((seq) => matchesSelector(el, seq)))
}

function defaultRect(el) {
  // 桩几何：**不是**任何视觉结论，只保证 chrome 自己的摘要（bar=…px h…）有值可取。
  if (el.localName === 'img') return { x: 0, y: 0, top: 0, left: 0, right: 16, bottom: 16, width: 16, height: 16 }
  return { x: 0, y: 0, top: 0, left: 0, right: 1344, bottom: 36, width: 1344, height: 36 }
}

function makeTextNode(text) {
  return {
    nodeType: 3,
    localName: '#text',
    childNodes: [],
    parentNode: null,
    _text: String(text),
    get textContent() { return this._text },
    set textContent(v) { this._text = String(v) },
    get innerText() { return this._text },
    contains(other) { return other === this },
    remove() { if (this.parentNode) this.parentNode.removeChild(this) },
  }
}

/** 迷你 HTML 解析（innerHTML）：chrome 用它插入 logo `<span class="logo"><img …></span>` 与
 *  窗口三键的 SVG。**保持嵌套关系**（`.menu-btn .logo img` 这条后代查询必须命中，否则 logoDigest
 *  会打印 logoSrc=noimg，把桩的缺陷伪装成被测缺陷）。 */
function parseHTML(doc, el, html, api) {
  api.use('element.innerHTML')
  el.childNodes.length = 0
  const stack = [el]
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[\w:.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)/g
  let m
  while ((m = re.exec(html))) {
    if (m[1]) {
      const idx = stack.map((n) => n.localName).lastIndexOf(m[1].toLowerCase())
      if (idx > 0) stack.length = idx
    } else if (m[2]) {
      const node = makeElement(doc, m[2], api)
      const attrRe = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
      let am
      while ((am = attrRe.exec(m[3] || ''))) node.setAttribute(am[1], am[2] ?? am[3] ?? am[4] ?? '')
      stack[stack.length - 1].appendChild(node)
      if (!m[4] && !VOID_TAGS.has(m[2].toLowerCase())) stack.push(node)
    } else if (m[5] !== undefined && m[5].trim()) {
      stack[stack.length - 1].appendChild(makeTextNode(m[5]))
    }
  }
}

function makeElement(doc, tag, api) {
  const classes = new Set()
  const listeners = new Map()
  const attributes = new Map()
  const style = makeStyle(api)
  const data = {}
  const dataset = new Proxy(data, {
    set(t, prop, value) {
      api.use('element.dataset')
      t[prop] = String(value)
      attributes.set(dataAttrName(prop), String(value))
      return true
    },
    get(t, prop) { return t[prop] },
    has(t, prop) { return prop in t },
    deleteProperty(t, prop) {
      api.use('element.dataset')
      delete t[prop]
      attributes.delete(dataAttrName(prop))
      return true
    },
    ownKeys(t) { return Reflect.ownKeys(t) },
    getOwnPropertyDescriptor(t, prop) { return Object.getOwnPropertyDescriptor(t, prop) },
  })
  const syncClassAttr = () => {
    const v = [...classes].join(' ')
    if (v) attributes.set('class', v); else attributes.delete('class')
  }
  const classList = {
    add(...cs) { api.use('classList.add'); for (const c of cs) classes.add(String(c)); syncClassAttr() },
    remove(...cs) { api.use('classList.remove'); for (const c of cs) classes.delete(String(c)); syncClassAttr() },
    contains(c) { api.use('classList.contains'); return classes.has(String(c)) },
    toggle(c, force) {
      api.use('classList.toggle')
      const on = force === undefined ? !classes.has(String(c)) : !!force
      if (on) classes.add(String(c)); else classes.delete(String(c))
      syncClassAttr()
      return on
    },
    get length() { return classes.size },
    toString() { return [...classes].join(' ') },
  }

  const el = {
    nodeType: 1,
    localName: String(tag).toLowerCase(),
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    parentNode: null,
    shadowRoot: null,
    id: '',
    hidden: false,
    tabIndex: 0,
    title: '',
    disabled: false,
    src: '',
    __rect: null, // 桩：harness 可为"注入布局事实"覆盖它
    __stubPosition: '', // 桩：getComputedStyle 只认这一个字段

    get className() { return [...classes].join(' ') },
    set className(v) {
      classes.clear()
      for (const c of String(v).split(/\s+/)) if (c) classes.add(c)
      syncClassAttr()
    },
    get classList() { return classList },
    get _classes() { return classes },
    get style() { return style },
    get dataset() { return dataset },
    get children() { return el.childNodes.filter((n) => n.nodeType === 1) },
    get firstChild() { return el.childNodes[0] || null },
    get parentElement() { return el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : null },
    get textContent() { return el.childNodes.map((n) => n.textContent).join('') },
    set textContent(v) {
      api.use('element.textContent')
      el.childNodes.length = 0
      if (String(v) !== '') el.appendChild(makeTextNode(String(v)))
    },
    get innerText() { return el.textContent },
    get innerHTML() { return '' },
    set innerHTML(v) { parseHTML(doc, el, String(v), api) },
    get naturalWidth() { return el.localName === 'img' ? 16 : 0 },
    get naturalHeight() { return el.localName === 'img' ? 16 : 0 },
    get complete() { return true },
    get offsetLeft() { return 0 },
    get offsetWidth() { return el.localName === 'button' ? 40 : 0 },
    get scrollHeight() { return 0 },
    get clientHeight() { return 0 },

    attachShadow(init) {
      api.use('element.attachShadow')
      if (el.shadowRoot) throw new Error('attachShadow: shadow root already attached')
      if (!init || (init.mode !== 'open' && init.mode !== 'closed')) throw new Error('attachShadow: mode must be "open" or "closed"')
      const sr = makeElement(doc, '#shadow-root', api)
      sr.nodeType = 11
      sr.mode = init.mode
      sr.host = el
      el.shadowRoot = sr
      return sr
    },
    appendChild(child) {
      api.use('element.appendChild')
      if (!child || typeof child !== 'object') throw new TypeError('appendChild: 需要一个节点')
      if (child.parentNode) child.parentNode.removeChild(child)
      child.parentNode = el
      el.childNodes.push(child)
      return child
    },
    append(...nodes) {
      api.use('element.append')
      for (const n of nodes) el.appendChild(typeof n === 'string' ? makeTextNode(n) : n)
    },
    replaceChildren(...nodes) {
      api.use('element.replaceChildren')
      el.childNodes.length = 0
      el.append(...nodes)
    },
    removeChild(child) {
      api.use('element.removeChild')
      const i = el.childNodes.indexOf(child)
      if (i >= 0) {
        el.childNodes.splice(i, 1)
        child.parentNode = null
      }
      return child
    },
    remove() {
      api.use('element.remove')
      if (el.parentNode) el.parentNode.removeChild(el)
    },
    contains(other) {
      api.use('element.contains')
      let n = other
      while (n) {
        if (n === el) return true
        n = n.parentNode
      }
      return false
    },
    querySelector(sel) { api.use('element.querySelector'); return queryAll(el, sel)[0] || null },
    querySelectorAll(sel) { api.use('element.querySelectorAll'); return queryAll(el, sel) },
    closest(sel) {
      const groups = parseSelector(sel)
      let n = el
      while (n && n.nodeType === 1) {
        if (groups.some((seq) => matchCompound(n, seq[seq.length - 1]))) return n
        n = n.parentNode
      }
      return null
    },
    setAttribute(name, value) {
      api.use('element.setAttribute')
      const n = String(name)
      const v = String(value)
      attributes.set(n, v)
      // 真实 DOM 的反射语义（`[data-*]` 选择器、className、img.src 都靠它）。
      if (n === 'class') { classes.clear(); for (const c of v.split(/\s+/)) if (c) classes.add(c) }
      else if (n === 'id') el.id = v
      else if (n === 'src') el.src = v
      else if (n.startsWith('data-')) data[datasetKeyOf(n)] = v
    },
    getAttribute(name) { return attributes.has(String(name)) ? attributes.get(String(name)) : null },
    hasAttribute(name) { return attributes.has(String(name)) },
    removeAttribute(name) { attributes.delete(String(name)) },
    addEventListener(type, fn) {
      api.use('element.addEventListener')
      const t = String(type)
      if (!listeners.has(t)) listeners.set(t, [])
      listeners.get(t).push(fn)
    },
    removeEventListener(type, fn) {
      api.use('element.removeEventListener')
      const arr = listeners.get(String(type)) || []
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    },
    dispatchEvent(ev) {
      api.use('element.dispatchEvent')
      for (const fn of [...(listeners.get(String(ev.type)) || [])]) {
        fn.call(el, { type: ev.type, target: el, preventDefault() {}, stopPropagation() {}, composedPath: () => [el] })
      }
      return true
    },
    focus() { api.use('element.focus'); doc.activeElement = el },
    getBoundingClientRect() {
      api.use('element.getBoundingClientRect')
      return el.__rect || defaultRect(el)
    },
  }
  return el
}

function createDocument(api) {
  const listeners = new Map()
  const doc = {
    readyState: 'loading',
    hidden: false,
    activeElement: null,
    documentElement: null,
    body: null,
    __elementFromPoint: null, // 桩：harness 可注入"命中谁"的布局事实
    createElement(tag) { api.use('document.createElement'); return makeElement(doc, tag, api) },
    createTextNode(text) { api.use('document.createTextNode'); return makeTextNode(text) },
    getElementById(id) {
      api.use('document.getElementById')
      if (!doc.documentElement) return null
      const all = collectDescendants(doc.documentElement, [])
      return all.find((e) => e.id === id) || (doc.documentElement.id === id ? doc.documentElement : null)
    },
    querySelector(sel) { api.use('document.querySelector'); return queryAll(doc.documentElement, sel)[0] || null },
    querySelectorAll(sel) { api.use('document.querySelectorAll'); return queryAll(doc.documentElement, sel) },
    elementFromPoint(x, y) {
      api.use('document.elementFromPoint')
      return doc.__elementFromPoint ? doc.__elementFromPoint(x, y) : null
    },
    addEventListener(type, fn) {
      api.use('document.addEventListener')
      const t = String(type)
      if (!listeners.has(t)) listeners.set(t, [])
      listeners.get(t).push(fn)
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(String(type)) || []
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    },
    dispatchEvent(ev) {
      api.use('document.dispatchEvent')
      for (const fn of [...(listeners.get(String(ev.type)) || [])]) fn({ type: ev.type, preventDefault() {}, stopPropagation() {} })
      return true
    },
  }
  return doc
}

/** 可控时钟：真实 setTimeout/setInterval 换成本地虚拟时钟 ⇒ 测试不会留悬挂定时器、
 *  也能确定性地走到"body 稍后才出现"的重试路径。 */
function createClock(api, onError) {
  let now = 0
  let seq = 0
  const timers = new Map()
  const schedule = (fn, ms, args, every) => {
    if (typeof fn !== 'function') throw new TypeError('定时器回调必须是函数')
    const id = ++seq
    timers.set(id, { fn, args, at: now + Math.max(0, Number(ms) || 0), every })
    return id
  }
  return {
    now: () => now,
    pending: () => timers.size,
    setTimeout(fn, ms, ...args) { api.use('setTimeout'); return schedule(fn, ms, args, null) },
    setInterval(fn, ms, ...args) { api.use('setInterval'); return schedule(fn, ms, args, Math.max(1, Number(ms) || 1)) },
    clearTimeout(id) { api.use('clearTimeout'); timers.delete(id) },
    clearInterval(id) { api.use('clearInterval'); timers.delete(id) },
    advance(ms) {
      const end = now + Math.max(0, Number(ms) || 0)
      let guard = 0
      for (;;) {
        if (++guard > 5000) {
          onError(new Error(`虚拟时钟推进一步内跑了 5000 个回调（疑似自调度死循环）now=${now}`))
          break
        }
        let next = null
        for (const [id, t] of timers) {
          if (t.at > end) continue
          if (!next || t.at < next.t.at || (t.at === next.t.at && id < next.id)) next = { id, t }
        }
        if (!next) break
        now = Math.max(now, next.t.at)
        if (next.t.every === null) timers.delete(next.id)
        else next.t.at = now + next.t.every
        try {
          next.t.fn(...next.t.args)
        } catch (err) {
          onError(err)
        }
      }
      now = Math.max(now, end)
    },
  }
}

function makeMutationObserver(api, registry) {
  return class MiniMutationObserver {
    constructor(cb) {
      api.use('new MutationObserver')
      if (typeof cb !== 'function') throw new TypeError('MutationObserver 需要一个回调函数')
      this.__cb = cb
      this.__target = null
      this.__options = null
      registry.push(this)
    }
    observe(target, options) {
      api.use('MutationObserver.observe')
      // 真实浏览器 observe(null) 抛 TypeError（parameter 1 is not of type 'Node'）——
      // 桩照抄这个失败模式，否则"body 还没出现就 observe"会静默通过。
      if (!target || typeof target !== 'object') throw new TypeError('MutationObserver.observe: target 不是 Node')
      this.__target = target
      this.__options = options || {}
    }
    disconnect() { api.use('MutationObserver.disconnect'); this.__target = null }
    takeRecords() { return [] }
  }
}

const jsonResponse = (payload) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(payload),
  text: () => Promise.resolve(JSON.stringify(payload)),
})

// ══════════════════════════════════════════════════════════════════════════
// 二、在 vm 沙箱里加载 chrome（**不设 __DSH_CHROME_TEST__**）
// ══════════════════════════════════════════════════════════════════════════
function runChrome({ source, early, contract }) {
  const api = { on: false, names: new Set(), use(name) { if (this.on) this.names.add(name) } }
  const recording = (on, fn) => {
    const prev = api.on
    api.on = on
    try { return fn() } finally { api.on = prev }
  }

  const reports = []   // 桥 /log 收到的引导上报（按到达顺序）
  const calls = []     // 所有 fetch 调用（含桥动作）
  const timerErrors = []
  const observers = []
  const doc = createDocument(api)
  const clock = createClock(api, (err) => timerErrors.push(err))
  const winListeners = new Map()

  if (!early) {
    recording(false, () => {
      const html = doc.createElement('html')
      const head = doc.createElement('head')
      const body = doc.createElement('body')
      html.appendChild(head)
      html.appendChild(body)
      doc.documentElement = html
      doc.body = body
      doc.readyState = 'complete'
    })
  }

  const sandbox = {
    console,
    document: doc,
    // 远程 dsh 页（http://127.0.0.1:*，无 __TAURI__）：契约写入与桥传输都走这条分支 ——
    // 正是 0.18.0 出事故的那条路径。
    location: { protocol: 'http:', host: `127.0.0.1:${BRIDGE_PORT}`, href: `http://127.0.0.1:${BRIDGE_PORT}/?token=stub` },
    navigator: { userAgent: 'dsh-desktop-chrome-bootstrap-stub', platform: 'linux' },
    fetch: (url, opts = {}) => {
      api.use('fetch')
      const headers = opts.headers || {}
      const body = typeof opts.body === 'string' ? opts.body : null
      const rec = { url: String(url), method: String(opts.method || 'GET').toUpperCase(), shellHeader: headers['X-DSH-Shell'] || null, body }
      calls.push(rec)
      if (rec.url.endsWith('/log') && body) {
        let detail = body
        try { detail = String(JSON.parse(body).detail || '') } catch (_) { /* 非 JSON：原样当 detail */ }
        reports.push({ stage: detail.split(' ')[0] || '(空)', detail })
      }
      return Promise.resolve(jsonResponse({}))
    },
    MutationObserver: makeMutationObserver(api, observers),
    setTimeout: (...a) => clock.setTimeout(...a),
    setInterval: (...a) => clock.setInterval(...a),
    clearTimeout: (id) => clock.clearTimeout(id),
    clearInterval: (id) => clock.clearInterval(id),
    matchMedia: (q) => {
      api.use('matchMedia')
      return { matches: false, media: String(q), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
    },
    getComputedStyle: (node) => {
      api.use('getComputedStyle')
      return { position: (node && node.__stubPosition) || '', getPropertyValue: (k) => (node && node.style ? node.style.getPropertyValue(k) : '') }
    },
    Event: class MiniEvent {
      constructor(type, init) {
        api.use('new Event')
        this.type = String(type)
        Object.assign(this, init || {})
      }
      preventDefault() {}
      stopPropagation() {}
    },
    addEventListener(type, fn) {
      api.use('window.addEventListener')
      const t = String(type)
      if (!winListeners.has(t)) winListeners.set(t, [])
      winListeners.get(t).push(fn)
    },
    removeEventListener(type, fn) {
      api.use('window.removeEventListener')
      const arr = winListeners.get(String(type)) || []
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    },
    dispatchEvent(ev) {
      api.use('window.dispatchEvent')
      for (const fn of [...(winListeners.get(String(ev.type)) || [])]) fn({ type: ev.type, preventDefault() {}, stopPropagation() {} })
      return true
    },
    innerWidth: 1344,
    innerHeight: 1025,
    __DSH_BRIDGE_PORT__: BRIDGE_PORT,
    __DSH_SHELL_VERSION__: '0.18.2',
    __DSH_PRODUCT_NAME__: 'DSH Smoothly Desktop',
    __DSH_BUILD_DATE__: '2026-10-17',
    __DSH_TITLEBAR_CONTRACT__: !!contract,
    __DSH_LOGO__: LOGO_URI,
    // ⚠️ 故意**不设** __DSH_CHROME_TEST__：本套件的全部意义就是走真实初始化路径。
  }

  vm.createContext(sandbox)
  vm.runInContext('globalThis.window = globalThis; globalThis.self = globalThis;', sandbox)

  let thrown = null
  recording(true, () => {
    try {
      vm.runInContext(source, sandbox, { filename: 'shell-chrome.js' })
    } catch (err) {
      thrown = err
    }
  })

  return {
    api, doc, clock, reports, calls, timerErrors, observers, thrown, sandbox,
    recording,
    stages: () => reports.map((r) => r.stage),
    detailOf: (stage) => (reports.find((r) => r.stage === stage) || {}).detail || '',
    /** 极早时序用：稍后把 <html>/<body> 变出来（对应真实浏览器的导航推进）。 */
    materialize() {
      recording(false, () => {
        if (doc.documentElement) return
        const html = doc.createElement('html')
        const head = doc.createElement('head')
        const body = doc.createElement('body')
        html.appendChild(head)
        html.appendChild(body)
        doc.documentElement = html
        doc.body = body
        doc.readyState = 'complete'
      })
    },
    advance(ms) { recording(true, () => clock.advance(ms)) },
    /** 手动投递 MutationObserver 回调（真实浏览器在微任务里批量投递；这里的回调体是纯同步 DOM 操作）。 */
    fireObservers(target) {
      let fired = 0
      recording(true, () => {
        for (const o of observers) {
          if (!o.__target) continue
          if (target && !o.__target.contains(target) && o.__target !== target) continue
          fired += 1
          o.__cb([{ type: 'childList', target: o.__target }], o)
        }
      })
      return fired
    },
    query(fn) { return recording(false, fn) },
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 三、断言
// ══════════════════════════════════════════════════════════════════════════
function makeChecker() {
  const checks = []
  return {
    checks,
    check(id, label, why, ok, detail) {
      checks.push({ id, label, why, ok: !!ok, detail: detail === undefined ? '' : String(detail) })
      return !!ok
    },
    failures() { return checks.filter((c) => !c.ok) },
  }
}
function printChecks(checks, { onlyFailing = false } = {}) {
  for (const c of checks) {
    if (onlyFailing && c.ok) continue
    console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? `   [${c.detail}]` : ''}`)
    console.log(`       ↳ 会红条件：${c.why}`)
  }
}
const flush = () => new Promise((r) => setImmediate(r))
const errLine = (err) => (err ? `${(err && err.name) || 'Error'}: ${(err && err.message) || String(err)}` : '')

// 真实初始化路径必须用到的桩入口（实测清单，写在 ④ 里守漂移）。
// 桩缺任何一个 ⇒ chrome 抛异常 ⇒ 缺 ready / 出现 fatal ⇒ 本套件变红。
const REQUIRED_API = [
  'document.createElement', 'document.getElementById', 'document.addEventListener',
  'element.attachShadow', 'element.appendChild', 'element.append', 'element.setAttribute',
  'element.addEventListener', 'element.getBoundingClientRect', 'element.querySelectorAll',
  'element.innerHTML', 'style.setProperty', 'element.dataset', 'classList.add',
  'new MutationObserver', 'MutationObserver.observe', 'window.addEventListener',
  'fetch', 'setTimeout', 'setInterval',
]

/** 场景 1：正常时序（documentElement + body 都在），顶栏契约开。 */
async function scenarioNormal(source, unhandled) {
  const c = makeChecker()
  const unhandledBefore = unhandled.length
  const run = runChrome({ source, early: false, contract: true })
  await flush()

  const stages = run.stages()
  const idx = (s) => stages.indexOf(s)

  c.check('no-throw', '真实初始化路径整段加载不抛异常',
    '顶层任意语句抛异常 ⇒ 注入即死（0.18.0 / 2026-10-15 事故形态），而壳侧 w.eval 只看到"派发成功"',
    run.thrown === null, errLine(run.thrown))
  c.check('no-fatal', '引导上报链里没有 fatal',
    'fatal 只在某个 boot 阶段抛异常时产生 ⇒ 有它即该阶段死亡',
    !stages.includes('fatal'), `实测 [${stages.join(' → ')}]`)
  c.check('chain', '上报链 inject → mounted → ready 齐全且顺序正确',
    '缺 ready = 中途死在某一步；缺 mounted = 宿主没挂上（顶栏不可见）',
    idx('inject') === 0 && idx('mounted') > idx('inject') && idx('ready') > idx('mounted'),
    `实测 [${stages.join(' → ')}]`)
  const mounted = run.detailOf('mounted')
  c.check('digest', 'mounted 摘要带 bar/hidden/btns，且 logo 来自注入的 __DSH_LOGO__',
    'img 没建出来 / 注入变量没读到 / 图没解码 ⇒ 摘要会变成 logoSrc=noimg|fallback|UNSET（正是"菜单点不开"的形态）',
    /bar=-?\d+px h\d+/.test(mounted) && /hidden=(true|false)/.test(mounted) && /btns=\d+/.test(mounted)
      && /logoVar=set/.test(mounted) && /logoSrc=png/.test(mounted),
    mounted.slice(0, 160))

  const host = run.query(() => run.doc.getElementById('dsh-shell-chrome'))
  c.check('host', '宿主 #dsh-shell-chrome 挂在 document.body 里',
    '挂载守卫缺失 / 提前 return ⇒ 宿主不在树上（用户看到的就是"顶栏与菜单消失"）',
    !!host && run.query(() => run.doc.body.contains(host)), !!host ? 'host 存在' : 'host 不存在')
  const sr = host ? host.shadowRoot : null
  const bar = sr ? run.query(() => sr.querySelector('.bar')) : null
  const buttons = sr ? run.query(() => sr.querySelectorAll('button')) : []
  const menuBtn = sr ? run.query(() => sr.querySelector('.menu-btn')) : null
  const ctlActions = sr ? run.query(() => sr.querySelectorAll('[data-action]')).map((b) => b.getAttribute('data-action')) : []
  c.check('topbar', 'shadowRoot 里有顶栏 .bar + 菜单触发器 + ≥4 个按钮',
    'DOM 构建段位于致命行之后 ⇒ 只剩一个空宿主（0.18.0 实测：挂上了但几乎是空的）',
    !!sr && !!bar && !!menuBtn && buttons.length >= 4,
    `bar=${!!bar} menuBtn=${!!menuBtn} btns=${buttons.length}`)
  c.check('wincontrols', '窗口三键（minimize / toggle-maximize / close）都在顶栏里',
    '控件段被致命行截断 ⇒ 用户失去最小化/最大化/关闭入口（顶栏"在"但没用）',
    ['minimize', 'toggle-maximize', 'close'].every((a) => ctlActions.includes(a)),
    `实测 [${ctlActions.join(',')}]`)

  const html = run.doc.documentElement
  const menubarVar = run.query(() => html.style.getPropertyValue('--dsh-shell-menubar-h'))
  const titlebarVar = run.query(() => html.style.getPropertyValue('--dsh-windows-titlebar-height'))
  const titlebarData = run.query(() => html.dataset.windowsTitlebar)
  const hostClass = host ? run.query(() => host.className) : ''
  c.check('contract', '契约写入落到 documentElement（--dsh-shell-menubar-h / --dsh-windows-titlebar-height / data-windows-titlebar / host.caption）',
    '漏 null 守卫或提前死亡 ⇒ 契约静默全空（客户端算错列宽、插件全屏页被顶栏压住）——这正是 2026-10-16 审计发现的那条漏守卫',
    menubarVar === '36px' && titlebarVar === '40px' && titlebarData === '' && hostClass.includes('caption'),
    `menubar=${menubarVar || '空'} titlebar=${titlebarVar || '空'} data=${JSON.stringify(titlebarData)} hostClass="${hostClass}"`)

  const logCalls = run.calls.filter((x) => x.url.endsWith('/log'))
  const bridgeCalls = run.calls.filter((x) => !x.url.endsWith('/log'))
  c.check('bridge-guard-header', '所有非 GET 桥请求（含 /log 上报）都带 X-DSH-Shell: 1',
    '漏这个头 ⇒ 桥的阶段 0 准入拒绝（预检不放行）⇒ 症状是"菜单点了没反应"（2026-09-01 事故同形）',
    logCalls.length > 0 && logCalls.every((x) => x.shellHeader === '1')
      && bridgeCalls.filter((x) => x.method !== 'GET').every((x) => x.shellHeader === '1'),
    `上报 ${logCalls.length} 条，桥动作 ${bridgeCalls.length} 条`)

  // ③ 自愈：把宿主从 body 移除，然后**手动触发** MutationObserver 回调（真实浏览器由 body 变动触发）。
  const detachObserved = run.query(() => {
    host.remove()
    return !run.doc.body.contains(host)
  })
  const fired = run.fireObservers(run.doc.body)
  const healed = run.query(() => run.doc.body.contains(run.doc.getElementById('dsh-shell-chrome')))
  const remount = run.detailOf('remount')
  c.check('self-heal', '宿主被移除 + 触发 MutationObserver 回调 ⇒ 被重新挂上',
    '自愈观察者注册在致命行之后（0.18.0）或注册被删 ⇒ 宿主一旦被 SPA 重渲染清掉就永不回来 —— 这正是本次要堵的那段',
    detachObserved && fired > 0 && healed, `detach=${detachObserved} 投递回调=${fired} 重挂=${healed}`)
  c.check('remount-report', '自愈会上报 remount（"曾经消失又回来"可回溯）',
    '只重挂不上报 ⇒ 现场无法归因（顶栏静默消失的历史症状）',
    /^remount\b/.test(remount), remount ? remount.slice(0, 120) : '（没有 remount 上报）')

  // 防重复注入守卫（同一文档 on_page_load 可能多次触发）。
  const before = run.query(() => run.doc.querySelectorAll('#dsh-shell-chrome').length)
  let secondThrown = null
  run.recording(true, () => {
    try { vm.runInContext(source, run.sandbox, { filename: 'shell-chrome.js#second-pass' }) } catch (err) { secondThrown = err }
  })
  const after = run.query(() => run.doc.querySelectorAll('#dsh-shell-chrome').length)
  c.check('single-host', '重复注入不会产生第二个宿主（防重复守卫）',
    '守卫被删 ⇒ 页面出现两条顶栏、双份事件监听（点击一次触发两次动作）',
    before === 1 && after === 1 && secondThrown === null, `注入前 ${before} → 注入后 ${after}${secondThrown ? ' 抛:' + errLine(secondThrown) : ''}`)

  // ⑤（补充）全屏浮层让位 + 顶缘唤出：**桩注入布局事实**（position:fixed、覆盖视口、内容越过 36px 带），
  //    断言 chrome 的判定与动作。判的是 chrome 的逻辑，不是真实布局。
  const overlay = run.query(() => {
    const box = run.doc.createElement('div')
    box.className = 'kb-overlay'
    box.__stubPosition = 'fixed'
    box.__rect = { x: 0, y: 0, top: 0, left: 0, right: 1344, bottom: 1025, width: 1344, height: 1025 }
    const inner = run.doc.createElement('div')
    inner.__rect = { x: 0, y: 0, top: 0, left: 0, right: 1344, bottom: 900, width: 1344, height: 900 }
    box.appendChild(inner)
    run.doc.body.appendChild(box)
    run.doc.__elementFromPoint = () => inner
    return { box, inner }
  })
  run.advance(900) // 全屏探测周期 800ms
  const hiddenForOverlay = run.query(() => host.classList.contains('fullscreen-hidden'))
  const toast = sr ? run.query(() => sr.querySelector('#dsh-mini-toast')) : null
  // 顶缘悬停条唤出（4px 条是 chrome 自己的元素）。
  const edgeStrip = sr ? run.query(() => sr.querySelector('.edge-strip')) : null
  const revealed = run.query(() => {
    if (!edgeStrip) return false
    edgeStrip.dispatchEvent({ type: 'mouseenter' })
    return !host.classList.contains('fullscreen-hidden')
  })
  run.query(() => { overlay.box.remove(); run.doc.__elementFromPoint = null })
  c.check('fullscreen-yield', '全屏浮层覆盖视口时菜单栏让位（host.fullscreen-hidden），顶缘悬停可唤出',
    '探测/让位逻辑失效 ⇒ 菜单栏压在插件全屏页（如看板）上，用户点不到页面顶部；或收起后唤不出',
    hiddenForOverlay && revealed && !!toast && /让位/.test(toast.textContent || ''),
    `让位=${hiddenForOverlay} 唤出=${revealed} 提示条="${toast ? String(toast.textContent).slice(0, 30) : '无'}"`)

  const usedNames = [...run.api.names]
  const missingApi = REQUIRED_API.filter((n) => !usedNames.includes(n))
  c.check('api-surface', `桩 DOM 覆盖了真实初始化实际调用的 API（实测 ${usedNames.length} 个入口）`,
    '桩缺某个 API ⇒ 抛 TypeError 变成"桩的缺陷"而不是被测缺陷；这条把必要清单钉成实测值',
    missingApi.length === 0, missingApi.length ? `未触达: ${missingApi.join(', ')}` : '')

  await flush()
  c.check('no-async-error', '定时器回调无异常，也没有未处理的 Promise 拒绝',
    '真实引导的重试（等 body）与桥请求都在定时器/微任务里；那里抛异常同样让 chrome 半死',
    run.timerErrors.length === 0 && unhandled.length === unhandledBefore,
    `定时器异常 ${run.timerErrors.length} 个${run.timerErrors.length ? '(' + errLine(run.timerErrors[0]) + ')' : ''}，未处理拒绝 ${unhandled.length - unhandledBefore} 个`)

  return { checks: c.checks, run, usedNames }
}

/** 场景 2：**极早时序** —— 注入时 <html> 与 <body> 都还不存在（WebView2 导航早期 eval）。
 *  契约开着（dataset 非空）是本场景的关键：它让 `if (rootEl)` 守卫的缺失**结构上可见**。 */
async function scenarioEarly(source, unhandled) {
  const c = makeChecker()
  const unhandledBefore = unhandled.length
  const run = runChrome({ source, early: true, contract: true })
  await flush()

  const stagesBeforeTree = run.stages()
  c.check('early-no-throw', '极早时序（documentElement/body 尚为 null）加载不抛异常',
    '漏 `if (rootEl)` 守卫（0.18.0 写法）⇒ TypeError: Cannot read properties of null (reading \'dataset\') ⇒ 整段 chrome 死亡 —— 这就是变异体 A 的靶子',
    run.thrown === null, errLine(run.thrown))
  c.check('early-ready', '极早时序也跑到 ready，且此时摘要如实写着 body=false',
    '缺少空安全 / 提前死亡 ⇒ 没有 ready（只剩 fatal 或什么都没有）',
    stagesBeforeTree.includes('ready') && !stagesBeforeTree.includes('fatal') && /body=false/.test(run.detailOf('ready')),
    `实测 [${stagesBeforeTree.join(' → ')}]｜ready 摘要: ${run.detailOf('ready').slice(0, 120)}`)
  c.check('early-skip-contract', 'documentElement 尚不存在时契约写入被安全跳过（不抛、也不写脏值）',
    '守卫写成 catch-all（如 try{}catch{} 后照常写）或写错对象 ⇒ 契约落到别处或静默半写',
    run.query(() => run.doc.documentElement === null), 'documentElement 仍为 null（未凭空造树）')

  // 树稍后出现（真实浏览器在导航推进后变出来）⇒ 等 body 的挂载/观察重试必须自己接上。
  run.materialize()
  run.advance(120) // 重试周期 50ms
  const host = run.query(() => run.doc.getElementById('dsh-shell-chrome'))
  const stagesAfterTree = run.stages()
  const menubarVar = run.query(() => run.doc.documentElement.style.getPropertyValue('--dsh-shell-menubar-h'))
  c.check('early-mount-retry', '树出现后宿主被挂上（挂载重试路径真的接上了）',
    '缺少"等 body 可用再挂载"的重试（2026-10-15 前的无守卫写法）⇒ 顶栏永不出现',
    !!host && run.query(() => run.doc.body.contains(host)) && stagesAfterTree.includes('mounted'),
    `实测 [${stagesAfterTree.join(' → ')}]`)
  c.check('early-contract-not-retried', '契约跳过就是跳过：树出现后不会补写（与真机一致，无静默半写）',
    '如果有人给契约加上"稍后重试"，这里会变成非空 ⇒ 说明行为变了，必须显式确认（真机同样只写一次）',
    menubarVar === '', `--dsh-shell-menubar-h=${menubarVar || '空'}`)

  await flush()
  c.check('early-no-async-error', '极早时序下定时器回调无异常、无未处理 Promise 拒绝',
    '等 body 的重试链里抛异常 ⇒ 顶栏永远挂不上（且日志里只有 fatal）',
    run.timerErrors.length === 0 && unhandled.length === unhandledBefore,
    `定时器异常 ${run.timerErrors.length} 个${run.timerErrors.length ? '(' + errLine(run.timerErrors[0]) + ')' : ''}，未处理拒绝 ${unhandled.length - unhandledBefore} 个`)

  return { checks: c.checks, run }
}

/** 场景 3：**出厂默认**（顶栏契约关）—— 这是绝大多数用户跑的配置：壳自己推挤 36px。
 *  只有这条分支会走 `rootEl.style.paddingTop/boxSizing`（契约开时 paddingTop=null，不推挤）。 */
async function scenarioContractOff(source, unhandled) {
  const c = makeChecker()
  const unhandledBefore = unhandled.length
  const run = runChrome({ source, early: false, contract: false })
  await flush()

  const stages = run.stages()
  const html = run.doc.documentElement
  const paddingTop = run.query(() => html.style.paddingTop)
  const boxSizing = run.query(() => html.style.boxSizing)
  const menubarVar = run.query(() => html.style.getPropertyValue('--dsh-shell-menubar-h'))
  const host = run.query(() => run.doc.getElementById('dsh-shell-chrome'))
  const hostClass = host ? run.query(() => host.className) : ''

  c.check('default-push', '默认配置（契约关）真的推挤页面内容：html padding-top=36px + border-box',
    '推挤块被致命行截断 / 守卫写坏 ⇒ 内容被顶栏压住（前 36px 点不到）—— 这是无壳客户端不存在、只有壳才需要的写入',
    paddingTop === '36px' && boxSizing === 'border-box', `paddingTop=${paddingTop || '空'} boxSizing=${boxSizing || '空'}`)
  c.check('default-contract-vars', '默认配置仍给 --dsh-shell-menubar-h（插件全屏 overlay 避让靠它），且不进 caption 模式',
    '只给 caption 模式设该变量 ⇒ position:fixed 的插件全屏页被顶栏压住；host 误带 caption ⇒ 顶栏变透明且不接收指针事件',
    menubarVar === '36px' && !hostClass.includes('caption'), `menubar=${menubarVar || '空'} hostClass="${hostClass}"`)
  c.check('default-chain', '默认配置下引导链同样 inject → mounted → ready 且无 fatal',
    '默认分支死在某一步（历史上"默认关"的分支最容易被改坏却没人跑）',
    stages[0] === 'inject' && stages.includes('mounted') && stages.includes('ready') && !stages.includes('fatal'),
    `实测 [${stages.join(' → ')}]`)

  await flush()
  c.check('default-no-async-error', '默认配置下定时器回调无异常、无未处理 Promise 拒绝',
    '推挤/探测的定时器链里抛异常同样让 chrome 半死', run.timerErrors.length === 0 && unhandled.length === unhandledBefore,
    `定时器异常 ${run.timerErrors.length} 个${run.timerErrors.length ? '(' + errLine(run.timerErrors[0]) + ')' : ''}，未处理拒绝 ${unhandled.length - unhandledBefore} 个`)

  return { checks: c.checks, run }
}

// ══════════════════════════════════════════════════════════════════════════
// 四、变异体（内存里造，绝不写盘）+ 主流程
// ══════════════════════════════════════════════════════════════════════════
// 变异体 A：删掉契约 dataset 写入的 `if (rootEl)` 守卫 —— 等价于还原 0.18.0 的写法
// （同级三行都有守卫，只有 dataset 这一行漏了；2026-10-16 审计发现）。
const MUTANT_A_FROM = 'if (rootEl) for (const [k, v] of Object.entries(captionPlan.dataset)) rootEl.dataset[k] = v;'
const MUTANT_A_TO = 'for (const [k, v] of Object.entries(captionPlan.dataset)) rootEl.dataset[k] = v;'
// 变异体 B：删掉自愈的 MutationObserver 注册（回调体保留，但目标永远是 null ⇒ 宿主被清掉后不回来）。
const MUTANT_B_FROM = 'observer.observe(document.body, { childList: true });'
const MUTANT_B_TO = 'void 0; // mutation-control: 自愈观察者不注册'

const MUTANTS = [
  { key: 'A', title: '删掉契约 dataset 写入的 if (rootEl) 守卫（= 0.18.0 写法）', from: MUTANT_A_FROM, to: MUTANT_A_TO, expect: 'early-no-throw' },
  { key: 'B', title: '删掉自愈观察者的注册 observer.observe(document.body, …)', from: MUTANT_B_FROM, to: MUTANT_B_TO, expect: 'self-heal' },
]

const unhandled = []
process.on('unhandledRejection', (reason) => { unhandled.push(reason) })
process.on('uncaughtException', (err) => {
  console.error(`FAIL 未捕获异常逃到进程层：${errLine(err)}`)
  process.exit(1)
})

async function main() {
  let failures = 0
  const fail = (msg) => { failures += 1; console.error(`FAIL ${msg}`) }
  const positive = []

  console.log(`chrome 引导桩（纯 Node，无浏览器）｜被测文件: ${CHROME_PATH}`)
  // 说明：本套件**故意不设** __DSH_CHROME_TEST__（被测文件里的 TEST_HOOK 分支由
  // scripts/test-shell-chrome.mjs 负责）—— 这里跑的就是它后面那段真实初始化路径。

  // ── 正向：真实初始化路径必须全绿（三个时序/配置都要跑） ────────────────
  console.log('\n== 正向 1/3：不设 __DSH_CHROME_TEST__ 加载 chrome（正常时序 + 顶栏契约开） ==')
  const normal = await scenarioNormal(CHROME_SRC, unhandled)
  printChecks(normal.checks)
  positive.push(...normal.checks)
  console.log(`   桩 DOM 实测被调用的入口（${normal.usedNames.length}）: ${[...normal.usedNames].sort().join(', ')}`)

  console.log('\n== 正向 2/3：极早时序（<html>/<body> 尚不存在，等树出现后重试）+ 顶栏契约开 ==')
  const early = await scenarioEarly(CHROME_SRC, unhandled)
  printChecks(early.checks)
  positive.push(...early.checks)

  console.log('\n== 正向 3/3：出厂默认（顶栏契约关）—— 壳自己推挤 36px ==')
  const dflt = await scenarioContractOff(CHROME_SRC, unhandled)
  printChecks(dflt.checks)
  positive.push(...dflt.checks)

  const positiveFailed = positive.filter((x) => !x.ok)
  for (const f of positiveFailed) fail(`正向检查未通过: ${f.label}`)
  if (positiveFailed.length) {
    console.error(`\nFAILED: 真实初始化路径有 ${positiveFailed.length} 项断言未通过（被测文件可能真的坏了：${positiveFailed.map((x) => x.id).join(', ')}）`)
    process.exit(1)
  }

  // ── 负向对照：两个变异体都必须让**指定**断言变红 ────────────────────────
  // ⚠️ 下面每个变异体段落里的 FAIL 行是**预期**的（负向对照的意义就是让门禁变红）；
  //    计入成败的只有紧随其后的 `ok 变异体 X ⇒ 指定断言 … 确实变红` 这一行。
  for (const m of MUTANTS) {
    console.log(`\n== 变异体 ${m.key}（内存里造，不写盘）：${m.title} ==`)
    if (!CHROME_SRC.includes(m.from)) {
      fail(`变异体 ${m.key} 的锚点在被测文件里找不到了（夹具与被测文本脱钩，必须修夹具）: ${m.from.slice(0, 70)}…`)
      continue
    }
    const mutated = CHROME_SRC.replace(m.from, m.to)
    if (mutated === CHROME_SRC) {
      fail(`变异体 ${m.key} 未生效（字符串替换没有改变源码）`)
      continue
    }
    const all = [
      ...(await scenarioNormal(mutated, unhandled)).checks,
      ...(await scenarioEarly(mutated, unhandled)).checks,
      ...(await scenarioContractOff(mutated, unhandled)).checks,
    ]
    const failedIds = all.filter((x) => !x.ok).map((x) => x.id)
    console.log(`  变异体 ${m.key} 下失败的断言（预期为红）: ${failedIds.length ? failedIds.join(', ') : '（无！）'}`)
    printChecks(all, { onlyFailing: true })
    if (!failedIds.includes(m.expect)) {
      fail(`变异体 ${m.key} 没有让指定断言 "${m.expect}" 变红（实测失败项: ${failedIds.join(', ') || '无'}）—— 该断言是恒真的假门禁`)
    } else {
      console.log(`  ok   变异体 ${m.key} ⇒ 指定断言 "${m.expect}" 确实变红（门禁可信）`)
    }
    if (!failedIds.length) fail(`变异体 ${m.key} 完全没被抓住（整个套件对它不敏感）`)
  }

  if (failures) {
    console.error(`\nFAILED: chrome 引导桩 ${failures} 项（含负向对照）`)
    process.exit(1)
  }
  console.log('\nPASS: chrome 引导桩（纯 Node；真实初始化路径：上报链 inject→mounted→ready / 宿主与顶栏 / 自愈重挂 /')
  console.log(`      契约写入（开与关两态）/ 极早时序空安全；${MUTANTS.length}/${MUTANTS.length} 变异体均被判红）`)
  process.exit(0)
}

await main().catch((err) => {
  console.error(`FAIL 套件自身异常（桩/夹具的缺陷，不是被测文件的）：${errLine(err)}\n${err && err.stack ? err.stack : ''}`)
  process.exit(1)
})
