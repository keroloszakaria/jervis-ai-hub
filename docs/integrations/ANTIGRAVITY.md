# Jervis AI Hub in Antigravity

The Antigravity plugin runs the hub's tools inside Google Antigravity (the `agy` CLI and the apps that load its plugins). It is an Antigravity plugin with a skill and one MCP server. The server is the same core the Claude Code plugin runs, built into `dist/jervis-mcp.mjs`.

Status: **partially ready**. Read-only requests, comparisons, background jobs, models, limits, activity and diagnostics work. Project reads, writes and delegation are refused by design (see below).

## Install

You need agy 1.5.3 or a later 1.x (checked with 1.5.3) and Node 20 or newer on `PATH`.

From a clone of this repository, on the `antigravity` branch:

```bash
agy plugin install ./integrations/antigravity
```

`agy plugin list` then shows `jervis-ai-hub` with the `hub` server. Inside Antigravity the server is named `jervis-ai-hub_hub`.

### Allowing the tools

Antigravity asks before an agent calls an MCP tool. In headless runs (`agy -p`), where it cannot ask, the call is denied. To let a headless run use a tool, allow that tool alone, for example:

```json
{ "permissions": { "allow": ["mcp(jervis-ai-hub_hub/list_providers)"] } }
```

Allow only the tools you need. The plugin never adds an allow rule itself.

## Disable, enable, remove

```bash
agy plugin disable jervis-ai-hub
```

```bash
agy plugin enable jervis-ai-hub
```

```bash
agy plugin uninstall jervis-ai-hub
```

Uninstall removes the plugin's folder and its entry in Antigravity's config. Once the server has run, Antigravity also keeps a copy of its tool descriptions in `~/.gemini/antigravity-cli/mcp/jervis-ai-hub_hub/`, and uninstall leaves that copy (agy 1.5.3). It holds tool names and descriptions only. Delete the folder to remove it.

## What is in it

| File | What it does |
| --- | --- |
| `integrations/antigravity/plugin.json` | The manifest (Antigravity's plugin schema): name, display name, description, version and two suggested prompts. |
| `integrations/antigravity/mcp_config.json` | One server, `hub`: `node ${PLUGIN_ROOT}/dist/jervis-mcp.mjs`, with `JERVIS_HUB_HOST=antigravity`. |
| `integrations/antigravity/skills/jervis-ai-hub/SKILL.md` | When to use the hub, which tool for what, and what is refused here. |
| `integrations/antigravity/dist/jervis-mcp.mjs` | A copy of the core's built bundle. CI checks it matches `dist/jervis-mcp.mjs`. |

The plugin has **no hooks, rules or sidecars**. Nothing runs on its own. Loop prevention is in the server itself (below). `agy plugin validate --strict` passes, with one note: the plugin has no logo, so Antigravity shows a generic icon.

## The tools

`ask_ai`, `compare_ai`, `delegate_ai`, `apply_changes`, `start_job`, `job_status`, `stop_job`, `list_providers`, `list_models`, `get_limits`, `preview_route`, `get_activity` and `get_diagnostics`.

## What is refused here, and why

An MCP server cannot put a question to the person in Antigravity. The hub never acts on a question nobody answered, so:

- **Reading the project** (`cwd`) is refused while the hub's "ask before a provider reads the project" setting is on (the default).
- **Writes** (`mode: "write"`) and **delegation** are refused before anything runs. Nothing is changed or sent. No setting turns this on. The hub's `allowUnboundedWrites` option is not touched, and the plugin cannot set it.
- **`apply_changes`** does not apply anything. It returns the command to run in your own terminal, from the plugin's folder: `node dist/jervis-mcp.mjs apply <run>`. That command asks you on the terminal and refuses when it has no terminal.
- **`start_job`** runs only on another AI here (no Claude subagents).

## No loops, and never Antigravity itself

- `JERVIS_HUB_HOST=antigravity` tells the hub it runs inside Antigravity. Antigravity is shown as "the agent this hub runs inside" and is never sent requests from here, so a request cannot go back to Antigravity.
- Every CLI the hub starts is given `JERVIS_HUB_DEPTH` and `JERVIS_HUB_PARENT`. A hub that finds itself inside an agent a hub started (depth 1 or more) sends nothing on.
- An `agy` the hub starts for a read-only request runs with `mcp(*)` denied, so it cannot call this plugin's tools at all.

## Data and keys

- The server keeps its setup in the plugin data folder Antigravity gives it (`PLUGIN_DATA`), or `JERVIS_HUB_HOME` when set, in one file readable by the user only. It holds no keys: API keys stay in the OS's secure storage.
- Sign-ins are the providers' own CLIs (Codex, OpenCode). The hub reads no browser cookies or session tokens.
- The first start links the official sign-ins that already work. It only checks them and sends no prompt.

## Checks

- `npx -y tsx@4.19.2 ci/antigravity-install.ts --agy <path to agy>` runs the strict validation, installs the plugin with the real agy CLI into a temporary home, disables and enables it, and starts the installed server as Antigravity does. Then it uninstalls the plugin and checks nothing is left. Your own `~/.gemini` is not touched, and no prompt is sent. Without agy the run fails instead of passing.
- `npx -y tsx@4.19.2 ci/mcp-smoke.ts` checks the server over stdio: the tool list, the refusals, the host's own provider, and the depth limit.

Verified on Windows 11 with agy 1.5.3:

- `ci/antigravity-install.ts`: 14 of 14 checks pass.
- A real headless `agy` run, with the plugin installed and only `list_providers` allowed, called the tool through `jervis-ai-hub_hub`. Antigravity came back marked as the host. Without the allow rule, Antigravity denied the call, as it should.
- After that run the plugin was uninstalled, and the installed-plugin list matched the one from before.

Not verified: macOS and Linux with a real agy (CI runs the stdio checks there, not the install), and the Antigravity desktop app's plugin screen.

## After changing the core

Build the bundle and copy it into the plugin:

```bash
npx -y esbuild@0.24.0 hosts/mcp/server.ts --bundle --platform=node --target=node20 --format=esm --alias:claude-code=./hosts/mcp/claude-code-shim.ts --outfile=dist/jervis-mcp.mjs --legal-comments=none --log-level=warning
```

```bash
cp dist/jervis-mcp.mjs integrations/antigravity/dist/jervis-mcp.mjs
```

Raise `version` in `integrations/antigravity/plugin.json` too.
