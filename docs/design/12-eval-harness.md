# 12 eval-harness — credit discipline for harness evolution

> Status: design (not started) | Tier: 3 | Packages: packages/eval/eval-harness + scripts/bench/ | Depends on: the event schemas of 03, 11
> Verified seams against deepseek-harness **0.1.0-rc.7** (@99f6f02fec); path:line citations refer to that tree.

## Design goal and user problem

**Goal**: lay a credit-discipline rail for this repository itself — any claim that "plugin X improved outcomes" must pass: budget-matched baselines, the three deterministic gates validity/activation/significance, held-out selection with a sealed test evaluated exactly once, and accepted patches archived by (where × why) pathology.
**User problem**: all 13 work items in this repo modify the same harness, and today neither contributors nor maintainers have any mechanism to separate a real improvement from a search-budget artifact — a PR claiming "evolution worked" may simply have spent more tokens; without this rail, a repo whose entire theme is harness evolution is itself practicing the undisciplined counterexample.

## Motivation (Rethinking's 67.4<72.3 warning: undisciplined evolution is search-budget self-deception)

Every work item in this repo (docs 01–13) evolves the same harness: 01/02/03 build the verification stack, 04/05/06 drive long-horizon tasks, 07/08/09 govern — every plugin is a "harness patch". This repo's own thesis (observation-driven harness evolution) must be honored inwardly: without credit discipline, these evolutions are nothing but search-budget self-congratulation.

The conclusions of Rethinking Harness Evolution are engraved here:

- Harness evolution **is fundamentally a form of search**. Under the same budget, budget-matched controls show evolution **losing to** parallel sampling (67.4 < 72.3) and sequential refinement (75.8/86.2 vs 84.3/91.8) — in other words, the value of a patch claiming "evolution works" may be nothing more than the extra tokens spent; plain parallel sampling beats it.
- Without discipline, held-out transfer collapses to +0.6 pass@1 — harness gains fitted on the diagnostic set leave almost nothing on unseen tasks.

GSME provides the protocol that fixes this credit problem: the proposer reads failure traces, annotates the pathology, and writes candidate patches; **credit is not judged by feel but by three deterministic gates** — validity (re-run + infrastructure-damage check), activation (the patch actually fired), significance (paired trials at 2σ); the best harness is **evaluated on the sealed test exactly once**, and the sealed set is never used for diagnosis, parent selection, or early stopping; accepted patches are archived by (where × why) pathology rather than by task — this is how 86–147% held-out retention was achieved.

Demystifying Evals completes the engineering side: five cleanly layered objects — task/trial/grader/transcript/outcome; graders split into L1 outcome / L2 process / L3 model-graded / L4 human; **the harness config must be recorded into the transcript itself**, otherwise cross-model/cross-harness comparisons confound model differences with scaffolding differences — which is exactly the mistake this repo is most prone to after every plugin change. AHE/observability-driven optimization and APEX multi-layer co-evolution are background motivation for process metrics and are not expanded here.

## Current state and gaps

Verified (upstream dsh repo `/deepseek-harness`):

- There is a headless one-shot runner (`dsh --profile headless "task"`) plus llm-replay / llm-mock-server / agent-loop-testkit test infrastructure (see "Surfaces and seams").
- `BENCHMARK.md` is only 3 lines: it points at the Python SDK guide + `jsonrpc-agent/minimal.py` and demands "separate workspaces and session IDs". **It defines no task format whatsoever** — so this doc aligns with its execution surface (SDK + isolated workspace/session) instead of inventing a parallel task concept; that in itself is no excuse for the gap.
- This repo has vitest + presubmit gates + pnpm scaffolding; `scripts/` follows the node ESM script convention.

Gaps: (a) no task registry and no trial-transcript normalization layer — session.jsonl is a runtime artifact, not an evaluation artifact; (b) no budget-matched comparison mechanism, so any claim that "plugin X improved outcomes" is currently unverifiable; (c) no train/held-out/sealed split and sealing; (d) no pathology archive for accepted patches. docs 03 (trace-compliance metrics) and 11 (silent-failure flags) will provide the L2 process-metric schemas; this doc is written as their consumer-side seam (and runs in degraded mode before they land).

Scope honesty: this doc is **not** a general-purpose benchmark suite. It is the rail for this repo's evolution credit. L3 (model-graded rubric) and L4 (human) graders are optional and absent by default. Explicitly out of scope: creating a new public benchmark, a cross-repo general evaluation framework, a model-comparison portal. The memory bench pack (doc 24) extends THIS rail as a milestone family (availability-vs-use, tenure-crossover, delete-leak), adding task packs rather than a new harness.

## Design

### Surfaces and seams (verified + cited)

