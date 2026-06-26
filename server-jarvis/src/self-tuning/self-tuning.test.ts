import { expect, test, describe } from "bun:test";
import { SelfTuningStore } from "./store";
import { SessionOutcomeCollector } from "./collector";
import { OutcomeAnalyzer } from "./analyzer";
import { SelfTuningProposer } from "./proposer";

const TEST_DB_PATH = ":memory:";

describe("Self tuning", () => {
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
