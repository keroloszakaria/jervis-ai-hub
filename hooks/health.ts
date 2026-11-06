// HealthMonitor and connection management. Four facts are kept apart:
// installed, authenticated (a sign-in or key is present), verified (a real
// test request answered) and enabled (the person's switch).
import { refreshLimits } from './limits'
import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { checkAuth, forgetCredential, promptAndStoreKey } from './auth'
import { argvOf, clean, errText, exe } from './cli'
import { refreshModels } from './models'
import { provider } from './registry'
import { runRequest } from './requests'
import { note, saveConfig, setHealth, DEFAULT_SETTINGS } from './state'

// state this file reads (the scan needs each atom declared in the file that uses it)
const config = atom({ plugin: 'ai-subscriptions', key: 'config' } as const, {}, { shape: 'cfg-3' })
const health = atom({ plugin: 'ai-subscriptions', key: 'health' } as const, {}, { shape: 'h-1' })
const settings = atom({ plugin: 'ai-subscriptions', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'st-1' })

const TEST_PROMPT = 'Reply with exactly: OK'

export type Status = 'disabled' | 'not-installed' | 'signed-out' | 'checking' | 'unverified' | 'verified' | 'failing'

/** The one word the pane shows, derived from the separate facts. */
export async function status($: EngineInterface, id: string): Promise<Status> {
  const c = (await read($, config))[id]
  const h = (await read($, health))[id]
  if (c && !c.isEnabled) return 'disabled'
  if (!h || h.auth === 'unknown' || h.auth === 'checking') return 'checking'
  if (h.auth === 'not-installed') return 'not-installed'
  if (h.auth === 'signed-out' || h.auth === 'missing-credential') return 'signed-out'
  if (!h.lastTest) return 'unverified'
  return h.lastTest.isOk ? 'verified' : 'failing'
}

export const STATUS_LABEL: Record<Status, string> = {
  disabled: 'Disabled',
  'not-installed': 'CLI missing',
  'signed-out': 'Signed out',
  checking: 'Checking…',
  unverified: 'Signed in, not tested',
  verified: 'Verified',
  failing: 'Test failed',
}

export const STATUS_COLOR: Record<Status, string | undefined> = {
  disabled: undefined,
  'not-installed': 'error',
  'signed-out': 'warning',
  checking: undefined,
  unverified: 'warning',
  verified: 'success',
  failing: 'error',
}

/** Authentication checks for every connected provider; cheap, sends no prompt. */
export async function checkAllAuth($: EngineInterface): Promise<void> {
  const cfg = await read($, config)
  await Promise.all(
    Object.entries(cfg)
      .filter(([, c]) => c.isConnected)
      .map(([id]) => checkOne($, id)),
  )
}

export async function checkOne($: EngineInterface, id: string): Promise<void> {
  const p = provider(id)
  if (!p) return
  await setHealth($, id, h => ({ ...h, auth: 'checking' }))
  const r = await checkAuth($, p)
  const at = await $.clock.now()
  await setHealth($, id, h => ({ ...h, auth: r.state, authMessage: r.message, authCheckedAt: at }))
}

/** A real, minimal request: the only thing that marks a provider verified. */
export async function test($: EngineInterface, id: string): Promise<void> {
  await note($, id, 'Sending a test request…')
  const r = await runRequest($, { providerId: id, prompt: TEST_PROMPT, mode: 'read', type: 'test' })
  const at = await $.clock.now()
  await setHealth($, id, h => ({
    ...h,
    lastTest: { isOk: r.isOk, at, ms: r.ms, message: r.isOk ? r.text.slice(0, 80) : r.text.slice(0, 300) },
  }))
  await note($, id, undefined)
}

async function signInCodex($: EngineInterface, id: string, path: string): Promise<boolean> {
  await note($, id, 'Starting the official ChatGPT sign-in… finish it in your browser.')
  try {
    for await (const chunk of $.process.spawn({ argv: [...argvOf(path), 'login'] })) {
      const url = /https?:\/\/[^\s'"]+/.exec(clean(chunk.text))?.[0]
      if (url) await note($, id, 'Finish signing in to ChatGPT in your browser:', false, url)
    }
  } catch (error) {
    await note($, id, `Sign-in could not start: ${errText(error)}`, true)
    return false
  }
  return true
}

/** Connects one provider by its own official method, then checks it. */
export async function connect($: EngineInterface, id: string): Promise<void> {
  const p = provider(id)
  if (!p) return
  const path = await exe($, p.kind)
  if (!path) {
    await setHealth($, id, h => ({ ...h, auth: 'not-installed', authMessage: 'CLI not installed' }))
    await note($, id, `${p.label} needs its official CLI installed first.`, true)
    return
  }

  let auth = await checkAuth($, p)
  if (auth.state !== 'authenticated') {
    if (p.kind === 'codex') {
      if (!(await signInCodex($, id, path))) return
    } else if (p.kind === 'agy') {
      await note($, id, auth.message, true)
      return
    } else if (p.kind === 'opencode-key') {
      await note($, id, `Enter the key in the “Jervis AI Hub - ${p.label}” window.`)
      const r = await promptAndStoreKey($, p)
      if (!r.isOk) {
        await note($, id, r.message, true)
        return
      }
    }
    auth = await checkAuth($, p)
  }
  const at = await $.clock.now()
  await setHealth($, id, h => ({ ...h, auth: auth.state, authMessage: auth.message, authCheckedAt: at, lastTest: undefined }))
  if (auth.state !== 'authenticated') {
    await note($, id, auth.message, true)
    return
  }

  await saveConfig($, id, c => ({ ...c, isConnected: true, isEnabled: true, connectedAt: at }))
  await note($, id, 'Loading models…')
  await refreshModels($, id)
  void refreshLimits($, id).catch(() => undefined)
  await note($, id, undefined)
  if ((await read($, settings)).verifyOnConnect) await test($, id)
}

/** Removes the hub's link; for a subscription it never signs out of the CLI itself. */
export async function disconnect($: EngineInterface, id: string): Promise<void> {
  await forgetCredential($, id)
  await saveConfig($, id, c => ({ ...c, isConnected: false }))
  await setHealth($, id, () => ({ auth: 'unknown' }))
  await note($, id, undefined)
}
