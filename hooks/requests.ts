// Running requests: one call through a provider's CLI, with activity logging,
// redaction and de-duplication; and the comparison across several providers.
import { refreshLimits } from './limits'
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ActivityType, Mode, Task, Usage } from '../types'
import { begin, finish, redact } from './activity'
import { revealForRequest } from './auth'
import { ERROR_LABEL, type ErrorKind, MAX_ARG_PROMPT, argvOf, classifyError, errText, exe, invocation, parse, parseOpencodeExport, sandboxDir, timeoutFor } from './cli'
import { resolveModel } from './models'
import { sessionKey } from './permissions'
import { provider } from './registry'
import { DEFAULT_SETTINGS, setHealth } from './state'

// state this file reads (the scan needs each atom declared in the file that uses it)
const config = atom({ plugin: 'ai-subscriptions', key: 'config' } as const, {}, { shape: 'cfg-3' })
const health = atom({ plugin: 'ai-subscriptions', key: 'health' } as const, {}, { shape: 'h-1' })
const models = atom({ plugin: 'ai-subscriptions', key: 'models' } as const, {}, { shape: 'm-2' })
const settings = atom({ plugin: 'ai-subscriptions', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'st-1' })
const progress = atom({ plugin: 'ai-subscriptions', key: 'progress' } as const, {}, { shape: 'p-1' })

export type RequestResult = {
  isOk: boolean
  provider: string
  model?: string
  effort?: string
  text: string
  ms: number
  usage?: Usage
  /** what kind of failure this was, when it failed */
  errorKind?: ErrorKind
}

export type RequestArgs = {
  providerId: string
  prompt: string
  mode: Mode
  model?: string
  /** reasoning effort; absent, the one picked in the hub for this model */
  effort?: string
  /** a project folder the agent may read (and in write mode, change); absent, an empty sandbox */
  cwd?: string
  type: ActivityType
  task?: Task
  fallbackFrom?: string
  /** told the activity id once the request starts, so a background job can show and stop it */
  onStart?: (activityId: string) => void
}

/** Identical requests in flight share one run, so a double press or a retried tool call sends nothing twice. */
const inFlight = new Map<string, Promise<RequestResult>>()

/** The stop handle of each request still running, by its activity id. */
const running = new Map<string, () => void>()

/** Stops a running request: its CLI is ended and the request reads as stopped. False when it is not running. */
export function stopRequest(activityId: string): boolean {
  const stop = running.get(activityId)
  stop?.()
  return Boolean(stop)
}

/** Activity ids of the requests running now. */
export const runningIds = (): string[] => [...running.keys()]

type Ran = { exitCode: number; stdout: string; stderr: string; ended: 'exit' | 'timeout' | 'cancelled' }

const CAP = 4 * 1024 * 1024

/**
 * Runs one CLI and reads what it writes, until it exits, its deadline passes
 * or the person stops it. Leaving the stream ends the child.
 */
async function runStoppable(
  $: EngineInterface,
  activityId: string,
  req: { argv: string[]; cwd: string; env?: Record<string, string>; input?: string },
  timeoutMs: number,
): Promise<Ran> {
  const stream = $.process.spawn(req)
  let stop: (why: 'timeout' | 'cancelled') => void = () => undefined
  const stopped = new Promise<'timeout' | 'cancelled'>(resolve => (stop = resolve))
  running.set(activityId, () => stop('cancelled'))
  const timer = new AbortController()
  void $.clock.sleep(timeoutMs, { signal: timer.signal }).then(
    () => stop('timeout'),
    () => undefined,
  )
  let stdout = ''
  let stderr = ''
  // progress is counted here and written to state once a second, never per chunk;
  // only sizes and times are kept, never what the CLI wrote
  const startedAt = await $.clock.now()
  let bytes = 0
  let lastOutputAt: number | undefined
  let isDone = false
  await update($, progress, p => ({ ...p, [activityId]: { startedAt, at: startedAt, bytes: 0 } }))
  void (async () => {
    // a session that ends mid-run takes the clock with it: the ticker just stops
    try {
      while (!isDone) {
        await $.clock.sleep(TICK_MS, { signal: timer.signal })
        if (isDone) return
        const at = await $.clock.now()
        await update($, progress, p => (p[activityId] ? { ...p, [activityId]: { startedAt, at, bytes, lastOutputAt } } : p))
      }
    } catch {
      // stopped
    }
  })()
  try {
    for (;;) {
      const step = await Promise.race([stream.next(), stopped])
      if (typeof step === 'string') {
        void stream.return(undefined as never).catch(() => undefined)
        return { exitCode: 1, stdout, stderr, ended: step }
      }
      if (step.done) return { exitCode: step.value.code ?? 1, stdout, stderr, ended: 'exit' }
      bytes += step.value.text.length
      lastOutputAt = await $.clock.now()
      if (step.value.stream === 'stdout') {
        if (stdout.length < CAP) stdout += step.value.text
      } else if (stderr.length < CAP) stderr += step.value.text
    }
  } finally {
    isDone = true
    timer.abort()
    running.delete(activityId)
    await update($, progress, p => {
      const { [activityId]: _gone, ...rest } = p
      return rest
    })
  }
}

