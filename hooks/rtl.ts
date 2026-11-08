// Right to left for the pane in Arabic. A Text's `dir` orders its letters, but
// the desktop still lays the pane out from the left, so the layout is turned
// here, on the Boxes: a row runs from the right, and a line of text or a button
// standing alone in a column sits at the right edge. In a surface that is not
// the terminal, Arabic text is also put in a right-to-left isolate, so a line
// that mixes in Latin words or numbers reads from the right.

import type { Elements } from 'claude-code'

type Els = Elements[keyof Elements]

const RLI = '⁧'
const PDI = '⁩'

/** Arabic text as a right-to-left run, whatever the line around it reads as. */
export function isolate(s: string): string {
  return s.startsWith(RLI) ? s : `${RLI}${s}${PDI}`
}

/** The text without the marks `isolate` added. */
export function plain(s: string): string {
  return s.replace(/[⁧⁩]/g, '')
}

function flat(kids: unknown[]): unknown[] {
  const out: unknown[] = []
  for (const k of kids) {
    if (Array.isArray(k)) out.push(...flat(k))
    else if (k !== null && k !== undefined && k !== false && k !== true) out.push(k)
  }
  return out
}

// what stands alone in a column and is drawn flush to its start edge
function isLine(k: unknown): boolean {
  const type = typeof k === 'object' && k !== null ? (k as { type?: unknown }).type : undefined
  return type === 'Text' || type === 'Button'
}

/**
 * The surface's Box, mirrored: `row` runs right to left (and `row-reverse`
 * left to right), and in a column each Text or Button child is held in a row
 * that starts at the right. A Box with no direction is a row.
 */
export function mirroredBox(BaseBox: Els['Box']): Els['Box'] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((props: any) => {
    const { children, ...rest } = props ?? {}
    const kids = flat(children === undefined ? [] : Array.isArray(children) ? children : [children])
    const d = rest.flexDirection
    if (d === 'column' || d === 'column-reverse') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lines = kids.map(k => (isLine(k) ? h(BaseBox as any, { flexDirection: 'row-reverse' }, k) : k))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return h(BaseBox as any, rest, ...lines)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return h(BaseBox as any, { ...rest, flexDirection: d === 'row-reverse' ? 'row' : 'row-reverse' }, ...kids)
  }) as typeof BaseBox
}
