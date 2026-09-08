#!/usr/bin/env node
// Real-browser verification of the shell chrome's fullscreen-overlay
// adaptation (menubar auto-hide / top-edge reveal). Runs the REAL
// shell-chrome.js in a stub page that mimics the dsh app (static flow layout,
// pushed down 36px) plus a kanban-style `position: fixed; inset: 0` overlay,
// then asserts:
//   1. adaptive push (html padding 36px) + --dsh-shell-menubar-h contract;
//   2. fullscreen overlay opens → menubar auto-hides, overlay close button
//      becomes unobstructed and clickable;
//   3. overlay closes → menubar restores;
//   4. hover on the 4px top edge reveals the menubar; after ~3s idle it
//      auto-hides again (and does NOT loop while the mouse sits on the strip);
//   5. no false positive on the normal page (menubar stays visible).
//
// Opt-in: requires `playwright` (plus a Chromium browser). When the package is
// not installed, prints SKIP and exits 0 — it is NOT part of `npm test`.
//
//   node scripts/verify-fullscreen-adaptation.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const chromePath = join(here, '..', 'src-tauri', 'resources', 'ui', 'shell-chrome.js')

let chromium
try {
  ({ chromium } = await import('playwright'))
} catch {
  console.log('SKIP — playwright not installed (opt-in script; not part of npm test)')
  process.exit(0)
}

const chromeJs = readFileSync(chromePath, 'utf8')
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: sans-serif; }
  .app-header { height: 64px; background: #e8e8e8; display: flex; align-items: center; padding: 0 16px; }
  .app-content { padding: 16px; min-height: 400px; background: #fff; }
  .btn { padding: 6px 12px; margin: 4px; }
  /* mimic dsh-kanban .kb-overlay */
  .kb-overlay { position: fixed; inset: 0; z-index: 50; display: flex; flex-direction: column; background: #fff; }
  .kb-header { display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid #ddd; }
  .kb-title { margin: 0; font-size: 16px; font-weight: 600; }
  .kb-spacer { flex: 1; }
  .kb-close { width: 28px; height: 28px; cursor: pointer; }
</style></head><body>
  <div class="app-header">dsh app header (static flow)</div>
  <div class="app-content"><button id="open" class="btn">打开全屏看板</button></div>
  <div id="overlay" class="kb-overlay" style="display: none">
    <header class="kb-header"><h2 class="kb-title">思磨力看板</h2><div class="kb-spacer"></div><button id="ov-close" class="kb-close" aria-label="close">✕</button></header>
    <div style="padding: 20px">board content</div>
  </div>
  <script>
    document.getElementById('open').addEventListener('click', () => { document.getElementById('overlay').style.display = 'block' })
    document.getElementById('ov-close').addEventListener('click', () => { document.getElementById('overlay').style.display = 'none' })
  </script>
  <script>${chromeJs}</script>
</body></html>`

const scratch = mkdtempSync(join(tmpdir(), 'dsh-shell-verify-'))
writeFileSync(join(scratch, 'page.html'), html)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
let failures = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
  if (!cond) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await page.goto('file://' + join(scratch, 'page.html'))
await page.waitForSelector('#dsh-shell-chrome')
await sleep(1200) // let the first probe run

// 1. baseline: adaptive push + contract var + menubar visible
const base = await page.evaluate(() => ({
  pad: document.documentElement.style.paddingTop,
  v: getComputedStyle(document.documentElement).getPropertyValue('--dsh-shell-menubar-h').trim(),
  hidden: document.getElementById('dsh-shell-chrome').classList.contains('fullscreen-hidden'),
}))
check('html padding pushed 36px', base.pad === '36px', JSON.stringify(base))
check('--dsh-shell-menubar-h = 36px', base.v === '36px')
check('menubar visible on normal page', base.hidden === false)

// 2. open the fullscreen overlay -> menubar auto-hides
await page.click('#open')
await sleep(2200)
const ov = await page.evaluate(() => {
  const host = document.getElementById('dsh-shell-chrome')
  const hit = document.elementFromPoint(Math.round(innerWidth / 2), 48)
  const close = document.getElementById('ov-close').getBoundingClientRect()
  const closeHit = document.elementFromPoint(close.left + close.width / 2, close.top + close.height / 2)
  return {
    hidden: host.classList.contains('fullscreen-hidden'),
    hitOverlay: !!hit && !!hit.closest && !!hit.closest('.kb-overlay'),
    closeUnobstructed: !!closeHit && (closeHit.id === 'ov-close' || (closeHit.closest && closeHit.closest('#ov-close'))),
    closeTop: close.top,
  }
})
check('menubar hidden after fullscreen overlay opens', ov.hidden === true, JSON.stringify(ov))
check('probe at (w/2,48) hits the overlay', ov.hitOverlay === true)
check('overlay close button unobstructed at its center', ov.closeUnobstructed === true, `top=${ov.closeTop}`)

// 3. overlay close button is clickable while menubar hidden
await page.click('#ov-close')
await sleep(1500)
const afterClose = await page.evaluate(() => ({
  hidden: document.getElementById('dsh-shell-chrome').classList.contains('fullscreen-hidden'),
  overlayGone: getComputedStyle(document.getElementById('overlay')).display === 'none',
}))
check('overlay closed by its own button', afterClose.overlayGone === true, JSON.stringify(afterClose))
check('menubar restored after overlay closes', afterClose.hidden === false)

// 4. hover the 4px top strip -> menubar revealed; idle -> auto re-hide (no loop)
await page.click('#open')
await sleep(2200)
const wasHidden = await page.evaluate(() => document.getElementById('dsh-shell-chrome').classList.contains('fullscreen-hidden'))
check('re-hidden for hover test', wasHidden === true)
await page.mouse.move(640, 2)
await sleep(500)
const revealed = await page.evaluate(() => !document.getElementById('dsh-shell-chrome').classList.contains('fullscreen-hidden'))
check('hover top edge reveals menubar', revealed === true)
await sleep(3600) // > FULLSCREEN_REVEAL_IDLE_MS
const rehid = await page.evaluate(() => document.getElementById('dsh-shell-chrome').classList.contains('fullscreen-hidden'))
check('menubar auto-hides again after idle (no hover loop)', rehid === true)

// 5. no false positive on the normal page (menubar stays)
await page.click('#ov-close')
await sleep(1500)
const stable = await page.evaluate(() => !document.getElementById('dsh-shell-chrome').classList.contains('fullscreen-hidden'))
check('menubar stable on normal page (no false positive)', stable === true)

await browser.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)