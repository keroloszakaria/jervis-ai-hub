// ModelRegistry: discovers each provider's models from its own CLI and fills
// in metadata only from a source that reports it (Codex's own catalog, or
// models.dev for OpenCode providers). Nothing is guessed.
import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Capability, ModelInfo } from '../types'
import { revealForRequest } from './auth'
import { clean, errText, exe } from './cli'
import { provider } from './registry'
import type { ProviderEntry } from './registry'
import { STORE, saveConfig, setModels } from './state'

// state this file reads (the scan needs each atom declared in the file that uses it)
const config = atom({ plugin: 'ai-subscriptions', key: 'config' } as const, {}, { shape: 'cfg-3' })
const models = atom({ plugin: 'ai-subscriptions', key: 'models' } as const, {}, { shape: 'm-2' })

type DevModel = {
  id?: string
  name?: string
  description?: string
  reasoning?: boolean
  tool_call?: boolean
  attachment?: boolean
  modalities?: { input?: string[] }
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number }
  status?: string
}

/** models.dev metadata per OpenCode provider id, fetched once a session. */
let devCache: Record<string, Record<string, DevModel>> | undefined
let devLoading: Promise<void> | undefined

async function loadModelsDev($: EngineInterface): Promise<void> {
  if (devCache) return
  devLoading ??= (async () => {
    try {
      const r = await $.http.fetch('https://models.dev/api.json')
      if (!r.ok) throw new Error(`models.dev answered ${r.status}`)
      const all = JSON.parse(r.text) as Record<string, { models?: Record<string, DevModel> }>
      devCache = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.models ?? {}]))
    } catch {
      devCache = {} // metadata is optional: the lists still work
    }
  })()
  await devLoading
}

export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const isEffort = (v: unknown): v is string => typeof v === 'string' && /^[a-z]+$/.test(v)

/**
 * Antigravity lists one model per effort ("gemini-4-argon-medium", "Gemini 4
 * Argon (Medium)"). Variants whose id and label both carry the same level are
 * folded into one model with an effort choice; the CLI's own ids are kept.
 */
export function groupEfforts(listed: { id: string; label: string }[]): ModelInfo[] {
  const out: ModelInfo[] = []
  const byBase = new Map<string, ModelInfo>()
  for (const { id, label } of listed) {
    const idM = /^(.*)-([a-z]+)$/.exec(id)
    const labelM = /^(.*?)\s*\(([A-Za-z]+)\)$/.exec(label)
    const level = idM?.[2]
    if (idM && labelM && level && EFFORT_ORDER.includes(level) && labelM[2]?.toLowerCase() === level) {
      const base = idM[1] ?? id
      let m = byBase.get(base)
      if (!m) {
        m = { id: base, label: labelM[1] ?? label, efforts: [], effortIds: {}, source: 'cli-list' }
        byBase.set(base, m)
        out.push(m)
      }
      m.efforts?.push(level)
      if (m.effortIds) m.effortIds[level] = id
      // the CLI's first listed variant is its default
      m.defaultEffort ??= level
      continue
    }
    out.push({ id, label, source: 'cli-list' })
  }
  for (const m of out) {
    if (m.efforts && m.efforts.length < 2) {
      // a lone variant is not a choice: keep it as the CLI lists it
      const only = m.effortIds ? Object.values(m.effortIds)[0] : undefined
      if (only) Object.assign(m, { id: only, efforts: undefined, effortIds: undefined, defaultEffort: undefined })
    }
    m.efforts?.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
  }
  return out
}

/** What a request sends for a picked model and effort: the CLI's model id, and an effort flag where the CLI takes one. */
export function resolveModel(
  list: ModelInfo[] | undefined,
  model: string | undefined,
  effort: string | undefined,
): { model?: string; cliModel?: string; effort?: string; effortArg?: string } {
  const info = model ? list?.find(m => m.id === model) : undefined
  if (!info?.efforts?.length) return { model, cliModel: model }
  const picked = effort && info.efforts.includes(effort) ? effort : undefined
  if (info.effortIds) {
    const e = picked ?? info.defaultEffort ?? info.efforts[0]
    return { model, cliModel: (e && info.effortIds[e]) || model, effort: e }
  }
  return { model, cliModel: model, effort: picked ?? info.defaultEffort, effortArg: picked }
}

/** An id saved before efforts were split (an Antigravity variant) as its model and effort now. */
export function splitLegacy(list: ModelInfo[], id: string): { model: string; effort?: string } | undefined {
  for (const m of list) {
    const hit = Object.entries(m.effortIds ?? {}).find(([, v]) => v === id)
    if (hit) return { model: m.id, effort: hit[0] }
  }
  return undefined
}

export const EFFORT_LABEL = (e: string): string =>
  ({ xhigh: 'Extra high', max: 'Max', ultra: 'Ultra', none: 'None', minimal: 'Minimal' })[e] ??
  `${e[0]?.toUpperCase() ?? ''}${e.slice(1)}`

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

