// Acceptance checks for the MCP server the Codex and Antigravity plugins start,
// run against the built bundle the way a host runs it (stdio JSON-RPC).
//
//   npx -y tsx@4.19.2 ci/mcp-smoke.ts [--real]
//
// Without --real nothing is sent to any provider: the checks are the protocol,
// the tool list, and the refusals that must hold before anything runs. With
// --real one read-only prompt goes to OpenCode's free tier, if it is signed in.
// Each run uses a store of its own in a temporary folder.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const BUNDLE = join(__dirname, '..', 'dist', 'jervis-mcp.mjs')
const isReal = process.argv.includes('--real')
let failures = 0

function check(what: string, isOk: boolean, detail = ''): void {
  if (!isOk) failures++
  console.log(`${isOk ? 'ok  ' : 'FAIL'} ${what}${isOk || !detail ? '' : `\n     ${detail.slice(0, 600)}`}`)
}

type Server = { call: (method: string, params?: unknown) => Promise<Record<string, unknown>>; stop: () => void }

function server(env: Record<string, string>): Server {
  const child = spawn(process.execPath, [BUNDLE], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map<number, (m: Record<string, unknown>) => void>()
  let next = 1
  createInterface({ input: child.stdout }).on('line', line => {
    const m = JSON.parse(line) as { id: number }
    pending.get(m.id)?.(m as never)
    pending.delete(m.id)
  })
  child.stderr.on('data', () => undefined)
  return {
    call: (method, params) =>
      new Promise(resolve => {
        const id = next++
        pending.set(id, resolve)
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      }),
    stop: () => child.kill(),
  }
}

const text = (r: Record<string, unknown>): string => ((r.result as { content?: { text: string }[] })?.content ?? []).map(c => c.text).join('\n')
const isError = (r: Record<string, unknown>): boolean => Boolean((r.result as { isError?: boolean })?.isError)
const tool = (s: Server, name: string, args: Record<string, unknown> = {}) => s.call('tools/call', { name, arguments: args })

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'jervis-mcp-'))
  try {
    const s = server({ JERVIS_HUB_HOST: 'codex', JERVIS_HUB_HOME: home })
    const init = await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
    check('initialize names the server', JSON.stringify(init).includes('jervis-ai-hub'), JSON.stringify(init))
    const list = (await s.call('tools/list')).result as { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] }
    const names = list.tools.map(t => t.name)
    const want = ['ask_ai', 'compare_ai', 'delegate_ai', 'apply_changes', 'start_job', 'job_status', 'stop_job', 'list_providers', 'list_models', 'get_limits', 'preview_route', 'get_activity', 'get_diagnostics']
    check('every tool is listed', want.every(n => names.includes(n)), names.join(','))
    check('read-only tools say so', list.tools.find(t => t.name === 'get_limits')?.annotations?.readOnlyHint === true && list.tools.find(t => t.name === 'ask_ai')?.annotations?.readOnlyHint === false)

    const providers = text(await tool(s, 'list_providers'))
    check('Codex, the host, is marked as never sent requests', /chatgpt:.*the agent this hub runs inside/.test(providers), providers)
    const self = await tool(s, 'ask_ai', { provider: 'chatgpt', prompt: 'ping' })
    check('a request to the host’s own provider is refused', isError(self) && text(self).includes('runs inside'), text(self))

    const apply = await tool(s, 'apply_changes', { run: 'run-1-0123456789abcdef' })
    check('apply_changes never applies here: it gives the terminal command', text(apply).includes('node dist/jervis-mcp.mjs apply run-1-0123456789abcdef') && !text(apply).includes('Applied'), text(apply))

    // nobody can be asked here, so no write and no delegation is ever sent
    const del = await tool(s, 'delegate_ai', { provider: 'opencode-free', brief: 'change a file', repo: home })
    check('a delegation cannot be approved here, so nothing is delegated', isError(del) && /nothing was delegated|not connected|Refused/.test(text(del)), text(del))
    const write = await tool(s, 'ask_ai', { provider: 'opencode-free', prompt: 'write a file', mode: 'write', cwd: home })
    check('a write cannot be approved here, so nothing is sent', isError(write) && !/Applied/.test(text(write)), text(write))

    const unknown = await s.call('tools/call', { name: 'rm_rf', arguments: {} })
    check('an unknown tool is a protocol error', JSON.stringify(unknown).includes('Unknown tool'), JSON.stringify(unknown))

    const limits = text(await tool(s, 'get_limits'))
    check('get_limits answers without inventing numbers', !/NaN|undefined/.test(limits), limits)
    const preview = await tool(s, 'preview_route', { task: 'general', prompt: 'x' })
    check('preview_route answers and sends nothing', !/Unknown tool/.test(text(preview)), text(preview))

    if (isReal) {
      const r = await tool(s, 'ask_ai', { provider: 'opencode-free', prompt: 'Reply with exactly: PONG' })
      check('a real read-only request to OpenCode answers', !isError(r) && /PONG/i.test(text(r)), text(r))
      const withFolder = await tool(s, 'ask_ai', { provider: 'opencode-free', prompt: 'list the files', cwd: process.cwd() })
      check('project access cannot be approved here, so nothing is sent', isError(withFolder) && /nobody could be asked/.test(text(withFolder)), text(withFolder))
    }
    s.stop()

    // a hub inside an agent a hub started sends nothing on
    const deep = server({ JERVIS_HUB_HOST: 'codex', JERVIS_HUB_HOME: home, JERVIS_HUB_DEPTH: '1' })
    await deep.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
    const loop = await tool(deep, 'ask_ai', { provider: 'opencode-free', prompt: 'ping' })
    check('at depth 1 nothing is sent on', isError(loop) && text(loop).includes('sends nothing on'), text(loop))
    deep.stop()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

main().then(
  () => {
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
    process.exit(failures ? 1 : 0)
  },
  error => {
    console.error(error)
    process.exit(1)
  },
)
