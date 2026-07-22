// Task A5 — missing-artifact damper. The executor loop counts prior identical
// FAILURES of a tool call so it can escalate the healing hint (from tool-heal.ts)
// after the 2nd occurrence, instead of letting the model keep re-globbing /
// re-reading a path that isn't there. `priorFailureCount` is the pure
// failure-counting helper that drives the `attempt` fed to augmentErrorOutput.
import { describe, expect, test } from "bun:test";
import { priorFailureCount } from "./pipeline";
import { toolCallSignature, augmentErrorOutput } from "../tool-heal";
import type { ToolCallRecord } from "./stage-output";

function rec(
  name: string,
  args: Record<string, unknown>,
  output: string,
  is_error: boolean,
): ToolCallRecord {
  return { name, arguments: args, output, is_error, duration_ms: 0 };
}

const sig = (name: string, args: Record<string, unknown>) => toolCallSignature(name, args);

describe("priorFailureCount", () => {
  test("empty history has zero prior failures", () => {
    expect(priorFailureCount([], sig("read_file", { path: "x.py" }))).toBe(0);
  });

  test("counts only FAILED calls with the exact same signature", () => {
    const history: ToolCallRecord[] = [
      rec("read_file", { path: "x.py" }, "File not found: x.py", true),
      rec("read_file", { path: "x.py" }, "1 | ok", false), // success — not counted
      rec("read_file", { path: "y.py" }, "File not found: y.py", true), // different path
      rec("glob", { pattern: "x.py" }, "no matches", true), // different tool
      rec("read_file", { path: "x.py" }, "File not found: x.py", true),
    ];
    expect(priorFailureCount(history, sig("read_file", { path: "x.py" }))).toBe(2);
  });

  test("argument order / identity uses the stable signature", () => {
    const history: ToolCallRecord[] = [
      rec("grep", { pattern: "foo", path: "src" }, "not found", true),
    ];
    // same args -> matches
    expect(priorFailureCount(history, sig("grep", { pattern: "foo", path: "src" }))).toBe(1);
    // different args -> no match
    expect(priorFailureCount(history, sig("grep", { pattern: "bar", path: "src" }))).toBe(0);
  });

  test("counts across carried prior-segment history (whole-history semantics)", () => {
    // A carried prior-segment failure + a this-segment failure should both count,
    // because the re-glob spiral this dampens crosses replan-segment boundaries.
    const carried = rec("read_file", { path: "_t.py" }, "File not found: _t.py", true);
    const thisSegment = rec("read_file", { path: "_t.py" }, "File not found: _t.py", true);
    expect(priorFailureCount([carried, thisSegment], sig("read_file", { path: "_t.py" }))).toBe(2);
  });

  test("drives escalation: attempt = priorFailures + 1 crosses the escalation threshold on the 2nd failure", () => {
    const signature = sig("read_file", { path: "_t.py" });
    const failure = rec("read_file", { path: "_t.py" }, "File not found: _t.py", true);

    // First failure: no prior -> attempt 1 -> base (non-escalated) hint.
    const attempt1 = priorFailureCount([], signature) + 1;
    const out1 = augmentErrorOutput(failure.output, attempt1);
    expect(out1).toContain("Hint:");
    expect(out1).not.toContain("try a different approach");

    // Second identical failure: one prior -> attempt 2 -> escalated hint.
    const attempt2 = priorFailureCount([failure], signature) + 1;
    const out2 = augmentErrorOutput(failure.output, attempt2);
    expect(out2).toContain("failed 2 times");
    expect(out2).toContain("try a different approach or report the limitation");
  });
});
