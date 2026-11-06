// AuthenticationManager: official sign-in checks, and API keys kept with the
// operating system's own protection: Windows DPAPI (bound to this user
// account), the macOS Keychain, or the Linux Secret Service. A key is typed
// into a masked system dialog, never into the pane. On Windows the store holds
// only its DPAPI ciphertext; elsewhere it holds a marker, and the key lives in
// the system's keyring.
import type { EngineInterface } from 'claude-code'

import type { AuthState } from '../types'
import { argvOf, clean, errText, exe, onPath } from './cli'
import { type OsName, osName } from './platform'
import type { ProviderEntry } from './registry'
import { STORE } from './state'

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** PowerShell's -EncodedCommand: the script as UTF-16LE, base64. Avoids every quoting rule. */
function encodePs(script: string): string {
  const bytes: number[] = []
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i)
    bytes.push(c & 0xff, c >> 8)
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}

export async function powershell(
  $: EngineInterface,
  script: string,
  stdin?: string,
  timeoutMs = 60_000,
): Promise<{ code: number; out: string; err: string }> {
  const r = await $.process.run(
    ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(script)],
    { stdin, timeoutMs },
  )
  return { code: r.exitCode, out: r.stdout.trim(), err: clean(r.stderr) }
}

const UTF8_IO = '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);'

/** The keyring entry's service name on macOS and Linux. */
const SERVICE = 'jervis-ai-hub'
/** What the store holds in place of a ciphertext when the key lives in the system keyring. */
const MARK: Record<Exclude<OsName, 'windows'>, string> = { mac: 'keychain:v1', linux: 'secret-service:v1' }
const isMark = (v: string | undefined): boolean => v === MARK.mac || v === MARK.linux

/** `security -i` reads one command per line; values go in double quotes. */
const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

async function storeNative($: EngineInterface, os: Exclude<OsName, 'windows'>, id: string, label: string, key: string): Promise<boolean> {
  // the key goes on stdin, never on a command line other processes can read
  const r =
    os === 'mac'
      ? await $.process.run(['security', '-i'], { stdin: `add-generic-password -U -s ${SERVICE} -a ${q(id)} -l ${q(label)} -w ${q(key)}\n`, timeoutMs: 30_000 })
      : await $.process.run(['secret-tool', 'store', `--label=${label}`, 'service', SERVICE, 'account', id], { stdin: key, timeoutMs: 30_000 })
  return r.exitCode === 0
}

async function readNative($: EngineInterface, os: Exclude<OsName, 'windows'>, id: string): Promise<string | undefined> {
  const r =
    os === 'mac'
      ? await $.process.run(['security', 'find-generic-password', '-s', SERVICE, '-a', id, '-w'], { timeoutMs: 30_000 })
      : await $.process.run(['secret-tool', 'lookup', 'service', SERVICE, 'account', id], { timeoutMs: 30_000 })
  const key = r.stdout.replace(/\r?\n$/, '')
  return r.exitCode === 0 && key ? key : undefined
}

async function clearNative($: EngineInterface, os: Exclude<OsName, 'windows'>, id: string): Promise<void> {
  await (os === 'mac'
    ? $.process.run(['security', 'delete-generic-password', '-s', SERVICE, '-a', id], { timeoutMs: 30_000 })
    : $.process.run(['secret-tool', 'clear', 'service', SERVICE, 'account', id], { timeoutMs: 30_000 }))
}

/** A masked system dialog for the key: osascript on macOS, zenity or kdialog on Linux. */
async function askKeyNative(
  $: EngineInterface,
  os: Exclude<OsName, 'windows'>,
  title: string,
  label: string,
): Promise<{ key?: string; isCancelled?: boolean; error?: string }> {
  let argv: string[]
  if (os === 'mac') {
    const as = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    argv = [
      'osascript',
      '-e',
      `display dialog ${as(label)} default answer "" with hidden answer with title ${as(title)} buttons {"Cancel", "Save"} default button "Save" cancel button "Cancel"`,
      '-e',
      'text returned of result',
    ]
  } else if (await onPath($, 'zenity')) {
    argv = ['zenity', '--password', `--title=${title}`]
  } else if (await onPath($, 'kdialog')) {
    argv = ['kdialog', '--title', title, '--password', label]
  } else {
    return { error: 'no dialog tool found: install zenity or kdialog to type a key' }
  }
  const r = await $.process.run(argv, { timeoutMs: 10 * 60 * 1000 })
  const key = r.stdout.replace(/\r?\n$/, '').trim()
  if (r.exitCode !== 0 || !key) return /-128|cancel/i.test(r.stderr) || r.exitCode === 1 || !key ? { isCancelled: true } : { error: clean(r.stderr).slice(0, 200) }
  return { key }
}

