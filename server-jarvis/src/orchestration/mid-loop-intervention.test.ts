import { describe, expect, test } from "bun:test";
import { decideMidLoopIntervention } from "./mid-loop-intervention";

const base = {
  writeIntent: true,
  successfulWrites: 0,
  distinctSuccessfulReads: 0,
  turnCount: 3,
  maxTurns: 20,
  stageRemainingMs: 300_000,
  deadToolSuppressed: false,
  suppressedToolName: undefined as string | undefined,
};

describe("decideMidLoopIntervention", () => {
  test("no signal -> continue", () => {
    expect(decideMidLoopIntervention(base)).toEqual({ kind: "continue" });
  });

  test("dead tool suppressed -> redirect", () => {
    const d = decideMidLoopIntervention({ ...base, deadToolSuppressed: true, suppressedToolName: "glob" });
    expect(d).toMatchObject({ kind: "redirect", tool: "glob" });
  });

  test("write-intent, many reads, budget still comfortable -> force_write", () => {
    const d = decideMidLoopIntervention({
      ...base, distinctSuccessfulReads: 6, stageRemainingMs: 120_000,
    });
    expect(d.kind).toBe("force_write");
  });

  test("write-intent, zero writes, budget critical -> abort (not a timeout)", () => {
    const d = decideMidLoopIntervention({
      ...base, distinctSuccessfulReads: 10, stageRemainingMs: 20_000,
    });
    expect(d).toMatchObject({ kind: "abort" });
    expect((d as any).reason).toContain("budget");
  });

  test("no write intent -> never forces or aborts on write grounds", () => {
    const d = decideMidLoopIntervention({
      ...base, writeIntent: false, distinctSuccessfulReads: 20, stageRemainingMs: 5_000,
    });
    expect(d).toEqual({ kind: "continue" });
  });

  test("writes already happened -> continue even with low budget", () => {
    const d = decideMidLoopIntervention({
      ...base, successfulWrites: 2, distinctSuccessfulReads: 10, stageRemainingMs: 5_000,
    });
    expect(d).toEqual({ kind: "continue" });
  });

  test("ambiguous middle (some reads, budget not yet critical) is NOT a reflex decision", () => {
    const d = decideMidLoopIntervention({
      ...base, distinctSuccessfulReads: 3, stageRemainingMs: 200_000,
    });
    expect(d).toEqual({ kind: "continue" });
  });
});
