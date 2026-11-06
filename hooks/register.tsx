// Jervis AI Hub (the ai-subscriptions mod): hooks and tools. The units live
// beside this file: registry (ProviderRegistry), models (ModelRegistry), auth
// (AuthenticationManager), health (HealthMonitor), routing (RoutingEngine),
// delegation (DelegationBridge), activity (ActivityStore), ui (the pane).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Level, ProviderConfig, Task } from '../types'
import { askTool, compareTool, delegateTool } from './actions'
import { protectLegacyKey } from './auth'
import { checkAllAuth, connect } from './health'
import { refreshAllLimits, refreshClaudeLimits } from './limits'
import { isModelListStale, refreshModels } from './models'
import { forgetOtherSessions, sessionKey } from './permissions'
import { PROVIDERS, TASKS, provider } from './registry'
import { STORE, loadPersisted, saveConfig } from './state'
import { LEVELS, LEVEL_USE, isLevel } from './levels'
import { GUIDE_ID, guideText } from './guide'
import { currentRules, recordSpawn, ruleFor } from './subagents'
import { BG, renderPane } from './ui'

// state this file reads (the scan needs each atom declared in the file that uses it)
const config = atom({ plugin: 'ai-subscriptions', key: 'config' } as const, {}, { shape: 'cfg-3' })
const cwd = atom({ plugin: 'ai-subscriptions', key: 'cwd' } as const, '', { shape: 'cwd-1' })
const models = atom({ plugin: 'ai-subscriptions', key: 'models' } as const, {}, { shape: 'm-2' })

const PANE = 'ai-subscriptions'
const TITLE = 'Jervis AI Hub'

/** Carries the previous version's providers over, and moves plaintext keys into DPAPI. */
async function migrate($: EngineInterface): Promise<void> {
  // model lists from before efforts were split are rediscovered under the new key
  await $.store.delete('hub-models-v1')
  const already = await $.store.get(STORE.config)
  const legacyKeys = (await $.store.get(STORE.legacyKeys)) as Record<string, string> | undefined
  if (legacyKeys && typeof legacyKeys === 'object') {
    let isAllSafe = true
    for (const [id, key] of Object.entries(legacyKeys)) {
      if (typeof key !== 'string' || !key) continue
      if (!(await protectLegacyKey($, id, key))) isAllSafe = false
    }
    // the plaintext goes either way: a key that could not be encrypted is asked for again
    await $.store.delete(STORE.legacyKeys)
    if (!isAllSafe) $.ui.toast('Jervis AI Hub: a saved API key could not be encrypted; connect that provider again.')
  }
  if (already) return
  const legacy = (await $.store.get(STORE.legacyConfig)) as
    | Record<string, { isConnected?: boolean; isEnabled?: boolean; model?: string }>
    | undefined
  if (legacy && typeof legacy === 'object') {
    for (const [id, c] of Object.entries(legacy)) {
      if (!provider(id) || !c?.isConnected) continue
      await saveConfig($, id, (x: ProviderConfig) => ({ ...x, isConnected: true, isEnabled: c.isEnabled !== false, model: c.model }))
    }
    await $.store.delete(STORE.legacyConfig)
    return
  }
  // first run: link the official sign-ins that already work here (checks only, no prompt sent)
  for (const id of ['chatgpt', 'antigravity', 'opencode-free']) void connect($, id)
}

