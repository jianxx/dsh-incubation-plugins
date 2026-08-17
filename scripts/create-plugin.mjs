#!/usr/bin/env node
/**
 * create-plugin.mjs — scaffold a new incubation plugin package.
 *
 *   pnpm new:plugin <group> <name> [--desc "one-line description"]
 *
 * Creates packages/<group>/<name>/ with:
 *   package.json   — @jianxx/dsh-incubation-<name>, cordis peerDep + link: devDep
 *   tsconfig.json  — extends ../../../tsconfig.base.json, src → lib
 *   src/index.ts   — cordis plugin surface (name/inject/apply) skeleton
 *   tests/<name>.spec.ts — vitest smoke test (imports ../src, root vitest only)
 *   README.md      — incubation card: goal / status / graduation criteria
 *
 * and registers the package in:
 *   tsconfig.base.json        — compilerOptions.paths alias (JSON round-trip)
 *   tsconfig.packages.json    — project references (JSON round-trip)
 *   pnpm-lock.yaml            — importers entry, inserted textually per
 *                               docs/dev.md "Lockfile invariants" (link: specifiers
 *                               need no packages:/snapshots: rows), because this
 *                               host cannot run pnpm install --lockfile-only
 *                               (network-restricted; see docs/dev.md)
 *   README.md                 — one row in the ## Layout code block
 * and symlinks the package's link: devDeps into
 * packages/<group>/<name>/node_modules so typecheck/test work offline
 * immediately (pnpm's strict layout does the same on CI after a real install).
 *
 * Idempotency: refuses when the package dir exists; every registration skips
 * an already-present entry. Bundles (cordis.patch.yml composition packages)
 * are NOT scaffolded here — copy packages/bundle/* shape by hand when needed.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCOPE = "@jianxx";
const PREFIX = "dsh-incubation";
const HARNESS_REPO = "deepseek-harness";
const CORDIS_LINK = "link:../../../../deepseek-harness/vendor/cordis";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) {
  console.error(`create-plugin: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  let desc = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--desc") {
      desc = argv[++i] ?? "";
      if (!desc) fail("--desc needs a value");
    } else if (a === "--help" || a === "-h") {
      console.log(
        "usage: pnpm new:plugin <group> <name> [--desc \"one-line description\"]\n" +
          "  group: packages/<group>/ category dir (kebab-case, e.g. interaction)\n" +
          "  name:  package dir name (kebab-case, e.g. command-foo)\n" +
          "creates @jianxx/dsh-incubation-<name> at packages/<group>/<name>",
      );
      process.exit(0);
    } else if (a.startsWith("--")) {
      fail(`unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) {
    fail("expected <group> <name>; see --help");
  }
  return { group: positional[0], name: positional[1], desc };
}

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Parse + re-stringify JSON canonically (2-space), insert, keep key order. */
function editJson(path, mutate) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  const changed = mutate(data);
  if (changed) writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  return changed;
}

/** Textual pnpm-lock.yaml importer insert (alphabetical), per docs/dev.md. */
function insertLockfileImporter(lockPath, importerKey, bodyLines) {
  if (!existsSync(lockPath)) return "missing";
  const text = readFileSync(lockPath, "utf8");
  if (text.includes(`  ${importerKey}:`)) return "present";
  const lines = text.split("\n");
  const impIdx = lines.indexOf("importers:");
  if (impIdx === -1) fail("pnpm-lock.yaml has no importers: section");
  // Importers section ends at the next column-0 key or EOF.
  let secEnd = lines.length;
  for (let i = impIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) {
      secEnd = i;
      break;
    }
  }
  // Entry keys are the two-space-indented `key:` lines within the section.
  const entries = [];
  for (let i = impIdx + 1; i < secEnd; i++) {
    const m = /^  (\S[^:]*):\s*$/.exec(lines[i]);
    if (m) entries.push({ key: m[1], line: i });
  }
  const block = [`  ${importerKey}:`, ...bodyLines];
  // `.` (the root) sorts first by pnpm convention; packages/* alphabetical.
  let done = false;
  for (const e of entries) {
    if (e.key === ".") continue;
    if (e.key > importerKey) {
      // entry + trailing blank, right before the next entry's key line
      lines.splice(e.line, 0, ...block, "");
      done = true;
      break;
    }
  }
  if (!done) {
    // section end: back up over the blank separator line(s), insert
    // blank-led block + trailing blank so pnpm's entry spacing is preserved.
    let endIdx = secEnd;
    while (endIdx - 1 > impIdx && lines[endIdx - 1] === "") endIdx--;
    lines.splice(endIdx, 0, "", ...block, "");
    if (lines[impIdx + 1] !== "") lines.splice(impIdx + 1, 0, "");
  }
  writeFileSync(lockPath, lines.join("\n"));
  return "inserted";
}

