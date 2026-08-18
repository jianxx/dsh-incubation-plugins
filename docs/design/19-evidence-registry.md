# 19 evidence-registry — Cross-Session Domain Belief Registry (the single authority on fact admission for parallel workers)

> Status: design (not started) | Tier: 3 | Package: packages/science/evidence-registry | Depends on: [20 citation-verify](20-citation-verify.md) (registers claim_level 2/4 verifiers at runtime, from M2; zero compile-time dependency) | Optional integrations: 13 subagent-context-scope (M4), 15 scholar (number reserved, planned), 03 trace-contracts (tier-3 run evidence)

## Design Goals and User Problem

**Goal**: a cross-session registry of domain knowledge state — where three entry types concerning the research subject, **hypothesis, evidence, and belief_update**, are appended to an append-only hash chain; belief state may only be changed by **evidence that has passed a gate**; all writes from multiple workers are appended through a single serialization point. This is the concretization, in this plugin, of Danus's principle that "the stateless verifier is the sole authority on fact admission."

**User problem**: the most chronic failure of research-style multi-agent sessions (3–9 parallel workers reading literature and running analyses) is not some worker lying, but **contamination spreading**: worker A, on half-baked evidence, announces "hypothesis H is proven"; worker B takes that sentence as a factual premise and reasons onward; wrong conclusions cross-cite each other among workers and self-reinforce, until by the final draft no one can tell which belief is backed by evidence and which is a rumor squared. After the session ends these beliefs have nowhere to live — the next study of the same topic starts from scratch, or worse: continues from vague impressions.

## Motivation (Why Necessary — Two Papers Each Provide Half the Answer)

**HEP (Hypothesis Evolution Protocol, arXiv 2607.09195)**: upgrades hypotheses from "chat inside a session" to **continuously evolving registry artifacts** — each hypothesis carries a prior confidence P(H), a lifecycle, and a lineage; all changes go through a hash-chained append-only event log, and **only evidence that has passed the evidence gate may alter beliefs**. It contributes the morphology and the replayability: a belief is not text floating in context, but a state machine replayable to any point in time. HEP's lesson is likewise directly citable: its evidence strength is limited by agent self-scored verification and tool fidelity — in other words, once the protocol stands, **the gate tiers must be backed by a real external verifier**; the agent must not be allowed to sign its own permits.

**Danus (arXiv 2607.06447)**: a verifier-gated research workflow — the main agent plans, workers explore in parallel, and **the stateless verifier is the sole authority on fact admission**; the fact-graph remembers via proofs + dependency edges, supporting **dependency-propagating revocation** of erroneous facts; unverified dead ends and plans leave only low-trust marks in global/local memory and never enter the fact graph. It contributes the discipline of the parallel world: the more workers there are, the more you need one admission point that does not accept self-reported credentials; and revocation semantics guarantee the registry is not a one-way ramp that can only be piled up, never dismantled — when an accepted belief is refuted, downstream beliefs that depend on it can be cascade-marked along dependency pointers instead of being silently voided.

The two papers together are the skeleton of this design: **HEP's registry morphology (hash-chain append-only + gate-passed evidence changes beliefs) × Danus's parallel governance (single authority + proof/dependency supporting revocation)**. The registry is not yet another markdown note; it is the single authoritative answer to "which belief stands right now" in a parallel-agent research flow.

## Current State and Gaps

Current state of dsh (each item verified, see "Surfaces and Seams"):

- **Append-only precedent**: `session-persistence-jsonl` is the engineering precedent for "files only grow, no delete API" (doc 12 verified its layout); its publication uses the `link()+unlink()` no-clobber protocol (`:544-549`) — the single-writer assumption is deeply embedded in the upstream storage infrastructure.
- **The KV layer does not serialize for you**: the `KvUnit` header comment in `storage` states explicitly "**does NOT serialize concurrent writes — write ordering is the caller's responsibility**" (`backend.ts:59-60`); to get serialization, either go through `storage-domain`'s single-writer chain (whose `update()` promises "concurrent updates never interleave", `domain.ts:83-84`), or build your own in-process queue + file lock.
- **Shared observation and tool-registration surfaces are all in place**: `ctx.tools.register` (mandatory output schema), the `session-telemetry/record` ops channel, `session/event` subscription — doc 02 has pinned the line numbers for all.

