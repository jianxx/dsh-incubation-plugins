# 26 memory-write-gate — memory write admission: post-write demotion gate, payload read-scan, and the upstream pre-write gate

> Status: design (not started) | Tier: 2 | Package: packages/memory/memory-write-gate | Depends on: 08 (rejection-memory precedent); interacts with 24 (baseline criteria), 29 (team overlay)
>
> Verified seams against deepseek-harness **0.1.0-rc.7** (@99f6f02fec); path:line citations refer to that tree.

## Design goal and user problem

**Goal**: add a **quality admission** layer over dsh-cc-plugins memory's consolidation
output — post-write scoring of already-persisted records, quarantine of low-quality
records with re-import blocking; instruction-shaped payload scanning of memory text
near the injection point; and "pre-write admission" delivered as an upstream PR into
`memory-consolidation` (Track B), not disguised as a capability of this plugin.
**User problem**: today's memory is all-or-nothing — consolidation has no admission
quality gate, so chitchat, transient state, and self-contradictory facts all sink into
the memdir. Unsupervised growth directly dilutes recall (InMind-style recall dilution):
the bigger the memdir, the more noise each recall drags into the prompt, crowding out
the facts that actually matter; and once contradictory records are recalled they fight
each other at the decision surface, with no mechanism to say "this should never have
entered memory".

## Motivation (literature anchors, honest labeling included)

- **MemRouter** (2605.00356): reports +10.3 F1 / 16.7× recall efficiency, but **those
  numbers come from a trained 12M-parameter embedder router**, while the scorer we
  adopt is heuristics + LLM-fallback — paying per turn the cost MemRouter eliminated
  through training. This work item adopts only its **concept**: "writes should face an
  admission threshold, not blanket post-write acceptance"; its quantified gains are
  neither cited nor expected.
- **Selective Persistent Memory** (2607.09493): 96% vs 71% task completion rate
  (selective persistence vs full), evidence that an admission gate has real payoff.
  The **single-platform user study** limitation is noted as-is, no extrapolation.
- **ConsistencyGate**: K-shot self-consistency admission; its cost concentrates in
  implicit facts — heuristic pre-filtering with only the gray band going to
  LLM-fallback is exactly narrowing the expensive judgment to the gray belt.
- **DMF** (2606.03463): deterministic write function — write decisions should be
  reproducible and auditable, with no hidden learned state; all inputs to our scorer
  (record text, frontmatter, neighboring records) are deterministic — same input,
  same conclusion.
- **MemSIF**: the CoreFact (write-time) vs ActiveFact (query-time) split — the write
  gate governs "what deserves to become a core fact"; query-time filtering is the
  recall side and out of scope for this package.
- **GhostWriter / AM-Sentry**: admission + retrieval dual gates for delayed-activation
  payloads — memory text itself can be an injection vector; the read-side scan (Track A
  feature 2 of this package) is a port of the retrieval gate.

## Current state and gaps (hard constraints, stated up front)

**Plugins cannot wrap plugins, and upstream has no memory-write waterfall/event seam.**
The memory packages (`packages/memory/memory`, `packages/memory/memory-consolidation`)
are not mounted as wrappable services: they internally listen to `agent/pre-step` /
`agent/turn-stopping` (the turn-stopping subscription is visible inside
`packages/memory/memory-consolidation/lib/index.js`), consolidation's writes happen in
its interior, and **there is no event or waterfall that lets a third-party plugin
intervene before a write**; custom session event types are closed to out-of-repo
plugins (the read path refuses to interpret them when `ignorable: true` is missing —
`packages/session/session-persistence-jsonl/src/format.ts:244` is where the format
refusal lands). Therefore:

- **Track A (the incubation plugin this repo ships)** can only be a **post-write
  demotion gate**: the write has already happened; the gate runs before the next read.
  This is strictly weaker than pre-write admission — bad records are visible to recall
  between the write and the gate run.
- **Track B (an upstream contribution, not a plugin)**: a PR into dsh-cc-plugins
  `memory-consolidation` adding a pre-write admission hook (a scorer SPI). **Until
  Track B lands, true pre-write admission does not exist**; this document does not
  pretend otherwise.

The memdir is plain files (MEMORY.md entry point + topic md files with
user/feedback/project/reference frontmatter; entry-point name and truncation logic
around `packages/memory/memory/lib/index.js:873-879`), so **file-level
read/write/mtime access is available to an incubation plugin** — this is the factual
basis for all of Track A's capabilities.

### Boundaries with dsh-cc-plugins memory

This plugin reads memdir files (read-only scanning + writing its own quarantine zone)
and **does not rewrite** cc-plugins' original memory files: demoted records move into
this plugin's own `.dsh/mem-gate/quarantine/` and the entry is deleted from the
original file (this is an edit to the memdir, so it must be atomic-written and
recorded in an audit event); it does not intercept on consolidation's write path
(impossible, see hard constraints). Track B is the correct upstream-side integration
shape.

## Design

### Surfaces and seams (verified + cited)

