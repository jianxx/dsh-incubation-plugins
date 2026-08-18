# 05 long-run-protocol — Long-Running Session Protocol

> Status: design (not started) | Tier: 1 | Package: packages/session/long-run-protocol | Dependencies: none (optional integration with 04)

## Design goal and user problem

**Goal**: provide a session protocol for tasks spanning hours and multiple context windows — an initializer that lands the init script + progress.md artifact, round-end enforcement of "incremental progress + a mergeable clean state", and, at context anxiety, a window swap without losing the task (fork reset + structured handoff continuation).
**User problem**: in the back half of a long task the agent develop context anxiety: the compacted history makes it read "a lot got done" as "it's done", or it loops re-narrating old messages; when the user comes back they face a session that can neither explain its progress nor be picked up by any fresh session, so the only move left is starting over.

## Motivation (why this is necessary — two failure classes: one-shotting + premature completion)

Effective Harnesses for Long-Running Agents identifies two structural failure
classes of long-running sessions: (one-shotting) the initial agent tries to
finish the entire task in one go, blows out the context midway, and is forced
to grind on inside a crippled context; (premature completion) after
compaction/round-splitting, the model misreads "a lot has been done" as
"everything is done" and declares completion prematurely. That article's
prescription is exactly this document's three pillars: an **initializer
agent** (landing an init script + progress log + first commit),
**incremental rounds** (each round advances exactly one step; one-shotting
is forbidden), and **leaving a mergeable clean state at the end of every
round** (progress updated + no casual dirty changes in the workspace).

Harness Design for Long-Running App Dev supplies the second piece: separate
"compression" from "reset" — when the context shows anxiety symptoms (the
model repeatedly misquotes old messages, attention drifts, overflow recovery
recurs), **context reset + a structured handoff artifact beats in-place
compression**: compression preserves a noisy summary, while reset discards
the narrative and passes along only verified state (goal/done/next/blockers/
evidence pointers). This design does not reinvent that article's
Planner/Generator/Evaluator role split: the Evaluator role is carried by
04 goal-verify-gate (optional runtime integration) — 05 owns only the
"process protocol", not the "completion verdict".

The dsh upstream has all the raw ingredients (append-only session log +
`sessions.fork` + resume surface + compaction plugins); what's missing is
**binding them into one protocol**: the progress artifact schema and format,
machine-enforced end-of-round checks (enforce mode), the full closed loop of
reset=fork+handoff, and telemetry.

## Current state and gaps

Verified (path:line citations listed item by item in "Surfaces and seams"):

- Sessions are a durable append-only log; `ctx.sessions.fork(source, boundary?)`
  already exists. It seeds a child session with an **inclusive event-seq
  prefix** and refuses to truncate inside an open turn. But "when to fork
  (how to pick the boundary), what to continue the context with after
  forking, and who drives the user to switch to the child session" — upstream
  has no protocol for any of these; fork is only a primitive.
- Compaction already has two upstream plugins (`compaction-basic`,
  `compaction-tool-result-pruner`) that perform **in-place surface
  replacement within the same session** (the durable log is untouched).
  There is no "window swap + handoff artifact" channel at all.
- The `agent/turn-stopping` serial hook already provides an "interception
  seam at natural wrap-up time" (verified in 04).
- **Three gaps** (plus telemetry): ① the format and on-disk convention of
  the progress/handoff artifact; ② end-of-round checks (was progress
  updated? is the state clean?) with steer-back enforcement; ③ fork-reset:
  boundary selection + handoff continuation + switch guidance; ④ supporting
  telemetry (rounds/resets/interception categories).

