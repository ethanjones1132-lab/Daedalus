// server-jarvis/src/orchestration/replan.test.ts
import { describe, expect, test } from "bun:test";
import { splitPipelineAtReplan, buildReplanRequest } from "./replan";
import type { PipelineStageState } from "./stage-output";

describe("splitPipelineAtReplan", () => {
  test("returns one segment when there is no replan marker", () => {
    expect(splitPipelineAtReplan(["planner", "executor", "synthesizer"]))
      .toEqual([["planner", "executor", "synthesizer"]]);
  });

  test("splits into ordered segments at each conductor_replan marker", () => {
    const result = splitPipelineAtReplan([
      "planner", "executor", "conductor_replan", "executor", "reviewer", "synthesizer",
    ]);
    expect(result).toEqual([
      ["planner", "executor"],
      ["executor", "reviewer", "synthesizer"],
    ]);
  });

  test("strips re-enter: prefixes and drops nulls, matching Coordinator.executablePipeline", () => {
    const result = splitPipelineAtReplan([null, "re-enter:executor", "conductor_replan", "synthesizer"]);
    expect(result).toEqual([["executor"], ["synthesizer"]]);
  });

  test("drops empty segments (e.g. two replan markers in a row)", () => {
    const result = splitPipelineAtReplan(["executor", "conductor_replan", "conductor_replan", "synthesizer"]);
    expect(result).toEqual([["executor"], ["synthesizer"]]);
  });
});

describe("buildReplanRequest", () => {
  test("includes the original request, carried state, and remaining stages", () => {
    const state: PipelineStageState = {
      plan: { ok: true, narrative: "Step 1: inspect the schema." },
      executor: { ok: true, narrative: "Found an unexpected schema.", toolCalls: [] },
    };
    const text = buildReplanRequest("migrate the users table", state, ["reviewer", "synthesizer"]);
    expect(text).toContain("[MID-PIPELINE REPLAN]");
    expect(text).toContain("migrate the users table");
    expect(text).toContain("Step 1: inspect the schema.");
    expect(text).toContain("Found an unexpected schema.");
    expect(text).toContain("reviewer, synthesizer");
  });

  test("handles an empty carried state without throwing", () => {
    const text = buildReplanRequest("do something", {}, []);
    expect(text).toContain("[MID-PIPELINE REPLAN]");
    expect(text).toContain("re-derive from scratch");
  });
});
