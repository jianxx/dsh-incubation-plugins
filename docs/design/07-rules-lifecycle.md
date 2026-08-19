# 07 rules-lifecycle — Capture, Activation, and Convergence of Behavioral Rule Artifacts

> Status: design (not started) | Tier: 2 | Package: packages/memory/rules-lifecycle | Depends on: none
>
> Verified seams against deepseek-harness **0.1.0-rc.7** (@99f6f02fec); path:line citations refer to that tree.

## Design goal and user problem

**Goal**: sediment user corrections into a versioned behavioral-rules artifact (five sections: behavioral rules / code standards / self-review checklist / anti-patterns / workflow rules), with a candidate → active → archived state machine, recurrence tracking, periodic consolidation, and a hard byte budget on prompt injection.
**User problem**: users repeat the same corrections to the agent every week ("don't touch vendor/", "run lint before committing"); corrections either never sediment at all, or sediment into CLAUDE.md and only ever grow — months later the prompt is drowned in accumulated rule noise, the rules that actually matter get ignored by the model, and the very errors that were corrected keep recurring.

## Motivation

- **SSCA** (Self-Improving Coding Agents Through Accumulated Rules) demonstrates a
  verified production loop: an accepted review comment → a versioned behavioral rule
  written into a shared instruction file; rules are organized into five sections —
  behavioral rules / code standards / self-review checklist / anti-patterns / workflow
  rules; on a platform of 35+ services they grew from 5 to 18 rules over several
  months; across 74 exposures, the 9 categories of errors covered by rules showed
  **zero recurrence**. But the paper also states a clear limit: monotonic growth
  creates context-window pressure — **maintenance/convergence is not optional**.
  This work item makes "convergence" a first-class phase (consolidation + archive),
  not an afterthought patch.
- **SkillOpt**: bounded edits act as a learning rate — each consolidation run sets a
  max edit count; edits pass a held-out validation gate before acceptance; rejected
  edits go into negative-feedback memory (here: rejected candidates are retained in
  archived and participate in the consolidation prompt, avoiding repeat proposals).
- **AMV-L**: the memory lifecycle must constrain per-request compute/footprint —
  realized here as a **byte budget for prompt injection** (default 2KB); exceeding
  the budget triggers degradation, not unbounded stacking.
- **MemCon** (cited as future work only): later, the control of
  RETRIEVE/CONSOLIDATE/FORGET itself could be learned; this design fixes control as
  rule-based, with no learning.
- dsh status quo: it has a system-prompt assembly seam, a session event stream, and
  a cheap auxiliary LLM call pattern, but **no** versioned, reviewed rule artifact
  with recurrence statistics. This work item fills that gap.

## Current State and Gap

dsh already has every required seam (cited one by one in the next section); the gap
is purely in artifacts and process: no rules store, no candidate→active→archived
state machine, no recurrence tracking, no budgeted injector, no consolidation
review loop.

### Boundary with dsh-cc-plugins memory

dsh-cc-plugins (a different repo, **zero compile-time dependency, optional runtime
integration**, shared principle 1) already provides generic CLAUDE.md-style memory +
dream consolidation: what it accumulates is **facts and preferences**, growing
naturally, without per-entry review, without recurrence metrics. rules-lifecycle is
**not** generic memory: it is a versioned, per-entry human-reviewed (a candidate
never takes effect silently), budget-constrained **rule** artifact with provenance
and exposure/recurrence statistics. The two can coexist: memory answers "what is
this project", rules answer "what mistakes has this team made, and must never make
again". This plugin neither reads nor writes cc-plugins memory files; if integration
is ever built, it may only read-reference them inside the consolidation prompt,
which does not constitute a dependency.

Adjacent memory items: the candidate→active→archived lifecycle machinery in the
consolidation flow is the named extraction candidate for 27 memory-maintenance
(applied there to facts, not rules); 26 memory-write-gate complements this doc's
consolidation — quality admission for facts, never a gate on human-reviewed rules.

## Design

### Surfaces and Seams (verified + cited)

All of the following are verified in the deepseek-harness repo; unverified items go
only into "Risks and Open Questions".

1. **System prompt injection**: `ctx.systemPrompt.section({name, order, text})`,
   returning a Cordis disposer; `text` may be a synchronous function, **evaluated
   synchronously on every assembly** (called directly inside assemble, no await).
   Order conventions: `-100` harness identity, `0` persona, tool guidance uses
   100–199. Source: `packages/core/system-prompt/src/index.ts` (`PromptSection`,
   `SystemPrompt.section()`, order convention around lines 57–60, registration API
   at lines 61/381, `system-prompt/change` notification).
   → This plugin registers `name: 'rules-lifecycle:active'`, `order: 200` (after
   tool guidance).
