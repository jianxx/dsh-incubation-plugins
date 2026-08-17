# 10 verified-tools — Idempotency, Verify-Before-Retry, and Argument Admission

> Status: design (not started) | Tier: 3 | Package: packages/verification/verified-tools | Depends on: 01

An execution-semantics plugin for "unreliable tools": it wraps the real dispatch
around `tools/execute`, providing idempotent dedup, verify-before-retry for
ambiguous outcomes, and pre-validation admission of tool arguments.

## Motivation (including the ablation implication of verification-only > full wrapper: v1 builds verify-before-retry, not retry orchestration)

Literature anchors and their implications:

- **Verified Tool Calls (2608.02645)**: formalizes four failure classes —
  timeout-after-dispatch, delayed visibility, partial success, stale conflict —
  and separates the "observed response" from "world state": the response is only
  a possibly-stale proxy, so the intended postcondition must be verified
  **before** retrying a side-effecting call. The paper reports a 20–72% baseline
  rate of duplicate side effects, dropping to 0/16/20% with deterministic
  idempotency keys + verification, while task success stays at 100%. **Key
  ablation: verification-only often beats the full wrapper — the gain comes
  from "checking whether the action already happened", not from retry
  orchestration itself.** Therefore v1 of this plugin builds only
  verify-before-retry (retry cap fixed at 1), with no backoff chains,
  re-planning, or multi-retry orchestration.
- **To Call or Not to Call**: call/no-call is itself an admission decision
  (necessity / utility / affordability). It maps onto this plugin's
  **wrap/no-wrap gate**: pay the verification cost only for calls the manifest
  classifies as side-effecting; readonly / write-local calls pass through at
  zero cost, incurring no storage or probe overhead (see step 1 of the
  "wrapping main flow").
- **Structured Output Control**: schema/format failures are common at the tool
  boundary, and decoder-side enforcement is insufficient; runtime-side argument
  validation + corrective feedback (a recovery channel) belongs to the harness.
  Upstream core explicitly states "tools validate their own schema" (see gap 3),
  which leaves exactly this room for the plugin.

## Current State and Gaps

Verified (dsh repo, `/Users/bytedance/workspace/github.com/deepseek-harness`,
referred to below as dsh):

1. **Timeouts are already returned as structured error results**: timeouts are
   handled by the plugin `packages/guard/timeout-policy`, which produces an
   ordinary `ToolExecutionFailure` (`isError:true`,
   `error.info = { name:'ToolTimeoutError', code:'TOOL_TIMEOUT' }`,
   `packages/guard/timeout-policy/src/index.ts:25,41-48`), so the wrapper can
   route on `error?.info.code === 'TOOL_TIMEOUT'`. Core only validates the
   `timeoutMs` option (`packages/core/tools/src/schema.ts:499-500`).
2. **Duplicate calls already get an advisory reminder**:
   `packages/guard/repeat-tool-reminder` detects consecutive identical calls
   (default thresholds [3,5,8]) and injects a reminder UserMessage, **but has no
   veto and no dedup** (`src/index.ts:1-2`).
3. **No unified harness-layer argument validation**: the comment on
   `ToolExecutionInput.arguments` states "Losslessly JSON-serializable parsed
   arguments (tools validate their own schema)"
   (`packages/core/tools/src/index.ts:322`). Core ships a ready-made validator
   `validateJsonSchemaValue(schema, value, path): string[]`
   (`packages/core/tools/src/json-schema.ts:654`, re-exported via `index.ts:93`,
   package name `@deepseek-ai/dsh-tools`), currently used only for output
   (`index.ts:1795`).

Gaps: (a) no end-to-end idempotent dedup (store + short-circuit); (b) no
verify-before-retry for timeout-ambiguous scenarios (the classic case: blindly
re-sending `gh pr create` after a timeout creates a duplicate PR); (c) no
unified pre-execute argument validation with corrective feedback; (d) no
consistent telemetry for any of the above events.

## Design

### Surfaces and Seams (verified + cited)

1. **around-seam wrapping**: `'tools/execute'(this: Scoped<ToolRuntime>, exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>`
   (`packages/core/tools/src/index.ts:163`). It can fully envelop dispatch:
   inspect `exec` → **short-circuit with a synthesized `ToolExecutionResult`
   (legal, no need to call `next()`)** → or call `next()` and then
   observe/replace the result. Constraint: the wrapper may only replace
   `exec.signal`; the call identity is immutable (`index.ts:155-158,386-394`).
   Registration shape: inside `apply(ctx: Context)`,
   `ctx.on('tools/execute', async (exec, next) => ...)` (cf.
   `packages/guard/timeout-policy/src/index.ts:50-58`).