/** (Re)declares the tools so their descriptions and enums name what is connected now. */
async function registerTools($: EngineInterface): Promise<void> {
  const cfg = await read($, config)
  const live = PROVIDERS.filter(p => cfg[p.id]?.isConnected && cfg[p.id]?.isEnabled)
  const names = live
    .map(p => `"${p.id}" = ${p.label}${cfg[p.id]?.model ? ` (model ${cfg[p.id]?.model}${cfg[p.id]?.effort ? `, effort ${cfg[p.id]?.effort}` : ''})` : ''}`)
    .join('; ')
  const providerProp = live.length
    ? { type: 'string', enum: live.map(p => p.id), description: 'A connected provider' }
    : { type: 'string', description: 'A connected provider' }
  const tasks = TASKS.map(t => t.id)

  await $.tool.register({
    name: 'ask_ai',
    isDeferred: false,
    description:
      'Send a prompt to another AI the user connected in Jervis AI Hub (their own subscriptions and API keys) and get its answer. ' +
      'Use it when the user asks to consult, get a second opinion from, or hand a question to one of these providers. ' +
      `Connected: ${names || 'none yet: ask the user to connect one in Jervis AI Hub'}. ` +
      'Give a task and leave provider out to let the hub pick the best connected model and effort for it (the user’s routing rules first); name a provider with a task and no model to get that provider’s best model for it. ' +
      'Say how hard the work is with level (light, standard or heavy): the hub then picks a model and effort that serve that level, so simple work does not spend a strong model. ' +
      'mode "read" (default) runs in an empty folder and sends only the prompt; pass cwd only when the provider must read project files (the user is asked). ' +
      'mode "write" lets that agent change files in cwd, only when the user asked for it (the user is asked). ' +
      'The other AI does not see this conversation: put all context in the prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: providerProp,
        task: { type: 'string', enum: tasks, description: 'Used for routing when provider is left out' },
        level: LEVEL_PROP,
        prompt: { type: 'string', description: 'The full, self-contained prompt' },
        mode: { type: 'string', enum: ['read', 'write'], description: 'read (default) or write' },
        model: { type: 'string', description: 'Optional model override; defaults to the one picked in the hub' },
        effort: {
          type: 'string',
          description: 'Optional reasoning effort (e.g. low, medium, high), only for models that list levels; defaults to the one picked in the hub',
        },
        cwd: { type: 'string', description: 'Optional project folder the provider may access' },
        preview: {
          type: 'boolean',
          description: 'true: only show which provider, model, effort, access and fallback the request would use; nothing is sent',
        },
      },
      required: ['prompt'],
    },
  })

  await $.tool.register({
    name: 'compare_ai',
    isDeferred: false,
    description:
      'Send the same read-only prompt to several connected providers at once and get their answers side by side, for comparing models. ' +
      'Runs in an empty folder: only the prompt is sent. Defaults to up to four ready providers, skipping any at its limit; each uses its best model for the task.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The full, self-contained prompt' },
        providers: { type: 'array', items: providerProp, description: 'Which providers (2 to 5); default: the ready ones' },
        task: { type: 'string', enum: tasks, description: 'Optional: each provider then answers with its best model and effort for this task' },
        level: LEVEL_PROP,
      },
      required: ['prompt'],
    },
  })

  await $.tool.register({
    name: 'delegate_ai',
    isDeferred: false,
    description:
      'Hand a bounded coding task to another agent (ChatGPT/Codex or Antigravity) through Jervis Relay: it edits the working tree of the repository, never commits, and reports the files it touched. ' +
      'Use only when the user asks to delegate work to that AI. The user confirms first. Review the diff afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: providerProp,
        brief: { type: 'string', description: 'A precise, self-contained task brief' },
        repo: { type: 'string', description: 'The repository folder; defaults to the session folder' },
      },
      required: ['provider', 'brief'],
    },
  })
}

const LEVEL_PROP = {
  type: 'string',
  enum: [...LEVELS],
  description: `How hard the work is: ${LEVELS.map(l => `${l} = ${LEVEL_USE[l]}`).join('; ')}`,
}

