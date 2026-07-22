import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runNightlySemanticEval } from "./nightly-semantic-eval";
import type { SemanticReport } from "./semantic-harness";

function report(score: number): SemanticReport {
  return {
    total: 1,
    averageScore: score,
    results: [{ id: "case-a", score, covered: [], missed: [], answer: "answer" }],
  };
}

describe("nightly semantic evaluation runner", () => {
  test("records a passing run and its latest pointer", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-nightly-eval-"));
    try {
      const baselinePath = join(root, "semantic-baseline.json");
      writeFileSync(baselinePath, JSON.stringify({ version: 1, averageScore: 0.9, scores: { "case-a": 0.9 } }));
      const result = await runNightlySemanticEval({
        now: new Date("2026-07-22T03:00:00.000Z"),
        output_dir: root,
        baseline_path: baselinePath,
        run_eval: async () => report(0.9),
      });

      expect(result.status).toBe("passed");
      expect(result.alert_path).toBeUndefined();
      expect(JSON.parse(readFileSync(result.artifact_path, "utf-8")).status).toBe("passed");
      expect(JSON.parse(readFileSync(result.latest_path, "utf-8")).run_id).toBe(result.run_id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("records a regression and emits a durable alert", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-nightly-eval-"));
    try {
      const baselinePath = join(root, "semantic-baseline.json");
      writeFileSync(baselinePath, JSON.stringify({ version: 1, averageScore: 0.9, scores: { "case-a": 0.9 } }));
      const result = await runNightlySemanticEval({
        now: new Date("2026-07-22T03:01:00.000Z"),
        output_dir: root,
        baseline_path: baselinePath,
        run_eval: async () => report(0.5),
      });

      expect(result.status).toBe("regressed");
      expect(result.alert_path).toBeDefined();
      expect(result.regressions[0]).toContain("case-a");
      expect(JSON.parse(readFileSync(result.alert_path!, "utf-8")).status).toBe("regressed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("records a baseline-missing alert instead of treating an unbaselined run as green", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-nightly-eval-"));
    try {
      const result = await runNightlySemanticEval({
        now: new Date("2026-07-22T03:02:00.000Z"),
        output_dir: root,
        baseline_path: join(root, "missing-baseline.json"),
        run_eval: async () => report(0.9),
      });

      expect(result.status).toBe("baseline_missing");
      expect(result.alert_path).toBeDefined();
      expect(result.regressions[0]).toContain("baseline missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
