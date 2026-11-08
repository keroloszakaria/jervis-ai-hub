// What the hub's modules take from 'claude-code' at run time (atom, read,
// update), for hosts other than Claude Code. The bundle for the MCP server maps
// the 'claude-code' import here; Claude Code itself never loads this file.
// Values live in the host's own state map, one per process (a session's state).

export type Atom<T> = { ref: { plugin: string; key: string }; initial: T }

type WithState = { __state: Map<string, unknown> }

export function atom<T>(ref: { plugin: string; key: string }, initial: T, _opts?: unknown): Atom<T> {
  return { ref, initial }
}

const keyOf = (a: Atom<unknown>): string => `${a.ref.plugin}:${a.ref.key}`

export function read<T>($: unknown, a: Atom<T>): Promise<T> {
  const m = ($ as WithState).__state
  return Promise.resolve((m.has(keyOf(a)) ? m.get(keyOf(a)) : a.initial) as T)
}

export function update<T>($: unknown, a: Atom<T>, fn: (v: T) => T): Promise<void> {
  const m = ($ as WithState).__state
  const was = (m.has(keyOf(a)) ? m.get(keyOf(a)) : a.initial) as T
  m.set(keyOf(a), fn(was))
  return Promise.resolve()
}