/** `/ask-ai` arguments: an optional provider (id or name), task and level, then the question. */
export async function parseAskArgs(
  $: EngineInterface,
  args: string,
): Promise<{ provider?: string; task?: Task; level?: Level; prompt: string; connected: string[]; preview: boolean }> {
  const cfg = await read($, config)
  const live = PROVIDERS.filter(p => cfg[p.id]?.isConnected && cfg[p.id]?.isEnabled)
  const all = args.trim().split(/\s+/).filter(Boolean)
  const preview = all.includes('--preview')
  const words = all.filter(w => w !== '--preview')
  let providerId: string | undefined
  let task: Task | undefined
  let level: Level | undefined
  for (let i = 0; i < 3 && words.length; i++) {
    const w = words[0]!.toLowerCase()
    const p = !providerId ? live.find(x => x.id === w || x.label.toLowerCase().split(/\s+/)[0] === w) : undefined
    const t = !task ? TASKS.find(x => x.id === w) : undefined
    if (p) providerId = p.id
    else if (t) task = t.id
    else if (!level && isLevel(w)) level = w
    else break
    words.shift()
  }
  return { provider: providerId, task, level, prompt: words.join(' '), connected: live.map(p => p.id), preview }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    // project-read grants never outlive the session that gave them
    forgetOtherSessions(await sessionKey($))
    await update($, cwd, () => e.cwd)
    await loadPersisted($)
    await migrate($)
    await $.command.register({
      name: 'ai-providers',
      description: 'Open Jervis AI Hub: connect AI providers, pick models, route, compare and review activity',
    })
    await $.command.register({
      name: 'ask-ai',
      description: 'Ask a connected AI directly: /ask-ai [provider] [task] [--preview] your question (read-only, only the question is sent)',
    })
    await registerTools($)
    void $.ui.open({ id: PANE, title: TITLE, backgroundColor: BG })
    // cheap checks only: sign-in present, models listed; no prompt is sent
    void checkAllAuth($)
    void refreshAllLimits($).catch(() => undefined)
    const cfg = await read($, config)
    const lists = await read($, models)
    // a missing list, or one older than a day, is read again in the background; the old one shows meanwhile
    const now = await $.clock.now()
    for (const p of PROVIDERS) if (cfg[p.id]?.isConnected && isModelListStale(lists[p.id], now)) void refreshModels($, p.id)
    return ran
  })

  // Claude's own windows move with each reply: keep the hub's copy current
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    if (e.changed.includes('rateLimits')) void refreshClaudeLimits($, e.rateLimits).catch(() => undefined)
    return r
  })

  // the routing guide, last in the system prompt; a thread keeps the one it started with
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    let text: string | undefined
    try {
      text = await guideText($)
    } catch {
      text = undefined
    }
    return text ? { sections: [...r.sections.filter(x => x.id !== GUIDE_ID), { id: GUIDE_ID, text, scope: 'session' as const }] } : r
  })

  // Claude's own subagents: a rule picks the model when Claude names none.
  // Nothing here may throw after next(e), or the spawn would be asked twice.
  on('agent.spawn', async ($, e, next) => {
    let model: string | undefined
    try {
      model = ruleFor(await currentRules($), e)
    } catch {
      model = undefined
    }
    const r = await next(model ? { ...e, model } : e)
    if (r.deny === undefined && !e.fork && !e.resume && !e.workflow) {
      const source = model ? 'rule' : e.model ? 'caller' : 'inherited'
      void recordSpawn($, { type: e.subagentType, model: r.model, source }).catch(() => undefined)
    }
    return r
  })

  // the tools follow what is connected
  on('state.set', { plugin: 'ai-subscriptions', key: 'config' }, async ($, e, next) => {
    const r = await next(e)
    void registerTools($)
    return r
  })

  on('command.run', { command: 'ai-providers' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, backgroundColor: BG })
    return { text: 'Jervis AI Hub opened.' }
  })

  // /ask-ai [provider] [task] question: the person's own words, read-only, in the empty folder
  on('command.run', { command: 'ask-ai' }, async ($, e) => {
    const parsed = await parseAskArgs($, e.args)
    if (!parsed.prompt) {
      return {
        text:
          'Usage: /ask-ai [provider] [task] [light|standard|heavy] [--preview] your question\n' +
          `Providers: ${parsed.connected.join(', ') || 'none connected yet (open /ai-providers)'}\n` +
          `Tasks: ${TASKS.map(t => t.id).join(', ')}. With neither, the hub picks the best connected model.`,
      }
    }
    const r = await askTool($, { provider: parsed.provider, task: parsed.task, level: parsed.level, prompt: parsed.prompt, mode: 'read', preview: parsed.preview })
    if (parsed.preview) return { text: r.text }
    return { text: r.text, context: [`The person asked another AI through /ask-ai. Its answer:\n${r.text}`] }
  })

  on('tool.call', { tool: 'mcp__ai-subscriptions__ask_ai' }, async ($, e) => {
    const a = e as unknown as Record<string, unknown>
    const prompt = str(a.prompt)
    if (!prompt) return { deny: 'ask_ai needs a prompt.' }
    const task = TASKS.some(t => t.id === a.task) ? (a.task as Task) : undefined
    const r = await askTool($, {
      provider: str(a.provider),
      task,
      level: isLevel(a.level) ? a.level : undefined,
      prompt,
      mode: a.mode === 'write' ? 'write' : 'read',
      model: str(a.model),
      effort: str(a.effort),
      cwd: str(a.cwd),
      preview: a.preview === true,
    })
    return r.isOk ? { result: r.text } : { deny: r.text }
  })

  // typed loosely until the engine lays this tool's types at the next reload
  on('tool.call', { tool: 'mcp__ai-subscriptions__compare_ai' as 'mcp__ai-subscriptions__ask_ai' }, async ($, e) => {
    const a = e as unknown as Record<string, unknown>
    const prompt = str(a.prompt)
    if (!prompt) return { deny: 'compare_ai needs a prompt.' }
    const ids = Array.isArray(a.providers) ? a.providers.filter((x): x is string => typeof x === 'string') : undefined
    const task = TASKS.some(t => t.id === a.task) ? (a.task as Task) : undefined
    const r = await compareTool($, prompt, ids, task, isLevel(a.level) ? a.level : undefined)
    return r.isOk ? { result: r.text } : { deny: r.text }
  })

  // typed loosely until the engine lays this tool's types at the next reload
  on('tool.call', { tool: 'mcp__ai-subscriptions__delegate_ai' as 'mcp__ai-subscriptions__ask_ai' }, async ($, e) => {
    const a = e as unknown as Record<string, unknown>
    const id = str(a.provider)
    const brief = str(a.brief)
    if (!id || !brief) return { deny: 'delegate_ai needs a provider and a brief.' }
    const r = await delegateTool($, id, brief, str(a.repo))
    return r.isOk ? { result: r.text } : { deny: r.text }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    return renderPane($, els, e.props.bodyColumns ?? 40)
  })
}
