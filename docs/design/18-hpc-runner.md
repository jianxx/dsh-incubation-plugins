# 18 hpc-runner — HPC/cloud-batch backend and compute-level checkpoint-resume for scientific heavy computation

> Status: design (not started) | Tier: 2 (domain base) | Package: packages/compute/hpc-runner | Dependencies: the main-repo ctx.jobs producer seam (Form A; adjudicated by the M0 spike) | Consumers: the breeding domain pack (22 GBLUP first run), any hour-scale computation task

## Design goal and user problem

**Goal**: give the agent a managed path into HPC/cloud-batch execution for scientific heavy computation — GWAS genome-wide scans, GBLUP large-matrix inversions, quantum-sensing long-horizon sampling analyses, jobs at the minutes-to-tens-of-hours scale — spanning: job-description generation → cluster submission → status polling → log and artifact reclamation → **compute-level checkpoint-resume** (after a process kill, a reclaimed cluster node, or a session window swap, resume from a checkpoint pointer instead of starting over).
**User problem**: today, when a user asks the agent to run an 8-hour GBLUP, the agent can only babysit a local bash (burning the context window) or hand-crank a chain of raw ssh/sbatch commands: nobody tracks job state after submission, a failed node leaves no resume mechanism, and when the long session swaps windows, an in-flight job becomes an unclaimed orphan. The agent can *write* compute code; it cannot *raise* a compute task.

## Motivation (why this is necessary)

Three independent evidence axes converge on "a scientific agent must have a managed heavy-compute channel, and it does not exist today":

1. **Task-scale evidence**: single analysis/control tasks in research settings already run tens of hours (the quantum-sensing reports of 18.9h-scale long tasks in llm-wiki/wiki/syntheses/scientific-research-agents.md); among the 21 system requirements of the XFEL study (From Overload to Insights, same synthesis) are explicit **HPC access** and "no user data transferred to third parties" — heavy compute and data residency are hard constraints of scientific facilities, not optional optimizations.
2. **Main-repo posture**: the main dsh repo's `packages/jobs` (background-job registry + producer model) and `packages/e2b` (provider-composition remote execution-world POC) demonstrate that "a generic execution base + swappable providers/producers" is the sanctioned architecture direction; but the main repo's existing producers are only the local kinds `bash`/`subagent` (the initial entries of `JobKindMap` in `types.ts`), with no "cluster-submission" producer precedent.
3. **Natural alignment with session scale**: HPC jobs and the long-run objects of [05 long-run-protocol](./05-long-run-protocol.md) are two sides of the same coin — sessions swap windows, computation must not die; 05's handoff convention "pass only verified state pointers" supplies an already-sanctioned protocol carrier for "handing off an in-flight job".

The cost of skipping this work is already visible in the field: the breeding team's GBLUP first run both needs this channel (the integration gate after M3) and serves as its first real acceptance scenario.

## Current state and the gap

Verified one by one (path:line citations are itemized under "Surface and seams", all against the current working tree of the main repo /Users/bytedance/workspace/github.com/deepseek-harness):

- `ctx.jobs` is the **JobRegistry** abstraction on a cordis service key (`declare module` declaration merging); the in-process provider is jobs-local's `LocalJobRegistry` (purely in-memory bookkeeping). The production model is **producer-driven**: anyone can declaration-merge `JobKindMap` to add a new kind, then register a job via `ctx.jobs.start` with `JobStart{kind, label, owner?, run(): JobHooks}`; "the producer owns execution resources, the runtime owns identity and lifecycle state" — structurally isomorphic to the role of an HPC submitter. **This is the confirmed shape of the extension point**.
- The tool-jobs plugin already mounts a model-facing controller on that seam: `job_output` (bounded wait), `job_list`, `job_kill`, and delivers completion notices to the owning agent via inject/busy or wakeup/idle — jobs of a new kind **inherit for free** this tool surface and notification flow.
- The schedule package provides durable one-shot/fixed-rate reminders (agent-scoped, persisted over the session event log), with a fixed-rate floor of `MIN_EVERY_INTERVAL_SECONDS = 300` — usable as a low-frequency polling driver, NOT as a second-level heartbeat.
- **Three gaps**: ① no HPC/cloud-batch producer exists (sbatch rendering, submission, state-machine mapping, log reclamation); ② no **compute-level** checkpoint convention — the jobs lifecycle only tracks "job terminal status", not "the job's internal checkpoint_rev"; ③ no handoff of in-flight jobs across sessions/process restarts — jobs-local is a purely in-memory registry, so after a process restart the registry is empty while the cluster job is still running; a re-attach convention is required.

