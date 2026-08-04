/**
 * M7 — self-tuning outcome loop contract.
 *
 * Apply proposal → pending measurement → complete N runs → outcome row
 * with improved true/false. Pins the store + evaluator path that turns
 * 3993 tuning_proposals / 0 tuning_outcomes into a closed loop.
 */
import { describe, expect, test } from "bun:test";
import { SessionOutcomeCollector } from "./collector";
import {
  DEFAULT_MIN_POST_APPLY_SAMPLES,
  evaluatePendingTuningOutcomes,
} from "./outcome-loop";
import { SelfTuningStore, successRateOfRuns } from "./store";

function seedCompletedRun(
  store: SelfTuningStore,
  opts: {
    id: string;
    taskType: string;
    outcome: "success" | "failed" | "degraded";
    sessionId?: string;
  },
): void {
  store.insertAgentRun({
    id: opts.id,
    session_id: opts.sessionId ?? "sess_outcome_loop",
    user_request: `fixture ${opts.id}`,
    task_type: opts.taskType,
    pipeline: JSON.stringify(["executor", "synthesizer"]),
    completed: 1,
    final_output: opts.outcome === "success" ? "ok" : "bad",
    duration_ms: 10,
    tool_calls_count: 0,
    token_count: 1,
  });
  store.updateAgentRun(opts.id, { outcome: opts.outcome });
}

function insertProposal(
  store: SelfTuningStore,
  opts: { id: string; agentRunId: string; taskType: string },
): void {
  store.insertTuningProposal({
    id: opts.id,
    agent_run_id: opts.agentRunId,
    proposal_type: "temperature",
    task_type: opts.taskType,
    current_value: "0.4",
    proposed_value: "0.3",
    rationale: "fixture proposal for outcome loop",
    applied: 0,
  });
}

describe("successRateOfRuns", () => {
  test("empty → rate 0 sample 0", () => {
    expect(successRateOfRuns([])).toEqual({ rate: 0, sample_n: 0 });
  });

  test("counts outcome=success over completed runs", () => {
    const store = new SelfTuningStore(":memory:");
    seedCompletedRun(store, { id: "r1", taskType: "coding", outcome: "success" });
    seedCompletedRun(store, { id: "r2", taskType: "coding", outcome: "failed" });
    seedCompletedRun(store, { id: "r3", taskType: "coding", outcome: "success" });
    const runs = store.getCompletedAgentRunsForTaskType("coding");
    const dial = successRateOfRuns(runs);
    expect(dial.sample_n).toBe(3);
    expect(dial.rate).toBeCloseTo(2 / 3, 5);
  });
});

