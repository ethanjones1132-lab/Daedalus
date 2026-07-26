import { describe, expect, test } from "bun:test";
import {
  buildMidLoopToolEvidence,
  classifyMidLoopEscalation,
  collectToolPathTargets,
  decideMidLoopIntervention,
  hasConcreteProgressEvidence,
  maySpendMidLoopEscalation,
  midLoopWorthAsking,
  resolveResidentMidLoopDirective,
  shouldRunMidLoopCheck,
} from "./mid-loop-intervention";

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

  test("successful write alone does NOT short-circuit quality supervision", () => {
    // Old behavior auto-continued on successfulWrites > 0. Quality-aware
    // checkpoints leave that path open for verification inject / model escalate.
    const d = decideMidLoopIntervention({
      ...base, successfulWrites: 2, distinctSuccessfulReads: 10, stageRemainingMs: 5_000,
    });
    expect(d).toEqual({ kind: "continue" });
  });

  test("successful write with failed verification -> inject corrective note", () => {
    const d = decideMidLoopIntervention({
      ...base,
      successfulWrites: 1,
      distinctSuccessfulReads: 4,
      stageRemainingMs: 200_000,
      verification: {
        tier: "builtin",
        ran: true,
        passed: false,
        detail: "solution.py: syntax error",
        command: "syntax_check",
      },
    });
    expect(d.kind).toBe("inject");
    expect((d as { note: string }).note).toContain("Verification failed");
    expect((d as { note: string }).note).toContain("syntax error");
  });

  test("ambiguous middle (some reads, budget not yet critical) is NOT a reflex decision", () => {
    const d = decideMidLoopIntervention({
      ...base, distinctSuccessfulReads: 3, stageRemainingMs: 200_000,
    });
    expect(d).toEqual({ kind: "continue" });
  });
});

describe("shouldRunMidLoopCheck", () => {
  test("runs after a new successful write under the cap", () => {
    expect(shouldRunMidLoopCheck({
      writeLanded: true,
      successfulWrites: 1,
      successfulWritesAtLastCheck: 0,
      checksUsed: 0,
    })).toBe(true);
  });

  test("skips when there are no successful writes", () => {
    expect(shouldRunMidLoopCheck({
      writeLanded: true,
      successfulWrites: 0,
      successfulWritesAtLastCheck: 0,
      checksUsed: 0,
    })).toBe(false);
  });

  test("skips when this write set was already checked", () => {
    expect(shouldRunMidLoopCheck({
      writeLanded: true,
      successfulWrites: 2,
      successfulWritesAtLastCheck: 2,
      checksUsed: 1,
    })).toBe(false);
  });

  test("pre-completion runs only for unchecked writes", () => {
    expect(shouldRunMidLoopCheck({
      writeLanded: false,
      forcePreCompletion: true,
      successfulWrites: 1,
      successfulWritesAtLastCheck: 0,
      checksUsed: 0,
    })).toBe(true);
    expect(shouldRunMidLoopCheck({
      writeLanded: false,
      forcePreCompletion: true,
      successfulWrites: 1,
      successfulWritesAtLastCheck: 1,
      checksUsed: 1,
    })).toBe(false);
  });

  test("honors the per-stage check cap", () => {
    expect(shouldRunMidLoopCheck({
      writeLanded: true,
      successfulWrites: 3,
      successfulWritesAtLastCheck: 2,
      checksUsed: 2,
      maxChecks: 2,
    })).toBe(false);
  });
});

describe("midLoopWorthAsking / classifyMidLoopEscalation", () => {
  test("pre-write reads with zero writes is early exploration", () => {
    expect(classifyMidLoopEscalation({
      ...base, distinctSuccessfulReads: 2, successfulWrites: 0,
    })).toBe("early_exploration");
    expect(midLoopWorthAsking({
      ...base, distinctSuccessfulReads: 2, successfulWrites: 0,
    })).toBe(true);
  });

  test("clean turn with no reads is not worth asking", () => {
    expect(midLoopWorthAsking(base)).toBe(false);
  });

  test("successful writes alone without quality signal is not worth asking", () => {
    expect(midLoopWorthAsking({
      ...base, successfulWrites: 1, distinctSuccessfulReads: 3,
    })).toBe(false);
  });

  test("write just landed is priority quality", () => {
    expect(classifyMidLoopEscalation({
      ...base,
      successfulWrites: 1,
      distinctSuccessfulReads: 3,
      writeLandedSinceLastCheck: true,
    })).toBe("priority_quality");
  });

  test("failed verification after write is priority quality", () => {
    expect(classifyMidLoopEscalation({
      ...base,
      successfulWrites: 1,
      verification: { tier: "existing", ran: true, passed: false, detail: "test failed" },
    })).toBe("priority_quality");
  });

  test("endgame budget is priority even mid-exploration", () => {
    expect(classifyMidLoopEscalation({
      ...base,
      distinctSuccessfulReads: 2,
      successfulWrites: 0,
      stageRemainingMs: 20_000,
    })).toBe("priority_quality");
  });

  test("afterReroute is priority", () => {
    expect(classifyMidLoopEscalation({
      ...base,
      distinctSuccessfulReads: 1,
      afterReroute: true,
    })).toBe("priority_quality");
  });
});

