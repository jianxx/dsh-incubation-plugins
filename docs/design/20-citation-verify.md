# 20 citation-verify — Three-Layer Citation Attribution Gate (link / content / support)

> Status: design (not started) | Tier: 3 | Package: packages/science/citation-verify | Dependencies: no compile-time dependencies; at runtime can be registered by [19 evidence-registry](19-evidence-registry.md) in the verifier role for claim_level 2/4 tiers; optional integration with 15 scholar (number reserved, document in planning)

## Design Goal and User Problem

**Goal**: a `citation_check(claims[])` tool plus a dual audit gate that judges every citation-bearing claim the agent writes across three layers — `link` (citation identifier resolvable, resource exists), `content` (the quoted passage can be located in the source document and aligns with the source span), `support` (the source content substantively supports the claim) — and produces versioned, persistable, reviewable verdict artifacts.

**User problem**: in deep-research / literature-review sessions, users receive output that "looks cited" — links open, topics are adjacent — but nobody has verified "does this citation actually support this claim." The title only promised citation UX, not an evidence chain; once fake citations enter a wiki / report / knowledge base, the user can only click through and verify each one by hand — which is precisely the job they believed they had outsourced.

## Motivation (Why Necessary — Citation Appearance ≠ Evidentiary Support)

Two papers decompose this layer very clearly, and this design directly materializes their layering:

- **Cited but Not Verified** (arXiv 2605.06635): the most dangerous failure mode of research agents is not "no citation" but **citations that do not support the specific claim** — output links open, topics are relevant, yet factual support is markedly weaker than the surface citation quality. That work explicitly splits source attribution evaluation into three layers: Link Works / Relevant Content / Fact Check. The three-layer judgment in this document is the engineering naming of those three layers: link = "link works", content = "content matches the quotation", support = "fact check". **Citation UX is not evidence verification** — this sentence is engraved in the motivation, reminding that every layer is an independent gate, and passing link without passing support is still failure.
- **Auditing RAG Hypotheses** (arXiv 2607.19415): advances attributable checking from post-hoc diagnosis to **gating at generation time** — retrieved segments are assembled into context with stable evidence IDs (`obs:`/`jump:`/`lit:`/`path:`) and produce structured hypotheses; the V1 gate mechanically checks "does the cited ID genuinely exist in the context", and the V2 gate performs a content-compatibility audit; in the reported run, 136 hypotheses had V1 **zero invalid citations**. Conclusion: running the mechanical gate first annihilates an entire class of hallucination at extremely low cost; the expensive semantic gate only invests in content that passed the mechanical gate.

Engineering consequences: first, the mechanical layer must run first and must be fully automatic (doi/arxiv resolution + GET/HEAD or scholar hit), at zero model cost; second, the semantic support gate's verdicts must be versioned and persisted, otherwise they are not reviewable — mitigations for the LLM judge's non-reproducibility are given in "Risk 1"; third, the output is not a single "pass/fail" sentence but a per-layer verdict plus evidence pointers, consumed by [19 evidence-registry](19-evidence-registry.md)'s belief gating as verifier evidence for claim_level 2/4 tiers.

## Current State and Gaps

dsh current state (verified, see "Surfaces and Seams" in the next section):

- Tools have a unified registration surface (`ctx.tools.register`, mandatory output schema + render), and tool-result contract admission is doc 02's turn-level territory — **no current plugin validates the domain proposition of "external literature citations"**.
- A unified observation outlet exists: `session-telemetry/record` waterfall (ops channel); doc 02 already demonstrated the `<plugin>/<op>` naming convention; doc 12's trial exporter consumes ops records for L2 process metrics — the audit log has a ready-made channel and downstream consumer.
- The scholar seam (15, a reserved-number sibling work item, document in planning) does not exist yet; doi/arxiv resolution and HEAD reachability checks have zero precedent in the repo.

