# 13 subagent-context-scope — Need-Only Context Boundaries for Subagents (Spike-First)

> Status: spike: done (verdict: **feasible-plugin**, evidence below) | Tier: 3 | Package: packages/agents/subagent-context-scope (M0 verdict: feasible) | Dependencies: none (upstream `deepseek-harness` provides every seam; doc 01/12 are runtime-optional integrations only)
> Verified seams against deepseek-harness **0.1.0-rc.7** (@99f6f02fec); path:line citations refer to that tree.

## Design goal and user problem

**Goal**: add need-only context boundaries to spawned subagents — register scoped-fork / scoped-spawn provider wrappers that carry only the prompt sections, tool subsets, memory scopes, and goal subsets a role policy declares necessary; ship a leakage-measurement harness (synthetic distractor-secret scenarios) feeding doc 12.
**User problem**: spawning a subagent today means copying the parent session's entire memory — discussions of unrelated tasks, secrets that were probed, other roles' intermediate reasoning — verbatim into the child; the child gets derailed by distractors, answer quality drops, the user pays double tokens for two contexts, and picks up an information-leakage surface on top, with no configuration entry point for any of it.

## Motivation (PerspectiveGap Numbers + Why the Default Full-History Copy Is Wrong)

PerspectiveGap measured information leakage in multi-agent prompt orchestration: after
distractors / out-of-scope information are injected into role contexts, across 110
scenarios × 10 topologies, the average combined pass rate is only 14.9%, the strongest
model reaches only 62.0%, and the average overall leakage rate is 246.5% (leaked content
gets copied and amplified). The conclusions point consistently at the same independently
measurable axis: **need-only context boundary** — each role should see only the slice of
context necessary to complete its task.

PatchOptic's projected read (each step sees only the projected subview relevant to itself)
and the Formal Hierarchical Architecture's manifest-driven lazy discovery (each step's
prompt loads only the current node's sub-manifest) are the same economics expressed over
a delegation tree.

dsh's default behavior is exactly the counterexample: the `fork` provider **wholesale-copies**
the parent session's "completed-turn prefix" into the child session (`completedTurnPrefix`,
see Q1). Irrelevant tasks accumulated in the parent session, secrets it has touched, other
roles' intermediate reasoning — all of it becomes distractors and leakage surface for the
subagent. Defaulting to a full-history copy is convenient engineering (the seed replays
directly) but wrong on both quality and safety: it optimizes the property "the subagent can
replay the parent's history," which almost nobody wants, at the cost of "the subagent sees
only what it needs," the property PerspectiveGap proved valuable.

## M0 Spike: Feasibility Investigation

**This spike was actually executed by the author before writing this document** (reading
upstream source directly, not secondhand). Conclusion first: the concern raised in "critical
context" (that a plugin cannot control subagent context) **is refuted by code evidence** —
the fork/provider seam hands the decision power over seed bytes, prompt, toolset, and persona
entirely to the provider, and the provider registry is open to third-party plugins. The only
real limitation: `ctx.sessions.fork` is a session-level pure-slicing seam (unrelated to
subagent seeds), and the creation window of one-shot subagents has no plugin hook (this can
be bypassed in M1 by assembling your own driver from public APIs, see Q2).

rc.7 note on the shipped external providers: `subagent-claude-code` and
`subagent-codex` gained `run_in_background` in rc.7 (Job-registry-backed:
`backgroundMode: 'one-shot'`; explicit `true` returns a parent-owned Job id
consumable via `job_output`/`job_kill`), and both are explicitly OPT-IN mounts —
production dsh does not install them (the `disabled: true` tool rows plus the
"Production dsh does not install these optional providers" comment in
`apps/cli/config/agent-presets/standard/agent.cordis.yml`).

### Q1: What context does a subagent get at spawn? Where are the override points?

**fork path (in-process fork)**:
`packages/subagent/subagent-fork-in-process/src/index.ts:48-54` — `completedTurnPrefix(parent)`
slices `parent.session.events` up to the last `turn/end` (an in-flight turn is unbalanced and
non-replayable, so it is excluded) and passes the result as `{seed}` to `startInProcessRun`.
**The seed's content and boundaries are computed entirely by the provider**; the service layer
plays no part in selection.
`SubagentProvider.inheritsParentContext = true` (:64 of the same file) is merely a descriptive
flag for model-facing copy.

**spawn path (provider-direct creation)**:
`packages/subagent/subagent-spawn-in-process/src/index.ts:48-53` — no seed is passed; the
subagent starts brand-new (its own session, its own system prompt, zero parent context).