**Explicitly out of scope**: no data movement (data location and movement policy belong to the sandbox/approval layer; this document only states the boundary); no scheduler-policy optimization (queue selection comes from user/pack configuration, not auto-tuning); no replacement of the jobs-local registry (it is identity-and-lifecycle bookkeeping — see "Form adjudication").

## Design

### Surface and seams (verified + cited)

1. **Producer registration seam (the hinge of Form A)**: `JobKindMap` is an open map designed for declaration merging — "Plugins extend this map by declaration merging" (`packages/jobs/jobs/src/types.ts:23-26`, initial entries `bash`/`subagent`); `ctx.jobs.start(spec: JobStart): JobId` (`packages/jobs/jobs/src/index.ts:82`); `JobStart = { kind, label, outputLimitBytes?, owner?, run(): JobHooks }` (`jobs/src/types.ts:46-70`); `JobHooks = { cancel(reason?): void, done: Promise<JobOutcome>, readOutput?(): string }` (`:72-95`) — `done` **must resolve at the process level after resources are released**, which aligns with "the HPC job reached a terminal state and its logs were pulled". Omitting `owner` creates an unowned job, supporting a staging form before cross-session claiming. When owner is bound, "agent disposal cancels and awaits the job" — **this is the wrong default for HPC jobs**: the cancel hooks must distinguish "the session died, the job keeps running" from "the user truly wants scancel"; see cancel semantics in the key behavior flows.
2. **Lifecycle and terminal states**: `JobStatus = 'running'|'stopping'|'completed'|'killed'|'failed'` (`types.ts:17`), exactly one terminal value; producer-specific facts go into `JobSnapshot.detail` (queue name, slurm state, checkpoint_rev digest).
3. **Model-facing tool inheritance**: tool-jobs' `job_output/job_list/job_kill` (`packages/jobs/tool-jobs/src/index.ts:260/334-392`, internally via `ctx.jobs.wait/read/list/get/kill`, `packages/jobs/jobs/src/index.ts:90-133`); completion notices are driven by `ctx.jobs.onJobDone` (`:143`), and tool-jobs delivers them by injecting a busy owner or waking an idle owner per its `CompletionDelivery` config (default `wakeup`) — when an HPC job finishes hours later, the agent is woken to see the terminal state and artifact pointers. Controllers must `attachController` first (`jobs/src/index.ts:176`); tool-jobs already does, and this plugin does not attach a second one. The registry change broadcast seam `onJobsChanged` (`:167`) is reserved for future UI.
4. **Polling-drive seam**: schedule is an agent-scoped durable reminder mechanism — one-shot (`after_seconds`/`at`) and fixed-rate (`every_seconds`, floor `MIN_EVERY_INTERVAL_SECONDS = 300`, `packages/schedule/schedule/src/domain.ts:24`); records persist in the session event log, and an overdue rule delivers the latest occurrence. On submit, create one `every_seconds=300` polling reminder; each fire polls the remote state, updates `JobSnapshot.detail`, and pulls incremental logs when warranted; delete the reminder once the job settles. **The 300s floor is this design's maximum polling-granularity guarantee** — status queries go through size-bounded squeue/sacct stdout anyway and do not need second-level freshness; when denser sampling is needed, run_code can front one-shot inline polls (see behavior flows). A while+sleep spin inside the session is the anti-pattern: it burns context and has no durability.
5. **Event-stream discipline**: custom session event types are closed to out-of-repo plugins (`packages/core/session/src/known-event-types.ts:7-15`, cited and verified in 05) — this plugin **adds no session events**; job facts go through the jobs registry (naturally); audit and alerts go through telemetry ops (same discipline as 05).
6. **Remote-exec precedent**: e2b proved that "replacing the two OS adapters fs/subprocess swaps in an entire remote execution world" (`packages/e2b/README.md`, the provider-composition POC); HPC does NOT copy this approach — a cluster's entry surface is a **batch-command CLI** (sbatch/squeue/sacct/scancel), not a persistent execution world, so our remote surface is a thin `ClusterTransport` abstraction (ssh wrapper as the default implementation + a direct-local mock implementation), leaving ctx.fs/ctx.subprocess untouched. The main repo also has code-runtime (`ctx.codeRuntime`, the host of run_code) and the sandbox layer, where data-movement approval belongs; this document does not expand on them.
7. **run_code fronting polls**: `run_code` is exposed by Code Mode with `ctx.codeRuntime` as its host (`packages/code-runtime/code-runtime/README.md`); it lets the model write a one-shot "loop-check state until X" program inside a waiting window, and does not replace durable polling.

