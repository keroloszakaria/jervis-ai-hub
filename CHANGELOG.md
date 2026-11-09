# Changelog

## Unreleased

- **The repository is public:** anyone can install the mod with the command in the README; no GitHub access is needed.
- **Claude Code's declarations are no longer in the repository:** `vendor/claude-code/index.d.ts` belonged to Claude Code, not to this project. CI no longer type-checks; run the type check locally, where Claude Code writes the declarations.
- **User manual** in English and Arabic: `docs/USER_MANUAL.md`, `docs/ar/USER_MANUAL.md`.

## 0.11.0

Core hardening. The full list, with evidence and tests, is in `docs/audits/CORE_HARDENING_AUDIT.md`.

- **Antigravity prompts stay off the command line:** the prompt goes to `agy` on stdin, as a stream-json message, so other programs cannot read it in the process list. Long, multiline and Unicode prompts are sent whole; the old length limit is gone.
- **Junctions cannot reach outside the project:** a folder inside the project that leads out of it (a Windows junction or a linked folder) is left out of the copy. An Apply through one is refused, including a folder made into one after the copy.
- **A half-written Apply is put back:** if git fails part way, the files it wrote are restored and the answer says so. If they cannot be restored, the answer names them.
- **No loops between hubs:** every CLI the hub starts is told it runs under a hub (`JERVIS_HUB_DEPTH`). A hub inside such an agent sends nothing on.
- **Limits read as they are:** one spent account-wide window means the provider is spent. Model groups match whole words only. Unknown and old readings are never treated as free, and each provider and model has one of these states: available, limited, exhausted, stale, unknown, unsupported.
- **Routing rules must suit the task:** a rule whose model the provider no longer offers, or whose model lacks what the task needs (image input for vision), is skipped, and the reason names it. A fallback with smart routing off keeps that check.
- **Heavy work is not stepped down:** with no model that serves heavy work, the request is refused instead of going to a weaker level. Equal picks go the same way every time.
- **Delegations can be stopped:** a relay delegation has a 30-minute limit and a Stop. A stopped CLI the hub cannot confirm ended is reported as possibly still running.
- **The hub's own git runs nothing of the repository's:** no fsmonitor hook and no filters. If a run changed `.git/config` or the attributes files, the hub does not run git on the repository again, and says so.
- **Jobs after a reload:** jobs on another AI that a reload cut off end as failed and free their slots. An earlier session's job results do not show in the next session.
- **Smaller fixes:**
  - A bare repository is guarded like any other.
  - A run kept for later is checked against the folder of the session applying it.
  - `compare_ai` names each provider it left out.
  - "Declined" now reads "declined, or nobody could be asked".
- **One core, more hosts:** the tools are described and run in one place (`hooks/tools.ts`), and `dist/jervis-mcp.mjs` serves them over MCP (stdio) from the same modules, for the Codex and Antigravity plugins. There nobody can be asked for an approval, so project reads, writes and delegation are not sent, and kept changes are applied only from the person's own terminal (`node dist/jervis-mcp.mjs apply <run>`). `ci/mcp-smoke.ts` checks the server over stdio on every OS.
- **Tests:** 17 new regression tests, and new real-git checks for junctions, filters and bare repositories.

## 0.10.11

The pane in Arabic reads from the right:

- **Right to left:** with the language set to Arabic, every row runs from the right (labels on the right, their controls on the left, the tabs in reading order), and a line of text or a button on its own sits at the right edge. Before, only the letters were ordered right to left; the layout stayed left to right.
- **Mixed lines read correctly:** on the desktop, Arabic text is put in a right-to-left run, so a line that mixes in English words, model names or numbers reads from the right. The terminal orders the letters itself and is left as it was.
- **More of the pane in Arabic:** the reason for each smart pick (“your chosen model, 52% of plan left”), the routing hint, the page name beside the title, statuses after their mark (“◐ Not tested”), the level descriptions, In use, Favorites, and the limit hints added in 0.10.10.
- **A narrow pane kept hints in English:** a long hint was cut to fit before it was translated, so the cut English had no Arabic. It is now translated, then cut.
- **Tests:** the Settings page in Arabic on the desktop and in the terminal, and in English, which keeps its rows as written.

## 0.10.10

Old limit readings stop steering the router:

