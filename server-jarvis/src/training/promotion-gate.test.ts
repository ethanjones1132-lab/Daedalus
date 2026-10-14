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

const coverageContract = (expected: string[]) => ({
  schema_version: 1,
  eval_suite: "semantic-live",
  generated_at: "2026-09-25T00:00:00.000Z",
  expected_cases: expected,
});

const replayRow = (caseId: string, overrides: Record<string, unknown> = {}) => ({
  case_id: caseId,
  passed: true,
  baseline_score: 0.8,
  candidate_score: 0.8,
  ...overrides,
});

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
        coverage_contract: coverageContract(["a", "b"]),
      }),
    ).toMatchObject({ decision: "reject", reason: "replay_regression", regression_count: 1 });
  });

  test("approves only a provenance-complete corpus with passing replay", () => {
    const decision = evaluatePromotionGate({
      corpus: [goodRow],
      replay: [
        { case_id: "a", passed: true, baseline_score: 0.8, candidate_score: 0.82 },
        { case_id: "b", passed: true, baseline_score: 0.7, candidate_score: 0.7 },
      ],
      coverage_contract: coverageContract(["a", "b"]),
    });

    expect(decision).toMatchObject({ decision: "approve", replay_pass_rate: 1, regression_count: 0 });
    expect(decision).toMatchObject({
      reason: "quality_gate_passed",
      replay_coverage: {
        suite: "semantic-live",
        expectedCount: 2,
        providedCount: 2,
        matchedCount: 2,
        missingCount: 0,
        unexpectedCount: 0,
        missingCaseIds: [],
        unexpectedCaseIds: [],
        truncated: false,
        complete: true,
      },
    });
    expect(decision.replay_evidence).toBeUndefined();
  });
});

