#!/usr/bin/env node
// Sync runtime resources into src-tauri/resources/ so tauri can bundle them:
//   scripts/server-manager.mjs        -> resources/manager/server-manager.mjs
//   src-tauri/resources/patch/*       -> already in place
//   plugins/dsh-client-notifications  -> resources/plugin/@dsh-desktop/client-notifications
//   plugins/preinstalled/<pkg>        -> resources/preinstalled/<pkg> (preinstalled bundles)
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const res = join(root, 'src-tauri', 'resources')

mkdirSync(join(res, 'manager'), { recursive: true })
// manager 的**相对导入闭包**整体拷贝：以前这里硬编码两个文件名，新增 helper 模块
// 时源码侧全绿、打包版却在启动 1 秒内 ERR_MODULE_NOT_FOUND 退出（2026-09-25 dev
// 实机事故：upgrade-marker.mjs 没被带上）。改为从入口文件出发递归解析
// `from './x.mjs'`，这样任何新模块都自动随包。
const managerModules = new Set()
const collectManagerModules = (file) => {
  if (managerModules.has(file)) return
  managerModules.add(file)
  const text = readFileSync(join(root, 'scripts', file), 'utf8')
  for (const m of text.matchAll(/from\s+'\.\/([^']+\.mjs)'/g)) collectManagerModules(m[1])
}
collectManagerModules('server-manager.mjs')
for (const name of managerModules) {
  cpSync(join(root, 'scripts', name), join(res, 'manager', name), { force: true })
}
console.log(`manager modules synced: ${[...managerModules].sort().join(', ')}`)

// Desktop client plugins: plugins/<dir> -> resources/plugin/@dsh-desktop/<rel>
// where <rel> comes from the package's real name (source dirs are NOT the
// package name). `preinstalled` is not a plugin package and is skipped.
const pluginScopeDest = join(res, 'plugin', '@dsh-desktop')
mkdirSync(pluginScopeDest, { recursive: true })
for (const dir of readdirSync(join(root, 'plugins'))) {
  if (dir === 'preinstalled') continue
  const src = join(root, 'plugins', dir)
  if (!statSync(src).isDirectory()) continue
  const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'))
  const name = pkg.name || dir
  if (!name.startsWith('@dsh-desktop/')) {
    throw new Error(`plugin ${dir} declares unexpected package name ${name} (expected @dsh-desktop/*)`)
  }
  const rel = name.slice('@dsh-desktop/'.length)
  cpSync(src, join(pluginScopeDest, rel), { recursive: true, force: true })
}

// Preinstalled plugins: each directory under plugins/preinstalled is a
// self-contained dsh bundle copied into <runtime>/node_modules at launch.
// Version-locked with the shell release (see PLUGIN-CONSOLE-PLAN.md D3).
// The list below is the ship list — dir names, not package names (the bundle's
// own package.json decides where it lands in node_modules, so a scoped package
// like @karoc/dsh-smoothly-opencode-session keeps its unscoped dir here).
const preinstalledDest = join(res, 'preinstalled')
mkdirSync(preinstalledDest, { recursive: true })
for (const name of ['dsh-model-reasoning', 'dsh-kanban', 'dsh-turn-navigator', 'dsh-smoothly-opencode-session']) {
  cpSync(join(root, 'plugins', 'preinstalled', name), join(preinstalledDest, name), { recursive: true, force: true })
}

console.log('resources synced')