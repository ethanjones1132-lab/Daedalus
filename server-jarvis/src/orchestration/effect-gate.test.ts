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
      request: "explain the api",
    });
    expect(report.verdict).toBe("clean");
    expect(report.writeIntent).toBe(false);
    expect(report.successfulWrites).toBe(0);
  });

  test("full profile with an explicit write request still requires a write effect", () => {
    const report = evaluateEffectGate({
      profile: "full",
      executor: executor([call("read_file")]),
      request: "write workspace/smoke.md",
    });
    expect(report.verdict).toBe("no_write_effect");
    expect(report.writeIntent).toBe(true);
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

  // ── 2026-07-17 incident: executor-less pipelines bypassed the gate ──
  // "Begin implementing phase 1" was routed synthesizer-only (profile "none",
  // no executor). writeIntent required profile==="full" && executor present,
  // so the gate stayed "clean" and the synthesizer fabricated a completion
  // claim with fake diffs. A write-intent request must fire the gate even
  // when no executor ran at all.
  test("write-intent request with no executor stage fires no_write_effect", () => {
    const report = evaluateEffectGate({
      profile: "none",
      request: "Begin implementing phase 1",
    });
    expect(report.verdict).toBe("no_write_effect");
    expect(report.writeIntent).toBe(true);
    expect(report.synthesizerNotice).toContain("ZERO file mutations");
  });

  test("write-intent request under a read_only profile still fires the gate", () => {
    const report = evaluateEffectGate({
      profile: "read_only",
      executor: executor([call("read_file")]),
      request: "update README.md",
    });
    expect(report.verdict).toBe("no_write_effect");
  });

  test("non-write request with no executor stays clean", () => {
    const report = evaluateEffectGate({
      profile: "none",
      request: "what did we decide about the smoothing approach?",
    });
    expect(report.verdict).toBe("clean");
    expect(report.writeIntent).toBe(false);
  });

  test("write-intent request satisfied by a successful write is clean", () => {
    const report = evaluateEffectGate({
      profile: "full",
      executor: executor([call("read_file"), call("edit_file")]),
      request: "Begin implementing phase 1",
    });
    expect(report.verdict).toBe("clean");
    expect(report.successfulWrites).toBe(1);
  });
});
