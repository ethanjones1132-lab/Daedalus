/**
 * D-01: Trajectory corpus export tests.
 *
 * Pin the composite-reward contract and the quality-filtering behavior on
 * fixture trajectories. Tests run against `SelfTuningStore(":memory:")` so
 * they cannot pollute the production DB.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { SelfTuningStore, type TrajectorySnapshot, type AgentRun } from "../self-tuning/store";
import {
  buildExportRow,
  exportCorpus,
  DEFAULT_REWARD_WEIGHTS,
  DEFAULT_TOKEN_BUDGET,
  type EvalResults,
} from "./corpus";

/** Build a TrajectorySnapshot with sensible defaults and a deep-merge override. */
function makeSnapshot(overrides: {
  id?: string;
  agent_run_id?: string;
  session_id?: string;
  snapshot_json?: string;
  created_at?: string;
} = {}): TrajectorySnapshot {
  const id = overrides.id ?? "traj_test_1";
  const agentRunId = overrides.agent_run_id ?? "run_test_1";
  const sessionId = overrides.session_id ?? "sess_test_1";
  return {
    id,
    agent_run_id: agentRunId,
    session_id: sessionId,
    snapshot_json: overrides.snapshot_json ?? JSON.stringify({
      version: 1,
      agent_run_id: agentRunId,
      session_id: sessionId,
      task_type: "debug",
      run_outcome: "success",
      duration_ms: 1200,
      routing: { pipeline: ["planner", "executor", "synthesizer"] },
      worker_instructions: { executor: "Read the file before editing." },
      instruction_variants: {},
      stage_runs: [
        { id: "st_1", agent_run_id: "run_test_1", mode_id: "executor", turn_number: 1, was_successful: 1, had_error: 0, input_tokens: 500, output_tokens: 200 },
        { id: "st_2", agent_run_id: "run_test_1", mode_id: "synthesizer", turn_number: 2, was_successful: 1, had_error: 0, input_tokens: 800, output_tokens: 400 },
      ],
      model_attributions: [
        { id: "ma_1", agent_run_id: "run_test_1", stage_id: "executor", provider: "openrouter", model_id: "gemma4:e2b", was_successful: 1, had_error: 0 },
      ],
      user_request: "fix the typo in src/foo.ts",
    }),
    created_at: overrides.created_at,
  };
}

function makeAgentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run_test_1",
    session_id: "sess_test_1",
    user_request: "fix the typo in src/foo.ts",
    task_type: "debug",
    pipeline: JSON.stringify(["planner", "executor", "synthesizer"]),
    completed: 1,
    outcome: "success",
    duration_ms: 1200,
    user_rating: 4,
    ...overrides,
  };
}

