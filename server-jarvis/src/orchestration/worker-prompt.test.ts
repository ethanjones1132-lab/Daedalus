import { describe, expect, test } from "bun:test";
import { hashInstruction, resolveStagePrompt } from "./worker-prompt";

describe("resolveStagePrompt", () => {
  test("returns static prompt when no worker instructions exist", () => {
    expect(resolveStagePrompt("planner", "BASE PROMPT")).toBe("BASE PROMPT");
  });

  test("prepends conductor instructions and appends baseline contract", () => {
    const merged = resolveStagePrompt("executor", "BASE PROMPT", {
      executor: "Read src/auth.ts before editing.",
    });
    expect(merged).toContain("Read src/auth.ts before editing.");
    expect(merged).toContain("BASE PROMPT");
    expect(merged).toContain("Conductor instructions");
  });

  test("hashInstruction is stable for identical text", () => {
    expect(hashInstruction("read src/auth.ts")).toBe(hashInstruction("read src/auth.ts"));
    expect(hashInstruction("a")).not.toBe(hashInstruction("b"));
  });

  // T2.3
  test("renders injected mid-run notes as Conductor mid-run note block", () => {
    const merged = resolveStagePrompt(
      "executor",
      "BASE",
      undefined,
      undefined,
      undefined,
      ["read tests first", "prefer small diffs"],
    );
    expect(merged).toContain("Conductor mid-run note:");
    expect(merged).toContain("read tests first");
    expect(merged).toContain("prefer small diffs");
    expect(merged).toContain("BASE");
  });

  test("caps injected notes at 3 and 600 chars each", () => {
    const long = "x".repeat(800);
    const merged = resolveStagePrompt("executor", "BASE", undefined, undefined, undefined, [
      long, "b", "c", "d",
    ]);
    expect(merged.match(/- /g)?.length).toBe(3);
    expect(merged).not.toContain("x".repeat(601));
  });

  test("injects shared context blocks into customized prompts", () => {
    const merged = resolveStagePrompt(
      "synthesizer",
      "BASE PROMPT",
      { synthesizer: "Answer in three bullets." },
      {
        relevant_memories: ["User prefers Bun over npm."],
        failure_patterns: ["OpenRouter 401 on free tier"],
        prior_tool_results: { "read_file:src/a.ts": "export const x = 1;" },
      },
    );
    expect(merged).toContain("User prefers Bun over npm.");
    expect(merged).toContain("OpenRouter 401 on free tier");
    expect(merged).toContain("read_file:src/a.ts");
    expect(merged).toContain("Answer in three bullets.");
  });

  test("injects retrieved workspace context even without custom instructions or skills", () => {
    const merged = resolveStagePrompt(
      "executor",
      "BASE PROMPT",
      undefined,
      {
        relevant_memories: ["Active filesystem workspace root: C:\\Projects\\home-base-recovered"],
        prior_tool_results: {
          "read_file:README.md": "Jarvis is a standalone Tauri desktop platform with a Bun server.",
        },
      },
    );

    expect(merged).toContain("C:\\Projects\\home-base-recovered");
    expect(merged).toContain("Jarvis is a standalone Tauri desktop platform");
    expect(merged).toContain("BASE PROMPT");
  });

  test("bounds shared context entries and the assembled block", () => {
    const merged = resolveStagePrompt(
      "executor",
      "BASE PROMPT",
      undefined,
      {
        relevant_memories: Array.from({ length: 20 }, (_, i) => `memory-${i} ${"m".repeat(2_000)}`),
        failure_patterns: Array.from({ length: 12 }, (_, i) => `failure-${i} ${"f".repeat(1_000)}`),
        prior_tool_results: Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [`result-${i}`, "r".repeat(5_000)]),
        ),
      },
    );

    expect(merged).not.toContain("result-0");
    expect(merged).toContain("[context truncated for latency budget]");
  });
});
