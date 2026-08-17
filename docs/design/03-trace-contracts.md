# 03 trace-contracts — Trace contracts: online gate + offline scoring

> Status: design (not started) | Tier: 1 | Package: packages/verification/trace-contracts | Depends on: none (optional integration with 01)

## Motivation

Many agent failures are not "wrong answers" but **trajectory deformation**:
skipping tests and committing directly (Tool-Skip), getting a tool error yet
continuing to claim success (Result-Ignore), fabricating results without
calling any tool (Output-Fabrication), repeating calls pointlessly
(Unnecessary-Tool-Use) — these four are exactly ToolFailBench's measurement
categories. permission-rules answers "is this agent authorized to call this
tool" (identity/mode authorization); it cannot answer "should this task call
bash one more time right now" (a per-task behavior budget).

The paradigm AgentLTL offers: write trajectory properties as a declarative
spec (tool order/branch/count/params/grounding derived from FO-LTL), with
**a single spec reused in three places** — offline scoring, online
block-and-warn, and training reward. This work item lands the first two
(reward is left for the training side, which consumes the event schema
exported by doc 12). Two literature red lines go straight into the design:

- **AgentLTL warning**: soft-block paired with early termination harms the
  agent's recovery ability — so deny must carry feedback text that references
  the violated clause, leaving the model a **recovery channel** rather than a
  dead-end error.
- **Reason-Less-Verify-More**: a gate is worth enforcing online only where
  state-decidable / interceptable / recoverable all hold at once;
  undecidable preconditions are downgraded to audit, not blocked online.
- **SafetySentry**: EXECUTE / ASK / REFUSE three-state routing + adjustable
  thresholds — ASK is a configuration dial, not hardcoded (corresponding to
  the `off / audit / enforce` three levels of doc 00 tenet 3).

## Current state and gaps

Already in place (verified in the next section): the `tools/pre-execute`
waterfall's decision type includes `allow / deny(reason) / ask(reason?)`; ask
is resolved internally by the tool registry via ApprovalService
(`ctx.get('approval')`), natively riding the `approval/request` waterfall's
built-in UX; the persistent `session/event` event stream is subscribable by
plugins; the `session-telemetry/record` waterfall is the unified
observability outlet.

Gaps: no plugin expresses "task-level trajectory budgets" as a loadable
declarative file; the pre-execute gate currently sees only a single call,
with no cross-call sequence/count state; the offline side has no scorer that
replays the session event stream into compliance rates and violation
classifications. cc-plugins' permission-rules engine has its own
allow/deny/ask three-state, but it is **identity-authorization semantics**
and lives in another repo — this plugin has zero compile-time dependencies;
ASK always goes through the upstream `approval/request` seam (doc 00 tenet 1)
and works standalone.

## Design

### Surfaces and seams (verified + cited)

All items below are confirmed by direct code reading (upstream repo
`/Users/bytedance/workspace/github.com/deepseek-harness`):

1. **`tools/pre-execute` waterfall + the PreToolDecision three-state**
   `packages/core/tools/src/index.ts:152` (listener signature) and `:588-591`:
   ```ts
   export type PreToolDecision =
     | { kind: 'allow' }
     | { kind: 'deny'; reason: string }
     | { kind: 'ask'; reason?: string }
   ```
   The default at the end of the waterfall is `{ kind: 'allow' }` (`:1477`).
2. **How ASK is actually wired (the plugin does not call approval itself)**:
   when the registry gets `gate.kind === 'ask'` from pre-execute, it
   **internally** calls `serviceAsk(exec, gate)` (`:1479-1480`,
   implementation `:1689-1728`): an absent `ctx.get('approval')` → degrades to
   deny (the reason is `tool "X" requires approval (not yet supported)`); an
   absent `exec.agent` degrades the same way; otherwise
   `approval.request({ agent, toolName, callId, reason?, signal })`;
   `allowed-once` → allow; `rejected / cancelled / unavailable` → deny, and
   the reason wording is distinguishable across the three (the model can tell
   "a human said no" apart from "no approval channel exists"). The
   ApprovalService implementation internally renders UX via the
   `approval/request` waterfall (see the `ctx.on('approval/request', …)`
   usage in `packages/core/tools/tests/tools.spec.ts:744`).
   **Conclusion: the plugin's ASK only returns `{ kind: 'ask', reason }` at
   pre-execute; the approval UX is owned by the host's ApprovalService; in
   deployments with no UI / no approval service this automatically fails
   closed into deny, as intended.**