describe("offline promotion gate replay evidence", () => {
  test("rejects evidence with no expected-case manifest, because nothing then proves coverage", () => {
    const decision = evaluatePromotionGate({
      corpus: [goodRow],
      replay: [replayRow("a"), replayRow("b")],
    });

    expect(decision).toMatchObject({
      decision: "reject",
      reason: "replay_invalid",
      replay_pass_rate: 0,
      regression_count: 0,
    });
    expect(decision.replay_evidence?.code).toBe("contract_absent");
    expect(decision.replay_coverage).toBeUndefined();
  });

  test("rejects a malformed manifest with its own stable code", () => {
    const cases: [unknown, string][] = [
      [["a", "b"], "root_not_object"],
      [{}, "missing_schema"],
      [{ ...coverageContract(["a", "b"]), schema_version: 2 }, "unknown_schema"],
      [{ ...coverageContract(["a", "b"]), eval_suite: "  " }, "missing_metadata"],
      [{ ...coverageContract(["a", "b"]), generated_at: "someday" }, "invalid_timestamp"],
      [{ ...coverageContract(["a", "b"]), expected_cases: undefined }, "missing_payload"],
      [{ ...coverageContract(["a", "b"]), expected_cases: "a,b" }, "invalid_payload"],
      [{ ...coverageContract(["a", "b"]), expected_cases: [] }, "empty_manifest"],
      [{ ...coverageContract(["a", "b"]), expected_cases: ["a", "a"] }, "duplicate_case_id"],
      [{ ...coverageContract(["a", "b"]), expected_cases: ["a", " "] }, "empty_case_id"],
      [{ ...coverageContract(["a", "b"]), scores: {} }, "unexpected_field"],
    ];

    for (const [contract, code] of cases) {
      const decision = evaluatePromotionGate({
        corpus: [goodRow],
        replay: [replayRow("a"), replayRow("b")],
        coverage_contract: contract,
      });
      expect(decision).toMatchObject({ decision: "reject", reason: "replay_invalid" });
      expect(decision.replay_evidence?.code).toBe(code);
      expect(decision.replay_pass_rate).toBe(0);
    }
  });

  test("rejects a case the evidence dropped instead of shrinking the pass-rate denominator", () => {
    const decision = evaluatePromotionGate({
      corpus: [goodRow],
      replay: [replayRow("a")],
      coverage_contract: coverageContract(["a", "b"]),
    });

    expect(decision).toMatchObject({ decision: "reject", reason: "replay_invalid", replay_pass_rate: 0 });
    expect(decision.replay_evidence?.code).toBe("coverage_incomplete");
    expect(decision.replay_evidence?.expected_count).toBe(2);
    expect(decision.replay_evidence?.provided_count).toBe(1);
    expect(decision.replay_evidence?.missing_case_ids).toEqual(["b"]);
    expect(decision.replay_evidence?.unexpected_case_ids).toEqual([]);
  });

  test("rejects a case the manifest never listed", () => {
    const decision = evaluatePromotionGate({
      corpus: [goodRow],
      replay: [replayRow("a"), replayRow("b"), replayRow("c")],
      coverage_contract: coverageContract(["a", "b"]),
    });

    expect(decision).toMatchObject({ decision: "reject", reason: "replay_invalid" });
    expect(decision.replay_evidence?.code).toBe("coverage_incomplete");
    expect(decision.replay_evidence?.unexpected_case_ids).toEqual(["c"]);
  });

  test("rejects a duplicated easy pass that would otherwise reach a 100% pass rate", () => {
    const decision = evaluatePromotionGate({
      corpus: [goodRow],
      replay: [replayRow("b"), replayRow("b"), replayRow("b")],
      coverage_contract: coverageContract(["a", "b"]),
    });

    expect(decision).toMatchObject({ decision: "reject", reason: "replay_invalid", replay_pass_rate: 0 });
    expect(decision.replay_evidence?.code).toBe("duplicate_case_id");
    expect(decision.replay_evidence?.case_id).toBe("b");
  });

  test("rejects a row whose baseline score is absent with the missing-baseline reason", () => {
    for (const baseline of [undefined, null]) {
      const decision = evaluatePromotionGate({
        corpus: [goodRow],
        replay: [replayRow("a"), replayRow("b", { baseline_score: baseline })],
        coverage_contract: coverageContract(["a", "b"]),
      });

      expect(decision).toMatchObject({
        decision: "reject",
        reason: "replay_missing_baseline",
        replay_pass_rate: 0,
        regression_count: 0,
      });
      expect(decision.replay_evidence?.code).toBe("missing_baseline_score");
      expect(decision.replay_evidence?.case_id).toBe("b");
    }
  });

  test("rejects a malformed or out-of-range score before it can move the regression count", () => {
    const cases: [unknown, string][] = [
      ["0.8", "invalid_score"],
      [Number.NaN, "invalid_score"],
      [Number.POSITIVE_INFINITY, "invalid_score"],
      [1.5, "score_out_of_range"],
      [-0.5, "score_out_of_range"],
      [undefined, "missing_candidate_score"],
      [null, "missing_candidate_score"],
    ];

    for (const [score, code] of cases) {
      const decision = evaluatePromotionGate({
        corpus: [goodRow],
        replay: [replayRow("a", { candidate_score: score })],
        coverage_contract: coverageContract(["a"]),
      });
      expect(decision).toMatchObject({ decision: "reject", reason: "replay_invalid", regression_count: 0 });
      expect(decision.replay_evidence?.code).toBe(code);
    }
  });

  test("rejects a non-boolean pass flag, a blank case id, and a replay root that is not a list", () => {
    const badFlag = evaluatePromotionGate({
      corpus: [goodRow],
      replay: [replayRow("a", { passed: "yes" })],
      coverage_contract: coverageContract(["a"]),
    });
    expect(badFlag).toMatchObject({ decision: "reject", reason: "replay_invalid" });
    expect(badFlag.replay_evidence?.code).toBe("invalid_passed");

    const blankId = evaluatePromotionGate({
      corpus: [goodRow],
      replay: [replayRow("  ")],
      coverage_contract: coverageContract(["a"]),
    });
    expect(blankId).toMatchObject({ decision: "reject", reason: "replay_invalid" });
    expect(blankId.replay_evidence?.code).toBe("blank_case_id");

    for (const root of [{ rows: [] }, "a,b", 7]) {
      const decision = evaluatePromotionGate({
        corpus: [goodRow],
        replay: root,
        coverage_contract: coverageContract(["a"]),
      });
      expect(decision).toMatchObject({ decision: "reject", reason: "replay_invalid" });
      expect(decision.replay_evidence?.code).toBe("root_not_array");
    }
  });

  test("rejects a malformed row rather than skipping it", () => {
    for (const entry of [null, "case-a", 3, ["case-a"]]) {
      const decision = evaluatePromotionGate({
        corpus: [goodRow],
        replay: [entry],
        coverage_contract: coverageContract(["a"]),
      });
      expect(decision).toMatchObject({ decision: "reject", reason: "replay_invalid" });
      expect(decision.replay_evidence?.code).toBe("row_not_object");
    }

    const unknownField = evaluatePromotionGate({
      corpus: [goodRow],
      replay: [replayRow("a", { judge_notes: "looked fine" })],
      coverage_contract: coverageContract(["a"]),
    });
    expect(unknownField).toMatchObject({ decision: "reject", reason: "replay_invalid" });
    expect(unknownField.replay_evidence?.code).toBe("unknown_field");
  });

  test("scores the pass rate over exactly the expected case set", () => {
    const decision = evaluatePromotionGate({
      corpus: [goodRow],
      replay: [
        replayRow("a"),
        replayRow("b"),
        replayRow("c"),
        replayRow("d", { passed: false, baseline_score: 0.4, candidate_score: 0.4 }),
      ],
      coverage_contract: coverageContract(["a", "b", "c", "d"]),
    });

    expect(decision).toMatchObject({
      decision: "reject",
      reason: "replay_failed",
      replay_pass_rate: 0.75,
      regression_count: 0,
    });
    expect(decision.replay_coverage?.complete).toBe(true);
  });

  test("does not let a corpus row stand in for a replay case", () => {
    const decision = evaluatePromotionGate({
      corpus: [{ ...goodRow, id: "a", agent_run_id: "run-a" }],
      replay: [replayRow("b")],
      coverage_contract: coverageContract(["a", "b"]),
    });

    expect(decision).toMatchObject({ decision: "reject", reason: "replay_invalid" });
    expect(decision.replay_evidence?.missing_case_ids).toEqual(["a"]);
  });

  test("keeps the corpus-provenance check ahead of the evidence checks", () => {
    const decision = evaluatePromotionGate({
      corpus: [{ ...goodRow, session_id: "" }],
      replay: [replayRow("a", { passed: "yes" })],
    });

    expect(decision).toMatchObject({ decision: "reject", reason: "missing_provenance" });
    expect(decision.replay_evidence).toBeUndefined();
  });

  test("keeps replay_missing for an evidence set with no rows at all", () => {
    expect(evaluatePromotionGate({ corpus: [goodRow], replay: [] })).toMatchObject({
      decision: "reject",
      provenance_ok: true,
      reason: "replay_missing",
    });
  });

  test("still rejects a regression inside a complete, unique, in-range evidence set", () => {
    const decision = evaluatePromotionGate({
      corpus: [goodRow],
      replay: [
        replayRow("a", { baseline_score: 0.9, candidate_score: 0.6 }),
        replayRow("b", { baseline_score: 0.8, candidate_score: 0.82 }),
      ],
      coverage_contract: coverageContract(["a", "b"]),
    });

    expect(decision).toMatchObject({ decision: "reject", reason: "replay_regression", regression_count: 1 });
    expect(decision.replay_evidence).toBeUndefined();
    expect(decision.replay_coverage?.complete).toBe(true);
  });

  test("keeps the regression tolerance and the regression limit honoured", () => {
    const withinTolerance = evaluatePromotionGate({
      corpus: [goodRow],
      replay: [replayRow("a", { baseline_score: 0.8, candidate_score: 0.76 })],
      coverage_contract: coverageContract(["a"]),
    });
    expect(withinTolerance).toMatchObject({ decision: "approve", regression_count: 0 });

    const overLimit = evaluatePromotionGate({
      corpus: [goodRow],
      replay: [
        replayRow("a", { baseline_score: 0.9, candidate_score: 0.5 }),
        replayRow("b", { baseline_score: 0.9, candidate_score: 0.5 }),
      ],
      coverage_contract: coverageContract(["a", "b"]),
      max_regression_count: 1,
    });
    expect(overLimit).toMatchObject({ decision: "reject", reason: "replay_regression", regression_count: 2 });
  });
});
