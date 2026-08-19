# 29 memory-guardian — shared-memory governance (Tier 3; gated on real multi-person use)

> Status: design (parked; only M0 threat model/fixtures may proceed) | Tier: 3 | Package: packages/memory/memory-guardian | Depends on: 25 (record envelope v1/provenance), 26 (gate/scan); boundaries: 13 (scoping), 09 (egress)
>
> Verified seams against deepseek-harness **0.1.0-rc.7** (@99f6f02fec); path:line citations refer to that tree.

## Design goal and user problem

**Goal**: give the team shared memory (team overlay) a governance layer — a file-level TOCTOU fix, cross-type contamination detection (provenance density + type tags), optional signed write records; preceded by an adversarial fixture suite (poisoned topic files / type-confused facts / stale-but-plausible) that turns "shared-memory failure modes" into an injectable, measurable problem.
**User problem**: the team overlay today is a read-only layering, single-tenant, with a documented TOCTOU and **no write protocol** — a poisoned or stale topic file gets absorbed verbatim into every teammate's context; a project fact read as a user preference (type confusion) has no detection whatsoever; who wrote what, when, and on what basis — there is no way to trace accountability.

## Explicit build gate (stated up front)

**This item does not start being built until a real multi-person team-overlay deployment exists**
(M0 threat model/fixtures excepted). In a single-user scenario the governance value ≈ 0: the only
writer is the user themselves, the attack surface for poisoning and confusion does not exist, and
TOCTOU degenerates into "overwriting yourself". The gate's criterion is a fact, not a date: the
team overlay shows ≥2 independent writers, and the write path goes through dsh-family plugins
(not manual editing).

## Motivation (threat-model evidence, not expected ROI)

All of the following are lab numbers from papers/benchmarks, presented as existence evidence for
the threat model; **they are not a deployment-benefit expectation**:

- **MemPoison** (threat model): poisoning attacks against agent memory reach an ASR of 0.95 —
  once shared memory is writable without validation, exploitation is nearly certain; this is
  evidence for "why governance is needed", not "95% risk after deployment".
- **MemGate**: after adding boundaries/filtering, leakage drops 27% → 3.5% — directional
  evidence: read-side boundaries work; also a lab number.
- **MemGuard** (2605.28009): type-isolated storage + cross-type contamination detection; its
  89.53% anti-hallucination number is **that paper's own lab result**; this doc borrows only its
  structure (per-type storage + cross-type contamination detection), not that number as an
  expectation.
- **SafeHarbor** (2605.05704): query-conditioned boundary rebuilding — dynamically redraw memory
  boundaries per current query; note its rule-base construction cost; this doc does not adopt
  query-time rebuilding, only a light consistency check at read time.
- **MutMem**: signed change records — concept source for the M3 optional appendix only.
- **RBI-Eval**: the current-turn warrant concept — "why does this turn get to read this memory";
  it shapes the wording of the M2 read-time policy.

## Current state and gaps

Already available:

- The cc-plugins `memory` team overlay: read-only layering, single-tenant, documented TOCTOU;
  **no write protocol** — this is the premise of this item's existence and its largest gap.
- 25's record envelope v1 (provenance: who/when/which session wrote).
- 26's Track A gate (post-write demotion + read scan) — the existing gate on memory writes; this
  item sits downstream of it.
- 11's fault-injection track and 12's eval rail — the carriers for fixtures.
- 13 decides what subagents/agents **see**; 09 audits what **leaves** (egress payload).

Gaps:

- No protocol and no concurrency control on the write path (TOCTOU is a documented known issue).
- No cross-type contamination detection: no signal at all for misreads across memdir type tags
  (user preference / project fact / …).
- No adversarial fixtures: shared-memory failure modes have no reproducible test assets today.

## Scope decomposition (boundary with 13/09)

