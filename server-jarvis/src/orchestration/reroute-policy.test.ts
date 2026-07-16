import { describe, expect, test } from "bun:test";
import {
  canApplyConductorReroute,
  DEFAULT_MAX_REROUTES_PER_SEGMENT,
  rejectReroute,
} from "./reroute-policy";

describe("conductor reroute policy", () => {
  test("allows bounded successive evidence-driven reroutes instead of dropping the second directive", () => {
    expect(DEFAULT_MAX_REROUTES_PER_SEGMENT).toBeGreaterThan(1);
    expect(canApplyConductorReroute(0)).toBe(true);
    expect(canApplyConductorReroute(1)).toBe(true);
    expect(canApplyConductorReroute(DEFAULT_MAX_REROUTES_PER_SEGMENT)).toBe(false);
  });
});

describe("rejectReroute — deterministic admission (F1)", () => {
  test("rejects completed-planner self-reroute", () => {
    expect(
      rejectReroute({
        triggerStage: "planner",
        triggerOutcome: "completed",
        newRemaining: ["re-enter:planner"],
        reason: "Planner completed but failed to gather any workspace evidence; must re-run planner",
      }),
    ).toBe("self_reroute_after_clean_completion");
  });

  test("admits failed-planner self-reroute (genuine retry)", () => {
    expect(
      rejectReroute({
        triggerStage: "planner",
        triggerOutcome: "failed",
        newRemaining: ["re-enter:planner", "executor", "synthesizer"],
        reason: "planner empty_completion — retry once",
      }),
    ).toBeNull();
  });

  test("rejects evidence-reasoned planner reroute even from an executor trigger", () => {
    expect(
      rejectReroute({
        triggerStage: "executor",
        triggerOutcome: "completed",
        newRemaining: ["re-enter:planner", "executor", "synthesizer"],
        reason: "insufficient workspace evidence; re-enter planner for a better plan",
      }),
    ).toBe("evidence_reroute_targeting_toolless_stage");
  });

  test("admits executor evidence reroute to re-enter:executor", () => {
    expect(
      rejectReroute({
        triggerStage: "executor",
        triggerOutcome: "completed",
        newRemaining: ["re-enter:executor", "reviewer", "synthesizer"],
        reason: "deep-read evidence insufficient after completed executor stage; re-entering executor once",
      }),
    ).toBeNull();
  });

  test("rejects plain stage-name self-reroute after clean planner completion", () => {
    expect(
      rejectReroute({
        triggerStage: "planner",
        triggerOutcome: "completed",
        newRemaining: ["planner", "executor"],
        reason: "try again",
      }),
    ).toBe("self_reroute_after_clean_completion");
  });
});
