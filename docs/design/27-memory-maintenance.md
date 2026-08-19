# 27 memory-maintenance — memory upkeep: staleness detection, decay demotion, contradiction repair, and versioned rollback

> Status: design (not started) | Tier: 3 | Package: packages/memory/memory-maintenance | Depends on: 25 (§Record envelope v1, frozen anchor), 26 (write gate), 07 (reuses its lifecycle and consolidation machinery)
>
> Verified seams against deepseek-harness **0.1.0-rc.7** (@99f6f02fec); path:line citations refer to that tree.

## Design goal and user problem

**Goal**: add the "upkeep" half-loop to the memdir — stale-claim detection (dead
paths / outdated versions / broken URLs), access-frequency tracking, decay → demotion
queue (human approval), contradiction pairs → repair proposals, superseded-by version
chains, and NL-triggered rollback; the machinery reuses 07's candidate/active/archived
state machine, bounded-edit consolidation, and human approval loop — no rebuild.
**User problem**: memory grows monotonically; outdated and contradictory facts
silently poison decisions — after "the build path migrated from vite to rsbuild" is
written down, the old entry stays, both enter the prompt on recall, and the agent
picks the old one. Today no mechanism knows "what to delete, what to revise, or how
to roll back a mistake".

## Motivation (literature anchors)

- **Agent Memory ≠ Database** (2605.26252): four failure classes — unsupervised
  growth, missing semantic revision, capacity-driven blind forgetting, query-recall
  mismatch — **used directly as this design's contract checklist**: M0 treats growth
  visibility, M1 treats forgetting (evidence-based decay, not blind), M2 treats
  semantic revision (contradiction repair), M3 treats revision-history
  traceability. Those four classes are the future of an unmaintained memdir.
- **MEMOREPAIR** (2605.07242): barrier-first cascade repair — while a contradiction
  set is unresolved, reasoning that depends on those facts should carry a barrier
  marker; the full version needs provenance infrastructure, so this package does
  **MEMOREPAIR-lite** (phased: M2 implements only minimal barrier semantics).
- **MemStrata**: deterministic supersession layer + bi-temporal ledger — superseded
  records are not deleted but hung on a superseded-by chain; M3 adopts its
  supersession semantics (lite version: single timeline + version numbers, no full
  bi-temporal).
- **OBLIVION** (2604.00131): access-frequency decay — memory anneals by usage
  signals; M0/M1's frequency tracking + decay queue is its deterministic
  implementation.
- **Live-Evo** (2602.02369), **ChronoMem** (2607.27773): natural-language-triggered
  rollback ("take the memory back to before last Wednesday") — M3's ChronoMem-lite
  is implemented with 25's envelope version numbers; capability limits in open
  questions.
- **Veracium** (2607.21962): single-platform user study; conclusions are directional
  reference only, labeled as-is.

## Current state and gaps

Hard constraints as in doc 26 (plugins cannot wrap plugins, no memory-write waterfall
seam; the memdir is plain files, file-level read/write/mtime available): upkeep is
**entirely file-level post-hoc work**; there is no upstream "delete/revise" event to
subscribe to; frequency tracking can only come from recall paths observable in this
ecosystem (25's injection path; honest face: cc-plugins' own recall injection is
invisible to third parties, so frequency statistics cover only 25's injection surface
and are labeled a lower bound).

07 already provides all the lifecycle machinery: the candidate→active→archived state
machine, bounded-edit consolidation (`consolidation.maxEditsPerRun`), the human
approval loop (the `/rule review`/`activate` pattern), utility scoring and human
exemption (`pinned`). This package **reuses rather than rebuilds**: candidate
extraction targets the machinery face of 07 §"consolidation flow (SkillOpt/SSCA
maintenance phase)" (state machine, bounded edits, approval loop), and **commits to
extracting that machinery face into a shared lib** — that lib does not exist yet; the
extraction is a prerequisite deliverable of this package's M1, not an existing fact.

Record schema frozen anchor: **25 §Record envelope v1** (provenance, version, access
count fields defer to 25 and are not redefined here; 26's rejected-hash set and gate
timestamps are also read through the envelope).

## Design

### Surfaces and seams (verified + cited)

1. **effect-scoped timers**: `ctx.interval` / `ctx.timeout`
   (`vendor/timer/src/index.ts:4-22`) — M0's frequency aggregation and staleness
   scans are cheap interval jobs; they stop on scope unload.