Gaps: (a) there is no cross-session **domain-semantic state** store — memory/CLAUDE.md is free text, with no structure, no gating, no revocation; (b) there is no hard constraint primitive enforcing "beliefs may only be changed by gate-passed evidence"; (c) when parallel workers write shared knowledge, no serialization discipline protects them (this is especially bare in dsh's session/subagent semantics: each subagent lives in its own session).

## Boundary with 02 claim-contracts (a Dedicated Section)

This section is the load-bearing wall of this document; read [02 claim-contracts](02-claim-contracts.md) first, then this section.

- **02 governs turn-level honesty**: at every `turn/end` it audits "the assistant's natural-language self-report" with a three-state verdict of supported / unsupported / unverifiable, the criterion being **reconciliation of this session's tool events** (`tool/call` ↔ `tool/result` pairing + read-only fs assertions). It answers: "does the sentence the agent just said match the calls that actually happened in this turn?" Judgment domain = in-session events; time granularity = turn.
- **19 governs cross-session domain semantics**: the hypothesis/evidence/belief state machine of the research subject, the criterion being **gate-passed evidence entries carrying a gate_ref**. It answers: "regarding this research subject, what is each belief's confidence right now, and by which gate-passed evidence was it updated?" Judgment domain = the external world; time granularity = cross-session long-term.
- **Intersection (one-way)**: 19's belief_update may take a turn-level claim already audited as supported by 02 as an **evidence lead** (the evidence entry's `source` points to the event seq range of that turn), then the verifier of the corresponding tier decides whether to accept it. 19 never asks back into turn-level honesty — whether a worker lied within a turn is 02's business; 19 only guarantees that "even if a lie is not caught by 02, it cannot enter the belief layer," because a belief_update without a gate_ref is rejected at the registry.
- **Tier meanings differ — do not conflate**: 02's `off / audit / enforce` is the gate enforcement strength; 19's `claim_level 1–5` is the **evidence-strength tier required by a claim**. The latter is satisfied by 02-style leg-shaped verifiers; both share overview principle 3's three-position knob, but their semantics are orthogonal.

## Design

### Surfaces and Seams (exact names + verified paths)

Every item below has been verified against the upstream dsh source; sibling items (15/17) that have not landed appear only in open questions.

1. **Tool-registration seam — `ctx.tools.register(definition)`**
   `deepseek-harness/packages/core/tools/src/index.ts:1037` (returns a dispose function;
   mandates `output: {schema, render, presentationMeta?}`, throwing immediately otherwise `:1039-1042`).
   The four tools registry_propose_hypothesis / registry_add_evidence / registry_belief_update /
   registry_query are all registered by this plugin; **this is the sole write entry point** (see the single-writer section of the behavior flows).