The gaps are exactly three layers: (a) no citation identifier resolution and existence check (link); (b) no "quote passage ↔ source span" alignment (content); (c) no adjudication of "the source substantively supports the claim" (support). There is also an engineering gap: verdict artifacts have no stable ID and no persistence location, so audits cannot be replayed.

**Boundary with 02 claim-contracts**: 02 governs **turn-level honesty** — whether the agent's self-report "tests have passed" reconciles with this session's tool events; its judgment domain is **in-session events**. This plugin governs **domain attribution** — whether the claim reconciles with the **external literature** it cites; its judgment domain is the external world. The two layers do not substitute for each other: a claim can be turn-level supported (the agent did invoke web search) while failing the citation layer (the paper found does not support the claim).

## Design

### Surfaces and Seams (exact names + verified paths; literature anchors live in the Motivation section)

Every item below was verified against upstream dsh source; sibling work item (15), not yet landed, appears only in "Risks and Open Questions" and in the joint-test milestone.

1. **Tool registration seam — `ctx.tools.register(definition)`**
   `deepseek-harness/packages/core/tools/src/index.ts:1037` (returns a dispose function).
   Note the hard requirement: `ToolDefinition` must declare `output: { schema, render, presentationMeta? }`,
   otherwise it throws `TypeError` immediately (`:1039-1042`, verified). The verdict of `citation_check`
   flows through the structured `output.schema`; `render` produces the human-readable summary shown to the model.
2. **Telemetry seam — `session-telemetry/record` waterfall**
   `deepseek-harness/packages/session/session-telemetry/src/index.ts:43` (signature),
   `SessionTelemetryRecord` structure `:55-`: `channel: 'ledger'|'ops'`, `severity`,
   `attributes`, `body`; sink `emit()` enqueues non-blockingly (:104). Ops-channel records
   carry a `telemetry.op` attribute (same file comment, verified). The audit log follows doc 02's
   `claim-contracts/admission` naming convention: `cite-check/result` (per claim),
   `cite-check/gate` (enforce interception).
   Important property: the coordinator contains listeners that throw (`coordinator.ts:205-216`'s
   `redact()`, run inside `contain`; throw = that record is held back, fail-closed) —
   our emission must be fire-and-forget, depending on no return value.
3. **Eval export alignment — doc 12**
   [12-eval-harness](12-eval-harness.md)'s trial exporter takes plugin-attributed telemetry
   as one kind of activation evidence; `cite-check/*` op records land in the trial transcript
   as this document's L2 process metrics. Schema fields follow 12's head-line fingerprint
   convention; we do not invent our own metric vocabulary (overview principle 5); if extension
   needs arise, align with 12 during review and then revise this document.
4. **19 registration-point seam — `cite://<check_id>` (air-dropped contract)**
   [19 evidence-registry](19-evidence-registry.md)'s belief_update gate requires
   `gate_ref` to be resolvable: this document promises `cite://<check_id>` → persisted artifact
   `.science/cite-checks/<check_id>.json`, whose Artifact contains the tools version, prompt template version,
   and per-layer verdicts, for 19's M2 to check "citation resolvable + tier attained". The format is exactly
   this document's "Data Model" section; **19 depends only on this URI contract and file format, with zero compile-time dependency**.
