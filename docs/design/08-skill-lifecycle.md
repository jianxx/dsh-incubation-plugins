# 08 skill-lifecycle — admission, utility, and retirement of skill artifacts

> Status: design (not started) | Tier: 2 | Package: packages/skills/skill-lifecycle | Dependencies: none
>
> Verified seams against deepseek-harness **0.1.0-rc.7** (@99f6f02fec); path:line citations refer to that tree.

## Design goal and user problem

**Goal**: make skill packages governed runtime artifacts — admission lint (shape / resource completeness / permission compatibility / injection-style instruction safety), utility tracking (candidate → active → archived state machine), versioned rollback storage, and provenance records.
**User problem**: skill directories only ever grow: SKILL.md files copied from elsewhere are never reviewed, so a bad skill carrying injection-style instructions or demanding out-of-scope tools meets zero interception; once installed, nobody knows which ones are actually used or which are actively hurting; a broken edit cannot be rolled back — the bigger the library, the bigger the retrieval interference and supply-chain risk, and none of it is visible today.

## Motivation

The Dynamic Agent Skills survey splits skills into an eight-stage lifecycle
(evidence acquisition, proposal, verification/admission, organization/storage,
retrieval/composition, maintenance/repair, distillation/portability,
governance/provenance). `retrieveSkill` is only the middle segment: without
admission, lineage, utility, and rollback, the larger the skill library grows,
the more generation errors are converted into retrieval interference and
supply-chain risk. dsh today has only the middle segment (register + retrieve);
both governance segments (admission, retirement) are missing. Three patch
directions:

- **Progressive Crystallization**: a skill must be circuit-breaker
  DEMOTE-able (regression/security failure); freeze-once is unacceptable → we
  need a state machine and a demote channel, not "imported means permanent".
- **SkillOpt**: revising a skill document is bounded edit + held-out
  verification gate + rejection memory; the rejection-memory idea ports
  directly to admission (re-importing the same hash is rejected outright,
  without re-running lint).
- **SkillCorpus/SkillCenter**: corpus-level distribution is feasible, but its
  payoff is capped by coverage and coupled to the harness → utility must be
  measured in situ, not assumed.

Runtime subset: of the eight stages, acquisition (evidence collection) and
distillation/portability (offline distillation, cross-harness porting) belong
to offline pipelines; this document does not design them, leaving only an
entry point at import lint.

## Current state and gaps

Mapping of the eight lifecycle stages onto dsh today (cited paths are relative
to the `deepseek-harness` repo root; see the next section for "injection"
details):

| Stage | dsh today | This work |
|-------|-----------|-----------|
| 1 evidence acquisition | offline (hand-written / ported from elsewhere), no runtime requirement | not done |
| 2 proposal | `ctx.skills.register` exists (runtime skill registration, `packages/skill/skill/src/index.ts:440`), but has no review step | reused as the registration egress for admitted skills |
| 3 verification/admission | **missing**: a candidate produced by any provider goes straight into the catalog and tools | **core**: admission gate |
| 4 organization/storage | registry dedups by rank/scope tier (`skill/src/index.ts:568-583`, `RUNTIME_RANK=250` `:24` / `BUNDLED_SKILL_RANK=600` `:27`), but no versioning, no content addressing, no persistence | versioned provenance store |
| 5 retrieval/composition | already present: core `skill` tool + `<available_skills>` catalog (see next section) | reuse; no rerank/composition |
| 6 maintenance/repair | **missing**: no usage stats, no utility signal, no demote | utility tracking + demote proposals |
| 7 distillation/portability | none | not done (offline; import lint provides the docking point) |
| 8 governance/provenance | **missing**: no source/hash/version records, no rollback, no audit | provenance schema + rollback + telemetry |

Additional verified facts: the `skills/change` event exists but carries no
payload; it only triggers a cache refresh when a provider is
registered/invalidated or `control.invalidate()` is called
(`skill/src/index.ts:297`, `649-660`). Both injection-side channels (catalog +
tool body) go through the provider's `list`/`get` — that is the natural
landing point for the gate.

