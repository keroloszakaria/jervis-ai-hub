// SmartPicker: the best connected model for a task, from what the sources
// report (reasoning, tool calls, context, image input, list price) and what
// the providers report about their limits. No quality ranking is invented:
// every point a model scores is a reported fact, and the reason says which.
import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Capability, Limits, ModelInfo, Route, Task } from '../types'
import { EFFORT_ORDER, hasCapability } from './models'
import { provider } from './registry'
import { readiness } from './requests'

// state this file reads (the scan needs each atom declared in the file that uses it)
const config = atom({ plugin: 'ai-subscriptions', key: 'config' } as const, {}, { shape: 'cfg-3' })
const health = atom({ plugin: 'ai-subscriptions', key: 'health' } as const, {}, { shape: 'h-1' })
const limits = atom({ plugin: 'ai-subscriptions', key: 'limits' } as const, {}, { shape: 'l-1' })
const models = atom({ plugin: 'ai-subscriptions', key: 'models' } as const, {}, { shape: 'm-2' })

export type SmartPick = { route: Route; reason: string; label: string }

const thinks = (m: ModelInfo): boolean => m.reasoning === true || (m.efforts?.length ?? 0) > 0

/** The effort that suits the task, from the levels the model lists; none where it lists none. */
export function effortFor(m: ModelInfo, task: Task): string | undefined {
  const list = [...(m.efforts ?? [])].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
  if (!list.length) return undefined
  const first = (...want: string[]) => want.find(e => list.includes(e))
  if (task === 'reasoning' || task === 'review') return first('high', 'xhigh') ?? list[list.length - 1]
  if (task === 'code') return first('medium', 'high') ?? m.defaultEffort
  if (task === 'fast') return first('low', 'minimal') ?? list[0]
  return undefined
}

/** How much of the tightest reported window is used, for the windows that cover this model. */
function usedFor(l: Limits | undefined, m: ModelInfo | undefined): number | undefined {
  if (!l?.windows?.length) return undefined
  const name = `${m?.label ?? ''} ${m?.id ?? ''}`.toLowerCase()
  const covers = l.windows.filter(w => {
    if (!w.group) return true
    const words = w.group.toLowerCase().split(/[^a-z0-9]+/).filter(x => x && !['models', 'and', 'model'].includes(x))
    return words.some(x => name.includes(x))
  })
  return covers.length ? Math.max(...covers.map(w => w.usedPercent)) : undefined
}

/**
 * Scores every model of every ready provider (or of `only`) for the task and
 * returns the best, with the reported facts that won it.
 */
export async function smartPick(
  $: EngineInterface,
  task: Task,
  opts: { only?: string; needs?: Capability[] } = {},
): Promise<SmartPick | { reason: string }> {
  const cfg = await read($, config)
  const hl = await read($, health)
  const lims = await read($, limits)
  const all = await read($, models)
  const needs = opts.needs ?? (task === 'vision' ? ['image-input'] : [])
  type Cand = { id: string; m?: ModelInfo; score: number; why: string[]; cost?: number }
  const cands: Cand[] = []
  const ids = Object.keys(cfg).filter(id => cfg[id]?.isConnected && cfg[id]?.isEnabled && (!opts.only || id === opts.only))
  const costs: number[] = []
  for (const id of ids) {
    if (await readiness($, id)) continue
    const p = provider(id)
    if (!p) continue
    const l = lims[id]
    if (l?.isBlocked) continue
    const list = all[id]?.models ?? []
    const pool: (ModelInfo | undefined)[] = list.length ? list : [undefined]
    for (const m of pool) {
      if (m && needs.some(c => hasCapability(m, c) !== true)) continue
      if (!m && needs.length) continue
      const used = usedFor(l, m)
      if (used !== undefined && used >= 98) continue
      const why: string[] = []
      let score = 0
      const isInUse = m ? cfg[id]?.model === m.id : true
      if (m && thinks(m) && (task === 'code' || task === 'review' || task === 'reasoning')) {
        score += task === 'reasoning' ? 5 : 3
        why.push('reasoning')
      }
      if (m?.toolCalling && (task === 'code' || task === 'review')) {
        score += task === 'code' ? 2 : 1
        why.push('tool calls')
      }
      if (m?.contextWindow && m.contextWindow >= 200_000 && (task === 'review' || task === 'code')) {
        score += task === 'review' ? 2 : 1
        why.push(`${Math.round(m.contextWindow / 1000)}k context`)
      }
      if (m && needs.includes('image-input')) {
        score += 2
        why.push('image input')
      }
      if (task === 'fast' && m) {
        if (!thinks(m)) score += 2
        if (m.efforts?.includes('low')) {
          score += 1
          why.push('low effort')
        }
      }
      if (isInUse) {
        score += task === 'general' ? 3 : 1
        if (task === 'general') why.push('your chosen model')
      }
      if (used !== undefined) {
        score += 2 * (1 - used / 100)
        why.push(`${Math.round(100 - used)}% of plan left`)
      }
      if (p.billing !== 'api') {
        score += 1
        why.push(p.billing === 'free' ? 'free' : 'your plan')
      }
      if (hl[id]?.lastTest?.isOk) score += 1
      else if (hl[id]?.lastTest) score -= 3
      const cost = m && m.costIn !== undefined && m.costOut !== undefined ? m.costIn + m.costOut : undefined
      if (cost !== undefined) costs.push(cost)
      cands.push({ id, m, score, why, cost })
    }
  }
  if (task === 'fast' && costs.length > 1) {
    const max = Math.max(...costs)
    for (const c of cands) {
      if (c.cost === undefined || max <= 0) continue
      c.score += 3 * (1 - c.cost / max)
      c.why.push(`$${c.cost.toFixed(2)}/1M list price`)
    }
  }
  if (!cands.length) {
    return { reason: needs.length ? `no ready model reports ${needs.join(', ')}` : opts.only ? `${provider(opts.only)?.label ?? opts.only} is not ready` : 'no provider is connected and ready' }
  }
  const best = cands.reduce((a, b) => (b.score > a.score ? b : a))
  const p = provider(best.id)
  const effort = best.m ? effortFor(best.m, task) : undefined
  return {
    route: { provider: best.id, model: best.m?.id, effort },
    reason: `smart pick for ${task}${best.why.length ? `: ${best.why.join(', ')}` : ''}`,
    label: `${p?.label ?? best.id} · ${best.m?.label ?? 'default model'}${effort ? ` · ${effort}` : ''}`,
  }
}
