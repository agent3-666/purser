/**
 * Delete each guarded rule, one at a time, and require the scenario that names it to fail.
 *
 *   npx tsx scripts/mutation-check.ts
 *
 * Refuses three results that look like success:
 *   - a GUARD marker that no scenario names (nothing would notice it disappearing)
 *   - a marker that matches more or less than one line
 *   - a mutant that does not run at all (a crash is not a failing scenario)
 * Files are restored from a byte copy taken before each mutation, never from git.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const RESULTS = join(ROOT, "out/payee-authorization-experiments.json");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}

interface Scenario { id: string; guard: string | null; pass: boolean; got: { verdict: string; reasons: string[] } }

function runExperiments(): Scenario[] | null {
  rmSync(RESULTS, { force: true });
  try {
    execFileSync(join(ROOT, "node_modules/.bin/tsx"), ["experiments/payee-authorization.ts"], { cwd: ROOT, stdio: "pipe" });
  } catch {
    // A failing scenario exits 1 by design. Whether the run happened at all is decided by the file.
  }
  if (!existsSync(RESULTS)) return null;
  return JSON.parse(readFileSync(RESULTS, "utf8")) as Scenario[];
}

const markers: Array<{ file: string; guard: string }> = [];
for (const file of sources(join(ROOT, "src"))) {
  for (const m of readFileSync(file, "utf8").matchAll(/GUARD:([a-z0-9-]+)/g)) markers.push({ file, guard: m[1] });
}

const baseline = runExperiments();
if (!baseline || baseline.some((s) => !s.pass)) {
  console.error("baseline is not green, so no mutation result would mean anything");
  process.exit(2);
}
const named = new Set(baseline.map((s) => s.guard).filter(Boolean));
const unnamed = markers.filter((m) => !named.has(m.guard));
if (unnamed.length) {
  console.error(`GUARD markers no scenario names: ${unnamed.map((m) => m.guard).join(", ")}`);
  process.exit(2);
}

let bad = 0;
for (const { file, guard } of markers) {
  const original = readFileSync(file, "utf8");
  const lines = original.split("\n");
  const hits = lines.filter((l) => l.includes(`GUARD:${guard}`));
  if (hits.length !== 1) {
    console.log(`FAIL  ${guard}: marker matches ${hits.length} lines`);
    bad++;
    continue;
  }
  const backup = `${file}.mutation-backup`;
  copyFileSync(file, backup);
  try {
    writeFileSync(file, lines.filter((l) => !l.includes(`GUARD:${guard}`)).join("\n"));
    const results = runExperiments();
    if (!results) {
      console.log(`FAIL  ${guard}: the mutant did not run, so this proves nothing`);
      bad++;
      continue;
    }
    const target = results.filter((s) => s.guard === guard);
    const turned = target.filter((s) => !s.pass);
    if (turned.length === target.length && target.length > 0) {
      console.log(`ok    ${guard}: ${turned.map((s) => `${s.id} now ${s.got.verdict}`).join("; ")}`);
    } else {
      console.log(`FAIL  ${guard}: removing it changed nothing in ${target.filter((s) => s.pass).map((s) => s.id).join(", ")}`);
      bad++;
    }
  } finally {
    copyFileSync(backup, file);
    rmSync(backup);
  }
}

if (readFileSync(markers[0].file, "utf8").includes("mutation-backup")) process.exit(3);
console.log(bad ? `\n${bad} guard(s) not proven` : `\nall ${markers.length} guards proven: removing any one changes the scenario it exists for`);
process.exit(bad ? 1 : 0);
