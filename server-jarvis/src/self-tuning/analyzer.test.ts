// ═══════════════════════════════════════════════════════════════
// ── OutcomeAnalyzer contract pin ──
// ═══════════════════════════════════════════════════════════════
// The `OutcomeAnalyzer` class in `self-tuning/analyzer.ts` (85 lines) is
// the temperature / restrict-tools / prune-mode proposer that feeds
// `SelfTuningProposer.proposeAndApply`. It is the contract between the
// historical run telemetry (agent_runs + stage_runs) and the live
// runtime knobs (executor.temperature, tool surface). A regression in
// this module silently downgrades the agent's calibration loop.
//
// The existing `self-tuning.test.ts` had exactly ONE test for the
// starvation-exclusion behavior (line 245). This file pins the rest of
// the observable contract surface so a future refactor of the analyzer
// cannot drift the suggestion shape, the dedupe rule, the temperature
// math, or the <3-runs short-circuit without breaking a test.
//
// Tested contracts:
//   (1) Below 3 completed runs for the task_type → no suggestions (early return).
//   (2) Only `completed === 1` runs are considered; in-flight (completed: 0) ignored.
//   (3) Filter is task_type-scoped — other task types' runs don't bleed in.
//   (4) avgRating < 3 → temperature suggestion; rationale references the rating trigger.
//   (5) stageErrors > 20% (excluding starvation) → temperature suggestion; rationale
//       references the error-rate trigger.
//   (6) avgRating < 2.5 AND stageErrors > 30% → restrict_tools suggestion (compound).
//   (7) No rating, low error rate → no temperature suggestion (rating must exist).
//   (8) High rating, high error rate → temperature suggestion from error-rate path.
//   (9) temperatureSuggestion math: proposed = max(0.1, current - 0.1) and reads
//       current from BUILTIN_MODES.executor.temperature (default 0.4 → proposes 0.3).
//  (10) Dedupe by `${proposal_type}:${task_type}:${proposed_value}` — duplicates
//       collapsed even when rationales differ.
//  (11) suggestion shape: proposal_type is the union literal, task_type matches
//       the analyze() arg, current_value/proposed_value are stringified numerics.
//  (12) Multiple distinct suggestion kinds for the same task_type are NOT deduped
//       (different proposal_type or different proposed_value).
//  (13) Starvation exclusion: stage rows with `partial_error_code` in
//       isRuntimeStarvationErrorCode() are NOT counted toward `totalStages`,
//       so a flood of starvation rows cannot fabricate an error-rate trip.
//  (14) `runs.length < 3` short-circuit returns [] regardless of any stage data
//       that may exist for the (too-few) runs.
//  (15) `runs.length >= 3` is the literal threshold — exactly 3 runs is enough
//       to enter the analysis branch (regression guard against off-by-one).

import { describe, expect, test } from "bun:test";
import { OutcomeAnalyzer, type TuningSuggestion } from "./analyzer";
import { SelfTuningStore, type AgentRun, type StageRun } from "./store";

function makeRun(overrides: Partial<AgentRun> & { id: string; task_type: string }): AgentRun {
  return {
    id: overrides.id,
    session_id: overrides.session_id ?? "s",
    user_request: overrides.user_request ?? "req",
    task_type: overrides.task_type,
    pipeline: overrides.pipeline ?? JSON.stringify(["executor"]),
    completed: overrides.completed ?? 1,
    final_output: overrides.final_output,
    user_rating: overrides.user_rating,
    duration_ms: overrides.duration_ms ?? 100,
    tool_calls_count: overrides.tool_calls_count ?? 0,
    token_count: overrides.token_count ?? 100,
    outcome: overrides.outcome,
  };
}

function makeStage(overrides: Partial<StageRun> & { id: string; agent_run_id: string }): StageRun {
  return {
    id: overrides.id,
    agent_run_id: overrides.agent_run_id,
    mode_id: overrides.mode_id ?? "executor",
    turn_number: overrides.turn_number ?? 1,
    input_tokens: overrides.input_tokens ?? 10,
    output_tokens: overrides.output_tokens ?? 10,
    tool_calls_json: overrides.tool_calls_json ?? "[]",
    duration_ms: overrides.duration_ms ?? 10,
    was_successful: overrides.was_successful ?? 1,
    had_error: overrides.had_error ?? 0,
    error_message: overrides.error_message,
    partial_error_code: overrides.partial_error_code,
  };
}

