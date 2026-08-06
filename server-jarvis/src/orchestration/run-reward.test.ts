import { describe, expect, test } from "bun:test";
import {
  OVERCLAIM_PENALTY,
  buildStoredRunRewardSnapshot,
  computeRunReward,
  computeRunRewardFromEffects,
  computeRunRewardFromStored,
  planEvidenceFromItems,
  serializeRunRewardBreakdown,
  writeEvidenceFromEffects,
  writeEvidenceFromToolCalls,
} from "./run-reward";
import { runWithTheta } from "./orchestration-policy";
import type { WriteEffectObservation } from "./content-fingerprint";

function effect(path: string, changed: boolean): WriteEffectObservation {
  return {
    toolName: "edit_file",
    path,
    before: { path, exists: true, bytes: 1, sha256: changed ? "aaa" : "same" },
    after: { path, exists: true, bytes: 1, sha256: changed ? "bbb" : "same" },
    changed,
  };
}

describe("computeRunReward B1 composition", () => {
  test("the orchestration policy cannot change its own reward objective", () => {
    const input = {
      writes: { changedPaths: ["src/a.ts"], writeRequired: true },
      check: { tier: "existing" as const, ran: true, passed: false },
      plan: { itemsTotal: 1, itemsVerified: 0 },
      declaredOutcome: "success" as const,
    };

    const baseline = computeRunReward(input);
    const underCandidate = runWithTheta(
      { force_write_nudge_cap: 99 },
      () => computeRunReward(input),
    );

    expect(underCandidate).toEqual(baseline);
    expect(underCandidate.weights).toEqual({ writes: 1 / 3, check: 1 / 3, plan: 1 / 3 });
    expect(underCandidate.overclaimPenalty).toBe(OVERCLAIM_PENALTY);
  });

  test("full success: target write + independent check + plan", () => {
    const r = computeRunReward({
      writes: {
        changedPaths: ["src/solution.py"],
        targetPaths: ["src/solution.py"],
        writeRequired: true,
      },
      check: { tier: "existing", ran: true, passed: true },
      plan: { itemsTotal: 2, itemsVerified: 2 },
      declaredOutcome: "success",
    });
    expect(r.score).toBe(1);
    expect(r.overclaim).toBe(false);
    expect(r.hardZero).toBe(false);
  });

  test("partial plan is fractional", () => {
    const r = computeRunReward({
      writes: { changedPaths: ["a.ts"], writeRequired: true },
      check: { tier: "existing", ran: true, passed: true },
      plan: { itemsTotal: 4, itemsVerified: 1 },
    });
    expect(r.terms.plan).toBeCloseTo(0.25, 5);
    expect(r.score).toBeCloseTo((1 + 1 + 0.25) / 3, 5);
  });
});

describe("B2 anti-gaming", () => {
  test("write-required + check_tier none → hard zero (not partial)", () => {
    const r = computeRunReward({
      writes: { changedPaths: ["a.ts"], writeRequired: true },
      check: { tier: "none", ran: false, passed: null },
      plan: { itemsTotal: 1, itemsVerified: 1 },
    });
    expect(r.hardZero).toBe(true);
    expect(r.score).toBe(0);
    expect(r.baseScore).toBe(0);
  });

  test("write-required + missing check → hard zero", () => {
    const r = computeRunReward({
      writes: { changedPaths: ["a.ts"], writeRequired: true },
      check: null,
      plan: null,
    });
    // check N/A counts as declined for write-required
    expect(r.hardZero).toBe(true);
    expect(r.score).toBe(0);
  });

  test("status/log docs do not credit writes without being targets", () => {
    const r = computeRunReward({
      writes: {
        changedPaths: ["IMPLEMENTATION_STATUS_CURRENT.md", "EXECUTION_LOG.md"],
        writeRequired: true,
      },
      check: { tier: "existing", ran: true, passed: true },
      plan: null,
    });
    expect(r.terms.writes).toBe(0);
    expect(r.creditedWritePaths).toEqual([]);
  });

  test("status doc CAN credit when it is the explicit target", () => {
    const r = computeRunReward({
      writes: {
        changedPaths: ["docs/EXECUTION_LOG.md"],
        targetPaths: ["docs/EXECUTION_LOG.md"],
        writeRequired: true,
      },
      check: { tier: "existing", ran: true, passed: true },
      plan: null,
    });
    expect(r.terms.writes).toBe(1);
  });

  test("non-target writes earn nothing when targets known", () => {
    const r = computeRunReward({
      writes: {
        changedPaths: ["NOTES.md"],
        targetPaths: ["src/core.py"],
        writeRequired: true,
      },
      check: { tier: "existing", ran: true, passed: true },
      plan: null,
    });
    expect(r.terms.writes).toBe(0);
  });

  test("synth check is not independent → check term 0 (no hard zero if ran)", () => {
    const r = computeRunReward({
      writes: { changedPaths: ["a.ts"], writeRequired: true },
      check: { tier: "synth", ran: true, passed: true },
      plan: null,
    });
    expect(r.terms.check).toBe(0);
    expect(r.hardZero).toBe(false);
    // writes only of two applicable terms
    expect(r.score).toBeCloseTo(0.5, 5);
  });

  test("failed independent check allows honest partial (writes can score)", () => {
    const r = computeRunReward({
      writes: { changedPaths: ["a.ts"], writeRequired: true },
      check: { tier: "builtin", ran: true, passed: false },
      plan: null,
      declaredOutcome: "partial",
    });
    expect(r.hardZero).toBe(false);
    expect(r.terms.writes).toBe(1);
    expect(r.terms.check).toBe(0);
    expect(r.score).toBeCloseTo(0.5, 5);
    expect(r.overclaim).toBe(false);
  });
});

