// DelegationBridge: hands a coding task to another agent through the existing
// Jervis Relay delegate skills (codex-delegate, agy-delegate), which run the
// agent in the repository, forbid commits and write a result.json with the
// files it touched. The hub adds no orchestration of its own.
import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { begin, finish, redact, redactKeys } from './activity'
import { clean, dirOf, errText, exe, onPath } from './cli'
import { changedFiles, filesLine, guardEnv, LOCK_NOTE, refChanges, refusal, snapshot, workState } from './gitguard'
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

/** A token for one run, written into its brief, so its result can be told from another run's. */
function runToken(): string {
  const b = new Uint8Array(12)
  crypto.getRandomValues(b)
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('')
}

const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

/**
 * Why a result.json cannot be trusted as this run's, or undefined when it can.
 * It is read from the folder the hub gave the relay (--out-dir), never from a
 * path the run reports, and must have the relay's v1 schema, the agent that was
 * asked, its own place in that folder, and the brief the relay copied there
 * carrying this run's token. This binds a result to its run; it is not a
 * boundary against an agent that may write anywhere (Antigravity's delegation).
 */
export async function resultProblem(
  $: EngineInterface,
  result: Record<string, unknown> | undefined,
  want: { agent: string; resultPath: string; briefPath: string; token: string; isMissing?: boolean },
): Promise<string | undefined> {
  if (want.isMissing) return 'it left no result in the folder the hub gave it'
  if (!result) return 'its result file could not be read as JSON'
  if (result.schema !== 'jervis-relay.result.v1') return `its result has an unknown schema (${String(result.schema)})`
  if (result.agent !== want.agent) return `its result is from another agent (${String(result.agent)})`
  if (typeof result.status !== 'string' || !result.status) return 'its result has no status'
  const artifacts = (result.artifacts ?? {}) as { result?: unknown; brief?: unknown }
  if (typeof artifacts.result !== 'string' || !samePath(artifacts.result, want.resultPath)) return 'its result names another result file'
  if (typeof artifacts.brief !== 'string' || !samePath(artifacts.brief, want.briefPath)) return 'its result names another brief'
  let brief = ''
  try {
    brief = await $.fs.read(want.briefPath)
  } catch {
    return 'the brief beside its result could not be read'
  }
  if (!brief.includes(want.token)) return 'its result belongs to another run (the brief beside it is not this one)'
  return undefined
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
  // Codex's delegation is run by the hub itself, under its write profile, not by the relay
  if (p?.kind === 'codex') return { isOk: true, detail: 'run by the hub under its write profile' }
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
  /** in a workspace copy: the hub compares the copy itself, so the relay's run lists no files */
  opts: { inCopy?: boolean } = {},
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
    '\n\nRules from the orchestrator: do not commit, do not push, keep changes inside this repository, and report what you changed. ' +
    `${LOCK_NOTE}\n`
  // the refs as they are before anything runs, read by the hub's own git
  const before = await snapshot($, repo)
  if (before.failed) {
    return {
      isOk: false,
      status: 'git-unchecked',
      text: `Refused: ${repo} looks like a git repository, but its refs could not be read (${before.failed}), so the delegation could not be checked. Nothing ran.`,
    }
  }

  // the working tree as it is before, so the files the run changed are the hub's own list
  const workBefore = before.isRepo ? await workState($, repo) : undefined

  const token = runToken()
  await $.fs.write(briefPath, `${brief}${guard}\nRun: ${token}\n`)
  // the hub names the relay's artifact folder itself, so it reads the result from
  // where it expects it, never from a path the run reports; it is under ~/.claude,
  // not the temp folder, which Codex's workspace-write sandbox may write
  const outDir = joinPath(os, await homeDir($), '.claude', 'jervis-ai-hub', 'relay', `run-${stamp}-${token}`)
  const resultPath = joinPath(os, outDir, 'result.json')

  // The relay finds the CLI on PATH; a stale shim there must not shadow the working build.
  const cli = await exe($, p.kind)
  const pathVar = (await $.env.get('PATH')) ?? (await $.env.get('Path')) ?? ''
  const sep = pathSep(os)
  const env = {
    ...(cli ? { PATH: `${dirOf(cli)}${sep}${pathVar}`, ...(os === 'windows' ? { Path: `${dirOf(cli)}${sep}${pathVar}` } : {}) } : {}),
    // every git the relay and its agent start refuses ref changes and pushes
    ...(before.isRepo ? await guardEnv($, os) : {}),
    // the repository, not a PWD inherited from the shell Claude started in (OpenCode reads PWD first)
    PWD: repo,
  }
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
      argv: [node, script, '--brief', briefPath, '--cd', repo, '--out-dir', outDir, '--mode', 'workspace-write', ...(model ? ['--model', model] : [])],
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
  let result: Record<string, unknown> | undefined
  const isMissing = !(await $.fs.exists(resultPath).catch(() => false))
  if (!isMissing) {
    try {
      result = JSON.parse(await $.fs.read(resultPath)) as Record<string, unknown>
    } catch {
      // not JSON: reported below
    }
  }
  const problem = await resultProblem($, result, {
    agent: p.relaySkill.replace(/-delegate$/, ''),
    resultPath,
    briefPath: joinPath(os, outDir, 'brief.txt'),
    token,
    isMissing,
  })
  if (problem) result = undefined
  const git = (result?.git ?? {}) as { commitViolation?: unknown }
  const final = typeof result?.finalMessage === 'string' ? redactKeys(result.finalMessage) : ''

  // the hub's own check, whatever the relay reports: did any ref change?
  const after = await snapshot($, repo)
  const changed = refChanges(before, after)
  if (git.commitViolation === true && !changed.length) changed.push('the relay reports that HEAD changed')
  // the files changed, read by the hub's own git: the relay's own list is never used
  const workAfter = before.isRepo ? await workState($, repo) : undefined
  const touched = workBefore && workAfter ? changedFiles(workBefore, workAfter) : undefined
  const files = opts.inCopy ? '' : `\n${filesLine(workBefore, workAfter)}`
  if (changed.length) {
    const why = `git refs changed during the delegation: ${changed.join('; ')}`
    await finish($, actId, { state: 'error', ms, touchedFiles: touched, resultPreview: final, error: why })
    return {
      isOk: false,
      status: 'git-changed',
      touchedFiles: touched,
      resultPath,
      text: [
        `${p.label} relay ran for ${Math.round(ms / 1000)}s, but git refs changed, which a delegation must never do.`,
        ...refusal(before, after, changed),
        files.trim(),
      ].join('\n'),
    }
  }

  // no result that is provably this run's: never success, whatever the exit code
  if (problem) {
    const why = `the relay exited with ${code ?? 'no code'}, but ${problem}`
    await finish($, actId, { state: 'error', ms, touchedFiles: touched, error: why })
    return {
      isOk: false,
      status: 'unknown',
      touchedFiles: touched,
      text: [
        `${p.label} relay result unknown after ${Math.round(ms / 1000)}s: ${why}.`,
        'Nothing it reported is trusted. Check the working tree yourself (git status, git diff) before you use any of it.',
        files.trim(),
      ].join('\n'),
    }
  }
  const status = result!.status as string
  // a success needs both: the relay says completed and it exited cleanly
  const isOk = status === 'completed' && code === 0
  await finish($, actId, {
    state: isOk ? 'ok' : 'error',
    ms,
    touchedFiles: touched,
    resultPreview: final,
    error: isOk ? undefined : redact(clean(stderr).slice(-600)),
  })
  return {
    isOk,
    status,
    touchedFiles: touched,
    resultPath,
    text: `${p.label} relay ${status}${code === 0 ? '' : ` but exited with ${code ?? 'no code'}`} in ${Math.round(ms / 1000)}s.${files}\n\n${final}`.trim(),
  }
}
