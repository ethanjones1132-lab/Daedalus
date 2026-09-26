import { describe, expect, test } from "bun:test";
import {
  MAX_REPORTED_CASE_IDS,
  ReplayEvidenceError,
  decodeReplayCoverageContract,
  decodeReplayEvidence,
  verifyReplayCoverage,
  type ReplayCoverageContract,
  type ReplayEvidenceErrorCode,
} from "./replay-evidence";

function expectCode(run: () => unknown, code: ReplayEvidenceErrorCode): ReplayEvidenceError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ReplayEvidenceError);
  const failure = thrown as ReplayEvidenceError;
  expect(failure.code).toBe(code);
  return failure;
}

function row(caseId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { case_id: caseId, passed: true, baseline_score: 0.8, candidate_score: 0.8, ...overrides };
}

function envelope(expected: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    eval_suite: "semantic-live",
    generated_at: "2026-09-25T00:00:00.000Z",
    expected_cases: expected,
    ...overrides,
  };
}

function contract(expected: string[]): ReplayCoverageContract {
  return decodeReplayCoverageContract(envelope(expected));
}

describe("replay evidence row decoding", () => {
  test("decodes a complete unique set of rows and never touches its input", () => {
    const input = [row("case-a"), row("case-b", { passed: false, candidate_score: 0.6 })];
    const snapshot = structuredClone(input);

    expect(decodeReplayEvidence(input)).toEqual(input);
    expect(input).toEqual(snapshot);
  });

  test("rejects a root that is not an array", () => {
    for (const root of [null, undefined, {}, "[]", 3, { rows: [] }]) {
      expectCode(() => decodeReplayEvidence(root), "root_not_array");
    }
  });

  test("rejects a row that is not an object", () => {
    for (const entry of [null, "case-a", 3, ["case-a"]]) {
      expectCode(() => decodeReplayEvidence([entry]), "row_not_object");
    }
  });

  test("rejects a blank case id", () => {
    for (const caseId of ["", "   ", "\n"]) {
      const failure = expectCode(() => decodeReplayEvidence([row(caseId)]), "blank_case_id");
      expect(failure.entryIndex).toBe(0);
      expect(failure.message).toBe("blank_case_id:entry_0");
    }
  });

  test("rejects a duplicated case id at the second occurrence", () => {
    const failure = expectCode(
      () => decodeReplayEvidence([row("case-a"), row("case-b"), row("case-a")]),
      "duplicate_case_id",
    );
    expect(failure.entryIndex).toBe(2);
    expect(failure.caseId).toBe("case-a");
  });

  test("rejects a non-boolean pass flag", () => {
    for (const passed of ["true", 1, 0, null, undefined]) {
      expectCode(() => decodeReplayEvidence([row("case-a", { passed })]), "invalid_passed");
    }
  });

  test("reports an absent baseline score as missing evidence, never as a scorable row", () => {
    for (const baseline of [undefined, null]) {
      const failure = expectCode(
        () => decodeReplayEvidence([row("case-a", { baseline_score: baseline })]),
        "missing_baseline_score",
      );
      expect(failure.caseId).toBe("case-a");
    }
    const absent = row("case-a");
    delete absent.baseline_score;
    expectCode(() => decodeReplayEvidence([absent]), "missing_baseline_score");
  });

  test("reports an absent candidate score as missing evidence", () => {
    for (const candidate of [undefined, null]) {
      const failure = expectCode(
        () => decodeReplayEvidence([row("case-a", { candidate_score: candidate })]),
        "missing_candidate_score",
      );
      expect(failure.caseId).toBe("case-a");
    }
  });

  test("rejects a score that is not a finite number", () => {
    for (const score of ["0.8", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, true, {}]) {
      expectCode(() => decodeReplayEvidence([row("case-a", { candidate_score: score })]), "invalid_score");
    }
  });

  test("rejects a score outside [0, 1] but accepts both endpoints", () => {
    for (const score of [-0.001, -1, 1.001, 2]) {
      expectCode(() => decodeReplayEvidence([row("case-a", { baseline_score: score })]), "score_out_of_range");
    }
    expect(
      decodeReplayEvidence([row("case-a", { baseline_score: 0, candidate_score: 1 })]),
    ).toEqual([{ case_id: "case-a", passed: true, baseline_score: 0, candidate_score: 1 }]);
  });

  test("rejects an unknown field so no second evidence channel can ride along", () => {
    const failure = expectCode(() => decodeReplayEvidence([row("case-a", { missed: ["rubric"] })]), "unknown_field");
    expect(failure.entryIndex).toBe(0);
  });
});

