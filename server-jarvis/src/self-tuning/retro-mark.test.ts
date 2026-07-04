import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { SelfTuningStore } from "./store";
import { findPoisonedRuns, retroMarkPoisonedRuns } from "./retro-mark";

/**
 * Live incident 2026-07-03 (session 1d4727cf, run_81091960): the synthesizer
 * emitted tool-call JSON as its "answer". The stage was recorded
 * was_successful=1, the run outcome=success, and the tuning heuristics then
 * boosted the offending model's capability score. This retro-marks the
 * poisoned history so the reward signal reflects what actually happened.
 *
 * Uses a real on-disk :memory:-backed SelfTuningStore (via its schema-creation
 * side effect) to build the Database instance the pure core module operates
 * on, mirroring the pattern in self-tuning.test.ts.
 */

function makeDb(): Database {
  // SelfTuningStore(":memory:") lazily creates + caches a single in-memory
  // Database with the full schema applied (see store.ts getDb()). Grab that
  // underlying Database via a throwaway store call so retro-mark tests run
  // against the exact same schema production code uses.
  const store = new SelfTuningStore(":memory:");
  store.insertAgentRun({
    id: "__schema_bootstrap__",
    session_id: "s",
    user_request: "q",
    task_type: "general",
    pipeline: JSON.stringify(["synthesizer"]),
    completed: 1,
  });
  const db = (store as unknown as { getDb: () => Database }).getDb();
  if (!db) throw new Error("failed to open in-memory self-tuning db for test");
  db.prepare("DELETE FROM agent_runs WHERE id = ?").run("__schema_bootstrap__");
  return db;
}

function insertRun(
  db: Database,
  id: string,
  finalOutput: string,
  outcome: string | null,
): void {
  db.prepare(
    `INSERT INTO agent_runs (id, session_id, user_request, task_type, pipeline, completed, final_output, outcome)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, "session_test", "do something", "general", JSON.stringify(["synthesizer"]), finalOutput, outcome);
}

function insertAttribution(
  db: Database,
  id: string,
  runId: string,
  stageId: string,
  agentId: string,
  wasSuccessful: number,
): void {
  db.prepare(
    `INSERT INTO model_attributions (id, agent_run_id, stage_id, agent_id, provider, model_id, was_successful, had_error, duration_ms, fallback_used)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, runId, stageId, agentId, "openrouter", "test-model", wasSuccessful, wasSuccessful ? 0 : 1, 100, 0);
}

