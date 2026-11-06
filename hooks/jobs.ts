// Background jobs: the pieces of a big task, each at its level, run by a Claude
// subagent or by another AI the person connected. A job starts and returns at
// once; its progress shows above the prompt, and when it ends its result is
// added to the conversation for Claude to read (the person can turn that off).
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Job, Level, Route } from '../types'
import { LEVEL_LABEL } from './levels'
import { allowProjectRead } from './permissions'
import { provider } from './registry'
import { type RequestResult, runRequest, stopRequest } from './requests'
import { type SmartPick, smartPick } from './smart'
import { DEFAULT_SETTINGS } from './state'
import { subagentModels } from './subagents'

// state this file reads (the scan needs each atom declared in the file that uses it)
const settings = atom({ plugin: 'ai-subscriptions', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'st-1' })
const jobs = atom({ plugin: 'ai-subscriptions', key: 'jobs' } as const, [], { shape: 'j-1' })
const jobsAt = atom({ plugin: 'ai-subscriptions', key: 'jobsAt' } as const, 0, { shape: 'ja-1' })

/** How many jobs may run at once. */
export const MAX_RUNNING = 4

/** How much of a result goes into the conversation; the rest is a job_status call away. */
export const REPORT_CHARS = 4000

/** Full results, by job id: kept in memory for this session, never in state or the store. */
const results = new Map<string, string>()

export type StartArgs = {
  title: string
  prompt: string
  level: Level
  runner?: 'auto' | 'subagent' | 'other-ai'
  provider?: string
  cwd?: string
}

async function patch($: EngineInterface, id: string, fn: (j: Job) => Job): Promise<void> {
  await update($, jobs, list => list.map(j => (j.id === id ? fn(j) : j)))
}

/** A notice in the transcript for the person; the model never reads it. */
async function notice($: EngineInterface, text: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
  } catch {
    // the band still shows it
  }
}

const runnerLabel = (j: Job): string =>
  j.runner === 'subagent'
    ? `Claude subagent${j.model ? ` · ${j.model}` : ''}`
    : `${provider(j.provider ?? '')?.label ?? j.provider ?? 'another AI'}${j.model ? ` · ${j.model}` : ''}${j.effort ? ` · ${j.effort}` : ''}`

export const describeJob = (j: Job): string => `"${j.title}" (${LEVEL_LABEL[j.level].toLowerCase()}, ${runnerLabel(j)})`

