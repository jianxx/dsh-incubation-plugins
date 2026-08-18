# Incubation design specs — index

Source: gap analysis of `deepseek-harness` (dsh core) + `dsh-cc-plugins` (the
CC-parity plugin set) against the agent runtime/harness literature synthesis
("Agent Runtime and Harness Systems: From Session Scripts to Agent-Native
Serving Plane"), revised after an independent review pass.
Each document is one incubation work item, split into PR-sized milestones.
Number order is the build order.

## Analytical frames (three lenses)

1. **Three-layer verification stack** (layers are not substitutable):
   trace property → action gate → claim contract
   (AgentLTL / Reason-Less-Verify-More / Prompts-to-Contracts, Forethought, EG-VAR)
2. **Three-layer state recovery**: resumable event stream → resumable execution
   environment → goal-verification gate (CRAB / Goal-Autopilot / GODR)
3. **HarnessScaling's six dimensions** R/M/C/S/O/G + the skill/tool artifact
   lifecycle (SkillOpt → the eight-stage Dynamic Agent Skills taxonomy)

## Already covered (do NOT rebuild)

Three-state permission engine (`permission-rules` in dsh-cc-plugins), lazy tool
loading (`tool-search`), worktree isolation, subagent fork, coordinator mode,
CLAUDE.md-style memory + consolidation, microcompaction, the CC hook bridge,
session persistence/fork/resume.

## Explicitly out of scope (upstream core or serving plane)

CRAB-style OS checkpointing (sandbox internals), PatchOptic authority triples
(runtime admission algebra), KV reuse / speculative decoding / WorkflowCompile
(serving plane), TUI, auto-update, multi-user collaboration.

## Shared design tenets (binding for every work item)

1. **ASK goes through the `approval/request` waterfall** — no hand-rolled
   confirmation channel. Plugin code never calls the waterfall directly from a
   `tools/pre-execute` listener: return `{kind:'ask', reason}` and the tool
   registry resolves it internally via `serviceAsk` (verified upstream).
2. **Turn-end intervention = steer-back continuation, not veto**:
   `agent/turn-stopping` fires serially only at natural turn end; a plugin
   continues the turn by steering (injecting a plugin-attributed user message).
   A throwing listener ends the turn with an error — listeners must never throw.
   Steer messages participate in round accounting, so plugin attribution must be
   set correctly.
3. **Enforcement strength is a tunable config dial** (the SafetySentry
   continuum): every gate-style plugin ships `off / audit / enforce` modes and
   an adjustable ASK threshold; no hard-coded policy.
4. **tool-manifest is the shared substrate**: effect classes, idempotency
   recipes, disclosure classes, verification probes — per-tool metadata lives in
   exactly one annotation mechanism (doc 01).
5. **Observation flows uniformly through the `session-telemetry/record`
   waterfall (ops channel) + the session/event stream**. Custom session event
   types are closed to downstream plugins — no new session event types.
6. **Milestones = PR granularity**: every M is independently mergeable with an
   observable pass criterion; `pnpm new:plugin <group> <name>` scaffolds the
   skeleton and all presubmit gates must go green.

## Work items

| # | Doc | Tier | Package | Depends on | Literature anchors |
|---|-----|------|---------|-----------|--------------------|
| 01 | [tool-manifest](01-tool-manifest.md) | 1 (substrate) | verification/tool-manifest | — | Verified Tool Calls, TokenWall, cross-cutting |
| 02 | [claim-contracts](02-claim-contracts.md) | 1 | verification/claim-contracts | 01 | Prompts-to-Contracts, Forethought, EG-VAR |
| 03 | [trace-contracts](03-trace-contracts.md) | 1 | verification/trace-contracts | — | AgentLTL, Reason-Less-Verify-More, ToolFailBench, SafetySentry |
| 04 | [goal-verify-gate](04-goal-verify-gate.md) | 1 | goals/goal-verify-gate | — | Goal-Autopilot, GODR |
| 05 | [long-run-protocol](05-long-run-protocol.md) | 1 | session/long-run-protocol | (04 optional) | Effective Harnesses, Harness Design |
| 06 | [issue-pilot](06-issue-pilot.md) | 1 | control-plane/issue-pilot | 04, 05, 01 | Symphony, SwarmResearch (branch isolation) |
| 07 | [rules-lifecycle](07-rules-lifecycle.md) | 2 | memory/rules-lifecycle | — | Self-Improving Coding Agents, AMV-L, MemCon |
| 08 | [skill-lifecycle](08-skill-lifecycle.md) | 2 | skills/skill-lifecycle | — | Dynamic Agent Skills (8 stages), Progressive Crystallization, SkillOpt |
| 09 | [token-wall](09-token-wall.md) | 2 | security/token-wall | 01 | TokenWall, Semantic Gateway, compositional harm |
| 10 | [verified-tools](10-verified-tools.md) | 3 | verification/verified-tools | 01 | Verified Tool Calls (2608.02645) |
| 11 | [silent-failure-watch](11-silent-failure-watch.md) | 3 | observability/silent-failure-watch | — | When Errors Become Narratives, ToolFailBench, OAT, AgentCheck |
| 12 | [eval-harness](12-eval-harness.md) | 3 | eval/eval-harness | 03, 11 | GSME, Rethinking Harness Evolution, Demystifying Evals |
| 13 | [subagent-context-scope](13-subagent-context-scope.md) | 3 (spike first) | agents/subagent-context-scope | — | PerspectiveGap, PatchOptic (projected read) |

## Build order and merge strategy

```text
01 ──► 02 ─┐
01 ──► 03 ─┼─► 06 (pressure-tests 04/05)
04 ──► 05 ─┘
01 ──► 10 ; 01 ──► 09
07 ; 08 ; 11 independent  →  12 consumes the event schemas of 03/11
13 runs its M0 spike first; the feasibility verdict decides whether to build
```

- **Wave 1** (stand up the three-layer verification stack): 01 → 02 + 03 → 04
- **Wave 2** (end-to-end pressure test): 05 → 06 (issue-pilot drives 04/05 for real)
- **Wave 3** (governance and security): 07, 08, 09 in parallel
- **Wave 4** (depth): 10, 11, 12; 13 depends on the spike verdict

## Graduation criteria (incubation → dsh-cc-plugins or upstream)

An incubating package is nominated for graduation when: (a) all presubmit gates
green for ≥ 2 consecutive weeks; (b) a real profile uses it (not just tests);
(c) telemetry metrics prove value (e.g. mis-block rate, premature-completion
interceptions); (d) every item in the README's "graduation criteria" section is
checked off.
