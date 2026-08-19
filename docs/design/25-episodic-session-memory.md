# 25 episodic-session-memory — cross-session episodic memory (first build of the memory wave)

> Status: design (not started; M0 is a spike, go/no-go see milestones) | Tier: 2 | Package: packages/memory/episodic-session-memory | Depends on: no hard dependencies (runtime-optional integrations: 24's measurement rail, 07's rule promotion, 08's skill candidates, 05's progress.md data source, 10's probes)
> Anchors: HLTM (2604.26197) / E-mem (2601.21714) / InMind (C.1 #13) / Selective Persistent Memory (2607.09493) / Memory Characterization (2606.06448); risk surface: C.1 #9 (cross-session ROI unverified — answered by 24)
> Verified seams against deepseek-harness **0.1.0-rc.7** (@99f6f02fec); path:line citations refer to that tree.

## Design goal and user problem

**Goal**: derive **episode cards** from historical sessions — citable memory units carrying
goal, outcome, key decisions, errors and fixes, and provenance references — injected via a
two-tier residency policy of "resident / retrievable", and provide a promotion bridge from failed episodes → candidate rules (07) / candidate skills (08). The only persistent storage is the derived
cards; all access to the raw event log goes through the upstream session-query surface.
**User problem**: every session starts from zero. The build failure you spent three hours
tracking down last week (symptoms, error paths, final fix, why the other approaches didn't work) has to be re-derived this week — because the existing
curated topic memory (memory's memdir) stores only **facts** ("this repo uses pnpm"),
not **episodes with causal context** (how that failure was diagnosed and fixed).

## Motivation

- **HLTM (2604.26197)**: memory layering (episodic → summary → semantic) validated at production scale;
  the only production-scale origin in this wave; the episodic layer is the source, the summary/semantic layers derive from it.
  This design does only the episodic layer; derivation rules are left to the consolidation wave.
- **E-mem (2601.21714)**: the three-phase lifecycle management of episodic memory — generation/update/retrieval;
  the direct reference for the card fields (goal/outcome/errors+fixes).
- **InMind (C.1 #13)**: in-context resident 84.0% vs retrieval-style ≤14.4% — the lesion is not
  embedding scale but **residency policy**: recalled memory always loses to resident memory.
  This design therefore makes resident/retrievable a first-class card attribute
  rather than betting everything on retrieval quality. Note: that number is a single-platform study, used as direction not as value.
- **Selective Persistent Memory (2607.09493)**: persist only schema-worthy content;
  the single-platform limitation is likewise noted.
- **Memory Characterization (2606.06448)**: construction energy can exceed query
  energy within a few hundred queries — the indexer must be bounded-increment, cost-accounted, and freshness-visible.
- **C.1 #9 (explicit risk)**: the ROI of cross-session memory has never been verified on real workloads —
  this is exactly 24's reason for existing; this plugin's M0 spike uses 24's family-1 tasks as its criterion;
  no improvement means stopping at the spike.

**dsh today**: upstream already has the caller-workspace historical-session retrieval surface (the four session-query tools +
sqlite backend, mounted in base) and opt-in cross-session snapshots (session-reference);
cc-plugins memory provides fact-level curated memory. What is missing: episode-level derived cards,
a memory-artifact schema with provenance, a residency policy, and an episode → rule/skill promotion channel.

## Current state and gaps

Verified:

- **Historical-session retrieval surface (the front door for ingestion)**: `session_search` (search **prior sessions** in the caller workspace,
  returning each session's strongest matching event), `session_event_search` (search prior events within one authorized
  session), `session_trace` (session lineage, full ancestor/descendant relations),
  `session_event_read` (read one complete event plus a neighborhood summary) — registered at
  `packages/session-query/tool-session-query/src/index.ts:67-117` (also
  `session_event_trace` :97, event replacement/reference relations).
- **sqlite backend already mounted**: `session-query-sqlite` is injected in the base composition
  (`packages/bundle/base/cordis.patch.yml:117`) and in web-app (:30) —
  the read path is production-usable; no need to build our own indexing infrastructure.
- **Cross-session snapshots (opt-in)**: `context/session-reference` provides bounded read-only snapshots of other sessions
  as sourced model-facing context, consuming `ctx.sessionQuery`,
  not requiring SQLite FTS (`packages/context/session-reference/README.md`).
- **System-prompt seam**: `ctx.systemPrompt.section({name, order, text})` returns an exact
  disposer; same-name scoped overrides global (`packages/core/system-prompt/src/index.ts:375-392`).
- **Injection seam**: `agent.inject()` queues model-facing context for the next pre-step without
  waking the driver (`packages/core/agent/src/runtime-types.ts:135-143`);
  attribution discipline per doc 05 (source `{kind:'plugin', plugin:'episodic-session-memory'}`).
- **turn-stopping (candidate trigger point for the promotion bridge)**: serial, fires only on natural completion
  (`packages/core/agent/src/runtime-types.ts:272-278`); the listener never throws.
- **Telemetry**: everything goes through the ops channel
  (`packages/session/session-telemetry/src/index.ts:64-86`); custom session
  event types are closed to downstream plugins (`packages/core/session/src/known-event-types.ts:7-15`)
  → no new session events.
- **Timer infrastructure**: `ctx.interval`/`ctx.timeout` auto-dispose
  (`vendor/timer/src/index.ts:4-15`); `ctx.jobs` is in-process only
  (jobs/README, not a durable scheduler — not verified line by line, listed as assumption A1); the three schedule
  tools (`schedule_create/list/delete`) are durable **reminder** records, not a scheduler
  (`packages/schedule/schedule/src/types.ts:52-74`) → background re-indexing **does not depend on**
  schedule; it happens while the process lives, with cold-start catch-up accounting.

Gaps: (1) an episode-card artifact and schema; (2) the derivation pipeline (which turn triggers, when a card forms); (3)
the residency policy and injection path; (4) ingestion from progress.md (05) into cards; (5) the episode→rule/skill
promotion bridge; (6) index cost accounting.

## Design

### Ingestion discipline (hard constraint, declared up front)

**All reads of prior sessions go through the upstream session-query surface** — i.e. the `session_search` /
`session_event_search` / `session_trace` / `session_event_read` tool semantics, plus the already-mounted
`session-query-sqlite` store read path (or the opt-in session-reference snapshot).
**Forbidden**: building a second private index of the raw event log inside this plugin (private FTS, a private embedding store,
a private JSONL replay directory). **The only persistent storage is the derived episode cards** (carrying references back to
session id + seq ranges). Rationale: the same principle as 01's tool-manifest single-annotation mechanism —
there is exactly one substrate; a private index would silently rot through format evolution (e.g. zstd compression, event-schema
evolution), whereas cards are a **referential view** of the log; re-reading the log always goes through the upstream read path,
so upstream evolution is followed automatically. A card is not a copy of the event log — it is a conclusion with provenance.

### Record envelope v1

> This section's heading is frozen ("记录封套 v1"; English "Record envelope v1"); docs 26/27 cross-reference
> it as "25 §Record envelope v1". Fields are append-only; semantic changes must open v2 and keep v1 read compatibility.

The top-level envelope shared by all memory artifacts of this wave (episode cards, and the artifacts of 26/27 that reference this envelope):

```jsonc
{
  "type": "episode",                  // type tag: episode (this plugin) | reserved for 26/27 artifact types
  "schema": "memory-envelope/v1",     // envelope version
  "id": "ep_01J…",                    // artifact id (ULID)
  "timestamps": { "createdAt": "…", "updatedAt": "…" },
  "sourceSessionIds": ["01J…", "01J…"], // sessions of origin (at least one; multi-session merges allowed)
  "provenance": [                      // provenance references: pointers back to the event log, not copies
    { "sessionId": "01J…", "fromSeq": 120, "toSeq": 340, "note": "diagnosis rounds" }
  ],
  "confidence": 0.0,                   // 0–1: derivation confidence (model self-assessment + validation rules)
  "supersededBy": null,                // points to the new artifact id when superseded; non-null means historical version
  "payload": { … }                     // type-specific payload (card fields in the next section)
}
```

Invariants: `supersededBy` is one-directional (acyclic); superseded artifacts are **not deleted** (auditable,
deletion requests traceable); the seq ranges in `provenance` must be able to reconstruct the
source evidence via `session_event_read` — when a card's claim cannot be substantiated, confidence is forced to 0 and
`memory.index.stale` is set (key convention see 24).

### Data model / configuration (episode card schema, budgets, thresholds)

**Episode card** (the payload of envelope `type:'episode'`):

```jsonc
{
  "goal": "修复 CI 上 flaky 的 integration test",
  "outcome": "resolved | abandoned | superseded",   // outcome state
  "keyDecisions": ["放弃 mock 方案,改用 testcontainers(见 seq 210-260)"],
  "errorsAndFixes": [{ "error": "端口竞争 EADDRINUSE", "fix": "动态端口分配" }],
  "tags": ["ci", "flaky-test", "testcontainers"],
  "residency": "resident | retrievable",  // residency tier (InMind)
  "staleness": { "sourceAdvanced": true, "lastVerifiedAt": "…" }
}
```

**Storage**: `.dsh/episodes/*.json` (one file per card, envelope + payload; resolved relative to `session.cwd`,
so it can enter git review; atomic write temp+rename, per 07 convention). Derived data,
**never** appended into the session log as an event.

**Configuration declaration (rc.7 onward)**: this plugin's knobs are declared through a settings namespace (`settingsNamespace`
+ `installSettingsSection`, `packages/settings/settings/src/index.ts:863`):
resolution layers = schema defaults → cordis composition entry (base) → the `settings.yaml` user document;
hot-reload via `settings/updated`; runtime read via `ctx.settings.describe()`; registration is exposure
(after #2404 registration is the only exposure control point).

| Key | Default | Meaning |
|---|---|---|
| `mode` | `audit` | `off` / `audit` (card-building + indexing only, no injection) / `full` (inject) |
| `residentBudgetBytes` | 2048 | UTF-8 byte cap on resident-card injection (same order of magnitude as 07's 2KB) |
| `residentCap` | 3 | maximum number of resident cards |
| `recall.trigger` | `per-turn` | `per-turn` (side query each turn) / `on-uncertainty` (see recall path) |
| `index.batchMaxSessions` | 20 | maximum sessions processed per incremental indexing round (bounded increment) |
| `derivation.provider` / `derivation.model` | required pair | auxiliary LLM route for derivation (session-title-llm-style pair requirement) |

### Residency policy (InMind: resident vs retrievable)

- **resident**: a few (≤`residentCap`) high-value cards, **injected on every assembly**,
  through our own systemPrompt section (`name:'episodic-session-memory:resident'`,
  `order: 210` — after 07's rules section (200); a different name from cc-plugins memory's
  section, so no conflict). Hard byte cap `residentBudgetBytes`; over the cap, truncate in confidence+freshness
  descending order, with the omitted count noted at the tail.
- **retrievable**: the remaining cards only enter the recall path, not residency.
- **Promotion/demotion**: a card with outcome=resolved and ≥2 recent citations may be promoted to resident
  (audit mode only proposes); cards with `staleness.sourceAdvanced` automatically leave resident.
- **Honest boundary**: the resident segment coexists in a **pile-up** relationship with cc-plugins memory's own prompt section and 07's rule
  injection — upstream has **no** cross-plugin prompt budget arbiter;
  the three sources can each max out their own budget and then stack. This plugin does not pretend to have solved that problem:
  "total injected bytes without arbitration" is listed as risk R2, and the telemetry body records the current round's resident-segment actual
  bytes, for consumption by 24's rail and any future (if it appears) budget-arbitration design.

### Recall path (boundary with cc-plugins memory)

- Retrieval surface = the card store's own lightweight index (tag + goal/outcome text, in-process,
  rebuilt from the card files — cards are derived data, the index is a cache of a cache, discardable).
- Injection: in `per-turn` mode, a side query at the start of each turn (small model, following cc-plugins memory's
  fork side-query precedent) then `agent.inject()`, with plugin attribution
  (`source: {kind:'plugin', plugin:'episodic-session-memory'}`); in `on-uncertainty`
  mode, recall fires only when a trigger condition hits (e.g. the model explicitly searches historical sessions, or an uncertainty signal) —
  saves tokens at the cost of missed recalls; M0/M2 compares the two modes.
- **Explicit boundary: this plugin cannot and does not intercept cc-plugins memory's `inject()`** — its
  recall is its own; the two injection streams coexist; dedup happens only within this plugin's own "already-shown cards" set
  (following cc-plugins memory's already-shown-file dedup precedent). Cross-plugin dedup likewise has no upstream mechanism,
  filed under R2.
- Budget-tiered routing sketch: the recall side query first asks "already in resident?" (if so, no duplicate recall);
  card recall count scales with current context pressure (tokenMeter surface per 05 seam 10 usage,
  an optional service; a fixed number if absent).

### progress.md ingestion (relation to 05, not parallel double extraction)

05's `.dsh/longrun/progress.md` is a **task-scoped one-off artifact** (discarded with the task);
episode cards are **session-scoped citable artifacts** (carrying provenance, surviving across tasks). The two
are not competing extractions: when a long-run session ends (or progress.md is marked complete), progress.md's
Goal/Done/Blockers/Evidence are a **ready-made card-draft source** — the derivation pipeline reads it plus
`session_trace`/`session_event_read` to fill in provenance seq ranges and synthesizes one card,
rather than doing a second pass of episode extraction over the event log in the same session. Verdict: progress.md is the scaffolding,
the card is the building.

### Episode → rule/skill promotion bridge (the cash-out point of cross-session ROI)

Failed episodes (outcome=abandoned, or dense errorsAndFixes) are the highest-value memories.
The milestones deliver **candidate generation**, never silent activation:

- **→ 07 candidate rules**: when a card's errorsAndFixes shows a "same mistake ≥2 times" pattern, generate
  a rule draft into 07's `/rule review` pending queue (07's candidate state machine, the human
  activate gate, and the `/rule add` file contract stay as-is — this bridge only produces draft text and provenance).
- **→ 08 candidate skills**: recurring multi-step solutions (keyDecisions patterns) generate
  skill candidates into 08's candidate channel, for human review.
- **Environment verification**: when 10's probes (verified-tools) are present, promotion drafts carry verification status;
  when absent, labeled unverified (does not block human review).

This bridge is the mechanism by which "cross-session ROI" becomes measurable on the 24 rail: a card eventually becoming an activated rule
and suppressing recurrence (07's recurrence statistics) is far harder evidence than "injection counts".

### Indexer discipline (Characterization's cost accounting)

- **Bounded increment**: driven in-process at low frequency by `ctx.interval`, at most
  `index.batchMaxSessions` sessions per round; one cold-start catch-up pass; `ctx.jobs` is in-process only
  (assumption A1), no durable background.
- **Cost accounting**: derivation-call tokens all counted into `memory.construct.tokens` (24's key);
  card staleness into `memory.index.stale/fresh`. If accumulated construct exceeds the
  recall side query's tokens (Characterization's crossover), telemetry escalates to warn —
  this is the machine signal that "this memory isn't worth it", wired to 24's falsification line.

## Milestone breakdown

**M0: spike (go/no-go).** No package built. Using the ready-made session-query tools + manual/scripted
derivation, do a one-time card extraction over **about 20 historical sessions of one real repository**; the mini task set takes
24 family 1's heldout tasks (if 24 M0 is not done, first land 5 seeds following 24's task schema);
run one round against the "no memory" variant.
Verification criteria (hard): derived cards + resident injection show a repeatable improvement over "no memory"
on 24's family-1 three-level counts (at least one of recall and use; direction consistent across double runs).
**Falsification: if there is no improvement, M0 is the endpoint — this plugin stays at the spike report, no M1**;
that result is also written back into 24's falsification-conditions section.

**M1: card derivation pipeline + record envelope v1.** `pnpm new:plugin memory episodic-session-memory`
scaffolding; envelope schema + card payload schema + atomic writes; incremental derivation triggered by turn
completion (`agent/turn-stopping`, listener never throws) (card forms at session end);
provenance seq ranges re-verified via `session_event_read`; confidence rules.
Verification: synthetic session fixtures → card round-trip; failed re-verification zeroes a card's confidence +
stale count; listener fault-injection does not kill the turn.

**M2: recall path + residency policy.** resident section (order 210, hard byte cap + truncation);
the per-turn / on-uncertainty modes; `agent.inject()` attribution; already-shown dedup;
recall counts land in `memory.recall.hit/miss` (24 keys).
Verification: assert resident over-cap truncation; first comparison run of the two recall modes on the 24 rail;
assert injected events' source is `{kind:'plugin', plugin:'episodic-session-memory'}`.

**M3: progress.md ingestion + promotion bridge.** 05-artifact reading (tolerant of partial write,
per 05's parser); card synthesis at long-run session end; errorsAndFixes → 07 pending drafts,
keyDecisions → 08 candidates (drafts only; the human gates live on the 07/08 command surfaces); attach
verification status when 10 is present.
Verification: progress.md fixtures (including truncation) → cards; drafts enter 07's `/rule review` queue with
zero silent activation; degrade to warn, not crash, when 07/08 are absent.

**M4: indexer economics + hardening.** Bounded increment + cold-start catch-up; full accounting of `memory.construct.tokens`
/ `memory.index.*` + crossover warn; deletion path (card deletion =
file deletion + supersededBy chain retained for audit, coordinating with 24's family-3 probe); README graduation criteria.
Verification: one full pass of 24 families 2/3/4 (crossover two-point, deletion zero leakage, bucketed P90);
construct/retrieval cost reconciliation report.

## Validation plan

- Unit tests: envelope round-trip, provenance re-verification, truncation, partial progress.md tolerance,
  the deletion path.
- Synthetic-session integration: real `session/event` seam drives derivation triggers; injection-attribution assertions;
  turn-stopping fault-injection.
- 24 rail (primary criterion): M0 go criteria, M2 two-mode comparison, M4 all four families.
- Real trial: enable on this repo's own development sessions for ≥2 weeks, observing card citation rate and promotion-bridge yield
  (acceptance ratio in the 07/08 queues), as graduation-nomination evidence.

## Risks and open questions

1. **C.1 #9 (explicit): cross-session ROI unverified**. This plugin's very reason for existing is the proposition under test;
   the M0 spike is the first gate, 24's baseline comparison the second. If both are negative, the correct action is
   archiving this design, not adding features.
2. **No cross-plugin prompt budget arbitration** (honest declaration): the resident segment stacks with cc-plugins memory's
   section and 07's rules injection; total injected bytes may run out of control. Mitigation: hard cap on our own segment +
   telemetry recording measured bytes + revisit whether an arbitration design is needed only after 24's baseline
   yields a "total injection vs use.correct" curve (possibly a separate work item).
3. **Derivation LLM routing**: per 07 risk 3; whether a general plugin taking the "current session route" API is
   stable is unconfirmed; fallback is the required `derivation.provider/model` pair
   (session-title-llm strategy).
4. **Assumption A1: `ctx.jobs` is in-process only** — the jobs README was not verified line by line; if a durable
   scheduler actually exists, the indexer design is unchanged (bounded increment stays), only the cold-start catch-up logic simplifies.
   Check method: read the full `packages/jobs/jobs/README.md` before M1.
5. **Stability of the sqlite read path as a plugin surface**: `session-query-sqlite` is mounted in base,
   but whether its store's **direct programmatic read API** (bypassing the tool surface) is a stable plugin surface is unverified.
   Check method: the M0 spike uses only the tool surface (the zero-risk path); before M1 verify the store service key
   and exported surface; if unavailable, route everything through an operation layer encapsulating tool semantics
   (already abstracted on this package's ingest side).
6. **Representativeness of the 20 sessions**: the M0 single-repo sample may be biased (that repo may happen to be rich in reusable episodes).
   Accepted: the spike only seeks an "existence proof" (one real scenario benefits); generalization is answered by 24's rail's
   multi-repo task families.
7. **Privacy surface**: cards carry user data across sessions; `.dsh/episodes/` entering git may contain
   sensitive content. Mitigation: confidence gate + redaction rules in the derivation prompt + integration with 09's
   purpose markers (following 07 risk 2's exfiltration-classification approach); details pending alignment once 09 lands.

## Boundaries

- **With 24**: all of this plugin's metric keys and falsification criteria cite 24's `memory.*` key convention;
  M0's go/no-go is exactly 24 family 1's comparison run.
- **With 26/27**: they cross-reference this doc's "§Record envelope v1"; this plugin does not consume their artifacts,
  but the envelope fields (sourceSessionIds/provenance/confidence/supersededBy) are reused by them.
- **With 05**: progress.md is an ingestion source and scaffolding, not a competing memory; 05's parsing-tolerance
  rules are reused, not reimplemented.
- **With 07/08**: the promotion bridge only produces candidate drafts; state machines, human activation gates, and recurrence statistics all live on
  the 07/08 side; no overreach.
- **With cc-plugins memory**: coexistence without reading each other; fact memory belongs to it, episodic memory to this plugin;
  no cross-plugin dedup/budget arbitration (risk R2).

## Out of scope

- Summary/semantic-layer memory (HLTM's upper two layers) — left to the consolidation wave.
- Private indexes/embedding stores over the raw event log (explicitly forbidden, see ingestion discipline).
- A cross-plugin prompt budget arbiter (a separate work-item candidate; this plugin only records telemetry).
- Cross-repo/cross-user shared memory (team overlays belong to cc-plugins memory's existing semantics).
