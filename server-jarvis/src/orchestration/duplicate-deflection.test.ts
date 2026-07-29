// 2026-07-18 live incident: the executor legitimately re-read a file to
// compose an edit, got a 500-char preview + lecture, and reported
// "duplicate read-call restriction" as the reason no write happened. A
// repeated identical read now REPLAYS the full cached output (still marked
// with the deflection marker so it earns no evidence credit — the actual
// purpose of the 2026-07-12 repetition guard).
import { describe, expect, test } from "bun:test";
import { duplicateToolCallDeflection, toolCallIdentityKey } from "./pipeline";
import { isDuplicateToolDeflection } from "./stage-output";

const bigOutput = Array.from({ length: 400 }, (_, i) => `${i + 1} | line ${i + 1}`).join("\n");

describe("duplicateToolCallDeflection", () => {
  test("replays the FULL cached output, not a preview", () => {
    const result = duplicateToolCallDeflection(
      { id: "c1", name: "read_file", arguments: { path: "x.cpp" } },
      bigOutput,
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain(`line 400`);
    expect(result.output.length).toBeGreaterThan(bigOutput.length);
  });

  test("replay keeps the deflection marker so it earns no evidence credit", () => {
    const result = duplicateToolCallDeflection(
      { id: "c2", name: "read_file", arguments: { path: "x.cpp" } },
      bigOutput,
    );
    expect(isDuplicateToolDeflection({ output: result.output })).toBe(true);
  });

  test("with no cached output, still deflects with redirect guidance", () => {
    const result = duplicateToolCallDeflection(
      { id: "c3", name: "glob", arguments: { pattern: "*" } },
      undefined,
    );
    expect(isDuplicateToolDeflection({ output: result.output })).toBe(true);
    expect(result.output).toContain("NEW target");
  });
});

describe("toolCallIdentityKey", () => {
  const windowsIdentity = (arguments_: Record<string, unknown>) => toolCallIdentityKey(
    { name: "read_file", arguments: arguments_ },
    { workspaceRoot: "C:\\Projects\\Jarvis", platform: "win32" },
  );

  test("collapses equivalent relative, absolute, and forward-slash workspace paths", () => {
    const relative = windowsIdentity({ path: "IMPLEMENTATION_PLAN.md" });
    const absolute = windowsIdentity({ path: "C:\\Projects\\Jarvis\\IMPLEMENTATION_PLAN.md" });
    const forwardSlash = windowsIdentity({ path: "c:/projects/jarvis/implementation_plan.md" });

    expect(relative).toBe(absolute);
    expect(relative).toBe(forwardSlash);
  });

  test("uses the filesystem scope's WSL drive canonicalization on Linux", () => {
    const linuxIdentity = (arguments_: Record<string, unknown>) => toolCallIdentityKey(
      { name: "read_file", arguments: arguments_ },
      { workspaceRoot: "/mnt/c/Projects/Jarvis", platform: "linux" },
    );
    const relative = linuxIdentity({ path: "README.md" });
    const windowsDrive = linuxIdentity({ path: "C:\\Projects\\Jarvis\\README.md" });
    const windowsForwardSlash = linuxIdentity({ path: "C:/Projects/Jarvis/README.md" });
    const wslPath = linuxIdentity({ path: "/mnt/c/Projects/Jarvis/README.md" });

    expect(relative).toBe(windowsDrive);
    expect(relative).toBe(windowsForwardSlash);
    expect(relative).toBe(wslPath);
  });

  test("keeps unrelated targets and non-path arguments distinct", () => {
    const plan = windowsIdentity({ path: "IMPLEMENTATION_PLAN.md", offset: 0 });
    const readme = windowsIdentity({ path: "README.md", offset: 0 });
    const shiftedOffset = windowsIdentity({ path: "IMPLEMENTATION_PLAN.md", offset: 1 });
    const differentPattern = windowsIdentity({ path: "IMPLEMENTATION_PLAN.md", pattern: "Needle" });
    const caseChangedPattern = windowsIdentity({ path: "IMPLEMENTATION_PLAN.md", pattern: "needle" });

    expect(plan).not.toBe(readme);
    expect(plan).not.toBe(shiftedOffset);
    expect(differentPattern).not.toBe(caseChangedPattern);
  });
});
