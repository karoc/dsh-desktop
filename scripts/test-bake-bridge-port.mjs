#!/usr/bin/env node
// 桥端口烘焙的"写出前自证合法"门禁（2026-10-17）。
//
// 背景：manager 的 bakeBridgePort 会**就地改写**插件 client.js，把带引号的
// `'__DSH_BRIDGE_PORT__'` 换成真实端口。脚本注释里记录过一次事故：替换错位置得到
// `globalThis.12345` ⇒ SyntaxError ⇒ `<script src>` 整文件失效、插件全灭。这类
// "整段静默死亡"与 0.18.0 顶栏事故同族，必须有可失败的门禁。
//
// 负向对照（本套件自证可失败，改坏任意一处即红）：
//   ① 把 checkScriptSyntax 换成"永不失败"（或删掉 manager 里的调用）→ 第 4 条与接线断言必红；
//   ② 把 bakeBridgePortSource 改回"替换全部出现"（连不带引号的读取路径一起换）→ 第 1 条必红。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { bakeBridgePortSource, checkScriptSyntax, PORT_PLACEHOLDER } from './bake-port.mjs'

let failures = 0
const check = (label, fn) => {
  try { fn(); console.log(`ok   ${label}`) } catch (e) { failures += 1; console.error(`FAIL ${label}\n     ${e.message}`) }
}

// 与真实插件同形：一处带引号的占位符（待烘焙）+ 一处不带引号的读取路径（必须原样保留）。
const SAMPLE = [
  '// demo client plugin (classic script)',
  '(function () {',
  "  const baked = '__DSH_BRIDGE_PORT__';",
  '  const port = globalThis.__DSH_BRIDGE_PORT__ || baked;',
  "  window.__ModuleLoader__.load({ id: 'demo', port });",
  '})();',
  '',
].join('\n')

check('只替换带引号的占位符，不带引号的读取路径原样保留', () => {
  const { source, changed } = bakeBridgePortSource(SAMPLE, 57360)
  assert.equal(changed, true)
  assert.ok(source.includes("const baked = '57360';"), '带引号的占位符应被替换')
  assert.ok(source.includes('globalThis.__DSH_BRIDGE_PORT__'), 'globalThis 读取路径必须保留')
  assert.ok(!source.includes(PORT_PLACEHOLDER), '占位符应已消失')
})

check('幂等：没有占位符时返回原文且 changed=false（不触发写盘）', () => {
  const baked = bakeBridgePortSource(SAMPLE, 57360).source
  const again = bakeBridgePortSource(baked, 57360)
  assert.equal(again.changed, false)
  assert.equal(again.source, baked)
})

check('合法脚本：vm.Script 编译通过（与浏览器 <script src> 同语义）', () => {
  const baked = bakeBridgePortSource(SAMPLE, 57360).source
  const r = checkScriptSyntax(baked)
  assert.equal(r.ok, true, `应通过，实际: ${r.why}`)
})

check('负向对照：旧事故形态（不带引号也被替换 ⇒ globalThis.12345）必须被判非法', () => {
  // 复刻事故写法：对整串做替换，连 `globalThis.__DSH_BRIDGE_PORT__` 一起换掉。
  const broken = SAMPLE.split('__DSH_BRIDGE_PORT__').join('57360')
  assert.ok(broken.includes('globalThis.57360'), '夹具应真的产出事故形态')
  const r = checkScriptSyntax(broken)
  assert.equal(r.ok, false, 'globalThis.57360 是语法错误，必须被判非法')
  assert.ok(r.why.length > 0, '失败时必须带可读原因（供日志用）')
})

check('顶层 return 这类「函数体/ CJS 合法但脚本非法」的写法也必须被判非法', () => {
  const r = checkScriptSyntax('return 1\n')
  assert.equal(r.ok, false, 'new Function 会放过它；node --check 必须拦住')
})

check('接线断言：manager 在写盘前真的调用了校验，且失败时保留原文件', () => {
  const src = readFileSync(new URL('./server-manager.mjs', import.meta.url), 'utf8')
  assert.ok(/bakeBridgePortSource\(raw, args\.bridgePort\)/.test(src), '应使用可测的纯函数生成候选')
  assert.ok(/const verdict = checkScriptSyntax\(next\)/.test(src), '写盘前必须校验候选')
  assert.ok(/if \(!verdict\.ok\) \{[\s\S]{0,400}?return\s*\}/.test(src), '校验失败必须直接 return（不写盘）')
  assert.ok(/bridge port bake ABORTED/.test(src), '失败路径必须留下可检索日志')
})

if (failures > 0) { console.error(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: 桥端口烘焙自证（只换带引号占位符 / 写前校验 / 事故形态必被拦）')
