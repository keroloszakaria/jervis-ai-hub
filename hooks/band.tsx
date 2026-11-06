// The band above the prompt: the session's background jobs, each with its
// level, where it runs and how long it has run; ended ones until cleared.
import type { EngineInterface, RenderInput } from 'claude-code'

import { snipWords } from './activity'
import { LEVEL_LABEL } from './levels'
import { allJobs, bandClock, clearEnded, duration, stopJob } from './jobs'
import { provider } from './registry'

const ICON = { running: '◐', done: '✓', failed: '✕', stopped: '■' } as const
const COLOR = { running: '#FFA45C', done: 'success', failed: 'error', stopped: 'warning' } as const

export async function renderBand($: EngineInterface, e: RenderInput<'AbovePrompt'>) {
  if ((e.props as { hasSurvey?: boolean }).hasSurvey) return undefined
  const shown = (await allJobs($)).filter(j => !j.isCleared)
  if (!shown.length) return undefined
  const at = Math.max(await bandClock($), await $.clock.now())
  const { Box, Button, Text } = $.ui.resolve(e)
  const running = shown.filter(j => j.state === 'running').length
  const ended = shown.length - running
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text weight="semibold">{`Jervis AI Hub · ${running} running${ended ? ` · ${ended} ended` : ''}`}</Text>
        {ended ? <Button key="jobs-clear" plain dimColor label="Clear ended" onPress={() => void clearEnded($)} /> : null}
      </Box>
      {shown.slice(-5).map(j => {
        const where = j.runner === 'subagent' ? `subagent${j.model ? ` · ${j.model}` : ''}` : `${provider(j.provider ?? '')?.label ?? j.provider ?? ''}${j.model ? ` · ${j.model}` : ''}`
        const time = duration((j.endedAt ?? at) - j.startedAt)
        return (
          <Box key={`job-${j.id}`} flexDirection="row" gap={1}>
            <Text color={COLOR[j.state]}>{ICON[j.state]}</Text>
            <Text>{`${j.title} · ${LEVEL_LABEL[j.level]} · ${where} · ${time}`}</Text>
            {j.state !== 'running' && j.summary ? <Text dimColor>{`· ${snipWords(j.summary, 90)}`}</Text> : null}
            {j.state === 'running' && j.runner === 'other-ai' && j.activityId ? (
              <Button key={`job-stop-${j.id}`} variant="secondary" label="Stop" onPress={() => void stopJob($, j.id)} />
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}
