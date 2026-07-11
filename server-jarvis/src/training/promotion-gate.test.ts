import { describe, expect, test } from "bun:test";
import { evaluatePromotionGate, type PromotionCorpusRow } from "./promotion-gate";

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

describe("offline promotion gate", () => {
  test("rejects a corpus with missing provenance", () => {
    expect(evaluatePromotionGate({ corpus: [{ ...goodRow, session_id: "" }], replay: [] })).toMatchObject({
      decision: "reject",
      reason: "missing_provenance",
    });
  });

  test("rejects failing replay and regressions", () => {
    expect(
      evaluatePromotionGate({
        corpus: [goodRow],
        replay: [
          { case_id: "a", passed: false, baseline_score: 0.9, candidate_score: 0.6 },
          { case_id: "b", passed: true, baseline_score: 0.8, candidate_score: 0.8 },
        ],
      }),
    ).toMatchObject({ decision: "reject", reason: "replay_regression", regression_count: 1 });
  });

  test("approves only a provenance-complete corpus with passing replay", () => {
    expect(
      evaluatePromotionGate({
        corpus: [goodRow],
        replay: [
          { case_id: "a", passed: true, baseline_score: 0.8, candidate_score: 0.82 },
          { case_id: "b", passed: true, baseline_score: 0.7, candidate_score: 0.7 },
        ],
      }),
    ).toMatchObject({ decision: "approve", replay_pass_rate: 1, regression_count: 0 });
  });
});
