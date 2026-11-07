// What the tools do, with the confirmations that
// guard project access and changes.
import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Level, Task } from '../types'
import { finish } from './activity'
import { errText, timeoutFor } from './cli'
import { delegate } from './delegation'
import { filesLine, guardEnv, LOCK_NOTE, refChanges, refusal, snapshot, workState } from './gitguard'
import { allowProjectRead, allowWrite, canonicalDir, folder, reviewChanges, unboundedRefusal } from './permissions'
import type { RefSnapshot } from './gitguard'
import { applyRun, compare as compareCopy, isThisSessions, leftOutLine, makeCopy, readRun, removeRun } from './workspace'
import { closeReview, diffExcerpt, showReview } from './review'
import type { Compared, WorkRun } from './workspace'
import { osName } from './platform'
import { provider } from './registry'
import { compare, readiness, runRequest, usageLine } from './requests'
import type { RequestResult } from './requests'
import { askWithFallback, candidates, route } from './routing'
import { smartPick } from './smart'
import { setUi, DEFAULT_SETTINGS } from './state'

// state this file reads (the scan needs each atom declared in the file that uses it)
const cwd = atom({ plugin: 'ai-subscriptions', key: 'cwd' } as const, '', { shape: 'cwd-1' })
const settings = atom({ plugin: 'ai-subscriptions', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'st-1' })
const config = atom({ plugin: 'ai-subscriptions', key: 'config' } as const, {}, { shape: 'cfg-3' })

export const header = (r: RequestResult): string =>
  `[${r.provider}${r.model ? ` · ${r.model}` : ''}${r.effort ? ` · ${r.effort}` : ''}${r.ms ? ` · ${(r.ms / 1000).toFixed(1)}s` : ''}]`

export type ToolAnswer = { isOk: boolean; text: string }

/** ask_ai: one provider (named, or routed by task), read-only unless write was asked and confirmed. */
export async function askTool(
  $: EngineInterface,
  a: { provider?: string; task?: Task; level?: Level; prompt: string; mode: 'read' | 'write'; model?: string; effort?: string; cwd?: string; preview?: boolean },
): Promise<ToolAnswer> {
  let providerId = a.provider
  let model = a.model
  let effort = a.effort
  let why = ''
  if (!providerId) {
    const r = await route($, a.task ?? 'general', undefined, a.level, Boolean(a.task))
    if (!r.route) return { isOk: false, text: `No provider to route to: ${r.reason}. Connect one in Jervis AI Hub.` }
    providerId = r.route.provider
    model ??= r.route.model
    effort ??= r.route.effort
    why = r.reason
  } else if (!model && ((a.task && a.task !== 'general') || a.level) && (await read($, settings)).smartRouting !== false) {
    // a named provider and a task or level: the best of that provider's models for it
    const pick = await smartPick($, a.task ?? 'general', { only: providerId, level: a.level })
    if ('route' in pick) {
      model = pick.route.model
      effort ??= pick.route.effort
      why = pick.reason
    }
  }
  const p = provider(providerId)
  if (!p) return { isOk: false, text: `Unknown provider "${providerId}".` }

  if (a.preview) return { isOk: true, text: await preview($, { ...a, providerId, model, effort, why }) }

  if (a.mode === 'write') {
    const named = a.cwd ?? (await read($, cwd))
    if (!named) return { isOk: false, text: 'Write mode needs a project folder (cwd).' }
    const unbounded = await unboundedRefusal($, providerId)
    if (unbounded) return { isOk: false, text: `Refused: ${unbounded}` }
    return writeRun($, { providerId, model, effort, prompt: a.prompt, named, task: a.task, type: 'ask', how: 'ask_ai write mode' })
  }

  const f = a.cwd ? await folder($, a.cwd) : undefined
  if (f?.error !== undefined) return { isOk: false, text: `Refused: ${f.error}` }
  if (f && !(await allowProjectRead($, providerId, f.real, f.shown))) {
    return { isOk: false, text: 'The person declined project access: nothing was sent.' }
  }
  const r = await askWithFallback($, { provider: providerId, model, effort }, a.prompt, a.task, f?.real, a.level)
  const via = `${why ? `\n(${why})` : ''}${r.tried.length > 1 ? `\n(fell back after: ${r.tried.slice(0, -1).join(', ')})` : ''}${r.declined ? `\n(the person declined to let ${provider(r.declined)?.label ?? r.declined} read the project, so nothing was sent to it)` : ''}`
  return {
    isOk: r.isOk,
    text: `${header(r)}\n${r.text}${usageLine(r.usage) ? `\n\n(${usageLine(r.usage)})` : ''}${via}`,
  }
}

