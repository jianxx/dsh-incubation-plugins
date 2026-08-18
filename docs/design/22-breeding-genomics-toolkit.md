# 22 breeding-genomics-toolkit — Breeding Genomics Compute Toolkit (first domain-pack instance)

> Status: design (not started) | Tier: 4 (domain instance layer) | Package: packages/domain/breeding-genomics-toolkit | Depends: 01 tool-manifest, 10 verified-tools; 14 evidence-spine, 16 analysis-workbench, 17 run-registry, 18 hpc-runner, 21 domain-pack spec (all being written in parallel — final versions govern); Companion: 23 breeding-data-adapters | Consumers: breeding-ai-workspace (CAAS intelligent design-breeding team) `projects/genomic-selection` and subsequent breeding projects

## Design Goals and User Problem

**Goal**: be the first domain instance of the 21-domain-pack spec (being written in
parallel; final version governs) and add the missing "compute layer" to
breeding-ai-workspace — wrap genotype QC / imputation / GWAS / genomic selection (GS)
pipelines as dsh tools with idempotency keys, resource-magnitude annotations, and
mandatory run lineage. Two iron rules:

1. **Wrap mature tools, never re-implement statistical algorithms** (plink2 / bcftools /
   Beagle / minimac4 / rMVP / GAPIT3 / R sommer / the BLUPF90 family);
2. **Statistical and parameter decisions stay human-in-the-loop** — MAF/HWE thresholds,
   GWAS model choice, GS model family, cross-validation folds are scientific judgments:
   the agent proposes, a human confirms, and the gate rides the approval layer
   (shared principle 1); enforcement strength follows the off/audit/enforce spectrum
   (shared principle 3).

**User problem**: the breeding team's agent workspace is strong on the literature/memory
plane today (paper scans, ingestion, wiki forensics, reproduction state machines), yet it
cannot run a single GBLUP — there are no scientific-computing dependencies at all, and
the seven-slot skeleton of `projects/genomic-selection/` is still `.gitkeep` placeholders.
Without a wrapping layer, agent-driven compute today looks like: ad-hoc bash calling
plink, parameters scattered across chat history; a network hiccup on rerun means duplicate
compute; results carry no run_id, no sidecar, no lineage; and nobody can tell who decided
each statistical threshold. What users want is a **replayable, traceable, human-endorsed**
qc → imputation → GWAS/GEBV pipeline.

## Motivation

Three verified facts justify the work item:

1. **The workspace is mature on literature/memory and blank precisely on compute.**
   `skills/INDEX.md` in breeding-ai-workspace registers 8 active skills (paper-scan over
   arXiv+OpenAlex, paper-ingest, wiki-query, the paper-reproduce state machine,
   innovation-scan, etc.), all facing papers and knowledge; `pyproject.toml` has only a
   dev dependency group `[pre-commit, PyYAML]` — zero GWAS/GS/scientific dependencies.
   The first compute project `projects/genomic-selection/` plans the full pipeline
   "reference-population genotypes+phenotypes → GBLUP/ssGBLUP EBV/GEBV estimation →
   cross-validated r/bias → output/ reports" in its README, but all seven slots hold only
   `.gitkeep`. The compute layer is exactly where this package plugs in.
2. **The value of compute wrapping is orchestration and lineage, not algorithms.**
   The statistical correctness of GBLUP/ssGBLUP/GWAS directly drives selection decisions,
   and mature implementations have been validated repeatedly by the domain; rewriting
   them only adds risk. The agent's marginal value is: canonicalized parameters,
   idempotency so no compute budget is burned twice, complete replayable lineage, and
   recorded threshold decisions — precisely what the 01/10 base layers already provide
   generically; this package only instantiates them for the domain.
3. **Statistical decisions must stay human-in-the-loop.** Choosing FarmCPU vs MLM for
   GWAS, GBLUP vs ssGBLUP for GS, loosening or tightening QC thresholds — these are
   scientific, not engineering, judgments. The workspace's own `rules.yml` contract
   (schema_version: breeding.rules/v1) is the reserved home for such deterministic hard
   rules; this package's decision gating aligns with it: the agent proposes, a human
   (via the approval layer) decides, and the outcome lands in the project sidecar and
   event log.