3. **Session event subscription**: `ctx.on('session/event', (session, event) => …)`
   — type declaration `packages/core/session/src/index.ts:76`
   (`post-commit, fire-and-forget`; listener failures are logged and
   isolated); real usage `packages/core/session/src/invariant.ts:223`. The
   event keys (`packages/core/session/src/types.ts:236-291`, SessionEventMap)
   include `turn/start`, `turn/end`, `step/start`, `step/end`,
   `tool/call { turn, step, callId, name, arguments: string }`,
   `tool/result {…}` — all inputs for the three rule classes
   (sequence/count/param) come from here; `tool/call.arguments` is a JSON
   string, and a parse failure is handled as a param-rule evaluation failure
   (see the behavior section).
4. **Telemetry outlet**: the
   `'session-telemetry/record'(record, next) => SessionTelemetryRecord`
   waterfall, declared at
   `packages/session/session-telemetry/src/index.ts:43`; record shape
   `{ channel: 'ledger' | 'ops', time, severity, attributes, body }`
   (same file `:64-83`). Session log events are mirrored automatically
   via the ledger channel; the plugin's own metrics (compliance %, etc.)
   travel the ops channel, with `telemetry.op` named `trace-contracts.*`.
5. **Deny feedback outside of approval**: a deny's `reason` is materialized
   into an `Error: <reason>` tool result (`:1490-1496`) — this is exactly the
   recovery channel's carrier: the reason is the feedback text the model sees
   on the next turn.

### Data model / configuration (contract schema sketch)

Contract files: `<repo>/.dsh/trace.yml` (project level) and
`~/.dsh/trace.yml` (user level); `/trace attach <file>` can bind a contract
to the current session/goal. The user level provides defaults, the project
level overrides, and session attach overrides again (precedence: session >
project > user).

```yaml
# .dsh/trace.yml — example: TDD flow
name: tdd-flow
mode: enforce            # off | audit | enforce (the three levels of doc 00 tenet 3)
ask:                     # SafetySentry dial: global ASK threshold
  default: false         # whether to escalate to a real human ASK when an ask-tier violation is hit
  escalateAfter: 2       # after the same rule is denied ≥N times, escalate subsequent violations to ask (prevents infinite loops)
rules:
  - id: test-before-commit
    kind: sequence                       # sequence rule
    pattern: "edit* test+ commit?"       # regex-like: tool-name tokens + * + ? quantifiers
    capture: { edited: "edit{file}" }    # named capture, referenced by param rules
    window: turn                         # match window: turn | session
    action: deny                         # deny | ask | audit
    message: "test must run before commit (captured file ${edited})"
  - id: bash-budget
    kind: count                          # count rule
    tool: bash                           # or pattern: "edit*"
    maxCalls: 40
    window: session
    action: ask                          # over budget doesn't hard-block; ask a human
  - id: no-destructive-bash
    kind: param                          # parameter constraint (JSON-schema on parsed args)
    tool: bash
    schema:
      type: object
      properties:
        command: { type: string, not: { pattern: "rm\\s+-rf\\s+/" } }
      required: [command]
    action: deny
    message: "destructive commands are forbidden by contract; if cleanup is needed, delete files one by one and state the reason"
  - id: build-clean-before-push
    kind: state                          # state precondition: read-only probe, evaluated before the side-effect step
    before: "git push*"                  # trigger point (side-effect pattern)
    probe: build.status                  # references a probe id from 01 tool-manifest
    expect: green
    action: deny
    downgrade: audit                     # no manifest plugin / probe undecidable → downgrade
```

Design points:

- The **sequence** pattern acts on "the sequence of tool names already
  invoked within this window"; its semantics are AgentLTL's
  order/branch/count subset (deliberately not full FO-LTL, to keep the schema
  readable); named captures expose the already-matched arguments to later
  param rules.
- **state rules** follow Reason-Less-Verify-More: the probe must be
  read-only, decidable, and evaluable synchronously within pre-execute /
  under a short timeout; if any of these fails → `downgrade` takes effect and
  a `trace.state_downgraded{ rule, reason }` audit event is recorded — never
  block online on an undecidable condition.
- **action defaults**: param hard safety constraints → deny; sequence/count
  budget types → default ask (SafetySentry: for recoverable violations,
  asking a human is cheaper than hard-blocking); state probe missing → audit.
  With global `mode: audit`, all rules only record and never block (use it
  during the canary period to collect the false-interception rate).

### Key behavior flows

**Gate flow (online)** — the evaluation order within a single invocation of
the pre-execute listener:

```text
tools/pre-execute(exec):
  1. contract = sessionState.attachedContract; absent → return next() (pass-through)
  2. args = JSON.parse(exec.arguments)  // on failure: param rules recorded as unevaluable, no block
  3. a param rule matches and the schema fails
     → execute the action (deny goes through the recovery channel; ask goes through approval; audit records an event) → subsequent param rules may stack
  4. before a side-effecting call: evaluate the state rules' read-only probes (when the 01 plugin is present);
     undecidable → downgrade=audit + audit event
  5. feed this call to the sequence matcher within the window (incremental NFA), and complete counter bookkeeping
     → violation hit → execute the action
  6. all pass → allow; simultaneously emit a trace compliance event
```

The recovery channel (how the AgentLTL red line is implemented):
- **deny feedback wording contract**: `reason` must contain (a) the rule id,
  (b) the original text of the violated clause (the message template, after
  rendering), (c) the current state summary (counts used / sequence
  progress), and (d) one actionable correction suggestion. Template:
  `trace-contract[test-before-commit]: test must run before commit. Current sequence: edit(src/a.ts)×3, test×0. Suggestion: run test now, and commit after it passes.`
  Because upstream wraps reason into an `Error: …` tool result (seam 5 in the
  previous section), the model is guaranteed to read it on the next turn, and
  the continuation turn can course-correct — not a dead end.
- **ask**: return `{ kind: 'ask', reason: <clause rendered in the same format> }`;
  the approval UX / channel belongs to the host's
  ApprovalService; if the user clicks reject in the ASK → upstream produces
  the deny reason `the user rejected tool "X"`, equally readable by the
  model. `escalateAfter` promotes the action to ask only when the same rule
  is denied repeatedly, breaking the "model keeps hitting the wall — the
  human never gets asked" loop.
- The listener **never throws**: any evaluation exception is recorded as a
  `trace.gate_error` audit event, then allow (fail-open at the gate,
  fail-closed in the ledger; isomorphic to the listener constraint of doc 00
  tenet 2).

