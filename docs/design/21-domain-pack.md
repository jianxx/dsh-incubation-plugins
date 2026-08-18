# 21 domain-pack — The Only Legitimate Form of Domain Knowledge Injection: Config Pack + Preflight Validation

> Status: design (not started) | Tier: 2 (domain foundation) | Package: packages/domain/domain-pack | Dependencies: schemastery (schema validation), ctx.skills / ctx.tools (consumption seams) | Consumers: breeding domain packs (22 GBLUP, 23 GWAS, planned), all vertical-domain integrators

## Design Goal and User Problem

**Goal**: converge "installing a scientific-research domain onto a generic agent" into a **machine-readable `dsh.domain.yml` config pack** + a **preflight validator**: the pack declares domain name/version/tool references/skills directory/dataset adapters/environment requirements; the validator verifies each item (command exists? file exists? environment variables present? importable? value ranges legal?). Any single failure blocks domain registration and emits fix guidance. Installing a domain goes from "pray the prompt is written correctly" to "run the validator and read the traffic light."
**User problem**: today, to use an agent for breeding GBLUP, the user can only smear domain knowledge into the prompt: "remember PLINK lives under /opt, the first column of the phenotype file is IID, GBLUP needs the G inverse first —". The prompt is neither verifiable nor reusable; switch projects or switch machines and nobody knows whether the environment still holds, until the task blows up mid-run, wasting hours of compute and context.

## Motivation (Why This Is Necessary)

**"Pure prompt-injected domain knowledge" is an anti-pattern**; the evidence is ablation, not intuition:

- Vibe-FDTR (a thermophysical-property inversion workflow, llm-wiki/wiki/syntheses/
  scientific-research-agents.md) used config-driven + procedural skills to reach
  100%/98.9% success on two benchmark tiers; under ablation, **removing the domain
  pack → the agent-only form scored 0% on real multi-step tasks**, removing
  skills → 36.7%; meanwhile it saved 87.7% of tokens and 60% of wall time versus
  a bare code-agent. Conclusion: validated **machine-readable config + procedural
  knowledge** is the precondition for reliable execution; the prompt is only the
  final layer of glue.
- TRACE (a seismic-discovery system with 2200+ domain modules, same survey) is
  isomorphic to the "config-driven pack": enumerable, verifiable, composable
  **domain artifacts** are the path to scale; its strong signals are domain
  tools + formal constraints + interpretable intermediate state — exactly the
  counterparts of this design's skills/tools/preflight trio.

The artifacts surface of the main repo is already in place: skills have a provider registry, tools have the manifest annotation foundation ([01 tool-manifest](./01-tool-manifest.md)), and skills have a governance pipeline ([08 skill-lifecycle](./08-skill-lifecycle.md)). **What is missing is making "domain" itself a first-class artifact**: a unit that can be packaged, versioned, and quality-gated. The body of this plugin is the **validator** — the pack is merely its input; it does no engine work (session/execution) at all.

## Current State and Gaps

Verified item by item (path:line numbers listed per item under "Surfaces and Seams"):

- The main repo's `packages/skill/skill` is the Service Definition of the skill
  capability seam: `ctx.skills` aggregates the directories of all providers and
  adjudicates the winner by name; providers register via
  `ctx.skills.registerProvider` (verified in 08 deployment; same-file skill
  registration precedent at `:440`); `BUNDLED_SKILL_RANK` and the priority model
  are in place. Skills directories are consumed by machine enumeration, a
  natural fit for "a domain-pack mounts a skills directory".
- The incubation-repo scaffold `scripts/create-plugin.mjs`
  (`pnpm new:plugin <group> <name>`, package.json `:18`) has already pipelined
  "create a new package + register the build surface": it generates the
  package.json/tsconfig/src/index.ts/tests/README skeletons and writes back
  tsconfig.paths, project references, pnpm-lock, and the README Layout table.
  The domain-pack scaffold follows this shape and adds one command:
  `pnpm new:domain-pack <name>`.
