#!/usr/bin/env node
// Throwaway deterministic check for the launcher sweep logic (src/app.js):
//   - MAX_ROWS trims to 9 (appendLog x12 → 9 children, newest first)
//   - advanceStep: 9th step schedules lightAll via setTimeout(1700) — NOT immediate
//   - scanTick stops the rAF loop while the final timer is pending (no timer reset loop)
//   - resetSweep / server-down / install-error cancel the pending timer
//   - lightAll is idempotent and clears the timer
// Run: node scripts/test-launcher-sweep.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const root = dirname(fileURLToPath(import.meta.url))
const appJs = readFileSync(join(root, '..', 'src', 'app.js'), 'utf8')

// ── minimal DOM / Tauri / timer stubs ───────────────────────────────────────
function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(), children: [], style: {}, className: '', id: '',
    title: '', hidden: false, textContent: '', clientHeight: 26 * 9,
    parentNode: null,
    appendChild(c) { el.children.push(c); c.parentNode = el; return c },
    insertBefore(c, ref) { const i = ref ? el.children.indexOf(ref) : -1; if (i >= 0) el.children.splice(i, 0, c); else el.children.unshift(c); c.parentNode = el; return c },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parentNode = null },
    addEventListener() {}, setAttribute() {}, removeAttribute() {},
  }
  return el
}
const ids = ['state', 'credits', 'retry', 'opendata', 'openplugins', 'spinner', 'installProgress', 'legacyBanner', 'legacyBannerText', 'legacyCleanBtn', 'legacyLaterBtn']
const elements = Object.fromEntries(ids.map((id) => [id, makeEl()]))
const creditsViewport = makeEl()
creditsViewport.clientHeight = 26 * 9

// timers: capture registrations; no real waiting
let nextTimer = 1
const pending = new Map()
const timers = { setTimeout(fn, ms) { const id = nextTimer++; pending.set(id, { fn, ms }); return id },
                 clearTimeout(id) { pending.delete(id) } }
let rafScheduled = 0, rafCancelled = 0, rafCb = null
const raf = { requestAnimationFrame(cb) { rafScheduled++; rafCb = cb; return rafScheduled },
              cancelAnimationFrame() { rafCancelled++; rafCb = null } }

const ctx = {
  console, document: {
    getElementById: (id) => elements[id] || null,
    querySelector: (sel) => (sel === '.credits-viewport' ? creditsViewport : null),
    createElement: (t) => makeEl(t),
  },
  window: { matchMedia: () => ({ matches: false }) },
  globalThis: {},
  setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  setInterval: () => 1, clearInterval: () => {},
  requestAnimationFrame: raf.requestAnimationFrame, cancelAnimationFrame: raf.cancelAnimationFrame,
  sessionStorage: { getItem: () => null, setItem() {} },
}
ctx.globalThis = ctx
ctx.__TAURI__ = {
  event: { listen: (name, cb) => { (ctx.__events = ctx.__events || {})[name] = cb; return Promise.resolve() } },
  core: { invoke: () => Promise.resolve({}) },
}
vm.createContext(ctx)
vm.runInContext(appJs, ctx, { filename: 'src/app.js' })