## Design

### Surfaces and seams (verified + cited)

1. **Registration API**:
   `ctx.skills.registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void`
   (`skill/src/index.ts:391`); `Context.skills: SkillRegistry` (`:284-288`).
   Provider shape (`:248-268`):
   ```ts
   interface SkillProvider {
     readonly name: string
     list(o: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation>
     get(c: SkillCandidate, o: SkillLookupOptions): Promise<SkillDefinition | undefined>
   }
   ```
   `SkillProviderControl = { signal: AbortSignal; invalidate: () => void }`
   (`:271-276`). Skill records: `SkillSummary` (`:56-71`: name / description /
   whenToUse? / invocation / source / provider / resourceBase?),
   `SkillCandidate extends SkillSummary` (+ rank / locator / path? / metadata?,
   `:74-83`), `SkillDefinition` (+ content, `:86-93`);
   `SkillInvocationPolicy = { modelInvocable, userInvocable }` (`:48-53`);
   `SkillSource` union type (`:39`). **The core types have no allowedTools
   field** — only opaque `metadata`.
2. **The two channels injecting into the model's view**:
   (a) the model-visible core `skill` tool
   (`packages/skill/tool-skill/src/index.ts:81-161`); `execute` goes through
   `ctx.skills.list/get` (`:134/141`), and the body is wrapped by
   `renderSkillContent` into `<skill_content>`/`<skill_instructions>` and
   injected into the transcript (`skill/src/index.ts:171-184`);
   (b) an `agent/pre-step` listener injects a persistent `<available_skills>`
   catalog user message with `source.kind: 'skill-catalog'`
   (`tool-skill:213-251`, rendering `:254-277`), only when this plugin's tool
   registration resolves successfully
   (`ctx.tools.get(skillTool.name, agent) === skillTool`, `:220`);
   (c) the user typing a `/name` gesture is injected via another
   `agent/pre-step` listener (`:177-204`).
   ⇒ **The admission gate must live inside the provider**: `list` decides
   catalog visibility (candidates may be listed and marked), `get` decides
   whether the body is injected (in candidate state, return `undefined` +
   reason).
3. **Wrappability (conclusion: cannot wrap, only replace)**: core skill
   aggregation goes through `ctx.skills.list/get` and enumerates **all**
   providers (`skill/src/index.ts:552-620`); there is no middleware point that
   would "wrap someone else's provider". Re-registering a same-name provider
   at the same tier throws directly (`:335-337`); no replace/unregister.
   Across tiers, nearer scopes shadow farther ones (`:346-356`, merge
   `:552-565`); same-name skills within a tier are deduped by rank.
   ⇒ This plugin **ships its own governed file-system provider**; profiles
   that enable it must not also enable the core `skill-filesystem`. Skills
   produced by already-registered third-party providers are not intercepted
   (documentation + profile constraint). The core `FileSystemSkillProvider`
   class is exported
   (`packages/skill/skill-filesystem/src/index.ts:146`) and can serve as a
   delegation target (construction dependencies: see open question 1).
4. **Permissions and tool grants**:
   `PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'`
   (`packages/interaction/permission-rules/lib/types/types.d.ts:34`,
   `PERMISSION_MODES` constant `:36`); `'permission/mode'` is a session
   **event** type, not a state key — it is declared by module augmentation of
   `SessionEventMap` in the vendored
   `@deepseek-ai/dsh-permission-rules` lib output
   (`packages/interaction/permission-rules/lib/types/index.d.ts:31-33`,
   payload `{ mode: PermissionMode }`). Tool-grant channel:
   `ctx.tools.restrict(filter)` with `ToolRestriction { allow?, deny? }`
   (`packages/core/tools/src/index.ts:680-686,1071`); the translation from
   CC-format `allowed-tools` to `ToolRestriction` exists only in the vendored
   `skill-claude-code` lib output
   (`packages/skill/skill-claude-code/lib/types/translate.d.ts:15-22`); there
   is no runtime enforcement point inside dsh ⇒ the grant-compat check is done
   by this plugin at admission time.
