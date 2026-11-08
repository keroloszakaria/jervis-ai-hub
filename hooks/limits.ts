// LimitsReader: what each provider itself reports about its limits, read
// through official means only. Nothing is estimated: where a provider or its
// CLI reports nothing, the hub says so.
//   Codex: the CLI's app server, `account/rateLimits/read` (plan windows).
//   Antigravity: `agy -p /usage --output-format json`, a local command that sends no prompt.
//   Claude: this session's own rate-limit windows, as Claude Code's status line has them.
//   DeepSeek, OpenRouter, Moonshot, SiliconFlow: their documented balance/key endpoints.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { LimitWindow, Limits } from '../types'
import { powershell, revealForRequest } from './auth'
import { argvOf, errText, exe, sandboxDir } from './cli'
import { osName } from './platform'
import { provider } from './registry'
import { DEFAULT_SETTINGS } from './state'

const limits = atom({ plugin: 'ai-subscriptions', key: 'limits' } as const, {}, { shape: 'l-1' })
const config = atom({ plugin: 'ai-subscriptions', key: 'config' } as const, {}, { shape: 'cfg-3' })
const settings = atom({ plugin: 'ai-subscriptions', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'st-1' })

/** A provider's limits are read again at most this often, unless the person presses Refresh. */
export const MIN_GAP_MS = 60_000
/**
 * A limits reading older than this no longer steers the router: its windows
 * may have reset or filled since. It is shown as old, and read again on Refresh
 * or after the provider's next request.
 */
export const LIMITS_TTL_MS = 30 * 60_000

/** Whether a reading is too old to decide anything by. */
export const isLimitsStale = (l: Limits | undefined, now: number): boolean => !l || now - l.at > LIMITS_TTL_MS

/** Whether a window has reset since it was read: what it said is used is used no more. */
export const hasReset = (w: LimitWindow, now: number): boolean => w.resetsAt !== undefined && w.resetsAt <= now

/** A window at or past this share used counts as spent. */
export const SPENT_AT = 98
/** A window at or past this share used counts as limited (still usable). */
export const LIMITED_AT = 80

/** Whether a window is spent now: read as nearly full, and not past its reset time. */
export const isSpent = (w: LimitWindow, now: number): boolean => !hasReset(w, now) && w.usedPercent >= SPENT_AT

const STOP_WORDS = new Set(['model', 'models', 'and', 'the', 'all'])
const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9.]+/).filter(x => x && !STOP_WORDS.has(x))

/**
 * Whether a window's model group covers a model, by whole words: "Gemini
 * Models" covers gemini-4-argon; "Claude and GPT models" covers a Claude model
 * or a GPT one. Each alternative's words must all be words of the model's id
 * or label, so "pro" never matches "promo" and "3" never matches "gpt-4-32k".
 * A window with no group covers every model (it is the account's).
 */
export function groupCovers(group: string | undefined, model: { id?: string; label?: string } | undefined): boolean {
  if (!group) return true
  if (!model) return false
  const have = new Set([...words(model.id ?? ''), ...words(model.label ?? '')])
  const alternatives = group.split(/\s+and\s+|,|\//i).map(words).filter(a => a.length)
  return alternatives.some(alt => alt.every(w => have.has(w)))
}

/**
 * What a reading says about a provider (or, given a model, about that model)
 * now. Nothing is estimated: no reading is `unknown`, an old one `stale`, a
 * provider that reports none `unsupported`; `exhausted` when the provider said
 * it is blocked, when any window that covers the whole account is spent, or
 * when every window that covers the model (or, for the provider, every model
 * group) is spent; `limited` past 80%; else `available`.
 */
export type LimitState = 'available' | 'limited' | 'exhausted' | 'stale' | 'unknown' | 'unsupported'
export function limitState(l: Limits | undefined, now: number, model?: { id?: string; label?: string }): LimitState {
  if (!l || l.state === 'error' || (l.state === 'checking' && !l.windows?.length && !l.isBlocked)) return 'unknown'
  if (l.state === 'unsupported') return 'unsupported'
  if (isLimitsStale(l, now)) return 'stale'
  if (l.isBlocked) return 'exhausted'
  const ws = l.windows ?? []
  if (!ws.length) return 'unknown'
  const account = ws.filter(w => !w.group)
  if (account.some(w => isSpent(w, now))) return 'exhausted'
  const grouped = ws.filter(w => w.group)
  if (model) {
    // the account's windows cover every model; a group's only its own
    const covering = ws.filter(w => groupCovers(w.group, model))
    if (!covering.length) return 'unknown'
    if (covering.some(w => isSpent(w, now))) return 'exhausted'
    return covering.some(w => !hasReset(w, now) && w.usedPercent >= LIMITED_AT) ? 'limited' : 'available'
  }
  if (grouped.length) {
    const groups = [...new Set(grouped.map(w => w.group!))]
    if (groups.every(g => grouped.some(w => w.group === g && isSpent(w, now)))) return 'exhausted'
  }
  return ws.some(w => !hasReset(w, now) && w.usedPercent >= LIMITED_AT) ? 'limited' : 'available'
}

/** Whether a reading says the provider is at its limit now (see limitState). */
export function isAtLimit(l: Limits | undefined, now: number): boolean {
  return limitState(l, now) === 'exhausted'
}

/** Used shares that raise a toast, once per window and level. */
export const ALERT_LEVELS = [80, 95] as const

const UTF8_OUT = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);'

