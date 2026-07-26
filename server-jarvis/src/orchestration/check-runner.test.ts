import { describe, expect, test } from "bun:test";
import { classifyRunGateTier, mergeToCheckResult, runVerificationCheck } from "./check-runner";
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