| Seam | Verified facts | References |
|---|---|---|
| Trial driver A (SDK) | `DeepSeekHarness(provider, model, max_tokens, cwd, session_root, cordis=Path)`; `.run(prompt, session_id=…)` returns `{final_response}`; session directory persists JSONL (including model requests and tool calls) | `deepseek-harness/examples/jsonrpc-agent/minimal.py`, `docs/user/guide/python-sdk.md` |
| Trial driver B (headless) | `dsh --profile headless "task"` runs one-shot to completion; stdout = the last non-empty assistant text; exit 0 ⟺ the final `turn/end` completed, otherwise 1; terminal error code+message goes to stderr; no listening port opened | `packages/bundle/headless/README.md` |
| Patch mounting (variant switching) | launcher syntax `dsh --profile <p> --patch <path.yml> [args]`; `--patch` is repeatable and its value must be a path; layer order = bundle layers → user layer → `--patch` overlays; cordis.yml line format `- id/name/inject/config`, supports `!!js` and `insert:` | `apps/cli/src/args.ts`(:58–68), `apps/cli/README.md`(:37), `packages/bundle/headless/cordis.patch.yml` |
| Session persistence | `@deepseek-ai/dsh-session-persistence-jsonl`, `config.root` required (commonly set to `$DSH_SESSION_ROOT`); layout `<root>/<project>/<session-id>/session.jsonl[.zstd]`; `compression: 'none'` yields plain line-readable jsonl; no delete API, files are append-only | `packages/session/session-persistence-jsonl/README.md` |
| Event subscription | `session/event` (cordis event, `ctx.on('session/event', (session, event) => …)`) verified attachable in practice (schedule/llm-retry); `session-telemetry/record` waterfall (`ctx.waterfall('session-telemetry/record', record, () => record)`) | `packages/schedule/schedule/tests/runtime.spec.ts`, `packages/session/session-telemetry/src/coordinator.ts:214` |
| Deterministic replay | llm-replay: a fixture is a recorded `session.jsonl` (`assistant/chunk` regrouped by (turn,step); header line `id`/`createdAt`); config `file`/`overrideFile`/`childFiles`/`providers`/`paceMs` (or `$DSH_SNAPSHOT_FILE`); after sorting by header `createdAt`, **binds to the live session in first-call order**; `assertConsumed()` end-check verifies the script was fully consumed; throw/cancel/hang via the `replay.override.json` sidecar | `packages/test-support/llm-replay/README.md` |
| This repo's scaffolding | `pnpm new:plugin <group> <name>` → `@jianxx/dsh-incubation-<name>` at `packages/<group>/<name>`; gates: typecheck, vitest, check:exports, check:spec-deps | `scripts/create-plugin.mjs`, root `package.json` |

**Plugin vs script boundary** (60% tooling / 40% discipline): the plugin carries exactly one runtime job — the trial transcript exporter; everything else lives in `scripts/bench/*.mjs` + the root-level `bench/` data directory (registry/trials/variants/archive/results are all non-published artifacts and do not go into packages/).

### Data model / configuration

`bench/trials/<task>/<variant>/<run>.jsonl` — trial transcript. Header line (aligned with llm-replay's line-0 header convention, and with Demystifying's "config goes into the transcript" requirement):

```jsonc
// line 0 — fingerprint (all subsequent lines are normalized events)
{"id":"<trialId>","task":"<taskId>","variant":"<variantId>","run":3,"createdAt":"…",
 "fingerprint":{"repoHead":"<git sha>","plugins":[{"name":"@jianxx/dsh-incubation-trace-contracts","version":"0.1.0","configHash":"…"}],
  "settingsHash":"sha256:…","model":"deepseek-v4-pro","seed":null,"temperature":0.0,"patchFiles":["bench/variants/trace-on.cordis.patch.yml"]},
 "budget":{"maxTurns":40,"maxTokens":200000,"maxWallSeconds":1200}}
```

Fingerprint note (rc.7): `settingsHash` can now be computed from a real runtime
read — `ctx.settings.describe()` returns per-namespace resolved/base/user values
(`packages/settings/settings/src/index.ts:479`) — instead of hashing only the
composition file. Plugin VERSIONS, however, are still NOT runtime-introspectable:
plugin-inventory entries carry only entryId/moduleName/enabled/fiberPhase
(`packages/host/plugin-inventory/src/types.ts:17-22`), so versions keep coming
from the variant registry/lockfile.

`bench/tasks/{train,heldout,sealed}/<id>.yml` — task registry:

```yaml
id: fix-failing-tests-01
prompt: "Inspect the repository and fix the failing tests."
setup: {fixture: fixtures/repo-a.tgz, workspace: per-trial}       # runner unpacks into an isolated workspace
graders:
  l1: {kind: command, run: "pnpm --dir {workspace} test", expect: {exit: 0}}
  l2: [trace-compliance.no-undeclared-tool, silent-failure.no-swallowed-error]  # references doc 03/11 metric ids
  l3: null                                                        # optional model-graded rubric
budget: {maxTurns: 40, maxTokens: 200000, maxWallSeconds: 1200}
```

