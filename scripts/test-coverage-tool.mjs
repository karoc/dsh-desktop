#!/usr/bin/env node
// 覆盖率工具的**自检门禁**（npm test 第 19 套）：测量工具本身必须先证明"会失败"，否则数字不可信。
// 2026-10-07 实录：初版把所有 count>0 区间做并集 ⇒ 每个文件都报 100%（V8 的根区间覆盖整个文件）；
// 是"嵌套区间"夹具把这条错误钉出来的。数量口径见 scripts/coverage-baseline.mjs。
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
try {
  const out = execFileSync(process.execPath, ['scripts/coverage-baseline.mjs', '--self-test'], { cwd: ROOT, encoding: 'utf8' })
  const last = out.trim().split('\n').pop()
  if (!/^PASS: 覆盖率工具自检（\d+\/\d+）$/.test(last)) throw new Error(`自检输出不符合预期: ${last}`)
  console.log(`PASS: 覆盖率工具自检门禁（${last.replace(/^PASS: /, '')}）`)
} catch (err) {
  console.error('FAIL: 覆盖率工具自检未通过（数字不可信）')
  console.error(String(err.stdout || err.message).trim().split('\n').slice(-6).join('\n'))
  process.exit(1)
}
