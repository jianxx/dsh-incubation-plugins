# 02 claim-contracts — admission layer for claims and output contracts

> Status: design (not started) | Tier: 1 | Package: packages/verification/claim-contracts | Depends on: 01 tool-manifest

## Design goal and user problem

**Goal**: enforce code-level admission on tool results and assistant claims before they enter the context or reach the user (schema shape / freshness / provenance / domain rules), and audit assistant claims at end-of-turn into a three-way verdict: supported / unsupported / unverifiable.
**User problem**: users cannot trust what the agent says — "file created" or "tests pass" may be fabricated outright or built on truncated, stale tool results; once dirty data enters the context it silently poisons every later inference, the error surfaces far downstream, and prompt-level "please be honest" has never been a load-bearing wall.



## Motivation (why this is needed — the missing layer of the three-layer stack)

The three faces of the three-layer verification stack are not substitutable for
one another: 01 tool-manifest is the per-tool metadata substrate,
03 trace-contracts governs "is the trajectory legal", and this work item owns the
last layer — "does the output look real":

1. **Tool-result admission**: even when a tool call has legal arguments and
   executes without throwing, its result may still fail composition contracts —
   broken shape, stale data, missing provenance fields, or violation of domain
   rules (a bash result carrying no exit code; a read of a nonexistent file that
   silently succeeds with an empty string). Downstream steps keep reasoning on
   top of the bad result — this is the wellspring of "silent failure → wrong
   narrative".
2. **Assistant-claim hygiene**: the natural-language summary at the end of a
   turn — "created file X", "all tests pass", "PR submitted" — may not match the
   events that actually occurred in the session. No mechanism reconciles claims
   against evidence.

Literature anchors and the corresponding design stances:

- **Prompts-to-Contracts**: contracts held as code (manifest + schema +
  validator) beat pure prompt instructions, and incur less over-refusal than
  bolt-on guardrails — so the feedback on admission failure must be **actionable
  corrective feedback**, not a blanket refusal. The model owns only the
  replaceable composition boundary; adjudication over contracts stays in code
  forever.
- **Forethought**: typed primitives paired with local contract checks,
  intercepting as close as possible to the point of production rather than
  auditing after the fact.
- **EG-VAR**: the model proposes and a deterministic verifier admits; **when
  there is no evidence chain, take abstain + audit trail rather than judging a
  violation** — `unverifiable ≠ violation` is a hard semantic of this layer.

Why it must be code-owned admission rather than a prompt instruction: a prompt
instruction is "asking the model to self-discipline"; a contract is "the harness
adjudicating at the seam". The former dilutes with context, gets overridden by
injection, and cannot be audited; the latter executes on every call, produces
telemetry carrying a validator id, and has adjustable strength (doc 00 tenet 3).

## Current state and gaps

Upstream already provides every hosting seam (each one verified item-by-item
under "Surfaces and seams" below): the `tools/post-execute` waterfall's
`PostToolDecision` already supports a `block + feedback` corrective channel and
result replacement; the session event stream carries the full event set —
`assistant/message`, `tool/result`, etc. — with a monotonic `seq`; the
`session-telemetry/record` waterfall and the ops channel exist; the
`agent/turn-stopping` serial hook exists. Per doc 00's "Already covered" list,
neither cc-plugins nor this repo has a claim/contract admission implementation.
The gap therefore reduces to exactly two points:

- **No cross-field/cross-domain contract validation of post-execute results**:
  the registry itself only validates input arguments and each tool's custom
  output schema; freshness, provenance, and domain rules are owned by no one.
- **No mechanism reconciles assistant claims against evidence**, and no related
  telemetry vocabulary exists.

## Design

### Surfaces and seams (exact names + verified paths)

Every item below is verified against upstream source code; anything unverified
appears only under "Risks and open questions".

1. **Admission seam — `tools/post-execute` waterfall**
   `packages/core/tools/src/index.ts:175`:
   `(exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>`.
   Plugins register via `ctx.on('tools/post-execute', handler)`.