## Status Quo and Gap

### dsh core and incubation base (each seam verified, file:line)

- Tool registration/enumeration and the `tools/execute` wrapping seam: see
  01-tool-manifest §Surfaces-and-Seams and 10-verified-tools §Surfaces-and-Seams (both
  verified with line numbers). The four domain tools here are ordinary dsh tools:
  registered via `ctx.tools.register`, with idempotency / argument pre-validation /
  verify-before-retry reused from 10's generic wrapper — not rebuilt in this package.
- **ASK gating**: `ctx.approval.request(...)` →
  `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
  (`deepseek-harness/packages/interaction/user-approval/src/index.ts:257`; outcome type
  `types.ts:28`). Note `request()` must happen inside an open turn; answerer-less
  environments (subagent / background) return `'unavailable'` → fail-closed (see risk 7).
- **Command execution**: via the `@deepseek-ai/dsh-shell` abstraction
  `run(spec: ShellExecSpec): Promise<ShellRunResult>`
  (`packages/shell/shell/src/index.ts:93`), under sandbox semantics — never bare
  `child_process`.
- **Telemetry**: the `session-telemetry/record` waterfall
  (`packages/session/session-telemetry/src/index.ts:43`); tool executions, decision
  gates, and idempotency hits from this package enter the unified event stream as ledger
  records (shared principle 5).
- **State persistence**: `writeFileAtomic`(`packages/fs/fs-local/src/index.ts:36,200`);
  domain-level caches (reference panels, engine image metadata) live under the harness
  HOME: `dshHomePath('domain-breeding', ...)`
  (`packages/util/home-paths/src/index.ts:98`, `DSH_HOME_DIR_NAME='.dsh'` at `:12`).
- **14 / 16 / 17 / 18 / 21**: the evidence-spine master doc ("unified carrier of
  empirical evidence"), the local analysis workbench (dataset tools), the run registry
  (run_id / run_get), the HPC submitter, and the domain-pack spec + validator are all
  being written in parallel; this package integrates only against their **work-item
  names and agreed responsibilities** — final interfaces follow their final drafts
  (see risk 8).

### breeding-ai-workspace (each item verified)

- `skills/INDEX.md`: 8 active skills, all on the literature/memory plane (motivation 1).
- `pyproject.toml`: only dev dependencies `[pre-commit, PyYAML]`; zero scientific
  computing capability.
- `projects/genomic-selection/README.md`: seven-slot reference implementation, still
  placeholder; goals include the GBLUP / ssGBLUP / BayesB / RR-BLUP model families,
  EBV/GEBV outputs, and tracking prediction accuracy r and bias; it explicitly defers to
  `docs/data-sources.md` for dataset contracts and does not copy schemas.
- Seven-slot contract (`docs/specs/2026-06-26-breeding-ai-workspace-design.md` §4.4):
  `raw/` is the **immutable** input slot (dated names `YYYY-MM-DD-<source>-<slug>`),
  `output/` holds deliverables (dated `<date>-<artifact-type>-<slug>`), `tools/` holds
  project-private scripts. This package's artifacts follow that layout — no parallel
  directory conventions.
- Sidecar / event contract (`tools/trace-analyzer.py:35-82,196-198`): each run writes
  `output/<id>.events.ndjson` paired with `<id>.run.yml` (manifest carries
  `checks.required[].gate_id`, `skills.invoked` / `skills.skipped`); event types include
  `run.finished` (status=done), `gate.finished` (gate_id+status),
  `command.finished` (command_id+exit_code), `gate.result`; AGENTS.md additionally
  requires `decision` and `evidence.used` events at key decision points.
  **When running inside the workspace, this package's sidecars/events must be
  isomorphic, or trace-analyzer checks such as `gate_not_run_but_done` silently stop
  working.**
- `docs/data-sources.md`: the registration template is in place, but every entry is
  "to be registered" — filled by 23 breeding-data-adapters; this package consumes the
  dataset descriptors 23 produces (below).

**Gap summary**: the workspace has an input slot (raw/), a lineage contract
(sidecar + events), and a literature brain — the missing layer is a compute tool surface
that wraps mature bioinformatics engines, carries idempotency and lineage out of the box,
and gates statistical decisions. This package is that layer.

## Design

### Surfaces and Seams

**dsh.domain.yml (domain manifest)**: per the 21-domain-pack spec (parallel; final
governs), declares this pack's tool list and preflight tiers; preflight results feed the
21 validator:

```yaml
apiVersion: dsh.domain/v1        # final per the 21 spec
pack: breeding-genomics-toolkit
tools: [genotype_qc, plink_filter, impute, gwas, genomic_prediction]
preflight:
  engines:                        # each slot is required / either-or
    genotype_qc:        { any_of: [plink2] }
    file_ops:           { any_of: [bcftools, vcftools] }
    impute:             { any_of: [beagle, minimac4] }
    gwas:               { any_of: [rMVP, GAPIT3] }          # R packages, R>=4.2
    genomic_prediction: { any_of: ["R+sommer", blupf90] }   # sommer preferred
  environment:                    # exactly one of the two tiers
    backend: conda                # or container
    conda:     { env_file: environment.yml, lock_sha256: <hex> }
    container: { image: registry.example/breeding-gs:2026.06, image_sha256: <hex> }
  licenses:
    blupf90: user-provided        # academic license, not redistributed (risk 3)