This item sits strictly between 13 and 09: **13 governs "who can see what" (per-agent-kind
scoping), 09 governs "what can leave" (egress payload audit), and this item governs "what gets
written into / shared into memory, and whether types cross-contaminate"**. It does not redo 13's
per-agent-kind scoping and does not redo 09's egress audit — both are referenced as cross-refs;
this doc does not repeat their seams and design.

## Design

### Surfaces and seams (verified + cited)

Upstream seams (this item directly depends only on configuration and telemetry; the write path is
on the incubation side):

| Seam | Verified surface | Source |
|---|---|---|
| Settings namespace | `settingsNamespace` + `installSettingsSection` (registration is exposure; hot reload; runtime read via `ctx.settings.describe()`) | `$DSH/packages/settings/settings/src/index.ts:863` |
| Telemetry channel | custom session event types are closed (unknown types rejected by the persistence layer); plugin events go through the `session-telemetry/record` operational channel | `$DSH/packages/session/session-persistence-jsonl/src/format.ts:244` |
| timer (if used for sweeps) | `ctx.interval` effect-scoped auto-cleanup — unusable for unattended persistent patrols | `$DSH/vendor/timer/src/index.ts:4-15` |
| Turn boundary | `agent/turn-stopping` serial; listeners never throw (throw → error turn) | `$DSH/packages/core/agent/src/runtime-types.ts:272-278`, `$DSH/packages/core/agent-loop/src/agent.ts:304-315` |

Incubation-side seams (authoritative as each doc's landed APIs; referenced here, not restated):
25's record envelope v1 provenance fields; 26 Track A's post-write demotion + read scan; 11's
fault-injection track; 12's eval rail.

### M0 — threat model + adversarial fixture suite

Three fixture classes, run on 11's fault-injection track and 12's rail:

1. **poisoned topic file**: entries mixed into the overlay that are semantically plausible but
   factually wrong (wrong API signatures, outdated internal conventions); measure the rate at
   which downstream tasks get led astray.
2. **type-confused fact**: a project fact written into a user-preference type slot (and the
   reverse); measure whether type cross-contamination changes agent behavior (MemGuard's
   cross-type contamination-detection structure).
3. **stale-but-plausible**: entries that were once correct and are now wrong — specifically to
   separate "a poisoning problem" from "a mere staleness problem" (this feeds the falsification
   line directly).

Fixtures only produce distribution data; no detector is built in M0.

### M1 — file-level TOCTOU fix for the overlay

- Write path: all incubation-side writers converge into a single writer module doing **atomic
  swap** (tmp + rename) or file locking; no plugin may bypass the writer and write overlay files
  directly.
- **Honest boundary**: readers in other sessions cannot be coordinated — a file lock constrains
  dsh-family writers only, not manual edits or external processes. Hence the accompanying
  **read-time versioned consistency check**: on read, verify the envelope's version/monotonic
  sequence number (RBI-Eval's current-turn warrant phrasing: on what basis is the copy read this
  turn trustworthy); on mismatch → drop this read's cache, re-read; still mismatched → demote to
  a "stale read" event into telemetry.
- Explicitly no distributed consensus: the overlay is a convention over a shared filesystem, not
  a database.

### M2 — cross-type contamination detector

- Inputs: memdir's **type tags** + 25's envelope **provenance density** (the dispersion of
  provenance sources within one topic file — contradictory type assertions from multiple sources
  are a contamination signal).
- Shape: a static scan (not query-time rebuilding; SafeHarbor's query-conditioned rebuilding is
  explicitly not adopted due to rule-base cost), emitting `memory.guardian.*` telemetry keys
  (the key convention belongs to doc 24; only the prefix is declared here) and per-scope
  read/write policy-hit reports.
- Relation to 26: 26 Track A governs "should this write pass the gate"; this detector governs
  "does what passed the gate cross-contaminate on the type axis" — downstream complementary, no
  duplicated scanning logic.

### M3 (optional appendix) — signed write records

The MutMem concept: the writer attaches a signature to each write record (a key convention
within one trust domain), verified at read time. **Explicitly marked future/optional**: within a
single trust domain, signatures only defend against external tampering, not against a compromised
writer; key-management cost does not hold up on a single-tenant overlay. Unless M0/M2 data shows
tampering (rather than staleness) is the dominant failure mode, this is not built.

### Configuration

Standard configuration-declaration (rc.7 onward) section (`settingsNamespace` +
`installSettingsSection`, `packages/settings/settings/src/index.ts:863`; layered resolution +
hot reload; registration is exposure):

```yaml
memory-guardian:
  scanMode: audit           # off | audit | enforce (principle 3's three tiers)
  perScopePolicies:         # per-scope read/write policies
    - scope: "team"
      read: audit
      write: enforce        # enforce = only via the M1 writer, bypass rejected
  maxProvenanceSources: 8   # type-assertion conflicts beyond this go into the report
```

## Milestone breakdown

**M0 — threat model + fixture suite (the only item allowed to proceed)**
Three fixture classes + running on the 11/12 tracks + a failure-mode distribution report
(led-astray rate / contamination rate / staleness share). Unit tests: fixture determinism (same
input, same distribution); no writer/detector needed.
**Verification**: run the baseline distribution of the three failure modes on a synthetic
overlay; the report lands on disk.

**M1 — file-level TOCTOU fix (post-gate)**
Writer convergence + atomic swap/locking + read-time versioned consistency check + stale-read
telemetry.
**Verification**: no torn reads under concurrent-write stress; a manual external file edit
triggers the "stale read" path rather than a crash.

**M2 — cross-type contamination detector**
Type tags + provenance-density scan, per-scope policies, report command.
**Verification**: a detection-rate report on M0's type-confused fixtures (numbers only, no
preset threshold).

