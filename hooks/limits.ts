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
import { errText, exe, sandboxDir } from './cli'
import { provider } from './registry'

const limits = atom({ plugin: 'ai-subscriptions', key: 'limits' } as const, {}, { shape: 'l-1' })
const config = atom({ plugin: 'ai-subscriptions', key: 'config' } as const, {}, { shape: 'cfg-3' })

const UTF8_OUT = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);'

/** Starts `codex app-server`, asks for the rate limits once, prints that one reply, and stops it. */
const codexScript = (path: string): string => `${UTF8_OUT}$ErrorActionPreference = 'Stop'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = '${path.replace(/'/g, "''")}'
$psi.Arguments = 'app-server'
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$psi.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
$p = [System.Diagnostics.Process]::Start($psi)
$p.StandardInput.WriteLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"jervis-ai-hub","version":"0.3.0"}}}')
$p.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"initialized"}')
$p.StandardInput.WriteLine('{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read"}')
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
  const r = await powershell($, codexScript(path), undefined, 40_000)
  const line = r.out.split(/\r?\n/).find(l => l.startsWith('{"id":2,'))
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
  const r = await $.process.run([path, '-p', '/usage', '--output-format', 'json'], { cwd: await sandboxDir($), timeoutMs: 60_000 })
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

/** Reads one provider's limits and keeps them in state. */
export async function refreshLimits($: EngineInterface, id: string): Promise<void> {
  const p = provider(id)
  if (!p) return
  const now = await $.clock.now()
  const reader = KEY_READERS[id]
  if (p.kind !== 'codex' && p.kind !== 'agy' && !reader) {
    await update($, limits, l => ({ ...l, [id]: { at: now, state: 'unsupported' as const, source: unsupportedReason(id) } }))
    return
  }
  await update($, limits, l => ({ ...l, [id]: { ...(l[id] ?? { source: '' }), at: now, state: 'checking' as const } }))
  let out: Limits
  try {
    out = p.kind === 'codex' ? await readCodex($, now) : p.kind === 'agy' ? await readAgy($, now) : await readKey($, id, reader!, now)
  } catch (error) {
    out = { at: now, state: 'error', source: p.kind === 'codex' ? 'Codex CLI' : p.kind === 'agy' ? 'agy /usage' : reader!.source, error: errText(error).slice(0, 200) }
  }
  await update($, limits, l => ({ ...l, [id]: out }))
}

/** Reads every connected provider's limits, one after another. */
export async function refreshAllLimits($: EngineInterface): Promise<void> {
  await refreshClaudeLimits($).catch(() => undefined)
  const cfg = await read($, config)
  for (const id of Object.keys(cfg)) if (cfg[id]?.isConnected) await refreshLimits($, id)
}
