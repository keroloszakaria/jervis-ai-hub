// The workspace copy: a write runs in a copy of the folder that has no `.git`
// and no secret files, and its changes reach the folder only when the person
// says yes. Copying, comparing and applying go through a git repository of the
// hub's own for each run (the engine writes text files only), so binary files
// are copied as they are and the person's own `.git` is never written.
//
// What a run is (its folder, its base) lives in the hub's memory and its
// plugin store, never in a file beside the copy: an agent that can write
// there cannot point an apply at another folder. The run's own paths come
// from its id alone, and the hub's git config is written again before each use.
//
// Files are read into a throwaway scan repository first; only what the scan
// keeps is stored in the run's own, so a file left out (a key inside, a link,
// what .jervisignore names) leaves no copy of its content in the run's git.
import type { EngineInterface } from 'claude-code'

import { errText } from './cli'
import { homeDir, joinPath, osName } from './platform'
import type { OsName } from './platform'
import { provider } from './registry'

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

/**
 * What a file with a key in it looks like, whatever its name: shapes specific
 * enough not to catch ordinary code. git grep reads them as extended regular
 * expressions, and skips binary files.
 */
export const SECRET_CONTENT: string[] = [
  '-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----',
  'AKIA[0-9A-Z]{16}',
  'gh[pousr]_[A-Za-z0-9]{36,}',
  'github_pat_[A-Za-z0-9_]{22,}',
  'sk-(ant-|proj-)?[A-Za-z0-9_-]{32,}',
  'AIza[0-9A-Za-z_-]{35}',
  '(sk|rk)_live_[0-9A-Za-z]{20,}',
  'xox[abprs]-[0-9A-Za-z-]{10,}',
]

/** The file in the folder's root whose patterns (as in .gitignore) are left out of the copy too. */
export const IGNORE_FILE = '.jervisignore'

/** Whether a path (relative, `/`-separated) is left out of the copy by its name. */
export function isLeftOut(path: string): boolean {
  const parts = path.split('/')
  if (parts.some(p => p.toLowerCase() === '.git')) return true
  const name = parts[parts.length - 1] ?? ''
  return SECRET_NAMES.some(r => r.test(name))
}

export type LeftOut = { path: string; why: 'name' | 'link' | 'content' | 'ignore-file' }

export type WorkRun = {
  id: string
  /** the person's folder, as resolved and approved; the question names this folder, never another */
  folder: string
  /** the folder, as questions name it */
  shown: string
  /** the run's own folder: `git/`, `tree/`, `changes.patch` (from the id alone) */
  root: string
  git: string
  tree: string
  /** the tree git recorded as the copy's base */
  base: string
  provider: string
  createdAt: number
  leftOut: LeftOut[]
}

/** What the hub keeps of a run; the rest follows from its id. */
type RunRecord = Pick<WorkRun, 'id' | 'folder' | 'base' | 'provider' | 'createdAt' | 'leftOut'>

/** `isLink`: the run made it a link or a submodule, which the hub never applies. */
export type Change = { status: 'A' | 'M' | 'D' | 'T'; path: string; isLink?: boolean }

/** One file's change as the review shows it: its diff, cut at the caps. */
export type FileDiff = {
  path: string
  status: Change['status']
  isLink?: boolean
  isBinary: boolean
  added: number
  deleted: number
  /** the diff from its first hunk; empty for a binary or mode-only change */
  text: string
  /** the text was cut at the caps, or not shown at all */
  isCut: boolean
}

/** `after`: the tree git recorded for the copy as the run left it. */
export type Compared = { changes: Change[]; stat: string; patchPath: string; after: string; files: FileDiff[] }

/** How much of each file's diff, and of all of them, the review carries. */
export const MAX_FILE_DIFF_LINES = 400
export const MAX_FILE_DIFF_CHARS = 40_000
export const MAX_DIFF_CHARS = 400_000

