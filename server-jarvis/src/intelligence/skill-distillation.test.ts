import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { distillSkillCandidate, distillFromTrajectorySnapshot } from "./skill-distiller";
import { listSkillCandidates, saveSkillCandidate, loadSkillCandidate } from "./skill-store";
import { resolveSkillsForTurn } from "./skill-resolver";
import { evaluateSkillPromotion, runSkillPromotionPass } from "./skill-promotion";
import type { SkillCandidate } from "./skill-types";
import type { TrajectorySnapshot } from "../self-tuning/store";

describe("skill distillation (Track C)", () => {
  let tempRoot = "";

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "jarvis-skill-cand-"));
    (globalThis as any).__skillCandidatesDirOverride = tempRoot;
  });

  afterEach(() => {
    delete (globalThis as any).__skillCandidatesDirOverride;
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  test("distills a candidate from a successful run", () => {
    const candidate = distillSkillCandidate({
      agentRunId: "run_distill_1",
      sessionId: "sess_1",
      taskType: "debug",
      userRequest: "fix the auth bug in src/auth.ts",
      workerInstructions: { executor: "Read src/auth.ts before editing." },
      stageRuns: [{
        id: "st1",
        agent_run_id: "run_distill_1",
        mode_id: "executor",
        turn_number: 1,
        was_successful: 1,
        had_error: 0,
      }],
      runOutcome: "success",
    }, {
      enabled: true,
      min_confidence: 0.5,
      promotion_eval_delta: 0.02,
      max_candidates: 50,
    });

    expect(candidate).not.toBeNull();
    expect(candidate!.status).toBe("candidate");
    expect(listSkillCandidates("candidate").length).toBeGreaterThan(0);
  });

  test("resolveSkillsForTurn matches promoted skills by task type", () => {
    const candidate: SkillCandidate = {
      id: "skill_test_1",
      name: "distilled-debug-test",
      description: "test",
      trigger: {
        task_types: ["debug"],
        requirements: ["full_execution"],
        signals: ["mutation_verb"],
      },
      body: "# Debug pattern\nAlways read failing tests first.",
      source_run_ids: ["run_x"],
      confidence: 0.8,
      status: "promoted",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    saveSkillCandidate(candidate);

    const resolved = resolveSkillsForTurn("refactor the login handler and fix tests", "debug");
    expect(resolved.matched.length).toBeGreaterThan(0);
    expect(resolved.promptBlock).toContain("distilled-debug-test");
  });

  test("promotion pass promotes high-confidence candidates", () => {
    saveSkillCandidate({
      id: "skill_promote_1",
      name: "distilled-refactor-x",
      description: "refactor pattern",
      trigger: { task_types: ["refactor"], requirements: ["full_execution"], signals: [] },
      body: "## Conductor worker guidance\nReuse existing modules.",
      source_run_ids: ["run_y"],
      confidence: 0.82,
      status: "candidate",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = runSkillPromotionPass({
      enabled: true,
      min_confidence: 0.5,
      promotion_eval_delta: 0.02,
      max_candidates: 50,
    });
    // The candidate above has signals:[] → fails the "missing_signals" gate
    // before the eval-delta check, so it is rejected (not promoted). The
    // promotion pass still returns a structured result with totals.
    expect(result.total_evaluated).toBe(1);
    expect(result.promoted.length).toBe(0);
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0].rejection_reason).toBe("missing_signals");
    expect(result.rejected[0].status).toBe("rejected");
    // A truly-promotable candidate (signals present, in-range body) should pass.
    saveSkillCandidate({
      id: "skill_promote_2",
      name: "distilled-refactor-promote",
      description: "promotable refactor",
      trigger: { task_types: ["refactor"], requirements: ["full_execution"], signals: ["mutation_verb", "function_name"] },
      body: "## Conductor worker guidance\nReuse existing modules. ".repeat(20), // ~720 chars, in the 400..4000 sweet spot
      source_run_ids: ["run_z"],
      confidence: 0.95,
      status: "candidate",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const second = runSkillPromotionPass({
      enabled: true,
      min_confidence: 0.5,
      promotion_eval_delta: 0.02,
      max_candidates: 50,
    });
    expect(second.promoted.length).toBe(1);
    expect(second.promoted[0].id).toBe("skill_promote_2");
    expect(listSkillCandidates("promoted").length).toBeGreaterThan(0);
  });

  test("rejection reasons are structured and machine-typed", () => {
    // Each rejection branch has a distinct, typed reason. The eval surface
    // can group / count these so operators can see *why* candidates fail.
    const cases: { id: string; candidate: SkillCandidate; expectReason: string }[] = [
      {
        id: "low_conf",
        candidate: {
          id: "rc_low", name: "rc-low", description: "x",
          trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb"] },
          body: "x".repeat(600),
          source_run_ids: ["r"], confidence: 0.1, status: "candidate",
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        },
        expectReason: "low_confidence",
      },
      {
        id: "no_signals",
        candidate: {
          id: "rc_nosig", name: "rc-nosig", description: "x",
          trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: [] },
          body: "x".repeat(600),
          source_run_ids: ["r"], confidence: 0.9, status: "candidate",
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        },
        expectReason: "missing_signals",
      },
      {
        id: "short_body",
        candidate: {
          id: "rc_short", name: "rc-short", description: "x",
          trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb"] },
          body: "x".repeat(50),
          source_run_ids: ["r"], confidence: 0.9, status: "candidate",
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        },
        expectReason: "body_length_out_of_range",
      },
      {
        id: "long_body",
        candidate: {
          id: "rc_long", name: "rc-long", description: "x",
          trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb"] },
          body: "x".repeat(4500),
          source_run_ids: ["r"], confidence: 0.9, status: "candidate",
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        },
        expectReason: "body_length_out_of_range",
      },
      {
        id: "suspicious_paths",
        candidate: {
          id: "rc_paths", name: "rc-paths", description: "x",
          trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb"] },
          body: "Look at C:\\Users\\foo and C:\\bar and C:\\baz in /etc/passwd and /usr/local and /var/log. ".repeat(15),
          source_run_ids: ["r"], confidence: 0.9, status: "candidate",
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        },
        expectReason: "suspicious_paths",
      },
    ];
    for (const c of cases) {
      saveSkillCandidate(c.candidate);
      const v = evaluateSkillPromotion(c.candidate, {
        enabled: true, min_confidence: 0.5, promotion_eval_delta: 0.02, max_candidates: 50,
      });
      expect(v.promote).toBe(false);
      expect(v.reason).toBe(c.expectReason);
      expect(v.detail).toBeTruthy();
    }
  });

  test("rejection reason is persisted and survives reload", () => {
    saveSkillCandidate({
      id: "rc_persist", name: "rc-persist", description: "x",
      trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: [] },
      body: "x".repeat(600),
      source_run_ids: ["r"], confidence: 0.9, status: "candidate",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    const result = runSkillPromotionPass({
      enabled: true, min_confidence: 0.5, promotion_eval_delta: 0.02, max_candidates: 50,
    });
    expect(result.rejected.length).toBe(1);
    const reloaded = loadSkillCandidate("rc_persist");
    expect(reloaded).not.toBeNull();
    expect(reloaded!.status).toBe("rejected");
    expect(reloaded!.rejection_reason).toBe("missing_signals");
    expect(reloaded!.rejection_detail).toContain("signals");
  });

  test("a rejected candidate does not re-evaluate on the next pass", () => {
    // A rejected candidate has status="rejected", not "candidate", so the
    // pass's `listSkillCandidates("candidate")` filter skips it. This is
    // the loop-termination guarantee: no infinite re-eval churn.
    saveSkillCandidate({
      id: "rc_noreeval", name: "rc-noreeval", description: "x",
      trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: [] },
      body: "x".repeat(600),
      source_run_ids: ["r"], confidence: 0.9, status: "candidate",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    const first = runSkillPromotionPass({
      enabled: true, min_confidence: 0.5, promotion_eval_delta: 0.02, max_candidates: 50,
    });
    expect(first.total_evaluated).toBe(1);
    expect(first.rejected.length).toBe(1);

    const second = runSkillPromotionPass({
      enabled: true, min_confidence: 0.5, promotion_eval_delta: 0.02, max_candidates: 50,
    });
    expect(second.total_evaluated).toBe(0);
    expect(second.promoted.length).toBe(0);
    expect(second.rejected.length).toBe(0);
  });

  test("re-enabling a rejected candidate clears its stale reason", () => {
    saveSkillCandidate({
      id: "rc_rearm", name: "rc-rearm", description: "x",
      trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: [] },
      body: "x".repeat(600),
      source_run_ids: ["r"], confidence: 0.9, status: "candidate",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    runSkillPromotionPass({
      enabled: true, min_confidence: 0.5, promotion_eval_delta: 0.02, max_candidates: 50,
    });
    const rejected = loadSkillCandidate("rc_rearm")!;
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejection_reason).toBe("missing_signals");

    // Operator manually re-arms with a fixed trigger (signals now present,
    // body length still in range) — manually restore to "candidate" so
    // the next pass can re-evaluate. The store should clear the stale
    // reason on the transition out of "rejected".
    rejected.status = "candidate";
    rejected.trigger.signals = ["mutation_verb", "function_name"];
    saveSkillCandidate(rejected);

    const rearmed = runSkillPromotionPass({
      enabled: true, min_confidence: 0.5, promotion_eval_delta: 0.02, max_candidates: 50,
    });
    const promotedRow = rearmed.promoted.find((p) => p.id === "rc_rearm");
    expect(promotedRow).toBeDefined();
    expect(promotedRow!.status).toBe("promoted");
    expect(promotedRow!.rejection_reason).toBeUndefined();
    expect(promotedRow!.rejection_detail).toBeUndefined();
  });

  // ---- C-01 hardening: distill_on policy + audit/replay from trajectory snapshots ----

  const baseStageRun = {
    id: "st_redistill",
    agent_run_id: "run_redistill_1",
    mode_id: "executor",
    turn_number: 1,
    was_successful: 1,
    had_error: 0,
  } as const;

  const baseDistillInput = {
    agentRunId: "run_redistill_1",
    sessionId: "sess_redistill_1",
    taskType: "debug" as const,
    userRequest: "fix the failing import in src/auth.ts",
    workerInstructions: { executor: "Read src/auth.ts before editing." },
    stageRuns: [baseStageRun],
  };

  test("distill_on=[success] (default) blocks degraded and failed outcomes", () => {
    // Default config (no distill_on) → ["success"] implicit
    const cfgNoPolicy = {
      enabled: true,
      min_confidence: 0.5,
      promotion_eval_delta: 0.02,
      max_candidates: 50,
    };
    expect(
      distillSkillCandidate({ ...baseDistillInput, runOutcome: "success" }, cfgNoPolicy),
    ).not.toBeNull();
    expect(
      distillSkillCandidate({ ...baseDistillInput, runOutcome: "degraded" }, cfgNoPolicy),
    ).toBeNull();
    expect(
      distillSkillCandidate({ ...baseDistillInput, runOutcome: "failed" }, cfgNoPolicy),
    ).toBeNull();

    // Explicit ["success"]
    const cfgSuccessOnly = { ...cfgNoPolicy, distill_on: ["success" as const] };
    expect(
      distillSkillCandidate({ ...baseDistillInput, runOutcome: "degraded" }, cfgSuccessOnly),
    ).toBeNull();
  });

  test("distill_on=[success,degraded] allows degraded replan-rescued runs to distill", () => {
    const cfg = {
      enabled: true,
      min_confidence: 0.5,
      promotion_eval_delta: 0.02,
      max_candidates: 50,
      distill_on: ["success", "degraded"] as ("success" | "degraded" | "failed")[],
    };
    // Use distinct agentRunIds so the two distillations produce distinct candidates.
    const successCand = distillSkillCandidate(
      { ...baseDistillInput, agentRunId: "run_redistill_success_1", runOutcome: "success" },
      cfg,
    );
    const degradedCand = distillSkillCandidate(
      { ...baseDistillInput, agentRunId: "run_redistill_degraded_1", runOutcome: "degraded" },
      cfg,
    );
    expect(successCand).not.toBeNull();
    expect(degradedCand).not.toBeNull();
    // Both should be persisted as candidates (distinct rows)
    expect(listSkillCandidates("candidate").length).toBeGreaterThanOrEqual(2);
    // Confidence floor for degraded should be lower than success (0.30 vs 0.45)
    expect(degradedCand!.confidence).toBeLessThan(successCand!.confidence);
  });

  test("distill_on=[] (empty) blocks all outcomes (sanity check)", () => {
    const cfg = {
      enabled: true,
      min_confidence: 0.5,
      promotion_eval_delta: 0.02,
      max_candidates: 50,
      distill_on: [] as ("success" | "degraded" | "failed")[],
    };
    expect(
      distillSkillCandidate({ ...baseDistillInput, runOutcome: "success" }, cfg),
    ).toBeNull();
  });

  test("distillFromTrajectorySnapshot round-trips a stored snapshot into a candidate", () => {
    // Build a synthetic trajectory JSON matching the shape the distiller expects
    const snapshot: TrajectorySnapshot = {
      id: "traj_redistill_1",
      agent_run_id: "run_redistill_2",
      session_id: "sess_redistill_2",
      snapshot_json: JSON.stringify({
        version: 1,
        agent_run_id: "run_redistill_2",
        session_id: "sess_redistill_2",
        task_type: "debug",
        run_outcome: "success",
        duration_ms: 1200,
        routing: { pipeline: ["planner", "executor", "synthesizer"] },
        worker_instructions: { executor: "Read src/foo.ts before editing." },
        instruction_variants: {},
        stage_runs: [{
          id: "st_redistill_2",
          agent_run_id: "run_redistill_2",
          mode_id: "executor",
          turn_number: 1,
          was_successful: 1,
          had_error: 0,
        }],
        model_attributions: [],
        user_request: "fix the typo in src/foo.ts",
      }),
    };

    const cfg = {
      enabled: true,
      min_confidence: 0.5,
      promotion_eval_delta: 0.02,
      max_candidates: 50,
    };
    const candidate = distillFromTrajectorySnapshot({ snapshot, config: cfg });
    expect(candidate).not.toBeNull();
    expect(candidate!.trigger.task_types[0]).toBe("debug");
    expect(candidate!.source_run_ids).toContain("run_redistill_2");
    expect(candidate!.trigger.task_types).toContain("debug");
    expect(candidate!.status).toBe("candidate");
  });

  test("distillFromTrajectorySnapshot returns null on malformed JSON", () => {
    const snapshot: TrajectorySnapshot = {
      id: "traj_redistill_bad",
      agent_run_id: "run_redistill_bad",
      session_id: "sess_redistill_bad",
      snapshot_json: "{ not valid json",
    };
    const cfg = {
      enabled: true,
      min_confidence: 0.5,
      promotion_eval_delta: 0.02,
      max_candidates: 50,
    };
    expect(distillFromTrajectorySnapshot({ snapshot, config: cfg })).toBeNull();
  });

  test("distillFromTrajectorySnapshot returns null when distillation is disabled", () => {
    const snapshot: TrajectorySnapshot = {
      id: "traj_redistill_disabled",
      agent_run_id: "run_redistill_disabled",
      session_id: "sess_redistill_disabled",
      snapshot_json: JSON.stringify({
        version: 1,
        agent_run_id: "run_redistill_disabled",
        session_id: "sess_redistill_disabled",
        task_type: "debug",
        run_outcome: "success",
        duration_ms: 500,
        routing: {},
        instruction_variants: {},
        stage_runs: [],
        model_attributions: [],
        user_request: "noop",
      }),
    };
    const cfg = {
      enabled: false,
      min_confidence: 0.5,
      promotion_eval_delta: 0.02,
      max_candidates: 50,
    };
    expect(distillFromTrajectorySnapshot({ snapshot, config: cfg })).toBeNull();
  });
});