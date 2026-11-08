// The engine interface the hub's modules call, answered by Node for hosts other
// than Claude Code (Codex, Antigravity). Only what the modules use is here.
//
// - store: one JSON file under ~/.jervis-ai-hub, written whole and renamed into
//   place, readable by this user only. It holds no key: keys stay in the OS's
//   secure storage, as in Claude Code.
// - ui.ask: only the asker the host passes in. The MCP server passes none, so
//   every question reads as "nobody could be asked" and the hub's fail-safe
//   answer follows (nothing sent, changes kept for later). The terminal command
//   `apply` passes one that asks on the person's own terminal.
// - process.spawn: ending the stream ends the child at once (it is killed), even
//   while a read waits on it.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Asker = (question: string, options: string[]) => Promise<string | undefined>

export type NodeEngineOptions = {
  /** where the store file lives; default ~/.jervis-ai-hub */
  home?: string
  /** puts a question to a person; absent, nobody can be asked */
  ask?: Asker
  /** a note for the person (the MCP server writes it to stderr) */
  log?: (text: string) => void
}

type Chunk = { stream: 'stdout' | 'stderr'; text: string }
type Ended = { code: number | null; signal: string | null }

function storeAt(home: string) {
  const file = join(home, 'store.json')
  let cache: Record<string, unknown> | undefined
  const load = (): Record<string, unknown> => {
    if (cache) return cache
    try {
      cache = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    } catch {
      cache = {}
    }
    return cache
  }
  const save = (): void => {
    mkdirSync(home, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(cache ?? {}), { mode: 0o600 })
    renameSync(tmp, file)
    try {
      chmodSync(file, 0o600)
    } catch {
      // Windows: the file is in the user's own profile
    }
  }
  return {
    get: async (k: string) => structuredClone(load()[k]),
    set: async (k: string, v: unknown) => {
      load()[k] = structuredClone(v)
      save()
    },
    delete: async (k: string) => {
      delete load()[k]
      save()
    },
    keys: async () => Object.keys(load()),
  }
}

function run(argv: readonly string[], opts: { timeoutMs?: number; stdin?: string; cwd?: string; env?: Record<string, string> } = {}) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: { ...process.env, ...opts.env }, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 20_000)
    child.stdout.on('data', d => (stdout += String(d)))
    child.stderr.on('data', d => (stderr += String(d)))
    child.on('error', e => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, stdout, stderr })
    })
    child.stdin.end(opts.stdin ?? '')
  })
}

/** A child's output, piece by piece, then how it ended; return() kills it, even mid-read. */
function spawnStream(req: { argv: readonly string[]; cwd?: string; env?: Record<string, string>; input?: string }) {
  const queue: Chunk[] = []
  const waiting: ((r: IteratorResult<Chunk, Ended>) => void)[] = []
  let ended: Ended | undefined
  let failed: Error | undefined
  const child = spawn(req.argv[0]!, req.argv.slice(1), { cwd: req.cwd, env: { ...process.env, ...req.env }, windowsHide: true })
  const push = (c: Chunk) => {
    const w = waiting.shift()
    if (w) w({ done: false, value: c })
    else queue.push(c)
  }
  const finish = () => {
    while (waiting.length) waiting.shift()!({ done: true, value: ended ?? { code: null, signal: 'killed' } })
  }
  child.stdout.on('data', d => push({ stream: 'stdout', text: String(d) }))
  child.stderr.on('data', d => push({ stream: 'stderr', text: String(d) }))
  child.on('error', e => {
    failed = e
    finish()
  })
  child.on('close', (code, signal) => {
    ended = { code, signal }
    finish()
  })
  child.stdin.end(req.input ?? '')
  let resolveResult: (e: Ended) => void = () => undefined
  const result = new Promise<Ended>(r => (resolveResult = r))
  child.on('close', (code, signal) => resolveResult({ code, signal }))
  const it = {
    next: (): Promise<IteratorResult<Chunk, Ended>> => {
      if (failed) return Promise.reject(failed)
      if (queue.length) return Promise.resolve({ done: false, value: queue.shift()! })
      if (ended) return Promise.resolve({ done: true, value: ended })
      return new Promise(r => waiting.push(r))
    },
    return: async (): Promise<IteratorResult<Chunk, Ended>> => {
      if (!ended) {
        child.kill()
        // a child that ignores the first signal is ended for good
        setTimeout(() => {
          if (!ended) child.kill('SIGKILL')
        }, 2000).unref()
        ended = { code: null, signal: 'SIGTERM' }
        finish()
      }
      return { done: true, value: ended }
    },
    result,
    [Symbol.asyncIterator]() {
      return it
    },
  }
  return it
}

/** The engine interface, answered by this Node process. */
export function nodeEngine(opts: NodeEngineOptions = {}) {
  // a plugin host gives the plugin a data folder of its own (Codex: PLUGIN_DATA)
  const home = opts.home ?? process.env.JERVIS_HUB_HOME ?? process.env.PLUGIN_DATA ?? join(homedir(), '.jervis-ai-hub')
  const sessionId = randomUUID()
  const log = opts.log ?? ((t: string) => process.stderr.write(`${t}\n`))
  const $ = {
    __state: new Map<string, unknown>(),
    env: { get: async (name: string) => process.env[name] },
    clock: {
      now: async () => Date.now(),
      sleep: (ms: number, o?: { signal?: AbortSignal }) =>
        new Promise<void>((resolve, reject) => {
          if (o?.signal?.aborted) return reject(new Error('aborted'))
          const t = setTimeout(resolve, ms)
          o?.signal?.addEventListener('abort', () => {
            clearTimeout(t)
            reject(new Error('aborted'))
          })
        }),
    },
    store: storeAt(home),
    session: {
      id: async () => sessionId,
      // no conversation to add to: a job's result is read with job_status
      append: async () => undefined,
      usage: async () => ({ rateLimits: [] }),
    },
    fs: {
      exists: async (p: string) => existsSync(p),
      read: async (p: string) => readFileSync(p, 'utf8'),
      write: async (p: string, text: string) => {
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, text)
      },
      list: async (p: string) =>
        readdirSync(p, { withFileTypes: true }).map(d => {
          const st = lstatSync(join(p, d.name))
          return { name: d.name, kind: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other', size: st.size, mtimeMs: st.mtimeMs, isLink: st.isSymbolicLink() }
        }),
      stat: async (p: string, _o?: { resolve?: boolean }) => {
        const st = statSync(p)
        return { kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', size: st.size, mtimeMs: st.mtimeMs, isLink: lstatSync(p).isSymbolicLink(), realPath: realpathSync.native(p) }
      },
    },
    process: { run, spawn: spawnStream },
    http: {
      fetch: async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
        const r = await fetch(url, init)
        return { ok: r.ok, status: r.status, text: init?.method === 'HEAD' ? '' : await r.text() }
      },
    },
    ui: {
      ask: async (question: string, o: { options: string[] }) => (opts.ask ? opts.ask(question, o.options) : undefined),
      toast: (text: string) => log(text),
      status: () => undefined,
      open: async () => ({ isPlaced: false }),
      close: async () => undefined,
    },
    tool: { register: async () => undefined },
    command: { register: async () => undefined },
    agent: {
      spawn: async () => {
        throw new Error('Claude subagents exist only in Claude Code')
      },
    },
  }
  return $
}