const credits = elements.credits
let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok  ${name}`)
  else { failures++; console.log(`FAIL  ${name} ${extra}`) }
}
const lightTimers = () => [...pending.values()].filter((t) => String(t.fn).includes('lightAll'))

// 1) 9-row trim: 12 logs → 9 rows kept, newest first (insertBefore firstChild)
for (let i = 1; i <= 12; i++) ctx.appendLog(`line ${i}`)
check('MAX_ROWS=9: 12 条日志后保留 9 行', credits.children.length === 9, `got ${credits.children.length}`)
check('新行在顶部（最新 line 12 在最上）', credits.children[0].textContent === 'line 12', credits.children[0] && credits.children[0].textContent)
check('最旧行被裁掉（line 1-3 不在）', !credits.children.some((c) => c.textContent === 'line 1'))

// sweep should have started (raf scheduled) — rows exist
check('有日志后启动光辉扫动', rafScheduled >= 1)

// 2) real-flow: drive scanTick exactly like the browser rAF loop (only call
//    scanTick when a rAF was scheduled). The sweep runs 9 ramps; at the final
//    step the loop must STOP while the 1.7s timer is pending — otherwise the
//    timer would keep being re-armed and lightAll would never fire.
let ts = 0, sweptToEnd = false, frames = 0
while (rafCb && !sweptToEnd && frames < 5000) {
  const cb = rafCb; rafCb = null
  ts += 100
  cb(ts)
  frames++
  sweptToEnd = lightTimers().length === 1 && rafCb === null // 顶点定时器挂起且循环不再调度
}
check('扫动推进完整 9 档后到达顶点（定时器挂起）', lightTimers().length === 1, `frames=${frames}, n=${lightTimers().length}`)
check('顶点等待期 rAF 循环停止（不再调度）', sweptToEnd, `frames=${frames}`)
check('等待期行未点亮（opacity != 1）', credits.children.every((c) => c.style.opacity !== '1'))

// 3) firing the timer lights everything
lightTimers()[0].fn()
check('定时器触发后全部点亮', credits.children.every((c) => c.style.opacity === '1'))
check('触发后亮灯定时器已清', lightTimers().length === 0, `n=${lightTimers().length}`)

// 3b) REGRESSION: during the pending 1.7s pause, new logs must NOT restart the
//     sweep (which would re-arm the timer via advanceStep and delay lightAll).
ctx.resetSweep()
ctx.appendLog('pause test')
while (rafCb && lightTimers().length === 0) { const cb = rafCb; rafCb = null; ts += 100; cb(ts) }
check('顶点定时器已挂起（前置）', lightTimers().length === 1)
const rafBeforePause = rafCb
const timerIdBefore = lightTimers()[0]
ctx.appendLog('log during pause')   // 停顿期新日志
check('停顿期新日志不重启扫动（无 rAF）', rafCb === null, `rafCb=${rafCb !== null}`)
check('停顿期定时器不被重置（仍是同一 id）', lightTimers().length === 1 && lightTimers()[0] === timerIdBefore, `n=${lightTimers().length}`)
ctx.appendLog('another log during pause')
check('连续新日志仍不重置定时器', lightTimers().length === 1 && lightTimers()[0] === timerIdBefore)
lightTimers()[0].fn()
check('停顿期新日志随定时器一起点亮', credits.children.every((c) => c.style.opacity === '1'))
// 亮灯后新日志立即点亮（不重启扫动）
ctx.appendLog('log after lit')
check('亮灯后新日志立即点亮', credits.children[0].style.opacity === '1')
check('亮灯后不再调度扫动', rafCb === null)

// 4) advanceStep semantics: first 8 steps schedule no timer; 9th arms 1700ms
ctx.resetSweep()
ctx.appendLog('again')
for (let i = 0; i < 8; i++) ctx.advanceStep()
check('前 8 步不调度亮灯定时器', lightTimers().length === 0)
ctx.advanceStep() // 第 9 步 → 顶点
check('第 9 步调度 1 个亮灯定时器', lightTimers().length === 1, `n=${lightTimers().length}`)
check('亮灯延迟 = 1700ms', lightTimers().length === 1 && lightTimers()[0].ms === 1700, lightTimers()[0] && `ms=${lightTimers()[0].ms}`)

// 5) resetSweep cancels a pending timer (re-arm then reset)
ctx.resetSweep()
check('resetSweep 取消挂起定时器', lightTimers().length === 0, `n=${lightTimers().length}`)

// 6) server-down cancels pending timer
ctx.appendLog('x')
for (let i = 0; i < 9; i++) ctx.advanceStep()
check('server-down 前定时器挂起', lightTimers().length === 1)
ctx.__events['server-down']()
check('server-down 取消定时器', lightTimers().length === 0, `n=${lightTimers().length}`)

// 7) install error cancels pending timer
ctx.appendLog('y')
for (let i = 0; i < 9; i++) ctx.advanceStep()
check('install-error 前定时器挂起', lightTimers().length === 1)
ctx.__events['install-status']({ payload: { phase: 'error', error: 'boom' } })
check('install-error 取消定时器', lightTimers().length === 0, `n=${lightTimers().length}`)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
