import { describe, expect, test } from "bun:test";
import { judgeAnswer } from "./judge";
import { toPromotionReplayResults, type SemanticReport } from "./semantic-harness";

describe("semantic harness judge boundary", () => {
  test("does not turn a contradictory judge response into a passing replay", async () => {
    const verdict = await judgeAnswer(
      async () => ({
        content: JSON.stringify({ covered: ["rubric item", "rubric item"], missed: [] }),
      }),
      "request",
      "answer",
      ["rubric item"],
    );
    const report: SemanticReport = {
      total: 1,
      averageScore: verdict.score,
      results: [
        {
          id: "case-contradictory",
          score: verdict.score,
          covered: verdict.covered,
          missed: verdict.missed,
          answer: "answer",
        },
      ],
    };

    expect(verdict.valid).toBe(false);
    expect(toPromotionReplayResults(report)[0]?.passed).toBe(false);
  });
});
