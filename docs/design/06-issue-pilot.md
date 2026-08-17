# 06 issue-pilot — issue-level task control plane

> Status: design (not started) | Tier: 1 | Package: packages/control-plane/issue-pilot | Depends on: 01, 04, 05

## Motivation

A production-grade agent control plane is anchored not at chat-session granularity but at
**issue/task granularity** (Symphony's core lesson: after migrating the control plane from
"one person babysitting 3–5 chat sessions" to an issue state machine, the team's landed-PR
throughput went ~5x / ~3 weeks). Its four replicable elements: (1) a per-issue state machine;
(2) an independent workspace per task (SwarmResearch: a separate branch/worktree per path,
context isolation, merging only at the shepherd); (3) WORKFLOW.md (YAML frontmatter + template
body) as the flow contract; (4) an agent running with a goal + tools (including `gh`, CI logs),
landing output as PRs. dsh already has every base primitive (agent registry / session
persistence / shell / jobs / telemetry); what is missing is the layer that orchestrates them
into an issue control plane — this work item is that layer, and it is also an end-to-end
stress test of 04 (gate) and 05 (long-run) (see the doc 00-overview build order).

## Current state and gaps

Already available (deepseek-harness, all verified, citations see "Surfaces and seams"):

- Programmatic creation of standalone agent sessions (specify `cwd`, compose setup, multi-turn steering, dispose) — `ctx.agents`.
- Plugin-level periodic timers (effect-scoped, self-cleaning) — vendored cordis `timer`.
- Foreground command execution (with cwd/timeout/structured result) — `ctx.shell`; background job registry — `ctx.jobs`.
- Slash command registration surface — `ctx.commands`; observability waterfall — `session-telemetry/record`.

Gaps:

- No issue → session lifecycle state machine (discovery, queueing, workspace preparation, driving, CI reflux, review reflux, terminal states).
- No automatic preparation of per-issue worktree + dependency bootstrap (a git worktree only has tracked files, node_modules is absent — an explicit bootstrap is mandatory).
- No WORKFLOW.md contract parsing and composition mount with 04/05.
- No issue state persistence across restarts and no reconciler (`ctx.jobs` is an in-process contract, lost on restart).
- No budget guardrails (concurrency cap, token budget, retry backoff, kill-switch).
- No kill-switch file precedent upstream (grep across the whole repo returns no hits); newly introduced by this design.

## Design

### Surfaces and seams (verified + cited)

The following source repository root: `$DSH = /Users/bytedance/workspace/github.com/deepseek-harness`.

| Seam | Verified surface | Source |
|---|---|---|
| Create per-issue session | `ctx.agents.create(options: CreateAgentOptions): Promise<AgentHandle>`; `CreateAgentOptions = { sessionId, meta?: { cwd?, parentSession?, origin?, delegationDepth? }, seed?, agentOptions?, signal?, setup? }`; `AgentHandle = { agent, dispose() }` | `$DSH/packages/core/agent/src/index.ts:405` (public `create`), `:202` (abstract `createAgent`), `:172` (`AgentHandle`), `:95` (`meta.cwd`, validated absolute) |
| Follow-up steering | `handle.agent.followup(message: UserMessage): void` | `$DSH/packages/core/agent/src/runtime-types.ts:124` |
| Session resume (re-attach after restart) | `ctx.agents.resume(options: ResumeAgentOptions): Promise<AgentHandle>` (requires session persistence) | `$DSH/packages/core/agent/src/index.ts:424` |
| Non-agent caller precedent | SDK server calls `ctx.agents.create({...})` directly in plugin context | `$DSH/packages/sdk/server/src/server.ts:223` |
| Periodic timer | `ctx.interval(callback, delayMs): () => void` (returns dispose; effect-scoped, auto-cleaned on plugin unload); also `ctx.timeout`, async-iterator form | `$DSH/vendor/timer/src/index.ts:5-7` (Context mixin declaration), `:31+` (`TimerService`) |
| Plugin cleanup | `ctx.effect(() => { ...; return dispose })`; agent-scoped listener precedent (schedule's installer) | `$DSH/packages/schedule/schedule/src/index.ts:43-47` |
| gh/git execution | `ctx.shell.run(spec)`, `ShellExecRequest = { command, workdir?, timeoutMs?, signal?, stdoutMaxBytes?, env? }`; resolves `ShellRunResult = { exitCode, signal, timedOut, aborted, timeoutMs, stdout, stderr }`; **rejects only on infrastructure failures, non-zero exit resolves normally** | `$DSH/packages/shell/shell/README.md` (Service API table), `$DSH/packages/shell/shell/src/types.ts:113` |
| Background job registry | `ctx.jobs.start(spec): JobId` (must `attachController(name)` first), `kill/wait/get/list/onJobDone`; **the contract is in-process** (explicit in Known Limitations) | `$DSH/packages/jobs/jobs/README.md` |
| Slash command | `ctx.commands.register({...})` precedent | `$DSH/packages/goal/command-goal/src/index.ts:164` |
| Observability | `session-telemetry/record` waterfall (record can be rewritten via waterfall) | `$DSH/packages/session/session-telemetry/src/index.ts:43` |

Design decisions and implications:

1. **Do not carry per-issue sessions with `ctx.subagents`.** `ctx.subagents.startContinuable()` requires a
   live parent Agent (`$DSH/packages/subagent/subagent/README.md:Service API`), while issue-pilot
   itself is a plugin, not an agent; create top-level sessions directly via `ctx.agents.create()`, with steering done by the pilot itself
   via `handle.agent.followup()`, consistent with binding principle 2 (steer-back follow-ups rather than veto).
   `meta.origin` currently only accepts the literal `'subagent'` (around index.ts:99), so pilot sessions **do not set** origin.
2. **Dependency bootstrap implemented natively, not relying on dsh-cc-plugins' tool-git-worktree** (cross-repo integration is runtime-optional only,
   principle 1; this item explicitly forbids that integration). worktree/dependencies are executed via `ctx.shell.run` running `git` and bootstrap scripts.
