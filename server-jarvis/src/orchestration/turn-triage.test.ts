import { describe, test, expect } from "bun:test";
import { isTrivialConversationalTurn } from "./turn-triage";

describe("isTrivialConversationalTurn", () => {
  test("greetings and small talk are trivial", () => {
    for (const s of ["Hey buddy, how are you today?", "hello", "thanks!", "good morning", "yo", "ok cool"]) {
      expect(isTrivialConversationalTurn(s)).toBe(true);
    }
  });

  test("task requests are NOT trivial", () => {
    for (const s of [
      "Summarize this repo and name one improvement",
      "read the config file and fix the bug",
      "what does resolveProviderTarget do?",
      "list the files in src",
    ]) {
      expect(isTrivialConversationalTurn(s)).toBe(false);
    }
  });

  test("long input is never trivial even if it starts with a greeting", () => {
    const s = "Hi! " + "Please refactor the orchestrator pipeline so that ".repeat(5);
    expect(isTrivialConversationalTurn(s)).toBe(false);
  });

  test("empty / whitespace is treated as trivial (synthesizer can handle it)", () => {
    expect(isTrivialConversationalTurn("   ")).toBe(true);
  });
});
