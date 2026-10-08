#!/usr/bin/env node
// 门禁可信度对照（2026-10-08 起，npm test 第 20 套）：**注入真实缺陷 ⇒ 对应套件必须变红；还原 ⇒ 必须变绿**。
//
// 为什么需要：覆盖率只说明"跑过多少行"，不说明"断言是否真的会失败"。恒真的门禁比没有门禁更糟（给出虚假安心）。
// 三个对照都刻意选择**改内容**而不是"改某个精确字符串"，避免夹具与被测文本耦合：
//   ① 篡改资源副本        ⇒ test-copy-consistency 必须红（它存在的意义就是两份一致）
//   ② 篡改 package.json 版本 ⇒ test-manifest-consistency 必须红（四版本一致是它的核心断言）
//   ③ 在 manager 注入一个空 catch ⇒ test-silent-failures 必须红（这正是该门禁声称能抓的缺陷）
//
// 安全约束：**只在干净工作树上运行**（否则拒绝）；每个对照组用 try/finally 还原，并在还原后验证"变绿"。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sh = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const node = (script) => {
  try {
    execFileSync(process.execPath, [join(ROOT, script)], { cwd: ROOT, stdio: 'pipe' })
    return 0
  } catch (err) { return err.status ?? 1 }
}

if (sh(['status', '--porcelain', '--untracked-files=no']) !== '') {
  console.error('FAIL: 工作树有未提交的**已跟踪**改动 —— 本套件会临时修改文件，拒绝运行（未跟踪的新文件不算脏）')
  process.exit(1)
}

const controls = [
  {
    name: '篡改资源副本 ⇒ 一致性门禁必须红',
    target: 'src-tauri/resources/manager/server-manager.mjs',
    mutate: (s) => s + '\n// mutation-control: 故意让两份不一致\n',
    suite: 'scripts/test-copy-consistency.mjs',
  },
  {
    name: '篡改 package.json 版本 ⇒ 四版本一致门禁必须红',
    target: 'package.json',
    mutate: (s) => s.replace(/"version":\s*"[^"]+"/, '"version": "9.9.9-mutation"'),
    suite: 'scripts/test-manifest-consistency.mjs',
  },
  {
    name: '在 manager 注入空 catch ⇒ 静默失效审计必须红',
    target: 'scripts/server-manager.mjs',
    mutate: (s) => s.replace('function npm(', 'function mutationControl() { try { void 0 } catch { } }\nfunction npm('),
    suite: 'scripts/test-silent-failures.mjs',
  },
]

let failures = 0
for (const c of controls) {
  const path = join(ROOT, c.target)
  const original = readFileSync(path, 'utf8')
  const mutated = c.mutate(original)
  if (mutated === original) {
    console.error(`  FAIL ${c.name}：变异未生效（夹具与被测文本已脱钩）`)
    failures++
    continue
  }
  let red = 0, greenAfter = 0
  try {
    writeFileSync(path, mutated)
    red = node(c.suite)
  } finally {
    writeFileSync(path, original)
    greenAfter = node(c.suite)
  }
  const ok = red !== 0 && greenAfter === 0
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${c.name}（注入后 exit=${red}，还原后 exit=${greenAfter}）`)
  if (!ok) failures++
}

if (failures) { console.error(`FAILED: ${failures} 项对照未通过（门禁不可信）`); process.exit(1) }
console.log(`PASS: 门禁可信度对照（${controls.length}/${controls.length}：注入必红、还原必绿）`)
