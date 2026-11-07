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

async function git($: EngineInterface, repo: string, args: string[]): Promise<string | undefined> {
  try {
    const r = await $.process.run(['git', '-C', repo, ...args], { timeoutMs: 20_000 })
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
    probe = await $.process.run(['git', '-C', repo, 'rev-parse', '--is-inside-work-tree'], { timeoutMs: 20_000 })
  } catch {
    probe = undefined
  }
  if (probe?.exitCode === 0 && probe.stdout.trim() !== 'true') return { isRepo: false, refs: {} }
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
