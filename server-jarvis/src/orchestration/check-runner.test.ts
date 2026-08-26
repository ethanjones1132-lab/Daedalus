import { describe, expect, test } from "bun:test";
import {
  applyCheckHonestyGate,
  CHECK_HONESTY_GATE_CODE,
  classifyRunGateTier,
  mergeToCheckResult,
  runVerificationCheck,
} from "./check-runner";
import type { CheckResult } from "./check-runner";
import type { RunGateResult } from "./run-gate";
import type { ToolCallRecord } from "./stage-output";
import type { CheckOutcome } from "./build-check";

describe("check-runner tier mapping", () => {
  test("adjacent/explicit test → existing tier", () => {
    expect(classifyRunGateTier("adjacent_test")).toBe("existing");
    expect(classifyRunGateTier("explicit_test")).toBe("existing");
  });

  test("standalone script → synth tier", () => {
    expect(classifyRunGateTier("standalone_script")).toBe("synth");
  });
});

describe("mergeToCheckResult (build tri-state)", () => {
  const skipped: RunGateResult = { status: "skipped", reason: "no test", issues: [] };

  test("passing run gate becomes a passed CheckResult at its tier", () => {
    const run: RunGateResult = { status: "passed", target: "sol/_t.py", reason: "adjacent_test", issues: [] };
    const result = mergeToCheckResult({ run, build: { kind: "not_applicable", reason: "x" }, hadWrittenCode: true });
    expect(result).toMatchObject({ tier: "existing", ran: true, passed: true });
  });

  test("failing run gate carries the failure detail", () => {
    const run: RunGateResult = { status: "failed", target: "sol.py", issues: [{ path: "sol.py", error: "AssertionError: 3 != 4" }] };
    const result = mergeToCheckResult({ run, build: { kind: "not_applicable", reason: "x" }, hadWrittenCode: true });
    expect(result).toMatchObject({ tier: "existing", ran: true, passed: false });
    expect(result.detail).toContain("AssertionError");
  });

  test("no runnable test, build clean → builtin passed", () => {
    const build: CheckOutcome = { kind: "clean", command: "cargo check --quiet" };
    expect(mergeToCheckResult({ run: skipped, build, hadWrittenCode: true }))
      .toMatchObject({ tier: "builtin", ran: true, passed: true });
  });

  test("no runnable test, build failed → builtin failed with detail", () => {
    const build: CheckOutcome = { kind: "failed", command: "cargo check --quiet", detail: "error[E0425]: cannot find value `x`" };
    const r = mergeToCheckResult({ run: skipped, build, hadWrittenCode: true });
    expect(r).toMatchObject({ tier: "builtin", ran: true, passed: false });
    expect(r.detail).toContain("E0425");
  });

  test("REGRESSION: build not_applicable → honest none, never a green", () => {
    const build: CheckOutcome = { kind: "not_applicable", reason: "no build system matched" };
    expect(mergeToCheckResult({ run: skipped, build, hadWrittenCode: true }))
      .toMatchObject({ tier: "none", ran: false, passed: null });
  });

  test("no written code → none regardless of build", () => {
    expect(mergeToCheckResult({ run: skipped, build: { kind: "clean", command: "x" }, hadWrittenCode: false }))
      .toMatchObject({ tier: "none", ran: false });
  });
});

describe("CheckResult explains a none tier", () => {
  test("no code written is distinguished from a declined detector", () => {
    const noCode = mergeToCheckResult({
      run: { status: "skipped", issues: [], reason: undefined, target: undefined } as any,
      build: { kind: "not_applicable", reason: "no build system matched" },
      hadWrittenCode: false,
    });
    expect(noCode.tier).toBe("none");
    expect(noCode.declinedReason).toBe("no_code_written");

    const declined = mergeToCheckResult({
      run: { status: "skipped", issues: [], reason: undefined, target: undefined } as any,
      build: { kind: "not_applicable", reason: "no build system matched" },
      hadWrittenCode: true,
    });
    expect(declined.tier).toBe("none");
    expect(declined.declinedReason).toBe("no build system matched");
  });
});

