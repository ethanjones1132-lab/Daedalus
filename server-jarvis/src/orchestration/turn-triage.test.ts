import { describe, test, expect } from "bun:test";
import { isContinuationTurn, isTrivialConversationalTurn, isWorkOrderFollowup } from "./turn-triage";

describe("isContinuationTurn", () => {
  test("recognizes compact continuation commands", () => {
    for (const message of ["Now task 2, go ahead", "ok go ahead", "continue", "next"]) {
      expect(isContinuationTurn(message)).toBe(true);
    }
  });

  test("recognizes work-start commands and ordinal phase/stage milestones as continuations", () => {
    for (const message of ["begin phase 1", "start phase 2", "resume step 2", "proceed with the plan"]) {
      expect(isContinuationTurn(message)).toBe(true);
    }
  });

  test("rejects standalone tasks, long messages, and acknowledgements", () => {
    for (const message of ["read the config file", "x".repeat(200), "thanks!", "beginners guide to rust", "phase transitions in physics"]) {
      expect(isContinuationTurn(message)).toBe(false);
    }
  });

  // 2026-07-17 incident: "Begin implementing phase 1" missed WORK_START_COMMAND
  // because the pattern required the work object directly after the verb.
  test("work-start commands with a gerund before the object are continuations", () => {
    for (const message of [
      "Begin implementing phase 1",
      "start implementing the plan",
      "ok begin writing the next task",
    ]) {
      expect(isContinuationTurn(message)).toBe(true);
    }
  });

  // 2026-07-17 incident: "Verify implementation completed" classified as a
  // fresh answer_only turn, short-circuited to a tool-less synthesizer, and
  // hallucinated a verification. It must inherit the prior turn's authority.
  test("verification-of-prior-work follow-ups are continuations", () => {
    for (const message of [
      "Verify implementation completed",
      "verify the implementation is complete",
      "check that the changes work",
    ]) {
      expect(isContinuationTurn(message)).toBe(true);
    }
  });

  test("fresh verification questions about concepts are not continuations", () => {
    expect(isContinuationTurn("verify my understanding of TCP: is it stream oriented?")).toBe(false);
  });
});

// 2026-07-18: during an ACTIVE full-execution task the polarity flips — any
// short non-question, non-smalltalk message is a work order that inherits the
// task's authority. This helper is the flip's gate.
describe("isWorkOrderFollowup", () => {
  test("imperative work orders qualify", () => {
    for (const message of [
      "re-execute",
      "Please apply the edits oh my goodness",
      "go",
      "polish it up",
      "try again with the full file this time",
    ]) {
      expect(isWorkOrderFollowup(message)).toBe(true);
    }
  });

  test("questions, smalltalk, and long fresh prompts do not qualify", () => {
    expect(isWorkOrderFollowup("what's the status?")).toBe(false);
    expect(isWorkOrderFollowup("how does the smoothing work")).toBe(false);
    expect(isWorkOrderFollowup("thanks!")).toBe(false);
    expect(isWorkOrderFollowup("did it work?")).toBe(false);
    expect(isWorkOrderFollowup("x".repeat(200))).toBe(false);
    expect(isWorkOrderFollowup("")).toBe(false);
  });
});

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