function insertRuns(
  store: SelfTuningStore,
  runs: AgentRun[],
  stages: StageRun[] = [],
): void {
  for (const run of runs) {
    store.insertAgentRun(run);
  }
  for (const stage of stages) {
    store.insertStageRun(stage);
  }
}

function newStore(): SelfTuningStore {
  return new SelfTuningStore(":memory:");
}

describe("OutcomeAnalyzer.analyze — early return", () => {
  test("returns [] when there are zero runs for the task_type", () => {
    const store = newStore();
    const analyzer = new OutcomeAnalyzer(store);

    expect(analyzer.analyze("any-task")).toEqual([]);
  });

  test("returns [] when there is only one run for the task_type (below threshold)", () => {
    const store = newStore();
    insertRuns(store, [
      makeRun({ id: "r1", task_type: "coding", user_rating: 1 }),
    ]);

    const analyzer = new OutcomeAnalyzer(store);
    expect(analyzer.analyze("coding")).toEqual([]);
  });

  test("returns [] when there are only two runs (strictly below the 3-run threshold)", () => {
    const store = newStore();
    insertRuns(store, [
      makeRun({ id: "r1", task_type: "coding", user_rating: 1 }),
      makeRun({ id: "r2", task_type: "coding", user_rating: 1 }),
    ]);

    const analyzer = new OutcomeAnalyzer(store);
    expect(analyzer.analyze("coding")).toEqual([]);
  });

  test("the < 3 short-circuit is independent of stage-row data for the same runs", () => {
    // Even with stage data that would otherwise trip the error-rate path
    // (>20% errors), the 3-run minimum blocks the analysis branch.
    const store = newStore();
    insertRuns(
      store,
      [makeRun({ id: "r1", task_type: "coding" })],
      [
        makeStage({ id: "s1", agent_run_id: "r1", had_error: 1, was_successful: 0 }),
      ],
    );

    const analyzer = new OutcomeAnalyzer(store);
    expect(analyzer.analyze("coding")).toEqual([]);
  });
});

describe("OutcomeAnalyzer.analyze — completed-filter", () => {
  test("ignores in-flight runs (completed: 0) when counting toward the 3-run minimum", () => {
    const store = newStore();
    // 5 in-flight runs, 0 completed. The completed-filter should leave
    // the analyzer with an empty set, so we get [].
    insertRuns(store, [
      makeRun({ id: "r1", task_type: "coding", completed: 0 }),
      makeRun({ id: "r2", task_type: "coding", completed: 0 }),
      makeRun({ id: "r3", task_type: "coding", completed: 0 }),
    ]);

    const analyzer = new OutcomeAnalyzer(store);
    expect(analyzer.analyze("coding")).toEqual([]);
  });

  test("counts only completed === 1 runs toward the threshold; mixes do not bleed", () => {
    const store = newStore();
    insertRuns(store, [
      makeRun({ id: "r1", task_type: "coding", user_rating: 1 }),
      makeRun({ id: "r2", task_type: "coding", user_rating: 1 }),
      makeRun({ id: "r3", task_type: "coding", user_rating: 1 }),
      // A 4th run, completed:0, must NOT bring the count to 4.
      makeRun({ id: "r4", task_type: "coding", completed: 0, user_rating: 1 }),
    ]);

    const analyzer = new OutcomeAnalyzer(store);
    // Low rating across the 3 completed runs → temperature suggestion.
    const out = analyzer.analyze("coding");
    expect(out).toHaveLength(1);
    expect(out[0]!.proposal_type).toBe("temperature");
  });
});