**Explicitly not doing**: no cross-issue scheduling and orchestration
(that's 06, see "Boundary with 06"); no Planner/Generator/Evaluator
multi-role split (Evaluator is carried by 04); no changes to upstream
`/compact` behavior — reset and compaction coexist and complement each
other (see "Boundary of reset vs compaction").

## Design

### Surfaces and seams (verified + cited)

1. **fork seam**: the `ctx.sessions` service key is already injected into
   `Context` (`packages/core/session/src/index.ts:38-40`); the signature is
   `fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session`
   (same file `:1081`). `boundary` = an **inclusive event seq** into the
   source log (not bytes/message count); if omitted, the source's current
   last event is used (`:1100-1105`); child seed = `events.slice(0, boundary+1)`
   (`:1137`), i.e. the **durable event prefix is carried verbatim**. The
   truncation point must not land inside an open turn: if the last
   `turn/start`/`turn/end` at the end of the seed prefix is a `turn/start`,
   it throws `SessionForkError('OPEN_TURN')` (`:1128-1135`). The child
   session header automatically carries `{cwd, parentSession, seedLength}`
   (`:1087-1094`; header field definitions
   `packages/core/session/src/types.ts:61-80`) — fork lineage is traceable
   by construction.
2. **Visible-context source**: the agent projects from the log when issuing
   a request — `this.session.deriveMessages()`
   (`packages/core/agent-loop/src/agent.ts:341`); per-node surface
   projection rules live at `packages/core/session/src/surface.ts:74-76`.
   → After fork, the child session's initial visible context = the event
   projection of the seed prefix; **seed events do not trigger the
   `session/event` firehose** (constructing the seed does not publish,
   `index.ts:451-455` firstLiveSeq comment). Therefore the handoff text
   cannot rely on "write it into the child session log and have it be
   seen" (surface appends on a non-driven session are unverified, see risk
   R1); it must go through the resume-time injection seam (item 6).
3. **System-prompt seam**: `ctx.systemPrompt.section({name, order, text})`
   returns an exact disposer
   (`packages/core/system-prompt/src/index.ts:381-390`); `PromptSection =
{ name, order, text | (AssembleContext)=>string, complete? }`(`:53-75`);
   re-registering the same name throws, scoped overrides global (by name),
   and empty text is dropped at render time (`renderPrompt` `:212-217`).
   An element provider runs on every assembly; `AssembleContext` carries
   `agent?` via declaration merging
   (`packages/core/agent/src/runtime-types.ts:16-20`), and the call site
   always passes `{agent, scope: agent}`
   (`packages/core/agent/src/dispatch.ts:174-176`, call site
   `agent-loop/src/agent.ts:230`) → **register one global provider that
   decides, by `context.agent?.session.id`, whether this session is in
   long-run mode**, with no scoped-vs-global contention. Take the
   conventional gap 200–299 for `order` (after tool guidance 100–199; do
   not insert before identity/persona).
4. **Command seam**: `ctx.commands.register(definition)`
   (`packages/interaction/commands/src/index.ts:245-252`),
   `CommandDefinition = { name, description, input?, recordInput?, handler }`
   (`:40-55`), name must match `[a-z][a-z0-9_-]*`(`:25`); the handler
   receives `CommandInvocation { commandId, agent, rawInput, signal }`
   (`:28-37`, with authoritative `agent.session`) and returns
   `{ kind:'success', text?, sourceEventSeq? } | { kind:'error', text }`
   (`:192-218`).
5. **Round-end interception seam**: `agent/turn-stopping`, `@mode serial`,
   payload `{ agent, turn, signal }`
   (`packages/core/agent/src/runtime-types.ts:261-278`); **fires only at
   natural wrap-up** — the turn has already produced `turnEnds` and the
   steering inbox is empty (`packages/core/agent-loop/src/agent.ts:295`);
   a listener throwing → the turn ends with error.conclusion(`:302-315`),
   **so the listener must never throw** (doc 00 tenet 2; wrap everything
   in try/catch). A steer continues **the same open turn** (after the steer
   the inbox is non-empty, so the loop goes through `next-step` instead of
   closing the turn, `:299-300`) → the "per-round cap" is counted keyed by
   `turn`.
6. **steer/inject attribution seam**: `agent.steer(message: UserMessage): void`
   (`runtime-types.ts:127-133`) injects steering for the next step;
   `agent.inject(...)` queues model-facing context for the next pre-step
   and does not wake the driver (`:135-143`). The message is built with
   `createUserMessage({ content, source })`
   (`packages/llm/llm/src/message.ts:192-199`), using source
   `{ kind:'plugin', plugin:'long-run-protocol', form:'notice'|'recall' }`
   (MessageSourceMap `:100-105`, form enum `:88-94`). Verified in doc 04:
   `kind:'plugin'` is not admitted by goal-round-driver as a new round
   (round admission requires `source.kind==='goal'` plus an exact sequence
   number) — **steer-backs do not consume round budget**, satisfying the
   attribution discipline of doc 00 tenet 2.
7. **Resume injection seam**: `agent/session-start` (emit, payload
   `{agent, source}`, `runtime-types.ts:207-217`); its comment explicitly
   says "Use `agent.inject()` to seed model-facing context";
   `SessionStartSource` includes `'resume'`(`:61`). When the child session
   is resumed by the host, source==='resume' and
   `session.header.parentSession` hits a local lineage record → inject the
   handoff.