2. **Decision type — `PostToolDecision`** same file `:596-600`:
   two variants of `{kind:'accept'; content?|value?; additionalContexts?}` plus
   `{kind:'block'; feedback: ContentBlock[]; additionalContexts?}`.
   Consumption point `postExecute()` (:1742-1781, verified): `block` replaces the
   result with `{content: feedback, isError: true, error: {message}}` — i.e. what
   the model sees is the feedback text (recovery-friendly); `accept+content`
   replaces content, `accept+value` replaces value (re-validated against the
   tool's own output schema; a failed result is not allowed to have its value
   replaced; the two cannot be replaced simultaneously). The behavior is also
   pinned down by tests: `tests/tools.spec.ts:856-872` ("can replace the result
   content", "block turns the call into an isError with corrective feedback").
   Note: a throwing listener is funneled into an isError (:1740 comment) — our
   handler **must never throw**, or the actionable feedback is lost; and block
   discards the tool-deferred context, keeping only the `additionalContexts`
   carried by the block decision itself.
3. **Result shape — `ToolExecutionResult`** same file `:556-580`: success carries
   `value: JsonValue + content: ContentBlock[]`, failure carries
   `error: ToolFailure`; validators read the structured `value` first, `meta` may
   serve as a domain-side aid.
4. **Claim-audit seam — `session/event` observer**
   `packages/core/session/src/index.ts:76`:
   `(session: Session, event: SessionEvent) => void` (pure observer, no return
   value). Event payloads `packages/core/session/src/types.ts:243-297`:
   `assistant/message` `{turn, step, message, usage?}`, `tool/call`
   `{turn, step, callId, name, arguments}`, `tool/result`
   `{turn, step, message, error?, meta?}`, `turn/end {turn, reason}`
   (`TurnEndReason` enum `:155-177`: completed/aborted/blocked/error/max-tokens/
   interrupted). The event envelope `:415-447` carries `seq` (monotonic within
   the session), `time`, `sourceEventSeqs` — evidence references are expressed
   directly as seqs. See the consumption pattern at
   `packages/core/agent-loop/src/runtime-context.ts:46`.
5. **Telemetry seam — `session-telemetry/record` waterfall**
   `packages/session/session-telemetry/src/index.ts:43`, record shape
   `SessionTelemetryRecord` same file `:64-` (`channel: 'ledger'|'ops'`,
   `severity`, `attributes`, `body`); the sink `emit()` is non-blocking enqueue
   (:104). This plugin's verdict and claim flags travel the **ops channel** and
   never land in the session log (see risk 3).
6. **Steer-back seam (milestone-gated, not v1) — `agent/turn-stopping` serial
   hook** `packages/core/agent-loop/src/agent.ts:296`. doc 00 tenet 2: the turn
   may only be continued via a plugin-attributed user message; the listener never
   throws.
7. **Config landing point — `.dsh/contracts/*.yml`**: consistent with the
   upstream project-level convention (`<projectRoot>/.dsh/skills` in
   `packages/skill/skill-filesystem/src/index.ts:246`, source `project-dsh`).

### Data model / configuration (contract + validator schema, modes)

Contract files (YAML, one per file, `.dsh/contracts/*.yml`; built-in contracts
ship with the package in the same format):

```yaml
id: fs-read-missing-file        # globally unique; telemetry references it
version: 1
tool: fs/read                   # tool name or glob; resolved by name via the doc 01 manifest
validator: domain               # json-schema | freshness | provenance | domain
mode: enforce                   # off | audit | enforce (can be overridden by higher-level config)
when: { result.isError: false } # applicability predicate; runs only on matching results
checks: ...                     # kind-specific parameters (see below)
feedback: |                     # actionable feedback template injected to the model on block
  fs/read target {{args.path}} does not exist: confirm with fs/list first, or create it and retry.
```

Four validator kinds (the kind determines the `checks` parameters):

- `json-schema`: the JSON Schema the result's `value` must satisfy (the
  Prompts-to-Contracts substrate).
- `freshness`: an mtime/timestamp field in the result must fall within the ttl,
  or match the current fs mtime (prevents a stale cache being taken as ground
  truth).
- `provenance`: the list of provenance fields that must be carried (e.g.
  `sourceUrl`, `path`, `fetchedAt`).
- `domain`: named-rule implementations (looked up by id inside the registry),
  for hard constraints that fit none of the first three kinds.

Mode resolution order (the SafetySentry tunable dial, doc 00 tenet 3):
contract-file field > validator-kind default > global default (`audit`). `off`
short-circuits entirely; `audit` still runs `accept`/`next()` as usual but emits
telemetry; `enforce` goes `block + feedback`.

The claim-audit side (occupies no contract files; configured via a pattern
library): one pattern = `{id, match (regex / intent template, bilingual
Chinese-English), evidence query spec}`. The evidence spec describes the
retrieval surface for supporting evidence: this turn's `tool/call`/`tool/result`
event pairs (paired by callId, success = isError=false), plus read-only fs
assertions (file existence) when needed. Each claim produces a flag:

```ts
type ClaimFlag = {
  plugin: 'claim-contracts'      // attribution (doc 00 tenet: observations carry provenance)
  patternId: string
  claim: { text: string; turn: number; sourceSeq: number } // provenance seq
  verdict: 'supported' | 'unsupported' | 'unverifiable'    // abstain is a verdict, not a violation
  evidence: { eventSeqs: number[]; fsFacts?: string[] }    // nullable
  mode: 'audit' | 'enforce'      // always audit in v1
}
```

