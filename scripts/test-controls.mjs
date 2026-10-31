#!/usr/bin/env node
// 门禁可信度对照（2026-10-08 起，npm test 第 20 套）：**注入真实缺陷 ⇒ 对应套件必须变红；还原 ⇒ 必须变绿**。
//
// 为什么需要：覆盖率只说明"跑过多少行"，不说明"断言是否真的会失败"。恒真的门禁比没有门禁更糟（给出虚假安心）。
// 每个对照都刻意选择**改语义**而不是"改某个精确字符串"，避免夹具与被测文本耦合：
//   ① 篡改资源副本        ⇒ test-copy-consistency 必须红（它存在的意义就是两份一致）
//   ② 篡改 package.json 版本 ⇒ test-manifest-consistency 必须红（四版本一致是它的核心断言）
//   ③ 在 manager 注入一个空 catch ⇒ test-silent-failures 必须红（这正是该门禁声称能抓的缺陷）
//   ④ 让 tree-guard 忽略未提交改动 ⇒ test-tree-guard 必须红（dirty 判定是它的一半判据）
//   ⑤ 让 cmpVersion 把正式版判成与同号预发布相等 ⇒ test-version-compare-parity 必须红（审计 P0-1 的核心）
//   ⑥ 关掉 logrotate 的 @HOME@ 残留检查 ⇒ test-install-logrotate 必须红（该检查就是事故形态的防线）
//
// 约定（2026-10-31 起）：新增/修改一个"守行为"的门禁，就同时给这里加一条注入对照；确实不能加（如纯静态
// 文档门禁），在 PR 里写明理由。没有这一条，门禁本身的可失败性就没人验证。
//
// 本地跑前先 `node scripts/sync-cargo-lock-version.mjs`（或在干净 checkout 上跑）：② 的"还原后必须绿"
// 会读 manifest 门禁，而 main 上 Cargo.lock 在发布后本来就是旧的（CI 会先 sync，本地不 sync 会假红）。
//
// 安全约束：**只在干净工作树上运行**（否则拒绝）；每个对照组用 try/finally 还原，并在还原后验证"变绿"。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sh = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
// 对照只会改这些路径；脏树检查必须**只**看它们。记录层（KANBAN.json / .agents）几乎永远是脏的，
// 若把它算进来，本机会永远 SKIP（2026-10-31 实测：提交后仍因看板改动跳过）—— 那等于本地从没跑过对照。
const MUTATION_PATHS = ['scripts', 'src-tauri/resources', 'package.json']
const node = (script) => {
  try {
    execFileSync(process.execPath, [join(ROOT, script)], { cwd: ROOT, stdio: 'pipe' })
    return 0
  } catch (err) { return err.status ?? 1 }
}

// 工作树有未提交改动 ⇒ **显式跳过**（不是失败）：开发中工作树本来就是脏的，若在这里判失败，
// 整条 `npm test` 会在"正在改代码"时必然变红 —— 那是假信号（2026-10-08 我自己就被它误导过一次）。
// 对照只在干净树上才有意义，CI 的 checkout 永远是干净的 ⇒ 由 CI 保证它真的跑。
// 跳过必须是**响亮**的，不能与"对照通过"混淆。
if (sh(['status', '--porcelain', '--untracked-files=no', '--', ...MUTATION_PATHS]) !== '') {
  console.log('SKIP: 对照可触达的路径（' + MUTATION_PATHS.join('、') + '）有未提交改动 ⇒ 门禁可信度对照跳过' +
    '（这些改动会被注入/还原覆盖；记录层 KANBAN.json / .agents 不计入）')
  process.exit(0)
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
  {
    name: 'tree-guard 忽略未提交改动 ⇒ 守卫门禁必须红',
    target: 'scripts/lib/tree-guard.mjs',
    mutate: (s) => s.replace('result.drifted = result.diffFiles.length > 0 || result.dirtyFiles.length > 0',
      'result.drifted = result.diffFiles.length > 0 // mutation-control: 故意忽略 dirtyFiles'),
    suite: 'scripts/test-tree-guard.mjs',
  },
  {
    name: '版本比较把正式版判成与同号预发布相等 ⇒ parity 必须红',
    target: 'scripts/lib/version-compare.mjs',
    mutate: (s) => s.replace('  if (x.length === 0) return 1', '  if (x.length === 0) return 0 // mutation-control'),
    suite: 'scripts/test-version-compare-parity.mjs',
  },
  {
    name: '关掉 logrotate 安装器的 @HOME@ 残留检查 ⇒ 安装器门禁必须红',
    target: 'scripts/install-logrotate.mjs',
    mutate: (s) => s.replace('  if (content.includes(PLACEHOLDER)) {', '  if (false) { // mutation-control'),
    suite: 'scripts/test-install-logrotate.mjs',
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