async function discover($: EngineInterface, p: ProviderEntry): Promise<ModelInfo[]> {
  const path = await exe($, p.kind)
  if (!path) throw new Error('CLI not installed')

  if (p.kind === 'codex') {
    const r = await $.process.run([path, 'debug', 'models'], { timeoutMs: 60_000 })
    const json = JSON.parse(r.stdout) as {
      models?: {
        slug?: string
        display_name?: string
        description?: string
        visibility?: string
        context_window?: number
        input_modalities?: string[]
        supported_reasoning_levels?: { effort?: string }[]
        default_reasoning_level?: string
        supports_search_tool?: boolean
      }[]
    }
    return (json.models ?? [])
      .filter(m => m.slug && m.visibility !== 'hide')
      .map(m => ({
        id: m.slug ?? '',
        label: m.display_name ?? m.slug ?? '',
        description: m.description,
        contextWindow: num(m.context_window),
        inputModalities: Array.isArray(m.input_modalities) ? m.input_modalities : undefined,
        reasoning: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.length > 0 : undefined,
        reasoningLevels: m.supported_reasoning_levels?.map(l => l.effort ?? '').filter(Boolean),
        efforts: m.supported_reasoning_levels?.map(l => l.effort ?? '').filter(isEffort),
        defaultEffort: isEffort(m.default_reasoning_level) ? m.default_reasoning_level : undefined,
        webSearch: typeof m.supports_search_tool === 'boolean' ? m.supports_search_tool : undefined,
        // Codex runs every model as an agent with tools
        toolCalling: true,
        source: 'codex' as const,
      }))
  }

  if (p.kind === 'agy') {
    const r = await $.process.run([path, 'models'], { timeoutMs: 60_000 })
    const listed = clean(r.stdout)
      .split('\n')
      .map(l => l.split('\t'))
      .filter(([m, label]) => m && label && !/\s/.test(m.trim()))
      .map(([m = '', label = '']) => ({ id: m.trim(), label: label.trim() }))
    return groupEfforts(listed)
  }

  let env: Record<string, string> | undefined
  if (p.kind === 'opencode-key' && p.envVar) {
    const key = await revealForRequest($, p.id)
    if (!key) throw new Error('no API key saved')
    env = { [p.envVar]: key }
  }
  const r = await $.process.run([path, 'models', '--standalone'], { timeoutMs: 120_000, env })
  env = undefined
  const prefix = `${p.ocProvider}/`
  const ids = clean(r.stdout)
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith(prefix))
  await loadModelsDev($)
  const meta = devCache?.[p.ocProvider ?? ''] ?? {}
  return ids.map(id => {
    const short = id.slice(prefix.length)
    const d = meta[short]
    return {
      id,
      label: d?.name ?? short,
      description: d?.description,
      contextWindow: num(d?.limit?.context),
      maxOutput: num(d?.limit?.output),
      inputModalities: d?.modalities?.input,
      reasoning: d?.reasoning,
      toolCalling: d?.tool_call,
      costIn: num(d?.cost?.input),
      costOut: num(d?.cost?.output),
      status: d?.status,
      source: d ? ('models.dev' as const) : ('cli-list' as const),
    }
  })
}

/** Refreshes one provider's model list; keeps the old list on failure. */
export async function refreshModels($: EngineInterface, id: string): Promise<void> {
  const p = provider(id)
  if (!p) return
  const current = (await read($, models))[id]
  if (current?.isLoading) return
  await setModels($, id, m => ({ ...m, isLoading: true, error: undefined }))
  try {
    const list = await discover($, p)
    if (list.length === 0) throw new Error('the CLI listed no models for this account')
    const loadedAt = await $.clock.now()
    await setModels($, id, () => ({ models: list, isLoading: false, loadedAt }))
    const cfg = (await read($, config))[id]
    const legacy = cfg?.model && !list.some(m => m.id === cfg.model) ? splitLegacy(list, cfg.model) : undefined
    if (legacy) {
      await saveConfig($, id, c => ({ ...c, model: legacy.model, effort: legacy.effort }))
    } else if (!cfg?.model || !list.some(m => m.id === cfg.model)) {
      const pick = p.kind === 'opencode-free' ? (list.find(m => /free/i.test(m.id)) ?? list[0]) : list[0]
      await saveConfig($, id, c => ({ ...c, model: pick?.id }))
    }
  } catch (error) {
    await setModels($, id, m => ({ ...m, isLoading: false, error: errText(error) }))
  }
  // keep a trimmed copy so lists show at once next session
  const all = await read($, models)
  const keep = Object.fromEntries(
    Object.entries(all).map(([k, v]) => [k, { models: v.models.slice(0, 400), isLoading: false, loadedAt: v.loadedAt }]),
  )
  await $.store.set(STORE.models, keep)
}

export const CAPABILITIES: { id: Capability; label: string }[] = [
  { id: 'image-input', label: 'Image input' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'tool-calling', label: 'Tool calling' },
  { id: 'web-search', label: 'Web search' },
  { id: 'long-context', label: 'Context ≥ 200k' },
]

/** True, false, or undefined when the source does not say. */
export function hasCapability(m: ModelInfo, c: Capability): boolean | undefined {
  switch (c) {
    case 'image-input':
      return m.inputModalities ? m.inputModalities.includes('image') : undefined
    case 'reasoning':
      return m.reasoning
    case 'tool-calling':
      return m.toolCalling
    case 'web-search':
      return m.webSearch
    case 'long-context':
      return m.contextWindow === undefined ? undefined : m.contextWindow >= 200_000
  }
}

export const capabilityList = (m: ModelInfo): string[] =>
  CAPABILITIES.filter(c => hasCapability(m, c.id) === true).map(c => c.label)

export const favKey = (providerId: string, modelId: string): string => `${providerId}::${modelId}`
