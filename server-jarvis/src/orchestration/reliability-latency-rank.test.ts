import { describe, expect, test } from "bun:test";
import {
  RELIABILITY_LATENCY_MIN_SAMPLES,
  rankModelsByReliabilityLatency,
  refusedForStageBudget,
  reliabilityLatencyScore,
  type ReliabilityLatencyEntry,
} from "./reliability-latency-rank";

function entry(
  key: string,
  over: Partial<ReliabilityLatencyEntry> = {},
): ReliabilityLatencyEntry {
  return {
    key,
    sampleCount: RELIABILITY_LATENCY_MIN_SAMPLES,
    successRate: 0.9,
    p50FirstTokenMs: 2_000,
    ...over,
  };
}

describe("reliabilityLatencyScore", () => {
  test("is successRate / max(p50, 1)", () => {
    expect(reliabilityLatencyScore(entry("a", { successRate: 0.8, p50FirstTokenMs: 2_000 }))).toBe(
      0.8 / 2_000,
    );
    expect(reliabilityLatencyScore(entry("b", { successRate: 1, p50FirstTokenMs: 0 }))).toBe(1);
  });

  test("missing p50 is treated as 1ms for the ratio", () => {
    expect(
      reliabilityLatencyScore(entry("c", { successRate: 0.5, p50FirstTokenMs: undefined })),
    ).toBe(0.5);
  });

  test("clamps successRate to [0, 1]", () => {
    expect(reliabilityLatencyScore(entry("d", { successRate: 2, p50FirstTokenMs: 10 }))).toBe(
      1 / 10,
    );
    expect(reliabilityLatencyScore(entry("e", { successRate: -1, p50FirstTokenMs: 10 }))).toBe(0);
  });
});

describe("rankModelsByReliabilityLatency", () => {
  test("ranks by successRate / latency (higher first)", () => {
    const ranked = rankModelsByReliabilityLatency([
      entry("slow-ok", { successRate: 1, p50FirstTokenMs: 10_000 }),
      entry("fast-ok", { successRate: 0.9, p50FirstTokenMs: 1_000 }),
      entry("mid", { successRate: 0.95, p50FirstTokenMs: 3_000 }),
    ]);
    expect(ranked.map((e) => e.key)).toEqual(["fast-ok", "mid", "slow-ok"]);
  });

  test("refuses models with sample>=N and p50 > remainingStageMs", () => {
    const ranked = rankModelsByReliabilityLatency(
      [
        entry("too-slow", { sampleCount: RELIABILITY_LATENCY_MIN_SAMPLES, p50FirstTokenMs: 20_000 }),
        entry("fits", { sampleCount: RELIABILITY_LATENCY_MIN_SAMPLES, p50FirstTokenMs: 5_000 }),
      ],
      8_000,
    );
    expect(ranked.map((e) => e.key)).toEqual(["fits"]);
  });

  test("does not refuse below MIN_SAMPLES even when p50 exceeds budget", () => {
    const ranked = rankModelsByReliabilityLatency(
      [
        entry("thin-slow", {
          sampleCount: RELIABILITY_LATENCY_MIN_SAMPLES - 1,
          p50FirstTokenMs: 50_000,
          successRate: 1,
        }),
        entry("known-fast", {
          sampleCount: RELIABILITY_LATENCY_MIN_SAMPLES,
          p50FirstTokenMs: 1_000,
          successRate: 0.5,
        }),
      ],
      2_000,
    );
    expect(ranked.map((e) => e.key)).toContain("thin-slow");
    expect(ranked.map((e) => e.key)).toContain("known-fast");
  });

  test("no remainingStageMs means no refuse, only ranking", () => {
    const ranked = rankModelsByReliabilityLatency([
      entry("slow", { p50FirstTokenMs: 30_000, successRate: 1 }),
      entry("fast", { p50FirstTokenMs: 500, successRate: 0.8 }),
    ]);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.key).toBe("fast");
  });

  test("non-finite remainingStageMs is ignored for refuse", () => {
    const ranked = rankModelsByReliabilityLatency(
      [entry("slow", { p50FirstTokenMs: 99_000 })],
      Number.NaN,
    );
    expect(ranked).toHaveLength(1);
  });

  test("stable tie-break: more samples, then key ASC", () => {
    const ranked = rankModelsByReliabilityLatency([
      entry("b-model", { successRate: 1, p50FirstTokenMs: 1_000, sampleCount: 6 }),
      entry("a-model", { successRate: 1, p50FirstTokenMs: 1_000, sampleCount: 6 }),
      entry("c-model", { successRate: 1, p50FirstTokenMs: 1_000, sampleCount: 10 }),
    ]);
    expect(ranked.map((e) => e.key)).toEqual(["c-model", "a-model", "b-model"]);
  });

  test("equal p50 prefers higher successRate", () => {
    const ranked = rankModelsByReliabilityLatency([
      entry("flaky", { successRate: 0.5, p50FirstTokenMs: 2_000 }),
      entry("solid", { successRate: 0.95, p50FirstTokenMs: 2_000 }),
    ]);
    expect(ranked[0]!.key).toBe("solid");
  });
});

describe("refusedForStageBudget", () => {
  test("returns only graded models whose p50 exceeds budget", () => {
    const refused = refusedForStageBudget(
      [
        entry("slow", { sampleCount: 8, p50FirstTokenMs: 12_000 }),
        entry("fast", { sampleCount: 8, p50FirstTokenMs: 1_000 }),
        entry("thin", { sampleCount: 2, p50FirstTokenMs: 99_000 }),
        entry("no-p50", { sampleCount: 8, p50FirstTokenMs: undefined }),
      ],
      5_000,
    );
    expect(refused).toEqual(new Set(["slow"]));
  });

  test("empty set when budget absent", () => {
    expect(refusedForStageBudget([entry("x", { p50FirstTokenMs: 99_000 })])).toEqual(new Set());
  });
});
