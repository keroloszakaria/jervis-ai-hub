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

- A request sends only its prompt, run in an empty sandbox folder. A provider gets a project folder only when Claude passes one, and you are asked first (Settings → Privacy, on by default). Each provider of a fallback is asked on its own. "Allow this session" lasts for one session.
- Read-only requests can only read:
  - Codex runs in its own read-only sandbox.
  - OpenCode runs with permissions that deny everything but reading, globbing and searching, and deny every folder outside its own. A project's `opencode.json` cannot loosen them.
  - Antigravity runs with settings for that run alone that deny writes, commands, MCP tools and the web.
- These rules hold only on the CLI versions they were checked on: OpenCode 2.x (1.x reads another format and would ignore them) and Antigravity 1.5 or a later 1.x. On any other version, or one whose version cannot be read, the request is refused and nothing is sent. Codex keeps its own sandbox on every version.
- Files change only on a write you confirm: `ask_ai` with `mode: "write"`, or `delegate_ai`.

**Writes and delegation**

- Both kinds of write edit the working tree and cannot commit or push. Git refs are locked through environment config, and pushes go to a remote helper that does not exist.
- The hub reads every ref before and after. If any changed, it refuses the result and says what changed and how to undo it. It never undoes anything itself.
- A delegation counts only with a relay result that is provably its own: the relay's v1 schema, the agent that was asked, the file the relay named, and a brief beside it that carries this run's random token. Without one, the result is "unknown", never a success, whatever the exit code, and nothing it reported is passed on.

**What comes back**

- Answers have the request's key, and anything shaped like a provider key or bearer token, replaced with `[redacted]`.
- A background job's result comes back marked as another model's data, inside a tag with a random name, so it cannot pass as your words or as instructions.
- A job belongs to its session. When the session ends, its jobs on another AI are stopped, and a late result goes nowhere.

**What is kept**

- The activity log keeps metadata: time, provider, model, task, outcome, duration, tokens and cost. It keeps a prompt preview only if you turn on "Keep redacted prompt previews" (off by default), and then only redacted and short.
- Exports never include prompts, answers or error text.
- Usage is what each provider reports: the hub never estimates quota or cost. Subscription use is shown apart from API billing.
- A request that fails is never retried on its own. It goes to another provider only if you turn fallback on (off by default). A stopped or timed-out request never falls back. Identical read-only requests from one session share a run, so nothing is sent twice.

## Known limits

- **Antigravity's prompt is a command-line argument**, because its CLI takes it no other way. Other programs running as your user can see it while the request runs. Keys never go on a command line.
- **Read-only isolation relies on each CLI** honouring its own sandbox or permission settings. A CLI bug there is outside the hub's control.
- **The git guard is not an operating-system boundary.** An agent that clears its environment, changes git config or edits `.git` by hand gets past the lock. The check afterwards still finds a changed ref, but a push that gets past cannot be seen from local refs. If a result says refs changed, check the remote yourself. A sealed workspace (no `.git`, credentials or network) is not built yet.
- **While a write or delegation runs**, the repository's own git hooks (such as husky) do not run.
- **Checked on Windows only.** The isolation rules and the git guard were checked with the real CLIs on Windows. macOS and Linux run the same code and the same tests, but not with signed-in CLIs.
- **Folder approvals compare paths as written.** A symlink or junction is approved by the path you see, not by the folder it points to, which is not resolved.
- **A job on a Claude subagent** cannot be stopped from the band.
- `vendor/claude-code/index.d.ts` is Claude Code's, used only for type checking in CI. It is not shipped code (see `vendor/README.md`).
