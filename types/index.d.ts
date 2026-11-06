// Jervis AI Hub (the ai-subscriptions mod): the values it keeps in $.state.

export type Mode = 'read' | 'write'

/** How a provider is reached. */
export type Kind = 'codex' | 'agy' | 'opencode-free' | 'opencode-key'
export type AuthMethod = 'subscription' | 'api-key' | 'free'

/** The tasks the routing engine has a default for. */
export type Task = 'general' | 'code' | 'review' | 'reasoning' | 'fast' | 'vision'
/** The kind of work a request is: Claude says which when it asks. */
export type Level = 'light' | 'standard' | 'heavy'

export type Capability = 'image-input' | 'reasoning' | 'tool-calling' | 'web-search' | 'long-context'

/** What the person chose for one provider. Credentials never live here. */
export type ProviderConfig = {
  isConnected: boolean
  isEnabled: boolean
  model?: string
  /** reasoning effort for the model, only where its source lists levels */
  effort?: string
  connectedAt?: number
}

/**
 * Authentication and availability are kept apart: `auth` says whether the
 * credential or sign-in is present; only `lastTest` proves a request worked.
 */
export type AuthState =
  | 'unknown'
  | 'checking'
  | 'not-installed'
  | 'signed-out'
  | 'missing-credential'
  | 'authenticated'

export type Health = {
  auth: AuthState
  authCheckedAt?: number
  authMessage?: string
  lastTest?: { isOk: boolean; at: number; ms: number; message: string }
  lastSuccessAt?: number
  lastLatencyMs?: number
}

/** Model metadata as a source reported it; a field the source lacks stays absent. */
export type ModelInfo = {
  id: string
  label: string
  description?: string
  contextWindow?: number
  maxOutput?: number
  inputModalities?: string[]
  reasoning?: boolean
  reasoningLevels?: string[]
  /** effort levels the person can pick, as the source lists them */
  efforts?: string[]
  defaultEffort?: string
  /** for CLIs that list one model per effort (Antigravity): effort -> the CLI's own id */
  effortIds?: Record<string, string>
  toolCalling?: boolean
  webSearch?: boolean
  /** USD per million tokens, API list price as models.dev lists it */
  costIn?: number
  costOut?: number
  status?: string
  source: 'codex' | 'models.dev' | 'cli-list'
}

export type ModelList = {
  models: ModelInfo[]
  isLoading: boolean
  error?: string
  loadedAt?: number
}

/** Token counts a CLI reported for one request; absent when it reports none. */
export type Usage = {
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  reasoningTokens?: number
  /** USD cost the CLI itself recorded for the request (OpenCode's session cost); never estimated by the hub */
  costUsd?: number
}

export type ActivityType = 'ask' | 'compare' | 'delegate' | 'test'

export type Activity = {
  id: string
  at: number
  type: ActivityType
  provider: string
  model?: string
  effort?: string
  task?: Task
  mode: Mode
  state: 'running' | 'ok' | 'error' | 'cancelled'
  ms?: number
  promptChars: number
  /** only when the person turned prompt previews on; redacted */
  preview?: string
  resultPreview?: string
  error?: string
  usage?: Usage
  fallbackFrom?: string
  touchedFiles?: string[]
}

export type Route = { provider: string; model?: string; effort?: string }
export type Routes = Partial<Record<Task, Route>>

export type Settings = {
  defaultProvider?: string
  routes: Routes
  /** with no rule for a task, pick the best-fitting connected model for it */
  smartRouting?: boolean
  /** toasts when a provider's reported window passes 80% or 95% used */
  limitAlerts?: boolean
  /** a toast when a request that ran 30 seconds or more ends; on when absent */
  doneAlerts?: boolean
  /** the model each type of Claude subagent runs on when Claude names none */
  subagentModels?: SubagentModels
  /** levels the person set by hand, by "provider::model" */
  levels?: Record<string, Level>
  /** a short guide in Claude's system prompt: which connected model serves each level; on when absent */
  levelGuide?: boolean
  /** the pane's language; English when absent */
  language?: 'en' | 'ar'
  fallback: boolean
  maxFallbacks: number
  confirmProjectAccess: boolean
  recordPreviews: boolean
  verifyOnConnect: boolean
  retentionCount: number
  retentionDays: number
  useProjectProfile: boolean
  profiles: Record<string, Routes>
}

