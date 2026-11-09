// The hub's tools, host-neutral: one catalogue and one dispatcher, used by every
// host the hub runs in (the Claude Code plugin, and the MCP server the Codex and
// Antigravity plugins start). A host passes in its engine interface; nothing in
// here draws a pane or knows which host asks, beyond what `host` says.
import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Level, Task } from '../types'
import { applyChangesTool, askTool, compareTool, delegateTool } from './actions'
import { exportRow } from './activity'
import { runDiagnostics } from './diagnostics'
import { status, STATUS_LABEL } from './health'
import { hopDepth, MAX_HOPS, selfProvider } from './hops'
import { jobStatus, startJob, stopJob } from './jobs'
import { LEVEL_USE, LEVELS, isLevel } from './levels'
import { limitState, refreshAllLimits, unsupportedReason } from './limits'
import { capabilityList } from './models'
import { PROVIDERS, TASKS, provider } from './registry'
import { DEFAULT_UI } from './state'

// state this file reads (the scan needs each atom declared in the file that uses it)
const config = atom({ plugin: 'ai-subscriptions', key: 'config' } as const, {}, { shape: 'cfg-3' })
const models = atom({ plugin: 'ai-subscriptions', key: 'models' } as const, {}, { shape: 'm-2' })
const limits = atom({ plugin: 'ai-subscriptions', key: 'limits' } as const, {}, { shape: 'l-1' })
const activity = atom({ plugin: 'ai-subscriptions', key: 'activity' } as const, [], { shape: 'a-1' })
const ui = atom({ plugin: 'ai-subscriptions', key: 'ui' } as const, DEFAULT_UI, { shape: 'ui-2' })

/** Which host the hub runs in: Claude Code draws panes and asks in its own dialog; the MCP hosts do neither. */
export type Host = 'claude-code' | 'codex' | 'antigravity' | 'mcp'

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown>; isReadOnly: boolean }
export type ToolAnswer = { isOk: boolean; text: string }