5. **Remaining ctx surfaces**: `ctx.commands.register({ … })` (precedents
   `packages/feedback/command-feedback/src/index.ts:101`,
   `packages/session-query/session-log-export/src/index.ts:19`); config via
   zod `Schema<Config>` (precedent `skill-filesystem/src/index.ts:76`); file
   I/O via `ctx.fs` (the skill-filesystem convention).

### Data model / configuration

**Governance record** (decoupled from the core `SkillCandidate`; the plugin
owns its store, content-addressed):

```ts
type SkillKey = string            // `${provider}:${name}`
interface SkillVersion {
  contentHash: string             // sha256(normalized SKILL.md content)
  version: number                 // monotonically increasing per key
  sourcePath?: string; sourceUrl?: string
  importedAt: string              // ISO-8601
  parentVersion?: number          // edit lineage (anchor for SkillOpt bounded edit)
  lintReport: LintFinding[]       // see next section
  grants: string[]                // resolved allowed-tools
}
interface SkillGovernanceRecord {
  key: SkillKey
  activeVersion: number | null    // null = never admitted
  versions: SkillVersion[]        // full history, deduped by contentHash
  state: 'candidate' | 'active' | 'archived'
  rejectionMemory: string[]       // rejected contentHash (reimport rejected outright)
  utility: { invocations: number; lastUsedAt?: string
             followErrors: number; followCalls: number }  // see behavior flow 2
}
```

**State machine**: `candidate → active → archived`; `archived → active` is
allowed only via rollback (pointing at a historical version). Every transition
appends an audit event (actor: human|auto, trigger, reason).

#### Configuration (rc.7 onward)

> **Configuration (rc.7 onward)**: user-tunable knobs are declared through a settings namespace (`settingsNamespace` + `installSettingsSection`, `packages/settings/settings/src/index.ts:863`). Resolution layers: schema defaults → the cordis composition entry (base) → the `settings.yaml` user document. Values hot-reload via `settings/updated` and are readable at runtime through `ctx.settings.describe()`. Registering a namespace exposes it — #2404 removed the apiproxy allowlists, so registration is the only exposure control — which means both the web settings page and `settings.yaml` can edit it. The cordis `apply(ctx, config)` second argument remains the composition-defaults layer; this package's knobs (`mode`, `lint`, `demote`, …) ride that layer.

**Configuration** (zod; follows the enforcement-strength continuum of shared
principle 3):

```ts
Config = {
  mode: 'off' | 'audit' | 'enforce'          // enforce = no injection unless admitted
  autoAdmitSources: SkillSource[]            // default ['bundled'] (trustedHost roots)
  candidateInCatalog: boolean               // whether candidates are listed in the catalog (marked), default true
  lint: Record<string, 'off' | 'warn' | 'block'>   // per-rule adjustable
  demote: { minInvocations: number           // default 20
            failureRatio: number             // followErrors/followCalls threshold, default 0.35
            staleDays: number                // default 60
            requireConfirmation: true }      // circuit-breaker always requires human confirmation
}
```

### Key behavior flows

1. **Discovery → admission → active**. The governed provider scans the skill
   roots (delegating to the core `FileSystemSkillProvider` or scanning on its
   own; see open question 1); in `list` it looks up every candidate in the
   store:
   - Unknown → run the admission pipeline (in order): shape → resource
     manifest → safety lint → grant-compat. Outcomes: `active` (clean, or from
     a trusted source) | `candidate` (clean but unconfirmed; if
     `candidateInCatalog`, listed in the catalog and marked in metadata) |
     rejected (written to rejectionMemory, not cataloged).
   - Known → per store state: `active` passes through; `candidate`/`archived`:
     `list` lists per config, `get` returns `undefined` (body not injected);
     the rejection reason is the lint findings.
   - ASK confirmation (human admit/demote) goes through the shared
     `approval/request` waterfall — no self-built channel; listeners never
     throw (shared principles 1, 2).