/** Whether the system's secure storage works here. */
export async function secureStorageStatus($: EngineInterface): Promise<{ isOk: boolean; detail: string }> {
  const os = await osName($)
  if (os === 'mac') {
    return (await onPath($, 'security')) ? { isOk: true, detail: 'macOS Keychain (login keychain)' } : { isOk: false, detail: 'the `security` tool is missing' }
  }
  if (os === 'linux') {
    return (await onPath($, 'secret-tool'))
      ? { isOk: true, detail: 'Secret Service through secret-tool (GNOME Keyring or KWallet)' }
      : { isOk: false, detail: 'secret-tool is missing: install libsecret-tools (or libsecret) and a keyring' }
  }
  try {
    const r = await powershell(
      $,
      `${UTF8_IO}$c = ConvertTo-SecureString 'probe' -AsPlainText -Force | ConvertFrom-SecureString; if ($c.Length -gt 20) { 'ok' }`,
    )
    return r.out === 'ok'
      ? { isOk: true, detail: 'Windows DPAPI (current user)' }
      : { isOk: false, detail: r.err || 'DPAPI did not answer' }
  } catch (error) {
    return { isOk: false, detail: `Windows PowerShell unavailable: ${errText(error)}` }
  }
}

async function creds($: EngineInterface): Promise<Record<string, string>> {
  return ((await $.store.get(STORE.creds)) as Record<string, string> | undefined) ?? {}
}

export async function hasCredential($: EngineInterface, id: string): Promise<boolean> {
  return Boolean((await creds($))[id])
}

/**
 * Shows a masked Windows dialog for the key and stores its DPAPI ciphertext.
 * The plaintext stays inside PowerShell: this function never sees it.
 */
let dialogFor: string | undefined

