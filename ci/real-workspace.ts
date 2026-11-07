// Runs the hub's workspace copy (hooks/workspace.ts) against the real git of
// the system it runs on, in throwaway folders: copy, change (binary files
// included), compare, apply, and an apply refused after the folder changed.
// CI runs it on Linux, Windows and macOS. By hand: npx -y tsx@4.19.2 ci/real-workspace.ts
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { applyRun, changedSince, cleanOldRuns, compare, isLeftOut, makeCopy, readRun, removeRun } from '../hooks/workspace'

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'hub-workspace-')))
const home = join(root, 'home')
mkdirSync(home)

// the plugin store, in memory; and a hook run just before `git apply`, to change the folder at that moment
const store = new Map<string, unknown>()
let beforeApply: (() => void) | undefined

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
    list: async (path: string) =>
      readdirSync(path, { withFileTypes: true }).map(d => ({ name: d.name, kind: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other', size: 0, mtimeMs: 0, isLink: d.isSymbolicLink() })),
  },
  process: {
    run: async (argv: string[], opts?: { timeoutMs?: number; stdin?: string; cwd?: string; env?: Record<string, string> }) => {
      if (argv.includes('apply') && beforeApply) {
        beforeApply()
        beforeApply = undefined
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