2. **Session event stream**: `ctx.on('session/event', (session, event) => …)`,
   published post-commit, emit pattern, observer failures are isolated. Source:
   `packages/core/session/src/index.ts:76`. User messages are
   `'user/message': UserMessage` (`packages/core/session/src/types.ts:264`), whose
   `source` distinguishes the producer (`MessageSourceMap` at
   `packages/llm/llm/src/message.ts:100–105`: `{kind:'user'}` = typed by a human,
   `{kind:'plugin', plugin}` = injected, plus model/tool). Correction detection
   looks **only** at `source.kind === 'user'`. The governed object surface:
   the `'tool/call'` payload is `{turn, step, callId, name, arguments}` (arguments
   is the raw JSON string produced by the model, `types.ts:279`);
   `'assistant/message'` carries the assembled message. Interrupt signal:
   `'turn/end'` with `reason.kind === 'aborted'` and `reason.reason.kind === 'user'`
   (`types.ts:155–177`, `TurnEndReasonMap`).
3. **Plugins making cheap LLM calls**: see the pattern in
   `packages/session/session-title-llm/src/index.ts` —
   `ctx.llm.stream(options)`; `GenerateOptions` includes `{provider, model, messages,
   system, maxTokens, sessionId, purpose, signal}`; use `createUserMessage` to build
   plugin-attributed messages (`source: {kind:'plugin', ...}`), `BlockAssembler`
   collects blocks, `deadline()` from `@deepseek-ai/dsh-timeout` enforces the time
   limit; before sending, append a log-only session event (the
   `session/title-llm-request` precedent); `provider`/`model` must be configured as
   a pair. DeepSeek is the default provider (registered at
   `packages/llm/llm-deepseek/src/index.ts:251`).
4. **Command surface**: `ctx.commands.register({name, description, input: {hint},
   recordInput, handler})`, with the handler returning `{kind:'success', text}`.
   Source: `packages/feedback/command-feedback/src/index.ts:101`. Rule text needs
   provenance → `recordInput: true`, so the `command/run` event carries the input.
5. **Telemetry**: `session-telemetry/record` waterfall; the ledger channel maps
   one-to-one with session event appends — a plugin that appends its own session
   events automatically becomes ledger telemetry records. Source:
   `packages/session/session-telemetry/src/index.ts:43`. Conforms to shared
   principle 5.
6. **Custom session event constraints**: for types outside
   `KNOWN_SESSION_EVENT_TYPES`, the read path refuses to interpret the log unless
   the `ignorable: true` flag is present
   (`packages/core/session/src/types.ts:433` and the header comment of
   `known-event-types.ts`: out-of-repo plugin events are by construction not in the
   table). → All custom events of this plugin must carry `ignorable: true`, and
   declare their types by merging `SessionEventMap` (session-title-llm is exactly
   this pattern).

### Data Model / Configuration (rule entry schema, budgets, thresholds)

> **Configuration (rc.7 onward)**: user-tunable knobs (the table below:
> injection budgets, overflow mode, thresholds) are declared through a settings
> namespace (`settingsNamespace` + `installSettingsSection`,
> `packages/settings/settings/src/index.ts:863`). Resolution layers: schema
> defaults → the cordis composition entry (base) → the `settings.yaml` user
> document. Values hot-reload via `settings/updated` and are readable at runtime
> through `ctx.settings.describe()`. Registering a namespace exposes it — #2404
> removed the apiproxy allowlists, so registration is the only exposure control
> — which means both the web settings page and `settings.yaml` can edit it. The
> cordis `apply(ctx, config)` second argument remains the composition-defaults
> layer; the `.dsh/rules/*.md` files below are rule content, not configuration.

**Storage**: `.dsh/rules/{behavioral,code-standards,self-review,anti-patterns,workflow}.md`,
five files corresponding one-to-one to the SSCA five sections. Writes go through the
plugin's internal atomic write (temp + rename), not through the tool surface;
resolved relative to `session.cwd`, travels with the repo, and can enter git code
review.

**Rule entry** (one `<!-- rule: … -->` metadata block + body per file):

