import { describe, expect, test } from "bun:test";
import {
  computeRunReward,
  computeRunRewardFromEffects,
  writeEvidenceFromEffects,
  writeEvidenceFromToolCalls,
} from "./run-reward";
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

describe("computeRunReward", () => {
  test("full success: target write + check pass + all plan items", () => {
    const r = computeRunReward({
      writes: {
        changedPaths: ["src/solution.py"],
        targetPaths: ["src/solution.py"],
        writeRequired: true,
      },
      check: { tier: "existing", ran: true, passed: true },
      plan: { itemsTotal: 2, itemsVerified: 2 },
    });
    expect(r.score).toBe(1);
    expect(r.terms).toEqual({ writes: 1, check: 1, plan: 1 });
    expect(r.creditedWritePaths).toContain("src/solution.py");
  });

  test("no model-judged path: check alone from CheckResult, not reviewer", () => {
    // Even without plan/write applicability, a failed runtime check is 0.
    const r = computeRunReward({
      writes: { changedPaths: ["a.ts"], writeRequired: true },
      check: { tier: "builtin", ran: true, passed: false },
      plan: null,
    });
    // writes=1, check=0 → score 0.5 with equal weights on two applicable terms
    expect(r.terms.writes).toBe(1);
    expect(r.terms.check).toBe(0);
    expect(r.score).toBeCloseTo(0.5, 5);
  });

  test("check_tier none scores 0 on check term (B2 foundation)", () => {
    const r = computeRunReward({
      writes: { changedPaths: ["a.ts"], writeRequired: true },
      check: { tier: "none", ran: false, passed: null },
      plan: null,
    });
    expect(r.terms.check).toBe(0);
    // writes 1, check 0 → 0.5
    expect(r.score).toBeCloseTo(0.5, 5);
    expect(r.notes.some((n) => n.includes("tier=none"))).toBe(true);
  });

  test("write-required with zero deltas → write term 0", () => {
    const r = computeRunReward({
      writes: { changedPaths: [], writeRequired: true },
      check: { tier: "existing", ran: true, passed: true },
      plan: null,
    });
    expect(r.terms.writes).toBe(0);
    expect(r.score).toBeCloseTo(0.5, 5);
  });

  test("non-target writes do not credit when targets known", () => {
    const r = computeRunReward({
      writes: {
        changedPaths: ["NOTES.md", "docs/status.md"],
        targetPaths: ["src/core.py"],
        writeRequired: true,
      },
      check: { tier: "existing", ran: true, passed: true },
      plan: null,
    });
    expect(r.terms.writes).toBe(0);
    expect(r.creditedWritePaths).toEqual([]);
    expect(r.notes.some((n) => n.includes("non-target"))).toBe(true);
  });

  test("read-only turn drops write weight and re-normalizes", () => {
    const r = computeRunReward({
      writes: { changedPaths: [], writeRequired: false },
      check: { tier: "existing", ran: true, passed: true },
      plan: { itemsTotal: 1, itemsVerified: 1 },
    });
    expect(r.weights.writes).toBe(0);
    expect(r.score).toBe(1);
    expect(r.weights.check + r.weights.plan).toBeCloseTo(1, 5);
  });

  test("partial plan verification is fractional", () => {
    const r = computeRunReward({
      writes: { changedPaths: ["a.ts"], writeRequired: true },
      check: { tier: "existing", ran: true, passed: true },
      plan: { itemsTotal: 4, itemsVerified: 1 },
    });
    expect(r.terms.plan).toBeCloseTo(0.25, 5);
    // (1 + 1 + 0.25) / 3
    expect(r.score).toBeCloseTo((1 + 1 + 0.25) / 3, 5);
  });

  test("no applicable terms → score 0", () => {
    const r = computeRunReward({
      writes: { changedPaths: [], writeRequired: false },
      check: null,
      plan: null,
    });
    expect(r.score).toBe(0);
    expect(r.notes.some((n) => n.includes("no applicable"))).toBe(true);
  });

  test("offline deterministic: same input → same score", () => {
    const input = {
      writes: {
        changedPaths: ["x.cpp", "y.h"],
        targetPaths: ["x.cpp"],
        writeRequired: true,
      },
      check: { tier: "builtin" as const, ran: true, passed: true as boolean | null },
      plan: { itemsTotal: 3, itemsVerified: 2 },
    };
    expect(computeRunReward(input)).toEqual(computeRunReward(input));
  });
});

describe("writeEvidence helpers", () => {
  test("from effects only counts changed fingerprints", () => {
    const ev = writeEvidenceFromEffects(
      [effect("a.ts", true), effect("b.ts", false)],
      { writeRequired: true },
    );
    expect(ev.changedPaths).toEqual(["a.ts"]);
  });

  test("from tool calls collects successful write paths", () => {
    const ev = writeEvidenceFromToolCalls(
      [
        { name: "read_file", is_error: false, arguments: { path: "a.ts" } },
        { name: "edit_file", is_error: false, arguments: { path: "a.ts" } },
        { name: "write_file", is_error: true, arguments: { path: "b.ts" } },
      ],
      { writeRequired: true },
    );
    expect(ev.changedPaths).toEqual(["a.ts"]);
  });

  test("computeRunRewardFromEffects end-to-end", () => {
    const r = computeRunRewardFromEffects({
      effects: [effect("src/main.rs", true)],
      check: { tier: "existing", ran: true, passed: true },
      writeRequired: true,
      targetPaths: ["src/main.rs"],
    });
    expect(r.score).toBe(1);
  });
});
