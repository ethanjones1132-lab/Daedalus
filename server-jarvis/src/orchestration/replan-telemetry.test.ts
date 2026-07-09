// server-jarvis/src/orchestration/replan-telemetry.test.ts
// ═══════════════════════════════════════════════════════════════
// B-04 (Track B, Conductor Recursive Self-Selection): pins the
// `SessionReplanCounter` and `segmentOutcomeFromCarry` contracts so
// a future "switch to SQL-backed counter" or "drop the
// per-session cap" refactor cannot silently regress production
// budget semantics. All tests use a fake store (or `null`) so the
// suite never touches the production self-tuning DB.
// ═══════════════════════════════════════════════════════════════

import { describe, expect, it } from "bun:test";
import { SessionReplanCounter, segmentOutcomeFromCarry } from "./replan-telemetry";
import type { RecordReplanInput } from "./replan-telemetry";
import type { CoordinatorResult } from "./coordinator";
import type { PipelineStageState } from "./stage-output";
import type { ReplanEvent } from "../self-tuning/store";

// ── Fakes ────────────────────────────────────────────────────

class FakeStore {
  events: ReplanEvent[] = [];
  insertCalls = 0;
  insertReplanEvent(ev: ReplanEvent): void {
    this.insertCalls += 1;
    this.events.push({ ...ev });
  }
}

function baseDecision(overrides: Partial<CoordinatorResult> = {}): CoordinatorResult {
  return {
    task_type: "debug",
    pipeline: ["executor", "synthesizer"],
    topology: "linear",
    context: { needs_workspace_inspection: true, needs_memory: false, estimated_complexity: "medium" },
    coordinator_rationale: "fixture rationale",
    ...overrides,
  };
}

function baseInput(overrides: Partial<RecordReplanInput> = {}): RecordReplanInput {
  return {
    sessionId: "s1",
    agentRunId: "run-1",
    replanIndex: 1,
    rationale: "the executor returned empty",
    revised: baseDecision(),
    segmentOutcome: "degraded",
    cap: "",
    ...overrides,
  };
}

// ── SessionReplanCounter ─────────────────────────────────────

describe("SessionReplanCounter — used / remaining", () => {
  it("returns 0 used for an unknown session", () => {
    const c = new SessionReplanCounter({ maxPerSession: 6 });
    expect(c.used("nope")).toBe(0);
    expect(c.remaining("nope")).toBe(6);
  });

  it("remaining is never negative even after the cap is exceeded", () => {
    const c = new SessionReplanCounter({ maxPerSession: 2 });
    c.record(baseInput());
    c.record(baseInput());
    c.record(baseInput()); // over-spend
    c.record(baseInput()); // over-spend again
    expect(c.used("s1")).toBe(4);
    expect(c.remaining("s1")).toBe(0);
  });

  it("counters are per-session — recording on s1 does not touch s2", () => {
    const c = new SessionReplanCounter({ maxPerSession: 6 });
    c.record(baseInput({ sessionId: "s1" }));
    c.record(baseInput({ sessionId: "s1" }));
    expect(c.used("s1")).toBe(2);
    expect(c.used("s2")).toBe(0);
    expect(c.remaining("s2")).toBe(6);
  });

  it("clamps a negative maxPerSession to 0", () => {
    const c = new SessionReplanCounter({ maxPerSession: -3 });
    expect(c.used("s1")).toBe(0);
    expect(c.remaining("s1")).toBe(0);
    c.record(baseInput());
    expect(c.used("s1")).toBe(1);
    expect(c.remaining("s1")).toBe(0);
  });
});

describe("SessionReplanCounter — effectivePerTurnCap", () => {
  it("returns the smaller of callerPerTurnMax and maxPerSession", () => {
    const c = new SessionReplanCounter({ maxPerSession: 6 });
    expect(c.effectivePerTurnCap("s1", 2)).toBe(2);
    expect(c.effectivePerTurnCap("s1", 10)).toBe(6);
  });

  it("returns maxPerSession (NOT remaining) for an already-spent session", () => {
    // The contract is documented: the cap means "up to N replans per turn",
    // not "up to N minus what's already used in earlier turns of the same
    // session". The session's `remaining()` is checked separately as the
    // `sessionCapHit` signal.
    const c = new SessionReplanCounter({ maxPerSession: 6 });
    c.record(baseInput());
    c.record(baseInput());
    c.record(baseInput());
    expect(c.used("s1")).toBe(3);
    expect(c.effectivePerTurnCap("s1", 2)).toBe(2);
  });

  it("clamps a negative callerPerTurnMax to 0", () => {
    const c = new SessionReplanCounter({ maxPerSession: 6 });
    expect(c.effectivePerTurnCap("s1", -1)).toBe(0);
  });
});