2. **Utility tracking → demote proposals**. A `get` hit records one
   invocation (the model loading a body via the `skill` tool necessarily
   passes through `get`); outcomes use **proxy signals** (stated explicitly —
   misjudgment is not ruled out): the error rate of the tool calls immediately
   following a skill load (followErrors/followCalls) against the session
   baseline, combined with lastUsed, computes three classes of demote
   triggers — failure-correlated (exceeds `failureRatio`), stale (unused
   beyond `staleDays`), security (an old version fails re-check after a lint
   rule upgrade). A trigger generates a demote proposal (circuit-breaker; the
   DEMOTE to `archived` executes only after human confirmation); `utility`
   data feeds the report. Judging the true payoff is left to the doc 12
   eval-harness for held-out evaluation.
3. **Rollback**. The store is versioned by contentHash; rollback = point
   `activeVersion` back to a parent version + `control.invalidate()`
   (triggering registry cache refresh → `skills/change` → catalog re-render).
   Any historical version can be re-activated at any time; hashes in
   rejectionMemory are never auto-revived.

### Built-in lint rules

Each: `{ id, severity: 'info' | 'warn' | 'block', message }`; under `enforce`,
`block` lands the skill in `candidate` or rejects it; under `audit` it is only
recorded. Initial rule set:

| id | Rule |
|----|------|
| `shape/frontmatter` | `name` + `description` required; `name` passes `isSkillName` (exported by the skill package); `disable-model-invocation` maps correctly onto `SkillInvocationPolicy` (aligned with `skill-filesystem/src/index.ts:992-999`) |
| `shape/body` | body non-empty; no illegal instruction blocks |
| `resource/manifest` | every referenced file declared in frontmatter exists in the skill directory; `resourceBase` consistent with the directory layout |
| `safety/override-phrase` | imperative override phrases targeting the agent ("ignore previous instructions", "do not follow", "you must always/never", etc. — Chinese and English patterns) |
| `safety/base64-blob` | contiguous base64/hex blobs above a threshold (default 128 chars) |
| `safety/network-egress` | unexpected network calls in the instructions (curl/wget/fetch URLs, webhook addresses, hard-coded IPs) |
| `safety/secret-ref` | references to credential paths or env-var exfiltration (`~/.ssh`, `$TOKEN` concatenation echoed back, etc.) |
| `grant/resolvable` | every name in `allowed-tools` resolvable via `ctx.tools.get`; unresolvable ⇒ block |
| `grant/mode-compat` | warn when grants are non-empty and the mode folded via `foldPermissionMode(agent.session.events)` is `'plan'` (read-only window); under `bypassPermissions`, raise egress/secret severity by two notches. Note: the plan-mode overlay is applied by the engine at call time, so a folded value may miss a live plan overlay |

