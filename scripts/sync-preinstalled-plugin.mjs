#!/usr/bin/env node
// 预装插件同步器：把 npm 上**已发布**的插件版本按壳的打包约定装进
// `plugins/preinstalled/<dir>`，并（可选）重跑资源同步。
//
// 为什么要有脚本：这条流程此前是文档里的手工步骤，且踩过两次坑 ——
//   ① README 的双语链接行格式因仓而异（管道式 / 粗体·式 / 根本没有），写死格式会
//      留下指向不随包分发的 README.zh.md 的**坏链**；
//   ② 手工拷贝容易漏文件（少一个 `lib/` 文件 = 装到用户机器上才炸）。
// 脚本把约定固化成代码，并提供**演练判据**：对一个"已发布且已是最新"的版本重新
// 同步，结果必须是零 diff（有 diff 就说明约定没对齐）。
//
// 用法：
//   node scripts/sync-preinstalled-plugin.mjs dsh-model-reasoning            # 同步 npm latest
//   node scripts/sync-preinstalled-plugin.mjs dsh-model-reasoning 0.2.6      # 指定版本
//   node scripts/sync-preinstalled-plugin.mjs dsh-model-reasoning 0.2.4 --check   # 只比对不落盘（演练）
//   … 加 --no-resources 跳过 sync-resources.mjs
//
// 随包文件约定（与现有壳内拷贝一致）：
//   收：package.json、cordis.patch.yml、lib/**（不含 .map）、LICENSE、README.md（裁剪后）
//   不收：README.zh.md、CHANGELOG.md、CONTRIBUTING.md、src/、docs/、*.map、图片
// 被丢弃的文件会逐条打印，避免"精简约定砍掉运行时资产"（技能里的历史事故）。
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const tarballAt = argv.indexOf('--tarball')
// --tarball 的**值**不是位置参数（早期版本把它当成了版本号 → 校验失败）
const positional = argv.filter((a, i) => !a.startsWith('--') && !(tarballAt >= 0 && i === tarballAt + 1))
const [pkgArg, versionArg] = positional
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const checkOnly = flags.has('--check')
if (!pkgArg) {
  console.error('用法：node scripts/sync-preinstalled-plugin.mjs <npm 包名> [版本] [--check] [--no-resources]')
  process.exit(2)
}

const log = (msg) => console.log(msg)
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1) }

// ── 1. 解析目标版本与 tarball ────────────────────────────────────────────────
// --tarball <路径|URL>：离线/索引延迟时直接给 tarball（发布前预演也用它）
const tarballOverride = tarballAt >= 0 ? argv[tarballAt + 1] : null
let version = versionArg ?? null
let tarball = null
if (tarballOverride) {
  tarball = tarballOverride
  log(`tarball（跳过 registry）：${tarballOverride}`)
} else {
  const metaUrl = `https://registry.npmjs.org/${pkgArg.replace('/', '%2f')}`
  log(`registry: ${metaUrl}`)
  const metaRes = await fetch(metaUrl)
  if (!metaRes.ok) fail(`取 registry 元数据失败：HTTP ${metaRes.status}`)
  const meta = await metaRes.json()
  version = version ?? meta['dist-tags']?.latest
  if (!version) fail('registry 里没有 dist-tags.latest，请显式给版本')
  const vmeta = meta.versions?.[version]
  if (!vmeta) fail(`registry 里没有版本 ${version}（已发布：${Object.keys(meta.versions ?? {}).slice(-5).join(', ')}）`)
  tarball = vmeta.dist?.tarball
  if (!tarball) fail(`版本 ${version} 缺少 dist.tarball`)
  log(`目标：${pkgArg}@${version}`)
}

