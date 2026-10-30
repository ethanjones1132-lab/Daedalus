import { describe, expect, test } from "bun:test";
import { createTurnTiming } from "./turn-timing";

function fakeClock(values: number[]) {
  let index = 0;
  return {
    now: () => values[Math.min(index++, values.length - 1)],
  };
}

describe("turn timing (post-answer path instrumentation)", () => {
  test("measures a synchronous operation with a bounded, labelled duration", () => {
    const lines: string[] = [];
    const timing = createTurnTiming("run_abc", {
      clock: fakeClock([1000, 1000, 1042.4]),
      emit: (line) => lines.push(line),
    });

    expect(timing.measure("run_finalize", () => 7)).toBe(7);
    expect(lines).toEqual(["[Jarvis Timing] run=run_abc op=run_finalize ms=42"]);
  });

  test("measures an awaited operation and keeps its resolved value", async () => {
    const lines: string[] = [];
    const timing = createTurnTiming("run_async", {
      clock: fakeClock([500, 500, 586]),
      emit: (line) => lines.push(line),
    });

    const result = await timing.measureAsync("optimize_and_apply", async () => "proposals");
    expect(result).toBe("proposals");
    expect(lines).toEqual(["[Jarvis Timing] run=run_async op=optimize_and_apply ms=86"]);
  });

  test("still reports the duration when the awaited operation rejects", async () => {
    const lines: string[] = [];
    const timing = createTurnTiming("run_err", {
      clock: fakeClock([10, 10, 190]),
      emit: (line) => lines.push(line),
    });

    await expect(timing.measureAsync("terminal_send", async () => {
      throw new Error("writer closed");
    })).rejects.toThrow("writer closed");
    expect(lines).toEqual(["[Jarvis Timing] run=run_err op=terminal_send ms=180"]);
  });

  test("clamps an out-of-range duration instead of printing it", () => {
    const negative: string[] = [];
    createTurnTiming("run_neg", {
      clock: fakeClock([500, 500, 120]),
      emit: (line) => negative.push(line),
    }).measure("self_tuning_proposals", () => undefined);
    expect(negative).toEqual(["[Jarvis Timing] run=run_neg op=self_tuning_proposals ms=0"]);

    const huge: string[] = [];
    createTurnTiming("run_huge", {
      clock: fakeClock([0, 0, 90_000_000]),
      emit: (line) => huge.push(line),
    }).measure("pre_terminal_frames", () => undefined);
    expect(huge).toEqual(["[Jarvis Timing] run=run_huge op=pre_terminal_frames ms=900000"]);
  });

  test("reports the tail total since the timing started", () => {
    const lines: string[] = [];
    const timing = createTurnTiming("run_total", {
      clock: fakeClock([100, 350]),
      emit: (line) => lines.push(line),
    });

    timing.markTotal("tail_before_terminal");
    expect(lines).toEqual(["[Jarvis Timing] run=run_total op=tail_before_terminal ms=250"]);
  });

  test("bounds and sanitises the run identity so a log line stays one line", () => {
    const lines: string[] = [];
    const timing = createTurnTiming(`run\nbad\tid ${"x".repeat(200)}`, {
      clock: fakeClock([0, 0, 1]),
      emit: (line) => lines.push(line),
    });

    timing.measure("run_finalize", () => undefined);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\t");
    const runToken = line.split(" ")[2];
    expect(runToken.startsWith("run=run_bad_id_")).toBe(true);
    expect(runToken.length).toBeLessThanOrEqual("run=".length + 64);
    expect(line.endsWith(" op=run_finalize ms=1")).toBe(true);
  });

  test("never includes operation output in the emitted line", () => {
    const lines: string[] = [];
    createTurnTiming("run_payload", {
      clock: fakeClock([0, 0, 5]),
      emit: (line) => lines.push(line),
    }).measure("run_finalize", () => "user secret prompt text");

    expect(lines).toEqual(["[Jarvis Timing] run=run_payload op=run_finalize ms=5"]);
  });
});

describe("turn timing invalid samples and failing collaborators", () => {
  test("omits the observation when the clock throws", () => {
    const lines: string[] = [];
    const timing = createTurnTiming("run_clock_throw", {
      clock: { now: () => { throw new Error("monotonic clock unavailable"); } },
      emit: (line) => lines.push(line),
    });

    expect(timing.measure("run_finalize", () => 7)).toBe(7);
    timing.markTotal("tail_before_terminal");
    expect(lines).toEqual([]);
  });

  test("omits the observation when the end sample is not finite", () => {
    const lines: string[] = [];
    const timing = createTurnTiming("run_clock_nan_end", {
      clock: fakeClock([0, 1000, Number.NaN]),
      emit: (line) => lines.push(line),
    });

    timing.measure("run_finalize", () => undefined);
    expect(lines).toEqual([]);
  });

  test("omits the observation instead of fabricating one from a zero start sample", () => {
    // The defect under review: substituting 0 for a failed start sample turned
    // a large monotonic reading into a large fabricated duration.
    const lines: string[] = [];
    const timing = createTurnTiming("run_clock_nan_start", {
      clock: fakeClock([0, Number.NaN, 5_000]),
      emit: (line) => lines.push(line),
    });

    timing.measure("run_finalize", () => undefined);
    expect(lines).toEqual([]);
  });

  test("omits the total when the clock cannot be sampled", () => {
    const lines: string[] = [];
    const timing = createTurnTiming("run_clock_total_nan", {
      clock: fakeClock([100, Number.NaN]),
      emit: (line) => lines.push(line),
    });

    timing.markTotal("tail_before_terminal");
    expect(lines).toEqual([]);
  });

  test("reports the wrapped operation's failure and rethrows it", () => {
    const lines: string[] = [];
    const timing = createTurnTiming("run_sync_err", {
      clock: fakeClock([0, 0, 12]),
      emit: (line) => lines.push(line),
    });

    expect(() => timing.measure("run_finalize", () => {
      throw new Error("finalize failed");
    })).toThrow("finalize failed");
    expect(lines).toEqual(["[Jarvis Timing] run=run_sync_err op=run_finalize ms=12"]);
  });

  test("a failing sink never fails the wrapped operation", async () => {
    const timing = createTurnTiming("run_sink", {
      clock: fakeClock([0, 0, 5, 5, 9]),
      emit: () => { throw new Error("sink unavailable"); },
    });

    expect(timing.measure("run_finalize", () => "value")).toBe("value");
    await expect(timing.measureAsync("terminal_send", async () => {
      throw new Error("writer closed");
    })).rejects.toThrow("writer closed");
  });
});