const RUN_ID = /^run-(\d+)-[0-9a-f]{16}$/
const RUNS_KEY = 'hub-work-runs-v1'
/** this session's runs: what a later reading of the store must agree with */
const known = new Map<string, RunRecord>()
/** the session that made each of those runs: a /clear keeps the module, not the session */
const madeIn = new Map<string, string>()

async function sessionNow($: EngineInterface): Promise<string> {
  try {
    return await $.session.id()
  } catch {
    return ''
  }
}

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

/**
 * The hub's git config and attributes for a run, written again before each
 * use: whatever was put there meanwhile (a filter, an external diff) is gone.
 */
async function sealGit($: EngineInterface, gitDir: string): Promise<void> {
  const os = await osName($)
  await $.fs.write(joinPath(os, gitDir, 'config'), `[core]\n\trepositoryformatversion = 0\n\tfilemode = ${os === 'windows' ? 'false' : 'true'}\n\tbare = true\n`)
  await $.fs.write(joinPath(os, gitDir, 'info', 'attributes'), '')
}

/** `~/.claude/jervis-ai-hub/work`: every run's folder is in here, and nothing else is ever removed. */
export async function workRoot($: EngineInterface): Promise<string> {
  return joinPath(await osName($), await homeDir($), '.claude', 'jervis-ai-hub', 'work')
}

function runId(stamp: number): string {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return `run-${stamp}-${[...b].map(x => x.toString(16).padStart(2, '0')).join('')}`
}