export async function promptAndStoreKey(
  $: EngineInterface,
  p: ProviderEntry,
): Promise<{ isOk: boolean; message: string }> {
  // one key dialog at a time: a second would stack windows the person must hunt for
  if (dialogFor) return { isOk: false, message: `Finish the open key window for ${dialogFor} first.` }
  dialogFor = p.label
  const os = await osName($)
  if (os !== 'windows') {
    let key: string | undefined
    try {
      const shown = `Paste your ${p.label} API key. It is kept in your ${os === 'mac' ? 'macOS Keychain' : 'system keyring'} and never shown.`
      const got = await askKeyNative($, os, `Jervis AI Hub - ${p.label}`, shown)
      if (got.isCancelled) return { isOk: false, message: 'Cancelled: no key was saved.' }
      if (!got.key) return { isOk: false, message: `The key dialog failed: ${got.error ?? 'no key'}` }
      key = got.key
      if (!(await storeNative($, os, p.id, `Jervis AI Hub - ${p.label}`, key))) return { isOk: false, message: 'The system keyring refused the key.' }
      await $.store.set(STORE.creds, { ...(await creds($)), [p.id]: MARK[os] })
      return { isOk: true, message: 'Key saved in the system keyring.' }
    } catch (error) {
      return { isOk: false, message: `The key dialog could not open: ${errText(error)}` }
    } finally {
      key = undefined
      dialogFor = undefined
    }
  }
  const title = `Jervis AI Hub - ${p.label}`.replace(/'/g, "''")
  const label = `Paste your ${p.label} API key. It is encrypted for your Windows account (DPAPI) and never shown.`.replace(/'/g, "''")
  const script = `${UTF8_IO}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Hub -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);'
[System.Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object System.Windows.Forms.Form
$f.Text = '${title}'; $f.Width = 520; $f.Height = 190; $f.StartPosition = 'CenterScreen'
$f.TopMost = $true; $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
$l = New-Object System.Windows.Forms.Label
$l.Text = '${label}'; $l.Left = 14; $l.Top = 12; $l.Width = 480; $l.Height = 36
$t = New-Object System.Windows.Forms.TextBox
$t.UseSystemPasswordChar = $true; $t.Left = 14; $t.Top = 54; $t.Width = 476
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Save'; $ok.Left = 330; $ok.Top = 96; $ok.DialogResult = 'OK'
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'; $cancel.Left = 414; $cancel.Top = 96; $cancel.DialogResult = 'Cancel'
$f.Controls.AddRange(@($l, $t, $ok, $cancel)); $f.AcceptButton = $ok; $f.CancelButton = $cancel
$f.Add_Load({ [void][Hub.Win]::ShowWindow($f.Handle, 0) })
$f.Add_Shown({ [void][Hub.Win]::ShowWindow($f.Handle, 5); [void][Hub.Win]::SetForegroundWindow($f.Handle); $f.Activate(); $t.Focus() })
$r = $f.ShowDialog()
if ($r -ne 'OK' -or [string]::IsNullOrWhiteSpace($t.Text)) { exit 3 }
$s = ConvertTo-SecureString $t.Text.Trim() -AsPlainText -Force
$t.Text = ''
$s | ConvertFrom-SecureString`
  try {
    const r = await powershell($, script, undefined, 10 * 60 * 1000)
    if (r.code === 3) return { isOk: false, message: 'Cancelled: no key was saved.' }
    if (r.code !== 0 || !/^[0-9a-f]{40,}$/i.test(r.out)) {
      return { isOk: false, message: `The key dialog failed: ${r.err.slice(0, 200) || `exit ${r.code}`}` }
    }
    await $.store.set(STORE.creds, { ...(await creds($)), [p.id]: r.out })
    return { isOk: true, message: 'Key encrypted and saved.' }
  } catch (error) {
    return { isOk: false, message: `The key dialog could not open: ${errText(error)}` }
  } finally {
    dialogFor = undefined
  }
}

/** Encrypts a plaintext key from an earlier version and drops the plaintext. */
export async function protectLegacyKey($: EngineInterface, id: string, plaintext: string): Promise<boolean> {
  const os = await osName($)
  if (os !== 'windows') {
    if (!(await storeNative($, os, id, `Jervis AI Hub - ${id}`, plaintext))) return false
    await $.store.set(STORE.creds, { ...(await creds($)), [id]: MARK[os] })
    return true
  }
  const r = await powershell(
    $,
    `${UTF8_IO}$k = [Console]::In.ReadToEnd().Trim(); ConvertTo-SecureString $k -AsPlainText -Force | ConvertFrom-SecureString`,
    plaintext,
  )
  if (r.code !== 0 || !/^[0-9a-f]{40,}$/i.test(r.out)) return false
  await $.store.set(STORE.creds, { ...(await creds($)), [id]: r.out })
  return true
}

/**
 * Decrypts a key for the one request about to run. The caller passes it as an
 * environment variable and drops it; it is never stored, drawn or logged.
 */
export async function revealForRequest($: EngineInterface, id: string): Promise<string | undefined> {
  const cipher = (await creds($))[id]
  if (!cipher) return undefined
  if (isMark(cipher)) {
    const os = await osName($)
    return os === 'windows' ? undefined : readNative($, os, id)
  }
  const r = await powershell(
    $,
    `${UTF8_IO}$s = [Console]::In.ReadToEnd().Trim() | ConvertTo-SecureString; $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }`,
    cipher,
  )
  return r.code === 0 && r.out ? r.out : undefined
}

export async function forgetCredential($: EngineInterface, id: string): Promise<void> {
  const all = await creds($)
  if (!(id in all)) return
  if (isMark(all[id])) {
    const os = await osName($)
    if (os !== 'windows') await clearNative($, os, id).catch(() => undefined)
  }
  const { [id]: _drop, ...rest } = all
  await $.store.set(STORE.creds, rest)
}

/**
 * Checks authentication only: a sign-in or key that is present. It proves
 * nothing about availability, which only a test request shows.
 */
export async function checkAuth(
  $: EngineInterface,
  p: ProviderEntry,
): Promise<{ state: AuthState; message: string }> {
  const path = await exe($, p.kind)
  if (!path) return { state: 'not-installed', message: `The ${p.kind === 'codex' ? 'Codex' : p.kind === 'agy' ? 'agy' : 'OpenCode'} CLI is not installed.` }
  try {
    if (p.kind === 'codex') {
      const r = await $.process.run([...argvOf(path), 'login', 'status'], { timeoutMs: 30_000 })
      const text = clean(r.stdout + '\n' + r.stderr)
      return /logged in/i.test(text) && !/not logged in/i.test(text)
        ? { state: 'authenticated', message: text.split('\n')[0] ?? 'Signed in' }
        : { state: 'signed-out', message: 'Not signed in to Codex.' }
    }
    if (p.kind === 'agy') {
      const r = await $.process.run([...argvOf(path), 'models'], { timeoutMs: 60_000 })
      return r.exitCode === 0 && clean(r.stdout).includes('\t')
        ? { state: 'authenticated', message: 'agy lists its models for this account.' }
        : { state: 'signed-out', message: 'agy is not signed in: run `agy` once in a terminal and sign in.' }
    }
    if (p.kind === 'opencode-key') {
      return (await hasCredential($, p.id))
        ? { state: 'authenticated', message: 'A key is saved in secure storage (not yet proof that it works).' }
        : { state: 'missing-credential', message: 'No API key saved.' }
    }
    return { state: 'authenticated', message: 'No sign-in needed.' }
  } catch (error) {
    return { state: 'unknown', message: errText(error) }
  }
}
