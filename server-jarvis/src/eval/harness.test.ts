import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runEval, diffBaseline, runCliGate, toBaseline, validateBaseline, type Baseline, type EvalReport } from "./harness";

describe("Orchestration eval / regression harness", () => {
  test("every eval case passes", async () => {
    const report = await runEval();
    const failures = report.results
      .filter((r) => !r.pass)
      .map((r) => `${r.id}: ${r.detail}`);
    expect(failures).toEqual([]);
    expect(report.failed).toBe(0);
    expect(report.total).toBeGreaterThan(0);
  });

  test("no regression against captured baseline", async () => {
    const report = await runEval();
    const baseline = JSON.parse(
      readFileSync(join(import.meta.dir, "baseline.json"), "utf-8"),
    ) as Baseline;
    // Empty diff => routing/gating behavior matches the recorded baseline.
    // To intentionally accept new behavior: bun run src/eval/harness.ts --write-baseline
    expect(diffBaseline(report, baseline)).toEqual([]);
  });
});

// Build a synthetic report so pass/fail and drift can be exercised without
// depending on the real case set flipping.
function fakeReport(outcomes: Array<{ id: string; pass: boolean }>): EvalReport {
  const results = outcomes.map((o) => ({
    id: o.id,
    kind: "test",
    pass: o.pass,
    detail: o.pass ? "ok" : "synthetic failure",
  }));
  const passed = results.filter((r) => r.pass).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}