**Rejection memory**: rejected contentHashes are persisted; re-importing the
same hash is rejected outright, with the first-run lint findings attached (the
admission-side port of SkillOpt's rejection memory) — avoiding duplicate
computation and the "rename-and-reimport" bypass.

## Milestone breakdown

Each M is an independently mergeable PR (scaffolded from
`pnpm new:plugin skills skill-lifecycle`, all gates green).

- **M1: governed provider + admission core + provenance store**
  file-system skill-dir provider (three rules: shape / resource /
  grant-resolvable) + `SkillGovernanceRecord` store (persisted via `ctx.fs`,
  content-addressed) + `list/get` gating + unit tests.
  Verification: fixture skill directories (well-formed / missing description /
  missing resource files / unresolvable grant) each yield the expected
  outcome; `active` skills appear in `<available_skills>`, rejected skills do
  not; store state survives restart.
- **M2: safety lint + state machine + `/skill-admin` + telemetry**
  the four safety rules and the three mode tiers; the
  `candidate/active/archived` state machine with audit events;
  `ctx.commands.register` wires `/skill-admin list|admit|archive|report`
  (naming rationale: CC's user-facing `/skills` carries browse/invoke
  semantics, so the governance domain uses a separate `skill-admin` to avoid
  ambiguity and conflict); transitions/findings are written into the
  `session-telemetry/record` waterfall (shared principle 5; schema aligned
  with doc 12).
  Verification: after `/skill-admin admit`, the skill can be injected by the
  `skill` tool in the same turn; in audit mode, block-level findings are
  recorded but not enforced; telemetry event fields match the doc 12 schema.
- **M3: utility tracking + demote/rollback + import lint + docs**
  invocation/follow-error statistics; the three demote triggers +
  human-confirmation path; rollback (re-activate a historical version); batch
  import lint (`skill-admin import <dir>` subcommand or an equivalent repo
  script, emitting a per-skill report); README (including graduation
  criteria).
  Verification: a synthetic event stream above `failureRatio` yields a demote
  proposal that takes no effect before confirmation; after rollback, `get`
  returns the old contentHash body and `skills/change` triggers a catalog
  refresh; the import report contains every lint finding and the final state.

## Verification plan

- Unit: positive/negative cases for each lint rule; state-machine transition
  tests (including rollback and rejectionMemory); store persistence
  round-trip.
- Integration: the full fixture skill-directory set (benign / injection copy /
  base64 blob / egress / bad grant / missing resources) → provider → assert
  catalog contents and the `skill` tool's `get` behavior; smoke-test the
  `skills/change` invalidation path.
- Manual: full chain in a real session —
  `/skill-admin list → admit → invoke → report → archive → rollback`; run the
  same fixture once under audit and once under enforce.
- Observation: report output — the lint-finding distribution and false-block
  rate (audit data) — as evidence for graduation criterion (c).
- Gates: all three checks green; before switching to verification, per the
  workflow, return to plan mode first to pin down observable pass criteria.

## Risks and open questions

1. **Instantiating the delegated core fs provider**: the class is exported
   (`skill-filesystem/src/index.ts:146`), but its constructor signature and
   its `ctx` dependencies are unverified. Check: read how that file organizes
   the constructor and `apply` (`:130`); if it cannot be instantiated
   standalone, fall back to self-scanning directories (thin logic — only
   frontmatter parsing + root enumeration).
2. **Plugin-side read access to `permission/mode`** (partially resolved):
   event-read is resolved — plugins read the mode via
   `foldPermissionMode(agent.session.events)` (exported by
   `@deepseek-ai/dsh-permission-rules`,
   `packages/interaction/permission-rules/lib/types/index.d.ts:103`;
   last-wins fold), or by subscribing to `session/event` filtered on
   `event.type === 'permission/mode'`. Remaining caveat: the plan-mode
   overlay is applied by the engine at call time, so a folded value may
   miss a live plan overlay.
3. **Event name for follow-error statistics**: `agent/post-tool` or an
   equivalent tool-result event is unverified. Check: survey the agent event
   table in `packages/core`; confirm the tool-call completion event and its
   error field.
4. **Plugin persistence directory**: the state-resolution API is unverified.
   Check: which ctx service existing stateful plugins (e.g. the memory family)
   use to persist.
5. **Ungoverned bypass**: when a profile also enables the core
   `skill-filesystem`, skills that have not passed the gate still enter the
   catalog (aggregation semantics, `skill/src/index.ts:552-620`). Mitigation:
   hard documentation constraint + near-tier shadowing (`:346-356`);
   longer-term, a profile-consistency check can be added in the doc 06
   control-plane.
6. **Catalog presentation of candidates**: catalog rendering belongs to
   tool-skill (`tool-skill:254-277`) and we will not fork it ⇒ the candidate
   marker can only ride in `metadata`, and whether the renderer displays it is
   out of our control; acceptable (the default `candidateInCatalog: true` is
   visibility only — injection is already gated by `get`).
7. **Ceiling of heuristic lint**: both false positives (blocking benign
   skills) and bypasses (reworded copy) are inevitable; tune thresholds with
   real audit-mode data and keep block rules few and precise; jailbreak-level
   adversaries are not a goal of this package.
8. **Explicit non-goals**: runtime skill composition / retrieval rerank
   (SkillCorpus-style) and offline skill synthesis — both not done; coverage
   and payoff judgments are follow-ups, to be revisited once the doc 12
   eval-harness provides held-out measurement.
