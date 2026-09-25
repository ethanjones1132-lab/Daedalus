/**
 * Self-tuning proposal measurement — pure decision contracts.
 *
 * One applied proposal can be in exactly three honest states, and only one of
 * them may claim a conclusion:
 *   - `measured`             a real post-apply rate was compared to a real baseline
 *   - `awaiting_samples`     the post-apply window cannot say anything yet
 *   - `baseline_unavailable` the apply-time baseline was never measured
 *
 * The defect these pin: an unrated completed run used to score 1.0, and a
 * missing baseline used to read as a real zero — so an "improved" verdict could
 * be computed against fiction.
 */
import { describe, expect, test } from "bun:test";
import { decideProposalMeasurement, postApplyRuns } from "./tuning-measurement";
import type { AgentRun, TuningOutcome, TuningProposal } from "./store";
import { successRateOfRuns } from "./store";

function run(id: string, outcome: string | null, rating: number | null = null): AgentRun {
  const row: AgentRun = {
    id,
    session_id: "sess_measure",
    user_request: `fixture ${id}`,
    task_type: "coding",
    pipeline: "[]",
    completed: 1,
    duration_ms: 1,
    tool_calls_count: 0,
    token_count: 0,
  };
  if (outcome !== null) row.outcome = outcome;
  if (rating !== null) row.user_rating = rating;
  return row;
}

function proposal(overrides: Partial<TuningProposal> = {}): TuningProposal {
  return {
    id: "prop_m",
    agent_run_id: "run_b",
    proposal_type: "temperature",
    task_type: "coding",
    applied: 1,
    applied_at: "2026-09-25T10:00:00.000Z",
    baseline_success_rate: 0.5,
    pre_apply_run_count: 2,
    pre_apply_run_ids: JSON.stringify(["b0", "b1"]),
    ...overrides,
  };
}

function outcomeRow(overrides: Partial<TuningOutcome> = {}): TuningOutcome {
  return {
    id: "tout_1",
    proposal_id: "prop_m",
    measured: 0.8,
    baseline: 0.5,
    improved: 1,
    sample_n: 3,
    success_rate_delta: 0.3,
    measured_at: "2026-09-25T11:00:00.000Z",
    ...overrides,
  };
}

