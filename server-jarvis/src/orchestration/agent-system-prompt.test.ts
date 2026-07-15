import { describe, expect, test } from "bun:test";
import { applyAgentSystemPrompt, AGENT_SYSTEM_PROMPT_HEADER } from "./agent-system-prompt";

describe("applyAgentSystemPrompt (T3.2)", () => {
  test("no-ops on empty prompt", () => {
    const msgs = [{ role: "system", content: "BASE" }, { role: "user", content: "hi" }];
    expect(applyAgentSystemPrompt(msgs, "")).toEqual(msgs);
    expect(applyAgentSystemPrompt(msgs, undefined)).toEqual(msgs);
  });

  test("splices into leading system message", () => {
    const msgs = [{ role: "system", content: "BASE" }, { role: "user", content: "hi" }];
    const out = applyAgentSystemPrompt(msgs, "Be terse.");
    expect(out[0].content).toContain("BASE");
    expect(out[0].content).toContain(AGENT_SYSTEM_PROMPT_HEADER);
    expect(out[0].content).toContain("Be terse.");
    // Input not mutated.
    expect(msgs[0].content).toBe("BASE");
  });

  test("inserts leading system when none exists", () => {
    const msgs = [{ role: "user", content: "hi" }];
    const out = applyAgentSystemPrompt(msgs, "Be terse.");
    expect(out[0].role).toBe("system");
    expect(out[0].content).toContain("Be terse.");
    expect(out[1].role).toBe("user");
  });

  test("caps at 4000 chars", () => {
    const long = "x".repeat(5000);
    const out = applyAgentSystemPrompt([{ role: "system", content: "B" }], long);
    // Header + 4000 of body — must not include the full 5000.
    expect(out[0].content as string).not.toContain("x".repeat(4001));
    expect((out[0].content as string).match(/x/g)?.length).toBe(4000);
  });
});
