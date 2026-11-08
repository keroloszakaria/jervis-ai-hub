# Jervis AI Hub in Codex

The Codex plugin runs the hub's tools inside OpenAI Codex. It is a Codex plugin with a skill and one MCP server. The server is the same core the Claude Code plugin runs, built into `dist/jervis-mcp.mjs`.

Status: **partially ready**. Read-only requests, comparisons, background jobs, models, limits, activity and diagnostics work. Project reads, writes and delegation are refused by design (see below).

## Install

You need Codex CLI with plugin support (checked with 0.167.0-alpha.3.2) and Node 20 or newer on `PATH`.

From a clone of this repository, on the `codex` branch:

```bash
codex plugin marketplace add .
```

```bash
codex plugin add jervis-ai-hub@jervis-ai-hub
```

Then start a new Codex session. `codex mcp list` shows the server as `hub`.

## Remove

```bash
codex plugin remove jervis-ai-hub@jervis-ai-hub
```

```bash
codex plugin marketplace remove jervis-ai-hub
```

This removes the plugin's files and its lines in `config.toml`. The hub's own saved setup (in Codex's plugin data folder) is not part of the plugin, so Codex may keep it.

## What is in it

| File | What it does |
| --- | --- |
| `.agents/plugins/marketplace.json` | The marketplace Codex reads from this repository. It has one plugin, at `./integrations/codex`. |
| `integrations/codex/plugin.json` | The manifest (portable plugin schema, display name under `extensions["com.openai"]`). |
| `integrations/codex/mcp.json` | One stdio server, `hub`: `node ${PLUGIN_ROOT}/dist/jervis-mcp.mjs`, with `JERVIS_HUB_HOST=codex`. |
| `integrations/codex/skills/jervis-ai-hub/SKILL.md` | When to use the hub, which tool for what, and what is refused here. |
| `integrations/codex/dist/jervis-mcp.mjs` | A copy of the core's built bundle. CI checks it matches `dist/jervis-mcp.mjs`. |

The plugin has **no hooks**. Codex asks the person to trust plugin hooks, and nothing here needs one. Loop prevention is in the server itself (below).

## The tools

`ask_ai`, `compare_ai`, `delegate_ai`, `apply_changes`, `start_job`, `job_status`, `stop_job`, `list_providers`, `list_models`, `get_limits`, `preview_route`, `get_activity` and `get_diagnostics`. The tools that only read (`list_*`, `get_*`, `preview_route`, `job_status`) are marked read-only for Codex.

## What is refused here, and why

An MCP server cannot put a question to the person in Codex. The hub never acts on a question nobody answered, so:

- **Reading the project** (`cwd`) is refused while the hub's "ask before a provider reads the project" setting is on (the default).
- **Writes** (`mode: "write"`) and **delegation** are refused before anything runs. Nothing is changed or sent.
- **`apply_changes`** does not apply anything. It returns the command to run in your own terminal, from the plugin's folder: `node dist/jervis-mcp.mjs apply <run>`. That command asks you on the terminal and refuses when it has no terminal.
- **`start_job`** runs only on another AI here (no Claude subagents).

Turning the project-access question off in the hub's settings lets `cwd` reads go out without asking. That is the person's choice; the plugin never changes it.

## No loops, and never Codex itself

- `JERVIS_HUB_HOST=codex` tells the hub it runs inside Codex. ChatGPT (Codex) is shown as "the agent this hub runs inside" and is never sent requests from here, so a request cannot go back to Codex.
- Every CLI the hub starts is given `JERVIS_HUB_DEPTH` and `JERVIS_HUB_PARENT`. A hub that finds itself inside an agent a hub started (depth 1 or more) sends nothing on.

## Data and keys

- The server keeps its setup in the plugin data folder Codex gives it (`PLUGIN_DATA`), or `JERVIS_HUB_HOME` when set, in one file readable by the user only. It holds no keys: API keys stay in the OS's secure storage.
- Sign-ins are the providers' own CLIs (Antigravity, OpenCode). The hub reads no browser cookies or session tokens.
- The first start links the official sign-ins that already work. It only checks them and sends no prompt.

## Checks

- `npx -y tsx@4.19.2 ci/codex-install.ts --codex <path to codex>` installs the plugin with the real Codex CLI into a temporary `CODEX_HOME`, starts the installed server as Codex does, then removes it and checks nothing is left. Your own `~/.codex` is not touched, and no prompt is sent. Without a Codex CLI the run fails instead of passing.
- `npx -y tsx@4.19.2 ci/mcp-smoke.ts` checks the server over stdio: the tool list, the refusals, the host's own provider, and the depth limit.

Verified on Windows 11 with codex-cli 0.167.0-alpha.3.2:

- `ci/codex-install.ts`: 13 of 13 checks pass.
- A real `codex exec` (read-only sandbox) with this bundle as an MCP server listed the 13 tools and called `list_providers`. ChatGPT came back marked as the host.

Not verified: macOS and Linux with a real Codex CLI (CI runs the stdio checks there, not the install), and the Codex desktop app's plugin screen.

## After changing the core

Build the bundle and copy it into the plugin:

```bash
npx -y esbuild@0.24.0 hosts/mcp/server.ts --bundle --platform=node --target=node20 --format=esm --alias:claude-code=./hosts/mcp/claude-code-shim.ts --outfile=dist/jervis-mcp.mjs --legal-comments=none --log-level=warning
```

```bash
cp dist/jervis-mcp.mjs integrations/codex/dist/jervis-mcp.mjs
```

Raise `version` in `integrations/codex/plugin.json` too, so Codex installs the new copy.
