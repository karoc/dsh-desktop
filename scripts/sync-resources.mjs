#!/usr/bin/env node
// Sync runtime resources into src-tauri/resources/ so tauri can bundle them:
//   scripts/server-manager.mjs        -> resources/manager/server-manager.mjs
//   src-tauri/resources/patch/*       -> already in place
//   plugins/dsh-client-notifications  -> resources/plugin/@dsh-desktop/client-notifications
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const res = join(root, 'src-tauri', 'resources')

mkdirSync(join(res, 'manager'), { recursive: true })
cpSync(join(root, 'scripts', 'server-manager.mjs'), join(res, 'manager', 'server-manager.mjs'), { force: true })

const pluginDest = join(res, 'plugin', '@dsh-desktop', 'client-notifications')
mkdirSync(dirname(pluginDest), { recursive: true })
cpSync(join(root, 'plugins', 'dsh-client-notifications'), pluginDest, { recursive: true, force: true })

console.log('resources synced')