- **A window past its reset time no longer counts:** a provider whose reported windows have all reset since they were read is routed to again. The Limits view shows "reset since this reading" in place of the old share.
- **A reading older than 30 minutes decides nothing:** it neither leaves a provider out nor counts as free. The smart pick's reason says "limits not read recently, so unknown" and gives no share of the plan left. The Limits view marks the reading as old and offers Refresh.
- **A reading under way keeps its time:** while limits are read again, the old windows stay marked with the time they were read, so they do not look new.
- **Tests:** on a set clock, windows before and after their reset (Smart routing on and off), and a reading 31 minutes old.

## 0.10.9

Consent before a prompt moves to another provider:

- **A fallback asks first, even with no folder:** when the provider you chose fails and fallback is on, the hub asks before the prompt goes to the next provider: "Send the prompt to … instead?", with Allow once, Allow this session and Deny. Before, the hub asked only when a project folder was involved.
- **A no stops the fallback:** Deny, or a question closed without an answer, sends nothing to that provider or any after it. The answer says so.
- **Allow this session** covers that provider for the rest of the session only. Another session asks again.
- **Activity shows a declined fallback:** a refused row names the provider and the one it would have fallen back from. This holds with a folder too.
- **Tests:** Deny and a closed question with three providers connected, and a session grant that does not carry over to another session.

## 0.10.8

A routing order you can see:

- **The default provider comes before the smart pick:** with Smart routing on, a request with no provider named and no rule for its task goes to your default provider, with that provider's best model for the task and level. Before, Smart routing passed over the default provider. With no default provider set, nothing changes.
- **What was passed over is named:** "routing rule for code: DeepSeek not ready", or "default provider DeepSeek skipped: ..." in the reason.
- **The Settings tab shows the same pick** the request would make, default provider included.
- **Tests:** a table of seven cases (rule, default and smart on and off, a provider not ready). In each, the preview and the request go to the same provider for the same reason.

## 0.10.7

A sign-in is checked before it is used:

- **Not known is not ready:** a provider whose sign-in has not been checked yet, or whose check could not run, is no longer taken as signed in. The router leaves it out, and a request named for it checks the sign-in first (locally, no prompt) and waits for the answer. A preview says "its sign-in has not been checked yet" and runs nothing.
- **One check at a time:** a request that needs a check already under way, such as the one at session start, waits for it rather than starting another.
- **A refused sign-in sticks:** when a provider refuses a request for its sign-in or key, the hub marks it signed out and does not route to it again until you connect it again, or a new session's check finds it signed in.
- **Tests:** a check that could not run at start is run again with the request (signed out: nothing sent; signed in: the request runs), and a 401 marks the provider signed out, so it is refused by name and left out of routing.

## 0.10.6

Fallback that stops on what another provider cannot fix:

- **Only some failures fall back:** with fallback on, a request goes to another provider only after a limit, a network problem or a provider that could not take it. A sign-in problem, an error the hub cannot name, a refusal, a stop or a timeout ends the request. Before, every failure but a stop or a timeout went on to the next provider.
- **A refusal is never fallen back from:** when the hub refuses a request before sending it (Codex without read isolation, an OpenCode or Antigravity version whose rules it has not checked), no other provider gets the prompt.
- **The answer says why it stopped:** "no other provider was tried after this failure", with the kind.
- **Failures read from the CLI's JSON first:** an HTTP status (429, 401/403, 5xx) or an error name (OpenCode's `ProviderAuthError`) decides the kind before the words do. A CLI that cannot be started reads as not available.
- **Tests:** a table of kinds, statuses and error events from Codex and OpenCode, and three requests: an unknown failure sends nothing on, a limit falls back, an isolation refusal sends nothing on.

## 0.10.5

Review and apply, finished:

- **One review at a time:** when two runs end together, the second question and its Review changes pane wait for the first answer, so the pane never shows one run while you answer for another.
- **Strict apply:** a file changed in the folder while the changes were applied would hold both changes. The hub now takes the run's changes back out of every file, keeps the other change, names the file and keeps the run. 0.10.4 kept both and named the file.
- **What a failed copy leaves is cleaned up:** a scan that cannot be removed refuses the copy. At the next session start, anything more than ten minutes old is removed: a leftover scan, or a run folder with no record. A copy still being made in another session is left alone.
- **Checked with real git:** a merged change taken back out of every file of the run, a removal that fails, and the clean-up that follows. In the tests: two runs that end together are reviewed one after the other.