/** How often a running request's progress is written, ms. */
const TICK_MS = 1000

/** A request that ran at least this long gets a toast when it ends. */
export const DONE_ALERT_MS = 30_000

/** "42s", "1m 12s", "1h 3m". */
export const duration = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** "512 B", "3.4 KB", "1.2 MB". */
export const size = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`

/** Tells the person a long request ended, unless they turned it off or stopped it themselves. */
async function announce($: EngineInterface, label: string, ms: number, outcome: 'ok' | 'error' | 'timeout' | 'cancelled'): Promise<void> {
  if (outcome === 'cancelled' || ms < DONE_ALERT_MS) return
  if ((await read($, settings)).doneAlerts === false) return
  const took = duration(ms)
  $.ui.toast(
    outcome === 'ok'
      ? `Jervis AI Hub: ${label} answered after ${took}.`
      : outcome === 'timeout'
        ? `Jervis AI Hub: ${label} timed out after ${took}.`
        : `Jervis AI Hub: ${label} failed after ${took}.`,
  )
}

/** Whether a provider may take a request now: connected, on, installed and signed in. */
export async function readiness($: EngineInterface, id: string): Promise<string | undefined> {
  const p = provider(id)
  if (!p) return `Unknown provider "${id}".`
  const c = (await read($, config))[id]
  if (!c?.isConnected) return `${p.label} is not connected.`
  if (!c.isEnabled) return `${p.label} is disabled in Jervis AI Hub.`
  const h = (await read($, health))[id]
  if (h?.auth === 'not-installed') return `${p.label}: its CLI is not installed.`
  if (h?.auth === 'signed-out' || h?.auth === 'missing-credential') return `${p.label}: ${h.authMessage ?? 'not signed in.'}`
  return undefined
}

export async function runRequest($: EngineInterface, a: RequestArgs): Promise<RequestResult> {
  // Only a read from the same session, with the same provider, model, effort,
  // folder, task and the exact same prompt shares a run already under way. The
  // key lives in memory only while that run lasts; a write never shares one.
  const key = JSON.stringify([await sessionKey($), a.providerId, a.model ?? '', a.effort ?? '', a.mode, a.cwd ?? '', a.type, a.task ?? '', a.prompt])
  const running = a.mode === 'read' ? inFlight.get(key) : undefined
  if (running) return running
  const job = execute($, a).finally(() => inFlight.delete(key))
  inFlight.set(key, job)
  return job
}

async function execute($: EngineInterface, a: RequestArgs): Promise<RequestResult> {
  const p = provider(a.providerId)
  const c = (await read($, config))[a.providerId]
  const model = a.model ?? c?.model
  const wanted = a.effort ?? (model === c?.model ? c?.effort : undefined)
  const pick = resolveModel((await read($, models))[a.providerId]?.models, model, wanted)
  const effort = pick.effort
  const fail = (text: string): RequestResult => ({ isOk: false, provider: a.providerId, model, effort, text, ms: 0, errorKind: 'unavailable' })
  if (!p) return fail(`Unknown provider "${a.providerId}".`)
  const blocked = await readiness($, a.providerId)
  if (blocked) return fail(blocked)
  if (p.kind === 'agy' && a.prompt.length > MAX_ARG_PROMPT) {
    return fail(`Antigravity takes the prompt on its command line, which the system caps; this prompt is ${a.prompt.length} characters (limit ${MAX_ARG_PROMPT}).`)
  }
  const path = await exe($, p.kind)
  if (!path) return fail(`${p.label}: its CLI was not found.`)

  const id = await begin($, {
    type: a.type,
    provider: a.providerId,
    model,
    effort,
    task: a.task,
    mode: a.mode,
    prompt: a.prompt,
    fallbackFrom: a.fallbackFrom,
  })
  a.onStart?.(id)
  const started = await $.clock.now()
  let secret: string | undefined
  try {
    let env: Record<string, string> | undefined
    if (p.kind === 'opencode-key' && p.envVar) {
      secret = await revealForRequest($, p.id)
      if (!secret) throw new Error('the saved API key could not be read from this account’s secure storage; connect it again')
      env = { [p.envVar]: secret }
    }
    const { argv, stdin } = invocation(p.kind, path, a.prompt, a.mode, pick.cliModel, pick.effortArg)
    const runDir = a.cwd ?? (await sandboxDir($))
    const timeoutMs = timeoutFor(a.type, a.mode)
    const r = await runStoppable($, id, { argv, input: stdin, env, cwd: runDir }, timeoutMs)
    env = undefined
    if (r.ended !== 'exit') {
      const ms = (await $.clock.now()) - started
      const why =
        r.ended === 'cancelled'
          ? 'stopped by the person'
          : `stopped after ${Math.round(timeoutMs / 60_000)} minutes without finishing`
      const left = a.mode === 'write' ? ' Changes it made so far stay in the folder for review; nothing was retried.' : ''
      await finish($, id, { state: r.ended === 'cancelled' ? 'cancelled' : 'error', ms, error: why })
      await announce($, p.label, ms, r.ended)
      return { isOk: false, provider: a.providerId, model, effort, text: `${p.label}: ${why}.${left}`, ms, errorKind: r.ended }
    }
    const parsed = parse(p.kind, r.stdout, r.stderr, r.exitCode)
    // OpenCode prints no usage in its run output; it records tokens and cost on the session
    if (parsed.isOk && parsed.sessionId && (p.kind === 'opencode-key' || p.kind === 'opencode-free')) {
      try {
        const x = await $.process.run([...argvOf(path), 'session', 'export', parsed.sessionId], { cwd: runDir, timeoutMs: 30_000 })
        if (x.exitCode === 0) parsed.usage = parseOpencodeExport(x.stdout) ?? parsed.usage
      } catch {
        // the answer stands without usage
      }
    }
    const ms = (await $.clock.now()) - started
    const secrets = secret ? [secret] : []
    const errorKind = parsed.isOk ? undefined : classifyError(parsed.error ?? '')
    const text = parsed.isOk
      ? parsed.text
      : redact(`${p.label} failed (${ERROR_LABEL[errorKind ?? 'unknown']}): ${parsed.error ?? 'unknown error'}`, secrets)
    await finish(
      $,
      id,
      {
        state: parsed.isOk ? 'ok' : 'error',
        ms,
        usage: parsed.usage,
        resultPreview: parsed.isOk ? parsed.text : undefined,
        error: parsed.isOk ? undefined : parsed.error,
      },
      secrets,
    )
    await announce($, p.label, ms, parsed.isOk ? 'ok' : 'error')
    if (parsed.isOk) {
      const at = await $.clock.now()
      await setHealth($, a.providerId, h => ({ ...h, lastSuccessAt: at, lastLatencyMs: ms }))
      // the plan's windows moved: read them again (local, no prompt sent)
      if (p.kind === 'codex') void refreshLimits($, a.providerId).catch(() => undefined)
    }
    return { isOk: parsed.isOk, provider: a.providerId, model, effort, text, ms, usage: parsed.usage, errorKind }
  } catch (error) {
    const ms = (await $.clock.now()) - started
    const message = redact(errText(error), secret ? [secret] : [])
    await finish($, id, { state: 'error', ms, error: message })
    await announce($, p.label, ms, 'error')
    return { isOk: false, provider: a.providerId, model, effort, text: `${p.label} could not run: ${message}`, ms, errorKind: classifyError(message) }
  } finally {
    secret = undefined
  }
}

/** Runs one read-only prompt through several providers at once. */
export async function compare(
  $: EngineInterface,
  targets: { providerId: string; model?: string; effort?: string }[],
  prompt: string,
  task?: Task,
  cwd?: string,
): Promise<RequestResult[]> {
  const seen = new Set<string>()
  const unique = targets.filter(t => !seen.has(t.providerId) && seen.add(t.providerId)).slice(0, 5)
  return Promise.all(unique.map(t => runRequest($, { ...t, prompt, mode: 'read', cwd, type: 'compare', task })))
}

export const usd = (v: number): string => (v === 0 ? '$0' : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`)

export const usageLine = (u: Usage | undefined): string => {
  if (!u || (u.inputTokens === undefined && u.outputTokens === undefined)) return ''
  const parts = [
    u.inputTokens !== undefined ? `${u.inputTokens} in` : '',
    u.cachedTokens ? `${u.cachedTokens} cached` : '',
    u.outputTokens !== undefined ? `${u.outputTokens} out` : '',
  ].filter(Boolean)
  const cost = u.costUsd !== undefined ? `; cost OpenCode recorded: ${usd(u.costUsd)}` : ''
  return `tokens reported by the CLI: ${parts.join(', ')}${cost}`
}