8. **fs seam**: `ctx.fs: FileSystem`(`packages/fs/fs/src/index.ts:45-47`);
   the parts used are `resolve / processPath / stat / readText / writeText`
   (`:116 / :126 / :152 / :176 / :222`), instantiated per sandbox backend —
   never assemble `node:fs` paths directly.
9. **Telemetry seam** (unified observability, doc 00 tenet 5): service key
   `ctx.sessionTelemetry`
   (`packages/session/session-telemetry/src/index.ts:22-24`), sending port
   `SessionTelemetryBackend.emit(record)`(abstract `:166`), record shape
   `{ channel:'ledger'|'ops', time, severity, attributes, body }`(`:64-86`);
   the `session-telemetry/record` waterfall(`:26-47`) is an extension point
   for redaction, not a sending port. **This plugin sends everything on
   `channel:'ops'`**, attributes =
   `{ telemetry.op: 'longrun/<event>', session.id }`(op vocabulary
   discipline follows the peer comment at `:76`), details go in body; use
   after a null check on `ctx.get('sessionTelemetry')`.
10. **Context-pressure seam**: `ctx.tokenMeter.measure(session)` →
    `TokenMeasurement { totalTokens, surfaceTokens, ... }`
    (`packages/llm/token-meter/src/index.ts:74`, measure `:116`; types at
    `token-meter/src/types.ts:22-36`). Model-capacity resolution follows
    the compaction-basic precedent: read the routed {provider, model} from
    `session.requestHeader()?.config`
    (`packages/compaction/compaction-basic/src/index.ts:52-60`), then
    `ctx.llm.resolveModelInfo(provider, model).context.contextWindow`(same
    file `:294-303`). fill% = totalTokens / contextWindow.
11. **shell seam (optional)**: `ctx.shell: ShellExecutor`
    (`packages/shell/shell/src/index.ts:41-43`), `resolve(request): ShellExecSpec`
    - `run(spec)`(`:85, :93`) — the workspace-dirty check and the init.sh
      first commit go through it; when the service is absent, degrade to warn
      (risk R4).
12. **Event surface is closed**: custom session event types are closed to
    downstream plugins — the header comment of `known-event-types.ts`:
    "Downstream (out-of-repo) plugin events are outside this list by
    construction; a registration surface for them is deferred"
    (`packages/core/session/src/known-event-types.ts:7-15`) → this plugin
    **adds no new session events**; the state machine lives in `.dsh/`
    files, auditing goes through telemetry ops (same conclusion as doc
    02/04). The `tools/pre-execute` decision type and its resolution inside
    ask-registry follow doc 04 (`packages/core/tools/src/index.ts:582-591`);
    this plugin does not go through that seam.

### Data model / configuration (progress/handoff schema, thresholds, modes)

Fixed relative locations under the project root (`session.header.cwd`):

```text
.dsh/longrun/
  init.sh        # reproducible environment check script (executable template: versions/assertions/quick dependency self-check)
  progress.md    # progress log = handoff artifact (single source of truth)
  state.json     # plugin-private: where lineage and config land (see below)
```

`progress.md`(versioned markdown, version in frontmatter; the model is the
primary writer — the plugin only writes the initial scaffolding and reads):

```markdown
---
schema: longrun/v1
goal: <one-sentence goal>
round: 0
updatedAt: <ISO8601>
---

## Goal

## Plan

## Done # - [x] items + evidence pointers (commit hash / file path / session seq links)

## Next # 1-3 immediate next steps

## Blockers

## Evidence # run links: test commands, key output excerpts, relevant seq ranges
```

