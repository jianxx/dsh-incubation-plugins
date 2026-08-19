# 28 prospective-memory — prospective memory / deferred intents (Tier 2)

> Status: design (not started) | Tier: 2 | Package: packages/memory/prospective-memory | Depends on: 24 (intent eval set, M4 only); upstream schedule tooling (already in rc.7)
>
> Verified seams against deepseek-harness **0.1.0-rc.7** (@99f6f02fec); path:line citations refer to that tree.

## Design goal and user problem

**Goal**: give the agent a first-class "deferred intent" object — a durable intent record with trigger condition, expiry, armed state, and suppression policy, matured and fired across three arms (in-session events / artifact state / time), where a hit first goes through suppression evaluation (premature / stale / duplicate) before any action.
**User problem**: "tell me when the tests finish", "after the release, remind me to delete that temporary rule" — today's agent fails in one of two ways: either it does it now (turning "wait for the tests" into "poll immediately and burn context"), or it simply forgets. Without a deferred-intent object carrying expiry and suppression, an agent's promises are as short-lived as its context.

## Motivation

The direct finding of prospective-memory research is: **even purpose-built systems do this badly**.
PM-Bench (2607.12385) reports that purpose-built systems reach only 65.1% Set-F1, and the failure
modes cluster at both ends — **premature execution** (preconditions look satisfied but are not;
the system acts the moment a cue appears) and **stale execution** (the world has changed but the
system still acts on the old intent). This sets the center of gravity of this design: suppression
is not an afterthought patch, it is the design center; the trigger arms are deliberately simple,
the evaluator deliberately conservative.

PMMC (2608.00962) provides the conceptual input for trigger design: during consolidation,
compile intents into decidable "question-programs" instead of leaving raw natural-language
intents to be interpreted at trigger time. Mapped onto this design: when an intent is written to
disk, structure the natural-language trigger/action into simple patterns as far as possible
(see "Trigger arms"); at trigger time do only pattern matching + suppression evaluation, no
open-ended interpretation.

All of the above are benchmark/paper results, presented as design inputs per the shared design
principles; no ROI is promised.

## Current state and gaps

Already available (deepseek-harness, all verified, citations in "Surfaces and seams"):

- Durable reminder records: one-shot At/After plus periodic Every via the `schedule_*` tools.
- The three-stage tool-execution decision surface: pre-execute `{allow|deny|ask}`, execute +
  post-execute — the listening point for the event-pattern arm.
- `agent/turn-stopping` natural-completion serial hook — the turn-boundary evaluation point.
- The `session-telemetry/record` operational telemetry channel.

Gaps:

- No deferred-intent object: no durable record of {trigger condition, action, expiry, armed
  state, suppression policy}.
- **No execution mechanism with any on-time guarantee**: `ctx.jobs` is an in-process contract,
  `ctx.interval`/`ctx.timeout` are effect-scoped and auto-cleaned — nothing can fire between
  sessions while nothing is running (see "Honest durability" below).
- No suppression semantics: premature/stale/duplicate firing has no classification, no record,
  no user-visible surface.
- `schedule_*` are reminders, not a scheduler (see below); treating "reminder delivered" as
  "condition satisfied" is precisely a replay of PM-Bench's premature-execution failure mode.

## Design

### Surfaces and seams (verified + cited)

The following source repository root: `$DSH` = the upstream `deepseek-harness` repository root; all citations are repo-relative paths.