2. **in-process background jobs**: `ctx.jobs` in-process contract
   (`packages/jobs/jobs/README.md:40`) — scanning/pairing/proposal generation run as
   background jobs; listeners never throw (shared principle 2).
3. **command surface**: `ctx.commands.register({name, description, input,
   recordInput, handler})` (precedent at
   `packages/feedback/command-feedback/src/index.ts:101`) — the
   `/mem-maint review|apply|rollback` human gates; provenance trails via
   `recordInput: true` (the NL rollback gesture needs input trails).
4. **file surface**: memdir + `.dsh/mem-maintenance/` (queues/ledgers) via `ctx.fs`
   atomic writes; mtime for incremental scans.
5. **telemetry**: ops-channel `memory.maint.*` counters; key conventions belong to
   doc 24 and are not re-specified here; evaluation criteria belong to 12/24.

#### Configuration declaration (rc.7 onward)

> **Configuration declaration (rc.7 onward)**: this plugin's user-tunable knobs are
> declared through a settings namespace (`settingsNamespace` +
> `installSettingsSection`, `packages/settings/settings/src/index.ts:863`):
> resolution layers are schema defaults → the cordis composition entry (base) → the
> `settings.yaml` user document; `settings/updated` hot-reload and runtime reads via
> `ctx.settings.describe()` are supported. Registration is exposure — #2404 removed
> the apiproxy allowlists, registration is the only exposure control point; the
> cordis `apply(ctx, config)` second argument remains the composition-defaults
> layer.

| Key | Default | Meaning |
|---|---|---|
| `maintain.mode` | `off` | three levels: **off = queue-only** (just queue) / **audit = propose** (emit repair proposals) / **enforce = auto-apply-trivial** (only "trivial" proposals auto-apply: dead-path deletion, pure typos; contradiction repairs are never automatic) |
| `decay.halfLifeDays` | 45 | access-frequency half-life (OBLIVION constant) |
| `decay.minAgeDays` | 30 | minimum record age for demotion candidates |
| `contradiction.scoreThreshold` | 0.6 | pairing confidence threshold (below the gray band, no entry into M2) |
| `sweep.intervalMinutes` | 60 | staleness/frequency scan period |

### Key behavior flows (phases are hard dependency order)

**M0 — stale-claim detection + access-frequency tracking**
Staleness detection (deterministic, zero LLM): file paths in memdir records →
`ctx.fs` probing for dead paths; version claims → compared against the workspace's
actual versions (`package.json` etc.); URLs → HEAD probes for breakage. Frequency
tracking: each hit on 25's injection path records an access event (envelope field);
07/26's gate and consolidation touchpoints counted in where available; an interval
job aggregates. Output: staleness list + frequency ledger, with
`memory.maint.stale_found|hit` counters. Honest declaration: **injection-side hit
visibility covers only 25's own injection path**; cc-plugins internal recall is
invisible, so frequency is a lower bound.