/**
 * Rules for Claude's own subagents. A rule applies only when the Agent call
 * names no model; `'*'` is every type without a rule of its own.
 */
export type SubagentModels = {
  isOn: boolean
  /** subagent type (or '*') -> model alias (haiku, sonnet, opus, ...) */
  rules: Record<string, string>
  /** the Claude model alias for each level, which the guide tells Claude to pass on its Agent calls */
  byLevel?: Partial<Record<Level, string>>
}

/** One subagent this session started, and what it ran on. */
export type Spawn = {
  at: number
  type: string
  /** the model the engine reports the subagent runs on */
  model: string
  /** who chose it: a hub rule, Claude's own call, or nobody (its definition or the session's model) */
  source: 'rule' | 'caller' | 'inherited'
}

/** How far a running request has got, as its CLI's output shows; kept for this session only. */
export type Progress = {
  startedAt: number
  /** the last time the hub looked, ms */
  at: number
  /** bytes of output the CLI has written so far */
  bytes: number
  /** when the CLI last wrote anything; absent before its first output */
  lastOutputAt?: number
}

export type Note = { text: string; isError?: boolean; href?: string }

export type DiagRow = { name: string; isOk: boolean; detail: string }

export type Tab = 'overview' | 'models' | 'activity' | 'settings'

export type PaneUi = {
  tab: Tab
  view?: 'add' | 'provider'
  expanded?: string
  search: string
  addSearch: string
  modelSearch: string
  modelProvider: string
  modelCap: string
  /** the Models list's level filter */
  modelLevel?: 'any' | Level
  favOnly: boolean
  selectedModel?: string
  modelLimit: number
  notes: Record<string, Note>
  activityOpen?: string
  /** the Activity list's type filter */
  actFilter?: 'all' | ActivityType
  diagnostics: DiagRow[]
  isDiagBusy: boolean
  /** bumps to clear text fields after a submit */
  inputGen: number
}

/** One usage window a provider reports, as it reports it. */
export type LimitWindow = { label: string; usedPercent: number; resetsAt?: number; /** the model group the window covers */ group?: string }
/** What a provider itself reported about its limits; nothing here is estimated. */
export type Limits = {
  /** when the hub last asked, ms */
  at: number
  state: 'ok' | 'error' | 'unsupported' | 'checking'
  windows?: LimitWindow[]
  /** prepaid balance or credit, as the provider reports it */
  balance?: { label: string; amount: string; currency?: string }[]
  /** spend cap on the key, where the provider has one */
  cap?: { used: number; limit?: number; remaining?: number }
  plan?: string
  /** a block the provider reported (limit reached) */
  isBlocked?: boolean
  /** where the numbers came from, or why there are none */
  source: string
  error?: string
}

// Inside the augmentation below, a bare name resolves to claude-code's own
// export first (claude-code exports a `Settings`), so the values go by these
// unique aliases.
export type HubProviderConfig = ProviderConfig
export type HubHealth = Health
export type HubModelList = ModelList
export type HubSettings = Settings
export type HubActivity = Activity
export type HubPaneUi = PaneUi
export type HubLimits = Limits
export type HubProgress = Progress
export type HubSpawn = Spawn

declare module 'claude-code' {
  interface PluginState {
    'ai-subscriptions': {
      config: Shaped<Record<string, HubProviderConfig>>
      health: Shaped<Record<string, HubHealth>>
      models: Shaped<Record<string, HubModelList>>
      favorites: Shaped<string[]>
      settings: Shaped<HubSettings>
      activity: Shaped<HubActivity[]>
      ui: Shaped<HubPaneUi>
      cwd: Shaped<string>
      limits: Shaped<Record<string, HubLimits>>
      progress: Shaped<Record<string, HubProgress>>
      spawns: Shaped<HubSpawn[]>
    }
  }
}
