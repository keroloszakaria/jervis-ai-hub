# Changelog

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