describe("maySpendMidLoopEscalation (#5 reservation)", () => {
  test("early exploration may use at most max-reserved slots", () => {
    expect(maySpendMidLoopEscalation({
      classification: "early_exploration", used: 0, earlyUsed: 0,
    })).toBe(true);
    expect(maySpendMidLoopEscalation({
      classification: "early_exploration", used: 2, earlyUsed: 2,
    })).toBe(false);
  });

  test("priority may spend the reserved final slot", () => {
    expect(maySpendMidLoopEscalation({
      classification: "priority_quality", used: 2, earlyUsed: 2,
    })).toBe(true);
    expect(maySpendMidLoopEscalation({
      classification: "priority_quality", used: 3, earlyUsed: 2,
    })).toBe(false);
  });
});

describe("resolveResidentMidLoopDirective (#4 continue-must-cite)", () => {
  test("bare continue without evidence becomes force_write pre-write", () => {
    const d = resolveResidentMidLoopDirective({ directive: "continue" }, {
      ...base, distinctSuccessfulReads: 3, successfulWrites: 0,
    });
    expect(d).toMatchObject({ kind: "force_write", decisionSource: "schema_control" });
  });

  test("bare continue after write becomes inject", () => {
    const d = resolveResidentMidLoopDirective({ directive: "continue" }, {
      ...base, successfulWrites: 1, writeLandedSinceLastCheck: true,
    });
    expect(d).toMatchObject({ kind: "inject", decisionSource: "schema_control" });
  });

  test("continue with concrete progress_evidence is accepted", () => {
    const d = resolveResidentMidLoopDirective({
      directive: "continue",
      progress_evidence: "read solution.py boundary and confirmed the off-by-one",
    }, {
      ...base,
      distinctSuccessfulReads: 2,
      recentReadTargets: ["solution.py"],
    });
    expect(d).toMatchObject({ kind: "continue", decisionSource: "resident_model" });
  });

  test("hasConcreteProgressEvidence rejects vague ok", () => {
    expect(hasConcreteProgressEvidence("looks fine", base)).toBe(false);
    expect(hasConcreteProgressEvidence("ok", base)).toBe(false);
    expect(hasConcreteProgressEvidence("read src/a.ts and wrote the fix", base)).toBe(true);
  });
});

describe("buildMidLoopToolEvidence", () => {
  test("collects recent read/write targets and failed write attempts", () => {
    const evidence = buildMidLoopToolEvidence([
      {
        name: "read_file",
        arguments: { path: "src/a.ts" },
        output: "export const a = 1;",
        is_error: false,
        duration_ms: 5,
      },
      {
        name: "edit_file",
        arguments: { path: "src/a.ts", old_string: "1", new_string: "2" },
        output: "old_string not found",
        is_error: true,
        duration_ms: 8,
      },
      {
        name: "write_file",
        arguments: { path: "src/b.ts" },
        output: "wrote",
        is_error: false,
        duration_ms: 10,
      },
    ], {
      taskObjective: "fix off-by-one in a.ts",
      writeLandedSinceLastCheck: true,
    });

    expect(evidence.distinctSuccessfulReads).toBe(1);
    expect(evidence.successfulWrites).toBe(1);
    expect(evidence.failedWriteAttempts).toBe(1);
    expect(evidence.recentReadTargets).toEqual(["src/a.ts"]);
    expect(evidence.recentWriteTargets).toEqual(["src/b.ts"]);
    expect(evidence.taskObjective).toContain("off-by-one");
    expect(evidence.writeLandedSinceLastCheck).toBe(true);
    expect(evidence.recentToolSummaries?.length).toBe(3);
  });

  test("collectToolPathTargets reads nested multi_edit paths", () => {
    expect(collectToolPathTargets({
      edits: [{ path: "one.ts" }, { file_path: "two.ts" }],
    })).toEqual(["one.ts", "two.ts"]);
  });
});
