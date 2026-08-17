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
cpSync(join(root, 'scripts', 'server-manager.mjs'), join(res, 'manager', 'server-manager.mjs'), { force: true })
cpSync(join(root, 'scripts', 'proxy.mjs'), join(res, 'manager', 'proxy.mjs'), { force: true })

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
const preinstalledDest = join(res, 'preinstalled')
mkdirSync(preinstalledDest, { recursive: true })
for (const name of ['dsh-model-reasoning']) {
  cpSync(join(root, 'plugins', 'preinstalled', name), join(preinstalledDest, name), { recursive: true, force: true })
}

console.log('resources synced')