const CODEX_LINES = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"jervis-ai-hub","version":"0.4.0"}}}',
  '{"jsonrpc":"2.0","method":"initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read"}',
]

/** Starts `codex app-server`, asks for the rate limits once, prints that one reply, and stops it. */
const psQuote = (s: string): string => s.replace(/'/g, "''")
const codexScript = (argv: string[]): string => `${UTF8_OUT}$ErrorActionPreference = 'Stop'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = '${psQuote(argv[0] ?? '')}'
$psi.Arguments = '${psQuote([...argv.slice(1).map(a => `"${a}"`), 'app-server'].join(' '))}'
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$psi.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
$p = [System.Diagnostics.Process]::Start($psi)
${CODEX_LINES.map(l => `$p.StandardInput.WriteLine('${l}')`).join('\n')}
$p.StandardInput.Flush()
$deadline = (Get-Date).AddSeconds(25)
try {
  while ((Get-Date) -lt $deadline) {
    $t = $p.StandardOutput.ReadLineAsync()
    if (-not $t.Wait(25000)) { break }
    $line = $t.Result
    if ($null -eq $line) { break }
    if ($line.StartsWith('{"id":2,')) { [Console]::Out.WriteLine($line); break }
  }
} finally { try { $p.Kill() } catch {} }`

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined)
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)

/** A window's name from its length, as the plan states it. */
export const windowLabel = (mins: number): string =>
  mins === 10080 ? 'Weekly' : mins === 1440 ? 'Daily' : mins % 1440 === 0 ? `${mins / 1440}-day` : mins % 60 === 0 ? `${mins / 60}-hour` : `${mins}-minute`

function codexWindows(rl: Record<string, unknown>): LimitWindow[] {
  const out: LimitWindow[] = []
  for (const key of ['primary', 'secondary']) {
    const w = obj(rl[key])
    const used = num(w?.usedPercent)
    if (!w || used === undefined) continue
    const mins = num(w.windowDurationMins)
    const resets = num(w.resetsAt)
    out.push({ label: mins ? windowLabel(mins) : key === 'primary' ? 'Main' : 'Second', usedPercent: used, resetsAt: resets ? resets * 1000 : undefined })
  }
  return out
}

async function readCodex($: EngineInterface, now: number): Promise<Limits> {
  const path = await exe($, 'codex')
  if (!path) return { at: now, state: 'error', source: 'Codex CLI', error: 'the Codex CLI is not installed' }
  let out: string
  if ((await osName($)) === 'windows') {
    out = (await powershell($, codexScript(argvOf(path)), undefined, 40_000)).out
  } else {
    // stdin stays open a few seconds so the server answers before it sees the end
    const r = await $.process.run(['sh', '-c', 'p="$1"; shift; { printf \'%s\\n\' "$@"; sleep 12; } | "$p" app-server', 'sh', path, ...CODEX_LINES], { timeoutMs: 40_000 })
    out = r.stdout
  }
  const line = out.split(/\r?\n/).find(l => l.startsWith('{"id":2,'))
  if (!line) return { at: now, state: 'error', source: 'Codex CLI', error: 'the Codex app server did not answer with rate limits' }
  const reply = obj(JSON.parse(line))
  const res = obj(reply?.result)
  if (!res) return { at: now, state: 'error', source: 'Codex CLI', error: String(obj(reply?.error)?.message ?? 'no rate limits in the reply') }
  const rl = obj(res.rateLimits) ?? {}
  const credits = obj(rl.credits)
  const balance =
    credits && (credits.hasCredits === true || credits.unlimited === true)
      ? [{ label: 'Credits', amount: credits.unlimited === true ? 'Unlimited' : String(credits.balance ?? '0') }]
      : undefined
  return {
    at: now,
    state: 'ok',
    source: 'Codex CLI (account/rateLimits/read)',
    windows: codexWindows(rl),
    balance,
    plan: typeof rl.planType === 'string' ? rl.planType : undefined,
    isBlocked: res.ordinaryUsageAllowed === false || Boolean(rl.rateLimitReachedType) || rl.spendControlReached === true,
  }
}