- The cordis.patch.yml loading chain is verified: the main repo's
  `packages/boot/app-boot` profile.ts defines
  `PROFILE_PATCH_FILENAME = 'cordis.patch.yml'` (`:39`); app-boot index.ts loads
  the bundle's patch override list (`:213` watched paths, `:290` overlay patch
  list loading); the incubation-repo README's two-anchor name resolution
  (install side wins, profile directory as fallback) guarantees that
  `@jianxx`-prefixed packages are not shadowed — a domain-pack, as a bundle
  member, can be loaded through the existing profile mechanism; **no new loader
  is needed**.
- **Three gaps**: ① the schema and version convention for `dsh.domain.yml` do
  not exist; ② there is no preflight validator — environment assumptions are
  scattered across prompts and READMEs; ③ there is no admission tier — when a
  dependency is missing, whether to block or merely warn is configurable
  nowhere.

**Explicitly out of scope**: no execution engine (workflow orchestration belongs
to the session and to consumers such as [05 long-run-protocol](./05-long-run-protocol.md)
and [18 hpc-runner](./18-hpc-runner.md)); no execution channel for remote
preflight (the remote tier is handled by 18's submit template embedding
self-checks; see risk R2); no replacement of 08's skill governance (in-domain
skills still go through its admission and utility statistics; this plugin only
delivers).

## Design

### Surfaces and Seams (verified + cited)

1. **Schema validation seam**: schemastery is the established validation
   library for Config in the cordis ecosystem (precedents:
   `packages/jobs/tool-jobs/src/index.ts` has `export const Config:
   z<Config> = z.object({...})`; `packages/jobs/jobs-local/src/index.ts`
   likewise) — the domain.yml schema is expressed in the same library, and
   error messages naturally carry field paths.
2. **Skills-directory mount seam**: `ctx.skills.registerProvider(create)` (08
   references `packages/skill/skill/src/index.ts`; the provider decides the
   source, the registry aggregates); a domain-pack mounts its in-pack `skills/`
   directory into the aggregation in provider form, with source labeled
   `custom`/the package name, and **priority follows the existing rank model**
   (`BUNDLED_SKILL_RANK = 600` as the reference; domain packs use a slightly
   lower default, so user directories can still override).
