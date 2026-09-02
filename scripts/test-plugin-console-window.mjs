#!/usr/bin/env node
// Structural contract for the plugins management WINDOW (src/plugin-console.js).
//
// The window reuses the original plugin console's rendering core with a
// unified shell design system. Two hard constraints are locked here:
//   1. LAYOUT MUST NOT CHANGE — the section order (install → preinstalled →
//      user installed → dsh update → actions) is the information architecture
//      the user asked to keep; a re-order or removal fails this test.
//   2. STYLE MUST BE UNIFIED — geometry (radii 8/12/14), flat primary buttons
//      (solid accent, no gradient), in-shell confirm dialog instead of native
//      confirm(), theme = color-only (no per-theme geometry vars).
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'src', 'plugin-console.js'), 'utf8')

// ── 1. layout: section render order is fixed (information architecture) ────
const order = ['install', 'preinstalled', 'userInstalled', 'update', 'actions']
const marks = order.map((id) => src.indexOf(`section(L.${id}`))
for (let i = 0; i < marks.length; i++) {
  assert.ok(marks[i] >= 0, `layout section "L.${order[i]}" still rendered`)
}
for (let i = 1; i < marks.length; i++) {
  assert.ok(marks[i] > marks[i - 1], `layout section order preserved (${order[i - 1]} before ${order[i]})`)
}
// key building blocks of the layout remain (cards / switch / update arrow /
// install input / restart / footer).
for (const needle of [
  'dshc-item', 'dshc-row', 'dshc-switch', 'dshc-upd-arrow',
  'dshc-install', 'dshc-restart', 'dshc-refresh', 'dshc-footer', 'dshc-check-pre',
]) {
  assert.ok(src.includes(needle), `layout block ${needle} present`)
}

// ── 2. style: unified geometry tokens (no per-theme geometry) ──────────────
for (const theme of ['deep', 'aurora', 'moon', 'amber']) {
  const block = src.slice(src.indexOf(`${theme}: {`), src.indexOf(`    },`))
  assert.ok(!/radiusRow|'radius'|blur|'pad'|'gap'/.test(block), `theme "${theme}" carries no geometry (color-only)`)
}
assert.ok(src.includes('border-radius: 12px'), 'cards/rows use unified 12px radius')
assert.ok(src.includes('border-radius: 8px'), 'buttons/inputs use unified 8px radius')
assert.ok(src.includes('border-radius: 14px'), 'dialog cards use unified 14px radius')
// 主按钮纯色 accent（switch/升级箭头等组件保留渐变，不在此断言范围）
const primaryBlock = src.slice(src.indexOf('.dshc-btn2.primary'), src.indexOf('.dshc-btn2.primary:hover'))
assert.ok(primaryBlock.length > 0, 'primary button block found')
assert.ok(!primaryBlock.includes('linear-gradient'), 'primary buttons are solid accent (no gradient)')
assert.ok(primaryBlock.includes('background: var(--dshc-accent);'), 'primary button = solid accent')

// ── 3. in-shell confirm replaces native confirm ────────────────────────────
assert.ok(src.includes('function showConfirm'), 'window has an in-shell confirm dialog')
assert.ok(src.includes('dshc-confirm-backdrop'), 'confirm uses the unified modal backdrop')
assert.ok(!src.includes('globalThis.confirm'), 'no native confirm() left in the window')

console.log('PASS — plugins window structure (layout order + unified style + in-shell confirm)')
process.exit(0)