**Both paths converge at** `packages/subagent/subagent-in-process-driver/src/index.ts:102-148`
`startInProcessRun(request, {seed})`: resolve depth → capture delegated policy (approval pinned
to `'never'`) → `parent.ctx.agents.create({sessionId, meta, seed, agentOptions, signal, setup})`,
where `setup(childCtx)` (:120-130) calls `applyChildComposition`:
`packages/subagent/subagent/src/child-agent.ts:163-174` —
(1) `agentPresets.composeFrom(childCtx, parent.ctx)` joins the parent preset;
(2) registers the `subagent:delegation` runtime context (order 120);
(3) if `persona` is present, registers a same-named `deployment:persona` scoped section that
**shadows** the deployment persona (`:171-172`);
(4) if `toolFilter` is present, calls `childCtx.tools.restrict(...)` (`:174`).

**Request-level override points** (`SubagentStartRequest`, `subagent/src/types.ts:100-149`),
each gated by a capability (`SubagentRuntime.assertCapabilities`, index.ts:481-496):
`prompt` (the subagent's user message, wholly replaceable), `agentOptions`
(provider/model/maxTokens), `toolFilter` (ToolRestriction), `persona`, `outputSchema`,
`maxDepth`, `label`.

**`ctx.sessions.fork(source, boundary?)`** (`packages/core/session/src/index.ts:1081-1138`)
is a separate session-level seam: **boundary-pure slicing only** (a contiguous prefix that must
not land inside an open turn); content projection is not supported. Note: the subagent fork
provider **does not use it** — it slices and passes the seed itself, which is exactly the
plugin's opportunity.

**Legal seed envelope** (`core/session/src/index.ts:508-547`): `seq` contiguous from 0,
lossless JSON, valid envelopes, supported request header, every event passed through
`surfaceManager.validateNext`. ⇒ **A content-projected seed is representable**: delete events,
renumber seq, keep turns balanced, and it passes the same validation. Events are deep-frozen,
so projection = constructing new event objects (the snapshot path already accepts wholly new
JSON values).

### Q2: Can a third-party plugin wrap/replace a subagent provider?

**Yes — and there is already a shipped precedent.**
- Registration API: `SubagentRuntime.registerProvider(provider)`
  (`subagent/src/index.ts:369-385`) — a named registry with cordis effect scoping
  (unregistered on unload); duplicate names throw `DUPLICATE_PROVIDER`;
  `getProvider(name)` (:392) lets a wrapper resolve the wrapped target.
  Contrast with the bash seam's mutually exclusive single implementation: here the design is
  **explicitly multi-provider coexistence** (header comment at index.ts:8-10).
- Precedent: `AgentProvider` in `dsh-cc-plugins/packages/compat/cc-plugin-loader/src/agents.ts:40-90`
  is exactly a "wrapping provider" — registered per agentType; on `start` it first
  `resolve('fork')`, then overrides `prompt`/`agentOptions.model`/`toolFilter` and forwards.
  (Cited as shape evidence only; this package has no compile-time dependency on
  dsh-cc-plugins — shared principle 1.)
- Selection mechanism: the model-side tool `tool-subagent`'s `Config.provider: string`
  (`subagent/tool-subagent/src/index.ts:30,81-82`) decides which registered name a delegation
  lands on; a deployment points the name at the wrapping provider (e.g., `scoped-fork`) and it
  takes effect — no upstream change needed.

**Context-control levers exposed by the provider interface**:
- Wrap-and-forward (mutating the request): rewrite/replace `prompt`; `agentOptions`;
  `toolFilter` **intersected** with the request value (restrict semantics narrow naturally);
  `persona` shadowing; tightening `maxDepth`.
- History projection: the interface has no declarative field for it, but the wrapper can
  **decline to forward to stock fork** and instead call the publicly exported
  `startInProcessRun(request, {seed: self-computed projected seed})` (the driver is a public
  package) — fork's seed computation is only 7 lines; reimplement it with a filter and you
  have projection.
- Deeper creation-window orchestration: `dsh-subagent` publicly exports
  `applyChildComposition / captureDelegatedPolicyOverrides / appendDelegatedPolicyOverrides /
  childSessionMeta / resolveChildAgentOptions / resolveChildDepth / settleRun /
  finalAssistantOutput` (index.ts:72,101-111) — assembling your own one-shot driver via
  `ctx.agents.create({setup})` (~a hundred lines of lifecycle code) lets you attach arbitrary
  scoped-section shadowing inside childCtx.
- Continuable subagents: the provider contributes only `{seed}` (`prepareContinuable`,
  types.ts:323); orchestration belongs to the continuation manager. But deployment plugins get
  an explicit hook: **`SubagentRuntime.registerContinuableSetup(contribution)`**
  (index.ts:286-292), which takes effect on every continuable child's creation window, both
  fresh creation and cold recovery.

### Q3: Can `agent.ctx` scope carve per-agent slices of services / prompt sections?

**Yes — this is a structural capability, not a coincidence.**
- `SystemPrompt` is built on `ScopedLayers` (`core/system-prompt/src/index.ts:347`);
  `section()/context()` registered through an agent's `childCtx` shadows the global
  same-named section (:375 states "A scoped section shadows a global
  section with the same name", signature at :381); the duplicate-name error message points straight at
  `agent.ctx` (:317). **Shadowing with empty text ≈ deletion**: `renderPrompt` drops empty
  sections (:212-217). `suppressRuntimeContext()` is likewise effect-scoped (:415).
- `tools.restrict()` **requires a scoped context** — calling it globally throws outright
  (`core/tools/src/index.ts:1074`): `agent.ctx` slicing is a first-class citizen.
- Joining a preset is a scope re-mount: `composeFrom(childCtx, parentCtx)`
  (`preset/agent-presets/src/index.ts:316-325`); a custom provider can also `mount()` a
  different preset for the subagent — i.e., "the subagent runs on a different orchestration
  than its parent."

### Three-Outcome Contingency Table

| M0 outcome | Direction | Trigger condition |
|---|---|---|
| **feasible-plugin (actually hit)** | All levers plugin-based, no upstream changes → execute M1/M2 below | Q1–Q3 evidence holds (it does) |
| needs-upstream (not triggered, pre-staged) | File upstream issues and park. Pre-staged asks: add a declarative `historyProjection` to `SubagentStartRequest` (keep predicate / turn-retention policy, validated by the service and handed to session-level seed construction); add `registerOneShotSetup(contribution)` for one-shot subagents (aligned with continuable's existing `registerContinuableSetup`, index.ts:286); both are additive and do not break existing capability semantics | The fork seed proves not provider-controllable, or registerProvider is not open to plugins — the evidence has already ruled out both |
| partial (not triggered, pre-staged projection fallback) | Ship the plugin first: L1 prompt rewrite, L2 agentOptions, L3 toolFilter intersection, L4 persona shadowing (all achievable with pure wrap-and-forward); escalate to an upstream issue: one-shot creation-window hook (if M1 decides not to maintain a self-assembled driver, see risk R1) | Review judges the maintenance cost of the self-assembled one-shot driver to exceed its benefit |

## Design (Conditional on the Spike Verdict; Provider-Wrapper Shape; Context Policy Schema)

Overall shape: **wrapping providers + role-level context policy**. The plugin registers two
providers, `scoped-fork` and `scoped-spawn` (wrapping stock `fork`/`spawn`), and the deployment
points to them via `tool-subagent`'s `Config.provider`. On every `start`, the wrapper resolves
the role from the request (lazy order: explicit `label` matching a policy name → `persona`
text hash → default policy), applies that role's policy, then decides whether to forward or
compute its own seed.

### Surfaces and Seams (Only Verified Ones)

- `ctx.subagents.registerProvider / getProvider` (index.ts:369,392) — registration and resolution.
- `ResolvedSubagentStartRequest` (types.ts:155-158) — rewritable fields as per Q1.
- `startInProcessRun(request, {seed})` (subagent-in-process-driver/src/index.ts:102)
  + a self-computed projected seed — the only correct entry point for history projection
  (stock fork computes its seed inside the provider; wrap-and-forward cannot reach it).
- All orchestration functions in `child-agent.ts` are public exports (index.ts:102-111) —
  reused when assembling your own driver; no logic is copied.
- Continuable side: `registerContinuableSetup` (index.ts:286-292).
- Leakage observation: the run handle carries `localAgent` (types.ts:257-261); the harness can
  read `child.session.events` and the system prompt the child assembled directly — no new
  observation channel needed.
- Three execution strengths `off / audit / enforce` (shared principle 3): the `audit` tier only
  logs "what enforce would have pruned" and does not mutate requests.
- Tool exfiltration classification goes through doc 01's tool-manifest annotation mechanism
  (shared principle 4); this package does not invent its own per-tool metadata. Until doc 01
  lands, `secretPatterns` inlined in the policy serves as the fallback.

### Data Model / Configuration

```
ContextScopePolicy {
  roles: Record<roleName, {
    promptSections?: { shadowEmpty: string[] }   // register empty sections via childCtx to shadow by name (Q3)
    toolFilter?: { allow?: string[]; deny?: string[] }  // intersected with the request's toolFilter (L3)
    persona?: string                             // shadows deployment:persona (L4)
    agentOptions?: { model?, provider?, maxTokens? }    // (L2)
    history?: {
      mode: 'inherit' | 'prefix-only' | 'projected'
      // projected: delete matched events while preserving turn balance, renumber seq
      dropEventTypes?: string[]                  // e.g., telemetry echoes other than 'session/end-seed'
      dropContentPatterns?: string[]             // canary/secret regexes; or sourced from doc 01's exfiltration taxonomy
      keepLastTurns?: number                     // coarse-grained shortcut for projected
    }
    maxDepth?: number                            // may only be tighter than the request
  }>
  defaultRole: roleName
  strength: 'off' | 'audit' | 'enforce'
}
```

### Leak-Measurement Harness (Synthetic Scenario Design, Consumed by doc 12)

A PerspectiveGap-flavored scenario pack: each scenario = a scripted parent-session transcript
(task-relevant content + K canary secrets, shaped like `CANARY-{scenario}-{k}`, distributed
across other roles' tasks / credentials / reasoning fragments) + one subagent delegation task.
For each scenario, run the delegation twice — `inherit` (baseline) and the policy tier — and
collect:
- **leak rate**: the fraction of canaries appearing in the subagent's final context
  (`localAgent.session.events` + the assembled system prompt), compared pre/post policy;
  target: policy tier ≤ baseline × 0.1.
- **task success**: the assertion pass rate of the subagent's task (guards against
  over-pruning; over-pruning is scored as failure alongside leakage).
- Events follow shared principle 5 through the `session-telemetry/record` waterfall +
  `session/event` stream, with schema aligned to doc 12's eval export
  (`metric: 'context-leak-rate'`, dimensions scenario×role×mode).

## Milestone Breakdown

- **M0 = this spike (completed in this document)**: the Q1–Q3 evidence and the outcome
  adjudication above. The deliverable is this document.
- **M1 (conditional, now activated)**: `pnpm new:plugin agents subagent-context-scope`
  scaffolding; policy schema; `scoped-fork`/`scoped-spawn` wrapping providers; the lever
  subset L1 prompt rewrite + L2 agentOptions + L3 toolFilter intersection + L4 persona
  shadowing + history projection (`prefix-only` and `projected`, via self-computed seed +
  `startInProcessRun`); unit tests: seed-projector invariants (contiguous seq / turn balance /
  event JSON round-trip), pass-through of capability denials, intersection semantics, and
  off/audit not mutating requests.
- **M2 (conditional)**: leak-measurement harness + telemetry reporting + a scenario pack of
  ≥ 10 scenarios (covering 3 topologies); `shadowEmpty` section slicing (continuable via
  `registerContinuableSetup`; one-shot on the same plan if review accepts the self-assembled
  driver, otherwise fall back to the upstream issue from the partial row); README graduation
  criteria.

## Verification Plan

1. `pnpm --filter @jianxx/dsh-incubation-subagent-context-scope test` all green (gate).
2. Integration test: bring up an in-memory deployment, delegate once via stock `fork`
   (baseline transcript fully inherited), then delegate the same task via `scoped-fork`;
   assert on child `session.events` length, canary hit counts, and that the
   `inheritsParentContext` copy matches actual behavior (must be declared truthfully under
   projected).
3. Score the harness scenario pack: report both metrics — leak rate and task success — wired
   into the doc 12 export.
4. Manual spot-check of steer-back attribution in one real session (if M2 adds section
   slicing, verify the parent agent is unaffected: shadowing stays within the childCtx scope).

## Risks and Open Questions

- **R1 Drift risk of the self-assembled one-shot driver**: if M2 needs one-shot section
  shadowing, the driver must be reassembled from public exports (~100 lines), pinned by a
  suite of characterization tests against stock driver behavior; upstream evolution is caught
  by test alarms. The fallback is the partial row's upstream issue (`registerOneShotSetup`).
- **R2 Legality envelope of projection**: which event types are required for surface/model
  replay (e.g., request header, turn boundaries) is established empirically in M1 with failing
  tests; `sessions.create` validation fails loud and never silently corrupts. Projection must
  not touch the subagent's own events after `session/end-seed` (the seed contains only the
  parent prefix, so this holds by construction).
- **R3 Honesty of role resolution**: `label` is self-reported by the model/caller and cannot
  serve as a security boundary; the policy is a leakage-reduction and quality lever, not a
  replacement for permissions (permissions are pinned by `DelegatedPolicyOverrides`'s approval
  `'never'`, child-agent.ts:186, verified).
- **R4 Timing gap with doc 01**: before doc 01 lands, `dropContentPatterns` serves as the
  inline fallback; after it lands, migrate to the tool-manifest exfiltration taxonomy (shared
  principle 4), dual-reading during migration.
- **Open question**: should a continuable child's projected seed be re-projected as the parent
  session grows after cold recovery? (Current `prepareContinuable` semantics are "frozen once
  at creation"; the TODO at subagent-fork-in-process:77-89 shows upstream has left this blank
  too.) — This package follows upstream semantics and does not pre-answer.
