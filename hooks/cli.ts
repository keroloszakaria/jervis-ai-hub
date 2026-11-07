// Finding and running the providers' official CLIs, and reading what they print.
import type { EngineInterface } from 'claude-code'

import type { Kind, Mode, Usage } from '../types'
import { homeDir, joinPath, osName, tempDir } from './platform'
import type { OsName } from './platform'

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

export type ErrorKind = 'auth' | 'limit' | 'network' | 'timeout' | 'cancelled' | 'unavailable' | 'policy' | 'unknown'

/** A failure as a CLI reported it: its words, and the HTTP status or error name its JSON carried, when it carried one. */
export type Failure = { message: string; status?: number; name?: string }

/**
 * What kind of failure a CLI reported. A status or an error name in its JSON
 * decides first; the words are a hint after that, so anything else is `unknown`.
 */
export function classifyError(f: string | Failure): ErrorKind {
  const { message, status, name } = typeof f === 'string' ? { message: f, status: undefined, name: undefined } : f
  if (status === 429) return 'limit'
  if (status === 401 || status === 403) return 'auth'
  if (status === 408 || (status !== undefined && status >= 500 && status <= 599)) return 'network'
  if (name && /auth/i.test(name)) return 'auth'
  const m = message.toLowerCase()
  if (/rate.?limit|\b429\b|quota|usage limit|too many requests|limit reached|insufficient (balance|credit)/.test(m)) return 'limit'
  if (/\b401\b|\b403\b|unauthori[sz]ed|not logged in|not signed in|log ?in again|invalid (api )?key|authenticat/.test(m)) return 'auth'
  if (/enotfound|econnrefused|econnreset|etimedout|getaddrinfo|socket hang up|fetch failed|network|\b50[234]\b|service unavailable/.test(m)) return 'network'
  if (/\benoent\b|command not found|is not recognized as/.test(m)) return 'unavailable'
  return 'unknown'
}

export const ERROR_LABEL: Record<ErrorKind, string> = {
  auth: 'sign-in problem',
  limit: 'limit reached',
  network: 'network problem',
  timeout: 'timed out',
  cancelled: 'stopped',
  unavailable: 'not available',
  policy: 'refused',
  unknown: 'error',
}

/**
 * The failures another provider may be tried after: the provider was at its
 * limit, could not be reached, or could not take the request. A sign-in
 * problem, a refusal, an unknown error, a stop or a timeout ends the request:
 * another provider would not fix it, and the prompt must not travel on a guess.
 */
const RETRYABLE: ReadonlySet<ErrorKind> = new Set<ErrorKind>(['limit', 'network', 'unavailable'])

/** Whether a failed read-only request may go on to another provider. */
export const mayFallBack = (kind: ErrorKind | undefined): boolean => kind !== undefined && RETRYABLE.has(kind)

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

/**
 * OpenCode, a write the person allowed for one folder: its file tools only,
 * inside that folder. A denial of outside folders alone is not enough: checked
 * on 2.1.4, the model wrote outside through its shell, and through its
 * `execute` tool, which moved the session to another folder. So everything is
 * denied, then reading, searching, editing and writing are allowed, then every
 * folder outside is denied. It runs no commands.
 */
export const OPENCODE_WRITE_CONFIG = JSON.stringify({
  permissions: [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'read', resource: '*', effect: 'allow' },
    { action: 'glob', resource: '*', effect: 'allow' },
    { action: 'grep', resource: '*', effect: 'allow' },
    { action: 'edit', resource: '*', effect: 'allow' },
    { action: 'write', resource: '*', effect: 'allow' },
    { action: 'external_directory', resource: '*', effect: 'deny' },
  ],
})