async function withTempBaseline(
  fn: (baselinePath: string, dir: string) => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-eval-cli-"));
  try {
    await fn(join(dir, "baseline.json"), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("regression CLI gate (fail-closed)", () => {
  test("missing baseline => nonzero exit and does NOT create it", async () => {
    await withTempBaseline((baselinePath) => {
      const report = fakeReport([{ id: "a", pass: true }]);
      const { exitCode, output } = runCliGate({ report, baselinePath, writeBaseline: false });
      expect(exitCode).toBe(1);
      expect(output.join("\n")).toContain("Baseline unreadable");
      // The gate must not silently create/refresh the snapshot.
      expect(existsSync(baselinePath)).toBe(false);
    });
  });

  test("malformed baseline (invalid JSON) => nonzero exit", async () => {
    await withTempBaseline((baselinePath) => {
      writeFileSync(baselinePath, "{ not: valid json ]");
      const report = fakeReport([{ id: "a", pass: true }]);
      const { exitCode, output } = runCliGate({ report, baselinePath, writeBaseline: false });
      expect(exitCode).toBe(1);
      expect(output.join("\n")).toContain("Baseline unreadable");
    });
  });

  test("structurally wrong baseline (valid JSON, bad shape) => nonzero exit", async () => {
    await withTempBaseline((baselinePath) => {
      writeFileSync(baselinePath, JSON.stringify({ hello: "world" }));
      const report = fakeReport([{ id: "a", pass: true }]);
      const { exitCode } = runCliGate({ report, baselinePath, writeBaseline: false });
      expect(exitCode).toBe(1);
    });
  });

  test("valid matching baseline + all passing => zero exit", async () => {
    await withTempBaseline((baselinePath) => {
      const report = fakeReport([{ id: "a", pass: true }, { id: "b", pass: true }]);
      writeFileSync(baselinePath, JSON.stringify(toBaseline(report), null, 2) + "\n");
      const { exitCode } = runCliGate({ report, baselinePath, writeBaseline: false });
      expect(exitCode).toBe(0);
    });
  });

  test("valid baseline but drift => nonzero exit", async () => {
    await withTempBaseline((baselinePath) => {
      const baselineReport = fakeReport([{ id: "a", pass: true }]);
      writeFileSync(baselinePath, JSON.stringify(toBaseline(baselineReport), null, 2) + "\n");
      const liveReport = fakeReport([{ id: "a", pass: false }]);
      const { exitCode, output } = runCliGate({ report: liveReport, baselinePath, writeBaseline: false });
      expect(exitCode).toBe(1);
      expect(output.join("\n")).toContain("Baseline drift detected");
    });
  });

  test("report failures with a valid baseline => nonzero exit", async () => {
    await withTempBaseline((baselinePath) => {
      const report = fakeReport([{ id: "a", pass: true }, { id: "b", pass: false }]);
      writeFileSync(baselinePath, JSON.stringify(toBaseline(report), null, 2) + "\n");
      const { exitCode } = runCliGate({ report, baselinePath, writeBaseline: false });
      expect(exitCode).toBe(1);
    });
  });

  test("--write-baseline explicitly writes a baseline and exits 0", async () => {
    await withTempBaseline((baselinePath) => {
      const report = fakeReport([{ id: "a", pass: true }]);
      expect(existsSync(baselinePath)).toBe(false);
      const { exitCode, output } = runCliGate({ report, baselinePath, writeBaseline: true });
      expect(exitCode).toBe(0);
      expect(output.join("\n")).toContain("Wrote baseline");
      expect(existsSync(baselinePath)).toBe(true);
      const written = JSON.parse(readFileSync(baselinePath, "utf-8")) as Baseline;
      expect(written.outcomes).toEqual({ a: "pass" });
    });
  });

  test("real runEval passes cleanly against its own written baseline", async () => {
    await withTempBaseline(async (baselinePath) => {
      const report = await runEval();
      const written = runCliGate({ report, baselinePath, writeBaseline: true });
      expect(written.exitCode).toBe(0);
      const gated = runCliGate({ report, baselinePath, writeBaseline: false });
      expect(gated.exitCode).toBe(0);
    });
  });
});

// ── Baseline schema validation (fail-closed, tightened) ─────────────
// A baseline is only trustworthy when total is a non-negative integer,
// outcomes is a plain object of pass/fail strings, and total matches the entry count.
describe("baseline schema validation", () => {
  const goodReport = fakeReport([{ id: "a", pass: true }, { id: "b", pass: false }]);
  const goodBaseline = () => JSON.parse(JSON.stringify(toBaseline(goodReport)));

  test("validateBaseline accepts a well-formed baseline", () => {
    const verdict = validateBaseline(goodBaseline());
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.baseline.total).toBe(2);
  });

  test("outcomes as an ARRAY is rejected (typeof [] === 'object' must not pass)", async () => {
    await withTempBaseline((baselinePath) => {
      const bad = goodBaseline();
      bad.outcomes = [true, false];
      writeFileSync(baselinePath, JSON.stringify(bad));
      const { exitCode, output } = runCliGate({ report: goodReport, baselinePath, writeBaseline: false });
      expect(exitCode).toBe(1);
      expect(output.join("\n")).toContain("Baseline unreadable");
      expect(output.join("\n")).toContain("outcomes");
    });
  });

  test("outcomes with null / invalid entries is rejected", async () => {
    await withTempBaseline((baselinePath) => {
      const bad = goodBaseline();
      bad.outcomes = { a: null, b: 1 };
      writeFileSync(baselinePath, JSON.stringify(bad));
      const { exitCode, output } = runCliGate({ report: goodReport, baselinePath, writeBaseline: false });
      expect(exitCode).toBe(1);
      expect(output.join("\n")).toContain("Baseline unreadable");
    });
  });

  test("total not matching entry count is rejected", async () => {
    await withTempBaseline((baselinePath) => {
      const bad = goodBaseline();
      bad.total = 7;
      writeFileSync(baselinePath, JSON.stringify(bad));
      const { exitCode, output } = runCliGate({ report: goodReport, baselinePath, writeBaseline: false });
      expect(exitCode).toBe(1);
      expect(output.join("\n")).toContain("does not match");
    });
  });

  test("negative total is rejected", async () => {
    await withTempBaseline((baselinePath) => {
      const bad = goodBaseline();
      bad.total = -1;
      writeFileSync(baselinePath, JSON.stringify(bad));
      const { exitCode, output } = runCliGate({ report: goodReport, baselinePath, writeBaseline: false });
      expect(exitCode).toBe(1);
      expect(output.join("\n")).toContain("non-negative integer");
    });
  });

  test("fractional total is rejected", async () => {
    await withTempBaseline((baselinePath) => {
      const bad = goodBaseline();
      bad.total = 2.5;
      writeFileSync(baselinePath, JSON.stringify(bad));
      const { exitCode, output } = runCliGate({ report: goodReport, baselinePath, writeBaseline: false });
      expect(exitCode).toBe(1);
      expect(output.join("\n")).toContain("non-negative integer");
    });
  });

  // Matching existing string snapshots remain valid without a migration.
  test("existing string outcomes validate and are honoured verbatim", async () => {
    await withTempBaseline((baselinePath) => {
      const legacy = {
        version: 1,
        total: 1,
        passed: 1,
        outcomes: { a: "pass" },
      };
      writeFileSync(baselinePath, JSON.stringify(legacy));
      expect(validateBaseline(legacy).ok).toBe(true);
      const cleanReport = fakeReport([{ id: "a", pass: true }]);
      const { exitCode, output } = runCliGate({ report: cleanReport, baselinePath, writeBaseline: false });
      expect(exitCode).toBe(0);
      expect(output.join("\n")).not.toContain("Baseline drift");
    });
  });

  test("semantic mismatch against a existing string baseline still fails", async () => {
    await withTempBaseline((baselinePath) => {
      const legacy = { version: 1, total: 1, passed: 1, outcomes: { a: "pass" } };
      writeFileSync(baselinePath, JSON.stringify(legacy));
      const regressed = fakeReport([{ id: "a", pass: false }]);
      const { exitCode, output } = runCliGate({ report: regressed, baselinePath, writeBaseline: false });
      expect(exitCode).toBe(1);
      expect(output.join("\n")).toContain("Baseline drift detected");
    });
  });

  test("the repo's own baseline.json passes validation", () => {
    const onDisk = JSON.parse(
      readFileSync(join(import.meta.dir, "baseline.json"), "utf-8"),
    ) as unknown;
    const verdict = validateBaseline(onDisk);
    expect(verdict.ok).toBe(true);
  });
});

// Preserve the existing on-disk contract; alternate representations are malformed.
test("boolean outcome values cannot silently extend the baseline schema", () => {
  expect(validateBaseline({ version: 1, total: 1, passed: 1, outcomes: { a: true } }).ok).toBe(false);
});

test("baseline metadata is complete and consistent", () => {
  const good = { version: 1, total: 2, passed: 1, outcomes: { a: "pass", b: "fail" } };
  for (const patch of [{version: undefined}, {version: 999}, {passed: undefined}, {passed: -1}, {passed: 0.5}, {passed: 3}, {passed: 2}]) {
    expect(validateBaseline({ ...good, ...patch }).ok).toBe(false);
  }
});
