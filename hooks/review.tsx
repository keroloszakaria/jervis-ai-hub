// The review of a run's changes: a pane beside the question (Apply, Keep for
// later, Discard) with each file the run changed and its diff. It only shows:
// the answer is the question's, and the pane closes once it is given.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Elements } from 'claude-code'

import type { Review } from '../types'
import { hasArabic, tr } from './i18n'
import { isolate, mirroredBox } from './rtl'
import { DEFAULT_SETTINGS } from './state'
import type { Compared, WorkRun } from './workspace'

export const REVIEW_PANE = 'ai-subscriptions-review'
const EMPTY: Review = { runId: '', title: '', files: [], open: [] }

// state this file reads (the scan needs each atom declared in the file that uses it)
const review = atom({ plugin: 'ai-subscriptions', key: 'review' } as const, EMPTY, { shape: 'rv-1' })
const settings = atom({ plugin: 'ai-subscriptions', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'st-1' })

const BG = '#0A0A0A'
const NEON = '#FF6A00'
const SURFACE = '#141414'
const HAIRLINE = 'rgba(255,255,255,0.10)'

const STATUS: Record<string, { tag: string; color: string }> = {
  A: { tag: 'new', color: 'success' },
  M: { tag: 'changed', color: NEON },
  D: { tag: 'deleted', color: 'error' },
  T: { tag: 'type changed', color: 'warning' },
}

/**
 * Opens the review for a run's changes. Resolves whether a surface draws it
 * now: when none does, the question carries what it can of the diffs itself.
 */
export async function showReview($: EngineInterface, run: WorkRun, c: Compared, title: string): Promise<boolean> {
  const first = c.files.find(f => f.text)?.path
  await update($, review, () => ({ runId: run.id, title, files: c.files, open: first ? [first] : [] }))
  try {
    const r = await $.ui.open({ id: REVIEW_PANE, title: 'Review changes', backgroundColor: BG })
    return r.isPlaced
  } catch {
    return false
  }
}

/** Closes the review once the question is answered, and forgets its diffs. */
export async function closeReview($: EngineInterface): Promise<void> {
  await $.ui.close({ id: REVIEW_PANE }).catch(() => undefined)
  await update($, review, () => EMPTY)
}

/** A few files' diffs in text, for a question no pane stands beside. */
export function diffExcerpt(c: Compared, maxFiles = 3, maxLines = 30): string {
  const parts = c.files
    .filter(f => f.text)
    .slice(0, maxFiles)
    .map(f => {
      const lines = f.text.split('\n')
      return `--- ${f.path}\n${lines.slice(0, maxLines).join('\n')}${lines.length > maxLines || f.isCut ? '\n…' : ''}`
    })
  return parts.join('\n')
}

type Els = Elements[keyof Elements]

export async function renderReview($: EngineInterface, els: Els, surface?: string) {
  const { Box: BaseBox, Text: BaseText, Button: BaseButton } = els
  const isAr = (await read($, settings)).language === 'ar'
  // in Arabic the pane is laid out from the right; the terminal orders the letters itself
  const Box = isAr ? mirroredBox(BaseBox) : BaseBox
  const bidi = isAr && surface !== 'terminal'
  const T = (s: string): string => (isAr ? tr(s) : s)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Text = ((props: any) => {
    const { children, ...rest } = props ?? {}
    const kids = (Array.isArray(children) ? children : children === undefined ? [] : [children]).map((k: unknown) => (typeof k === 'string' && !rest.mono ? T(k) : k))
    const rtl = isAr && kids.some((k: unknown) => typeof k === 'string' && hasArabic(k))
    const shown = rtl && bidi ? kids.map((k: unknown) => (typeof k === 'string' && hasArabic(k) ? isolate(k) : k)) : kids
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return h(BaseText as any, { ...rest, ...(rtl ? { dir: 'rtl' } : {}) }, ...shown)
  }) as typeof BaseText
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Button = ((props: any) => h(BaseButton as any, { ...props, label: T(props.label) })) as typeof BaseButton

  const r = await read($, review)
  if (!r.runId) {
    return (
      <Box flexDirection="column" paddingX="md" paddingY="sm">
        <Text dimColor>No changes waiting for review.</Text>
      </Box>
    )
  }
  const open = new Set(r.open)
  const toggle = (path: string) =>
    void update($, review, x => ({ ...x, open: x.open.includes(path) ? x.open.filter(p => p !== path) : [...x.open, path] }))
  const added = r.files.reduce((n, f) => n + f.added, 0)
  const deleted = r.files.reduce((n, f) => n + f.deleted, 0)
  const withText = r.files.filter(f => f.text).map(f => f.path)

  return (
    <Box flexDirection="column" paddingX="md" paddingY="sm">
      <Text size="heading" weight="bold">
        {r.title}
      </Text>
      <Box flexDirection="row" marginTop="xs">
        <Text mono color="success">{`+${added}`}</Text>
        <Text mono> </Text>
        <Text mono color="error">{`−${deleted}`}</Text>
        <Text mono dimColor>{` · ${r.files.length} file${r.files.length === 1 ? '' : 's'}`}</Text>
      </Box>
      <Text size="footnote" dimColor>
        Answer in the question: Apply, Keep for later or Discard. Nothing here changes your folder.
      </Text>
      <Box flexDirection="row" marginTop="sm">
        <Button key="all" label="Open all" variant="secondary" onPress={() => void update($, review, x => ({ ...x, open: withText }))} />
        <Button key="none" label="Close all" variant="secondary" onPress={() => void update($, review, x => ({ ...x, open: [] }))} />
      </Box>
      {r.files.map(f => {
        const st = f.isLink ? { tag: 'link, never applied', color: 'error' } : (STATUS[f.status] ?? STATUS.M!)
        const isOpen = open.has(f.path)
        const note = f.isBinary ? 'binary file: no text diff' : !f.text && f.isCut ? 'diff too large to show here: see the patch' : !f.text ? 'no text change (mode or empty file)' : ''
        return (
          <Box key={`f-${f.path}`} flexDirection="column" borderStyle="round" borderColor={HAIRLINE} backgroundColor={SURFACE} paddingX="sm" marginTop="sm">
            <Box flexDirection="row" justifyContent="space-between" alignItems="center">
              <Box flexDirection="row" flexShrink={1}>
                <Text size="caption" mono color={st.color}>
                  {`${T(st.tag)} `}
                </Text>
                <Text mono wrap="truncate-start">
                  {f.path}
                </Text>
              </Box>
              <Box flexDirection="row" flexShrink={0}>
                {f.isBinary ? null : <Text mono color="success">{`+${f.added} `}</Text>}
                {f.isBinary ? null : <Text mono color="error">{`−${f.deleted} `}</Text>}
                {f.text ? <Button key={`t-${f.path}`} plain label={isOpen ? 'Hide' : 'Show'} onPress={() => toggle(f.path)} /> : null}
              </Box>
            </Box>
            {note ? (
              <Text size="footnote" dimColor>
                {note}
              </Text>
            ) : null}
            {isOpen && f.text
              ? f.text.split('\n').map((line, i) => (
                  <Text key={`l-${i}`} mono size="footnote" color={line.startsWith('+') ? 'success' : line.startsWith('-') ? 'error' : line.startsWith('@@') ? NEON : undefined} dimColor={line.startsWith(' ')}>
                    {line || ' '}
                  </Text>
                ))
              : null}
            {isOpen && f.isCut && f.text ? (
              <Text size="footnote" dimColor>
                The rest of this file's diff is in the patch.
              </Text>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}