describe("SessionReplanCounter — record / persistence", () => {
  it("returns the next 1-indexed replan_index after each call", () => {
    const c = new SessionReplanCounter({ maxPerSession: 6 });
    expect(c.record(baseInput({ replanIndex: 1 }))).toBe(1);
    expect(c.record(baseInput({ replanIndex: 2 }))).toBe(2);
    expect(c.record(baseInput({ replanIndex: 3 }))).toBe(3);
  });

  it("works with store: null (in-process only, no DB write)", () => {
    const c = new SessionReplanCounter({ maxPerSession: 6, store: null });
    // Should not throw.
    const next = c.record(baseInput());
    expect(next).toBe(1);
    expect(c.used("s1")).toBe(1);
  });

  it("with a store: writes one ReplanEvent per record() with the documented fields", () => {
    const store = new FakeStore();
    const c = new SessionReplanCounter({ maxPerSession: 6, store: store as any });
    const input = baseInput({
      sessionId: "s-7",
      agentRunId: "run-42",
      rationale: "executor returned empty",
      revised: baseDecision({
        pipeline: ["executor", "reviewer", "synthesizer"],
        worker_instructions: { executor: { hint: "be terse" }, reviewer: { hint: "be strict" } },
      }),
      segmentOutcome: "degraded",
      cap: "per_turn",
    });
    const next = c.record(input);
    expect(next).toBe(1);
    expect(store.insertCalls).toBe(1);
    const ev = store.events[0];
    expect(ev.id).toBe("replan-run-42-1");
    expect(ev.agent_run_id).toBe("run-42");
    expect(ev.session_id).toBe("s-7");
    expect(ev.replan_index).toBe(1);
    expect(ev.rationale).toBe("executor returned empty");
    expect(ev.revised_pipeline).toBe('["executor","reviewer","synthesizer"]');
    expect(ev.revised_worker_instructions_keys).toBe("executor,reviewer");
    expect(ev.segment_outcome).toBe("degraded");
    expect(ev.capped).toBe("per_turn");
  });

  it("truncates a long rationale to 500 chars with a '...' suffix", () => {
    const store = new FakeStore();
    const c = new SessionReplanCounter({ maxPerSession: 6, store: store as any });
    const long = "x".repeat(800);
    c.record(baseInput({ rationale: long }));
    const ev = store.events[0];
    expect(ev.rationale.length).toBe(500);
    expect(ev.rationale.endsWith("...")).toBe(true);
    expect(ev.rationale.startsWith("x".repeat(497))).toBe(true);
  });

  it("leaves a short rationale untouched", () => {
    const store = new FakeStore();
    const c = new SessionReplanCounter({ maxPerSession: 6, store: store as any });
    c.record(baseInput({ rationale: "short" }));
    expect(store.events[0].rationale).toBe("short");
  });

  it("uses '' for revised_worker_instructions_keys when worker_instructions is absent", () => {
    const store = new FakeStore();
    const c = new SessionReplanCounter({ maxPerSession: 6, store: store as any });
    c.record(baseInput({ revised: baseDecision() })); // no worker_instructions
    expect(store.events[0].revised_worker_instructions_keys).toBe("");
  });

  it("sorts the worker_instructions keys alphabetically for stable grep-ability", () => {
    const store = new FakeStore();
    const c = new SessionReplanCounter({ maxPerSession: 6, store: store as any });
    c.record(baseInput({
      revised: baseDecision({
        // Intentionally non-alphabetical input order.
        worker_instructions: { synthesizer: { a: 1 }, executor: { b: 2 }, reviewer: { c: 3 } },
      }),
    }));
    expect(store.events[0].revised_worker_instructions_keys).toBe("executor,reviewer,synthesizer");
  });

  it("serializes revised_pipeline as a JSON array of the stage list", () => {
    const store = new FakeStore();
    const c = new SessionReplanCounter({ maxPerSession: 6, store: store as any });
    c.record(baseInput({ revised: baseDecision({ pipeline: ["planner", "executor"] }) }));
    expect(store.events[0].revised_pipeline).toBe('["planner","executor"]');
  });

  it("serializes revised_pipeline as [] when the decision has no pipeline", () => {
    const store = new FakeStore();
    const c = new SessionReplanCounter({ maxPerSession: 6, store: store as any });
    c.record(baseInput({ revised: baseDecision({ pipeline: undefined as any }) }));
    expect(store.events[0].revised_pipeline).toBe("[]");
  });
});

