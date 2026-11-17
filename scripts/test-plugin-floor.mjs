#!/usr/bin/env node
// 运行时地板守卫（scripts/plugin-floor.mjs）的单测 + 语义自检 + manager 接线 E2E。
//
// 负向对照（必须变红）：
//   ① 让 satisfies 忽略 prerelease 排序
//   ② 让守卫在"未声明地板"时也隔离
//   ③ 让守卫隔离 @deepseek-ai/*
//   ④ 把 caret 上界写回"永远 bump major"
//   ⑤ 把 patch overlay 的摘除改成**整份丢弃** ⇒ 其它 overlay 条目（ui-sidebar-browser 覆盖 /
//      同块里的第二个 insert 项）跟着丢失 ⇒ 本套件必须红
//   ⑥ 把 manager 侧新增的守卫输入去掉（plugins: []）⇒ dsh 0.1.5 下 patch 注入的插件不再被拦
//      （假 dsh 收到的 overlay 里仍有它）⇒ E2E 必须红
// ⑤⑥ 由 scripts/test-controls.mjs 在干净树上注入并断言"注入必红、还原必绿"。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectDshFloors, compare, parsePatchOverlay, planPatchPluginGuard, planPluginGuard, satisfies, selfTest, stripPatchPlugins,
} from './plugin-floor.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OVERLAY = join(repoRoot, 'src-tauri', 'resources', 'patch', 'dsh-desktop.patch.yml')
const PLUGIN_SRC = join(repoRoot, 'src-tauri', 'resources', 'plugin', '@dsh-desktop', 'client-notifications')
const MANAGER = join(repoRoot, 'scripts', 'server-manager.mjs')
const PLUGIN_NAME = '@dsh-desktop/client-notifications'

let failures = 0
const check = (label, fn) => {
  try { fn(); console.log(`ok   ${label}`) } catch (e) { failures += 1; console.error(`FAIL ${label}\n     ${e.message}`) }
}

check('semver 自检（9 条，含 prerelease/caret 0.x/tilde/区间）', () => {
  const bad = selfTest().filter((r) => !r.ok)
  assert.equal(bad.length, 0, `自检失败：${JSON.stringify(bad)}`)
})

check('compare 的 prerelease 排序', () => {
  assert.equal(compare('0.1.7-rc.2', '0.1.7-rc.1'), 1)
  assert.equal(compare('0.1.7-rc.2', '0.1.7'), -1)
  assert.equal(compare('0.1.7', '0.1.7-rc.2'), 1, '反向：正式版大于同版本 prerelease')
  assert.equal(compare('0.1.7-alpha.1', '0.1.7-rc.1'), -1)
  assert.equal(compare('0.1.7', '0.1.7'), 0)
  assert.equal(satisfies('0.1.7', '>=0.1.7-rc.1'), true, '正式版满足 rc 地板')
})

check('collectDshFloors 只取 dsh 平台包', () => {
  const floors = collectDshFloors({
    peerDependencies: { '@deepseek-ai/dsh-client-ui-settings': '>=0.1.7-rc.1', react: '^18.2.0' },
  })
  assert.deepEqual(floors, [{ name: '@deepseek-ai/dsh-client-ui-settings', range: '>=0.1.7-rc.1' }])
  assert.deepEqual(collectDshFloors({}), [])
})

check('已装 dsh 低于插件地板 → skipInstall + quarantine', () => {
  const plan = planPluginGuard({
    installedDsh: '0.1.6-alpha.1',
    bundled: [{ name: 'dsh-model-reasoning', version: '0.2.6', pkgJson: { peerDependencies: { '@deepseek-ai/dsh-client-ui-settings': '>=0.1.7-rc.1' } } }],
    enabled: ['@deepseek-ai/dsh-base', 'dsh-model-reasoning'],
  })
  assert.deepEqual(plan.skipInstall.map((x) => x.name), ['dsh-model-reasoning'])
  assert.deepEqual(plan.quarantine.map((x) => x.name), ['dsh-model-reasoning'])
  assert.equal(plan.quarantine[0].floor, '>=0.1.7-rc.1')
})

