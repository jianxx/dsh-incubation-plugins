# dsh-incubation-plugins

Incubating plugins for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). Experimental ideas live here first: every package ships as an independently installable unit that any dsh installation loads through its profile system, and graduates to the main plugin set once it proves out.

Sibling repo: [dsh-cc-plugins](https://github.com/jianxx/dsh-cc-plugins) (the CC-parity plugin set) — this repository reuses its tooling (pnpm workspace + tsc project references + vitest, presubmit gates, profile sync scripts) and its loading conventions.

**Status: no plugins yet.** The repo today carries only the development
infrastructure: layout, scaffolding, presubmit gates, CI.

## Layout

```
packages/
  <group>/<name>               one plugin per leaf; groups are thematic dirs
                               (interaction, core, hooks, memory, …)
```

Scaffold a new one (todo rows appear here automatically):

```sh
pnpm new:plugin interaction command-foo --desc "/foo — one-line description"
pnpm typecheck && pnpm test
```

The scaffolder (`scripts/create-plugin.mjs`) also registers the package in
`tsconfig.base.json` paths, `tsconfig.packages.json` references, and the
`pnpm-lock.yaml` importers section, and symlinks its `link:` devDeps so the
offline dev loop works immediately.

## How the loading works (the mechanism our names rely on)

1. Bundles list "rows" in `cordis.patch.yml`; each row is an entry `{id, name, config?, insert?…}` the Loader interprets.
2. The dsh launcher resolves each bundle's `name` two-anchor: the dsh installation first, then the profile directory. This is why our packages use the `@jianxx` scope: a `@deepseek-ai/dsh-*` name would be shadowed by the in-box copy.
3. Inside a patch, each `name:` is resolved from the profile directory as base URL; hoisted node_modules carries the whole bundle dependency tree, so one profile dependency on a bundle pulls every plugin with it.
4. Plugins' peers (`@deepseek-ai/cordis`, service-definition packages like `@deepseek-ai/dsh-invariants`) are NOT bundled: they resolve via the installation-wide symlink fallback, keeping one cordis instance per process. Never ship them as our `dependencies`.

## Install into a local profile (half a minute)

Prereq: a dsh CLI installation (`dsh` on PATH) and a built sibling checkout of
deepseek-harness at `../deepseek-harness`.

```sh
pnpm run build                              # emit lib/ per package
bash scripts/sync-local-profile.sh web      # flat-copy @jianxx/* into the profile
```

`scripts/sync-local-profile.sh` copies (not symlinks) the built packages into
the profile so every `@deepseek-ai/*` import resolves through the
installation's single cordis instance — the same way a published bundle does.
Re-run it after every build.

## Presubmit gates

Pre-commit (husky) and CI (`.github/workflows/presubmit.yml`) run the same
four gates:

```sh
pnpm check:spec-deps     # tests/ imports must be declared (docs/dev.md)
pnpm typecheck           # tsc -b tsconfig.packages.json (≡ build, emits lib/)
pnpm test                # vitest; packages/*/*/tests/**/*.spec.ts
pnpm check:subagent-paste
```

There is also `pnpm check:exports` — every `./lib/*` leaf in a package's
`exports` must resolve to a file the build emits (run it after `pnpm build`;
it is not wired into the gates because it needs `lib/` present).

CI additionally checks out `jianxx/deepseek-harness` side by side at a pinned
SHA (`DSH_HARNESS_REF` in the workflow) so `link:` devDeps resolve, and caches
the harness `lib/` outputs by that pin. Bump the pin + adapt in the same
commit when moving to a newer harness.

## Develop

```sh
pnpm install --frozen-lockfile    # offline-friendly: everything pins to the local dsh checkout via link:
pnpm run typecheck                # tsc -b (emits lib/ per package)
pnpm test                         # vitest
```

Upstream types resolve through `link:` devDeps into the sibling dsh checkout
at `../deepseek-harness` (built once with `pnpm run build:lib` there). To
publish for real, replace link: devDeps with released version ranges.

> Working on `pnpm-lock.yaml` or dependency declarations on a
> network-restricted host: see `docs/dev.md` for what the frozen-lockfile
> check actually verifies, the test-time dependency declaration contract,
> and worktree setup.