/** A run's paths, from its id alone. */
async function pathsOf($: EngineInterface, id: string): Promise<Pick<WorkRun, 'root' | 'git' | 'tree'>> {
  const os = await osName($)
  const root = joinPath(os, await workRoot($), id)
  return { root, git: joinPath(os, root, 'git'), tree: joinPath(os, root, 'tree') }
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

/** Index entries as `{ mode, path }`, from `ls-files -s -z`. */
function staged(out: string): { mode: string; blob: string; path: string }[] {
  return nul(out).map(l => {
    const tab = l.indexOf('\t')
    const [mode = '', blob = ''] = l.slice(0, tab).split(' ')
    return { mode, blob, path: l.slice(tab + 1) }
  })
}

const isLinkMode = (mode: string) => mode === '120000' || mode === '160000'

const sameCase = (os: OsName, p: string): string => {
  const x = p.replace(/[\\/]+$/, '')
  return os === 'windows' ? x.replace(/\//g, '\\').toLowerCase() : x
}

/**
 * The folders (relative, with `/`) on these paths whose real place is outside
 * `folder`: a Windows junction or a linked folder, which git lists as a plain
 * folder. A file under one is not the folder's, so it is neither copied nor
 * written by an Apply. A folder whose place cannot be read counts as outside.
 */
export async function foldersLeadingOut($: EngineInterface, folder: string, paths: string[]): Promise<Set<string>> {
  const os = await osName($)
  const sep = os === 'windows' ? '\\' : '/'
  let rootReal: string
  try {
    rootReal = (await $.fs.stat(folder, { resolve: true })).realPath ?? folder
  } catch {
    rootReal = folder
  }
  const root = sameCase(os, rootReal)
  const dirs = new Set<string>()
  for (const p of paths) {
    const parts = p.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  const out = new Set<string>()
  for (const d of [...dirs].sort((a, b) => a.length - b.length)) {
    // under a folder already found to lead out
    if ([...out].some(o => d.startsWith(`${o}/`))) {
      out.add(d)
      continue
    }
    let real: string | undefined
    try {
      const st = await $.fs.stat(joinPath(os, folder, ...d.split('/')), { resolve: true })
      real = st.realPath
    } catch {
      real = undefined
    }
    const r = real === undefined ? undefined : sameCase(os, real)
    if (r === undefined || (r !== root && !r.startsWith(root + sep))) out.add(d)
  }
  return out
}

const underAny = (p: string, dirs: Set<string>): boolean => {
  const parts = p.split('/')
  for (let i = 1; i < parts.length; i++) if (dirs.has(parts.slice(0, i).join('/'))) return true
  return false
}

async function dropFromIndex($: EngineInterface, gitDir: string, folder: string, paths: string[]): Promise<void> {
  if (!paths.length) return
  // the index only: --force-remove never touches the folder's files
  must(await hubGit($, gitDir, folder, ['update-index', '--force-remove', '-z', '--stdin'], { stdin: `${paths.join('\0')}\0` }), 'leaving files out')
}

/**
 * Copies `folder` into a run's own `tree/`, without `.git`, ignored files,
 * links, submodules, the usual secret files, files with what looks like a key
 * inside, or what `.jervisignore` names. Throws with the reason when it cannot,
 * or when the folder is over the caps; then nothing was copied that stays.
 */
export async function makeCopy($: EngineInterface, a: { folder: string; shown?: string; provider: string }): Promise<WorkRun> {
  const os = await osName($)
  const stamp = await $.clock.now()
  const id = runId(stamp)
  const { root, git: gitDir, tree } = await pathsOf($, id)
  try {
    // a bare repository of the hub's own; the person's .git is never written
    must(await hubGit($, gitDir, undefined, ['init', '-q', '--bare', gitDir], { cwd: await homeDir($) }), 'starting the copy')
    await sealGit($, gitDir)
    // the scan reads every file first, in a repository of its own that is removed before the run starts
    const scanDir = joinPath(os, root, 'scan')
    must(await hubGit($, scanDir, undefined, ['init', '-q', '--bare', scanDir], { cwd: await homeDir($) }), 'starting the scan')
    await sealGit($, scanDir)
    const listed = await filesOf($, a.folder, gitDir)
    // files reached through a folder that leads out of the project (a junction) are not the project's
    const outside = await foldersLeadingOut($, a.folder, listed)
    const files = listed.filter(p => !underAny(p, outside))
    const leftOut: LeftOut[] = listed.filter(p => underAny(p, outside)).map(path => ({ path, why: 'link' as const }))
    leftOut.push(...files.filter(isLeftOut).map(path => ({ path, why: 'name' as const })))
    const keep = files.filter(p => !isLeftOut(p))
    if (keep.length > MAX_COPY_FILES) {
      throw new Error(`${a.folder} has ${keep.length} files to copy, more than the ${MAX_COPY_FILES} a copy may hold`)
    }
    const add = async (dir: string, paths: string[], what: string) =>
      must(await hubGit($, dir, a.folder, ['--literal-pathspecs', 'add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { stdin: `${paths.join('\0')}\0` }), what)
    if (keep.length) await add(scanDir, keep, 'reading the files')
    // links and submodules stay out: a link could lead out of the copy
    const links = staged(must(await hubGit($, scanDir, undefined, ['ls-files', '-s', '-z']), 'reading the files')).filter(e => isLinkMode(e.mode)).map(e => e.path)
    await dropFromIndex($, scanDir, a.folder, links)
    leftOut.push(...links.map(path => ({ path, why: 'link' as const })))
    // what the folder's own .jervisignore names
    const ignoreFile = joinPath(os, a.folder, IGNORE_FILE)
    if (await $.fs.exists(ignoreFile).catch(() => false)) {
      const named = nul(must(await hubGit($, scanDir, a.folder, ['ls-files', '-z', '-c', '-i', `--exclude-from=${ignoreFile}`]), `reading ${IGNORE_FILE}`))
      await dropFromIndex($, scanDir, a.folder, named)
      leftOut.push(...named.map(path => ({ path, why: 'ignore-file' as const })))
    }
    // files with what looks like a key inside, whatever their name (git grep exits 1 when nothing matches)
    const grep = await hubGit($, scanDir, undefined, ['grep', '--cached', '-I', '-l', '-z', '-E', ...SECRET_CONTENT.flatMap(p => ['-e', p])])
    if (grep.code > 1) throw new Error(`looking for keys in the files failed: ${(grep.err || grep.out).trim().slice(0, 200)}`)
    const keyed = grep.code === 0 ? nul(grep.out) : []
    await dropFromIndex($, scanDir, a.folder, keyed)
    leftOut.push(...keyed.map(path => ({ path, why: 'content' as const })))
    // what the scan kept, as it read each file; the scan's store, which holds every file, goes now
    const scanned = staged(must(await hubGit($, scanDir, undefined, ['ls-files', '-s', '-z']), 'reading the files'))
    await rmTree($, os, scanDir)
    if (await $.fs.exists(scanDir).catch(() => true)) throw new Error('the scan of the files could not be removed')
    // only what the scan kept is stored for the run
    if (scanned.length) await add(gitDir, scanned.map(e => e.path), 'copying the files')
    // a file that changed between the scan and the copy was not the file scanned: nothing is copied
    const want = new Map(scanned.map(e => [e.path, `${e.mode} ${e.blob}`]))
    const got = staged(must(await hubGit($, gitDir, undefined, ['ls-files', '-s', '-z']), 'reading the copy'))
    const moved = got.filter(e => want.get(e.path) !== `${e.mode} ${e.blob}`).map(e => e.path)
    if (moved.length || got.length !== scanned.length) {
      throw new Error(`files changed while they were copied (${moved.slice(0, 5).join(', ') || 'the list of files'}); nothing was copied, try again`)
    }
    // the content's size, from the blobs git now holds
    const blobs = staged(must(await hubGit($, gitDir, undefined, ['ls-files', '-s', '-z']), 'reading the copy')).map(e => e.blob).filter(Boolean)
    if (blobs.length) {
      const sizes = must(await hubGit($, gitDir, undefined, ['cat-file', '--batch-check=%(objectsize)'], { stdin: `${blobs.join('\n')}\n` }), 'measuring the copy')
      const bytes = sizes.split(/\r?\n/).reduce((n, s) => n + (Number(s) || 0), 0)
      if (bytes > MAX_COPY_BYTES) {
        throw new Error(`${a.folder} has ${Math.round(bytes / 1024 / 1024)} MB to copy, more than the ${MAX_COPY_BYTES / 1024 / 1024} MB a copy may hold`)
      }
    }
    const base = must(await hubGit($, gitDir, undefined, ['write-tree']), 'recording the copy').trim()
    await $.fs.write(joinPath(os, tree, '.jervis-copy'), '')
    must(await hubGit($, gitDir, tree, ['checkout-index', '-a', '-f']), 'writing the copy')
    const record: RunRecord = { id, folder: a.folder, base, provider: a.provider, createdAt: stamp, leftOut }
    await remember($, record)
    return { ...record, shown: a.folder, root, git: gitDir, tree }
  } catch (error) {
    await removeRun($, root)
    throw error
  }
}

/** What the run changed in its copy, as git reads it against the base, with the patch saved beside it. */
export async function compare($: EngineInterface, run: WorkRun): Promise<Compared> {
  const os = await osName($)
  await sealGit($, run.git)
  const index = joinPath(os, run.root, 'after.index')
  must(await hubGit($, run.git, run.tree, ['read-tree', run.base], { index }), 'reading the base')
  must(await hubGit($, run.git, run.tree, ['add', '-A', '--', '.', ':(exclude).jervis-copy'], { index }), 'reading the copy')
  // the raw form carries each file's mode, so a link the run made is seen as one
  const raw = nul(must(await hubGit($, run.git, run.tree, ['diff', '--cached', '--no-renames', '--raw', '-z', run.base], { index }), 'comparing'))
  const changes: Change[] = []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [, newMode = ''] = raw[i]!.replace(/^:/, '').split(' ')
    const status = (raw[i]!.trim().split(' ').pop() ?? 'M').charAt(0) as Change['status']
    const path = raw[i + 1]!
    if (path === '.jervis-copy') continue
    changes.push({ status, path, ...(isLinkMode(newMode) ? { isLink: true } : {}) })
  }
  const stat = changes.length
    ? must(await hubGit($, run.git, run.tree, ['diff', '--cached', '--no-renames', '--stat=120', run.base], { index }), 'summing up').trimEnd()
    : ''
  const patch = changes.length ? must(await hubGit($, run.git, run.tree, ['diff', '--cached', '--no-renames', '--binary', '--full-index', run.base], { index }), 'making the patch') : ''
  const patchPath = joinPath(os, run.root, 'changes.patch')
  await $.fs.write(patchPath, patch)
  const after = must(await hubGit($, run.git, run.tree, ['write-tree'], { index }), 'recording the changes').trim()
  const files = changes.length ? await fileDiffs($, run, index, changes) : []
  return { changes, stat, patchPath, after, files }
}

/** Each file's diff for the review, in the order git lists the changes, cut at the caps. */
async function fileDiffs($: EngineInterface, run: WorkRun, index: string, changes: Change[]): Promise<FileDiff[]> {
  const opts = ['diff', '--cached', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv']
  // `added\tdeleted\tpath`, with `-` for both on a binary file
  const counts = nul(must(await hubGit($, run.git, run.tree, [...opts, '--numstat', '-z', run.base], { index }), 'counting the changes'))
    .map(l => l.split('\t'))
    .filter(f => f.length >= 3)
    .map(([a = '', d = '', path = '']) => ({ path, isBinary: a === '-', added: Number(a) || 0, deleted: Number(d) || 0 }))
  const shown = must(await hubGit($, run.git, run.tree, [...opts, '-U3', run.base], { index }), 'reading the changes')
  // each file's part starts at a `diff --git` line; no line inside a diff starts so
  const parts = `\n${shown}`.split('\ndiff --git ').slice(1)
  const fits = parts.length === changes.length
  let budget = MAX_DIFF_CHARS
  return changes.map((c, i) => {
    const n = counts.find(x => x.path === c.path)
    const part = fits ? (parts[i] ?? '') : ''
    const from = part.indexOf('\n@@')
    let text = from < 0 ? '' : part.slice(from + 1).replace(/\n$/, '')
    let isCut = !fits
    const lines = text.split('\n')
    if (lines.length > MAX_FILE_DIFF_LINES) {
      text = lines.slice(0, MAX_FILE_DIFF_LINES).join('\n')
      isCut = true
    }
    if (text.length > MAX_FILE_DIFF_CHARS) {
      text = text.slice(0, MAX_FILE_DIFF_CHARS)
      isCut = true
    }
    if (text.length > budget) {
      text = ''
      isCut = true
    }
    budget -= text.length
    return {
      path: c.path,
      status: c.status,
      ...(c.isLink ? { isLink: true } : {}),
      isBinary: n?.isBinary ?? false,
      added: n?.added ?? 0,
      deleted: n?.deleted ?? 0,
      text,
      isCut,
    }
  })
}

/**
 * The files the run changed that are no longer in the folder as they were
 * when it was copied: changed since, deleted, or (for a file the run added)
 * created meanwhile. An apply goes ahead only when this is empty.
 */
export async function changedSince($: EngineInterface, run: WorkRun, changes: Change[]): Promise<string[]> {
  return differsFrom($, run, run.base, changes, c => c.status === 'A')
}

/**
 * The files the run changed that are not, in the folder now, as `tree` has
 * them. `isAbsent`: the files `tree` does not hold (a file the folder lacks
 * too is as the tree has it).
 */
async function differsFrom($: EngineInterface, run: WorkRun, tree: string, changes: Change[], isAbsent: (c: Change) => boolean): Promise<string[]> {
  if (!changes.length) return []
  const os = await osName($)
  await sealGit($, run.git)
  const index = joinPath(os, run.root, 'check.index')
  must(await hubGit($, run.git, run.folder, ['read-tree', tree], { index }), 'reading the base')
  const paths = changes.map(c => c.path)
  // the folder's own files, read as they are now, at the paths the run changed;
  // a file the tree lacks that the folder still lacks is as it was, and git
  // refuses a path that matches nothing, so it is left out of the reading
  const read: string[] = []
  for (const c of changes) {
    if (!isAbsent(c) || (await $.fs.exists(joinPath(os, run.folder, ...c.path.split('/'))).catch(() => true))) read.push(c.path)
  }
  if (read.length) {
    must(
      await hubGit($, run.git, run.folder, ['--literal-pathspecs', 'add', '-A', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { index, stdin: `${read.join('\0')}\0` }),
      'reading the folder',
    )
  }
  // the index is the base with only those paths read again, so any difference is one of them
  const out = must(await hubGit($, run.git, run.folder, ['diff', '--cached', '--no-renames', '--name-only', '-z', tree], { index }), 'checking the folder')
  const asked = new Set(paths)
  return nul(out).filter(p => asked.has(p))
}

/**
 * `unchecked`: why the check after the apply could not run. `isMixed`: the
 * run's changes could not be taken back out of files that changed meanwhile,
 * so those files hold both.
 */
export type Applied = { isOk: true; unchecked?: string } | { isOk: false; why: string; files?: string[]; isMixed?: true }

/**
 * Writes the run's changes into the folder, only when none of its files
 * changed since the copy and none of them is a link. `git apply` checks every
 * file before it writes any, so a file changed between this check and the
 * apply fails the whole apply. Nothing is staged or committed.
 */
export async function applyRun($: EngineInterface, run: WorkRun, c: Compared): Promise<Applied> {
  if (!c.changes.length) return { isOk: true }
  const links = c.changes.filter(x => x.isLink).map(x => x.path)
  if (links.length) return { isOk: false, why: 'the run made links or submodules, which the hub never applies, so nothing was applied', files: links }
  try {
    // checked again now: a folder made into a junction since the copy would carry the write out of the project
    const outside = await foldersLeadingOut($, run.folder, c.changes.map(x => x.path))
    const out = c.changes.filter(x => underAny(x.path, outside)).map(x => x.path)
    if (out.length) return { isOk: false, why: 'these files are reached through a folder that leads out of the project (a junction or a link), so nothing was applied', files: out }
    const since = await changedSince($, run, c.changes)
    if (since.length) return { isOk: false, why: 'these files changed in the folder after the copy was made, so nothing was applied', files: since }
    await sealGit($, run.git)
    const r = await hubGit($, run.git, run.folder, ['apply', '--binary', '--whitespace=nowarn', c.patchPath], { cwd: run.folder })
    if (r.code !== 0) {
      const why = (r.err || r.out).trim().slice(0, 300)
      // git checks every file before it writes, but a write can still fail half way (a locked file): find what it wrote
      const written = await differsFrom($, run, run.base, c.changes, x => x.status === 'A').catch(() => undefined)
      if (written === undefined) return { isOk: false, isMixed: true, why: `git could not apply the changes (${why}), and the hub could not check what it wrote: check these files`, files: c.changes.map(x => x.path) }
      if (!written.length) return { isOk: false, why: `git could not apply the changes (${why}); nothing was applied` }
      await sealGit($, run.git)
      const undo = await hubGit($, run.git, run.folder, ['apply', '-R', '--binary', '--whitespace=nowarn', ...written.map(p => `--include=${p}`), c.patchPath], { cwd: run.folder })
      const left = undo.code === 0 ? await differsFrom($, run, run.base, c.changes, x => x.status === 'A').catch(() => written) : written
      if (!left.length) return { isOk: false, why: `git could not apply the changes (${why}) after it had written some files; those were put back, so nothing was applied`, files: written }
      return { isOk: false, isMixed: true, why: `git could not apply the changes (${why}) after it had written some files, and these could not be put back: check them`, files: left }
    }
  } catch (error) {
    return { isOk: false, why: `${errText(error)}; nothing was applied` }
  }
  // each file as the run left it? one that is not had another change merged in:
  // what was approved is the run's version, so the run's changes come back out
  let merged: string[]
  try {
    merged = await differsFrom($, run, c.after, c.changes, x => x.status === 'D')
  } catch (error) {
    return { isOk: true, unchecked: errText(error) }
  }
  if (!merged.length) return { isOk: true }
  await sealGit($, run.git)
  const back = await hubGit($, run.git, run.folder, ['apply', '-R', '--binary', '--whitespace=nowarn', c.patchPath], { cwd: run.folder })
  if (back.code !== 0) {
    return {
      isOk: false,
      isMixed: true,
      why: `these files changed in the folder while the changes were applied, and the hub could not take the run's changes back out (${(back.err || back.out).trim().slice(0, 200)}): they hold both, so check them`,
      files: merged,
    }
  }
  return { isOk: false, why: "these files changed in the folder while the changes were applied, so the run's changes were taken back out; the folder keeps the other changes", files: merged }
}

async function storedRuns($: EngineInterface): Promise<Record<string, RunRecord>> {
  try {
    const v = await $.store.get(RUNS_KEY)
    return v && typeof v === 'object' ? (v as Record<string, RunRecord>) : {}
  } catch {
    return {}
  }
}

// every read-change-write of the kept runs goes through this queue, one at a
// time, so two runs ending together never lose each other's record
let runsQueue: Promise<unknown> = Promise.resolve()
function withRuns<T>(job: () => Promise<T>): Promise<T> {
  const next = runsQueue.then(job, job)
  runsQueue = next.catch(() => undefined)
  return next
}

async function remember($: EngineInterface, r: RunRecord): Promise<void> {
  known.set(r.id, r)
  madeIn.set(r.id, await sessionNow($))
  await withRuns(async () => {
    const all = await storedRuns($)
    all[r.id] = r
    await $.store.set(RUNS_KEY, all)
  })
}

async function forget($: EngineInterface, id: string): Promise<void> {
  known.delete(id)
  madeIn.delete(id)
  await withRuns(async () => {
    const all = await storedRuns($)
    if (id in all) {
      delete all[id]
      await $.store.set(RUNS_KEY, all)
    }
  })
}

/** Whether a stored record is one the hub could have written: its id, an absolute folder, a git tree id, a known provider. */
function isRecord(id: string, r: unknown): r is RunRecord {
  if (!r || typeof r !== 'object') return false
  const x = r as Record<string, unknown>
  const m = RUN_ID.exec(id)
  return (
    x.id === id &&
    m !== null &&
    x.createdAt === Number(m[1]) &&
    typeof x.folder === 'string' &&
    (/^[a-zA-Z]:\\/.test(x.folder) || x.folder.startsWith('/') || x.folder.startsWith('\\\\')) &&
    !/[\0\r\n]/.test(x.folder) &&
    typeof x.base === 'string' &&
    /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(x.base) &&
    typeof x.provider === 'string' &&
    provider(x.provider) !== undefined &&
    Array.isArray(x.leftOut)
  )
}

/**
 * A kept run by its id: this session's own record when it has one, else the
 * plugin store's, which must have the shape the hub writes. Its paths come
 * from the id, so no record can move them. Undefined when there is none.
 */
export async function readRun($: EngineInterface, id: string): Promise<WorkRun | undefined> {
  if (!RUN_ID.test(id)) return undefined
  const stored = (await storedRuns($))[id]
  const mine = known.get(id)
  const r = mine ?? stored
  if (!isRecord(id, r)) return undefined
  // a store changed after this session wrote it is not trusted
  if (mine && stored && JSON.stringify(stored) !== JSON.stringify(mine)) return undefined
  const p = await pathsOf($, id)
  if (!(await $.fs.exists(p.git).catch(() => false))) return undefined
  return { ...r, shown: r.folder, ...p }
}

/** Whether this session made the run (its record is in the hub's memory, not only in the store). */
export async function isThisSessions($: EngineInterface, id: string): Promise<boolean> {
  return known.has(id) && madeIn.get(id) === (await sessionNow($))
}

/** Whether `path` is a run's own folder: directly under the work root and named as a run. */
export async function isRunFolder($: EngineInterface, path: string): Promise<boolean> {
  const os = await osName($)
  const root = await workRoot($)
  const sep = os === 'windows' ? '\\' : '/'
  const norm = (p: string) => (os === 'windows' ? p.replace(/\//g, '\\').toLowerCase() : p)
  if (!norm(path).startsWith(norm(root) + sep)) return false
  return RUN_ID.test(path.slice(root.length + 1))
}

async function rmTree($: EngineInterface, os: OsName, path: string): Promise<void> {
  try {
    if (os === 'windows') await $.process.run(['cmd.exe', '/d', '/c', 'rmdir', '/s', '/q', path], { timeoutMs: 120_000 })
    else await $.process.run(['rm', '-rf', '--', path], { timeoutMs: 120_000 })
  } catch {
    // left for the next clean-up
  }
}

/** Removes a run's own folder and its record; any other path is left alone. */
export async function removeRun($: EngineInterface, path: string): Promise<void> {
  if (!(await isRunFolder($, path))) return
  const os: OsName = await osName($)
  await forget($, path.slice((await workRoot($)).length + 1)).catch(() => undefined)
  await rmTree($, os, path)
}

/** A copy still being made, in this session or another, is left this long before it counts as left behind. */
export const LEFT_BEHIND_MS = 10 * 60 * 1000

/**
 * Called as a session starts. Removes kept runs older than a week, and,
 * once older than a few minutes, what a failed copy left behind: a scan
 * (which holds every file read) and a run with no record. Then drops records
 * left without a folder.
 */
export async function cleanOldRuns($: EngineInterface, now: number, maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  const os = await osName($)
  const root = await workRoot($)
  let entries: { name: string; kind: string }[] = []
  try {
    entries = await $.fs.list(root)
  } catch {
    entries = []
  }
  const recorded = await storedRuns($)
  for (const e of entries) {
    const m = RUN_ID.exec(e.name)
    if (!m || e.kind !== 'dir') continue
    const age = now - Number(m[1])
    const dir = joinPath(os, root, e.name)
    if (age > maxAgeMs || (age > LEFT_BEHIND_MS && !(e.name in recorded))) {
      await removeRun($, dir)
      continue
    }
    const scan = joinPath(os, dir, 'scan')
    if (age > LEFT_BEHIND_MS && (await $.fs.exists(scan).catch(() => false))) await rmTree($, os, scan)
  }
  const there = new Set(entries.map(e => e.name))
  await withRuns(async () => {
    const all = await storedRuns($)
    // a record made since the folder was listed (by another session) is not stale
    const stale = Object.keys(all).filter(id => !RUN_ID.test(id) || (!there.has(id) && now - Number(RUN_ID.exec(id)![1]) > LEFT_BEHIND_MS))
    if (stale.length) {
      for (const id of stale) delete all[id]
      await $.store.set(RUNS_KEY, all).catch(() => undefined)
    }
  })
}

/** The kept runs, newest first. */
export async function keptRuns($: EngineInterface): Promise<WorkRun[]> {
  const runs: WorkRun[] = []
  for (const id of Object.keys(await storedRuns($))) {
    const r = await readRun($, id)
    if (r) runs.push(r)
  }
  return runs.sort((a, b) => b.createdAt - a.createdAt)
}

/** How an answer names what was left out of the copy, and why. */
export function leftOutLine(left: LeftOut[], max = 10): string {
  if (!left.length) return ''
  const groups: [LeftOut['why'], string][] = [
    ['name', 'by their names'],
    ['content', 'with what looks like a key inside'],
    ['link', 'links and submodules'],
    ['ignore-file', `named in ${IGNORE_FILE}`],
  ]
  const parts = groups
    .map(([why, label]) => {
      const paths = left.filter(l => l.why === why).map(l => l.path)
      if (!paths.length) return ''
      return `${label}: ${paths.slice(0, max).join(', ')}${paths.length > max ? ` and ${paths.length - max} more` : ''}`
    })
    .filter(Boolean)
  return `Left out of the copy, ${parts.join('; ')}.`
}