check('已装 dsh 满足地板 → 什么都不做（不误伤）', () => {
  const plan = planPluginGuard({
    installedDsh: '0.1.7-rc.2',
    bundled: [{ name: 'dsh-model-reasoning', version: '0.2.6', pkgJson: { peerDependencies: { '@deepseek-ai/dsh-client-ui-settings': '>=0.1.7-rc.1' } } }],
    enabled: ['@deepseek-ai/dsh-base', 'dsh-model-reasoning'],
  })
  assert.deepEqual(plan.skipInstall, [])
  assert.deepEqual(plan.quarantine, [])
})

check('未声明地板的插件不动（只有警告）；@deepseek-ai/* 永不隔离', () => {
  const plan = planPluginGuard({
    installedDsh: '0.1.6-alpha.1',
    bundled: [
      { name: 'dsh-kanban', version: '0.2.8', pkgJson: { peerDependencies: { react: '^18.2.0' } } },
      { name: '@deepseek-ai/dsh-web-app', version: '0.1.7-rc.2', pkgJson: {} },
    ],
    enabled: ['dsh-kanban', '@deepseek-ai/dsh-web-app'],
  })
  assert.deepEqual(plan.skipInstall, [], '未声明地板 → 不跳过安装')
  assert.deepEqual(plan.quarantine, [], '@deepseek-ai/* 与未声明地板者都不隔离')
  assert.equal(plan.warnings.length, 1)
  assert.match(plan.warnings[0], /dsh-kanban 未声明 dsh 地板/)
})

check('dsh 未安装/版本不可解析 → 不做任何判断', () => {
  for (const installedDsh of [null, '', 'not-a-version']) {
    const plan = planPluginGuard({
      installedDsh,
      bundled: [{ name: 'dsh-model-reasoning', version: '0.2.6', pkgJson: { peerDependencies: { '@deepseek-ai/dsh-client-ui-settings': '>=0.1.7-rc.1' } } }],
      enabled: ['dsh-model-reasoning'],
    })
    assert.deepEqual(plan.skipInstall, [])
    assert.deepEqual(plan.quarantine, [])
    assert.equal(plan.warnings.length, 1)
  }
})

check('用户自装插件（未随壳分发）不隔离', () => {
  const plan = planPluginGuard({ installedDsh: '0.1.6-alpha.1', bundled: [], enabled: ['someone-elses-plugin'] })
  assert.deepEqual(plan.quarantine, [])
})

// ── --patch overlay（注入插件的地板守卫输入） ───────────────────────────────
check('真实 overlay：只有带 name 的 insert 项算"注入插件"，覆盖条目不算', () => {
  const { blocks, insertPlugins } = parsePatchOverlay(readFileSync(OVERLAY, 'utf8'))
  assert.deepEqual(insertPlugins.map((p) => p.name), [PLUGIN_NAME])
  assert.equal(insertPlugins[0].id, 'desktop-notifications')
  assert.deepEqual(blocks.map((b) => b.kind), ['insert', 'override'])
  assert.equal(blocks[1].id, 'ui-sidebar-browser')
})

