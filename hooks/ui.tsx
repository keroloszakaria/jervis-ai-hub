// Jervis AI Hub: the pane. Four tabs (Overview, Models, Activity, Settings),
// a page per provider, and the Add Provider view. Every control here does what
// it says.
import { LOGOS } from './logos'
import { atom, read } from 'claude-code'
import type { EngineInterface, Elements } from 'claude-code'

import type { Activity, Limits, ModelInfo, PaneUi, Route, Settings, Task } from '../types'
import { clearActivity, snip, stats } from './activity'
import { runDiagnostics } from './diagnostics'
import { refreshAllLimits, refreshLimits } from './limits'
import { STATUS_COLOR, connect, disconnect, status, test } from './health'
import type { Status } from './health'
import { CAPABILITIES, EFFORT_LABEL, capabilityList, favKey, hasCapability, refreshModels, resolveModel } from './models'
import { AUTH_LABEL, PROVIDERS, TASKS, provider } from './registry'
import type { ProviderEntry } from './registry'
import { usageLine } from './requests'
import { activeRoutes } from './routing'
import { smartPick } from './smart'
import type { SmartPick } from './smart'
import { saveConfig, saveFavorites, saveSettings, setUi, DEFAULT_SETTINGS, DEFAULT_UI } from './state'

// state this file reads (the scan needs each atom declared in the file that uses it)
const activity = atom({ plugin: 'ai-subscriptions', key: 'activity' } as const, [], { shape: 'a-1' })
const config = atom({ plugin: 'ai-subscriptions', key: 'config' } as const, {}, { shape: 'cfg-3' })
const cwd = atom({ plugin: 'ai-subscriptions', key: 'cwd' } as const, '', { shape: 'cwd-1' })
const favorites = atom({ plugin: 'ai-subscriptions', key: 'favorites' } as const, [], { shape: 'f-1' })
const health = atom({ plugin: 'ai-subscriptions', key: 'health' } as const, {}, { shape: 'h-1' })
const models = atom({ plugin: 'ai-subscriptions', key: 'models' } as const, {}, { shape: 'm-2' })
const settings = atom({ plugin: 'ai-subscriptions', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'st-1' })
const limits = atom({ plugin: 'ai-subscriptions', key: 'limits' } as const, {}, { shape: 'l-1' })
const ui = atom({ plugin: 'ai-subscriptions', key: 'ui' } as const, DEFAULT_UI, { shape: 'ui-2' })

type Els = Elements[keyof Elements]

// ---------- formatting ----------
const ago = (now: number, at: number | undefined): string => {
  if (at === undefined) return 'never'
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86_400)}d ago`
}
const until = (now: number, at: number | undefined): string => {
  if (at === undefined) return ''
  const m = Math.max(0, Math.round((at - now) / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}
const pctColor = (p: number): string => (p >= 90 ? 'error' : 'success')
const ms = (v: number | undefined): string => (v === undefined ? '–' : v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(1)}s`)
const k = (n: number | undefined): string =>
  n === undefined ? '–' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
const yesNo = (v: boolean | undefined): string => (v === undefined ? 'not reported' : v ? 'yes' : 'no')
const cap = (s: string): string => `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}`
const shortModel = (id: string): string => id.replace(/^.*\//, '')

const PILL: Record<Status, string> = {
  verified: 'Verified',
  unverified: 'Not tested',
  failing: 'Test failed',
  'signed-out': 'Signed out',
  'not-installed': 'CLI missing',
  checking: 'Checking…',
  disabled: 'Off',
}
const DOT: Record<Status, string> = {
  verified: '●',
  unverified: '◐',
  failing: '●',
  'signed-out': '○',
  'not-installed': '○',
  checking: '◌',
  disabled: '○',
}
const STATE_ICON: Record<Activity['state'], string> = { ok: '✓', error: '✗', running: '●', cancelled: '–' }
const STATE_COLOR: Record<Activity['state'], string> = { ok: 'success', error: 'error', running: 'warning', cancelled: 'inactive' }
const BILLING: Record<ProviderEntry['billing'], string> = {
  subscription: 'Uses your plan’s limits; no per-request bill. Remaining quota is not reported to the hub.',
  api: 'Billed per token by the provider on your API account.',
  free: 'Free tier; the provider may rate-limit it.',
}
const BILLING_TAG: Record<ProviderEntry['billing'], string> = { subscription: 'Subscription', api: 'API key', free: 'Free' }

// ---------- palette: black, white and neon orange ----------
export const BG = '#0A0A0A'
const FG = '#FFFFFF'
const MUTED = '#9A9A9A'
const NEON = '#FF6A00'
const NEON_SOFT = '#FFA45C'
const DANGER = '#FF3B30'
/** theme keys the pane uses, mapped onto the palette so it reads the same in a light or dark app */
const TONE: Record<string, string> = {
  success: NEON,
  warning: NEON_SOFT,
  error: DANGER,
  claude: NEON,
  inactive: MUTED,
  subtle: MUTED,
  text: FG,
}
const tone = (c: unknown, dim: unknown): string => (typeof c === 'string' ? (TONE[c] ?? c) : dim ? MUTED : FG)

// ---------- drawings (desktop surfaces; the terminal draws the text fallbacks) ----------
const PALETTE = ['#FF6A00', '#FF8A33', '#E65C00', '#FFA45C', '#CC5500', '#FF7A1A']
// the design's provider marks: a two-letter code on a fixed color
const MARK: Record<string, { code: string; fill: string }> = {
  chatgpt: { code: 'OA', fill: '#FF6A00' },
  antigravity: { code: 'AG', fill: '#FF6A00' },
  'opencode-free': { code: 'OZ', fill: '#FF6A00' },
  deepseek: { code: 'DS', fill: '#FF6A00' },
  openrouter: { code: 'OR', fill: '#FF6A00' },
  google: { code: 'GM', fill: '#FF6A00' },
  xai: { code: 'XA', fill: '#FF6A00' },
  mistral: { code: 'MI', fill: '#FF6A00' },
  groq: { code: 'GQ', fill: '#FF6A00' },
  moonshot: { code: 'KM', fill: '#FF6A00' },
}
const markOf = (id: string, label: string) =>
  MARK[id] ?? { code: (label.replace(/\(.*?\)/g, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || '?').toUpperCase(), fill: PALETTE[hashOf(label) % PALETTE.length] ?? '#64748B' }
const hashOf = (s: string): number => {
  let n = 7
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0
  return n
}
const avatarSvg = (id: string, label: string): string => {
  const logo = LOGOS[id === 'claude' ? 'anthropic' : id]
  if (logo)
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">` +
      `<rect width="40" height="40" rx="11" fill="#FFFFFF"/>` +
      `<rect x="0.5" y="0.5" width="39" height="39" rx="10.5" fill="none" stroke="#18181B" stroke-opacity="0.10"/>` +
      `<svg x="9" y="9" width="22" height="22" viewBox="0 0 24 24">${logo}</svg>` +
      `</svg>`
    )
  const { code, fill } = markOf(id, label)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${fill}" stop-opacity="1"/><stop offset="1" stop-color="${fill}" stop-opacity="0.78"/></linearGradient></defs>` +
    `<rect width="40" height="40" rx="11" fill="#0B0B0C"/>` +
    `<rect width="40" height="40" rx="11" fill="url(#g)"/>` +
    `<text x="20" y="25.5" text-anchor="middle" font-family="JetBrains Mono, Cascadia Mono, Consolas, monospace" font-size="15" font-weight="700" fill="#FFFFFF">${code}</text>` +
    `</svg>`
  )
}
/** a usage meter: used share of a plan window */
const meterSvg = (pct: number, width: number): string => {
  const w = Math.max(40, width)
  const f = Math.max(0, Math.min(100, pct))
  const c = f >= 90 ? ['#FF6B60', '#FF3B30'] : ['#FFB070', '#FF6A00']
  const fw = f === 0 ? 0 : Math.max(6, (w * f) / 100)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="8" viewBox="0 0 ${w} 8" style="overflow:visible">` +
    `<style>.f{transform-origin:0 50%;animation:m .8s cubic-bezier(.2,.9,.25,1) both}@keyframes m{from{transform:scaleX(0)}to{transform:scaleX(1)}}</style>` +
    `<defs><linearGradient id="m" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${c[0]}"/><stop offset="1" stop-color="${c[1]}"/></linearGradient></defs>` +
    `<rect width="${w}" height="8" rx="4" fill="#FFFFFF" fill-opacity="0.10"/>` +
    (fw ? `<rect class="f" width="${fw.toFixed(1)}" height="8" rx="4" fill="url(#m)" style="filter:drop-shadow(0 0 4px ${c[1]})"/>` : '') +
    `</svg>`
  )
}
/** latency bars for the latest requests, colored by outcome */
const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const latencySvg = (rows: Activity[], width: number): string => {
  const H = 72
  const n = Math.max(rows.length, 20)
  const max = Math.max(1, ...rows.map(r => r.ms ?? 0))
  const slot = width / n
  const bar = Math.max(3, Math.min(18, slot * 0.56))
  const grad = (a: Activity) => (a.state === 'error' ? 'r' : a.state === 'ok' ? 't' : 'a')
  const grid = [0.33, 0.66]
    .map(f => `<line x1="0" y1="${(H - 4 - f * (H - 10)).toFixed(1)}" x2="${width}" y2="${(H - 4 - f * (H - 10)).toFixed(1)}" stroke="#FFFFFF" stroke-opacity="0.08" stroke-dasharray="2 4"/>`)
    .join('')
  const bars = rows
    .map((a, i) => {
      const h = Math.max(3, Math.round(((a.ms ?? 0) / max) * (H - 10)))
      const tip = esc(`${a.type} · ${a.provider}${a.model ? ` · ${a.model}` : ''} · ${a.ms !== undefined ? `${(a.ms / 1000).toFixed(1)}s` : 'running'}${a.state === 'error' ? ' · failed' : ''}`)
      return `<rect class="b" style="animation-delay:${(i * 0.035).toFixed(3)}s" x="${(i * slot + (slot - bar) / 2).toFixed(1)}" y="${H - 4 - h}" width="${bar.toFixed(1)}" height="${h}" rx="3" fill="url(#${grad(a)})"><title>${tip}</title></rect>`
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}">` +
    `<style>.b{transform-box:fill-box;transform-origin:50% 100%;animation:g .7s cubic-bezier(.2,.9,.25,1) both;transition:filter .15s,opacity .15s}` +
    `@keyframes g{from{transform:scaleY(0);opacity:0}to{transform:scaleY(1);opacity:1}}` +
    `svg:hover .b{opacity:.55}.b:hover{opacity:1!important;filter:brightness(1.25) drop-shadow(0 0 6px rgba(255,106,0,.9))}</style>` +
    `<defs>` +
    `<linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFB070"/><stop offset="1" stop-color="#FF6A00"/></linearGradient>` +
    `<linearGradient id="r" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF6B60"/><stop offset="1" stop-color="#C21A10"/></linearGradient>` +
    `<linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#BDBDBD"/></linearGradient>` +
    `</defs>${grid}` +
    `<line x1="0" y1="${H - 3.5}" x2="${width}" y2="${H - 3.5}" stroke="#FFFFFF" stroke-opacity="0.2"/>${bars}</svg>`
  )
}

