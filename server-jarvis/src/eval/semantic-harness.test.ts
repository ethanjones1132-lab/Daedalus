import { describe, expect, test } from "bun:test";
import { judgeAnswer } from "./judge";
import {
  toPromotionReplayResults,
  toSemanticCoverageContract,
  type SemanticReport,
} from "./semantic-harness";
import { SEMANTIC_CASES } from "./semantic-cases";
import { evaluatePromotionGate, type PromotionCorpusRow } from "../training/promotion-gate";

const goodRow: PromotionCorpusRow = {
  id: "snapshot-1",
  agent_run_id: "run-1",
  session_id: "session-1",
  task_type: "debug",
  user_request: "find the bug",
  pipeline: ["planner", "worker"],
  stage_runs: [{ was_successful: 1 }],
  model_attributions: [{ model: "model-a" }],
  run_outcome: "success",
};

function reportWith(scores: Record<string, number>): SemanticReport {
  const results = Object.entries(scores).map(([id, score]) => ({
    id,
    score,
    covered: [],
    missed: [],
    answer: "answer",
  }));
  const total = results.length;
  return {
    total,
    averageScore: results.reduce((sum, r) => sum + r.score, 0) / Math.max(1, total),
    results,
  };
}

const baselineFor = (scores: Record<string, number>) => ({
  version: 1,
  averageScore: 0.7,
  scores,
});

const manifest = (...ids: string[]) => toSemanticCoverageContract(ids.map((id) => ({ id })));

describe("semantic harness judge boundary", () => {
  test("does not turn a contradictory judge response into a passing replay", async () => {
    const verdict = await judgeAnswer(
      async () => ({
        content: JSON.stringify({ covered: ["rubric item", "rubric item"], missed: [] }),
      }),
      "request",
      "answer",
      ["rubric item"],
    );
    const report: SemanticReport = {
      total: 1,
      averageScore: verdict.score,
      results: [
        {
          id: "case-contradictory",
          score: verdict.score,
          covered: verdict.covered,
          missed: verdict.missed,
          answer: "answer",
        },
      ],
    };

    expect(verdict.valid).toBe(false);
    expect(toPromotionReplayResults(report)[0]?.passed).toBe(false);
  });
});

describe("semantic report to promotion replay evidence", () => {
  test("approves a report whose A and B sides cover the suite exactly once", () => {
    const decision = evaluatePromotionGate({
      corpus: [goodRow],
      replay: toPromotionReplayResults(reportWith({ a: 0.9, b: 0.8 }), baselineFor({ a: 0.8, b: 0.7 })),
      coverage_contract: manifest("a", "b"),
    });

    expect(decision).toMatchObject({ decision: "approve", reason: "quality_gate_passed", replay_pass_rate: 1 });
    expect(decision.replay_coverage).toMatchObject({ expectedCount: 2, providedCount: 2, complete: true });
    expect(decision.replay_evidence).toBeUndefined();
  });

  test("rejects a report case the pinned baseline never scored", () => {
    const decision = evaluatePromotionGate({
      corpus: [goodRow],
      replay: toPromotionReplayResults(reportWith({ a: 0.9, b: 0.8 }), baselineFor({ a: 0.8 })),
      coverage_contract: manifest("a", "b"),
    });

    expect(decision).toMatchObject({ decision: "reject", reason: "replay_missing_baseline" });
    expect(decision.replay_evidence?.case_id).toBe("b");
  });

  test("rejects a report with no pinned baseline at all", () => {
    const decision = evaluatePromotionGate({
      corpus: [goodRow],
      replay: toPromotionReplayResults(reportWith({ a: 0.9, b: 0.8 })),
      coverage_contract: manifest("a", "b"),
    });

    expect(decision).toMatchObject({ decision: "reject", reason: "replay_missing_baseline" });
  });

  test("rejects a report case the suite manifest never listed", () => {
    const decision = evaluatePromotionGate({
      corpus: [goodRow],
      replay: toPromotionReplayResults(reportWith({ a: 0.9, b: 0.8, c: 0.95 }), baselineFor({ a: 0.8, b: 0.7, c: 0.9 })),
      coverage_contract: manifest("a", "b"),
    });

    expect(decision).toMatchObject({ decision: "reject", reason: "replay_invalid" });
    expect(decision.replay_evidence?.code).toBe("coverage_incomplete");
    expect(decision.replay_evidence?.unexpected_case_ids).toEqual(["c"]);
  });

  test("rejects a report that ran the same case twice", () => {
    const report = reportWith({ a: 0.9, b: 0.8 });
    report.results.push({ ...report.results[0] });

    const decision = evaluatePromotionGate({
      corpus: [goodRow],
      replay: toPromotionReplayResults(report, baselineFor({ a: 0.8, b: 0.7 })),
      coverage_contract: manifest("a", "b"),
    });

    expect(decision).toMatchObject({ decision: "reject", reason: "replay_invalid" });
    expect(decision.replay_evidence?.code).toBe("duplicate_case_id");
  });

  test("rejects a report that dropped a case the pinned baseline still holds", () => {
    const decision = evaluatePromotionGate({
      corpus: [goodRow],
      replay: toPromotionReplayResults(reportWith({ a: 0.9 }), baselineFor({ a: 0.8, b: 0.7 })),
      coverage_contract: manifest("a", "b"),
    });

    expect(decision).toMatchObject({ decision: "reject", reason: "replay_invalid" });
    expect(decision.replay_evidence?.code).toBe("coverage_incomplete");
    expect(decision.replay_evidence?.missing_case_ids).toEqual(["b"]);
  });

  test("rejects a judge score that is not a measurable fraction", () => {
    for (const [score, code] of [
      [Number.NaN, "invalid_score"],
      [Number.POSITIVE_INFINITY, "invalid_score"],
      [1.4, "score_out_of_range"],
      [-0.2, "score_out_of_range"],
    ] as const) {
      const decision = evaluatePromotionGate({
        corpus: [goodRow],
        replay: toPromotionReplayResults(reportWith({ a: score }), baselineFor({ a: 0.8 })),
        coverage_contract: manifest("a"),
      });
      expect(decision).toMatchObject({ decision: "reject", reason: "replay_invalid" });
      expect(decision.replay_evidence?.code).toBe(code);
    }
  });

  test("derives the coverage contract from the suite's own case ids and nothing else", () => {
    const contract = toSemanticCoverageContract();

    expect(Object.keys(contract).sort()).toEqual(["eval_suite", "expected_cases", "generated_at", "schema_version"]);
    expect(contract.schema_version).toBe(1);
    expect(contract.expected_cases).toEqual(SEMANTIC_CASES.map((c) => c.id));
    expect(Number.isFinite(Date.parse(contract.generated_at as string))).toBe(true);
  });

  test("reads only the id off a suite case, so a run or trajectory id cannot become a case id", () => {
    const cases = [{ id: "case-a", agent_run_id: "run-1", session_id: "session-1" }];

    expect(toSemanticCoverageContract(cases).expected_cases).toEqual(["case-a"]);
  });
});
