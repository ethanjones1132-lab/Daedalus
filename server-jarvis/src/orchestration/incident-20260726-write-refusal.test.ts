import { describe, expect, test } from "bun:test";
import { hasWriteIntent, resolveTurnRequirement } from "./turn-requirements";
import { resolveTaskRunTurn, sharesObjectiveSignal } from "./task-run";
import { decideMidLoopIntervention } from "./mid-loop-intervention";
import type { MidLoopSignal } from "./mid-loop-intervention";

/**
 * 2026-07-26 live session (self-tuning.db session c5f1a360): four escalating
 * write orders produced exactly ONE successful file edit across 73 tool calls.
 *
 * The runtime was not "refusing" at the model layer — `hasWriteIntent` returned
 * false for the user's most explicit demand, and `requiresWriteEffect` gates
 * mid-loop supervision (pipeline.ts), the write-effect nudge (effect-gate.ts),
 * delegate eligibility (claude-delegate.ts) and the effect gate's own verdict.
 * One false collapsed all four, and the zero-write turn shipped as `success`.
 *
 * These tests pin the exact messages from that session.
 */

/** Verbatim user turns from session c5f1a360, in order. */
const SESSION_TURNS = [
  "Read the implementation plan in this folder",
  "read the implementation plan please",
  "try again, read the rest of the file",
  "Begin implementing phase 1. Stop after completing task 1.7",
  "Retry, implement the fixes this time. It is required",
  "Actually edit the files bud, phase 1 is ago please",
  "Begin implementing phase 2, full execution",
] as const;

describe("hasWriteIntent: anaphoric mutation objects", () => {
  // run_247d1cf1: zero writes, labeled success, because this returned false.
  test("'Retry, implement the fixes this time' is write intent", () => {
    expect(hasWriteIntent("Retry, implement the fixes this time. It is required")).toBe(true);
  });

  test.each([
    "implement the fixes",
    "apply the fixes",
    "apply the fix",
    "make the fixes",
    "just do the edits",
    "implement the changes",
  ])("%p is write intent", (message) => {
    expect(hasWriteIntent(message)).toBe(true);
  });

  // The plural-target widening must not grant write authority to questions or
  // to explicitly read-only framings.
  test.each([
    "what were the fixes you made?",
    "explain the fixes in this file",
    "summarize the changes without editing anything",
    "do not apply the fixes yet",
    "read the implementation plan please",
  ])("%p is NOT write intent", (message) => {
    expect(hasWriteIntent(message)).toBe(false);
  });
});

describe("task-run: write intent survives the whole session", () => {
  /** Replay the session the way index.ts drives it, turn by turn. */
  function replay(turns: readonly string[]) {
    let contract: ReturnType<typeof resolveTaskRunTurn>["contract"] | undefined;
    return turns.map((message) => {
      const live = Boolean(
        contract && !["completed", "failed", "cancelled"].includes(contract.status),
      );
      const requirement = resolveTurnRequirement(
        message,
        contract?.requirement,
        live,
      ).result.requirement;
      const resolved = resolveTaskRunTurn(contract, message, requirement, {
        sessionId: "c5f1a360",
        workspacePath: "C:/Users/ethan/Downloads/Perihelion",
      });
      contract = resolved.contract;
      return {
        message,
        requirement,
        isContinuation: resolved.isContinuation,
        writeIntent: contract.writeIntent === true,
      };
    });
  }

  test("a write order escalates a read task run's contract", () => {
    // Turn 4 follows three read turns. `writeIntent` was false because the
    // continuation branch tested the PRIOR contract's requirement, so a
    // read->write escalation could never arm the contract.
    const replayed = replay(SESSION_TURNS.slice(0, 4));
    const phase1 = replayed[3]!;
    expect(phase1.requirement).toBe("full_execution");
    expect(phase1.writeIntent).toBe(true);
  });

  test("every turn from 'Begin implementing phase 1' onward carries write intent", () => {
    const replayed = replay(SESSION_TURNS);
    for (const turn of replayed.slice(3)) {
      expect({ message: turn.message, writeIntent: turn.writeIntent })
        .toEqual({ message: turn.message, writeIntent: true });
    }
  });

  test("the read turns before the first write order stay read-only", () => {
    const replayed = replay(SESSION_TURNS);
    for (const turn of replayed.slice(0, 3)) {
      expect({ message: turn.message, writeIntent: turn.writeIntent })
        .toEqual({ message: turn.message, writeIntent: false });
    }
  });

  test("escalating a read run to execution adopts the work order as objective", () => {
    let contract: ReturnType<typeof resolveTaskRunTurn>["contract"] | undefined;
    for (const message of SESSION_TURNS.slice(0, 4)) {
      const live = Boolean(
        contract && !["completed", "failed", "cancelled"].includes(contract.status),
      );
      const requirement = resolveTurnRequirement(
        message,
        contract?.requirement,
        live,
      ).result.requirement;
      contract = resolveTaskRunTurn(contract, message, requirement, {
        sessionId: "c5f1a360",
      }).contract;
    }
    // Was "try again, read the rest of the file" for the rest of the session.
    expect(contract!.objective).toBe(
      "Begin implementing phase 1. Stop after completing task 1.7",
    );
  });

  test("'Retry, implement the fixes' continues the phase-1 run", () => {
    // It minted a NEW task run: significantTokens matched "implementing"
    // against "implement" as distinct tokens, so sharesObjectiveSignal failed
    // and every sticky property (workspace, depth, write intent) was lost.
    const replayed = replay(SESSION_TURNS.slice(0, 5));
    expect(replayed[4]!.isContinuation).toBe(true);
  });
});

