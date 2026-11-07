// The confirmations that guard project access and changes. A read grant
// belongs to one session, one provider and one project folder: a new session
// (or a /clear, which starts one) asks again, and so does every other provider.
import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { osName } from './platform'
import type { OsName } from './platform'
import { provider } from './registry'
import { DEFAULT_SETTINGS } from './state'

// state this file reads (the scan needs each atom declared in the file that uses it)
const settings = atom({ plugin: 'ai-subscriptions', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'st-1' })

/** `session|provider|folder` for each "Allow this session" answer. */
const readGrants = new Set<string>()

/** The session the request belongs to; '' when the engine cannot say, which matches no grant of a real session. */
export async function sessionKey($: EngineInterface): Promise<string> {
  try {
    return await $.session.id()
  } catch {
    return ''
  }
}

/**
 * One spelling per folder: separators made uniform and trailing ones dropped.
 * Windows and macOS file systems ignore case by default, so case is folded
 * there; on Linux `/A` and `/a` are different folders and keep their case.
 */
export function canonicalDir(os: OsName, dir: string): string {
  let d = dir.trim()
  if (os === 'windows') d = d.replace(/\//g, '\\')
  const sep = os === 'windows' ? '\\' : '/'
  while (d.length > 1 && d.endsWith(sep) && !(os === 'windows' && /^[a-z]:\\$/i.test(d))) d = d.slice(0, -1)
  return os === 'linux' ? d : d.toLowerCase()
}

/**
 * Where a folder really is: a symlink or junction followed to its target, so a
 * grant belongs to the folder itself and a link to another folder is asked
 * about on its own. A path the file system cannot resolve stays as written.
 */
export async function realDir($: EngineInterface, dir: string): Promise<string> {
  try {
    return (await $.fs.stat(dir, { resolve: true })).realPath ?? dir
  } catch {
    return dir
  }
}

/**
 * A project folder resolved once: `real` is where it leads, which is what is
 * approved and where the CLI then runs, so a link changed after the question
 * changes nothing; `shown` is how the question names it.
 */
export async function folder($: EngineInterface, dir: string): Promise<{ real: string; shown: string }> {
  const os = await osName($)
  const real = await realDir($, dir)
  return { real, shown: canonicalDir(os, real) === canonicalDir(os, dir) ? dir : `${dir} (which leads to ${real})` }
}

/** Asks the person in the engine's own dialog; a dismissed dialog is a no. */
async function confirm($: EngineInterface, question: string, options: string[]): Promise<string | undefined> {
  try {
    return await $.ui.ask(question, { options, header: 'AI Hub' })
  } catch {
    return undefined
  }
}

/** `dir` is a folder already resolved (`folder`); `shown` is how the question names it. */
export async function allowProjectRead($: EngineInterface, providerId: string, dir: string, shown = dir): Promise<boolean> {
  if (!(await read($, settings)).confirmProjectAccess) return true
  const session = await sessionKey($)
  const grant = `${session}|${providerId}|${canonicalDir(await osName($), dir)}`
  if (session && readGrants.has(grant)) return true
  const label = provider(providerId)?.label ?? providerId
  const answer = await confirm($, `Let ${label} read the files in ${shown}? Their contents go to that provider.`, [
    'Allow once',
    'Allow this session',
    'Deny',
  ])
  if (answer === 'Allow this session' && session) readGrants.add(grant)
  return answer === 'Allow once' || answer === 'Allow this session'
}

export async function allowWrite($: EngineInterface, providerId: string, dir: string, how: string, shown = dir): Promise<boolean> {
  const label = provider(providerId)?.label ?? providerId
  const answer = await confirm($, `Let ${label} change files in ${shown} (${how})? Nothing is committed.`, ['Allow', 'Deny'])
  return answer === 'Allow'
}

/** Drops every read grant of sessions other than this one (called as a session starts). */
export function forgetOtherSessions(session: string): void {
  for (const g of readGrants) if (!g.startsWith(`${session}|`)) readGrants.delete(g)
}