**Parsing tolerance**: missing sections → treated as empty; unknown sections
preserved verbatim (not touched on rewrite); missing `schema` or unknown
version in frontmatter → parse as v1 and telemetry warn ("partial-write
tolerance", covering the case where the initializer is killed mid-write).
The plugin **never rewrites** model-maintained content.

`state.json`(plugin-private, small JSON):

```json
{
  "active": { "sessionId": "...", "goal": "...", "initedAt": "..." },
  "handoffs": [
    {
      "childSessionId": "...",
      "parentSessionId": "...",
      "boundary": 123,
      "reason": "manual|auto-suggest",
      "at": "..."
    }
  ]
}
```

Configuration (schemastery, three adjustable tiers, doc 00 tenet 3):

```ts
mode?: 'off' | 'audit' | 'enforce'   // default 'audit'; off = keep commands only, disable all interception
workspaceDirtyPolicy?: 'off'|'warn'|'enforce' // default 'warn'
maxSteerbacksPerTurn?: number        // default 2; counted keyed by turn
autoSuggestFillPercent?: number      // default 75; 0 = off
```

Telemetry op vocabulary (values of the `telemetry.op` attribute; details go
in body):
`longrun/init`, `longrun/round-check {turn, verdict, categories[], steeredBack}`,
`longrun/cap-exhausted {turn}`, `longrun/reset {boundary, childSessionId}`,
`longrun/handoff-inject {childSessionId}`, `longrun/auto-suggest {fillPercent}`.

### Key behavior flows

**init flow**(`/longrun init <goal-text> [--commit]`, inside the command
handler):

1. Take `invocation.agent.session.header.cwd`; if missing → return
   `{kind:'error'}` with an explanation (a session must have a cwd to have
   a project root).
2. Via `ctx.fs`, write `init.sh` (environment self-check template; if one
   already exists, skip and rename), write the `progress.md` scaffolding
   (goal into frontmatter), write `state.json.active`.
3. With `--commit` and `ctx.shell` present: `git add .dsh/longrun && git
commit`, folding the result into the return text; shell absent → degrade
   to a warn message.
4. Echo the current markdown locations and a "protocol is now in effect"
   text. Idempotent: a repeat init errors out unless `--force`.

**round check / steer-back flow**(`agent/turn-stopping` listener; the
listener is wrapped in try/catch throughout and never throws):

1. mode==='off' → return immediately. Take the payload `{agent, turn,
signal}`; if `ctx.get('fs')` is absent → record one telemetry event and
   let the turn pass.
2. Read this session's progress baseline: when `turn/start` arrives (via
   the `session/event` firehose, declared at
   `core/session/src/index.ts:74-76`), cache the content hash of
   progress.md keyed by `(sessionId, turn)`; at turn-stopping time, read
   again and compare.
3. Three checks, **classified individually** (the telemetry interception
   categories are named after these):
   - `missing-progress`: the progress.md hash is identical to the baseline
     (no update this round).
   - `dirty-state`: policy is not off and shell is present, and
     `git status --porcelain` is non-empty (edge cases such as filenames
     with spaces degrade to warn).
   - `premature-completion`:**only when 04 is present at runtime**(read the
     latest gate result from `.dsh/goal-verify-gate/goals/*.json`; the file
     contract belongs to doc 04, see risk R2) and this turn observed an
     `update_goal complete` tool call that was rejected / did not pass the
     gate; when 04 is absent this category is not emitted (no verdict
     surface exists; no text heuristics).
4. audit mode: any catch only records telemetry and does not touch the
   turn. **enforce mode** with cap not exhausted:
   `agent.steer(createUserMessage({ content: concrete remediation text,
source: { kind:'plugin', plugin:'long-run-protocol', form:'notice',
summary: '<≤120-char summary>' } }))` — the remediation text is specific
   about which check failed and what to do (which section of progress.md to
   update / commit or write into Blockers / which gate the goal still
   misses), embodying steer-back-not-veto (not refusing turn wrap-up, but
   handing back a continuation carrying a fix direction).
5. Cap exhausted (the max+1-th failure within the same turn): **steer no
   more**, record `longrun/cap-exhausted`(severity warn), and let the turn
   wrap up normally — the infinite-loop guardrail.

**reset = fork + handoff flow**:

- Manual: `/longrun reset [--at <seq>] [reason]`. Boundary selection:
  default = the seq **just before the source session's first `turn/start`**
  (`findFirst(turn/start)-1`, i.e. "keep all setup events, clear all
  narrative", corresponding to Harness Design's window replacement); `--at`
  gives it explicitly; `sessions.fork`'s own errors for OPEN_TURN /
  out-of-range seq are mapped to readable command errors. **Session
  switching is host-owned**(upstream precedent: command-resume only lists
  sessions and points to `dsh --resume <id>`; sessions cannot be switched
  programmatically) — so a successful command returns text = the new
  childSessionId + switch instructions; it also appends to
  `state.json.handoffs` and emits `longrun/reset` telemetry.
- Continuation: when the child session is resumed by the host,
  `agent/session-start`(seam 7)fires; on finding the lineage, build a
  structured continuation from the **current** progress.md (tolerating
  partial writes): goal / plan summary / done items / next / blockers /
  evidence pointers + a restatement of protocol obligations, delivered via
  `agent.inject(createUserMessage({..., source:{kind:'plugin', plugin:
'long-run-protocol', form:'recall', summary:'handoff'}}))`; record
  `longrun/handoff-inject`. Degraded path for a lost state.json:
  `/longrun handoff` regenerates it manually.
- auto-suggest: done incidentally inside the turn-stopping main flow —
  when seam 10 computes fill% ≥ `autoSuggestFillPercent`, record
  `longrun/auto-suggest`; audit mode only telemeters, enforce mode
  steer-backs **at most once**(per threshold tier)asking the model to first
  write progress.md in full + commit, then letting a human run
  `/longrun reset`. **Deliberately no approval ask inside the serial
  hook**(that would block turn-close on human interaction, risk R3), and
  consistent with "host owns switching": the plugin only ever suggests, and
  never switches sessions on its own.
- **Lost vs kept**: lost = the entire intermediate narrative (that is
  precisely the intent: window replacement > noisy summary); kept = the
  done/blockers/evidence pointers in progress.md (commit hashes, file
  paths, seq links) + the parent's complete append-only log forever
  queryable (traceable via the lineage header).

### Boundary of reset vs compaction

|             | compaction (upstream, already exists)                                                                                                                                                                                                     | reset (this design)                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Mechanism   | In-place surface replacement within the same session; `compaction/*` are log-only shadow events only (`packages/compaction/compaction/src/types.ts:16-89`; the trigger `compaction-basic` hooks `agent/pre-step`, `src/index.ts:137-167`) | `sessions.fork` creates a new session seeded with the durable prefix up to an early boundary + handoff injected at resume |
| durable log | Never touched                                                                                                                                                                                                                             | Parent log never touched; child = new log with lineage header                                                             |
| Applies to  | Mid-session step pressure, where the narrative still has reference value                                                                                                                                                                  | Context anxiety, frequent overflow recovery, phase transitions                                                            |
| Trigger     | Automatic (within the thresholdRatio policy)                                                                                                                                                                                              | Manual command + auto-suggest (suggests forever, never forces)                                                            |

One verdict line: if old facts in the context **still need to be referenced
back** → compact; if the old narrative has become a noise source → reset.
The two coexist: after a reset, the new child session is still protected by
compaction (its seed prefix projects as usual), with no conflict.

### Boundary with 06 issue-pilot

05 defines only the long-run protocol **inside a single session**: artifact
contracts, round-end checks, the fork-reset closed loop, telemetry.
**05 does not do**: cross-issue scheduling, one-branch/worktree-per-issue
isolation, an orchestration main loop (those belong to 06; 06 uses the fork
provider and worktree isolation). 06's instantiation = **one 05 session per
issue**(an independent `.dsh/longrun/` under an independent cwd), consuming
three external contracts: the commands, the progress.md file schema, and
the telemetry op vocabulary. 05 has no notion of "issue".

## Milestone split

**M1: `/longrun init` + progress schema + prompt section + unit tests.**
Register the command and the global prompt provider; the
init.sh/progress.md/state.json scaffolding; the schema parser (tolerating
partial writes). Verify: (a) the init command produces the three files on a
fake-ctx (fake cwd/sessions/systemPrompt), and a second repeat init errors;
(b) the prompt section emits text only for a session matched by
`.dsh/longrun/state.json`(`context.agent?.session.id` mapping assertion),
with zero change in assembly for all other sessions; (c) the parser does
not blow up on fixtures with missing sections / unknown versions /
truncated writes. PR-sized.

**M2: turn-stopping round checks + steer-back + attribution + telemetry +
synthetic-session tests.** Three classified checks, audit/enforce modes,
cap, attribution. Verify: (a) drive a synthetic multi-round session: when
progress is unchanged → exactly one steer, with the `user/message` event
source asserted as `{kind:'plugin', plugin:'long-run-protocol'}`; (b) two
consecutive failed rounds → the second records cap-exhausted and the turn
closes normally; (c) fault-injection cases inside the listener (throw at
every checkpoint) assert the turn still ends completed (never throws);
(d) a telemetry spy asserts the op vocabulary is emitted.

**M3: reset via fork + handoff reconstruction + auto-suggest + metrics +
docs.** `/longrun reset [--at]`, `agent/session-start` resume injection,
the auto-suggest tiers, README. Verify: (a) synthetic-session fork
assertions: child.header.parentSession/seedLength correct, seed length =
boundary+1, construction-time firehose silence; (b) after resume fires, the
first pre-step context batch contains a form:'recall' handoff; (c) invalid
boundaries (an open-turn point / out of range) produce command error text;
(d) in enforce mode, a qualifying auto-suggest steers exactly once;
(e) kill-resume drill: progress.md truncated by a kill mid-init → a reset
continuation can still build a handoff (parser tolerance). rEPLAce via
fork = M3's acceptance criterion.

## Verification plan

1. **Unit**: progress.md parser fixtures matrix (including partial-write
   truncation); every branch of the command handlers (no cwd / no shell /
   no tokenMeter / 04 present and absent); config schema defaults.
2. **Synthetic-session integration**(following the repo's test-support /
   agent-loop-mock style): real `sessions.create` + multi-turn driving,
   asserting steer event shape, cap, attribution, classified telemetry;
   fork asserting seed/lineage; replayed resume events asserting handoff
   inject.
3. **Telemetry assertions**: a record spy checks the attributes/body shape
   of every op (ops vocabulary discipline).
4. **Real-profile e2e**: a deliberately multi-round demo task, running
   through init → several rounds (including one steer-back interception) →
   auto-suggest triggering → manual reset → `dsh --resume <child>` showing
   the handoff; manually verify the departing desk (clean workspace +
   accurate progress).
5. **Recovery drill**: `kill -9` the process at arbitrary moments and
   resume; progress.md/state.json uncorrupted (each via its own fault-
   tolerance path), and `firstLiveSeq` semantics unaffected by fork.
6. **Graduation observation**(aligned with doc 00 graduation criteria): a
   metrics dashboard showing rounds, resets, per-category interception
   counts and the false-interception appeal rate; nominate for graduation
   after two consecutive green weeks.

## Risks and open questions

- **R1 surface append on a non-driven child session is unverified**: an
  alternative design wanted to append the handoff directly as a
  `user/message` into the forked-but-not-yet-driven child session so the
  seed would carry it — the surface-append semantics of a driverless
  session are unverified. **How to check**: read whether `Session.append`'s
  surfaceOp path is allowed for a driverless session (acceptance rules in
  `packages/core/session/src/surface.ts`) and write a minimal case; the
  current design uses seam 7's `agent/session-start` + `agent.inject` to
  sidestep this dependency.
- **R2 04's gate-state file contract**: we read 04's
  `.dsh/goal-verify-gate/goals/*.json` directly (optional at runtime, zero
  compile-time dependency). **How to check**: before 05 M2, read the
  serialize implementation merged in 04 M1 and confirm the fields; 04
  absent / file missing / parse failure → skip that category only, never
  crash the flow. If 04's schema evolves, this plugin negotiates by the
  version field; the interim fallback is tolerating any parse failure.
- **R3 auto-suggest depends on two optional services**: the
  `ctx.get('tokenMeter')` service key (spike: verify the declare-module key
  name in `llm/token-meter/src/index.ts`), and the availability of
  `ctx.llm.resolveModelInfo` plus the `contextWindow` field (following the
  compaction-basic `:294-303` precedent). If either is missing → record one
  skip telemetry and never mention it again for that session. **How to
  check**: print the existence of both once in the target profile.
- **R4 the workspace-dirty check depends on `ctx.shell` and git being
  available**: in a sandbox or a non-git project, `git status --porcelain`
  is infeasible → degrade to warn; **how to check**: the cwd field and
  failure paths of `ShellExecSpec`(read `ShellExecRequest` in
  `packages/shell/shell/src/index.ts`).
- **R5 reset switch guidance is text**: host owns switching (the
  command-resume precedent); the best the plugin can offer = clear command
  echo + state.json; if the user forgets to switch and keeps going in the
  parent session, the parent's round checks keep running normally (the
  protocol applies to parent and child alike; no data risk).
- **R6 one-way anchoring of state.json to the session/store**: cwd is the
  project key, and sessionId is stored in the file; **how to check**: with
  multiple profiles under the same cwd, confirm no cross-talk (the read
  path only concludes "this session is long-running" when the stored
  sessionId equals header.id).
- **R7 enforce-mode auto-suggest steers only once**: if the model remediates
  and then crosses the threshold again, no further steer (loop prevention),
  telemetry only. This trade-off is deliberate; if the measured miss rate
  is high, add % tiers above the threshold (e.g. one steer each at
  75/85/95) and do another review round.