function packageJson(group, name, desc) {
  return {
    name: `${SCOPE}/${PREFIX}-${name}`,
    description: desc || `TODO: one-line description of ${name}`,
    version: "0.1.0",
    repository: {
      type: "git",
      url: "git+https://github.com/jianxx/dsh-incubation-plugins.git",
      directory: `packages/${group}/${name}`,
    },
    type: "module",
    exports: {
      ".": {
        types: "./lib/index.d.ts",
        default: "./lib/index.js",
      },
      "./src/*": "./src/*",
      "./package.json": "./package.json",
    },
    files: ["lib"],
    license: "Apache-2.0",
    peerDependencies: {
      "@deepseek-ai/cordis": ">=0.1.0-rc.5",
    },
    devDependencies: {
      "@deepseek-ai/cordis": CORDIS_LINK,
    },
  };
}

const TSCONFIG_JSON = `{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib"
  },
  "include": [
    "src"
  ],
  "references": []
}
`;

function indexTs(name, desc) {
  return `/**
 * ${desc || `TODO: what ${name} does.`}
 * @module ${SCOPE}/${PREFIX}-${name}
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = '${name}'
export const inject: string[] = []

/**
 * Mount the plugin surface (tools, commands, hooks, …).
 * @param _ctx - cordis context carrying the harness seams.
 */
export function apply(_ctx: Context): void {
  // TODO: implement ${name}.
}
`;
}

function specTs(name) {
  return `import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/index.ts'

describe('${SCOPE}/${PREFIX}-${name}', () => {
  it('exposes the cordis plugin surface', () => {
    expect(name).toBe('${name}')
    expect(inject).toEqual([])
    expect(apply).toBeTypeOf('function')
  })
})
`;
}

function readmeMd(name, desc) {
  return `# ${SCOPE}/${PREFIX}-${name}

${desc || "TODO: one-line description."}

**Status: incubating.** Experimental dsh plugin; not yet covered by the
stability expectations of the main plugin set. Breaking changes may land
without deprecation.

## Goal

TODO: what user-visible capability this plugin adds, and why it cannot live
in the harness core or the main plugin repo today.

## Graduation criteria

TODO: the exit conditions — e.g. exercised in a real profile for N sessions,
CI gates green, no open correctness bugs — after which this package graduates
out of incubation (republished under the main plugin set).

## Develop

\`\`\`sh
pnpm typecheck   # tsc -b (emits lib/)
pnpm test        # vitest; this package's suite is tests/${name}.spec.ts
\`\`\`
`;
}