2. **pre-execute veto**: `'tools/pre-execute'(exec, next)` (`index.ts:152`),
   deciding `{kind:'allow'} | {kind:'deny'; reason} | {kind:'ask'; reason}`
   (`index.ts:588-603`); a `deny` materializes as an isError result of
   `Error: <reason>` handed to the model (`index.ts:1493-1500`) — i.e. the
   recovery channel for corrective feedback. **pre-execute cannot rewrite
   arguments** (`index.ts:585-587`), so recovery can only work by using the
   deny-reason to prompt the model to fix and re-send (consistent with the
   runtime-side corrective-retry semantics of Structured Output Control). The
   tool definition is fetched with `ctx.tools.get(exec.name, exec.agent)` (cf.
   `timeout-policy/src/index.ts:57`); the schema field is declared as
   `parameters` (`index.ts:1257-1265`).
3. **Nested dispatch (running tool-type probes)**: `ToolRuntime.execute` is a
   public method (`index.ts:1342`), so the wrapper can call
   `this.execute(...)`; nested dispatch is a designed-in concept, threaded via
   the `parent` token (`index.ts:316-320,327-334`); grep shows no reentrancy
   guard. You must supply your own `callId` and `signal`, and pass
   `parent: exec.token`. **Note**: under Code Mode, only calls carrying a
   parent may execute native tool names (`index.ts:329-334`). Precedent:
   `repeat-tool-reminder/src/index.ts:190` calls `ctx.tools.execute()`
   directly.
4. **ASK escalation**: `ctx.approval.request({agent, toolName, callId?, reason?, signal?})`
   → `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
   (`packages/interaction/user-approval/src/index.ts:153-170,257`;
   `types.ts:28`). `'unavailable'` fails closed; `request()` must run inside an
   open turn (`index.ts:264-272`), which the wrapper naturally satisfies. It
   does not bypass the `approval/request` waterfall (shared principle 1).
5. **Telemetry**: `'session-telemetry/record'` is a synchronous redaction
   transform, not an "emit event" API
   (`packages/session/session-telemetry/src/index.ts:47`; record shape
   `{channel:'ledger'|'ops', time, severity, attributes, body}` at `:64-92`).
   Emitting telemetry = appending a session event (ledger) or going through
   `SessionTelemetrySink.emit` (`:97`). The dedup-hit / verify-catch /
   probe-run / arg-denial events produced by this plugin enter the unified
   event stream as ledger events (shared principle 5).
6. **shell-type probes**: via the `@deepseek-ai/dsh-shell` abstract execution
   service `run(spec: ShellExecSpec): Promise<ShellRunResult>`
   (`packages/shell/shell/src/index.ts:93`), under sandbox semantics — never
   `child_process` directly.
7. **State on disk**: `.dsh` resolves to the harness HOME
   (`DSH_HOME_DIR_NAME='.dsh'`, env `DSH_HOME`, default `~/.dsh`;
   `packages/util/home-paths/src/index.ts:12-18`, resolvers `resolveDshHome()`
   / `dshHomePath(...segments)` at `:87-98`); atomic writes via
   `writeFileAtomic` (`packages/fs/fs-local/src/index.ts:36,200,244`). All
   manifest metadata (effectClass / idempotency.keyRecipe / retryProbe /
   failureSemantics) comes from doc 01's annotation mechanism (shared
   principle 4).

### Data Model / Configuration (idem store schema, windows, modes)

Idempotency record (the ledger of one "intended execution" within the dedup
window):

```ts
// Path: dshHomePath('verified-tools','idem', <windowDir>, `${key}.json`)
interface IdemRecord {
  key: string                       // sha256 hex, see keyRecipe
  tool: string
  agentId?: string
  argsDigest: string                // canonical argument digest (subset selected by the recipe)
  state: 'in-flight' | 'completed'
  resultDigest?: string             // single-line result digest (success value or error code), no raw payload
  recordedAt: number                // epoch ms
  bucketStart: number               // floor(now / bucketMs) * bucketMs
}
```

Key recipe (the manifest provides `idempotency.keyRecipe`, selecting which
argument fields participate in the hash):

```ts
key = sha256(agentId, toolName, canonical(argsSubset(recipe)),
             floor(now / config.bucketMs))
