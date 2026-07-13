import { describe, test, expect } from "bun:test";
import { loadPrompt } from "./prompt-loader";

// Live diagnosis (2026-06-26) Priority 4: "Repo grounding is weak even when a
// response succeeds. The model still hallucinates the repo identity and entry
// files." The synthesizer is the only stage the user sees, and on
// coordinator-fallback or trivial-turn routes it gets no executor grounding.
// The fix is a "Never Invent Repo / Code Details" rule in the synthesizer
// prompt itself. This test pins the rule in place so a future prompt refactor
// can't silently remove it.
describe("synthesizer prompt grounding rule", () => {
  test("forbids inventing files / paths / frameworks absent from the provided context", () => {
    const prompt = loadPrompt("modes/synthesizer.md");
    expect(prompt).toContain("Never Invent Repo / Code Details");
    expect(prompt).toMatch(/only mention files \/ paths \/ commands \/ technologies that appear in the provided context/i);
    expect(prompt).toMatch(/when uncertain whether something is grounded, prefer silence over invention/i);
  });

  test("directs the synthesizer to admit when no executor inspected the workspace", () => {
    const prompt = loadPrompt("modes/synthesizer.md");
    // The honest-admission copy for repo questions with no workspace
    // inspection. Task 2.5 removed the old re-ask coaching from this line
    // ("ask me to read specific files") — that exact coaching manufactured
    // the 2026-07-12 repetition loop.
    expect(prompt).toMatch(/I haven't inspected the repo in this turn/i);
    expect(prompt).toMatch(/never tell the user to re-send, re-phrase, or re-ask/i);
    expect(prompt.toLowerCase()).not.toContain("ask me to read specific files");
  });

  test("forbids copying internal tool evidence into the user-facing answer", () => {
    const prompt = loadPrompt("modes/synthesizer.md");
    expect(prompt).toMatch(/never reproduce.*Tool Call Result/i);
    expect(prompt).toContain("<jarvis_internal_tool_result");
  });
});
