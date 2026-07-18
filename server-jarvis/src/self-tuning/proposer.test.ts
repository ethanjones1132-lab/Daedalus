import { expect, test, describe, beforeEach } from "bun:test";
import { SelfTuningProposer } from "./proposer";
import { OutcomeAnalyzer } from "./analyzer";
import { SelfTuningStore, type TuningSuggestion } from "./store";

const TEST_DB_PATH = ":memory:";

/**
 * SelfTuningProposer is the glue between OutcomeAnalyzer (which is fully pinned
 * in analyzer.test.ts as of 2026-07-17) and SelfTuningStore's tuning_proposals
 * table. The proposer is called from server-jarvis/src/index.ts:3277 on every
 * terminal run, with taskType from the route. A regression that drifted any
 * of these observable contracts would silently break the calibration loop:
 *
 *  - the empty-suggestion short-circuit (would write 0 rows, fine, but a
 *    future "always insert a noop proposal" refactor would pollute the table)
 *  - the dedupe key format (proposal_type:task_type:proposed_value) — the
 *    analyzer's `dedupeSuggestions` uses the SAME key format, so the two must
 *    stay in lock-step or a duplicate suggestion would slip through
 *  - the "dedupe only against pending (applied=0)" semantic — a "dedupe
 *    against ALL proposals" regression would permanently block the loop
 *    after the first round of proposals is applied
 *  - the ID format (prop_<uuid>) and applied=0 default
 *  - the field plumbing from suggestion + agentRunId to the stored row
 *
 * This file pins those contracts. Same regression-pin pattern as the
 * approval-store (2026-07-18 afternoon), todo-store (2026-07-17 afternoon),
 * task-run (2026-07-18 4pm), and modes (2026-07-14 evening) contract pins.
 */

interface SeededRun {
  id: string;
  user_rating: number;
  had_error: number;
}

function seedRuns(
  store: SelfTuningStore,
  taskType: string,
  runs: SeededRun[],
): void {
  for (const run of runs) {
    store.insertAgentRun({
      id: run.id,
      session_id: "session_proposer_test",
      user_request: "synthetic for proposer test",
      task_type: taskType,
      pipeline: JSON.stringify(["planner", "executor"]),
      completed: 1,
      final_output: "synthetic",
      user_rating: run.user_rating,
      duration_ms: 100,
      tool_calls_count: 1,
      token_count: 100,
    });
    store.insertStageRun({
      id: `stage_${run.id}`,
      agent_run_id: run.id,
      mode_id: "executor",
      turn_number: 1,
      input_tokens: 10,
      output_tokens: 20,
      tool_calls_json: "[]",
      duration_ms: 100,
      was_successful: run.had_error === 0 ? 1 : 0,
      had_error: run.had_error,
      error_message: run.had_error === 0 ? undefined : "synthetic error",
    });
  }
}

function makeNegativeCodingRuns(count: number): SeededRun[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `run_neg_${i}`,
    user_rating: 1,
    had_error: 1,
  }));
}

function makeNegativeResearchRuns(count: number): SeededRun[] {
  // Distinct run_id namespace from makeNegativeCodingRuns so the two can
  // coexist in the same store without violating the UNIQUE constraint on
  // agent_runs.id (relevant for test 6, which seeds both task types).
  return Array.from({ length: count }, (_, i) => ({
    id: `run_res_${i}`,
    user_rating: 1,
    had_error: 1,
  }));
}

