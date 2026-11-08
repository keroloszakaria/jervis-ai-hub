# Core hardening audit

Branch `fix/core-hardening`, cut from `main` at `13c9903` (0.10.11). Every finding below was read in the code, reproduced where it can be, fixed on this branch, and covered by a regression test. A finding marked **Mitigated** is limited by the engine and cannot be fully closed from the plugin.

How the evidence was gathered:

- Reading the code, by hand and in an independent read-only review.
- Running the real CLIs: Antigravity 1.5.3, Codex, and OpenCode 2.1.4.
- Running the real-git checks (`ci/real-workspace.ts`, `ci/real-gitguard.ts`).
- Running the plugin test suite (`claude plugin test .`).

"Fails on old code" means the new test was run against the `main` version of the file and failed there.

| ID | Severity | Area | Status |
| --- | --- | --- | --- |
| H-01 | High | Antigravity prompt on the command line | Fixed |
| H-02 | High | Windows junction escapes the copy and Apply | Fixed |
| H-03 | High | A half-written Apply reported as "nothing was applied" | Fixed |
| H-04 | High | No guard against hub → agent → hub loops | Fixed |
| H-05 | High | A stopped request may leave its CLI running | Mitigated |
| R-01 | High | Routing rules not checked against the task | Fixed |
| R-02 | Medium | A fallback with smart routing off ignores vision | Fixed |
| L-01 | High | `every()` limit logic: one spent window did not count | Fixed |
| L-02 | Medium | Unknown and old readings read as free | Fixed |
| L-03 | Medium | Loose substring matching of model groups | Fixed |
| S-01 | Medium | Heavy work stepped down to a weaker level; ties not fixed | Fixed |
| M-01 | Medium | Relay delegation has no time limit and no Stop | Fixed |
| M-02 | Medium | The hub's git on the user's repo can run repo-defined programs | Fixed |
| M-03 | Medium | Jobs left "running" by a reload block `start_job` | Fixed |
| W-01 | Medium | Lost updates to the kept-runs record | Fixed |
| C-01 | Low | `compare_ai` silently drops providers | Fixed |
| U-01 | Low | "The person declined" wording in headless runs | Fixed |
| L-04 | Low | A kept run checked against the wrong session after `/clear` | Fixed |
| L-05 | Low | A job's result shows in the next session | Fixed |
| L-06 | Low | A bare repository or `.git` read as "not a repository" | Fixed |
| L-07 | Low | Clean-up of left-behind copies races another session | Fixed |

---

## H-01 Antigravity prompt on the command line

- **Where:** `hooks/cli.ts` `invocation()` (agy branch), `hooks/requests.ts`.
- **Root cause:** the prompt was the value of `-p`, so it sat in the process's argv.
  - Any local user or tool could read it through the process list (`ps`, Task Manager, EDR logs).
  - A length cap (`MAX_ARG_PROMPT`) refused long prompts instead of sending them another way.
- **Evidence:** the old code built the argv `[agy, -p, <prompt>, ...]`. With the real agy 1.5.3, `--input-format stream-json` with the message on stdin was confirmed to work: it emits `init`, `step_update` and `result` events.
- **Impact:** prompts that may hold private code or text were exposed to other processes, and long prompts failed.
- **Fix:**
  - argv is now `--input-format stream-json --output-format stream-json [model] [mode] -p=`.
  - The prompt goes on stdin as one JSON line: `{"event":"user","message":{"role":"user","content":…}}` (`agyStdin`).
  - The output is read from the `result` event, falling back to the older plain JSON.
  - The length cap is gone.
- **Tests:**
  - `H-01 Antigravity gets its prompt on stdin…`: sensitive, Unicode/RTL, multiline, emoji/CJK and 200,000-character prompts, in read and write modes.
  - `H-01 … result event, success and failure`.
  - `H-01 a real Antigravity request never puts the prompt in its arguments`.
- **Status:** Fixed.

## H-02 Windows junction escapes the copy and Apply

- **Where:** `hooks/workspace.ts` `makeCopy()` and `applyRun()`.
- **Root cause:** `git ls-files` lists files under a junction (or a linked folder) as ordinary paths.
  - The copy read files from outside the project through it.
  - An Apply could write or delete outside it, including through a folder replaced with a junction after the copy was made.
- **Evidence:** `ci/real-workspace.ts` makes a real junction. On the `main` workspace.ts, two checks fail:
  - "a file reached through a junction is not in the copy";
  - "an Apply through a folder made into a junction is refused".
- **Impact:** files outside the approved folder could be read into a copy sent to a provider, or changed by an Apply.
- **Fix:**
  - `foldersLeadingOut()` resolves each parent folder's real path (`$.fs.stat(…, { resolve: true })`) and compares it with the project's real root; a folder that cannot be resolved counts as outside.
  - The copy leaves those files out (`why: 'link'`).
  - The check runs again right before an Apply, and the Apply is refused if any changed path goes through such a folder.
