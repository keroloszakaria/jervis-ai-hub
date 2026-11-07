// The workspace copy: a write runs in a copy of the folder that has no `.git`
// and no secret files, and its changes reach the folder only when the person
// says yes. Copying, comparing and applying go through a git repository of the
// hub's own for each run (the engine writes text files only), so binary files
// are copied as they are and the person's own `.git` is never written.
import type { EngineInterface } from 'claude-code'

import { errText } from './cli'
import { homeDir, joinPath, osName } from './platform'
import type { OsName } from './platform'

/** More files than this, or more content, refuses the run: nothing is sent. */
export const MAX_COPY_FILES = 20_000
export const MAX_COPY_BYTES = 300 * 1024 * 1024

/** Files left out of the copy even when git tracks them: the usual names of secrets. */
const SECRET_NAMES: RegExp[] = [
  /^\.env$/i,
  /^\.env\..+/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /^id_ecdsa/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
]

/** Whether a path (relative, `/`-separated) is left out of the copy. */
export function isLeftOut(path: string): boolean {
  const parts = path.split('/')
  if (parts.some(p => p.toLowerCase() === '.git')) return true
  const name = parts[parts.length - 1] ?? ''
  return SECRET_NAMES.some(r => r.test(name))
}

export type WorkRun = {
  id: string
  /** the person's folder, as resolved and approved */
  folder: string
  /** how the question names it */
  shown: string
  /** the run's own folder: `git/`, `tree/`, `run.json`, `changes.patch` */
  root: string
  git: string
  tree: string
  /** the tree git recorded as the copy's base */
  base: string
  provider: string
  createdAt: number
  /** the files left out because of their names */
  leftOut: string[]
}

export type Change = { status: 'A' | 'M' | 'D' | 'T'; path: string }

export type Compared = { changes: Change[]; stat: string; patchPath: string }

// byte-exact copies, no hooks, no background work, paths as they are
const GIT_FLAGS = [
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'core.symlinks=true',
  '-c', 'core.quotepath=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'gc.auto=0',
  '-c', 'advice.addEmbeddedRepo=false',
]

type Git = { code: number; out: string; err: string }

async function hubGit(
  $: EngineInterface,
  gitDir: string,
  workTree: string | undefined,
  args: string[],
  opts: { stdin?: string; cwd?: string; index?: string; timeoutMs?: number } = {},
): Promise<Git> {
  const r = await $.process.run(
    ['git', ...GIT_FLAGS, `--git-dir=${gitDir}`, ...(workTree ? [`--work-tree=${workTree}`] : []), ...args],
    {
      cwd: opts.cwd ?? workTree ?? gitDir,
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs ?? 120_000,
      // the hub's own commands: none of the person's git variables, and an index of the run's own when asked
      env: { GIT_DIR: gitDir, ...(workTree ? { GIT_WORK_TREE: workTree } : {}), GIT_INDEX_FILE: opts.index ?? joinPathLike(gitDir, 'index') },
    },
  )
  return { code: r.exitCode, out: r.stdout, err: r.stderr }
}

const joinPathLike = (dir: string, name: string) => (dir.includes('\\') ? `${dir}\\${name}` : `${dir}/${name}`)

function must(r: Git, what: string): string {
  if (r.code !== 0) throw new Error(`${what} failed: ${(r.err || r.out).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`)
  return r.out
}

const nul = (out: string) => out.split('\0').filter(Boolean)

/** `~/.claude/jervis-ai-hub/work`: every run's folder is in here, and nothing else is ever removed. */
export async function workRoot($: EngineInterface): Promise<string> {
  return joinPath(await osName($), await homeDir($), '.claude', 'jervis-ai-hub', 'work')
}

function runId(stamp: number): string {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return `run-${stamp}-${[...b].map(x => x.toString(16).padStart(2, '0')).join('')}`
}

/** The files to copy, relative to the folder: git's own list in a repository, else every file not ignored. */
async function filesOf($: EngineInterface, folder: string, gitDir: string): Promise<string[]> {
  let inRepo = false
  try {
    const top = await $.process.run(['git', '-C', folder, 'rev-parse', '--show-toplevel'], { timeoutMs: 20_000 })
    inRepo = top.exitCode === 0
  } catch {
    inRepo = false
  }
  let all: string[]
  let gone: string[]
  if (inRepo) {
    // the person's own repository is only read: ls-files writes nothing
    const ls = (extra: string[]) => $.process.run(['git', '-c', 'core.quotepath=false', '-C', folder, 'ls-files', '-z', ...extra], { timeoutMs: 60_000 })
    const a = await ls(['-c', '-o', '--exclude-standard'])
    if (a.exitCode !== 0) throw new Error(`git could not list the files in ${folder}: ${a.stderr.trim().slice(0, 200)}`)
    all = nul(a.stdout)
    gone = nul((await ls(['-d'])).stdout)
  } else {
    // outside a repository: every file, minus what the folder's own .gitignore leaves out
    all = nul(must(await hubGit($, gitDir, folder, ['ls-files', '-z', '-o', '--exclude-standard'], { cwd: folder }), 'listing the folder'))
    gone = []
  }
  const deleted = new Set(gone)
  // a nested repository is listed as its folder: it is not copied
  return [...new Set(all)].filter(p => !deleted.has(p) && !p.endsWith('/'))
}

