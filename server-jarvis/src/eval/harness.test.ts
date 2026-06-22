import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { runEval, diffBaseline, type Baseline } from "./harness";

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