- **Tests:** the two `ci/real-workspace.ts` checks above. Both fail on old code and pass now.
- **Status:** Fixed.

## H-03 A half-written Apply reported as "nothing was applied"

- **Where:** `hooks/workspace.ts` `applyRun()`.
- **Root cause:** git checks a patch before writing, but a write can still fail part way (a locked or read-only file). The hub then said "nothing was applied" without looking.
- **Impact:** the person was told the folder was untouched when it was partly changed.
- **Fix:**
  - After a failed `git apply`, the hub compares the folder with the base and finds files that were written.
  - It reverses those with `git apply -R --include=…`, then checks again.
  - The answer says either "those were put back, so nothing was applied", or names the files that could not be put back (`isMixed`).
- **Tests:** `ci/real-workspace.ts` "a half-written Apply is put back and never called applied". It runs on POSIX as a non-root user (it needs a read-only folder) and is skipped on Windows.
- **Status:** Fixed. Not run locally on Windows; CI (Linux) runs it.

## H-04 No guard against hub → agent → hub loops

- **Where:** `hooks/requests.ts` `execute()`, `hooks/delegation.ts` `delegate()`, new `hooks/hops.ts`.
- **Root cause:** once Codex or Antigravity carry their own Jervis plugin (Phases 3–4), a request could pass from the hub to an agent, back to a hub inside it, and onward without limit.
- **Fix:**
  - Every CLI the hub starts gets `JERVIS_HUB_DEPTH=<depth+1>` and `JERVIS_HUB_PARENT=<activity id>`.
  - A hub whose own environment has a depth of 1 or more (`MAX_HOPS = 1`) refuses `ask_ai`, `compare_ai`, jobs on another AI, and delegation, before anything runs. The refusal is a policy refusal, so it is never fallen back from.
- **Tests:**
  - `H-04 every CLI the hub starts is told its depth, and a hub inside one sends nothing on`.
  - `H-04 a delegation from a hub inside an agent a hub started is refused…`.
