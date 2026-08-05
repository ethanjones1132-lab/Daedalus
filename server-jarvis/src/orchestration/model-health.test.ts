import { describe, expect, test, beforeEach } from "bun:test";
import {
  NO_TOOL_DEMOTION_THRESHOLD,
  MIN_NO_TOOL_SAMPLE,
  shouldDemoteForNoTool,
  recordExecutorTurn,
  noToolStatsFor,
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