`bench/variants/<id>.yml` — harness variant descriptor: `{id, parent, patch (points to a cordis patch yml), status: baseline|candidate|accepted|archived, pathology?: {where, why}}`. Baselines (`parallel-sampling`, `sequential-refinement`) and plugin variants are declared in the same format.

### Key behavior flow (run→score→propose→three credit gates→sealed once→archive)

1. **run** (`scripts/bench/run.mjs`, pseudocode): load the matrix (task × variant × {seed,temp}); `budgetMatched = min over variants(task.budget)` → **first** lower every variant's cap for that task to the min, then start running. Per trial: unpack the fixture into an isolated workspace → set `DSH_SESSION_ROOT` + `compression: 'none'` → launch via SDK or headless + `--patch` → the runner watches the trial process and SIGTERMs it once the turn/wall cap is exceeded (recording `outcome: budget-exhausted`). After drain, the exporter (as a plugin, inline on session/event; the fallback is harvesting the persisted session.jsonl) writes `bench/trials/…`. When `deterministic: true` and the variant itself spawns no concurrent subagents, the first run also records a fixture, and subsequent controls replay through llm-replay.

2. **score** (`scripts/bench/score.mjs`): per-variant pass@k + cost (tokens/wall) + L2 process metrics (consumes the 03/11 flags; if they haven't landed, skip and mark `l2: unavailable`). Paired significance: align trials by (task, seed/temp, budget), count discordant pairs b/c McNemar-style, exact binomial → judge 2σ. The report template **mandatorily** appends the discipline checklist at the end (see next section).

3. **Three credit gates** (GSME; all deterministic, no manual exemption in lieu of running them):
   - validity: re-run the candidate variant N times; all transcripts schema-valid, no crashes, no infrastructure damage (session/event sequence intact, `turn/end` closed; infrastructure damage includes fixture leakage and out-of-bounds workspace writes).
   - activation: the plugin declared by the candidate patch **actually fired** on the diagnosed failing trials — as evidenced by plugin-attribution telemetry (records carrying plugin attribution in `session-telemetry/record`) or a flip of the 03/11 flags; zero activations ⟹ reject outright.
   - significance: reaches 2σ on budget-matched pairs relative to the baseline (parent variant).

4. **sealed once**: the best variant chosen in the selection phase (on held-out) is evaluated **only** once, on the sealed set; the result lands in `bench/sealed-results/` and never flows back into any diagnosis / parent selection / early stopping.

5. **archive**: variants that pass all acceptance gates go into `bench/archive/<where>__<why>/<slug>/` — pathology keyed by (where × why), not keyed by task. Each entry contains: patch diff (cordis overlay), path to the motivating failure trace, the quantitative results of the three gates, lineage (parent id). A miniature of GSME's quality-diversity map.

### Discipline protocol and mechanical guards

Protocol text (the "protocol" paragraphs of this section are the executable document — a human can read them and run, a machine can check them):

- **Budget matching is a first-class invariant**: for any comparison on the same task, if the two sides' transcripts differ in effective budget by > 0, refuse to produce a score (score.mjs exits 1 outright). Caps are uniformly lowered to the min **before** entering trials (budget caps must not be retrofitted after the fact). Rethinking's control arms (`parallel-sampling`, `sequential-refinement`) live permanently in the registry as runnable baseline variants — every candidate must first prove it is "not a search-budget artifact".
- **Three-way split**: `bench/tasks/train/` (diagnosis), `heldout/` (selection), `sealed/` (final evaluation). The sealed directory is hash-locked: the repo commits `bench/sealed.lock` (per-file sha256 + aggregate hash); `scripts/bench/check-sealed.mjs` is hooked into presubmit — (a) any file change under sealed without the whitelist marker `sealed-rotate` ⟹ fail; (b) any artifact in `bench/results/` or `bench/archive/` referencing a sealed task id or a sealed trace ⟹ fail; (c) `bench/sealed-results/` accepts only commits carrying the `sealed-run` marker with one file per task — anything else ⟹ fail.
- **Report checklist** (tail of the score.mjs template; any missing item turns red): `budgets matched? ✓ / baseline included? ✓ / held-out used for selection? ✓ / sealed intact (lock verified)? ✓ / transcript fingerprint recorded? ✓`.

## Milestone breakdown (each M = one PR-sized unit + "Verify:" criteria)

**M1: transcript exporter + task schema + 3 seed tasks + documented protocol.**
`pnpm new:plugin eval eval-harness` raises the skeleton; subscribe to `session/event` to write the normalized trial.jsonl (header-line fingerprint: plugin set + versions + settings hash + model + timestamp); 3 seed tasks under `bench/tasks/train/` (single-tool repair type, with L1 command grader + budget); the discipline protocol of this section written up under `docs/design`.
Verify: vitest unit tests cover fingerprint stability and event normalization; one real SDK trial produces a schema-valid transcript (manual smoke, command recorded in the README).

**M2: runner + enforced budget matching + baseline comparator configuration + paired-significance report.**
`scripts/bench/run.mjs` + `score.mjs`; budget-min lowering and mismatch rejection; the two baseline variants `parallel-sampling`/`sequential-refinement` runnable; McNemar + 2σ gate; report template with checklist.
Verify: use llm-replay fixtures to build an end-to-end fake evaluation, asserting — comparisons with mismatched budgets are rejected, a missing checklist item turns red, paired significance is numerically correct on constructed data.

**M3: sealed-lock CI + archive + one real docs 01–06 plugin comparative evaluation as dogfood.**
`check-sealed.mjs` lands in presubmit; archive directory and writer land; pick one already-landed plugin from 01/03 and run the full flow (propose→three gates→held-out selection→sealed once), writing the gate numbers into the first archive entry.
Verify: presubmit fails on a branch that deliberately breaks the sealed lock; the dogfood report's checklist is all green and sealed-results appears exactly once.

## Verification plan

- Unit tests (vitest, hooked into root `pnpm test`): exporter normalization (events→lines), fingerprint (same config same hash, different plugins different hash), McNemar/2σ numerics, budget-mismatch rejection, the three fail paths of the sealed lock. Plugin tests obey check-spec-deps (imports must be self-declared).
- Integration (replay mode): use recorded session.jsonl fixtures + llm-replay to run the deterministic trial→score full chain; `assertConsumed()` semantics carried over.
- Live smoke (SDK mode): `DeepSeekHarness` + an isolated `session_root` running one seed task, cross-checking the transcript header line against the persisted session.jsonl.
- Process dogfood: M3's 01–06 plugin comparison is the behavioral verification — its artifacts (report + archive entry) must themselves be reviewed by deep-reasoner on "whether the conclusions are constrained by the discipline".

## Risks and open questions

1. **Token accounting granularity**: a trial's token count comes from the usage fields of `assistant/chunk` and the usage recorded in `compaction/summary` (the llm-replay README mentions "the recorded usage when present"), but **the exact per-turn field names are not verified in this doc**. Check before M1 starts: the upstream session jsonl event schema docs + doc 03's landed draft; if per-event usage is missing, degrade to a walltime+turn double cap and mark `tokenBudget: unavailable` in the transcript.
2. **Headless has no verifiable max-turns/max-tokens flag** (not listed in the README). M2's cap enforcement relies on runner-side SIGTERM (wall/turn counting comes from `turn/end` in `session/event`). Check: `grep -rn "maxTurn\|maxToken" packages/bundle/headless/src` + the agent loop's core configuration; if the core already has limit configuration, switch to configuration-injection first with kill as the fallback.
3. **Consistency of the dual SDK/headless drivers**: the two drivers assemble prompts differently (SDK goes through the `agent-spine` demo assembly, headless goes through bundle patches); the fingerprint must include the driver id, and cross-driver comparisons are forbidden by default (score rejects them) unless explicitly declared. rc.7 addition: upstream PR #2462 committed a model-visible golden snapshot of the minimal composition (`scripts/snapshots/python-sdk-single-exe/minimal/model-visible.json`) — upstream's own drift detector for the SDK driver's assembled prompt/tools; cite it as a first-class reference for the driver-id part of the fingerprint.
4. **Sandbox strength**: the `minimal.cordis.yml` example is `sandbox-policy: danger-full-access`. Bench trial setup may write into the repo — the runner must use a separate temporary workspace (worktree/unpacked copy) and check for out-of-bounds writes at the validity gate.
5. **Pinning the upstream version**: trials depend on the upstream dsh tree. The repo should commit `bench/upstream.lock` (commit sha + installation instructions); CI/live evaluations warn on lock mismatch. The exact form is to be aligned with the existing profile-sync script conventions before M1 is finalized (check the existing conventions of `scripts/sync-local-profile.sh`).
6. **Replay of concurrent subagents**: llm-replay binds in first-call order, declaring a sequential-delegation assumption (its Known Limitations). Variants with concurrent subagents (e.g., 06 issue-pilot's multi-branch) cannot be deterministically replayed — such variants can only be run live, with the fingerprint marked `deterministic: false`.
7. **03/11 schemas not yet landed**: docs/design currently has only 00-overview. The exporter runs in degraded mode first (`l2: unavailable`); metric-id references defer to whatever 03/11 actually specify; if their schemas don't match this doc's assumptions, the seams change to follow 03/11, never the reverse.
