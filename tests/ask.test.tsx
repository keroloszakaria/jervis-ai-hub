import { expect, test } from 'claude-code/testing'

declare function setTimeout(fn: () => void, ms: number): unknown
const settle = (ms = 30) => new Promise<void>(r => void setTimeout(r, ms))

const PANE = (bodyColumns = 50) =>
  ({
    plugin: 'ai-subscriptions',
    component: 'Pane',
    requestId: 'ai-subscriptions',
    props: {
      title: 'Jervis AI Hub',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 80 },
      view: {},
    },
  }) as const

const SECRET = 'sk-secret-ABCDEFGH12345678'
const CIPHER = 'ab'.repeat(40)

type Run = { argv: string[]; cwd?: string; env?: Record<string, string>; stdin?: string }
type World = {
  ran: Run[]
  store: Record<string, unknown>
  execOk: boolean
  answer: string
  asked: string[]
  leakKeyInStderr: boolean
  balanceAuth?: string
  toasts: string[]
  /** OpenCode prints a session id and records a cost on it */
  withSession?: boolean
  os?: 'mac'
}

/** reads a PowerShell -EncodedCommand back into its script (UTF-16LE, base64) */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function psScript(argv: string[]): string {
  const enc = argv[argv.indexOf('-EncodedCommand') + 1] ?? ''
  const bytes: number[] = []
  for (let i = 0; i < enc.length; i += 4) {
    const n = [0, 1, 2, 3].map(j => Math.max(0, B64.indexOf(enc[i + j] ?? 'A')))
    const v = (n[0]! << 18) | (n[1]! << 12) | (n[2]! << 6) | n[3]!
    bytes.push((v >> 16) & 255)
    if (enc[i + 2] !== '=') bytes.push((v >> 8) & 255)
    if (enc[i + 3] !== '=') bytes.push(v & 255)
  }
  let out = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8))
  return out
}
const RATE = JSON.stringify({
  id: 2,
  result: {
    ordinaryUsageAllowed: true,
    rateLimits: { primary: { usedPercent: 35, windowDurationMins: 10080, resetsAt: 1300 }, secondary: { usedPercent: 92, windowDurationMins: 300, resetsAt: 1100 }, credits: { hasCredits: false, unlimited: false, balance: '0' }, planType: 'plus' },
  },
})