describe("M7 tuning outcome loop", () => {
  test("apply captures baseline and marks pending measurement", () => {
    const store = new SelfTuningStore(":memory:");
    // Baseline: 1 success / 3 completed → 0.333
    seedCompletedRun(store, { id: "base_0", taskType: "coding", outcome: "success" });
    seedCompletedRun(store, { id: "base_1", taskType: "coding", outcome: "failed" });
    seedCompletedRun(store, { id: "base_2", taskType: "coding", outcome: "failed" });
    insertProposal(store, { id: "prop_1", agentRunId: "base_2", taskType: "coding" });

    store.applyTuningProposal("prop_1");

    const applied = store.getTuningProposal("prop_1");
    expect(applied?.applied).toBe(1);
    expect(applied?.applied_at).toBeTruthy();
    expect(applied?.pre_apply_run_count).toBe(3);
    expect(JSON.parse(applied?.pre_apply_run_ids ?? "[]").sort()).toEqual(
      ["base_0", "base_1", "base_2"].sort(),
    );
    expect(applied?.baseline_success_rate).toBeCloseTo(1 / 3, 5);

    const pending = store.getProposalsPendingMeasurement();
    expect(pending.map((p) => p.id)).toEqual(["prop_1"]);
    expect(store.getTuningOutcomes("prop_1")).toHaveLength(0);
  });

  test("evaluate is a no-op until minSamples post-apply runs exist", () => {
    const store = new SelfTuningStore(":memory:");
    seedCompletedRun(store, { id: "base_a", taskType: "coding", outcome: "failed" });
    insertProposal(store, { id: "prop_wait", agentRunId: "base_a", taskType: "coding" });
    store.applyTuningProposal("prop_wait");

    // Only 1 post-apply run; default min is 3
    seedCompletedRun(store, { id: "post_0", taskType: "coding", outcome: "success" });
    const written = evaluatePendingTuningOutcomes(store, {
      minSamples: DEFAULT_MIN_POST_APPLY_SAMPLES,
    });
    expect(written).toHaveLength(0);
    expect(store.getTuningOutcomes("prop_wait")).toHaveLength(0);
    expect(store.getProposalsPendingMeasurement()).toHaveLength(1);
  });

  test("apply → pending → N successful post-apply runs → outcome improved=true", () => {
    const store = new SelfTuningStore(":memory:");
    // Weak baseline: 0/2
    seedCompletedRun(store, { id: "b0", taskType: "coding", outcome: "failed" });
    seedCompletedRun(store, { id: "b1", taskType: "coding", outcome: "failed" });
    insertProposal(store, { id: "prop_up", agentRunId: "b1", taskType: "coding" });
    store.applyTuningProposal("prop_up");

    expect(store.getProposalsPendingMeasurement()).toHaveLength(1);

    // 3 post-apply successes → measured=1.0 > baseline=0 → improved
    seedCompletedRun(store, { id: "p0", taskType: "coding", outcome: "success" });
    seedCompletedRun(store, { id: "p1", taskType: "coding", outcome: "success" });
    seedCompletedRun(store, { id: "p2", taskType: "coding", outcome: "success" });

    const written = evaluatePendingTuningOutcomes(store, { minSamples: 3 });
    expect(written).toHaveLength(1);
    expect(written[0]!.proposal_id).toBe("prop_up");
    expect(written[0]!.measured).toBeCloseTo(1, 5);
    expect(written[0]!.baseline).toBeCloseTo(0, 5);
    expect(written[0]!.improved).toBe(1);
    expect(written[0]!.sample_n).toBe(3);
    expect(written[0]!.success_rate_delta).toBeCloseTo(1, 5);
    expect(written[0]!.notes).toMatch(/improved|success_rate|coding/i);

    const rows = store.getTuningOutcomes("prop_up");
    expect(rows).toHaveLength(1);
    expect(store.getProposalsPendingMeasurement()).toHaveLength(0);

    // Idempotent: second pass writes nothing
    expect(evaluatePendingTuningOutcomes(store, { minSamples: 3 })).toHaveLength(0);
    expect(store.getTuningOutcomes("prop_up")).toHaveLength(1);
  });

  test("post-apply worse than baseline → improved=false", () => {
    const store = new SelfTuningStore(":memory:");
    // Strong baseline: 3/3
    seedCompletedRun(store, { id: "s0", taskType: "research", outcome: "success" });
    seedCompletedRun(store, { id: "s1", taskType: "research", outcome: "success" });
    seedCompletedRun(store, { id: "s2", taskType: "research", outcome: "success" });
    insertProposal(store, { id: "prop_down", agentRunId: "s2", taskType: "research" });
    store.applyTuningProposal("prop_down");

    // 3 post-apply failures
    seedCompletedRun(store, { id: "f0", taskType: "research", outcome: "failed" });
    seedCompletedRun(store, { id: "f1", taskType: "research", outcome: "failed" });
    seedCompletedRun(store, { id: "f2", taskType: "research", outcome: "failed" });

    const written = evaluatePendingTuningOutcomes(store, { minSamples: 3 });
    expect(written).toHaveLength(1);
    expect(written[0]!.improved).toBe(0);
    expect(written[0]!.measured).toBeCloseTo(0, 5);
    expect(written[0]!.baseline).toBeCloseTo(1, 5);
    expect(written[0]!.success_rate_delta).toBeCloseTo(-1, 5);
  });

  test("recordTuningOutcome is idempotent per proposalId", () => {
    const store = new SelfTuningStore(":memory:");
    seedCompletedRun(store, { id: "r0", taskType: "general", outcome: "success" });
    insertProposal(store, { id: "prop_once", agentRunId: "r0", taskType: "general" });
    store.applyTuningProposal("prop_once");

    const first = store.recordTuningOutcome("prop_once", {
      measured: 0.8,
      baseline: 0.5,
      improved: true,
      sample_n: 5,
      notes: "first write",
    });
    const second = store.recordTuningOutcome("prop_once", {
      measured: 0.1,
      baseline: 0.9,
      improved: false,
      sample_n: 99,
      notes: "should not overwrite",
    });
    expect(first?.id).toBe(second?.id);
    expect(store.getTuningOutcomes("prop_once")).toHaveLength(1);
    expect(store.getTuningOutcomes("prop_once")[0]!.notes).toBe("first write");
    expect(store.getTuningOutcomes("prop_once")[0]!.measured).toBeCloseTo(0.8, 5);
  });

  test("completeAgentRun path evaluates pending proposals (end-to-end)", () => {
    const store = new SelfTuningStore(":memory:");
    const collector = new SessionOutcomeCollector(store);

    // Baseline failures
    seedCompletedRun(store, { id: "e2e_b0", taskType: "coding", outcome: "failed" });
    seedCompletedRun(store, { id: "e2e_b1", taskType: "coding", outcome: "failed" });
    insertProposal(store, { id: "prop_e2e", agentRunId: "e2e_b1", taskType: "coding" });
    store.applyTuningProposal("prop_e2e");
    expect(store.getProposalsPendingMeasurement()).toHaveLength(1);

    // Drive N post-apply runs through the collector so evaluation is automatic
    for (let i = 0; i < DEFAULT_MIN_POST_APPLY_SAMPLES; i++) {
      const id = `e2e_post_${i}`;
      collector.startAgentRun(id, "sess_e2e", "do the thing", "coding", ["executor"]);
      collector.completeAgentRun(id, "ok", 20, 1, 10, "success");
    }

    const outcomes = store.getTuningOutcomes("prop_e2e");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.improved).toBe(1);
    expect(outcomes[0]!.sample_n).toBe(DEFAULT_MIN_POST_APPLY_SAMPLES);
    expect(outcomes[0]!.measured).toBeCloseTo(1, 5);
    expect(outcomes[0]!.baseline).toBeCloseTo(0, 5);
    expect(store.getProposalsPendingMeasurement()).toHaveLength(0);
  });

  test("other task_types do not count toward a proposal's post-apply sample", () => {
    const store = new SelfTuningStore(":memory:");
    seedCompletedRun(store, { id: "iso_b", taskType: "coding", outcome: "failed" });
    insertProposal(store, { id: "prop_iso", agentRunId: "iso_b", taskType: "coding" });
    store.applyTuningProposal("prop_iso");

    // Plenty of research runs — must not unlock the coding proposal
    for (let i = 0; i < 5; i++) {
      seedCompletedRun(store, {
        id: `iso_research_${i}`,
        taskType: "research",
        outcome: "success",
      });
    }
    expect(evaluatePendingTuningOutcomes(store, { minSamples: 3 })).toHaveLength(0);

    // Coding runs unlock it
    for (let i = 0; i < 3; i++) {
      seedCompletedRun(store, {
        id: `iso_coding_${i}`,
        taskType: "coding",
        outcome: "success",
      });
    }
    const written = evaluatePendingTuningOutcomes(store, { minSamples: 3 });
    expect(written).toHaveLength(1);
    expect(written[0]!.proposal_id).toBe("prop_iso");
  });
});
