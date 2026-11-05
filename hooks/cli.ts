// Finding and running the providers' official CLIs, and reading what they print.
import type { EngineInterface } from 'claude-code'

import type { Kind, Mode, Usage } from '../types'
import { homeDir, joinPath, osName, tempDir } from './platform'

export const TIMEOUT = 10 * 60 * 1000
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

/** Resolves a command through `where` (Windows) or `which`, skipping .cmd shims that may point at removed builds. */
export async function onPath($: EngineInterface, name: string): Promise<string | undefined> {
  for (const argv of [['where', name], ['which', name]]) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 10_000 })
      const line = r.stdout
        .split(/\r?\n/)
        .map(l => l.trim())
        .find(l => l && !/\.(cmd|bat)$/i.test(l))
      if (r.exitCode === 0 && line) return line
    } catch {
      // try the next
    }
  }
  return undefined
}

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

export type Invocation = { argv: string[]; stdin?: string }

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
      argv: [path, 'exec', '--json', '--skip-git-repo-check', '-s', mode === 'write' ? 'workspace-write' : 'read-only', ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []), '-'],
      stdin: prompt,
    }
  }
  if (kind === 'agy') {
    return {
      argv: [path, '--output-format', 'json', ...(model ? ['--model', model] : []), ...(mode === 'write' ? ['--mode', 'accept-edits'] : []), `-p=${prompt}`],
    }
  }
  return {
    argv: [path, 'run', '--standalone', '--format', 'json', ...(model ? ['-m', model] : []), ...(mode === 'write' ? ['--auto'] : [])],
    stdin: prompt,
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
