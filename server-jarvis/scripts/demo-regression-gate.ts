// ── Demo: a trustworthy regression gate ──────────────────────────────
//
// A runnable, isolated proof that Jarvis's eval regression gate is
// fail-closed. It exercises four behaviours using ONLY a temporary
// baseline fixture in a fresh temp directory:
//
//   1. valid   — a matching baseline and a clean report => exit 0
//   2. missing — no baseline file                      => exit 1, fails closed
//   3. malformed — an untrustworthy baseline object    => exit 1, fails closed
//   4. drift   — behaviour regressed vs baseline       => exit 1, names the case
//
// The script exits 0 ONLY when all four behaviours are observed exactly as
// expected. It never touches the repo's real baseline.json, never calls a
// model and never opens a listener.
//
//   bun run scripts/demo-regression-gate.ts

import { mkdtempSync, existsSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runCliGate, toBaseline, validateBaseline, type Baseline, type EvalReport } from "../src/eval/harness";

function fakeReport(outcomes: Array<{ id: string; pass: boolean }>): EvalReport {
  const results = outcomes.map((o) => ({
    id: o.id,
    kind: "demo",
    pass: o.pass,
    detail: o.pass ? "ok" : "synthetic failure",
  }));
  const passed = results.filter((r) => r.pass).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}

interface Expectation {
  name: string;
  expectedExit: number;
  expectedLine: (text: string) => boolean;
}

const expectations: Expectation[] = [
  { name: "valid baseline passes", expectedExit: 0, expectedLine: (t) => t.includes("passed,") },
  { name: "missing baseline fails closed", expectedExit: 1, expectedLine: (t) => t.includes("Baseline unreadable") },
  { name: "malformed baseline fails closed", expectedExit: 1, expectedLine: (t) => t.includes("Baseline unreadable") },
  { name: "regression drift fails", expectedExit: 1, expectedLine: (t) => t.includes("Baseline drift detected") },
];

const realBaselinePath = join(import.meta.dir, "..", "src", "eval", "baseline.json");
const realBaselineBefore = existsSync(realBaselinePath)
  ? readFileSync(realBaselinePath, "utf8")
  : null;

let dir: string | null = null;
const observed: Array<{ name: string; exit: number; matched: boolean; output: string[] }> = [];

try {
  dir = mkdtempSync(join(tmpdir(), "jarvis-demo-gate-"));
  const baselinePath = join(dir, "baseline.json");

  const report = fakeReport([
    { id: "demo.routing.basic", pass: true },
    { id: "demo.routing.complex", pass: true },
  ]);

  // 1 — valid baseline written through the public path, then gated.
  writeFileSync(baselinePath, JSON.stringify(toBaseline(report), null, 2) + "\n");
  const valid = runCliGate({ report, baselinePath, writeBaseline: false });
  observed.push({ name: expectations[0].name, exit: valid.exitCode, matched: expectations[0].expectedExit === valid.exitCode && expectations[0].expectedLine(valid.output.join("\n")), output: valid.output });

  // 2 — missing baseline.
  const missingPath = join(dir, "does-not-exist.json");
  const missing = runCliGate({ report, baselinePath: missingPath, writeBaseline: false });
  observed.push({ name: expectations[1].name, exit: missing.exitCode, matched: expectations[1].expectedExit === missing.exitCode && expectations[1].expectedLine(missing.output.join("\n")) && !existsSync(missingPath), output: missing.output });

  // 3 — malformed baseline: array outcomes, null entries and a total that
  // does not match the entry count are all rejected by validateBaseline.
  const malformed: Record<string, unknown> = JSON.parse(JSON.stringify(toBaseline(report)));
  malformed.outcomes = { "demo.routing.basic": null, "demo.routing.complex": true };
  malformed.total = 9;
  writeFileSync(baselinePath, JSON.stringify(malformed));
  const bad = runCliGate({ report, baselinePath, writeBaseline: false });
  const schemaVerdict = validateBaseline(malformed);
  observed.push({ name: expectations[2].name, exit: bad.exitCode, matched: bad.exitCode === 1 && !schemaVerdict.ok && expectations[2].expectedLine(bad.output.join("\n")), output: bad.output });

  // 4 — drift: the live report regresses one case.
  writeFileSync(baselinePath, JSON.stringify(toBaseline(report), null, 2) + "\n");
  const regressed = fakeReport([
    { id: "demo.routing.basic", pass: false },
    { id: "demo.routing.complex", pass: true },
  ]);
  const drift = runCliGate({ report: regressed, baselinePath, writeBaseline: false });
  observed.push({ name: expectations[3].name, exit: drift.exitCode, matched: drift.exitCode === 1 && expectations[3].expectedLine(drift.output.join("\n")), output: drift.output });
} finally {
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
}

// ── Report ───────────────────────────────────────────────────────────
console.log("Jarvis regression gate — isolated demo");
console.log("fixture:", dir === null ? "(cleaned)" : "temp dir removed after run");
console.log("real baseline.json touched:", realBaselineBefore === null ? "absent" : "untouched");
console.log("");

for (const o of observed) {
  console.log(`[${o.matched ? "OK" : "MISMATCH"}] ${o.name} — exit ${o.exit}`);
  for (const line of o.output) console.log(`    ${line}`);
  console.log("");
}

// The demo must never have mutated the real baseline.
const realBaselineAfter = existsSync(realBaselinePath) ? readFileSync(realBaselinePath, "utf8") : null;
const realBaselineUntouched = realBaselineAfter === realBaselineBefore;
const allObserved = observed.length === 4 && observed.every((o) => o.matched);

if (!realBaselineUntouched) {
  console.error("FAIL: the real baseline.json changed during the demo.");
  process.exit(2);
}
if (!allObserved) {
  console.error("FAIL: not every expected behaviour was observed.");
  process.exit(1);
}

console.log("All four expected behaviours observed; the gate is fail-closed and reproducible.");
process.exit(0);
