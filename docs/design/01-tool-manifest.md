# 01 tool-manifest — A shared substrate for tool metadata

> Status: design (not started) | Tier: 1 (substrate) | Package: packages/verification/tool-manifest | Depends on: none (only cordis + dsh core types) | Consumers: 02 claim-contracts, 09 token-wall, 10 verified-tools

## Design goal and user problem

**Goal**: provide the single per-tool metadata registry (effect class / idempotency recipe / disclosure class / failure semantics) for every gate/verify-type plugin, with a builtin core-tool manifest, user overlays, and a fail-closed default for unknown tools.
**User problem**: today, anyone adding "is this call safe / can it be retried" logic to the agent hand-rolls a hard-coded tool list; as those lists drift apart, the same tool is allowed in one place and blocked in another — the user faces self-contradicting behavior with no authoritative answer anywhere.



## Motivation (why it's needed)

The three-layer verification stack (trace property / action gate / claim contract)
and TokenWall-style exfiltration defenses all need to answer the same set of
per-tool questions: does this tool have side effects? Is it safe to retry? Do its
parameters carry payloads that could leave the network? After a failure, what
state is the world in?

Without a unified annotation substrate, every plugin will invent its own tool
classification table. Reviews of docs 04/08/09 have already surfaced the
**duplicate-annotation risk** — permission-rules maintains its own
`fileEditTools`/`readOnlyTools` lists, verified-tools needs idempotency recipes,
token-wall needs an exfiltration classification: three lists that drift apart and
contradict each other (the same tool is readonly in plugin A but approval-gated in
plugin B). The core premise of Verified Tool Calls (2608.02645) is that "tool
calls carry verifiable effect claims"; TokenWall's premise is "a uniform disclosure
grading at every egress point". Both demand a **single annotation mechanism**
(doc 00 overview, shared principle 4).

This package provides: the `ctx.toolManifest` service + a built-in manifest + a
user overlay layer — the sole entry point through which all gate/verify-type
plugins read tool metadata.

## Current state and the gap

Where dsh stands today: `ctx.tools` (ToolRuntime) is a cordis service;
`register(definition)` registers a `ToolDefinition` (name/description/parameters +
output schema + execute), dispatched through the waterfall `tools/pre-execute` →
`tools/execute` → `tools/post-execute`, plus a monotonic guard layer. Tool
self-description stops at the JSON Schema level — **there is no
effect/idempotency/exfiltration semantics whatsoever**.

permission-rules (dsh-cc-plugins) already demonstrates the gap: to make
plan-mode/acceptEdits decisions, it embeds the hardcoded lists
`DEFAULT_FILE_EDIT_TOOLS` and `DEFAULT_READ_ONLY_TOOLS` in its Config. This is the
first instantiation of "every consumer carries its own tool classification"; once
docs 09/10 land it becomes three mutually incompatible mechanisms. The gap = **one
authoritative, overridable, fail-closed per-tool metadata registry**.

## Design

### Surface and seams

Seams verified one by one (file:line):

- **Service registration pattern** (cordis `Service`):
  `dsh-cc-plugins/packages/interaction/permission-rules/src/index.ts:153`
  (`class PermissionRulesService extends Service`, with `super(ctx, 'permissionRules')`
  in the constructor, `static inject = ['tools']`, and type declaration merging via
  `declare module '@deepseek-ai/cordis' { interface
  Context { permissionRules: ... } }`). tool-manifest follows this pattern to mount
  `ctx.toolManifest`; the `toolManifest` key has zero grep hits in both the
  deepseek-harness and dsh-cc-plugins repos — no conflict.
- **Tool enumeration API** (the core consumption seam): in
  `deepseek-harness/packages/core/tools/src/index.ts`,
  `ToolRuntime extends Service` (:787, `super(ctx, 'tools')`); public surface:
  `get(name, scope?): ToolDefinition | undefined` (:1204),
  `schemas(scope?): ToolSchema[]` (:1234), `guard()` (:1110), and the
  `tools/change` event (:207, register/unregister notification, for incremental
  refresh by the coverage lint).
  `ToolSchema = { name: string; description: string; parameters: Record<string, unknown> }`
  (`deepseek-harness/packages/llm/llm/src/types.ts:312`).
- **glob matching semantics** (aligned with permission-rule):
  `permission-rules/src/parser.ts:27` `matchContent` — `*` is a wildcard, `:*` is a
  prefix; the manifest's `pattern` field reuses the same semantics to avoid a second
  matching dialect.
