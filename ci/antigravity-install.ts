// Acceptance for the Antigravity plugin: check it with `agy plugin validate
// --strict`, install it with the real agy CLI into a temporary home, disable and
// enable it, start the installed MCP server the way Antigravity does, then
// uninstall it and check nothing of it is left. The person's own ~/.gemini is
// never touched (USERPROFILE and HOME point at the temporary folder), and no
// prompt is sent to any provider.
//
//   npx -y tsx@4.19.2 ci/antigravity-install.ts [--agy <path to agy>]
//
// Without an agy CLI (on PATH, AGY_BIN, or --agy) the checks that need it are
// reported as failed, so a missing CLI never reads as a pass.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const ROOT = join(__dirname, '..')
const PLUGIN = join(ROOT, 'integrations', 'antigravity')
const NAME = 'jervis-ai-hub'
let failures = 0

function check(what: string, isOk: boolean, detail = ''): void {
  if (!isOk) failures++
  console.log(`${isOk ? 'ok  ' : 'FAIL'} ${what}${isOk || !detail ? '' : `\n     ${detail.slice(0, 600)}`}`)
}

function agyBin(): string | undefined {
  const i = process.argv.indexOf('--agy')
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1]
  if (process.env.AGY_BIN) return process.env.AGY_BIN
  const probe = spawnSync('agy', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' })
  return probe.status === 0 ? 'agy' : undefined
}

function agy(bin: string, home: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(bin, args, { encoding: 'utf8', env: { ...process.env, USERPROFILE: home, HOME: home }, shell: bin === 'agy' && process.platform === 'win32', timeout: 120_000 })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

type Listed = { name: string; enabled: boolean; mcpServers?: string[]; skills?: string[]; path?: string }
const listed = (bin: string, home: string): Listed[] => {
  const r = agy(bin, home, ['plugin', 'list', '--json'])
  try {
    return (JSON.parse(r.out.slice(r.out.indexOf('['))) as Listed[] | null) ?? []
  } catch {
    return []
  }
}

/** One MCP request and its answer, to the server started as Antigravity starts it. */
async function mcpProviders(bundleRoot: string, data: string): Promise<string> {
  const child = spawn(process.execPath, [join(bundleRoot, 'dist', 'jervis-mcp.mjs')], {
    cwd: bundleRoot,
    env: { ...process.env, PLUGIN_ROOT: bundleRoot, PLUGIN_DATA: data, JERVIS_HUB_HOST: 'antigravity' },
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
  const mcp = JSON.parse(readFileSync(join(PLUGIN, 'mcp_config.json'), 'utf8')) as { mcpServers: Record<string, { env?: Record<string, string> }> }
  check('the server tells the hub it runs inside Antigravity', mcp.mcpServers.hub?.env?.JERVIS_HUB_HOST === 'antigravity')
  check('the plugin has no hooks (nothing runs on its own)', !existsSync(join(PLUGIN, 'hooks.json')) && !existsSync(join(PLUGIN, 'hooks')))

  const bin = agyBin()
  if (!bin) {
    check('an agy CLI to install with (PATH, AGY_BIN or --agy)', false, 'no agy CLI found: the install checks did not run')
    return
  }
  const home = mkdtempSync(join(tmpdir(), 'jervis-agy-home-'))
  const data = mkdtempSync(join(tmpdir(), 'jervis-agy-data-'))
  try {
    const v = agy(bin, home, ['plugin', 'validate', PLUGIN, '--strict'])
    check('agy validates the plugin in strict mode', v.code === 0 && /Validation passed/.test(v.out), v.out)
    const inst = agy(bin, home, ['plugin', 'install', PLUGIN])
    check('agy installs the plugin', inst.code === 0 && /mcpServers\s*:\s*1 installed/.test(inst.out), inst.out)
    const installed = join(home, '.gemini', 'config', 'plugins', NAME)
    check('the install has the manifest, the MCP config, the skill and the bundle', ['plugin.json', 'mcp_config.json', join('skills', 'jervis-ai-hub', 'SKILL.md'), join('dist', 'jervis-mcp.mjs')].every(f => existsSync(join(installed, f))), installed)
    const row = listed(bin, home).find(p => p.name === NAME)
    check('agy lists it, enabled, with the hub server and the skill', row?.enabled === true && (row.mcpServers ?? []).includes('hub') && (row.skills ?? []).includes('jervis-ai-hub'), JSON.stringify(row))

    const off = agy(bin, home, ['plugin', 'disable', NAME])
    check('agy disables it', off.code === 0 && listed(bin, home).find(p => p.name === NAME)?.enabled === false, off.out)
    const on = agy(bin, home, ['plugin', 'enable', NAME])
    check('agy enables it again', on.code === 0 && listed(bin, home).find(p => p.name === NAME)?.enabled === true, on.out)

    const answer = await mcpProviders(installed, data)
    check('the installed server answers, and never sends Antigravity’s own provider requests', /antigravity:.*the agent this hub runs inside/.test(answer), answer)

    const rm = agy(bin, home, ['plugin', 'uninstall', NAME])
    check('agy uninstalls it', rm.code === 0, rm.out)
    check('agy no longer lists it', !listed(bin, home).some(p => p.name === NAME))
    const plugins = join(home, '.gemini', 'config', 'plugins')
    check('nothing of it is left in the plugins folder', !existsSync(plugins) || !readdirSync(plugins).includes(NAME), existsSync(plugins) ? readdirSync(plugins).join(',') : '')
    const cfg = join(home, '.gemini', 'config', 'config.json')
    const cfgText = existsSync(cfg) ? readFileSync(cfg, 'utf8') : ''
    check('nothing of it is left in the config', !cfgText.includes(NAME), cfgText)
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