**M1 — decay → demotion queue (human approval)**
Candidate set = low frequency ∧ high age ∧ no contradiction entanglement (records
referenced by M2's contradiction sets do not participate in demotion — the same
protective semantics as 07's "rules with unresolved recurrences do not participate in
demotion"). Candidates enter `.dsh/mem-maintenance/queue/` and are presented through
the shared approval surface (07 pattern: approval is an explicit command; the
`approval/request` waterfall is for ASK scenarios, shared principle 1). Demotion =
the archived state (07 state machine semantics), no physical deletion; `pinned`
human exemption as in 07. **Prerequisite deliverable: extract 07's state machine /
bounded edits / approval loop into a shared lib** (see current state — a commitment,
not an existing fact).

**M2 — contradiction pairs → MEMOREPAIR-lite repair proposals**
Depends on: the provenance density accumulated by 25's envelope + 26's gate
timestamps (who wrote first, from where). Contradiction pairing (assertion conflicts
within a topic; confidence below threshold does not enter) → generate repair
proposals (keep-new-drop-old / merge rewrite / mark-uncertain, one of three; LLM
drafts, machine-checked bounded-edit cap, 07 consolidation's machine-check pattern).
**Minimal barrier semantics**: while a contradiction set is unresolved, records
depending on that fact set carry a caveat marker when rendered ("unresolved
contradiction exists, see /mem-maint review"), without blocking recall. Application
must be human (not relaxed even at the enforce level — stated plainly).

**M3 — superseded-by chains + ChronoMem-lite NL rollback**
Repairs/rewrites produce superseded-by chains (MemStrata lite: single timeline +
envelope version numbers, history not deleted); NL rollback = `/mem-maint rollback
<NL time/condition>` rolls affected records back per the envelope version sequence
(ChronoMem-lite: only rolls back versions covered by this package's ledger; writes
predating the 25 envelope are outside the ledger — the capability boundary is
presented as-is).

## Milestone breakdown

- **M0: staleness detection + frequency ledger**
  three deterministic staleness probes, 25 injection-path hit counting, interval
  job, telemetry. Verification: fixture memdir (dead paths / old versions / broken
  URLs, positive and negative cases each) detection snapshots; frequency aggregation
  unit tests; interval dispose.
- **M1: shared lib extraction + decay demotion queue (human approval)**
  extract 07's machinery face into a lib (this package is its first user), decay
  scoring, candidate queue, approval commands, pinned. Verification: synthetic tests
  of the three candidate conditions (any unmet → not queued); zero effectuation
  before approval; 07 regression green after the extraction (nothing broken).
- **M2: contradiction pairs + repair proposals + caveat barrier**
  pairer, LLM proposals + machine checks, caveat rendering, human application.
  Verification: contradiction fixtures produce one-of-three proposals; over-cap edits
  rejected; the caveat appears in rendering snapshots during the barrier; at the
  enforce level, contradiction repairs still do not auto-apply.
- **M3: supersession chains + NL rollback + docs**
  superseded-by written into the envelope, rollback command, README (graduation
  criteria). Verification: after rollback the record set exactly matches the
  historical version; out-of-ledger records are refused rollback with the boundary
  stated.

## Validation plan

- Unit/integration per milestone; driven mainly by fixture memdirs + synthetic
  injection events.
- Observation: `memory.maint.*` distributions, the queue's human disposition ratio
  (adopted/rejected) as graduation-nomination telemetry evidence; contradiction
  repair quality is adjudicated by the 12/24 eval rail, not self-graded.
- Gates: all three green (principle 6).

## Risks and open questions

1. **Rework risk of the 07 machinery extraction**: if 07 is already live when the lib
   is extracted, all of 07's verifications must be rerun; scheduling-wise aim for
   around 07 M3 merging. Open: the extraction boundary (state machine vs rendering)
   to be decided by a spike.
2. **Bias of the frequency lower bound**: covering only 25's injection path, cold
   records may be "falsely low-frequency" and demoted. Mitigation:
   `decay.minAgeDays` + queue-only default + human approval as the backstop; whether
   hit surfaces beyond 25 exist depends on upstream contributions like Track B
   (doc 26) — unknown.
3. **Heuristic ceiling of contradiction pairing**: paraphrased contradictions missed
   and metaphors falsely flagged are both unavoidable; set the threshold
   conservatively at first (prefer misses over false positives), tune the false
   positive rate on M2 audit data.
4. **NL rollback parsing ambiguity**: misparsing a natural-language time expression
   → rolling back the wrong set. Mitigation: present a diff preview before rollback,
   application still requires confirmation; out-of-ledger content is explicitly
   refused.
5. **Dependency timing**: M2 hard-depends on 25's envelope accumulating enough
   provenance density in real use — if 25 slips, M2 slips with it; it does not
   degrade into provenance-free repair (that is more dangerous than not repairing).
6. **Failure criteria (stated honestly)**: if telemetry shows memdir growth
   plateauing in real use and the contradiction rate ≈ 0, M2/M3 are shelved forever
   — there is nothing to maintain; M0/M1's staleness detection remains independently
   valuable.
7. **memdir format drift**: same as doc 26 risk 6, hedged with fixtures + upstream
   version pinning.

## Boundaries and non-goals

- No rebuilding lifecycle machinery (07 owns it), no redefining the record schema
  (25 owns it), no re-specifying telemetry keys (doc 24 owns them), no pre-write
  admission (26/Track B owns it).
- No capacity-driven deletion (the inverse of failure class three: blind
  capacity-based trimming is explicitly excluded; demotion goes only through
  frequency + age + human).
- No learned forgetting policy (MemCon-style: future work, requires the 24 baseline
  first).
- No full bi-temporal ledger (MemStrata full) and no cascade reasoning barriers
  (MEMOREPAIR full); the lite semantics in this document govern.
