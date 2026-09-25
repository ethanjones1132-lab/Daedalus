import { describe, expect, test } from "bun:test";
import {
  CorpusSidecarError,
  decodeEvalSidecar,
  decodeReplanSidecar,
  summarizeSidecarCoverage,
} from "./corpus-sidecars";

function expectSidecarError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CorpusSidecarError);
    expect((error as CorpusSidecarError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("corpus sidecar decoders", () => {
  test("decodes a versioned eval envelope", () => {
    const decoded = decodeEvalSidecar({
      schema_version: 1,
      evaluator: "semantic-harness",
      eval_suite: "baseline-v1",
      generated_at: "2026-09-25T12:00:00.000Z",
      results: {
        "run-pass": true,
        "run-fail": false,
      },
    });

    expect(decoded.format).toBe("versioned");
    expect(decoded.metadata).toEqual({
      schemaVersion: 1,
      evaluator: "semantic-harness",
      evalSuite: "baseline-v1",
      generatedAt: "2026-09-25T12:00:00.000Z",
    });
    expect([...decoded.values]).toEqual([
      ["run-pass", true],
      ["run-fail", false],
    ]);
    expect(decoded.providedRunIds).toEqual(["run-fail", "run-pass"]);
  });

  test("decodes a versioned replan envelope", () => {
    const decoded = decodeReplanSidecar({
      schema_version: 1,
      evaluator: "conductor-learning",
      eval_suite: "replan-v1",
      generated_at: "2026-09-25T12:00:00.000Z",
      counts: {
        "run-a": 0,
        "run-b": 3,
      },
    });

    expect(decoded.format).toBe("versioned");
    expect(decoded.metadata?.schemaVersion).toBe(1);
    expect([...decoded.values]).toEqual([
      ["run-a", 0],
      ["run-b", 3],
    ]);
    expect(decoded.providedRunIds).toEqual(["run-a", "run-b"]);
  });

  test("identifies a strict legacy bare map", () => {
    const evalSidecar = decodeEvalSidecar({ "run-a": true });
    const replanSidecar = decodeReplanSidecar({ "run-a": 2 });

    expect(evalSidecar.format).toBe("legacy");
    expect(evalSidecar.metadata).toBeNull();
    expect([...evalSidecar.values]).toEqual([["run-a", true]]);
    expect(replanSidecar.format).toBe("legacy");
    expect(replanSidecar.metadata).toBeNull();
    expect([...replanSidecar.values]).toEqual([["run-a", 2]]);
  });

  test.each([
    ["eval", () => decodeEvalSidecar(null), "root_not_object"],
    ["eval array", () => decodeEvalSidecar([]), "root_not_object"],
    ["replan array", () => decodeReplanSidecar([]), "root_not_object"],
    ["unknown schema", () => decodeEvalSidecar({ schema_version: 2, results: {} }), "unknown_schema"],
    ["missing evaluator", () => decodeEvalSidecar({ schema_version: 1, eval_suite: "v1", generated_at: "2026-09-25T12:00:00.000Z", results: {} }), "missing_metadata"],
    ["missing eval suite", () => decodeReplanSidecar({ schema_version: 1, evaluator: "e", generated_at: "2026-09-25T12:00:00.000Z", counts: {} }), "missing_metadata"],
    ["invalid timestamp", () => decodeEvalSidecar({ schema_version: 1, evaluator: "e", eval_suite: "v", generated_at: "not-a-date", results: {} }), "invalid_timestamp"],
    ["unknown envelope field", () => decodeEvalSidecar({ schema_version: 1, evaluator: "e", eval_suite: "v", generated_at: "2026-09-25T12:00:00.000Z", results: {}, surprise: true }), "unexpected_field"],
  ])("rejects %s", (_name, fn, code) => {
    expectSidecarError(fn as () => unknown, code);
  });

  test.each([
    ["string", "true"],
    ["null", null],
    ["array", []],
    ["number", 1],
  ])("rejects non-boolean eval value %s", (_name, value) => {
    expectSidecarError(
      () => decodeEvalSidecar({ "run-a": true, "run-b": value }),
      "invalid_value",
    );
  });

  test.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["infinite", Number.POSITIVE_INFINITY],
    ["nan", Number.NaN],
    ["string", "2"],
    ["boolean", true],
  ])("rejects replan count %s", (_name, value) => {
    expectSidecarError(
      () => decodeReplanSidecar({ "run-a": 1, "run-b": value }),
      "invalid_value",
    );
  });

  test("rejects an empty or whitespace-only run id", () => {
    expectSidecarError(() => decodeEvalSidecar({ "": true }), "empty_run_id");
    expectSidecarError(() => decodeReplanSidecar({ "   ": 1 }), "empty_run_id");
    expectSidecarError(() => decodeEvalSidecar({ " run-a": true }), "invalid_run_id");
  });

  test("rejects the entire sidecar when one entry is invalid", () => {
    expectSidecarError(
      () => decodeEvalSidecar({ "run-a": true, "run-b": "false", "run-c": false }),
      "invalid_value",
    );
    expectSidecarError(
      () => decodeReplanSidecar({ "run-a": 1, "run-b": -2, "run-c": 3 }),
      "invalid_value",
    );
  });
});

describe("corpus sidecar coverage", () => {
  test("reports provided, matched, unmatched, and missing run ids", () => {
    const coverage = summarizeSidecarCoverage(
      ["run-b", "run-a", "run-z"],
      ["run-a", "run-c", "run-d"],
    );

    expect(coverage.providedRunIds).toEqual(["run-a", "run-b", "run-z"]);
    expect(coverage.matchedRunIds).toEqual(["run-a"]);
    expect(coverage.unmatchedRunIds).toEqual(["run-b", "run-z"]);
    expect(coverage.missingRunIds).toEqual(["run-c", "run-d"]);
    expect(coverage.providedCount).toBe(3);
    expect(coverage.matchedCount).toBe(1);
    expect(coverage.unmatchedCount).toBe(2);
    expect(coverage.missingCount).toBe(2);
    expect(coverage.truncated).toBe(false);
  });

  test("bounds reported ids while retaining exact counts", () => {
    const provided = Array.from({ length: 25 }, (_, index) => `run-${index}`);
    const coverage = summarizeSidecarCoverage(provided, []);

    expect(coverage.providedCount).toBe(25);
    expect(coverage.providedRunIds).toHaveLength(20);
    expect(coverage.unmatchedCount).toBe(25);
    expect(coverage.unmatchedRunIds).toHaveLength(20);
    expect(coverage.truncated).toBe(true);
  });
});
