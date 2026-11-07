# Changelog

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