**M3 — (optional) signed write records**: see above; not done by default.

## Risks and open questions

- R1 **The write protocol is a precondition, not this item's product**: the cc-plugins overlay
  has no write protocol — M1's "writer convergence" presumes incubation-side plugins have
  become the actual write path; if real deployments remain mostly manual edits, the writer is
  decorative; the gate criterion therefore includes "writes go through dsh-family plugins".
- R2 **Fixture measurement caliber**: the led-astray/contamination rates depend on downstream
  task judgment; whether the grading standard is stable when riding 12's rail is open.
- R3 **Authority of type tags**: if memdir type tags are written by the model, they are
  themselves an attack surface (the poisoner tags first); whether the M2 detector needs
  cross-validation against 25's envelope createdBy is open.
- R4 **Cost of the read-time consistency check**: the latency of per-read verification/re-read
  is untested at large overlay scale; if significant, degrade to sampled verification; open.
- R5 **Trust-domain boundary of signatures (M3)**: a single-key trust domain defends against the
  outside, not the inside; multi-tenant key distribution has no carrier at all — this is the
  root reason M3 stays optional.
- R6 **Relabeling duty for lab numbers**: every adversarial number in this doc (0.95,
  27→3.5%, 89.53%), when quoted in later READMEs/reports, must keep its "lab result" label and
  must not be converted into a deployment expectation.

## Boundaries and non-goals

- No per-agent-kind scoping (13's responsibility, cross-ref).
- No egress/egress-payload audit (09's responsibility, cross-ref).
- No query-time boundary rebuilding (the SafeHarbor route, rule-base cost).
- No distributed consensus / turning the overlay into a database — the filesystem-level
  convention is the premise.
- Signed write records are out of scope by default (M3 optional appendix only).
- Memory packaging and the `memory.*` telemetry-key convention belong to doc 24; this doc only
  declares the `memory.guardian.*` prefix.
- **Falsification line**: if M0 fixtures show the overlay's failure modes are dominated by mere
  staleness, with poisoning and type cross-contamination negligible, the detector scope narrows
  into 27 (memory maintenance) and the rest of this item stays parked.
