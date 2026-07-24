import { describe, expect, test } from "bun:test";
import { classifyRunGateTier, mergeToCheckResult } from "./check-runner";
import type { RunGateResult } from "./run-gate";

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