describe("decideProposalMeasurement", () => {
  test("a recorded outcome row is the measured state and carries its own provenance", () => {
    const verdict = decideProposalMeasurement({
      proposal: proposal(),
      outcome: outcomeRow(),
      completedRuns: [run("b0", "failed"), run("b1", "failed"), run("p0", "success")],
      minSamples: 3,
    });
    expect(verdict.state).toBe("measured");
    expect(verdict.reason).toBeNull();
    expect(verdict.measured).toBeCloseTo(0.8, 5);
    expect(verdict.baseline).toBeCloseTo(0.5, 5);
    expect(verdict.improved).toBe(1);
    expect(verdict.sample_n).toBe(3);
    expect(verdict.measured_at).toBe("2026-09-25T11:00:00.000Z");
    expect(verdict.applied_at).toBe("2026-09-25T10:00:00.000Z");
  });

  test("a measured row reports improved=0 truthfully rather than omitting the verdict", () => {
    const verdict = decideProposalMeasurement({
      proposal: proposal(),
      outcome: outcomeRow({ measured: 0.1, baseline: 0.9, improved: 0, success_rate_delta: -0.8 }),
      completedRuns: [],
      minSamples: 3,
    });
    expect(verdict.state).toBe("measured");
    expect(verdict.improved).toBe(0);
    expect(verdict.measured).toBeCloseTo(0.1, 5);
  });

  test("enough post-apply runs and a real baseline → measured with improved", () => {
    const verdict = decideProposalMeasurement({
      proposal: proposal({ baseline_success_rate: 0.25 }),
      outcome: null,
      completedRuns: [
        run("b0", "failed"),
        run("b1", "failed"),
        run("p0", "success"),
        run("p1", "success"),
        run("p2", "failed"),
      ],
      minSamples: 3,
    });
    expect(verdict.state).toBe("measured");
    expect(verdict.measured).toBeCloseTo(2 / 3, 5);
    expect(verdict.baseline).toBeCloseTo(0.25, 5);
    expect(verdict.improved).toBe(1);
    expect(verdict.sample_n).toBe(3);
    expect(verdict.known_n).toBe(3);
    expect(verdict.unknown_n).toBe(0);
    // Pre-decision verdict has no measurement time yet.
    expect(verdict.measured_at).toBeNull();
  });

  test("post-apply rate equal to the baseline is measured, not improved", () => {
    const verdict = decideProposalMeasurement({
      proposal: proposal({ baseline_success_rate: 0.5 }),
      outcome: null,
      completedRuns: [run("p0", "success"), run("p1", "failed"), run("p2", "success"), run("p3", "failed")],
      minSamples: 3,
    });
    expect(verdict.state).toBe("measured");
    expect(verdict.measured).toBeCloseTo(0.5, 5);
    expect(verdict.improved).toBe(0);
  });

  test("too few post-apply runs → awaiting_samples, never a measured 0", () => {
    const verdict = decideProposalMeasurement({
      proposal: proposal(),
      outcome: null,
      completedRuns: [run("b0", "failed"), run("p0", "success"), run("p1", "success")],
      minSamples: 3,
    });
    expect(verdict.state).toBe("awaiting_samples");
    expect(verdict.reason).toBe("post_apply_samples_below_minimum");
    expect(verdict.measured).toBeNull();
    expect(verdict.improved).toBeNull();
    expect(verdict.sample_n).toBe(2);
    // The baseline is still stated even while awaiting, so an operator can read it.
    expect(verdict.baseline).toBeCloseTo(0.5, 5);
  });

  test("a null baseline is never read as a real zero and never yields improved", () => {
    const verdict = decideProposalMeasurement({
      proposal: proposal({ baseline_success_rate: null }),
      outcome: null,
      completedRuns: [run("p0", "success"), run("p1", "success"), run("p2", "success")],
      minSamples: 3,
    });
    expect(verdict.state).toBe("baseline_unavailable");
    expect(verdict.reason).toBe("baseline_unavailable");
    expect(verdict.improved).toBeNull();
    expect(verdict.baseline).toBeNull();
    // The post-apply rate itself is real and is reported as such, just not compared.
    expect(verdict.measured).toBeCloseTo(1, 5);
    expect(verdict.sample_n).toBe(3);
  });

  test("an undefined baseline (row predates the column) is also unavailable", () => {
    const verdict = decideProposalMeasurement({
      proposal: proposal({ baseline_success_rate: undefined }),
      outcome: null,
      completedRuns: [run("p0", "success"), run("p1", "success"), run("p2", "failed")],
      minSamples: 3,
    });
    expect(verdict.state).toBe("baseline_unavailable");
    expect(verdict.baseline).toBeNull();
    expect(verdict.improved).toBeNull();
  });

  test("post-apply window of unrated runs cannot conclude improvement", () => {
    const verdict = decideProposalMeasurement({
      proposal: proposal(),
      outcome: null,
      completedRuns: [
        run("b0", "failed"),
        run("p0", null),
        run("p1", null),
        run("p2", null),
      ],
      minSamples: 3,
    });
    expect(verdict.state).toBe("awaiting_samples");
    expect(verdict.reason).toBe("post_apply_outcomes_unknown");
    expect(verdict.measured).toBeNull();
    expect(verdict.improved).toBeNull();
    expect(verdict.sample_n).toBe(3);
    expect(verdict.known_n).toBe(0);
    expect(verdict.unknown_n).toBe(3);
  });

  test("one known outcome among unrated runs is still not a measurement", () => {
    const verdict = decideProposalMeasurement({
      proposal: proposal(),
      outcome: null,
      completedRuns: [run("p0", null), run("p1", null), run("p2", "success")],
      minSamples: 3,
    });
    // known_n is 1 of 3 — too thin to state a rate as a conclusion.
    expect(verdict.state).toBe("awaiting_samples");
    expect(verdict.reason).toBe("post_apply_outcomes_unknown");
    expect(verdict.known_n).toBe(1);
    expect(verdict.unknown_n).toBe(2);
  });

  test("a rated legacy post-apply run still counts (rating fallback preserved)", () => {
    const verdict = decideProposalMeasurement({
      proposal: proposal(),
      outcome: null,
      completedRuns: [run("p0", null, 4), run("p1", null, 5), run("p2", null, 1)],
      minSamples: 3,
    });
    expect(verdict.state).toBe("measured");
    expect(verdict.known_n).toBe(3);
    expect(verdict.unknown_n).toBe(0);
    expect(verdict.measured).toBeCloseTo(2 / 3, 5);
  });

  test("an unapplied proposal has no measurement window at all", () => {
    const verdict = decideProposalMeasurement({
      proposal: proposal({ applied: 0, applied_at: null, baseline_success_rate: null, pre_apply_run_count: null, pre_apply_run_ids: null }),
      outcome: null,
      completedRuns: [run("p0", "success"), run("p1", "success"), run("p2", "success")],
      minSamples: 3,
    });
    expect(verdict.state).toBe("awaiting_samples");
    expect(verdict.sample_n).toBe(0);
    expect(verdict.measured).toBeNull();
  });

  test("a pre-M7 applied row with no snapshot columns yields no post-apply window", () => {
    const verdict = decideProposalMeasurement({
      proposal: proposal({ applied_at: null, baseline_success_rate: null, pre_apply_run_count: null, pre_apply_run_ids: null }),
      outcome: null,
      completedRuns: [run("p0", "success"), run("p1", "success"), run("p2", "success")],
      minSamples: 3,
    });
    expect(verdict.state).toBe("awaiting_samples");
    expect(verdict.reason).toBe("post_apply_samples_below_minimum");
    expect(verdict.sample_n).toBe(0);
    expect(verdict.measured).toBeNull();
    expect(verdict.improved).toBeNull();
    expect(verdict.applied_at).toBeNull();
  });

  test("minSamples is clamped to at least one, so a zero config cannot deadlock", () => {
    const verdict = decideProposalMeasurement({
      proposal: proposal(),
      outcome: null,
      completedRuns: [run("p0", "success")],
      minSamples: 0,
    });
    expect(verdict.minSamples).toBe(1);
    expect(verdict.state).toBe("measured");
  });
});

