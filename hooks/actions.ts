// What the tools do, with the confirmations that
// guard project access and changes.
import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Task } from '../types'
import { errText } from './cli'
import { delegate } from './delegation'
import { provider } from './registry'
import { compare, runRequest, usageLine } from './requests'
import type { RequestResult } from './requests'
import { askWithFallback, candidates, route } from './routing'
import { smartPick } from './smart'
import { setUi, DEFAULT_SETTINGS } from './state'

// state this file reads (the scan needs each atom declared in the file that uses it)
const cwd = atom({ plugin: 'ai-subscriptions', key: 'cwd' } as const, '', { shape: 'cwd-1' })
const settings = atom({ plugin: 'ai-subscriptions', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'st-1' })

/** Project folders the person allowed a provider to read for this session. */
const readGrants = new Set<string>()

/** Asks the person in the engine's own dialog; a dismissed dialog is a no. */
async function confirm($: EngineInterface, question: string, options: string[]): Promise<string | undefined> {
  try {
    return await $.ui.ask(question, { options, header: 'AI Hub' })
  } catch {
    return undefined
  }
}

export async function allowProjectRead($: EngineInterface, providerId: string, dir: string): Promise<boolean> {
  if (!(await read($, settings)).confirmProjectAccess) return true
  const grant = `${providerId}|${dir.toLowerCase()}`
  if (readGrants.has(grant)) return true
  const label = provider(providerId)?.label ?? providerId
  const answer = await confirm($, `Let ${label} read the files in ${dir}? Their contents go to that provider.`, [
    'Allow once',
    'Allow this session',
    'Deny',
  ])
  if (answer === 'Allow this session') readGrants.add(grant)
  return answer === 'Allow once' || answer === 'Allow this session'
}

export async function allowWrite($: EngineInterface, providerId: string, dir: string, how: string): Promise<boolean> {
  const label = provider(providerId)?.label ?? providerId
  const answer = await confirm($, `Let ${label} change files in ${dir} (${how})? Nothing is committed.`, ['Allow', 'Deny'])
  return answer === 'Allow'
}

export const header = (r: RequestResult): string =>
  `[${r.provider}${r.model ? ` · ${r.model}` : ''}${r.effort ? ` · ${r.effort}` : ''}${r.ms ? ` · ${(r.ms / 1000).toFixed(1)}s` : ''}]`

export type ToolAnswer = { isOk: boolean; text: string }

/** ask_ai: one provider (named, or routed by task), read-only unless write was asked and confirmed. */
export async function askTool(
  $: EngineInterface,
  a: { provider?: string; task?: Task; prompt: string; mode: 'read' | 'write'; model?: string; effort?: string; cwd?: string },
): Promise<ToolAnswer> {
  let providerId = a.provider
  let model = a.model
  let effort = a.effort
  let why = ''
  if (!providerId) {
    const r = await route($, a.task ?? 'general')
    if (!r.route) return { isOk: false, text: `No provider to route to: ${r.reason}. Connect one in Jervis AI Hub.` }
    providerId = r.route.provider
    model ??= r.route.model
    effort ??= r.route.effort
    why = r.reason
  } else if (!model && a.task && a.task !== 'general' && (await read($, settings)).smartRouting !== false) {
    // a named provider and a task: the best of that provider's models for it
    const pick = await smartPick($, a.task, { only: providerId })
    if ('route' in pick) {
      model = pick.route.model
      effort ??= pick.route.effort
      why = pick.reason
    }
  }
  const p = provider(providerId)
  if (!p) return { isOk: false, text: `Unknown provider "${providerId}".` }

  if (a.mode === 'write') {
    const dir = a.cwd ?? (await read($, cwd))
    if (!dir) return { isOk: false, text: 'Write mode needs a project folder (cwd).' }
    if (!(await allowWrite($, providerId, dir, 'ask_ai write mode'))) return { isOk: false, text: 'The person declined: no files were changed.' }
    const r = await runRequest($, { providerId, model, effort, prompt: a.prompt, mode: 'write', cwd: dir, type: 'ask', task: a.task })
    return { isOk: r.isOk, text: `${header(r)}\n${r.text}${usageLine(r.usage) ? `\n\n(${usageLine(r.usage)})` : ''}` }
  }

  if (a.cwd && !(await allowProjectRead($, providerId, a.cwd))) {
    return { isOk: false, text: 'The person declined project access: nothing was sent.' }
  }
  const r = await askWithFallback($, { provider: providerId, model, effort }, a.prompt, a.task, a.cwd)
  const via = `${why ? `\n(${why})` : ''}${r.tried.length > 1 ? `\n(fell back after: ${r.tried.slice(0, -1).join(', ')})` : ''}`
  return {
    isOk: r.isOk,
    text: `${header(r)}\n${r.text}${usageLine(r.usage) ? `\n\n(${usageLine(r.usage)})` : ''}${via}`,
  }
}

export async function compareTool($: EngineInterface, prompt: string, providers?: string[]): Promise<ToolAnswer> {
  const ids = providers?.length ? providers : (await candidates($)).slice(0, 4)
  if (ids.length < 2) return { isOk: false, text: 'Comparing needs at least two ready providers.' }
  const results = await compare($, ids, prompt)
  const text = results
    .map(r => `## ${header(r)}${r.isOk ? '' : ' (failed)'}\n${r.text}${usageLine(r.usage) ? `\n_${usageLine(r.usage)}_` : ''}`)
    .join('\n\n')
  return { isOk: results.some(r => r.isOk), text }
}

export async function delegateTool($: EngineInterface, providerId: string, brief: string, repo?: string): Promise<ToolAnswer> {
  const dir = repo ?? (await read($, cwd))
  if (!dir) return { isOk: false, text: 'Delegation needs a repository folder.' }
  if (!(await allowWrite($, providerId, dir, 'Jervis Relay delegation'))) return { isOk: false, text: 'The person declined: nothing was delegated.' }
  try {
    const r = await delegate($, providerId, brief, dir)
    return { isOk: r.isOk, text: r.text }
  } catch (error) {
    return { isOk: false, text: `Delegation failed: ${errText(error)}` }
  }
}
