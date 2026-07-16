import { expect, test, describe } from "bun:test";
import { SelfTuningStore, selfTuningDbPath } from "./store";
import { SessionOutcomeCollector } from "./collector";
import { OutcomeAnalyzer } from "./analyzer";
import { SelfTuningProposer } from "./proposer";
import { existsSync, statSync } from "fs";

const TEST_DB_PATH = ":memory:";

describe("Self tuning", () => {
  // 2026-07-13 finding: several orchestration.test.ts cases construct
  // PipelineExecutor with a ConductorWiring object ({ bus, live }, no
  // `.collector` field) or with `undefined` for the collector arg. Both
  // fall through to `outcomeCollector`'s default `new SelfTuningStore()`
  // (no override) — which, before this fix, wrote straight into the real
  // production self-tuning.db. Confirmed live: sentinel agent_run_ids
  // "run-abort" / "run-record-1" (with no parent agent_runs row) were
  // found polluting the actual production DB, inflating apparent executor/
  // planner error rates in any aggregate diagnosis. `bun test` sets
  // NODE_ENV=test automatically (verified), so that's the guard signal.
  test("SelfTuningStore with no override never touches the real DB file under NODE_ENV=test", () => {
    expect(process.env.NODE_ENV).toBe("test"); // sanity: bun test really does set this
    const realPath = selfTuningDbPath();
    const before = existsSync(realPath) ? statSync(realPath).mtimeMs : null;

    const store = new SelfTuningStore(); // NO override — the exact leak shape
    const collector = new SessionOutcomeCollector(store);
    collector.startAgentRun("run-guard-test", "s", "req", "general", ["executor"]);
    collector.recordStageRun({
      id: "stage-guard-test",
      agent_run_id: "run-guard-test",
      mode_id: "executor",
      turn_number: 1,
      tool_calls_json: "[]",
      duration_ms: 1,
      was_successful: 0,
      had_error: 1,
      error_message: "synthetic test failure",
    });

    // The write must be readable back (the in-memory fallback is fully
    // functional, not a silent no-op)...
    expect(store.getStageRuns("run-guard-test")).toHaveLength(1);
    // ...but the REAL on-disk file must be untouched.
    const after = existsSync(realPath) ? statSync(realPath).mtimeMs : null;
    expect(after).toBe(before);
  });

  test("an explicit dbPathOverride is still honored under NODE_ENV=test (doesn't force :memory:)", () => {
    const store = new SelfTuningStore(":memory:");
    const collector = new SessionOutcomeCollector(store);
    collector.startAgentRun("run-explicit", "s", "req", "general", ["executor"]);
    expect(store.getAgentRuns().some((r) => r.id === "run-explicit")).toBe(true);
  });

  test("collector records run and stage telemetry", () => {
    const store = new SelfTuningStore(TEST_DB_PATH);
    const collector = new SessionOutcomeCollector(store);
    const runId = "run_test";

    collector.startAgentRun(runId, "session_test", "write a unit test", "coding", ["planner", "executor"]);
    collector.recordStageRun({
      id: "stage_test",
      agent_run_id: runId,
      mode_id: "executor",
      turn_number: 1,
      input_tokens: 10,
      output_tokens: 20,
      tool_calls_json: "[]",
      duration_ms: 12,
      was_successful: 1,
      had_error: 0,
    });
    collector.completeAgentRun(runId, "done", 123, 2, 30);

    const runs = store.getAgentRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].completed).toBe(1);
    expect(store.getStageRuns(runId)[0].mode_id).toBe("executor");
  });

  test("getAgentRunsForTaskTypesInWindow filters by task type and [start, end) window", () => {
    const store = new SelfTuningStore(TEST_DB_PATH);
    const insert = (id: string, taskType: string, createdAt: string, outcome: string) => {
      store.insertAgentRun({
        id,
        session_id: "s",
        user_request: "q",
        task_type: taskType,
        pipeline: JSON.stringify(["synthesizer"]),
        completed: 1,
      });
      // insertAgentRun's fixed column list doesn't take created_at/outcome —
      // both are set here via the generic updater to pin an exact timestamp.
      store.updateAgentRun(id, { outcome, created_at: createdAt });
    };
    insert("run_in_window", "debug", "2026-06-02T00:00:00.000Z", "success");
    insert("run_before_window", "debug", "2026-05-30T00:00:00.000Z", "success");
    insert("run_at_end_boundary", "debug", "2026-06-03T00:00:00.000Z", "success"); // end is exclusive
    insert("run_wrong_task_type", "refactor", "2026-06-02T00:00:00.000Z", "success");

    const rows = store.getAgentRunsForTaskTypesInWindow(
      ["debug"],
      "2026-06-01T00:00:00.000Z",
      "2026-06-03T00:00:00.000Z",
    );
    expect(rows.map((r) => r.id)).toEqual(["run_in_window"]);
  });

  test("completeAgentRun persists a truthful outcome (default success, explicit failed)", () => {
    const store = new SelfTuningStore(TEST_DB_PATH);
    const collector = new SessionOutcomeCollector(store);

    collector.startAgentRun("run_ok", "s", "q", "general", ["synthesizer"]);
    collector.completeAgentRun("run_ok", "answer", 10, 0, 5); // default
    collector.startAgentRun("run_bad", "s", "q", "general", ["synthesizer"]);
    collector.completeAgentRun("run_bad", "(no output: empty_completion)", 10, 0, 0, "failed");

    const byId = Object.fromEntries(store.getAgentRuns().map((r) => [r.id, r]));
    expect(byId["run_ok"].outcome).toBe("success");
    expect(byId["run_bad"].outcome).toBe("failed");
  });

  // T0.2: truncated turns must persist as `partial`, not fold to `degraded`
  // at the storage boundary (reward math maps partial→degraded separately).
  test("completeAgentRun persists partial outcome truthfully", () => {
    const store = new SelfTuningStore(TEST_DB_PATH);
    const collector = new SessionOutcomeCollector(store);
    collector.startAgentRun("run_partial", "s", "q", "general", ["synthesizer"]);
    collector.completeAgentRun("run_partial", "mid-sentence cut", 50_000, 0, 100, "partial");
    const run = store.getAgentRuns().find((r) => r.id === "run_partial");
    expect(run?.outcome).toBe("partial");
  });

  // T0.2: stage_runs stop_reason + partial_error_code round-trip (new columns
  // + idempotent guarded ALTER on pre-existing DBs).
  test("insertStageRun persists stop_reason and partial_error_code", () => {
    const store = new SelfTuningStore(TEST_DB_PATH);
    const collector = new SessionOutcomeCollector(store);
    collector.startAgentRun("run_stop", "s", "q", "general", ["synthesizer"]);
    collector.recordStageRun({
      id: "stage_stop",
      agent_run_id: "run_stop",
      mode_id: "synthesizer",
      turn_number: 1,
      was_successful: 0,
      had_error: 0,
      stop_reason: "provider_cut",
      partial_error_code: "stream_cut",
    });
    const stage = store.getStageRuns("run_stop")[0];
    expect(stage.stop_reason).toBe("provider_cut");
    expect(stage.partial_error_code).toBe("stream_cut");
  });

  test("stop_reason / partial_error_code migration is idempotent", () => {
    // Open twice against the same path — second open re-runs guarded ALTERs.
    const path = ":memory:";
    const a = new SelfTuningStore(path);
    a.insertAgentRun({
      id: "run_mig",
      session_id: "s",
      user_request: "q",
      task_type: "general",
      pipeline: "[]",
      completed: 0,
    });
    a.insertStageRun({
      id: "stage_mig",
      agent_run_id: "run_mig",
      mode_id: "synthesizer",
      turn_number: 1,
      was_successful: 1,
      had_error: 0,
      stop_reason: "stop",
    });
    // Same :memory: store is process-local; re-ensure path via second insert.
    a.insertStageRun({
      id: "stage_mig2",
      agent_run_id: "run_mig",
      mode_id: "executor",
      turn_number: 1,
      was_successful: 1,
      had_error: 0,
      stop_reason: "tool_calls",
      partial_error_code: null,
    });
    const stages = a.getStageRuns("run_mig");
    expect(stages).toHaveLength(2);
    expect(stages.map((s) => s.stop_reason).sort()).toEqual(["stop", "tool_calls"]);
  });

  test("an injected in-memory collector is isolated — bun test cannot reach the production DB", () => {
    // Two independent :memory: stores never share rows. Because every pipeline
    // test injects a :memory: collector (never the global production singleton),
    // running `bun test` can never add rows to ~/.openclaw/jarvis/self-tuning.db.
    const storeA = new SelfTuningStore(":memory:");
    const storeB = new SelfTuningStore(":memory:");
    new SessionOutcomeCollector(storeA).startAgentRun("run_isolated", "s", "q", "general", ["synthesizer"]);

    expect(storeA.getAgentRuns().map((r) => r.id)).toContain("run_isolated");
    expect(storeB.getAgentRuns()).toHaveLength(0);
  });

  test("proposer creates pending proposals after enough negative outcomes", async () => {
    const store = new SelfTuningStore(TEST_DB_PATH);
    const runIds = ["run_a", "run_b", "run_c"];

    for (const runId of runIds) {
      store.insertAgentRun({
        id: runId,
        session_id: "session_test",
        user_request: "write a unit test",
        task_type: "coding",
        pipeline: JSON.stringify(["planner", "executor"]),
        completed: 1,
        final_output: "failed",
        user_rating: 1,
        duration_ms: 100,
        tool_calls_count: 1,
        token_count: 100,
      });
      store.insertStageRun({
        id: `stage_${runId}`,
        agent_run_id: runId,
        mode_id: "executor",
        turn_number: 1,
        input_tokens: 10,
        output_tokens: 20,
        tool_calls_json: "[]",
        duration_ms: 100,
        was_successful: 0,
        had_error: 1,
        error_message: "unstable output",
      });
    }

    const proposer = new SelfTuningProposer(store, new OutcomeAnalyzer(store));
    const proposals = await proposer.proposeAndApply("run_c", "coding");

    expect(proposals.length).toBeGreaterThan(0);
    expect(store.getPendingProposals().map((p) => p.proposal_type)).toContain("temperature");
  });

  test("OutcomeAnalyzer ignores stage_window_exhausted and turn_deadline rows when computing error rate", () => {
    // F2/F3: runtime starvation must not drive temperature proposals.
    const store = new SelfTuningStore(TEST_DB_PATH);
    for (let i = 0; i < 3; i++) {
      const runId = `run_starvation_${i}`;
      store.insertAgentRun({
        id: runId,
        session_id: "session_starvation",
        user_request: "audit the repo",
        task_type: "research",
        pipeline: JSON.stringify(["planner", "executor"]),
        completed: 1,
        final_output: "failed",
        user_rating: 5, // high rating so only error-rate path could fire
        duration_ms: 100,
        tool_calls_count: 0,
        token_count: 100,
      });
      store.insertStageRun({
        id: `stage_starve_${i}`,
        agent_run_id: runId,
        mode_id: "planner",
        turn_number: 1,
        input_tokens: 10,
        output_tokens: 0,
        tool_calls_json: "[]",
        duration_ms: 50,
        was_successful: 0,
        had_error: 1,
        error_message: "Stage budget exhausted on stage=planner",
        partial_error_code: i === 0 ? "turn_deadline" : "stage_window_exhausted",
      });
    }

    const analyzer = new OutcomeAnalyzer(store);
    const suggestions = analyzer.analyze("research");
    expect(suggestions.some((s) => /error rate/i.test(s.rationale))).toBe(false);
  });

  test("collector records conductor directives for audit / replay", () => {
    const store = new SelfTuningStore(TEST_DB_PATH);
    const collector = new SessionOutcomeCollector(store);
    const runId = "run_dir_audit";

    store.insertAgentRun({
      id: runId,
      session_id: "session_dir",
      user_request: "x",
      task_type: "general",
      pipeline: JSON.stringify(["planner", "executor"]),
      completed: 0,
    });

    collector.recordDirective({
      id: "dir_1",
      agent_run_id: runId,
      stage: "executor",
      directive_type: "reroute",
      reason: "tool errors hit threshold",
      new_remaining_json: JSON.stringify(["re-enter:planner", "executor", "synthesizer"]),
    });
    collector.recordDirective({
      id: "dir_2",
      agent_run_id: runId,
      stage: "executor",
      directive_type: "abort_stage",
      reason: "stalled",
    });
    collector.recordDirective({
      id: "dir_3",
      agent_run_id: runId,
      stage: "planner",
      directive_type: "inject_context",
      reason: "missing info",
      inject_for_stage: "executor",
      inject_note: "use the read_file tool from the workspace root",
    });
    collector.recordDirective({
      id: "dir_4",
      agent_run_id: runId,
      stage: "synthesizer",
      directive_type: "continue",
    });

    const rows = store.getConductorDirectives(runId);
    expect(rows).toHaveLength(4);
    expect(rows[0].directive_type).toBe("reroute");
    expect(JSON.parse(rows[0].new_remaining_json!)).toContain("re-enter:planner");
    expect(rows[1].directive_type).toBe("abort_stage");
    expect(rows[1].reason).toBe("stalled");
    expect(rows[2].inject_for_stage).toBe("executor");
    expect(rows[2].inject_note).toContain("read_file");
    expect(rows[3].directive_type).toBe("continue");
  });
});