### Form adjudication: the M0 spike (both forms spelled out; freeze after adjudication)

- **Form A (preferred) — a jobs producer extension**: declaration-merge `JobKindMap['hpc']`; inside `run()`: render the sbatch script → submit via transport → capture the slurm job_id → start the schedule polling reminder; `JobHooks.cancel` routes by cause (see behavior flows); `JobHooks.done` resolves after the sacct terminal state + log reclamation; `readOutput` returns the most recently pulled log tail. Payoff: reuse tool-jobs' entire model surface and completion notices, reuse job_id/state-machine semantics, and 05's handoff only needs to carry one job_id in its transfer pointer.
- **Form B (fallback) — an independent service + own tool surface**: if the spike proves the seam does not fit (criteria below), land a `ctx.hpcRunner` service + the `hpc_submit/hpc_status/hpc_logs/hpc_cancel/hpc_resume` tool set, managing reminders and notifications itself. The fallback rationale must be written into the spike report.
- **M0 criteria (all testable against a fake cluster)**: (a) `JobKindMap` declaration merging typechecks in the incubation repo; (b) owner-disposal semantics — whether agent dispose forcibly cancels a running job (and if so, how unowned registration + manual owner checks bypass that without breaking the authorization model); (c) compatibility of the "done must not reject; a rejection converts to failed" contract with remote polling error paths; (d) whether cross-process re-attach via an unowned start conforms to the registry's authorization semantics. **Any single veto criterion holding → Form B; all pass → Form A**.

### Data model / configuration

Job directory convention (under the compute project root; user-visible and auditable):

```text
.hpc/jobs/<slurm_job_id>/
  submit.json      # frozen submission request: script path, render params, resource declaration, submit time
  script.sbatch    # the actual rendered artifact submitted (content-addressed; re-render is the same script)
  checkpoint.json  # compute-level checkpoint pointer (below) — the shared read/write surface of domain task and agent
  poll.jsonl       # polling journal: each entry {at, slurm_state, indexer_state, log_tail_hash}
  logs/            # pulled stdout/stderr segments (tail increments, named <seq>.log)
  artifacts/       # artifact manifest registered at terminal state (paths + sha256), consumed by 17
```

**checkpoint.json — the compute-level checkpoint convention (three fields, all self-written and self-checked by the domain program)**:

```json
{
  "checkpoint_rev": 7,
  "state_ptr": "checkpoints/gblup_rev7.npz",
  "resumed_from": 6,
  "written_at": "2026-08-20T10:20:00Z",
  "validator": "python tools/check_ckpt.py checkpoints/gblup_rev7.npz"
}
```

Contract: `state_ptr` must point to an **autonomously reloadable** state file; `resumed_from` forms a rev chain, and after a resume the new rev = resumed_from + 1; `validator` is an optional offline check command which, when declared, hpc_resume runs locally/mock first before submitting. Domain tasks that do not honor this convention may still use submit/poll, but the checkpoint/resume tools **refuse explicitly** (fail-closed: the agent must not be led to believe it can resume a job that never saved state).

Configuration (schemastery, same three-tier philosophy as [01 tool-manifest](./01-tool-manifest.md)):

```ts
transport?: { kind: 'ssh'; host: string; user?: string; keyPath?: string }
          | { kind: 'mock'; stateDir: string }        // state dir of the mock slurm stub
slurm?: {
  partition?: string; account?: string;               // cluster-side defaults
  pollEverySeconds?: number                            // default 300 (>= the schedule floor)
  maxLogTailBytes?: number                             // default 64KiB; overflow truncates, keeping the tail
  sbatchTemplatePath?: string                          // override slot for the built-in template below
}
checkpointPolicy?: 'strict' | 'off'                    // default strict: no convention → no resume
manifest?: { submitEffect: 'side-effecting' }          // hook for 01's built-in manifest entry
```

The sbatch render template (built-in default, overridable via `sbatchTemplatePath`; template variables correspond one-to-one with submit.json):

```bash
#!/bin/bash
#SBATCH --job-name={{job_name}}
#SBATCH --cpus-per-task={{cpus}}
#SBATCH --mem={{mem}}
#SBATCH --time={{time}}
#SBATCH --partition={{partition}}
{{#if gpus}}#SBATCH --gres=gpu:{{gpus}}{{/if}}
set -euo pipefail
# checkpoint resume: the job body itself reads checkpoint.json's state_ptr
{{command}}
```