3. **Jobs for observability/cancellation, not persistence**: each spawned driving loop is wrapped as a `ctx.jobs`
   job (controller name `issue-pilot`), persistent state lives only in the state file; restarts rely on the reconciler to rebuild.
4. **Approval surface for unattended sessions**: pilot creates top-level sessions, which do not go through the subagent
   delegated-policy pinning; the composition requires the deployment side to provide pilot sessions with the combination of `approval 'never'` + sandboxed
   `ctx.shell` (see risk R2).

### Data model / configuration

**Issue state file** `.dsh/issue-pilot/<owner>/<repo>/<issue>.json` (atomic write: tmp+rename):

```jsonc
{
  "version": 1,
  "issue": { "owner": "o", "repo": "r", "number": 123, "title": "..." },
  "state": "discovered|queued|preparing|running|awaiting-ci|in-review|merged|failed|needs-human",
  "attempts": 1,
  "budget": { "tokensUsed": 0, "tokenLimit": 500000, "wallClockMs": 0 },
  "links": { "branch": "pilot/issue-123", "worktree": ".worktrees/issue-123",
             "pr": null, "sessionId": "..." },
  "cursors": { "lastCommentId": null, "lastCheckRunId": null },
  "lastError": null,
  "history": [{ "from": "queued", "to": "preparing", "at": "ISO", "reason": "..." }]
}
```

State machine: `discovered → queued → preparing → running → awaiting-ci → in-review → merged`;
any non-terminal state can enter `failed` (retryable, attempts++ then back to `queued`) or `needs-human` (terminates to a human).
`merged` is an **observed** terminal state (pilot never performs the merge; merging belongs to humans or repo auto-merge).

**WORKFLOW.md contract** (repo root, Symphony pattern; frontmatter schema-validated, body is a template):

```yaml
---
label: pilot:queued            # input label
steps: [reproduce, fix, test, open-pr]
done:                          # done-criteria, each item mapping to 04 gate kinds
  gates: [tests-green, diff-scope, pr-opened]
allowPaths: ["src/**", "tests/**"]   # diff boundary for 01/trace preconditions
budgets: { tokens: 500000, wallClockMin: 120 }
reviewers: [alice]             # required human review, before merged guaranteed by repo rules
---
Issue: {{number}} {{title}}
{{body}}
<05 long-run-protocol init block: per-round structure, progress ledger format, gates revalidation timing>
```

The body template is rendered per issue and composed into the session via `setup` at spawn time: mount the 05 long-run-protocol init
(progress ledger / resumption discipline), register `done.gates` as 04 gate instances (how `tests-green` runs, `diff-scope`
reads `allowPaths`, `pr-opened` reads `links.pr`), and constrain the tool surface by the 01 tool-manifest side-effect classification.

**Guardrail configuration** (plugin config, all with defaults):

```yaml
issue-pilot:
  repos: [{ owner, repo, workflowPath: WORKFLOW.md }]
  pollIntervalSec: 60
  maxConcurrent: 1            # allow 1-2
  maxAttempts: 3              # exponential backoff base 2^attempts * 5min
  defaultTokenBudget: 500000
  killSwitchFile: .dsh/issue-pilot/KILL
  bootstrapScript: scripts/link-worktree-deps.sh   # default for this repo family; other repos override via config
```

### Key behavior flows

**Main flow (poller → spawn → drive → PR → merge)**:

