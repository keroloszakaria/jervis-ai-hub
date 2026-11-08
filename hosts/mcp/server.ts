// Jervis AI Hub as an MCP server (stdio), for hosts other than Claude Code:
// the Codex plugin and the Antigravity plugin start it. It serves the same
// tools as the Claude Code plugin, run by the same modules.
//
//   node dist/jervis-mcp.mjs                 the MCP server (stdio)
//   node dist/jervis-mcp.mjs apply <run-id>  apply a kept run, asking on this terminal
//   node dist/jervis-mcp.mjs tools           list the tools (a check that it loads)
//
// The host says who it is with JERVIS_HUB_HOST (codex, antigravity): its own
// provider is never sent requests from here. Nothing here can put a question to
// a person, so every approval reads as "nobody could be asked": reads of a
// project folder and writes are not sent unless the person turned the question
// off in the hub's settings, and changes made in a copy are kept for later. Only
// `apply`, run by the person in their own terminal, applies them.
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

import { read, update, atom } from 'claude-code'

import { applyChangesTool } from '../../hooks/actions'
import { checkAllAuth, connect } from '../../hooks/health'
import { settleJobs } from '../../hooks/jobs'
import { isModelListStale, refreshModels } from '../../hooks/models'
import { PROVIDERS } from '../../hooks/registry'
import { STORE, loadPersisted } from '../../hooks/state'
import { type Host, TOOL_NAMES, callTool, toolSpecs } from '../../hooks/tools'
import { type Asker, nodeEngine } from './engine'

const VERSION = '0.11.0'
const PROTOCOL = '2025-06-18'

const config = atom({ plugin: 'ai-subscriptions', key: 'config' } as const, {}, { shape: 'cfg-3' })
const models = atom({ plugin: 'ai-subscriptions', key: 'models' } as const, {}, { shape: 'm-2' })
const cwd = atom({ plugin: 'ai-subscriptions', key: 'cwd' } as const, '', { shape: 'cwd-1' })

const hostOf = (): Host => {
  const h = process.env.JERVIS_HUB_HOST
  return h === 'codex' || h === 'antigravity' ? h : 'mcp'
}

type Engine = ReturnType<typeof nodeEngine>

/** What Claude Code's session start does, without the pane: the saved setup, sign-ins checked, models listed. */
async function start($: Engine, folder: string): Promise<void> {
  const e = $ as never
  await update(e, cwd, () => folder)
  await loadPersisted(e)
  // first run here: link the official sign-ins that already work (checks only, no prompt sent)
  if (!(await $.store.get(STORE.config))) for (const id of ['chatgpt', 'antigravity', 'opencode-free']) await connect(e, id).catch(() => undefined)
  await settleJobs(e).catch(() => undefined)
  await checkAllAuth(e).catch(() => undefined)
  const cfg = (await read(e, config)) as Record<string, { isConnected?: boolean }>
  const lists = (await read(e, models)) as Record<string, never>
  const now = Date.now()
  for (const p of PROVIDERS) if (cfg[p.id]?.isConnected && isModelListStale(lists[p.id], now)) void refreshModels(e, p.id).catch(() => undefined)
}

type Rpc = { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: Record<string, unknown> }

async function serve(): Promise<void> {
  const host = hostOf()
  const $ = nodeEngine({ log: t => process.stderr.write(`[jervis] ${t}\n`) })
  const e = $ as never
  // a host may start the server in the plugin's own folder, which is no project
  const here = process.cwd()
  const root = process.env.PLUGIN_ROOT
  const isPluginFolder = root !== undefined && resolve(root).toLowerCase() === resolve(here).toLowerCase()
  const ready = start($, isPluginFolder ? '' : here)
  const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`)
  const answer = (id: Rpc['id'], result: unknown) => send({ jsonrpc: '2.0', id, result })
  const fail = (id: Rpc['id'], code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } })

  const handle = async (m: Rpc): Promise<void> => {
    if (m.id === undefined) return // a notification: nothing to answer
    switch (m.method) {
      case 'initialize':
        return answer(m.id, {
          protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'jervis-ai-hub', version: VERSION },
          instructions:
            'Jervis AI Hub: send prompts to other AIs the user connected (their own subscriptions and keys), compare them, run background jobs, and read limits and models. ' +
            'Approvals cannot be asked here: project reads and writes are not sent unless the user allowed them in the hub, and changes made in a copy are applied only by the user from their terminal.',
        })
      case 'ping':
        return answer(m.id, {})
      case 'tools/list': {
        await ready
        const specs = await toolSpecs(e, host)
        return answer(m.id, {
          tools: specs.map(s => ({ name: s.name, description: s.description, inputSchema: s.inputSchema, annotations: { readOnlyHint: s.isReadOnly, openWorldHint: true } })),
        })
      }
      case 'tools/call': {
        await ready
        const name = String(m.params?.name ?? '')
        if (!(TOOL_NAMES as readonly string[]).includes(name)) return fail(m.id, -32602, `Unknown tool "${name}"`)
        try {
          const r = await callTool(e, host, name, (m.params?.arguments as Record<string, unknown>) ?? {})
          return answer(m.id, { content: [{ type: 'text', text: r.text }], isError: !r.isOk })
        } catch (error) {
          return answer(m.id, { content: [{ type: 'text', text: `Jervis AI Hub failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true })
        }
      }
      default:
        return fail(m.id, -32601, `Method not found: ${m.method}`)
    }
  }

  const rl = createInterface({ input: process.stdin })
  rl.on('line', line => {
    if (!line.trim()) return
    let m: Rpc
    try {
      m = JSON.parse(line) as Rpc
    } catch {
      return fail(null, -32700, 'Parse error')
    }
    void handle(m).catch(err => fail(m.id ?? null, -32603, err instanceof Error ? err.message : String(err)))
  })
  rl.on('close', () => process.exit(0))
}

/** Asks on this terminal: the person types the number of their answer. */
const terminalAsker: Asker = (question, options) =>
  new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    process.stderr.write(`\n${question}\n${options.map((o, i) => `  ${i + 1}. ${o}`).join('\n')}\n`)
    rl.question('Answer with a number: ', a => {
      rl.close()
      resolve(options[Number(a.trim()) - 1])
    })
  })

async function applyCommand(run: string | undefined): Promise<number> {
  if (!run) {
    process.stderr.write('Usage: node jervis-mcp.mjs apply <run-id>, from the project folder.\n')
    return 2
  }
  // the answer must come from a person: no terminal, no Apply
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    process.stderr.write('apply asks you on this terminal, so it needs one (it was not started from an interactive terminal). Nothing was applied.\n')
    return 2
  }
  const $ = nodeEngine({ ask: terminalAsker })
  await update($ as never, cwd, () => process.cwd())
  await loadPersisted($ as never)
  const r = await applyChangesTool($ as never, run)
  process.stdout.write(`${r.text}\n`)
  return r.isOk ? 0 : 1
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'apply') process.exit(await applyCommand(arg))
  if (cmd === 'tools') {
    const $ = nodeEngine()
    await loadPersisted($ as never)
    process.stdout.write(`${(await toolSpecs($ as never, hostOf())).map(s => s.name).join('\n')}\n`)
    return
  }
  if (cmd === '--version') {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  await serve()
}

void main()
