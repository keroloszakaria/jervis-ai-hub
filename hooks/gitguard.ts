// GitGuard: keeps a delegation from committing or pushing, and checks it did not.
//
// Two layers. Before: the relay runs with git config set through the
// environment (GIT_CONFIG_COUNT), so every git the agent starts loads hooks
// that refuse any ref change (reference-transaction, which --no-verify does not
// skip) and sends every push to a remote helper that does not exist. After: the
// hub reads the repository's refs itself and compares them with what it read
// before, so a change that slipped past the first layer (an agent that clears
// its environment, or edits .git by hand) is still found and reported. The hub
// never undoes anything on its own: it says what changed and how to undo it.
import type { EngineInterface } from 'claude-code'

import { joinPath, osName, type OsName, tempDir } from './platform'

export type RefSnapshot = {
  isRepo: boolean
  head?: string
  /** the branch HEAD points at; undefined when detached */
  branch?: string
  /** every ref (branches, tags, remote-tracking, stash) and the object it names */
  refs: Record<string, string>
  /** why the refs could not be read, when the folder is (or may be) a repository: nothing is known */
  failed?: string
}

const HOOK_REFUSE = (what: string) =>
  `#!/bin/sh\necho "Jervis AI Hub: ${what} is not allowed during a delegation; leave the changes uncommitted for review." >&2\nexit 1\n`

/** The hooks a guarded git loads, by file name. */
export const GUARD_HOOKS: Record<string, string> = {
  // runs on every ref update, and --no-verify does not skip it
  'reference-transaction':
    '#!/bin/sh\n[ "$1" = prepared ] || exit 0\necho "Jervis AI Hub: a delegation may not change git refs (no commit, branch, stash, merge, reset or fetch); leave the changes uncommitted for review." >&2\nexit 1\n',
  'pre-commit': HOOK_REFUSE('committing'),
  'pre-merge-commit': HOOK_REFUSE('merging'),
  'pre-rebase': HOOK_REFUSE('rebasing'),
  'pre-push': HOOK_REFUSE('pushing'),
}

/** The URL scheme every push is rewritten to: git has no helper for it, so the push fails. */
export const BLOCKED_SCHEME = 'jervis-blocked://'

/** Read-only git on the user's repository: no fsmonitor hook, no paging, paths as they are. */
export const SAFE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-c', 'core.untrackedCache=false', '--no-pager']

async function git($: EngineInterface, repo: string, args: string[]): Promise<string | undefined> {
  try {
    const r = await $.process.run(['git', ...SAFE_GIT, '-C', repo, ...args], { timeoutMs: 20_000 })
    return r.exitCode === 0 ? r.stdout : undefined
  } catch {
    return undefined
  }
}

