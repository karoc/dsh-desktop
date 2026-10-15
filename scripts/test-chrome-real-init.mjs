#!/usr/bin/env node
// 壳注入脚本的**真实初始化**自检（2026-10-15 新增，dev 侧门禁 `npm run test:chrome-real`）。
//
// 为什么必须单独有这一条：`scripts/test-shell-chrome.mjs` 加载 chrome 时设了 `__DSH_CHROME_TEST__`
// ⇒ chrome 在 TEST_HOOK 处**提前 return** ⇒ **第 145 行之后的真实初始化路径在单测里从不执行**。
// 2026-10-15 的真实事故正落在这条缝里：鉴权探针的调度块被误插进 `misleadingAuthHint` 函数体
// ⇒ 顶层 `scheduleAuthProbe()` 抛 `ReferenceError` ⇒ **整个 chrome 加载即中断**（顶栏/菜单全无、
// 插件 UI 面也不出现），而所有单测全绿。
//
// 判据（可失败）：把 chrome 注入到一个**真实 Chromium 页面**（不带 TEST_HOOK）后，必须满足
//   ① 没有 pageerror ② 存在 `#dsh-shell-chrome` 宿主 ③ shadow root 里有 ≥4 个按钮（顶栏菜单）。
// 没有可用的活动页面时**显式 SKIP**（exit 0 并打印原因），不伪装通过。
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = join(ROOT, 'src-tauri', 'resources', 'ui', 'shell-chrome.js')
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
const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1344, height: 1025 } })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(mask(String(e.message).split('\n')[0])))
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(9000)
for (const t of ['继续', '稍后配置', 'Continue']) { const x = page.locator(`button:text-is("${t}")`); if (await x.count()) { await x.first().click().catch(() => {}); break } }
await page.waitForTimeout(2000)
await page.addScriptTag({ content: code })
await page.waitForTimeout(4000)
const info = await page.evaluate(() => {
  const host = document.getElementById('dsh-shell-chrome')
  const sr = host && host.shadowRoot
  return { host: !!host, buttons: sr ? sr.querySelectorAll('button').length : -1 }
})
await browser.close()

let failed = 0
const check = (name, ok) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failed++ }
check('真实初始化无异常（无 pageerror）', errors.length === 0)
check('创建了 #dsh-shell-chrome 宿主', info.host)
check(`shadow root 内按钮数 ≥ 4（实测 ${info.buttons}）`, info.buttons >= 4)
if (errors.length) for (const e of errors.slice(0, 4)) console.log(`    pageerror: ${e}`)
if (failed) { console.error(`FAILED: chrome 真实初始化自检 ${failed} 项`); process.exit(1) }
console.log('PASS: chrome 真实初始化自检（顶栏宿主与菜单都在）')