/** Reads Antigravity's `/usage` report: per model group, a weekly and a 5-hour window. */
async function readAgy($: EngineInterface, now: number): Promise<Limits> {
  const path = await exe($, 'agy')
  if (!path) return { at: now, state: 'error', source: 'agy CLI', error: 'the agy CLI is not installed' }
  const r = await $.process.run([...argvOf(path), '-p', '/usage', '--output-format', 'json'], { cwd: await sandboxDir($), timeoutMs: 60_000 })
  let body: Record<string, unknown> | undefined
  try {
    body = obj(JSON.parse(r.stdout.trim()))
  } catch {
    body = undefined
  }
  const cmd = obj(body?.command)
  if (!cmd || cmd.name !== 'usage') return { at: now, state: 'error', source: 'agy /usage', error: 'agy did not return a usage report' }
  const windows: LimitWindow[] = []
  for (const g of Array.isArray(obj(cmd.data)?.groups) ? (obj(cmd.data)?.groups as unknown[]) : []) {
    const group = obj(g) ?? {}
    for (const b of Array.isArray(group.buckets) ? group.buckets : []) {
      const k = obj(b) ?? {}
      const left = num(k.remaining_fraction)
      if (left === undefined) continue
      const at = typeof k.reset_time === 'string' ? Date.parse(k.reset_time) : NaN
      windows.push({
        group: typeof group.name === 'string' ? group.name : undefined,
        label: k.window === 'weekly' ? 'Weekly' : k.window === '5h' ? '5-hour' : String(k.name ?? k.window ?? 'Limit'),
        usedPercent: Math.max(0, Math.min(100, Math.round((1 - left) * 1000) / 10)),
        resetsAt: Number.isFinite(at) ? at : undefined,
      })
    }
  }
  return { at: now, state: 'ok', source: 'agy /usage', windows }
}

const CLAUDE_WINDOW: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', seven_day_opus: 'Weekly Opus', seven_day_sonnet: 'Weekly Sonnet', spend_limit: 'Spend' }

/** This session's own subscription windows (Claude Code), as the status line reads them. */
export async function refreshClaudeLimits($: EngineInterface, given?: { kind: string; percentUsed: number; resetsAt?: string }[]): Promise<void> {
  const now = await $.clock.now()
  const rl = given ?? (await $.session.usage()).rateLimits
  const windows: LimitWindow[] = rl.map(w => {
    const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN
    return { label: CLAUDE_WINDOW[w.kind] ?? w.kind.replace(/_/g, ' '), usedPercent: w.percentUsed, resetsAt: Number.isFinite(at) ? at : undefined }
  })
  await update($, limits, l => ({
    ...l,
    claude: {
      at: now,
      state: 'ok' as const,
      source: 'Claude Code (this session’s rate-limit windows)',
      windows,
      isBlocked: windows.some(w => w.usedPercent >= 100),
    },
  }))
}

type KeyReader = { url: string; source: string; parse: (body: Record<string, unknown>) => Partial<Limits> }

/** Documented endpoints that report a key's balance or spend cap. */
const KEY_READERS: Record<string, KeyReader> = {
  deepseek: {
    url: 'https://api.deepseek.com/user/balance',
    source: 'DeepSeek /user/balance',
    parse: b => ({
      isBlocked: b.is_available === false,
      balance: (Array.isArray(b.balance_infos) ? b.balance_infos : []).map(x => {
        const i = obj(x) ?? {}
        return { label: 'Balance', amount: String(i.total_balance ?? '0'), currency: typeof i.currency === 'string' ? i.currency : undefined }
      }),
    }),
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/key',
    source: 'OpenRouter /api/v1/key',
    parse: b => {
      const d = obj(b.data) ?? {}
      const used = num(d.usage) ?? 0
      const limit = num(d.limit)
      return { cap: { used, limit, remaining: num(d.limit_remaining) ?? (limit !== undefined ? limit - used : undefined) }, plan: d.is_free_tier === true ? 'Free tier' : undefined }
    },
  },
  kimi: {
    url: 'https://api.moonshot.ai/v1/users/me/balance',
    source: 'Moonshot /v1/users/me/balance',
    parse: b => {
      const d = obj(b.data) ?? {}
      const amount = num(d.available_balance)
      return { balance: amount !== undefined ? [{ label: 'Available', amount: String(amount) }] : [], isBlocked: amount !== undefined && amount <= 0 }
    },
  },
  siliconflow: {
    url: 'https://api.siliconflow.com/v1/user/info',
    source: 'SiliconFlow /v1/user/info',
    parse: b => {
      const d = obj(b.data) ?? {}
      const total = d.totalBalance ?? d.balance
      return { balance: total !== undefined ? [{ label: 'Balance', amount: String(total) }] : [] }
    },
  },
}