- Execution flow: the listener shape for `tools/pre-execute` can be seen at
  permission-rules/src/index.ts:216.

The **read direction** of tool enumeration: tool-manifest listens to `tools/change`
+ calls `ctx.tools.schemas()` for coverage statistics; it **never** demands in the
reverse direction that dsh tool registration carry new fields (zero upstream
changes — purely a plugin-side overlay).

### Data model / configuration

```ts
// A single manifest entry (all fields except pattern/description are optional → covered by defaults)
interface ToolManifestEntry {
  pattern: string            // tool-name glob, same semantics as permission-rule matchContent ('*' / ':*')
  description: string        // human-readable classification rationale (for audit; never enters model context)
  effectClass?: 'readonly' | 'write-local' | 'side-effecting'
              | 'external-disclosure' | 'authority-change' | 'irreversible'
  idempotency?: {
    argFields: string[]      // argument paths participating in the hash (e.g. ['file_path','content'])
    timeBucketSec?: number   // time-bucket granularity; 0 = exclude time (pure content addressing)
  }                          // deterministic idempotency key = hash(argFields values + agentId + floor(now/bucket))
  retryProbe?: {             // lets doc 10 verified-tools autopsy the failure before retrying
    kind: 'shell-command' | 'tool-call'
    command?: string         // probe command when kind=shell-command (template may reference args)
    tool?: string            // probe tool name when kind=tool-call (must be effectClass=readonly)
    args?: Record<string, unknown>
    expect: string           // postcondition expression (e.g. exit=0 and stdout matches glob)
  }
  disclosureClass?: 'none' | 'egress-payload' | 'publish'
  failureSemantics?: 'atomic' | 'timeout-ambiguous' | 'partial-visibility'
}

interface ManifestFile {
  version: 1
  entries: ToolManifestEntry[]
  provenance?: { source: 'builtin' | 'plugin-declared' | 'user-overlay'; ref: string }
}
```

**Source precedence** (later overrides earlier; within the same precedence the
later registration overrides the earlier one; conflicts are warned at load time):
`plugin-declared < builtin < user-overlay(~/.dsh/tools.manifest.json) <
project(.dsh/tools.manifest.json)`. Overrides merge at the granularity of fields
within a single entry; provenance is always recorded alongside the final effective
fields, so audits can trace "who decided this classification".