/** Starts one job and returns at once with its id, or says why it could not start. */
export async function startJob($: EngineInterface, a: StartArgs): Promise<{ job?: Job; error?: string }> {
  const list = await read($, jobs)
  if (list.filter(j => j.state === 'running').length >= MAX_RUNNING) {
    return { error: `${MAX_RUNNING} jobs are running already; wait for one to end (job_status).` }
  }
  const s = await read($, settings)
  const at = await $.clock.now()
  const id = `job-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const base: Job = { id, title: a.title, level: a.level, runner: 'other-ai', state: 'running', startedAt: at }

  // where it runs: the runner asked for; on auto, another AI that serves the level, else a subagent
  const pick = a.runner === 'subagent' ? undefined : await smartPick($, 'general', { only: a.provider, level: a.level })
  if (pick && !('route' in pick) && (a.runner === 'other-ai' || a.provider)) return { error: `No AI to run it: ${pick.reason}.` }
  const r: Route | undefined = pick && 'route' in pick ? (pick as SmartPick).route : undefined

  if (r) {
    if (a.cwd && !(await allowProjectRead($, r.provider, a.cwd))) {
      return { error: `The person declined to let ${provider(r.provider)?.label ?? r.provider} read the project: the job was not started.` }
    }
    const job: Job = { ...base, runner: 'other-ai', provider: r.provider, model: r.model, effort: r.effort }
    await update($, jobs, l => [...l, job])
    void runRequest($, {
      providerId: r.provider,
      model: r.model,
      effort: r.effort,
      prompt: a.prompt,
      mode: 'read',
      cwd: a.cwd,
      type: 'ask',
      onStart: activityId => void patch($, id, j => ({ ...j, activityId })),
    })
      .then(
        res => endFromRequest($, id, res),
        error => endJob($, id, 'failed', String(error instanceof Error ? error.message : error)),
      )
      // a session that ended mid-job has nothing left to report to
      .catch(() => undefined)
    await afterStart($, job)
    return { job }
  }

  // a Claude subagent on the model the person set for this level
  const model = subagentModels(s).byLevel?.[a.level]
  const job: Job = { ...base, runner: 'subagent', model }
  await update($, jobs, l => [...l, job])
  const spawned = await $.agent.spawn({
    prompt: a.cwd ? `${a.prompt}\n\nWork in this folder: ${a.cwd}` : a.prompt,
    description: a.title.slice(0, 60),
    subagentType: 'general-purpose',
    ...(model ? { model } : {}),
  })
  if (spawned.deny !== undefined) {
    await endJob($, id, 'failed', `the subagent was not started: ${spawned.deny}`, { quiet: true })
    return { error: `The subagent was not started: ${spawned.deny}` }
  }
  if (!spawned.agentId) {
    // core names every subagent it starts; without a name its end cannot be followed
    await endJob($, id, 'failed', 'Claude Code did not say which subagent it started, so the hub cannot follow it; its answer shows in the transcript.', { quiet: true })
    return { error: 'The subagent started, but Claude Code gave no id to follow it by; its answer will show in the transcript.' }
  }
  await patch($, id, j => ({ ...j, agentId: spawned.agentId, model: spawned.model || j.model }))
  const started = (await read($, jobs)).find(j => j.id === id) ?? job
  await afterStart($, started)
  return { job: started }
}

async function afterStart($: EngineInterface, job: Job): Promise<void> {
  await notice($, `Jervis AI Hub: started ${describeJob(job)}.`)
  tick($)
}

async function endFromRequest($: EngineInterface, id: string, r: RequestResult): Promise<void> {
  const tokens = r.usage?.inputTokens !== undefined || r.usage?.outputTokens !== undefined
    ? { input: r.usage?.inputTokens ?? 0, output: r.usage?.outputTokens ?? 0 }
    : undefined
  await endJob($, id, r.isOk ? 'done' : r.errorKind === 'cancelled' ? 'stopped' : 'failed', r.text, { tokens, model: r.model })
}

/** A subagent's turn ended: if it was a job's, that job ends with its answer. */
export async function onAgentTurn(
  $: EngineInterface,
  e: { agentId?: string; answer: string; reason: string; usage?: { input_tokens: number; output_tokens: number; model: string } },
): Promise<void> {
  if (!e.agentId) return
  const job = (await read($, jobs)).find(j => j.agentId === e.agentId && j.state === 'running')
  if (!job) return
  const state = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
  const tokens = e.usage ? { input: e.usage.input_tokens, output: e.usage.output_tokens } : undefined
  await endJob($, job.id, state, e.answer || (state === 'done' ? '(no answer)' : `the subagent ended: ${e.reason}`), { tokens, model: e.usage?.model })
}

async function endJob(
  $: EngineInterface,
  id: string,
  state: Job['state'],
  text: string,
  extra: { tokens?: Job['tokens']; model?: string; quiet?: boolean } = {},
): Promise<void> {
  const at = await $.clock.now()
  results.set(id, text)
  const summary = text.replace(/\s+/g, ' ').trim().slice(0, 240)
  await patch($, id, j => ({ ...j, state, endedAt: at, summary, tokens: extra.tokens ?? j.tokens, model: extra.model ?? j.model }))
  if (extra.quiet) return
  const job = (await read($, jobs)).find(j => j.id === id)
  if (!job) return
  const took = duration(at - job.startedAt)
  const word = state === 'done' ? 'finished' : state === 'stopped' ? 'was stopped' : 'failed'
  $.ui.toast(`Jervis AI Hub: job "${job.title}" ${word} after ${took}.`)
  await notice($, `Jervis AI Hub: ${describeJob(job)} ${word} after ${took}.`)
  if ((await read($, settings)).jobReports === false) return
  const cut = text.length > REPORT_CHARS
  const report = [
    `[Jervis AI Hub] Background job ${describeJob(job)} ${word} after ${took}.`,
    `Result${cut ? ` (first ${REPORT_CHARS} characters; job_status with id "${id}" gives the rest)` : ''}:`,
    cut ? text.slice(0, REPORT_CHARS) : text,
  ].join('\n')
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: report }] } })
  } catch {
    // the result stays a job_status call away
  }
}

/** Stops a job: another AI's run is ended; a subagent cannot be stopped from a mod. */
export async function stopJob($: EngineInterface, id: string): Promise<boolean> {
  const job = (await read($, jobs)).find(j => j.id === id)
  if (!job || job.state !== 'running' || job.runner !== 'other-ai' || !job.activityId) return false
  return stopRequest(job.activityId)
}

/** Hides the ended jobs from the band; their results stay readable. */
export async function clearEnded($: EngineInterface): Promise<void> {
  await update($, jobs, l => l.map(j => (j.state === 'running' ? j : { ...j, isCleared: true })))
}

export async function allJobs($: EngineInterface): Promise<Job[]> {
  return read($, jobs)
}

/** job_status: every job in one line each, or one job's whole result. */
export async function jobStatus($: EngineInterface, id?: string): Promise<string> {
  const list = await read($, jobs)
  const now = await $.clock.now()
  if (id) {
    const j = list.find(x => x.id === id)
    if (!j) return `No job "${id}" in this session.`
    const head = `${describeJob(j)}: ${j.state}, ${duration((j.endedAt ?? now) - j.startedAt)}`
    return j.state === 'running' ? `${head}. Still running.` : `${head}.\n${results.get(id) ?? j.summary ?? ''}`
  }
  if (!list.length) return 'No background jobs in this session.'
  return list
    .map(j => `${j.id}: ${describeJob(j)}: ${j.state}, ${duration((j.endedAt ?? now) - j.startedAt)}${j.summary && j.state !== 'running' ? ` · ${j.summary.slice(0, 120)}` : ''}`)
    .join('\n')
}

let isTicking = false

/** While a job runs, the band's clock moves once a second. */
function tick($: EngineInterface): void {
  if (isTicking) return
  isTicking = true
  void (async () => {
    try {
      for (;;) {
        await $.clock.sleep(1000)
        if (!(await read($, jobs)).some(j => j.state === 'running')) return
        const at = await $.clock.now()
        await update($, jobsAt, () => at)
      }
    } catch {
      // the band shows the time at its next redraw
    } finally {
      isTicking = false
    }
  })()
}

/** "42s", "1m 12s", "1h 3m". */
export const duration = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export async function bandClock($: EngineInterface): Promise<number> {
  return read($, jobsAt)
}