describe("SessionReplanCounter — clearSession", () => {
  it("removes the session and frees the budget", () => {
    const c = new SessionReplanCounter({ maxPerSession: 2 });
    c.record(baseInput());
    c.record(baseInput());
    expect(c.used("s1")).toBe(2);
    c.clearSession("s1");
    expect(c.used("s1")).toBe(0);
    expect(c.remaining("s1")).toBe(2);
  });

  it("is a no-op for an unknown session", () => {
    const c = new SessionReplanCounter({ maxPerSession: 2 });
    expect(() => c.clearSession("never-seen")).not.toThrow();
  });

  it("does not touch other sessions", () => {
    const c = new SessionReplanCounter({ maxPerSession: 2 });
    c.record(baseInput({ sessionId: "s1" }));
    c.record(baseInput({ sessionId: "s2" }));
    c.clearSession("s1");
    expect(c.used("s1")).toBe(0);
    expect(c.used("s2")).toBe(1);
  });
});

describe("SessionReplanCounter — totalUsed", () => {
  it("sums used counts across all live sessions", () => {
    const c = new SessionReplanCounter({ maxPerSession: 6 });
    c.record(baseInput({ sessionId: "s1" }));
    c.record(baseInput({ sessionId: "s1" }));
    c.record(baseInput({ sessionId: "s2" }));
    expect(c.totalUsed()).toBe(3);
  });

  it("returns 0 when no session has recorded anything", () => {
    const c = new SessionReplanCounter({ maxPerSession: 6 });
    expect(c.totalUsed()).toBe(0);
  });
});

// ── segmentOutcomeFromCarry ──────────────────────────────────

describe("segmentOutcomeFromCarry", () => {
  it("returns 'success' when neither plan nor executor is set", () => {
    expect(segmentOutcomeFromCarry({})).toBe("success");
  });

  it("returns 'success' when both plan and executor are ok", () => {
    const carry: PipelineStageState = {
      plan: { ok: true } as any,
      executor: { ok: true } as any,
    };
    expect(segmentOutcomeFromCarry(carry)).toBe("success");
  });

  it("returns 'degraded' when plan.ok is false (executor ok or absent)", () => {
    const carry: PipelineStageState = { plan: { ok: false } as any };
    expect(segmentOutcomeFromCarry(carry)).toBe("degraded");
  });

  it("returns 'degraded' when executor.ok is false (plan ok or absent)", () => {
    const carry: PipelineStageState = { executor: { ok: false } as any };
    expect(segmentOutcomeFromCarry(carry)).toBe("degraded");
  });

  it("returns 'degraded' when BOTH plan and executor are not ok", () => {
    const carry: PipelineStageState = {
      plan: { ok: false } as any,
      executor: { ok: false } as any,
    };
    expect(segmentOutcomeFromCarry(carry)).toBe("degraded");
  });

  it("treats a plan with no `ok` field as DEGRADED (the truthy-check is on `carry.plan`, not on `carry.plan.ok`)", () => {
    // The implementation uses `carry.plan ? !carry.plan.ok : false`. The
    // guard is on the *existence* of `carry.plan` (a nullish plan is
    // considered not-yet-executed, success), but a *present-but-missing-ok*
    // plan is treated as a failed plan because `!undefined === true`.
    // Pin that explicit (and slightly surprising) behavior so a future
    // tightening of the check is intentional, not silent.
    const carry: PipelineStageState = { plan: {} as any };
    expect(segmentOutcomeFromCarry(carry)).toBe("degraded");
  });

  it("treats an executor with no `ok` field as DEGRADED (same truthy-on-existence rule)", () => {
    const carry: PipelineStageState = { executor: {} as any };
    expect(segmentOutcomeFromCarry(carry)).toBe("degraded");
  });
});
