# Changelog

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