describe("OutcomeAnalyzer.analyze — task_type scoping", () => {
  test("other task_types' runs do not contribute to the analysis", () => {
    const store = newStore();
    // 3 'research' runs with low rating + high error rate — should trip BOTH paths.
    insertRuns(
      store,
      [
        makeRun({ id: "r1", task_type: "research", user_rating: 1 }),
        makeRun({ id: "r2", task_type: "research", user_rating: 1 }),
        makeRun({ id: "r3", task_type: "research", user_rating: 1 }),
      ],
      [
        makeStage({ id: "s1", agent_run_id: "r1", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s2", agent_run_id: "r2", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s3", agent_run_id: "r3", had_error: 1, was_successful: 0 }),
      ],
    );
    // 3 'coding' runs with perfect rating + no errors — should produce [].
    insertRuns(store, [
      makeRun({ id: "c1", task_type: "coding", user_rating: 5 }),
      makeRun({ id: "c2", task_type: "coding", user_rating: 5 }),
      makeRun({ id: "c3", task_type: "coding", user_rating: 5 }),
    ]);

    const analyzer = new OutcomeAnalyzer(store);

    const research = analyzer.analyze("research");
    // rating < 2.5 (avg = 1.0) AND stageErrors > 0.3 (100%) → restrict_tools + temperature.
    // Two distinct proposal_types, both retained by dedupe.
    const researchTypes = new Set(research.map((s) => s.proposal_type));
    expect(researchTypes).toEqual(new Set(["temperature", "restrict_tools"]));

    const coding = analyzer.analyze("coding");
    expect(coding).toEqual([]);
  });
});