```

Configuration (profile-level; the three SafetySentry tiers run throughout,
shared principle 3):

```ts
verifiedTools: {
  mode: 'off' | 'audit' | 'enforce'   // master switch + ambiguity-escalation tier; default audit
  argValidation: 'off' | 'audit' | 'enforce'  // can be tiered independently
  windowMs: number                    // dedup window, default 600_000
  bucketMs: number                    // time bucket, default 60_000
  retentionWindows: number            // GC on write, default 24
  maxRetries: 1                       // paper-ablation implication: fixed at 1, cannot be raised
  probe: { timeoutMs: number; fallback: 'ask' | 'fail' }
  askThreshold: number                // SafetySentry continuum (see risk 6)
}
```

The window directory `<windowDir>` is the bucket-start stamp; on every record
write, GC also deletes expired window directories, avoiding unbounded growth.
All writes go through `writeFileAtomic`.

### Key Behavior Flows (wrapping main flow; ambiguity → probe → verdict flow; argument validation flow)

**Flow 1 — wrapping main flow** (`tools/execute` wrapper):

1. Check `effectClass` in the manifest: anything other than
   `side-effecting | external-disclosure | irreversible` → **`return next()`
   directly**, with zero storage and zero probing end to end (gate economics).
2. Compute the key from the `keyRecipe`, read the `IdemRecord`:
   - `completed` and within the window → short-circuit: return a dedup result
     with `isError:false`, content "this call is a duplicate of an equivalent
     call in bucket <bucket>; deduped per the recorded result: <resultDigest>",
     `meta: { deduped: true, originalBucket }`; ledger records
     `verified-tools.dedup-hit`.
   - `in-flight` → short-circuit suppression: an isError result "an equivalent
     side-effecting call is already in flight; not dispatched", preventing
     concurrent duplicate dispatch; record `dedup-hit(inflight)`.
   - No record → write `in-flight`, call `next()`, then transition on the
     outcome:
     - success → write `completed` + resultDigest, return the result as-is;
     - failure with `error.info.code === 'TOOL_TIMEOUT'` and the manifest's
       `failureSemantics` marking `timeout-ambiguous` → enter flow 2;
     - other failures → write `completed` (failure digest). **Re-sending a
       failed call with the same args in the same bucket is also deduped**:
       the short-circuit returns the recorded failure digest, forcing the
       model to change the arguments (changing args changes the key) instead
       of blindly retrying.
3. The wrapper's own internal retry (flow 2, step 4) carries an internal
   bypass marker that skips step 2's dedup check — otherwise it would be
   blocked by its own `in-flight` record.

**Flow 2 — ambiguity → probe → verdict** (verify-before-retry):

1. Read the manifest's `retryProbe`: `{ kind:'shell', command, expect }` or
   `{ kind:'tool', name, args, expect }` (`expect` = postcondition assertion;
   when multiple assertions are present, any one failing counts as partial).
2. A shell probe runs via `dsh-shell` `run()`; a tool probe runs via nested
   dispatch with `this.execute(...)` (`parent: exec.token`, a fresh `callId`,
   its own `signal`, and `probe.timeoutMs`). The probe itself must be marked
   `readonly` in the manifest and carry a bypass marker, so this wrapper does
   not recursively wrap it.
3. Three-way verdict:
   - **postcondition met** (the action actually succeeded; the response was a
     stale proxy) → synthesize a verify-success result: `isError:false`,
     content "the call timed out but was verified complete: <probe evidence
     digest>; not retried", `meta: { verifyRecovered: true }`; ledger records
     `verify-catch` (the prevented duplicate side effect); write `completed`.
   - **postcondition unmet** → allow **exactly one** retry (re-call `next()`
     with the bypass marker); the second result is returned directly and
     recorded as `completed`.
   - **unknown** (the probe cannot decide / the probe itself failed) → resolve
     by mode: `off` returns the timeout error as-is; `audit` logs a warn and
     returns as-is; `enforce` →
     `ctx.approval.request({agent, reason, ...})`, where `'allowed-once'` =
     permit one retry, `'rejected'/'cancelled'` = return the original timeout
     error, `'unavailable'` = fail-closed (upstream semantics,
     `user-approval/types.ts:28`).
4. The whole probe lifecycle emits `probe-run` telemetry (count, verdict
   distribution, latency).

**Flow 3 — argument validation** (`tools/pre-execute`):

1. Fetch `ctx.tools.get(exec.name, exec.agent)?.parameters`, then
   `violations = validateJsonSchemaValue(schema, exec.arguments, 'arguments')`.
2. No violations → `{kind:'allow'}`.
3. Violations exist: `audit` → allow + ledger warn (observe without
   indulging? — the audit tier defaults to allow-and-record in order to
   collect the false-positive rate); `enforce` → `{kind:'deny', reason}`
   where the reason lists each violation path plus an expected-type digest
   (e.g. `arguments.prTitle: expected string, got number`). Upstream
   materializes the deny as an `Error: <reason>` result handed back to the
   model, which fixes the arguments per the corrective feedback and re-sends
   (the recovery channel). Record `arg-denial` telemetry.

### Four Failure Classes → Signal/Action Mapping Table

| Failure class (paper term) | Detection signal | Plugin action |
|---|---|---|
| timeout-after-dispatch | Result has `error.info.code === 'TOOL_TIMEOUT'` and `failureSemantics=timeout-ambiguous` | Flow 2: probe → verify-success / one retry / tier-based ASK |
| delayed visibility | Flow 2 probe returns `unknown` (the effect may become visible later) | No blind retry: `off/audit` return the failure as-is + annotate; `enforce` ASKs; the retry decision goes to a human or defaults to no |
| partial success | Probe's multiple assertions partially satisfied | Do not retry (avoid stacking partial side effects); the synthesized result notes the partial evidence + records a `partial` event; the `enforce` tier escalates to ASK |
| stale conflict | A `completed` idempotency record is hit before dispatch (the world already contains a proxy of the intended effect) | Short-circuit with the dedup result (flow 1, step 2) |

### End-to-End Example (`gh pr create` timeout)

Suppose the manifest annotates the shell tool's `gh pr create ...` command
pattern with: `effectClass: 'side-effecting'`,
`failureSemantics: 'timeout-ambiguous'`, `keyRecipe: ['command']`,
`retryProbe: { kind:'shell', command: 'gh pr list --head <branch> --json url,number', expect: 'nonempty' }`.

1. The model issues `bash { command: 'gh pr create --title ... --head feat-x' }`.
   The wrapper matches the manifest → enters the wrapping path; writes an
   `in-flight` record (key includes the command digest + the current time
   bucket).
2. `next()` dispatches; the timeout-policy timer fires first → a failure
   result with `error.info.code === 'TOOL_TIMEOUT'` comes back (upstream
   semantics — what you see is what you get).
3. The wrapper sees timeout-ambiguous → runs the probe, executing
   `gh pr list --head feat-x --json url` via `dsh-shell`; the
   `postcondition nonempty` is satisfied and the PR URL is obtained.
4. Synthesize verify-success: `isError:false`, content "`gh pr create` timed
   out after dispatch, but the PR was verified to exist:
   https://github.com/org/repo/pull/42; not re-sent",
   `meta:{verifyRecovered:true}`; ledger records
   `verify-catch(tool=bash, pattern="gh pr create")`; write `completed`.
5. The model receives success semantics and keeps moving the task forward.
   **Duplicate side effects = 0, and no retry of any kind was performed** —
   the minimal form of the paper's ablation conclusion: the entire gain comes
   from "verify whether it already happened first".
6. Counterfactuals: if the probe returns empty (unmet), retry exactly once
   with bypass; if the probe also fails (unknown) and mode=enforce, go through
   `approval/request` to bring a human in, rather than blindly re-sending.

## Milestone Breakdown (each M = one PR's worth + a "Verify:" criterion)

**M1 — Argument pre-validation + idem store + dedup (verify-catch preconditions optional)**
PR scope: `pnpm new:plugin verification verified-tools` scaffolding; flow 3 in
full (reusing `validateJsonSchemaValue`); the idem store (`dshHomePath` +
`writeFileAtomic` + GC-on-write); the dedup short-circuit of flow 1 steps 1–2
(excluding flow 2); mode/window/bucket configuration; the two ledger event
types `dedup-hit` and `arg-denial`; unit tests.
Verify: a unit test mocks a `side-effecting` tool — (a) a second call with the
same args in the same bucket returns `meta.deduped` and the underlying dispatch
count === 1; (b) malformed arguments are denied at the enforce tier with the
reason containing the violation paths, and allowed at the audit tier with a
warn going to the ledger; (c) mode=off is full pass-through. Gates
(typecheck/lint/test) all green.

**M2 — Probe framework + verify-before-retry + synthetic chaos testing**
PR scope: flow 2 in full (shell probes via `dsh-shell`, tool probes via nested
`this.execute` with `parent: exec.token`; bypass markers preventing recursive
wrapping / preventing self-blocked dedup); the three-way verdict; `verify-catch`,
`probe-run`, and `partial` telemetry; a chaos testbed (tool stubs + a "shadow
world state" recorder, able to inject the four failure classes:
timeout-after-dispatch, delayed visibility, partial success, stale conflict).
Verify: a chaos-suite matrix (4 failure classes × verdict met/unmet/unknown)
asserts — duplicate side effects always 0, and final task success rate does not
degrade due to the wrapper; in the probe-met scenario, the caller observes
verify-success rather than a second dispatch (dispatch count === 1).

**M3 — ASK escalation + telemetry export + docs**
PR scope: `enforce`-tier unknown → `ctx.approval.request` integration
(`allowed-once` permits one retry, everything else fails closed); the
`askThreshold` SafetySentry continuum configuration; telemetry event schema
aligned with the doc 12 eval export; README (graduation criteria) and example
configurations.
Verify: an integration test mocks approval — the three branches
`allowed-once/rejected/unavailable` are each asserted; telemetry snapshots
assert the event sequence; a real-profile smoke test: inside a sandbox repo,
inject a network outage on `gh pr create` to produce a timeout, verifying the
verify-catch path actually triggers and no duplicate PR is created.

## Verification Plan

- Unit: key determinism (permuting the recipe subset does not change the key;
  crossing a bucket must change the key); store GC; dedup window boundary
  (whether two calls straddling a bucket edge are deduped or not); deny-reason
  structure.
- Chaos testing (the M2 testbed): the shadow world state is the sole source of
  truth for side effects; assert "the truth contains the side effect exactly
  once" rather than "the caller saw success" — matching the paper's
  effect/response separation.
- Real smoke test (M3): a sandbox GitHub repo + artificial disconnect/slow
  network injecting timeout-after-dispatch.
- Telemetry criteria (input to graduation criterion c): prevented-duplicate
  count, verify-catch count, arg-denial false-block rate (observed first under
  audit), unknown escalation rate.
- Regression: `repeat-tool-reminder` coexists with this plugin without
  conflict (the former is advisory, this plugin short-circuits; ordering tests
  cover it).

## Risks and Open Questions

1. **Scope of the idem store**: `.dsh` = harness HOME (`~/.dsh`), not
   project-local (`home-paths/src/index.ts:12-18`). For cross-repo
   `side-effecting` commands (e.g. two repos each running `gh pr create`) to
   dedup correctly, the recipe must fold repo/cwd-type context into the key.
   Check item: whether a project-level state-directory convention exists (grep
   for state-dir helpers outside `dshHomePath`); if not, decide before M1 on
   "global HOME + recipe forced to include the cwd field".
2. **Manifest classification granularity depends on doc 01**: the `gh pr
   create` scenario requires sub-classification inside the shell tool by
   command pattern (effectClass / retryProbe both hang on the arg-pattern).
   Check item: whether `01-tool-manifest.md` defines arg-pattern-level
   annotations; if only tool granularity exists, this plugin degenerates for
   bash-type tools into "annotate the whole shell tool as side-effecting",
   with significantly amplified cost (gate economics break down). This is the
   largest upstream dependency for v1.
3. **Nested-probe pipeline side effects are not fully understood**: a tool
   probe via `this.execute(...)` re-runs the full `pre-execute → execute`
   waterfalls (the phase ordering in `invariant.ts:100-110`); whether it
   triggers permission approvals / gets recursively wrapped by this wrapper,
   and how the Code Mode parent restriction (`index.ts:329-334`) concretely
   behaves on the probe path — validate with a spike before M2 starts: "nested-
   dispatch a readonly tool inside a wrapper and observe approval and
   interception behavior".
4. **The deny reason is plain text** (`Error: <reason>`,
   `index.ts:1493-1500`), with no structured fields; a long violation list
   could blow up the display. Check item: whether that `Error:`-prefixed text
   has length truncation; if necessary, put only the first N entries in the
   reason + "M total".
5. **Dedup suppression of failure records may block legitimate retries**: once
   a same-args failure is recorded as `completed`, a genuine retry after the
   underlying condition is fixed within the window (e.g. the network recovers)
   would be short-circuited. Mitigation: give failure records a TTL using a
   shorter sub-window (`windowMs / 4`), or at the audit tier treat failure
   records as observe-only without short-circuiting — to be settled by M1
   experiments.
6. **Approval availability**: `request()` requires an open turn
   (`user-approval/src/index.ts:264-272`); environments with no UI answerer
   (subagent/background) return `'unavailable'` → fail-closed. This is
   expected behavior, but the combined policy of `askThreshold` and background
   profiles needs to be documented, to avoid a degraded experience where every
   unknown fails in background mode.
7. **resultDigest contains no raw payload**: if dedup results carry details of
   side-effect output, that is a leak surface (interaction with doc 09's
   token-wall). The design fixes the digest as "action + key identifier (e.g.
   PR URL)" only; check item: after 09 lands, confirm whether the digest must
   go through its redaction export.
