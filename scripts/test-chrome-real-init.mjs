#!/usr/bin/env node
// 壳注入脚本的**真实初始化**自检（2026-10-15 新增，2026-10-16 扩充；dev 侧门禁 `npm run test:chrome-real`）。
//
// 为什么必须单独有这一条：`scripts/test-shell-chrome.mjs` 加载 chrome 时设了 `__DSH_CHROME_TEST__`
// ⇒ chrome 在 TEST_HOOK 处**提前 return** ⇒ **第 145 行之后的真实初始化路径在单测里从不执行**。
// 2026-10-15 的真实事故正落在这条缝里：鉴权探针的调度块被误插进 `misleadingAuthHint` 函数体
// ⇒ 顶层 `scheduleAuthProbe()` 抛 `ReferenceError` ⇒ **整个 chrome 加载即中断**（顶栏/菜单全无、
// 插件 UI 面也不出现），而所有单测全绿。
//
// 判据（均可失败，且每一条都实测过"注入对应缺陷后必须变红"）：
//   ① 没有 pageerror；
//   ② 存在 `#dsh-shell-chrome` 宿主、shadow root 内按钮数 ≥4；
//   ③ 最早期注入（body 尚不存在的时序）不崩且最终挂上顶栏；
//   ④ **引导上报完整**：inject → mounted → ready（走本机 stub 桥，假装环回桥）且无 fatal；
//   ⑤ **自愈可失败对照**：把宿主从 body 移除（模拟 dsh SPA 重渲染 body）后必须重挂 + 报 remount。
//      这一条是 0.18.0 事故的直接判据：那一版的 MutationObserver 位于致命行之后、永不执行
//      ⇒ 顶栏一旦被清掉就再也不回来（实测 0.18.0 在此处变红）。
// 没有可用的活动页面时**显式 SKIP**（exit 0 并打印原因），不伪装通过。
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 负向对照入口：`DSH_CHROME_FILE=<别的 chrome 文件> npm run test:chrome-real` 必须**变红**。
// （2026-10-16 用它把 0.18.0 的事故版拉进来验过：那版在自愈/上报两条上都失败。）
const CHROME = process.env.DSH_CHROME_FILE || join(ROOT, 'src-tauri', 'resources', 'ui', 'shell-chrome.js')
const mask = (s) => String(s).replaceAll(/token=[^\s"'&]+/g, 'token=<masked>')

function liveUrl(logPath) {
  if (!existsSync(logPath)) return null
  const log = readFileSync(logPath, 'utf8')
  const urls = [...log.matchAll(/^(\S+) .*dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/gm)]
  return urls.length ? urls[urls.length - 1][2] : null
}

const candidates = [
  'C:/Users/qqwto/AppData/Roaming/dsh.smoothly.desktop/runtime/manager.log',
  '/mnt/c/Users/qqwto/AppData/Roaming/dsh.smoothly.desktop/runtime/manager.log',
  '/mnt/c/Users/qqwto/AppData/Roaming/dsh.smoothly.desktop.dev/runtime/manager.log',
]
const url = candidates.map(liveUrl).find(Boolean)
if (!url) {
  console.log('SKIP: 没有可用的活动 dsh 页面（需要本机 dsh 正在运行）—— 本自检只在本机真机环境下有意义')
  process.exit(0)
}

const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require('/home/karoc/node_modules/playwright')) } catch { try { ({ chromium } = require('playwright')) } catch { console.log('SKIP: 本机没有 playwright'); process.exit(0) } }

const code = readFileSync(CHROME, 'utf8')

