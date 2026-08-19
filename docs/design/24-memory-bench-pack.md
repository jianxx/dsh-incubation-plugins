# 24 memory-bench-pack — memory evaluation pack (milestone-family extension of 12; entry gate of the memory wave)

> Status: design (not started) | Tier: 3 (bench pack, belongs to 12's milestone-family extension, no standalone package) | Depends on: 12 (eval-harness, hard dependency — rail / three credit gates / sealed discipline all reused) | Wave: **entry gate** of the memory wave (25–29) — no memory plugin may propose graduation before reporting baseline numbers on this pack
> Anchors: StratMem-Bench (2604.26243) / Stored Evidence & Pass@B-P90R (2605.07313) / Veracium (2607.21962) / MemLeak / Setoka / PM-Bench (2607.12385) / Memory Characterization (2606.06448)
> Verified seams against deepseek-harness **0.1.0-rc.7** (@99f6f02fec); path:line citations refer to that tree.

## Design goal and user problem

**Goal**: bolt a four-metric-family task pack onto 12's evaluation rail, splitting "memory" from a single
improvement number into three independently falsifiable levels — **was it stored (availability) → was it recalled (recall) → was it used correctly (use)** —
plus three axes: aging, deletion leakage, and scale conditioning; and define here the
`memory.*` telemetry key convention shared by the whole memory wave (25–29); later documents only reference it, never re-invent it.
**User problem**: today nothing distinguishes "memory was written to a file" from "it was actually
brought back to mind and used correctly next time". A memory plugin can claim "improved memory",
but without a baseline and without tiered counters that claim
is unfalsifiable; worse, fresh-fixture evaluation (one clean-environment run) systematically overestimates
memory systems — Veracium's tenure-crossover shows curated-memory degrades over long usage horizons,
which a fresh fixture precisely fails to measure. This pack is that gate: **memory plugins get weighed first, graduation talk comes after**.

## Motivation

- **Survey thesis (C.1 #1, highest severity)**: existing harness memory evaluations almost all treat
  "stored" as "used" — writing into the memdir counts as success. StrMem-Bench splits evaluation into
  storage, retrieval, and utilization segments scored separately — the direct origin of this pack's first metric family.
- **Veracium (2607.21962)**: tenure-crossover — curated-memory systems (manually / semi-automatically
  maintained clean indexes) are overtaken by provenance-rich systems (carrying sources, traceable
  back to original text) on usage horizons of ~9 weeks; fresh-fixture short-horizon evaluation yields the
  **opposite** conclusion from long-term use.
  Honesty note: its 96→72% vs 90% comparison numbers come from a **single-platform user study** —
  no cross-platform extrapolation, used only as motivation that "aging must be measured".
- **Stored Evidence / Pass@B-P90R (2605.07313)**: a correct answer is not correct evidence —
  memory-system evaluation must report "which memory entry was cited, and whether that entry actually
  supports the conclusion", and report P90 latency/cost degradation (P90R) as the memory grows,
  not just mean pass@k.
- **MemLeak**: deletion leakage — memory facts the user deleted must never resurface in any form
  (direct injection, index residue, consolidation paraphrase). This is a privacy/compliance hard gate,
  yet almost no harness evaluation covers it;
  this pack turns it into a deterministic probe.
- **Setoka**: answer-rate ≠ accuracy — "the model answered" is not "the model answered correctly";
  a memory-evaluation grader must distinguish refusal / wrong answer / hallucination off stale memory; this pack's grader vocabulary follows that three-way split.
- **PM-Bench (2607.12385)**: prospective scoring — one should not only test "does it remember the past"
  but also "does it remember what is to be done (intentions)". This pack's M3 reserves an intent-set slot;
  the formal consumer is doc 28 (prospective memory); only tasks and keys land here.
- **Memory Characterization (2606.06448)**: memory construction cost and freshness are first-class
  metrics — construction-side energy can exceed total query-side energy within a few hundred queries. This pack requires
  every evaluated plugin to also report `memory.construct.tokens`, putting "the cost of building the index" into the same table.

**One sentence**: 12 settles "whether harness changes are trustworthy", 24 settles "whether memory changes are trustworthy" —
same rail, four new metric families, one shared set of keys.

## Current state and gaps

Verified:

- 12's full rail is on record: the budget-match invariant, the three GSME credit gates (validity /
  activation / significance), the train/heldout/sealed split, the `bench/` directory layout
  (`bench/trials|tasks|variants|archive|sealed-results`, see 12 §data model).
  This pack **rebuilds none of it**, only adding task families and graders.
- Current memory stack: dsh-cc-plugins `memory` (memdir = `MEMORY.md` index, ≤200 lines/25KB,
  topic files with `name/description/type` frontmatter, type ∈ user/feedback/project/
  reference; recall = per-turn fork of a small model to query the frontmatter side then `agent.inject()`,
  already-shown file dedup demonstrated — `packages/memory/memory/README.md:14-17/:53-55`) +
  `memory-consolidation` (turn-stopping → extraction → gated dream rewrite:
  24h + ≥5 new sessions + stale lock, three gates). This is the **baseline variant**, not a replacement target.
- System-prompt injection seam: cc-plugins memory's section goes through
  `ctx.systemPrompt.section({name, order, text})`
  (`packages/core/system-prompt/src/index.ts:375-392`) — the evaluated plugin's injection surface
  goes entirely through existing sections; the evaluation needs no new seam.
- Telemetry seam: all counters go through the ops channel
  (`packages/session/session-telemetry/src/index.ts:64-86`,
  record = `{channel:'ops', time, severity, attributes, body}`); custom session
  event types are closed to downstream plugins (`packages/core/session/src/known-event-types.ts:7-15`
  header comment: out-of-repo plugin events are by construction not in the table; the read path has an `ignorable` guard,
  `packages/core/session/src/types.ts:422`) → **this pack adds no session event types whatsoever**;
  all metrics go through the ops channel (same conclusion as docs 02/04/05/07).

Three gaps: (1) no tasks and graders that count availability/recall/use separately;
(2) no aging (time × traffic) axis — 12's trials are all fresh fixtures; (3) no deletion-leakage
probe and no scale-conditioned reporting (Pass@B/P90R). (4) No unified `memory.*` key convention across 25–29.

## Design

### Surfaces and seams (verified + cited)

| Seam | Use | Citation |
|---|---|---|
| 12's runner/score/credit gates/sealed | All reused; this pack only lands the `bench/tasks/mem-*` task families + new graders + counter hooks | 12 §design |
| ops telemetry channel | All `memory.*` counters come out here; use after a `ctx.get('sessionTelemetry')` null check | `packages/session/session-telemetry/src/index.ts:64-86`; precedents `packages/session/session-telemetry/src/index.ts:43/:104` |
| System-prompt section (evaluated surface) | The evaluated memory plugin's injection entry; the evaluation only reads the assembled result, does not modify the seam | `packages/core/system-prompt/src/index.ts:375-392` |
| `agent.inject()` (evaluated surface) | cc-plugins memory's recall injection path; the evaluation observes its `source.kind==='plugin'` attribution via trial transcript, without intercepting | `packages/core/agent/src/runtime-types.ts:135-143` |
| Session-history retrieval (fixture source for the aging axis) | Use `session_search` and related tool semantics to constrain task design; real driving goes through 12's dual SDK/headless track | `packages/session-query/tool-session-query/src/index.ts:67-117` |
| Settings surface | The task pack's own knobs (family on/off, bucket boundaries) go through a settings namespace: `installSettingsSection` (`packages/settings/settings/src/index.ts:863`), layers = schema defaults → cordis base → `settings.yaml`, hot-reload via `settings/updated`, runtime read via `ctx.settings.describe()`; registration is exposure (#2404) | same as above |

### `memory.*` key convention (sole authoritative definition; 25–29 cite this section)

All are ops channel counters; the `telemetry.op` attribute value is the key name; the body carries
`{task, variant, trialId, bucket?, detail?}`:

| Key | Meaning |
|---|---|
| `memory.availability.stored` | The fact actually landed in the persistent surface the plugin declares (memdir file / card store) |
| `memory.availability.absent` | A task-planted fact was not found afterwards (storage failure) |
| `memory.recall.hit` / `memory.recall.miss` | Whether the recall path brought the relevant entry into model-facing context (attested by injection attribution / transcript) |
| `memory.use.correct` / `memory.use.wrong` / `memory.use.hallucinated` | Downstream answer respectively: used the entry correctly / used it wrong or used a stale version / cited a nonexistent or already-deleted entry (Setoka three-way split) |
| `memory.leak.delete` | In the deletion probe, an already-deleted fact resurfaces (direct / index residue / paraphrase); any single occurrence fails that trial |
| `memory.construct.tokens` | Construction-side token cost (indexing, extraction, consolidation all counted) |
| `memory.index.stale` / `memory.index.fresh` | Index freshness (trial count of cards/index lagging fact changes; in use from 25 on) |
| `memory.aging.crossover` | In the aging arm, a variant's direction-flip point at T+N relative to T=0 (a report event, not a counter) |

Convention discipline: each of docs 25–29 **only cites** this table's key names; new keys must first modify this table (one PR,
table-row append only); the key name is the op name; plugins are forbidden from privately coining synonymous keys.