## 0.10.4

Review and integrity:

- **Each file's diff before you answer:** beside the Apply, Keep for later or Discard question, a Review changes pane lists each file the run changed with its added and deleted lines, and opens each one's diff. Binary files are named as such, and a link the run made is marked as never applied. Where no pane is drawn, the question carries the first few diffs itself. The pane closes once you answer.
- **A file left out of the copy leaves nothing behind:** the files are scanned in a repository of the run's own that is removed before the run starts. Only what the scan keeps is stored for the run, so no git object holds a file with a key inside, or what `.jervisignore` names. A file that changes between the scan and the copy refuses the copy.
- **After an Apply, each file is read again:** a file that also had another change made in the folder meanwhile (git merged both) is named, so you can check it.
- **A run kept in another session applies only to this session's folder,** or a folder inside it.
- **Checked with real git:** no object of a left-out file in the run's git (with a control), the scan removed, a file changed between scan and copy, each file's diff and a binary file, and a change made meanwhile elsewhere in a file kept and named.
- Not changed: Antigravity writes are still held by no folder (off by default). The real CLI checks on macOS and Linux have not run.

## 0.10.3

Workspace integrity:

- **Kept runs can no longer be pointed elsewhere:** the hub keeps what a run is (its folder, its base) in its memory and its plugin store, not in a `run.json` beside the copy, where an agent allowed to write anywhere could change it. The run's paths come from its id, a record changed during the session is refused, and the question names the folder an Apply would write.
- **The hub's git config is written again before each use,** so a filter or external diff put into it runs nothing.
- **Links and submodules stay out of the copy,** and a run that makes one is never applied.
- **Keys are found by what they look like:** a text file with a private key block or an AWS, GitHub, OpenAI, Anthropic, Google, Stripe live or Slack key is left out of the copy, whatever its name.
- **`.jervisignore`:** `.gitignore` patterns in a project's root name more files to leave out.
- The answer says why each file was left out.
- **Checked with real git:** a key in `config/prod.json`, `.jervisignore`, links (on Linux and macOS), a filter in the hub's config (with a control run), a changed record, and a file changed at the moment of `git apply`: the whole apply fails and no file is written. The real Codex gate passes all 8 checks.
- Not changed: the review still shows the file list and the patch's path, not each file's diff (planned for 0.10.4).

## 0.10.2

Writes go to a workspace copy:

- **A write runs in a copy, and you decide what reaches the folder:** an `ask_ai` write or a `delegate_ai` runs in a copy of the folder under `~/.claude/jervis-ai-hub/work`. The copy has no `.git`, no ignored files, and none of the usual secret files (`.env`, keys, `.npmrc`). The hub then names the changed files and the patch and asks: Apply, Keep for later, or Discard. Nothing is staged or committed.
- **An Apply never overwrites your edits:** if any file the run changed was changed in the folder after the copy, nothing is applied and those files are named.
- **`apply_changes`** asks again about a run kept for later. Kept runs are removed after 7 days.
- **Your own `.git` is only read:** the copy, the compare and the apply use a git repository of the hub's own for each run.
- The changed-file list is the run's own, no longer "by anyone".
- **"Write straight into the folder"** (Privacy, off by default) gives back the old behaviour.
- **Checked:** `ci/real-workspace.ts` runs copy, compare and apply with real git (binary files, line endings, a deleted file, refusals) and runs in CI on all three systems. `ci/real-cli.ts codex` adds three copy checks with the real Codex: `.env` is not in the copy, a write lands in the copy and not the folder, and Apply writes it. All 8 Codex checks pass on Windows 11.

## 0.10.1

- **Codex delegations are held to the folder too:** the relay cannot give Codex the hub's permission profile (it always passes `--sandbox`, which wins over a profile). A Codex delegation now runs without the relay: the hub runs Codex itself, as for an `ask_ai` write, under its `hubwrite` profile, with the same probe, refusal, folder question, git guard and changed-file list. Only Antigravity delegates through the relay.
- Not checked with the real Codex on its own: it is the same command as an `ask_ai` write, which `ci/real-cli.ts` checks.

## 0.10.0

Codex reads are held to the folder:

