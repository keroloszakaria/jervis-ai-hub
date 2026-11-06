// Levels: which kind of work a model suits, light, standard or heavy, worked
// out only from what its source reports (reasoning, effort levels). Nothing
// here ranks quality. A model with effort levels spans several levels, picked
// by its effort; the person can set any model's level by hand.
import type { Level, ModelInfo } from '../types'
import { EFFORT_ORDER } from './models'

export const LEVELS: readonly Level[] = ['light', 'standard', 'heavy']

export const LEVEL_LABEL: Record<Level, string> = { light: 'Light', standard: 'Standard', heavy: 'Heavy' }

/** What each level is for, as Claude reads it in the tool and in the system prompt. */
export const LEVEL_USE: Record<Level, string> = {
  light: 'search, lookups, summaries, renames, boilerplate',
  standard: 'everyday code changes and explanations',
  heavy: 'hard bugs, architecture, security and careful reviews',
}

const LIGHT_EFFORTS = ['none', 'minimal', 'low']
const HEAVY_EFFORTS = ['high', 'xhigh', 'max', 'ultra']

export type Rating = {
  /** the levels the model can serve; empty when its source reports nothing to go by */
  levels: Level[]
  /** the reported facts behind it, or "your choice" */
  why: string
  isSet: boolean
}

/** The levels a model serves: the person's choice, else what its source reports. */
export function rate(m: ModelInfo, set?: Level): Rating {
  if (set) return { levels: [set], why: 'your choice', isSet: true }
  const efforts = m.efforts ?? []
  if (efforts.length) {
    const levels: Level[] = []
    if (efforts.some(e => LIGHT_EFFORTS.includes(e))) levels.push('light')
    if (efforts.includes('medium') || (m.defaultEffort && !LIGHT_EFFORTS.includes(m.defaultEffort) && !HEAVY_EFFORTS.includes(m.defaultEffort))) {
      levels.push('standard')
    }
    if (efforts.some(e => HEAVY_EFFORTS.includes(e))) levels.push('heavy')
    const sorted = [...efforts].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
    return { levels, why: `effort ${sorted[0]}${sorted.length > 1 ? ` to ${sorted[sorted.length - 1]}` : ''}`, isSet: false }
  }
  if (m.reasoning === true) return { levels: ['standard', 'heavy'], why: 'reasoning', isSet: false }
  if (m.reasoning === false) return { levels: ['light', 'standard'], why: 'no reasoning', isSet: false }
  return { levels: [], why: 'its source reports no reasoning or effort', isSet: false }
}

/** "LIGHT", "LIGHT–HEAVY", or "UNRATED". */
export function levelTag(r: Rating): string {
  if (!r.levels.length) return 'Unrated'
  const first = r.levels[0]!
  const last = r.levels[r.levels.length - 1]!
  return first === last ? LEVEL_LABEL[first] : `${LEVEL_LABEL[first]}–${LEVEL_LABEL[last]}`
}

/** The effort that fits a level, from the ones the model lists; none where it lists none. */
export function effortForLevel(m: ModelInfo, level: Level): string | undefined {
  const list = [...(m.efforts ?? [])].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
  if (!list.length) return undefined
  if (level === 'light') return list.find(e => e === 'low') ?? list.find(e => LIGHT_EFFORTS.includes(e)) ?? list[0]
  if (level === 'heavy') return list.find(e => e === 'high') ? (list.includes('xhigh') ? 'xhigh' : 'high') : list[list.length - 1]
  return list.includes('medium') ? 'medium' : (m.defaultEffort ?? list[Math.floor(list.length / 2)])
}

/** The level next to this one, tried when no ready model serves it. */
export const nearLevel = (level: Level): Level => (level === 'standard' ? 'heavy' : 'standard')

export const isLevel = (v: unknown): v is Level => v === 'light' || v === 'standard' || v === 'heavy'