Manifest tool annotations (shipped with the package, fed to 01): `hpc_submit` / `hpc_resume` = `side-effecting` (writes to the cluster queue; timeout-ambiguous — the submission may already have happened); `hpc_status` / `hpc_logs` / `hpc_checkpoint_read` = `readonly`; `hpc_cancel` = `side-effecting` (issues scancel to the cluster); idempotency keys: submit/resume carry the content hash of `submit.json`; re-submitting the same rendered artifact is made idempotent cluster-side-defensively — sbatch would happily enqueue twice, **so the submit path dedupes by listing before submitting** (see behavior flows).

### Key behavior flows

**Submit flow** (`hpc_submit` tool; the full enforce-mode path):

1. Arguments = job name + command/script skeleton + resource declaration + (optional) checkpoint resume pointer. Render the sbatch → write `submit.json`/`script.sbatch` → dedupe: an existing `running` job with the same render hash → return the existing job instead of submitting twice.
2. Run `sbatch script.sbatch` over the transport, parse the slurm job_id, register the job directory; register with `ctx.jobs.start` (kind declaration-merged as `hpc`; the owner decision vs. unowned form recorded by the M0 spike), returning the model-facing `job_id` (both the registry id and the slurm id are echoed).
3. Create a schedule reminder with `every_seconds = pollEverySeconds` (default 300), whose payload carries the registry job_id + the job directory path.
4. **17 integration point: a successful submit emits `run_begin(hpc)`** (sibling doc 17-run-provenance, planned; until its file contract lands, telemetry ops records the same fields as a stopgap — non-blocking).

**Poll flow** (the schedule reminder fires; the handler never throws, wrapped in try/catch throughout):

1. Read the job directory → run `squeue -j <id>` over the transport; on a miss (already dequeued) run `sacct -j <id> --format=State,ExitCode` for the terminal state.
2. Append state transitions to `poll.jsonl`; update `JobSnapshot.detail` to `<slurm_state>@<partition> rev=<checkpoint_rev>`.
3. Pull logs incrementally: `tail -c <maxLogTailBytes>` into `logs/`; if the remote is unreachable → record a warn this round and mark `poll-stale` in detail (do **not** convert to failed; cluster network jitter is routine — only N consecutive failures escalate).
4. On a terminal state (COMPLETED/FAILED/CANCELLED/TIMEOUT): pull the final logs → register `artifacts/` (artifact paths + sha256) → delete the polling reminder → resolve `JobHooks.done` (mapping to `completed`/`failed`/`killed`; TIMEOUT maps to `failed` with TIMEOUT in detail) → tool-jobs' completion notice reaches the owning agent automatically.
   **17 integration point: at terminal state, automatically `run_log_artifact` (output-directory hash + artifact manifest pointer)**.

**Cancel flow** (`hpc_cancel`; also responds to registry `kill`):

- An explicit user cancel → transport `scancel` → poll confirms CANCELLED → settle as `killed`; when a registry-level `kill` arrives for session disposal rather than user intent, and the job is configured `detach-on-owner-loss` (default on; rationale: HPC jobs queue at hourly prices — a dead session should not kill the job), the cancel hook **stops only local polling and agent attribution, and does NOT scancel**; done settles locally as `killed` (detail: `detached`); the job_id + job directory remain available for a new session to re-attach. **This is the deliberate deviation from the jobs default owner semantics, and the M0 spike must verify it does not break the registry's up-front invariants** (preflight access and cleanup).

**Re-attach flow** (process restart / a new session takes over):

1. The new session obtains the job_id (via the 05 handoff pointer, user relay, or an `.hpc/jobs/` directory scan).
2. `hpc_attach(job_id)`: read the job directory → query current squeue/sacct state over the transport → re-`ctx.jobs.start` as an unowned kind, with `run()` entering the poll loop directly — the jobs registry is identity bookkeeping; re-attach = claiming a fresh local identity for a pre-existing remote job.

**Checkpoint/resume flows** (from M2):