5. **15 scholar seam reservation (optional runtime integration)**
   When a claim carries `evidence_id` (15's stable evidence ID, shaped like a `lit:` prefix), `citation_check`
   prefers the scholar span cache for content comparison and skips HTTP fetching. This is an **optional runtime integration**:
   when 15 is not registered, the same claim takes the HTTP path, and behavior does NOT degrade into failure (branch logic in the behavior flow).
   Zero compile-time dependency (overview principle 1).
6. **Consumer hook — do not modify others' flows (air-dropped contract)**
   The enforce tier is **invoked by consumers**: a writing skill / the Wave 3 science-report,
   before "submit/publish-type" actions (writing a wiki page / a report final draft), hands the
   citation-bearing claims in the to-be-published paragraph to `citation_check` and treats `fail` as the exit condition.
   This plugin **never** modifies other-plugins' flows or registers pre-execute interception on others' write
   tools — it is a tool provider + contract document, not a gatekeeper process.

### claim_level Tier Mapping (Registration Contract with 19)

[19 evidence-registry](19-evidence-registry.md) labels hypotheses with `claim_level 1–5`;
each level requires a verifier gate of corresponding strength. This plugin commits to covering two tiers (the mapping
table is authoritative in 19; this is the 20-side self-declaration, for 19's M2 check to compare):

| 19 tier | Semantics | 20's coverage | gate_ref shape |
|---|---|---|---|
| 2 rule check | Mechanically decidable formal checks | V1 mechanical gate (link + content) | `cite://<check_id>` and V1 all-pass in the result || 4 domain audit | Semantic-level substantive verification | V1 + V2 (incl. support) | `cite://<check_id>` and results contain a support verdict |

Tier 3 (execution review) is covered by 03-trace-gate-style runtime evidence; tier 5 (formal verification) is outside this plugin's scope
— declaring **not doing** this is part of the contract: 19 must not reference `cite://` for tiers 3/5, and M2's tier
check should reject based on this document's table (preventing tier usurpation of "passing citation checking off as execution review").

### Data Model / Configuration

`citation_check` input (JSON):

```ts
{
  claims: [{
    id: string                    // named by the caller; results point back to it
    text: string                  // claim text
    citation: {
      kind: 'doi' | 'arxiv' | 'evidence_id' | 'url'
      value: string               // literal doi / arxiv id / 15's evidence_id / url
      quote?: string              // the source passage excerpt given by the claimant; comparison target of the content layer
    }
    importance?: 'low' | 'high'   // default low; input to the support gate's sampling policy (see V2)
  }]
}
```

Output (the shape of `output.schema`; rendered summary lives in `render`):

```ts
{
  check_id: string                // stable ID, the last segment of the cite:// URI; content-addressed (hash of input + template version)
  results: [{
    claim_id: string
    link:    { verdict: 'pass'|'fail', detail: string }   // resolution succeeded + resource reachable
    content: { verdict: 'pass'|'fail'|'skip', detail: string } // quote localization success; skip when no quote
    support: { verdict: 'pass'|'fail'|'skip', score: number,   // only run for V1 survivors
               rationale: string, judge: { model, template_version } }
    overall: 'pass' | 'fail'      // see the dual-gate aggregation rule in the behavior flow
  }]
  totals: { pass: number, fail: number, by_layer: {...} }
}
```

The verdict artifact `.science/cite-checks/<check_id>.json` persists the full output set plus
`{ tool_version, template_version, judged_at, source_meta(url/doi status, fetched_bytes_hash) }`,
serving as 19's gate_ref dereference target and the manual review entry point (doc 00 "claim nothing without observation"; the artifact is the observation surface).

Plugin configuration (`config:` section; three tiers inherit overview principle 3):

```ts
{
  mode: 'off' | 'audit' | 'enforce'     // default audit
  support: {
    threshold: number                   // score < threshold → fail, default 0.7
    judgeModel?: string                 // standalone judge model config; defaults to the host model — Risk 3 discusses circularity
    samplePolicy: 'all' | 'high-only' | { sampleRatio: number }  // V2 sampling default all
    templateVersion: string             // shipped with the package; explicitly bumped on upgrade
  }
  link: { timeoutMs: number }           // default 10s; shared by HEAD and the GET fallback
}
```

### Key Behavior Flows

**Mechanical gate (V1, fully automatic, zero model calls)**: per claim — `link`: `kind=doi` resolves to
`doi.org/<doi>`, `kind=arxiv` resolves to `arxiv.org/abs/<id>`, then HEAD (on 429/405/timeout may
degrade to GET with range truncation); 2xx/3xx = pass, 4xx/network error = fail; when `kind=evidence_id`,
query the 15 registry (absent → `link: fail, detail: 'scholar seam unavailable'`); `kind=url`
is HEADed directly. **Results for the same reference are cached in-session by (kind, value)**, so re-citations
in a report do not hit the network repeatedly.
The link layer's detail code table (listed in the data-model section) is the stable interface for audits and golden-set assertions.
`content`: when `quote` is present — fetch text from the source hit by link (or 15's span cache), normalize
(case / whitespace / hyphenation), then run a dual judgment of containment and fuzzy containment (edit distance ≤ 5% of length); failing both means
fail with detail stating "quote not in source"; for HTML sources, strip tags and extract the body first (readability-style extraction is an
implementation detail). When `quote` is absent, `content: skip` (with no anchor, do not pretend to have verified — this is an honesty
constraint, not laziness).

**Dual audit gate aggregation** (the Auditing RAG V1/V2 mapping): V1 = `link` ∧ (`content` is pass or
skip); those failing V1 get `overall: fail` and short-circuit directly — **content that fails the mechanical gate gets no semantic-gate investment**.
V2 = `support`: only V1 survivors enter, sampled per `samplePolicy` (with `high-only`, only importance=high runs);
the LLM judge uses a fixed template (task: given the claim text + quote/span, answer with a
0/0.5/1 support score and a one-sentence reason), `score < threshold → fail`. The template v1 outline shipped with the package
(a versioned object, not free-form disclosure): role ("You are a fact-checking judge; rely solely on the given source passage") →
three input sections (claim verbatim / citation quote / source span window) → output contract (
`{support: 0|0.5|1, rationale: ≤40 chars}` as JSON, no prose) → adjudication hints ("partial support
or topically related but not asserted = 0.5; source does not address it = 0"). When the judge is unavailable (config lacks a model),
fail-closed produces `support: skip, verdict: fail` only when mode=enforce; under audit it records
an `unverifiable-style skip` and emits `severity: warn` in telemetry (inheriting EG-VAR's
abstain-is-not-violation semantics, see doc 02's Motivation section). `overall` = pass only if every layer that ran passed.

**The dual gate's position in Auditing RAG coordinates**: the V1 gate corresponds to their "cited ID validity" check (whether the
Cited ID exists in the context); we generalize it from in-prompt IDs to the existence of doi/arxiv/url; the V2 gate
corresponds to their "content compatibility" audit. The paper's optimistic-looking figure of 136 hypotheses with zero V1 invalidity holds only
given the premise that **evidence IDs are assigned by the system, not invented by the model** — likewise, this plugin requires quotes to be verbatim excerpts and
evidence_id to be assigned by 15; identifiers freely generated by the model naturally fail at the link layer with high probability (i.e., the entire class of
hallucinations that the mechanical gate eliminates in the paper).

**Three-tier behavior** (overview principle 3):
- `off`: the tool can still be invoked explicitly (returns results), but emits no telemetry and the gate hook is treated as absent.
- `audit`: normal judgment + telemetry (`cite-check/result` per-run summary). Consumers may publish as usual.
- `enforce`: the same judgment; convention has consumers treat `overall: fail` as a publish veto —
  this plugin side only guarantees that the **returned structure carries fail with layer details**, and additionally emits the `cite-check/gate` op
  (attributes include `check_id`, `failed_claims`). The veto action lives on the consumer side (air-dropped contract;
  this repo does not modify skill/report flows).

**Verdict persistence and versioning**: each invocation persists one artifact (content-addressed check_id = sha256(
canonical(claims + template_version + tool_version)); re-runs with identical input reuse the same ID).
Upgrading the support template bumps `template_version`; historical artifacts are permanently immutable — reviewability is
the load-bearing wall of "LLM judge being auditable" (see Risk 1).

**Audit telemetry vocabulary** (ops channel; naming follows doc 02 precedent, downstream aligned with doc 12 export):

| op | Trigger point | attributes | severity |
|---|---|---|---|
| `cite-check/result` | once per invocation (summary) | `check_id`, `claims`, `pass`, `fail`, `v1_fail`, `v2_fail` | `warn` when fail>0, otherwise `info` |
| `cite-check/gate` | enforce mode with at least one failing claim | `check_id`, `failed_claims` (comma-separated ids) | `warn` |

body carries the full results JSON (same shape as the persisted artifact); per overview principle 5, if after 12 lands the
export schema dictates otherwise, change the vocabulary to follow 12 without changing the semantics.

**15 integration path**: claims with `kind=evidence_id` use 15's span cache directly for content comparison
without touching the network; if 15 is not deployed, that kind fails at the link layer with the reason stated (it does not crash).
This preference ordering also serves 15 in reverse: after 15 lands, any write-library content citing literature should prefer evidence_id,
in exchange for deterministic span alignment.

## Milestone Split (each M = one PR's granularity + a "Verification:" observable criterion)

- **M1 — link + content mechanical layer + artifact persistence + unit tests**: `citation_check` tool registration,
  doi/arxiv/url link resolution (injected HTTP client, fully mocked in unit tests), quote normalization and
  span matching, `.science/cite-checks/` artifact writing, telemetry op emission,
  `pnpm new:plugin science citation-verify` skeleton.
  **Verification**: drive = vitest unit tests, mock HTTP injecting the four states 200/404/429/timeout;
  observable result = link verdict correct under all four states, content judgment correct for quote in/not-in source,
  artifact files persisted by check_id and content-addressed (second identical-input invocation reuses the same file);
  pass condition = `pnpm typecheck && pnpm test` all green, covering all four states and normalization edge cases.
- **M2 — support LLM judge layer + prompt template versioning**: judge implementation (LLM-call abstraction,
  configurable model), template file shipped with the package + `template_version` recorded in artifacts, score-threshold adjudication,
  sampling policy, judge-absent fail-closed/skip tiering.
  **Verification**: drive = unit tests (mock judge returning fixed scores) + one real-model smoke test
  (README records the command and output); observable result = overall flips as score crosses the threshold, template version
  appears in every artifact, judge-absent produces fail+skip under enforce and produces
  warn telemetry under audit; pass condition = unit tests all green + smoke artifact human-readable.
- **M3 — three-tier config + audit log completion**: mode parsing (off silent / audit records /
  enforce adds gate op), `cite-check/result` and `cite-check/gate` end-to-end,
  README (with graduation criteria and integration instructions for the writing skill / science-report).
  **Verification**: drive = synthetic invocation sequences (same input run once under each of the three tiers);
  observable result = zero telemetry under off, result-without-gate under audit, dual emission under enforce;
  pass condition = telemetry entry assertions exact to op name and check_id attribute.
- **M4 — 15/19 joint test (optional at runtime, does not block merge)**: after 15 lands, the evidence_id path
  uses the span cache; 19 consumes `cite://<check_id>` as the claim_level 2/4 gate_ref;
  run the full end-to-end of "registry belief_update referencing a 20 verdict" once.
  **Verification**: drive = scripted session (`dsh --profile headless` + llm-mock,
  per [12-eval-harness](12-eval-harness.md)'s current seam table);
  observable result = 19's belief_update rejects missing gate_ref / insufficient tier, accepts
  legal cite:// references, and the telemetry chain is complete;
  pass condition = all end-to-end assertions pass. If 15/19 are not ready this M defers; the first three Ms are not blocked.

## Verification Plan

- **Layer one (pure functions)**: link normalization (all of doi/arxiv/url kinds), quote normalization and containment
  judgment, sampling policy, threshold adjudication, content-addressing stability of check_id.
- **Layer two (mock integration)**: injected HTTP client covering 2xx/4xx/429/timeout/malformed URL;
  mock judge covering the full score spectrum and timeouts; artifact file round-trip.
- **Layer three (synthetic session)**: `dsh --profile headless` + llm-mock driving a writing scenario that
  produces a paragraph containing a fabricated DOI; assert that at the enforce tier `cite-check/gate` appears and
  overall=fail (see DoD 3).
- **Layer four (golden set)**: 30 manually annotated entries (four classes: genuinely supported / wrong link / wrong content /
  unsupported; sources: public papers + hand-crafted mismatches); mechanical-layer accuracy 100% as the passing line;
  support-layer F1 ≥ 0.8 and all "wrong link / wrong content" entries judged fail (short-circuit semantics).
  The annotation set and judgment script are checked into the repo (`bench/`-style, not entering the packages release surface).
- Gate commands: `pnpm typecheck && pnpm test` (in a worktree run
  `bash scripts/link-worktree-deps.sh` first; see CLAUDE.md).

## Risks and Open Questions

1. **Reproducibility of the support judge**: LLM judgment drifts with template and model. Mitigation: template versioning into artifacts +
   verdicts persisted to disk + same-input content addressing; reproducibility further relies on a pinned `judgeModel` (no default upgrades accepted).
   Check item: when M2 lands, add a test pinning "template upgrade → historical artifact IDs unchanged; new artifacts differ in version".
2. **Paywalls / anti-crawling**: HEAD/GET may return 403 for resources that actually exist. Policy: the link-layer verdict expresses only
   "reachability"; 403/401 scenarios are faithfully marked in detail and not misreported as nonexistent; when the support layer has no readable source,
   treat as abstain (skip) rather than fail (audit tier). The cost of a false-positive block exceeds that of a false-negative pass;
   the audit tier's leniency is an intentional asymmetry.
3. **Circularity risk of judge model and examinee being same-source**: if writing and judging share a model with the same defect distribution,
   "support" verdicts may skew systematically high. Mitigation: `judgeModel` can be configured to an independent model, and the README
   recommends heterogeneous configuration; the reason the sampling strategy defaults to `all` rather than sampled at the enforce tier is also
   to raise the probability of catching circular failure. Open question: whether N-model voting is needed — to be decided by golden-set data.
4. **15 timing gap**: the evidence_id path provides only fail-loud degraded behavior before 15 lands.
   If 15 is cancelled, that kind is retained but downgraded to alias-of-url — this needs a review decision and is not prejudged in this document.
5. **check_id content addressing vs adjustable adjudication**: the template version entering the hash means fixing a template changes the check_id;
   old cite:// references on the 19 side still resolve (the files don't move), but "re-judging the same claim" does not produce a
   new artifact — this is a feature (history is replayable), and 19's documentation must state clearly that "gate_ref is a point-in-time snapshot".
6. **Consumer discipline for the enforce hook**: this plugin only gives the verdict; whether to veto is up to the caller;
   if the consumer forgets to check overall, the fail information is silently lost. Mitigation: the enforce tier's
   `cite-check/gate` op serves as an independently auditable surface; doc 12's activation check can treat
   "a gate op exists yet the artifact was still published" as a violation signal. Check item: verify during the M4 joint test.

## Unit Acceptance (Definition of Done)

- [ ] [auto] golden set of 30 entries: mechanical-layer link/content judgment accuracy 100% as passing line,
  wired into CI as a gate (runset embedded in `pnpm test`).
- [ ] [auto] golden set: support layer F1 ≥ 0.8 on the annotated set, and all "wrong link / wrong content" entries
  judged fail (regression guarantee of V1 short-circuit semantics).
- [ ] [auto] enforce-tier negative case: in a scripted session (headless + llm-mock), a writing submission with a fabricated DOI
  triggers the `cite-check/gate` op, and `overall: fail` appears in the returned structure.
- [ ] [auto] audit log contract: op records of `cite-check/result` / `cite-check/gate`
  contain the `check_id` attribute and sink `emit()` is non-blocking (mock sink asserts non-await).
- [ ] [auto] artifact reviewability: check_id reuse on second identical-input invocation, template version recorded in artifacts,
  files under `.science/cite-checks/` immutable (write-failure test).
- [ ] [joint test] 19 belief_update accepting `cite://<check_id>` as the claim_level 2/4
  gate_ref, end-to-end acceptance path (M4).
- [ ] [manual] README "graduation criteria" section ready; one real-profile run of the audit
  tier across ≥5 sessions with manual spot-checking that gate ops cause no false blocks.