/**
 * What a request would do, worked out from what the hub already knows: no
 * process runs, nothing is sent and nobody is asked anything.
 */
async function preview(
  $: EngineInterface,
  a: { providerId: string; model?: string; effort?: string; why: string; prompt: string; mode: 'read' | 'write'; cwd?: string; task?: Task; level?: Level },
): Promise<string> {
  const p = provider(a.providerId)
  const c = (await read($, config))[a.providerId]
  const s = await read($, settings)
  const model = a.model ?? c?.model
  const effort = a.effort ?? (model === c?.model ? c?.effort : undefined)
  const blocked = await readiness($, a.providerId)
  const dir = a.mode === 'write' ? (a.cwd ?? (await read($, cwd))) : a.cwd
  const where =
    a.mode === 'write'
      ? dir
        ? `changes files in ${dir} (you are asked first; nothing is committed)`
        : 'needs a project folder (cwd)'
      : dir
        ? `reads ${dir} (you are asked first${s.confirmProjectAccess ? '' : ', unless project-access questions are off'})`
        : 'read-only, in an empty folder: only the prompt is sent'
  const fallback =
    a.mode === 'write' || !s.fallback
      ? 'none'
      : `up to ${s.maxFallbacks} other provider${s.maxFallbacks === 1 ? '' : 's'} if this one fails${dir ? ', each asked separately for the project' : ''}`
  return [
    'Preview: nothing was sent.',
    `Provider: ${p?.label ?? a.providerId}${blocked ? ` (not ready: ${blocked})` : ''}`,
    `Model: ${model ?? 'the CLI’s default'}${effort ? ` · effort ${effort}` : ''}`,
    ...(a.why ? [`Why: ${a.why}`] : []),
    ...(a.task ? [`Task: ${a.task}`] : []),
    ...(a.level ? [`Level: ${a.level}`] : []),
    `Access: ${where}`,
    `Fallback: ${fallback}`,
    `Stops after: ${Math.round(timeoutFor('ask', a.mode) / 60_000)} minutes`,
    `Prompt: ${a.prompt.length} characters`,
  ].join('\n')
}

export async function compareTool($: EngineInterface, prompt: string, providers?: string[], task?: Task, level?: Level): Promise<ToolAnswer> {
  const named = Boolean(providers?.length)
  const ids = named ? [...new Set(providers)] : await candidates($)
  const isSmart = (await read($, settings)).smartRouting !== false
  const targets: { providerId: string; model?: string; effort?: string }[] = []
  for (const id of ids) {
    if (targets.length >= (named ? 5 : 4)) break
    if (!isSmart) {
      targets.push({ providerId: id })
      continue
    }
    // each provider answers with its best model for the task
    const pick = await smartPick($, task ?? 'general', { only: id, level })
    if ('route' in pick) targets.push({ providerId: id, model: pick.route.model, effort: pick.route.effort })
    else if (named) targets.push({ providerId: id })
  }
  if (targets.length < 2) return { isOk: false, text: 'Comparing needs at least two ready providers.' }
  const results = await compare($, targets, prompt, task)
  const text = results
    .map(r => `## ${header(r)}${r.isOk ? '' : ' (failed)'}\n${r.text}${usageLine(r.usage) ? `\n_${usageLine(r.usage)}_` : ''}`)
    .join('\n\n')
  return { isOk: results.some(r => r.isOk), text }
}

/**
 * A write the hub runs itself (an ask_ai write, a Codex delegation): the folder
 * resolved once and approved, refs locked by the git guard and read before and
 * after, and the changed files listed by the hub's own git. Codex runs under
 * the hub's write profile here, so its reads are held to the folder too.
 */