check('摘一个 insert 项：同块其它 insert 项、覆盖条目、注释都逐字保留', () => {
  const synthetic = [
    '# 头注释',
    '- insert:',
    '    - id: a',
    "      name: '@dsh-desktop/a'",
    '    - id: b',
    "      name: '@dsh-desktop/b'",
    '# 段尾注释',
    '- id: ui-sidebar-browser',
    '  disabled: false',
    '',
  ].join('\n')
  const out = stripPatchPlugins(synthetic, ['@dsh-desktop/a'])
  assert.deepEqual(out.removed, ['@dsh-desktop/a'])
  assert.deepEqual(out.missing, [])
  assert.deepEqual(out.residual, [])
  assert.match(out.text, /- id: b\n {6}name: '@dsh-desktop\/b'/, '同块的另一个 insert 项必须保留')
  assert.match(out.text, /^- id: ui-sidebar-browser$/m, '覆盖条目必须保留')
  assert.match(out.text, /^ {2}disabled: false$/m)
  assert.match(out.text, /# 头注释/, '文件头注释必须保留')
  assert.match(out.text, /# 段尾注释/, '段尾注释必须保留')
})

check('摘掉唯一 insert 项：连空的 `- insert:` 一起删，覆盖条目与换行结尾仍在', () => {
  const text = readFileSync(OVERLAY, 'utf8')
  const out = stripPatchPlugins(text, [PLUGIN_NAME])
  assert.deepEqual(out.removed, [PLUGIN_NAME])
  assert.deepEqual(out.residual, [])
  assert.ok(!/- insert:/.test(out.text), '空的 insert 块必须整块删除（YAML 里 null 与"没有这条"语义不同）')
  assert.ok(!out.text.includes(PLUGIN_NAME), '插件名不得残留')
  assert.ok(!out.text.includes('desktop-notifications'), '目标 id 行也不得残留')
  assert.match(out.text, /^- id: ui-sidebar-browser$/m)
  assert.match(out.text, /^ {2}disabled: false$/m)
  assert.ok(out.text.endsWith('\n'), '必须以换行结尾（否则后续追加会粘成一行，见 test-patch-targets）')
  assert.deepEqual(parsePatchOverlay(out.text).insertPlugins, [])
})

check('overlay 形状超出支持子集 ⇒ 不静默丢弃：missing 非空、原文一个字节都不改', () => {
  const inline = '- insert: [{ id: x, name: "@dsh-desktop/inline" }]\n- id: ui-sidebar-browser\n  disabled: false\n'
  const out = stripPatchPlugins(inline, ['@dsh-desktop/inline'])
  assert.deepEqual(out.removed, [], '摘不掉就是摘不掉（不能假装成功）')
  assert.deepEqual(out.missing, ['@dsh-desktop/inline'])
  assert.equal(out.text, inline, '摘不掉时必须原样返回（调用方据此 fail-open，绝不整份丢弃）')
})

check('CRLF overlay 同样能解析与摘除', () => {
  const crlf = '- insert:\r\n    - id: x\r\n      name: "@dsh-desktop/client-notifications"\r\n- id: ui-sidebar-browser\r\n  disabled: false\r\n'
  assert.deepEqual(parsePatchOverlay(crlf).insertPlugins.map((p) => p.name), ['@dsh-desktop/client-notifications'])
  const out = stripPatchPlugins(crlf, ['@dsh-desktop/client-notifications'])
  assert.deepEqual(out.residual, [])
  assert.match(out.text, /^- id: ui-sidebar-browser$/m)
  assert.ok(!out.text.includes('insert'), 'CRLF 输入摘除后不得留下 insert 块')
})

check('patch 插件计划：0.1.5 拦 / 满足地板放 / 缺清单只告警 / @deepseek-ai 与未知 dsh 不动', () => {
  const pkgJson = JSON.parse(readFileSync(join(PLUGIN_SRC, 'package.json'), 'utf8'))
  const plugins = [{ name: PLUGIN_NAME, version: pkgJson.version, pkgJson }]
  const old = planPatchPluginGuard({ installedDsh: '0.1.5', plugins })
  assert.deepEqual(old.drop.map((p) => p.name), [PLUGIN_NAME], '0.1.5 必须判拦截')
  assert.equal(old.drop[0].floor, '>=0.1.6-alpha.2')
  assert.match(old.drop[0].requires, /^@deepseek-ai\/dsh-client-ui-(session|workspace)$/)

  const ok = planPatchPluginGuard({ installedDsh: '0.2.2-rc.1', plugins })
  assert.deepEqual(ok.drop, [], '地板满足 ⇒ 不摘（不误伤）')

  const noMeta = planPatchPluginGuard({ installedDsh: '0.1.5', plugins: [{ name: PLUGIN_NAME, pkgJson: null }] })
  assert.deepEqual(noMeta.drop, [], '没有包清单 = 没有证据')
  assert.equal(noMeta.warnings.length, 1)
  assert.match(noMeta.warnings[0], /找不到 package\.json/)

  const dshOwn = planPatchPluginGuard({
    installedDsh: '0.1.5',
    plugins: [{ name: '@deepseek-ai/dsh-web-app', pkgJson: { peerDependencies: { '@deepseek-ai/dsh-client-ui-settings': '>=0.1.7-rc.1' } } }],
  })
  assert.deepEqual(dshOwn.drop, [], '@deepseek-ai/* 永不从 overlay 摘')

  const unknown = planPatchPluginGuard({ installedDsh: null, plugins })
  assert.deepEqual(unknown.drop, [], 'dsh 版本未知 ⇒ 不判断')
  assert.equal(unknown.warnings.length, 1)
})

// ── manager 接线 E2E：假 dsh 记录它**实际收到**的 overlay ────────────────────
// 这一层是必需的：只测纯函数的话，"守卫没被 manager 调用"（= 本缺陷的原状）会全绿。
const work = mkdtempSync(join(tmpdir(), 'dsh-floor-'))
const runtime = join(work, 'runtime')
const resources = join(work, 'resources')
const probe = join(work, 'patch.probe.json')
const guardedCopy = join(runtime, 'plugin-floor', 'dsh-desktop.patch.yml')
const readLog = () => (existsSync(join(runtime, 'manager.log')) ? readFileSync(join(runtime, 'manager.log'), 'utf8') : '')

function writeFakeDsh(version) {
  const dir = join(runtime, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }, null, 2))
  writeFileSync(join(dir, 'lib', 'bin.js'), [
    "import { readFileSync, writeFileSync } from 'node:fs'",
    'const argv = process.argv.slice(2)',
    "const i = argv.indexOf('--patch')",
    'const patch = i >= 0 ? argv[i + 1] : null',
    'const probe = process.env.DSH_TEST_PATCH_PROBE',
    "if (probe) writeFileSync(probe, JSON.stringify({ argv, patch, text: patch ? readFileSync(patch, 'utf8') : null }))",
    "process.stdout.write(JSON.stringify({ t: 'url', url: 'http://127.0.0.1:19999' }) + '\\n')",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'))
}

const stopManager = (child) => new Promise((done) => {
  if (child.exitCode !== null) return done()
  child.once('exit', () => done())
  child.kill('SIGTERM')
  setTimeout(() => { try { child.kill('SIGKILL') } catch { /* fail-open-ok: 测试夹具清理，进程已退出 */ } done() }, 5000).unref()
})

/** 起 manager，等它报出 url（假 dsh 已把收到的 overlay 写进 probe），返回事件流。 */
async function runManager(label, timeoutMs = 20_000) {
  const events = []
  const child = spawn(process.execPath, [
    MANAGER,
    '--runtime-dir', runtime,
    '--resource-dir', resources,
    '--patch', OVERLAY,
    '--cwd', work,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DSH_DESKTOP_NO_UPDATE: '1', DSH_TEST_PATCH_PROBE: probe },
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', (b) => { stderr += String(b) })
  await new Promise((res, rej) => {
    let buf = ''
    const timer = setTimeout(() => rej(new Error(`${label}: 等不到 url 事件\nstderr: ${stderr}\nlog: ${readLog().slice(-1500)}`)), timeoutMs)
    child.stdout.on('data', (b) => {
      buf += String(b)
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          const ev = JSON.parse(line)
          events.push(ev)
          if (ev.t === 'url') { clearTimeout(timer); res(ev) }
        } catch { /* 非 JSON 噪声（子进程直接打到 stdout 的内容） */ }
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      rej(new Error(`${label}: manager 在报出 url 前退出（code ${code}）\nstderr: ${stderr}\nlog: ${readLog().slice(-1500)}`))
    })
  })
  return { child, events }
}

try {
  // 假 resources：只需要客户端插件源（ensurePlugin 会把它拷进 runtime）。
  mkdirSync(join(resources, 'plugin', '@dsh-desktop'), { recursive: true })
  cpSync(PLUGIN_SRC, join(resources, 'plugin', '@dsh-desktop', 'client-notifications'), { recursive: true })

  // ① dsh 0.1.5（低于插件地板；devMode 冻结地板自动升级，模拟"锁在旧版"的用户）
  writeFakeDsh('0.1.5')
  mkdirSync(runtime, { recursive: true })
  writeFileSync(join(runtime, 'dsh.json'), JSON.stringify({ devMode: true }))
  const first = await runManager('dsh 0.1.5')
  await stopManager(first.child)

  assert.ok(existsSync(probe), '假 dsh 必须留下它收到的 overlay（probe 文件）')
  const probe1 = JSON.parse(readFileSync(probe, 'utf8'))
  assert.ok(typeof probe1.text === 'string' && probe1.text.length > 0, '假 dsh 收到的 overlay 内容不能为空')
  assert.ok(!probe1.text.includes(PLUGIN_NAME), `0.1.5：注入插件必须从 overlay 摘掉（否则 dsh web boot fail-closed ⇒ 白屏）；实际收到：\n${probe1.text}`)
  assert.ok(!probe1.text.includes('desktop-notifications'), '目标 id 行也不得留下')
  assert.match(probe1.text, /^- id: ui-sidebar-browser$/m, '其它 overlay 条目（浏览器页覆盖）必须原样保留')
  assert.match(probe1.text, /^ {2}disabled: false$/m)
  assert.equal(probe1.patch, guardedCopy, '摘过之后必须交给 dsh 受控副本（<runtime>/plugin-floor/），不能改仓库里的原 overlay')

  const log1 = readLog()
  assert.match(
    log1,
    /plugin-floor: 隔离 @dsh-desktop\/client-notifications@[^ ]+（要求 @deepseek-ai\/dsh-client-ui-(session|workspace) ">=0\.1\.6-alpha\.2"，已装 dsh 0\.1\.5 不满足）—— 已从 --patch 注入清单摘掉/,
    `manager.log 必须给出可读的隔离原因；实际：\n${log1.slice(-2000)}`,
  )
  assert.ok(
    first.events.some((e) => e.t === 'log' && /plugin-floor: 隔离 @dsh-desktop\/client-notifications/.test(e.line)),
    '隔离原因必须作为 {t:"log"} 事件上报（启动页日志区 = 用户可见面）',
  )
  const manifest1 = JSON.parse(readFileSync(join(runtime, 'dsh.json'), 'utf8'))
  assert.equal(manifest1.quarantinedPatchPlugins?.[0]?.name, PLUGIN_NAME, 'dsh.json 必须记账（诊断/排查依赖它）')
  assert.equal(manifest1.quarantinedPatchPlugins[0].source, 'patch')
  assert.equal(manifest1.quarantinedPatchPlugins[0].floor, '>=0.1.6-alpha.2')
  assert.equal(manifest1.devMode, true, '记账不得弄丢 manifest 的其它字段')

  // ② 同一个 runtime 升到满足地板的 dsh（0.2.2-rc.1）⇒ 注入必须自动恢复
  writeFakeDsh('0.2.2-rc.1')
  rmSync(probe, { force: true })
  const logOffset = readLog().length
  const second = await runManager('dsh 0.2.2-rc.1')
  await stopManager(second.child)
  const probe2 = JSON.parse(readFileSync(probe, 'utf8'))
  assert.ok(probe2.text.includes(PLUGIN_NAME), '地板满足后必须恢复注入（守卫每次拉起 dsh 都重算）')
  assert.equal(probe2.patch, OVERLAY, '没有插件要被摘 ⇒ 直接用原 overlay，不产生受控副本')
  assert.ok(!existsSync(guardedCopy), '上一轮留下的受控副本必须清掉（否则下次误用旧名单）')
  const log2 = readLog().slice(logOffset)
  assert.ok(!/plugin-floor: 隔离/.test(log2), `地板满足后不得再报隔离；实际新增日志：\n${log2}`)
  const manifest2 = JSON.parse(readFileSync(join(runtime, 'dsh.json'), 'utf8'))
  assert.deepEqual(manifest2.quarantinedPatchPlugins, [], '恢复后记账必须清空（不留假隔离名单）')
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures > 0) { console.error(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: 运行时地板守卫（semver 自检 + 计划四态 + patch overlay 摘除 + manager 接线 E2E）')
