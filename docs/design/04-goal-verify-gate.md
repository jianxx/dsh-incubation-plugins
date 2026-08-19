# 04 goal-verify-gate — the pre-completion verification gate

> Status: design (not started) | Tier: 1 | Package: packages/goals/goal-verify-gate | Depends on: none (optional integration with 03)
>
> Verified seams against deepseek-harness **0.1.0-rc.7** (@99f6f02fec); path:line citations refer to that tree.

## Design goal and user problem

**Goal**: gate the goal's `complete` transition behind verification gates that must actually execute and pass (command exit codes / file existence and content / session-event evidence); a failing gate leaves the goal active (STALL) — completion can never be claimed without evidence — and repeated failures escalate to an ASK for the user at a configurable threshold.
**User problem**: the agent declaring "done" costs it nothing — today a /goal's completion is pure model self-discipline, and the user only discovers the gap between "announced complete" and reality afterwards; in unattended long runs, fabricated completion is the most expensive failure mode there is.

## Motivation (why this is necessary — DONE gate / anti-false-completion / the third layer of three-layer state recovery)

doc 00's three-layer state recovery: resumable event stream (session log replay,
already upstream) → resumable execution environment (already upstream) →
**goal-verification gate — this work item**. Without this layer, `update_goal`'s
`complete` is nothing but model self-discipline: the prompt guidance says
"Mark complete only when the objective is actually achieved"
(tool-goal/src/index.ts:119), yet the harness performs zero machine verification
of "completion" — the model can push a goal to its terminal state with a single
sentence at any time. This is exactly the failure mode Goal-Autopilot indicts:
DONE must be externalized into a gated verdict; a goal that has not passed the
executed+passed gate may only STALL and must never claim success.

Placement within the three-layer verification stack: 01/02 govern "whether an
individual tool result/claim looks real", 03 governs "whether the trajectory is
legitimate", and this work item governs "completion verdicts at the goal
level" — the outermost layer, and the only one that can refuse a durable state
transition. GODR's goal-lifecycle demands (suspend/resume/invalidate/
return-point) are **mostly already satisfied by upstream core ops**
(pause = suspend, resume, block ≈ invalidate-with-reason,
edit ≈ return-point correction, clear); this document explicitly does not
rebuild them (see next section).

