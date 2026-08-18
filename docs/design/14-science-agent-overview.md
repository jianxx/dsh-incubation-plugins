# 14 science-agent-overview — charter for building a scientific-research agent on dsh (work items 15–23)

> Status: design (not started) | Nature: charter (takes no build slot) | Covers work items: 15–23 | Shared substrate: [01 tool-manifest](01-tool-manifest.md) | Acceptance ground: breeding-ai-workspace `projects/genomic-selection`

This document is not a plugin implementation spec: it defines the motivation,
stage mapping, unit split, shared tenets, and overall acceptance criteria of the
"scientific research on dsh" work package (items 15–23). Per-unit surface
details (tool signatures, schemas, events) belong to each unit's own document;
this charter only pins the boundaries and contract ownership between units.

## Goal and user problem

**Goal**: extend dsh from a general coding harness into a scientific-workflow
harness — six gaps (literature evidence, analysis execution, run provenance,
HPC backend, citation attribution, domain packs) are each closed by one
incubation work item, with end-to-end acceptance on the genomic-selection
project of breeding-ai-workspace.

**User problem**: today, a breeding (or any wet-lab/dry-lab hybrid) team trying
to do research with dsh hits a chain of inconveniences from one root cause: ask
the agent to search the literature and it only has generic web search, with no
replayable retrieval record; ask it to run GBLUP and the code dies inside
`run_code` — no machine-readable result contract, no lineage link; submitting
to a cluster is impossible — no HPC backend; a goal gate asked to verify
"analysis complete" has no citable run evidence; the only way to inject domain
knowledge is prompt-stuffing — precisely the layer whose ablation collapses in
the literature (Vibe-FDTR, below). These are not nine separate pains but
surfaces of one gap: **dsh has no first-class objects for scientific
artifacts** (papers, datasets, hypotheses, runs, evidence, citation relations).

## Motivation (why this is necessary)

Three bodies of material justify this work package: why it can grow out of dsh,
why it must, and where the first field is.

**① dsh's capability surface is broad, with systematic gaps for research
workflows.** Verified surfaces (paths and line refs checked): the cordis
plugin/service mechanism and the `ctx.tools` runtime
(`deepseek-harness/packages/core/tools/src/index.ts`; seam line numbers per the
verified list in [01](01-tool-manifest.md)); the code-mode `run_code` transport
(`packages/core/tools/src/code-mode.ts:20`, `RUN_CODE_NAME = 'run_code'`);
background jobs `job_output/job_list/job_kill`
(`packages/jobs/tool-jobs/src/index.ts:303/343/363`); scheduled reminders
`schedule_create/list/delete`(`packages/schedule/schedule/src/tools.ts:318/400/420`);
the `subagent` and `workflow` orchestration surfaces
(`packages/subagent/tool-subagent/src/index.ts:22`,
`packages/workflow/tool-workflow/src/index.ts:29`); the goal ledger
`create_goal/update_goal` (`packages/goal/tool-goal/src/index.ts:208/235`);
CLAUDE.md-style memory + consolidation (packages
`packages/memory/{memory,memory-consolidation}`, listed as already covered in
doc 00); and an MCP client (`packages/mcp/mcp-client/src/index.ts:28`, stdio
and streamable-HTTP transports). Yet the same `packages/` tree has: no academic
retrieval surface, no run/experiment lineage, no HPC/batch backend, no notebook
surface, no MCP **server** (`packages/mcp/` holds only `mcp-client` +
`mcp-config`), and no browser-automation package (top-level
`ls packages | grep -i 'browser|playwright|notebook|jupyter|hpc|slurm'` returns
zero hits — verified). The gap is systematic: nothing carries the
artifact→evidence→review→discovery chain as first-class objects.

**② Literature: the dividing line for research agents is now the
evidence-building workflow.** The synthesis page
`/Users/bytedance/workspace/llm-wiki/wiki/syntheses/scientific-research-agents.md`
(479 lines, 63 integrated sources — verified) concludes (:170): the dividing
line is not "can it search papers" but **whether institution policy, research
questions, hypotheses, datasets, papers, claims, evidence spans, tool outputs
and verifiers can be organized into an operable, replayable research artifact
graph**. Anchors mapped one-to-one onto this package:

