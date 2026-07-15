import { describe, expect, test } from "bun:test";
import { ModelScorecard } from "./model-scorecard";
import type { ModelAttribution } from "../self-tuning/store";

const KEY = "opencode_go:deepseek-v4-flash";

function seededRow(
  id: string,
  createdAt: string,
  overrides: Partial<ModelAttribution> = {},
): ModelAttribution {
  return {
    id,
    agent_run_id: `run-${id}`,
    stage_id: "coordinator",
    provider: "opencode_go",
    model_id: "deepseek-v4-flash",
    was_successful: 0,
    had_error: 1,
    fallback_used: 0,
    created_at: createdAt,
    ...overrides,
  };
}

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

  test("revises a recorded outcome without adding a second sample", () => {
    const scorecard = new ModelScorecard();
    for (let i = 0; i < 5; i++) scorecard.record("coordinator", KEY, { ok: true });
    const recorded = scorecard.record("coordinator", KEY, { ok: true });
    const revise = (scorecard as unknown as {
      revise?: (attempt: unknown, patch: { ok: boolean }) => void;
    }).revise;

    expect(typeof revise).toBe("function");
    revise?.(recorded, { ok: false });

    expect(scorecard.errorRate("coordinator", KEY)).toBe(1 / 6);
  });

  test("0/8 seeded coordinator history is immediately unfit", () => {
    const scorecard = new ModelScorecard();
    const rows = Array.from({ length: 8 }, (_, index) =>
      seededRow(
        `seed-fail-${index}`,
        new Date(Date.UTC(2026, 6, 15, 12, 0, index)).toISOString(),
      ),
    );

    scorecard.seedFromHistory("coordinator", rows);

    expect(scorecard.unfitKeys("coordinator")).toEqual(new Set([KEY]));
  });

  test("12 seeded failures can be rehabilitated by 14 fresh successes", () => {
    const scorecard = new ModelScorecard();
    const rows = Array.from({ length: 12 }, (_, index) =>
      seededRow(
        `seed-${index}`,
        new Date(Date.UTC(2026, 6, 15, 12, 0, index)).toISOString(),
      ),
    );

    scorecard.seedFromHistory("coordinator", rows);
    expect(scorecard.unfitKeys("coordinator")).toEqual(new Set([KEY]));

    for (let i = 0; i < 14; i++) {
      scorecard.record("coordinator", KEY, { ok: true });
    }

    expect(scorecard.unfitKeys("coordinator").size).toBe(0);
  });

  test("empty seeded history is a no-op", () => {
    const scorecard = new ModelScorecard();

    scorecard.seedFromHistory("coordinator", []);

    expect(scorecard.unfitKeys("coordinator").size).toBe(0);
    expect(scorecard.p50FirstToken("coordinator", KEY)).toBeUndefined();
  });

  test("seeded history treats had_error as a failure even if was_successful is set", () => {
    const scorecard = new ModelScorecard();

    scorecard.seedFromHistory("coordinator", [
      seededRow("truthful-1", "2026-07-15T12:00:00.000Z", {
        was_successful: 1,
        had_error: 1,
      }),
      ...Array.from({ length: 5 }, (_, index) =>
        seededRow(
          `truthful-fail-${index}`,
          new Date(Date.UTC(2026, 6, 15, 12, 0, index + 1)).toISOString(),
        ),
      ),
    ]);

    expect(scorecard.unfitKeys("coordinator")).toEqual(new Set([KEY]));
  });
});