// ── 2. 下载并解开 tarball ───────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'dsh-preinstalled-'))
const tgz = join(work, 'pkg.tgz')
if (/^https?:/.test(tarball)) {
  const bin = await (await fetch(tarball)).arrayBuffer()
  writeFileSync(tgz, Buffer.from(bin))
} else {
  cpSync(resolve(tarball), tgz)
}
const unpacked = join(work, 'unpacked')
mkdirSync(unpacked, { recursive: true })
try {
  execFileSync('tar', ['-xzf', tgz, '-C', unpacked], { stdio: 'pipe' })
} catch (err) {
  fail(`解包失败（需要系统 tar）：${err.message}`)
}
const pkgRoot = join(unpacked, 'package')
if (!existsSync(pkgRoot)) fail('tarball 结构异常：没有 package/ 目录')
const published = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
log(`包内声明的版本：${published.name}@${published.version}`)
if (version && published.version !== version) fail(`包内版本(${published.version})与目标(${version})不一致`)
version = published.version
if (pkgArg && published.name !== pkgArg) fail(`包内名字(${published.name})与参数(${pkgArg})不一致`)

// ── 3. 按壳约定挑选文件 ─────────────────────────────────────────────────────
// 收哪些文件：以**包作者在 tarball 的 package.json 里声明的 `files`** 为准（那是"运行时
// 需要什么"的权威定义），再减去壳的精简 denylist。registry 元数据里的 files 不可靠
// （abbreviated packument 会省略它），必须读 tarball 内的 package.json。
// 无 files 声明时按"全收 - denylist"处理。
const DENY = [
  /^README\.zh\.md$/, /^CHANGELOG\.md$/, /^CONTRIBUTING\.md$/, /\.map$/, /^docs\//,
]
const escapeRx = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const toMatcher = (entry) => {
  const e = String(entry).replace(/^\.\//, '').replace(/\/$/, '')
  if (e.includes('*')) {
    const rx = new RegExp(`^${e.split('*').map(escapeRx).join('[^/]*')}$`)
    return (f) => rx.test(f)
  }
  return (f) => f === e || f.startsWith(`${e}/`)
}
const declaredFiles = Array.isArray(published.files) && published.files.length > 0 ? published.files : null
const allowedByAuthor = declaredFiles ? declaredFiles.map(toMatcher) : null
if (declaredFiles) log(`包作者声明的 files：${declaredFiles.join(', ')}`)
else log('包内没有 files 声明 → 按"全收 - denylist"处理')

const walk = (dir, base = dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, base, out)
    else out.push(relative(base, full))
  }
  return out
}
const allFiles = walk(pkgRoot)
const keep = []
const skipped = []
for (const rel of allFiles) {
  if (DENY.some((rx) => rx.test(rel))) { skipped.push(rel); continue }
  // npm 无视 files 白名单**总是**打包的隐式文件（package.json / README / LICENSE）
  const implicit = ['package.json', 'README.md', 'LICENSE', 'LICENCE'].includes(rel)
  if (!implicit && allowedByAuthor && !allowedByAuthor.some((m) => m(rel))) { skipped.push(rel); continue }
  keep.push(rel)
}
// 必需：package.json + 至少一个半区（client / host）。cordis.patch.yml 只警告 ——
// host-only 插件（如 @karoc/dsh-smoothly-opencode-session）也走同一套拷贝约定。
if (!keep.includes('package.json')) fail('包内缺少 package.json')
const halves = ['lib/client.js', 'lib/index.js'].filter((f) => keep.includes(f))
if (halves.length === 0) fail('包内既没有 lib/client.js 也没有 lib/index.js（无法识别为插件）')
if (!keep.includes('cordis.patch.yml')) log('⚠️  包内没有 cordis.patch.yml（壳的 bundle 发现依赖它；确认这是预期）')
log(`收录 ${keep.length} 个文件（半区：${halves.join(' + ')}）`)
if (skipped.length > 0) log(`按约定丢弃 ${skipped.length} 个：${skipped.join(', ')}`)

