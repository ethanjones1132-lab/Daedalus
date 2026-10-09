import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runEval, diffBaseline, runCliGate, toBaseline, type Baseline, type EvalReport } from "./harness";

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