```md
<!-- rule: AP-003
section: anti-patterns
state: active            # candidate | active | archived
version: 2
author: user             # user | agent-suggested
source: { session: 01J…, ref: "PR#412 review comment" }
matcher: { kind: regex, events: [tool/call], pattern: "catch\\s*\\([^)]*\\)\\s*\\{\\s*\\}" }
stats: { exposures: 41, recurrences: 1, lastInjectedAt: 2026-08-15T… }
createdAt: 2026-08-03T…  activatedAt: 2026-08-09T…  archivedAt: null
-->
No empty catch blocks; at minimum log and rethrow, or call handleError(e).
```

- `state: candidate → active → archived`; `archived` additionally serves as the
  terminal state for rejected (`source.verdict: rejected` marker, retained as
  SkillOpt-style negative feedback).
- `matcher` is defined only at activation time and is optional;
  `kind: tool-name | regex`; `events` restricts the set of event types listened to.

**Configuration** (schemastery schema; all defaults are tunable defaults, shared
principle 3):

| Key | Default | Meaning |
|---|---|---|
| `injectionBudgetBytes` | 2048 | Max UTF-8 bytes of active rules injected per assembly (AMV-L) |
| `overflowMode` | `audit` | `audit` = passive truncated rendering only; `enforce` = additionally emit archive proposals for persistently uninjected rules |
| `capture.suggest` | `audit` | `off` disables heuristic correction detection; `audit` only queues suggestions, never activates them |
| `recurrence.escalation` | `notify` | `notify` (event + `/rule status`) / `steer` (solicit a strengthened draft on a subsequent turn) / `off` |
| `consolidation.intervalDays` | 7 | Periodic trigger |
| `consolidation.thresholdBytes` | 0.8×budget | Trigger on active total bytes as a share of budget |
| `consolidation.thresholdCount` | 24 | Trigger on active rule count (SSCA's 18 rules are already in the effective range, with headroom) |
| `consolidation.maxEditsPerRun` | 8 | Max edits per consolidation run (SkillOpt learning rate) |
| `consolidation.provider/model` | required as a pair | Auxiliary LLM routing; validation and pairing requirement same as session-title-llm |

**Utility scoring** (for degradation ordering; lower is proposed for archive
first): `u(r) = w_r·recency(lastInjectedAt) + w_e·ln(1+exposures) +
w_p·prevented(r)`, where `prevented(r)` = days since activation during which the
matcher was present with zero recurrences; `exposures` = injection count
(deduplicated at turn level; microcompaction rebuilds are not double-counted).
**Rules with unresolved recurrences do not participate in degradation** — archiving
a currently failing rule amounts to hiding the problem; it should first go through
the strengthening flow; `pinned: true` is a manual exemption.

### Key Behavioral Flows

**State machine (capture → candidate → active → archived)**
- Explicit capture: `/rule add <section> <text>` → immediately becomes a candidate,
  appends `rules/candidate` (ignorable).
- Semi-automatic suggestion (capture.suggest=audit): the watcher sees a
  `user/message` with `source.kind:'user'` hitting a correction marker
  (configurable word list, defaults include `不对`/`不要这样`/`别`/`should have`/
  `instead`), or a `turn/end` (aborted, user reason) immediately followed by a
  user message in the same session (interrupt-then-rephrase) → generates a
  suggestion into the review queue, appends `rules/suggested`.
  **audit-first: suggestions are never silently activated**; `/rule review` lists
  the pending queue, and the user runs `/rule activate <id>` or
  `/rule reject <id>`.
- All state transitions are human commands; the automatic surface is limited to:
  suggestion queuing, recurrence counting, render truncation, and degradation
  **proposals**.

**Injection flow**
Register `rules-lifecycle:active` (order 200). Invariant (verified): section text is
evaluated synchronously, so the rendered result is pre-generated and cached on store
changes; the provider just returns the cached string — zero I/O on the assembly hot
path. Rendering = concatenating active rules in the five-section order; when
exceeding `injectionBudgetBytes`, truncate whole rules from lowest utility upward,
and append a tail line `- …(+N rules omitted by byte budget; see /rule status)`.
Each turn, aggregate-append `rules/injection {bytes, ruleIds, omittedIds}` at
`turn/end` (ignorable; not appended at assembly time, to avoid assembly side
effects). In `enforce` mode, a rule truncated for K consecutive turns automatically
generates an archive proposal into `/rule review`.

**Recurrence tracking flow**
A `session/event` listener (never throws, shared principle 2; exceptions are only
recorded via telemetry). For each active rule with a matcher: `tool-name` matches
`tool/call.name`; `regex` matches the raw `tool/call.arguments` string or
`assistant/message` text blocks. Only **new** occurrences after activation are
counted: use `activatedAtSeq` as the baseline and deduplicate by event `seq`. On a
hit → `stats.recurrences++`, persist, append
`rules/recurrence {ruleId, seq, session}` (ledger → telemetry mirrors it
automatically, severity raised to `warn`). With escalation=`notify`, `/rule status`
shows an escalation badge; `steer` (opt-in) goes through the `agent/turn-stopping`
steer-back: at natural completion, inject a plugin-attributed user message asking
the agent to draft a strengthened version of the rule text as a **new candidate** —
still requiring human activation; the steer message participates in round
accounting, so the attribution marker
`source: {kind:'plugin', plugin:'rules-lifecycle'}` must be carried
(shared principle 2).

**Consolidation flow (SkillOpt/SSCA maintenance phase)**
Triggered by period or threshold. Build a prompt = the full text of all
active+candidate rules + the rejected list from archived (negative feedback) +
per-rule stats; call via `ctx.llm.stream` (verified pattern 3,
`purpose: 'rules-consolidation'`, pre-send append of the `rules/consolidation-request`
log-only event). The model produces an **edit proposal** (merge/rewrite/archive
ops), and a programmatic held-out gate machine-checks it: (a) edit count ≤
`maxEditsPerRun` (bounded edits); (b) it must not delete or weaken the matcher
semantics of any rule with an unresolved recurrence; (c) merged total bytes must not
increase. On machine-check failure → the proposal is rejected wholesale and the
rejected feedback is recorded. On pass, it is presented as unified diff text via
`/rule consolidate` (the handler returns `{kind:'success', text: diff}`, without
inventing a confirmation channel — approval is the user typing
`/rule consolidate apply`, conforming to shared principle 1's "human gate on the
command surface"). apply writes to the store, bumps `version+1` on all affected
rules, and appends `rules/consolidated`.

### End-to-End Example

1. PR#412 review comment: "**don't swallow errors with empty catch blocks**".
2. User: `/rule add anti-patterns No empty catch blocks; at least log or rethrow` →
   candidate `AP-003` (author=user, source.ref="PR#412 review comment").
3. User: `/rule activate AP-003 --matcher regex:catch\s*\([^)]*\)\s*\{\s*\}` →
   active; from the next assembly onward the injected block shows
   `### Anti-patterns\n- [AP-003] No empty catch blocks…`.
4. Two sessions later, the agent writes an empty catch in the
   `tool/call.arguments` of an Edit → the watcher hits, `recurrences: 0→1`,
   appends `rules/recurrence`, and `/rule status` shows
   `AP-003 ⚠ recurrence @seq 517`.
5. The user strengthens it accordingly: `/rule add anti-patterns No empty catch;
   always call handleError(e)…` and activates it as `AP-003 v2`, with the matcher
   tightened to `catch\s*\([^)]*\)\s*\{(?![^}]*handleError)`; thereafter the watcher
   keeps observing, and zero recurrences accumulate `prevented` — replicating SSCA's
   "zero recurrence of ruled-against errors" metric.

## Milestone Breakdown

**M1: store + five-section schema + /rule commands + injector (byte budget) + unit tests**
`.dsh/rules/*.md` read/write (atomic writes), entry schema validation,
`/rule add|list|activate|archive|reject|status`, `rules-lifecycle:active` section
registration and budget-truncation rendering, `rules/candidate|activated|archived|injection`
events (ignorable).
Verify: unit tests cover store round-trip, rejection of illegal state-machine
transitions, budget truncation order (lowest utility truncated first), and assembly-side
injection block snapshots; the `pnpm new:plugin memory rules-lifecycle` scaffold gates
are all green (principle 6).

**M2: recurrence tracking + escalation path + telemetry + synthetic session tests**
matcher language (tool-name/regex), `session/event` watcher (listener isolation +
seq dedup), `rules/recurrence` event with notify/steer escalation, heuristic suggest
(`capture.suggest`, audit-first), exposure counting and utility scoring, consecutive-
truncation archive proposals (enforce).
Verify: synthetic sessions (append event fixtures in order on a temporary SessionStore:
correction message, empty-catch tool/call, aborted turn/end) → assert that suggestions
are queued but not activated, recurrence count and sequence are exact, and escalation
events with severity=warn appear in the telemetry export.

**M3: consolidation flow (diff approval) + utility scoring refinement + docs**
consolidation triggers, LLM proposals (`purpose` marker, pre-send log event),
machine-checked held-out gate (maxEdits / recurrence-rule protection / bytes not
increasing), diff presentation and `consolidate apply`, rejected feedback retention,
and the graduation criteria section of the README.
Verify: MockAdapter-driven full-chain unit tests of proposal→machine-check→apply
(including two negative cases: exceeding maxEdits gets rejected, touching a
recurrence rule gets rejected); docs cross-consistent with this document.

## Verification Plan

- **Driving method**: M1/M2 use vitest unit tests + synthetic session fixtures (real
  `session/event` seam, appending events to drive the watcher, no mocking of the
  event bus); M3 uses the MockAdapter pattern from agent-loop tests (see usage in
  `packages/core/agent-loop/tests/`) to simulate the consolidation LLM.
- **Observable pass criteria**: (a) the injected block is ≤ budget with no half rule
  (whole-rule truncation); (b) correction heuristics only enter the suggestion
  queue, and the `rules/active` set contains no non-human activation record; (c)
  the empty-catch fixture produces exactly one `rules/recurrence` on the watcher;
  (d) the telemetry export contains the full sequence
  `rules/candidate|activated|recurrence|injection|consolidated` with a schema
  consistent with the eval export schema of doc 12 (principle 5); (e) the three
  gates are all green.
- **Real-world trial**: enable in this repo's own development sessions for ≥ 2
  weeks, observing suggestion queue precision (accept/reject ratio) and mean
  injected bytes, as telemetry evidence for the graduation nomination.

## Risks and Open Questions

1. **False-positive surface of heuristic correction detection**: marker words can
   hit "the user is discussing something else" (e.g. "don't design this API this
   way" is task discussion, not behavioral correction); interrupt-then-rephrase can
   misclassify "interrupting then adding an unrelated new requirement" as a
   correction. Mitigation: audit-first (false-positive cost = noise in the
   suggestion list, no behavioral consequence) + configurable word list +
   `capture.suggest: off` fallback. Open: whether to record the suggestion
   acceptance rate and automatically desensitize (decide from M2 telemetry data).
2. **Interaction with 09 token-wall (judgment given)**: rule file writes **are
   authoritative changes** — rule text will enter the system prompt and belongs to
   the instruction supply chain; but its write path does not go through the tool
   surface (plugin-internal atomic write), so 09's tool-call admission
   classification inherently cannot see it. Judgment: **the authoritative gate is
   borne by this plugin's own human gates** (candidate→active and consolidate apply
   both require explicit commands), not by 09's tool wall; the real intersections
   with 09 are at two trust boundaries — (a) candidate text originates from user
   messages, and should pass exfiltration classification before persistence and
   injection (a pasted user correction may contain a secret); (b) the consolidation
   request sends full rule text to the provider, already marked with
   `purpose:'rules-consolidation'`, so 09/semantic-gateway can attach policies by
   purpose. Open: before 09 lands, the classifier call in (a) is an optional
   integration (skip with a record if 09 is not detected); when the time comes, the
   classification requirement must be declared via the tool-manifest unique
   annotation mechanism (principle 4).
3. **Auxiliary LLM route resolution**: session-title-llm's route comes from
   `request.route` inside its provider contract or an explicit `provider+model`
   pair; whether a **generic** plugin API for obtaining "the current session route"
   (e.g. `ctx.llm.resolveCallConfig`, see internal usage at
   `packages/host/apiproxy/src/api-proxy.ts:2288`) is a stable plugin surface is
   **unconfirmed**. Checklist item: confirm whether it is exported from the host
   package; if unavailable, keep `consolidation.provider/model` required (same
   policy as session-title-llm), defaulting to the DeepSeek provider.
4. **Exposure semantics are approximate**: SSCA's exposure is "the number of times
   the relevant scenario appeared while the rule was in force"; here it is
   approximated by injection count; microcompaction/compaction assembly rebuilds do
   not count as new exposures (turn-level dedup). This approximation may
   underestimate "in force but not triggered" scenarios — accepted, because
   recurrence (hit rate) is the hard signal.
5. **MemCon-style learned control**: learned control of
   RETRIEVE/CONSOLIDATE/FORGET is listed as future work only; if introduced in the
   future, a baseline must first be established from this plugin's telemetry
   starting at M2 (acceptance rate, zero-recurrence days, injected bytes); replacing
   rule-based control without a baseline is not allowed.
