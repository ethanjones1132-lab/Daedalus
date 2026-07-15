import { describe, expect, test } from "bun:test";
import { ModelScorecard } from "./model-scorecard";

const KEY = "opencode_go:deepseek-v4-flash";

describe("ModelScorecard", () => {
  test("below the minimum sample size nothing is unfit", () => {
    const scorecard = new ModelScorecard();
    for (let i = 0; i < 5; i++) scorecard.record("coordinator", KEY, { ok: false });
    expect(scorecard.unfitKeys("coordinator").size).toBe(0);
  });

  test("a model failing at least half of six attempts is unfit for that stage only", () => {
    const scorecard = new ModelScorecard();
    for (let i = 0; i < 7; i++) scorecard.record("coordinator", KEY, { ok: false });
    expect(scorecard.unfitKeys("coordinator")).toEqual(new Set([KEY]));
    expect(scorecard.unfitKeys("reviewer").size).toBe(0);
  });

  test("recent successes dilute the rolling window below the threshold", () => {
    const scorecard = new ModelScorecard();
    for (let i = 0; i < 6; i++) scorecard.record("coordinator", KEY, { ok: false });
    for (let i = 0; i < 14; i++) scorecard.record("coordinator", KEY, { ok: true });
    expect(scorecard.unfitKeys("coordinator").size).toBe(0);
  });

  test("window trims to the most recent 20 attempts", () => {
    const scorecard = new ModelScorecard();
    for (let i = 0; i < 20; i++) scorecard.record("synthesizer", KEY, { ok: false });
    for (let i = 0; i < 20; i++) scorecard.record("synthesizer", KEY, { ok: true });
    expect(scorecard.unfitKeys("synthesizer").size).toBe(0);
  });

  test("p50 first-token latency", () => {
    const scorecard = new ModelScorecard();
    for (const ms of [1000, 2000, 30000]) scorecard.record("synthesizer", KEY, { ok: true, firstTokenMs: ms });
    expect(scorecard.p50FirstToken("synthesizer", KEY)).toBe(2000);
  });
});