async function writeRun(
  $: EngineInterface,
  a: { providerId: string; model?: string; effort?: string; prompt: string; named: string; task?: Task; type: 'ask' | 'delegate'; how: string },
): Promise<ToolAnswer> {
  const { providerId, model, effort } = a
  // resolved once: the folder approved is the folder written
  const f = await folder($, a.named)
  if (f.error !== undefined) return { isOk: false, text: `Refused: ${f.error}` }
  const dir = f.real
  // refs locked while it writes, and read before and after
  const before = await snapshot($, dir)
  if (before.failed) {
    return { isOk: false, text: `Refused: ${dir} looks like a git repository, but its refs could not be read (${before.failed}), so the write could not be checked. Nothing was sent.` }
  }
  const direct = (await read($, settings)).writeDirect === true
  if (!(await allowWrite($, providerId, dir, a.how, f.shown, !direct))) {
    return { isOk: false, text: a.type === 'delegate' ? 'The person declined: nothing was delegated.' : 'The person declined: no files were changed.' }
  }
  const env = before.isRepo ? await guardEnv($, await osName($)) : undefined
  if (!direct) {
    const rules = a.type === 'delegate' ? ' Rules from the orchestrator: do not commit, do not push, keep changes inside this folder, and report what you changed.' : ''
    return inCopy($, { providerId, dir, shown: f.shown, before }, async (tree, note) => {
      const r = await runRequest($, { providerId, model, effort, prompt: `${a.prompt}\n\n${note}${rules}`, mode: 'write', cwd: tree, type: a.type, task: a.task, env })
      return { isOk: r.isOk, text: `${header(r)}\n${r.text}${usageLine(r.usage) ? `\n\n(${usageLine(r.usage)})` : ''}`, activityId: r.activityId }
    })
  }
  const workBefore = before.isRepo ? await workState($, dir) : undefined
  const rules =
    a.type === 'delegate'
      ? `Rules from the orchestrator: do not commit, do not push, keep changes inside this folder, and report what you changed.${before.isRepo ? ` ${LOCK_NOTE}` : ''}`
      : before.isRepo
        ? `Rules from the orchestrator: do not commit or push. ${LOCK_NOTE}`
        : ''
  const prompt = rules ? `${a.prompt}\n\n${rules}` : a.prompt
  const r = await runRequest($, { providerId, model, effort, prompt, mode: 'write', cwd: dir, type: a.type, task: a.task, env })
  if (before.isRepo) {
    const after = await snapshot($, dir)
    const changed = refChanges(before, after)
    if (changed.length) {
      const why = after.failed ? 'the git refs could not be checked after the write' : 'git refs changed during the write, which it must never do'
      // the run's own row reads as failed too, so the activity log and its counts agree
      if (r.activityId) await finish($, r.activityId, { state: 'error', error: `refused: ${changed.join('; ')}` })
      return { isOk: false, text: [`${header(r)}\nRefused: ${why}.`, ...refusal(before, after, changed)].join('\n') }
    }
  }
  // the files changed, as the hub's own git reads them
  const files = filesLine(workBefore, before.isRepo ? await workState($, dir) : undefined)
  return { isOk: r.isOk, text: `${header(r)}\n${r.text}\n\n${files}${usageLine(r.usage) ? `\n\n(${usageLine(r.usage)})` : ''}` }
}

const COPY_NOTE =
  'You are working in a copy of the project folder. The person sees your changes and decides whether they are applied; nothing you do reaches the real folder before that. There is no .git here.'

/**
 * Runs `work` in a copy of `dir`, then puts the copy's changes to the person:
 * Apply (only onto files still as they were when copied), Keep for later, or
 * Discard. The person's own folder is written only by an Apply.
 */
