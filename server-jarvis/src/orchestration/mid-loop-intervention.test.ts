import { describe, expect, test } from "bun:test";
import {
  assessCorrectnessFloor,
  buildMidLoopToolEvidence,
  classifyMidLoopEscalation,
  collectToolPathTargets,
  decideMidLoopIntervention,
  FORCE_WRITE_NUDGE_CAP,
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

  test("five total successful reads across two files do not trigger the re-read-loop reflex", () => {
    const d = decideMidLoopIntervention({
      ...base,
      distinctSuccessfulReads: 2,
      totalSuccessfulReads: 5,
    });
    expect(d.kind).toBe("continue");
  });

  test("six total successful reads across three files meet the re-read-loop threshold", () => {
    const d = decideMidLoopIntervention({
      ...base,
      distinctSuccessfulReads: 3,
      totalSuccessfulReads: 6,
    });
    expect(d.kind).toBe("force_write");
  });

  test("nine total successful reads across two files force a write", () => {
    const d = decideMidLoopIntervention({
      ...base,
      distinctSuccessfulReads: 2,
      totalSuccessfulReads: 9,
    });
    expect(d.kind).toBe("force_write");
  });

  test("a re-read loop at the abort floor preserves the low-budget abort", () => {
    const d = decideMidLoopIntervention({
      ...base,
      distinctSuccessfulReads: 2,
      totalSuccessfulReads: 9,
      stageRemainingMs: 30_000,
    });
    expect(d.kind).toBe("abort");
  });

  // 2026-08-01, found by the replay harness on the FIRST post-fix runs: after
  // the plan-remainder nudge was capped, the spin relocated here. The
  // failed-write note was decided 7x byte-identical across 3 runs and 12/17
  // executor turns still made no tool call.
  //
  // Two halves of one bug, the same shape as the plan-remainder case:
  //   1. this branch had NO nudge cap — unlike `shouldPressWriteEffect`, which
  //      stops at `nudgesSent < 3` — so it kept holding the executor loop open.
  //   2. `buildFailedWriteNote` escalates on `forceWriteNudgesSent`, but that
  //      counter only advanced at the APPLY site behind a per-turn gate, while
  //      the decision fires every checkpoint. Its `sent >= 2` branch could
  //      therefore never be reached, so the note repeated verbatim.
  test("force_write stops firing once its nudge budget is spent", () => {
    const spent = {
      ...base,
      distinctSuccessfulReads: 2,
      failedWriteAttempts: 2,
      successfulWrites: 0,
      stageRemainingMs: 200_000,
      forceWriteNudgesSent: FORCE_WRITE_NUDGE_CAP,
    };
    expect(decideMidLoopIntervention(spent).kind).not.toBe("force_write");
  });

  test("force_write still fires while budget remains", () => {
    const fresh = {
      ...base,
      distinctSuccessfulReads: 2,
      failedWriteAttempts: 2,
      successfulWrites: 0,
      stageRemainingMs: 200_000,
      forceWriteNudgesSent: FORCE_WRITE_NUDGE_CAP - 1,
    };
    expect(decideMidLoopIntervention(fresh).kind).toBe("force_write");
  });

  test("force_write skips when run-level write_effect pressure is already spent", () => {
    const spent = {
      ...base,
      distinctSuccessfulReads: 6,
      stageRemainingMs: 200_000,
      writeEffectPressureAvailable: false,
    };
    expect(decideMidLoopIntervention(spent).kind).toBe("continue");
  });

  test("plan_remainder skips when run-level plan_remainder pressure is already spent", () => {
    const spent = {
      ...base,
      successfulWrites: 1,
      planItemsRemaining: 3,
      planNudgesSent: 0,
      planRemainderPressureAvailable: false,
    };
    expect(decideMidLoopIntervention(spent).kind).toBe("continue");
  });

  test("the failed-write note escalates instead of repeating verbatim", () => {
    // 2026-08-04: cap is 2 (sent 0 then 1). Compare statement vs escalation.
    const at = (sent: number) =>
      (decideMidLoopIntervention({
        ...base,
        distinctSuccessfulReads: 2,
        failedWriteAttempts: 2,
        successfulWrites: 0,
        stageRemainingMs: 200_000,
        recentReadTargets: ["src/PluginProcessor.cpp"],
        forceWriteNudgesSent: sent,
      }) as { note: string }).note;
    expect(at(0)).not.toBe(at(1));
  });

  test("force_write injects are tagged so the host can count them", () => {
    const d = decideMidLoopIntervention({
      ...base,
      distinctSuccessfulReads: 2,
      failedWriteAttempts: 2,
      successfulWrites: 0,
      stageRemainingMs: 200_000,
    });
    expect((d as { noteKind?: string }).noteKind).toBe("force_write");
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
    // 2026-08-04: second allowed nudge (sent=1) is the escalation under cap=2.
    const d = decideMidLoopIntervention({
      ...base,
      distinctSuccessfulReads: 2,
      failedWriteAttempts: 3,
      successfulWrites: 0,
      stageRemainingMs: 200_000,
      forceWriteNudgesSent: 1,
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
    expect(evidence.totalSuccessfulReads).toBe(1);
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

  // W5 mid-loop integrity: status/log (and off-target) writes must not count
  // as successfulWrites — otherwise force_write pressure stops while the
  // terminal effect gate still reports no_write_effect.
  test("status doc write does not count as successfulWrites", () => {
    const evidence = buildMidLoopToolEvidence([
      {
        name: "write_file",
        arguments: { path: "IMPLEMENTATION_STATUS_CURRENT.md" },
        output: "wrote",
        is_error: false,
        duration_ms: 5,
      },
      {
        name: "write_file",
        arguments: { path: "docs/EXECUTION_LOG.md" },
        output: "wrote",
        is_error: false,
        duration_ms: 5,
      },
    ]);
    expect(evidence.successfulWrites).toBe(0);
    expect(evidence.recentWriteTargets).toEqual([]);
  });

  test("off-target write is ignored when targetPaths are set; target write counts", () => {
    const evidence = buildMidLoopToolEvidence([
      {
        name: "write_file",
        arguments: { path: "scratch/notes.md" },
        output: "wrote",
        is_error: false,
        duration_ms: 5,
      },
      {
        name: "edit_file",
        arguments: { path: "src/app.ts" },
        output: "edited",
        is_error: false,
        duration_ms: 5,
      },
    ], { targetPaths: ["src/app.ts"] });
    expect(evidence.successfulWrites).toBe(1);
    expect(evidence.recentWriteTargets).toEqual(["src/app.ts"]);
  });

  test("Stage 0a.1: status doc listed as a target credits mid-loop when written", () => {
    const evidence = buildMidLoopToolEvidence([
      {
        name: "write_file",
        arguments: { path: "IMPLEMENTATION_STATUS_CURRENT.md" },
        output: "wrote",
        is_error: false,
        duration_ms: 5,
      },
    ], { targetPaths: ["IMPLEMENTATION_STATUS_CURRENT.md", "src/app.ts"] });
    expect(evidence.successfulWrites).toBe(1);
    expect(evidence.recentWriteTargets).toEqual(["IMPLEMENTATION_STATUS_CURRENT.md"]);
  });

  test("status doc does not credit mid-loop when only a code path is the target", () => {
    const evidence = buildMidLoopToolEvidence([
      {
        name: "write_file",
        arguments: { path: "IMPLEMENTATION_STATUS_CURRENT.md" },
        output: "wrote",
        is_error: false,
        duration_ms: 5,
      },
    ], { targetPaths: ["src/app.ts"] });
    expect(evidence.successfulWrites).toBe(0);
    expect(evidence.recentWriteTargets).toEqual([]);
  });
});

describe("pickNamedWriteTarget / failed-write notes (W5)", () => {
  test("failed-write note never names a status/log path", () => {
    const d = decideMidLoopIntervention({
      ...base,
      distinctSuccessfulReads: 2,
      failedWriteAttempts: 2,
      successfulWrites: 0,
      stageRemainingMs: 200_000,
      recentWriteTargets: ["IMPLEMENTATION_STATUS_CURRENT.md"],
      recentReadTargets: ["src/real.ts"],
    });
    expect(d.kind).toBe("force_write");
    const note = (d as { note: string }).note;
    expect(note).not.toMatch(/IMPLEMENTATION_STATUS/i);
    expect(note).not.toMatch(/_STATUS|_LOG/i);
    expect(note).toContain("src/real.ts");
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
    expect((decision as { note: string }).note).toContain("A landed write is progress");
  });

  test("remaining items inject before the first successful write", () => {
    const decision = decideMidLoopIntervention(
      worked({ successfulWrites: 0, writeLandedSinceLastCheck: false, planItemsTotal: 6, planItemsRemaining: 5 }),
    );
    expect(decision.kind).toBe("inject");
    const note = (decision as { note: string }).note;
    expect(note).toContain("No successful write has landed yet");
    expect(note).not.toContain("A landed write is progress");
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

  // 2026-07-31 live incident (run_2c46d082, session 50504c06): a "continue"
  // turn whose local conductor aborted fell to the deterministic answer_only
  // route, so NO planner stage ran — but the TaskPlan ledger still carried the
  // PREVIOUS turn's 4 items. `activePlanItem` therefore rendered the
  // stage-output placeholder "No planning stage executed." (see the
  // SKIP_SENTINELS set in synth-context.ts, which already treats these strings
  // as non-meaningful on the synthesizer path). The resulting nudge read:
  //
  //   "4 plan item(s) are still unverified ... The active item is:
  //    No planning stage executed."
  //
  // — an instruction naming a null placeholder as the thing to work on. It was
  // injected 56x byte-identical; 28 of 37 executor turns produced no tool call
  // at all (~93s of a 282s turn). Same bug class the 2026-07-26 read-spiral
  // note fix addressed (buildReadSpiralNote), which this branch never got.
  //
  // The note must never name a placeholder as the active item. Supervision is
  // deliberately PRESERVED (still `inject`, not `continue`) — per the
  // 2026-07-29 C1/C2 polarity inversion, making this branch stricter must not
  // silently remove supervision.
  test("a placeholder plan summary is never named as the active item", () => {
    const decision = decideMidLoopIntervention(
      worked({
        planItemsTotal: 4,
        planItemsRemaining: 4,
        activePlanItem: "No planning stage executed.",
      }),
    );
    expect(decision.kind).toBe("inject");
    const note = (decision as { note: string }).note;
    expect(note).not.toContain("No planning stage executed.");
    expect(note).not.toContain("The active item is:");
  });

  test("a real active plan item is still named", () => {
    const decision = decideMidLoopIntervention(
      worked({
        planItemsTotal: 4,
        planItemsRemaining: 4,
        activePlanItem: "Task 2: add the ParameterID enum",
      }),
    );
    expect(decision.kind).toBe("inject");
    const note = (decision as { note: string }).note;
    expect(note).toContain("The active item is: Task 2: add the ParameterID enum");
  });

  // 2026-07-31 follow-up to the same incident: removing the unactionable
  // clause stops the note being nonsense, but not the REPETITION. The plan
  // nudge fired 66x on one turn because nothing counted how many times it had
  // already been ignored. `buildReadSpiralNote` got exactly this discipline on
  // 2026-07-26 via `forceWriteNudgesSent`; this branch never did.
  //
  // Contract: escalate once, then stop. A note the executor has ignored twice
  // is not going to work the third time, and each repeat costs a full model
  // round-trip (~2-10s) plus a re-upload of the whole transcript. Stopping lets
  // the executor loop exit naturally instead of being held open to the turn
  // cap — 28 of 37 turns on the live run did nothing at all.
  test("the first plan nudge uses the baseline wording", () => {
    const decision = decideMidLoopIntervention(
      worked({ planItemsTotal: 6, planItemsRemaining: 5, planNudgesSent: 0 }),
    );
    expect(decision.kind).toBe("inject");
    expect((decision as { note: string }).note).toContain("still unverified");
  });

  test("the second plan nudge escalates instead of repeating verbatim", () => {
    const first = decideMidLoopIntervention(
      worked({ planItemsTotal: 6, planItemsRemaining: 5, planNudgesSent: 0 }),
    ) as { note: string };
    const second = decideMidLoopIntervention(
      worked({ planItemsTotal: 6, planItemsRemaining: 5, planNudgesSent: 1 }),
    ) as { kind: string; note: string };
    expect(second.kind).toBe("inject");
    expect(second.note).not.toBe(first.note);
  });

  test("a plan nudge ignored twice stops firing so the loop can exit", () => {
    const decision = decideMidLoopIntervention(
      worked({ planItemsTotal: 6, planItemsRemaining: 5, planNudgesSent: 2 }),
    );
    expect(decision.kind).toBe("continue");
  });

  test("supervision survives the repeat-cap via the quality phase", () => {
    // Same polarity property as above: capping the nudge must not leave the
    // stage unsupervised.
    const capped = worked({ planItemsTotal: 6, planItemsRemaining: 5, planNudgesSent: 2 });
    const supervised = decideMidLoopIntervention(capped).kind !== "continue"
      || shouldRunQualityPhase(capped);
    expect(supervised).toBe(true);
  });

  test("plan-remainder injects are tagged so the host can count them", () => {
    // The host increments `planNudgesSent` at the apply site in pipeline.ts and
    // cannot distinguish inject variants without a tag.
    const decision = decideMidLoopIntervention(
      worked({ planItemsTotal: 6, planItemsRemaining: 5, planNudgesSent: 0 }),
    );
    expect((decision as { noteKind?: string }).noteKind).toBe("plan_remainder");
  });

  test("supervision is preserved when the plan summary is a placeholder", () => {
    // The 2026-07-29 inversion property, restated for this guard: suppressing
    // the placeholder text must not suppress the supervision itself.
    const placeholder = worked({
      planItemsTotal: 4,
      planItemsRemaining: 4,
      activePlanItem: "No planning stage executed.",
    });
    const supervised = decideMidLoopIntervention(placeholder).kind !== "continue"
      || shouldRunQualityPhase(placeholder);
    expect(supervised).toBe(true);
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

describe("force-write nudge cap engages on every force_write decision", () => {
  // 2026-08-04 (run_cc660a4d): ~30 near-identical force-write notes because
  // only decisions tagged noteKind === "force_write" advanced the host counter,
  // and the spiral branches left that tag unset. Cap is 2: one statement, one
  // escalation.
  const writeSignal = (forceWriteNudgesSent: number): MidLoopSignal => ({
    writeIntent: true,
    successfulWrites: 0,
    distinctSuccessfulReads: 8,
    turnCount: 3,
    maxTurns: 12,
    stageRemainingMs: 200_000,
    deadToolSuppressed: false,
    forceWriteNudgesSent,
    planItemsTotal: 1,
    planItemsRemaining: 1,
  });

  test("every force_write decision is tagged noteKind so the host can count it", () => {
    const decision = decideMidLoopIntervention(writeSignal(0));
    if (decision.kind !== "force_write") {
      throw new Error(`expected force_write, got ${decision.kind}`);
    }
    expect(decision.noteKind).toBe("force_write");
  });

  test("stops deciding force_write once the cap is reached", () => {
    const decision = decideMidLoopIntervention(writeSignal(FORCE_WRITE_NUDGE_CAP));
    expect(decision.kind).not.toBe("force_write");
  });

  test("cap is 2 — one statement, one escalation", () => {
    expect(FORCE_WRITE_NUDGE_CAP).toBe(2);
  });
});

describe("read-spiral force_write is capped and tagged (A1)", () => {
  const spiral = (forceWriteNudgesSent: number) => ({
    writeIntent: true,
    successfulWrites: 0,
    failedWriteAttempts: 0,
    distinctSuccessfulReads: 9,
    toolCallsEmitted: true,
    turnCount: 3,
    maxTurns: 12,
    stageRemainingMs: 90_000,
    forceWriteNudgesSent,
  });

  test("read-spiral force_write carries noteKind so the host counter advances", () => {
    const d = decideMidLoopIntervention(spiral(0) as any);
    expect(d.kind).toBe("force_write");
    expect(d.noteKind).toBe("force_write");
  });

  test("read-spiral stops firing at the cap", () => {
    expect(decideMidLoopIntervention(spiral(FORCE_WRITE_NUDGE_CAP) as any).kind)
      .not.toBe("force_write");
  });

  test("the escalated wording is reachable once the counter advances", () => {
    const first = decideMidLoopIntervention(spiral(0) as any);
    const second = decideMidLoopIntervention(spiral(1) as any);
    expect("note" in first && "note" in second).toBe(true);
    expect((first as { note: string }).note)
      .not.toBe((second as { note: string }).note);
  });
});
