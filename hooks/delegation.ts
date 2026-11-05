// DelegationBridge: hands a coding task to another agent through the existing
// Jervis Relay delegate skills (codex-delegate, agy-delegate), which run the
// agent in the repository, forbid commits and write a result.json with the
// files it touched. The hub adds no orchestration of its own.
import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { begin, finish, redact } from './activity'
import { clean, dirOf, errText, exe, onPath } from './cli'
import { resolveModel } from './models'
import { provider } from './registry'
import { readiness } from './requests'

// state this file reads (the scan needs each atom declared in the file that uses it)
import { homeDir, joinPath, osName, pathSep, tempDir } from './platform'
const config = atom({ plugin: 'ai-subscriptions', key: 'config' } as const, {}, { shape: 'cfg-3' })
const models = atom({ plugin: 'ai-subscriptions', key: 'models' } as const, {}, { shape: 'm-2' })

export type DelegationResult = {
  isOk: boolean
  text: string
  status?: string
  touchedFiles?: string[]
  resultPath?: string
}

async function skillScript($: EngineInterface, skill: string): Promise<string | undefined> {
  const path = joinPath(await osName($), await homeDir($), '.claude', 'skills', skill, 'scripts', 'relay.mjs')
  try {
    return (await $.fs.exists(path)) ? path : undefined
  } catch {
    return undefined
  }
}

/** Whether a provider can be delegated to here, and if not, why. */
export async function delegationSupport($: EngineInterface, id: string): Promise<{ isOk: boolean; detail: string }> {
  const p = provider(id)
  if (!p?.relaySkill) {
    return { isOk: false, detail: 'No Jervis Relay adapter works with this CLI version (the opencode-delegate relay needs a newer OpenCode).' }
  }
  if (!(await skillScript($, p.relaySkill))) return { isOk: false, detail: `The ${p.relaySkill} skill is not installed.` }
  if (!(await onPath($, 'node'))) return { isOk: false, detail: 'Node.js is not on PATH.' }
  return { isOk: true, detail: `via ${p.relaySkill}` }
}

/**
 * Runs the relay. The caller has already confirmed with the person: this
 * changes files in `repo`.
 */
export async function delegate(
  $: EngineInterface,
  id: string,
  brief: string,
  repo: string,
): Promise<DelegationResult> {
  const p = provider(id)
  if (!p?.relaySkill) return { isOk: false, text: 'This provider has no working relay adapter.' }
  const blocked = await readiness($, id)
  if (blocked) return { isOk: false, text: blocked }
  const script = await skillScript($, p.relaySkill)
  const node = await onPath($, 'node')
  if (!script || !node) return { isOk: false, text: (await delegationSupport($, id)).detail }

  const os = await osName($)
  const stamp = await $.clock.now()
  const briefPath = joinPath(os, await tempDir($), 'jervis-ai-hub', 'briefs', `brief-${stamp}.md`)
  const guard =
    '\n\nRules from the orchestrator: do not commit, do not push, keep changes inside this repository, and report what you changed.\n'
  await $.fs.write(briefPath, brief + guard)

  // The relay finds the CLI on PATH; a stale shim there must not shadow the working build.
  const cli = await exe($, p.kind)
  const pathVar = (await $.env.get('PATH')) ?? (await $.env.get('Path')) ?? ''
  const sep = pathSep(os)
  const env = cli ? { PATH: `${dirOf(cli)}${sep}${pathVar}`, ...(os === 'windows' ? { Path: `${dirOf(cli)}${sep}${pathVar}` } : {}) } : undefined
  const c = (await read($, config))[id]
  const pick = resolveModel((await read($, models))[id]?.models, c?.model, c?.effort)
  // the relay takes a model id only: an effort the CLI encodes in the id (Antigravity) goes through it
  const model = pick.cliModel

  const actId = await begin($, { type: 'delegate', provider: id, model: c?.model, effort: pick.effort, mode: 'write', prompt: brief })
  const started = await $.clock.now()
  let stderr = ''
  let code: number | null = null
  try {
    const stream = $.process.spawn({
      argv: [node, script, '--brief', briefPath, '--cd', repo, '--mode', 'workspace-write', ...(model ? ['--model', model] : [])],
      cwd: repo,
      env,
    })
    for await (const chunk of stream) if (chunk.stream === 'stderr') stderr += chunk.text
    code = (await stream.result).code
  } catch (error) {
    const ms = (await $.clock.now()) - started
    await finish($, actId, { state: 'error', ms, error: errText(error) })
    return { isOk: false, text: `The relay could not start: ${errText(error)}` }
  }
  const ms = (await $.clock.now()) - started
  const resultPath = /[A-Za-z]:\\[^\r\n"]*result\.json|\/[^\s"]*result\.json/.exec(clean(stderr))?.[0]
  let result: Record<string, unknown> | undefined
  if (resultPath) {
    try {
      result = JSON.parse(await $.fs.read(resultPath)) as Record<string, unknown>
    } catch {
      // reported below without it
    }
  }
  const git = (result?.git ?? {}) as { touchedFiles?: unknown }
  const touched = Array.isArray(git.touchedFiles) ? git.touchedFiles.filter((f): f is string => typeof f === 'string') : undefined
  const status = typeof result?.status === 'string' ? result.status : code === 0 ? 'completed' : 'failed'
  const final = typeof result?.finalMessage === 'string' ? result.finalMessage : ''
  const isOk = status === 'completed'
  await finish($, actId, {
    state: isOk ? 'ok' : 'error',
    ms,
    touchedFiles: touched,
    resultPreview: final,
    error: isOk ? undefined : redact(clean(stderr).slice(-600)),
  })
  const files = touched?.length ? `\nFiles changed (review before committing):\n${touched.map(f => `- ${f}`).join('\n')}` : '\nNo files changed.'
  return {
    isOk,
    status,
    touchedFiles: touched,
    resultPath,
    text: `${p.label} relay ${status} in ${Math.round(ms / 1000)}s.${files}\n\n${final}`.trim(),
  }
}