**Session state**: contract evaluation state (counters, sequence NFA
progress, named-capture bindings) is stored in the plugin's memory keyed by
session; on `session/disposed`, one summary telemetry record is emitted and
the state is released; the session/event stream is the recovery data source
(after a restart, the scorer can replay the window event by event to rebuild
state — aligned with doc 00's "the event stream is recoverable").

**Commands**: `/trace attach <file>` (bind/switch), `/trace status` (current
contract + in-window progress + violations already triggered),
`/trace report` (invokes the scorer to generate this session's report),
`/trace detach`. See the risks section for the command-registration seam.

**Scorer flow (offline / live)**:
1. Input: replay of the session event stream (MVP: read the persisted log);
   live mode subscribes to `session/event` for incremental scoring, but gate
   state and scoring state are kept separate and never pollute each other.
2. Replay the evaluator for each rule, producing: compliance rate, per-rule
   hit/violation counts, and a violation timeline.
3. Violations are classified into ToolFailBench's four classes: Tool-Skip (a
   token missing from the sequence), Result-Ignore (tool/result is an error
   and the next step has no repair call), Output-Fabrication (the final
   assertion references a call result that does not exist within the window),
   Unnecessary-Tool-Use (count over budget or repeated identical-argument
   calls).
4. Metrics go out via the `session-telemetry/record` ops channel:
   `trace.compliance_pct`, `trace.violations{rule, category}`,
   `trace.ask_escalations`; `/trace report` outputs a markdown summary table.
5. **The data source for doc 12 eval-harness**: scoring results are
   simultaneously written back to the session log as trace.report events,
   which the eval export schema consumes directly (doc 00 tenet 5).

### Boundary with permission-rules

permission-rules (cc-plugins) is **identity/mode authorization**: whether
this principal can call this tool — the answer is independent of task
context, and the policy is stable long-term. trace-contracts is a **per-task
behavior budget**: under the same identity, "how many more times can bash be
called in this fix task, test must run before commit, build must be green
before push" — the answers change with session state and attach/detach with
the task. The two should be **two independent listeners in the pre-execute
waterfall, chained one after another, each minding its own concern**;
identity-authorization deny is terminal (no recovery semantics), while
contract deny carries the recovery channel. If the host has the cc permission
engine installed, this plugin still uses only the upstream
`approval/request` seam — no import, no probing of its internals (doc 00
tenet 1: zero compile-time dependencies).

## Milestone split

### M1: contract schema + loader + pre-execute gate (allow / deny-with-feedback)

schema validation (zod-like) + two-level file loading (precedence: session >
project > user) + the sequence incremental matcher (NFA) + counters +
JSON-schema param evaluation + the gate listener; deny reason rendered per
the "recovery-channel wording contract"; the `mode: off/audit/enforce` three
levels in effect. **Verify**: unit tests drive
`waterfall('tools/pre-execute')` with a mock pipeline — (a) under
`edit* test+ commit?`, skipping test and committing directly is denied, and the reason contains the
rule id, the original clause text, and the state summary; (b) over-limit
counts are denied under enforce and only recorded under audit; (c) an error
thrown inside the gate is swallowed and recorded as `trace.gate_error`, and
the call is let through; (d) with no contract, pure pass-through (`next()` is
called).

### M2: ask path + /trace commands + session state

the gate returns `{kind:'ask', reason}`; the `escalateAfter` escalation
logic; the per-session evaluation-state store + summary release on
`session/disposed`; the three commands `/trace attach/status/detach`; state
recovered by replaying the event stream (restart scenario). **Verify**: unit
tests inject a fake ApprovalService (the three branches
`allowed-once / rejected / unavailable` each land on the correct subsequent
decision); after
the same rule is denied ×N, the N+1th return is ask; after dispose the state
is gone and the summary record is emitted; rebuilding state from a recorded
event stream yields field-by-field equality with the in-memory state.

### M3: post-hoc/live scorer + telemetry + template pack + docs

the event-stream replay scorer, the ToolFailBench four-class classifier, the
`session-telemetry/record` ops metric trio, `/trace report` markdown output;
the contract template pack: `tdd-flow.yml`, `docs-only-flow.yml`,
`release-flow.yml`; README (including the integration notes with 01).
**Verify**: for a recorded stream containing known violations, the scorer's
compliance rate and classifications match human annotation (≥3 golden
samples, covering at least three of the four classes); the metric records'
`telemetry.op`, attributes, and body shapes match the schema; all three
contracts in the template pack pass schema validation.

## Verification plan

- Unit (M1/M2): mock pipeline + fake ApprovalService, all gates green
  (shipped by the `pnpm new:plugin` scaffold); focused coverage that all four
  elements of the recovery-channel wording contract are present.
- Integration (M3): run two real tasks with dsh (one honoring the TDD
  contract, one deliberately violating it); `/trace report`'s violation
  timeline matches a manual cross-check; confirm that ask fails closed into
  deny when no approval service exists (established upstream behavior — this
  plugin only asserts it and does not depend on it).
- Observation: `trace.compliance_pct` / `trace.violations{rule,category}` /
  `trace.ask_escalations` appear in telemetry; collect the
  false-interception rate under audit mode for 2 weeks as the calibration
  basis for the enforce default.

## Risks and open questions

1. **The `/trace` command-registration seam is unverified**: how an upstream
   plugin registers a slash command has not been pinned down to a concrete
   API. Check:
   `grep -rn "registerCommand\|command/" packages/core packages/host --include="*.ts"`
   (in the deepseek-harness repo); if
   upstream has no command seam, the M2 commands degrade to a programmatic
   API exported by the plugin plus an entry point on the doc 12 side.
2. **The injection point for ops metrics**: `session-telemetry/record` is the
   capture side's transform waterfall; the exact entry by which "a plugin
   actively emits an ops record" (the capture coordinator's public method or
   the waterfall's triggering party) is not fully confirmed. Check: read the
   full text of `packages/session/session-telemetry/src/index.ts` for the
   export surface of `capture`/coordinator; if only passive transformation is
   possible, fall back to writing trace.report events into the session log,
   carried by the ledger channel.
3. **state probes depend on 01, which does not exist yet**: before 01
   tool-manifest is complete, all state rules take downgrade=audit; if 01 is
   not ready by M3, state rules as a whole are labeled experimental.
4. **The expressiveness boundary of the sequence pattern**: the regex-like
   syntax does not cover all of FO-LTL's branching semantics; cross-window
   "must eventually" properties (e.g. test must run before the session ends)
   are not supported in M1 — they are left to the scorer for offline
   determination, stated explicitly in the docs.
5. **Deny storm**: when the model repeatedly hits the wall on the same
   clause, we rely on `escalateAfter` escalating to ask to pull a human in;
   if the human keeps rejecting after escalation, the session should have an
   external stop mechanism — that is the goal layer's (doc 04)
   responsibility; this plugin only guarantees it never goes silent.