### Key behavior flows (post-execute admission flow; claim-audit flow; abstain path)

**Admission flow (on every tool call)**: the `tools/post-execute` handler
receives `(exec, result)` → looks up the applicable validator list by
`exec.name` against the doc 01 manifest + `.dsh/contracts/` → runs them one by
one (pure functions; only read-only fs stat allowed, side effects forbidden) →
if all pass, `next()` unchanged; on failure, a validator's own bug is kept
separate from "contract unsatisfied" — the former logs a `{severity:'warn'}`
ops telemetry and fails open (treated as audit by default); the latter follows
mode: `audit` → `next()` + ops telemetry
`{telemetry.op:'claim-contracts/admission', attributes:{validator.id, tool, verdict:'rejected', mode}}`;
`enforce` → return `{kind:'block', feedback: ContentBlock[]}` (the feedback
carries the validator id and an actionable remediation guide) + the same
telemetry. The handler is wrapped in try/catch end to end and never throws.

**Claim-audit flow (audit-only in v1)**: the `session/event` observer maintains
a per-turn buffer (this turn's assistant/message text and tool/call+result
pairs); at `turn/end` with `reason.kind==='completed'`: take the final assistant
text → the pattern library extracts checkable claims → reconcile each against
its evidence spec (event seqs first, read-only fs when necessary) → emit one ops
telemetry flag per claim (structure as above; `severity`: `warn` for unsupported,
`info` for the rest). If the turn ends aborted/error, the whole turn is skipped
(in an environment where claims could not land, no verdict is made). v1 changes
no model-visible surface.

