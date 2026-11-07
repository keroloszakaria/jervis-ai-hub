# Security

## Supported versions

Only the latest release gets security fixes. Update with `claude plugin update ai-subscriptions@jervis-ai-hub`.

## Reporting a problem

Report it privately to the maintainer, Kerolos Zakaria, on GitHub. Do not open a public issue. Say what you did, what happened, and the version (`.claude-plugin/plugin.json`). Leave real keys and private prompts out of the report.

## What the hub protects

**Credentials**

- An API key is typed into a masked system dialog, never into the pane. It is kept in the system's secure storage: Windows DPAPI (bound to your user account), the macOS Keychain or the Linux Secret Service. It is never shown, logged, stored in plain text or put on a command line; a CLI gets it in its environment or on stdin.
- Subscriptions are signed in through each provider's own CLI. The hub never reads another application's session tokens or browser cookies.
- A saved key is not taken as proof that it works. A provider reads as verified only after a real check. "Test right after connecting" sends one real prompt, so it is off by default.

**What leaves your machine**

- A request sends its prompt, run in an empty sandbox folder. That folder limits what each CLI can read: OpenCode and Antigravity through their own rules, Codex through the hub's permission profile in its sandbox (below). A provider gets a project folder only when Claude passes one, and you are asked first (Settings → Privacy, on by default). Each provider of a fallback is asked on its own. "Allow this session" lasts for one session, and belongs to the folder a symlink or junction leads to: a link to another folder is asked about on its own, and the question names its target. The folder is resolved once, when it is asked about, and the CLI then runs in that resolved folder, so a link changed after the question changes nothing. A folder that cannot be resolved (missing, unreadable, a link that leads nowhere) is refused before anything is asked or sent. Each run's `PWD` is set to its own folder, because OpenCode takes its folder from `PWD` before the process's own.
- Read-only requests cannot write:
  - Codex runs under the hub's own permission profile (`hubread`, `hubwrite`): its filesystem is denied except Codex's own minimal system files and the run's folder, read-only or writable. On Windows this needs Codex's MXC sandbox (`windows.sandbox="mxc"`); its other Windows sandboxes cannot deny reads. Before the first Codex request on each Codex build, the hub checks it with `codex sandbox` (commands only: no model, nothing sent): each profile must read a file the hub put in its folder and must not read one the hub put outside it. If the check fails or cannot run, Codex is refused and nothing is sent, unless you turn on "Allow Codex without read isolation" in Settings → Privacy. Then Codex runs in its older read-only or `workspace-write` sandbox, which stops writes outside the folder but not reads, and the answer says so. Diagnostics shows the check's result.
  - OpenCode runs with permissions that deny everything but reading, globbing and searching, and deny every folder outside its own. A project's `opencode.json` cannot loosen them.
  - Antigravity runs with settings for that run alone that deny writes, commands, MCP tools and the web.
- These rules hold only on the CLI versions they were checked on: OpenCode 2.x (1.x reads another format and would ignore them) and Antigravity 1.5 or a later 1.x. On any other version, or one whose version cannot be read, the request is refused and nothing is sent. Codex is checked on each build by the probe above instead.
- Files change only on a write you confirm: `ask_ai` with `mode: "write"`, or `delegate_ai`.
- Writes on Antigravity, whose writes and delegations are not held to the folder, are off. They are refused, before anything is asked or sent, unless you turn on "Allow writes not held to the folder (Antigravity)" (Settings → Privacy, off by default). Then the question says it can change any file you can.
- An OpenCode write gets its file tools only (read, search, edit, write), inside its folder: everything else is denied, its shell and `execute` tools included, so it runs no commands. A deny of outside folders alone was not enough (see Checked versions).

**Writes and delegation**

- Both kinds of write edit the working tree and cannot commit or push. Git refs are locked through environment config, and pushes go to a remote helper that does not exist.
- The hub reads every ref before and after. If any changed, or the refs cannot be read afterwards, it refuses the result, says what changed and how to undo it, and marks the run failed in the activity log. It never undoes anything itself.
- After a write or delegation in a repository, the hub lists the files that changed from its own reading of the working tree (git status and content hashes, before and after), never from the agent's or the relay's report. A file already changed before is listed only if the run changed it again. The list holds every change made while the run went on, by anyone, and says so. Outside a repository the answer says the hub cannot list them.
- A folder git calls "not a git repository" is written without the guard. A folder with a `.git` in it or in any folder above it, whose refs git cannot read (git missing, an unsafe-ownership refusal), is refused before anything runs.
- A delegation counts only with a relay result of its own. The hub names the relay's artifact folder (`--out-dir`, under `~/.claude/jervis-ai-hub/relay`, named with the run's random token) and reads `result.json` from there, never from a path the run reports. The result must have the relay's v1 schema and the agent that was asked, and the brief the relay copied there must carry the token. Without that, the result is "unknown", never a success, whatever the exit code, and nothing it reported is passed on. With it, a success also needs the relay's exit code to be 0.

**What comes back**

- Answers have the request's key, and anything shaped like a provider key or bearer token, replaced with `[redacted]`.
- A background job's result comes back marked as another model's data, inside a tag with a random name, so it cannot pass as your words or as instructions.
- A job belongs to its session. When the session ends, its jobs on another AI are stopped, and a late result goes nowhere.

**What is kept**