describe("postApplyRuns", () => {
  test("id-set snapshot is the primary split", () => {
    const all = [run("b0", "failed"), run("b1", "failed"), run("p0", "success")];
    expect(postApplyRuns(all, proposal()).map((r) => r.id)).toEqual(["p0"]);
  });

  test("count fallback when ids are missing", () => {
    const all = [run("b0", "failed"), run("b1", "failed"), run("p0", "success")];
    const sliced = postApplyRuns(all, proposal({ pre_apply_run_ids: null, pre_apply_run_count: 2 }));
    expect(sliced.map((r) => r.id)).toEqual(["p0"]);
  });

  test("applied_at fallback when both snapshot columns are missing", () => {
    const all = [run("old", "failed"), run("new", "success")];
    const sliced = postApplyRuns(
      all,
      proposal({ pre_apply_run_ids: null, pre_apply_run_count: null, applied_at: "2026-09-25T00:00:00.000Z" }),
    );
    // Undated rows are excluded rather than silently counted as post-apply.
    expect(sliced.map((r) => r.id)).toEqual([]);
  });

  test("a malformed pre_apply_run_ids blob falls through instead of yielding everything", () => {
    const all = [run("b0", "failed"), run("p0", "success")];
    const sliced = postApplyRuns(
      all,
      proposal({ pre_apply_run_ids: "not-json", pre_apply_run_count: 1, applied_at: "2026-09-25T00:00:00.000Z" }),
    );
    expect(sliced.map((r) => r.id)).toEqual(["p0"]);
  });
});
