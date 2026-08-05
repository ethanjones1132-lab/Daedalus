import { describe, expect, test, beforeEach } from "bun:test";
import {
  NO_TOOL_DEMOTION_THRESHOLD,
  MIN_NO_TOOL_SAMPLE,
  shouldDemoteForNoTool,
  recordExecutorTurn,
  noToolStatsFor,
  shouldBenchForErrorRate,
  MIN_ERROR_RATE_SAMPLE,
  ERROR_RATE_BENCH_THRESHOLD,
  recordModelCall,
  errorStatsFor,
  errorStatsForModel,
  modelsBenchedForErrorRate,
  __resetModelHealthForTests,
} from "./model-health";

describe("shouldDemoteForNoTool", () => {
  test("demotes a model above the threshold with enough samples", () => {
    expect(shouldDemoteForNoTool({ noToolTurns: 30, executorTurns: 40 })).toBe(true);
  });

  test("does not demote below the sample floor, however bad the rate", () => {
    expect(shouldDemoteForNoTool({
      noToolTurns: MIN_NO_TOOL_SAMPLE - 1,
      executorTurns: MIN_NO_TOOL_SAMPLE - 1,
    })).toBe(false);
  });

  test("does not demote a healthy model", () => {
    expect(shouldDemoteForNoTool({ noToolTurns: 2, executorTurns: 40 })).toBe(false);
  });

  test("threshold is a rate, not a count", () => {
    const rate = NO_TOOL_DEMOTION_THRESHOLD;
    const turns = 100;
    expect(shouldDemoteForNoTool({
      noToolTurns: Math.ceil(rate * turns) + 1,
      executorTurns: turns,
    })).toBe(true);
    expect(shouldDemoteForNoTool({
      noToolTurns: Math.floor(rate * turns) - 1,
      executorTurns: turns,
    })).toBe(false);
  });
});

describe("process-local no-tool stats", () => {
  beforeEach(() => {
    __resetModelHealthForTests();
  });

  test("recordExecutorTurn aggregates turns and no-tool counts", () => {
    recordExecutorTurn("openrouter", "vendor/m:free", true);
    recordExecutorTurn("openrouter", "vendor/m:free", false);
    recordExecutorTurn("openrouter", "vendor/m:free", false);
    expect(noToolStatsFor("openrouter", "vendor/m:free")).toEqual({
      noToolTurns: 2,
      executorTurns: 3,
    });
  });

  test("unknown models report zero stats", () => {
    expect(noToolStatsFor("none", "missing")).toEqual({
      noToolTurns: 0,
      executorTurns: 0,
    });
  });

  test("models are keyed by provider:model_id", () => {
    recordExecutorTurn("claude_cli", "minimax-m3", false);
    expect(noToolStatsFor("opencode_go", "minimax-m3").executorTurns).toBe(0);
    expect(noToolStatsFor("claude_cli", "minimax-m3").executorTurns).toBe(1);
  });
});

describe("shouldBenchForErrorRate", () => {
  test("benches a model failing most calls", () => {
    expect(shouldBenchForErrorRate({ errors: 30, calls: 33 })).toBe(true);
  });

  test("respects a sample floor", () => {
    expect(shouldBenchForErrorRate({ errors: 3, calls: 3 })).toBe(false);
  });

  test("leaves a mostly-healthy model alone", () => {
    expect(shouldBenchForErrorRate({ errors: 70, calls: 342 })).toBe(false);
  });

  test("threshold is a rate above ERROR_RATE_BENCH_THRESHOLD", () => {
    const calls = 100;
    expect(shouldBenchForErrorRate({
      errors: Math.floor(ERROR_RATE_BENCH_THRESHOLD * calls),
      calls,
    })).toBe(false);
    expect(shouldBenchForErrorRate({
      errors: Math.floor(ERROR_RATE_BENCH_THRESHOLD * calls) + 1,
      calls,
    })).toBe(true);
  });

  test("sample floor constant is 10", () => {
    expect(MIN_ERROR_RATE_SAMPLE).toBe(10);
  });
});

describe("process-local error-rate stats", () => {
  beforeEach(() => {
    __resetModelHealthForTests();
  });

  test("recordModelCall aggregates calls and errors", () => {
    recordModelCall("claude_cli", "vendor/failing:free", true);
    recordModelCall("claude_cli", "vendor/failing:free", true);
    recordModelCall("claude_cli", "vendor/failing:free", false);
    expect(errorStatsFor("claude_cli", "vendor/failing:free")).toEqual({
      errors: 2,
      calls: 3,
    });
    // Bare model id also accumulates for delegate selection.
    expect(errorStatsForModel("vendor/failing:free")).toEqual({
      errors: 2,
      calls: 3,
    });
  });

  test("modelsBenchedForErrorRate lists only over-threshold models", () => {
    for (let i = 0; i < 12; i++) {
      recordModelCall("claude_cli", "vendor/failing:free", true);
    }
    for (let i = 0; i < 12; i++) {
      recordModelCall("claude_cli", "vendor/healthy:free", i === 0);
    }
    const benched = modelsBenchedForErrorRate();
    expect(benched).toContain("vendor/failing:free");
    expect(benched).not.toContain("vendor/healthy:free");
  });
});