1. **Poller tick** (`ctx.interval` every `pollIntervalSec`): first check whether the kill-switch file exists; if so, the whole system sleeps;
   `ctx.shell.run({ command: 'gh issue list --label pilot:queued --json number,title,body,labels', workdir: <repoRoot>, timeoutMs: 30_000 })`;
   reconcile against the state directory → new issues are written as `discovered`; if a concurrency slot is free (current `preparing|running|awaiting-ci|in-review`
   count < `maxConcurrent`), then `discovered → queued → preparing`.
2. **Preparing**: `git worktree add .worktrees/issue-<n> -b pilot/issue-<n>`; then bootstrap:
   by default execute per `bootstrapScript` (this repo family uses the `scripts/link-worktree-deps.sh` pattern —
   a worktree only has tracked files; the script symlinks the levels of `node_modules` from the main checkout);
   any failure → `failed` (retryable).
3. **Spawn**: `ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: <worktree absolute path> },
   setup })` — inside `setup`, complete 05 init + 04 gates + 01 tool constraints; after resolve,
   `handle.agent.followup(<rendered WORKFLOW.md body as the first user message>)`, and register the driving loop as a
   `ctx.jobs` job. → `running`; the issue gets labeled `pilot:running`.
4. **Driving**: the agent works inside the worktree, runs tests, opens a PR (`gh pr create` is an action within its tool surface,
   side effects already classified per 01). Each tick pilot reads `gh pr list --head pilot/issue-<n> --json number,state`;
   when the PR appears → `awaiting-ci`, record `links.pr`.
5. **CI reflux**: `gh pr checks <pr> --json name,state`; all green → `in-review` (post a `needs human review`
   comment); any red → inject a `gh run view --log-failed` summary via `followup()` (message carries a plugin attribution prefix
   `[issue-pilot:<issue>#<attempt>]` — steer messages participate in round accounting, attribution must be explicit, principle 2).
6. **Review reflux**: `gh pr view <pr> --json comments,reviews`; incrementally via `cursors.lastCommentId`,
   new review comments → inject via `followup()` requesting changes; the agent fixes and pushes a new commit, back to CI reflux.
7. **Merge observation**: `gh pr view --json mergedAt` non-empty → `merged`; swap label to `pilot:done`,
   remove `pilot:running`; cleanup bookkeeping records the post-settlement cost (keep the worktree by default, cleaned uniformly by the GC subcommand).

**Budget and retry**: each tick accumulates `budget.tokensUsed` from the session telemetry snapshot; on exceeding the limit →
`handle.dispose()` + label `needs-human` + issue comment. Repeatedly failing gates → `failed`, after backoff
back to `queued`; `attempts` reaching `maxAttempts` → `needs-human`.

**Restart reconciler**: on plugin load, scan the state directory: non-terminal but no corresponding live job in `ctx.jobs` →
if session persistence is available, `ctx.agents.resume()` to resume driving (attempts unchanged), otherwise per the retry policy
back to `queued` (attempts++). `merged/needs-human` untouched.

**Human-facing surface**: `/issue-pilot run <n>` (manually discover and enqueue an issue, skipping the label wait),
`/issue-pilot status [n]`, `/issue-pilot report`, `/issue-pilot gc`.

### Failure taxonomy

| Type | Detection signal | Recovery action |
|---|---|---|
| stuck-loop | In `history`, K consecutive ticks (default 3) in `running` with unchanged branch head SHA and no new gate passing | dispose + `needs-human`, with the most recent gate failure summary and token consumption attached |
| gate-flapping | The same 04 gate alternates between pass/fail ≥ M times (default 3) (read gate history events) | freeze retries → `needs-human`, with flapping report attached (gate name, alternation sequence) |
| ci-flake | Same-named check on the same head SHA goes red then green (check run id changes, SHA unchanged) | Trigger rerun (`gh run rerun --failed`), **not counted in attempts**, flake count +1 into telemetry |
| conflict-on-rebase | `gh pr view --json mergeable` = `CONFLICTING`, or rebase exits non-zero with conflict markers | First time: steer the agent to rebase + resolve conflicts; second failure → `needs-human` |

Detection logic depends only on state files + `gh`/`git` read-only commands, never intruding into the agent session internals.

### Metrics and billing

The purpose of the design is measurement; everything goes through `session-telemetry/record` uniformly (principle 5), events:

- `issue-pilot/state-transition`: `{issue, from, to, attempt, elapsedMs}`
- `issue-pilot/gate-failure`: `{issue, gateKind, attempt}` — gate failure distribution
- `issue-pilot/budget`: `{issue, tokensUsed, tokenLimit, outcome}` — per-issue cost
- `issue-pilot/landed`: `{issue, pr, leadTimeMs}` — landed-PR throughput

`/issue-pilot report` aggregates from the state directory + telemetry: 7d window landed PR count, p50/p90
time-to-merge, per-merged-PR token cost, gate-failure distribution, `needs-human` rate.
The comparison group is the throughput metrics reported by Symphony — this plugin turns that comparison measurement into a standing output rather than a one-off report.