- *An agent-facing knowledge layer over retrieval buys cross-task gains* — EMBL
  AI Librarian plans natural-language questions into fielded subqueries against
  Europe PMC with BM25 reranking and sentence-level evidence extraction; on
  LitQA2, GPT-5.4 rises from 17.6 (parametric memory) to 78.9 with LIBRARIAN
  (70.3 with web search); ScholarQA-Bench Bio/Neu Citation F1 73.8/79.4 vs
  BM25 67.0/68.5 (:216/:453).
- *Packaged domain code + procedural knowledge is the prerequisite for reliable
  evidence execution* — Vibe-FDTR reaches 100% / 98.9% on its two-level
  benchmark; the code-agent without procedural skills drops to 91.4% /
  **36.7%**, agent-only to 38.6% / 0%, while costing 87.7% less and running
  over 60% faster than the code-agent (:212/:452). This directly grounds
  tenet d (domain knowledge must be machine-readable).
- *Citation UX is not evidence verification* — Cited but Not Verified splits
  attribution into Link Works / Relevant Content / Fact Check, showing factual
  support lags far behind surface citation quality (:184/:362) → item 20.
- *Fact admission needs a single authority* — Danus's stateless verifier is the
  sole authority on fact admission; its fact-graph memory stores proofs and
  dependencies and supports revocation of erroneous facts (:286) → item 19.
- *Long-horizon tasks hold at real experiment sites* — an autonomous
  quantum-sensing run on NV centers lasted 18.9 h, including a CPMG follow-up
  the operator never explicitly requested (synthesis:304; source page
  `wiki/sources/arxiv-2607.25145-*.md:88`, both verified); its division-of-
  labor conclusion — "the agent owns hypotheses and quantitative evidence
  interpretation; deterministic code owns control and safety" — shapes item
  18's backend posture.
- *Canonical evidence IDs + gate-at-generation* — Auditing RAG Hypotheses
  assembles prompts with stable evidence IDs (`obs:`/`jump:`/`lit:`/`path:`);
  its V1 citation-validity gate reported zero invalid references across 136
  hypotheses (:208) → the evidence-ID scheme of 15/20.
- *Writing-better revisions must be distinguished from re-running for stronger
  evidence* — Prompt-to-Paper funnels statistics and figures into a canonical
  `results.json` with an eight-dimension scorer and hallucination penalties
  (:202/:380) → item 16's result contract.
- *A unified provenance contract is still missing* — meta-problem one (:347):
  "across systems there is still no unified schema for claim, evidence span,
  review note, simulation result and verifier output" → item 17's raison
  d'être.

**③ Evidence from the breeding workspace: a mature literature layer over an
empty compute/data layer.** In
`/Users/bytedance/workspace/github.com/breeding-ai-workspace` (verified): global
`skills/` lists paper-scan / paper-ingest / paper-deep-read / wiki-query /
innovation-scan and other literature-side skills in `registry.yml`; meanwhile
the first sample project `projects/genomic-selection/` README self-describes as
"structural placeholder, content to be filled by the team" — a nine-face
skeleton (the seven-slot contract of spec §4.4 plus the
`rules.yml`/`knowledge/`/`memory-log/` extensions) whose directories contain
only `.gitkeep`. In short: the workspace has made "read papers, query the wiki"
usable, while "process genotype data, run GBLUP, keep lineage" has not even
skeleton content. That empty ground is the acceptance field for 14–23.

## Status quo and gaps

Surveyed along the research workflow (reusable surfaces cited in ① above; the
01–13 substrates in the incubation repo are listed in the [00](00-overview.md)
table):

- **Reusable**: run_code for immediate execution; the jobs/schedule background
  and timing surfaces; subagent/workflow/goal orchestration and goal ledger;
  the memory surface; mcp-client for external tool attachment; 01's per-tool
  metadata registry; 03/04's trace/goal gates.
