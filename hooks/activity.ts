// ActivityStore: a bounded, redacted log of what the hub sent where.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Activity } from '../types'
import { STORE, DEFAULT_SETTINGS } from './state'

// state this file reads (the scan needs each atom declared in the file that uses it)
const activity = atom({ plugin: 'ai-subscriptions', key: 'activity' } as const, [], { shape: 'a-1' })
const settings = atom({ plugin: 'ai-subscriptions', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'st-1' })

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/g, // OpenAI / DeepSeek / Moonshot style
  /\bsk-or-[A-Za-z0-9_-]{12,}/g, // OpenRouter
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google
  /\bgsk_[A-Za-z0-9]{20,}/g, // Groq
  /\bxai-[A-Za-z0-9]{20,}/g, // xAI
  /\bpplx-[A-Za-z0-9]{20,}/g, // Perplexity
  /\bfw_[A-Za-z0-9]{20,}/g, // Fireworks
  /\bcsk-[A-Za-z0-9]{20,}/g, // Cerebras
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(api[_-]?key|token|secret|password)(["'\s:=]+)[^\s"',]{8,}/gi,
  /\b[0-9a-f]{40,}\b/gi, // long hex, e.g. a DPAPI blob
]

/** Removes anything shaped like a credential, and the exact values given. */
export function redact(text: string, exact: readonly string[] = []): string {
  let out = text
  for (const value of exact) if (value.length >= 6) out = out.split(value).join('[redacted]')
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, a?: string, b?: string) =>
      typeof a === 'string' && typeof b === 'string' && /key|token|secret|password/i.test(a) ? `${a}${b}[redacted]` : '[redacted]',
    )
  }
  return out
}

export const snip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, Math.max(1, n - 1))}…` : one
}

async function persist($: EngineInterface): Promise<void> {
  await $.store.set(STORE.activity, await read($, activity))
}

/** Starts an entry and returns its id. Prompt text is kept only as a redacted preview, and only when allowed. */
export async function begin(
  $: EngineInterface,
  entry: Omit<Activity, 'id' | 'at' | 'state' | 'preview' | 'promptChars'> & { prompt: string },
): Promise<string> {
  const s = await read($, settings)
  const at = await $.clock.now()
  const id = `${at}-${Math.random().toString(36).slice(2, 8)}`
  const { prompt, ...rest } = entry
  const row: Activity = {
    ...rest,
    id,
    at,
    state: 'running',
    promptChars: prompt.length,
    preview: s.recordPreviews ? snip(redact(prompt), 160) : undefined,
  }
  const cutoff = at - s.retentionDays * 86_400_000
  await update($, activity, list => [...list.filter(a => a.at >= cutoff), row].slice(-Math.max(1, s.retentionCount)))
  await persist($)
  return id
}

export async function finish(
  $: EngineInterface,
  id: string,
  patch: Partial<Pick<Activity, 'state' | 'ms' | 'resultPreview' | 'error' | 'usage' | 'model' | 'touchedFiles'>>,
  secrets: readonly string[] = [],
): Promise<void> {
  const s = await read($, settings)
  const clean = {
    ...patch,
    error: patch.error === undefined ? undefined : snip(redact(patch.error, secrets), 400),
    resultPreview:
      patch.resultPreview === undefined || !s.recordPreviews ? undefined : snip(redact(patch.resultPreview, secrets), 200),
  }
  await update($, activity, list => list.map(a => (a.id === id ? { ...a, ...clean } : a)))
  await persist($)
}

export async function clearActivity($: EngineInterface): Promise<void> {
  await update($, activity, () => [])
  await persist($)
}

export type ProviderStats = {
  requests: number
  failures: number
  avgMs?: number
  inputTokens: number
  outputTokens: number
  hasTokens: boolean
  /** sum of the costs the CLI recorded (OpenCode), where it recorded any */
  costUsd?: number
}

/** Per-provider totals over what the log still holds. */
export function stats(list: readonly Activity[]): Record<string, ProviderStats> {
  const out: Record<string, ProviderStats & { msSum: number; msN: number }> = {}
  for (const a of list) {
    if (a.state === 'running') continue
    const s = (out[a.provider] ??= { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, hasTokens: false, msSum: 0, msN: 0 })
    s.requests += 1
    if (a.state === 'error') s.failures += 1
    if (a.ms !== undefined) {
      s.msSum += a.ms
      s.msN += 1
    }
    if (a.usage?.costUsd !== undefined) {
      s.costUsd = (s.costUsd ?? 0) + a.usage.costUsd
    }
    if (a.usage?.inputTokens !== undefined || a.usage?.outputTokens !== undefined) {
      s.hasTokens = true
      s.inputTokens += a.usage.inputTokens ?? 0
      s.outputTokens += a.usage.outputTokens ?? 0
    }
  }
  return Object.fromEntries(
    Object.entries(out).map(([k, { msSum, msN, ...v }]) => [k, { ...v, avgMs: msN ? Math.round(msSum / msN) : undefined }]),
  )
}