Gate-failure feedback must be **actionable corrective feedback** (which gate
failed, what is missing, how to fix it), not a blanket rejection — the same
stance as doc 02 (Prompts-to-Contracts: verdict authority lives in code;
feedback serves the model's recovery).

## Current state and the gap

Verified (paths and line numbers are itemized in the next section):

- `ctx.goals` (GoalService, event-sourced + CAS) already has the full set of
  domain operations: `create / edit / pause / resume / complete / block /
clear`, the durable `goal/change` event + the real-time `goal/changed`
  notification; `goal-round-driver` drives round continuation and attributes
  messages to rounds; tool-goal already has the dual authority channels
  direct-human / goal-round.
- So the GODR lifecycle = already exists; **the gap is exactly one point:
  there is no programmable gate on the `complete` transition**. The marginal
  cost of the model self-reporting completion is zero.

**Explicitly not writing a parallel FSM**: no copy of the GoalSnapshot/phase
machine, no separate durable store independently deciding done-ness. Two
durable state machines each telling their own story about "completed or not"
is the top failure mode of this work item; the way to avoid it is to gate only
the complete transition (a domain extension of GoalService), with the
`goal/change` log remaining the sole authority on done-ness.

## Design

### Surfaces and seams (verified + cited)

1. **The only model path to completion = a tool call**: the model has exactly
   one route, `update_goal(action:'complete')`, landing on
   `ctx.goals.complete(agent, ref)`
   (`packages/goal/tool-goal/src/index.ts:307-308`; action enum `:41-43`).
   The `/goal` slash-command syntax **has no complete**
   (`packages/goal/command-goal/src/index.ts:14` USAGE, parsing `:33-43`), so
   a human cannot bypass via command either. → Interception seam = the
   `tools/pre-execute` waterfall (`packages/core/tools/src/index.ts:142-152`),
   decision type `PreToolDecision = allow | deny {reason} | ask {reason?}`
   (same file `:583-591`): `deny` materializes as a model-visible error
   result (reason is the corrective feedback); `ask` is routed by the
   registry through `serviceAsk` (`:1690-1726`) into the approval waterfall,
   `allowed-once → allow`, the other three states → differently worded
   denies; **with no approval service, ask deterministically degrades to
   deny**. The input `ToolExecution` carries `{name, arguments, callId,
agent?, signal}` (`:314-337`, `:379-384`) — matched on
   `exec.name==='update_goal'` and `arguments.action==='complete'`, with
   `arguments.goal_id` directly yielding the target.
2. **No veto seam at the service layer**: `ctx.goals.complete`
   (`packages/goal/goal/src/index.ts:336-346`) goes straight to the
   transition; GoalService has no pre-mutation hook; `goal/changed` is a
   post-commit emit notification (`:557`, declared at
   `packages/goal/goal/src/domain.ts:104-116`) — listener failures are
   swallowed but cannot veto. Wrapping `goals` via same-name cordis service
   re-registration is infeasible (service keys are single-owner;
   re-registering throws — same constraint noted in the session-telemetry
   service-key comment `:144-146`). → v1 interception sits at the tool seam;
   the gap of programmatic direct-call bypass is logged as Risk 1.
3. **Gate results cannot ride along on goal/change**: durable payloads are
   strictly decoded — `decodeSnapshot` requires an exactly-equal field set
   (`packages/goal/goal/src/fold.ts:87-112`, "must have exactly ... fields"),
   and `GoalSnapshot` has no metadata extension slot
   (`packages/goal/goal/src/types.ts:59-68`); the custom session-event
   registration surface is not open (doc 02 Risk 3 reaches the same
   conclusion). → Gate declarations and reports are stored by the plugin
   itself (see Data model).
4. **Steer-back seam**: the `agent/turn-stopping` serial hook
   (`packages/core/agent/src/runtime-types.ts:261-278`): "a listener that
   objects steers (`agent.steer(...)`) … fresh steering runs another step,
   none closes the turn"; `agent.steer(message: UserMessage): void`
   (`:133`). A steer continues **the same open turn** (the turn is not
   yet closed), the original turn's authority context (direct-human or
   goal-round) is preserved, and the model may still legitimately call
   complete after being steered. The attribution shape follows tool-goal's
   existing precedent: `createUserMessage({ content, source: { kind:
'plugin', plugin: 'goal-verify-gate', form: 'notice', summary } })`
   (the deferContext usage at `packages/goal/tool-goal/src/index.ts:313-324` —
   we inject directly via `agent.steer`). `kind:'plugin'` grants no goal
   authority (`packages/goal/tool-goal/src/authority.ts:65-74`) and is not
   mistaken for a new round by the round driver (round admission requires
   `source.kind==='goal'` plus an exact match on `roundsStarted+1`,
   `packages/goal/goal-round-driver/src/index.ts:48-58`, `:174-178`) —
   **steer-back consumes no round budget**, and the attribution discipline
   satisfies doc 00 principle 2.
5. **Telemetry seam**: the `session-telemetry/record` waterfall +
   `SessionTelemetryRecord{channel, severity, attributes, body}`
   (`packages/session/session-telemetry/src/index.ts:35-46`, `:64-86`); the
   send point = `ctx.sessionTelemetry.emit()` (service-key registration
   `:148-151`, sink emit is a non-blocking enqueue `:94-104`). This plugin
   uses the **ops channel** exclusively, with `attributes = { telemetry.op:
'goal-verify-gate/<event>', session.id, agent.id }`; goal/gate details go
   in `body` (the attributes vocabulary discipline is untouched). Skipped
   when no backend is mounted (null-check via `ctx.get('sessionTelemetry')`).
6. **ASK seam (stall escalation)**: `ApprovalRequest = { agent, toolName,
callId?, reason?, signal? }`
   (`packages/interaction/user-approval/src/index.ts:153-174`),
   `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' |
'unavailable'` (`packages/interaction/user-approval/src/types.ts:29`). ASK
   is dispatched by the registry on the plugin's behalf — the plugin only
   returns `{ kind: 'ask', reason }` from pre-execute; the reason must itself
   carry the gate-failure summary and an explanation of the decision options
   (the UI renders only this text). The ask/outcome is written to session
   audit by ApprovalService itself (`:188-190` comment).