- The activity log keeps metadata: time, provider, model, task, outcome, duration, tokens and cost. It keeps a prompt preview only if you turn on "Keep redacted prompt previews" (off by default), and then only redacted and short.
- Exports never include prompts, answers or error text.
- Usage is what each provider reports: the hub never estimates quota or cost. Subscription use is shown apart from API billing.
- A request that fails is never retried on its own. It goes to another provider only if you turn fallback on (off by default). A stopped or timed-out request never falls back. Identical read-only requests from one session share a run, so nothing is sent twice.

## Checked versions

The CLIs' isolation rules are checked by hand with the real CLIs, on Windows 11 (build 26200), with `ci/real-cli.ts`. It sends real prompts the way the hub does. A refusal check passes only when the effect is absent, the CLI's own output shows the refusal (a denied tool call, a sandbox error, Antigravity's `denied_actions`) and a control run beside it (a read or write inside the folder) worked; anything else is inconclusive. The script exits 1 when a check failed, 3 when any was inconclusive or a CLI was missing, and 0 only when all passed, and writes every run (system, CLI path and version, the commands, the refusals seen, the output's end) to an evidence file under `~/.claude/jervis-ai-hub/evidence`. The "outside" folder is under your home, not the temp folder. Last run on 2026-11-07. The hub allows a whole version family. A patch or minor release inside it is trusted to keep its permission format, but has not been re-checked. Diagnostics (Settings) shows each installed CLI as checked, allowed but not checked itself, or refused.

| CLI | Version checked | Allowed | What was checked |
| --- | --- | --- | --- |
| OpenCode | 2.1.4 | 2.x | Read-only: reading inside the folder works, writing is denied, reading outside is denied, a project `opencode.json` that allows everything cannot loosen the rules. Write: inside works; outside is denied, through the shell and `execute` tools too, and with a project `opencode.json` that allows everything. The earlier write rule (deny outside folders only) failed this check: the model wrote outside through its shell and its `execute` tool. On the last run, the free tier's limit was reached before the plain write-outside check, so it read inconclusive; it passed on the run before. |
| Antigravity | 1.5.3 | 1.5 and later 1.x (read-only) | Read-only: a read inside the folder works, a write is denied, a read outside is denied (all three passed, refusals seen). Writes are off in the hub (see Known limits). |
| Codex | 0.167.0-alpha.3.2, Windows 11 build 26200 with MXC | any build whose probe passes | With the hub's profiles: read-only: a read inside works, a write is denied, a read outside is denied. Write: inside works, a write outside (under your home) is denied. All five passed, refusals seen. Without a profile (0.9.11 and the "without read isolation" setting), a read outside was not denied. Under MXC, Codex's temp folder is its own: the real temp folder is denied for reads and writes. Codex's `elevated` Windows sandbox refuses the profiles; `unelevated` cannot deny reads. |
| git | each CI runner's git, on every push | any | `ci/real-gitguard.ts` runs the hub's own guard with real git on Linux, Windows and macOS: commit (with and without `--no-verify`), branch, tag and stash are refused, every push fails, status, diff and add work, a commit made past the guard is found, and a subfolder of a repository is read as the repository. By hand on Windows, Git for Windows 2.56 also refuses fetch. |

Apart from git, macOS and Linux run the same code and the same mocked tests in CI, but the CLI rows were not checked there: that needs signed-in CLIs, which CI does not have.

## Known limits

- **Antigravity's prompt is a command-line argument**, because its CLI takes it no other way. Other programs running as your user can see it while the request runs. Keys never go on a command line.
- **Read-only isolation relies on each CLI** honouring its own sandbox or permission settings. A CLI bug there is outside the hub's control.
- **The git guard is not an operating-system boundary.** An agent that clears its environment, changes git config or edits `.git` by hand gets past the lock. The check afterwards still finds a changed ref, but a push that gets past cannot be seen from local refs. If a result says refs changed, check the remote yourself. A sealed workspace (no `.git`, credentials or network) is not built yet.
- **While a write or delegation runs**, the repository's own git hooks (such as husky) do not run.
- **Codex delegations are not read-isolated.** The relay runs Codex with its own `workspace-write` mode and cannot be given the hub's profile yet, so a Codex delegation can read any file your account can. `ask_ai` requests are held by the profile.
- **Codex permission profiles are a beta Codex feature,** and the probe checks one read in and one read out per profile. A Codex change that holds those two files but not others would pass it. The probe runs again on each new Codex build.
- **With "Allow Codex without read isolation" on,** a Codex request can read any file your account can (another project, `~/.ssh`) and send it to OpenAI.
- **Antigravity writes are not held to the folder.** An `ask_ai` write runs in its accept-edits mode, and a delegation through a relay runs with the relay's own settings. So they are off unless you allow them; once allowed, nothing holds them to the folder.
- **The changed-file list reads git's view.** It cannot tell the agent's changes from yours or another program's made during the run. It covers a git repository only, compares at most 5,000 changed files (and says so past that), and an agent that edits git's index or config can hide a change from it, as with the git guard.
- **CLI rules checked on Windows only, by hand.** The CLIs' rules were checked with the real CLIs on Windows. CI does not run them: that needs signed-in CLIs, which means keeping accounts in CI. The git guard is checked with real git on all three systems in CI.
- **A relay result is bound to its run, not sealed.** The check stops an old or another run's result from passing as this one. It does not stop an agent that sets out to forge one: the artifact folder is under `~/.claude`, outside the repository and the temp folder that Codex's `workspace-write` sandbox may write, but Antigravity's delegation runs without its own permission checks and can write anywhere you can. The token is in the brief the agent reads.
- **A job on a Claude subagent** cannot be stopped from the band.
- `vendor/claude-code/index.d.ts` is Claude Code's, used only for type checking in CI. It is not shipped code (see `vendor/README.md`).