describe("replay coverage contract decoding", () => {
  test("decodes the versioned envelope and keeps its declared case order", () => {
    expect(contract(["case-c", "case-a"])).toEqual({
      schemaVersion: 1,
      evalSuite: "semantic-live",
      generatedAt: "2026-09-25T00:00:00.000Z",
      expectedCaseIds: ["case-c", "case-a"],
    });
  });

  test("rejects a root that is not an object", () => {
    for (const root of [null, undefined, [], "expected_cases", 3]) {
      expectCode(() => decodeReplayCoverageContract(root), "root_not_object");
    }
  });

  test("rejects a bare case map: a coverage contract must name its schema and suite", () => {
    expectCode(() => decodeReplayCoverageContract({ "case-a": true }), "missing_schema");
    expectCode(() => decodeReplayCoverageContract(envelope(["case-a"], { schema_version: undefined })), "missing_schema");
  });

  test("rejects an unknown schema version", () => {
    for (const schema of [2, 0, "1", null]) {
      expectCode(() => decodeReplayCoverageContract(envelope(["case-a"], { schema_version: schema })), "unknown_schema");
    }
  });

  test("rejects a missing or blank suite name", () => {
    for (const suite of [undefined, "", "   ", 3]) {
      expectCode(() => decodeReplayCoverageContract(envelope(["case-a"], { eval_suite: suite })), "missing_metadata");
    }
  });

  test("treats an absent generated_at as unknown but an unparsable one as invalid", () => {
    expect(contract(["case-a"]).generatedAt).toBe("2026-09-25T00:00:00.000Z");
    expect(decodeReplayCoverageContract(envelope(["case-a"], { generated_at: undefined })).generatedAt).toBeNull();
    expectCode(() => decodeReplayCoverageContract(envelope(["case-a"], { generated_at: "yesterday" })), "invalid_timestamp");
  });

  test("rejects a missing, non-array, empty, or malformed expected case list", () => {
    expectCode(() => decodeReplayCoverageContract(envelope(undefined)), "missing_payload");
    expectCode(() => decodeReplayCoverageContract(envelope({ "case-a": true })), "invalid_payload");
    expectCode(() => decodeReplayCoverageContract(envelope("case-a")), "invalid_payload");
    expectCode(() => decodeReplayCoverageContract(envelope([])), "empty_manifest");
    const blank = expectCode(() => decodeReplayCoverageContract(envelope(["case-a", "  "])), "empty_case_id");
    expect(blank.entryIndex).toBe(1);
  });

  test("rejects a duplicated expected case id, which would let one pass stand in for another", () => {
    const failure = expectCode(
      () => decodeReplayCoverageContract(envelope(["case-a", "case-b", "case-a"])),
      "duplicate_case_id",
    );
    expect(failure.entryIndex).toBe(2);
  });

  test("rejects an unknown top-level field", () => {
    expectCode(() => decodeReplayCoverageContract(envelope(["case-a"], { results: {} })), "unexpected_field");
  });
});

describe("replay coverage", () => {
  const expected = contract(["case-a", "case-b", "case-c"]);

  test("reports complete coverage when every expected case has exactly one row", () => {
    const decoded = decodeReplayEvidence([row("case-a"), row("case-b"), row("case-c")]);
    expect(verifyReplayCoverage(decoded, expected)).toEqual({
      suite: "semantic-live",
      expectedCount: 3,
      providedCount: 3,
      matchedCount: 3,
      missingCount: 0,
      unexpectedCount: 0,
      missingCaseIds: [],
      unexpectedCaseIds: [],
      truncated: false,
      complete: true,
    });
  });

  test("reports a case the evidence dropped instead of shrinking the denominator", () => {
    const decoded = decodeReplayEvidence([row("case-a"), row("case-c")]);
    const coverage = verifyReplayCoverage(decoded, expected);
    expect(coverage.complete).toBe(false);
    expect(coverage.missingCaseIds).toEqual(["case-b"]);
    expect(coverage.missingCount).toBe(1);
    expect(coverage.providedCount).toBe(2);
    expect(coverage.matchedCount).toBe(2);
  });

  test("reports a case the manifest never listed", () => {
    const decoded = decodeReplayEvidence([row("case-a"), row("case-b"), row("case-c"), row("case-d")]);
    const coverage = verifyReplayCoverage(decoded, expected);
    expect(coverage.complete).toBe(false);
    expect(coverage.unexpectedCaseIds).toEqual(["case-d"]);
    expect(coverage.unexpectedCount).toBe(1);
  });

  test("orders reported ids deterministically regardless of row order", () => {
    const decoded = decodeReplayEvidence([row("case-z"), row("case-c")]);
    const coverage = verifyReplayCoverage(decoded, expected);
    expect(coverage.missingCaseIds).toEqual(["case-a", "case-b"]);
    expect(coverage.unexpectedCaseIds).toEqual(["case-z"]);
  });

  test("bounds the reported ids and says so", () => {
    const many = Array.from({ length: MAX_REPORTED_CASE_IDS + 5 }, (_, i) => `case-${String(i).padStart(2, "0")}`);
    const coverage = verifyReplayCoverage([], contract(many));
    expect(coverage.missingCount).toBe(MAX_REPORTED_CASE_IDS + 5);
    expect(coverage.missingCaseIds).toHaveLength(MAX_REPORTED_CASE_IDS);
    expect(coverage.truncated).toBe(true);
  });

  test("does not mutate the decoded rows it reads", () => {
    const decoded = decodeReplayEvidence([row("case-a"), row("case-b"), row("case-c")]);
    const snapshot = structuredClone(decoded);
    verifyReplayCoverage(decoded, expected);
    expect(decoded).toEqual(snapshot);
  });
});