async function inCopy(
  $: EngineInterface,
  a: { providerId: string; dir: string; shown: string; before: RefSnapshot },
  work: (tree: string, note: string) => Promise<{ isOk: boolean; text: string; activityId?: string }>,
): Promise<ToolAnswer> {
  let run: WorkRun
  try {
    run = await makeCopy($, { folder: a.dir, shown: a.shown, provider: a.providerId })
  } catch (error) {
    return {
      isOk: false,
      text: `Refused: the hub could not make a copy of ${a.shown} to work in (${errText(error)}). Nothing was sent. To write into the folder itself, turn on "Write straight into the folder" in Jervis AI Hub → Settings → Privacy.`,
    }
  }
  const left = run.leftOut.length ? `\n${leftOutLine(run.leftOut)}` : ''
  let done: { isOk: boolean; text: string; activityId?: string }
  try {
    done = await work(run.tree, COPY_NOTE)
  } catch (error) {
    await removeRun($, run.root)
    throw error
  }
  // the folder's own refs, in case anything reached them
  if (a.before.isRepo) {
    const after = await snapshot($, a.dir)
    const changed = refChanges(a.before, after)
    if (changed.length) {
      await removeRun($, run.root)
      const why = after.failed ? 'the git refs could not be checked after the run' : 'git refs changed during the run, which it must never do'
      if (done.activityId) await finish($, done.activityId, { state: 'error', error: `refused: ${changed.join('; ')}` })
      return { isOk: false, text: [`${done.text}\nRefused: ${why}. The copy's changes were discarded.`, ...refusal(a.before, after, changed)].join('\n') }
    }
  }
  let c: Compared
  try {
    c = await compareCopy($, run)
  } catch (error) {
    await removeRun($, run.root)
    return { isOk: false, text: `${done.text}\n\nThe hub could not read the copy's changes (${errText(error)}), so nothing was applied.${left}` }
  }
  if (!c.changes.length) {
    await removeRun($, run.root)
    return { isOk: done.isOk, text: `${done.text}\n\nNo files changed in the copy, so nothing was applied.${left}` }
  }
  const outcome = await decide($, run, c)
  return { isOk: done.isOk && outcome.isOk, text: `${done.text}\n\n${outcome.text}${left}` }
}

function changeLines(c: Compared, max = 50): string {
  const lines = c.changes.slice(0, max).map(x => `- ${x.path}${x.status === 'A' ? ' (new)' : x.status === 'D' ? ' (deleted)' : ''}`)
  return `${lines.join('\n')}${c.changes.length > max ? `\n- and ${c.changes.length - max} more` : ''}`
}

/** One review at a time: the pane shows one run, and each answer goes to its own run. */
let reviews: Promise<unknown> = Promise.resolve()

/** Asks the person about a run's changes and does what they say, after any review before it. */
function decide($: EngineInterface, run: WorkRun, c: Compared): Promise<ToolAnswer> {
  const turn = reviews.then(() => decideNow($, run, c))
  reviews = turn.catch(() => undefined)
  return turn
}

async function decideNow($: EngineInterface, run: WorkRun, c: Compared): Promise<ToolAnswer> {
  // a review that waited may find its run already applied or discarded by the one before
  if (!(await $.fs.exists(run.git).catch(() => false))) {
    return { isOk: false, text: `Run ${run.id} was already applied or discarded while it waited; nothing more was done.` }
  }
  const label = provider(run.provider)?.label ?? run.provider
  const n = c.changes.length
  const stat = c.stat.split('\n').slice(0, 21).join('\n')
  const title = `${label} changed ${n} file${n === 1 ? '' : 's'} in a copy of ${run.shown}`
  // each file's diff in a pane beside the question; where none is drawn, a few of them in the question
  const isShown = await showReview($, run, c, title)
  const diffs = isShown ? "Each file's diff is in the Review changes pane." : diffExcerpt(c)
  let answer: Awaited<ReturnType<typeof reviewChanges>>
  try {
    answer = await reviewChanges(
      $,
      `${title}:\n${stat}\n${diffs ? `${diffs}\n` : ''}The whole patch: ${c.patchPath}\nApply these changes to ${run.shown}? Nothing is staged or committed.`,
    )
  } finally {
    await closeReview($)
  }
  const later = `apply_changes with run "${run.id}" asks again; kept runs are removed after 7 days.`
  if (answer === 'discard') {
    await removeRun($, run.root)
    return { isOk: true, text: `The person discarded the changes: nothing was applied.\n${changeLines(c)}` }
  }
  if (answer === 'keep') return { isOk: true, text: `Kept for later, not applied (run ${run.id}). ${later}\n${changeLines(c)}` }
  const r = await applyRun($, run, c)
  if (!r.isOk) {
    const files = r.files?.length ? `:\n${r.files.map(p => `- ${p}`).join('\n')}` : '.'
    return { isOk: false, text: `${r.isMixed ? 'Partly applied' : 'Not applied'}: ${r.why}${files}\nThe changes are kept (run ${run.id}). ${later}` }
  }
  await removeRun($, run.root)
  const unchecked = r.unchecked ? `\nThe hub could not check the files after applying (${r.unchecked}).` : ''
  return { isOk: true, text: `Applied to ${run.shown}, not staged or committed (review before committing):\n${changeLines(c)}${unchecked}` }
}