- `hpc_checkpoint(job_id)`: the transport reads the remote `checkpoint.json` (running the validator first, when declared), and echoes the rev chain; the plugin never writes or intervenes — **the domain program owns checkpoint cadence** (quantum-sensing-style minute-level checkpoints are decided by the job script itself and do not occupy the agent's context).
- `hpc_resume(job_id | workdir)`: freeze a new submit (prepending `resume_from=<rev>` as an environment variable or scaffold argument), render a new sbatch and submit, with the `resumed_from` chain incremented; the old job's registry record stays as terminal lineage. **Checkpoint correctness belongs to the domain program**: the agent side only guarantees "pointer passing + faithful rendering + no double billing"; the DoD's resume drill uses a fixture job to verify end-to-end equivalence.

**Alignment with the 05 handoff** (M3): the 05 handoff artifact's `Evidence` section gains one line `hpc: { job_id, workdir, checkpoint_rev }` and the transfer is complete; after the new session has the handoff injected via `agent/session-start` (05 seam 7), its first action can be `hpc_attach`. 05 is untouched; 18 consumes.

### Data-residency boundary

Submit ships only a **job description** (script + resource declaration + pointers); data always stays on cluster-side filesystems; any data movement up/down (if any) is triggered explicitly by the user/upper-level approval flow, never through this plugin's default path. Rationale: the XFEL requirements list states plainly "no user data transferred to third parties"; the authority layer for data location and movement policy is the main-repo sandbox/approval — this plugin does not become a second gate, it only writes the boundary down hard in tool annotations and the README.

## Milestones

- **M0 — provider-form spike (one PR)**: per the four adjudication criteria, write one minimal spike each against a fake cluster (mock transport) + the real jobs registry; deliverable = `docs/design/18-m0-spike-report.md` (each criterion pass/fail + the verdict). Verification: {driver: boot a real `LocalJobRegistry` with a fake ctx under incubation-repo vitest, exercising declaration merge + start/cancel/re-attach cases; observable: the spike report + test exit code; pass: all four criteria resolved and exactly one form selected}.
- **M1 — slurm submit + polling (after Form A is ratified; one PR)**: `ClusterTransport` (ssh + mock implementations), sbatch rendering, hpc_submit/hpc_attach, schedule polling, and the mock slurm stub CLI (a local state machine: PENDING→RUNNING→COMPLETED/FAILED/TIMEOUT, answering sbatch/squeue/sacct/scancel). Verification: {driver: auto tests run entirely against the mock transport, driven by fixture cluster state-machine scripts; observable: the job snapshot sequence, the poll.jsonl journal, the terminal done outcome; pass: the full chain submit→PENDING→RUNNING→COMPLETED plus log-reclamation assertions all green; a duplicate submit of the same render is idempotent}.
- **M2 — checkpoint/resume convention + tools (one PR)**: the checkpoint.json schema + strict-mode rejection; hpc_checkpoint/hpc_resume; the validator hook. Verification: {driver: a fixture job (a sleep+counter script writing a rev chain) is killed→resumed on the mock cluster; observable: the resumed_from chain, the produced outputs; pass: the resumed run's terminal artifacts are byte-identical to the uninterrupted baseline; a resume of a job without the checkpoint convention is refused with an error containing the convention guidance}.
- **M3 — 05/17 integration (one PR)**: the handoff's hpc pointer section + attach continuation; run_begin/run_log_artifact wiring (kept as telemetry stopgap if 17 has not landed). Verification: {driver: a synthetic session performs a 05-style fork + resume injection carrying the hpc pointer; observable: the new session's first-step attach succeeds and the registry's new identity takes over the same slurm id; pass: after the handoff, poll/cancel/terminal notification are all reachable with no residual polling on the parent side}.

## Verification plan

1. **Unit**: the template-rendering matrix (resource declaration sparse/full/overridden), the mock slurm state machine's full transitions and illegal jumps, checkpoint.json parse tolerance (missing rev / broken chain / validator failure).
2. **Mock-cluster full loop (integration-grade auto)**: the end-to-end cases of M1/M2 are the primary acceptance — see DoD.
3. **Checkpoint drill (auto)**: M2's kill→resume→baseline comparison, including the negative "a validator-rejected bad checkpoint is not submitted".
4. **Real-cluster first run (manual)**: executed jointly with the breeding GBLUP first run (checklist in DoD; the scenario belongs to this series' no. 22 breeding domain pack, planned) — real ssh transport, real queue waits, real sacct terminal states, and one deliberate kill to watch the resume path.
5. **Regression gates**: the CI triplet typecheck/test/build + doc checks (hook up the manifest-annotation sync lint if 01's lint already exists).

## Risks and open questions

- **R1 owner-semantics deviation**: with `owner` supplied, agent disposal cancels the job — detach-on-owner-loss requires unowned registration + application-layer session authorization instead, moving the authorization surface from the registry into this plugin; if the M0 spike proves unowned jobs cannot be constrained to "the original session first", criterion (b) vetoes Form A toward Form B. **How to check**: read `LocalJobRegistry`'s owner checks and disposal paths closely (`packages/jobs/jobs-local/src/index.ts`) before concluding.
- **R2 poll granularity**: the schedule floor of 300s means completion-awareness latency for short jobs (<5 min) is acceptable (notifications depend on polling), but interactive tuning loops will feel "dull"; open: whether to allow run_code-fronted one-shot high-frequency polling as a model-facing option (off by default, to avoid burning tokens).
- **R3 Ownership of remote preflight**: `hpc_submit` needs to confirm the cluster-side environment (module loads / partitions / quotas) — that is the remote tier of [21 domain-pack](./21-domain-pack.md) preflight; the division of labor: 21 defines the preflight mechanism and the local tier, while 18's submit template duty = embedding a remote self-check section into the rendered sbatch artifact (version/env/path assertions first, fail-fast on the cluster side) — a local preflight "pass" ≠ a cluster-side "pass".
- **R4 Semantic drift between mock and real slurm**: squeue/sacct state words, exit codes, and field versions drift constantly; the mock only locks the contract of the subset we *consume*, and the real first run (manual) is the correction point.
- **R5 Log volume**: HPC job logs can reach GB — default is a 64KiB tail pull; full reclamation belongs to artifact sha registration + user discretion; never pipe log bodies into the agent context (detail carries only status lines).
- **R6 Data-residency enforcement**: the boundary is expressed via annotations and docs; technically an hpc_submit command could still embed a curl upload — this joint defense involves the 09 token-wall / approval layer; this cycle does not duplicate the gate, accepts a "document-level boundary", and registers the risk.

## Definition of Done (unit acceptance)

Checkbox taxonomy: [auto] = assertable in CI; [manual] = executed by a human with evidence back-filled; [integration] = cross-package end-to-end assertions within this repo.

- [ ] [auto] Mock-cluster full loop: submit → PENDING→RUNNING→COMPLETED state-transition sequence → log-tail reclamation → done settlement; the snapshot sequence and the poll.jsonl schema validate against each other.
- [ ] [auto] A duplicate submit of the same rendered artifact reuses the existing job and never produces a second slurm id.
- [ ] [auto] Checkpoint drill: the fixture job (rev-chain-writing) is killed mid-run → resumed → its terminal artifacts are byte-identical to the uninterrupted baseline; the `resumed_from` chain is intact.
- [ ] [auto] Negative cases: resume on a job without the checkpoint convention is refused fail-closed with an error containing the convention format guidance; a bad checkpoint (validator failure) is not submitted.
- [ ] [auto] Cancel both ways: user cancel → scancel to terminal killed; owner-loss (simulated session disposal) → local settlement with detail=`detached` while the remote job stays running (if M0 adjudicates Form B, this item is rewritten as the equivalent behavior of the standalone service).
- [ ] [auto] Schedule polling wiring: exactly one every-reminder exists after submit; the reminder is deleted after terminal state; N consecutive transport failures escalate alerts only and never fabricate a terminal state.
- [ ] [auto] Telemetry ops vocabulary: the attribute shapes of hpc/submit, hpc/poll, hpc/terminal, hpc/resume, hpc/attach are spy-asserted.
- [ ] [integration] The 05 handoff carries the hpc pointer → new session attach → the poll/terminal-notification chain asserted in the synthetic-session integration (reusing 05's synthetic-driver style).
- [ ] [integration] 17 wiring: submit emits run_begin(hpc), terminal state emits run_log_artifact (while 17 is unlanded, assert the telemetry stopgap fields are same-shaped; after 17 lands, switch to the real interface with tests unchanged).
- [ ] [auto] 01 manifest built-in entries: submit/resume/cancel=side-effecting, status/logs/checkpoint_read=readonly, with lint coverage at 100%.
- [ ] [manual] Real-cluster first-run checklist (executed jointly with the breeding GBLUP first run; see this series' no. 22, planned): ① ssh transport connectivity and a real sbatch submission; ② real squeue/sacct state words diffed against the mock dictionary to zero or differences registered; ③ one deliberate kill of a job to verify the resume path; ④ terminal log reclamation and artifact hash re-verification; ⑤ data-residency confirmation: no data moved up or down by any default action throughout.
- [ ] [manual] The README is consistent with the form verdict in 18-m0-spike-report.md; the fallback rationale (if Form B) is recorded at both the doc level and in code comments.