- **Gap G1 academic retrieval & evidence assembly**: no Europe PMC / academic
  connectors, no evidence-span objects, no scheduled literature watch → 15.
- **Gap G2 analysis execution surface**: run_code cold-starts each time; no
  persistent kernel, no plotting surface, no machine-readable results
  contract → 16.
- **Gap G3 run provenance**: no uniform record per computed run (data version /
  parameters / code version / environment / artifact hashes), so a goal gate
  has no evidence pointer → 17.
- **Gap G4 compute backend**: no HPC/batch submission, no compute-level
  resume-from-checkpoint; an 18.9 h-class task cannot be carried inside a
  session → 18.
- **Gap G5 hypothesis/evidence graph**: no first-class hypothesis, no fact-
  admission authority → 19.
- **Gap G6 citation attribution**: no three-layer attribution gate behind
  citation-looking output → 20.
- **Gap G7 shape of domain knowledge**: no "machine-readable config +
  preflight" domain-pack spec; prompt-stuffing is a known anti-pattern → 21.
- **Gap G8/G9 domain landing**: neither genomics tooling (VCF/GWAS/GS) nor
  public data-source adapters (NCBI/Ensembl et al.) exist → 22/23.

## Design

### Surfaces and seams (verified + cited)

The charter itself adds no seams; every dsh surface reused by 15–23 was verified
with line refs (see Motivation ①). Each unit document re-verifies, at line
level per doc 01's discipline, the seams it consumes. New seams concentrate in
three places: 15 introduces external academic APIs (pure egress, tenet a);
17 introduces a run-record store (local, append-only; integration points with
03/04); 18 introduces a submitter-backend abstraction (local executor as the
reference implementation, HPC adapter deferred). Except for the marked
integration points, all packages keep compile-time zero dependency on
dsh-cc-plugins, honoring doc 00 tenets 1/4/6.

### Eight-stage workflow → dsh capability mapping

This table is the master map of 14–23; the stage skeleton follows the
synthesis page's Appendix A cheat-sheet.

| Stage | Literature anchor | dsh status quo | New item |
|---|---|---|---|
| Data readiness | SciHorizon-DataEVA (criteria execution + self-correction) | generic fs/shell; no domain data contract or QC surface | 23 (readiness criteria expressed via 21 preflight) |
| Literature evidence | EMBL AI Librarian; SLR screening κ=0.52–0.77 (the inclusion gate needs audit) | generic web_search; no academic stores, no evidence assembly, no watch | 15 |
| Hypothesis formation | ECLAIR (auditable structured hypotheses); HEP (registry + `P(H)`); Auditing RAG (stable evidence IDs) | no first-class hypothesis/evidence objects | 19 |
| Experiment execution | Vibe-FDTR (packaging + config preflight); quantum sensing (18.9 h; deterministic code controls hardware) | generic run_code/bash/jobs execution; no HPC backend, no compute-level resume | 18 (local executor first) |
| Data analysis | Prompt-to-Paper (canonical `results.json`) | run_code cold starts; no persistent kernel or result contract | 16 |
| Writing & reporting | Prompt-to-Paper (8-dim scorer + hallucination penalty) | none | W3 `science-report`, not chartered this round |
| Review & verification | Cited but Not Verified (Link/Relevant/Fact triple) | 02 claim-contracts does generic claim checking; no citation-attribution gate | 20 |
| Discovery loop | Danus (verifier-gated fact graph); OpenProver (machine-checkable acceptance) | 04 goal-verify-gate has no experiment-evidence pointer | 19 + 20; 04 mounts 17's run evidence |

### Unit matrix