1. **turn-stopping serial hook**: `'agent/turn-stopping'` fires serially
   (`packages/core/agent/src/runtime-types.ts:272-278`); a listener throw turns a
   STALL into an error (turn-level error wrapping at
   `packages/core/agent-loop/src/agent.ts:304-315`) → **the gate listener must never
   throw**; all scanning work goes to the background via `ctx.jobs` (see 3), the hook
   only enqueues.
2. **effect-scoped timers**: `ctx.interval` / `ctx.timeout` auto-dispose with the
   scope (the mixin + disposable decoration in `vendor/timer/src/index.ts:4-22`) →
   the hourly sweep scan registers via `ctx.interval`, stopping when the plugin
   unloads.
3. **in-process background jobs**: `ctx.jobs` is an in-process contract
   (`packages/jobs/jobs/README.md:40`) → scanning/scoring run as a background job;
   the turn-stopping hook only calls `JobStart.run()` to enqueue and returns
   immediately.
4. **file surface**: memdir and `.dsh/mem-gate/` both go through `ctx.fs` + atomic
   writes (temp + rename, the same convention as 07); mtime serves as the detection
   signal for the "write to gate run" window.
5. **configuration**: `settingsNamespace` + `installSettingsSection`
   (`packages/settings/settings/src/index.ts:863`).
6. **telemetry**: ops-channel `session-telemetry/record` waterfall; the `memory.*`
   key conventions are **owned by doc 24** — this package only emits counters
   (`memory.gate.scanned|quarantined|rehydrated|payload_flagged` etc.); key naming
   and schema follow doc 24 and are not re-specified here.

#### Configuration declaration (rc.7 onward)

> **Configuration declaration (rc.7 onward)**: this plugin's user-tunable knobs are
> declared through a settings namespace (`settingsNamespace` +
> `installSettingsSection`, `packages/settings/settings/src/index.ts:863`):
> resolution layers are schema defaults → the cordis composition entry (base) → the
> `settings.yaml` user document; `settings/updated` hot-reload and runtime reads via
> `ctx.settings.describe()` are supported. Registration is exposure — #2404 removed
> the apiproxy allowlists, registration is the only exposure control point — so both
> the web settings page and `settings.yaml` can edit it; the cordis `apply(ctx,
> config)` second argument remains the composition-defaults layer.

**Configuration** (independent three-level settings per record category; `off | audit |
enforce` semantics):

| Key | Default | Meaning |
|---|---|---|
| `gate.chitchat` | `audit` | chitchat/transient records: audit = count only; enforce = quarantine |
| `gate.contradicted` | `audit` | contradicts a newer record (heuristic): enforce = quarantine the older side |
| `gate.incomplete` | `audit` | broken frontmatter: enforce = quarantine |
| `gate.payloadScan` | `audit` | instruction-shaped payload scan: enforce = quarantine + telemetry |
| `gate.grayBandLlm` | `on` | gray-band records go to LLM-fallback judgment (provider/model required as a pair, same as 07 pattern 3) |
| `gate.sweepIntervalMinutes` | 60 | `ctx.interval` sweep period |
| `quarantine.retainDays` | 30 | quarantine retention period; physically deleted after expiry |

### Key behavior flows

**Post-write demotion gate (Track A feature 1)**
Trigger: the turn-stopping hook (enqueue) or the hourly interval. Inside the job:
(a) enumerate memdir records, mtime-incremental; (b) score each — heuristics: age,
contradiction with newer records (regex/field-level approximation of assertion
conflicts within a topic, DMF-deterministic), frontmatter completeness, novelty
relative to the existing record set (too much duplication with near neighbors = zero
information); only the gray band goes to LLM-fallback (ConsistencyGate's cost
narrowing); (c) at the enforce level, low-quality records are atomically removed from
the original file and land in `.dsh/mem-gate/quarantine/` (retaining original
frontmatter + quarantine reason + timestamp), and their contentHash is recorded in the
**rejected-hash set** (08's rejection-memory precedent: content with the same hash is
rejected outright when consolidation re-imports it, blocking "sink back in via a
different file"); (d) counters go to ops telemetry.
**Honest declaration of the weaker-than-pre-write window**: bad records are visible
to recall between "write → next gate run". Mitigation: the turn-stop hook makes the
gate finish **before the next session's first read** (enqueued within the same turn,
runs immediately in the background); the residual window = subsequent recalls within
the same session — accepted, with the window's hit rate telemetered.

