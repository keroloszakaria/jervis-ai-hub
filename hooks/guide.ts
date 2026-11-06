// The routing guide: a short section of Claude's system prompt that says
// which kind of work goes where. It names only what stays the same through a
// conversation (the levels, the connected providers, the person's subagent
// models), never live limits, so it does not change mid-thread: a thread keeps
// the prompt it started with, and a changed one would cost the prompt cache.
import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Level } from '../types'
import { LEVELS, LEVEL_USE } from './levels'
import { PROVIDERS } from './registry'
import { DEFAULT_SETTINGS } from './state'
import { subagentModels } from './subagents'

// state this file reads (the scan needs each atom declared in the file that uses it)
const config = atom({ plugin: 'ai-subscriptions', key: 'config' } as const, {}, { shape: 'cfg-3' })
const settings = atom({ plugin: 'ai-subscriptions', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'st-1' })

export const GUIDE_ID = 'ai-subscriptions:levels'

/** The guide's text, or undefined when it is off or there is nothing to route to. */
export async function guideText($: EngineInterface): Promise<string | undefined> {
  const s = await read($, settings)
  if (s.levelGuide === false) return undefined
  const cfg = await read($, config)
  const live = PROVIDERS.filter(p => cfg[p.id]?.isConnected && cfg[p.id]?.isEnabled)
  const byLevel = subagentModels(s).byLevel ?? {}
  const sub = (l: Level) => byLevel[l]
  const hasSub = LEVELS.some(l => sub(l))
  if (!live.length && !hasSub) return undefined
  const lines = [
    '# Jervis AI Hub: match the model to the work',
    'Judge how hard each piece of work is, and spend a strong model only where it is needed:',
    ...LEVELS.map(l => `- ${l}: ${LEVEL_USE[l]}${sub(l) ? `. Subagent model: "${sub(l)}"` : ''}`),
  ]
  if (live.length) {
    lines.push(
      `To hand a piece to another AI the user connected (${live.map(p => p.label).join(', ')}), call ask_ai with that level; the hub picks a model and effort that serve it, within each provider's reported limits.`,
    )
  }
  if (hasSub) {
    lines.push('When you start a subagent and the user named no model, pass the subagent model for the work’s level as the Agent call’s model.')
  }
  return lines.join('\n')
}