describe("SelfTuningProposer", () => {
  let store: SelfTuningStore;

  beforeEach(() => {
    store = new SelfTuningStore(TEST_DB_PATH);
  });

  // ── (1) empty-suggestion short-circuit ────────────────────────────────
  test("returns [] without touching the store when the analyzer has no suggestions", async () => {
    // No runs seeded → analyzer.analyze() short-circuits on the <3-runs gate.
    const proposer = new SelfTuningProposer(store, new OutcomeAnalyzer(store));
    const result = await proposer.proposeAndApply("run_x", "general");
    expect(result).toEqual([]);
    expect(store.getPendingProposals()).toHaveLength(0);
  });

  // ── (2) happy path + field plumbing ───────────────────────────────────
  test("happy path: emits one proposal with all suggestion fields + agentRunId, applied=0", async () => {
    seedRuns(store, "coding", makeNegativeCodingRuns(3));
    const proposer = new SelfTuningProposer(store, new OutcomeAnalyzer(store));

    const result = await proposer.proposeAndApply("run_caller_42", "coding");

    expect(result.length).toBeGreaterThan(0);
    const tempProp = result.find((p) => p.proposal_type === "temperature");
    expect(tempProp).toBeDefined();
    expect(tempProp!.agent_run_id).toBe("run_caller_42");
    expect(tempProp!.task_type).toBe("coding");
    expect(tempProp!.applied).toBe(0);
    // current_value / proposed_value are stringified in the analyzer.
    // 0.3 - 0.1 in JS is 0.19999999999999998 (IEEE-754 noise) — String()
    // of that is "0.19999999999999998", not "0.2". Use toBeCloseTo via
    // Number() to compare semantically.
    expect(Number(tempProp!.proposed_value)).toBeCloseTo(0.2, 10);
    expect(Number(tempProp!.current_value)).toBeCloseTo(0.3, 10);
    expect(tempProp!.rationale).toMatch(/rating|error rate/i);

    // And it landed in the pending store
    const pending = store.getPendingProposals();
    expect(pending).toHaveLength(result.length);
    expect(pending.find((p) => p.id === tempProp!.id)).toBeDefined();
  });

  // ── (3) ID format ─────────────────────────────────────────────────────
  test("proposal id format is prop_<uuid>", async () => {
    seedRuns(store, "coding", makeNegativeCodingRuns(3));
    const proposer = new SelfTuningProposer(store, new OutcomeAnalyzer(store));

    const result = await proposer.proposeAndApply("run_caller", "coding");

    for (const p of result) {
      expect(p.id).toMatch(/^prop_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  // ── (4) dedupe key format ─────────────────────────────────────────────
  test("dedupe key uses proposal_type:task_type:proposed_value (matches analyzer)", async () => {
    // We pin this by proving the observable consequence: re-running with the
    // same suggestion does NOT add a second row. The internal key format
    // matches analyzer.dedupeSuggestions' format (`proposal_type:task_type:proposed_value`)
    // so a drift in the proposer's key format would surface as a duplicate row.
    seedRuns(store, "coding", makeNegativeCodingRuns(3));
    const proposer = new SelfTuningProposer(store, new OutcomeAnalyzer(store));

    await proposer.proposeAndApply("run_first", "coding");
    const firstCount = store.getPendingProposals().length;
    expect(firstCount).toBeGreaterThan(0);

    // Re-running for the same task type with the same suggestion shape should
    // not add duplicates, because the dedupe check sees the same key.
    await proposer.proposeAndApply("run_second", "coding");
    const secondCount = store.getPendingProposals().length;
    expect(secondCount).toBe(firstCount);
  });

  // ── (5) dedupe only against pending (applied=0) ───────────────────────
  test("a previously-applied proposal does NOT block re-proposing the same key", async () => {
    // This is the critical regression guard: a "dedupe against ALL proposals"
    // refactor would permanently disable the calibration loop after one round.
    seedRuns(store, "coding", makeNegativeCodingRuns(3));
    const proposer = new SelfTuningProposer(store, new OutcomeAnalyzer(store));

    const first = await proposer.proposeAndApply("run_first", "coding");
    expect(first.length).toBeGreaterThan(0);

    // Apply every proposal that was just emitted
    for (const p of first) {
      store.applyTuningProposal(p.id);
    }
    expect(store.getPendingProposals()).toHaveLength(0);
    expect(store.getAppliedProposals()).toHaveLength(first.length);

    // Re-running with the same analyzer signal — the loop MUST still fire,
    // because applied=1 rows are no longer in the "pending" set that the
    // dedupe check inspects.
    const second = await proposer.proposeAndApply("run_second", "coding");
    expect(second.length).toBeGreaterThan(0);
    // The new proposals are distinct IDs (re-randomized) but live alongside
    // the now-applied originals.
    const newIds = second.map((p) => p.id);
    const oldIds = first.map((p) => p.id);
    for (const newId of newIds) {
      expect(oldIds).not.toContain(newId);
    }
    expect(store.getPendingProposals()).toHaveLength(second.length);
  });

  // ── (6) different task_types are independent ──────────────────────────
  test("a pending temperature:coding proposal does NOT block a temperature:research proposal", async () => {
    // Use distinct run_id namespaces per task type so the UNIQUE constraint
    // on agent_runs.id / stage_runs.id doesn't fire within the same test.
    seedRuns(store, "coding", makeNegativeCodingRuns(3)); // run_neg_0/1/2
    seedRuns(store, "research", makeNegativeResearchRuns(3)); // run_res_0/1/2
    const proposer = new SelfTuningProposer(store, new OutcomeAnalyzer(store));

    const codingProps = await proposer.proposeAndApply("run_c", "coding");
    expect(codingProps.find((p) => p.task_type === "coding")).toBeDefined();
    expect(codingProps.find((p) => p.task_type === "research")).toBeUndefined();

    const researchProps = await proposer.proposeAndApply("run_r", "research");
    expect(researchProps.find((p) => p.task_type === "research")).toBeDefined();

    // Both rows present
    const allPending = store.getPendingProposals();
    expect(allPending.filter((p) => p.task_type === "coding")).toHaveLength(
      codingProps.length,
    );
    expect(allPending.filter((p) => p.task_type === "research")).toHaveLength(
      researchProps.length,
    );
  });

  // ── (7) the proposer's per-call dedupe is against the STORE, not the loop ──
  test("the proposer's dedupe is against the store's pre-existing pending rows, NOT within the call (analyzer's job)", async () => {
    // Pinned: when the analyzer's own `dedupeSuggestions` (analyzer.ts:75-85)
    // is bypassed and N identical suggestions are returned in one call, the
    // proposer's per-call loop does NOT collapse them — it inserts N rows.
    // The proposer's `existing` set is built from `getPendingProposals()` at
    // call start (line 22-24), so within-batch duplicates flow through.
    // This is the actual contract: the analyzer is the single source of
    // truth for in-batch dedupe, the proposer is the single source of
    // truth for cross-call dedupe.
    seedRuns(store, "coding", makeNegativeCodingRuns(3));

    const dupSuggestion: TuningSuggestion = {
      proposal_type: "temperature",
      task_type: "coding",
      current_value: "0.3",
      proposed_value: "0.2",
      rationale: "synthetic duplicate",
    };

    const stubAnalyzer = {
      analyze: () => [dupSuggestion, dupSuggestion, dupSuggestion],
    };

    const proposer = new SelfTuningProposer(store, stubAnalyzer as unknown as OutcomeAnalyzer);
    const result = await proposer.proposeAndApply("run_dup", "coding");

    // Three identical-key suggestions in one call all flow through.
    // (The analyzer would have collapsed them; the proposer doesn't.)
    expect(result).toHaveLength(3);
    expect(store.getPendingProposals()).toHaveLength(3);
    // All three have distinct ids (the proposal_id is freshly random per row).
    const ids = new Set(result.map((p) => p.id));
    expect(ids.size).toBe(3);
  });

  // ── (8) every emitted proposal is findable in pending by id ───────────
  test("every returned proposal is findable in getPendingProposals() by id", async () => {
    seedRuns(store, "coding", makeNegativeCodingRuns(3));
    const proposer = new SelfTuningProposer(store, new OutcomeAnalyzer(store));

    const result = await proposer.proposeAndApply("run_check", "coding");
    const pending = store.getPendingProposals();
    const pendingIds = new Set(pending.map((p) => p.id));
    for (const p of result) {
      expect(pendingIds.has(p.id)).toBe(true);
    }
    // Symmetric: every pending row was returned by the call
    const resultIds = new Set(result.map((p) => p.id));
    for (const p of pending) {
      expect(resultIds.has(p.id)).toBe(true);
    }
  });

  // ── (9) caller-controlled agentRunId wins over what's in the store ───
  test("the agent_run_id stored on each proposal is the caller-supplied runId, not anything from the analyzer", async () => {
    seedRuns(store, "coding", makeNegativeCodingRuns(3));
    const proposer = new SelfTuningProposer(store, new OutcomeAnalyzer(store));

    // Pass an agentRunId that is NOT present in the seeded runs — the
    // proposer should still attribute the proposals to it, because the
    // agentRunId is a free-form caller label, not a join target.
    const synthetic = "run_outer_attribution_xyz";
    const result = await proposer.proposeAndApply(synthetic, "coding");

    expect(result.length).toBeGreaterThan(0);
    for (const p of result) {
      expect(p.agent_run_id).toBe(synthetic);
    }
    // And the store agrees
    const pending = store.getPendingProposals();
    for (const p of pending) {
      expect(p.agent_run_id).toBe(synthetic);
    }
  });

  // ── (10) restrict_tools fires alongside temperature when both signals
  //       are present (so the proposer's loop emits more than one row)
  test("emits BOTH temperature AND restrict_tools when both signals fire (low rating + high error rate)", async () => {
    // 3 runs with user_rating=1 (avgRating=1 < 2.5) AND had_error=1 (stageErrors=1.0 > 0.3)
    // — both the temperature trigger AND the restrict_tools compound gate should fire.
    seedRuns(store, "coding", makeNegativeCodingRuns(3));
    const proposer = new SelfTuningProposer(store, new OutcomeAnalyzer(store));

    const result = await proposer.proposeAndApply("run_both", "coding");

    const types = new Set(result.map((p) => p.proposal_type));
    expect(types.has("temperature")).toBe(true);
    expect(types.has("restrict_tools")).toBe(true);
    expect(result).toHaveLength(2);
  });

  // ── (11) initializeTunedConfigs() is a no-op (documented contract) ────
  test("initializeTunedConfigs() does not insert any proposals", () => {
    seedRuns(store, "coding", makeNegativeCodingRuns(3));
    const proposer = new SelfTuningProposer(store, new OutcomeAnalyzer(store));

    proposer.initializeTunedConfigs();

    // No proposals should be inserted by this hook — the implementation
    // comment says it's a no-op kept for call-site stability.
    expect(store.getPendingProposals()).toHaveLength(0);
  });

  // ── (12) default constructor (no store/analyzer) uses the shared singletons ──
  test("default constructor uses SelfTuningStore + OutcomeAnalyzer defaults (no override needed)", () => {
    // This is the same shape that index.ts:2893 / 3277 use via the
    // `selfTuningProposer` singleton at the bottom of proposer.ts. We can't
    // exercise the default constructor against the production DB (that would
    // be a regression), but we CAN assert that the default constructor
    // doesn't throw and that proposeAndApply works on a fresh :memory: store
    // when both dependencies are explicitly overridden.
    const freshStore = new SelfTuningStore(TEST_DB_PATH);
    const proposer = new SelfTuningProposer(); // no args
    // The default-constructed proposer holds a reference to the live
    // production self-tuning.db. We do NOT call proposeAndApply on it; we
    // only assert that construction succeeded (the singleton is usable).
    expect(proposer).toBeInstanceOf(SelfTuningProposer);
    // And a separately-constructed proposer with explicit dependencies still
    // behaves correctly (the only path we want to exercise in unit tests).
    seedRuns(freshStore, "coding", makeNegativeCodingRuns(3));
    const explicitProposer = new SelfTuningProposer(
      freshStore,
      new OutcomeAnalyzer(freshStore),
    );
    return explicitProposer.proposeAndApply("run_explicit", "coding").then(
      (result) => {
        expect(result.length).toBeGreaterThan(0);
      },
    );
  });
});