function insertPerformance(
  db: Database,
  agentId: string,
  stageId: string,
  taskType: string,
  successCount: number,
  failureCount: number,
): void {
  db.prepare(
    `INSERT INTO agent_performance (agent_id, stage_id, task_type, success_count, failure_count, total_duration_ms, sample_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(agentId, stageId, taskType, successCount, failureCount, 1000, successCount + failureCount);
}

function snapshot(db: Database) {
  return {
    runs: db.query("SELECT id, outcome FROM agent_runs ORDER BY id").all(),
    attributions: db
      .query("SELECT id, was_successful, had_error FROM model_attributions ORDER BY id")
      .all(),
    performance: db
      .query("SELECT agent_id, stage_id, task_type, success_count, failure_count FROM agent_performance ORDER BY agent_id, stage_id, task_type")
      .all(),
  };
}

describe("retro-mark poisoned runs", () => {
  test("findPoisonedRuns identifies tool-JSON leaks and Synthesis-failed runs, spares clean/fenced prose", () => {
    const db = makeDb();

    insertRun(db, "run_clean", "The answer to your question is 42.", "success");
    insertRun(
      db,
      "run_tool_json_leak",
      '{"name":"read_file","arguments":{"path":"foo.ts"}}',
      "success",
    );
    insertRun(db, "run_synthesis_failed", "Synthesis failed: upstream 500", null);
    insertRun(
      db,
      "run_fenced_tool_json",
      "Here is an example tool call:\n```json\n" +
        '{"name":"read_file","arguments":{"path":"foo.ts"}}' +
        "\n```\nThat's how it works.",
      "success",
    );
    // Already failed — should not be re-flagged as newly poisoned by findPoisonedRuns
    // (outcome is neither NULL nor 'success').
    insertRun(db, "run_already_failed", '{"name":"read_file"}', "failed");

    const poisoned = findPoisonedRuns(db).map((r) => r.id).sort();
    expect(poisoned).toEqual(["run_synthesis_failed", "run_tool_json_leak"].sort());
  });

  test("dry run (apply=false) computes summary but writes nothing", () => {
    const db = makeDb();
    insertRun(db, "run_clean", "The answer to your question is 42.", "success");
    insertRun(db, "run_tool_json_leak", '{"name":"read_file","arguments":{"path":"foo.ts"}}', "success");
    insertAttribution(db, "attr_synth", "run_tool_json_leak", "synthesizer", "agent_a", 1);
    insertPerformance(db, "agent_a", "synthesizer", "general", 5, 1);

    const before = snapshot(db);
    const summary = retroMarkPoisonedRuns(db, { apply: false });

    expect(summary.runsMarked).toBe(1);
    expect(summary.attributionsFlipped).toBe(1);
    expect(summary.performanceRowsAdjusted).toBe(1);
    expect(summary.details.some((d) => d.includes("run_tool_json_leak"))).toBe(true);

    const after = snapshot(db);
    expect(after).toEqual(before);
  });

  test("apply=true marks poisoned runs failed, flips synthesizer attributions, and repairs agent_performance", () => {
    const db = makeDb();

    // Clean run — untouched by anything.
    insertRun(db, "run_clean", "The answer to your question is 42.", "success");
    insertAttribution(db, "attr_clean", "run_clean", "synthesizer", "agent_a", 1);

    // Poisoned: tool JSON leaked as the answer, recorded success.
    insertRun(db, "run_tool_json_leak", '{"name":"read_file","arguments":{"path":"foo.ts"}}', "success");
    insertAttribution(db, "attr_leak_synth", "run_tool_json_leak", "synthesizer", "agent_a", 1);
    insertAttribution(db, "attr_leak_executor", "run_tool_json_leak", "executor", "agent_b", 1);

    // Poisoned: "Synthesis failed:" text shipped as final_output, outcome NULL.
    insertRun(db, "run_synthesis_failed", "Synthesis failed: upstream 500", null);
    insertAttribution(db, "attr_synfail_synth", "run_synthesis_failed", "synthesizer", "agent_a", 1);

    // Legit prose with a fenced tool-JSON example — NOT poisoned.
    insertRun(
      db,
      "run_fenced_tool_json",
      "Here is an example tool call:\n```json\n" +
        '{"name":"read_file","arguments":{"path":"foo.ts"}}' +
        "\n```\nThat's how it works.",
      "success",
    );
    insertAttribution(db, "attr_fenced_synth", "run_fenced_tool_json", "synthesizer", "agent_a", 1);

    // agent_a/synthesizer/general performance should be decremented twice
    // (once per poisoned run's synthesizer attribution): success 10 -> 8,
    // failure 2 -> 4.
    insertPerformance(db, "agent_a", "synthesizer", "general", 10, 2);
    // agent_b/executor performance is untouched — executor is not the answer stage.
    insertPerformance(db, "agent_b", "executor", "general", 3, 1);

    const summary = retroMarkPoisonedRuns(db, { apply: true });

    expect(summary.runsMarked).toBe(2);
    expect(summary.attributionsFlipped).toBe(2); // only the two synthesizer attrs on poisoned runs
    expect(summary.performanceRowsAdjusted).toBe(1); // one (agent_a, synthesizer, general) row touched twice, adjusted once

    const runs = Object.fromEntries(
      (db.query("SELECT id, outcome FROM agent_runs").all() as Array<{ id: string; outcome: string | null }>).map(
        (r) => [r.id, r.outcome],
      ),
    );
    expect(runs["run_clean"]).toBe("success");
    expect(runs["run_tool_json_leak"]).toBe("failed");
    expect(runs["run_synthesis_failed"]).toBe("failed");
    expect(runs["run_fenced_tool_json"]).toBe("success");

    const attrs = Object.fromEntries(
      (
        db
          .query("SELECT id, was_successful, had_error FROM model_attributions")
          .all() as Array<{ id: string; was_successful: number; had_error: number }>
      ).map((r) => [r.id, r]),
    );
    expect(attrs["attr_clean"]).toEqual({ id: "attr_clean", was_successful: 1, had_error: 0 });
    expect(attrs["attr_leak_synth"]).toEqual({ id: "attr_leak_synth", was_successful: 0, had_error: 1 });
    // Executor attribution on the poisoned run is untouched — only the
    // ANSWER stage (synthesizer) attribution is flipped.
    expect(attrs["attr_leak_executor"]).toEqual({ id: "attr_leak_executor", was_successful: 1, had_error: 0 });
    expect(attrs["attr_synfail_synth"]).toEqual({ id: "attr_synfail_synth", was_successful: 0, had_error: 1 });
    expect(attrs["attr_fenced_synth"]).toEqual({ id: "attr_fenced_synth", was_successful: 1, had_error: 0 });

    const perf = db
      .query(
        "SELECT agent_id, stage_id, task_type, success_count, failure_count FROM agent_performance ORDER BY agent_id, stage_id",
      )
      .all() as Array<{
      agent_id: string;
      stage_id: string;
      task_type: string;
      success_count: number;
      failure_count: number;
    }>;
    const agentASynth = perf.find((p) => p.agent_id === "agent_a" && p.stage_id === "synthesizer");
    expect(agentASynth?.success_count).toBe(8); // 10 - 2 (two poisoned synthesizer attributions)
    expect(agentASynth?.failure_count).toBe(4); // 2 + 2
    const agentBExecutor = perf.find((p) => p.agent_id === "agent_b" && p.stage_id === "executor");
    expect(agentBExecutor?.success_count).toBe(3); // untouched
    expect(agentBExecutor?.failure_count).toBe(1); // untouched
  });

  test("clamps success_count/failure_count at >= 0 and leaves missing performance rows alone", () => {
    const db = makeDb();
    insertRun(db, "run_tool_json_leak", '{"name":"read_file","arguments":{"path":"foo.ts"}}', "success");
    insertAttribution(db, "attr_synth", "run_tool_json_leak", "synthesizer", "agent_no_perf_row", 1);
    // No matching agent_performance row for agent_no_perf_row/synthesizer/general.

    const summary = retroMarkPoisonedRuns(db, { apply: true });
    expect(summary.runsMarked).toBe(1);
    expect(summary.attributionsFlipped).toBe(1);
    expect(summary.performanceRowsAdjusted).toBe(0);

    const rows = db.query("SELECT * FROM agent_performance").all();
    expect(rows).toHaveLength(0);
  });

  test("clamps success_count decrement so it never goes negative", () => {
    const db = makeDb();
    insertRun(db, "run_tool_json_leak", '{"name":"read_file","arguments":{"path":"foo.ts"}}', "success");
    insertAttribution(db, "attr_synth", "run_tool_json_leak", "synthesizer", "agent_a", 1);
    insertPerformance(db, "agent_a", "synthesizer", "general", 0, 5);

    retroMarkPoisonedRuns(db, { apply: true });

    const row = db
      .query("SELECT success_count, failure_count FROM agent_performance WHERE agent_id = ? AND stage_id = ?")
      .get("agent_a", "synthesizer") as { success_count: number; failure_count: number };
    expect(row.success_count).toBe(0); // clamped, was already 0
    expect(row.failure_count).toBe(6);
  });
});
