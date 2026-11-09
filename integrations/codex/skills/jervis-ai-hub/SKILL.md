---
name: jervis-ai-hub
description: Use when the user asks to consult, get a second opinion from, compare, or hand a read-only question to another AI they connected in Jervis AI Hub (Claude Code CLI, Antigravity, OpenCode, or a saved API key), or asks about those providers' models and limits.
---

# Jervis AI Hub from Codex

The `hub` MCP server of this plugin sends prompts to the other AIs the user connected in Jervis AI Hub, with their own subscriptions and keys. Codex itself (ChatGPT) is never sent requests from here.

- `list_providers` first, to see which providers are connected and ready.
- `ask_ai` for one answer, `compare_ai` for the same prompt to several providers side by side. Pass `level` (light, standard, heavy) so the hub picks a model that fits the work.
- `start_job` for a longer piece in the background, then `job_status` with its id to read the result, and `stop_job` to end it.
- `list_models`, `get_limits` and `preview_route` read what the providers report. They send no prompt. Never state a quota or limit the tools did not return.

Put the context needed to answer in the prompt. For `claude-code`, pass a self-contained prompt without `cwd`.

## What does not work from Codex

The hub cannot put a question to the user from inside Codex, and it never acts without the user's answer. So:

- A request with `cwd` (reading project files) is refused, unless the user turned off the project-access question in the hub's own settings.
- `mode: "write"` and `delegate_ai` are refused. Nothing is changed or delegated.
- `apply_changes` only returns the command the user runs in their own terminal to review and apply kept changes. Show them that command; do not run it for them.

When a tool refuses, tell the user why in one line, as the tool's answer says, and do not retry it another way.