| # | Name | Package | Depends on | Wave |
|---|------|---------|-----------|------|
| 15 | [literature-evidence](15-literature-evidence.md) | science/literature-evidence | 01 | W1 |
| 16 | [analysis-workbench](16-analysis-workbench.md) | science/analysis-workbench | 01, 17 | W1 |
| 17 | [run-provenance](17-run-provenance.md) | science/run-provenance | 01; integrates 03/04 | W1 |
| 18 | [hpc-runner](18-hpc-runner.md) | science/hpc-runner | 01, 17 | W1 |
| 19 | [evidence-registry](19-evidence-registry.md) | science/evidence-registry | 01, 02 | W2 |
| 20 | [citation-verify](20-citation-verify.md) | science/citation-verify | 01, 15 | W2 |
| 21 | [domain-pack](21-domain-pack.md) | science/domain-pack | 01, 05, 08 | W2 |
| 22 | [breeding-genomics-toolkit](22-breeding-genomics-toolkit.md) | breeding/genomics-toolkit | 21, 16, 18, 10 | W2 |
| 23 | [breeding-data-adapters](23-breeding-data-adapters.md) | breeding/data-adapters | 21 | W2 |

(Link targets land as each unit is chartered; link existence is kept in sync
with the doc-00 table by `pnpm check:spec-deps`.)

### Data model / configuration

The charter pins only two cross-unit fixtures; field details belong to the unit
docs:

- **Run record (owned by 17, consumed by 04/16/18/22)**: one append-only record
  per lineage-managed run, carrying at least data-version pointer, parameters,
  code version, environment fingerprint, artifact hashes, and verifier outputs;
  04 goal-verify-gate's `complete` may mount a "run evidence pointer"
  (tenet b). Aligning this schema with 03's trace events is an open question of
  17 (see Risks).
- **Manifest annotation convention (extends 01; no second registry)**: every
  external academic-API tool introduced by 15/22/23 registers in 01
  tool-manifest with `effectClass: 'readonly'` plus an egress=read-only
  annotation (GET-only; no POST/PUT) (tenet a); 16's kernel/plot tools are
  classed by their real side effects; 18's submitter defaults to
  `side-effecting` + `timeout-ambiguous` (same basis as 01's built-in entry
  for `jobs`).
- **Three-position gates, uniform**: both 20's attribution gate and 21's
  preflight ship `off / audit / enforce`, per doc 00 tenet 3.

### Key behavior flows

- **Literature loop (15 → 20)**: `schedule_create` fires the watch → candidate
  queue → ingestion (full text/abstract + metadata) → evidence assembly (stable
  evidence IDs) → every citation in a report or answer passes 20's three-layer
  attribution gate (Link/Relevant/Fact) → assembly and attribution results join
  17's lineage.
- **Compute lineage flow (shared by 16/18/22)**: preflight (21) → submit (local
  executor or HPC adapter) → 17 opens a run record → execution (16 persistent
  kernel; 18 resume-from-checkpoint) → canonical `results.json` + figures →
  record closes → 04 gate verifies via the run pointer.
- **Domain injection flow (21)**: a domain-pack = machine-readable config (data
  contracts / QC criteria / default pipeline parameters) + procedural skills +
  manifest entries; loading runs preflight range checks, and failing them bars
  entry into execution — replacing prompt-stuffing.

### Shared design tenets (research-specific)

Doc 00's six tenets bind this package in full; four more are added for the
research setting:

- **a. All external academic APIs are GET-only**, annotated egress=read-only in
  01 tool-manifest; external systems that require writes (submission,
  annotation stores) are out of this package.
- **b. The uniform carrier of empirical evidence is 17's run record**; 04's
  `complete`, 16's `results.json`, and 22's breeding-value reports must all be
  able to mount a run evidence pointer — artifacts without pointers do not
  enter gate vocabulary.
- **c. Claim strength ↔ verifier strength tiers** (annotation / rule /
  execution re-check / domain audit / formal verification) expressed via the
  manifest + 20's attribution gate; every gate keeps off/audit/enforce; the
  enforce-level default of 19/20 reads "discovery-grade claims require an
  executable or machine-checkable verifier".
- **d. Domain knowledge is injected exclusively as a 21 domain-pack**
  (machine-readable config + preflight); prompt-only domain infusion is this
  package's named anti-pattern — the Vibe-FDTR ablation (98.9%→36.7%) is its
  quantified cost.

