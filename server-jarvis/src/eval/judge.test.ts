// server-jarvis/src/eval/judge.test.ts
import { describe, expect, test } from "bun:test";
import { judgeAnswer } from "./judge";

describe("judgeAnswer", () => {
  test("scores 1.0 when the judge model reports every rubric item covered", async () => {
    const callModel = async () => ({
      content: JSON.stringify({ covered: ["mentions the fix", "names the file"], missed: [] }),
    });
    const verdict = await judgeAnswer(callModel as any, "fix the bug", "I fixed it in login.ts", [
      "mentions the fix", "names the file",
    ]);
    expect(verdict.score).toBe(1);
    expect(verdict.missed).toEqual([]);
  });

  test("scores partial coverage proportionally", async () => {
    const callModel = async () => ({
      content: JSON.stringify({ covered: ["mentions the fix"], missed: ["names the file"] }),
    });
    const verdict = await judgeAnswer(callModel as any, "fix the bug", "I fixed it.", [
      "mentions the fix", "names the file",
    ]);
    expect(verdict.score).toBe(0.5);
    expect(verdict.missed).toEqual(["names the file"]);
  });

  test("scores 0 and surfaces a rationale when the judge output is unparseable", async () => {
    const callModel = async () => ({ content: "not json" });
    const verdict = await judgeAnswer(callModel as any, "fix the bug", "I fixed it.", ["mentions the fix"]);
    expect(verdict.score).toBe(0);
    expect(verdict.rationale).toContain("unparseable");
  });

  test("handles an empty rubric as a vacuous pass", async () => {
    const callModel = async () => ({ content: JSON.stringify({ covered: [], missed: [] }) });
    const verdict = await judgeAnswer(callModel as any, "hi", "hello!", []);
    expect(verdict.score).toBe(1);
  });
});