function main() {
  const { group, name, desc } = parseArgs(process.argv.slice(2));
  if (!KEBAB.test(group)) fail(`invalid group '${group}' (kebab-case required)`);
  if (!KEBAB.test(name)) fail(`invalid name '${name}' (kebab-case required)`);

  const pkgRel = `packages/${group}/${name}`;
  const pkgDir = join(root, pkgRel);
  if (existsSync(pkgDir)) fail(`${pkgRel} already exists`);
  for (const f of ["tsconfig.base.json", "tsconfig.packages.json"]) {
    if (!existsSync(join(root, f))) fail(`${f} not found at repo root`);
  }

  const harnessDir = resolve(root, "..", HARNESS_REPO);
  const cordisTarget = resolve(pkgDir, CORDIS_LINK.slice("link:".length));
  if (!existsSync(harnessDir)) {
    console.warn(
      `warning: sibling checkout ../${HARNESS_REPO} not found — ` +
        `the link: devDep will dangle until it exists`,
    );
  } else if (!existsSync(cordisTarget)) {
    console.warn(`warning: ${cordisTarget} missing — build the harness first`);
  }

  // -- files ---------------------------------------------------------------
  mkdirSync(join(pkgDir, "src"), { recursive: true });
  mkdirSync(join(pkgDir, "tests"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify(packageJson(group, name, desc), null, 2) + "\n",
  );
  writeFileSync(join(pkgDir, "tsconfig.json"), TSCONFIG_JSON);
  writeFileSync(join(pkgDir, "src", "index.ts"), indexTs(name, desc));
  writeFileSync(join(pkgDir, "tests", `${name}.spec.ts`), specTs(name));
  writeFileSync(join(pkgDir, "README.md"), readmeMd(name, desc));
  console.log(`created ${pkgRel}/{package.json,tsconfig.json,src/index.ts,tests/${name}.spec.ts,README.md}`);

  // -- tsconfig registrations ----------------------------------------------
  const alias = `${SCOPE}/${PREFIX}-${name}`;
  const baseChanged = editJson(join(root, "tsconfig.base.json"), (d) => {
    const paths = (d.compilerOptions ??= {}).paths ??= {};
    if (paths[alias]) return false;
    paths[alias] = [`./${pkgRel}/src/index.ts`];
    d.compilerOptions.paths = Object.fromEntries(
      Object.entries(paths).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    return true;
  });
  const refsChanged = editJson(join(root, "tsconfig.packages.json"), (d) => {
    d.references ??= [];
    if (d.references.some((r) => r.path === `./${pkgRel}`)) return false;
    d.references.push({ path: `./${pkgRel}` });
    d.references.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return true;
  });
  if (baseChanged) console.log(`tsconfig.base.json: added paths["${alias}"]`);
  if (refsChanged) console.log(`tsconfig.packages.json: added reference ./${pkgRel}`);

  // -- lockfile importer (textual; docs/dev.md lockfile invariants) ---------
  const lockStatus = insertLockfileImporter(
    join(root, "pnpm-lock.yaml"),
    pkgRel,
    [
      "    devDependencies:",
      "      '@deepseek-ai/cordis':",
      `        specifier: ${CORDIS_LINK}`,
      `        version: ${CORDIS_LINK}`,
    ],
  );
  if (lockStatus === "inserted") {
    console.log(`pnpm-lock.yaml: added importer ${pkgRel}`);
  } else if (lockStatus === "missing") {
    console.warn(
      "warning: pnpm-lock.yaml not found — run pnpm install once on a " +
        "networked host to generate it (docs/dev.md)",
    );
  }

  // -- per-package node_modules for link: devDeps (offline dev loop) --------
  if (existsSync(cordisTarget)) {
    const dest = join(pkgDir, "node_modules", "@deepseek-ai", "cordis");
    mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(dest)) {
      symlinkSync(cordisTarget, dest);
      console.log(`linked node_modules/@deepseek-ai/cordis -> ${cordisTarget}`);
    }
  }

  // -- root README Layout row ----------------------------------------------
  const readmePath = join(root, "README.md");
  if (existsSync(readmePath)) {
    const text = readFileSync(readmePath, "utf8");
    if (!text.includes(`  ${group}/${name} `) && !text.includes(`  ${group}/${name}\n`)) {
      const layoutIdx = text.indexOf("## Layout");
      if (layoutIdx !== -1) {
        const open = text.indexOf("```", layoutIdx);
        const close = open !== -1 ? text.indexOf("```", open + 3) : -1;
        if (open !== -1 && close !== -1) {
          const rowBase = `  ${group}/${name}`;
          const pad = " ".repeat(Math.max(2, 28 - rowBase.length));
          const row = rowBase + pad + (desc || "TODO");
          const updated =
            text.slice(0, close) + row + "\n" + text.slice(close);
          writeFileSync(readmePath, updated);
          console.log(`README.md: added Layout row for ${group}/${name}`);
        }
      }
    }
  }

  console.log(`
done. Next steps:
  1. implement ${pkgRel}/src/ and grow tests/${name}.spec.ts
  2. pnpm typecheck && pnpm test
  3. declare any extra @deepseek-ai/* imports in ${pkgRel}/package.json
     devDependencies (link: into ../${HARNESS_REPO}) and mirror them in
     pnpm-lock.yaml — check:spec-deps enforces this (docs/dev.md)`);
}

main();