## Milestone split

The charter itself has no code milestones; the split is the wave plan.

- **W1 (analysis & lineage substrate, 15–18)**: 15/17 lead; 16 depends on
  01+17; 18 depends on 01+17. Wide parallelism is allowed, but 16/18's single
  evidence outlet must be 17 — no private record surfaces may grow first.
  Exit criterion: the genomic-selection MVP flow (Verification plan) runs
  through.
- **W2 (evidence governance & domain landing, 19–23)**: 19 → 20; 21 → 22, 23.
  Exit criterion: the literature loop passes its gate at enforce level; an
  end-to-end genomic-selection run (data adaptation → QC → GBLUP →
  cross-validation → report whose citations all pass the attribution gate).
- **W3 roadmap (listed only, NOT chartered; each triggers its own chartering
  per the doc-00 process)**:
  - `science-report`: when 16's `results.json` contract has been stable on a
    real project for ≥ 2 weeks and 20's attribution gate has enforce-level
    telemetry.
  - `debate-orchestration`: when 19's evidence graph contains a real case of
    verifiers disagreeing on one claim (competing interpretations) and
    adversarial orchestration is needed to adjudicate.
  - `mcp-server`: when a concrete demand appears to expose the 15/17/19
    surfaces to other agents/tools (with only mcp-client in dsh today, reverse
    demand is what would determine a server's shape).
  - `breeding/field-data`: when the genomic-selection MVP passes acceptance and
    the team fixes the field-data collection process (instruments / sheet
    conventions).

## Verification plan

The charter's verification = **overall acceptance**, stacked on top of each
unit's DoD:

1. **Project-level MVP acceptance (manual, on real machines)**: inside
   breeding-ai-workspace `projects/genomic-selection`'s seven-slot skeleton,
   run small-dataset QC → GBLUP → cross-validation, yielding a `results.json`
   conforming to 16's contract; every run lives under 17's lineage and 04
   goal-verify-gate's `complete` cites a run evidence pointer.
2. **Literature-loop acceptance**: 15's scheduled watch yields a candidate
   queue → ingestion → evidence assembly → 20 citation-verify gates it;
   attribution failures produce a readable three-layer report
   (Link/Relevant/Fact), and at enforce level one constructed
   "link-resolves-but-does-not-support" case is intercepted.
3. **Unit acceptance rule**: each unit passes when every box in its own
   document's "unit acceptance (DoD)" section is checked; the charter never
   substitutes for a unit DoD.
4. **Automated gates**: landing in the repo requires the husky pre-commit
   battery (verified `.husky/pre-commit`): `pnpm check:spec-deps` /
   `pnpm typecheck` / `pnpm test` / `pnpm check:subagent-paste` — four greens.

## Risks and open questions

- **HPC site heterogeneity**: Slurm/PBS/cloud-batch auth, quotas and container
  policies are not individually verified; 18 ships a local executor as the
  reference implementation, and the HPC adapter's chartering requires real
  cluster accounts first.
- **Academic API quotas & ToS**: Europe PMC, NCBI E-utilities etc. each impose
  rate limits and terms; 15 needs per-source throttling and caching, with
  offline fixtures as the test default.
- **17 ↔ 03 event-schema boundary**: run records and trace events overlap
  (both describe "one execution"); 17's chartering must align with 03's schema
  to avoid dual writes drifting apart.
- **domain-pack config-surface bloat**: the config schema risks evolving into a
  "second rule language" (same concern as 01's content-level glob); 21 must
  explicitly delimit "what config governs vs what skills govern".
- **Wet-lab loops are out of scope**: quantum-sensing-style "deterministic code
  controls hardware" exceeds 14–23; 18 only builds compute backends and never
  touches instruments.
- **Data licensing**: permission/privacy boundaries of breeding genotype/
  phenotype data are backstopped by 23's manifest annotations, but per-source
  license review is a process matter this package cannot close.
