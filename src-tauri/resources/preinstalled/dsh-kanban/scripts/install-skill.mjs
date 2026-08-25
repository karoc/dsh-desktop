#!/usr/bin/env node
/**
 * Install the kanban-use skill (shipped with dsh-kanban) into the local agent
 * skills directory, so sessions see it in the skill catalog and the model can
 * load the full card-writing discipline on demand (the system-prompt guidance
 * points at it).
 *
 * The skill source of truth is skills/kanban-use/SKILL.md in this repo — the
 * plugin and the skill are maintained together in one repository.
 *
 * Usage:
 *   node scripts/install-skill.mjs                 # symlink (default; stays in sync with the repo)
 *   node scripts/install-skill.mjs --copy          # materialize a copy instead
 *   node scripts/install-skill.mjs --dest <dir>    # install under <dir>/kanban-use
 *                                                  # (default: ~/.agents/skills)
 *
 * Symlink mode: the installed skill IS the repo file — `git pull` + rebuild
 * keeps it fresh with zero further steps. A real (non-symlink) directory at
 * the target is never deleted; --copy mode overwrites the SKILL.md inside it.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const copy = args.includes('--copy')
const destFlag = args.find(a => a.startsWith('--dest='))
const destDir = resolve(destFlag ? destFlag.slice('--dest='.length) : join(homedir(), '.agents', 'skills'))

const root = resolve(import.meta.dirname, '..')
const source = resolve(root, 'skills', 'kanban-use')
const target = join(destDir, 'kanban-use')

if (!existsSync(source)) {
  console.error(`install-skill: source ${source} is missing — the skill lives in the repo`)
  process.exit(1)
}

mkdirSync(destDir, { recursive: true })

const mode = copy ? 'copy' : 'symlink'
let existing = null
try {
  const st = lstatSync(target)
  existing = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file'
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

if (existing === 'symlink') {
  const link = readlinkSync(target)
  if (resolve(dirname(target), link) === source) {
    console.log(`install-skill: kanban-use already installed (symlink → ${source}), up to date.`)
    process.exit(0)
  }
  rmSync(target, { force: true })
  existing = null
}

if (existing === 'dir') {
  if (mode === 'symlink') {
    console.error(`install-skill: ${target} is a real directory — not replacing it to avoid destroying data.`)
    console.error(`  remove it manually, or re-run with --copy to overwrite the SKILL.md inside it.`)
    process.exit(1)
  }
  cpSync(source, target, { recursive: true })
  console.log(`install-skill: copied kanban-use skill into ${target} (existing directory kept, files overwritten).`)
} else {
  if (mode === 'symlink') {
    symlinkSync(source, target, 'dir')
    console.log(`install-skill: symlinked kanban-use skill → ${source}`)
  } else {
    cpSync(source, target, { recursive: true })
    console.log(`install-skill: copied kanban-use skill into ${target}`)
  }
}

console.log('install-skill: available to NEW sessions (skill catalogs are read at session start).')