// ── stub 环回桥：只收 /log，用来断言 chrome 的引导上报真的发出 ──────────────
// 必须实现**预检**（OPTIONS）并放行 content-type + x-dsh-shell：跨源 POST 带自定义头
// 会先触发预检，桥侧漏配 Allow-Headers 的症状就是"真正的 POST 根本不发出"（技能 §5.5）。
const reports = []          // 每个元素 = 一条 detail 字符串
const stub = createServer((req, res) => {
  let buf = ''
  req.on('data', (c) => (buf += c))
  req.on('end', () => {
    const cors = {
      'access-control-allow-origin': req.headers.origin || '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type, x-dsh-shell',
      'access-control-max-age': '600',
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }
    if (req.method === 'POST' && req.url === '/log') {
      try { const d = JSON.parse(buf).detail; if (d) reports.push(String(d)) } catch { reports.push(buf) }
    }
    res.writeHead(200, { 'content-type': 'application/json', ...cors })
    res.end('{}')
  })
})
await new Promise((r) => stub.listen(0, '127.0.0.1', r))
const stubPort = stub.address().port
const prefix = `window.__DSH_BRIDGE_PORT__=${JSON.stringify(String(stubPort))};`
// 「顶栏契约」开关（S8）：壳在运行时按标志文件注入 `__DSH_TITLEBAR_CONTRACT__=true`（lib.rs
// inject_shell_chrome）。它决定 `computeCaptionPlan` 的 dataset 是否**非空** —— 2026-10-16 审计
// 发现这正是"契约写入漏了一个 null 守卫"能否被看见的开关：不置它，chrome 永远走 dataset={} 空转
// 分支，门禁**结构上看不见**那个缺陷。据此在"最早期注入"时序（documentElement 可能尚为 null）
// 把它打开，作为该缺陷的负向对照入口。
const contractOn = 'window.__DSH_TITLEBAR_CONTRACT__=true;'
const stagesOf = () => reports.map((d) => d.split(' ')[0])

const browser = await chromium.launch()

// 2026-10-15 扩充：壳用 `w.eval` 注入，可能发生在**页面还没有 body** 的早期（WebView2 导航时序）。
// 因此这里额外用 addInitScript 复现"最早期注入"——原先 chrome 在这里抛
// `Cannot read properties of null (reading 'appendChild')` 而整段死亡；加挂载守卫后必须存活。
const ctxEarly = await browser.newContext({ viewport: { width: 1344, height: 1025 } })
await ctxEarly.addInitScript({ content: prefix + contractOn + code })   // 最早期注入（body 尚不存在）+ 顶栏契约开
const pageEarly = await ctxEarly.newPage()
const earlyErrors = []
pageEarly.on('pageerror', (e) => earlyErrors.push(mask(String(e.message).split('\n')[0])))
await pageEarly.goto(url, { waitUntil: 'domcontentloaded' })
await pageEarly.waitForTimeout(9000)
const earlyInfo = await pageEarly.evaluate(() => {
  const host = document.getElementById('dsh-shell-chrome')
  return {
    host: !!host,
    buttons: host && host.shadowRoot ? host.shadowRoot.querySelectorAll('button').length : -1,
    // 契约四项必须真的落到页面根上（漏守卫时会静默全空 —— 见下面 ④ 的判据）
    contract: {
      paddingTop: document.documentElement.style.paddingTop,
      windowsTitlebar: document.documentElement.dataset.windowsTitlebar,
      menubarVar: getComputedStyle(document.documentElement).getPropertyValue('--dsh-shell-menubar-h').trim(),
      hostClass: host ? host.className : '',
    },
  }
})
const earlyStages = stagesOf()
console.log(`  早期注入（无 body 时序）: host=${earlyInfo.host} buttons=${earlyInfo.buttons} errors=${earlyErrors.length} reports=[${earlyStages.join(',')}]`)
await pageEarly.close(); await ctxEarly.close()