/** apply_changes: a kept run's changes put to the person again. */
export async function applyChangesTool($: EngineInterface, id: string): Promise<ToolAnswer> {
  const run = await readRun($, id)
  if (!run) return { isOk: false, text: `No kept changes with run id "${id}" (they may have been applied, discarded, or removed after 7 days).` }
  // a run another session made applies only to this session's folder (or one inside it)
  if (!isThisSessions(id)) {
    const here = await read($, cwd)
    const f = here ? await folder($, here) : undefined
    const os = await osName($)
    const sep = os === 'windows' ? '\\' : '/'
    const mine = f && f.error === undefined ? canonicalDir(os, f.real) : undefined
    const its = canonicalDir(os, run.folder)
    if (!mine || (its !== mine && !its.startsWith(mine.endsWith(sep) ? mine : mine + sep))) {
      return { isOk: false, text: `Run ${id} was made for ${run.folder}, which is not this session's folder${here ? ` (${here})` : ''}. Open a session in ${run.folder} to apply it. Nothing was applied.` }
    }
  }
  let c: Compared
  try {
    c = await compareCopy($, run)
  } catch (error) {
    return { isOk: false, text: `The hub could not read the kept changes (${errText(error)}).` }
  }
  if (!c.changes.length) {
    await removeRun($, run.root)
    return { isOk: true, text: 'That run changed no files; nothing to apply.' }
  }
  return decide($, run, c)
}

export async function delegateTool($: EngineInterface, providerId: string, brief: string, repo?: string): Promise<ToolAnswer> {
  const named = repo ?? (await read($, cwd))
  if (!named) return { isOk: false, text: 'Delegation needs a repository folder.' }
  const unbounded = await unboundedRefusal($, providerId)
  if (unbounded) return { isOk: false, text: `Refused: ${unbounded}` }
  // Codex: the hub runs it itself under its write profile, which the relay cannot pass
  if (provider(providerId)?.kind === 'codex') {
    return writeRun($, { providerId, prompt: brief, named, type: 'delegate', how: 'delegation (run by the hub under its write profile)' })
  }
  const f = await folder($, named)
  if (f.error !== undefined) return { isOk: false, text: `Refused: ${f.error}` }
  const direct = (await read($, settings)).writeDirect === true
  if (!(await allowWrite($, providerId, f.real, 'Jervis Relay delegation', f.shown, !direct))) return { isOk: false, text: 'The person declined: nothing was delegated.' }
  try {
    if (!direct) {
      const before = await snapshot($, f.real)
      if (before.failed) {
        return { isOk: false, text: `Refused: ${f.real} looks like a git repository, but its refs could not be read (${before.failed}), so the delegation could not be checked. Nothing ran.` }
      }
      return await inCopy($, { providerId, dir: f.real, shown: f.shown, before }, async (tree, note) => {
        const r = await delegate($, providerId, `${brief}\n\n${note}`, tree, { inCopy: true })
        return { isOk: r.isOk, text: r.text }
      })
    }
    const r = await delegate($, providerId, brief, f.real)
    return { isOk: r.isOk, text: r.text }
  } catch (error) {
    return { isOk: false, text: `Delegation failed: ${errText(error)}` }
  }
}
