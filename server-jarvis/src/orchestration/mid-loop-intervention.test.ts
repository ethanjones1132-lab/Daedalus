import { describe, expect, test } from "bun:test";
import {
  assessCorrectnessFloor,
  buildMidLoopToolEvidence,
  classifyMidLoopEscalation,
  collectToolPathTargets,
  decideMidLoopIntervention,
  DEFAULT_QUALITY_PUSH_NOTE,
  hasConcreteProgressEvidence,
  hasQualityEvidence,
  maySpendMidLoopEscalation,
  midLoopWorthAsking,
  resolveResidentMidLoopDirective,
  shouldRunMidLoopCheck,
  shouldRunQualityPhase,
  type MidLoopSignal,
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

  test("failed write attempts with zero success → force_write with path guidance", () => {
    const d = decideMidLoopIntervention({
      ...base,
      distinctSuccessfulReads: 2,
      failedWriteAttempts: 2,
      successfulWrites: 0,
      stageRemainingMs: 200_000,
      recentReadTargets: ["src/PluginProcessor.cpp"],
    });
    expect(d.kind).toBe("force_write");
    const note = (d as { note: string }).note;
    // The guidance now points at the path this run actually touched. It used
    // to hardcode `_t.py`, a tier-2B benchmark fixture name, which was
    // injected ~22 times into an unrelated C++ task on 2026-07-26.
    expect(note).toContain("src/PluginProcessor.cpp");
    expect(note).toContain("edit_file");
    expect(note).not.toContain("_t.py");
  });

  test("a repeatedly-ignored failed-write nudge escalates to whole-file write", () => {
    const d = decideMidLoopIntervention({
      ...base,
      distinctSuccessfulReads: 2,
      failedWriteAttempts: 3,
      successfulWrites: 0,
      stageRemainingMs: 200_000,
      forceWriteNudgesSent: 2,
    });
    expect(d.kind).toBe("force_write");
    expect((d as { note: string }).note).toContain("write_file");
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
      // Not quality phase (quality already accepted).
      qualityAccepted: true,
    });
    expect(d).toMatchObject({ kind: "continue", decisionSource: "resident_model" });
  });

  test("hasConcreteProgressEvidence rejects vague ok", () => {
    expect(hasConcreteProgressEvidence("looks fine", base)).toBe(false);
    expect(hasConcreteProgressEvidence("ok", base)).toBe(false);
    expect(hasConcreteProgressEvidence("read src/a.ts and wrote the fix", base)).toBe(true);
  });
});