reports.length = 0
const ctx = await browser.newContext({ viewport: { width: 1344, height: 1025 } })
// 这个上下文**开契约**：documentElement 必然存在 ⇒ 契约写入必须真的落到页面根
// （S8 的正向保证：data-windows-titlebar + --dsh-shell-menubar-h 给 Web 客户端算列宽）。
await ctx.addInitScript({ content: prefix + contractOn })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(mask(String(e.message).split('\n')[0])))
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(9000)
for (const t of ['继续', '稍后配置', 'Continue']) { const x = page.locator(`button:text-is("${t}")`); if (await x.count()) { await x.first().click().catch(() => {}); break } }
await page.waitForTimeout(2000)
reports.length = 0
await page.addScriptTag({ content: code })
await page.waitForTimeout(4000)
const info = await page.evaluate(() => {
  const host = document.getElementById('dsh-shell-chrome')
  const sr = host && host.shadowRoot
  const bar = sr && sr.querySelector('.bar')
  const r = bar ? bar.getBoundingClientRect() : null
  const out = {
    host: !!host,
    buttons: sr ? sr.querySelectorAll('button').length : -1,
    barTop: r ? Math.round(r.top) : null,
    barH: r ? Math.round(r.height) : null,
    menuOpened: false,
    menuItems: 0,
    contract: {
      paddingTop: document.documentElement.style.paddingTop,
      windowsTitlebar: document.documentElement.dataset.windowsTitlebar,
      menubarVar: getComputedStyle(document.documentElement).getPropertyValue('--dsh-shell-menubar-h').trim(),
      titlebarVar: getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height').trim(),
      hostClass: host ? host.className : '',
    },
  }
  // 交互判据：点唯一的菜单触发器（左上 logo）→ 下拉必须打开。
  // 0.18.0 事故里"点击分发器"注册在致命行（:851）之后 ⇒ 从不注册 ⇒ 顶栏按钮点了没反应
  // —— 这正是用户报的"壳自定义菜单点不开"。所以这条断言直接对着用户症状。
  const btn = sr && sr.querySelector('.menu-btn')
  if (btn) {
    btn.click()
    const dds = [...sr.querySelectorAll('.dropdown')]
    const open = dds.filter((d) => !d.hidden)
    out.menuOpened = open.length > 0
    out.menuItems = open.length ? open[0].querySelectorAll('[data-item],[data-action],.dd-brand').length : 0
    // 2026-10-16（用户装上 0.18.1 后立刻报的问题）：菜单**能开**但内容 466px > 上限 440px
    // ⇒ 任何屏幕尺寸下都出滚动条。判据拆两条：正常窗口尺寸下不该有滚动条（内容装得下）；
    // 矮窗口下允许滚动但**不得越出视口**（下面用 420px 高的视口复测）。
    if (open.length) {
      const dd = open[0]
      out.menuScrolls = dd.scrollHeight > dd.clientHeight
      out.menuBottom = Math.round(dd.getBoundingClientRect().bottom)
      out.viewportH = window.innerHeight
    }
    btn.click() // 收起，保持现场干净
  }
  return out
})
// 矮窗口复测：允许滚动，但不许越出视口底部
await page.setViewportSize({ width: 1147, height: 420 })
await page.waitForTimeout(400)
await page.evaluate(() => {
  const sr = document.getElementById('dsh-shell-chrome')?.shadowRoot
  const btn = sr && sr.querySelector('.menu-btn')
  if (btn) btn.click()
})
await page.waitForTimeout(300)
const shortVp = await page.evaluate(() => {
  const sr = document.getElementById('dsh-shell-chrome')?.shadowRoot
  const dd = sr && [...sr.querySelectorAll('.dropdown')].find((d) => !d.hidden)
  if (!dd) return null
  const r = dd.getBoundingClientRect()
  return { bottom: Math.round(r.bottom), top: Math.round(r.top), vh: window.innerHeight, scrolls: dd.scrollHeight > dd.clientHeight }
})
await page.evaluate(() => {
  const sr = document.getElementById('dsh-shell-chrome')?.shadowRoot
  const btn = sr && sr.querySelector('.menu-btn')
  if (btn) btn.click()
})
await page.setViewportSize({ width: 1344, height: 1025 })
await page.waitForTimeout(300)
const bootStages = stagesOf()
const mountedLine = reports.find((d) => d.startsWith('mounted')) || ''

// ⑤ 自愈对照：把宿主从 body 移除（= dsh SPA 重渲染 body 干的事），必须自动重挂。
await page.evaluate(() => { document.getElementById('dsh-shell-chrome')?.remove() })
await page.waitForTimeout(2500)
const healed = await page.evaluate(() => !!document.getElementById('dsh-shell-chrome'))
const healStages = stagesOf()
await browser.close(); stub.close()

let failed = 0
const check = (name, ok) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failed++ }
check('真实初始化无异常（无 pageerror）', errors.length === 0)
check('创建了 #dsh-shell-chrome 宿主', info.host)
check(`shadow root 内按钮数 ≥ 4（实测 ${info.buttons}）`, info.buttons >= 4)
check(`顶栏真的在视口顶部且可见（bar.top=${info.barTop} bar.h=${info.barH}）`,
  info.barTop !== null && info.barTop >= -2 && info.barTop <= 4 && info.barH >= 30 && info.barH <= 48)
