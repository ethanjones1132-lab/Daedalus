import { describe, expect, test } from "bun:test";
import { SelfTuningStore } from "./store";

describe("model_attributions carry a stage_run_id", () => {
  test("attribution links to exactly one stage row", () => {
    const store = new SelfTuningStore(":memory:");
    store.insertAgentRun({
      id: "run_1",
      session_id: "sess_1",
      user_request: "req",
      task_type: "refactor",
      pipeline: JSON.stringify(["executor"]),
      completed: 0,
    });
    const stageId = "stage_abc";
    store.insertStageRun({
      id: stageId,
      agent_run_id: "run_1",
      mode_id: "executor",
      turn_number: 1,
      input_tokens: 10,
      output_tokens: 10,
      tool_calls_json: "[]",
      duration_ms: 100,
      was_successful: 1,
      had_error: 0,
    });
    store.insertModelAttribution({
      id: "attr_1",
      agent_run_id: "run_1",
      stage_id: "executor",
      stage_run_id: stageId,
      agent_id: "a",
      provider: "openrouter",
      model_id: "m",
      was_successful: 1,
      had_error: 0,
      duration_ms: 100,
      fallback_used: 0,
    });
    const rows = store.getModelAttributions("run_1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage_run_id).toBe(stageId);
  });
});

describe("SelfTuningStore recent stage attributions", () => {
  test("returns newest-first rows for a stage since a cutoff and respects the limit", () => {
    const store = new SelfTuningStore(":memory:");
    const insertedIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `attr-${i}`;
      insertedIds.push(id);
      store.insertModelAttribution({
        id,
        agent_run_id: `run-${i}`,
        stage_id: "coordinator",
        provider: "opencode_go",
        model_id: "deepseek-v4-flash",
        was_successful: i % 2 === 0 ? 1 : 0,
        had_error: i % 2 === 0 ? 0 : 1,
        fallback_used: 0,
      });
    }
    store.insertModelAttribution({
      id: "attr-other-stage",
      agent_run_id: "run-other-stage",
      stage_id: "executor",
      provider: "opencode_go",
      model_id: "deepseek-v4-flash",
      was_successful: 1,
      had_error: 0,
      fallback_used: 0,
    });

    const rows = store.getRecentStageAttributions("coordinator", "1970-01-01T00:00:00.000Z", 3);
    const futureRows = store.getRecentStageAttributions("coordinator", "2999-01-01T00:00:00.000Z", 3);

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.stage_id)).toEqual(["coordinator", "coordinator", "coordinator"]);
    expect(rows.map((row) => row.id)).toEqual(insertedIds.slice(-3).reverse());
    expect(futureRows).toEqual([]);
  });
});

describe("SelfTuningStore delegate write scoreboard", () => {
  test("upserts, reads, and clears delegate write scoreboard rows", () => {
    const store = new SelfTuningStore(":memory:");
    expect(store.getAllDelegateWriteScoreboard()).toEqual([]);

    store.upsertDelegateWriteScoreboard({
      model: "minimax-m3",
      attempts: 123,
      verifiedWrites: 118,
      benched: false,
    });
    store.upsertDelegateWriteScoreboard({
      model: "cohere/north-mini-code:free",
      attempts: 3,
      verifiedWrites: 0,
      benched: true,
    });

    const all = store.getAllDelegateWriteScoreboard();
    expect(all).toHaveLength(2);
    expect(store.getDelegateWriteScoreboardRow("minimax-m3")).toMatchObject({
      model: "minimax-m3",
      attempts: 123,
      verified_writes: 118,
      benched: 0,
    });
    expect(store.getDelegateWriteScoreboardRow("cohere/north-mini-code:free")?.benched).toBe(1);

    store.upsertDelegateWriteScoreboard({
      model: "minimax-m3",
      attempts: 124,
      verifiedWrites: 119,
      benched: false,
    });
    expect(store.getDelegateWriteScoreboardRow("minimax-m3")?.attempts).toBe(124);

    store.clearDelegateWriteScoreboard();
    expect(store.getAllDelegateWriteScoreboard()).toEqual([]);
  });
});

describe("SelfTuningStore conductor outcome summaries", () => {
  test("aggregates recent task and pipeline outcomes in SQLite", () => {
    const store = new SelfTuningStore(":memory:");
    const insert = (index: number, taskType: string, pipeline: string[], outcome: string) => {
      const runId = `conductor-summary-run-${index}`;
      store.insertAgentRun({
        id: runId,
        session_id: "conductor-summary-session",
        user_request: "fixture",
        task_type: taskType,
        pipeline: JSON.stringify(pipeline),
        completed: 1,
      });
      store.insertConductorRun({
        id: `conductor-summary-${index}`,
        agent_run_id: runId,
        session_id: "conductor-summary-session",
        routing_json: "{}",
        conductor_source: "local",
        task_type: taskType,
        topology: "linear",
        pipeline_json: JSON.stringify(pipeline),
        normalized_pipeline_json: JSON.stringify(pipeline),
        run_outcome: outcome,
      });
    };

    insert(1, "debug", ["planner", "executor", "synthesizer"], "success");
    insert(2, "debug", ["planner", "executor", "synthesizer"], "success");
    insert(3, "debug", ["planner", "executor", "synthesizer"], "failed");
    insert(4, "refactor", ["executor", "reviewer", "synthesizer"], "success");

    const summaries = store.getRecentConductorOutcomeSummaries(7, 3);
    expect(summaries[0]).toMatchObject({
      task_type: "debug",
      pipeline_shape: JSON.stringify(["planner", "executor", "synthesizer"]),
      sample_count: 3,
      success_count: 2,
    });
    expect(Number(summaries[0]!.success_rate)).toBeCloseTo(2 / 3, 5);
    expect(summaries.some((summary) => summary.task_type === "refactor")).toBe(true);
  });
});