async function readKey($: EngineInterface, id: string, r: KeyReader, now: number): Promise<Limits> {
  let key = await revealForRequest($, id)
  if (!key) return { at: now, state: 'error', source: r.source, error: 'the saved API key could not be decrypted' }
  try {
    const res = await $.http.fetch(r.url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } })
    if (!res.ok) return { at: now, state: 'error', source: r.source, error: `HTTP ${res.status}` }
    const body = obj(JSON.parse(res.text)) ?? {}
    return { at: now, state: 'ok', source: r.source, ...r.parse(body) }
  } finally {
    key = undefined
  }
}

/** Why there are no numbers, for the providers that report none. */
export function unsupportedReason(id: string): string {
  const p = provider(id)
  if (!p) return 'Unknown provider'
  if (p.kind === 'opencode-free') return 'Free models are rate-limited by OpenCode; it reports no quota.'
  return 'This provider has no documented endpoint for a key’s balance; see its console.'
}

/** The level each window was last announced at, so a toast shows once per window and level. */
const announced = new Map<string, number>()

/** Toasts a window that crossed 80% or 95% used, or a reported block, once each. */
export async function alertLimits($: EngineInterface, id: string, l: Limits): Promise<void> {
  if (l.state !== 'ok' || (await read($, settings)).limitAlerts === false) return
  const name = provider(id)?.label ?? id
  if (l.isBlocked) {
    const key = `${id}|blocked`
    if (!announced.has(key)) {
      announced.set(key, 100)
      $.ui.toast(`Jervis AI Hub: ${name} reports its limit reached.`)
    }
    return
  }
  announced.delete(`${id}|blocked`)
  for (const w of l.windows ?? []) {
    const level = [...ALERT_LEVELS].reverse().find(v => w.usedPercent >= v) ?? 0
    // a new window (another reset time) starts over
    const key = `${id}|${w.group ?? ''}|${w.label}|${w.resetsAt ?? ''}`
    if (level <= (announced.get(key) ?? 0)) continue
    announced.set(key, level)
    $.ui.toast(`Jervis AI Hub: ${name}${w.group ? ` ${w.group}` : ''} ${w.label.toLowerCase()} limit at ${Math.round(w.usedPercent)}% used.`)
  }
}

const reading = new Map<string, Promise<void>>()

/**
 * Reads one provider's limits and keeps them in state. A reading newer than
 * MIN_GAP_MS is kept unless `force` (the Refresh button); one in progress is shared.
 */
export function refreshLimits($: EngineInterface, id: string, opts: { force?: boolean } = {}): Promise<void> {
  const running = reading.get(id)
  if (running) return running
  const job = readLimits($, id, opts.force === true).finally(() => reading.delete(id))
  reading.set(id, job)
  return job
}

async function readLimits($: EngineInterface, id: string, force: boolean): Promise<void> {
  const p = provider(id)
  if (!p) return
  const now = await $.clock.now()
  const last = (await read($, limits))[id]
  if (!force && last && last.state === 'ok' && now - last.at < MIN_GAP_MS) return
  const reader = KEY_READERS[id]
  if (p.kind !== 'codex' && p.kind !== 'agy' && !reader) {
    await update($, limits, l => ({ ...l, [id]: { at: now, state: 'unsupported' as const, source: unsupportedReason(id) } }))
    return
  }
  await update($, limits, l => ({ ...l, [id]: { ...(l[id] ?? { source: '' }), at: l[id]?.at ?? now, state: 'checking' as const } }))
  let out: Limits
  try {
    out = p.kind === 'codex' ? await readCodex($, now) : p.kind === 'agy' ? await readAgy($, now) : await readKey($, id, reader!, now)
  } catch (error) {
    out = { at: now, state: 'error', source: p.kind === 'codex' ? 'Codex CLI' : p.kind === 'agy' ? 'agy /usage' : reader!.source, error: errText(error).slice(0, 200) }
  }
  await update($, limits, l => ({ ...l, [id]: out }))
  await alertLimits($, id, out)
}

/** Reads every connected provider's limits, one after another. */
export async function refreshAllLimits($: EngineInterface, opts: { force?: boolean } = {}): Promise<void> {
  await refreshClaudeLimits($).catch(() => undefined)
  const cfg = await read($, config)
  for (const id of Object.keys(cfg)) if (cfg[id]?.isConnected) await refreshLimits($, id, opts)
}