### Four metric families (task pack design)

**Family 1 — availability-vs-use split** (StrMem-Bench): tasks are multi-session fixtures —
session A plants a fact (via a real user message, not a direct file write); sessions B/C pose tasks in turn that need
that fact. Three independent counts: is the fact in the persistent surface (`memory.availability.*`),
does the recall path bring it into context (`memory.recall.*`), and is it used correctly
downstream (`memory.use.*`). Grader: L1 is a deterministic command/model-graded three-way split
(correct/wrong/hallucinated, Setoka); L2 checks recall evidence (injection event attribution).
**The three levels can all be green in the same trial, or split in any combination — the split pattern itself is the diagnosis**
(stored but not recalled = retrieval problem; recalled but used wrong = injection-quality problem).

**Family 2 — tenure-crossover aging arm** (Veracium): one memory store, established at T=0, then
injected with **synthetic time and traffic** (N rounds of follow-up session fixtures carrying
new facts / updates / contradictions, timestamps pushed forward), measuring family 1's three-level counts at both T=0 and T=N. Comparison subjects: curated style
(cc-plugins memory as-is) vs provenance-rich style (25's episode cards,
wired in after its M0). Fresh-fixture numbers serve only as the T=0 column, never as a standalone conclusion.
The report must include `memory.aging.crossover` events (if any direction flip occurs).