**Delayed-payload read scan (Track A feature 2, GhostWriter-style)**
Scan instruction-shaped payloads in "recalled/injected memory text" near the injection
point: override phrases targeting the agent ("ignore previous…" in English and Chinese
patterns), tool-call-shaped text, large base64/hex blobs (reusing 08's
`safety/override-phrase` and `safety/base64-blob` pattern libraries, not rewritten).
Hit → flag + quarantine proposal + `memory.gate.payload_flagged` telemetry; at the
enforce level, quarantine directly. **Scope tightened**: scan only the memory
injection channel, not general prompt filtering (that is 09 token-wall's turf); it
only applies to injection text this plugin can observe (honest face: cc-plugins
memory injection happens in its interior; what this plugin can reliably observe is
the memdir files themselves — the read scan therefore mainly runs over all records
during gate sweeps, not as a per-turn injection interception).

**Team-scope variant (Track A milestone item)**
When the team overlay is present (29's team-scope mechanism), the gate tightens on
the shared team memdir: enforce is preceded by human approval (quarantine proposals
go through the `approval/request` waterfall, shared principle 1). Details defer to
doc 29's overlay contract; this package only declares consumption.

**Track B (upstream contribution, repo deliverable, not a plugin)**
A PR against dsh-cc-plugins `memory-consolidation`: insert an admission hook (scorer
SPI: input is candidate record + context, output is admit/reject/gray) before
persistence; this repo's Track A scorer attaches in adapter form. **Stated plainly:
until Track B merges, pre-write admission does not exist; Track A remains a post-write
gate.** Track B's acceptance happens in the upstream repo and does not enter this
repo's milestone gates; this repo only maintains the adapter and the PR link.

## Milestone breakdown

- **M0: scorer + quarantine zone + rejected-hash set**
  read-only memdir parsing, four heuristic scoring items, atomic writes to
  `.dsh/mem-gate/quarantine/`, hash-set persistence and re-import blocking,
  `memory.gate.*` counters, three-level settings.
  Verification: fixture memdir (chitchat/contradiction/incomplete/good examples) →
  scoring snapshot tests; same-hash re-import rejected (unit test); listener never
  throws (injected exceptions only telemetered).
- **M1: read scan (payload scan)**
  pattern library reusing 08's rules, scan job on the hourly interval + turn-stop
  enqueue, enforce-level quarantine, telemetry. Verification: fixtures with payload
  copy get flagged/quarantined; benign memories show zero false positives (within
  threshold).
- **M2: team-scope variant + Track B PR**
  approval-gated enforce under doc 29's overlay; the upstream scorer SPI PR submitted
  and linked. Verification: team fixtures go through the approval waterfall; the PR is
  recorded as a link only — M2's gate does not depend on upstream merge.
- **M3: enforce graduation (gated on 24)**
  **explicit promotion criteria** for raising the default level to enforce: doc 24's
  baseline must demonstrate recall dilution on our real workload (recall noise share,
  contradiction recall rate, etc. above threshold); otherwise stay at audit.
  Verification: rerun gate on/off with 24's bench pack; the quarantined group's
  recall quality is no worse than full retention (12/24's eval rail is the arbiter).

## Validation plan

- Unit tests: scorer determinism (same input, same conclusion), hash-set blocking,
  atomic-write round trips, interval dispose (stops on scope unload).
- Integration: a full synthetic memdir fixture set; turn-stopping enqueue does not
  block (no heavy awaits inside the hook); jobs background execution visible in
  telemetry.
- Real trial: enable audit on this repo's development sessions for ≥ 2 weeks;
  manually sample the false-positive rate of `memory.gate.quarantined` as evidence
  for the M3 promotion discussion.
- Gates: all three green (principle 6).

## Risks and open questions

1. **Race on editing original memdir files**: the gate removing records can race
   with cc-plugins consolidation writes. Mitigation: atomic writes + mtime
   pre-check (if mtime changed before writing, skip that file this round); the
   residual race window is recorded in telemetry. Open: whether upstream is willing
   to expose a file lock or a write-completion event (an additional agenda item for
   the Track B PR).
2. **Cost of the gray-band LLM-fallback**: one auxiliary call per gray-band record;
   the cap threshold (at most N per round) to be set from M0 telemetry.
3. **Heuristic ceiling of contradiction detection**: field-level approximation will
   miss paraphrased contradictions; the miss rate is unknown — rely on doc 24's
   baseline measurement, no prior assumption.
4. **MemRouter numbers do not transfer** (already declared in the motivation
   section): any quantified-benefit claim must go through 12/24's eval rail; citing
   the literature numbers is forbidden.
5. **Failure criteria (stated honestly)**: if doc 24 shows "usability ≈ usage"
   (memory almost fully recalled with no dilution), the admission gate has no
   headroom — withdraw Track B and shrink Track A to payload-scan-only.
6. **memdir format drift**: if cc-plugins changes the topic md structure, the parser
   must follow; hedged with fixtures + upstream version pinning.

## Boundaries and non-goals

- No wrapping or replacing of cc-plugins memory (hard constraint, see current state);
  no modification of consolidation's retrieval logic.
- No query-time recall filtering (MemSIF's ActiveFact side) — that is recall-side
  work; if it becomes a project, a separate document.
- No general prompt-injection filtering (09 token-wall's domain); no learned scorer
  (DMF determinism constraint — learning is future work and requires the 24 baseline
  first).
- Track B's upstream review cadence is not controlled by this repo; this repo does
  not block M0–M1 on an unmerged PR.
