import { describe, expect, test } from "bun:test";
import { applyEffectGate, buildWriteEffectNudge, evaluateEffectGate, isTerminalNoWriteEffect, mostReadSuccessfulFile, shouldPressWriteEffect } from "./effect-gate";
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

  test("two failed mutations with zero success become terminal no_write_effect", () => {
    const report = evaluateEffectGate({
      profile: "full",
      executor: executor([
        call("write_file", true, "permission denied"),
        call("write_file", true, "permission denied again"),
      ]),
      request: "write workspace/proof.txt",
    });

    expect(report.verdict).toBe("no_write_effect");
    expect(isTerminalNoWriteEffect(report)).toBe(true);
    expect(applyEffectGate("degraded", "upstream_stage_failed", report)).toEqual({
      outcome: "failed",
      errorCode: "effect_gate_no_write_effect",
    });
  });

  test("a successful mutation prevents repeated failures from becoming no_write_effect", () => {
    const report = evaluateEffectGate({
      profile: "full",
      executor: executor([
        call("write_file", true, "first attempt failed"),
        call("edit_file", false, "updated"),
      ]),
      request: "update workspace/proof.txt",
    });

    expect(report.successfulWrites).toBe(1);
    expect(report.verdict).toBe("tool_failures");
    expect(isTerminalNoWriteEffect(report)).toBe(false);
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

  // ── 2026-07-18: sticky task-run write intent ──
  // "re-execute"/"continue" mid-implementation name no mutation themselves;
  // without the sticky flag the gate declared such turns clean and a
  // zero-write "re-execute" shipped as success.
  test("assumeWriteIntent arms the gate for text that names no mutation", () => {
    const report = evaluateEffectGate({
      profile: "full",
      executor: executor([call("read_file")]),
      request: "re-execute",
      assumeWriteIntent: true,
    });
    expect(report.writeIntent).toBe(true);
    expect(report.verdict).toBe("no_write_effect");
  });

  test("assumeWriteIntent satisfied by a successful write stays clean", () => {
    const report = evaluateEffectGate({
      profile: "full",
      executor: executor([call("read_file"), call("write_file")]),
      request: "continue",
      assumeWriteIntent: true,
    });
    expect(report.verdict).toBe("clean");
  });
});

describe("executor write pressure", () => {
  const base = {
    writeIntent: true,
    profile: "full" as const,
    successfulWrites: 0,
    toolCallsEmitted: true,
    duplicateReadDeflections: 0,
    distinctSuccessfulReads: 0,
    nudgesSent: 0,
    turnCount: 2,
    maxTurns: 12,
  };

  test("escalates a duplicate-read loop before the model stops calling tools", () => {
    expect(shouldPressWriteEffect({ ...base, duplicateReadDeflections: 2 })).toBe(true);
  });

  test("escalates four distinct reads in the final two turns", () => {
    expect(shouldPressWriteEffect({
      ...base,
      distinctSuccessfulReads: 4,
      turnCount: 10,
    })).toBe(true);
    expect(shouldPressWriteEffect({
      ...base,
      distinctSuccessfulReads: 4,
      turnCount: 9,
    })).toBe(false);
  });

  test("keeps prose-only pressure and bounds all injections at three", () => {
    expect(shouldPressWriteEffect({ ...base, toolCallsEmitted: false })).toBe(true);
    expect(shouldPressWriteEffect({ ...base, duplicateReadDeflections: 3, nudgesSent: 3 })).toBe(false);
  });

  test("directive names available write tools and the expected target", () => {
    const directive = buildWriteEffectNudge(["write_file", "apply_patch"], "src/app.ts");
    expect(directive).toContain("write_file, apply_patch");
    expect(directive).toContain("src/app.ts");
  });

  test("most-read target counts only successful file-content reads", () => {
    const calls: ToolCallRecord[] = [
      { ...call("read_file", false, "chunk one"), arguments: { path: "src/app.ts", offset: 0 } },
      { ...call("read_file", false, "chunk two"), arguments: { path: "src/app.ts", offset: 100 } },
      { ...call("read_file", false, "other source"), arguments: { path: "src/other.ts" } },
      ...Array.from({ length: 5 }, () => ({ ...call("list_directory"), arguments: { path: "src/listing-winner" } })),
      ...Array.from({ length: 4 }, () => ({ ...call("grep"), arguments: { path: "src/grep-winner" } })),
      {
        ...call("read_file", false, "[duplicate call deflected] Reuse the prior result."),
        arguments: { path: "src/decoy.ts" },
      },
      { ...call("read_file", true, "permission denied"), arguments: { path: "src/error.ts" } },
    ];

    expect(mostReadSuccessfulFile(calls)).toBe("src/app.ts");
  });
});