const ok = (stdout: string, stderr = '', exitCode = 0) => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function engine(on: any, w: World) {
  on('command.register', () => ({ value: { command: 'ai-providers' } }))
  on('tool.register', (_: unknown, e: { name: string }) => ({ value: { tool: `mcp__ai-subscriptions__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_: unknown, e: { text?: string; message?: string }) => {
    w.toasts.push(String(e.text ?? e.message ?? JSON.stringify(e)))
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: w.store[e.key] }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    w.store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.delete', (_: unknown, e: { key: string }) => {
    delete w.store[e.key]
    return { value: undefined }
  })
  on('env.get', (_: unknown, e: { name: string }) =>
    w.os === 'mac'
      ? { value: e.name === 'HOME' ? '/Users/me' : e.name === 'TMPDIR' ? '/tmp/' : e.name === 'PATH' ? '/usr/bin' : undefined }
      : { value: e.name === 'TEMP' ? 'C:\\Temp' : 'C:\\Local' },
  )
  on('fs.list', () => ({ value: [{ name: 'abc', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }))
  on('http.fetch', (_: unknown, e: { url: string; init?: { headers?: Record<string, string> } }) => {
    if (e.url.includes('/user/balance')) {
      w.balanceAuth = e.init?.headers?.Authorization
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '4.20' }] }) } }
    }
    return { value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({ deepseek: { models: { 'deepseek-chat': { name: 'DeepSeek Chat', tool_call: true, reasoning: false, limit: { context: 128000 } } } } }),
    } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_: unknown, e: { questions: { question: string }[] }) => {
    const q = e.questions[0]?.question ?? ''
    w.asked.push(q)
    return { result: { questions: e.questions, answers: { [q]: w.answer } } }
  })
  on('process.run', (_: unknown, e: { argv: string[]; init?: { cwd?: string; env?: Record<string, string>; stdin?: string } }) => {
    const run: Run = { argv: [...e.argv], cwd: e.init?.cwd, env: e.init?.env, stdin: e.init?.stdin }
    w.ran.push(run)
    const a = e.argv.join(' ')
    if (e.argv[0] === 'where' || e.argv[0] === 'which') return ok('', 'not found', 1)
    if (e.argv[0] === 'uname') return ok('Darwin\n')
    if (e.argv[0] === 'osascript') return ok(`${SECRET}\n`)
    if (e.argv[0] === 'security') return e.argv[1] === 'find-generic-password' ? ok(`${SECRET}\n`) : ok('')
    if (e.argv[0] === 'sh') return ok(`${RATE}\n`)
    if (e.argv[1] === 'session' && e.argv[2] === 'export') {
      return ok(JSON.stringify({ info: { id: e.argv[3], cost: 0.5, tokens: { input: 120, output: 30, reasoning: 0, cache: { read: 64, write: 0 } } } }))
    }
    if (e.argv[0] === 'powershell.exe') {
      // protect (stdin = plaintext), reveal (stdin = cipher), prompt (no stdin)
      if (run.stdin === CIPHER) return ok(SECRET)
      if (psScript(e.argv).includes('account/rateLimits/read')) return ok(`${RATE}\n`)
      return ok(CIPHER)
    }
    if (a.includes('login status')) return ok('Logged in using ChatGPT')
    if (a.includes('debug models')) {
      return ok(JSON.stringify({ models: [{ slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list', context_window: 500000, input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }], default_reasoning_level: 'medium' }] }))
    }
    if (a.endsWith(' models')) return ok('gem-pro-low\tGem Pro (Low)\ngem-pro-high\tGem Pro (High)\nsolo\tSolo\n')
    if (a.includes('models --standalone')) return ok('opencode/beam-free\ndeepseek/deepseek-chat\n')
    if (e.argv[1] === 'exec') {
      return w.execOk
        ? ok('{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\n{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}')
        : ok('', 'boom', 1)
    }
    if (e.argv[1] === 'run') {
      if (w.leakKeyInStderr) return ok('', `401 invalid key ${run.env?.DEEPSEEK_API_KEY ?? ''}`, 1)
      return ok(`{"type":"text",${w.withSession ? '"sessionID":"ses_1",' : ''}"part":{"text":"answer from opencode"}}`)
    }
    if (e.argv.includes('/usage')) {
      return ok(JSON.stringify({ status: 'SUCCESS', response: '', command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [{ window: 'weekly', remaining_fraction: 0.85, reset_time: '1970-01-01T00:30:00Z' }, { window: '5h', remaining_fraction: 0.4, reset_time: '1970-01-01T00:20:00Z' }] }] } } }))
    }
    return ok('{"status":"SUCCESS","response":"agy answer","usage":{"input_tokens":5,"output_tokens":1}}')
  })
}

const world = (store: Record<string, unknown> = {}): World => ({
  ran: [],
  store,
  execOk: true,
  answer: 'Deny',
  asked: [],
  leakKeyInStderr: false,
  toasts: [],
})

const LEGACY = () => ({
  'config-v2': {
    chatgpt: { isConnected: true, isEnabled: true, model: 'gpt-6-sol' },
    deepseek: { isConnected: true, isEnabled: true, model: 'deepseek/deepseek-chat' },
  },
  'keys-v1': { deepseek: 'sk-plain-abcdef1234567890' },
})

test('migration keeps providers, encrypts the old plaintext key, and signed-in is not verified', async ($, on) => {
  const w = world(LEGACY())
  engine(on, w)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await settle()

  expect(w.store['keys-v1']).toBeUndefined()
  expect((w.store['hub-creds-dpapi-v1'] as Record<string, string>).deepseek).toBe(CIPHER)
  expect(JSON.stringify(w.store)).not.toContain('sk-plain-abcdef1234567890')
  expect((w.store['hub-config-v3'] as Record<string, { isConnected: boolean }>).deepseek?.isConnected).toBe(true)

  const ui = await $.ui.mount({ ...PANE(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Not tested/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Verified$/ })).toBeUndefined()
  await ui.unmount()
})

test('only a real test request verifies, and a failed one shows as failed', async ($, on) => {
  const w = world(LEGACY())
  engine(on, w)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await settle()
  const ui = await $.ui.mount({ ...PANE(), surface: 'desktop' })

  // no repeated controls: the actions sit behind the overflow
  expect(await ui.find({ key: 'test-chatgpt' })).toBeUndefined()
  await ui.press({ key: 'more-chatgpt' })
  expect(await ui.find({ key: 'test-chatgpt' })).toBeDefined()
  expect(await ui.find({ key: 'test-deepseek' })).toBeUndefined()

  await ui.press({ key: 'test-chatgpt' })
  await settle()
  expect(await ui.find({ type: 'Text', text: /Verified$/ })).toBeDefined()

  w.execOk = false
  await ui.press({ key: 'test-chatgpt' })
  await settle()
  expect(await ui.find({ type: 'Text', text: /Test failed$/ })).toBeDefined()
  await ui.unmount()
})

test('a key echoed back in an error is redacted everywhere', async ($, on) => {
  const w = world(LEGACY())
  w.leakKeyInStderr = true
  engine(on, w)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await settle()

  const r = await $.tool.call({ tool: 'mcp__ai-subscriptions__ask_ai', provider: 'deepseek', prompt: 'hi' } as never)
  const run = w.ran.find(x => x.argv[1] === 'run')
  expect(run?.env?.DEEPSEEK_API_KEY).toBe(SECRET)
  expect(JSON.stringify(r)).not.toContain(SECRET)
  expect(JSON.stringify(w.store)).not.toContain(SECRET)
  expect(JSON.stringify(w.store)).toContain('[redacted]')
})

test('read-only requests run in the sandbox; project access and writes ask first', async ($, on) => {
  const w = world(LEGACY())
  engine(on, w)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await settle()

  await $.tool.call({ tool: 'mcp__ai-subscriptions__ask_ai', provider: 'chatgpt', prompt: 'q1' } as never)
  const first = w.ran.filter(x => x.argv[1] === 'exec').pop()
  expect(first?.cwd).toBe('C:\\Temp\\jervis-ai-hub\\sandbox')
  expect(first?.argv).toContain('read-only')
  expect(w.asked.length).toBe(0)

  const before = w.ran.filter(x => x.argv[1] === 'exec').length
  w.answer = 'Deny'
  const denied = await $.tool.call({ tool: 'mcp__ai-subscriptions__ask_ai', provider: 'chatgpt', prompt: 'q2', cwd: 'C:\\proj' } as never)
  expect(JSON.stringify(denied)).toContain('declined')
  const deniedWrite = await $.tool.call({ tool: 'mcp__ai-subscriptions__ask_ai', provider: 'chatgpt', prompt: 'q3', mode: 'write' } as never)
  expect(JSON.stringify(deniedWrite)).toContain('declined')
  expect(w.ran.filter(x => x.argv[1] === 'exec').length).toBe(before)
  expect(w.asked.length).toBe(2)

  w.answer = 'Allow'
  await $.tool.call({ tool: 'mcp__ai-subscriptions__ask_ai', provider: 'chatgpt', prompt: 'q4', mode: 'write' } as never)
  const write = w.ran.filter(x => x.argv[1] === 'exec').pop()
  expect(write?.argv).toContain('workspace-write')
  expect(write?.cwd).toBe('C:\\proj')
})

test('identical requests in flight run once; compare returns every provider', async ($, on) => {
  const w = world(LEGACY())
  engine(on, w)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await settle()

  const call = () => $.tool.call({ tool: 'mcp__ai-subscriptions__ask_ai', provider: 'chatgpt', prompt: 'same' } as never)
  const before = w.ran.filter(x => x.argv[1] === 'exec').length
  await Promise.all([call(), call()])
  expect(w.ran.filter(x => x.argv[1] === 'exec').length - before).toBe(1)

  const c = await $.tool.call({ tool: 'mcp__ai-subscriptions__compare_ai', prompt: 'which?', providers: ['chatgpt', 'deepseek'] } as never)
  const text = JSON.stringify(c)
  expect(text).toContain('[chatgpt')
  expect(text).toContain('[deepseek')
  expect(text).toContain('answer from opencode')
})

test('models tab searches, filters by reported capability and keeps favorites', async ($, on) => {
  const w = world(LEGACY())
  engine(on, w)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await settle()
  const ui = await $.ui.mount({ ...PANE(), surface: 'desktop' })
  await ui.press({ key: 'tab-models' })
  expect(await ui.find({ key: 'sel-chatgpt::gpt-6-sol' })).toBeDefined()
  expect(await ui.find({ key: 'sel-deepseek::deepseek/deepseek-chat' })).toBeDefined()

  await ui.input({ key: 'model-search-0', text: 'gpt', kind: 'change' })
  expect(await ui.find({ key: 'sel-deepseek::deepseek/deepseek-chat' })).toBeUndefined()
  await ui.input({ key: 'model-search-0', text: '', kind: 'change' })

  await ui.select({ key: 'model-cap', value: 'image-input' })
  expect(await ui.find({ key: 'sel-chatgpt::gpt-6-sol' })).toBeDefined()
  // models.dev reports no image input for this DeepSeek model, so it is filtered out
  expect(await ui.find({ key: 'sel-deepseek::deepseek/deepseek-chat' })).toBeUndefined()

  await ui.press({ key: 'fav-chatgpt::gpt-6-sol' })
  expect(w.store['hub-favorites-v1']).toEqual(['chatgpt::gpt-6-sol'])
  await ui.unmount()
})

test('every tab renders at a narrow width on every surface', async ($, on) => {
  const w = world(LEGACY())
  engine(on, w)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await settle()
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE(24), surface })
    for (const tab of ['overview', 'models', 'activity', 'settings'] as const) {
      await ui.press({ key: `tab-${tab}` })
      expect(await ui.find({ type: 'Text', text: /Jervis AI Hub/ })).toBeDefined()
    }
    await ui.press({ key: 'add' })
    expect(await ui.find({ type: 'Text', text: /Add a provider/ })).toBeDefined()
    expect(await ui.find({ key: 'conn-openrouter' })).toBeDefined()
    expect(await ui.find({ key: 'conn-chatgpt' })).toBeUndefined()
    await ui.press({ key: 'back' })
    await ui.press({ key: 'tab-overview' })
    await ui.press({ key: 'more-chatgpt' })
    expect(await ui.find({ key: 'test-chatgpt' })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('model and effort are picked apart and sent the way each CLI takes them', async ($, on) => {
  const legacy = LEGACY()
  const w = world({
    ...legacy,
    'config-v2': { ...legacy['config-v2'], antigravity: { isConnected: true, isEnabled: true, model: 'gem-pro-high' } },
  })
  engine(on, w)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await settle(60)
  const cfg = () => w.store['hub-config-v3'] as Record<string, { model?: string; effort?: string }>

  // Antigravity lists one id per effort: they fold into one model, and the saved variant becomes model + effort
  expect(cfg().antigravity?.model).toBe('gem-pro')
  expect(cfg().antigravity?.effort).toBe('high')
  await $.tool.call({ tool: 'mcp__ai-subscriptions__ask_ai', provider: 'antigravity', prompt: 'a1' } as never)
  const agy = w.ran.filter(x => x.argv.includes('--output-format')).pop()
  expect(agy?.argv).toContain('gem-pro-high')

  // Codex takes the effort as a config flag, only once one is picked
  await $.tool.call({ tool: 'mcp__ai-subscriptions__ask_ai', provider: 'chatgpt', prompt: 'c0' } as never)
  expect(w.ran.filter(x => x.argv[1] === 'exec').pop()?.argv.join(' ')).not.toContain('model_reasoning_effort')
  const ui = await $.ui.mount({ ...PANE(), surface: 'desktop' })
  await ui.press({ key: 'more-chatgpt' })
  await ui.press({ key: 'effort-chatgpt-high' })
  await settle()
  expect(cfg().chatgpt?.effort).toBe('high')
  await $.tool.call({ tool: 'mcp__ai-subscriptions__ask_ai', provider: 'chatgpt', prompt: 'c1' } as never)
  expect(w.ran.filter(x => x.argv[1] === 'exec').pop()?.argv).toContain('model_reasoning_effort="high"')

  // a model whose source lists no levels gets no effort choice
  await ui.press({ key: 'back' })
  await ui.press({ key: 'more-deepseek' })
  expect(await ui.find({ type: 'Text', text: /Not offered for this model/ })).toBeDefined()
  await ui.unmount()
})

test('limits show only what each provider reports, read through official means', async ($, on) => {
  const legacy = LEGACY()
  const w = world({ ...legacy, 'config-v2': { ...legacy['config-v2'], antigravity: { isConnected: true, isEnabled: true } } })
  engine(on, w)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await settle(80)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE(), surface })
    // Codex: the plan's windows from its app server
    expect(await ui.find({ type: 'Text', text: /35% used/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /92% used/ })).toBeDefined()
    // DeepSeek: its documented balance endpoint, the key sent only there
    expect(await ui.find({ type: 'Text', text: /Balance: 4\.20 USD/ })).toBeDefined()
    // Antigravity: its /usage report, per model group
    expect(await ui.find({ type: 'Text', text: /GEMINI MODELS/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /60% used/ })).toBeDefined()
    // Claude: this session's windows; none yet in a test, and none made up
    expect(await ui.find({ type: 'Text', text: /No reading yet/ })).toBeDefined()
    await ui.press({ key: 'more-chatgpt' })
    expect(await ui.find({ key: 'limits-refresh-chatgpt' })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
  expect(w.balanceAuth).toBe(`Bearer ${SECRET}`)
})

test('a task with no provider goes to the best-fitting model, with the reported facts that chose it', async ($, on) => {
  const w = world(LEGACY())
  engine(on, w)
  await $.session.start({ cwd: 'C:\proj', surface: 'desktop', isInteractive: true })
  await settle(80)
  // hard reasoning: the model that lists effort levels wins, at a high effort
  const r = (await $.tool.call({ tool: 'mcp__ai-subscriptions__ask_ai', task: 'reasoning', prompt: 'think' } as never)) as { result?: unknown }
  const exec = w.ran.filter(x => x.argv[1] === 'exec').pop()
  expect(exec?.argv).toContain('gpt-6-sol')
  expect(exec?.argv).toContain('model_reasoning_effort="high"')
  expect(JSON.stringify(r)).toContain('smart pick for reasoning')
  // Settings shows each task's pick and why
  const ui = await $.ui.mount({ ...PANE(), surface: 'desktop' })
  await ui.press({ key: 'tab-settings' })
  expect(await ui.find({ key: 'pick-reasoning' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Why: reasoning/ })).toBeDefined()
  await ui.unmount()
})


test('a limit alert shows once per level, and a fresh reading is reused for a minute', async ($, on) => {
  const w = world(LEGACY())
  engine(on, w)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await settle(80)
  const reads = () => w.ran.filter(x => x.argv[0] === 'powershell.exe' && psScript(x.argv).includes('account/rateLimits/read')).length
  const alerts = () => w.toasts.filter(t => /ChatGPT \(Codex\) 5-hour limit at 92% used/.test(t)).length
  expect(reads()).toBe(1)
  expect(alerts()).toBe(1)
  // a request moves the plan, but the reading is under a minute old: nothing is read again
  await $.tool.call({ tool: 'mcp__ai-subscriptions__ask_ai', provider: 'chatgpt', prompt: 'x' } as never)
  await settle()
  expect(reads()).toBe(1)
  // Refresh reads now; the same level is not announced twice
  const ui = await $.ui.mount({ ...PANE(), surface: 'desktop' })
  await ui.press({ key: 'limits-refresh-all' })
  await settle(60)
  expect(reads()).toBe(2)
  expect(alerts()).toBe(1)
  await ui.unmount()
})

test('/ask-ai asks directly; compare uses each provider’s best model; OpenCode’s recorded cost is shown', async ($, on) => {
  const w = world(LEGACY())
  w.withSession = true
  engine(on, w)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await settle(80)

  const help = await $.command.run({ command: 'ask-ai', args: '' } as never)
  expect(help.text).toContain('Usage: /ask-ai')
  const r = await $.command.run({ command: 'ask-ai', args: 'deepseek what is 2+2' } as never)
  const run = w.ran.filter(x => x.argv[1] === 'run').pop()
  expect(run?.stdin).toBe('what is 2+2')
  expect(run?.cwd).toBe('C:\\Temp\\jervis-ai-hub\\sandbox')
  expect(r.text).toContain('answer from opencode')
  expect(r.text).toContain('cost OpenCode recorded: $0.50')

  await $.tool.call({ tool: 'mcp__ai-subscriptions__compare_ai', prompt: 'which?', providers: ['chatgpt', 'deepseek'], task: 'reasoning' } as never)
  expect(w.ran.filter(x => x.argv[1] === 'exec').pop()?.argv).toContain('model_reasoning_effort="high"')

  const ui = await $.ui.mount({ ...PANE(), surface: 'desktop' })
  await ui.press({ key: 'tab-activity' })
  expect(await ui.find({ type: 'Text', text: /API COST/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$1\.00/ })).toBeDefined()
  await ui.unmount()
})

test('the pane reads in Arabic when the language is set', async ($, on) => {
  const w = world({ ...LEGACY(), 'hub-settings-v1': { routes: {}, profiles: {}, language: 'ar' } })
  engine(on, w)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await settle(60)
  const ui = await $.ui.mount({ ...PANE(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /الـ Providers/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Providers$/i })).toBeUndefined()
  await ui.press({ key: 'tab-settings' })
  expect(await ui.find({ type: 'Text', text: /موديل لكل مهمة/ })).toBeDefined()
  await ui.select({ key: 'language', value: 'en' })
  await settle()
  expect(await ui.find({ type: 'Text', text: /MODEL FOR EACH TASK/ })).toBeDefined()
  await ui.unmount()
})

test('on macOS keys live in the Keychain, passed on stdin, and the store keeps only a marker', async ($, on) => {
  const w = world(LEGACY())
  w.os = 'mac'
  engine(on, w)
  await $.session.start({ cwd: '/Users/me/proj', surface: 'desktop', isInteractive: true })
  await settle(80)
  const add = w.ran.find(x => x.argv[0] === 'security' && x.argv[1] === '-i')
  expect(add?.stdin).toContain('add-generic-password -U -s jervis-ai-hub -a "deepseek"')
  expect(add?.stdin).toContain('sk-plain-abcdef1234567890')
  expect(w.ran.some(x => x.argv.join(' ').includes('sk-plain-abcdef1234567890'))).toBe(false)
  expect((w.store['hub-creds-dpapi-v1'] as Record<string, string>).deepseek).toBe('keychain:v1')
  expect(JSON.stringify(w.store)).not.toContain('sk-plain-abcdef1234567890')

  await $.tool.call({ tool: 'mcp__ai-subscriptions__ask_ai', provider: 'deepseek', prompt: 'hi' } as never)
  const run = w.ran.filter(x => x.argv[1] === 'run').pop()
  expect(run?.env?.DEEPSEEK_API_KEY).toBe(SECRET)
  expect(run?.cwd).toBe('/tmp/jervis-ai-hub/sandbox')
  // Codex limits without PowerShell
  expect(w.ran.some(x => x.argv[0] === 'sh' && x.argv.includes('{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read"}'))).toBe(true)
  expect(w.ran.some(x => x.argv[0] === 'powershell.exe')).toBe(false)
})
