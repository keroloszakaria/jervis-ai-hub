# Jervis AI Hub

A Claude Code mod that connects your other AI subscriptions and API keys (ChatGPT through Codex, Antigravity, OpenCode, DeepSeek, OpenRouter, MiniMax and more) and lets Claude ask, compare or delegate to them.

- **Pane:** providers, models with effort, each provider's limits, activity and settings, in a black, white and neon orange design.
- **Tools for Claude:** `ask_ai`, `compare_ai`, `delegate_ai`, `apply_changes`, `start_job` and `job_status`. You can also ask directly with `/ask-ai [provider] [task] your question`.
- **Smart pick:** with a task and no provider, the hub picks the best connected model and effort, using only what each source reports and each provider's remaining limits. A fallback or a comparison uses each provider's best model too.
- **Routing order:** a provider named in the request, then your rule for the task, then your default provider (its best model for the task), then the smart pick, or the first ready provider with Smart routing off. A rule or default that cannot take the request is named in the reason.
- **Limits:** Codex plan windows, Antigravity `/usage`, your Claude session's windows, and the balance endpoints of DeepSeek, OpenRouter, Moonshot and SiliconFlow. Nothing is estimated. A toast warns at 80% and 95% of a window.
- **Cost:** for API-key providers, the cost OpenCode recorded for each request, per provider and in total.
- **Control:** a running request shows how long it has run and how much output it has written (sizes only), with a toast when a long one ends; stop it from the Activity tab; each kind of request has its own deadline; `/ask-ai --preview …` (or `preview: true`) shows the route and access without sending anything; export the activity log (metadata only).
- **Levels of work:** each model shows whether it serves light, standard or heavy work, from what its source reports (or your own choice). Claude passes a `level` and the hub picks a model and effort that fit, so simple work does not spend a strong model. A short guide in Claude's system prompt tells it the levels and which subagent model serves each.
- **Background jobs:** for a big task, Claude starts each piece with `start_job` at its level, on another AI or a Claude subagent. A band above the prompt shows each job's level, runner and time, and each result comes back into the conversation when it ends (`job_status` reads it too).
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

Open the pane with `/ai-providers`.

How to use every part of it: the [user manual](docs/USER_MANUAL.md) ([Arabic](docs/ar/USER_MANUAL.md)).

## Developing

- Type checking extends `.claude-plugin/types/tsconfig.json`, which Claude Code writes the first time it loads the mod (the folder is gitignored). Load the mod once, for example with `claude --plugin-dir <this folder>`, then run `npx -p typescript tsc -p .`.
- Tests: `claude plugin test .` and `claude plugin validate .`. CI (`.github/workflows/ci.yml`) runs both on every push and pull request. CI does not type-check: Claude Code's declarations are written only on a machine that loads the mod, and they are not this project's to publish, so run the type check locally before a release.
- The git guard is also checked with real git: `npx -y tsx@4.19.2 ci/real-gitguard.ts`, and the workspace copy with `npx -y tsx@4.19.2 ci/real-workspace.ts`. A `.jervisignore` in a project's root (`.gitignore` patterns) names more files to leave out of the copy. Before an Apply, the **Review changes** pane shows each changed file's diff. CI runs both on Linux, Windows and macOS.
- The CLIs' isolation rules are checked with the real, signed-in CLIs by hand (it sends real prompts): `npx -y tsx@4.19.2 ci/real-cli.ts --opencode-model opencode/beam-free`. Name `opencode`, `agy` or `codex` to check some of them. It exits 0 only when every check passed (1 failed, 3 incomplete) and writes an evidence file under `~/.claude/jervis-ai-hub/evidence`.
- Don't load a development copy and the installed plugin in the same session: both register the same tools and pane.

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## Licenses

Jervis AI Hub is released under the MIT License; see [LICENSE](LICENSE).

Provider logos come from lobe-icons (MIT); see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
