// Finding and running the providers' official CLIs, and reading what they print.
import type { EngineInterface } from 'claude-code'

import type { Kind, Mode, Usage } from '../types'
import { homeDir, joinPath, osName, tempDir } from './platform'

/** Windows caps a command line near 32k characters (and other systems cap it too); agy takes its prompt as an argument. */
export const MAX_ARG_PROMPT = 30_000

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
export const clean = (s: string): string => s.replace(ANSI, '').replace(/\r/g, '').trim()
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function firstExisting($: EngineInterface, paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      if (await $.fs.exists(path)) return path
    } catch {
      // keep looking
    }
  }
  return undefined
}

/**
 * A CLI that npm installed as a Node script runs as `node <script>`: the
 * command line that starts it, by the script's path. Every other CLI starts
 * by its own path.
 */
const launchers = new Map<string, string[]>()
export const argvOf = (path: string): string[] => launchers.get(path) ?? [path]

/**
 * What an npm `.cmd` shim starts, read from the shim instead of running it
 * through a shell: a native `.exe` it names, or a Node script with the node
 * it would use. A shim whose target is gone (a removed build) gives nothing.
 */
export async function throughShim($: EngineInterface, shim: string): Promise<string | undefined> {
  let text: string
  try {
    text = await $.fs.read(shim)
  } catch {
    return undefined
  }
  const dir = dirOf(shim)
  const targets = [...text.matchAll(/"%~?dp0%?\\?([^"%]+)"/gi)]
    .map(m => `${dir}\\${(m[1] ?? '').replace(/^\\+/, '')}`)
    .filter(t => !/\\node(\.exe)?$/i.test(t))
  const target = targets[targets.length - 1]
  if (!target || !(await $.fs.exists(target).catch(() => false))) return undefined
  if (/\.exe$/i.test(target)) return target
  const local = `${dir}\\node.exe`
  const node = (await $.fs.exists(local).catch(() => false)) ? local : await onPath($, 'node')
  if (!node) return undefined
  launchers.set(target, [node, target])
  return target
}

/** Resolves a command through `where` (Windows) or `which`; a .cmd shim is followed to what it starts. */
export async function onPath($: EngineInterface, name: string): Promise<string | undefined> {
  for (const argv of [['where', name], ['which', name]]) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 10_000 })
      if (r.exitCode !== 0) continue
      const lines = r.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      const direct = lines.find(l => !/\.(cmd|bat)$/i.test(l))
      if (direct) return direct
      if (name === 'node') continue
      for (const shim of lines.filter(l => /\.cmd$/i.test(l))) {
        const found = await throughShim($, shim)
        if (found) return found
      }
    } catch {
      // try the next
    }
  }
  return undefined
}

/** How long a request may run before it is stopped: a test is short, a write gets the most. */
export function timeoutFor(type: string, mode: Mode): number {
  if (type === 'test') return 2 * 60_000
  if (mode === 'write') return 10 * 60_000
  return 5 * 60_000
}

export type ErrorKind = 'auth' | 'limit' | 'network' | 'timeout' | 'cancelled' | 'unavailable' | 'unknown'

/** What kind of failure a CLI's message describes; the words are a hint, so anything else is `unknown`. */
export function classifyError(message: string): ErrorKind {
  const m = message.toLowerCase()
  if (/rate.?limit|\b429\b|quota|usage limit|too many requests|limit reached|insufficient (balance|credit)/.test(m)) return 'limit'
  if (/\b401\b|\b403\b|unauthori[sz]ed|not logged in|not signed in|log ?in again|invalid (api )?key|authenticat/.test(m)) return 'auth'
  if (/enotfound|econnrefused|econnreset|etimedout|getaddrinfo|socket hang up|fetch failed|network|\b50[234]\b|service unavailable/.test(m)) return 'network'
  return 'unknown'
}

export const ERROR_LABEL: Record<ErrorKind, string> = {
  auth: 'sign-in problem',
  limit: 'limit reached',
  network: 'network problem',
  timeout: 'timed out',
  cancelled: 'stopped',
  unavailable: 'not available',
  unknown: 'error',
}

/** Whether a failed read-only request may go on to another provider: not after a stop or a timeout. */
export const mayFallBack = (kind: ErrorKind | undefined): boolean => kind !== 'cancelled' && kind !== 'timeout'

