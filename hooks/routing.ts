// RoutingEngine: picks the provider and model for a task, from the person's
// rules (per project when they turned profiles on), then the default
// provider, then the first verified one. Fallback is opt-in, read-only only.
import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Capability, Route, Routes, Task } from '../types'
import { hasCapability } from './models'
import { PROVIDERS } from './registry'
import { type RequestResult, readiness, runRequest } from './requests'
import { smartPick } from './smart'
import { DEFAULT_SETTINGS } from './state'

// state this file reads (the scan needs each atom declared in the file that uses it)
const config = atom({ plugin: 'ai-subscriptions', key: 'config' } as const, {}, { shape: 'cfg-3' })
const cwd = atom({ plugin: 'ai-subscriptions', key: 'cwd' } as const, '', { shape: 'cwd-1' })
const health = atom({ plugin: 'ai-subscriptions', key: 'health' } as const, {}, { shape: 'h-1' })
const models = atom({ plugin: 'ai-subscriptions', key: 'models' } as const, {}, { shape: 'm-2' })
const settings = atom({ plugin: 'ai-subscriptions', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'st-1' })

export async function activeRoutes($: EngineInterface): Promise<{ routes: Routes; profile: string }> {
  const s = await read($, settings)
  const here = await read($, cwd)
  if (s.useProjectProfile && here) return { routes: { ...s.routes, ...(s.profiles[here] ?? {}) }, profile: here }
  return { routes: s.routes, profile: 'global' }
}

/** Providers that can take a request now, verified ones first. */
export async function candidates($: EngineInterface): Promise<string[]> {
  const cfg = await read($, config)
  const h = await read($, health)
  const ready: string[] = []
  for (const p of PROVIDERS) {
    if (!cfg[p.id]?.isConnected || !cfg[p.id]?.isEnabled) continue
    if (await readiness($, p.id)) continue
    ready.push(p.id)
  }
  const score = (id: string) => (h[id]?.lastTest?.isOk ? 0 : h[id]?.lastTest ? 2 : 1)
  return ready.sort((a, b) => score(a) - score(b))
}

/** Where a task goes, and why. */
export async function route(
  $: EngineInterface,
  task: Task,
  needs: Capability[] = task === 'vision' ? ['image-input'] : [],
): Promise<{ route?: Route; reason: string }> {
  const { routes, profile } = await activeRoutes($)
  const ready = await candidates($)
  const rule = routes[task]
  if (rule && ready.includes(rule.provider)) {
    return { route: rule, reason: `${profile === 'global' ? 'routing rule' : 'project rule'} for ${task}` }
  }
  const s = await read($, settings)
  if (s.smartRouting !== false) {
    const pick = await smartPick($, task, { needs })
    return 'route' in pick ? { route: pick.route, reason: pick.reason } : { reason: pick.reason }
  }
  const all = await read($, models)
  const fits = (id: string): Route | undefined => {
    if (needs.length === 0) return { provider: id }
    const list = all[id]?.models ?? []
    const m = list.find(x => needs.every(c => hasCapability(x, c) === true))
    return m ? { provider: id, model: m.id } : undefined
  }
  if (s.defaultProvider && ready.includes(s.defaultProvider)) {
    const r = fits(s.defaultProvider)
    if (r) return { route: r, reason: 'default provider' }
  }
  for (const id of ready) {
    const r = fits(id)
    if (r) return { route: r, reason: needs.length ? `first ready provider with ${needs.join(', ')}` : 'first ready provider' }
  }
  return { reason: needs.length ? `no connected model reports ${needs.join(', ')}` : 'no provider is connected and ready' }
}

/**
 * One read-only request with the person's fallback rule: on failure, at most
 * `maxFallbacks` other ready providers, each tried once. Write requests never
 * fall back: a half-done change must not be repeated elsewhere.
 */
export async function askWithFallback(
  $: EngineInterface,
  first: Route,
  prompt: string,
  task: Task | undefined,
  projectDir: string | undefined,
): Promise<RequestResult & { tried: string[] }> {
  const s = await read($, settings)
  const tried: string[] = []
  let r = await runRequest($, { providerId: first.provider, model: first.model, effort: first.effort, prompt, mode: 'read', cwd: projectDir, type: 'ask', task })
  tried.push(first.provider)
  if (r.isOk || !s.fallback) return { ...r, tried }
  for (const id of await candidates($)) {
    if (tried.length - 1 >= s.maxFallbacks) break
    if (tried.includes(id)) continue
    r = await runRequest($, { providerId: id, prompt, mode: 'read', cwd: projectDir, type: 'ask', task, fallbackFrom: tried[tried.length - 1] })
    tried.push(id)
    if (r.isOk) break
  }
  return { ...r, tried }
}