**Abstain path (EG-VAR)**: when the evidence is sufficient to neither support
nor refute, the verdict must be `unverifiable`, and the missing link must be
recorded in evidence (e.g. "no paired tool/result; fs assertion not
applicable"). `unverifiable` never counts toward the violation rate, only toward
the coverage metric — this reserves for doc 12's eval export a readout of "how
many claims are actually uncheckable".

**Steer-back (milestone-gated, off by default)**: when the claim side's mode is
raised to `enforce`, inject a user message with `[claim-contracts]` attribution
at `agent/turn-stopping`, attach the list of unsupported claims, and ask the
model to present evidence for each or retract. It is enabled only as an
experiment flag after M3; promotion requires a separate record of real-session
observation (doc 00 "no observation, no claim").

### Built-in validator list (initial pack with justification)

1. `json-schema-shape` (generic): any tool result whose contract supplies a
   schema gets shape-checked first — lowest cost, widest coverage; it is the
   precondition for the other validators.
2. `bash-exit-status` (domain): bash-family results must carry a structured exit
   code; missing → block — "the command ran but its success is unknown" is the
   number-one source of wrong narratives.
3. `fs-read-missing-file` (domain): when fs/read hits a nonexistent path it must
   surface as a structured isError (ENOENT); silent success with empty content
   is not allowed.
4. `result-freshness` (freshness): read-family results asserting "latest/current"
   semantics are rejected when their mtime exceeds the ttl (or audited).
5. `provenance-required` (provenance): results representing an external fetch
   must carry `sourceUrl`/`path`/`fetchedAt` — missing provenance means
   unauditable.
6. Claim patterns (audit-only): `file-created`, `command-ran`, `tests-passed`,
   `pr-opened` — high-frequency, and each has a clear evidence surface (paired
   tool events or an fs assertion).

## Milestone split (each M = PR granularity + an observable "Verify:" criterion)

- **M1 — validator registry + post-execute admission + ≥3 built-in validators +
  unit tests (mock pipeline)**: the registry (kind→implementation), contract
  loading (built-in pack first; `.dsh/contracts/` may wait for M3), the admission
  handler, telemetry; built-ins `json-schema-shape`, `bash-exit-status`,
  `fs-read-missing-file`.
  **Verify**: under a mock pipeline (following the `ctx.waterfall` direct-drive
  approach of `packages/core/tools/tests/invariant.spec.ts:54`) — in enforce, a
  bash result without an exit code is replaced by an isError whose feedback
  contains the validator id; in audit, the result passes through unchanged and
  produces one `claim-contracts/admission` ops telemetry; the handler-throws
  path is caught and never throws.
- **M2 — assistant-claim audit observer + telemetry flags + synthetic-session
  tests**: per-turn buffer, pattern library (the four above), turn/end trigger,
  flag emission.
  **Verify**: synthetic session A (the assistant claims "tests pass" but the
  turn has no bash tool/call) → yields an `unsupported` flag, with
  `evidence.eventSeqs` empty and `claim.sourceSeq` pointing at that
  assistant/message; synthetic session B (claimed content hits no pattern) →
  zero flags; synthetic session C (insufficient evidence surface) →
  `unverifiable`, not counted as a violation.
- **M3 — mode config resolution + contract pack example + docs**: the
  off/audit/enforce three-level override chain, `.dsh/contracts/*.yml` loading
  and schema validation, README (including a "graduation criteria" section).
  **Verify**: with global `off`, all M1/M2 behavior is silent; with a single
  validator raised to `enforce` while the global stays at `audit`, only that
  validator produces blocks; an invalid contract file is refused at load with
  the offending line number reported. (Steer-back is not in M1–M3; per the
  gating above it is filed as a separate item.)

Every M merges independently: M1 only adds the admission surface, M2 only adds
the observation surface, M3 only adds the config surface; none renames an
existing API.

## Verification plan

- **Layer 1 (pure functions)**: each validator's input/output over a table of
  constructed `ToolExecutionResult`s; unit test of the mode-resolution matrix;
  contract schema validation (including bad YAML / missing fields).
- **Layer 2 (mock-pipeline integration)**: build ctx + waterfall per the
  `invariant.spec.ts` pattern; assert the three branches accept/block/telemetry;
  fail-open (a validator's own exception) as a separate case.
- **Layer 3 (synthetic sessions)**: construct a `SessionEvent` stream and feed it
  to the observer (the same consumption posture as upstream
  `runtime-context.ts:46`); assert the flag set. fs assertions use a temp
  directory.
- **Layer 4 (live-run observation)**: run ≥ a number of sessions under a real
  profile with global `audit`; manually spot-check whether the rejections in ops
  telemetry are false interceptions (accumulating the telemetry evidence for the
  graduation criteria).
- Gate command: `pnpm typecheck && pnpm test` (if in a worktree, run
  `bash scripts/link-worktree-deps.sh` first; see CLAUDE.md).

## Risks and open questions

1. **doc 01 is not yet written** (`docs/design/` currently has only
   `00-overview.md`): the manifest's by-name lookup API shape is undecided.
   Mitigation: this document depends only on the contract-style agreement "look
   up contracts by tool name"; if doc 01 is delayed, M1 can land with
   `.dsh/contracts/` + the built-in pack alone, keeping the integration point a
   single function (`resolveValidators(toolName)`) and swapping the
   implementation later. Check item: verify the lookup signature at doc 01
   review.
2. **The acquisition path of the telemetry emission handle is only partially
   verified**: the waterfall signature (:43) and sink `emit()` (:104) are
   verified, but the service registration name by which the plugin obtains the
   coordinator/emit entry at runtime is not. Check item:
   `grep -rn "session-telemetry" packages/*/src --include="*.ts"` to find the
   coordinator's service registration and how existing ops record producers
   (e.g. the feedback package) wire in.
3. **Custom session event types are not open yet**: the header comment of
   `known-event-types.ts` states plainly "downstream plugin events … a
   registration surface is deferred". Therefore v1 flags only travel telemetry
   ops and never land in the session log; if doc 12's eval export needs
   persistent flags, reassess then (check item: whether an event registration
   surface appears upstream).
4. **False positives in claim extraction**: pattern hits over free text
   (especially mixed Chinese-English) may misidentify claims. Mitigation: keep
   the pattern library conservative (match only definite assertion sentence
   forms); produce `supported` only when positive evidence exists; count the
   coverage rate and the violation rate separately. Check item: manual
   spot-check of the false-positive rate in M2 layer 4.
5. **Cost of fs checks at turn end**: limited to the minimal stat set the
   patterns need; recursive traversal forbidden. If measured slowness, degrade
   to "no event evidence ⇒ unverifiable" (check item: perf budget to be
   determined).
6. **Misuse risk of block semantics**: a contract-failure block is
   recovery-friendly (the feedback becomes the next turn's input), but a
   validator's own bug going down the wrong branch would cause repeated
   rejections. The design already keeps them separate (fail-open + warn); M1's
   verification criteria include this path.

---

*Verified seams (all path:line citations re-read in 2026-08)*: `packages/core/tools/src/index.ts`
:175 / :556-600 / :1742-1781; `packages/core/tools/tests/tools.spec.ts:856-872`;
`packages/core/session/src/index.ts:76`; `packages/core/session/src/types.ts`
:155-177 / :243-297 / :415-447; `packages/session/session-telemetry/src/index.ts`
:43 / :64- / :104; `packages/core/agent-loop/src/agent.ts:296`;
`packages/core/agent-loop/src/runtime-context.ts:46`;
`packages/skill/skill-filesystem/src/index.ts:246`.
