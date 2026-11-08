# Multi-host implementation report

Date: 2026-11-08. Machine: Windows 11 Home (10.0.26200). Version: 0.11.0.

## Status

| Integration | Branch | Status | In one line |
| --- | --- | --- | --- |
| Core hardening | `fix/core-hardening` | **READY** | All 21 audit findings are fixed or mitigated, with regression tests. The local gate is green. |
| Shared core + MCP server | `fix/core-hardening` | **READY** | One tool layer (`hooks/tools.ts`) and an MCP stdio server (`dist/jervis-mcp.mjs`) built from the same modules. |
| Claude Code plugin | `fix/core-hardening` | **READY** | Unchanged in behaviour, and all 147 tests pass. |
| Codex plugin | `codex` | **PARTIALLY READY** | Install, use and removal checked with the real Codex CLI. Project reads, writes and delegation are refused by design. |
| Antigravity plugin | `antigravity` | **PARTIALLY READY** | Strict validation, install, use and removal checked with the real agy. Project reads, writes and delegation are refused by design. |
| Dashboard (Phase 5, optional) | — | **NOT DONE** | Not built. Nothing is served on a port. |

"Partially ready" has one cause in both hosts. An MCP server there cannot put a question to the person, and the hub never acts on an unanswered question. So everything that needs an approval is refused, not faked. Making these hosts fully ready needs a trusted approval channel from the host (MCP elicitation that the host supports, or the host's own per-tool approval tied to the request). That was not available to build on here.

## Phase 0–1: core hardening

The details are in `docs/audits/CORE_HARDENING_AUDIT.md`: 21 findings, each with its root cause, evidence, fix and tests. The ones that matter most:

- The prompt goes to Antigravity on stdin, never on the command line.
- Junctions out of the project are kept out of the copy and out of Apply.
- A half-written Apply is rolled back.
- The hub's own git runs no fsmonitor hook and no filters, and stops if `.git/config` or the attributes files changed during a run.
- A hop depth (`JERVIS_HUB_DEPTH`) stops loops between hubs.
- Limits use explicit states: available, limited, exhausted, stale, unknown, unsupported. An unknown or old reading is never treated as free.
- Routing rules are checked against the task.
- Delegations have a 30-minute limit and can be stopped.
- After a reload, jobs are settled and a past session's results stay out of the next one.

Several regression tests were confirmed to fail on the old code: the junction checks, the added-filter check, and L-01.

## Phase 2: the shared core

- `hooks/tools.ts` lists the 13 tools and runs them for any host:
  - `ask_ai`, `compare_ai`, `delegate_ai`, `apply_changes`;
  - `start_job`, `job_status`, `stop_job`;
  - `list_providers`, `list_models`, `get_limits`, `preview_route`, `get_activity`, `get_diagnostics`.
- `hosts/mcp/engine.ts` answers the engine interface in Node: the store, processes, files, http, the clock, and a question asker. It has no asker unless the terminal `apply` command passes one.
- `hosts/mcp/server.ts` is the MCP stdio server. It also has the `apply <run>` terminal command, which works on a TTY only.
- The host adapter is the `JERVIS_HUB_HOST` value (`codex` or `antigravity`). It keeps the host's own provider out of every route.

Two limits of this phase, stated plainly:

1. The modules still import `atom`, `read` and `update` from `'claude-code'`. In the MCP bundle that import is aliased to `hosts/mcp/claude-code-shim.ts`. The core is host-neutral at build time, not at the source level.
2. The Claude Code plugin still registers its tools with its own handlers in `hooks/register.tsx`, not through `hooks/tools.ts`. Both call the same modules, so behaviour matches, but the tool descriptions exist in two places. Moving Claude onto `tools.ts` is a follow-up.

## Phase 3: Codex (`codex` branch)

The plugin is in `integrations/codex`, with the marketplace in `.agents/plugins/marketplace.json`. It has no hooks. The full description is in `docs/integrations/CODEX.md`.

What was verified, with codex-cli 0.167.0-alpha.3.2:

- `ci/codex-install.ts` passes 13 of 13 checks in a temporary `CODEX_HOME`: the marketplace is added, the plugin installed, the server listed as enabled, and the installed server answers. After removal nothing is left in the config or the cache.
- A real `codex exec` (read-only sandbox) used the bundle as an MCP server, listed the 13 tools and called `list_providers`. ChatGPT came back marked as the host, so it is never sent requests.

## Phase 4: Antigravity (`antigravity` branch)

The plugin is in `integrations/antigravity`. It has no hooks, rules or sidecars, and `allowUnboundedWrites` is not touched. The full description is in `docs/integrations/ANTIGRAVITY.md`.

What was verified, with agy 1.5.3:

- `agy plugin validate --strict` passes. Its one note: there is no logo.
- `ci/antigravity-install.ts` passes 14 of 14 checks in a temporary home: install, list, disable, enable, the installed server's answer, uninstall, and nothing left behind.
- A real headless `agy` run called `list_providers` through `jervis-ai-hub_hub`. Only that one tool was allowed, through `--settings`. Antigravity came back marked as the host. Without the allow rule, Antigravity denied the call.
- After that run the plugin was uninstalled from the real home, and the plugin list matched the one from before. agy kept a copy of the tool descriptions in `~/.gemini/antigravity-cli/mcp/jervis-ai-hub_hub/`. The test had made it, so it was deleted, and the doc says uninstall leaves it.

## The gate (all on this machine)

| Check | Result |
| --- | --- |
| `tsc -p .` (and `tsconfig.ci.json` on each branch) | pass |
| `claude plugin validate .` | pass, on all three branches |
| `claude plugin test .` | 147 pass, 0 fail |
| `ci/real-workspace.ts` | all pass |
| `ci/real-gitguard.ts` | all pass |
| `ci/mcp-smoke.ts --real` | 14 of 14 pass, one of them a real OpenCode answer |
| `ci/real-cli.ts opencode agy codex` | 21 checks: 20 pass, 0 fail, 1 inconclusive |
| `ci/codex-install.ts` | 13 of 13 pass |
| `ci/antigravity-install.ts` | 14 of 14 pass |

The one inconclusive check is "agy, read-only: a read outside the folder is denied". It ran twice, and both times the model did not try the read, so the check could neither pass nor fail. It is not a failure, and it is not proof either. The write-denial checks for agy pass.

GitHub CI (the 3-OS matrix, including the new `mcp` job) runs on the pushed branches. Its result is on the pull requests, not in this report.

## Not done or not verified

- Phase 5, the dashboard, was not built.
- There is no real Codex or agy install test on macOS or Linux. CI runs the stdio checks there.
- The Codex desktop app's and the Antigravity app's plugin screens were not checked.
- Neither plugin is listed in a public directory. Codex plugins with hooks are not eligible there, and these have none, but nothing was submitted.
- Approvals inside MCP hosts are missing, and project reads, writes and delegation stay refused there until a host offers a trusted way to ask.
