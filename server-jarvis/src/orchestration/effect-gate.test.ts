import { describe, expect, test } from "bun:test";
import { applyEffectGate, evaluateEffectGate } from "./effect-gate";
import type { ExecutorStageOutput, ToolCallRecord } from "./stage-output";

function call(name: string, is_error = false, output = "ok"): ToolCallRecord {
  return { name, arguments: {}, output, is_error, duration_ms: 1 };
}

function executor(toolCalls: ToolCallRecord[]): ExecutorStageOutput {
  return { ok: true, narrative: "done", toolCalls };
}

describe("effect gate", () => {
  test("clean read turn is clean", () => {
    const report = evaluateEffectGate({
      profile: "read_only",
      executor: executor([call("read_file")]),
    });
    expect(report.clean).toBe(true);
    expect(report.verdict).toBe("clean");
  });

  test("any failed call produces tool_failures and an execution verification notice", () => {
    const report = evaluateEffectGate({
      profile: "full",
      executor: executor([call("write_file", true, "permission denied")]),
    });
    expect(report.clean).toBe(false);
    expect(report.verdict).toBe("tool_failures");
    expect(report.failedCalls).toEqual([{ name: "write_file", detail: "permission denied" }]);
    expect(report.synthesizerNotice).toContain("Execution Verification");
  });

  test("full profile with only reads produces no_write_effect", () => {
    const report = evaluateEffectGate({
      profile: "full",
      executor: executor([call("read_file")]),
    });
    expect(report.verdict).toBe("no_write_effect");
    expect(report.successfulWrites).toBe(0);
  });

  test("read-only profile with reads remains clean", () => {
    const report = evaluateEffectGate({
      profile: "read_only",
      executor: executor([call("glob")]),
    });
    expect(report.verdict).toBe("clean");
  });

  test("applyEffectGate fails an otherwise successful no-write report", () => {
    const report = evaluateEffectGate({ profile: "full", executor: executor([]) });
    expect(applyEffectGate("success", undefined, report)).toEqual({
      outcome: "failed",
      errorCode: "effect_gate_no_write_effect",
    });
    expect(applyEffectGate("failed", "stage_error", report)).toEqual({
      outcome: "failed",
      errorCode: "stage_error",
    });
  });
});