```

**Four domain tools × manifest (01) annotations**: each tool is verified-tools shaped —
an ordinary dsh tool plus a 01 manifest entry. Open item: 01's entry schema defines no
resource-magnitude field, so this package attaches an `x-resources` extension field on
its plugin-declared entries (unknown-field tolerance to be verified against 01's final
draft — see risk 4):

| Tool | Engine | effectClass | idempotency.argFields | x-resources (typical magnitude) |
|---|---|---|---|---|
| `genotype_qc` | plink2 | write-local | `[inputs_digest, params]` | 2-4 cpu / 8 GB / minutes (5k×50k SNP) |
| `plink_filter` | plink2 | write-local | same | same |
| `impute` | beagle \| minimac4 | write-local | same (incl. reference-panel pointer) | 8-32 cpu / 32-128 GB / hours |
| `gwas` | rMVP \| GAPIT3 | write-local | same (incl. model params) | 4-16 cpu / 16-64 GB / ten-minutes to hours |
| `genomic_prediction` | sommer (R) or blupf90 | write-local | same (incl. CV folds/seed) | 4-16 cpu / 16-128 GB / ten-minutes to hours (ssGBLUP see risk 2) |

All entries: `disclosureClass: 'none'` (compute tools never initiate egress; external
data acquisition belongs to 23, egress policing to 09 token-wall);
`failureSemantics: 'timeout-ambiguous'` with retryProbe = the output directory's
`.done.json` marker exists and its sha256 checks pass (10's flow-2 mechanism).

**Physical seams with the workspace** (verified — see "Status Quo and Gap"): input files
always live in the project `raw/` slot (or are referenced via 23 descriptors; immutable);
artifacts land in `output/`; the `.run.yml` sidecar + `.events.ndjson` stay isomorphic;
a run_id (17) is mandatory for lineage.

**Execution backends**: local small data (default threshold ≤5k samples × 50k SNPs,
configurable) runs on 16 analysis-workbench's local execution surface; above that, the
package renders 18-hpc-runner submit templates (sbatch / bsub, shipped under
`templates/hpc/`) and submits. Scale threshold, queue names, and accounts are
profile-level config — never hardcoded.

### Data Model / Configuration

**Input data contracts** (uniform schemas, published as JSON Schema under `schemas/`;
23's descriptor `schema_ref` points here; 16 dataset tools consume the same schemas):

- **genotype**: VCF (`.vcf.gz` + tabix index) or a PLINK triple (bed/bim/fam);
  versioned schema id `breeding.genotype/v1`.
- **phenotype csv** (minimal column set + validator): one trait per file;
  required columns `id` (individual, unique non-empty) and `trait` (numeric phenotype);
  optional columns `env` (environment/site/year batch) and `block`.
  Validator behavior: duplicate id → fail; non-numeric trait → fail; env/block must be
  either entirely absent or explicitly `NA` — half-missing → fail (prevents silent model
  formula changes); schema id `breeding.phenotype/v1`.
- **pedigree** (optional): three columns `id,sire,dam`, founders may be blank; schema id
  `breeding.pedigree/v1` (required by ssGBLUP, unused by GBLUP).

**Idempotency key recipe** (tool-level, complementary to 01's `idempotency` mechanism —
01 dedups arguments within a session; this recipe dedups compute across sessions):

```ts
inputsDigest = sha256( concat( sort( inputs.map(f => f.sha256) ) ) )
idemKey = sha256({
  tool, engine, engineVersion, environmentHash,   // conda lock / container image
  inputsDigest, canonical(params)                 // sorted keys, normalized numbers
})
// if the output dir holds a .done.json with the same idemKey → short-circuit and
// return the existing result pointer; never recompute
```

`.done.json` contents: `{ idemKey, engineVersion, outputs: [{path, sha256}],
run_id, finished_at }` — it doubles as postcondition evidence for 10 verified-tools
retryProbes and as the anchor 17 lineage replay reads.

**Profile-level configuration**:

```ts
breedingGenomics: {
  statsGate: 'off' | 'audit' | 'enforce'   // statistical-decision gate, default audit
  backend: 'local' | 'hpc'                 // local → 16; hpc → 18 submit templates
  scaleThreshold: { samples: 5000, snps: 50000 }  // above this → hpc
  engines: { impute: 'beagle', gwas: 'rMVP', gs: 'sommer' }  // either-or defaults
  referencePanel: { descriptorRef?: string } // points at a 23 dataset descriptor
  resources: { hpc: { queue, account, walltime } }           // for 18 templates
}
```

### Key Behavior Flows

**Flow 0 — preflight** (reused by the 21 validator): probe each `any_of` engine slot
(`plink2 --version` / `Rscript -e 'packageVersion("sommer")'` etc.), verify the conda
lock / container image hash matches dsh.domain.yml, and check that the BLUPF90 license
path exists and is non-empty; emit a preflight report JSON (per-slot pass/fail + actual
versions). Any required slot failing → the tool registers in a degraded
"registered-but-refuses-to-execute" mode and the report goes to the ledger.

**Flow 1 — generic execution flow** (shared skeleton of all four tools):

1. Argument schema pre-validation (10's `tools/pre-execute` mechanism; violations →
   deny + corrective feedback).
2. **Mandatory run attachment**: the execution context must carry a 17 run_id (injected
   by 16 / the agent session, or passed explicitly). No run → fail-closed with a hint to
   register a run first — this concretizes the 14 master doc's "unified carrier of
   empirical evidence": every compute artifact must be replayable via run_get.
3. Statistical parameters that count as "decisions" (thresholds / model families / CV
   folds) with statsGate=enforce → route into flow 2.
4. Compute the idemKey; if the output directory already holds a `.done.json` with the
   same key → short-circuit, returning `{ deduped: true, result: <.done.json digest> }`
   and logging `breeding.dedup-hit` to the ledger.
5. Backend selection: at or under threshold → local (16 surface); above → render an 18
   submit template and submit, returning a pending handle whose completion events are
   collected by 18 (parallel; final governs).
6. Engine execution: render the command template (plink2 / java -jar beagle.jar /
   Rscript driver script / blupf90+ parameter card), run via dsh-shell `run()` or 18;
   stdout/stderr archived.
7. Persist artifacts: result files (dated names per the seven-slot contract) +
   `.done.json` (writeFileAtomic) + sidecar/events: `command.finished` (exit_code),
   `gate.finished` (e.g. `gwas-schema-check`), closing `run.finished`;
   `session-telemetry/record` logs duration / resources / engine version.

**Flow 2 — statistical-decision gating** (statsGate, three tiers):

- The agent generates a proposal: `{ decision: 'maf-threshold', value: 0.05,
  rationale: '...', expectedImpact: '...' }`;
- `enforce`: `ctx.approval.request({ reason: <proposal summary> })` →
  `allowed-once` executes; `rejected/cancelled` aborts with a receipt; `unavailable`
  (background, no answerer) fails closed and the proposal lands in the `.run.yml`
  `pending_decisions` list awaiting human ratification;
- `audit`: executes directly, logging the proposal as a `decision` event +
  `evidence.used` in `.events.ndjson` (fields established by the workspace AGENTS.md);
- `off`: no proposals generated (not recommended; debugging only).

**Flow 3 — genomic-selection reference chain** (end-to-end example):

1. A 23 adapter fetches genotype VCF + phenotype csv; the descriptor lands in
   `data/<dataset_id>/`; the project registers a dated reference under `raw/`.
2. `genotype_qc`: maf≥0.05, missing≤0.1, HWE p≥1e-6 (after statsGate confirmation).
3. (Optional) `impute`: Beagle template + `referencePanel.descriptorRef`.
4. `genomic_prediction`: GBLUP (R sommer `mmer`/`mmer2` kernels; A/G matrix
   construction, variance components, GEBV output) + 5-fold cross-validation (fold seed
   fixed and folded into the idemKey), per-fold r and bias summarized into
   `results.json` (16 dataset/results schema, final governs).
5. Artifacts: `output/<date>-gebv-report.md` + `.run.yml` + `.events.ndjson`;
   a trace-analyzer pass returns no high findings.

## Milestones (each M = one PR)

- **M0 — package skeleton + dsh.domain.yml + preflight + synthetic fixture factory**:
  `pnpm new:plugin domain breeding-genomics-toolkit` scaffold; domain-yml loader;
  flow 0 in full; the fixture generator (fixed-seed simulated PLINK/VCF genotypes of
  200 samples × 1k SNPs + simulated phenotypes, reused by every later milestone's unit
  tests); phenotype/pedigree validators.
  Verify: driver = unit tests (preflight function on a mock ctx) + fixture-generator
  unit tests; observable = a preflight report JSON listing per-engine hits/misses and
  environment hashes, fixture outputs passing the validators; pass = with no engines
  installed the report fails clearly and names each missing engine, and two fixture
  generations are byte-identical (fixed seed).
- **M1 — genotype_qc + plink_filter**: plink2 wrapping, parameterized QC thresholds
  (maf/hwe/missing), VCF↔PLINK conversion (bcftools/vcftools tier), flow 1 in full
  (local backend).
  Verify: driver = M0 fixture unit tests; observable = post-QC bed/vcf passing schema
  validation, `.done.json` carrying the idemKey; pass = rerunning identical args
  triggers dedup (engine process count === 1), and a call without run_id is rejected
  with a hint.
- **M2 — impute**: Beagle/minimac4 command-template rendering, reference-panel
  descriptorRef resolution, imputed VCF feeding back into the qc chain.
  Verify: driver = fixture (Beagle unreferenced mode without a panel) + template-render
  snapshot tests; observable = imputed VCF genotype-completeness checks pass, rendered
  templates match snapshots; pass = a missing engine makes preflight fail and the tool
  refuse execution.
- **M3 — gwas**: rMVP/GAPIT3 R driver scripts (FarmCPU/BLINK/MLM parameterized),
  Manhattan/QQ plot artifacts, gwas result csv schema (marker, chr/pos, p, effects).
  Verify: driver = fixture + simulated QTL signal (phenotypes synthesized from 5 known
  loci); observable = result csv passing schema validation, the synthesized signal loci
  entering top hits; pass = all 5 synthesized loci land within the top 1% of p-values
  (assertable on the fixture).
- **M4 — genomic_prediction + pipeline integration smoke**: GBLUP (sommer preferred,
  BLUPF90 family as an optional tier), ssGBLUP optional tier (+pedigree), candidate-set
  GEBV prediction, 5-fold CV summarized into results.json (r/bias); full-chain smoke
  qc → GBLUP → CV.
  Verify: driver = fixture full chain + integration test (local backend); observable =
  results.json passing the 16 results schema (final governs), 17 run_get replaying the
  full lineage (final governs); pass = CV correlation r > 0 on the fixture (should be
  well above zero under synthesized signal), lineage tree complete (every intermediate
  artifact has a sha256 and a run_id).

## Verification Plan

1. M0–M4 acceptance criteria live in each milestone's "Verify" line; all unit tests run
   on synthetic fixtures — no real data or network needed.
2. **Integration smoke** [auto]: public small data (rice 3K subset, or an enlarged M0
   fixture; the shipped `scripts/fetch-fixture.sh` pulls it via 23's NCBI adapter) runs
   qc → GBLUP → 5-fold CV, producing results.json (passing the 16 schema) + complete
   lineage (replayable via 17 run_get).
3. **Workspace alignment check script** [auto]: asserts the target project's seven-slot
   directories, sidecar `.run.yml` fields (`checks.required[].gate_id`,
   `skills.invoked/skipped`), and `.events.ndjson` event types (run.finished /
   gate.finished / command.finished / decision / evidence.used) match trace-analyzer's
   expectations; must pass on breeding-ai-workspace's `projects/genomic-selection/`.
4. **First real internal-data run** [manual]: checklist in Definition of Done.
5. Regression gates: `pnpm typecheck && pnpm test && pnpm build` all green (shared
   principle 6).

## Risks and Open Questions

1. **Authorization and data compliance**: define the authorization boundary for internal
   breeding data (genotypes/phenotypes/pedigrees) first; the package ships no internal
   database connections; credentials come from environment variables / warm-up commands
   only (echoing the workspace data-sources.md rule "never write secrets into the repo").
2. **ssGBLUP large-matrix memory**: H-matrix memory ≈ 8·N² bytes (50k individuals ≈
   20 GB, 100k ≈ 80 GB). Ship a resource-guidance table and rewrite x-resources
   dynamically by N; above the local threshold, force the hpc tier.
3. **BLUPF90 license**: academic license, non-redistributable — preflight only checks
   that the user-provided path exists and works (a [manual] asset); the package carries
   no binaries; commercial deployment terms remain the licensee's responsibility.
4. **Manifest extension fields**: 01's entry schema does not define `x-resources`;
   loader tolerance for unknown fields must be verified against 01's final draft; if
   intolerant, fall back to machine-readable JSON embedded in `description`
   (settled by an M0 spike).
5. **R-ecosystem pinning**: rMVP/GAPIT3/sommer version drift destroys idempotency-key
   semantics — the conda lock or renv.lock must ship with the package; the container
   tier keys on the image sha256, and bumping the image requires an explicit PR.
6. **Imputation engine sensitivity**: Beagle's unreferenced mode suits only small gaps;
   minimac4 needs an m3vcf reference panel. Preflight can only shallow-check file
   existence; panel/population matching is judged by the human via the statsGate.
7. **Approval `unavailable` in background environments**: under enforce, statistical
   decisions fail closed into pending_decisions; if practice shows a collapsing
   experience, evaluate "auto-dropping background runs to audit + a mandatory pending
   list" after M4.
8. **Interface drift in 14/16/17/18/21**: all five are being written in parallel; every
   integration point of this package (results schema, run_id injection, submit
   templates, domain.yml apiVersion) is isolated behind an adapter layer, so only that
   layer changes when they finalize; sequencing guarantees M0/M1 depend only on the
   already-existing 01/10.

## Unit Acceptance (Definition of Done)

- **[auto] Integration smoke**: public small data (rice 3K subset or enlarged synthetic
  fixture, fetched by the shipped `scripts/fetch-fixture.sh`) runs qc → GBLUP → 5-fold
  cross-validation, producing results.json that passes the 16 results schema (final
  governs), with complete lineage — 17 run_get replays every intermediate artifact's
  sha256 and run_id.
- **[auto] Workspace alignment check**: a script asserts the breeding-ai-workspace
  seven-slot directory contract, `.run.yml` sidecar fields, and `.events.ndjson` event
  types are trace-analyzer compatible (passes on `projects/genomic-selection/`,
  exit 0).
- **[manual] First real internal-data run checklist**:
  (a) data authorization / approval records in place; (b) cluster submission via 18
  hpc-runner templates, with the submit command human-reviewed before execution;
  (c) with statsGate=enforce, every statistical decision carries a human approval
  record; (d) results (CV r/bias, GEBV ranking) signed off by domain reviewers;
  (e) sidecars/events committed back into the project repo, trace-analyzer reporting
  no high findings.
