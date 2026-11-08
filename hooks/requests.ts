// Running requests: one call through a provider's CLI, with activity logging,
// redaction and de-duplication; and the comparison across several providers.
import { refreshLimits } from './limits'
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ActivityType, Mode, Task, Usage } from '../types'
import { begin, finish, redact, redactKeys } from './activity'
import { checkAuth, revealForRequest } from './auth'
import { ERROR_LABEL, type ErrorKind, argvOf, classifyError, codexIsolation, errText, exe, invocation, isolationProblem, parse, parseOpencodeExport, sandboxDir, timeoutFor } from './cli'
import { hopEnv, hopRefusal, selfProvider } from './hops'
import { resolveModel } from './models'
import { osName } from './platform'
import type { OsName } from './platform'
import { sessionKey } from './permissions'
import { PROVIDERS, provider } from './registry'
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
  /** the activity row of the run, so a check made afterwards can mark it failed */
  activityId?: string
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
  /** variables for the CLI on top of its own (the git guard of a write) */
  env?: Record<string, string>
}

/** Identical requests in flight share one run, so a double press or a retried tool call sends nothing twice. */
const inFlight = new Map<string, Promise<RequestResult>>()

/** The stop handle of each request still running, by its activity id. */
const running = new Map<string, () => void>()

/** Requests begun whose CLI has not started yet, and those of them stopped meanwhile. */
const starting = new Set<string>()
const stopSoon = new Set<string>()

/**
 * Stops a running request: its CLI is ended and the request reads as stopped.
 * A request still getting ready never starts its CLI. False when it is not running.
 */
export function stopRequest(activityId: string): boolean {
  const stop = running.get(activityId)
  if (stop) {
    stop()
    return true
  }
  if (!starting.has(activityId)) return false
  stopSoon.add(activityId)
  return true
}

/** Activity ids of the requests running now. */
export const runningIds = (): string[] => [...running.keys()]

export type Ran = {
  exitCode: number
  stdout: string
  stderr: string
  ended: 'exit' | 'timeout' | 'cancelled'
  /** stopped, but the engine did not confirm the child ended within KILL_WAIT_MS */
  mayStillRun?: boolean
}

/** How long a stop waits for the engine to say the child ended. */
export const KILL_WAIT_MS = 5000

/** What an answer adds when a stopped CLI may still be running. */
export const MAY_STILL_RUN = ' The hub asked for the CLI to be ended but could not confirm it ended: it may still be running, so check your running processes.'

const CAP = 4 * 1024 * 1024

/**
 * Runs one CLI and reads what it writes, until it exits, its deadline passes
 * or the person stops it. Leaving the stream ends the child.
 */