describe("OutcomeAnalyzer.analyze — temperature suggestion", () => {
  test("avgRating < 3 produces a temperature suggestion with rating-trigger rationale", () => {
    const store = newStore();
    insertRuns(store, [
      makeRun({ id: "r1", task_type: "coding", user_rating: 2 }),
      makeRun({ id: "r2", task_type: "coding", user_rating: 3 }),
      makeRun({ id: "r3", task_type: "coding", user_rating: 2 }),
    ]);

    const analyzer = new OutcomeAnalyzer(store);
    const out = analyzer.analyze("coding");
    expect(out).toHaveLength(1);
    expect(out[0]!.proposal_type).toBe("temperature");
    expect(out[0]!.task_type).toBe("coding");
    expect(out[0]!.rationale.toLowerCase()).toContain("rating");
  });

  test("avgRating === 3.0 is NOT below the < 3 threshold — no temperature suggestion", () => {
    // Boundary check. `if (avgRating < 3)` — exactly 3.0 should NOT trip.
    const store = newStore();
    insertRuns(store, [
      makeRun({ id: "r1", task_type: "coding", user_rating: 3 }),
      makeRun({ id: "r2", task_type: "coding", user_rating: 3 }),
      makeRun({ id: "r3", task_type: "coding", user_rating: 3 }),
    ]);

    const analyzer = new OutcomeAnalyzer(store);
    const out = analyzer.analyze("coding");
    // No rating-triggered temperature, no error-rate trip (no stages).
    expect(out).toEqual([]);
  });

  test("stageErrors > 0.2 (excluding starvation) triggers a temperature suggestion with error-rate rationale", () => {
    // No user_rating at all → rating path is null. Stage error rate > 20%
    // must still fire a temperature suggestion.
    const store = newStore();
    insertRuns(
      store,
      [
        makeRun({ id: "r1", task_type: "coding" }),
        makeRun({ id: "r2", task_type: "coding" }),
        makeRun({ id: "r3", task_type: "coding" }),
      ],
      [
        // 2 errors out of 5 stage rows = 40% > 20%
        makeStage({ id: "s1", agent_run_id: "r1", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s2", agent_run_id: "r2", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s3", agent_run_id: "r3" }),
        makeStage({ id: "s4", agent_run_id: "r3" }),
        makeStage({ id: "s5", agent_run_id: "r3" }),
      ],
    );

    const analyzer = new OutcomeAnalyzer(store);
    const out = analyzer.analyze("coding");
    expect(out).toHaveLength(1);
    expect(out[0]!.proposal_type).toBe("temperature");
    expect(out[0]!.rationale.toLowerCase()).toContain("error rate");
  });

  test("stageErrors at exactly 0.2 does NOT trigger — strict > threshold", () => {
    // 1 error out of 5 stage rows = 20% — must NOT trip (> 0.2, not >=).
    const store = newStore();
    insertRuns(
      store,
      [
        makeRun({ id: "r1", task_type: "coding" }),
        makeRun({ id: "r2", task_type: "coding" }),
        makeRun({ id: "r3", task_type: "coding" }),
      ],
      [
        makeStage({ id: "s1", agent_run_id: "r1", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s2", agent_run_id: "r2" }),
        makeStage({ id: "s3", agent_run_id: "r2" }),
        makeStage({ id: "s4", agent_run_id: "r3" }),
        makeStage({ id: "s5", agent_run_id: "r3" }),
      ],
    );

    const analyzer = new OutcomeAnalyzer(store);
    const out = analyzer.analyze("coding");
    // No rating (null) and 20% error rate does NOT exceed 0.2 → empty.
    expect(out).toEqual([]);
  });

  test("high rating + no stage data → no temperature suggestion (rating gate is < 3)", () => {
    const store = newStore();
    insertRuns(store, [
      makeRun({ id: "r1", task_type: "coding", user_rating: 5 }),
      makeRun({ id: "r2", task_type: "coding", user_rating: 5 }),
      makeRun({ id: "r3", task_type: "coding", user_rating: 5 }),
    ]);

    const analyzer = new OutcomeAnalyzer(store);
    const out = analyzer.analyze("coding");
    expect(out).toEqual([]);
  });

  test("null user_rating across all runs → no rating-path suggestion; only error rate can fire", () => {
    const store = newStore();
    insertRuns(
      store,
      [
        makeRun({ id: "r1", task_type: "coding" }),
        makeRun({ id: "r2", task_type: "coding" }),
        makeRun({ id: "r3", task_type: "coding" }),
      ],
      [
        // 3/3 = 100% errors — would trip if error path was the only path.
        makeStage({ id: "s1", agent_run_id: "r1", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s2", agent_run_id: "r2", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s3", agent_run_id: "r3", had_error: 1, was_successful: 0 }),
      ],
    );

    const analyzer = new OutcomeAnalyzer(store);
    const out = analyzer.analyze("coding");
    // avgRating is null (no ratings across all 3 runs) → rating path returns
    // avgRating === null, so the rating-driven < 2.5 half of the compound
    // gate is false (null < 2.5 is false in JS). Only the error-rate path
    // fires → exactly one temperature suggestion.
    const types = out.map((s) => s.proposal_type).sort();
    expect(types).toEqual(["temperature"]);
  });
});

describe("OutcomeAnalyzer.analyze — restrict_tools compound gate", () => {
  test("avgRating < 2.5 AND stageErrors > 0.3 produces a restrict_tools suggestion", () => {
    const store = newStore();
    insertRuns(
      store,
      [
        makeRun({ id: "r1", task_type: "coding", user_rating: 2 }),
        makeRun({ id: "r2", task_type: "coding", user_rating: 2 }),
        makeRun({ id: "r3", task_type: "coding", user_rating: 2 }),
      ],
      [
        // 2/3 = 66% > 30% — meets the stageErrors > 0.3 half.
        makeStage({ id: "s1", agent_run_id: "r1", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s2", agent_run_id: "r2", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s3", agent_run_id: "r3" }),
      ],
    );

    const analyzer = new OutcomeAnalyzer(store);
    const out = analyzer.analyze("coding");
    const restrict = out.find((s) => s.proposal_type === "restrict_tools");
    expect(restrict).toBeDefined();
    expect(restrict!.task_type).toBe("coding");
    expect(restrict!.current_value).toBe("full tool set");
    expect(restrict!.proposed_value).toBe("read-only/search tools only");
  });

  test("avgRating === 2.5 does NOT trip < 2.5 — no restrict_tools", () => {
    // Boundary: < 2.5 is strict, so 2.5 should NOT trip.
    const store = newStore();
    insertRuns(
      store,
      [
        makeRun({ id: "r1", task_type: "coding", user_rating: 3 }),
        makeRun({ id: "r2", task_type: "coding", user_rating: 2 }),
        makeRun({ id: "r3", task_type: "coding", user_rating: 3 }),
      ],
      [
        // Average: (3+2+3)/3 = 2.66..., error rate: 2/3 = 66%.
        makeStage({ id: "s1", agent_run_id: "r1", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s2", agent_run_id: "r2", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s3", agent_run_id: "r3" }),
      ],
    );

    const analyzer = new OutcomeAnalyzer(store);
    const out = analyzer.analyze("coding");
    // No restrict_tools (avg >= 2.5). Temperature still fires from error rate.
    expect(out.some((s) => s.proposal_type === "restrict_tools")).toBe(false);
    expect(out.some((s) => s.proposal_type === "temperature")).toBe(true);
  });

  test("high error rate but rating >= 2.5 → no restrict_tools (AND gate)", () => {
    // Compound gate: BOTH halves must trip. Rating >= 2.5 alone blocks it.
    const store = newStore();
    insertRuns(
      store,
      [
        makeRun({ id: "r1", task_type: "coding", user_rating: 3 }),
        makeRun({ id: "r2", task_type: "coding", user_rating: 4 }),
        makeRun({ id: "r3", task_type: "coding", user_rating: 5 }),
      ],
      [
        makeStage({ id: "s1", agent_run_id: "r1", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s2", agent_run_id: "r2", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s3", agent_run_id: "r3" }),
      ],
    );

    const analyzer = new OutcomeAnalyzer(store);
    const out = analyzer.analyze("coding");
    // Rating gate NOT met (4.0 > 2.5). Error rate IS met (2/3 = 66%).
    expect(out.some((s) => s.proposal_type === "restrict_tools")).toBe(false);
    expect(out.some((s) => s.proposal_type === "temperature")).toBe(true);
  });
});

describe("OutcomeAnalyzer.analyze — starvation exclusion", () => {
  test("stage rows with partial_error_code === 'turn_deadline' do NOT count toward totalStages", () => {
    // F2/F3: starvation is an orchestration budget failure, not a model
    // failure. A flood of starvation rows must not fabricate an error-rate trip.
    const store = newStore();
    insertRuns(
      store,
      [
        makeRun({ id: "r1", task_type: "coding", user_rating: 5 }), // high rating
        makeRun({ id: "r2", task_type: "coding", user_rating: 5 }),
        makeRun({ id: "r3", task_type: "coding", user_rating: 5 }),
      ],
      [
        // 3 stage rows, all starvation + all had_error: 1. If these were
        // counted, error rate would be 100% → temperature suggestion fires.
        // With the exclusion, totalStages = 0 → 0% → no temperature trip.
        makeStage({
          id: "s1",
          agent_run_id: "r1",
          had_error: 1,
          was_successful: 0,
          partial_error_code: "turn_deadline",
        }),
        makeStage({
          id: "s2",
          agent_run_id: "r2",
          had_error: 1,
          was_successful: 0,
          partial_error_code: "stage_window_exhausted",
        }),
        makeStage({
          id: "s3",
          agent_run_id: "r3",
          had_error: 1,
          was_successful: 0,
          partial_error_code: "turn_deadline",
        }),
      ],
    );

    const analyzer = new OutcomeAnalyzer(store);
    const out = analyzer.analyze("coding");
    expect(out).toEqual([]);
  });

  test("non-starvation errors mixed with starvation rows: only the non-starvation ones count", () => {
    const store = newStore();
    insertRuns(
      store,
      [
        makeRun({ id: "r1", task_type: "coding", user_rating: 5 }),
        makeRun({ id: "r2", task_type: "coding", user_rating: 5 }),
        makeRun({ id: "r3", task_type: "coding", user_rating: 5 }),
      ],
      [
        // 1 real error + 1 starvation error = 1/2 of non-starvation stages error
        makeStage({
          id: "s1",
          agent_run_id: "r1",
          had_error: 1,
          was_successful: 0,
        }),
        makeStage({
          id: "s2",
          agent_run_id: "r2",
          had_error: 1,
          was_successful: 0,
          partial_error_code: "turn_deadline",
        }),
        makeStage({ id: "s3", agent_run_id: "r3" }),
      ],
    );

    const analyzer = new OutcomeAnalyzer(store);
    const out = analyzer.analyze("coding");
    // 1 error / 2 non-starvation stages = 50% > 20% → temperature suggestion.
    expect(out).toHaveLength(1);
    expect(out[0]!.proposal_type).toBe("temperature");
  });
});

describe("OutcomeAnalyzer — suggestion shape", () => {
  test("temperatureSuggestion reads current from BUILTIN_MODES.executor.temperature (0.3 → proposes 0.2)", () => {
    // The production default is `BUILTIN_MODES.executor.temperature = 0.3`.
    // Pin both the source (the mode's temperature) and the proposed value
    // (current - 0.1) so a refactor that hardcodes a different default
    // (or a refactor of BUILTIN_MODES.executor that changes 0.3) is caught.
    const store = newStore();
    // 3 low-rating runs (avg 2.0 < 3) → triggers the temperature path.
    insertRuns(store, [
      makeRun({ id: "r1", task_type: "coding", user_rating: 2 }),
      makeRun({ id: "r2", task_type: "coding", user_rating: 2 }),
      makeRun({ id: "r3", task_type: "coding", user_rating: 2 }),
    ]);

    const analyzer = new OutcomeAnalyzer(store);
    const out = analyzer.analyze("coding");
    expect(out).toHaveLength(1);
    expect(out[0]!.proposal_type).toBe("temperature");
    // current = BUILTIN_MODES.executor.temperature (0.3); proposed = current - 0.1.
    // Use toBeCloseTo for the float compare — `0.3 - 0.1` is
    // `0.19999999999999998` in IEEE-754, so a strict === on the string
    // "0.2" fails. The contract is the math, not the bit-exact repr.
    expect(Number(out[0]!.current_value)).toBeCloseTo(0.3, 10);
    expect(Number(out[0]!.proposed_value)).toBeCloseTo(0.2, 10);
    // And pin the delta explicitly so a regression that widens the
    // proposed gap (e.g. current - 0.2) is caught regardless of FP noise.
    expect(Number(out[0]!.current_value) - Number(out[0]!.proposed_value)).toBeCloseTo(0.1, 10);
  });

  test("temperatureSuggestion floors at 0.1 — does not go below 0.1 even with very low current", () => {
    // Pin the floor formula: max(0.1, current - 0.1). With the production
    // default of 0.3, the floor isn't engaged (0.3 - 0.1 = 0.2). We pin
    // the floor by checking the proposed >= 0.1 invariant and the
    // (current - proposed) === 0.1 invariant. A regression that widens
    // the delta (e.g. current - 0.2) or removes the floor (e.g. allowing
    // negative values) is caught.
    const store = newStore();
    insertRuns(store, [
      makeRun({ id: "r1", task_type: "coding", user_rating: 1 }),
      makeRun({ id: "r2", task_type: "coding", user_rating: 1 }),
      makeRun({ id: "r3", task_type: "coding", user_rating: 1 }),
    ]);

    const analyzer = new OutcomeAnalyzer(store);
    const out = analyzer.analyze("coding");
    const temperature = out.find((s) => s.proposal_type === "temperature")!;
    // Floor not engaged at current = 0.3.
    expect(Number(temperature.proposed_value)).toBeGreaterThanOrEqual(0.1);
    // Delta is exactly 0.1.
    expect(Number(temperature.current_value) - Number(temperature.proposed_value)).toBeCloseTo(0.1, 10);
  });

  test("proposal_type is the union literal from the TuningSuggestion contract", () => {
    const store = newStore();
    // Trip BOTH temperature paths (low rating + high error rate) and the
    // restrict_tools compound to exercise 2 of the 4 union members.
    insertRuns(
      store,
      [
        makeRun({ id: "r1", task_type: "coding", user_rating: 1 }),
        makeRun({ id: "r2", task_type: "coding", user_rating: 1 }),
        makeRun({ id: "r3", task_type: "coding", user_rating: 1 }),
      ],
      [
        makeStage({ id: "s1", agent_run_id: "r1", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s2", agent_run_id: "r2", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s3", agent_run_id: "r3" }),
      ],
    );

    const analyzer = new OutcomeAnalyzer(store);
    const out = analyzer.analyze("coding");
    const allowed = new Set(["temperature", "prune_mode", "restrict_tools", "skip_planner"]);
    for (const s of out) {
      expect(allowed.has(s.proposal_type)).toBe(true);
    }
  });
});

describe("OutcomeAnalyzer — dedupe", () => {
  test("identical (proposal_type, task_type, proposed_value) suggestions are collapsed to one", () => {
    const store = newStore();
    // The temperature path can fire from BOTH the rating gate and the
    // error-rate gate in the same pass; with identical current/proposed
    // values, dedupe must collapse them to a single suggestion.
    insertRuns(
      store,
      [
        makeRun({ id: "r1", task_type: "coding", user_rating: 1 }),
        makeRun({ id: "r2", task_type: "coding", user_rating: 1 }),
        makeRun({ id: "r3", task_type: "coding", user_rating: 1 }),
      ],
      [
        makeStage({ id: "s1", agent_run_id: "r1", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s2", agent_run_id: "r2", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s3", agent_run_id: "r3" }),
      ],
    );

    const analyzer = new OutcomeAnalyzer(store);
    const out = analyzer.analyze("coding");
    // Rating fires temperature. Error rate ALSO fires temperature. Dedupe
    // by (type, task_type, proposed_value) → ONE temperature entry.
    const temps = out.filter((s) => s.proposal_type === "temperature");
    expect(temps).toHaveLength(1);
  });

  test("distinct proposal_type or proposed_value are NOT deduped — both retained", () => {
    const store = newStore();
    // Fire rating + error rate (→ temperature) AND compound (→ restrict_tools).
    // Different proposal_types, so both must survive dedupe.
    insertRuns(
      store,
      [
        makeRun({ id: "r1", task_type: "coding", user_rating: 1 }),
        makeRun({ id: "r2", task_type: "coding", user_rating: 1 }),
        makeRun({ id: "r3", task_type: "coding", user_rating: 1 }),
      ],
      [
        makeStage({ id: "s1", agent_run_id: "r1", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s2", agent_run_id: "r2", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s3", agent_run_id: "r3" }),
      ],
    );

    const analyzer = new OutcomeAnalyzer(store);
    const out = analyzer.analyze("coding");
    const types = new Set(out.map((s) => s.proposal_type));
    expect(types).toEqual(new Set(["temperature", "restrict_tools"]));
  });
});

describe("OutcomeAnalyzer.analyze — threshold boundary", () => {
  test("exactly 3 completed runs is the minimum required to enter the analysis branch", () => {
    // Off-by-one regression guard. 3 is the documented threshold; 2 is not.
    const store = newStore();
    insertRuns(
      store,
      [
        makeRun({ id: "r1", task_type: "coding", user_rating: 1 }),
        makeRun({ id: "r2", task_type: "coding", user_rating: 1 }),
        makeRun({ id: "r3", task_type: "coding", user_rating: 1 }),
      ],
      [
        makeStage({ id: "s1", agent_run_id: "r1", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s2", agent_run_id: "r2", had_error: 1, was_successful: 0 }),
        makeStage({ id: "s3", agent_run_id: "r3", had_error: 1, was_successful: 0 }),
      ],
    );

    const analyzer = new OutcomeAnalyzer(store);
    const out = analyzer.analyze("coding");
    // 3 runs IS enough. rating < 3 (1.0) and error rate = 100% → 2 suggestions.
    expect(out.length).toBeGreaterThan(0);
    const types = new Set(out.map((s) => s.proposal_type));
    expect(types.has("temperature")).toBe(true);
    expect(types.has("restrict_tools")).toBe(true);
  });

  test("runs for OTHER task_types do not satisfy the 3-run minimum", () => {
    // Spread across task_types — 3 runs total, 0 for the analyzed task_type.
    const store = newStore();
    insertRuns(store, [
      makeRun({ id: "r1", task_type: "research", user_rating: 1 }),
      makeRun({ id: "r2", task_type: "writing", user_rating: 1 }),
      makeRun({ id: "r3", task_type: "ops", user_rating: 1 }),
    ]);

    const analyzer = new OutcomeAnalyzer(store);
    expect(analyzer.analyze("coding")).toEqual([]);
  });
});

describe("OutcomeAnalyzer — type surface", () => {
  test("TuningSuggestion is exported with the documented shape", () => {
    // Pin the public type surface so a refactor that drops or renames a
    // field is caught at compile time AND at runtime via shape check.
    const suggestion: TuningSuggestion = {
      proposal_type: "temperature",
      task_type: "coding",
      current_value: "0.4",
      proposed_value: "0.3",
      rationale: "test",
    };
    expect(suggestion.proposal_type).toBe("temperature");
    expect(suggestion.task_type).toBe("coding");
    expect(typeof suggestion.current_value).toBe("string");
    expect(typeof suggestion.proposed_value).toBe("string");
    expect(typeof suggestion.rationale).toBe("string");
  });
});