describe("runVerificationCheck (build)", () => {
  const write: ToolCallRecord = { name: "write_file", arguments: { path: "a.cpp" }, output: "ok", is_error: false, duration_ms: 1 };

  test("runs build + test gates and merges (build clean → builtin)", async () => {
    const r = await runVerificationCheck({
      toolCalls: [write], request: "fix a.cpp", plan: "", workspaceRoot: "/ws", timeoutMs: 1000,
      runBuild: async () => ({ kind: "clean", command: "cmake --build /ws/build" }),
      runTests: async () => ({ status: "skipped", reason: "no test", issues: [] }),
    });
    expect(r).toMatchObject({ tier: "builtin", ran: true, passed: true });
  });

  test("no build system → honest none", async () => {
    const r = await runVerificationCheck({
      toolCalls: [write], request: "fix a.cpp", plan: "", workspaceRoot: "/ws", timeoutMs: 1000,
      runBuild: async () => ({ kind: "not_applicable", reason: "no build system matched" }),
      runTests: async () => ({ status: "skipped", reason: "no test", issues: [] }),
    });
    expect(r.tier).toBe("none");
  });

  test("no written code short-circuits to none", async () => {
    const r = await runVerificationCheck({
      toolCalls: [{ name: "read_file", arguments: { path: "a.cpp" }, output: "x", is_error: false, duration_ms: 1 }],
      request: "explain", plan: "", workspaceRoot: "/ws", timeoutMs: 1000,
      runBuild: async () => ({ kind: "clean", command: "x" }),
      runTests: async () => ({ status: "skipped", reason: "no test", issues: [] }),
    });
    expect(r.tier).toBe("none");
  });
});

/**
 * Structural honesty: B3 only *penalizes* after-the-fact overclaim. This gate
 * refuses to leave the run as `success` when a real check already failed —
 * converting confident-liar success into degraded so reward/telemetry stay
 * honest without relying on the model to cooperate with a directive.
 */
describe("applyCheckHonestyGate", () => {
  const red: CheckResult = {
    tier: "existing",
    ran: true,
    passed: false,
    detail: "assert failed",
    command: "run:_t.py",
    durationMs: 10,
  };
  const green: CheckResult = {
    tier: "existing",
    ran: true,
    passed: true,
    detail: "",
    command: "run:_t.py",
    durationMs: 10,
  };

  test("demotes success to degraded when an independent check failed", () => {
    expect(applyCheckHonestyGate("success", undefined, red)).toEqual({
      outcome: "degraded",
      errorCode: CHECK_HONESTY_GATE_CODE,
    });
  });

  test("leaves success alone when the check passed", () => {
    expect(applyCheckHonestyGate("success", undefined, green)).toEqual({
      outcome: "success",
    });
  });

  test("leaves success alone when no check ran or is missing", () => {
    expect(applyCheckHonestyGate("success", undefined, null)).toEqual({
      outcome: "success",
    });
    expect(
      applyCheckHonestyGate("success", undefined, {
        tier: "none",
        ran: false,
        passed: null,
        detail: "",
        command: "",
        durationMs: 0,
      }),
    ).toEqual({ outcome: "success" });
  });

  test("does not upgrade or alter already-failed / degraded outcomes", () => {
    expect(applyCheckHonestyGate("failed", "stage_error", red)).toEqual({
      outcome: "failed",
      errorCode: "stage_error",
    });
    expect(applyCheckHonestyGate("degraded", "upstream_stage_failed", red)).toEqual({
      outcome: "degraded",
      errorCode: "upstream_stage_failed",
    });
  });

// Regression guard (iter-035): applyCheckHonestyGate (check-runner.ts:35-43) must
// demote success -> degraded when check.passed === false.
describe("honesty-gate regression (check-runner:35-43)", () => {
  const red = { ran: true, passed: false, tier: "none" } as const;
  test("false-check demotes to degraded with CHECK_HONESTY_GATE_CODE", () => {
    const r = applyCheckHonestyGate("success", undefined, red);
    expect(r.outcome).toBe("degraded");
    expect(r.errorCode).toBe(CHECK_HONESTY_GATE_CODE);
  });
  test("true-check keeps success (no over-demote)", () => {
    const g = { ran: true, passed: true, tier: "full" } as const;
    expect(applyCheckHonestyGate("success", undefined, g).outcome).toBe("success");
  });
});
});
