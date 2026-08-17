# 11 silent-failure-watch — runtime detection and offline reproduction of non-crash failure classes

> Status: design (not started) | Tier: 3 | Package: packages/observability/silent-failure-watch | Dependencies: none (schema consumed by doc 12)

## Motivation (why pass/fail logs miss the most dangerous class of production bugs)

The most common severe agent failures in production are not crashes, but **failures
that keep producing plausible narratives**: tool errors that get ignored, file/test
results asserted that never happened, context polluted by retry storms, scheduled
jobs spinning idle — every line of the session log is "legal": no exception, no
veto, just the narrative and reality slowly diverging (the production-runtime
longitudinal taxonomy of *When Errors Become Narratives*: fail-plausible outputs,
context pollution, plan drift, governance-check mismatch). ToolFailBench decomposes
this into countable, independent quality axes: Tool-Skip / Result-Ignore /
Output-Fabrication / Unnecessary-Tool-Use, paired with the CTUR metric — even the
strongest model only reaches CTUR 86.33%, which shows that tool-faithfulness is a
runtime property that must be observed independently; it cannot be absorbed by
end-to-end pass/fail.

This package has two layers: **online** (read-only detectors over the durable event
stream, emitting structured flags, never intervening) and **offline** (a
reproduce → intervene → confirm loop over recorded sessions plus fault injection;
AgentCheck doctrine: silent DATA-QUALITY faults far outnumber crashes; deterministic
diffs primary, LLM-judge auxiliary). OAT (unsupervised step-level attribution trained
on SUCCESS traces) is positioned as a future/offline direction and does not enter
the runtime path.

## Status quo and gaps

Upstream dsh already provides: a durable `session/event` stream (merge-extensible,
persisted event by event), the `session-telemetry/record` waterfall with ledger 1:1
mirroring, plugin command registration, and `packages/test-support`'s
llm-replay / llm-mock-server / agent-loop-testkit (usable from offline scripts).
Gaps: no component observes cross-step/turn properties such as "a result exists but
was ignored" or "the narrative doesn't match the events"; nor is the fault-injection
closed loop built as a repeatable engineering loop.

## Design

### Surfaces and seams (verified + cited)

**Event stream** (`@deepseek-ai/dsh-session`, source in
`deepseek-harness/packages/core/session/src/`):

- `SessionEventMap` is a **declaration-merge-extensible** interface
  (types.ts:236–344, "merge-extensible, append-only source of truth"); event names
  are the interface keys. The envelope
  `SessionEvent = { type, seq (monotonic within session), time (epoch ms), data, ignorable? }`
  (types.ts:415–434); `append` validates everything as JSON and deep-freezes
  (types.ts:291 comment / index.ts:605–655).
- Exact payloads:
  - `tool/call`: `{ turn, step, callId: CallId, name: string, arguments: string }`;
    arguments is the **raw JSON string produced by the model** (types.ts:279).
  - `tool/result`: `{ turn, step, message: ToolResultMessage, error?: { name, code },
    meta?: JsonValue }` (types.ts:291–297); `ToolResultMessage.content =
    [ToolResultBlock]`, `ToolResultBlock = { type:'tool-result', toolCallId: CallId,
    content: ContentBlock[], isError? }` (`packages/llm/llm/src/types.ts:88–93`,
    `message.ts:152`). Call↔result are paired via `callId`/`toolCallId`.
  - `assistant/message`: `{ turn, step, message: AssistantMessage, usage? }`
    (types.ts:273); `TextBlock = { type:'text', text }` (types.ts:54–57).
  - `user/message` (types.ts:257–264): three source classes — human input, synthetic
    `agent.inject()` (**including cron notifications**), and goal continuation rounds;
    the `source` field distinguishes them → the anchor point for scheduled-job runs.
  - `turn/start` / `turn/end { reason: TurnEndReason }` (merge-extensible
    `TurnEndReasonMap`, types.ts:155–177), `step/start` / `step/end`.
- Subscription: `ctx.on('session/event', (session, event) => …)`
  (core/session/src/invariant.ts:223; interface declaration core/session/src/index.ts:76);
  observers are contained via `invokeContainedSessionObservers` (index.ts:641–646).