/** The argument vector for one request; prompts go on stdin wherever the CLI reads it. */
export function invocation(
  kind: Kind,
  path: string,
  prompt: string,
  mode: Mode,
  model: string | undefined,
  effort?: string,
  /** Codex: the hub's permission profile on this system, or its older sandbox mode when that is undefined */
  codexOs?: OsName,
): Invocation {
  if (kind === 'codex') {
    // the profile holds reads and writes to the folder; the older `-s` modes hold writes only
    const sandbox = codexOs ? codexProfileArgs(codexOs, mode) : ['-s', mode === 'write' ? 'workspace-write' : 'read-only']
    return {
      argv: [...argvOf(path), 'exec', '--json', '--skip-git-repo-check', ...sandbox, ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []), '-'],
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

export type Parsed = {
  isOk: boolean
  text: string
  usage?: Usage
  error?: string
  /** the HTTP status and error name the CLI's error event carried, when it carried them */
  status?: number
  errorName?: string
  /** OpenCode's session id, to read the cost it recorded */
  sessionId?: string
}

/** An HTTP status a CLI's error object names, under the keys the CLIs use. */
function statusIn(o: unknown): number | undefined {
  if (!o || typeof o !== 'object') return undefined
  const r = o as Record<string, unknown>
  for (const k of ['statusCode', 'status_code', 'status', 'httpStatus']) {
    const v = r[k]
    if (typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599) return v
  }
  return undefined
}

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
  let status: number | undefined
  let errorName: string | undefined
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
        const e = d.error as Record<string, unknown> | undefined
        const err = e?.message ?? d.message
        error = typeof err === 'string' ? err : JSON.stringify(d).slice(0, 400)
        status = statusIn(e) ?? statusIn(d)
      }
    }
    // a transient error event (a reconnect) followed by a completed turn is not a failure
    if (text && usage && exitCode === 0) {
      error = undefined
      status = undefined
    }
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
        const e = d.error as Record<string, unknown> | undefined
        const err = e?.data ?? d.error ?? d.message
        error = typeof err === 'string' ? err : JSON.stringify(err).slice(0, 400)
        status = statusIn(e?.data) ?? statusIn(e)
        if (typeof e?.name === 'string') errorName = e.name
      }
    }
    text = parts.join('').trim()
  }

  if (!text && !error && lines.length && !lines.some(l => json(l))) text = lines.join('\n')
  if (exitCode !== 0 && !error) error = `exit ${exitCode}: ${clean(stderr).split('\n').slice(-6).join(' ')}`
  if (!text && !error) error = 'the CLI returned no answer'
  return { isOk: !error && text.length > 0, text, usage, error, ...(error && status ? { status } : {}), ...(error && errorName ? { errorName } : {}), sessionId }
}

/** The first x.y.z in a CLI's --version output ("opencode v2.1.4", "1.5.3"). */
export function parseVersion(text: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}

/**
 * The CLI versions whose isolation rules the hub has checked on a real run.
 * OpenCode reads `permissions` (an array) from 2.0 on; 1.x reads `permission`
 * and would ignore the hub's rules, so its requests would run unconfined.
 * Antigravity's --settings deny rules were checked on 1.5.
 */
const TESTED: Partial<Record<Kind, { label: string; modes: Mode[]; isOk: (v: [number, number, number]) => boolean; range: string }>> = {
  'opencode-free': { label: 'OpenCode', modes: ['read', 'write'], isOk: v => v[0] === 2, range: '2.x' },
  'opencode-key': { label: 'OpenCode', modes: ['read', 'write'], isOk: v => v[0] === 2, range: '2.x' },
  agy: { label: 'Antigravity', modes: ['read'], isOk: v => v[0] === 1 && v[1] >= 5, range: '1.5 or a later 1.x' },
}

const versions = new Map<string, string>()

/**
 * Why a request on this CLI may not run, when the hub cannot confirm its
 * isolation rules hold for the installed version; undefined when it can (or
 * the CLI keeps its own sandbox, as Codex does).
 */
export async function isolationProblem($: EngineInterface, kind: Kind, path: string, mode: Mode): Promise<string | undefined> {
  const t = TESTED[kind]
  if (!t || !t.modes.includes(mode)) return undefined
  let out = versions.get(path)
  if (out === undefined) {
    try {
      const r = await $.process.run([...argvOf(path), '--version'], { timeoutMs: 20_000 })
      out = clean(r.stdout || r.stderr).split('\n')[0] ?? ''
    } catch {
      out = ''
    }
    if (out) versions.set(path, out)
  }
  const v = parseVersion(out)
  if (v && t.isOk(v)) return undefined
  const what = mode === 'read' ? 'read-only' : 'write'
  return `${t.label} ${v ? v.join('.') : '(its version could not be read)'} is not a version whose ${what} limits the hub has checked (${t.range}), so nothing was sent. Install ${t.label} ${t.range}.`
}

/** The exact versions the isolation rules were checked on by hand (SECURITY.md, Checked versions). */
export const CHECKED: Partial<Record<Kind, string>> = { 'opencode-free': '2.1.4', 'opencode-key': '2.1.4', agy: '1.5.3' }

/**
 * How a CLI's version stands with the hub, for Diagnostics: checked, allowed
 * but not checked itself, or refused. Undefined for a CLI the hub has no rules
 * for (Codex keeps its own sandbox).
 */
export function versionNote(kind: Kind, versionText: string): string | undefined {
  const t = TESTED[kind]
  if (!t) return undefined
  const v = parseVersion(versionText)
  if (!v || !t.isOk(v)) return `refused: the hub's rules were checked on ${t.range} only`
  const seen = v.join('.')
  return seen === CHECKED[kind] ? 'checked' : `allowed, not checked itself (checked on ${CHECKED[kind]})`
}

