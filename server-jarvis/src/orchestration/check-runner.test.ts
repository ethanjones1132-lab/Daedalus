import { describe, expect, test } from "bun:test";
import { classifyRunGateTier, mergeToCheckResult, detectCheck } from "./check-runner";
import type { RunGateResult } from "./run-gate";
import type { SyntaxIssue } from "./syntax-gate";

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
    const result = mergeToCheckResult({ syntaxIssues: [], run, hadWrittenCode: true });
    expect(result).toMatchObject({ tier: "existing", ran: true, passed: true });
  });

  test("failing run gate carries the failure detail", () => {
    const run: RunGateResult = { status: "failed", target: "sol.py", reason: "explicit_test", issues: [{ path: "sol.py", error: "AssertionError: 3 != 4" }] };
    const result = mergeToCheckResult({ syntaxIssues: [], run, hadWrittenCode: true });
    expect(result).toMatchObject({ tier: "existing", ran: true, passed: false });
    expect(result.detail).toContain("AssertionError");
  });

  test("no runnable test but syntax issues → builtin failed", () => {
    const run: RunGateResult = { status: "skipped", reason: "no runnable Python target", issues: [] };
    const syntaxIssues: SyntaxIssue[] = [{ path: "sol.py", error: "SyntaxError: bad token" }];
    const result = mergeToCheckResult({ syntaxIssues, run, hadWrittenCode: true });
    expect(result).toMatchObject({ tier: "builtin", ran: true, passed: false });
    expect(result.detail).toContain("SyntaxError");
  });

  test("no test, clean syntax → builtin passed", () => {
    const run: RunGateResult = { status: "skipped", reason: "no runnable Python target", issues: [] };
    const result = mergeToCheckResult({ syntaxIssues: [], run, hadWrittenCode: true });
    expect(result).toMatchObject({ tier: "builtin", ran: true, passed: true });
  });

  test("nothing to check → none tier", () => {
    const run: RunGateResult = { status: "skipped", reason: "no python written", issues: [] };
    const result = mergeToCheckResult({ syntaxIssues: [], run, hadWrittenCode: false });
    expect(result).toMatchObject({ tier: "none", ran: false, passed: null });
  });
});

describe("check-runner detection", () => {
  const mockWorkspace = "/tmp/test-workspace";

  test("detectCheck returns null for empty inputs", () => {
    const result = detectCheck({
      workspaceRoot: mockWorkspace,
      changedPaths: [],
      toolCalls: undefined,
    });
    expect(result).toBeNull();
  });

  test("planItem with acceptance check command → synth tier", () => {
    const result = detectCheck({
      workspaceRoot: mockWorkspace,
      changedPaths: ["sol.py"],
      toolCalls: [],
      planItem: {
        acceptanceChecks: [{ command: "python verify.py", kind: "custom" }],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.tier).toBe("synth");
    expect(result!.command).toBe("python verify.py");
  });

  test("detectCheck handles missing planItem gracefully", () => {
    const result = detectCheck({
      workspaceRoot: mockWorkspace,
      changedPaths: ["sol.py"],
      toolCalls: [],
      planItem: undefined,
    });
    // Should not throw, may return null or a detected check
    expect(typeof result === "object" || result === null).toBe(true);
  });
});