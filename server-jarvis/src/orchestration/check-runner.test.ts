import { describe, expect, test } from "bun:test";
import { classifyRunGateTier, mergeToCheckResult, runVerificationCheck } from "./check-runner";
import type { RunGateResult } from "./run-gate";
import type { ToolCallRecord } from "./stage-output";

describe("check-runner tier mapping", () => {
  test("adjacent/explicit test → existing tier", () => {
    expect(classifyRunGateTier("adjacent_test")).toBe("existing");
    expect(classifyRunGateTier("explicit_test")).toBe("existing");
  });

  test("standalone script → synth tier", () => {
    expect(classifyRunGateTier("standalone_script")).toBe("synth");
  });

  test("passing run gate becomes a passed CheckResult at its tier", () => {
    const run: RunGateResult = { status: "passed", target: "sol/_t.py", reason: "adjacent_test", issues: [] };
    const result = mergeToCheckResult({ syntaxIssues: [], run });
    expect(result).toMatchObject({ tier: "existing", ran: true, passed: true });
  });

  test("failing run gate carries the failure detail", () => {
    const run: RunGateResult = { status: "failed", target: "sol.py", issues: [{ path: "sol.py", error: "AssertionError: 3 != 4" }] };
    const result = mergeToCheckResult({ syntaxIssues: [], run });
    expect(result).toMatchObject({ tier: "existing", ran: true, passed: false });
    expect(result.detail).toContain("AssertionError");
  });

  test("no runnable test but syntax issues → builtin failed", () => {
    const run: RunGateResult = { status: "skipped", reason: "no runnable Python target", issues: [] };
    const result = mergeToCheckResult({ syntaxIssues: [{ path: "sol.py", error: "SyntaxError: bad token" }], run });
    expect(result).toMatchObject({ tier: "builtin", ran: true, passed: false });
    expect(result.detail).toContain("SyntaxError");
  });

  test("no test, clean syntax → builtin passed", () => {
    const run: RunGateResult = { status: "skipped", reason: "no runnable Python target", issues: [] };
    const result = mergeToCheckResult({ syntaxIssues: [], run });
    expect(result).toMatchObject({ tier: "builtin", ran: true, passed: true });
  });

  test("nothing to check → none tier", () => {
    const run: RunGateResult = { status: "skipped", reason: "no python written", issues: [] };
    const result = mergeToCheckResult({ syntaxIssues: [], run, hadWrittenCode: false });
    expect(result).toMatchObject({ tier: "none", ran: false, passed: null });
  });
});

describe("runVerificationCheck", () => {
  test("delegates to injected gates and returns a merged result", async () => {
    const toolCalls: ToolCallRecord[] = [
      { name: "write_file", arguments: { path: "sol.py" }, output: "ok", is_error: false, duration_ms: 1 },
    ];
    const result = await runVerificationCheck({
      toolCalls,
      request: "fix sol.py",
      plan: "",
      workspaceRoot: "/ws",
      timeoutMs: 1000,
      runSyntax: async () => [],
      runTests: async () => ({ status: "passed", target: "sol/_t.py", reason: "adjacent_test", issues: [] }),
    });
    expect(result).toMatchObject({ tier: "existing", ran: true, passed: true });
  });

  test("reports none when no code was written", async () => {
    const result = await runVerificationCheck({
      toolCalls: [{ name: "read_file", arguments: { path: "sol.py" }, output: "x", is_error: false, duration_ms: 1 }],
      request: "explain sol.py",
      plan: "",
      workspaceRoot: "/ws",
      timeoutMs: 1000,
      runSyntax: async () => [],
      runTests: async () => ({ status: "skipped", reason: "no python written", issues: [] }),
    });
    expect(result.tier).toBe("none");
  });
});
