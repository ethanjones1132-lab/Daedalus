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
});
