# Jervis AI Hub

A Claude Code mod that connects your other AI subscriptions and API keys (ChatGPT through Codex, Antigravity, OpenCode, DeepSeek, OpenRouter, MiniMax and more) and lets Claude ask, compare or delegate to them.

- **Pane:** providers, models with effort, each provider's limits, activity and settings, in a black, white and neon orange design.
- **Tools for Claude:** `ask_ai`, `compare_ai` and `delegate_ai`. You can also ask directly with `/ask-ai [provider] [task] your question`.
- **Smart pick:** with a task and no provider, the hub picks the best connected model and effort, using only what each source reports and each provider's remaining limits. A fallback or a comparison uses each provider's best model too.
- **Limits:** Codex plan windows, Antigravity `/usage`, your Claude session's windows, and the balance endpoints of DeepSeek, OpenRouter, Moonshot and SiliconFlow. Nothing is estimated. A toast warns at 80% and 95% of a window.
- **Cost:** for API-key providers, the cost OpenCode recorded for each request, per provider and in total.
- **Control:** a running request shows how long it has run and how much output it has written (sizes only), with a toast when a long one ends; stop it from the Activity tab; each kind of request has its own deadline; `/ask-ai --preview …` (or `preview: true`) shows the route and access without sending anything; export the activity log (metadata only).
- **Claude's own subagents:** pick the model each subagent type runs on when Claude names none (Explore on Haiku, Plan on Opus…), and see what each subagent of the session ran on. Off until you turn it on.
- **Languages:** English or Arabic (Settings → Language).
- **Security:** API keys are typed into a masked system dialog and kept in the system's secure storage: Windows DPAPI, the macOS Keychain, or the Linux Secret Service. They are never shown, logged, put on a command line or stored in plain text.

Windows, macOS and Linux. Linux needs `secret-tool` (libsecret) and `zenity` or `kdialog`. The providers' own CLIs (`codex`, `agy`, `opencode`) must be installed and signed in for the subscriptions you connect.

## Install

At the prompt of a terminal session:

```
/plugin install ai-subscriptions --marketplace keroloszakaria/jervis-ai-hub
```

Answer `y` to add the marketplace, then pick the user scope. From a shell:

```bash
claude plugin install ai-subscriptions --marketplace keroloszakaria/jervis-ai-hub
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `keroloszakaria/jervis-ai-hub`, then Add plugin.

This repository is private: installing needs read access to it on GitHub and a git credential for github.com on your machine (an SSH key, or `gh auth login` then `gh auth setup-git`).

Open the pane with `/ai-providers`.

## Developing

- Type checking extends `.claude-plugin/types/tsconfig.json`, which Claude Code writes the first time it loads the mod (the folder is gitignored). Load the mod once, for example with `claude --plugin-dir <this folder>`, then run `npx -p typescript tsc -p .`.
- Tests: `claude plugin test .` and `claude plugin validate .`. CI (`.github/workflows/ci.yml`) runs both on every push and pull request. It does not type-check yet, because the types are written by Claude Code when it loads the mod.
- Don't load a development copy and the installed plugin in the same session: both register the same tools and pane.

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## Licenses

Provider logos come from lobe-icons (MIT); see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
