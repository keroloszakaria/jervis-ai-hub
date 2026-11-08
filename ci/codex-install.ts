// Acceptance for the Codex plugin: install it with the real Codex CLI into a
// temporary CODEX_HOME, start the installed MCP server the way Codex does, then
// remove it and check nothing of it is left. The person's own ~/.codex is never
// touched, and no prompt is sent to any provider.
//
//   npx -y tsx@4.19.2 ci/codex-install.ts [--codex <path to codex>]
//
// Without a Codex CLI (on PATH, CODEX_BIN, or --codex) the checks that need it
// are reported as skipped and the run fails, so a missing CLI never reads as a pass.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const ROOT = join(__dirname, '..')
const PLUGIN = join(ROOT, 'integrations', 'codex')
const MARKET = 'jervis-ai-hub'
const NAME = 'jervis-ai-hub'
let failures = 0

function check(what: string, isOk: boolean, detail = ''): void {
  if (!isOk) failures++
  console.log(`${isOk ? 'ok  ' : 'FAIL'} ${what}${isOk || !detail ? '' : `\n     ${detail.slice(0, 600)}`}`)
}

function codexBin(): string | undefined {
  const i = process.argv.indexOf('--codex')
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1]
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN
  const probe = spawnSync('codex', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' })
  return probe.status === 0 ? 'codex' : undefined
}

function codex(bin: string, home: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(bin, args, { encoding: 'utf8', env: { ...process.env, CODEX_HOME: home }, shell: bin === 'codex' && process.platform === 'win32', timeout: 120_000 })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** One MCP request and its answer, to the server started as Codex starts it. */
async function mcpProviders(bundleRoot: string, data: string): Promise<string> {
  const child = spawn(process.execPath, [join(bundleRoot, 'dist', 'jervis-mcp.mjs')], {
    cwd: bundleRoot,
    env: { ...process.env, PLUGIN_ROOT: bundleRoot, PLUGIN_DATA: data, JERVIS_HUB_HOST: 'codex' },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const lines = createInterface({ input: child.stdout })
  const answers = new Map<number, string>()
  const waiting = new Map<number, (s: string) => void>()
  lines.on('line', l => {
    const m = JSON.parse(l) as { id: number }
    const w = waiting.get(m.id)
    if (w) w(l)
    else answers.set(m.id, l)
  })
  const call = (id: number, method: string, params: unknown) =>
    new Promise<string>(resolve => {
      waiting.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  try {
    await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })
    return await call(2, 'tools/call', { name: 'list_providers', arguments: { all: true } })
  } finally {
    child.kill()
  }
}

async function main(): Promise<void> {
  const shipped = readFileSync(join(PLUGIN, 'dist', 'jervis-mcp.mjs'))
  check('the plugin ships the same MCP bundle the core builds', shipped.equals(readFileSync(join(ROOT, 'dist', 'jervis-mcp.mjs'))))
  const manifest = JSON.parse(readFileSync(join(PLUGIN, 'plugin.json'), 'utf8')) as { name: string; version: string }
  const mcp = JSON.parse(readFileSync(join(PLUGIN, 'mcp.json'), 'utf8')) as { mcpServers: Record<string, { env?: Record<string, string> }> }
  check('the server tells the hub it runs inside Codex', mcp.mcpServers.hub?.env?.JERVIS_HUB_HOST === 'codex')
  check('the plugin has no hooks (nothing for the person to trust, nothing runs on its own)', !existsSync(join(PLUGIN, 'hooks')) && !JSON.stringify(manifest).includes('"hooks"'))

  const bin = codexBin()
  if (!bin) {
    check('a Codex CLI to install with (PATH, CODEX_BIN or --codex)', false, 'no Codex CLI found: the install checks did not run')
    return
  }
  const home = mkdtempSync(join(tmpdir(), 'jervis-codex-home-'))
  const data = mkdtempSync(join(tmpdir(), 'jervis-codex-data-'))
  try {
    const add = codex(bin, home, ['plugin', 'marketplace', 'add', ROOT])
    check('codex adds the marketplace from the repository', add.code === 0, add.out)
    const inst = codex(bin, home, ['plugin', 'add', `${NAME}@${MARKET}`])
    check('codex installs the plugin', inst.code === 0, inst.out)
    const cached = join(home, 'plugins', 'cache', MARKET, NAME, manifest.version)
    check('the install has the manifest, the MCP config, the skill and the bundle', ['plugin.json', 'mcp.json', join('skills', 'jervis-ai-hub', 'SKILL.md'), join('dist', 'jervis-mcp.mjs')].every(f => existsSync(join(cached, f))), cached)
    const list = codex(bin, home, ['mcp', 'list'])
    check('codex lists the hub server, enabled', /\bhub\b.*jervis-mcp\.mjs.*enabled/s.test(list.out), list.out)

    const answer = await mcpProviders(cached, data)
    check('the installed server answers, and never sends Codex’s own provider requests', /chatgpt:.*the agent this hub runs inside/.test(answer), answer)

    const rm = codex(bin, home, ['plugin', 'remove', `${NAME}@${MARKET}`])
    check('codex removes the plugin', rm.code === 0, rm.out)
    const rmm = codex(bin, home, ['plugin', 'marketplace', 'remove', MARKET])
    check('codex removes the marketplace', rmm.code === 0, rmm.out)
    const config = existsSync(join(home, 'config.toml')) ? readFileSync(join(home, 'config.toml'), 'utf8') : ''
    check('nothing of it is left in the config', !config.includes(NAME), config)
    const left = join(home, 'plugins', 'cache', MARKET)
    check('nothing of it is left in the cache', !existsSync(left) || readdirSync(left).length === 0, existsSync(left) ? readdirSync(left).join(',') : '')
    const after = codex(bin, home, ['mcp', 'list'])
    check('codex no longer lists the hub server', !/jervis-mcp\.mjs/.test(after.out), after.out)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(data, { recursive: true, force: true })
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