| Seam | Verified surface | Source |
|---|---|---|
| Durable reminder records | v1 `ScheduleRecord = OneShotScheduleRecord (After \| At) \| EveryScheduleRecord`; create/list/delete value types `ScheduleCreateValue`/`ScheduleListValue`/`ScheduleDeleteValue` | `$DSH/packages/schedule/schedule/src/types.ts:52-74`, `:199-211` |
| Tool pre-execute decision | `PreToolDecision = { kind: 'allow' } \| { kind: 'deny'; reason } \| { kind: 'ask'; reason? }` | `$DSH/packages/core/tools/src/index.ts:588-591` |
| Tool execute + post-execute | `PostToolDecision` (accept/block + additionalContexts) decision surface | `$DSH/packages/core/tools/src/index.ts:597-601` |
| Turn natural-completion hook | `agent/turn-stopping` (serial; scope-filtered; payload `{agent, turn, signal}`) | `$DSH/packages/core/agent/src/runtime-types.ts:272-278` |
| Listener exception semantics | turn-loop catch: non-LlmError flattened into an error turn with `UNKNOWN` code — **listeners must never throw** (the crash basis of principle 2) | `$DSH/packages/core/agent-loop/src/agent.ts:304-315` |
| Continuation-turn steering | `agent.steer(message: UserMessage)` | `$DSH/packages/core/agent/src/runtime-types.ts:133` |
| jobs contract boundary | "The contract is in-process" — JobStart passes callbacks and the exact Agent object; a durable backend must reshape identity/restart/ownership | `$DSH/packages/jobs/jobs/README.md:40` |
| timer contract boundary | `ctx.interval`/`ctx.timeout` etc. mixins; Disposable, effect-scoped auto-cleanup | `$DSH/vendor/timer/src/index.ts:4-15` |
| Observability | custom session event types are closed to plugins (unknown types rejected by the persistence layer); telemetry goes uniformly through the `session-telemetry/record` operational channel | `$DSH/packages/session/session-persistence-jsonl/src/format.ts:244` |
| Configuration | `settingsNamespace` + `installSettingsSection` (registration is exposure; hot reload via `settings/updated`) | `$DSH/packages/settings/settings/src/index.ts:863` |

Design decisions:

1. **The intent store is this plugin's own persistence layer, not `ctx.jobs`** — the latter's
   contract is in-process (`packages/jobs/jobs/README.md:40`), lost on restart, orthogonal to
   "deferred" semantics.
2. **The time arm delegates entirely to the upstream `schedule_*`**; this plugin does not build a
   second timer. Its boundary must be quoted verbatim:
   > schedule_* are reminders, not a scheduler: they only deliver a notification into the session in the future; they do not fire while nothing is running and they do not execute actions.
3. The event-pattern arm hooks tools/post-execute + turn-stopping; listeners are all read-only +
   bookkeeping and never throw; when action is needed, inject a continuation-turn message with
   the `[prospective:<intentId>]` attribution prefix via `agent.steer()` (principle 2: steer
   messages participate in round accounting, attribution must be explicit).

### Intent record

Storage: durable JSONL/JSON, local to the repository/workspace under
`.dsh/prospective/intents.jsonl` (append + periodic compaction; atomic writes follow 06's
tmp+rename pattern). Each record:

```jsonc
{
  "intentId": "uuid",
  "version": 1,
  "trigger": {
    "kind": "event-pattern",        // see "Trigger arms"
    "pattern": { "tool": "shell.run", "argGlob": "*pnpm test*", "resultPredicate": "exitCode==0" }
  },                                 // or { "kind": "artifact-state", "check": {...} }
                                     // or { "kind": "time", "scheduleId": "..." }
  "action": "跑完测试后把结果摘要发给用户",   // natural language (required)
  "structured": null,                // optional structured action (M0 supports only the steer-message form)
  "expiry": "2026-09-01T00:00:00Z",  // expiry disarms; no further evaluation
  "armed": true,
  "createdBy": "user",               // user | model | plugin
  "provenance": { "session": "...", "turn": 12, "seq": 345 },
  "suppression": {                   // evaluated at trigger time, see "Suppression"
    "precondition": "exitCode==0 && durationMs>60000",  // optional: extra precondition beyond the pattern
    "staleCheck": "referenced-file-exists",             // optional: staleness probe
    "dedupeWindowMs": 300000
  },
  "history": [ /* armed/disarmed/fired/suppressed events */ ]
}
```

### Trigger arms (deliberately simple)