describe("D-01 buildExportRow", () => {
  test("builds a row with reward in [0,1] and full schema for a successful snapshot", () => {
    const snap = makeSnapshot();
    const run = makeAgentRun();
    const row = buildExportRow(snap, run, {});
    expect(row).not.toBeNull();
    expect(row!.agent_run_id).toBe("run_test_1");
    expect(row!.run_outcome).toBe("success");
    expect(row!.task_type).toBe("debug");
    expect(row!.pipeline).toEqual(["planner", "executor", "synthesizer"]);
    expect(row!.user_rating).toBe(4);
    expect(row!.reward).toBeGreaterThanOrEqual(0);
    expect(row!.reward).toBeLessThanOrEqual(1);
    // All five components are present and in [0, 1]
    for (const v of Object.values(row!.reward_components)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // Components match the expected values for this fixture
    expect(row!.reward_components.outcome).toBe(1.0); // success
    expect(row!.reward_components.user).toBe((4 - 1) / 4); // 0.75
    expect(row!.reward_components.eval).toBe(0.5); // neutral, no eval
    // 500+200+800+400 = 1900 tokens, budget 16000 → 1 - 1900/16000 ≈ 0.881
    expect(row!.reward_components.tokens).toBeCloseTo(1 - 1900 / 16000, 5);
    expect(row!.reward_components.errors).toBe(1.0); // 0 errors of 2 stages
  });

  test("returns null on malformed JSON", () => {
    const snap = makeSnapshot({ snapshot_json: "{ not valid json" });
    expect(buildExportRow(snap, undefined, {})).toBeNull();
  });

  test("returns null on unknown run_outcome", () => {
    const snap = makeSnapshot({
      snapshot_json: JSON.stringify({
        version: 1,
        agent_run_id: "run_test_1",
        run_outcome: "weird",
        stage_runs: [],
        model_attributions: [],
        routing: {},
      }),
    });
    expect(buildExportRow(snap, undefined, {})).toBeNull();
  });

  test("returns null when agent_run_id is missing", () => {
    const snap = makeSnapshot({
      snapshot_json: JSON.stringify({
        run_outcome: "success",
        stage_runs: [],
        model_attributions: [],
        routing: {},
      }),
    });
    expect(buildExportRow(snap, undefined, {})).toBeNull();
  });

  test("returns null when the snapshot row and embedded agent_run_id disagree", () => {
    const snap = makeSnapshot({
      agent_run_id: "run_row",
      snapshot_json: JSON.stringify({
        version: 1,
        agent_run_id: "run_embedded",
        run_outcome: "success",
        stage_runs: [],
        model_attributions: [],
        routing: {},
      }),
    });

    expect(buildExportRow(snap, undefined, {})).toBeNull();
  });

  test("uses the joined agent run's normalized executable pipeline", () => {
    const snap = makeSnapshot({
      snapshot_json: JSON.stringify({
        version: 1,
        agent_run_id: "run_test_1",
        run_outcome: "success",
        routing: { pipeline: ["synthesizer"] },
        stage_runs: [],
        model_attributions: [],
      }),
    });
    const run = makeAgentRun({
      pipeline: JSON.stringify(["executor", "reviewer", "synthesizer"]),
    });

    expect(buildExportRow(snap, run, {})!.pipeline).toEqual([
      "executor",
      "reviewer",
      "synthesizer",
    ]);
  });

  test("uses a corrected agent run outcome and removes the stale 0.40 reward inflation", () => {
    const snap = makeSnapshot();
    const staleSnapshotRow = buildExportRow(snap, makeAgentRun({ outcome: "success" }), {})!;
    const correctedRow = buildExportRow(snap, makeAgentRun({ outcome: "failed" }), {})!;

    expect(correctedRow.run_outcome).toBe("failed");
    expect(correctedRow.reward_components.outcome).toBe(0);
    expect(staleSnapshotRow.reward - correctedRow.reward).toBeCloseTo(0.40, 10);
  });

  test("computes outcome_score: success=1.0, degraded=0.5, failed=0.0", () => {
    const outcomes = ["success", "degraded", "failed"] as const;
    const expected = [1.0, 0.5, 0.0];
    for (let i = 0; i < outcomes.length; i++) {
      const snap = makeSnapshot({
        id: `traj_out_${i}`,
        snapshot_json: JSON.stringify({
          version: 1,
          agent_run_id: "run_test_1",
          run_outcome: outcomes[i],
          stage_runs: [],
          model_attributions: [],
          routing: {},
          user_request: "x",
        }),
      });
      const row = buildExportRow(snap, undefined, {})!;
      expect(row.run_outcome).toBe(outcomes[i]);
      expect(row.reward_components.outcome).toBe(expected[i]);
    }
  });

  test("user_rating_score: 1..5 maps to 0..1, null/out-of-range → 0.5", () => {
    const cases: Array<[number | null | undefined, number]> = [
      [1, 0.0],
      [2, 0.25],
      [3, 0.5],
      [4, 0.75],
      [5, 1.0],
      [null, 0.5],
      [undefined, 0.5],
      [0, 0.5],   // out of range
      [6, 0.5],   // out of range
      [-1, 0.5],  // out of range
    ];
    for (const [rating, expected] of cases) {
      const run = makeAgentRun({ user_rating: rating as number | undefined });
      const row = buildExportRow(makeSnapshot(), run, {})!;
      expect(row.user_rating).toBe(typeof rating === "number" ? rating : null);
      expect(row.reward_components.user).toBe(expected);
    }
  });

  test("eval_replay_score: passed=true → 1.0, false → 0.0, missing → 0.5", () => {
    const evalResults: EvalResults = new Map([
      ["run_pass", true],
      ["run_fail", false],
    ]);
    const cases: Array<[string, number]> = [
      ["run_pass", 1.0],
      ["run_fail", 0.0],
      ["run_unknown", 0.5],
    ];
    for (const [agentRunId, expected] of cases) {
      // Override the snapshot_json's embedded agent_run_id so the lookup hits
      const snap = makeSnapshot({
        agent_run_id: agentRunId,
        snapshot_json: JSON.stringify({
          version: 1, agent_run_id: agentRunId, run_outcome: "success",
          stage_runs: [], model_attributions: [], routing: {},
        }),
      });
      const row = buildExportRow(snap, undefined, { evalResults })!;
      expect(row.reward_components.eval).toBe(expected);
    }
  });

  test("token_efficiency_score: 0 → 0.5, budget → 0.0, half-budget → 0.5", () => {
    // 0 tokens → 0.5 (neutral)
    const snap0 = makeSnapshot({
      snapshot_json: JSON.stringify({
        version: 1, agent_run_id: "run_test_1", run_outcome: "success",
        stage_runs: [{ had_error: 0 }], model_attributions: [], routing: {},
      }),
    });
    expect(buildExportRow(snap0, undefined, {})!.reward_components.tokens).toBe(0.5);

    // 8000 / 16000 → 0.5
    const snap8k = makeSnapshot({
      snapshot_json: JSON.stringify({
        version: 1, agent_run_id: "run_test_1", run_outcome: "success",
        stage_runs: [{ had_error: 0, input_tokens: 4000, output_tokens: 4000 }],
        model_attributions: [], routing: {},
      }),
    });
    expect(buildExportRow(snap8k, undefined, {})!.reward_components.tokens).toBeCloseTo(0.5, 5);

    // 16000 / 16000 → 0.0 (at the cap)
    const snapCap = makeSnapshot({
      snapshot_json: JSON.stringify({
        version: 1, agent_run_id: "run_test_1", run_outcome: "success",
        stage_runs: [{ had_error: 0, input_tokens: 8000, output_tokens: 8000 }],
        model_attributions: [], routing: {},
      }),
    });
    expect(buildExportRow(snapCap, undefined, {})!.reward_components.tokens).toBe(0.0);

    // 20000 / 16000 → 0.0 (over the cap)
    const snapOver = makeSnapshot({
      snapshot_json: JSON.stringify({
        version: 1, agent_run_id: "run_test_1", run_outcome: "success",
        stage_runs: [{ had_error: 0, input_tokens: 10000, output_tokens: 10000 }],
        model_attributions: [], routing: {},
      }),
    });
    expect(buildExportRow(snapOver, undefined, {})!.reward_components.tokens).toBe(0.0);
  });

  test("token_efficiency_score: custom token budget", () => {
    const snap = makeSnapshot({
      snapshot_json: JSON.stringify({
        version: 1, agent_run_id: "run_test_1", run_outcome: "success",
        stage_runs: [{ had_error: 0, input_tokens: 4000, output_tokens: 4000 }],
        model_attributions: [], routing: {},
      }),
    });
    // 8000 / 8000 → 0.0 with budget=8000
    const row = buildExportRow(snap, undefined, { tokenBudget: 8000 })!;
    expect(row.reward_components.tokens).toBe(0.0);
  });

  test("stage_error_absence_score: 0 errors / 2 stages = 1.0, 1/2 = 0.5, 2/2 = 0.0, no stages = 1.0", () => {
    const cases: Array<[number, number, number]> = [
      [0, 2, 1.0],  // 0 errors of 2 stages
      [1, 2, 0.5],  // 1 of 2
      [2, 2, 0.0],  // 2 of 2
      [0, 0, 1.0],  // no stages → perfect (vacuously true)
    ];
    for (const [errors, total, expected] of cases) {
      const stageRuns = Array.from({ length: total }, (_, i) => ({
        had_error: i < errors ? 1 : 0,
      }));
      const snap = makeSnapshot({
        snapshot_json: JSON.stringify({
          version: 1, agent_run_id: "run_test_1", run_outcome: "success",
          stage_runs: stageRuns, model_attributions: [], routing: {},
        }),
      });
      const row = buildExportRow(snap, undefined, {})!;
      expect(row.reward_components.errors).toBe(expected);
    }
  });

  test("custom rewardWeights override individual components (zeroed weight drops it)", () => {
    // outcome=failed (0.0), user=0, eval=0, tokens=0, errors=0.5 → reward 0.0
    // Zeroing the errors weight should give a final reward of 0.0.
    const snap = makeSnapshot({
      snapshot_json: JSON.stringify({
        version: 1, agent_run_id: "run_test_1", run_outcome: "failed",
        stage_runs: [{ had_error: 1 }], model_attributions: [], routing: {},
      }),
    });
    const noErrorsWeight = { outcome: 1, user: 0, eval: 0, tokens: 0, errors: 0 };
    const row = buildExportRow(snap, undefined, { rewardWeights: noErrorsWeight })!;
    // Only outcome contributes: failed → 0.0
    expect(row.reward).toBe(0.0);
  });

  test("replan_count is reflected from the provided map", () => {
    const replanCounts = new Map([["run_test_1", 3]]);
    const row = buildExportRow(makeSnapshot(), undefined, { replanCounts })!;
    expect(row.replan_count).toBe(3);
  });

  test("falls back to snapshot.session_id and agent_run_defaults when fields missing", () => {
    const snap = makeSnapshot({
      snapshot_json: JSON.stringify({
        version: 1, agent_run_id: "run_test_1",
        run_outcome: "success", stage_runs: [], model_attributions: [],
        routing: {},
        // no session_id, no task_type, no user_request
      }),
    });
    const row = buildExportRow(snap, undefined, {})!;
    expect(row.session_id).toBe("sess_test_1"); // from snapshot
    expect(row.task_type).toBe("unknown");
    expect(row.user_request).toBe("");
    expect(row.duration_ms).toBe(0);
  });
});

describe("D-01 exportCorpus — quality filtering", () => {
  let store: SelfTuningStore;

  beforeEach(() => {
    store = new SelfTuningStore(":memory:");
  });

  test("returns empty result when no snapshots exist", () => {
    const result = exportCorpus(store, 100);
    expect(result.rows).toEqual([]);
    expect(result.stats).toEqual({ scanned: 0, kept: 0, droppedBelowThreshold: 0, droppedMalformed: 0 });
  });

  test("keeps all rows when minReward=0 and rewards are positive", () => {
    store.insertAgentRun(makeAgentRun());
    store.insertTrajectorySnapshot(makeSnapshot());
    const { rows, stats } = exportCorpus(store, 100);
    expect(stats.scanned).toBe(1);
    expect(stats.kept).toBe(1);
    expect(stats.droppedBelowThreshold).toBe(0);
    expect(rows[0].reward).toBeGreaterThan(0);
  });

  test("drops failed-row below minReward (D-01 spec: failed/degraded below threshold)", () => {
    // All five components minimized: failed + no user_rating + no eval +
    // over-budget tokens + every stage errored. Reward = 0.0.
    const run = makeAgentRun({ id: "run_failed", outcome: "failed", user_rating: undefined });
    const snap = makeSnapshot({
      id: "traj_failed",
      agent_run_id: "run_failed",
      snapshot_json: JSON.stringify({
        version: 1, agent_run_id: "run_failed", run_outcome: "failed",
        stage_runs: [
          { had_error: 1, input_tokens: 9000, output_tokens: 9000 },
          { had_error: 1, input_tokens: 9000, output_tokens: 9000 },
        ],
        model_attributions: [], routing: {},
      }),
    });
    store.insertAgentRun(run);
    store.insertTrajectorySnapshot(snap);

    // Default minReward (0.25, the CLI default — the library default is 0.0)
    // drops the zero-reward row
    const { rows, stats } = exportCorpus(store, 100, { minReward: 0.25 });
    expect(stats.scanned).toBe(1);
    expect(stats.kept).toBe(0);
    expect(stats.droppedBelowThreshold).toBe(1);
    expect(rows).toEqual([]);

    // Lowering the threshold to 0 keeps the row. With the components above
    // (outcome=0, user=0.5, eval=0.5, tokens=0, errors=0), the weighted reward
    // is (0.40*0 + 0.25*0.5 + 0.15*0.5 + 0.10*0 + 0.10*0) / 1.0 = 0.20.
    const { rows: rows2 } = exportCorpus(store, 100, { minReward: 0 });
    expect(rows2).toHaveLength(1);
    expect(rows2[0].run_outcome).toBe("failed");
    expect(rows2[0].reward).toBeCloseTo(0.20, 5);
    expect(rows2[0].reward_components.outcome).toBe(0.0);
    expect(rows2[0].reward_components.errors).toBe(0.0);
    expect(rows2[0].reward_components.tokens).toBe(0.0);
  });

  test("drops malformed snapshots (bad JSON) and counts them", () => {
    store.insertTrajectorySnapshot(makeSnapshot({ id: "traj_bad", snapshot_json: "{ broken" }));
    const goodSnap = makeSnapshot({ id: "traj_good" });
    store.insertAgentRun(makeAgentRun());
    store.insertTrajectorySnapshot(goodSnap);

    const { rows, stats } = exportCorpus(store, 100);
    expect(stats.scanned).toBe(2);
    expect(stats.droppedMalformed).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("traj_good");
  });

  test("respects limit — only scans the first N newest snapshots", () => {
    // Insert 5 snapshots with different ids
    for (let i = 0; i < 5; i++) {
      store.insertAgentRun(makeAgentRun({ id: `run_${i}`, user_rating: i + 1 }));
      store.insertTrajectorySnapshot(makeSnapshot({
        id: `traj_${i}`,
        agent_run_id: `run_${i}`,
      }));
    }
    const { stats } = exportCorpus(store, 2);
    expect(stats.scanned).toBe(2);
  });

  test("plumbs evalResults and replanCounts through to rows", () => {
    const run = makeAgentRun();
    const snap = makeSnapshot();
    store.insertAgentRun(run);
    store.insertTrajectorySnapshot(snap);

    const evalResults: EvalResults = new Map([["run_test_1", true]]);
    const replanCounts = new Map([["run_test_1", 2]]);
    const { rows } = exportCorpus(store, 100, { evalResults, replanCounts });
    expect(rows).toHaveLength(1);
    expect(rows[0].reward_components.eval).toBe(1.0);
    expect(rows[0].replan_count).toBe(2);
  });

  test("uses canonical same-run model attributions after a snapshot was retro-repaired", () => {
    store.insertAgentRun(makeAgentRun());
    store.insertTrajectorySnapshot(makeSnapshot());
    store.insertModelAttribution({
      id: "ma_1",
      agent_run_id: "run_test_1",
      stage_id: "executor",
      provider: "openrouter",
      model_id: "gemma4:e2b",
      was_successful: 0,
      had_error: 1,
      fallback_used: 0,
    });

    const { rows } = exportCorpus(store, 100);

    expect(rows).toHaveLength(1);
    expect(rows[0].model_attributions).toEqual([
      expect.objectContaining({
        id: "ma_1",
        agent_run_id: "run_test_1",
        was_successful: 0,
        had_error: 1,
      }),
    ]);
  });
});

describe("D-01 exportCorpus — JSONL serialization shape", () => {
  test("rows are JSONL-serializable (no Maps, no functions, no circular refs)", () => {
    const store = new SelfTuningStore(":memory:");
    store.insertAgentRun(makeAgentRun());
    store.insertTrajectorySnapshot(makeSnapshot());
    const { rows } = exportCorpus(store, 100);
    const line = JSON.stringify(rows[0]);
    // Round-trip
    const parsed = JSON.parse(line);
    expect(parsed.agent_run_id).toBe("run_test_1");
    expect(parsed.run_outcome).toBe("success");
    expect(parsed.reward).toBeTypeOf("number");
    expect(parsed.reward_components).toBeTypeOf("object");
  });
});

describe("D-01 constants and weights", () => {
  test("DEFAULT_REWARD_WEIGHTS has the expected shape and non-negative values", () => {
    for (const v of Object.values(DEFAULT_REWARD_WEIGHTS)) {
      expect(v).toBeGreaterThanOrEqual(0);
    }
    expect(DEFAULT_REWARD_WEIGHTS.outcome).toBeGreaterThan(0);
    // Total weight > 0 (so reward is well-defined)
    const total = Object.values(DEFAULT_REWARD_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  });

  test("DEFAULT_TOKEN_BUDGET is a positive integer", () => {
    expect(DEFAULT_TOKEN_BUDGET).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_TOKEN_BUDGET)).toBe(true);
  });
});