- **Codex runs under the hub's permission profile:** each request runs with a profile of the hub's own (`hubread` or `hubwrite`) that denies the filesystem except Codex's minimal system files and the run's folder. On Windows it runs in Codex's MXC sandbox, the one that can deny reads. Checked with the real Codex on Windows 11: a read outside the folder is now denied, where 0.9.11's check failed; all five Codex checks pass.
- **A probe before the first request, and Codex is refused if it fails:** on each Codex build the hub runs `codex sandbox` with each profile (commands only, no model, nothing sent). Each must read a file in its folder and must not read one outside it. When the check fails or cannot run (no MXC, an older Windows), the Codex request is refused before anything is sent.
- **"Allow Codex without read isolation"** in Settings → Privacy runs Codex in its older sandbox instead, which stops writes outside the folder but not reads. The answer says it ran so.
- **Diagnostics shows Codex read isolation:** held, or why not.
- Requests that start together share one probe.
- **Not yet:** Codex delegations through the relay keep the relay's own sandbox and are not read-isolated. Writes still edit your working tree; the workspace copy is the next step (`docs/design/0.10.0-isolation.md`).

## 0.9.11

Security fixes and a stricter check with the real CLIs:

- **Antigravity writes are off unless you allow them:** Antigravity's writes and delegations are not held to the folder, so they are now refused before anything is asked or sent. Turn on "Allow writes not held to the folder (Antigravity)" in Settings → Privacy to allow them; the question then says it can change any file you can.
- **`ci/real-cli.ts` is a gate:** a refusal check passes only when the effect is absent, the CLI's own output shows the refusal, and its control run worked. The script exits 1 on a failed check, 3 on any inconclusive one or a missing CLI, 0 only when all passed, and writes an evidence file for each run. It now checks Codex too, and the "outside" folder is under your home, not the temp folder.
- **Codex reads are not held to the folder:** the new Codex check found that a read-only Codex request can read a file outside its folder. Its sandbox stops writes, not reads. The hub cannot limit this yet; `SECURITY.md` now says so where it describes what leaves your machine, and the check stays failed.
- **The changed-file list says whose changes it holds:** every change made while the run went on, by anyone.

## 0.9.10

Security fixes, two of them found by the new check with the real CLIs:

- **OpenCode writes stay in their folder:** a write through OpenCode now gets its file tools only (read, search, edit, write), inside the folder you approved. Checked with OpenCode 2.1.4, the old rule (deny outside folders) stopped the write tool only: the model wrote outside through its shell, and through its `execute` tool, which moved the session to another folder. 0.9.9's `SECURITY.md` said a write outside was denied; that held for the write tool alone. An OpenCode write now runs no commands.
- **OpenCode runs in the folder the hub gives it:** OpenCode takes its folder from the `PWD` environment variable before the process's own folder. A `PWD` inherited from the shell Claude was started in could root a read-only request in that project instead of the empty sandbox. Every request and delegation now sets `PWD` to its own folder.
- **The hub lists the changed files itself:** after a write or a delegation in a git repository, the hub reads the working tree with its own git (status and content hashes, before and after) and lists the files that changed. The relay's own list is no longer used. A file you had already changed is listed only if the run changed it again. Outside a repository the answer says the hub cannot list them.
- **A delegation succeeds only with a clean exit:** the relay must report "completed" and exit with 0.
- **A folder that cannot be resolved is refused:** a project folder that is missing, unreadable or a link that leads nowhere is refused before anything is asked or sent. Before, the hub fell back to the path as given.
- **A check with the real CLIs:** `ci/real-cli.ts`, run by hand, sends real prompts to OpenCode and Antigravity the way the hub does and checks each isolation rule, with a control run beside each refusal so a model that never tried reads as inconclusive, not as a pass.

## 0.9.9

Security fixes:

- **A subfolder of a repository is guarded:** when git cannot read a folder's refs, the hub now looks for a `.git` in that folder and in every folder above it, as git does. A write or delegation in a subfolder of such a repository is refused, where before it ran without the guard.
- **The CLI runs where you approved:** a project folder is resolved once, when you are asked about it, and the CLI then runs in that resolved folder. A symlink or junction changed after the question changes nothing.
- **Relay results outside the temp folder:** a delegation's artifact folder is now under `~/.claude/jervis-ai-hub/relay`, which Codex's `workspace-write` sandbox does not write (it may write the temp folder). Antigravity's delegation can still write anywhere, as `SECURITY.md` says.
- **The git guard is checked with real git in CI:** `ci/real-gitguard.ts` runs the hub's own guard against real git on Linux, Windows and macOS on every push. It checks that commit (with and without `--no-verify`), branch, tag, stash and push are refused, that status, diff and add work, that a commit made past the guard is found, and that a subfolder is read as its repository.
- **Diagnostics shows how each CLI version stands:** checked, allowed but not checked itself (with the version that was checked), or refused.

