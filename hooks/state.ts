// Shared state of the hub: atoms the UI reads, and the keys they persist under.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Activity, Health, ModelList, PaneUi, ProviderConfig, Settings } from '../types'

export const STORE = {
  config: 'hub-config-v3',
  health: 'hub-health-v1',
  favorites: 'hub-favorites-v1',
  settings: 'hub-settings-v1',
  activity: 'hub-activity-v1',
  models: 'hub-models-v2',
  /** DPAPI ciphertexts (Windows) or keyring markers (macOS, Linux), never plaintext */
  creds: 'hub-creds-dpapi-v1',
  // earlier versions, read once for migration
  legacyConfig: 'config-v2',
  legacyKeys: 'keys-v1',
} as const

export const DEFAULT_SETTINGS: Settings = {
  routes: {},
  fallback: false,
  maxFallbacks: 1,
  confirmProjectAccess: true,
  recordPreviews: false,
  verifyOnConnect: true,
  retentionCount: 100,
  retentionDays: 30,
  useProjectProfile: false,
  profiles: {},
}

export const DEFAULT_UI: PaneUi = {
  tab: 'overview',
  search: '',
  addSearch: '',
  modelSearch: '',
  modelProvider: 'all',
  modelCap: 'any',
  favOnly: false,
  modelLimit: 25,
  notes: {},
  diagnostics: [],
  isDiagBusy: false,
  inputGen: 0,
}

export const config = atom({ plugin: 'ai-subscriptions', key: 'config' } as const, {}, { shape: 'cfg-3' })
export const health = atom({ plugin: 'ai-subscriptions', key: 'health' } as const, {}, { shape: 'h-1' })
export const models = atom({ plugin: 'ai-subscriptions', key: 'models' } as const, {}, { shape: 'm-2' })
export const favorites = atom({ plugin: 'ai-subscriptions', key: 'favorites' } as const, [], { shape: 'f-1' })
export const settings = atom({ plugin: 'ai-subscriptions', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'st-1' })
export const activity = atom({ plugin: 'ai-subscriptions', key: 'activity' } as const, [], { shape: 'a-1' })
export const ui = atom({ plugin: 'ai-subscriptions', key: 'ui' } as const, DEFAULT_UI, { shape: 'ui-2' })
export const limits = atom({ plugin: 'ai-subscriptions', key: 'limits' } as const, {}, { shape: 'l-1' })
export const cwd = atom({ plugin: 'ai-subscriptions', key: 'cwd' } as const, '', { shape: 'cwd-1' })

export async function saveConfig(
  $: EngineInterface,
  id: string,
  fn: (c: ProviderConfig) => ProviderConfig,
): Promise<void> {
  await update($, config, all => ({ ...all, [id]: fn(all[id] ?? { isConnected: false, isEnabled: true }) }))
  await $.store.set(STORE.config, await read($, config))
}

export async function setHealth($: EngineInterface, id: string, fn: (h: Health) => Health): Promise<void> {
  await update($, health, all => ({ ...all, [id]: fn(all[id] ?? { auth: 'unknown' }) }))
  await $.store.set(STORE.health, await read($, health))
}

export async function saveSettings($: EngineInterface, fn: (s: Settings) => Settings): Promise<void> {
  await update($, settings, s => fn({ ...DEFAULT_SETTINGS, ...s }))
  await $.store.set(STORE.settings, await read($, settings))
}

export async function saveFavorites($: EngineInterface, fn: (f: string[]) => string[]): Promise<void> {
  await update($, favorites, fn)
  await $.store.set(STORE.favorites, await read($, favorites))
}

export async function setModels($: EngineInterface, id: string, fn: (m: ModelList) => ModelList): Promise<void> {
  await update($, models, all => ({ ...all, [id]: fn(all[id] ?? { models: [], isLoading: false }) }))
}

export async function note(
  $: EngineInterface,
  id: string,
  text: string | undefined,
  isError = false,
  href?: string,
): Promise<void> {
  await update($, ui, u => {
    const notes = { ...u.notes }
    if (text === undefined) delete notes[id]
    else notes[id] = { text, isError, href }
    return { ...u, notes }
  })
}

export async function setUi($: EngineInterface, fn: (u: PaneUi) => PaneUi): Promise<void> {
  await update($, ui, u => fn({ ...DEFAULT_UI, ...u }))
}

export async function loadPersisted($: EngineInterface): Promise<void> {
  const get = async <T,>(key: string): Promise<T | undefined> => {
    try {
      return (await $.store.get(key)) as T | undefined
    } catch {
      return undefined
    }
  }
  const cfg = await get<Record<string, ProviderConfig>>(STORE.config)
  if (cfg && typeof cfg === 'object') await update($, config, () => cfg)
  const h = await get<Record<string, Health>>(STORE.health)
  if (h && typeof h === 'object') {
    // a check in flight when the last session ended is not a result
    const fixed = Object.fromEntries(
      Object.entries(h).map(([k, v]) => [k, v.auth === 'checking' ? { ...v, auth: 'unknown' as const } : v]),
    )
    await update($, health, () => fixed)
  }
  const fav = await get<string[]>(STORE.favorites)
  if (Array.isArray(fav)) await update($, favorites, () => fav)
  const st = await get<Settings>(STORE.settings)
  if (st && typeof st === 'object') await update($, settings, () => ({ ...DEFAULT_SETTINGS, ...st }))
  const act = await get<Activity[]>(STORE.activity)
  if (Array.isArray(act)) {
    await update($, activity, () => act.map(a => (a.state === 'running' ? { ...a, state: 'cancelled' as const } : a)))
  }
  const mods = await get<Record<string, ModelList>>(STORE.models)
  if (mods && typeof mods === 'object') {
    await update($, models, () =>
      Object.fromEntries(Object.entries(mods).map(([k, v]) => [k, { ...v, isLoading: false }])),
    )
  }
}