## Milestone breakdown

**M1 — State machine + poller + manual spawn (no automatic PR opening)**
State store (atomic writes + schema) + `gh issue list` poller (kill-switch, concurrency cap) +
`/issue-pilot run <n>`: spawn a single isolated session with cwd at the main repo (worktree/04/05 not yet attached),
session goal is the rendered WORKFLOW.md body; `ctx.jobs` wraps the driving loop; state stops at `running`,
PR/CI flow not done. Unit tests: state machine legal transitions, atomic write concurrency, kill-switch effectiveness, poller reconciliation.
**Verification**: create a test issue labeled `pilot:queued`, `/issue-pilot status` shows
`discovered→queued→running`, and the session indeed receives the rendered body (read its session's first user message).

**M2 — worktree isolation + dependency bootstrap + 04/05 composition + PR/CI reflux + telemetry**
per-issue `git worktree add` + bootstrapScript execution & failure classification; `setup` mounts 05 init,
04 done.gates, 01 tool constraints; PR detection, `awaiting-ci → in-review` transition, CI red → steer reflux,
merge observation → `merged` + label rotation; the four telemetry event types land in waterfall.
**Verification**: end-to-end on a sandbox issue in this repo producing a PR (if checks are green, reaching `in-review`);
inject a gate failure (break a test) confirming the steer reflux message carries the `[issue-pilot:...]` prefix and the session continues fixing;
`pnpm test` all green.

**M3 — review reflux + guardrails + reports + failure taxonomy coverage**
Comment incremental injection; token budget exceeded → dispose + `needs-human`; backoff retry + maxAttempts;
restart reconciler (`resume` or back to `queued`); `/issue-pilot report` + `gc`;
each of the four failure taxonomy rows gets targeted tests (an injectable mock seam constructing fake `gh` output).
Documentation (README + graduation criteria section).
**Verification**: each of the four failure rows has at least one test asserting "detection signal → recovery action"; the report command output contains
7d landed / gate distribution / needs-human rate three items; after a simulated restart the reconciler recovers running sessions (no-op counts as failure).

## Validation plan

- Pure unit test layer: state machine transition table, frontmatter schema validation, cursor incremental logic, backoff computation —
  `gh`/`git` all going through the injected `ctx.shell` mock (asserting the command strings from spec).
- Integration layer (real repo with real `gh` pointing at a sandbox repo): end-to-end scripts for M1/M2, asserting label rotation and PR landing.
- Composition verification (00-overview principle 6: all gates green): after scaffolding with `pnpm new:plugin control-plane issue-pilot`,
  typecheck/lint/test all green.
- Measurement verification: after M2 works, manually cross-check the three metrics in `/issue-pilot report` against manual bookkeeping.

## Risks and open questions

- R1 **`ctx.jobs` in-process contract**: restarts lose live jobs; the reconciler can only `resume` if session persistence is present; in a composition without persistence, an interrupted `running` can only be re-spawned — before M2, confirm the target deployment composition
  mounts `session-persistence-*` (check: the composition profile's plugins list).
- R2 **Permission surface of unattended sessions**: pilot creates top-level sessions, which do not go through subagent delegated-policy
  automatic pinning of `approval 'never'`; if the deployment composition defaults to ASK, the session will deadlock on an approval nobody attends to.
  Open: whether an explicit `approval/policy` injection is needed inside `setup` (check: `dsh-approval`'s session-level
  policy write API, similar to the `sandbox/mode` `effectiveSandboxMode` mechanism).
- R3 **Composition mount of the timer service**: `ctx.interval` comes from the vendored `timer` (`vendor/timer`);
  must confirm the host composition has registered that service, otherwise the plugin needs to bring its own `ctx.plugin(TimerService)` (check:
  whether the target profile's cordis.yml contains timer).
- R4 **client-runner has its own timer mixin** (`extensions/cordis-client-runner/src/client/timer.ts`);
  if the plugin runs on the extension side, must confirm which copy it gets; in M1, a 30s interval smoke test with the real composition is enough to defuse this.
- R5 **Budget accounting caliber**: per-issue token count depends on telemetry session snapshot fields (which fields to read
  to be decided in M2: check the `session-telemetry` record schema's token field names); if granularity is insufficient, degrade to
  wallClock + round count approximation.
- R6 **kill-switch is self-invented** (no upstream precedent): semantics are "if present, reject new work; running sessions stop naturally after
  finishing their current gate validation"; no forced kill (forced kill = dispose each handle, listed as a separate `/issue-pilot stop` command, not in file semantics).
- R7 **01/04/05 spec documents not yet landed** (the design directory currently only has 00-overview and this piece): this design's
  references to gate kinds / long-run init / manifest classification are to be calibrated against the APIs when those documents land.