## 0.9.8

Security fixes:

- **A refused write reads as failed in the activity log:** when an `ask_ai` write is refused because git refs changed, its own activity row now says so too, so the log and its counts match what Claude was told.
- **A git check that fails stops the write:** a folder git calls "not a git repository" is written without the guard, as before. A folder with a `.git` whose refs git cannot read (git missing, an unsafe-ownership refusal, refs that cannot be listed) is refused before anything runs, for `ask_ai` writes and delegations alike. Refs that cannot be read afterwards refuse the result.
- **The hub picks where the relay writes its result:** a delegation passes `--out-dir`, a folder in the hub's temp folder named with the run's token, and reads `result.json` from there. It no longer reads a path from the relay's output or from the result itself.
- **Folder approvals follow links:** a project folder is approved by where a symlink or junction leads. A link to an approved folder is not asked again, and a link to another folder is asked about on its own, with its target named in the question.
- `SECURITY.md` has a table of the CLI versions the isolation rules were checked on, what was checked and what is allowed, and says plainly that a relay result is bound to its run but not sealed against an agent that forges one.

## 0.9.7

Security fixes:

- **`ask_ai` writes get the git guard:** a write through `ask_ai` (`mode: "write"`) now runs like a delegation. Git refs are locked while it writes, pushes go nowhere, and the hub reads every ref before and after. If any changed, the answer is refused with what changed and how to undo it. Before, only `delegate_ai` had this.
- **A delegation needs a result of its own:** the relay's `result.json` must have the relay's v1 schema, come from the agent that was asked, be the file the relay named, and sit beside a brief carrying this run's random token. A missing, unreadable or foreign result now reads "unknown", never "completed", whatever the exit code, and nothing it reports is passed on.
- **CLI versions are checked:** OpenCode requests run only on OpenCode 2.x, whose permission format the hub writes; 1.x reads another format and would ignore the rules. Read-only Antigravity requests run only on 1.5 or a later 1.x. On any other version, or one whose version cannot be read, the request is refused and nothing is sent.
- `SECURITY.md` now says that writes come from `ask_ai` too, and names more limits: the git guard is not an operating-system boundary, the checks with real CLIs were made on Windows only, and folder approvals do not resolve symlinks.

## 0.9.6

Fixes for background jobs:

- **Never more than four at once:** a slot is taken the moment `start_job` is called, before anything is awaited, so many jobs started together can no longer pass the limit between the check and the start.
- **A job belongs to its session:** when a session ends (exit, `/clear`, resume), its jobs on another AI are stopped and their slots freed. A job that ends after its session did adds nothing to the next conversation: no result, toast or notice, and its row says the result was dropped. `job_status` gives a whole result only to the session whose job it was; another session sees the row's short summary.
- **Results kept in bounds:** at most 50 results of up to 200,000 characters each are kept; the oldest go first.
- **A stop before the CLI starts counts:** stopping a request (or a job) while it is still getting ready now stops it before its CLI starts, and nothing is sent. Before, that stop did nothing.

## 0.9.5

Security fixes:

- **OpenCode read-only requests can only read:** OpenCode's own default allows every tool, so a read-only request could write files and reach folders outside its own. A read-only request now runs with permissions (`OPENCODE_CONFIG_CONTENT`) that deny everything, allow reading, globbing and searching, and deny every folder outside the one it runs in. These rules win over a project's `opencode.json`. A write you allowed for a folder may not reach outside that folder.
- **Antigravity read-only requests deny writes, commands, MCP tools and the web** for that run (`--settings`, never saved), whatever allow rules your own Antigravity settings hold. Reads inside the folder still work; a read outside it is refused, as headless mode cannot ask.
- Codex keeps its own read-only sandbox, as before.

## 0.9.4

Security fixes:

