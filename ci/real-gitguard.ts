// Runs the hub's own git guard (hooks/gitguard.ts) against the real git of the
// system it runs on, in a throwaway repository: the hooks and variables it
// writes, the refs it reads before and after. CI runs it on Linux, Windows and
// macOS. Run it by hand with: npx -y tsx@4.19.2 ci/real-gitguard.ts
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { changedFiles, guardEnv, refChanges, snapshot, workState } from '../hooks/gitguard'
import { osName } from '../hooks/platform'

// the few engine calls the guard makes, answered by this process
const $ = {
  env: { get: async (name: string) => process.env[name] },
  fs: {
    write: async (path: string, text: string) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    },
    exists: async (path: string) => existsSync(path),
    read: async (path: string) => readFileSync(path, 'utf8'),
  },
  process: {
    run: async (argv: string[], opts?: { timeoutMs?: number; stdin?: string }) => {
      const r = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', input: opts?.stdin, timeout: opts?.timeoutMs ?? 20_000 })
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

function git(cwd: string, args: string[], env?: Record<string, string>) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

async function main(): Promise<void> {
const root = mkdtempSync(join(tmpdir(), 'hub-gitguard-'))
try {
  const os = await osName($)
  console.log(`git guard on ${os}: ${git(root, ['--version']).out.trim()}`)

  const repo = join(root, 'repo')
  const remote = join(root, 'remote.git')
  mkdirSync(repo)
  git(root, ['init', '--bare', '-q', remote])
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.name', 'Hub CI'],
    ['config', 'user.email', 'ci@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['remote', 'add', 'origin', remote],
  ]) git(repo, args)
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, ['add', 'a.txt'])
  check('a commit without the guard works', git(repo, ['commit', '-q', '-m', 'first']).code === 0)
  check('a push without the guard works', git(repo, ['push', '-q', 'origin', 'main']).code === 0)

  const before = await snapshot($, repo)
  check('the repository is seen as one', before.isRepo && !before.failed && Boolean(before.head), JSON.stringify(before))

  const env = await guardEnv($, os)
  const refused = (what: string, args: string[], mark: RegExp) => {
    const r = git(repo, args, env)
    check(`${what} is refused by the guard`, r.code !== 0 && mark.test(r.out), r.out)
  }
  const HUB = /Jervis AI Hub/
  refused('commit', ['commit', '--allow-empty', '-m', 'x'], HUB)
  refused('commit --no-verify', ['commit', '--allow-empty', '--no-verify', '-m', 'x'], HUB)
  refused('a new branch', ['branch', 'side'], HUB)
  refused('a tag', ['tag', 'v1'], HUB)
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  refused('stash', ['stash'], HUB)
  refused('push', ['push', 'origin', 'main'], /jervis-blocked/)
  refused('push to a URL', ['push', remote, 'main'], /jervis-blocked/)

  const works = (what: string, args: string[]) => {
    const r = git(repo, args, env)
    check(`${what} still works`, r.code === 0, r.out)
  }
  works('status', ['status', '--short'])
  works('diff', ['diff', '--stat'])
  works('add', ['add', 'a.txt'])

  const after = await snapshot($, repo)
  check('no ref changed under the guard', refChanges(before, after).length === 0, refChanges(before, after).join('\n'))

  // the check afterwards finds a commit made without the guard
  git(repo, ['commit', '-q', '-m', 'second'])
  const moved = refChanges(before, await snapshot($, repo))
  check('a commit made past the guard is found', moved.some(c => c.startsWith('HEAD moved')), moved.join('\n'))

  // a bare repository and the .git folder are repositories too: their refs are read and guarded
  const bare = await snapshot($, remote)
  check('a bare repository is read as one, with its refs', bare.isRepo && !bare.failed && Object.keys(bare.refs).some(r => r === 'refs/heads/main'), JSON.stringify(bare))
  const dotGit = await snapshot($, join(repo, '.git'))
  check('the .git folder is read as the repository', dotGit.isRepo && !dotGit.failed && Boolean(dotGit.head), JSON.stringify(dotGit))

  const plain = join(root, 'plain')
  mkdirSync(plain)
  const none = await snapshot($, plain)
  check('a folder outside any repository is not one', !none.isRepo && !none.failed, JSON.stringify(none))
  const sub = join(repo, 'src', 'deep')
  mkdirSync(sub, { recursive: true })
  const inner = await snapshot($, sub)
  check('a subfolder of the repository is read as the repository', inner.isRepo && !inner.failed, JSON.stringify(inner))

  // the changed files the hub lists itself: a file already changed and left alone is not one
  writeFileSync(join(repo, 'left-alone.txt'), 'mine\n')
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  const w1 = await workState($, sub)
  writeFileSync(join(repo, 'a.txt'), 'three\n')
  mkdirSync(join(repo, 'new dir'))
  writeFileSync(join(repo, 'new dir', 'n.txt'), 'n\n')
  const w2 = await workState($, sub, w1)
  const files = w1 && w2 ? changedFiles(w1, w2) : []
  check(
    'the hub lists the files changed since it looked, from any subfolder, and nothing else',
    JSON.stringify(files) === JSON.stringify(['a.txt', 'new dir/n.txt']),
    JSON.stringify({ files, w1, w2 }),
  )
  check('a folder outside any repository has no working tree to read', (await workState($, plain)) === undefined)

  // a run that adds a filter to the repository's config: the hub's git does not run it, and says why
  const marker = join(root, 'filter-ran').replace(/\\/g, '/')
  git(repo, ['config', 'filter.evil.clean', `sh -c 'echo ran > "${marker}"; cat'`])
  writeFileSync(join(repo, '.gitattributes'), '*.txt filter=evil\n')
  writeFileSync(join(repo, 'a.txt'), 'four\n')
  const w3 = await workState($, sub, w2)
  check('a filter added during the run is never run by the hub, and the list says why', Boolean(w3?.isGuardChanged) && !existsSync(marker), JSON.stringify({ w3, ran: existsSync(marker) }))
  git(repo, ['config', '--unset', 'filter.evil.clean'])
  rmSync(join(repo, '.gitattributes'))
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
