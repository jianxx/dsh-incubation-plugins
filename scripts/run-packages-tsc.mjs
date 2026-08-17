#!/usr/bin/env node
/**
 * run-packages-tsc.mjs — `tsc -b tsconfig.packages.json` wrapper.
 *
 * Bootstrap carve-out: with zero packages the solution config has no project
 * references, and tsc -b refuses an empty solution (TS18002). Skip cleanly in
 * that state; once the first package is scaffolded (references non-empty),
 * this is a pass-through to tsc. Passed-through args reach tsc unchanged.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = join(root, "tsconfig.packages.json");
if (!existsSync(cfg)) {
  console.error("run-packages-tsc: tsconfig.packages.json not found");
  process.exit(1);
}
const refs = JSON.parse(readFileSync(cfg, "utf8")).references ?? [];
if (refs.length === 0) {
  console.log("no packages yet — nothing to build (tsc -b skipped)");
  process.exit(0);
}

const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
const res = spawnSync(process.execPath, [tsc, "-b", cfg, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(res.status ?? 1);