- **A delegation cannot commit or push:** `delegate_ai` runs the relay with git config set through the environment, so every git the agent starts refuses any change to git refs (commit, branch, stash, merge, reset, fetch), even with `--no-verify`, and sends every push to a remote helper that does not exist. `status`, `diff` and `add` still work.
- **Checked afterwards:** the hub reads every ref (HEAD, branches, tags, remote-tracking refs) itself before and after the delegation. If any changed, the result is refused with what changed and, where it applies, the `git reset --soft` that keeps the work as uncommitted changes. The hub never undoes anything itself. A push that got past the guard cannot be seen from the local refs, so check the remote yourself if the result says refs changed.
- While a delegation runs, the repository's own git hooks (such as husky) do not run.

## 0.9.3

Security fixes:

- **Job results are marked as data:** a job's result comes back to Claude inside a tag with a random name, after a line saying which model wrote it, that it is not the person's words, and that requests in it are not instructions. A result cannot close the tag, because it cannot know its name. `job_status` shows a whole result the same way.
- **Keys are removed from answers:** a successful answer (`ask_ai`, `compare_ai`, jobs, a relay's final message) has the key the request used, and anything shaped like a provider key or a bearer token, replaced with `[redacted]` before Claude reads it. Commit ids and ordinary text are left as they are.

## 0.9.2

- **Meters stay still on scroll:** the limit meters and the activity chart no longer grow from zero each time the pane scrolls or redraws. They show their value at once.

## 0.9.1

- **A refused subagent starts no job:** when Claude Code itself refuses a subagent the hub asks for (in Auto mode its permission check can), no failed row is left above the prompt. Claude is told that the refusal came from Claude Code, with its reason, and which other AI `runner: "other-ai"` would use for that level.
- **Summaries end at a word:** an ended job's summary in the band is cut at the last whole word, with "…".

## 0.9.0

- **Background jobs:** Claude can split a big task into pieces and start each with `start_job` at its level. A job returns at once and runs in the background: on another AI you connected that serves the level, or on a Claude subagent with the model you set for that level (`runner`: auto, subagent or other-ai). At most four run at once. Another AI only reads: it gets the prompt, and the project folder when Claude passes one and you allow it.
- **Progress above the prompt:** a band above the prompt shows each job with its level, where it runs and how long it has run, and each ended job's first lines. A job on another AI can be stopped from the band. A subagent cannot be stopped from a mod, so it has no Stop button. Clear ended jobs from the band; their results stay readable.
- **Results back in the conversation:** when a job ends, a toast and a notice in the transcript say so, and its result (up to 4,000 characters) is added to the conversation for Claude to read. `job_status` lists the jobs and gives any job's whole result. Turn the added results off in Settings → Claude subagents.
- The routing guide now tells Claude to split big tasks into jobs.

## 0.8.0

- **Levels of work:** every model now shows the level of work it serves: light (search, lookups, summaries), standard (everyday code) or heavy (hard bugs, architecture, reviews). The level comes only from what the model's source reports: a model with effort levels spans several levels by its effort, a reasoning model serves standard and heavy, a model reported without reasoning serves light and standard, and a model whose source reports neither is marked Unrated. You can set any model's level by hand from its details.
- **Route by level:** `ask_ai` and `compare_ai` take `level`, and `/ask-ai` takes `light`, `standard` or `heavy` as a word. The hub then picks a model and an effort that serve that level, within each provider's reported limits. When no ready model serves the level, it uses the next one and says so.
- **Claude knows the levels:** a short guide in Claude's system prompt names the three levels, the AIs you connected and the Claude subagent model for each level (Haiku, Sonnet and Opus by default, changed in Settings → Claude subagents). It holds nothing that changes during a conversation, so the prompt cache holds. New sessions pick up a change. Turn it off in the same card.
- **Models tab:** a Level filter, each model's level on its row, and a card with the Claude subagent model for each level.

## 0.7.0

- **A model for each Claude subagent type:** Settings → Claude subagents picks the model each type of subagent runs on, for example Explore on Haiku, general-purpose on Sonnet and Plan on Opus, plus one for any other type. A rule applies only when Claude names no model itself, and it outranks the model in the agent's own definition. Forks, resumed subagents and workflow agents are left alone. It is off until you turn it on.
- **What each subagent ran on:** the same card lists this session's last subagents with the model Claude Code reports for each and who chose it: your rule, Claude, or the agent's own or the session's model.

## 0.6.0

- **Live progress:** a running request on the Activity tab shows how long it has run and how much output its CLI has written so far. Open the row to see when the CLI last wrote anything, so a request that has gone quiet is easy to spot. Only sizes and times are shown, never what the CLI wrote. Progress is kept for the session only and updates once a second.
- **Toast when a long request ends:** a request that ran 30 seconds or more raises a toast when it answers, fails or times out. A request you stop yourself raises none. Turn it off in Settings → Privacy ("Tell me when a long request ends").

## 0.5.0

- **Stop a request:** a running request shows a Stop button on the Activity tab. Stopping ends its CLI, and the request reads as stopped. A stopped request is never retried or passed to another provider.
- **Deadlines by request type:** a test gets 2 minutes, a read-only question 5, a write 10 (it was 10 minutes for everything). A request that runs out of time is reported as timed out and does not fall back. For a write, the changes made so far stay in the folder for review.
- **Failures named by kind:** a failed request says what kind of failure it was: sign-in problem, limit reached, network problem, timed out, stopped, not available, or error. The kind comes from the CLI's own message, so an unclear message stays a plain "error".
- **Model lists stay current:** a provider's model list is read again in the background when a session starts if it is more than a day old. The Models card shows when the list was last updated and marks it when it is out of date. The old list stays if reading fails.
- **CLIs installed by npm (Windows):** a CLI that npm installed as a `.cmd` shim is now found. The hub reads the shim and runs what it points to directly (a native `.exe`, or `node` with the script), never through a shell. A shim whose target is gone counts as not installed.
- **Preview:** `ask_ai` with `preview: true`, or `/ask-ai --preview …`, shows the provider, model, effort, reason, folder access, fallback and deadline the request would use. Nothing is sent, nothing runs and nobody is asked anything.
- **Export activity:** the Activity tab's Export button writes the log as Markdown and JSON to the hub's folder in the system temp folder. Only metadata is exported (time, provider, model, effort, task, mode, outcome, duration, tokens, cost). Prompts, answers, previews and error text are left out.

## 0.4.1

Security fixes:

- **Fallback asks each provider:** when a request with a project folder falls back to another provider, that provider now needs its own yes before it gets the prompt or the files. A no stops the fallback and nothing is sent to it.
- **Read grants belong to one session:** "Allow this session" no longer carries over to other sessions, including after `/clear`. On Linux, folder names keep their case, so `/A` and `/a` are different folders.
- **Request sharing:** only identical read-only requests from the same session (same provider, model, effort, folder, task and prompt) share a run that is already going. Writes never share a run. The old short hash is gone.
- **No hidden test prompt:** "Test right after connecting" is now off by default, because the test sends a real prompt that uses your plan or API balance. If you saved settings before, your earlier choice stays.
- **CI:** GitHub Actions runs `claude plugin validate .` and `claude plugin test .` on every push to `main` and every pull request, with no secrets.

## 0.4.0

- **Limit alerts:** a toast when a provider's reported window passes 80% or 95% used, or when it reports a block. You get one toast per window and level. Turn it off in Settings → Privacy.
- **Limits refresh:** a provider's limits are read at most once a minute. A reading already in progress is shared, and the Refresh buttons still read right away.
- **Compare with smart pick:** `compare_ai` takes an optional `task`. Each provider then answers with its own best model and effort for that task, and providers at their limit are skipped.
- **`/ask-ai` command:** `/ask-ai [provider] [task] your question` asks a connected AI from the prompt, in read-only mode. Only the question is sent.
- **API cost:** after each OpenCode request, the hub reads the tokens and cost OpenCode recorded for it (`opencode session export`). The cost shows on the request, per provider and as a total on the Activity tab. Nothing is estimated, and subscription requests show no cost.
- **Arabic:** Settings → Language switches the pane to Arabic, with right-to-left text.
- **macOS and Linux:**
  - Keys are typed into a masked system dialog: osascript on macOS, zenity or kdialog on Linux.
  - Keys are stored in the macOS Keychain or the Secret Service (`secret-tool`), always passed on stdin and never on a command line.
  - Paths, the sandbox folder and Codex limits work without PowerShell.

## 0.3.1

- Fallback skips providers at their limit and sends each one its best model for the task.
- Removed dead quick-ask code.
- Documented the development setup.

## 0.3.0

- First release: subscriptions and API keys, models with effort, limits, smart model pick, activity and settings.