- **Re-entry ban**: `append` throws if re-entered during publish ("session append
  cannot reenter while another append is being published", index.ts:622–624)
  → detectors must **only buffer** inside listeners; flags are appended later at
  the next event boundary (or `turn/end`/`step/end`).

**Telemetry**: `session-telemetry/record` is a waterfall on cordis Events
(session/session-telemetry/src/index.ts:24–44); ledger records **mirror session
events 1:1**, `SessionTelemetryRecord { channel:'ledger'|'ops', time, severity,
attributes, body }` (same file, 56–87). Conclusion: flags landing in the session
log automatically enter ledger telemetry — no custom export channel
(overview principle 5).

**Commands**: `inject=['commands']`; in `apply`,
`ctx.effect(() => ctx.commands.register({ name, description, handler }))`
(session-query/session-log-export/src/index.ts:7–26; `CommandDefinition` in
interaction/commands/src/index.ts:27–56; command names `[a-z][a-z0-9_-]*`).

**Plugin shape and config**: `export const name` + `export const inject` +
`apply(ctx, config?)`; config is just the second argument (precedent:
test-support/llm-replay/src/index.ts:772–809) → sampling/throttling are simply
Config fields of this package; no new mechanism needed.

**Offline testkit**:

- `mountAgentLoopTestDependencies(ctx, { tools? })` mounts
  LlmRuntime / SessionStore / SystemPrompt / ToolRuntime / AgentRegistry
  (test-support/agent-loop-testkit/src/index.ts:18–49).
- Tool stubs: `ctx.tools.register(definition: ToolDefinition): () => void`
  (core/tools/src/index.ts:1037) → a same-name wrapper tool is the fault-injection
  point.
- llm-replay: input is a **persisted session.jsonl**.
  `parseSessionLog(text): SessionEvent[]` (line 0 header + per-line
  `decodeStorageRecord`, llm-replay/src/index.ts:167–177, chunk-rows.ts:339);
  `deriveReplayScript(events)` cuts `chunks` entries for each model call at `finish`
  via `assistant/chunk` (206+); `ReplayEntry = chunks | throw | hang` (36–42;
  throw/hang cannot be reconstructed from the log and must be overridden);
  `ReplayConfig { file, overrideFile?, childFiles?, providers?, paceMs? }` (84–121),
  `ReplayOverrideDoc = ReplayEntry[] | { patches }` (271–284);
  `installLlmReplay(ctx, config): ReplayHandle { dispose, assertConsumed }`
  (129–138, 697). Entries are **popped in recorded call order** and bound to live
  sessions in first-call order (144–156, 688+); `resolveScriptedEntry` supports
  FROM_REQUEST templates that pull text from the live request (379–385). Corollary:
  after a tool fault is injected, the model still replays its old script →
  naturally reproducing the "narrative continues while reality has diverged"
  scenario.
- llm-mock-server: `startMockLlmServer`, 24 behaviors at the HTTP layer
  (`connection_reset/stall/rate_limit/malformed_json/…`, llm-mock-server/src
  /index.ts:16–44) — a complementary instrument for model-transport-level faults.

### Data model / configuration (flag event schema [source of truth], per-detector config)

**flag event** — this schema is the source of truth; doc 12 eval-harness consumes
it keyed on the `schema` version; the event is merged into `SessionEventMap` via
declaration merging; the payload is all JSON:

```ts
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap { 'watch/flag': WatchFlag }
}

export interface WatchFlag {
  schema: 1                      // version gate: doc 12 selects its parser by this
  detector: 'result-ignore' | 'output-fabrication' | 'context-pollution'
          | 'plan-drift' | 'job-drift'
  category: 'tool-skip' | 'result-ignore' | 'output-fabrication'
          | 'unnecessary-tool-use' | 'context-pollution' | 'plan-drift'
          | 'job-drift'          // ToolFailBench-flavored, reserved for extension
  sessionId: string
  trialId?: string               // injected by the offline loop / doc 12; absent online
  turn: number; step?: number
  evidence: { seqs: number[]; callIds?: string[] }  // evidence = event seqs (may span a window)
  severity: 'info' | 'warn' | 'error'
  mode: 'audit'                  // constant: this package never intervenes
  detail: string                 // ≤120-char machine summary (CONTEXT_SUMMARY_MAX_CHARS convention)
}
```

Named `watch/flag` (not `silent-failure/*`) to stay compatible with the
control-plane exchange rate; `evidence.seqs` references monotonic seqs, so
consumers can join directly back to the session log.

**Configuration** (all through the second argument of `apply(ctx, config)`;
sampling = per-detector `sampleRate` 0..1; throttling = `maxFlagsPerTurn` hard cap
plus same-evidence dedup):

```ts
export interface Config {
  enabled?: boolean            // default true; pure AUDIT, no enforce tier
  trialId?: string
  maxFlagsPerTurn?: number     // default 20
  detectors?: {
    resultIgnore?:      { enabled?; lookaheadSteps?: number /* N, default 3 */;
                          minTokenChars?: number; sampleRate?: number }
    outputFabrication?: { enabled?; extraPatterns?: string[]; sampleRate?: number }
    contextPollution?:  { enabled?; windowSteps?: number; repeatThreshold?: number;
                          pasteChars?: number; sampleRate?: number }
    planDrift?:        { enabled?: boolean; windowTurns?: number;
                          goalPathHints?: string[]; sampleRate?: number }
    jobDrift?:         { enabled?: boolean; kRuns?: number; sampleRate?: number }
  }
}
```

### Online detector catalog (each tabulated: signal / cost / false-positive posture)

| detector | signal definition (input events → verdict) | cost (O/event) | false-positive posture |
|---|---|---|---|
| result-ignore | After `tool/result`, extract the key tokens/ids of the result text (stopwords removed, filtered by `minTokenChars`) and search for them in the `assistant/message` text of the next N steps; all absent ⇒ flag, evidence = that result's seq + the covered window seqs. `isError`/empty results are tracked directly for "whether they are acknowledged". | One tokenization per result + N substring searches; sliding window, O(N × text length), bounded | High false-positive surface: summarizing language legitimately doesn't echo tokens. Default `severity:'info'`; can be dialed down via `sampleRate`; first tighten to the "error result ignored" subclass (stronger faithfulness) |
| output-fabrication | `assistant/message` text hits the minimal claim pattern set (`wrote/created <path>`, `tests pass`, `committed/PR #\d+`); no corresponding `tool/call` (write-class tools / todolist / goal gate) is found in subsequent events of the same turn ⇒ flag, evidence = the claim's message seq. **Boundary with doc 02**: 02 is admission-time enforcement on tool RESULTs plus turn-level claim audit; 11 is cross-turn drift telemetry and never blocks. M1 ships with its own minimal pattern set; migrate to the shared lib once 02 stabilizes (see Risks). | One regex pass per assistant text, O(pattern count) | Claims can be falsely matched by "spoken plans" → match only completed-tense/assertion forms; start at `warn`, tune driven by reports |
| context-pollution | Three indicators: ① within `windowSteps`, the same (name, canonicalized arguments) `tool/call` occurs ≥ `repeatThreshold` times (retry storm); ② a single `user/message` text > `pasteChars` with high overlap against recent content (large paste-back); ③ an abrupt language/domain shift in assistant text within the same turn (script/charset jump). Each flags independently. | Windowed hash counting, O(window); overlap via sampled shingles | Legitimate retries (polling, compile-fix loops) are a high false-positive surface → conservative default `repeatThreshold` 5+, `info` only; ③ emits `info` only |
| plan-drift (**proxy**) | When a goal exists (doc 04's domain; paths currently supplied manually via `goalPathHints`): across `windowTurns` consecutive turns, every `tool/call.arguments` touches no goal-adjacent path ⇒ flag. Explicitly marked as a proxy: runs without goal semantics too — a pure path-affinity heuristic. | One path-prefix match per call | Exploration/reading phases are naturally far from paths → `info` only, and only triggered over a consecutive window; once 04 lands, switch to reading its gate paths (runtime-optional integration, zero compile-time dependency, overview principle 1) |
| job-drift | Use the cron-class source of `user/message` as the job-run anchor; across `kRuns` consecutive runs of the same job, there is no state-changing-class `tool/call`, and any diff-carrying `tool/result.meta` is an empty diff ⇒ flag (idle-spin detection). | Per job run, O(events in window) | `info` only; `kRuns` defaults to 3; the exact shape of the cron source is unverified (Q3 in Risks) — until then, effective only on recognizable anchors |

Detector output is **only structured flag events** (evidence by event seq/callId) —
no narrative text is produced; narrative rendering is left to `/watch report` and
doc 12.

**`/watch report`**: registers `watch` via `inject=['commands']`; the handler
renders this session's recent flags (grouped by turn, detector×severity counts,
latest K entries with evidence seq links to `turn:step`); `rawInput` supports
`turns=N`/`detector=x` filters. CommandResult `kind:'success', text:…`
(session-log-export precedent).

### Offline replay + fault-injection loop

Location: `packages/observability/silent-failure-watch/scripts/` (run with tsx;
entry point package.json `scripts.watch-replay`). Input = persisted session.jsonl
(same format as `ReplayConfig.file`; parseability by `parseSessionLog` is the
acceptance criterion).

**`watch-replay run --session s.jsonl --fault <class> --at-call k --tool <name>`**:
root cordis ctx → `mountAgentLoopTestDependencies` →
`installLlmReplay(ctx, { file })` → `ctx.tools.register` a same-name wrapper tool
(internal counter; injects the fault at the k-th call) → load this plugin (with
`trialId`) → after the run completes, `ReplayHandle.assertConsumed()` → emit the
rerun session log.

**Fault classes** (tool layer; model-layer `throw/hang` is natively supported via
`overrideFile` patches — usable as one means, but not counted among the four
classes):

1. `stale-value`: return the result snapshot from the previous call with the same
   arguments (stale value).
2. `empty-result`: `ToolResultBlock.content = []`.
3. `permission-flip`: return a denial body with `isError: true` (fidelity depends
   on the `error.code` vocabulary of real denials; see Q2 in Risks).
4. `timeout`: hang until past the AbortSignal, then throw (simulates the timeout
   path).

**`watch-replay diff`** (deterministic-first, AgentCheck doctrine): replay does not
validate request equality (pop-in-order + FROM_REQUEST), so after the fault the
model still follows the old narrative — **full-text diff is meaningless**; the diff
language narrows to three deterministic assertions:
(a) **detector-eval**: the rerun log's flag set ⊇ the expected flag set for that
fault (the corresponding detector must hit, seq given);
(b) **canary assertion**: the unique canary token injected for the fault should be
absent from subsequent assistant text under result-ignore ground truth;
(c) **prefix equality**: in-order events before the fault point equal the original
log field by field.
LLM-judge is auxiliary (optional `--judge`, independently configured model, not
gated on): it scores whether the final narrative agrees with the real post-fault
state (low score = silent failure established).

**mitigation-confirm**: `watch-replay confirm --mitigation <plugin-module|config-json>`
reruns the same fault and asserts the silent narrative no longer runs to completion
intact — intervention evidence appears (deny/steer events from doc 02's
enforcement, or this plugin's flag hits at an earlier seq and subsequent input is
corrected). This is the reproduce → intervene → confirm engineering closed loop;
candidate fixes are loaded at offline time via optional dependencies, with zero
compile-time dependency at runtime.

## Milestone breakdown (each M = one PR of granularity + "Verify:" criteria)

**M1 — schema + two detectors + synthetic-session tests**
`pnpm new:plugin observability silent-failure-watch` scaffold; `watch/flag` merged
into `SessionEventMap` via declaration merge; result-ignore and output-fabrication
detectors + per-detector `sampleRate`/`maxFlagsPerTurn`; the zero-intervention path
on the recording side.
Verify: synthetic `SessionEvent`-sequence unit tests (golden flag sets, with exact
evidence-seq assertions); schema JSON round-trip; re-entry-discipline test (no
append inside listeners; deferred flush exercised); all gates green
(build/typecheck/test/check:exports/check:spec-deps).

**M2 — remaining detectors + sampling/throttling + /watch report**
context-pollution (three indicators), plan-drift proxy (hints supplied via config),
job-drift (effective on recognizable anchors); `/watch report` command registration
and rendering.
Verify: one synthetic-scenario unit test set per detector + throttle-cap assertions;
golden command output; `turns`/`detector` filter-parameter tests; an integration
test asserting that with session-telemetry mounted, watch/flag appears as ledger
records (1:1 mirror).

**M3 — offline CLI + 4 fault classes + mitigation-confirm + docs**
`watch-replay run/diff/confirm`; 4 fault classes; optional `--judge`; README (a
graduation-criteria section) + alignment with this directory's docs.
Verify: one recorded fixture session × 4 fault classes, each deterministically
hitting its expected flag set; `confirm` mode with a fake mitigation (e.g., a test
plugin that acks early) asserts the silent narrative is interrupted; the
`assertConsumed` unconsumed check takes effect; all gates green.

## Verification plan

- **Unit**: detectors as pure functions (event sequence → flag sequence); synthetic
  sessions fully golden-tested.
- **Integration**: testkit + llm-replay to construct a session where "the script
  ignores tool results"; result-ignore must hit. Idle-spin jobs and retry-storm
  synthetic scenarios cover the remaining three detectors.
- **Telemetry compatibility**: mount a minimal session-telemetry sink; assert
  watch/flag appears as ledger records and that the `session-telemetry/record`
  waterfall can rewrite them normally.
- **Offline loop**: M3's 4×fixture matrix + mitigation-confirm assertions; the
  deterministic parts enter the gates; LLM-judge only reports, never gates.
- **Feedback to doc 12**: once schema `schema:1` is frozen, the doc 12 side writes
  a consumer contract test from fixture flag events (to be added when doc 12 is
  initiated).

## Risks and open questions

- **The false-positive economics of heuristic detectors**: all AUDIT, never
  intervenes ⇒ the direct cost of false positives is report noise and telemetry
  volume, not wrong blocking. Posture: start at `info`, two-layer throttling via
  `sampleRate` + `maxFlagsPerTurn`, `/watch report` as the manual calibration loop;
  on the doc 12 side, tighten after detector×severity statistics. The most
  dangerous is the full-match version of result-ignore; M1 starts with the "error
  result unacknowledged" subclass.
- **Deduplication path with the 02 pattern library**: 02 (claim-contracts) =
  admission-time enforcement on tool RESULTs + turn-level claim audit; 11 =
  cross-turn drift telemetry, never blocks. Their claim-pattern shapes overlap, but
  the consumption differs. Decision: M1 ships its own minimal pattern set
  (completed-tense assertions + artifact-type whitelist), **explicitly declared as
  a temporary copy**; after 02 lands, promote the pattern library to shared
  (candidates: annexed to doc 01 tool-manifest, or a standalone patterns package),
  and 11 switches to depend on it; during the transition both copies coexist with
  consistent schema field names.
- **Open questions (unconfirmed items and precise checks)**:
  1. **The write path for envelope `ignorable`**: the public signature
     `Session.append(type, data)` takes no ignorable; it is only read in seed
     validation (index.ts:205–245). Check whether core/session has another writer
     with opts; until confirmed, treat `watch/flag` as a required event — old
     readers that don't recognize the type will refuse per spec, so the offline
     toolchain needs a synchronized upgrade (acceptable; all within this
     repo/upstream).
  2. **permission-flip fidelity**: the `tool/result.error.code` vocabulary produced
     by real denials is unverified (`dsh-permission-rules` source is not in the
     checkout; noted at types.ts:336–343). Before M3, run one real denial from the
     dsh-cc-plugins side, record it as a fixture, then finalize the fault's error
     text.
  3. **Anchor shape for cron/job runs**: the `user/message` docs list "cron
     notifications" (types.ts:257–264), but the exact `source.kind` structure
     injected by the schedule package is unconfirmed. Check the injection
     implementation in `packages/schedule/schedule`; until then, job-drift is
     effective only on recognizable anchors.
  4. **Source of goal path hints**: 04 (goal-verify-gate) is not yet built;
     plan-drift's goal-adjacent paths are temporarily supplied manually via config;
     after 04 lands, switch to runtime-optional reads (zero compile-time
     dependency).
  5. **Replay has no request-equality validation** (pop-in-order + FROM_REQUEST
     templates, confirmed at llm-replay/src/index.ts:379–385, 688+) → diff
     semantics can only be flag set + canary + prefix equality; no full-text
     comparison. If upstream adds request validation in the future, the offline
     loop needs adaptation (recorded in the README).