**Fail-closed default posture** (a design point, not an expedient): a tool whose
lookup hits no pattern returns a synthesized entry `{ effectClass: 'side-effecting',
failureSemantics: 'timeout-ambiguous', disclosureClass: 'none' }` (missing
idempotency recipe = not retryable). Rationale: treating unknown tools as
side-effecting with timeout-ambiguous consequences is the only safe common
assumption for the consumers (02/09/10) — better to over-block than to under-block
(same lineage as permission-rules' deny-by-default); `disclosureClass: 'none'`
looks lenient, but egress decisions are independently enforced by token-wall on
payload content — the manifest layer does not answer for it.

### Key behavior flows

- **Registration flow**: a plugin calls `ctx.toolManifest.register(entries)`
  (returns a dispose, per cordis convention); the builtin manifest ships with the
  package; overlay layers read their files at start, hot update goes through the
  settings-file watcher (re-read → rebuild merged view → fire the
  `tool-manifest/change` event so consumers re-fetch).
- **Query flow**: `lookup(toolName)` → take the first entry whose pattern matches,
  scanning precedence from high to low → fall back field by field to
  lower-precedence entries for missing fields → if still missing, fall back to the
  fail-closed synthesized entry → return `{ entry, provenance, defaulted: string[] }`
  (marking which fields were defaulted).
- **Coverage flow**: the lint (see M2) calls `lookup` for every `name` from
  `ctx.tools.schemas()`; anything whose `defaulted` contains `effectClass` is
  recorded as "uncovered", and it outputs a list plus suggested entry skeletons.

### Built-in manifest

Shipped with the package in M2 (JSON), with per-tool grading rationale:

| Tool | effectClass | disclosureClass | failureSemantics | Idempotency / rationale |
|---|---|---|---|---|
| `read`,`list`,`glob`,`grep` (fs-search) | `readonly` | `none` | `atomic` | read-only; idempotency key = path/pattern args, pure content addressing |
| `write`,`str_replace_editor` | `write-local` | `none` | `atomic` | modifies local files; failure means no write; idempotency key = file_path + content hash |
| `bash`,`pwsh` | `side-effecting` | `egress-payload` | `timeout-ambiguous` | commands can touch the network and mutate the system; timeout does not mean not executed; no retry — retryProbe is supplied by the caller |
| `skill` | `readonly` | `none` | `atomic` | only loads instruction text into context, no writes of its own; any follow-up actions are the responsibility of the subsequent tools |
| `todo` | `write-local` | `none` | `atomic` | in-session state; idempotency key = the full entry set |
| `goal` | `authority-change` | `none` | `atomic` | changes the agent's goal stack — an authority/intent-surface change that gate-type plugins must question separately |
| `subagent`,`fork` | `side-effecting` | `none` | `timeout-ambiguous` | spawned subagents call tools on their own; whether the child has started is unknowable at the timeout point |
| `report` (subagent report-back) | `write-local` | `none` | `atomic` | writes only to the parent session context |
| `list_agents` | `readonly` | `none` | `atomic` | pure query |
| `jobs`,`workflow`,`ralph` | `side-effecting` | `none` | `timeout-ambiguous` | schedules/orchestrates background execution; after submission the main execution body may already be running |
| `web_search` | `external-disclosure` | `egress-payload` | `atomic` | the query goes out to a search provider — it is itself a disclosure act; resending the same query adds no new disclosure; idempotency key = query + day-granularity time bucket |

(web_fetch is disabled upstream and not in the manifest; if enabled later, default
to `external-disclosure` + `egress-payload`, plus `publish` only when the target is
a public site.)

## Milestone breakdown

- **M1 — schema + loader + service**: type definitions and schemastery validation;
  multi-source merge with field-level fallback; `ctx.toolManifest`
  (`register/lookup/list` + `tool-manifest/change` event) + `declare module` type
  merging; unit tests cover: precedence, fail-closed fallback, glob matches,
  provenance recording.
  Acceptance: `pnpm typecheck && pnpm test` all green; a unit test asserts that
  looking up an unknown tool returns `side-effecting/timeout-ambiguous` with a
  non-empty `defaulted`.
- **M2 — built-in manifest + coverage lint**: ship the core-tool JSON manifest;
  repo script `pnpm lint:tool-manifest` calls `schemas()` against a minimal dsh app
  that brings up all core tools, producing a coverage report; uncovered tools are
  listed with entry skeletons; wired into CI as a non-zero exit.
  Acceptance: the script outputs 100% coverage (all core tools hit); after manually
  unregistering one fake tool entry, the script exits non-zero and names that tool.
- **M3 — consumer API freeze notes + docs**: the README spells out the lookup
  contract (return value includes provenance/defaulted, fail-closed semantics,
  change event), and notes that "compile-time dependencies of 02/09/10 may only
  reach this package's type exports"; plus migration advice for dsh-cc-plugins
  (permission-rules' hardcoded lists can switch to reading the manifest, optionally
  at runtime).
  Acceptance: a spike consumer (just `lookup('bash')` and print) typechecks against
  this package's type exports; the README contract paragraphs correspond
  one-to-one with implementation unit tests.

## Verification plan

1. The acceptance criteria for M1/M2 are embedded in each milestone's "Acceptance"
   line (unit tests + script exit codes; all can run on a fake ctx with no dsh
   runtime dependency, honoring the zero-compile-time-dependency constraint).
2. Integration smoke: in the incubation repo's examples, use the `pnpm new:plugin`
   skeleton to bring up a dsh app + tool-manifest; confirm `ctx.toolManifest`
   mounts and `lookup('web_search')` returns `external-disclosure` with
   provenance=`builtin`.
3. Regression gate: the CI triple required by the doc 00 overview
   (typecheck/test/build) + lint:tool-manifest.

## Risks and open questions

- **Enumeration across the scope dimension**: the `scope` semantics of
  `ctx.tools.schemas(scope?)` (per-agent tool variants) have not been verified line
  by line — whether the coverage lint needs to iterate all agent scopes will be
  checked at M2 implementation time with `grep -n "ScopeKey"
  packages/core/tools/src/index.ts`, then backfilled with tests.
- **user-overlay file watching**: whether dsh has an existing config-file watch
  facility (like settings' installSettingsSection) is unverified; M1 reads once,
  and hot update is demoted to an open question.
- **Source of the agentId in idempotency keys**: a stable per-agent identifier is
  needed in the hash; which field of `ToolExecution.agent` to take will be verified
  against its execution context when doc 10 is kicked off.
- **Content-level argument globs**: pattern matches tool names only; if a consumer
  needs "classify a certain class of bash commands separately" (the
  permission-rules content-matcher scenario), an extension point is reserved but
  not built this round, to avoid the manifest becoming a second permission-rule
  language.
