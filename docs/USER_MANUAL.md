# Jervis AI Hub: user manual

[العربية](ar/USER_MANUAL.md)

Jervis AI Hub is a Claude Code mod. It connects the other AI subscriptions and API keys you already have, and lets Claude ask them, compare their answers, run background work on them, or hand them a coding task. You stay in charge: nothing reads your project or changes a file without your answer.

This manual is for version 0.11.0.

## Contents

1. [What you need](#what-you-need)
2. [Install, update, remove](#install-update-remove)
3. [Open the pane](#open-the-pane)
4. [Connect a provider](#connect-a-provider)
5. [The pane, tab by tab](#the-pane-tab-by-tab)
6. [Use it from Claude](#use-it-from-claude)
7. [Ask directly: /ask-ai](#ask-directly-ask-ai)
8. [How the hub picks a provider](#how-the-hub-picks-a-provider)
9. [Writes and delegation](#writes-and-delegation)
10. [Background jobs](#background-jobs)
11. [Limits and costs](#limits-and-costs)
12. [Settings](#settings)
13. [Privacy and security](#privacy-and-security)
14. [Codex and Antigravity as hosts](#codex-and-antigravity-as-hosts)
15. [Troubleshooting](#troubleshooting)

## What you need

- Claude Code (terminal, desktop app or IDE extension), on Windows, macOS or Linux.
- On Linux: `secret-tool` (libsecret), and `zenity` or `kdialog` to type API keys.
- The official CLI of each subscription you connect, installed and signed in:

| To connect | Install | Version |
| --- | --- | --- |
| ChatGPT (your ChatGPT plan, through Codex) | Codex CLI (`codex`) | any |
| Antigravity | Antigravity CLI (`agy`) | 1.5 or a later 1.x |
| OpenCode Zen (free) and every API-key provider | OpenCode (`opencode`) | 2.x |

- Node.js, only to delegate to Antigravity through Jervis Relay.

## Install, update, remove

The repository is private. To install you need read access to it on GitHub, and a git credential for github.com on your machine (an SSH key, or `gh auth login` then `gh auth setup-git`).

**Install** at the prompt of a terminal session:

```
/plugin install ai-subscriptions --marketplace keroloszakaria/jervis-ai-hub
```

Answer `y` to add the marketplace, then pick the user scope. Or from a shell:

```bash
claude plugin install ai-subscriptions --marketplace keroloszakaria/jervis-ai-hub
```

In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `keroloszakaria/jervis-ai-hub` → **Add plugin**.

**Update:**

```bash
claude plugin update ai-subscriptions
```

**Remove:**

```bash
claude plugin uninstall ai-subscriptions
```

Removing the plugin does not sign you out of any CLI. To remove a saved API key first, open that provider and click **Disconnect** before you uninstall.

## Open the pane

The pane opens by itself when a session starts. To open it again, type:

```
/ai-providers
```

At the top you see the title, how many providers are ready (for example `● 2/3 ready`), the **+ Add** button and four tabs: **Overview**, **Models**, **Activity** and **Settings**.

On the first start the hub checks the ChatGPT, Antigravity and OpenCode sign-ins you already have and links the ones that work. That check sends no prompt.

## Connect a provider

Click **+ Add**. Providers come in three groups, and you can search them by name:

- **Subscription sign-in.** ChatGPT (Codex) and Antigravity.
- **Local or free.** OpenCode Zen (free), with no key.
- **API key.** DeepSeek, OpenRouter, Google Gemini API, xAI Grok, Mistral, Groq, Moonshot Kimi, Alibaba Qwen, Zhipu GLM, Cerebras, Fireworks, Perplexity, MiniMax, Anthropic API, OpenAI API, Z.AI, Together AI, Deep Infra, NVIDIA NIM, Hugging Face, Cohere and more (37 in all). They run through OpenCode.

Click **Connect** on a row:

- **ChatGPT:** the hub starts `codex login` and shows a link. Finish signing in in your browser.
- **Antigravity:** the hub cannot sign you in. Run `agy` once in a terminal, sign in, then click **Connect** again.
- **An API key:** a masked system window titled "Jervis AI Hub - &lt;provider&gt;" opens. Paste the key and click **Save**. **Get a key ↗** opens the provider's key page.

### What the status means

| Status | Meaning |
| --- | --- |
| ● Verified | A test request worked. |
| ◐ Not tested | Signed in, but no request has been tried yet. |
| ● Test failed | The last test did not work. |
| ○ Signed out | The sign-in or the key is missing. |
| ○ CLI missing | The provider's CLI is not installed. |
| ◌ Checking… | The hub is checking the sign-in. |
| ○ Off | You turned the provider off. |

Being signed in does not prove a request works. Open the provider and click **Test connection**. A test sends one short, real prompt, which counts against your plan or API balance.

## The pane, tab by tab

### Overview

- Tiles: **Ready**, **Requests** and **Avg latency**.
- **Providers:** each connected provider with its status, model and effort. **Open ›** opens its page.
- **Limits:** this Claude session's windows, and the limits each connected provider reports. **Refresh** reads them again.
- **Recent:** the last three requests. **All activity ›** opens the Activity tab.

### A provider's page

- **Requests**, **Avg latency** and **Tokens** (in / out, or "not reported" when the CLI gives none).
- **Limits** card: the plan, a meter per window ("N% used · resets in …"), and where the reading came from.
- **Model**: pick the model, then its **Effort** (only the efforts that model lists). With no effort picked, the CLI's default is used.
- **Connection**: the sign-in, the last test, whether delegation is available, and how it is billed.
- **Test connection** and **Refresh models**.
- **Recent errors**: the last three.
- **Manage**: **Turn off** / **Turn on**, and **Disconnect**. Disconnect removes the provider from the hub, with its saved API key. It never signs you out of the CLI.

### Models

- Search every connected provider's models. Filter by **Provider**, **Capability** (image input, reasoning, tool calling, web search, context ≥ 200k) and **Level** (light, standard, heavy).
- **☆** marks a favourite, and **★ Favorites** shows only favourites. Favourite models are also offered in the routing rules.
- **Details ›** shows what the model's source reports: ID, effort, context, input, tools, list price per million tokens, and level. A list price is not what your subscription costs.
- In the details you can:
  - **Set level** yourself;
  - make the model the **Default for** a task (this sets a routing rule);
  - **Use for &lt;provider&gt;** to make it that provider's model.

The hub shows only what each source reports. Nothing is guessed.

### Activity

- Tiles: **Requests**, **Failed**, **Avg latency**, and **API cost** when OpenCode recorded a cost.
- A latency chart of the last 30 requests (desktop app), and a table **By provider**.
- The request list (the newest 40), which you can filter: **All**, **Ask**, **Compare**, **Test**, **Delegate**.
  - Each row shows ✓ ok, ✗ error, ● running or – cancelled.
  - **›** opens the details: mode, model, prompt size, progress, usage and changed files.
  - A running request shows how long it has run and how much it has written. **Stop** ends it.
- **Export** writes the list as `.json` and `.md` to `<temp folder>/jervis-ai-hub/exports/`. It holds metadata only: no prompts, answers or error text.
- **Clear** empties the list.

### Settings

Every setting is explained in [Settings](#settings) below.

## Use it from Claude

Just ask Claude in plain words. For example:

- "Ask Antigravity for a second opinion on this plan."
- "Compare two other models on this question."
- "Split this review into pieces and run them in the background."

Claude uses these tools:

| Tool | What it does |
| --- | --- |
| `ask_ai` | One answer from one provider. Read-only by default. |
| `compare_ai` | The same prompt to 2–5 providers, side by side. Always read-only. |
| `start_job` / `job_status` | A piece of work in the background, then its result. |
| `delegate_ai` | A coding task handed to Codex or Antigravity, in a copy of your folder. |
| `apply_changes` | Asks you again about changes you kept for later. |

The other AI does not see your conversation, only the prompt Claude writes. A read-only request runs in an empty folder, so the provider sees only that prompt. It sees your project files only if Claude passes the folder and you allow it.

### Levels of work

Each request can carry a level, so simple work does not spend a strong model:

- **Light:** search, lookups, summaries, renames, boilerplate.
- **Standard:** everyday code changes and explanations.
- **Heavy:** hard bugs, architecture, security and careful reviews.

The hub picks a model and effort that serve the level. Heavy work is never stepped down to a weaker model: if no model serves it, the request is refused.

## Ask directly: /ask-ai

```
/ask-ai [provider] [task] [level] [--preview] your question
```

- **provider:** the id or first word of a connected provider, for example `chatgpt`, `antigravity` or `deepseek`.
- **task:** `general`, `code`, `review`, `reasoning`, `fast` or `vision`.
- **level:** `light`, `standard` or `heavy`.
- **--preview:** shows the provider, model, reason, access, deadline and prompt size. It sends nothing.

The first three words can come in any order. The first word that is none of them starts the question. With no provider and no task, the hub picks the best connected model.

```
/ask-ai deepseek code Why does this regex match the empty string? ^(a|b)*$
```

```
/ask-ai --preview heavy Review this migration plan for data loss.
```

`/ask-ai` is always read-only, and sends only the question. The answer starts with `[provider · model · effort · time]` and, when the CLI reports them, the tokens and the cost OpenCode recorded.

## How the hub picks a provider

For each request, in this order:

1. The provider named in the request.
2. Your **routing rule** for the task.
3. Your default provider (**Otherwise**), with its best model for the task.
4. The **smart pick**, when "Pick the best model for each task" is on.
5. With smart routing off, the first ready provider.

The smart pick scores every connected model on what its source reports (reasoning, tool calls, context, image input, price) and on the limits each provider reports.

A provider whose reading says its limit is reached is skipped. So is a rule whose model no longer exists or lacks what the task needs (an image task needs image input). The answer says why.

**Fallback** is off by default. When on, a read-only request that fails for a limit, a network problem or an unavailable provider can go to another provider (1–3 at most). The hub asks you first, because the prompt then goes somewhere you did not choose. Writes and delegations never fall back or retry.

## Writes and delegation

A write (`ask_ai` in write mode) or a delegation (`delegate_ai`) can change files. This is how it goes:

1. **You are asked first.** "Let &lt;provider&gt; change files in &lt;folder&gt;?" with **Allow** or **Deny**.
2. **It works in a copy.** The hub copies your folder to `~/.claude/jervis-ai-hub/work/<run>/`, leaving out:
   - the `.git` folder and files your `.gitignore` ignores;
   - links and submodules;
   - secret files: `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc` and similar;
   - files with something that looks like a key inside them;
   - anything you list in a `.jervisignore` in the folder's root, in `.gitignore` syntax;
   - folders that lead outside the project.
3. **You review it.** The **Review changes** pane shows each file's diff, and you answer in the question:
   - **Apply** writes the changes into your folder. Nothing is staged or committed.
   - **Keep for later** keeps them for 7 days. Ask Claude to apply run `run-…` later, and it uses `apply_changes`.
   - **Discard** throws them away.

Apply touches only files that have not changed in your folder since the copy was made. If any did, nothing is applied. Closing the question without answering counts as **Keep for later**.

**Who can do what:**

| Provider | Write | Delegation |
| --- | --- | --- |
| ChatGPT (Codex) | yes, held to the folder | yes, run by the hub |
| OpenCode and API-key providers | yes, held to the folder | no |
| Antigravity | only with "Allow writes not held to the folder (Antigravity)" on | the same, through Jervis Relay (needs Node.js and the `agy-delegate` skill) |

Antigravity is off for writes by default because its writes are not held to the folder: they can change any file you can.

**Deadlines:** a test stops after 2 minutes, a read after 5, a write after 10 and a delegation after 30. A request the hub could not confirm has ended is reported as possibly still running.

## Background jobs

For a large task, Claude can split it into pieces and start each with `start_job` at its level. A piece runs on another AI (read-only) or on a Claude subagent.

- At most 4 jobs run at once.
- A band above the prompt shows each job: ◐ running, ✓ done, ✕ failed or ■ stopped. It shows the job's level, where it runs, and for how long.
- **Stop** ends a running job on another AI. A subagent job cannot be stopped from the hub.
- **Clear ended** hides finished jobs. Their results can still be read.
- When a job ends you get a toast. Its result (up to 4,000 characters) is added to the conversation unless you turned that off, and `job_status` reads the whole result.
- Jobs belong to their session: ending the session ends its jobs.

## Limits and costs

- **Claude:** this session's own windows (5-hour, weekly…), updated after each reply.
- **ChatGPT:** the plan windows Codex reports.
- **Antigravity:** what `agy /usage` reports.
- **DeepSeek, OpenRouter, Moonshot Kimi and SiliconFlow:** the key's balance or spend. Other providers publish no balance endpoint, so the hub says so.

The hub never estimates or invents a number:

- A reading older than 30 minutes is marked out of date and does not steer routing. Click **Refresh**.
- A toast warns at 80% and 95% of a window, and when a provider reports a block.
- **Cost** is shown only where OpenCode recorded it for a request (API-key providers). A subscription has no per-request bill.

## Settings

**Language:** English or العربية. In Arabic the pane reads from the right.

**Model for each task:**

| Setting | Default | What it does |
| --- | --- | --- |
| Pick the best model for each task | On | The smart pick. It lists today's pick per task and why. |
| Routing rules (General, Coding, Code review, Hard reasoning, Fast answers, Images) | Smart pick | A fixed provider or favourite model per task. Your rule wins. |
| Otherwise | First verified | The default provider when no rule applies. |
| Separate rules for this project | Off | Rules that apply only in this project's folder. |
| Fall back when a read-only request fails | Off | Try up to 1–3 other providers, asking you first. |

**Claude subagents:**

| Setting | Default | What it does |
| --- | --- | --- |
| Tell Claude which model suits which work | On | A short guide in Claude's system prompt: the levels, your connected AIs, and the subagent model for each level. New sessions pick up a change. |
| Add each background job's result to the conversation | On | Off: only the band and `job_status` show it. |
| Light / Standard / Heavy work | Haiku / Sonnet / Opus | The Claude model a subagent job uses at each level. |
| Also pick a model for each subagent type | Off | Explore → Haiku, General-purpose → Sonnet, Plan → Opus, when Claude names no model itself. Forks keep the session's model. |

**Privacy:**

| Setting | Default | What it does |
| --- | --- | --- |
| Ask before a provider reads project files | On | You get **Allow once**, **Allow this session** or **Deny**. Off: reads go ahead without asking. Writes are always asked. |
| Allow writes not held to the folder (Antigravity) | Off | Lets Antigravity write and delegate. |
| Write straight into the folder | Off | Off: writes run in a copy you review. On: the agent edits your folder and can reach its `.git`. |
| Allow Codex without read isolation | Off | Where Codex's sandbox cannot hold it to the folder (Windows without MXC), Codex is refused unless this is on. |
| Keep redacted prompt previews | Off | Keeps a short preview with secrets removed. Off: only sizes and outcomes are kept. |
| Test right after connecting (sends one real prompt) | Off | Runs **Test connection** when you connect. |
| Alert me near a provider's limit | On | Toasts at 80% and 95%. |
| Tell me when a long request ends | On | A toast when a request of 30 seconds or more ends. |

**History:** keep the last 25, 100 or 500 requests (default 100), for 1, 7, 30 or 90 days (default 30).

**Diagnostics:** **Run checks** checks each CLI and its version, Codex read isolation, secure key storage, Node.js for Jervis Relay, delegation per provider, and the models.dev metadata.

## Privacy and security

- **API keys** are typed into a masked system window, never into the chat. They are kept in the system's secure storage: Windows DPAPI, the macOS Keychain, or the Linux Secret Service. They are never shown, logged, written in plain text or put on a command line. A key reaches its CLI only as an environment variable for that one request.
- **Sign-ins** are the providers' own CLIs. The hub never reads browser cookies or session tokens.
- **Prompts and answers** stay private: Activity keeps sizes and outcomes only, unless you turn on redacted previews.
- **Your project** is read only with your answer, and changed only after **Allow** and then **Apply**.
- **Your git** is protected: the hub runs no hook or filter from your repository, and refuses a run that changed your branches or refs.
- **Loops are prevented:** a hub inside an agent that another hub started sends nothing on.

What the hub keeps on disk:

| Where | What |
| --- | --- |
| Claude Code's plugin store | Your connections, settings, favourites, model lists and activity (no prompts). On Windows, the encrypted keys. |
| `~/.claude/jervis-ai-hub/work/` | Copies made for writes, and runs kept for later (removed after 7 days). |
| `~/.claude/jervis-ai-hub/relay/` | Results of Jervis Relay delegations. |
| `<temp>/jervis-ai-hub/` | The empty folder for read-only requests, and your exports. |

## Codex and Antigravity as hosts

The same hub can also run inside Codex and inside Antigravity, as a plugin of theirs. There it can ask, compare, run jobs and show models and limits. It cannot write, delegate or read your project, because those hosts give it no way to ask you first. Inside each host, that host's own AI is never sent requests.

Install and details: [docs/integrations/CODEX.md](integrations/CODEX.md) and [docs/integrations/ANTIGRAVITY.md](integrations/ANTIGRAVITY.md).

## Troubleshooting

| You see | What to do |
| --- | --- |
| `<provider>: its CLI is not installed.` / ○ CLI missing | Install the CLI from [What you need](#what-you-need), then click **Connect**. |
| `agy is not signed in: run agy once in a terminal and sign in.` | Do that, then click **Connect** again. |
| ○ Signed out after a request | The key or sign-in was refused. Sign in again or save a new key, then connect again. |
| `<CLI> <version> is not a version whose … limits the hub has checked` | Install a version from the table in [What you need](#what-you-need). |
| `Project access was not allowed (declined, or nobody could be asked): nothing was sent.` | You chose **Deny**, or nobody could answer (for example a headless run). Ask again and allow it. |
| `Refused: … writes are not held to the folder …` | Antigravity writes are off. Turn on "Allow writes not held to the folder (Antigravity)" only if you accept that risk. |
| `Refused: …, so Codex would not be held to its folder.` | Codex has no MXC sandbox on this Windows. Update Windows (11 24H2 or 25H2), or turn on "Allow Codex without read isolation" if you accept that Codex can read any file you can. |
| `Comparing needs at least two ready providers.` | Connect and test a second provider. |
| `4 jobs are running already` | Wait for one to end, or stop one from the band. |
| `these files changed in the folder after the copy was made, so nothing was applied` | Your folder changed during the run. Run the request again. |
| `No kept changes with run id …` | The run was applied, discarded, or removed after 7 days. |
| `… it may still be running, so check your running processes.` | The CLI did not confirm it ended. Close it in Task Manager or with `kill`. |
| A limit shows "may be out of date" | Click **Refresh** on Limits. |
| Something else | Settings → Diagnostics → **Run checks**, then Activity → **›** on the failed request. |

What changed in each version: [CHANGELOG.md](../CHANGELOG.md).