// README 裁剪：删掉**含 README.zh.md 的整行**及其后的空行（格式因仓而异，不能写死）
const pruneReadme = (text) => {
  const lines = text.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes('README.zh.md')) {
      // 约定（技能 §3）：删掉整行 + 紧随其后的空行；**保留**它前面的空行，
      // 否则标题与下一节会贴在一起（演练时正是这处 1 行差异抓出来的）。
      if (lines[i + 1] !== undefined && lines[i + 1].trim() === '') i += 1
      continue
    }
    out.push(lines[i])
  }
  return out.join('\n')
}

// ── 4. 目标目录（按包真名匹配现有目录，否则由包名派生）─────────────────────
const preRoot = join(root, 'plugins', 'preinstalled')
const dirs = readdirSync(preRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
let targetDir = null
for (const d of dirs) {
  const p = join(preRoot, d.name, 'package.json')
  if (!existsSync(p)) continue
  if (JSON.parse(readFileSync(p, 'utf8')).name === published.name) { targetDir = join(preRoot, d.name); break }
}
if (!targetDir) {
  const derived = published.name.replace(/^@[^/]+\//, '')
  targetDir = join(preRoot, derived)
  log(`未找到现有目录，将新建：plugins/preinstalled/${derived}`)
}
log(`目标目录：${relative(root, targetDir)}`)

// ── 5. 比对（演练判据：零 diff）────────────────────────────────────────────
const stage = join(work, 'stage')
mkdirSync(stage, { recursive: true })
for (const rel of keep) {
  const dest = join(stage, rel)
  mkdirSync(dirname(dest), { recursive: true })
  if (rel === 'README.md') {
    const pruned = pruneReadme(readFileSync(join(pkgRoot, rel), 'utf8'))
    if (pruned.includes('README.zh.md')) fail(`README 裁剪后仍含 README.zh.md 链接（坏链）`)
    writeFileSync(dest, pruned)
  } else {
    cpSync(join(pkgRoot, rel), dest)
  }
}
const hashOf = (f) => readFileSync(f).toString('base64')
const stageFiles = walk(stage)
const existingFiles = existsSync(targetDir) ? walk(targetDir) : []
const added = stageFiles.filter((f) => !existingFiles.includes(f))
const removed = existingFiles.filter((f) => !stageFiles.includes(f))
const changed = stageFiles.filter((f) => existingFiles.includes(f) && hashOf(join(stage, f)) !== hashOf(join(targetDir, f)))
const unchanged = stageFiles.filter((f) => existingFiles.includes(f) && !changed.includes(f))
log(`比对：新增 ${added.length} / 变更 ${changed.length} / 删除 ${removed.length} / 不变 ${unchanged.length}`)
for (const f of [...added.map((x) => `+ ${x}`), ...changed.map((x) => `~ ${x}`), ...removed.map((x) => `- ${x}`)]) log(`  ${f}`)

if (checkOnly) {
  const diff = added.length + changed.length + removed.length
  if (diff === 0) log('\nCHECK PASS — 零 diff（约定与已发布版本对齐）')
  else { log(`\nCHECK FAIL — ${diff} 处差异（演练判据要求零 diff）`); process.exit(1) }
  rmSync(work, { recursive: true, force: true })
  process.exit(0)
}

// ── 6. 落盘 + 资源同步 ─────────────────────────────────────────────────────
rmSync(targetDir, { recursive: true, force: true })
mkdirSync(dirname(targetDir), { recursive: true })
cpSync(stage, targetDir, { recursive: true })
log(`已写入 ${relative(root, targetDir)}（${published.name}@${published.version}）`)
if (!flags.has('--no-resources')) {
  execFileSync(process.execPath, [join(root, 'scripts', 'sync-resources.mjs')], { stdio: 'inherit' })
}
log('\nDONE — 下一步：node scripts/test-copy-consistency.mjs 与 node scripts/test-plugin-dsh-compat.mjs（后者应已转绿）')
rmSync(work, { recursive: true, force: true })