describe("sharesObjectiveSignal: inflected forms are the same topic", () => {
  test("'implement' matches an objective that said 'implementing'", () => {
    expect(sharesObjectiveSignal(
      "Begin implementing phase 1. Stop after completing task 1.7",
      "Retry, implement the fixes this time. It is required",
    )).toBe(true);
  });

  test("unrelated substantial requests still do not continue", () => {
    expect(sharesObjectiveSignal(
      "Begin implementing phase 1. Stop after completing task 1.7",
      "create a different spreadsheet in another directory for invoices",
    )).toBe(false);
  });
});

describe("mid-loop: the read spiral is broken before the budget runs out", () => {
  function signal(overrides: Partial<MidLoopSignal> = {}): MidLoopSignal {
    return {
      writeIntent: true,
      successfulWrites: 0,
      distinctSuccessfulReads: 0,
      failedWriteAttempts: 0,
      turnCount: 3,
      maxTurns: 14,
      stageRemainingMs: 400_000,
      deadToolSuppressed: false,
      afterReroute: false,
      ...overrides,
    } as MidLoopSignal;
  }

  test("5 reads and zero writes forces a write even with a full budget", () => {
    // run_f5c966fc: ~10 reads, zero edit_file calls, and every checkpoint
    // returned `continue` because the reflex was gated behind a 150s floor.
    const decision = decideMidLoopIntervention(
      signal({ distinctSuccessfulReads: 5, stageRemainingMs: 400_000 }),
    );
    expect(decision.kind).toBe("force_write");
  });

  test("the force-write note leads with the write, not another read", () => {
    const decision = decideMidLoopIntervention(
      signal({ distinctSuccessfulReads: 6, stageRemainingMs: 400_000 }),
    );
    const note = "note" in decision ? decision.note : "";
    // The old note began "Re-read the exact target path ..." and fired ~22
    // times verbatim; the executor obeyed the first clause every time.
    expect(note.toLowerCase()).not.toMatch(/^\W*re-?read/);
    expect(note).toMatch(/edit_file|write_file/);
  });

  test("a stale benchmark artifact is not injected into unrelated tasks", () => {
    const decision = decideMidLoopIntervention(
      signal({ failedWriteAttempts: 1, stageRemainingMs: 400_000 }),
    );
    const note = "note" in decision ? decision.note : "";
    // `_t.py` is a tier-2B fixture name. It was injected ~22 times into a
    // C++ JUCE plugin task on 2026-07-26.
    expect(note).not.toContain("_t.py");
  });

  test("repeat spirals escalate instead of repeating the same sentence", () => {
    // 2026-08-04: FORCE_WRITE_NUDGE_CAP is 2 — second allowed nudge is sent=1.
    const first = decideMidLoopIntervention(
      signal({ distinctSuccessfulReads: 5, forceWriteNudgesSent: 0 }),
    );
    const later = decideMidLoopIntervention(
      signal({ distinctSuccessfulReads: 12, forceWriteNudgesSent: 1 }),
    );
    const firstNote = "note" in first ? first.note : "";
    const laterNote = "note" in later ? later.note : "";
    expect(laterNote).not.toBe(firstNote);
    expect(laterNote.toLowerCase()).toMatch(/stop reading|do not call read|no more read/);
  });

  test("a nearly-exhausted budget still aborts rather than nudging", () => {
    const decision = decideMidLoopIntervention(
      signal({ distinctSuccessfulReads: 8, stageRemainingMs: 20_000 }),
    );
    expect(decision.kind).toBe("abort");
  });

  test("reads without write intent are never pressed", () => {
    const decision = decideMidLoopIntervention(
      signal({ writeIntent: false, distinctSuccessfulReads: 9 }),
    );
    expect(decision.kind).toBe("continue");
  });
});