3. **Tool enumeration and annotation seam**: tools referenced by the pack must
   be already-registered tools — the admission check uses the
   `ctx.tools.get(name, scope?)` form (verified in 01 at `packages/core/tools/src/
   index.ts:1204`); manifest annotation requirements are judged via 01's
   lookup, and fail-closed synthesized entries (01's "fail-closed default
   posture") cause unannotated tools to be named in audit tier.
4. **Loading seam**: the bundle/profile `cordis.patch.yml` chain (verified
   above) is responsible for loading the domain-pack into the profile as a
   cordis plugin; the domain-pack body follows the cordis function-plugin
   conventions (`export const name/inject`, `apply(ctx)`), consistent with the
   src/index.ts skeleton generated by create-plugin.mjs.
5. **Command and prompt seam**: the manual rerun entry for preflight hangs off
   `ctx.commands.register` (precedents: `packages/feedback/command-feedback`
   and 08's deployment both reference it) — `/domain-preflight [pack]`; the
   model's "why is this domain tool unavailable" is answered by injecting a
   section "this pack is currently blocked by preflight + fix guidance" in
   enforce tier via a system prompt section (05 seam 3 precedent), rather than
   scattering it into every error.

### Data Model / Configuration

`dsh.domain.yml` (the single source of truth for a domain pack; versioned; YAML):

```yaml
version: 1
name: breeding-gblup            # kebab-case, same as the directory name
domain: animal-breeding         # domain bucket (for grouping/retrieval)
description: GBLUP evaluation pipeline (breeding values, G inverse, cross-validation)
tools:                          # additional tool-package references this pack registers (npm name + version constraint)
  - package: "@jianxx/dsh-incubation-gblup-tools@^0.1"
skills: ./skills                # directory; mounted via the skills provider seam
datasets:                       # adapter references; no embedded data
  - name: pedigree
    adapter: "@jianxx/dsh-incubation-pedigree-adapter@^0.1"
    config: { format: plink-fam }
env_requirements:
  vars: [GBLUP_HOME]            # must exist
  python: ">=3.10"
preflight:                      # executable checks; per-item id + fix guidance
  - id: plink-on-path
    kind: command-exists
    command: plink2
    fix: "module load plink/2.0 or install plink2 onto PATH"
  - id: gblup-home-readable
    kind: file-exists
    path: "${GBLUP_HOME}/bin/gblup"
    fix: "export GBLUP_HOME=<install root>; confirm bin/gblup exists"
  - id: phenotype-schema
    kind: env-schema
    path: "${PHENO_FILE}"
    columns: [IID, SIRE, DAM, phenotype]
    fix: "the first column of the phenotype file must be IID; check the header delimiter is space/Tab"
  - id: numpy-importable
    kind: import-probe
    module: numpy
    fix: "pip install numpy or activate the correct venv"
```

The preflight `kind` enum (four frozen in M1; from M2 on, plugins may register
new kinds): `command-exists` / `file-exists` / `env-var` / `import-probe` /
`env-schema` (value-range and column-pattern shallow validation; **no** data
statistics auditing — that is the dataset adapter's job).

**Validator output form** (dual channel: machine + human readable; a failure
means fix guidance, not a bare error):

```json
{
  "pack": "breeding-gblup", "version": 1, "verdict": "fail",
  "results": [
    { "id": "plink-on-path", "ok": false, "kind": "command-exists",
      "observed": "exit 127 (not found in PATH)",
      "fix": "module load plink/2.0 or install plink2 onto PATH" }
  ],
  "mode": "enforce",
  "blockedRegistration": true
}
```

Admission tiers (schemastery Config, isomorphic to the three-tier philosophy of 01/05):

```ts
mode?: 'enforce' | 'audit' | 'off'   // default enforce; audit = red light shown but registration still mounts
rerunOnSessionStart?: boolean        // default false: run once at load time,
                                     // afterwards rerun manually via /domain-preflight
strictSkillSource?: boolean          // default true: in-pack skills must pass 08
                                     // admission before becoming visible to the model
                                     // (if 08 is absent, degrade to warn)
```

### Key Behavior Flows

**Load flow** (when a cordis patch loads the domain-pack plugin):

1. Resolve the pack path specified by the profile, read `dsh.domain.yml` →
   schemastery validation; if the schema is invalid → register no domain
   assets at all, and emit field-level errors on the command surface and in
   logs.
2. Run all preflight items per the pack declaration; record the preflight
   report (persisted to `.dsh/domain-packs/<name>.report.json` + telemetry ops
   word `domainpack/preflight`).
3. **enforce tier**: any fail → block: do not register tools, do not mount the
   skills directory; inject a "pack blocked + fix guidance" section into the
   system prompt; the command replies with the report. **audit tier**: mount
   everything; the report and the prompt section note "red light shown".
   **off**: skip preflight (schema validation only), for development.
4. All pass → register tools (via the cordis dependency package's apply),
   mount the skills provider, and record the dataset adapter references.

**Manual rerun flow** (`/domain-preflight [pack]`): hot-re-read the yml, rerun
preflight, update the report and the prompt section; in enforce tier, a
fail→pass transition means "unblocking" — backfill the registration of the
previously blocked assets (idempotent: already-registered ones are skipped).
Deliberately no model-triggered automatic rerun: preflight may run real
commands beyond `module load`; the timing of automatic triggering belongs to
the user.

**Model-visibility flow**: when blocked, the model reads the blocking reason
and fix guidance in the prompt — moving "blows up only when the tool is
called" forward to "known at session start"; in audit tier the model can use
the tools as usual, but the prompt section continuously flags the risk.

**Handoff flow with 08**: the in-pack skills directory does **not** enter the
`ctx.skills` aggregation directly; instead it first completes admission lint as
an 08 intake candidate (when strictSkillSource=true), becoming visible only
after 08's candidate→active state machine adjudicates it a winner; if 08 is
absent → degrade to direct mounting + warn (the adapters fault line; see risk
R3).

**Handoff flow with 01**: tools referenced by the pack have their annotations
checked via 01 lookup at load time: a missing `effectClass` (fail-closed
synthesized entry) counts as one warn in both audit and enforce tiers (does
not block; tool governance belongs to 01; domain-pack only does the naming).
This lets the tools of packs 22/23 be naturally inventoried in the manifest
coverage lint.

### Scaffolding (new:domain-pack)

Following the existing style of `scripts/create-plugin.mjs`, add
`pnpm new:domain-pack <name>`:

```text
packages/domain/<name>/
  package.json            # cordis peerDep conventions same as create-plugin
  dsh.domain.yml          # skeleton: version/name/domain + one command-exists example
  skills/example-skill/SKILL.md
  src/index.ts            # skeleton: apply reads the pack path → hands off to the domain-pack validator
  tests/<name>.spec.ts    # smoke: loading its own yml passes schema validation
  README.md               # section template: domain intro / prerequisites / preflight guide / joint-test gate
```

The registration surface is identical to create-plugin.mjs (tsconfig paths /
project references / pnpm-lock importers / README Layout row), plus one extra
entry registered in the domain-pack validator's discovery list
(`packages/domain/<name>` becomes loadable by name from a profile).

## Milestone Breakdown

- **M1 — schema + validator core (one PR)**: `dsh.domain.yml` v1 schema
  (schemastery), the five preflight kind executors, the load flow's three-tier
  admission, report persistence, and telemetry. Verification: {drive with: a
  fake ctx (ctx.tools/ctx.skills/commands all spied) loading three fixture
  packs — all-pass, single-fail, audit tier; observable results: the report
  JSON, whether the registration spies were called, the prompt section text;
  pass conditions: in enforce the single-fail pack registers nothing and the
  error contains the fix field; in audit all registrations happen and the
  report verdict=fail}.
- **M2 — preflight report UX + manual rerun (one PR)**: the
  `/domain-preflight` command, report reading format (table + fix guidance),
  fail→pass unblocking backfill registration, hot re-read. Verification:
  {drive with: a synthetic session issuing the command (fixture ctx);
  observable results: the command echo, the asset diff set of the second load;
  pass conditions: the rerun path is idempotent — two consecutive preflights of
  the same pack do not double-register; after fail→pass the blocked assets each
  appear exactly once}.
- **M3 — new:domain-pack scaffold (one PR)**: script extension and templates;
  documentation wired into the README. Verification: {drive with: actually
  running `pnpm new:domain-pack demo-pack`; observable results: the produced
  tree, typecheck results; pass conditions: the artifacts pass root
  vitest/typecheck all green; the skeleton pack is accepted by the domain-pack
  validator (schema fully passes) — the scaffold and the validator test each
  other}.
- **M4 — 08/01 integration points (one PR)**: wiring skills into 08 intake
  (optional presence), and the annotation-inventory warn for tools via 01
  lookup. Verification: {drive with: the fake ctx providing/not providing the
  08 and 01 service keys respectively; observable results: in strict tier
  skills enter 08 as candidates first, degradation to warn when absent;
  unannotated tools named by 01; pass conditions: all four presence
  combination behaviors become assertions}.

## Verification Plan

1. **Unit**: yml parsing and schema error paths (missing fields / bad kind /
   unknown version); each of the five preflight kinds' pass/fail/fix-guidance
   fields; the three-tier admission matrix.
2. **Negative auto (core of DoD)**: a fixture pack deliberately missing one
   preflight dependency is blocked in enforce tier, with error text containing
   the fix guidance — this test case is the minimal engineering expression of
   the Vibe-FDTR ablation conclusion.
3. **Natural regression**: once the two breeding packs 22/23 are implemented
   per this spec, their load/preflight is the integration regression for
   domain-pack — at the plan level, from M4 onward the two are listed in the
   joint-test gate.
4. **Scaffold self-check** (M3): the artifacts pass typecheck + the gate, and
   the skeleton pack is accepted by the validator.
5. **Report UX review (manual)**: capture one screen each of the enforce
   blocking prompt section and the command echo; review that "the fix guidance
   is readable, not just an id".

## Risks and Open Questions

- **R1 Maintenance cost of preflight false-positive rate**: environment checks
  are inherently brittle (PATH differences, module systems, inside/outside
  container differences); a false positive directly blocks the domain, the
  heaviest frustration. Countermeasures: mandatory `fix` documentation per
  kind; audit tier for canary rollout; every report entry carries the raw
  `observed` text so users can judge true vs. false. Open: whether a per-check
  `severity: block|warn` override is needed (review after M2).
- **R2 Ownership of remote preflight**: local preflight passing ≠ the cluster
  environment passing (HPC modules/quotas/filesystems are another world). The
  division of labor is cut: the local tier belongs to this plugin; the remote
  tier is handled by [18 hpc-runner](./18-hpc-runner.md)'s submit template
  embedding a self-check section in the sbatch-rendered artifact (cluster-side
  fail-fast); the domain-pack yml reserves a `preflight_remote: []` namespace
  but does not implement the execution channel.
- **R3 Degradation when 08 is absent**: strictSkillSource direct mounting lets
  skills bypass admission lint; the degradation is allowed only in
  configurations where 08 is absent (profile without 08 installed), and must
  warn — this exposure is recorded, not adopted as a long-term default.
- **R4 The security boundary of yml being config, not code**: the path/command
  fields of `env-schema`/`command-exists` could carry dangerous probe commands
  planted by a malicious pack (the probes themselves are read-only, but a
  side-channel exists); the five kinds frozen in M1 are all executed
  whitelist-style (no shell concatenation, command exec'd directly without
  expansion), and extension kinds must pass code review.
- **R5 Multi-pack coexistence and name conflicts**: when two domain-packs
  mount the same domain, skill name collisions are adjudicated by the
  ctx.skills rank (existing semantics); this plugin introduces no second
  conflict rule; a pack-level version only validates its own schema version
  and does no dependency version solving (that is pnpm's job).

## Unit Acceptance (Definition of Done)

Checkbox conventions: [auto] = assertable in CI; [manual] = executed by a human
with evidence backfilled; [联测 joint-test] = an end-to-end assertion linked
with other packages in the same repo.

- [ ] [auto] Full schema field matrix: a legal yml passes; missing
  name/version / bad kind / unknown version each produce field-path-level
  errors.
- [ ] [auto] Core negative case: a fixture pack missing one preflight
  dependency has tools/skills registration blocked in enforce tier (spy asserts
  zero calls), the report contains that check's `fix` guidance and
  `blockedRegistration: true`; the same fixture in audit tier registers
  everything and verdict=fail.
- [ ] [auto] Each of the five preflight kinds passes both pass/fail paths; fail
  reports contain the raw `observed` text and the `fix` field; command-class
  kinds do not go through shell interpretation (whitelisted-execution
  assertion: argument-injection attempts do not change the executed target).
- [ ] [auto] Manual rerun idempotence: two consecutive `/domain-preflight` runs
  on the same pack register assets exactly once; after a fail→pass transition
  the blocked assets are backfill-registered exactly once.
- [ ] [auto] Telemetry ops vocabulary: the attribute shapes of domainpack/load,
  domainpack/preflight, domainpack/blocked, domainpack/rerun are asserted by
  spies.
- [ ] [auto] The `pnpm new:domain-pack demo-pack` artifact tree passes
  typecheck + the full vitest gate; its skeleton yml is accepted by the
  validator (scaffold ↔ validator mutually verifying).
- [ ] [joint-test] With 08 present: in-pack skills enter 08 intake as
  candidates and are not visible to the model before admission; with 08 absent:
  degrade to direct mounting + exactly one warn telemetry.
- [ ] [joint-test] With 01 present: annotation inventory of pack-referenced
  tools produces a warn list (fail-closed synthesized entries named); does not
  affect registration.
- [ ] [joint-test] The breeding packs 22/23 are implemented per this spec and
  pass their own preflight — these two packs' load chain is the natural
  regression case; before 22/23 are chartered, substitute skeleton fixtures;
  see the 22/23 docs for links (planned).
- [ ] [manual] enforce blocking UX review: one screenshot each of the prompt
  section + the `/domain-preflight` report; a reviewer can read the fix
  guidance once and act on it directly.
- [ ] [manual] The README section template is filled out into a complete
  example on the demo-pack artifact, linking back to this document's schema
  section.