/**
 * Codex permission profiles (`-c`, for one run): every path denied, then the
 * runtime's minimal paths readable, then the run's folder readable (read-only)
 * or writable (write). Codex's OS sandbox enforces them: MXC on Windows,
 * Seatbelt on macOS, bubblewrap on Linux. They must not be mixed with
 * `--sandbox`, which would win over them.
 */
export const CODEX_PROFILES = {
  read: { name: 'hubread', rules: '{":root"="deny",":minimal"="read",":workspace_roots"={"."="read"}}' },
  write: { name: 'hubwrite', rules: '{":root"="deny",":minimal"="read",":workspace_roots"={"."="write"}}' },
} as const

/** The `-c` arguments that put one Codex run under the hub's profile for its mode. */
export function codexProfileArgs(os: OsName, mode: Mode): string[] {
  const p = CODEX_PROFILES[mode === 'write' ? 'write' : 'read']
  return [
    // on Windows only MXC can deny reads: the legacy elevated sandbox refuses these profiles
    ...(os === 'windows' ? ['-c', 'windows.sandbox="mxc"'] : []),
    '-c',
    `permissions.${p.name}.filesystem=${p.rules}`,
    '-c',
    `default_permissions="${p.name}"`,
  ]
}

export type CodexIsolation = { isOk: true } | { isOk: false; why: string }
// one probe per Codex build: runs that start together share it, since each probe rewrites the same files
const codexProbes = new Map<string, Promise<CodexIsolation>>()

/**
 * Whether Codex's sandbox holds a run to its folder on this machine: a probe
 * through `codex sandbox` (commands only, no model, nothing sent) with each of
 * the hub's profiles must read a file in its folder and must not read one the
 * hub put outside it. Cached per Codex build; any failure is a refusal.
 */
export async function codexIsolation($: EngineInterface, path: string): Promise<CodexIsolation> {
  let v = versions.get(path)
  if (v === undefined) {
    try {
      const r = await $.process.run([...argvOf(path), '--version'], { timeoutMs: 20_000 })
      v = clean(r.stdout || r.stderr).split('\n')[0] ?? ''
    } catch {
      v = ''
    }
    if (v) versions.set(path, v)
  }
  const key = `${path}|${v}`
  const known = codexProbes.get(key)
  if (known) return known
  const probe = probeCodex($, path)
  codexProbes.set(key, probe)
  const result = await probe
  // a probe that could not run at all is tried again next time; a held or a refused profile is kept
  if (!result.isOk && result.why.startsWith("Codex's sandbox could not be checked")) codexProbes.delete(key)
  return result
}

async function probeCodex($: EngineInterface, path: string): Promise<CodexIsolation> {
  const os = await osName($)
  const base = joinPath(os, await homeDir($), '.claude', 'jervis-ai-hub', 'probe')
  const work = joinPath(os, base, 'work')
  const inside = joinPath(os, work, 'inside.txt')
  const outside = joinPath(os, base, 'outside', 'secret.txt')
  const reader = (file: string): string[] =>
    os === 'windows' ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `Get-Content -LiteralPath '${file.replace(/'/g, "''")}'`] : ['cat', file]
  let result: CodexIsolation = { isOk: true }
  try {
    for (const mode of ['read', 'write'] as const) {
      const a = `in-${Math.random().toString(36).slice(2)}`
      const b = `out-${Math.random().toString(36).slice(2)}`
      await $.fs.write(inside, `${a}\n`)
      await $.fs.write(outside, `${b}\n`)
      const run = (file: string) =>
        $.process.run([...argvOf(path), ...codexProfileArgs(os, mode), 'sandbox', '--permission-profile', CODEX_PROFILES[mode].name, '--', ...reader(file)], {
          cwd: work,
          timeoutMs: 60_000,
        })
      const r1 = await run(inside)
      if (!r1.stdout.includes(a)) {
        const why = clean(`${r1.stderr}\n${r1.stdout}`).trim().split('\n').pop() ?? ''
        result = { isOk: false, why: `Codex's sandbox could not run the hub's ${mode} profile here${why ? ` (${why.slice(0, 200)})` : ''}` }
        break
      }
      const r2 = await run(outside)
      if (`${r2.stdout}${r2.stderr}`.includes(b)) {
        result = { isOk: false, why: `Codex's sandbox let the hub's ${mode} profile read a file outside its folder` }
        break
      }
    }
  } catch (error) {
    result = { isOk: false, why: `Codex's sandbox could not be checked (${errText(error)})` }
  }
  return result
}