1. **event-pattern**: match the triple `{tool name, argument glob, result predicate}` on
   tools/post-execute and turn-stopping. The pattern is deliberately dumb matching — no semantic
   interpretation; complex judgments go to the suppression-stage precondition. A hit ≠ a firing;
   it enters suppression evaluation first.
2. **artifact-state**: at turn-stop, run cheap read-only probes — file existence / content
   regex, git state (read-only commands via `ctx.shell.run`, e.g. `git log -1 --format=%H`).
   Likewise: probe true ≠ firing; suppression evaluation first.
3. **time**: no new timing mechanism. When the intent is written, call the upstream
   `schedule_create` (one-shot At/After, `packages/schedule/schedule/src/types.ts:52-74`) and
   record the returned schedule id into the trigger. When that reminder is **delivered into the
   session**, the plugin does not act directly; it re-evaluates the full condition (the current
   state of the event arm / artifact arm + expiry + suppression) and only then decides to act or
   suppress — this is the direct engineering consequence of the schedule boundary footnote
   above: a reminder is only a cue to "wake up and take a look", not proof that "the condition
   is satisfied".

### Honest durability (prominent)

**This plugin has no on-time guarantee, and does not pretend to.** `ctx.jobs` is an in-process
contract (`packages/jobs/jobs/README.md:40`), `ctx.interval`/`ctx.timeout` are effect-scoped
auto-cleaned (`vendor/timer/src/index.ts:4-15`) — time-based firing is impossible while no
session is running; `schedule_*` too only promise to deliver a notification into some (future)
session. The semantics are therefore **at-least-once + late suppression**: an intent that
matured while nothing was running is evaluated at the next session start or the next turn-stop,
and the suppression policy decides whether it is still valid or already stale. All user-facing
copy must present this semantics; any "fires on time" UI wording is a defect.

### Suppression (the design center)

Every hit is evaluated in order; any hit intercepts and writes a `memory.intent.suppressed`
telemetry event:

| Class | Test | Action |
|---|---|---|
| premature | Pattern hit but `precondition` unsatisfied (e.g. exit code 0 but suspiciously short duration — the tests never actually ran) | Do not fire; stay armed; record hit count; N consecutive premature → escalate to needs-user |
| stale | Past `expiry`, or the `staleCheck` probe fails (referenced file deleted, rule already manually cleaned) | Disarm, terminal-state record, one-shot user notification "intent dropped as stale" |
| duplicate-fire | The same intent hits again within the dedupe window | Intercept, count |

The `memory.*` telemetry-key convention belongs to doc 24; this doc only fixes this plugin's
events: `memory.intent.armed` / `memory.intent.fired` / `memory.intent.suppressed`
(reasonClass: premature|stale|duplicate) / `memory.intent.expired`, all through the
`session-telemetry/record` operational channel (no new session event types, principle 5).

### User surface and configuration