/** The tools every host serves. */
export const TOOL_NAMES = [
  'ask_ai',
  'compare_ai',
  'delegate_ai',
  'apply_changes',
  'start_job',
  'job_status',
  'stop_job',
  'list_providers',
  'list_models',
  'get_limits',
  'preview_route',
  'get_activity',
  'get_diagnostics',
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

const LEVEL_PROP = {
  type: 'string',
  enum: [...LEVELS],
  description: `How hard the work is: ${LEVELS.map(l => `${l} = ${LEVEL_USE[l]}`).join('; ')}`,
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
const taskOf = (v: unknown): Task | undefined => (TASKS.some(t => t.id === v) ? (v as Task) : undefined)
const levelOf = (v: unknown): Level | undefined => (isLevel(v) ? v : undefined)

/** The tools, their descriptions naming what is connected now. */
export async function toolSpecs($: EngineInterface, host: Host): Promise<ToolSpec[]> {
  const cfg = await read($, config)
  const self = await selfProvider($)
  const live = PROVIDERS.filter(p => cfg[p.id]?.isConnected && cfg[p.id]?.isEnabled && p.id !== self)
  const providerProp = live.length ? { type: 'string', enum: live.map(p => p.id), description: 'A connected provider' } : { type: 'string', description: 'A connected provider' }
  const tasks = TASKS.map(t => t.id)
  const names = live.map(p => `"${p.id}" = ${p.label}`).join('; ') || 'none yet'
  const isClaude = host === 'claude-code'
  const asks = isClaude ? 'the user is asked' : 'the user must have allowed it; with no way to ask here, nothing is sent'
  return [
    {
      name: 'ask_ai',
      isReadOnly: false,
      description:
        `Send a prompt to another AI the user connected in Jervis AI Hub (their own subscriptions and API keys) and get its answer. Connected: ${names}. ` +
        'Leave provider out to let the hub pick by task and level. mode "read" (default) sends only the prompt and runs in an empty folder; ' +
        `cwd lets the provider read project files (${asks}). mode "write" changes files (${asks}). The other AI does not see this conversation.`,
      inputSchema: {
        type: 'object',
        properties: {
          provider: providerProp,
          task: { type: 'string', enum: tasks },
          level: LEVEL_PROP,
          prompt: { type: 'string', description: 'The full, self-contained prompt' },
          mode: { type: 'string', enum: ['read', 'write'] },
          model: { type: 'string' },
          effort: { type: 'string' },
          cwd: { type: 'string', description: 'Optional project folder the provider may read' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'compare_ai',
      isReadOnly: true,
      description: 'Send the same read-only prompt to several connected providers and get the answers side by side. Only the prompt is sent.',
      inputSchema: {
        type: 'object',
        properties: { prompt: { type: 'string' }, providers: { type: 'array', items: providerProp }, task: { type: 'string', enum: tasks }, level: LEVEL_PROP },
        required: ['prompt'],
      },
    },
    {
      name: 'delegate_ai',
      isReadOnly: false,
      description: isClaude
        ? 'Hand a bounded coding task to another agent. It works in a copy of the repository; the user then chooses Apply, Keep for later or Discard.'
        : 'Hand a bounded coding task to another agent. It works in a copy of the repository and its changes are kept for later: they reach the folder only when the user applies them from their own terminal (the answer says how).',
      inputSchema: {
        type: 'object',
        properties: { provider: providerProp, brief: { type: 'string' }, repo: { type: 'string' } },
        required: ['provider', 'brief'],
      },
    },
    {
      name: 'apply_changes',
      isReadOnly: false,
      description: isClaude
        ? 'Put the changes of a run kept for later to the user again: Apply, Keep for later or Discard. Only the user applies them.'
        : 'Say how the user applies a run kept for later. This tool never applies anything itself: the user runs the command it gives in their own terminal and answers there.',
      inputSchema: { type: 'object', properties: { run: { type: 'string' } }, required: ['run'] },
    },
    {
      name: 'start_job',
      isReadOnly: false,
      description: 'Start one piece of a big task in the background on another connected AI that serves its level, and return at once. job_status reads its result.',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, prompt: { type: 'string' }, level: LEVEL_PROP, provider: providerProp, cwd: { type: 'string' } },
        required: ['title', 'prompt', 'level'],
      },
    },
    { name: 'job_status', isReadOnly: true, description: 'The background jobs, one line each; with id, that job’s whole result once it ended.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
    { name: 'stop_job', isReadOnly: false, description: 'Stop a running background job on another AI.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    {
      name: 'list_providers',
      isReadOnly: true,
      description: 'The connected providers: signed in or not, verified by a real request or not. all: true lists every provider the hub knows.',
      inputSchema: { type: 'object', properties: { all: { type: 'boolean' } } },
    },
    {
      name: 'list_models',
      isReadOnly: true,
      description: 'The models each connected provider reports, with only the metadata its source gives (no guessed values).',
      inputSchema: { type: 'object', properties: { provider: { type: 'string' } } },
    },
    {
      name: 'get_limits',
      isReadOnly: true,
      description: 'What each provider itself reports about its limits, and the state that follows (available, limited, exhausted, stale, unknown, unsupported). Nothing is estimated.',
      inputSchema: { type: 'object', properties: { refresh: { type: 'boolean' } } },
    },
    {
      name: 'preview_route',
      isReadOnly: true,
      description: 'Which provider, model, effort, access and fallback a request would use, and why. Nothing is sent.',
      inputSchema: {
        type: 'object',
        properties: { provider: providerProp, task: { type: 'string', enum: tasks }, level: LEVEL_PROP, prompt: { type: 'string' }, mode: { type: 'string', enum: ['read', 'write'] } },
      },
    },
    { name: 'get_activity', isReadOnly: true, description: 'The recent requests, metadata only: no prompt, answer or error text.', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
    { name: 'get_diagnostics', isReadOnly: true, description: 'What is installed, where, and what works: CLIs, isolation, secure storage, relay.', inputSchema: { type: 'object', properties: {} } },
  ]
}

/** Runs one tool. A refusal or failure is `isOk: false` with why, never an exception. */
export async function callTool($: EngineInterface, host: Host, name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const a = args ?? {}
  switch (name) {
    case 'ask_ai': {
      const prompt = str(a.prompt)
      if (!prompt) return { isOk: false, text: 'ask_ai needs a prompt.' }
      const r = await askTool($, {
        provider: str(a.provider),
        task: taskOf(a.task),
        level: levelOf(a.level),
        prompt,
        mode: a.mode === 'write' ? 'write' : 'read',
        model: str(a.model),
        effort: str(a.effort),
        cwd: str(a.cwd),
        preview: a.preview === true,
      })
      return r
    }
    case 'preview_route': {
      return askTool($, {
        provider: str(a.provider),
        task: taskOf(a.task),
        level: levelOf(a.level),
        prompt: str(a.prompt) ?? '(preview)',
        mode: a.mode === 'write' ? 'write' : 'read',
        preview: true,
      })
    }
    case 'compare_ai': {
      const prompt = str(a.prompt)
      if (!prompt) return { isOk: false, text: 'compare_ai needs a prompt.' }
      const ids = Array.isArray(a.providers) ? a.providers.filter((x): x is string => typeof x === 'string') : undefined
      return compareTool($, prompt, ids, taskOf(a.task), levelOf(a.level))
    }
    case 'delegate_ai': {
      const id = str(a.provider)
      const brief = str(a.brief)
      if (!id || !brief) return { isOk: false, text: 'delegate_ai needs a provider and a brief.' }
      return delegateTool($, id, brief, str(a.repo))
    }
    case 'apply_changes': {
      const id = str(a.run)
      if (!id) return { isOk: false, text: 'apply_changes needs the run id.' }
      // an MCP host cannot be trusted to put a question to a person: the person applies from a terminal
      if (host !== 'claude-code') return { isOk: true, text: applyHint(id) }
      return applyChangesTool($, id)
    }
    case 'start_job': {
      const title = str(a.title)
      const prompt = str(a.prompt)
      if (!title || !prompt || !isLevel(a.level)) return { isOk: false, text: 'start_job needs a title, a prompt and a level (light, standard or heavy).' }
      // a Claude subagent exists only in Claude Code
      const runner = host === 'claude-code' ? (a.runner === 'subagent' || a.runner === 'other-ai' ? a.runner : 'auto') : 'other-ai'
      const r = await startJob($, { title, prompt, level: a.level, runner, provider: str(a.provider), cwd: str(a.cwd) })
      if (!r.job) return { isOk: false, text: r.error ?? 'The job was not started.' }
      const j = r.job
      const where = j.runner === 'subagent' ? `a Claude subagent${j.model ? ` (${j.model})` : ''}` : `${j.provider}${j.model ? ` · ${j.model}` : ''}${j.effort ? ` · ${j.effort}` : ''}`
      return { isOk: true, text: `Started job ${j.id} "${j.title}" at level ${j.level} on ${where}. job_status with this id reads its result.` }
    }
    case 'job_status':
      return { isOk: true, text: await jobStatus($, str(a.id)) }
    case 'stop_job': {
      const id = str(a.id)
      if (!id) return { isOk: false, text: 'stop_job needs the job id.' }
      return (await stopJob($, id)) ? { isOk: true, text: `Asked job ${id} to stop; job_status shows when it has.` } : { isOk: false, text: `Job ${id} is not a running job on another AI here.` }
    }
    case 'list_providers':
      return { isOk: true, text: await providersText($, a.all === true) }
    case 'list_models':
      return { isOk: true, text: await modelsText($, str(a.provider)) }
    case 'get_limits':
      return { isOk: true, text: await limitsText($, a.refresh === true) }
    case 'get_activity': {
      const n = typeof a.limit === 'number' && a.limit > 0 ? Math.min(200, Math.floor(a.limit)) : 20
      const rows = (await read($, activity)).slice(-n).map(exportRow)
      return { isOk: true, text: rows.length ? JSON.stringify(rows, null, 2) : 'No requests yet.' }
    }
    case 'get_diagnostics': {
      await runDiagnostics($)
      const rows = (await read($, ui)).diagnostics ?? []
      const depth = await hopDepth($)
      const lines = rows.map(r => `${r.isOk ? 'ok  ' : 'FAIL'} ${r.name}: ${r.detail}`)
      lines.push(`host: ${host}; hub depth ${depth} (a hub at depth ${MAX_HOPS} or more sends nothing on)`)
      return { isOk: true, text: lines.join('\n') }
    }
    default:
      return { isOk: false, text: `Unknown tool "${name}".` }
  }
}

/** How a person applies a kept run from their own terminal: the one place an MCP host's Apply comes from. */
export function applyHint(run: string): string {
  return (
    `The changes of ${run} are kept, not applied. Nothing in this conversation can apply them: ` +
    `the user applies them from their own terminal, where they see the changed files and answer themselves. ` +
    `From the Jervis AI Hub plugin's folder:\n\n    node dist/jervis-mcp.mjs apply ${run}`
  )
}

async function providersText($: EngineInterface, isAll: boolean): Promise<string> {
  const cfg = await read($, config)
  const self = await selfProvider($)
  const lines: string[] = []
  let hidden = 0
  for (const p of PROVIDERS) {
    const c = cfg[p.id]
    if (!isAll && !c?.isConnected) {
      hidden++
      continue
    }
    const st = c?.isConnected ? STATUS_LABEL[await status($, p.id)] : 'not connected'
    const extra = p.id === self ? ' (the agent this hub runs inside: never sent requests from here)' : ''
    lines.push(`${p.id}: ${p.label} · ${p.billing === 'api' ? 'API key (billed per use)' : p.billing === 'free' ? 'free' : 'subscription'} · ${st}${c?.model ? ` · model ${c.model}` : ''}${extra}`)
  }
  if (!lines.length) lines.push('No provider is connected.')
  if (hidden) lines.push(`(${hidden} more not connected; all: true lists them)`)
  return lines.join('\n')
}

async function modelsText($: EngineInterface, only?: string): Promise<string> {
  if (only === 'claude-code') return 'Claude Code CLI uses the account’s default model unless you supply a model alias or ID.'
  const lists = await read($, models)
  const out: string[] = []
  for (const [id, list] of Object.entries(lists)) {
    if (only && id !== only) continue
    out.push(`## ${provider(id)?.label ?? id}${list?.loadedAt ? ` (listed ${new Date(list.loadedAt).toISOString()})` : ''}`)
    for (const m of list?.models ?? []) {
      const caps = capabilityList(m)
      out.push(`- ${m.id}${m.label && m.label !== m.id ? ` (${m.label})` : ''}${m.efforts?.length ? ` · efforts ${m.efforts.join('/')}` : ''}${caps.length ? ` · ${caps.join(', ')}` : ''}${m.contextWindow ? ` · context ${m.contextWindow}` : ''}`)
    }
  }
  return out.length ? out.join('\n') : only ? `No models listed for ${only} yet.` : 'No model lists yet.'
}

async function limitsText($: EngineInterface, refresh: boolean): Promise<string> {
  if (refresh) await refreshAllLimits($, { force: true }).catch(() => undefined)
  const lims = await read($, limits)
  const cfg = await read($, config)
  const now = await $.clock.now()
  const out: string[] = []
  for (const p of PROVIDERS) {
    if (!cfg[p.id]?.isConnected) continue
    const l = lims[p.id]
    const st = limitState(l, now)
    out.push(`${p.id}: ${st}${l ? ` (read ${Math.round((now - l.at) / 60_000)} min ago, from ${l.source})` : ''}`)
    if (l?.state === 'unsupported') out.push(`  ${unsupportedReason(p.id)}`)
    for (const w of l?.windows ?? []) out.push(`  ${w.group ? `${w.group} · ` : ''}${w.label}: ${w.usedPercent}% used${w.resetsAt ? `, resets ${new Date(w.resetsAt).toISOString()}` : ''}`)
    for (const b of l?.balance ?? []) out.push(`  ${b.label}: ${b.amount}${b.currency ? ` ${b.currency}` : ''}`)
  }
  return out.length ? out.join('\n') : 'No provider is connected.'
}