check(`引导上报完整 inject→mounted→ready 且无 fatal（实测 [${bootStages.join(',')}]）`,
  ['inject', 'mounted', 'ready'].every((s) => bootStages.includes(s)) && !bootStages.includes('fatal'))
check(`mounted 上报带位置/可见性摘要（${mask(mountedLine)}）`,
  /bar=-?\d+px h\d+/.test(mountedLine) && /hidden=(true|false)/.test(mountedLine) && /btns=\d+/.test(mountedLine))
check('宿主被移除后自愈重挂（SPA 重渲染不再永久丢顶栏）', healed)
check('自愈会上报 remount（"曾经消失"可回溯）', healStages.includes('remount'))
check(`唯一菜单点得开：点 logo → 下拉出现且有条目（opened=${info.menuOpened} items=${info.menuItems}）`,
  info.menuOpened && info.menuItems >= 5)
check(`正常窗口尺寸下菜单不出滚动条（scrolls=${info.menuScrolls} 内容=${info.menuItems} 项）`,
  info.menuScrolls === false)
check(`矮窗口（420px）下菜单允许滚动但不越出视口（bottom=${shortVp ? shortVp.bottom : '-'} vh=${shortVp ? shortVp.vh : '-'} scrolls=${shortVp ? shortVp.scrolls : '-'}）`,
  !!shortVp && shortVp.bottom <= shortVp.vh)
console.log(`  契约开（加载后注入）: paddingTop='${info.contract.paddingTop}'` +
  ` windowsTitlebar=${JSON.stringify(info.contract.windowsTitlebar)}` +
  ` menubarVar='${info.contract.menubarVar}' titlebarVar='${info.contract.titlebarVar}'` +
  ` hostClass='${info.contract.hostClass}'`)
// S8 契约的**正向**保证：客户端要读 data-windows-titlebar 算列宽、读 --dsh-shell-menubar-h 避让。
check('契约写入落到页面根（data-windows-titlebar + --dsh-shell-menubar-h + host.caption）',
  info.contract.windowsTitlebar !== undefined && info.contract.menubarVar !== '' &&
  info.contract.titlebarVar !== '' && info.contract.hostClass.includes('caption'))
if (errors.length) for (const e of errors.slice(0, 4)) console.log(`    pageerror: ${e}`)
check('最早期注入（无 body 时序）也不崩、且最终挂上顶栏',
  earlyInfo.host && earlyInfo.buttons >= 4 && earlyErrors.length === 0)
check(`最早期注入也跑完引导（实测 [${earlyStages.join(',')}]）`,
  earlyStages.includes('mounted') && earlyStages.includes('ready') && !earlyStages.includes('fatal'))
// ④ 顶栏契约（S8）：契约开 + 最早期注入时 `document.documentElement` **真的可能是 null**，
// 此时守卫的正确行为是"跳过写入且不抛"。所以这里只打印诊断值，判据交给上面的
// 「无 pageerror + 跑完引导」——2026-10-16 审计发现的漏守卫缺陷正是这样被钉住的
// （漏守卫 ⇒ 早期注入 + 契约开 ⇒ TypeError ⇒ 无 ready）。契约**写入真的落地**由下面的
// "契约开"上下文断言（那时 documentElement 必然存在）。
console.log(`  早期注入 + 契约开: paddingTop='${earlyInfo.contract.paddingTop}'` +
  ` windowsTitlebar=${JSON.stringify(earlyInfo.contract.windowsTitlebar)}` +
  ` menubarVar='${earlyInfo.contract.menubarVar}' hostClass='${earlyInfo.contract.hostClass}'`)
if (earlyErrors.length) for (const e of earlyErrors.slice(0, 3)) console.log(`    early pageerror: ${e}`)
if (failed) { console.error(`FAILED: chrome 真实初始化自检 ${failed} 项`); process.exit(1) }
console.log('PASS: chrome 真实初始化自检（顶栏在、引导上报完整、自愈有效）')