describe("Slice D quality-after-correctness", () => {
  test("correctness floor needs a write and non-red verification", () => {
    expect(assessCorrectnessFloor({
      writeIntent: true, successfulWrites: 0,
    })).toBe(false);
    expect(assessCorrectnessFloor({
      writeIntent: true, successfulWrites: 1,
      verification: { tier: "none", ran: false, passed: null },
    })).toBe(true);
    expect(assessCorrectnessFloor({
      writeIntent: true, successfulWrites: 1,
      verification: { tier: "builtin", ran: true, passed: false, detail: "err" },
    })).toBe(false);
  });

  test("quality phase arms after write lands with correctness floor", () => {
    expect(shouldRunQualityPhase({
      ...base,
      successfulWrites: 1,
      writeLandedSinceLastCheck: true,
    })).toBe(true);
    expect(shouldRunQualityPhase({
      ...base,
      successfulWrites: 1,
      writeLandedSinceLastCheck: true,
      qualityAccepted: true,
    })).toBe(false);
    expect(shouldRunQualityPhase({
      ...base,
      successfulWrites: 1,
      writeLandedSinceLastCheck: true,
      qualityPushesUsed: 2,
      qualityPushBudget: 2,
    })).toBe(false);
  });

  test("quality phase is priority escalation", () => {
    expect(classifyMidLoopEscalation({
      ...base,
      successfulWrites: 1,
      writeLandedSinceLastCheck: true,
    })).toBe("priority_quality");
  });

  test("quality_accept without quality_evidence becomes inject push", () => {
    const d = resolveResidentMidLoopDirective(
      { directive: "quality_accept" },
      {
        ...base,
        successfulWrites: 1,
        implementationPhase: "quality",
        writeLandedSinceLastCheck: true,
      },
    );
    expect(d.kind).toBe("inject");
    expect((d as { note: string }).note).toContain("Correctness floor");
    expect(d.decisionSource).toBe("schema_control");
  });

  test("quality_accept with quality_evidence is accepted", () => {
    const d = resolveResidentMidLoopDirective(
      {
        directive: "quality_accept",
        quality_evidence: "hardened empty-input edge case and re-read solution.py for polish",
      },
      {
        ...base,
        successfulWrites: 1,
        implementationPhase: "quality",
        recentWriteTargets: ["solution.py"],
      },
    );
    expect(d).toMatchObject({ kind: "continue", decisionSource: "resident_model" });
  });

  test("hasQualityEvidence distinguishes polish from bare write mentions", () => {
    expect(hasQualityEvidence("wrote solution.py", {
      ...base, recentWriteTargets: ["solution.py"],
    })).toBe(false);
    expect(hasQualityEvidence("covered empty and unsorted edge cases after re-read", base)).toBe(true);
  });

  test("default quality push note is actionable for free/local executors", () => {
    expect(DEFAULT_QUALITY_PUSH_NOTE).toContain("edge cases");
    expect(DEFAULT_QUALITY_PUSH_NOTE).toContain("one-shot");
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

describe("correctness floor stays about the work attempted, not the plan", () => {
  const base = {
    writeIntent: true,
    successfulWrites: 1,
    verification: undefined,
  };

  // 2026-07-29 inversion incident: the floor was made ledger-aware, but its
  // ONLY consumers (shouldRunQualityPhase, and the Slice D gate in
  // pipeline.ts) read it as "correctness met -> now unlock the quality push".
  // Returning false for a partially-drained ledger therefore SUPPRESSED
  // supervision on exactly the turns that needed it most: live run_da68c50b
  // (5 of 6 items outstanding) issued zero quality pushes, where pre-change
  // run_7e6b590f had issued two. The ledger belongs in its own reflex that
  // ADDS pressure — see "outstanding plan items add supervision pressure".
  test("a partially-drained ledger does not lower the floor", () => {
    expect(assessCorrectnessFloor({
      ...base,
      planItemsTotal: 7,
      planItemsRemaining: 6,
    })).toBe(true);
  });

  test("with no ledger the one-write floor applies", () => {
    expect(assessCorrectnessFloor(base)).toBe(true);
  });

  test("zero writes never meets the floor", () => {
    expect(assessCorrectnessFloor({ ...base, successfulWrites: 0 })).toBe(false);
  });

  test("a red verification still fails the floor", () => {
    expect(assessCorrectnessFloor({
      ...base,
      verification: { tier: "builtin", ran: true, passed: false },
    })).toBe(false);
  });
});

describe("outstanding plan items add supervision pressure", () => {
  const worked = (over: Partial<MidLoopSignal> = {}): MidLoopSignal => ({
    writeIntent: true,
    successfulWrites: 1,
    distinctSuccessfulReads: 4,
    turnCount: 7,
    maxTurns: 14,
    stageRemainingMs: 300_000,
    deadToolSuppressed: false,
    writeLandedSinceLastCheck: true,
    qualityPushesUsed: 0,
    qualityPushBudget: 2,
    ...over,
  } as MidLoopSignal);

  // The property the 2026-07-29 inversion violated, stated directly: a turn
  // with work still outstanding must never receive LESS supervision than the
  // same turn with the ledger fully drained.
  test("a remaining ledger never yields less supervision than a drained one", () => {
    const remaining = worked({ planItemsTotal: 6, planItemsRemaining: 5 });
    const drained = worked({ planItemsTotal: 6, planItemsRemaining: 0 });
    const supervised = (s: MidLoopSignal) =>
      decideMidLoopIntervention(s).kind !== "continue" || shouldRunQualityPhase(s);
    expect(supervised(remaining)).toBe(true);
    expect(supervised(drained)).toBe(true);
  });

  test("remaining items inject a directive naming what is left", () => {
    const decision = decideMidLoopIntervention(
      worked({ planItemsTotal: 6, planItemsRemaining: 5 }),
    );
    expect(decision.kind).toBe("inject");
    expect((decision as { note: string }).note).toContain("5");
  });

  test("a drained ledger does not inject remaining-work pressure", () => {
    const decision = decideMidLoopIntervention(
      worked({ planItemsTotal: 6, planItemsRemaining: 0 }),
    );
    expect(decision.kind).toBe("continue");
  });

  test("no ledger keeps the legacy behaviour", () => {
    expect(decideMidLoopIntervention(worked()).kind).toBe("continue");
  });

  test("the quality phase still unlocks while items remain", () => {
    // The regression: this returned false, so the Slice D gate never ran.
    expect(shouldRunQualityPhase(
      worked({ planItemsTotal: 6, planItemsRemaining: 5 }),
    )).toBe(true);
  });

  test("remaining items do not push once the budget is nearly gone", () => {
    // The C2 budget guard owns that case and aborts with a named partial.
    const decision = decideMidLoopIntervention(
      worked({ planItemsTotal: 6, planItemsRemaining: 5, stageRemainingMs: 20_000 }),
    );
    expect(decision.kind).toBe("abort");
  });
});

describe("plan remainder respects the stage budget", () => {
  const spiral = {
    writeIntent: true,
    successfulWrites: 2,
    distinctSuccessfulReads: 3,
    turnCount: 6,
    maxTurns: 14,
    deadToolSuppressed: false,
    planItemsTotal: 7,
    planItemsRemaining: 5,
  } as MidLoopSignal;

  test("plenty of budget left keeps pushing for the remaining items", () => {
    const decision = decideMidLoopIntervention({ ...spiral, stageRemainingMs: 400_000 });
    expect(decision.kind).not.toBe("abort");
  });

  test("budget too low for the remainder ends with an honest partial", () => {
    const decision = decideMidLoopIntervention({ ...spiral, stageRemainingMs: 20_000 });
    expect(decision.kind).toBe("abort");
    expect((decision as { reason: string }).reason).toContain("5");
  });
});