7. **Session-event observation seam** (the evidence surface for the
   session-event-required gate): the `session/event` observer,
   `tool/call {turn, step, callId, name, arguments}` /
   `tool/result {turn, step, message, error?, meta?}` /
   `turn/end {turn, reason}` (`packages/core/session/src/types.ts:252-291`,
   `:155-176`; already verified in doc 02).
8. **State-storage location**: the `.dsh/` project directory is an existing
   upstream convention (`<projectRoot>/.dsh/skills` at
   `packages/skill/skill-filesystem/src/index.ts:246`). A gate declaration is
   a **goal-lifecycle adjunct**, keyed by goalId and stored at
   `<session.header.cwd>/.dsh/goal-verify-gate/goals/<goalId>.json`: goalId
   is stable across resume/fork (replay yields the same id), and the
   session-header cwd is a validated absolute path
   (`packages/core/session/src/index.ts:112-115`, header attributes
   `:436-446`). The corresponding file is deleted on goal `clear`. Sessions
   missing a cwd: command/file-kind gates refuse declaration and warn
   (Risk 3).
9. **Command location**: core `/goal` is not extensible (unknown input is
   parsed as a create objective, command-goal `:33-43`), and
   `commands.register` throws on a name clash
   (`packages/interaction/commands/src/index.ts:77-82`, `:245`). → Register a
   standalone command `/goal-gate <add|list|remove|reset>`, leaving upstream
   syntax untouched.

### Data model / configuration (gate declaration schema, modes, stall policy)

> **Configuration (rc.7 onward)**: user-tunable knobs (here: the global gate
> mode and stall-policy defaults) are declared through a settings namespace
> (`settingsNamespace` + `installSettingsSection`,
> `packages/settings/settings/src/index.ts:863`). Resolution layers: schema
> defaults → the cordis composition entry (base) → the `settings.yaml` user
> document. Values hot-reload via `settings/updated` and are readable at runtime
> through `ctx.settings.describe()`. Registering a namespace exposes it — #2404
> removed the apiproxy allowlists, so registration is the only exposure control
> — which means both the web settings page and `settings.yaml` can edit it. The
> cordis `apply(ctx, config)` second argument remains the composition-defaults
> layer; per-goal `GateSpec.mode` overrides apply below it.

```ts
type GateMode = "off" | "audit" | "enforce";

interface GateSpec {
  id: string; // kebab-case, unique per goal, referenced by telemetry
  kind: string; // registry key; built-ins see "Built-in gate list"
  mode?: GateMode; // falls back to the global mode when unset
  config: JsonObject; // kind-specific parameters
}

interface GateReport {
  gateId: string;
  kind: string;
  passed: boolean;
  detail: string; // actionable description: exit code, missing path, unmatched regex…
  durationMs: number;
  attemptedAt: number;
}

interface GoalGateState {
  // .dsh/goal-verify-gate/goals/<goalId>.json
  goalId: string;
  gates: GateSpec[];
  consecutiveFailedCompletions: number;
  lastAttempt?: {
    at: number;
    allPassed: boolean;
    reports: GateReport[];
    forced: boolean;
  };
} // steerBack count is in-process per-(goalId, round), not persisted

interface Config {
  // schemastery, following upstream plugin convention
  mode?: GateMode; // global default 'audit' (consistent with doc 02)
  gateTimeoutMs?: number; // per-gate timeout, default 120_000
  stall?: {
    afterConsecutiveFails?: number /* default 3, min 1 */;
    escalateViaAsk?: boolean; /* default true */
  };
  steerBack?: {
    enabled?: boolean /* default true */;
    maxPerGoalRound?: number /* default 2 */;
    completionPatterns?: string[]; /* completion-wording regexes, bilingual Chinese/English, with a conservative default library */
  };
}
```

Mode resolution (the SafetySentry continuum, doc 00 principle 3):
`gate.mode > config.mode (default audit)`. `off` = the gate is not executed
at all; `audit` = execute, allow through, record telemetry (accumulating
mis-block data for graduation criterion (d)); `enforce` = deny on failure.
When `config.mode==='off'` globally, the plugin is fully short-circuited
(interception/steer/command parsing all silent).

### Key behavior flows (complete-interception flow; turn-end premature-completion steer-back flow; stall→ASK escalation flow)

