// Running requests: one call through a provider's CLI, with activity logging,
// redaction and de-duplication; and the comparison across several providers.
import { refreshLimits } from './limits'
import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ActivityType, Mode, Task, Usage } from '../types'
import { begin, finish, redact } from './activity'
import { revealForRequest } from './auth'
import { MAX_ARG_PROMPT, TIMEOUT, errText, exe, invocation, parse, sandboxDir } from './cli'
import { resolveModel } from './models'
import { provider } from './registry'
import { setHealth } from './state'

// state this file reads (the scan needs each atom declared in the file that uses it)
const config = atom({ plugin: 'ai-subscriptions', key: 'config' } as const, {}, { shape: 'cfg-3' })
const health = atom({ plugin: 'ai-subscriptions', key: 'health' } as const, {}, { shape: 'h-1' })
const models = atom({ plugin: 'ai-subscriptions', key: 'models' } as const, {}, { shape: 'm-2' })

export type RequestResult = {
  isOk: boolean
  provider: string
  model?: string
  effort?: string
  text: string
  ms: number
  usage?: Usage
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
}

/** Identical requests in flight share one run, so a double press or a retried tool call sends nothing twice. */
const inFlight = new Map<string, Promise<RequestResult>>()

function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
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
  const key = `${a.providerId}|${a.model ?? ''}|${a.effort ?? ''}|${a.mode}|${a.cwd ?? ''}|${a.type}|${hash(a.prompt)}`
  const running = inFlight.get(key)
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
  const fail = (text: string): RequestResult => ({ isOk: false, provider: a.providerId, model, effort, text, ms: 0 })
  if (!p) return fail(`Unknown provider "${a.providerId}".`)
  const blocked = await readiness($, a.providerId)
  if (blocked) return fail(blocked)
  if (p.kind === 'agy' && a.prompt.length > MAX_ARG_PROMPT) {
    return fail(`Antigravity takes the prompt on its command line, which Windows caps; this prompt is ${a.prompt.length} characters (limit ${MAX_ARG_PROMPT}).`)
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
  const started = await $.clock.now()
  let secret: string | undefined
  try {
    let env: Record<string, string> | undefined
    if (p.kind === 'opencode-key' && p.envVar) {
      secret = await revealForRequest($, p.id)
      if (!secret) throw new Error('the saved API key could not be decrypted for this Windows account; connect it again')
      env = { [p.envVar]: secret }
    }
    const { argv, stdin } = invocation(p.kind, path, a.prompt, a.mode, pick.cliModel, pick.effortArg)
    const r = await $.process.run(argv, {
      stdin,
      env,
      cwd: a.cwd ?? (await sandboxDir($)),
      timeoutMs: TIMEOUT,
    })
    env = undefined
    const parsed = parse(p.kind, r.stdout, r.stderr, r.exitCode)
    const ms = (await $.clock.now()) - started
    const secrets = secret ? [secret] : []
    const text = parsed.isOk ? parsed.text : redact(`${p.label} failed: ${parsed.error ?? 'unknown error'}`, secrets)
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
    if (parsed.isOk) {
      const at = await $.clock.now()
      await setHealth($, a.providerId, h => ({ ...h, lastSuccessAt: at, lastLatencyMs: ms }))
      // the plan's windows moved: read them again (local, no prompt sent)
      if (p.kind === 'codex') void refreshLimits($, a.providerId).catch(() => undefined)
    }
    return { isOk: parsed.isOk, provider: a.providerId, model, effort, text, ms, usage: parsed.usage }
  } catch (error) {
    const ms = (await $.clock.now()) - started
    const message = redact(errText(error), secret ? [secret] : [])
    await finish($, id, { state: 'error', ms, error: message })
    return { isOk: false, provider: a.providerId, model, effort, text: `${p.label} could not run: ${message}`, ms }
  } finally {
    secret = undefined
  }
}

/** Runs one read-only prompt through several providers at once. */
export async function compare(
  $: EngineInterface,
  providerIds: string[],
  prompt: string,
  cwd?: string,
): Promise<RequestResult[]> {
  const unique = [...new Set(providerIds)].slice(0, 5)
  return Promise.all(unique.map(id => runRequest($, { providerId: id, prompt, mode: 'read', cwd, type: 'compare' })))
}

export const usageLine = (u: Usage | undefined): string => {
  if (!u || (u.inputTokens === undefined && u.outputTokens === undefined)) return ''
  const parts = [
    u.inputTokens !== undefined ? `${u.inputTokens} in` : '',
    u.cachedTokens ? `${u.cachedTokens} cached` : '',
    u.outputTokens !== undefined ? `${u.outputTokens} out` : '',
  ].filter(Boolean)
  return `tokens reported by the CLI: ${parts.join(', ')}`
}
