// Runs the hub's workspace copy (hooks/workspace.ts) against the real git of
// the system it runs on, in throwaway folders: copy, change (binary files
// included), compare, apply, and an apply refused after the folder changed.
// CI runs it on Linux, Windows and macOS. By hand: npx -y tsx@4.19.2 ci/real-workspace.ts
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { LEFT_BEHIND_MS, applyRun, changedSince, cleanOldRuns, compare, isLeftOut, makeCopy, readRun, removeRun } from '../hooks/workspace'

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'hub-workspace-')))
const home = join(root, 'home')
mkdirSync(home)

// the plugin store, in memory; and a hook run just before `git apply`, to change the folder at that moment
const store = new Map<string, unknown>()
let beforeApply: (() => void) | undefined
// and one run just before the hub stores the files in a run's own git (not the scan's)
let beforeStore: (() => void) | undefined
// removals that fail, as on a locked file: the path is left as it is
let failRemove: ((path: string) => boolean) | undefined

// the few engine calls the copy makes, answered by this process; home is a throwaway folder
const $ = {
  env: { get: async (name: string) => (name === 'USERPROFILE' || name === 'HOME' ? home : process.env[name]) },
  store: {
    get: async (key: string) => (store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : undefined),
    set: async (key: string, value: unknown) => void store.set(key, JSON.parse(JSON.stringify(value))),
  },
  clock: { now: async () => Date.now() },
  fs: {
    read: async (path: string) => readFileSync(path, 'utf8'),
    write: async (path: string, text: string) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    },
    exists: async (path: string) => existsSync(path),
    stat: async (path: string) => {
      const st = statSync(path)
      return { kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', size: st.size, mtimeMs: st.mtimeMs, isLink: lstatSync(path).isSymbolicLink(), realPath: realpathSync.native(path) }
    },
    list: async (path: string) =>
      readdirSync(path, { withFileTypes: true }).map(d => ({ name: d.name, kind: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other', size: 0, mtimeMs: 0, isLink: d.isSymbolicLink() })),
  },
  process: {
    run: async (argv: string[], opts?: { timeoutMs?: number; stdin?: string; cwd?: string; env?: Record<string, string> }) => {
      const target = argv[argv.length - 1] ?? ''
      if ((argv[0] === 'rm' || argv.includes('rmdir')) && failRemove?.(target)) return { exitCode: 1, stdout: '', stderr: 'locked' }
      if (argv.includes('apply') && beforeApply) {
        beforeApply()
        beforeApply = undefined
      }
      if (argv.includes('add') && beforeStore && argv.some(a => a.startsWith('--git-dir=') && !/[\\/]scan$/.test(a))) {
        beforeStore()
        beforeStore = undefined
      }
      const r = spawnSync(argv[0]!, argv.slice(1), {
        encoding: 'utf8',
        input: opts?.stdin,
        cwd: opts?.cwd,
        env: { ...process.env, ...opts?.env },
        timeout: opts?.timeoutMs ?? 30_000,
        maxBuffer: 64 * 1024 * 1024,
      })
      if (r.error) throw r.error
      return { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }
    },
  },
} as never

let failures = 0
function check(what: string, isOk: boolean, detail = ''): void {
  console.log(`${isOk ? 'ok  ' : 'FAIL'} ${what}${!isOk && detail ? `\n     ${detail.trim().split('\n').join('\n     ')}` : ''}`)
  if (!isOk) failures++
}

function git(cwd: string, args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

/** Every file under `.git`, with its size and time, so a write to it shows. */
function gitFiles(dir: string): string {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        const s = statSync(p)
        out.push(`${p}:${s.size}:${s.mtimeMs}`)
      }
    }
  }
  walk(join(dir, '.git'))
  return out.sort().join('\n')
}

const BIN = Buffer.from([0, 1, 2, 255, 254, 13, 10, 0, 128, 10])
const BIN2 = Buffer.from([9, 8, 7, 0, 13, 13, 10, 255])

async function main(): Promise<void> {
  try {
    console.log(`workspace copy on ${process.platform}: ${git(root, ['--version']).out.trim()}`)
    const repo = join(root, 'repo')
    mkdirSync(join(repo, 'src'), { recursive: true })
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Hub CI'], ['config', 'user.email', 'ci@example.invalid'], ['config', 'commit.gpgsign', 'false'], ['config', 'core.autocrlf', 'true']]) git(repo, args)
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\ndist/\n')
    writeFileSync(join(repo, 'a.txt'), 'one\r\ntwo\n')
    writeFileSync(join(repo, 'src', 'img.bin'), BIN)
    writeFileSync(join(repo, '.env'), 'SECRET=1\n')
    writeFileSync(join(repo, 'gone.txt'), 'g\n')
    git(repo, ['add', '-f', '.'])
    git(repo, ['commit', '-q', '-m', 'first'])
    // the working tree as a person leaves it: a file deleted, one untracked, ignored output
    unlinkSync(join(repo, 'gone.txt'))
    writeFileSync(join(repo, 'new.txt'), 'n\n')
    mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'x', 'i.js'), '1\n')
    // git status refreshes the index itself, so it runs before .git is read
    const statusBefore = git(repo, ['status', '--porcelain']).out
    const gitBefore = gitFiles(repo)

    const run = await makeCopy($, { folder: repo, shown: repo, provider: 'chatgpt' })
    const t = run.tree
    check('the copy holds the tracked and untracked files', existsSync(join(t, 'a.txt')) && existsSync(join(t, 'new.txt')) && existsSync(join(t, 'src', 'img.bin')))
    check('a text file is copied byte for byte (no line-ending change)', readFileSync(join(t, 'a.txt')).equals(readFileSync(join(repo, 'a.txt'))))
    check('a binary file is copied byte for byte', readFileSync(join(t, 'src', 'img.bin')).equals(BIN))
    check('the copy has no .git', !existsSync(join(t, '.git')))
    check('the copy leaves out .env, though git tracks it', !existsSync(join(t, '.env')) && run.leftOut.some(l => l.path === '.env' && l.why === 'name'), JSON.stringify(run.leftOut))
    check('no record of the run is written beside the copy', !existsSync(join(run.root, 'run.json')))
    check('the copy leaves out ignored files', !existsSync(join(t, 'node_modules')))
    check('the copy leaves out a file the person deleted', !existsSync(join(t, 'gone.txt')))
    const gitAfter = gitFiles(repo)
    const moved = gitAfter.split('\n').filter(l => !gitBefore.split('\n').includes(l))
    check("the person's .git is not written by the copy", gitAfter === gitBefore, moved.join('\n'))

    // the run changes its copy: one changed, one binary added, one deleted
    writeFileSync(join(t, 'a.txt'), 'one\r\nTWO\n')
    writeFileSync(join(t, 'src', 'new.bin'), BIN2)
    unlinkSync(join(t, 'new.txt'))
    check('the folder is untouched while the run works in the copy', readFileSync(join(repo, 'a.txt'), 'utf8') === 'one\r\ntwo\n' && existsSync(join(repo, 'new.txt')))
    const c = await compare($, run)
    const list = c.changes.map(x => `${x.status} ${x.path}`).sort()
    check('the compare lists the run\'s changes and nothing else', JSON.stringify(list) === JSON.stringify(['A src/new.bin', 'D new.txt', 'M a.txt']), JSON.stringify(list))
    check('the patch is saved beside the run', existsSync(c.patchPath) && readFileSync(c.patchPath, 'utf8').includes('GIT binary patch'))
    check('nothing changed in the folder since the copy', (await changedSince($, run, c.changes)).length === 0)

    const applied = await applyRun($, run, c)
    check('apply works', applied.isOk, JSON.stringify(applied))
    check('apply writes a text change byte for byte', readFileSync(join(repo, 'a.txt'), 'utf8') === 'one\r\nTWO\n', JSON.stringify(readFileSync(join(repo, 'a.txt'), 'utf8')))
    check('apply writes a new binary file byte for byte', existsSync(join(repo, 'src', 'new.bin')) && readFileSync(join(repo, 'src', 'new.bin')).equals(BIN2))
    check('apply deletes a file the run deleted', !existsSync(join(repo, 'new.txt')))
    check('apply leaves .env alone', readFileSync(join(repo, '.env'), 'utf8') === 'SECRET=1\n')
    const staged = git(repo, ['diff', '--cached', '--name-only']).out.trim()
    check('apply stages and commits nothing', staged === '' && git(repo, ['rev-list', '--count', 'HEAD']).out.trim() === '1', staged)
    check('the person\'s git sees the change as an unstaged edit', git(repo, ['status', '--porcelain']).out !== statusBefore)

    // a second run, while the person changes the same file: the apply is refused
    const run2 = await makeCopy($, { folder: repo, shown: repo, provider: 'chatgpt' })
    writeFileSync(join(run2.tree, 'a.txt'), 'from the run\n')
    writeFileSync(join(run2.tree, 'fresh.txt'), 'f\n')
    const c2 = await compare($, run2)
    writeFileSync(join(repo, 'a.txt'), 'mine meanwhile\n')
    const refused = await applyRun($, run2, c2)
    check('an apply onto a file changed since the copy is refused, by name', !refused.isOk && JSON.stringify(refused).includes('a.txt'), JSON.stringify(refused))
    check('a refused apply writes nothing', readFileSync(join(repo, 'a.txt'), 'utf8') === 'mine meanwhile\n' && !existsSync(join(repo, 'fresh.txt')))

    // a file the run adds that the folder got meanwhile is refused too
    const run3 = await makeCopy($, { folder: repo, shown: repo, provider: 'chatgpt' })
    writeFileSync(join(run3.tree, 'both.txt'), 'run\n')
    const c3 = await compare($, run3)
    writeFileSync(join(repo, 'both.txt'), 'person\n')
    check('a file both added is refused', JSON.stringify(await changedSince($, run3, c3.changes)) === JSON.stringify(['both.txt']))

    // outside a repository: every file, minus the folder's own .gitignore
    const plain = join(root, 'plain')
    mkdirSync(join(plain, 'dist'), { recursive: true })
    writeFileSync(join(plain, '.gitignore'), 'dist/\n')
    writeFileSync(join(plain, 'p.txt'), 'p\n')
    writeFileSync(join(plain, 'dist', 'out.js'), 'o\n')
    writeFileSync(join(plain, 'server.key'), 'k\n')
    const run4 = await makeCopy($, { folder: plain, shown: plain, provider: 'chatgpt' })
    check('outside a repository the copy holds the files', existsSync(join(run4.tree, 'p.txt')))
    check('outside a repository it leaves out ignored and secret files', !existsSync(join(run4.tree, 'dist')) && !existsSync(join(run4.tree, 'server.key')))
    check('a folder outside any repository gets no .git', !existsSync(join(plain, '.git')))

    check('secret names are left out, others kept', isLeftOut('.env') && isLeftOut('a/.env.local') && isLeftOut('k/id_rsa.pub') && isLeftOut('x.PEM') && !isLeftOut('src/env.ts') && !isLeftOut('keys.ts'))

    // a key in a file with an ordinary name, and what .jervisignore names, stay out
    const keyed = join(root, 'keyed')
    mkdirSync(join(keyed, 'config'), { recursive: true })
    writeFileSync(join(keyed, 'config', 'prod.json'), `{ "token": "ghp_${'a1B2'.repeat(9)}" }\n`)
    writeFileSync(join(keyed, 'config', 'pem.txt'), '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n')
    writeFileSync(join(keyed, 'code.ts'), 'export const env = process.env.TOKEN // sk-short\n')
    writeFileSync(join(keyed, 'notes.private.md'), 'mine\n')
    writeFileSync(join(keyed, '.jervisignore'), '*.private.md\n')
    const run5 = await makeCopy($, { folder: keyed, shown: keyed, provider: 'chatgpt' })
    check('a file with a key inside is left out, whatever its name', !existsSync(join(run5.tree, 'config', 'prod.json')) && !existsSync(join(run5.tree, 'config', 'pem.txt')), JSON.stringify(run5.leftOut))
    check('ordinary code that mentions a token is copied', existsSync(join(run5.tree, 'code.ts')))
    check('what .jervisignore names is left out', !existsSync(join(run5.tree, 'notes.private.md')) && run5.leftOut.some(l => l.why === 'ignore-file'))
    // what was left out never reached the run's git: no object holds it
    const idOf = (file: string) => git(keyed, ['hash-object', '--', file]).out.trim()
    const inStore = (id: string) => git(home, [`--git-dir=${run5.git}`, 'cat-file', '-e', id]).code === 0
    check('control: a copied file is in the run\'s git', inStore(idOf('code.ts')))
    check(
      "a file left out leaves no copy of its content in the run's git",
      !inStore(idOf(join('config', 'prod.json'))) && !inStore(idOf(join('config', 'pem.txt'))) && !inStore(idOf('notes.private.md')),
    )
    check('the scan, which read every file, is gone before the run starts', !existsSync(join(run5.root, 'scan')))

    // a file changed between the scan and the copy: nothing is copied
    beforeStore = () => writeFileSync(join(keyed, 'code.ts'), `export const t = "ghp_${'z9Y8'.repeat(9)}"\n`)
    const runsNow = () => readdirSync(join(home, '.claude', 'jervis-ai-hub', 'work')).filter(n => n.startsWith('run-')).length
    const before = runsNow()
    let threw = ''
    try {
      await makeCopy($, { folder: keyed, shown: keyed, provider: 'chatgpt' })
    } catch (error) {
      threw = String(error)
    }
    beforeStore = undefined
    check('a file changed between the scan and the copy refuses the copy, and leaves no run behind', threw.includes('changed while they were copied') && runsNow() === before, `${threw} ${before} -> ${runsNow()}`)
    writeFileSync(join(keyed, 'code.ts'), 'export const env = process.env.TOKEN // sk-short\n')

    // the review: each file's diff, and binary files named as such
    const shown = join(root, 'shown')
    mkdirSync(shown)
    writeFileSync(join(shown, 'a.txt'), 'one\ntwo\nthree\n')
    const run9 = await makeCopy($, { folder: shown, shown, provider: 'chatgpt' })
    writeFileSync(join(run9.tree, 'a.txt'), 'one\nTWO\nthree\n')
    writeFileSync(join(run9.tree, 'b.bin'), Buffer.from([0, 1, 2, 0, 255]))
    const c9 = await compare($, run9)
    const fa = c9.files.find(f => f.path === 'a.txt')
    const fb = c9.files.find(f => f.path === 'b.bin')
    check("the review has each file's diff", Boolean(fa && fa.text.includes('-two') && fa.text.includes('+TWO') && fa.added === 1 && fa.deleted === 1), JSON.stringify(c9.files))
    check('a binary file is named as one, with no text', Boolean(fb && fb.isBinary && fb.text === '' && fb.status === 'A'), JSON.stringify(fb))

    // an apply onto a file that, meanwhile, changed elsewhere in it: the run's changes come back out, the other change stays
    const merge = join(root, 'merge')
    mkdirSync(merge)
    writeFileSync(join(merge, 'm.txt'), `${Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')}\n`)
    const run10 = await makeCopy($, { folder: merge, shown: merge, provider: 'chatgpt' })
    writeFileSync(join(run10.tree, 'm.txt'), readFileSync(join(run10.tree, 'm.txt'), 'utf8').replace('line 2\n', 'line 2 (run)\n'))
    const c10 = await compare($, run10)
    beforeApply = () => writeFileSync(join(merge, 'm.txt'), readFileSync(join(merge, 'm.txt'), 'utf8').replace('line 27\n', 'line 27 (person)\n'))
    const r10 = await applyRun($, run10, c10)
    const m = readFileSync(join(merge, 'm.txt'), 'utf8')
    check(
      "a change made meanwhile elsewhere in a file: the run's changes are taken back out, the other change stays, and the file is named",
      !r10.isOk && !('isMixed' in r10) && (r10.files ?? []).includes('m.txt') && !m.includes('line 2 (run)') && m.includes('line 27 (person)'),
      JSON.stringify({ r10, m }),
    )
    // so a run that changes two files leaves neither applied
    writeFileSync(join(merge, 'n.txt'), 'n\n')
    const run12 = await makeCopy($, { folder: merge, shown: merge, provider: 'chatgpt' })
    writeFileSync(join(run12.tree, 'n.txt'), 'N\n')
    writeFileSync(join(run12.tree, 'm.txt'), readFileSync(join(run12.tree, 'm.txt'), 'utf8').replace('line 3\n', 'line 3 (run)\n'))
    const c12 = await compare($, run12)
    beforeApply = () => writeFileSync(join(merge, 'm.txt'), readFileSync(join(merge, 'm.txt'), 'utf8').replace('line 20\n', 'line 20 (person)\n'))
    const r12 = await applyRun($, run12, c12)
    check('and every file of that run is taken back out, not only the merged one', !r12.isOk && readFileSync(join(merge, 'n.txt'), 'utf8') === 'n\n', JSON.stringify(r12))
    await removeRun($, run12.root)
    // and an apply with nothing else changed names nothing
    const run11 = await makeCopy($, { folder: merge, shown: merge, provider: 'chatgpt' })
    writeFileSync(join(run11.tree, 'm.txt'), readFileSync(join(run11.tree, 'm.txt'), 'utf8').replace('line 5\n', 'line 5 (run)\n'))
    const r11 = await applyRun($, run11, await compare($, run11))
    check('a clean apply is applied, with nothing to report', r11.isOk && !('unchecked' in r11) && readFileSync(join(merge, 'm.txt'), 'utf8').includes('line 5 (run)'), JSON.stringify(r11))

    // a scan that cannot be removed refuses the copy; what it left is removed at the next start, once old enough
    const work = join(home, '.claude', 'jervis-ai-hub', 'work')
    const runsBefore = new Set(readdirSync(work))
    failRemove = path => path.includes(`${join('jervis-ai-hub', 'work')}`)
    let scanRefused = ''
    try {
      await makeCopy($, { folder: plain, shown: plain, provider: 'chatgpt' })
    } catch (error) {
      scanRefused = String(error)
    }
    failRemove = undefined
    const leftBehind = readdirSync(work).filter(n => !runsBefore.has(n))
    check('a scan that cannot be removed refuses the copy', scanRefused.includes('could not be removed') && leftBehind.length === 1, `${scanRefused} ${leftBehind.join(',')}`)
    const stuck = join(work, leftBehind[0] ?? 'none')
    check('control: the failed copy left its scan behind', existsSync(join(stuck, 'scan')))
    await cleanOldRuns($, Date.now())
    check('a copy left behind just now is not touched (it may still be in the making)', existsSync(join(stuck, 'scan')))
    // a kept run with a scan still in it: the scan goes, the run stays
    const run13 = await makeCopy($, { folder: plain, shown: plain, provider: 'chatgpt' })
    mkdirSync(join(run13.root, 'scan'))
    writeFileSync(join(run13.root, 'scan', 'x'), 'x')
    await cleanOldRuns($, Date.now() + LEFT_BEHIND_MS + 60_000)
    check('once old enough, a copy with no record is removed', !existsSync(stuck))
    check("and a kept run's leftover scan goes, while the run stays", !existsSync(join(run13.root, 'scan')) && existsSync(run13.tree) && (await readRun($, run13.id)) !== undefined)
    await removeRun($, run13.root)

    // links: a link in the folder that leads out is not copied, and a link the run makes is never applied
    const linked = join(root, 'linked')
    mkdirSync(linked)
    writeFileSync(join(linked, 'ok.txt'), 'ok\n')
    const secretDir = join(root, 'secret-dir')
    mkdirSync(secretDir)
    writeFileSync(join(secretDir, 's.txt'), 'S\n')
    let canLink = true
    try {
      symlinkSync(secretDir, join(linked, 'out'), 'dir')
      symlinkSync(join(secretDir, 's.txt'), join(linked, 'out.txt'), 'file')
    } catch {
      canLink = false
    }
    if (canLink) {
      const run6 = await makeCopy($, { folder: linked, shown: linked, provider: 'chatgpt' })
      const inCopy = (n: string) => {
        try {
          lstatSync(join(run6.tree, n))
          return true
        } catch {
          return false
        }
      }
      check('a link in the folder that leads out is not in the copy', !inCopy('out') && !inCopy('out.txt') && run6.leftOut.some(l => l.why === 'link'), JSON.stringify(run6.leftOut))
      symlinkSync(join(secretDir, 's.txt'), join(run6.tree, 'made-link'), 'file')
      writeFileSync(join(run6.tree, 'ok.txt'), 'changed\n')
      const c6 = await compare($, run6)
      const r6 = await applyRun($, run6, c6)
      check('a link the run made is refused, and nothing is applied', !r6.isOk && JSON.stringify(r6).includes('made-link') && readFileSync(join(linked, 'ok.txt'), 'utf8') === 'ok\n', JSON.stringify({ r6, c6 }))
      await removeRun($, run6.root)
    } else {
      console.log('skip links: this system would not make a symbolic link here (on Windows that needs Developer Mode)')
    }

    // a junction (Windows) or linked folder that git lists as a plain folder: nothing under it is copied
    const jroot = join(root, 'junction-folder')
    mkdirSync(jroot)
    writeFileSync(join(jroot, 'ok.txt'), 'ok\n')
    const jsecret = join(root, 'junction-secret')
    mkdirSync(jsecret)
    writeFileSync(join(jsecret, 's.txt'), 'S\n')
    let canJunction = true
    try {
      symlinkSync(jsecret, join(jroot, 'out'), 'junction')
    } catch {
      canJunction = false
    }
    if (canJunction) {
      const runJ = await makeCopy($, { folder: jroot, shown: jroot, provider: 'chatgpt' })
      check('a file reached through a junction is not in the copy', !existsSync(join(runJ.tree, 'out', 's.txt')) && runJ.leftOut.some(l => l.path.startsWith('out') && l.why === 'link'), JSON.stringify(runJ.leftOut))
      await removeRun($, runJ.root)

      // a folder made into a junction after the copy: the Apply is refused and the file outside is untouched
      const jroot2 = join(root, 'junction-later')
      mkdirSync(join(jroot2, 'sub'), { recursive: true })
      writeFileSync(join(jroot2, 'sub', 'f.txt'), 'a\n')
      const runJ2 = await makeCopy($, { folder: jroot2, shown: jroot2, provider: 'chatgpt' })
      writeFileSync(join(runJ2.tree, 'sub', 'f.txt'), 'b\n')
      const cJ2 = await compare($, runJ2)
      const outside = join(root, 'junction-outside')
      mkdirSync(outside)
      writeFileSync(join(outside, 'f.txt'), 'a\n')
      renameSync(join(jroot2, 'sub'), join(jroot2, 'sub-was'))
      symlinkSync(outside, join(jroot2, 'sub'), 'junction')
      const rJ2 = await applyRun($, runJ2, cJ2)
      check('an Apply through a folder made into a junction is refused, and the file outside is untouched', !rJ2.isOk && JSON.stringify(rJ2).includes('leads out of the project') && readFileSync(join(outside, 'f.txt'), 'utf8') === 'a\n', JSON.stringify(rJ2))
      await removeRun($, runJ2.root)
    } else {
      console.log('skip junctions: this system would not make one here')
    }

    // a write that fails half way (a folder git cannot write): what was written is put back, and the answer says so
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const half = join(root, 'half')
      mkdirSync(join(half, 'z'), { recursive: true })
      writeFileSync(join(half, 'a.txt'), 'a\n')
      writeFileSync(join(half, 'z', 'b.txt'), 'b\n')
      const runH = await makeCopy($, { folder: half, shown: half, provider: 'chatgpt' })
      writeFileSync(join(runH.tree, 'a.txt'), 'A\n')
      writeFileSync(join(runH.tree, 'z', 'b.txt'), 'B\n')
      const cH = await compare($, runH)
      chmodSync(join(half, 'z'), 0o555)
      const rH = await applyRun($, runH, cH)
      chmodSync(join(half, 'z'), 0o755)
      check('a half-written Apply is put back and never called applied', !rH.isOk && readFileSync(join(half, 'a.txt'), 'utf8') === 'a\n' && readFileSync(join(half, 'z', 'b.txt'), 'utf8') === 'b\n', JSON.stringify(rH))
      await removeRun($, runH.root)
    }

    // the hub's own git config, changed by someone, is written again before use: no filter runs
    const run7 = await makeCopy($, { folder: plain, shown: plain, provider: 'chatgpt' })
    const marker = join(root, 'filter-ran').replace(/\\/g, '/')
    writeFileSync(join(run7.git, 'config'), `[core]\n\tbare = true\n[filter "evil"]\n\tclean = touch '${marker}'\n\trequired = true\n`)
    writeFileSync(join(run7.tree, '.gitattributes'), '* filter=evil\n')
    writeFileSync(join(run7.tree, 'p.txt'), 'p2\n')
    await compare($, run7)
    check("a filter put into the hub's git config never runs", !existsSync(marker))
    // control: the same config, used as it is, does run the filter
    writeFileSync(join(run7.git, 'config'), `[core]\n\tbare = true\n[filter "evil"]\n\tclean = touch '${marker}'\n\trequired = true\n`)
    writeFileSync(join(run7.tree, 'p.txt'), 'p3\n')
    spawnSync('git', [`--git-dir=${run7.git}`, `--work-tree=${run7.tree}`, 'add', '-A'], { cwd: run7.tree, env: { ...process.env, GIT_INDEX_FILE: join(run7.root, 'control.index') } })
    check('control: that config, used as it is, runs the filter (so the check above means something)', existsSync(marker))

    // a record changed after the hub wrote it is not trusted
    const rec = store.get('hub-work-runs-v1') as Record<string, { folder: string }>
    rec[run7.id]!.folder = join(root, 'elsewhere')
    check('a run whose record was changed is refused', (await readRun($, run7.id)) === undefined)
    check('a run id that is a path is refused', (await readRun($, '..\\..\\x')) === undefined && (await readRun($, '../../x')) === undefined)
    await removeRun($, run7.root)

    // a change at the moment of git apply: the whole apply fails, and no file is written
    const race = join(root, 'race')
    mkdirSync(race)
    writeFileSync(join(race, 'one.txt'), 'one\n')
    writeFileSync(join(race, 'two.txt'), 'two\n')
    const run8 = await makeCopy($, { folder: race, shown: race, provider: 'chatgpt' })
    writeFileSync(join(run8.tree, 'one.txt'), 'ONE\n')
    writeFileSync(join(run8.tree, 'two.txt'), 'TWO\n')
    const c8 = await compare($, run8)
    beforeApply = () => writeFileSync(join(race, 'two.txt'), 'theirs\n')
    const r8 = await applyRun($, run8, c8)
    check(
      'a file changed between the check and git apply fails the whole apply: no file is written',
      !r8.isOk && readFileSync(join(race, 'one.txt'), 'utf8') === 'one\n' && readFileSync(join(race, 'two.txt'), 'utf8') === 'theirs\n',
      JSON.stringify({ r8, one: readFileSync(join(race, 'one.txt'), 'utf8') }),
    )

    // removal only touches a run's own folder
    await removeRun($, run4.root)
    check("a run's folder is removed", !existsSync(run4.root))
    await removeRun($, plain)
    check('any other folder is left alone', existsSync(join(plain, 'p.txt')))
    await cleanOldRuns($, Date.now() + 8 * 24 * 60 * 60 * 1000)
    check('runs older than a week are removed at clean-up', !existsSync(run.root) && !existsSync(run2.root) && !existsSync(run3.root))
    check('and their records with them', Object.keys((store.get('hub-work-runs-v1') as object) ?? {}).length === 0, JSON.stringify(store.get('hub-work-runs-v1')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

main().then(
  () => {
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
    process.exit(failures ? 1 : 0)
  },
  error => {
    console.error(error)
    process.exit(1)
  },
)