/**
 * Copies `folder` into a run's own `tree/`, without `.git`, ignored files or
 * the usual secret files. Throws with the reason when it cannot, or when the
 * folder is over the caps; then nothing was copied that stays.
 */
export async function makeCopy(
  $: EngineInterface,
  a: { folder: string; shown: string; provider: string },
): Promise<WorkRun> {
  const os = await osName($)
  const stamp = await $.clock.now()
  const id = runId(stamp)
  const root = joinPath(os, await workRoot($), id)
  const gitDir = joinPath(os, root, 'git')
  const tree = joinPath(os, root, 'tree')
  try {
    // a bare repository of the hub's own; the person's .git is never written
    must(await hubGit($, gitDir, undefined, ['init', '-q', '--bare', gitDir], { cwd: await homeDir($) }), 'starting the copy')
    const files = await filesOf($, a.folder, gitDir)
    const leftOut = files.filter(isLeftOut)
    const keep = files.filter(p => !isLeftOut(p))
    if (keep.length > MAX_COPY_FILES) {
      throw new Error(`${a.shown} has ${keep.length} files to copy, more than the ${MAX_COPY_FILES} a copy may hold`)
    }
    if (keep.length) {
      must(
        await hubGit($, gitDir, a.folder, ['--literal-pathspecs', 'add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { stdin: `${keep.join('\0')}\0` }),
        'copying the files',
      )
    }
    // the content's size, from the blobs git now holds
    const staged = must(await hubGit($, gitDir, undefined, ['ls-files', '-s', '-z']), 'reading the copy')
    const blobs = nul(staged).map(l => l.split(' ')[1] ?? '').filter(Boolean)
    if (blobs.length) {
      const sizes = must(await hubGit($, gitDir, undefined, ['cat-file', '--batch-check=%(objectsize)'], { stdin: `${blobs.join('\n')}\n` }), 'measuring the copy')
      const bytes = sizes.split(/\r?\n/).reduce((n, s) => n + (Number(s) || 0), 0)
      if (bytes > MAX_COPY_BYTES) {
        throw new Error(`${a.shown} has ${Math.round(bytes / 1024 / 1024)} MB to copy, more than the ${MAX_COPY_BYTES / 1024 / 1024} MB a copy may hold`)
      }
    }
    const base = must(await hubGit($, gitDir, undefined, ['write-tree']), 'recording the copy').trim()
    await $.fs.write(joinPath(os, tree, '.jervis-copy'), '')
    must(await hubGit($, gitDir, tree, ['checkout-index', '-a', '-f']), 'writing the copy')
    const run: WorkRun = { id, folder: a.folder, shown: a.shown, root, git: gitDir, tree, base, provider: a.provider, createdAt: stamp, leftOut }
    await $.fs.write(joinPath(os, root, 'run.json'), JSON.stringify(run, null, 2))
    return run
  } catch (error) {
    await removeRun($, root)
    throw error
  }
}

/** What the run changed in its copy, as git reads it against the base, with the patch saved beside it. */
export async function compare($: EngineInterface, run: WorkRun): Promise<Compared> {
  const os = await osName($)
  const index = joinPath(os, run.root, 'after.index')
  must(await hubGit($, run.git, run.tree, ['read-tree', run.base], { index }), 'reading the base')
  must(await hubGit($, run.git, run.tree, ['add', '-A', '--', '.', ':(exclude).jervis-copy'], { index }), 'reading the copy')
  const names = nul(must(await hubGit($, run.git, run.tree, ['diff', '--cached', '--no-renames', '--name-status', '-z', run.base], { index }), 'comparing'))
  const changes: Change[] = []
  for (let i = 0; i + 1 < names.length; i += 2) {
    const status = names[i]!.charAt(0) as Change['status']
    const path = names[i + 1]!
    if (path === '.jervis-copy') continue
    changes.push({ status, path })
  }
  const stat = changes.length
    ? must(await hubGit($, run.git, run.tree, ['diff', '--cached', '--no-renames', '--stat=120', run.base], { index }), 'summing up').trimEnd()
    : ''
  const patch = changes.length ? must(await hubGit($, run.git, run.tree, ['diff', '--cached', '--no-renames', '--binary', '--full-index', run.base], { index }), 'making the patch') : ''
  const patchPath = joinPath(os, run.root, 'changes.patch')
  await $.fs.write(patchPath, patch)
  return { changes, stat, patchPath }
}

/**
 * The files the run changed that are no longer in the folder as they were
 * when it was copied: changed since, deleted, or (for a file the run added)
 * created meanwhile. An apply goes ahead only when this is empty.
 */
export async function changedSince($: EngineInterface, run: WorkRun, changes: Change[]): Promise<string[]> {
  if (!changes.length) return []
  const os = await osName($)
  const index = joinPath(os, run.root, 'check.index')
  must(await hubGit($, run.git, run.folder, ['read-tree', run.base], { index }), 'reading the base')
  const paths = changes.map(c => c.path)
  // the folder's own files, read as they are now, at the paths the run changed;
  // a file the run added that the folder still lacks is as it was, and git
  // refuses a path that matches nothing, so it is left out of the reading
  const read: string[] = []
  for (const c of changes) {
    if (c.status !== 'A' || (await $.fs.exists(joinPath(os, run.folder, ...c.path.split('/'))).catch(() => true))) read.push(c.path)
  }
  if (read.length) {
    must(
      await hubGit($, run.git, run.folder, ['--literal-pathspecs', 'add', '-A', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { index, stdin: `${read.join('\0')}\0` }),
      'reading the folder',
    )
  }
  // the index is the base with only those paths read again, so any difference is one of them
  const out = must(await hubGit($, run.git, run.folder, ['diff', '--cached', '--no-renames', '--name-only', '-z', run.base], { index }), 'checking the folder')
  const asked = new Set(paths)
  return nul(out).filter(p => asked.has(p))
}

export type Applied = { isOk: true } | { isOk: false; why: string; files?: string[] }

/** Writes the run's changes into the folder, only when none of its files changed since the copy. Nothing is staged or committed. */
export async function applyRun($: EngineInterface, run: WorkRun, c: Compared): Promise<Applied> {
  if (!c.changes.length) return { isOk: true }
  try {
    const since = await changedSince($, run, c.changes)
    if (since.length) return { isOk: false, why: 'these files changed in the folder after the copy was made, so nothing was applied', files: since }
    const r = await hubGit($, run.git, run.folder, ['apply', '--binary', '--whitespace=nowarn', c.patchPath], { cwd: run.folder })
    if (r.code !== 0) return { isOk: false, why: `git could not apply the changes (${(r.err || r.out).trim().slice(0, 300)}); nothing was applied` }
    return { isOk: true }
  } catch (error) {
    return { isOk: false, why: `${errText(error)}; nothing was applied` }
  }
}

/** A kept run, read back from its folder; undefined when there is none by that id. */
export async function readRun($: EngineInterface, id: string): Promise<WorkRun | undefined> {
  if (!/^run-\d+-[0-9a-f]{16}$/.test(id)) return undefined
  const os = await osName($)
  try {
    return JSON.parse(await $.fs.read(joinPath(os, await workRoot($), id, 'run.json'))) as WorkRun
  } catch {
    return undefined
  }
}

/** Whether `path` is a run's own folder: directly under the work root and named as a run. */
export async function isRunFolder($: EngineInterface, path: string): Promise<boolean> {
  const os = await osName($)
  const root = await workRoot($)
  const sep = os === 'windows' ? '\\' : '/'
  const norm = (p: string) => (os === 'windows' ? p.replace(/\//g, '\\').toLowerCase() : p)
  if (!norm(path).startsWith(norm(root) + sep)) return false
  const rest = path.slice(root.length + 1)
  return /^run-\d+-[0-9a-f]{16}$/.test(rest)
}

/** Removes a run's own folder; any other path is left alone. */
export async function removeRun($: EngineInterface, path: string): Promise<void> {
  if (!(await isRunFolder($, path))) return
  const os: OsName = await osName($)
  try {
    if (os === 'windows') await $.process.run(['cmd.exe', '/d', '/c', 'rmdir', '/s', '/q', path], { timeoutMs: 120_000 })
    else await $.process.run(['rm', '-rf', '--', path], { timeoutMs: 120_000 })
  } catch {
    // left for the next clean-up
  }
}

/** Kept runs older than a week are removed (called as a session starts). */
export async function cleanOldRuns($: EngineInterface, now: number, maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  const os = await osName($)
  const root = await workRoot($)
  let entries: { name: string; kind: string }[] = []
  try {
    entries = await $.fs.list(root)
  } catch {
    return
  }
  for (const e of entries) {
    const m = /^run-(\d+)-[0-9a-f]{16}$/.exec(e.name)
    if (!m || e.kind !== 'dir') continue
    if (now - Number(m[1]) > maxAgeMs) await removeRun($, joinPath(os, root, e.name))
  }
}

/** The kept runs, newest first. */
export async function keptRuns($: EngineInterface): Promise<WorkRun[]> {
  let entries: { name: string; kind: string }[] = []
  try {
    entries = await $.fs.list(await workRoot($))
  } catch {
    return []
  }
  const runs: WorkRun[] = []
  for (const e of entries) {
    if (e.kind !== 'dir') continue
    const r = await readRun($, e.name)
    if (r) runs.push(r)
  }
  return runs.sort((a, b) => b.createdAt - a.createdAt)
}
