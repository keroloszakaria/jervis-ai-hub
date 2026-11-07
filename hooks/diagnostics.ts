// Integration diagnostics: what is installed, where, and what works.
import type { EngineInterface } from 'claude-code'

import type { DiagRow, Kind } from '../types'
import { secureStorageStatus } from './auth'
import { argvOf, clean, errText, exe, onPath, versionNote } from './cli'
import { delegationSupport } from './delegation'
import { setUi } from './state'

async function version($: EngineInterface, path: string): Promise<string> {
  try {
    const r = await $.process.run([...argvOf(path), '--version'], { timeoutMs: 20_000 })
    return clean(r.stdout || r.stderr).split('\n')[0] ?? ''
  } catch (error) {
    return errText(error)
  }
}

export async function runDiagnostics($: EngineInterface): Promise<void> {
  await setUi($, u => ({ ...u, isDiagBusy: true }))
  const rows: DiagRow[] = []
  const clis: [Kind, string][] = [
    ['codex', 'Codex CLI'],
    ['agy', 'Antigravity CLI'],
    ['opencode-key', 'OpenCode CLI'],
  ]
  for (const [kind, name] of clis) {
    const path = await exe($, kind)
    if (!path) {
      rows.push({ name, isOk: false, detail: 'not installed' })
      continue
    }
    const v = await version($, path)
    const note = versionNote(kind, v)
    rows.push({ name, isOk: !note?.startsWith('refused'), detail: `${v}${note ? ` (${note})` : ''} · ${path}` })
  }
  const shim = await $.process.run(['where', 'codex'], { timeoutMs: 10_000 }).catch(() => undefined)
  const shimPath = shim?.stdout.split(/\r?\n/).find(l => /\.cmd$/i.test(l.trim()))
  if (shimPath) {
    const target = await $.fs.read(shimPath.trim()).catch(() => '')
    const exePath = /"([^"]+codex\.exe)"/i.exec(target)?.[1]
    const isOk = exePath ? await $.fs.exists(exePath).catch(() => false) : true
    rows.push({
      name: 'codex.cmd shim on PATH',
      isOk,
      detail: isOk ? 'points at an existing build' : `points at a removed build (${exePath}); the hub uses the installed codex.exe directly`,
    })
  }
  const dpapi = await secureStorageStatus($)
  rows.push({ name: 'Secure key storage', isOk: dpapi.isOk, detail: dpapi.detail })
  const node = await onPath($, 'node')
  rows.push({ name: 'Node.js (for Jervis Relay)', isOk: Boolean(node), detail: node ?? 'not on PATH' })
  for (const id of ['chatgpt', 'antigravity', 'opencode-free']) {
    const d = await delegationSupport($, id)
    rows.push({ name: `Delegation: ${id}`, isOk: d.isOk, detail: d.detail })
  }
  try {
    const r = await $.http.fetch('https://models.dev/api.json', { method: 'HEAD' })
    rows.push({ name: 'models.dev metadata', isOk: r.ok, detail: r.ok ? 'reachable' : `HTTP ${r.status}` })
  } catch (error) {
    rows.push({ name: 'models.dev metadata', isOk: false, detail: errText(error) })
  }
  await setUi($, u => ({ ...u, diagnostics: rows, isDiagBusy: false }))
}
