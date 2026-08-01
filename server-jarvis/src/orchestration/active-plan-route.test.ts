import { expect, test } from "bun:test";
import { activePlanContinuationPipeline } from "./active-plan-route";

test("explicit continuation of an open reviewer item skips coordinator and planner", () => {
  expect(activePlanContinuationPipeline({
    explicitContinuation: true,
    status: "active",
    turnCount: 2,
    activeItem: { acceptanceChecks: [{ id: "ac", description: "review", kind: "reviewer_pass" }] },
  })).toEqual(["executor", "reviewer", "synthesizer"]);
});

test("runtime-check item needs only executor and synthesizer", () => {
  expect(activePlanContinuationPipeline({
    explicitContinuation: true,
    status: "paused",
    turnCount: 3,
    activeItem: { acceptanceChecks: [{ id: "ac", description: "test", kind: "test_pass" }] },
  })).toEqual(["executor", "synthesizer"]);
});
