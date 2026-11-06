// Claude's own subagents: picks the model each type runs on when Claude names
// none, and keeps a short list of what each subagent this session ran on.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Settings, Spawn, SubagentModels } from '../types'
import { DEFAULT_SETTINGS } from './state'

// state this file reads (the scan needs each atom declared in the file that uses it)
const settings = atom({ plugin: 'ai-subscriptions', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'st-1' })
const spawns = atom({ plugin: 'ai-subscriptions', key: 'spawns' } as const, [], { shape: 'sp-1' })

/** The aliases this Claude Code build's Agent tool takes for `model`. */
export const SUBAGENT_MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const

/** The types the settings list by name; any other falls under '*'. */
export const SUBAGENT_TYPES = [
  { id: 'Explore', label: 'Explore (search)' },
  { id: 'general-purpose', label: 'General-purpose' },
  { id: 'Plan', label: 'Plan' },
  { id: '*', label: 'Any other type' },
] as const

/** Off until the person turns it on; the rules are a starting point they can change. */
export const DEFAULT_SUBAGENT_MODELS: SubagentModels = {
  isOn: false,
  rules: { Explore: 'haiku', 'general-purpose': 'sonnet', Plan: 'opus' },
  byLevel: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
}

/** The person's rules; settings saved before levels existed get the default model for each level. */
export const subagentModels = (s: Settings): SubagentModels =>
  s.subagentModels ? { ...s.subagentModels, byLevel: s.subagentModels.byLevel ?? DEFAULT_SUBAGENT_MODELS.byLevel } : DEFAULT_SUBAGENT_MODELS

/** What the spawn hook needs from `agent.spawn`'s input. */
export type SpawnFacts = {
  subagentType: string
  model?: string
  fork: boolean
  resume?: unknown
  workflow?: unknown
}

/**
 * The model a rule gives this spawn, or undefined to leave it alone: when the
 * hub's rules are off, Claude named a model, it is a fork (which always keeps
 * the parent's), a resumed run, or a workflow agent (its script chose).
 */
export function ruleFor(m: SubagentModels, e: SpawnFacts): string | undefined {
  if (!m.isOn || e.model || e.fork || e.resume || e.workflow) return undefined
  const pick = m.rules[e.subagentType] ?? m.rules['*']
  return pick && (SUBAGENT_MODELS as readonly string[]).includes(pick) ? pick : undefined
}

const KEEP = 20

/** Keeps what a started subagent runs on, for the Settings card; this session only. */
export async function recordSpawn($: EngineInterface, row: Omit<Spawn, 'at'>): Promise<void> {
  const at = await $.clock.now()
  await update($, spawns, list => [...list, { ...row, at }].slice(-KEEP))
}

export async function recentSpawns($: EngineInterface): Promise<Spawn[]> {
  return read($, spawns)
}

export async function currentRules($: EngineInterface): Promise<SubagentModels> {
  return subagentModels(await read($, settings))
}
