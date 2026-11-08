// How deep a chain of hubs runs: every CLI the hub starts is told it runs one
// step below the hub, so a hub inside that agent (the agent's own Jervis plugin)
// knows it was started by one and sends nothing onward. No request ever loops
// back to the provider that started it, however the plugins are set up.
import type { EngineInterface } from 'claude-code'

/** The variable every CLI the hub starts gets: how many hubs are above it. */
export const DEPTH_VAR = 'JERVIS_HUB_DEPTH'
/** The run (activity id) that started it, for the activity log of the hub below. */
export const PARENT_VAR = 'JERVIS_HUB_PARENT'
/** How many hubs may be above one that still sends a request on: none. */
export const MAX_HOPS = 1

/** How many hubs are above this one: 0 when Claude was started by a person. */
export async function hopDepth($: EngineInterface): Promise<number> {
  let v: string | undefined
  try {
    v = await $.env.get('JERVIS_HUB_DEPTH')
  } catch {
    v = undefined
  }
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** depth alone: why a hub this deep sends nothing on, or undefined when it may. */
export function hopProblem(depth: number): string | undefined {
  return depth >= MAX_HOPS
    ? `Jervis AI Hub is running inside an agent another Jervis AI Hub started (${DEPTH_VAR}=${depth}), so it sends nothing on: a request from here could loop back to the AI that started it. Nothing was sent.`
    : undefined
}

/** Why this hub sends nothing on, or undefined when it may. */
export async function hopRefusal($: EngineInterface): Promise<string | undefined> {
  return hopProblem(await hopDepth($))
}

/** The variables a CLI the hub starts gets, so a hub inside it knows its place. */
export async function hopEnv($: EngineInterface, parent: string): Promise<Record<string, string>> {
  return { [DEPTH_VAR]: String((await hopDepth($)) + 1), [PARENT_VAR]: parent }
}

/** The host the hub runs inside, as the host's plugin set it: its own provider is never sent requests from here. */
const HOST_PROVIDER: Record<string, string> = { codex: 'chatgpt', antigravity: 'antigravity' }

/** The provider that is the agent this hub runs inside, or undefined in Claude Code. */
export async function selfProvider($: EngineInterface): Promise<string | undefined> {
  let v: string | undefined
  try {
    v = await $.env.get('JERVIS_HUB_HOST')
  } catch {
    v = undefined
  }
  return v ? HOST_PROVIDER[v] : undefined
}
