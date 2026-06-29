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
});