- **Status:** Fixed for every path through the hub. A loop that skips the hub (an agent starting another agent's CLI itself) is outside the hub's reach.

## H-05 A stopped request may leave its CLI running

- **Where:** `hooks/requests.ts` `runStoppable()`.
- **Root cause:** on Stop or timeout, the stream was ended with `stream.return()` but not awaited.
  - A CLI that writes nothing may keep a pull pending, so ending the stream may not end the child.
  - The answer still said "stopped".
- **Evidence:** in the test engine, a CLI that never writes cannot be ended this way. That matches what the review warned about.
- **Fix:**
  - The hub now waits for `stream.return()` for up to `KILL_WAIT_MS` (5 s).
  - If the engine does not confirm the child ended, the answer adds: "it may still be running, so check your running processes".
- **Tests:** `Stop ends a running request…` now asserts that the note appears for a CLI that cannot be ended.
- **Status:** Mitigated. The plugin API has no kill-by-pid, so whether the child ends is up to the engine. The hub no longer claims more than it knows.

## R-01 Routing rules not checked against the task

- **Where:** `hooks/routing.ts` `route()`.
- **Root cause:** a rule was used whenever its provider was ready. This held even when:
  - the rule named a model the provider no longer offers;
  - the rule named a model that does not report what the task needs, such as image input for vision.
- **Fix:**
  - New `validateRoute()` checks three things: the provider is ready, the model is one it offers, and the model reports each needed capability. With no model set, it picks the first model that reports them.
  - A skipped rule is named in the reason (`vision: deepseek/deepseek-chat does not report image-input`).
  - Precedence is unchanged: explicit provider, then rule, then default, then smart.
  - Preview and execution use the same `route()`.
- **Tests:** `R-01 a vision rule set to a model without image input is skipped…` and `R-01 a rule naming a model the provider does not offer is skipped`.
- **Status:** Fixed.

## R-02 A fallback with smart routing off ignores vision

- **Where:** `hooks/routing.ts` `askWithFallback()`.
- **Root cause:** with smart routing off, the next provider was used with its default model, whatever the task needed.
- **Fix:** the fallback goes through `validateRoute({ provider }, needs)`. A provider with no model that can take the task is skipped.
- **Tests:** `R-02 with smart routing off, a vision request never falls back to a model without image input`.
- **Status:** Fixed. This test was not run against the old file: the change sits in a function that other fixed code now depends on.

## L-01 `every()` limit logic

- **Where:** `hooks/limits.ts` `isAtLimit()`.
- **Root cause:** a provider counted as at its limit only when every window was spent. A spent account-wide window, such as a weekly window at 100%, did not count while a 5-hour window had room, so the router kept sending requests that would fail.
- **Fix:** new `limitState()`.
  - Any spent account-wide (ungrouped) window means `exhausted`.
  - For a model, the windows that cover it decide.
  - For the provider, it is `exhausted` only when every model group is spent.
  - Over 80% used means `limited`.
  - `isAtLimit` is `limitState(…) === 'exhausted'`.
- **Tests:** `L-01 one spent account-wide window makes the provider exhausted`. It also covers the real Antigravity groups "Gemini Models" and "Claude and GPT models".
- **Status:** Fixed.

## L-02 Unknown and old readings read as free

- **Root cause:** none of these cases had a state of its own, and each read as "not at limit", which the router treated as free:
  - no reading;
  - an error;
  - a reading with no windows;
  - a model no window covers.
- **Fix:** the explicit states are `available`, `limited`, `exhausted`, `stale` (over 30 minutes old), `unknown` and `unsupported`. Nothing is estimated.
- **Tests:** `L-02 unknown, stale and unsupported limits are never read as free or spent`.
- **Status:** Fixed.

## L-03 Loose model-group matching

- **Where:** `hooks/smart.ts` `usedFor()`.
- **Root cause:** a group matched a model if any word of the group appeared anywhere in the model's name. So "Pro" matched `promo-model`, and "Gemini 3 Pro" matched Gemini 4.
- **Fix:** `groupCovers()`.
  - It matches whole words only.
  - Alternatives are split on "and", "," and "/".
  - Every word of one alternative must be a word of the model's id or label.
  - One matcher is used by both the router and `limitState`.
- **Tests:** `L-03 a model group covers a model by whole words only`.
- **Status:** Fixed.

## S-01 Heavy work stepped down; ties not fixed

- **Where:** `hooks/smart.ts` `smartPick()`.
- **Root cause:**
  - When nothing served the heavy level, the pick fell back silently to the standard level. Heavy work covers security, architecture and incidents.
  - Equal scores were broken by list order.
- **Fix:**
  - `strictLevel`, which defaults on for heavy, refuses with "heavy work is not stepped down to a weaker level".
  - Ties go plan before API key, then by provider id, then by model id.
- **Tests:** `S-01 heavy work with no model that serves it is refused, not sent to a weaker level`.
- **Status:** Fixed.

## M-01 Relay delegation has no time limit and no Stop

- **Where:** `hooks/delegation.ts` `delegate()`.
- **Root cause:** the relay process was read to its end with no deadline, and it was not registered with Stop.
- **Fix:**
  - The relay runs through the same `runStoppable()` as requests: a 30-minute limit (`RELAY_TIMEOUT_MS`), and Stop from its activity row.
  - The answer says it was stopped, that changes so far stay for review, and which files the hub saw change.
- **Tests:** `M-01 a relay delegation that never ends is stopped at its time limit…`.
- **Status:** Fixed.

## M-02 The hub's git on the user's repository can run repo-defined programs

- **Where:** `hooks/gitguard.ts` `git()`, `snapshot()`, `workState()`.
- **Root cause:** the hub runs `git status` and `git hash-object` on the user's repository before and after a write.
  - An agent with write access can add a `core.fsmonitor` command or a clean filter to `.git/config`, `.git/info/attributes` or `.gitattributes`.
  - The hub's own git, which runs outside any sandbox, would then run it.
- **Evidence:** `ci/real-gitguard.ts` adds a clean filter that writes a marker file. On the `main` gitguard.ts the marker is written: the check fails.
- **Fix:**
  - Every hub git call on the user's repository runs with `-c core.fsmonitor=false -c core.untrackedCache=false --no-pager`.
  - `hash-object` runs with `--no-filters`.
  - The config and attributes files are read as text before the run. If they changed, the hub does not run git on the repository again and says so: "check those files … before running git".
- **Tests:** `ci/real-gitguard.ts` "a filter added during the run is never run by the hub, and the list says why". It fails on old code and passes now.
- **Status:** Fixed.

## M-03 Jobs left "running" by a reload block `start_job`

- **Where:** `hooks/jobs.ts`.
- **Root cause:** job rows live in session state, which survives a hot reload; the module's in-memory runs do not.
  - A job on another AI that was running at reload stayed "running" forever.
  - Those rows counted against the four-job limit.
- **Fix:** `settleJobs()` runs at every session start.
  - A running job on another AI that this module is not running ends as `failed`, with "the hub reloaded while it ran, so its result was lost".
  - The pure rule is `settleRows()`.
- **Tests:** `M-03 jobs on another AI left running by a reload end as failed, and free their slots`.
- **Status:** Fixed.

## W-01 Lost updates to the kept-runs record

- **Where:** `hooks/workspace.ts` `remember()`, `forget()`, `cleanOldRuns()`.
- **Root cause:** each was a read-change-write of one store key, and `$.store` has no compare-and-set. Two runs ending together could drop one record, which lost a "Keep for later" run.
- **Fix:** all three go through one in-module queue (`withRuns`).
- **Tests:** `two runs that end together are reviewed one after the other…` now also asserts that both kept records are in the store.
- **Status:** Fixed within one engine process. Two engine processes writing the same store key is an engine limit.

## C-01 `compare_ai` silently drops providers

- **Root cause:** with a level set, a provider that had no model for that level was left out of an unnamed comparison without a word.
- **Fix:** each left-out provider is named with why (`_Left out: DeepSeek: …_`), both in the answer and in the "needs at least two" refusal.
- **Tests:** `C-01 a comparison names each ready provider it left out, and why`.
- **Status:** Fixed.

## U-01 "The person declined" in headless runs

- **Root cause:** a question nobody could answer (headless, or `claude -p`) was reported as the person's no.
- **Fix:** the wording now reads "Not allowed (declined, or nobody could be asked)" for project reads, writes, delegation and jobs.
- **Status:** Fixed.

## L-04 A kept run checked against the wrong session after `/clear`

- **Where:** `hooks/workspace.ts` `isThisSessions()`, `hooks/actions.ts` `applyChangesTool()`.
- **Root cause:** after a `/clear` the module stays loaded, so a run kept in the old session counted as "this session's". The check that it belongs to this session's folder was then skipped.
- **Fix:** each kept run records the session that made it, and only that session skips the folder check.
- **Tests:** `L-01w a run kept in one session is, after a /clear, checked against the new session folder`. It fails on old code and passes now.
- **Status:** Fixed. An Apply still needs the person's own Apply in every case.

## L-05 A job's result shows in the next session

- **Root cause:** a finished job's summary (the first 240 characters of its answer) stayed on its row and showed in the next session's band and `job_status`.
- **Fix:** rows record their session. At session start, a finished row from another session shows "it belonged to an earlier session, so its result is not shown here". The hub's own notes stay.
- **Tests:** `L-02 a job of an earlier session shows no piece of its result in the next one`, and part of `M-03`.
- **Status:** Fixed.

## L-06 A bare repository or `.git` read as "not a repository"

- **Where:** `hooks/gitguard.ts` `snapshot()`.
- **Root cause:** `rev-parse --is-inside-work-tree` prints `false` in a bare repository and inside `.git`. The hub took that to mean no repository at all, so no ref guard ran.
- **Fix:** `false` is now a repository whose refs are read and guarded.
- **Tests:** `ci/real-gitguard.ts` "a bare repository is read as one, with its refs" and "the .git folder is read as the repository".
- **Status:** Fixed.

## L-07 Clean-up races another session

- **Root cause:** `cleanOldRuns` dropped every record whose folder it had not just listed, including one another session had made a moment ago.
- **Fix:** a record is dropped only when its id is invalid, or when its folder is missing and it is older than `LEFT_BEHIND_MS`.
- **Status:** Fixed. There is no dedicated test, since it needs two sessions racing.

---

## Confirmed safe (checked, no change needed)

- **Apply approval:** an Apply happens only on the person's own answer through `$.ui.ask`. A tool call cannot apply by itself, and `apply_changes` asks again.
- **Keys:** keys travel by environment or stdin only, are redacted from answers, errors and the activity log, and are kept in OS secure storage (DPAPI or Keychain) with only a marker in the store.
- **Concurrency:** `MAX_RUNNING` holds under jobs started at the same moment, and identical in-flight reads run once.
- **Refs:** a delegation or write in a repository runs with refs locked (a `reference-transaction` hook and blocked push URLs) and is checked before and after.
- **Limits:** limits are read only through each provider's official means. No value is estimated or invented.

## Not covered by this audit

- **Interactive approval paths on real surfaces:** Allow, Deny and closing the dialog are covered by the test engine, not by a person clicking in the desktop app.
- **Cross-process store races:** two Claude Code processes writing one key at once. This is an engine limit (there is no compare-and-set).
- **Isolation inside the agents:** whether Codex's or Antigravity's own sandbox holds is checked by `ci/real-cli.ts` against the installed versions only.

## Gate

The results are recorded in `docs/reports/MULTI_HOST_IMPLEMENTATION_REPORT.md`:

- the typecheck (`tsconfig.json` and `tsconfig.ci.json`);
- `claude plugin validate .`;
- `claude plugin test .`;
- `ci/real-workspace.ts`, `ci/real-gitguard.ts` and `ci/real-cli.ts`.