describe("B3 calibration (overclaim)", () => {
  test("declared success + failed check is worse than honest partial", () => {
    const base = {
      writes: { changedPaths: ["a.ts"], writeRequired: true as const },
      check: { tier: "existing" as const, ran: true, passed: false as boolean | null },
      plan: null,
    };
    const honest = computeRunReward({ ...base, declaredOutcome: "partial" });
    const lie = computeRunReward({ ...base, declaredOutcome: "success" });
    expect(honest.overclaim).toBe(false);
    expect(lie.overclaim).toBe(true);
    expect(lie.score).toBeLessThan(honest.score);
    expect(lie.score).toBeCloseTo(honest.baseScore - OVERCLAIM_PENALTY, 5);
  });

  test("declared success without any check is overclaim", () => {
    // hard zero also applies (write-required + declined)
    const r = computeRunReward({
      writes: { changedPaths: ["a.ts"], writeRequired: true },
      check: { tier: "none", ran: false, passed: null },
      declaredOutcome: "success",
    });
    expect(r.hardZero).toBe(true);
    expect(r.overclaim).toBe(true);
    // base 0 − penalty
    expect(r.score).toBeCloseTo(-OVERCLAIM_PENALTY, 5);
  });

  test("true success is not overclaim", () => {
    const r = computeRunReward({
      writes: { changedPaths: ["a.ts"], writeRequired: true },
      check: { tier: "existing", ran: true, passed: true },
      declaredOutcome: "success",
    });
    expect(r.overclaim).toBe(false);
    expect(r.score).toBe(1);
  });
});

describe("offline stored snapshot", () => {
  test("build + computeRunRewardFromStored is deterministic", () => {
    const snap = buildStoredRunRewardSnapshot({
      writeRequired: true,
      effects: [effect("src/main.rs", true)],
      targetPaths: ["src/main.rs"],
      check: { tier: "existing", ran: true, passed: true },
      plan: { itemsTotal: 1, itemsVerified: 1 },
      declaredOutcome: "success",
    });
    const a = computeRunRewardFromStored(snap);
    const b = computeRunRewardFromStored(snap);
    expect(a).toEqual(b);
    expect(a.score).toBe(1);
    expect(serializeRunRewardBreakdown(a)).toBe(serializeRunRewardBreakdown(b));
  });

  test("planEvidenceFromItems counts verified with acceptance checks only", () => {
    const plan = planEvidenceFromItems([
      { status: "verified", acceptanceChecks: [{ id: "1" }] },
      { status: "pending", acceptanceChecks: [{ id: "2" }] },
      { status: "verified", acceptanceChecks: [] }, // no checks → ignored
    ]);
    expect(plan).toEqual({ itemsTotal: 2, itemsVerified: 1 });
  });
});

describe("helpers", () => {
  test("no-op content effect does not earn write credit even if tool call succeeded", () => {
    // CMA-ES exploit surface: a tool call that returns ok but changed:false
    // must not fill changedPaths (writeEvidenceFromEffects filters on changed).
    const snap = buildStoredRunRewardSnapshot({
      writeRequired: true,
      effects: [effect("src/noop.ts", false)],
      toolCalls: [
        { name: "edit_file", is_error: false, arguments: { path: "src/noop.ts" } },
      ],
      check: { tier: "none", ran: false, passed: false },
      declaredOutcome: "success",
    });
    expect(snap.changedPaths).toEqual([]);
    // Same tool call without effects would have credited the write.
    const toolOnly = buildStoredRunRewardSnapshot({
      writeRequired: true,
      toolCalls: [
        { name: "edit_file", is_error: false, arguments: { path: "src/noop.ts" } },
      ],
      check: { tier: "none", ran: false, passed: false },
      declaredOutcome: "success",
    });
    expect(toolOnly.changedPaths).toEqual(["src/noop.ts"]);
  });

  test("writeEvidenceFromEffects / toolCalls", () => {
    expect(
      writeEvidenceFromEffects([effect("a.ts", true), effect("b.ts", false)], {
        writeRequired: true,
      }).changedPaths,
    ).toEqual(["a.ts"]);
    expect(
      writeEvidenceFromToolCalls(
        [
          { name: "edit_file", is_error: false, arguments: { path: "a.ts" } },
          { name: "write_file", is_error: true, arguments: { path: "b.ts" } },
        ],
        { writeRequired: true },
      ).changedPaths,
    ).toEqual(["a.ts"]);
  });

  test("computeRunRewardFromEffects", () => {
    const r = computeRunRewardFromEffects({
      effects: [effect("src/main.rs", true)],
      check: { tier: "existing", ran: true, passed: true },
      writeRequired: true,
      targetPaths: ["src/main.rs"],
    });
    expect(r.score).toBe(1);
  });
});