/** Where a kind's CLI lives on this machine, or undefined when it is not installed. */
export async function exe($: EngineInterface, kind: Kind): Promise<string | undefined> {
  const os = await osName($)
  if (os !== 'windows') {
    // the official installers' homes, then Homebrew and the usual bins, then PATH
    const home = await homeDir($)
    const name = kind === 'codex' ? 'codex' : kind === 'agy' ? 'agy' : 'opencode'
    const own: Record<string, string[]> = {
      codex: os === 'mac' ? ['/Applications/Codex.app/Contents/Resources/codex'] : [],
      agy: [`${home}/.agy/bin/agy`],
      opencode: [`${home}/.opencode/bin/opencode`],
    }
    return (
      (await firstExisting($, [...(own[name] ?? []), `${home}/.local/bin/${name}`, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`])) ??
      onPath($, name)
    )
  }
  const local = (await $.env.get('LOCALAPPDATA')) ?? ''
  if (kind === 'codex') {
    const bin = `${local}\\OpenAI\\Codex\\bin`
    try {
      const dirs = (await $.fs.list(bin)).filter(d => d.kind === 'dir')
      const found = await firstExisting($, dirs.map(d => `${bin}\\${d.name}\\codex.exe`))
      if (found) return found
    } catch {
      // not the desktop app's install
    }
    return onPath($, 'codex')
  }
  if (kind === 'agy') return (await firstExisting($, [`${local}\\agy\\bin\\agy.exe`])) ?? onPath($, 'agy')
  return (
    (await firstExisting($, [`${local}\\Programs\\@opencodedesktop\\resources\\opencode-cli.exe`])) ??
    onPath($, 'opencode')
  )
}

export const dirOf = (path: string): string => path.replace(/[\\/][^\\/]*$/, '')

/** An empty folder the read-only requests run in, so no agent reads project files unasked. */
export async function sandboxDir($: EngineInterface): Promise<string> {
  const os = await osName($)
  const dir = joinPath(os, await tempDir($), 'jervis-ai-hub', 'sandbox')
  try {
    const readme = joinPath(os, dir, 'README.txt')
    if (!(await $.fs.exists(readme))) {
      await $.fs.write(readme, 'Jervis AI Hub runs read-only requests here so no project files are read.\n')
    }
  } catch {
    // the CLI then runs wherever the process starts
  }
  return dir
}

export type Invocation = { argv: string[]; stdin?: string; env?: Record<string, string> }

/**
 * Antigravity, read-only: settings for this run only (`--settings`, never
 * saved). Deny wins over any allow rule in the person's own settings, so the
 * agent cannot write, run a command, call an MCP tool or open the web. Reads
 * inside the folder stay allowed; a read outside it needs approval, which
 * headless mode cannot give, so it is refused.
 */
export const AGY_READ_SETTINGS = JSON.stringify({
  permissions: { deny: ['write_file(*)', 'command(*)', 'mcp(*)', 'read_url(*)', 'execute_url(*)'] },
})

/**
 * OpenCode, read-only (`OPENCODE_CONFIG_CONTENT`): OpenCode's own default
 * allows every tool, writes and paths outside the folder included, so a
 * read-only request denies everything, then allows reading, globbing and
 * searching, then denies every folder outside the one it runs in. The last
 * matching rule wins; these come after a project's opencode.json.
 */
export const OPENCODE_READ_CONFIG = JSON.stringify({
  permissions: [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'read', resource: '*', effect: 'allow' },
    { action: 'glob', resource: '*', effect: 'allow' },
    { action: 'grep', resource: '*', effect: 'allow' },
    { action: 'external_directory', resource: '*', effect: 'deny' },
  ],
})

/** OpenCode, a write the person allowed for one folder: nothing outside that folder. */
export const OPENCODE_WRITE_CONFIG = JSON.stringify({
  permissions: [{ action: 'external_directory', resource: '*', effect: 'deny' }],
})

/** The argument vector for one request; prompts go on stdin wherever the CLI reads it. */
export function invocation(
  kind: Kind,
  path: string,
  prompt: string,
  mode: Mode,
  model: string | undefined,
  effort?: string,
): Invocation {
  if (kind === 'codex') {
    return {
      argv: [...argvOf(path), 'exec', '--json', '--skip-git-repo-check', '-s', mode === 'write' ? 'workspace-write' : 'read-only', ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []), '-'],
      stdin: prompt,
    }
  }
  if (kind === 'agy') {
    return {
      argv: [
        ...argvOf(path),
        '--output-format',
        'json',
        ...(model ? ['--model', model] : []),
        ...(mode === 'write' ? ['--mode', 'accept-edits'] : ['--settings', AGY_READ_SETTINGS]),
        `-p=${prompt}`,
      ],
    }
  }
  return {
    argv: [...argvOf(path), 'run', '--standalone', '--format', 'json', ...(model ? ['-m', model] : []), ...(mode === 'write' ? ['--auto'] : [])],
    stdin: prompt,
    env: { OPENCODE_CONFIG_CONTENT: mode === 'write' ? OPENCODE_WRITE_CONFIG : OPENCODE_READ_CONFIG },
  }
}

/** Reads the tokens and cost OpenCode recorded for one session (`opencode session export <id>`). */
export function parseOpencodeExport(stdout: string): Usage | undefined {
  try {
    const info = (JSON.parse(stdout) as { info?: Record<string, unknown> }).info
    if (!info) return undefined
    const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    const t = (info.tokens ?? {}) as Record<string, unknown>
    const cache = (t.cache ?? {}) as Record<string, unknown>
    return {
      inputTokens: n(t.input),
      outputTokens: n(t.output),
      cachedTokens: n(cache.read),
      reasoningTokens: n(t.reasoning),
      costUsd: n(info.cost),
    }
  } catch {
    return undefined
  }
}

export type Parsed = { isOk: boolean; text: string; usage?: Usage; error?: string; /** OpenCode's session id, to read the cost it recorded */ sessionId?: string }

/** Reads a CLI's JSON output into the answer, the usage it reported and any error. */
export function parse(kind: Kind, stdout: string, stderr: string, exitCode: number): Parsed {
  const lines = clean(stdout).split('\n').map(l => l.trim()).filter(Boolean)
  const json = (l: string): Record<string, unknown> | undefined => {
    try {
      const v = JSON.parse(l) as unknown
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  let text = ''
  let usage: Usage | undefined
  let error: string | undefined
  let sessionId: string | undefined

  if (kind === 'codex') {
    for (const l of lines) {
      const d = json(l)
      if (!d) continue
      const item = d.item as Record<string, unknown> | undefined
      if (d.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') text = item.text
      if (d.type === 'turn.completed' && d.usage && typeof d.usage === 'object') {
        const u = d.usage as Record<string, unknown>
        usage = {
          inputTokens: num(u.input_tokens),
          outputTokens: num(u.output_tokens),
          cachedTokens: num(u.cached_input_tokens),
          reasoningTokens: num(u.reasoning_output_tokens),
        }
      }
      if (d.type === 'error' || d.type === 'turn.failed') {
        const err = (d.error as Record<string, unknown> | undefined)?.message ?? d.message
        error = typeof err === 'string' ? err : JSON.stringify(d).slice(0, 400)
      }
    }
    // a transient error event (a reconnect) followed by a completed turn is not a failure
    if (text && usage && exitCode === 0) error = undefined
  } else if (kind === 'agy') {
    const d = json(lines.join('\n')) ?? json(lines[lines.length - 1] ?? '')
    if (d) {
      if (typeof d.response === 'string') text = d.response.trim()
      if (d.status !== 'SUCCESS') error = typeof d.error === 'string' ? d.error : `status ${String(d.status)}`
      if (d.usage && typeof d.usage === 'object') {
        const u = d.usage as Record<string, unknown>
        usage = {
          inputTokens: num(u.input_tokens),
          outputTokens: num(u.output_tokens),
          cachedTokens: num(u.cache_read_tokens),
          reasoningTokens: num(u.thinking_tokens),
        }
      }
    }
  } else {
    const parts: string[] = []
    for (const l of lines) {
      const d = json(l)
      if (!d) continue
      const part = d.part as Record<string, unknown> | undefined
      if (!sessionId && typeof d.sessionID === 'string') sessionId = d.sessionID
      if (d.type === 'text' && typeof part?.text === 'string') parts.push(part.text)
      if (d.type === 'error') {
        const err = (d.error as Record<string, unknown> | undefined)?.data ?? d.error ?? d.message
        error = typeof err === 'string' ? err : JSON.stringify(err).slice(0, 400)
      }
    }
    text = parts.join('').trim()
  }

  if (!text && !error && lines.length && !lines.some(l => json(l))) text = lines.join('\n')
  if (exitCode !== 0 && !error) error = `exit ${exitCode}: ${clean(stderr).split('\n').slice(-6).join(' ')}`
  if (!text && !error) error = 'the CLI returned no answer'
  return { isOk: !error && text.length > 0, text, usage, error, sessionId }
}