2. **Storage coordinate — `.science/registry.ndjson` (project root)**
   The project-level `.dsh/` directory convention is in doc 02, seam item 7
   (`packages/skill/skill-filesystem/src/index.ts:246`). The registry is a **data artifact**, not
   configuration, so it lives separately under `.science/` (sharing the root with
   `.science/cite-checks/` from [20 citation-verify](20-citation-verify.md), making it easy for
   external tooling to freeze/archive the whole tree).
   The append protocol is self-built (see behavior flows); dsh's `storage-json` does not fit: it is a whole-file snapshot
   (`atomic.ts`'s writeAtomic, `:1-12` header "write a same-directory temp file, fsync
   it, then rename"), per-unit single-writer and last-write-wins — it cannot express "concurrent appends with a global order."
   `storage-domain`'s single-writer chain (the atomic RMW semantics of `domain.ts:83-84`) can serve as the candidate
   implementation for a later backend-ification (open question 2).
3. **Telemetry seam — `session-telemetry/record` waterfall**
   `deepseek-harness/packages/session/session-telemetry/src/index.ts:43`,
   record structure at `:55-` (`channel`, `severity`, `attributes`, `body`), sink `emit()`
   performs non-blocking enqueue (:104); the coordinator tolerates listeners that throw (fail-closed,
   `coordinator.ts:205-216`). This plugin's op vocabulary is in the data-model section.
4. **Event-subscription seam (optional observation surface) — `session/event`**
   `deepseek-harness/packages/core/session/src/index.ts:76`, post-commit
   fire-and-forget, event envelopes carry a monotonic `seq` (types at
   `packages/core/session/src/types.ts:415-447`, verified by doc 02).
   M4 uses it to bind registry_query digests into subagent context (with turn boundaries as injection points).
5. **13 handoff seam (reader side)**: [13-subagent-context-scope](13-subagent-context-scope.md)
   has verified `ctx.subagents.registerProvider` (index.ts:369-385) and that
   `SubagentStartRequest.prompt` is replaceable in whole (types.ts:100-149); scoped-section masking
   is established (core/system-prompt/src/index.ts:373-389). 19 registers no provider; it only exports
   the `registry_query` tool and a digest constructor; **the consumer that injects the digest into the
   subagent prompt is 13's scoped provider or any delegation initiator** — 19 gives the answer, 13 gives the injection port.

### Data Model / Configuration

**Three entry kinds + tombstone**, one JSON object per line, appended at the tail after canonical serialization:

```ts
type RegistryEntry = {
  seq: number;                    // global monotonic order, assigned at append time
  prev: string;                   // sha256 of the previous entry,'GENESIS' at chain head
  kind: 'hypothesis' | 'evidence' | 'belief_update' | 'tombstone'
  id: string;                     // content-addressed sha256 of this entry (canonical(entry minus id))
  at: string;                     // ISO8601
  agent?: string;                 // writer identity, for audit; not a security boundary
  payload: HypothesisP | EvidenceP | BeliefUpdateP | TombstoneP
}

type HypothesisP = {
  text: string
  confidence0: number             // prior, 0..1
  claim_level: 1|2|3|4|5          // claim strength, determines the required verifier tier
  tags: string[]
}

type EvidenceP = {
  hypothesis: string              // points to hypothesis.id
  source: { kind: 'cite', ref: string }                // cite://<check_id>(doc 20)
        | { kind: 'run', ref: string }                 // trace://<run_id>(17/doc 03 family)
        | { kind: 'evidence_id', ref: string }         // 15's stable ID
        | { kind: 'session-seq', span: [number, number] } // event range of this session (a 02-audited lead)
  gate_ref?: string               // pointer to the verifier verdict, e.g. cite://<check_id>
  gate_tier: 1|2|3|4|5            // the tier this evidence actually passed (self-reported by the object gate_ref resolves to)
  summary: string
}

type BeliefUpdateP = {
  hypothesis_raw: string          // hypothesis.id
  direction: 'support' | 'weaken' | 'abstain'
  new_confidence: number
  via_evidence: string[]          // list of evidence.id; **every one must meet its gate tier**
  rationale: string
}

type TombstoneP = {
  target: string                  // id of the revoked entry (usually revoking evidence or hypothesis)
  reason: string
  by: 'author' | 'cascade'        // cascade = dependency propagation (Danus revocation semantics)
}
```

**claim_level → required verifier tier mapping table** (configurable, defaults):

| claim_level | Semantics | Default required gate_tier | Off-the-shelf implementation hook |
|---|---|---|---|
| 1 Edge observation | Self-reported note suffices | 1 (no gate) | None (append directly) |
| 2 Rule-level claim | Mechanically decidable | 2 | [20](20-citation-verify.md) V1 mechanical gate |
| 3 Execution-level claim | Ran and rechecked | 3 | 03 trace-gate result / 17 run pointer |
| 4 Domain-level claim | Semantic substantive check | 4 | [20](20-citation-verify.md) V1+V2 |
| 5 Formal claim | Formal verification | 5 | (reserved, no implementation yet) |

Every evidence in `belief_update.via_evidence` must have `gate_tier >= the tier required by its
hypothesis's claim_level`; otherwise the whole update is rejected (see behavior flows). The mapping table lives in config:

```ts
{
  registry: {
    path: '.science/registry.ndjson'  // relative to project root
    tierRequirement: Record<1|2|3|4|5, { minGateTier: 1|2|3|4|5 }>
    // verifier URI scheme registration: see "gate validation" in behavior flows; 20 provides cite://, the 03 family trace://
  },
  telemetry: { ops: true }            // overview principle 3's audit/enforce acts only on
                                      // gate strength (see below); it does not change observation duties
}
```

**Telemetry vocabulary** (ops channel; provenance includes the plugin name, per doc 00 principle "observation carries attribution"):

| op | Trigger point | attributes |
|---|---|---|
| `evidence-registry/append` | Every successful append | `kind`, `seq`, `agent` |
| `evidence-registry/gate-reject` | Gate validation rejects a belief_update | `hypothesis`, `claim_level`, `missing_tier` |
| `evidence-registry/write-conflict` | The serialization point detects an ordering conflict | `expected_seq`, `got_seq` |

**The gate_ref contract with 20**: URI shape `<scheme>://<id>`. `cite://<check_id>` resolves to
`.science/cite-checks/<check_id>.json` (artifact format in
[20's doc](20-citation-verify.md)); self-reported tier = declared per the `claim_level` table (20 takes on
2 = V1 only, 4 = V1+V2). `trace://<run_id>` is reserved for the 03/17 family. Unregistered scheme = resolution failure.

### Key Behavior Flows

**Single-writer discipline (the concretization of Danus's single authority)**: all append paths of the four tools converge on a single
in-module `append(entry)` function — (a) in-process: serialized by a Promise queue, `seq` assignment and `prev` chain computation
happen inside the critical section; (b) cross-process: the `.science/registry.lock` advisory lock (the lockfile implementation is an implementation choice;
`storage-json`'s header note (:1-12), the "one writer per process" precedent, shows dsh already pushes multi-writer discipline
to the caller, and this plugin follows that contract). **This contract sentence is not implementation-specific**: appends are atomic and globally ordered.
Any write that bypasses this function is a bug; the tools live by the rule "never throw out of the handler"
(doc 02 seam 2, same lesson: a listener exception gets caught by the framework and turned into isError, losing actionable feedback).

**Write flows (per kind)**:

- `registry_propose_hypothesis(text, confidence0, claim_level, tags)`: no gate; appends the
  hypothesis entry directly; telemetry `append`. claim_level is frozen once written (strength is part of the claim;
  raising or lowering the tier equals a new hypothesis).
- `registry_add_evidence(hypothesis, source, gate_ref?, gate_tier, summary)`: validates that the
  `hypothesis` pointer is resolvable (exists and not tombstoned); if gate_ref is non-empty, verify immediately:
  scheme is registered → resolve the check object → its self-reported tier matches the `gate_tier` field
  (mismatch = reject; the "self-reported tier" must agree with the artifact content, preventing tier usurpation). Append the evidence entry.
- `registry_belief_update(hypothesis, direction, new_confidence, via_evidence, rationale)`:
  **this is the only tool with teeth**. Validates each via_evidence: (i) the pointer resolves; (ii) not tombstoned;
  (iii) its gate_tier ≥ the tier required by that hypothesis's claim_level (mapping-table config).
  Any failure rejects the whole update, returning text listing the reasons (actionable feedback, a cost hint in the
  spirit of EG-VAR abstain) and emitting telemetry `gate-reject`; only if all pass is the belief_update appended. The `abstain`
  direction has a **special exemption**: declining to judge is also a judgment (EG-VAR semantics in 02's motivation section) — via_evidence may be empty,
  but rationale is mandatory with the missing-link description.
- `registry_query(filter?)`: the current belief graph — walks the chain, applies tombstone revocations
  (Danus dependency propagation: evidence revoked → belief_updates referencing it get cascade-marked with `cascade`
  tombstones; the hypothesis's effective confidence falls back to the last value still backed by evidence),
  and outputs a current-state view grouped by hypothesis. **Queries are lazy**: the chain is the truth; a query is a projection.

**Revocation flow (tombstone)**: `registry_tombstone(target, reason)` is itself only an entry append
(on the tool surface it is folded into the internal entry points of registry_append; the model gets a
fourth-plus-one tool `registry_tombstone` in addition to `registry_belief_update`); **no history deletion, no rewriting**. Queries digest it at the projection layer.
This corresponds exactly to Danus's fact-graph revocation and HEP's hash-chain append-only: history never changes; the present can be revoked.

**M4 injection flow (query → subagent context)**: the delegation initiator (13's scoped provider or calling code),
before start, calls `registry_query({compressed: true, maxItems: N})` to get a digest and splices it into
a scoped section of the subagent prompt (13 has proven section masking works, see seam 5).
**Consistency stance**: within the same session, a registry's version is monotonic — parent and child share the file; the digest carries
`asOfSeq`, which the subagent uses as its read-your-writes baseline when writing back (open question 4 discusses concurrent drift).

## Milestone Breakdown (each M = one PR granularity + "Verify:")

- **M1 — ndjson + hash chain + three tools + write discipline**: `pnpm new:plugin science
  evidence-registry` skeleton; entry schema and canonical serialization; the `append()` serialization point
  (in-process queue + lockfile); the three tools hypothesis/evidence/belief_update
  (belief_update only validates pointer resolvability; gate validation deferred to M2); registry_query (with tombstone
  projection); telemetry `append` op.
  **Verify**: drive = vitest unit tests + directly constructed entry sequences; observable result = 50 concurrent
  `append` calls serialize into a valid chain (each `prev` link verifiable, seq contiguous, no byte interleaving),
  and after a tombstone, query rolls out a fallen-back confidence; pass condition = `pnpm typecheck &&
  pnpm test` all green, including the hash-chain verifier tested standalone as a pure function.
- **M2 — gate_ref validation (format only) + verifier registry**: the scheme registry
  (`cite://` handled by [20](20-citation-verify.md)'s artifact parser, with a minimal
  JSON read embedded in this plugin; `trace://` left as an extension point); tier-mapping config; all three
  gate validations of belief_update; the `gate-reject` op.
  **Verify**: drive = unit tests with constructed cite-artifact fixtures (four states: valid / missing file / insufficient tier /
  self-reported tier mismatch with artifact); observable result = belief_update accept/reject plus
  per-field assertions on `gate-reject` attributes; pass condition = all four states covered and
  rejection text contains repair guidance.
- **M3 — single-writer concurrency hardening + conflict tests**: pin down cross-process lockfile semantics (lock-acquisition failure
  fails fast rather than pretending to queue); crash recovery (truncated-tail detection: a line that fails JSON parsing at the tail immediately throws
  `corrupt-tail`, never silently skipped); the `write-conflict` op; a hash-chain replay-verification tool
  (bin script, for manual audit).
  **Verify**: drive = vitest spawning N=8 processes concurrently appending to the same registry + injecting kill -9 mid
  -write; observable result = chains of all successful appends are intact; a killed process leaves at most one corrupt-tail
  and the next open fails loud; pass condition = the chain verifier replays the artifacts successfully and exception paths are tested.
- **M4 — query digest → subagent context injection sample**: the digest constructor (the `compressed`
  mode: one line per hypothesis + confidence + `asOfSeq`); a sample delegation script (wrapped with 13's
  scoped provider, injecting the digest into the subagent prompt); telemetry unchanged.
  **Verify**: drive = scripted session (`dsh --profile headless` + llm-mock, following the driving posture in
  [12](12-eval-harness.md)'s seam table) starting a parent-child pair, with the parent writing two beliefs
  before delegating; observable result = the subagent system/user prompt contains the digest text and
  `asOfSeq` matches the seq after the parent's writes; pass condition = all assertions pass; if 13 has not landed, degrade to
  the manual sample "directly splice a prompt prefix" (the sample script passes the same assertions).

## Verification Plan

- **Layer 1 (pure functions)**: canonical serialization stability, the hash-chain verifier, tombstone projection
  (revocation / cascade revocation / revoking the already-revoked), tier-mapping decisions, gate_ref resolution.
- **Layer 2 (unit tests)**: each of the four tools' main paths + all rejection paths; telemetry op names and attributes.
- **Layer 3 (concurrency/crash)**: in-process Promise queue stress test; cross-process lockfile concurrency;
  corrupt-tail recovery.
- **Layer 4 (scripted session)**: the hallucination-injection drill with headless + llm-mock (DoD 4) and the M4
  injection chain.
- Gate command: `pnpm typecheck && pnpm test` (inside a worktree, run
  `bash scripts/link-worktree-deps.sh` first, see CLAUDE.md).

## Risks and Open Questions

1. **Lockfile implementation choice undecided** (proper-lockfile vs. self-managed fd with `O_EXCL`): an implementation matter;
   the contract is already pinned as "appends atomic, globally ordered." Check item: decide the choice at M1 review and write down the failure modes
   (stale lock, NFS), and add crash-recovery tests.
2. **Possible backend-ification**: `storage-domain`'s single-writer chain (the RMW semantics of `domain.ts:83-84`)
   and the `domain/changed` event (events.ts:46) naturally match the registry's append+broadcast needs;
   v1 chose self-built ndjson because append-only byte order is friendlier to manual audit / external freezing
   (`storage-json` is a whole-file snapshot; a rewrite loses ordering). Open question: after M3, whether to
   offer an optional `storage-domain` backend (entry = record, key = seq). No backward contortions.
3. **15/17 not landed**: the two pointer kinds `source.kind = 'evidence_id' / 'run'` can only keep the schema and the
   degraded "resolution failure = reject" path until the sibling items land; joint testing to be supplemented at a chosen time after M4 (same deferral clause as doc 20's M4).
4. **Concurrent research-session drift on the same registry**: the digest's `asOfSeq` only guarantees the subagent **read**
   a consistent moment; when parallel parent sessions write concurrently, a belief_update cast back by the subagent may reference
   evidence already revoked. Mitigation: M3's write-conflict telemetry + query snapshot-consistency documentation; true
   read-your-writes transactions are beyond v1. Check item: the M4 sample records one drift-scenario observation.
5. **gate_ref is a point-in-time snapshot, not a lifetime warranty** (the dual of doc 20 risk 5): cite artifacts are
   content-addressed, template versions enter the hash — re-judging the same claim produces a new check_id, and old references still point to
   old artifacts. Registry beliefs therefore "expire without knowing it." Mitigation: query projection may re-run the
   verifier on demand (optional parameter), but v1 does not auto-re-verify (cost and reproducibility, see doc 20 risk 1).
6. **Tombstone permissions**: in v1 any writer may revoke any entry (default trust within a research team;
   audit relies on the chain itself); if registries ever span trust domains, a permission surface is needed here, to be reviewed separately at that time.

## Per-Unit Acceptance (Definition of Done)

- [ ] [auto] Belief_updates with fabricated evidence are rejected: gate_ref missing, target artifact nonexistent,
  or its self-reported tier below the tier required by claim_level — assert `gate-reject` op and rejection text
  for at least one injected case of each of the three (M2).
- [ ] [auto] 50 concurrent appends with no interleaving corruption: the chain verifier replays the artifact, checking each `prev` link,
  contiguous seq, and intact JSON lines; the global order is replayable (M1/M3).
- [ ] [auto] After tombstone revocation, query contains no revoked beliefs: both direct and cascade paths
  (revoke evidence → referencing belief_updates cascade-marked; the hypothesis's
  confidence falls back to the last value supportable by the remaining evidence) (M1).
- [ ] [auto] Hallucination-injection drill: a scripted session (headless + llm-mock, via the driving posture of
  [12](12-eval-harness.md)) induces the agent to directly assert "hypothesis H is proven" in prose without calling tools;
  assert that in `registry_query` the hypothesis belief is unchanged, and that no corresponding `append` op
  exists in the session (M4).
- [ ] [auto] Telemetry-vocabulary contract: exact attribute assertions for the three ops (mock sink);
  sink `emit()` is non-blocking.
- [ ] [joint] End-to-end with [20 citation-verify](20-citation-verify.md):
  a real `cite://` artifact driving the belief_update accept path (DoD counterpart to 20's M4).
- [ ] [manual] One manual re-check of M3 crash recovery with a real process kill (not just mocks);
  README graduation criteria ready.