/** The folder that holds `dir`, or undefined at the top of the file system. */
export function parentOf(os: OsName, dir: string): string | undefined {
  const sep = os === 'windows' ? '\\' : '/'
  const d = os === 'windows' ? dir.replace(/\//g, '\\') : dir
  if (os === 'windows' ? /^[a-z]:\\?$/i.test(d) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(d) : d === '/') return undefined
  const trimmed = d.length > 1 ? d.replace(/[\\/]+$/, '') : d
  const at = trimmed.lastIndexOf(sep)
  if (at < 0) return undefined
  if (os !== 'windows' && at === 0) return '/'
  const up = trimmed.slice(0, at)
  return os === 'windows' && /^[a-z]:$/i.test(up) ? `${up}\\` : up
}

/**
 * Whether `dir` or any folder above it has a `.git` (a folder, or the file a
 * worktree or submodule keeps), the way git itself looks. A check that cannot
 * be made counts as yes: an unreadable folder must not let a write run unguarded.
 */
export async function gitAbove($: EngineInterface, os: OsName, dir: string): Promise<boolean> {
  let d: string | undefined = os === 'windows' ? dir.replace(/\//g, '\\') : dir
  for (let i = 0; d !== undefined && i < 256; i++) {
    if (await $.fs.exists(joinPath(os, d.replace(/[\\/]+$/, ''), '.git')).catch(() => true)) return true
    d = parentOf(os, d)
  }
  return d !== undefined
}

/**
 * What the repository's refs are now, read by the hub's own git, without the
 * guard. A folder git calls "not a git repository" is not one. Any other
 * failure (git missing or timing out, an unsafe-ownership refusal, refs that
 * cannot be listed) in a folder with a .git in it or above it is `failed`: a write there must
 * not run unchecked.
 */
export async function snapshot($: EngineInterface, repo: string): Promise<RefSnapshot> {
  let probe: { exitCode: number; stdout: string; stderr: string } | undefined
  try {
    probe = await $.process.run(['git', ...SAFE_GIT, '-C', repo, 'rev-parse', '--is-inside-work-tree'], { timeoutMs: 20_000 })
  } catch {
    probe = undefined
  }
  // "false": a bare repository or inside .git, which still has refs to guard
  if (probe && probe.exitCode !== 0 && /not a git repository/i.test(probe.stderr)) return { isRepo: false, refs: {} }
  if (!probe || probe.exitCode !== 0) {
    if (!(await gitAbove($, await osName($), repo))) return { isRepo: false, refs: {} }
    const why = probe ? (probe.stderr.trim().split(/\r?\n/)[0] ?? '') || `git exited with ${probe.exitCode}` : 'git could not run'
    return { isRepo: true, refs: {}, failed: why }
  }
  const head = (await git($, repo, ['rev-parse', '--verify', '-q', 'HEAD']))?.trim() || undefined
  const branch = (await git($, repo, ['symbolic-ref', '-q', '--short', 'HEAD']))?.trim() || undefined
  const listed = await git($, repo, ['for-each-ref', '--format=%(objectname) %(refname)'])
  if (listed === undefined) return { isRepo: true, refs: {}, failed: 'its refs could not be listed' }
  return { isRepo: true, head, branch, refs: parseRefs(listed) }
}

/** `for-each-ref --format='%(objectname) %(refname)'` lines, as a map from ref to object. */
export function parseRefs(out: string): Record<string, string> {
  const refs: Record<string, string> = {}
  for (const line of out.split(/\r?\n/)) {
    const m = /^([0-9a-f]{7,64}) (\S+)$/.exec(line.trim())
    if (m) refs[m[2]!] = m[1]!
  }
  return refs
}

const short = (sha?: string) => (sha ? sha.slice(0, 7) : 'none')

/** Every way the refs differ, in words; empty when nothing changed. */
export function refChanges(before: RefSnapshot, after: RefSnapshot): string[] {
  if (after.failed) return [`the refs could not be read afterwards (${after.failed}), so whether they changed is unknown`]
  if (!before.isRepo || !after.isRepo) return before.isRepo === after.isRepo ? [] : ['the folder stopped (or started) being a git repository']
  const out: string[] = []
  if (before.head !== after.head) out.push(`HEAD moved from ${short(before.head)} to ${short(after.head)}`)
  if (before.branch !== after.branch) out.push(`HEAD switched from ${before.branch ?? 'a detached HEAD'} to ${after.branch ?? 'a detached HEAD'}`)
  for (const ref of new Set([...Object.keys(before.refs), ...Object.keys(after.refs)])) {
    const a = before.refs[ref]
    const b = after.refs[ref]
    if (a === b) continue
    out.push(!a ? `${ref} was created at ${short(b)}` : !b ? `${ref} was deleted (it was ${short(a)})` : `${ref} moved from ${short(a)} to ${short(b)}`)
  }
  return out
}

/** What the agent is told while refs are locked. */
export const LOCK_NOTE =
  'Git refs are locked while you work: commit, branch, stash, merge, reset, fetch and push will fail. Leave every change uncommitted for review.'

/**
 * The lines that refuse a run whose refs changed: each change, how to keep the
 * work as uncommitted changes, and that a push cannot be seen from here.
 */
export function refusal(before: RefSnapshot, after: RefSnapshot, changed: string[]): string[] {
  const undo = undoHint(before, after)
  return [...changed.map(c => `- ${c}`), ...(undo ? [undo] : []), 'The hub undid nothing. A push cannot be undone from here: check the remote yourself.']
}

/** How to put the branch back, keeping the agent's work as uncommitted changes. */
export function undoHint(before: RefSnapshot, after: RefSnapshot): string | undefined {
  if (!before.head || before.head === after.head || before.branch !== after.branch) return undefined
  return `To keep the work but drop the commits, run: git reset --soft ${before.head}`
}

/**
 * Writes the guard's hooks and answers the variables that make every git the
 * relay starts load them. Variables already set (GIT_CONFIG_COUNT) are kept:
 * the guard's entries go after them.
 */
export async function guardEnv($: EngineInterface, os: OsName): Promise<Record<string, string>> {
  const dir = joinPath(os, await tempDir($), 'jervis-ai-hub', 'git-guard')
  for (const [name, text] of Object.entries(GUARD_HOOKS)) await $.fs.write(joinPath(os, dir, name), text)
  if (os !== 'windows') {
    // a hook runs only when it is executable; Git for Windows runs it through its own sh
    await $.process.run(['chmod', '+x', ...Object.keys(GUARD_HOOKS).map(n => joinPath(os, dir, n))], { timeoutMs: 10_000 }).catch(() => undefined)
  }
  const had = Number.parseInt((await $.env.get('GIT_CONFIG_COUNT')) ?? '0', 10)
  const n = Number.isFinite(had) && had > 0 ? had : 0
  return {
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: 'core.hooksPath',
    [`GIT_CONFIG_VALUE_${n}`]: os === 'windows' ? dir.replace(/\\/g, '/') : dir,
    // an empty prefix matches every URL, so every push goes to a helper git does not have
    [`GIT_CONFIG_KEY_${n + 1}`]: `url.${BLOCKED_SCHEME}.pushInsteadOf`,
    [`GIT_CONFIG_VALUE_${n + 1}`]: '',
  }
}

/** The working tree's changed and untracked files, each with its status and content hash. */
export type WorkState = {
  files: Record<string, string>
  isPartial: boolean
  /** the repository's own config and attributes as read before git ran: a change to them can make git run a program */
  guard?: string
  /** the config or attributes changed since the reading this one was compared with, so git was not run again */
  isGuardChanged?: boolean
}

/** Files of the repository that can make git run a program (a filter, a hook command): read as text, never by git. */
const GUARD_FILES = ['config', 'info/attributes']

async function guardOf($: EngineInterface, top: string): Promise<string> {
  const gitDir = (await git($, top, ['rev-parse', '--absolute-git-dir']))?.trim()
  if (!gitDir) return ''
  const os = await osName($)
  const parts: string[] = []
  for (const f of [...GUARD_FILES.map(x => joinPath(os, gitDir, ...x.split('/'))), joinPath(os, top, '.gitattributes')]) {
    let text = ''
    try {
      text = await $.fs.read(f)
    } catch {
      text = '<none>'
    }
    parts.push(`${f}\u0000${text}`)
  }
  return parts.join('\u0001')
}

/** At most this many changed files are compared; past it the list is marked partial. */
export const MAX_WORK_FILES = 5000

/** `git status --porcelain=v1 -z` entries as path to status; a rename or copy names both paths. */
export function parseStatus(out: string): Record<string, string> {
  const files: Record<string, string> = {}
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!
    if (e.length < 4) continue
    const xy = e.slice(0, 2)
    files[e.slice(3)] = xy
    // the old path of a rename or copy follows it
    if (/[RC]/.test(xy) && i + 1 < parts.length) files[parts[++i]!] = 'from'
  }
  return files
}

/**
 * What the working tree holds, read by the hub's own git: every changed or
 * untracked file, with its status and content hash, so a file the agent
 * changed again is told apart from one already changed before. Undefined
 * outside a repository or when git cannot say.
 */
export async function workState($: EngineInterface, repo: string, before?: WorkState): Promise<WorkState | undefined> {
  const top = (await git($, repo, ['rev-parse', '--show-toplevel']))?.trim()
  if (!top) return undefined
  const guard = await guardOf($, top)
  // a run that changed what git runs (a new filter in .git/config): the hub's git is not run on it
  if (before?.guard !== undefined && before.guard !== guard) return { files: before.files, isPartial: before.isPartial, guard, isGuardChanged: true }
  const out = await git($, top, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (out === undefined) return undefined
  const status = parseStatus(out)
  const paths = Object.keys(status).filter(p => !p.includes('\n'))
  const isPartial = paths.length > MAX_WORK_FILES
  const listed = paths.slice(0, MAX_WORK_FILES)
  const present = listed.filter(p => !/D/.test(status[p]!) && status[p] !== 'from' && !p.endsWith('/'))
  let hashes: string[] = []
  if (present.length) {
    try {
      const r = await $.process.run(['git', ...SAFE_GIT, '-C', top, 'hash-object', '--no-filters', '--stdin-paths'], { stdin: `${present.join('\n')}\n`, timeoutMs: 60_000 })
      if (r.exitCode === 0) hashes = r.stdout.split(/\r?\n/)
    } catch {
      // statuses alone, below
    }
  }
  const hashOf = new Map(present.map((p, i) => [p, hashes[i] ?? ''] as const))
  const files: Record<string, string> = {}
  for (const p of listed) files[p] = `${status[p]}:${hashOf.get(p) ?? ''}`
  return { files, isPartial, guard }
}

/** The files whose status or content differs between two readings, sorted. */
export function changedFiles(before: WorkState, after: WorkState): string[] {
  const out = new Set<string>()
  for (const p of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    if (before.files[p] !== after.files[p]) out.add(p)
  }
  return [...out].sort()
}

/** The changed files in words, for the answer: listed by the hub, never by the agent. */
export function filesLine(before: WorkState | undefined, after: WorkState | undefined): string {
  if (!before || !after) return 'The hub cannot list the changed files here (not a git repository): check the folder yourself.'
  if (after.isGuardChanged) return "The repository's git config or attributes (.git/config, .git/info/attributes or .gitattributes) changed during the run, so the hub did not run git on it again and cannot list the changed files: check those files, and the folder, yourself before running git."
  const files = changedFiles(before, after)
  const partial = before.isPartial || after.isPartial ? ` The working tree has more than ${MAX_WORK_FILES} changed files, so this list may be short.` : ''
  if (!files.length) return `No files changed (as read by the hub's own git).${partial}`
  // before and after: what anyone changed in between is in the list, not the agent's work alone
  const who = 'It holds every change made while the run was going, by anyone: one you or another program made then is listed too.'
  return `Files changed, as read by the hub's own git (review before committing):\n${files.map(f => `- ${f}`).join('\n')}\n${who}${partial}`
}