**Family 3 — deletion-leakage probe** (MemLeak): session A plants a fact → the user explicitly deletes it
(via that plugin's real deletion command / file operation, not an evaluation backdoor) → session B probes with three kinds of questions:
direct, via an associated chain of reasoning, and via the consolidation paraphrase surface. If any path resurfaces the
deleted fact ⟹ `memory.leak.delete` + that trial fails. Deterministic grader
(the answer text containing a normalized form of the deleted fact counts as a hit); no model-graded leniency.

**Family 4 — scale-conditioned reporting** (Stored Evidence): a fixed task set with the memory store bucketed by scale
(e.g. 10 / 100 / 1000 entries, fixture-generated), reporting Pass@B (with-evidence correctness — the answer must
cite an entry and the entry must support the conclusion) and P90R (P90 recall latency / token cost) broken out per bucket;
"means swallowing the tail" is banned. M3 then adds a PM-Bench-style intent-set (prospective-intent tasks:
whether "remember X next week" is honored in a later session); the formal consumer is doc 28 — this pack only lands
the task schema and the `memory.recall.hit` breakdown over intent entries (body.bucket='intent').

**Baseline first (hard rule)**: the first evaluated variant of families 1–4 is the **current stack as-is**
(cc-plugins memory + memory-consolidation, zero changes); its numbers are written into
`bench/archive/` as the memory-wave baseline; afterwards any memory plugin's (25–29)
comparison uses it as the parent variant. Without a baseline row, 12's activation gate
rejects memory variants outright.

### Falsification conditions (this pack's own)

This pack does not only falsify others; it also declares which results weaken this wave's premises:

- If the **baseline shows availability ≈ use on real workloads** (stored basically means usable),
  then the core premise of 26 (write gate) — "a large gap exists between storage and utilization that needs gating" — is weakened;
  at that point 26 degrades to an audit-only start instead of default-enforce semantics.
- If family 2 shows no significant difference between T=0 and T+N (within the tested N range),
  then Veracium's tenure-crossover does not hold for this stack, and 25's provenance-rich card
  design loses one of its main motivations — 25's M0 spike criteria correspondingly narrow.
- If family 3 shows zero leakage on the baseline and still zero after 25, the deletion probe degrades to a regression guard
  (run once per release), no longer occupying standing evaluation budget.

## Milestone breakdown (each M = one PR grain, extending 12's families)

**M0: baseline — family 1 tasks + three-level counters + current-stack first run.**
`bench/tasks/mem-avail/` (several each for train/heldout, sealed left empty pending M3);
the `memory.availability|recall|use` three families of counters hooked to the ops channel; score.mjs reporting
adds the three-level columns; **the current stack (cc-plugins memory + consolidation as-is) completes the first run**,
numbers go into archive as the memory-wave baseline.
Verification: on synthetic trials the three-level counts are controllably splittable (construct two fixture kinds, store-only and use-only;
only the corresponding level lights up in the counters); the baseline report checklist is all green (12's five items).

**M1: aging arm (family 2).** Synthetic time/traffic-injection fixture generator (timestamps pushed forward +
N rounds of follow-up sessions); T=0/T=N two-point sampling protocol; `memory.aging.crossover` events;
baseline + (if reached) the first comparison table with 25's spike variant.
Verification: same-store two-point reruns 5 times, the flip determination is stable (does not flip due to sampling jitter);
the fresh-fixture column never forms its own standalone section in the report (template guard).

**M2: deletion-leakage probe (family 3).** Deletion fixture with three question forms; deterministic grader;
`memory.leak.delete`; one run each for the baseline and (by then) 25.
Verification: manually inject residue from the memdir side after deletion; the probe must hit (negative-case construction);
zero false positives on the real deletion path.

**M3: Pass@B/P90R bucketing + intent-set slot (family 4, serving 28).**
Scale-bucket fixture generator; evidence grader (answer citation + entry support, vocabulary aligned with 02's claim
checker; on alignment failure L1 degrades to command-only); first fill of the sealed set
(one-time, via 12's sealed.lock process); PM-Bench-style intent task schema.
Verification: the bucketed report has a P90 column; the sealed-lock CI's three fail paths (built in 12 M3) take effect for the new task
families; the intent-task grader is mutually consistent with 28's criteria document.

**Gate language (written into 12's archive admission)**: when a memory variant (25–29) proposes graduation or entry into
candidate status, its archive entry must attach: four-level counts (baseline + itself), aging-arm two-point
numbers, deletion-probe results, construct.tokens reconciliation. Missing any ⟹ 12's credit gate
treats activation as failed.

## Validation plan

1. Counter unit tests: three-level split control, deletion hit / false positive, crossover stability.
2. Grader unit tests: Setoka three-way precision on constructed answers; evidence-grader alignment tests
   against 02's vocabulary (with degradation path on misalignment).
3. Fixture determinism: family 2 generator, same seed same output (hash lock); family 4 bucket boundaries stable.
4. Process dogfood: M0 baseline report + M3 sealed first run; review conclusions as in 12
   (deep-reasoner checks "are the conclusions constrained by the discipline").

## Risks and open questions

1. **Observation surface for recall determination**: cc-plugins memory's recall is a forked small-model side query +
   `agent.inject()`, with the injected message carrying `source.kind==='plugin'` attribution; but "whether the entry
   brought in is the target fact" requires comparing the injected text against memdir entries — the matching rule (exact / fuzzy)
   is undecided, and the forked side query itself may not land in session events. Open: verify before M1 whether cc-plugins
   memory's injection always goes through `agent.inject()` (if so, the transcript is decisive); if a
   system-prompt direct-concatenation path exists, recall determination needs an added section-rendering diff comparison surface.
2. **Ecological validity of synthetic aging**: whether timestamp push-forward + traffic injection can approximate real 9-week degradation
   (Veracium is a real user study) is unproven. Mitigation: crossover serves only as a directional criterion,
   not for numerical extrapolation; and the report is labeled synthetic-aging.
3. **Coupling of intent-set with 28's criteria**: PM-Bench's consumer is 28; if its grader depends on
   mechanisms 28 has not yet landed, M3 can only deliver schema + placeholder grader. Open: settle M3
   scope after cross-checking with the doc-28 table.
4. **Accounting boundary of construct.tokens**: consolidation's dream rewrite happens in a separate LLM call;
   whether its usage reliably appears in session events has not been verified field by field (same source as
   12 risk 1). If missing, fallback is a wall-clock + event-count proxy, labeled in the report.
5. **The "freshness" paradox of the sealed set**: memory tasks are inherently multi-session and stateful; rerunning sealed tasks
   pollutes the memory store. Plan: sealed memory tasks force per-trial independent workspace +
   independent session_root (12 already has the per-trial workspace convention); but "age the store in-place then test
   sealed" is impossible — sealed covers only the T=0 surface. Accepted, and written into the report template's limitation column.

## Boundaries

- **With 12**: this pack is a milestone-family extension of 12 (the title says "bench pack extending 12");
  no standalone package, no second rail; 12's budget-match, three credit gates, and sealed
  discipline all apply to this pack in full; this pack only adds task families, graders, the `memory.*` key
  convention, and the extra gate language for memory variants.
- **With 25–29**: each memory plugin's telemetry keys and falsification lines **uniformly cite this doc's key convention and baseline numbers**;
  if their milestone verification includes "reporting numbers on 24's rail", that means the baseline comparison starting from this pack's M0.
- **With 28**: intent-set lands here as tasks and keys; the full criteria for prospective scoring belong to 28.
- **With 02**: family 4's evidence-grader vocabulary aligns with 02's claim checker (optional integration;
  degrades when 02 is absent).

## Out of scope

- A general-purpose memory benchmark suite aimed at other repositories / other agent harnesses
  (this pack serves only this repo's plugins on 12's rail).
- KV / cache-layer memory evaluation (serving plane, see 00's exclusions).
- Real human long-term-use studies (Veracium-style tenure studies are user studies; this pack only does
  a synthetic-aging approximation).