export async function runStoppable(
  $: EngineInterface,
  activityId: string,
  req: { argv: string[]; cwd: string; env?: Record<string, string>; input?: string },
  timeoutMs: number,
): Promise<Ran> {
  starting.delete(activityId)
  // stopped while it got ready: nothing is sent
  if (stopSoon.delete(activityId)) return { exitCode: -1, stdout: '', stderr: '', ended: 'cancelled' }
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
        // leaving the stream ends the child; waited on, a little, so the answer can say whether it did
        const ended = await Promise.race([
          stream.return(undefined as never).then(
            () => true,
            () => true,
          ),
          $.clock.sleep(KILL_WAIT_MS).then(
            () => false,
            () => false,
          ),
        ])
        return { exitCode: 1, stdout, stderr, ended: step, ...(ended ? {} : { mayStillRun: true }) }
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

// one sign-in check per provider at a time: a request that needs one waits for the check under way
const checks = new Map<string, Promise<void>>()

/** Checks one provider's sign-in or key: cheap, local, sends no prompt. */
export function checkSignIn($: EngineInterface, id: string): Promise<void> {
  const p = provider(id)
  if (!p) return Promise.resolve()
  let job = checks.get(id)
  if (!job) {
    job = (async () => {
      await setHealth($, id, h => ({ ...h, auth: 'checking' }))
      const r = await checkAuth($, p)
      const at = await $.clock.now()
      await setHealth($, id, h => ({ ...h, auth: r.state, authMessage: r.message, authCheckedAt: at }))
    })().finally(() => checks.delete(id))
    checks.set(id, job)
  }
  return job
}

/**
 * Before a request is routed or sent: checks each connected, enabled provider
 * (or the ones named) whose sign-in is not known yet, so none is used on a guess.
 */
export async function checkUnknownSignIns($: EngineInterface, ids?: string[]): Promise<void> {
  const cfg = await read($, config)
  const h = await read($, health)
  const list = (ids ?? PROVIDERS.map(p => p.id)).filter(id => cfg[id]?.isConnected && cfg[id]?.isEnabled)
  await Promise.all(list.filter(id => checks.has(id) || !h[id] || h[id]!.auth === 'unknown' || h[id]!.auth === 'checking').map(id => checkSignIn($, id)))
}

/** Whether a provider may take a request now: connected, on, installed, and known to be signed in. */
export async function readiness($: EngineInterface, id: string): Promise<string | undefined> {
  const p = provider(id)
  if (!p) return `Unknown provider "${id}".`
  // the agent the hub runs inside is never sent a request from here: no loops back to it
  if ((await selfProvider($)) === id) return `${p.label} is the agent this hub runs inside, so the hub does not send it requests.`
  const c = (await read($, config))[id]
  if (!c?.isConnected) return `${p.label} is not connected.`
  if (!c.isEnabled) return `${p.label} is disabled in Jervis AI Hub.`
  const h = (await read($, health))[id]
  if (h?.auth === 'not-installed') return `${p.label}: its CLI is not installed.`
  if (h?.auth === 'signed-out' || h?.auth === 'missing-credential') return `${p.label}: ${h.authMessage ?? 'not signed in.'}`
  // a sign-in the hub has not checked is not taken as one
  if (!h || h.auth === 'unknown' || h.auth === 'checking') return `${p.label}: its sign-in has not been checked yet${h?.authMessage && h.auth === 'unknown' ? ` (the last check could not run: ${h.authMessage})` : ''}.`
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
  // nothing was sent: either this provider cannot take the request now, or the hub refused it (a refusal is not fallen back from)
  const fail = (text: string, errorKind: ErrorKind = 'unavailable'): RequestResult => ({ isOk: false, provider: a.providerId, model, effort, text, ms: 0, errorKind })
  if (!p) return fail(`Unknown provider "${a.providerId}".`)
  // a hub inside an agent a hub started sends nothing on: no loops
  const loop = await hopRefusal($)
  if (loop) return fail(loop, 'policy')
  await checkUnknownSignIns($, [a.providerId])
  const blocked = await readiness($, a.providerId)
  if (blocked) return fail(blocked)
  const path = await exe($, p.kind)
  if (!path) return fail(`${p.label}: its CLI was not found.`)
  // rules the hub cannot confirm for this version are no rules at all: refuse
  const unconfined = await isolationProblem($, p.kind, path, a.mode)
  if (unconfined) return fail(unconfined, 'policy')
  // Codex: its sandbox must hold the run to its folder, unless the person chose otherwise
  let codexOs: OsName | undefined
  let unisolated = ''
  if (p.kind === 'codex') {
    const iso = await codexIsolation($, path)
    if (iso.isOk) codexOs = await osName($)
    else if ((await read($, settings)).allowCodexUnisolated) unisolated = `Ran without read isolation: ${iso.why}. Codex could read any file your account can.`
    else {
      return fail(
        `Refused: ${iso.why}, so Codex would not be held to its folder. Nothing was sent. Codex needs its MXC sandbox on Windows (Windows 11 24H2 or 25H2 with the update that adds it); or turn on "Allow Codex without read isolation" in Jervis AI Hub → Settings → Privacy.`,
        'policy',
      )
    }
  }

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
  starting.add(id)
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
    const inv = invocation(p.kind, path, a.prompt, a.mode, pick.cliModel, pick.effortArg, codexOs)
    const { argv, stdin } = inv
    // the CLI's own limits for this mode (OpenCode's permissions), then the key
    const runDir = a.cwd ?? (await sandboxDir($))
    // PWD names the run's folder too: OpenCode takes its folder from PWD before the process's
    // own, so a PWD inherited from the shell Claude started in would root it in that project
    env = { ...inv.env, ...a.env, ...env, ...(await hopEnv($, id)), PWD: runDir }
    const timeoutMs = timeoutFor(a.type, a.mode)
    const r = await runStoppable($, id, { argv, input: stdin, env, cwd: runDir }, timeoutMs)
    env = undefined
    if (r.ended !== 'exit') {
      const ms = (await $.clock.now()) - started
      const why =
        r.ended === 'cancelled'
          ? 'stopped by the person'
          : `stopped after ${Math.round(timeoutMs / 60_000)} minutes without finishing`
      const left = (a.mode === 'write' ? ' Changes it made so far stay in the folder for review; nothing was retried.' : '') + (r.mayStillRun ? MAY_STILL_RUN : '')
      await finish($, id, { state: r.ended === 'cancelled' ? 'cancelled' : 'error', ms, error: why })
      await announce($, p.label, ms, r.ended)
      return { isOk: false, provider: a.providerId, model, effort, text: `${p.label}: ${why}.${left}`, ms, errorKind: r.ended, activityId: id }
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
    const errorKind = parsed.isOk ? undefined : classifyError({ message: parsed.error ?? '', status: parsed.status, name: parsed.errorName })
    // a successful answer is cleaned too: a model may echo the key it was given
    const text = parsed.isOk
      ? `${unisolated ? `(${unisolated})\n\n` : ''}${redactKeys(parsed.text, secrets)}`
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
    // the provider refused the sign-in or key: it is not used again until a check finds it signed in
    if (errorKind === 'auth') {
      const at = await $.clock.now()
      await setHealth($, a.providerId, h => ({
        ...h,
        auth: 'signed-out',
        authCheckedAt: at,
        authMessage: `a request was refused for its sign-in or key. Sign in again (or save a new key), then connect it again in Jervis AI Hub.`,
      }))
    }
    if (parsed.isOk) {
      const at = await $.clock.now()
      await setHealth($, a.providerId, h => ({ ...h, lastSuccessAt: at, lastLatencyMs: ms }))
      // the plan's windows moved: read them again (local, no prompt sent)
      if (p.kind === 'codex') void refreshLimits($, a.providerId).catch(() => undefined)
    }
    return { isOk: parsed.isOk, provider: a.providerId, model, effort, text, ms, usage: parsed.usage, errorKind, activityId: id }
  } catch (error) {
    const ms = (await $.clock.now()) - started
    const message = redact(errText(error), secret ? [secret] : [])
    await finish($, id, { state: 'error', ms, error: message })
    await announce($, p.label, ms, 'error')
    return { isOk: false, provider: a.providerId, model, effort, text: `${p.label} could not run: ${message}`, ms, errorKind: classifyError(message), activityId: id }
  } finally {
    secret = undefined
    starting.delete(id)
    stopSoon.delete(id)
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