**A. Complete-interception flow** (`tools/pre-execute` listener, wrapped in
try/catch so it never throws; its own exception = fail-open `next()` + warn
telemetry — a gate-runner bug and "gate unsatisfied" are strictly two separate
branches, same principle as doc 02):

1. Match on `update_goal` + `action==='complete'` → take `exec.agent`,
   `arguments.goal_id`; read `<goalId>.json`: no gates → `next()`.
2. Run the applicable gates in order (honoring `exec.signal`; the command
   gate spawns in `session.header.cwd` with a bounded timeout;
   failure/timeout both translate into a failed report).
3. All pass → write `lastAttempt{allPassed:true}`, zero the consecutive
   counter, emit `goal-verify-gate/complete-allowed` telemetry → `next()`.
4. Any failure:
   - any failed gate in `enforce` → consecutive+1, persist to disk, emit
     `goal-verify-gate/gate-fail` (warn, body carries each GateReport);
   - **stall check**: consecutive ≥ `stall.afterConsecutiveFails` and
     `escalateViaAsk` and global mode not off → return
     `{ kind:'ask', reason }` (reason = gate-failure summary + the
     three-option explanation "approve = force this completion; reject =
     the goal stays active and work continues; to abandon the goal use
     /goal pause|clear"); the registry's `serviceAsk` translates
     `rejected/cancelled/unavailable` into differentiated deny wordings.
   - below threshold → `{ kind:'deny', reason }` (reason lists each failed
     gate's `detail` one by one + repair guidance + current
     consecutive/threshold).
   - all failures are `audit`-grade → `next()` allows through + same-shaped
     telemetry (severity warn, annotated with `mode:'audit'`, to make
     mis-block rates countable).
5. A forced completion (ask→allowed-once) exempts **this one** call only;
   the model must still retry holding a fresh revision (CAS is GoalService's
   concern). Force success is confirmed via the subsequent `goal/changed`
   observation; once the phase turns terminal, the goal's store file is
   cleaned up.

**B. Turn-end premature-completion steer-back flow** (`agent/turn-stopping`
listener, wrapped in try/catch so it never throws — a thrown exception turns
a STALL into a crash, doc 00 principle 2):

1. Intervene only when all conditions hold: this plugin is not off;
   `ctx.goals.get(agent)` exists with `phase==='active'`; the goal has
   gates; no complete attempt was allowed **within this turn** (an
   in-process record `turn → allowed attempt seq`); the turn's final
   assistant text matches `completionPatterns`.
2. Cap check: `steerCount(goalId, roundsStarted) < maxPerGoalRound` →
   `agent.steer(createUserMessage({ content: <wording below>, source: {
kind:'plugin', plugin:'goal-verify-gate', form:'notice', summary } }))`,
   increment the counter, emit `goal-verify-gate/steer-back` telemetry
   (info). Wording essentials: list the goal's gates, and demand "either
   call update_goal complete so the gates actually run, or retract the
   completion wording and state what work remains".
3. If any condition fails (no goal / no gates / already capped / no wording
   match) → return immediately; the turn closes normally.

**C. stall→ASK escalation flow**: see A.4; the escalation fact emits
`goal-verify-gate/stall-escalated` (warn, body = `{ goalId, consecutive,
outcome }`). After a user-forced completion, the goal's store file is
cleaned up with the terminal phase; on rejection the counter is retained and
later attempts continue through A.4 (no repeat ASK harassment: `ask` is
re-issued only once "≥1 more deny has happened since the last ask").

### Built-in gate list

1. `command-exit-zero` `{ command: string; timeoutMs?; cwd? }` — spawns in
   `session.header.cwd` (or an explicit cwd), capturing the exit code and
   the tail of stderr; a timeout invariably translates to a failed report.
   Trust boundary: the command is supplied by **whoever declares the gate**
   (a human, or creation-time configuration), never improvised by the model
   at runtime — steer/deny wording must not induce the model to edit the
   command itself.
2. `file-exists` `{ path }` — resolved relative to `session.header.cwd`;
   read-only stat.
3. `file-matches` `{ path; pattern }` — reads the file (capped at 1 MiB,
   anything larger is treated as unreadable) and runs the regex; for "the
   report must contain a given conclusion/marker".
4. `session-event-required` `{ name?: string; minSuccesses?: number = 1 }` —
   consumes `session/event`: starting from the event seq of goal creation,
   ≥N `tool/result`s with `isError===false` (optionally filtered by tool
   name, e.g. bash/test-class tools). The evidence window is not reset by
   goal edits.
5. `trace-report` (M3, **runtime-optional integration with 03**)
   `{ minScore }` — reads the latest trace-report score for the goal's turn
   from 03 trace-contracts' runtime registry; when 03 is absent or no report
   exists yet, degrades to kind-level `audit` (no deny) with warn telemetry.
   Zero compile-time dependency across packages, relying solely on the
   runtime lookup of the kind registry (see Risk 5).

Future kinds attach through the exported shallow registry API:
`registerGateKind(kind, { run(spec, ctx): Promise<GateReport> })`; the
signature freezes at M1.

## Milestone breakdown (each M = one PR-sized unit + "Verify:" criteria)

- **M1 — gate registry + complete interception + three file/command-kind
  gates + storage + unit tests**: kind registry, the `tools/pre-execute`
  interceptor, mode resolution, `command-exit-zero`/`file-exists`/
  `file-matches` implementations, read/write of
  `<cwd>/.dsh/goal-verify-gate/goals/<goalId>.json` plus terminal-phase
  cleanup (hooked to the `goal/changed` observation), `gate-run`/
  `gate-fail`/`complete-allowed` telemetry.
  **Verify**: mock pipeline (following the `ctx.waterfall` direct-drive
  method of `packages/core/tools/tests/invariant.spec.ts`) — an exit-1
  command under enforce → `deny` with reason containing the gate id and
  exit code; the same failure under audit → `allow` + one warn telemetry
  entry; off → fully silent; the gate runner itself throwing → fail-open +
  warn; one case each for store-file round-trip and clear cleanup.
- **M2 — session-event-required + stall→ASK + turn-end steer-back + the
  /goal-gate command + telemetry completion**: observer counting,
  consecutive tracking and ask escalation, the completionPatterns default
  library (bilingual Chinese/English) and steer injection, `/goal-gate
add|list|remove|reset`.
  **Verify**: synthetic session — after consecutive failures reach the
  threshold, the next complete returns `ask` (a deployment without an
  approval backend deterministically degrades to deny, asserted per
  `serviceAsk`'s existing behavior); the message injected when
  turn-stopping triggers has `source.kind==='plugin'` with complete
  attribution; a third steer in the same round is no longer injected (cap);
  a listener-injection exception is swallowed and the turn closes normally;
  after `/goal-gate add` is persisted, complete interception takes effect
  within the same session.
- **M3 — trace-report kind (runtime-optional on 03) + metrics aggregation +
  docs**: runtime lookup of 03 via the registry, absence-degradation logic,
  an aggregation-view script over ops telemetry (mis-block rate, steer hits,
  stall count), README (including a graduation criteria section, with a
  check item for telemetry evidence of "premature-completion interception
  count").
  **Verify**: in an environment without 03, the `trace-report` gate
  degrades to audit and warns; with a stubbed 03 implementation, one
  deny/allow case each on either side of the score threshold; the README
  graduation criteria are fully listed.

Each M is independently mergeable: M1 adds only the interception surface,
M2 only policy and the human-facing surface, M3 only optional integration
and the observation surface; no existing API is renamed, no upstream-repo
files are touched.

## Verification plan

- **Layer 1 (pure functions)**: the mode-resolution matrix; the three gate
  runners (command uses temp scripts exiting 0/1/timeout; file gates use a
  temp directory); a completionPatterns hit/false-hit case table (including
  mixed Chinese-English text); store serialization round-trip and refusal
  to load corrupted JSON.
- **Layer 2 (mock-pipeline integration)**: build ctx + waterfall in the
  posture of upstream invariant.spec.ts, asserting the allow/deny/ask three
  branches and the cross-call accumulation of the consecutive counter;
  fail-open (own exception) as a separate case.
- **Layer 3 (synthetic session)**: a `SessionEvent` stream feeding the
  session-event-required observer; the full turn-stopping scenario set
  (intervene / don't intervene / cap / exception swallowed).
- **Layer 4 (live-run observation)**: run a real profile for ≥ several
  sessions under global `audit`, manually sampling gate-fail telemetry for
  the mis-block rate and whether steer-back is a nuisance (the data source
  for graduation criterion d).
- Gate commands: `pnpm typecheck && pnpm test` (in a worktree, run
  `bash scripts/link-worktree-deps.sh` first; see CLAUDE.md).

## Risks and open questions

1. **Programmatic bypass**: any host code calling `ctx.goals.complete()`
   directly (or via its `@Remote('complete')` export) is outside the
   jurisdiction of `tools/pre-execute`; upstream currently has only this
   one model path, but the future is not defended. Check item:
   `grep -rn "\.complete(" packages --include="*.ts"` to inventory direct
   call sites upstream; mid-term, propose a native GoalService gate point
   (pre-complete waterfall) to upstream, at which point this plugin's
   interceptor migrates wholesale while the underlying gate logic stays
   unchanged.
2. **Future new actions on `update_goal` or a new goal tool surface**: the
   interception condition hard-codes the `name+action` combination; any
   upstream shape-change silently slips past. Check item: at M1 acceptance,
   add a snapshot assertion over upstream tool-goal's action enum (a
   constant-comparison test).
3. **Session cwd availability**: `SessionOptions.cwd` is typed optional
   (`packages/core/agent/src/index.ts:87-95`). Sessions without a cwd
   should refuse command/file gate declarations and warn; check item:
   whether real-world profiles (ACP/CLI) always set cwd — if not, M1 needs
   a fallback strategy (e.g. process cwd + an explicit audit annotation).
4. **In-process volatility of the steer counter**: after resume/fork the
   per-round steer counter resets to zero; in the extreme, the same round
   may receive one extra steer (the impact is mild nuisance, not a
   correctness issue); gate declarations and the consecutive counter are
   both persisted, so no core function is lost. Accept this trade-off; no
   persistence is introduced for it.
5. **03 trace-contracts is not yet written** (`docs/design/` currently has
   only 00/02): its report-artifact shape and runtime exposure point are
   undecided. Mitigation: the `trace-report` kind does not enter the
   codebase before M3; the integration point converges to a single runtime
   lookup function, and both sides of the interface are cross-checked when
   03 is reviewed. Check item: once the 03 doc takes shape, add a docking
   checklist.
6. **ASK cannot express a third state**: `ApprovalOutcome` has only
   allowed-once plus three non-authorizing states; "abandon" cannot be made
   a third button → handled honestly within the design: the reason text
   spells out the abandonment path (`/goal pause|clear`). Check item: if
   upstream extends the outcome enum, upgrade the interaction.
7. **The CAS crack of forced completion**: ask→allow exempts only the gate;
   if the model then calls holding a stale revision, GoalService still
   rejects it (`GOAL_STALE_REVISION`) — deny/ask wording must remind it to
   `get_goal` first for a fresh revision (tool-goal guidance already
   requires this); the M2 session test covers this ordering.

---

_Verified seams (paths and line numbers all re-verified on 2026-08-17)_:
`packages/goal/tool-goal/src/index.ts:41-43 / :307-308 / :313-324`;
`packages/goal/tool-goal/src/authority.ts:65-74 / :101-108`;
`packages/goal/goal/src/index.ts:336-346 / :557`;
`packages/goal/goal/src/types.ts:59-68`;
`packages/goal/goal/src/fold.ts:87-112`;
`packages/goal/goal/src/domain.ts:104-116`;
`packages/goal/goal-round-driver/src/index.ts:48-58 / :174-178`;
`packages/goal/command-goal/src/index.ts:14 / :33-43`;
`packages/core/tools/src/index.ts:142-152 / :314-337 / :379-384 / :583-591 / :1690-1726`;
`packages/core/agent/src/runtime-types.ts:133 / :261-278`;
`packages/core/session/src/index.ts:112-115 / :436-446`;
`packages/core/session/src/types.ts:155-176 / :252-291`;
`packages/session/session-telemetry/src/index.ts:35-46 / :64-86 / :94-104 / :144-151`;
`packages/interaction/user-approval/src/index.ts:153-174 / :188-190`;
`packages/interaction/user-approval/src/types.ts:29`;
`packages/interaction/commands/src/index.ts:77-82 / :245`;
`packages/skill/skill-filesystem/src/index.ts:246`.
