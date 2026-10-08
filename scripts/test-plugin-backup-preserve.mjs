#!/usr/bin/env node
// 端到端断言：**插件备份永不因为"开始安装"而消失**（2026-10-07 质量审计修的数据丢失面）。
//
// 背景：`server-manager.mjs` 原来在安装开始时无条件 `rmSync(.plugin-backup)`。若上一次安装在"恢复插件"之前
// 被打断，这份备份可能是用户插件**唯一的一份拷贝** ⇒ 删掉就把"可恢复"变成"不可恢复"。
// 修法：只挪不删（→ `.plugin-backup.prev`），成功后才清理；启动恢复主备份优先。
//
// 判据（**可失败**）：在 `.plugin-backup` 里放一个**只存在于那里**的标记文件，让安装失败，然后断言标记
// 内容仍在（无论在 node_modules 还是在 .plugin-backup*）——把"只挪不删"改回 rmSync，本套件必红。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANAGER = join(ROOT, 'scripts', 'server-manager.mjs')
const NODE = process.execPath
const tmp = mkdtempSync(join(tmpdir(), 'dsh-pb-'))
const runtime = join(tmp, 'runtime')
const fakeHome = join(tmp, 'home')
mkdirSync(join(runtime, 'node_modules'), { recursive: true })
mkdirSync(fakeHome, { recursive: true })

// 受保护的"仅复制"客户端插件（壳侧 @dsh-desktop/*）—— 安装前会被备份
const PROTECTED = join(runtime, 'node_modules', '@dsh-desktop', 'client-notifications')
mkdirSync(PROTECTED, { recursive: true })
writeFileSync(join(PROTECTED, 'package.json'), JSON.stringify({ name: '@dsh-desktop/client-notifications', version: '0.0.1' }))

// ★ 关键夹具：一个**只存在于备份里**的标记（模拟"上次安装在恢复前被打断"）
const MARK = 'ONLY-COPY-MARKER'
const BACKUP = join(runtime, '.plugin-backup')
mkdirSync(join(BACKUP, '@dsh-desktop', 'client-notifications'), { recursive: true })
writeFileSync(join(BACKUP, '@dsh-desktop', 'client-notifications', MARK), 'must-not-be-lost\n')

// 假 pnpm：**故意失败**（触发 finally 里的安全网路径，且安装不会真的联网）；配合 --force 让安装路径真的被执行
const FAKE_PNPM = `process.stderr.write('stub pnpm: failing on purpose\\n')\nprocess.exit(3)\n`
mkdirSync(join(runtime, 'node_modules', 'pnpm', 'bin'), { recursive: true })
writeFileSync(join(runtime, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), FAKE_PNPM)

// 假 registry：给 npm view 一个合法 packument（否则 manager 会在更早的分支退出）
const registry = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ 'dist-tags': { latest: '9.9.9' }, versions: { '9.9.9': { dist: { tarball: `http://127.0.0.1:${registry.address().port}/dsh.tgz` } } } }))
})
await new Promise((r) => registry.listen(0, '127.0.0.1', r))

const child = spawn(NODE, [MANAGER,
  '--runtime-dir', runtime, '--resource-dir', join(ROOT, 'src-tauri', 'resources'),
  '--patch', join(tmp, 'patch.json'), '--cwd', tmp, '--home', fakeHome,
  '--registry', `http://127.0.0.1:${registry.address().port}`, '--bridge-port', '0', '--force',
], { env: { ...process.env, HOME: fakeHome }, stdio: ['ignore', 'pipe', 'pipe'] })

let out = ''
child.stdout.on('data', (d) => { out += d })
child.stderr.on('data', (d) => { out += d })
const code = await new Promise((r) => { child.on('exit', r); setTimeout(() => { child.kill('SIGKILL'); r('timeout') }, 90_000) })
registry.close()

// ── 断言 ────────────────────────────────────────────────────────────────────
function markerSomewhere() {
  const roots = [join(runtime, 'node_modules'), BACKUP, join(runtime, '.plugin-backup.prev')]
  for (const root of roots) {
    if (!existsSync(root)) continue
    const stack = [root]
    while (stack.length) {
      const dir = stack.pop()
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) stack.push(p)
        else if (e.name === MARK) return p
      }
    }
  }
  return null
}
const found = markerSomewhere()
const prevExists = existsSync(join(runtime, '.plugin-backup.prev'))
console.log(`  manager exit=${code}`)
console.log(`  标记文件仍在: ${found ? `是（${found.replace(tmp, '<tmp>')}）` : '否 ❌'}`)
console.log(`  .plugin-backup.prev 存在: ${prevExists}`)
let failures = 0
const check = (name, cond) => { if (cond) console.log(`  ok   ${name}`); else { console.error(`  FAIL ${name}`); failures++ } }
check('安装失败后，"只存在于备份里"的标记**没有丢失**', found !== null) // 覆盖：启动恢复（recoverFrom）+ 只挪不删
check('旧备份被保留为 .plugin-backup.prev（而不是被删）', prevExists)
console.log('  --- manager 输出（尾部 12 行）---')
for (const l of out.split('\n').filter(Boolean).slice(-12)) console.log('    ' + l.slice(0, 220))
rmSync(tmp, { recursive: true, force: true })
if (failures) { console.error(`FAILED: ${failures} 项`); process.exit(1) }
console.log('PASS: 插件备份保留（安装失败路径）')
