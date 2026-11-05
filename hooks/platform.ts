// Which operating system the hub runs on, and the paths that differ by it.
import type { EngineInterface } from 'claude-code'

export type OsName = 'windows' | 'mac' | 'linux'

let cached: OsName | undefined

/** Windows by its own variables; otherwise `uname -s` tells macOS from Linux. */
export async function osName($: EngineInterface): Promise<OsName> {
  if ((await $.env.get('LOCALAPPDATA')) || (await $.env.get('OS')) === 'Windows_NT') return 'windows'
  if (cached) return cached
  try {
    const r = await $.process.run(['uname', '-s'], { timeoutMs: 5_000 })
    cached = /darwin/i.test(r.stdout) ? 'mac' : 'linux'
  } catch {
    cached = 'linux'
  }
  return cached
}

/** Joins path parts with the system's separator. */
export const joinPath = (os: OsName, ...parts: string[]): string =>
  os === 'windows' ? parts.join('\\') : parts.join('/').replace(/\/{2,}/g, '/')

/** The PATH list separator. */
export const pathSep = (os: OsName): string => (os === 'windows' ? ';' : ':')

export async function homeDir($: EngineInterface): Promise<string> {
  return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
}

export async function tempDir($: EngineInterface): Promise<string> {
  return (await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR'))?.replace(/\/$/, '') ?? ((await osName($)) === 'windows' ? '.' : '/tmp')
}