// one look for every framed block
const SURFACE = '#141414'
const HAIRLINE = 'rgba(255,255,255,0.10)'
const ACCENT_EDGE = '#FF6A00'
const ROW_HOVER = 'rgba(255,106,0,0.14)'
const CARD = {
  flexDirection: 'column',
  borderStyle: 'round',
  borderColor: HAIRLINE,
  backgroundColor: SURFACE,
  paddingX: 'md',
  paddingY: 'sm',
  marginTop: 'sm',
} as const

const encodeRoute = (r: Route | undefined): string => (r ? `${r.provider}::${r.model ?? ''}` : 'auto')
const decodeRoute = (v: string): Route | undefined => {
  if (v === 'auto') return undefined
  const [p = '', m = ''] = v.split('::')
  return { provider: p, model: m || undefined }
}

export async function renderPane($: EngineInterface, els: Els, cols: number) {
  const { Box, Text: BaseText, Button, Link } = els
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Text = ((props: any) => {
    const { children, color, dimColor, ...rest } = props ?? {}
    const kids = children === undefined ? [] : Array.isArray(children) ? children : [children]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return h(BaseText as any, { ...rest, color: tone(color, dimColor) }, ...kids)
  }) as typeof BaseText
  const Select = 'Select' in els ? els.Select : undefined
  const Input = 'Input' in els ? els.Input : undefined
  const Svg = 'Svg' in els ? els.Svg : undefined

  const u: PaneUi = await read($, ui)
  const cfg = await read($, config)
  const hl = await read($, health)
  const mods = await read($, models)
  const favs = await read($, favorites)
  const st: Settings = await read($, settings)
  const log: Activity[] = await read($, activity)
  const here = await read($, cwd)
  const lims: Record<string, Limits> = await read($, limits)
  const now = await $.clock.now()
  const W = Math.max(24, cols)
  const IN = W - 4 // inside a card's frame and padding
  const METER_W = Math.min(560, Math.max(120, (W - 10) * 8))
  const LABEL_W = Math.min(16, Math.max(9, Math.floor(W * 0.28)))

  const connected = PROVIDERS.filter(p => cfg[p.id]?.isConnected)
  const statuses: Record<string, Status> = {}
  for (const p of connected) statuses[p.id] = await status($, p.id)
  const ready = connected.filter(p => statuses[p.id] === 'verified' || statuses[p.id] === 'unverified').length
  const allStats = stats(log)

  const setTab = (tab: PaneUi['tab']) => void setUi($, x => ({ ...x, tab, view: undefined }))
  const openProvider = (id: string) => void setUi($, x => ({ ...x, view: 'provider', expanded: id }))
  const pickFor = (id: string) => resolveModel(mods[id]?.models, cfg[id]?.model, cfg[id]?.effort)

  // ---------- small pieces ----------
  const Heading = ({ title, meta, right }: { title: string; meta?: string; right?: ReturnType<typeof Button> }) => (
    <Box marginTop="md" paddingX="xs" flexDirection="row" justifyContent="space-between" alignItems="center">
      <Text size="caption" weight="bold" mono color={NEON}>
        {title.toUpperCase()}
      </Text>
      {right ?? (meta ? (
        <Text size="caption" mono dimColor>
          {meta}
        </Text>
      ) : null)}
    </Box>
  )
  const Hint = ({ text }: { text: string }) => (
    <Text size="footnote" dimColor>
      {text}
    </Text>
  )
  const Avatar = ({ id, label, color, size = 28 }: { id: string; label: string; color?: string; size?: number }) =>
    Svg ? (
      <Box width={size > 30 ? 6 : size > 20 ? 5 : 3} flexShrink={0}>
        <Svg source={avatarSvg(id, label)} alt={label} width={size} height={size} />
      </Box>
    ) : (
      <Box width={4} flexShrink={0}>
        <Text color={markOf(id, label).fill} weight="bold" mono>
          {markOf(id, label).code}
        </Text>
        <Text color={color}> </Text>
      </Box>
    )
  /** a label column and its value, lined up down the block */
  const KV = ({ label, value, color }: { label: string; value: string; color?: string }) => (
    <Box flexDirection="row">
      <Box width={LABEL_W} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text color={color}>{value}</Text>
      </Box>
    </Box>
  )
  const Tile = ({ value, label, color, icon, sub }: { value: string; label: string; color?: string; icon?: string; sub?: string }) => (
    <Box
      key={`tile-${label}`}
      flexDirection="column"
      borderStyle="round"
      borderColor={HAIRLINE}
      backgroundColor={SURFACE}
      hover={{ borderColor: ACCENT_EDGE }}
      paddingX="md"
      paddingY="sm"
      flexGrow={1}
      minWidth={11}
    >
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Text size="caption" weight="semibold" mono color={color} dimColor={!color}>
          {label.toUpperCase()}
        </Text>
        {icon ? (
          <Text size="caption" color={color} dimColor={!color}>
            {icon}
          </Text>
        ) : null}
      </Box>
      <Text size="heading" weight="bold" mono tabular>
        {value}
      </Text>
      {sub ? (
        <Text size="caption" mono dimColor>
          {sub}
        </Text>
      ) : null}
    </Box>
  )
  /** one plan window: name, meter, used share and when it resets */
  const Meter = ({ label, pct, resetsAt }: { label: string; pct: number; resetsAt?: number }) => (
    <Box flexDirection="column" marginTop="xs">
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Text size="footnote">{label}</Text>
        <Text size="footnote" mono tabular color={pctColor(pct)}>
          {`${Math.round(pct)}% used${resetsAt ? ` · resets in ${until(now, resetsAt)}` : ''}`}
        </Text>
      </Box>
      {Svg ? (
        <Svg source={meterSvg(pct, METER_W)} alt={`${label}: ${Math.round(pct)}% used`} width={METER_W} height={8} />
      ) : (
        <Text color={pctColor(pct)}>{`${'▰'.repeat(Math.round(pct / 10))}${'▱'.repeat(10 - Math.round(pct / 10))}`}</Text>
      )}
    </Box>
  )
  /** everything a provider reported about its limits, or why it reported nothing */
  const LimitBody = ({ id }: { id: string }) => {
    const l = lims[id]
    if (!l || (l.state === 'checking' && !l.windows && !l.balance && !l.cap)) return <Hint text="Checking…" />
    if (l.state === 'unsupported') return <Hint text={l.source} />
    if (l.state === 'error')
      return (
        <Text size="footnote" color="error">
          {snip(`Couldn’t read limits: ${l.error ?? 'unknown error'}`, IN * 2)}
        </Text>
      )
    const lines = [
      ...(l.balance ?? []).map(b => `${b.label}: ${b.amount}${b.currency ? ` ${b.currency}` : ''}`),
      ...(l.cap
        ? [
            l.cap.limit !== undefined
              ? `Key spend: ${l.cap.used.toFixed(2)} of ${l.cap.limit} credits${l.cap.remaining !== undefined ? ` · ${l.cap.remaining.toFixed(2)} left` : ''}`
              : `Key spend: ${l.cap.used.toFixed(2)} credits · no cap set`,
          ]
        : []),
    ]
    return (
      <Box flexDirection="column">
        {l.isBlocked ? (
          <Text size="footnote" weight="semibold" color="error">
            Limit reached
          </Text>
        ) : null}
        {(l.windows ?? []).map((w, i, all) => (
          <Box flexDirection="column">
            {w.group && w.group !== all[i - 1]?.group ? (
              <Box marginTop={i === 0 ? 0 : 'xs'}>
                <Text size="caption" weight="semibold" mono dimColor>
                  {w.group.toUpperCase()}
                </Text>
              </Box>
            ) : null}
            <Meter label={`${w.label} limit`} pct={w.usedPercent} resetsAt={w.resetsAt} />
          </Box>
        ))}
        {lines.map(t => (
          <Text size="footnote">{t}</Text>
        ))}
        {!l.windows?.length && !lines.length ? (
          <Hint text={id === 'claude' ? 'No reading yet: the windows show after Claude’s next reply on a subscription.' : 'The provider reported no limits for this account.'} />
        ) : null}
      </Box>
    )
  }
  /** a setting whose state the button shows; pressing flips it */
  const Toggle = ({ id, on, label, hint, onPress }: { id: string; on: boolean; label: string; hint?: string; onPress: () => void }) => (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginTop={1} gap={1}>
      <Box flexDirection="column" flexShrink={1}>
        <Text>{label}</Text>
        {hint ? <Hint text={hint} /> : null}
      </Box>
      <Button key={id} label={on ? 'On' : 'Off'} variant={on ? 'primary' : 'secondary'} onPress={onPress} />
    </Box>
  )
  const Field = ({
    id,
    label,
    placeholder,
    value,
    onInput,
    onSubmit,
    submitLabel,
  }: {
    id: string
    label?: string
    placeholder: string
    value: string
    onInput?: (v: string) => void
    onSubmit: (v: string) => void
    submitLabel?: string
  }) =>
    Input ? (
      <Input
        key={`${id}-${u.inputGen}`}
        label={label}
        placeholder={placeholder}
        value={value}
        submitLabel={submitLabel}
        onInput={onInput ? v => onInput(v) : undefined}
        onSubmit={v => onSubmit(v)}
      />
    ) : (
      <Hint text={`${label ?? placeholder}: open the hub on desktop or terminal to type here.`} />
    )
  /** a labelled dropdown, its label in the same column as KV's */
  const Pick = ({
    id,
    label,
    value,
    options,
    onSelect,
  }: {
    id: string
    label: string
    value: string
    options: { value: string; label: string }[]
    onSelect: (v: string) => void
  }) => {
    const current = options.find(o => o.value === value)?.label ?? value
    if (options.length === 0) return <KV label={label} value="nothing to choose yet" />
    if (!Select) return <KV label={label} value={current} />
    return (
      <Box flexDirection="row" alignItems="center" marginTop={1}>
        <Box width={LABEL_W} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Box flexShrink={1}>
          <Select key={id} value={value} options={options} onSelect={v => onSelect(v)} />
        </Box>
      </Box>
    )
  }

  const tabs = (
    <Box flexDirection="row" flexWrap="wrap" gap="xs" marginTop={1}>
      {(
        [
          ['overview', 'Overview'],
          ['models', 'Models'],
          ['activity', 'Activity'],
          ['settings', 'Settings'],
        ] as const
      ).map(([id, label]) => (
        <Button key={`tab-${id}`} label={label} variant={u.tab === id && !u.view ? 'primary' : 'secondary'} onPress={() => setTab(id)} />
      ))}
    </Box>
  )

  const head = (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Box flexDirection="column" flexShrink={1}>
          <Text size="heading" weight="bold">
            Jervis AI Hub
            <Text weight="regular" dimColor>{` / ${u.view ? '' : cap(u.tab)}`.replace(/ \/ $/, '')}</Text>
          </Text>
          <Text size="caption" mono color={connected.length && ready === connected.length ? 'success' : connected.length ? 'warning' : undefined} dimColor={!connected.length}>
            {connected.length === 0 ? 'no providers yet' : `● ${ready}/${connected.length} ready`}
          </Text>
        </Box>
        <Button key="add" label="+ Add" variant="primary" onPress={() => void setUi($, x => ({ ...x, view: 'add', addSearch: '' }))} />
      </Box>
      {tabs}
    </Box>
  )

  const NoteLine = ({ id }: { id: string }) => {
    const n = u.notes[id]
    if (!n) return null
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={n.isError ? 'error' : 'warning'}>{snip(n.text, W * 3)}</Text>
        {n.href ? <Link href={n.href} label="Open the sign-in page" /> : null}
      </Box>
    )
  }

  /** the model and effort pickers for one provider */
  const ModelControls = ({ p }: { p: ProviderEntry }) => {
    const c = cfg[p.id] ?? { isConnected: true, isEnabled: true }
    const list = mods[p.id]
    const options = (list?.models ?? []).map(m => ({ value: m.id, label: m.label }))
    if (c.model && !options.some(o => o.value === c.model)) options.unshift({ value: c.model, label: shortModel(c.model) })
    const info = list?.models.find(m => m.id === c.model)
    const pick = pickFor(p.id)
    const efforts = info?.efforts ?? []
    return (
      <Box flexDirection="column">
        <Pick
          id={`model-${p.id}`}
          label="Model"
          value={c.model ?? options[0]?.value ?? ''}
          options={options}
          onSelect={v => {
            const next = list?.models.find(m => m.id === v)
            void saveConfig($, p.id, x => ({ ...x, model: v, effort: x.effort && next?.efforts?.includes(x.effort) ? x.effort : undefined }))
          }}
        />
        <Box flexDirection="row" alignItems="center" marginTop={1}>
          <Box width={LABEL_W} flexShrink={0}>
            <Text dimColor>Effort</Text>
          </Box>
          {efforts.length > 0 ? (
            <Box flexDirection="row" flexWrap="wrap" gap="xs" flexShrink={1}>
              {efforts.map(e => (
                <Button
                  key={`effort-${p.id}-${e}`}
                  label={EFFORT_LABEL(e)}
                  variant={pick.effort === e ? 'primary' : 'secondary'}
                  onPress={() => void saveConfig($, p.id, x => ({ ...x, effort: e }))}
                />
              ))}
            </Box>
          ) : (
            <Text dimColor>{list?.isLoading ? 'Loading…' : 'Not offered for this model'}</Text>
          )}
        </Box>
        {efforts.length > 0 && !c.effort && info?.defaultEffort ? (
          <Box marginLeft={LABEL_W}>
            <Hint text={`${EFFORT_LABEL(info.defaultEffort)} is the CLI’s default.`} />
          </Box>
        ) : null}
        {list?.error ? <Text color="error">{snip(`Models: ${list.error}`, IN * 2)}</Text> : null}
      </Box>
    )
  }

  // ---------- Add provider ----------
  if (u.view === 'add') {
    const q = u.addSearch.trim().toLowerCase()
    const available = PROVIDERS.filter(p => !cfg[p.id]?.isConnected).filter(
      p => !q || p.label.toLowerCase().includes(q) || p.id.includes(q),
    )
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Button key="back" plain dimColor label="‹ Back" role="dismiss" onPress={() => void setUi($, x => ({ ...x, view: undefined }))} />
        </Box>
        <Text size="title" weight="bold">
          Add a provider
        </Text>
        <Hint text="Sign in with a subscription, or bring an API key." />
        <Box marginTop={1}>
          <Field id="add-search" placeholder="Search providers" value={u.addSearch} onInput={v => void setUi($, x => ({ ...x, addSearch: v }))} onSubmit={() => undefined} />
        </Box>
        {(['subscription', 'free', 'api-key'] as const).map(method => {
          const group = available.filter(p => p.auth === method)
          if (group.length === 0) return null
          return (
            <Box flexDirection="column">
              <Heading title={AUTH_LABEL[method]} />
              <Box key={`add-group-${method}`} {...CARD} hover={{ borderColor: ACCENT_EDGE }}>
                {group.map((p, i) => (
                  <Box flexDirection="column" marginTop={i === 0 ? 0 : 1}>
                    <Box flexDirection="row" alignItems="center" gap={1}>
                      <Avatar id={p.id} label={p.label} />
                      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                        <Text weight="semibold">{snip(p.label, IN - 18)}</Text>
                        {p.keyUrl ? (
                          <Link href={p.keyUrl} label="Get a key ↗" />
                        ) : (
                          <Text size="footnote" dimColor>
                            {snip(p.hint, IN - 18)}
                          </Text>
                        )}
                      </Box>
                      <Button key={`conn-${p.id}`} label="Connect" onPress={() => void connect($, p.id)} />
                    </Box>
                    <NoteLine id={p.id} />
                  </Box>
                ))}
              </Box>
            </Box>
          )
        })}
        {available.length === 0 && (
          <Box marginTop={1}>
            <Hint text={q ? 'No provider matches.' : 'Every provider is connected.'} />
          </Box>
        )}
        <Box marginTop={1}>
          <Hint text="🔒 Keys are typed into a masked Windows dialog and stored encrypted for your account (DPAPI), never shown here." />
        </Box>
      </Box>
    )
  }

  // ---------- one provider's page ----------
  const pageProvider = u.view === 'provider' && u.expanded ? provider(u.expanded) : undefined
  if (pageProvider && cfg[pageProvider.id]?.isConnected) {
    const p = pageProvider
    const c = cfg[p.id] ?? { isConnected: true, isEnabled: true }
    const hp = hl[p.id]
    const s = statuses[p.id] ?? 'checking'
    const sel = mods[p.id]?.models.find(m => m.id === c.model)
    const ps = allStats[p.id]
    const errors = log.filter(a => a.provider === p.id && a.state === 'error').slice(-3).reverse()
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Button key="back" plain dimColor label="‹ Providers" role="dismiss" onPress={() => void setUi($, x => ({ ...x, view: undefined, tab: 'overview' }))} />
        </Box>
        <Box flexDirection="row" alignItems="center" gap={1} marginTop={1}>
          <Avatar id={p.id} label={p.label} color={STATUS_COLOR[s]} size={40} />
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Text size="title" weight="bold">
              {snip(p.label, IN)}
            </Text>
            <Text size="footnote" dimColor>
              {`${BILLING_TAG[p.billing]} · via ${p.kind === 'codex' ? 'Codex CLI' : p.kind === 'agy' ? 'Antigravity CLI' : 'OpenCode'}`}
            </Text>
          </Box>
          <Text size="footnote" weight="semibold" color={STATUS_COLOR[s]} dimColor={s === 'disabled' || s === 'checking'}>
            {`${DOT[s]} ${PILL[s]}`}
          </Text>
        </Box>
        <NoteLine id={p.id} />

        <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
          <Tile value={String(ps?.requests ?? 0)} label="Requests" icon="↗" sub={ps?.failures ? `${ps.failures} failed` : undefined} />
          <Tile value={ps?.avgMs ? ms(ps.avgMs) : '–'} label="Avg latency" icon="◷" />
          <Tile
            value={ps?.hasTokens ? `${k(ps.inputTokens)}/${k(ps.outputTokens)}` : '–'}
            label="Tokens"
            icon="⇅"
            sub={ps?.hasTokens ? 'in / out' : p.reportsUsage ? undefined : 'not reported'}
          />
        </Box>

        <Heading
          title="Limits"
          right={<Button key={`limits-refresh-${p.id}`} plain dimColor label={lims[p.id]?.state === 'checking' ? 'Checking…' : 'Refresh'} onPress={() => void refreshLimits($, p.id)} />}
        />
        <Box key="limits-card" {...CARD}>
          {lims[p.id]?.plan ? <KV label="Plan" value={cap(lims[p.id]?.plan ?? '')} /> : null}
          <LimitBody id={p.id} />
          {lims[p.id] && lims[p.id]?.state !== 'unsupported' ? <Hint text={`From ${lims[p.id]?.source ?? ''} · checked ${ago(now, lims[p.id]?.at)}`} /> : null}
        </Box>

        <Heading title="Model" />
        <Box key="model-card" {...CARD}>
          <ModelControls p={p} />
          {sel ? (
            <Box flexDirection="column" marginTop={1} marginBottom={1}>
              <KV label="Capabilities" value={snip(capabilityList(sel).join(', ') || 'not reported', (IN - LABEL_W) * 3)} />
              {sel.contextWindow ? <KV label="Context" value={`${k(sel.contextWindow)} tokens`} /> : null}
            </Box>
          ) : (
            <Box marginBottom={1} />
          )}
        </Box>

        <Heading title="Connection" />
        <Box key="conn-card" {...CARD}>
          <KV label="Sign-in" value={snip(hp?.authMessage ?? AUTH_LABEL[p.auth], (IN - LABEL_W) * 2)} />
          <KV
            label="Last test"
            value={
              hp?.lastTest
                ? `${hp.lastTest.isOk ? 'Passed' : 'Failed'} ${ago(now, hp.lastTest.at)}${hp.lastTest.isOk ? ` · ${ms(hp.lastTest.ms)}` : ''}`
                : 'Never'
            }
            color={hp?.lastTest ? (hp.lastTest.isOk ? 'success' : 'error') : 'warning'}
          />
          {hp?.lastTest && !hp.lastTest.isOk ? <Text color="error">{snip(hp.lastTest.message, IN * 3)}</Text> : null}
          <KV label="Delegation" value={p.relaySkill ? `Jervis Relay (${p.relaySkill})` : 'Not available'} />
          <KV label="Billing" value={snip(BILLING[p.billing], (IN - LABEL_W) * 3)} />
          {!hp?.lastTest ? (
            <Box marginTop={1}>
              <Hint text="Being signed in does not prove a request works: run a test." />
            </Box>
          ) : null}
          <Box flexDirection="row" flexWrap="wrap" gap="xs" marginTop={1} marginBottom={1}>
            <Button key={`test-${p.id}`} label="Test connection" variant="primary" onPress={() => void test($, p.id)} />
            <Button key={`models-${p.id}`} label="Refresh models" onPress={() => void refreshModels($, p.id)} />
          </Box>
        </Box>

        {errors.length > 0 && (
          <Box flexDirection="column">
            <Heading title="Recent errors" />
            {errors.map(a => (
              <Text color="error">{snip(`${ago(now, a.at)} · ${a.error ?? 'failed'}`, W * 2)}</Text>
            ))}
          </Box>
        )}

        <Heading title="Manage" />
        <Box flexDirection="row" flexWrap="wrap" gap="xs" marginTop={1}>
          <Button
            key={`toggle-${p.id}`}
            label={c.isEnabled ? 'Turn off' : 'Turn on'}
            onPress={() => void saveConfig($, p.id, x => ({ ...x, isEnabled: !x.isEnabled }))}
          />
          <Button key={`disc-${p.id}`} label="Disconnect" dimColor onPress={() => void disconnect($, p.id)} />
        </Box>
        <Hint text="Disconnect removes it from the hub; it never signs you out of the CLI." />
      </Box>
    )
  }

  // ---------- Overview ----------
  if (u.tab === 'overview') {
    const q = u.search.trim().toLowerCase()
    const shown = connected.filter(
      p => !q || p.label.toLowerCase().includes(q) || (cfg[p.id]?.model ?? '').toLowerCase().includes(q),
    )
    const recent = log.slice(-3).reverse()
    const done = log.filter(a => a.ms !== undefined && a.state === 'ok')
    const avg = done.length ? Math.round(done.reduce((t, a) => t + (a.ms ?? 0), 0) / done.length) : undefined
    const failed = log.filter(a => a.state === 'error').length

    return (
      <Box flexDirection="column">
        {head}

        {connected.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" gap="sm" marginTop="sm">
            <Tile value={`${ready}/${connected.length}`} label="Ready" icon="◉" color={ready === connected.length ? 'success' : 'warning'} />
            <Tile value={String(log.length)} label="Requests" icon="↗" sub={failed ? `${failed} failed` : undefined} />
            <Tile value={avg !== undefined ? ms(avg) : '–'} label="Avg latency" icon="◷" />
          </Box>
        )}

        <Heading title="Providers" meta={connected.length ? `${connected.length} connected` : undefined} />
        {connected.length > 4 && (
          <Box marginTop={1}>
            <Field id="search" placeholder="Search providers or models" value={u.search} onInput={v => void setUi($, x => ({ ...x, search: v }))} onSubmit={() => undefined} />
          </Box>
        )}
        {connected.length === 0 ? (
          <Box key="empty-card" {...CARD} paddingY="md" alignItems="flex-start">
            <Text weight="semibold">No provider connected yet</Text>
            <Hint text="Connect ChatGPT, Antigravity, a free model or an API key to start." />
            <Box marginTop={1}>
              <Button key="add-empty" label="Add your first provider" variant="primary" onPress={() => void setUi($, x => ({ ...x, view: 'add' }))} />
            </Box>
          </Box>
        ) : (
          <Box key="providers-card" {...CARD} hover={{ borderColor: ACCENT_EDGE }}>
            {shown.map((p, i) => {
              const c = cfg[p.id] ?? { isConnected: true, isEnabled: true }
              const s = statuses[p.id] ?? 'checking'
              const pick = pickFor(p.id)
              const sel = mods[p.id]?.models.find(m => m.id === c.model)
              const sub = [sel?.label ?? (c.model ? shortModel(c.model) : 'Default model'), pick.effort ? EFFORT_LABEL(pick.effort) : ''].filter(Boolean).join(' · ')
              return (
                <Box key={`prow-${p.id}`} flexDirection="row" alignItems="center" gap="sm" paddingX="sm" paddingY="xs" marginTop={i === 0 ? 0 : 'xs'} hover={{ backgroundColor: ROW_HOVER }}>
                  <Avatar id={p.id} label={p.label} color={STATUS_COLOR[s]} />
                  <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                    <Text weight="semibold" dimColor={s === 'disabled'}>
                      {snip(p.label, IN - 20)}
                    </Text>
                    <Text size="footnote" dimColor>
                      {snip(sub, IN - 18)}
                    </Text>
                  </Box>
                  <Text size="caption" mono weight="semibold" color={STATUS_COLOR[s]} dimColor={s === 'disabled' || s === 'checking'}>
                    {`${DOT[s]} ${PILL[s]}`}
                  </Text>
                  <Button key={`more-${p.id}`} plain dimColor label="Open ›" onPress={() => openProvider(p.id)} />
                </Box>
              )
            })}
            {shown.length === 0 && <Hint text="No connected provider matches." />}
          </Box>
        )}

        {connected.length > 0 && (
          <Box flexDirection="column">
            <Heading
              title="Limits"
              right={<Button key="limits-refresh-all" plain dimColor label={connected.some(p => lims[p.id]?.state === 'checking') ? 'Checking…' : 'Refresh'} onPress={() => void refreshAllLimits($)} />}
            />
            <Box key="limits-overview" {...CARD}>
              <Box key="lrow-claude" flexDirection="column" paddingX="sm" paddingY="xs" hover={{ backgroundColor: ROW_HOVER }}>
                <Box flexDirection="row" alignItems="center" gap="sm">
                  <Avatar id="claude" label="Claude" size={18} />
                  <Text weight="semibold">Claude</Text>
                  <Text size="caption" mono dimColor>
                    THIS SESSION
                  </Text>
                </Box>
                <LimitBody id="claude" />
              </Box>
              {connected.map(p => (
                <Box key={`lrow-${p.id}`} flexDirection="column" paddingX="sm" paddingY="xs" marginTop="xs" hover={{ backgroundColor: ROW_HOVER }}>
                  <Box flexDirection="row" alignItems="center" gap="sm">
                    <Avatar id={p.id} label={p.label} size={18} />
                    <Text weight="semibold">{snip(p.label, IN - 18)}</Text>
                    {lims[p.id]?.plan ? (
                      <Text size="caption" mono dimColor>
                        {(lims[p.id]?.plan ?? '').toUpperCase()}
                      </Text>
                    ) : null}
                  </Box>
                  <LimitBody id={p.id} />
                </Box>
              ))}
            </Box>
          </Box>
        )}

        {recent.length > 0 && (
          <Box flexDirection="column">
            <Heading title="Recent" right={<Button key="see-all" plain dimColor label="All activity ›" onPress={() => setTab('activity')} />} />
            {recent.map(a => (
              <Box key={`recent-${a.id}`} flexDirection="row" justifyContent="space-between" paddingX="sm" paddingY="xs" gap={1} hover={{ backgroundColor: ROW_HOVER }}>
                <Text>
                  <Text color={STATE_COLOR[a.state]}>{`${STATE_ICON[a.state]} `}</Text>
                  <Text>{`${cap(a.type)} `}</Text>
                  <Text dimColor>{snip(`· ${provider(a.provider)?.label ?? a.provider}`, Math.max(6, W - 26))}</Text>
                </Text>
                <Text size="footnote" mono dimColor tabular>
                  {`${a.ms !== undefined ? ms(a.ms) : '…'} · ${ago(now, a.at)}`}
                </Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  }

  // ---------- Models ----------
  if (u.tab === 'models') {
    type Row = { p: ProviderEntry; m: ModelInfo }
    const q = u.modelSearch.trim().toLowerCase()
    const rows: Row[] = []
    for (const p of connected) {
      if (u.modelProvider !== 'all' && u.modelProvider !== p.id) continue
      const own: Row[] = []
      for (const m of mods[p.id]?.models ?? []) {
        if (q && !m.label.toLowerCase().includes(q) && !m.id.toLowerCase().includes(q)) continue
        if (u.modelCap !== 'any' && hasCapability(m, u.modelCap as (typeof CAPABILITIES)[number]['id']) !== true) continue
        if (u.favOnly && !favs.includes(favKey(p.id, m.id))) continue
        own.push({ p, m })
      }
      // within a provider: the one in use, then favorites, then the source's order
      const rank = (r: Row) => (cfg[p.id]?.model === r.m.id ? 2 : favs.includes(favKey(p.id, r.m.id)) ? 1 : 0)
      own.sort((a, b) => rank(b) - rank(a))
      rows.push(...own)
    }
    const visible = rows.slice(0, u.modelLimit)
    const loading = connected.filter(p => mods[p.id]?.isLoading).map(p => p.label)
    const groups = connected
      .map(p => ({ p, items: visible.filter(r => r.p.id === p.id), total: rows.filter(r => r.p.id === p.id).length }))
      .filter(g => g.items.length > 0)

    const Detail = ({ p, m, fk }: { p: ProviderEntry; m: ModelInfo; fk: string }) => (
      <Box key={`detail-${fk}`} {...CARD} marginTop="xs" marginBottom="xs" marginX="sm" borderColor={ACCENT_EDGE}>
        {m.description ? <Text dimColor>{snip(m.description, IN * 3)}</Text> : null}
        <Box flexDirection="column" marginTop={m.description ? 1 : 0}>
          <KV label="ID" value={snip(m.id, IN - LABEL_W)} />
          {m.efforts?.length ? <KV label="Effort" value={m.efforts.map(EFFORT_LABEL).join(' · ')} /> : null}
          <KV label="Context" value={`${k(m.contextWindow)}${m.maxOutput ? ` · output ${k(m.maxOutput)}` : ''}`} />
          <KV label="Input" value={m.inputModalities?.join(', ') ?? 'not reported'} />
          <KV label="Tools · Web" value={`${yesNo(m.toolCalling)} · ${yesNo(m.webSearch)}`} />
          {m.costIn !== undefined || m.costOut !== undefined ? (
            <KV label="API /1M" value={`$${m.costIn ?? '?'} in · $${m.costOut ?? '?'} out${p.billing === 'subscription' ? ' (list price, not your plan)' : ''}`} />
          ) : null}
          {m.status ? <KV label="Status" value={m.status} color="warning" /> : null}
          <KV label="Source" value={m.source === 'cli-list' ? 'CLI list (no metadata)' : m.source} />
        </Box>
        <Pick
          id={`task-${fk}`}
          label="Default for"
          value="none"
          options={[{ value: 'none', label: 'Choose a task…' }, ...TASKS.map(t => ({ value: t.id, label: t.label }))]}
          onSelect={v => {
            if (v === 'none') return
            void saveSettings($, s => ({ ...s, routes: { ...s.routes, [v]: { provider: p.id, model: m.id } } }))
          }}
        />
        <Box flexDirection="row" marginTop="sm">
          {cfg[p.id]?.model === m.id ? (
            <Text color="success">{`✓ In use · set its effort on the ${p.label} page`}</Text>
          ) : (
            <Button
              key={`use-${fk}`}
              label={`Use for ${snip(p.label, 18)}`}
              variant="primary"
              onPress={() => void saveConfig($, p.id, x => ({ ...x, model: m.id, effort: x.effort && m.efforts?.includes(x.effort) ? x.effort : undefined }))}
            />
          )}
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {head}
        <Heading title="Find a model" meta={`${rows.length} model${rows.length === 1 ? '' : 's'}`} />
        <Box key="model-filters" {...CARD}>
          <Field id="model-search" placeholder="Search models" value={u.modelSearch} onInput={v => void setUi($, x => ({ ...x, modelSearch: v, modelLimit: 25 }))} onSubmit={() => undefined} />
        <Pick
          id="model-provider"
          label="Provider"
          value={u.modelProvider}
          options={[{ value: 'all', label: 'All connected' }, ...connected.map(p => ({ value: p.id, label: p.label }))]}
          onSelect={v => void setUi($, x => ({ ...x, modelProvider: v, modelLimit: 25 }))}
        />
        <Pick
          id="model-cap"
          label="Capability"
          value={u.modelCap}
          options={[{ value: 'any', label: 'Any' }, ...CAPABILITIES.map(c => ({ value: c.id, label: c.label }))]}
          onSelect={v => void setUi($, x => ({ ...x, modelCap: v, modelLimit: 25 }))}
        />
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginTop="sm" gap={1}>
          <Hint text={loading.length ? `Loading ${loading.join(', ')}…` : 'Only what each source reports.'} />
          <Button key="fav-only" label={u.favOnly ? '★ Favorites' : '☆ Favorites'} variant={u.favOnly ? 'primary' : 'secondary'} onPress={() => void setUi($, x => ({ ...x, favOnly: !x.favOnly }))} />
        </Box>
        </Box>
        {connected.length === 0 && <Hint text="Connect a provider to see its models." />}
        {connected.length > 0 && rows.length === 0 && loading.length === 0 && <Hint text="No model matches these filters." />}

        {groups.map(({ p, items, total }) => (
          <Box flexDirection="column">
            <Box key={`mgroup-${p.id}`} {...CARD} marginTop="md" hover={{ borderColor: ACCENT_EDGE }}>
              <Box flexDirection="row" alignItems="center" gap="sm" paddingX="sm" marginBottom="xs">
                <Avatar id={p.id} label={p.label} size={18} />
                <Text weight="bold">{snip(p.label, IN - 16)}</Text>
                <Text size="caption" mono color={NEON}>
                  {`${total} MODEL${total === 1 ? '' : 'S'}`}
                </Text>
              </Box>
              {items.map(({ m }) => {
                const fk = favKey(p.id, m.id)
                const isFav = favs.includes(fk)
                const isSel = u.selectedModel === fk
                const inUse = cfg[p.id]?.model === m.id
                const tag = inUse ? '● In use' : m.efforts?.length ? `${m.efforts.length} efforts` : m.contextWindow ? k(m.contextWindow) : ''
                return (
                  <Box flexDirection="column">
                    <Box key={`row-${fk}`} flexDirection="row" justifyContent="space-between" paddingX="sm" paddingY="xs" alignItems="center" gap={1} hover={{ backgroundColor: ROW_HOVER }}>
                      <Box flexDirection="row" alignItems="center" gap="sm" flexShrink={1}>
                        <Button
                          key={`fav-${fk}`}
                          plain
                          dimColor={!isFav}
                          label={isFav ? '★' : '☆'}
                          onPress={() => void saveFavorites($, f => (f.includes(fk) ? f.filter(x => x !== fk) : [...f, fk]))}
                        />
                        <Text weight={inUse || isSel ? 'semibold' : 'regular'} color={isSel ? NEON : undefined}>
                          {snip(m.label, Math.max(8, IN - 26))}
                        </Text>
                      </Box>
                      <Box flexDirection="row" alignItems="center" gap="sm" flexShrink={0}>
                        {tag ? (
                          <Text size="caption" mono color={inUse ? 'success' : undefined} dimColor={!inUse} tabular>
                            {tag.toUpperCase()}
                          </Text>
                        ) : null}
                        <Button key={`sel-${fk}`} plain dimColor label={isSel ? 'Hide' : 'Details ›'} onPress={() => void setUi($, x => ({ ...x, selectedModel: isSel ? undefined : fk }))} />
                      </Box>
                    </Box>
                    {isSel && <Detail p={p} m={m} fk={fk} />}
                  </Box>
                )
              })}
            </Box>
          </Box>
        ))}
        {rows.length > u.modelLimit && (
          <Box marginTop={1}>
            <Button key="more-models" label={`Show more · ${rows.length - u.modelLimit} left`} onPress={() => void setUi($, x => ({ ...x, modelLimit: x.modelLimit + 25 }))} />
          </Box>
        )}
      </Box>
    )
  }

  // ---------- Activity ----------
  if (u.tab === 'activity') {
    const types = ['all', 'ask', 'compare', 'test', 'delegate'] as const
    const filter = u.actFilter ?? 'all'
    const rows = log.filter(a => filter === 'all' || a.type === filter).slice(-40).reverse()
    const isWide = W >= 50
    const failed = log.filter(a => a.state === 'error').length
    const done = log.filter(a => a.ms !== undefined && a.state === 'ok')
    const avg = done.length ? Math.round(done.reduce((t, a) => t + (a.ms ?? 0), 0) / done.length) : undefined
    const Cell = ({ w, text, dim, color, badge }: { w: number; text: string; dim?: boolean; color?: string; badge?: boolean }) => (
      <Box width={w} flexShrink={0} justifyContent="flex-end">
        <Text mono tabular dimColor={dim} color={badge ? FG : color} backgroundColor={badge ? DANGER : undefined}>
          {badge ? ` ${text} ` : text}
        </Text>
      </Box>
    )
    const chartRows = log.filter(a => a.ms !== undefined).slice(-30)
    return (
      <Box flexDirection="column">
        {head}

        <Box flexDirection="row" flexWrap="wrap" gap="sm" marginTop="sm">
          <Tile value={String(log.length)} label="Requests" icon="↗" />
          <Tile value={String(failed)} label="Failed" icon="!" color={failed ? 'error' : undefined} />
          <Tile value={avg !== undefined ? ms(avg) : '–'} label="Avg latency" icon="◷" />
        </Box>

        {Svg && chartRows.length > 1 && (
          <Box flexDirection="column">
            <Heading title="Latency · latest requests" meta={`${chartRows.length} reqs`} />
            <Box key="chart-card" {...CARD} paddingY="md">
              <Svg
                isInteractive
                source={latencySvg(chartRows, Math.min(640, Math.max(200, IN * 8)))}
                alt={`Latency of the latest ${chartRows.length} requests; slowest ${ms(Math.max(...chartRows.map(a => a.ms ?? 0)))}`}
              />
              <Hint text={`Hover a bar for details · orange ok · red failed · tallest ${ms(Math.max(...chartRows.map(a => a.ms ?? 0)))}`} />
            </Box>
          </Box>
        )}

        <Heading title="By provider" meta={Object.keys(allStats).length ? `${Object.keys(allStats).length} active` : undefined} />
        {Object.keys(allStats).length === 0 ? (
          <Hint text="No requests yet." />
        ) : (
          <Box key="stats-card" {...CARD}>
            {isWide && (
              <Box flexDirection="row" paddingX="sm" marginBottom="xs">
                <Box flexGrow={1} flexShrink={1}>
                  <Text size="caption" mono dimColor>
                    PROVIDER
                  </Text>
                </Box>
                <Cell w={5} text="REQ" dim />
                <Cell w={6} text="FAIL" dim />
                <Cell w={8} text="AVG" dim />
                <Cell w={11} text="TOKENS" dim />
              </Box>
            )}
            {Object.entries(allStats).map(([id, s]) => {
              const p = provider(id)
              const tokens = s.hasTokens ? `${k(s.inputTokens)}/${k(s.outputTokens)}` : '—'
              return isWide ? (
                <Box key={`srow-${id}`} flexDirection="row" alignItems="center" paddingX="sm" paddingY="xs" hover={{ backgroundColor: ROW_HOVER }}>
                  <Box flexGrow={1} flexShrink={1} flexDirection="row" alignItems="center" gap="sm">
                    <Avatar id={id} label={p?.label ?? id} size={18} />
                    <Text>{snip(p?.label ?? id, W - 44)}</Text>
                  </Box>
                  <Cell w={5} text={String(s.requests)} />
                  <Cell w={6} text={String(s.failures)} dim={!s.failures} badge={s.failures > 0} />
                  <Cell w={8} text={s.avgMs ? ms(s.avgMs) : '–'} />
                  <Cell w={11} text={tokens} dim={!s.hasTokens} />
                </Box>
              ) : (
                <Box key={`srow-${id}`} flexDirection="column" paddingX="sm" paddingY="xs" hover={{ backgroundColor: ROW_HOVER }}>
                  <Box flexDirection="row" alignItems="center" gap="sm">
                    <Avatar id={id} label={p?.label ?? id} size={18} />
                    <Text weight="semibold">{snip(p?.label ?? id, IN - 6)}</Text>
                  </Box>
                  <Hint
                    text={`${s.requests} req · ${s.failures} failed${s.avgMs ? ` · avg ${ms(s.avgMs)}` : ''} · ${s.hasTokens ? `${k(s.inputTokens)} in / ${k(s.outputTokens)} out` : 'tokens not reported'}`}
                  />
                </Box>
              )
            })}
          </Box>
        )}

        <Heading
          title={`Requests · ${log.length}`}
          right={log.length > 0 ? <Button key="clear" plain dimColor label="Clear" onPress={() => void clearActivity($)} /> : undefined}
        />
        <Box key="requests-card" {...CARD}>
        <Box flexDirection="row" flexWrap="wrap" gap="xs">
          {types.map(t => (
            <Button
              key={`filter-${t}`}
              label={`${cap(t)}${t === 'all' ? '' : ` ${log.filter(a => a.type === t).length}`}`}
              variant={filter === t ? 'primary' : 'secondary'}
              onPress={() => void setUi($, x => ({ ...x, actFilter: t }))}
            />
          ))}
        </Box>
        <Box marginTop="xs" paddingX="xs">
          <Hint text={st.recordPreviews ? 'Redacted previews are kept.' : '🔒 Prompts and answers stay private: only sizes and outcomes are kept.'} />
        </Box>
        {rows.length === 0 ? <Hint text={log.length ? `No ${filter} requests.` : 'No requests yet.'} /> : null}
        <Box flexDirection="column" marginTop="sm">
          {rows.map(a => {
            const isOpen = u.activityOpen === a.id
            const time = `${a.ms !== undefined ? ms(a.ms) : '…'} · ${ago(now, a.at)}`
            const what = `· ${provider(a.provider)?.label ?? a.provider}${a.model ? ` · ${shortModel(a.model)}` : ''}${a.effort ? ` · ${a.effort}` : ''}`
            return (
              <Box flexDirection="column">
                <Box key={`arow-${a.id}`} flexDirection="row" justifyContent="space-between" alignItems="center" paddingX="sm" paddingY="xs" gap={1} hover={{ backgroundColor: ROW_HOVER }}>
                  <Box flexDirection="row" alignItems="center" gap="sm" flexShrink={1}>
                    <Avatar id={a.provider} label={provider(a.provider)?.label ?? a.provider} size={18} />
                    <Text>
                      <Text color={STATE_COLOR[a.state]}>{`${STATE_ICON[a.state]} `}</Text>
                      <Text weight="semibold">{`${cap(a.type)} `}</Text>
                      <Text dimColor>{snip(what, Math.max(8, W - time.length - 22))}</Text>
                    </Text>
                  </Box>
                  <Box flexDirection="row" alignItems="center" gap="sm" flexShrink={0}>
                    <Text size="footnote" mono dimColor tabular>
                      {time}
                    </Text>
                    <Button key={`act-${a.id}`} plain dimColor label={isOpen ? 'Hide' : '›'} onPress={() => void setUi($, x => ({ ...x, activityOpen: isOpen ? undefined : a.id }))} />
                  </Box>
                </Box>
                {isOpen && (
                  <Box key={`actd-${a.id}`} {...CARD} marginTop="xs" marginBottom="xs" marginX="sm" borderColor={ACCENT_EDGE}>
                    <KV label="Mode" value={`${a.mode === 'write' ? 'Write' : 'Read-only'}${a.task ? ` · task ${a.task}` : ''}`} />
                    <KV label="Model" value={`${a.model ?? 'default'}${a.effort ? ` · effort ${a.effort}` : ''}`} />
                    <KV label="Prompt" value={`${a.promptChars} chars`} />
                    {a.fallbackFrom ? <KV label="Fallback after" value={a.fallbackFrom} /> : null}
                    {usageLine(a.usage) ? <KV label="Usage" value={usageLine(a.usage).replace('tokens reported by the CLI: ', '')} /> : null}
                    {a.touchedFiles?.length ? <KV label="Files changed" value={snip(a.touchedFiles.join(', '), (IN - LABEL_W) * 3)} /> : null}
                    {a.preview ? <Text dimColor>{`→ ${a.preview}`}</Text> : null}
                    {a.resultPreview ? <Text>{`← ${a.resultPreview}`}</Text> : null}
                    {a.error ? <Text color="error">{snip(a.error, IN * 4)}</Text> : null}
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>
        </Box>
      </Box>
    )
  }

  // ---------- Settings ----------
  const { routes, profile } = await activeRoutes($)
  const isSmart = st.smartRouting !== false
  const routeOptions = [{ value: 'auto', label: isSmart ? 'Smart pick' : 'Automatic' }]
  const picks: Partial<Record<Task, SmartPick | { reason: string }>> = {}
  if (isSmart) for (const t of TASKS) if (!routes[t.id]) picks[t.id] = await smartPick($, t.id)
  for (const p of connected) routeOptions.push({ value: `${p.id}::`, label: p.label })
  for (const f of favs) {
    const [pid = '', mid = ''] = f.split('::')
    if (!cfg[pid]?.isConnected) continue
    const label = mods[pid]?.models.find(m => m.id === mid)?.label ?? shortModel(mid)
    routeOptions.push({ value: `${pid}::${mid}`, label: `★ ${label} (${provider(pid)?.label ?? pid})` })
  }
  for (const t of TASKS) {
    const v = encodeRoute(routes[t.id])
    if (!routeOptions.some(o => o.value === v)) routeOptions.push({ value: v, label: v.replace('::', ' · ') })
  }
  const setRoute = (task: Task, v: string) =>
    void saveSettings($, s => {
      const r = decodeRoute(v)
      if (s.useProjectProfile && here) {
        const prof = { ...(s.profiles[here] ?? {}) }
        if (r) prof[task] = r
        else delete prof[task]
        return { ...s, profiles: { ...s.profiles, [here]: prof } }
      }
      const next = { ...s.routes }
      if (r) next[task] = r
      else delete next[task]
      return { ...s, routes: next }
    })

  return (
    <Box flexDirection="column">
      {head}

      <Heading title="Model for each task" />
      <Box key="smart-card" {...CARD}>
        <Toggle
          id="smart"
          on={isSmart}
          label="Pick the best model for each task"
          hint="Scores every connected model on what its source reports (reasoning, tool calls, context, image input, price) and on the limits each provider reports. A rule you set below wins."
          onPress={() => void saveSettings($, s => ({ ...s, smartRouting: s.smartRouting === false }))}
        />
        {isSmart && (
          <Box flexDirection="column" marginTop="sm">
            {TASKS.map(t => {
              const rule = routes[t.id]
              const pk = picks[t.id]
              const text = rule
                ? `${provider(rule.provider)?.label ?? rule.provider}${rule.model ? ` · ${shortModel(rule.model)}` : ''} (your rule)`
                : pk && 'route' in pk
                  ? pk.label
                  : (pk?.reason ?? 'nothing ready')
              return (
                <Box key={`pick-${t.id}`} flexDirection="column" paddingX="sm" paddingY="xs" hover={{ backgroundColor: ROW_HOVER }}>
                  <Box flexDirection="row" justifyContent="space-between" gap={1}>
                    <Text weight="semibold">{t.label}</Text>
                    <Text size="footnote" color={rule ? undefined : NEON}>
                      {snip(text, Math.max(10, IN - 16))}
                    </Text>
                  </Box>
                  {!rule && pk && 'route' in pk ? <Hint text={snip(pk.reason.replace(/^smart pick for \w+: ?/, 'Why: '), IN * 2)} /> : null}
                </Box>
              )
            })}
          </Box>
        )}
      </Box>

      <Heading title="Routing rules" />
      <Box key="routing-card" {...CARD}>
        <Hint text={snip(profile === 'global' ? (isSmart ? 'Fix a task to one provider or model; left on Smart pick, the hub chooses.' : 'Who answers each kind of request when no provider is named.') : `Rules for this project: ${profile}`, IN * 2)} />
        {TASKS.map(t => (
          <Pick id={`route-${t.id}`} label={t.label} value={encodeRoute(routes[t.id])} options={routeOptions} onSelect={v => setRoute(t.id, v)} />
        ))}
        <Pick
          id="default-provider"
          label="Otherwise"
          value={st.defaultProvider ?? 'auto'}
          options={[{ value: 'auto', label: 'First verified' }, ...connected.map(p => ({ value: p.id, label: p.label }))]}
          onSelect={v => void saveSettings($, s => ({ ...s, defaultProvider: v === 'auto' ? undefined : v }))}
        />
        <Toggle
          id="profile"
          on={st.useProjectProfile}
          label="Separate rules for this project"
          hint={here ? undefined : 'No project folder in this session.'}
          onPress={() => void saveSettings($, s => ({ ...s, useProjectProfile: !s.useProjectProfile }))}
        />
        <Toggle
          id="fallback"
          on={st.fallback}
          label="Fall back when a read-only request fails"
          hint="Writes and delegations never fall back or retry."
          onPress={() => void saveSettings($, s => ({ ...s, fallback: !s.fallback }))}
        />
        {st.fallback && (
          <Pick
            id="max-fallbacks"
            label="At most"
            value={String(st.maxFallbacks)}
            options={['1', '2', '3'].map(v => ({ value: v, label: `${v} other provider${v === '1' ? '' : 's'}` }))}
            onSelect={v => void saveSettings($, s => ({ ...s, maxFallbacks: Number(v) }))}
          />
        )}
      </Box>

      <Heading title="Privacy" />
      <Box key="security-card" {...CARD}>
        <Toggle
          id="confirm-read"
          on={st.confirmProjectAccess}
          label="Ask before a provider reads project files"
          onPress={() => void saveSettings($, s => ({ ...s, confirmProjectAccess: !s.confirmProjectAccess }))}
        />
        <Toggle
          id="previews"
          on={st.recordPreviews}
          label="Keep redacted prompt previews"
          onPress={() => void saveSettings($, s => ({ ...s, recordPreviews: !s.recordPreviews }))}
        />
        <Toggle
          id="verify"
          on={st.verifyOnConnect}
          label="Test right after connecting"
          onPress={() => void saveSettings($, s => ({ ...s, verifyOnConnect: !s.verifyOnConnect }))}
        />
        <Box marginTop="sm">
          <Hint text="🔒 Changing files always asks first. Read-only requests run in an empty folder." />
        </Box>
      </Box>

      <Heading title="History" />
      <Box key="retention-card" {...CARD}>
        <Pick
          id="ret-count"
          label="Keep"
          value={String(st.retentionCount)}
          options={['25', '100', '500'].map(v => ({ value: v, label: `Last ${v} requests` }))}
          onSelect={v => void saveSettings($, s => ({ ...s, retentionCount: Number(v) }))}
        />
        <Pick
          id="ret-days"
          label="For"
          value={String(st.retentionDays)}
          options={['1', '7', '30', '90'].map(v => ({ value: v, label: `${v} day${v === '1' ? '' : 's'}` }))}
          onSelect={v => void saveSettings($, s => ({ ...s, retentionDays: Number(v) }))}
        />
      </Box>

      <Heading
        title="Diagnostics"
        right={<Button key="diag" label={u.isDiagBusy ? 'Running…' : 'Run checks'} onPress={() => void (u.isDiagBusy ? undefined : runDiagnostics($))} />}
      />
      {u.diagnostics.length === 0 ? (
        <Box key="diag-empty" {...CARD}>
          <Hint text="Checks the CLIs, secure storage, Jervis Relay and models.dev." />
        </Box>
      ) : (
        <Box key="diag-card" {...CARD}>
          {u.diagnostics.map(d => (
            <Box key={`diag-${d.name}`} flexDirection="row" gap="sm" paddingX="sm" paddingY="xs" hover={{ backgroundColor: ROW_HOVER }}>
              <Text weight="bold" color={d.isOk ? 'success' : 'error'}>{d.isOk ? '✓' : '✗'}</Text>
              <Box flexDirection="column" flexShrink={1}>
                <Text weight="medium">{d.name}</Text>
                <Text size="footnote" dimColor={d.isOk} color={d.isOk ? undefined : 'error'}>
                  {snip(d.detail, IN * 3)}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}