- Slash commands: `/prospective list` (grouped armed/disarmed/terminal), `/prospective cancel <id>`,
  `/prospective history <id>`. Arming is by default an explicit user action only (intents created
  by the model land with `armed: false`, awaiting the user's `/prospective arm <id>` — "no
  autonomous arming" is the default).
- Audit: all armed/fired/suppressed go to telemetry (see above).

Configuration (standard configuration-declaration (rc.7 onward) section; `settingsNamespace` +
`installSettingsSection`, `packages/settings/settings/src/index.ts:863`; resolution layers:
schema defaults → the cordis composition entry → `settings.yaml`, hot reload via
`settings/updated`, runtime read via `ctx.settings.describe()`; registration is exposure):

```yaml
prospective-memory:
  maxActiveIntents: 64        # beyond this, new intents are rejected (user-facing notice)
  sweepCadenceTurns: 10       # full sweep (artifact/time arms) every N turn-stops
  defaultExpiryDays: 7        # default expiry for intents given no explicit expiry
```

## Milestone breakdown

**M0 — record schema + store + event-pattern arm**
Intent schema + `.dsh/prospective/` store (atomic writes, load on startup, compaction) +
event-pattern matching on tools/post-execute and turn-stopping (hit → suppression evaluation →
steer action, steer message carrying the `[prospective:<id>]` prefix); premature/duplicate
suppression classes; `/prospective list|cancel`; the four telemetry events. Unit tests: schema
validation, pattern-matching table, suppression-decision table, listener throw isolation
(inject a throwing neighbor listener and assert this plugin is unaffected).
**Verification**: create a "tell me when pnpm test succeeds" intent in-session, run the tests
manually, assert the steer continuation happens and history/telemetry record fired.

**M1 — artifact-state arm**
Cheap read-only probes at turn-stop (file/git), stale suppression + staleCheck; sweep throttling
(sweepCadenceTurns). Unit tests: probe read-only-ness (all via mock `ctx.shell`, asserting a
command allowlist), stale decision.

**M2 — time arm via schedule_* + recovery reconciliation**
`schedule_create` integration (schedule id written back into the trigger), reminder delivery →
re-evaluation → act/suppress; reconciliation sweep at restart/new-session start (re-evaluate
matured-but-unhandled intents).
**Verification**: set an At reminder 1 minute out, close and reopen the session, assert the
re-evaluation path and the "late suppression" copy.

**M3 — suppression tuning**
Consecutive-premature count escalation to needs-user, dedupe window, expiry/default expiry,
`maxActiveIntents` cap with user notice; the full user surface of the no-autonomous-arming
default.

**M4 — PM-Bench-style scoring (depends on doc 24)**
Score on doc 24's intent eval package by Set-F1 + premature/stale failure distribution (the
eval track itself belongs to docs 12/24; this doc only consumes it).

## Risks and open questions

- R1 **Seam coverage of the event-pattern arm**: post-execute sees the parsed tool result, but
  some tool results may come back as a projection (content) rather than a structured value;
  which tools `resultPredicate` works against needs a per-tool inventory in M0; unusable ones
  degrade to turn-stop probes.
- R2 **Timing of steer actions**: turn-stopping fires serially, the steer injection happens
  before the next request, but if the intent's action itself needs tool calls it spends the
  user turn's budget — the attribution prefix + telemetry are the only accountability surface;
  whether "intent turns" need separate accounting is open.
- R3 **Multi-session concurrency**: two sessions evaluating the same intent file at once —
  concurrent writes to the store (append-only JSONL + compaction rename) need a file lock or a
  last-writer-wins convention; open (M0 assumes single session first).
- R4 **schedule record lifecycle**: canceling an intent must cascade to `schedule_delete`; the
  orphan case where an upstream reminder was delivered but the intent file is gone (manually
  deleted by the user) can only be handled as a record; open.
- R5 **Quality of model-created intents**: compiling natural-language triggers into simple
  patterns (the PMMC concept) is, in M0, done only for patterns explicitly given by the user;
  autonomous model compilation is an open question, and is constrained by the
  no-autonomous-arming default.
- R6 **Applicability of the PM-Bench number**: 65.1% is that benchmark's system upper bound,
  not an expectation for this plugin; it must not be quoted as an expected value before M4
  scoring.

## Boundaries and non-goals

- No scheduler / action executor: time triggering delegates entirely to `schedule_*` (the
  footnote semantics); an intent "action" has exactly one form — an attributed steer
  continuation message.
- No cross-machine / cloud persistence: the store is a workspace-local file; unattended on-time
  delivery is explicitly out of scope.
- No semantic trigger interpretation: triggers stay dumb patterns; complex judgments go into
  the suppression precondition, and the precondition itself is likewise limited to the same
  small predicate language.
- Read-side governance of memory content (who can read which memory) belongs to doc 13; egress
  audit belongs to doc 09; memory packaging and the `memory.*` key convention belong to doc 24 —
  this doc does not overlap them.
- Falsification line: if doc 24's intent set shows suppression dominating (most armed intents
  are already stale at trigger time), this feature narrows to explicit user arming only, never
  autonomous arming — the default is already implemented that way; M3 only confirms, never
  relaxes.
