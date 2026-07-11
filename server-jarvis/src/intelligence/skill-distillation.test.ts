import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { distillSkillCandidate, distillFromTrajectorySnapshot } from "./skill-distiller";
import { listSkillCandidates, saveSkillCandidate, loadSkillCandidate, updateSkillCandidateEval } from "./skill-store";
import { resolveSkillsForTurn, resolveSkillsForConductor } from "./skill-resolver";
import {
  evaluateSkillPromotion,
  runSkillPromotionPass,
  buildGroundingRubric,
  promoteSkillCandidate,
  promoteCandidates,
  computeCandidatePerformance,
  runGroundingJudge,
} from "./skill-promotion";
import type { SkillCandidate } from "./skill-types";
import type { TrajectorySnapshot } from "../self-tuning/store";
import type { CallModelFn } from "../orchestration/coordinator";

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

  // ---- D2: judge-gated promotion (organism loop v1) ----

  describe("buildGroundingRubric", () => {
    const promotableCandidate: SkillCandidate = {
      id: "rc_ground_1", name: "rc-ground-1", description: "x",
      trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb"] },
      body: "x".repeat(600),
      source_run_ids: ["run_ground_1"], confidence: 0.9, status: "candidate",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };

    test("mentions the candidate's task type", () => {
      const rubric = buildGroundingRubric(promotableCandidate, null);
      expect(rubric.some((r) => r.includes("debug"))).toBe(true);
    });

    test("always includes a no-invented-paths item", () => {
      const rubric = buildGroundingRubric(promotableCandidate, null);
      expect(rubric.some((r) => r.toLowerCase().includes("absolute path"))).toBe(true);
    });

    test("includes a worker-guidance item only when the source snapshot had worker_instructions", () => {
      const withGuidance = buildGroundingRubric(promotableCandidate, {
        worker_instructions: { executor: "Read the file first." },
      });
      const withoutGuidance = buildGroundingRubric(promotableCandidate, { worker_instructions: {} });
      const withNullSnapshot = buildGroundingRubric(promotableCandidate, null);
      expect(withGuidance.some((r) => r.includes("worker guidance"))).toBe(true);
      expect(withoutGuidance.some((r) => r.includes("worker guidance"))).toBe(false);
      expect(withNullSnapshot.some((r) => r.includes("worker guidance"))).toBe(false);
    });
  });

  describe("promoteSkillCandidate", () => {
    /** Fake judge callModel: always reports every rubric item as covered, so
     *  the resulting score is 1.0 regardless of the rubric passed in. */
    function passingCallModel(): CallModelFn {
      return async (messages) => {
        const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
        const rubricLines = userMsg.split("Rubric items")[1] ?? "";
        const items = [...rubricLines.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
        return { content: JSON.stringify({ covered: items, missed: [] }) };
      };
    }

    /** Fake judge callModel: reports every rubric item as missed (score 0). */
    function failingCallModel(): CallModelFn {
      return async () => ({ content: JSON.stringify({ covered: [], missed: [] }) });
    }

    function throwingCallModel(): CallModelFn {
      return async () => {
        throw new Error("model unavailable");
      };
    }

    const promotionCfg = {
      enabled: true,
      min_confidence: 0.5,
      promotion_eval_delta: 0.02,
      max_candidates: 50,
      min_judge_score: 0.75,
    };

    function groundableCandidate(id: string): SkillCandidate {
      return {
        id, name: `rc-${id}`, description: "x",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb", "read_verb"] },
        body: "## Conductor worker guidance\nRead the file first. ".repeat(20),
        source_run_ids: [`run_for_${id}`], confidence: 0.9, status: "candidate",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
    }

    function snapshotFetcherFor(runId: string, snapshot: { worker_instructions?: Record<string, string>; user_request?: string } | null) {
      return (candidateRunId: string) => (candidateRunId === runId ? snapshot : null);
    }

    test("candidate not found returns candidate_not_found without calling the judge", async () => {
      let called = false;
      const spyCallModel: CallModelFn = async (m, o) => {
        called = true;
        return passingCallModel()(m, o);
      };
      const result = await promoteSkillCandidate("does_not_exist", spyCallModel, promotionCfg, () => null);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("candidate_not_found");
      expect(called).toBe(false);
    });

    test("wrong status (already promoted) is rejected without calling the judge", async () => {
      const c = groundableCandidate("rc_already_promoted");
      c.status = "promoted";
      saveSkillCandidate(c);
      let called = false;
      const spyCallModel: CallModelFn = async (m, o) => {
        called = true;
        return passingCallModel()(m, o);
      };
      const result = await promoteSkillCandidate(c.id, spyCallModel, promotionCfg, () => null);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("wrong_status");
      expect(called).toBe(false);
    });

    test("heuristic gate failure rejects without calling the judge", async () => {
      const c: SkillCandidate = {
        id: "rc_heuristic_fail", name: "rc-heuristic-fail", description: "x",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: [] }, // no signals -> missing_signals gate
        body: "x".repeat(600),
        source_run_ids: ["run_heuristic_fail"], confidence: 0.9, status: "candidate",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      saveSkillCandidate(c);
      let called = false;
      const spyCallModel: CallModelFn = async (m, o) => {
        called = true;
        return passingCallModel()(m, o);
      };
      const result = await promoteSkillCandidate(c.id, spyCallModel, promotionCfg, () => null);
      expect(called).toBe(false);
      expect(result.candidate?.status).toBe("rejected");
      expect(result.candidate?.rejection_reason).toBe("missing_signals");
    });

    test("no grounding snapshot available rejects as eval_failed without calling the judge", async () => {
      const c = groundableCandidate("rc_no_snapshot");
      saveSkillCandidate(c);
      let called = false;
      const spyCallModel: CallModelFn = async (m, o) => {
        called = true;
        return passingCallModel()(m, o);
      };
      const result = await promoteSkillCandidate(c.id, spyCallModel, promotionCfg, () => null);
      expect(called).toBe(false);
      expect(result.candidate?.status).toBe("rejected");
      expect(result.candidate?.rejection_reason).toBe("eval_failed");
      expect(result.candidate?.rejection_detail).toContain("no grounding source");
    });

    test("judge pass (score >= min_judge_score) promotes and sets promoted_at + eval_score", async () => {
      const c = groundableCandidate("rc_judge_pass");
      saveSkillCandidate(c);
      const fetcher = snapshotFetcherFor(`run_for_${c.id}`, { worker_instructions: { executor: "Read first." } });
      const result = await promoteSkillCandidate(c.id, passingCallModel(), promotionCfg, fetcher);
      expect(result.ok).toBe(true);
      expect(result.candidate?.status).toBe("promoted");
      expect(result.candidate?.promoted_at).toBeTruthy();
      expect(result.candidate?.eval_score).toBe(1);
      const reloaded = loadSkillCandidate(c.id);
      expect(reloaded?.status).toBe("promoted");
      expect(reloaded?.promoted_at).toBeTruthy();
    });

    test("judge fail (score < min_judge_score) rejects with eval_failed and records eval_missed", async () => {
      const c = groundableCandidate("rc_judge_fail");
      saveSkillCandidate(c);
      const fetcher = snapshotFetcherFor(`run_for_${c.id}`, { worker_instructions: { executor: "Read first." } });
      const result = await promoteSkillCandidate(c.id, failingCallModel(), promotionCfg, fetcher);
      expect(result.ok).toBe(true);
      expect(result.candidate?.status).toBe("rejected");
      expect(result.candidate?.rejection_reason).toBe("eval_failed");
      expect(result.candidate?.eval_missed?.length).toBeGreaterThan(0);
    });

    test("judge call failure leaves the candidate as 'candidate' (not rejected, not promoted)", async () => {
      const c = groundableCandidate("rc_judge_unavailable");
      saveSkillCandidate(c);
      const fetcher = snapshotFetcherFor(`run_for_${c.id}`, { worker_instructions: { executor: "Read first." } });
      const result = await promoteSkillCandidate(c.id, throwingCallModel(), promotionCfg, fetcher);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("judge_unavailable");
      const reloaded = loadSkillCandidate(c.id);
      expect(reloaded?.status).toBe("candidate");
    });

    test("demoting a promoted candidate clears promoted_at", () => {
      const c = groundableCandidate("rc_demote");
      c.status = "promoted";
      c.promoted_at = new Date().toISOString();
      saveSkillCandidate(c);
      const { updateSkillCandidateStatus } = require("./skill-store");
      const demoted = updateSkillCandidateStatus(c.id, "candidate");
      expect(demoted?.status).toBe("candidate");
      expect(demoted?.promoted_at).toBeUndefined();
    });
  });

  describe("updateSkillCandidateEval (eval-only, no status transition)", () => {
    test("persists eval_score and eval_missed without changing status", () => {
      saveSkillCandidate({
        id: "rc_eval_only", name: "rc-eval-only", description: "x",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb"] },
        body: "x".repeat(600),
        source_run_ids: ["r"], confidence: 0.9, status: "candidate",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      const updated = updateSkillCandidateEval("rc_eval_only", 0.6, ["missed item 1"]);
      expect(updated?.status).toBe("candidate");
      expect(updated?.eval_score).toBe(0.6);
      expect(updated?.eval_missed).toEqual(["missed item 1"]);
      const reloaded = loadSkillCandidate("rc_eval_only");
      expect(reloaded?.status).toBe("candidate");
      expect(reloaded?.eval_score).toBe(0.6);
    });

    test("returns null for a missing candidate", () => {
      expect(updateSkillCandidateEval("does_not_exist", 0.5, [])).toBeNull();
    });
  });

  describe("promoteCandidates (bulk/scheduled judge-gated promotion)", () => {
    const bulkCfg = {
      enabled: true,
      min_confidence: 0.5,
      promotion_eval_delta: 0.02,
      max_candidates: 50,
      min_judge_score: 0.75,
    };

    function passingCallModel(): CallModelFn {
      return async (messages) => {
        const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
        const rubricLines = userMsg.split("Rubric items")[1] ?? "";
        const items = [...rubricLines.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
        return { content: JSON.stringify({ covered: items, missed: [] }) };
      };
    }

    test("bulk promotion refuses a candidate without a passing judge decision", async () => {
      saveSkillCandidate({
        id: "candidate-1",
        name: "candidate-1",
        description: "x",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb", "read_verb"] },
        body: "## Conductor worker guidance\nRead the file first. ".repeat(20),
        source_run_ids: ["run_for_candidate_1"],
        confidence: 0.9,
        status: "candidate",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await expect(promoteCandidates(["candidate-1"], passingCallModel(), bulkCfg, () => null))
        .rejects.toThrow("judge_required");
    });

    test("bulk promotion promotes a candidate with a passing prior judge decision", async () => {
      saveSkillCandidate({
        id: "candidate-2",
        name: "candidate-2",
        description: "x",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb", "read_verb"] },
        body: "## Conductor worker guidance\nRead the file first. ".repeat(20),
        source_run_ids: ["run_for_candidate_2"],
        confidence: 0.9,
        status: "candidate",
        eval_score: 1.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      const fetcher = (runId: string) =>
        runId === "run_for_candidate_2" ? { worker_instructions: { executor: "Read first." } } : null;
      const decisions = await promoteCandidates(["candidate-2"], passingCallModel(), bulkCfg, fetcher);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].candidate_id).toBe("candidate-2");
      expect(decisions[0].decision).toBe("promote");
      expect(decisions[0].judge_score).toBe(1);
      expect(decisions[0].rollback_revision_id).toBeTruthy();
      const reloaded = loadSkillCandidate("candidate-2");
      expect(reloaded?.status).toBe("promoted");
    });

    test("bulk promotion rejects a candidate whose prior judge score is below threshold", async () => {
      saveSkillCandidate({
        id: "candidate-3",
        name: "candidate-3",
        description: "x",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb", "read_verb"] },
        body: "## Conductor worker guidance\nRead the file first. ".repeat(20),
        source_run_ids: ["run_for_candidate_3"],
        confidence: 0.9,
        status: "candidate",
        eval_score: 0.5,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await expect(promoteCandidates(["candidate-3"], passingCallModel(), bulkCfg, () => null))
        .rejects.toThrow("judge_required");
    });
  });

  describe("runGroundingJudge (shared by promote and eval-only)", () => {
    function passingCallModel(): CallModelFn {
      return async (messages) => {
        const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
        const rubricLines = userMsg.split("Rubric items")[1] ?? "";
        const items = [...rubricLines.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
        return { content: JSON.stringify({ covered: items, missed: [] }) };
      };
    }

    function candidate(id: string): SkillCandidate {
      return {
        id, name: `rc-${id}`, description: "x",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb"] },
        body: "## Conductor worker guidance\nRead the file first. ".repeat(20),
        source_run_ids: [`run_for_${id}`], confidence: 0.9, status: "candidate",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
    }

    test("no source_run_ids -> no_grounding_source without calling the judge", async () => {
      const c = { ...candidate("rg1"), source_run_ids: [] };
      let called = false;
      const result = await runGroundingJudge(c, async (m, o) => { called = true; return passingCallModel()(m, o); }, () => null);
      expect(called).toBe(false);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBe("no_grounding_source");
    });

    test("no snapshot found for source run -> no_grounding_source without calling the judge", async () => {
      const c = candidate("rg2");
      let called = false;
      const result = await runGroundingJudge(c, async (m, o) => { called = true; return passingCallModel()(m, o); }, () => null);
      expect(called).toBe(false);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBe("no_grounding_source");
    });

    test("snapshot found -> calls the judge and returns its verdict", async () => {
      const c = candidate("rg3");
      const fetcher = (runId: string) => (runId === "run_for_rg3" ? { worker_instructions: { executor: "Read first." } } : null);
      const result = await runGroundingJudge(c, passingCallModel(), fetcher);
      expect(result.ok).toBe(true);
      expect(result.ok && result.verdict.score).toBe(1);
    });

    test("judge call throwing -> judge_unavailable", async () => {
      const c = candidate("rg4");
      const fetcher = (runId: string) => (runId === "run_for_rg4" ? { worker_instructions: {} } : null);
      const result = await runGroundingJudge(c, async () => { throw new Error("down"); }, fetcher);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBe("judge_unavailable");
    });
  });

  describe("resolveSkillsForConductor (D4 KV-safe conductor hint)", () => {
    function promotedCandidate(id: string, overrides?: Partial<SkillCandidate>): SkillCandidate {
      return {
        id, name: `distilled-${id}`, description: `Guidance for ${id}`,
        // signals:[] matches unconditionally (see triggerMatchesConductor) —
        // isolates these tests from the exact internal PATH_PATTERNS signal
        // names, which are covered separately in turn-requirements' own tests.
        trigger: { task_types: ["debug"], requirements: ["workspace_read"], signals: [] },
        body: "x".repeat(600),
        source_run_ids: ["run_x"], confidence: 0.9, status: "promoted",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        ...overrides,
      };
    }

    test("returns empty string when no promoted candidates match", () => {
      expect(resolveSkillsForConductor("hello there")).toBe("");
    });

    test("matches on requirement + signals without needing task_type (task_type is unknown pre-routing)", () => {
      // trigger.task_types is "debug", but the message is about "refactor" work —
      // conductor-time matching must not require task_type, only requirement/signals.
      saveSkillCandidate(promotedCandidate("conductor_1"));
      const hint = resolveSkillsForConductor("please look at src/foo.ts and summarize it");
      expect(hint).toContain("distilled-conductor_1");
    });

    test("excludes candidates whose trigger.requirements does not include the current requirement", () => {
      saveSkillCandidate(promotedCandidate("conductor_2", {
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: [] },
      }));
      const hint = resolveSkillsForConductor("please look at src/foo.ts and summarize it"); // workspace_read
      expect(hint).not.toContain("distilled-conductor_2");
    });

    test("only considers status='promoted' candidates, not candidate/rejected", () => {
      saveSkillCandidate(promotedCandidate("conductor_3", { status: "candidate" }));
      saveSkillCandidate(promotedCandidate("conductor_4", { status: "rejected" }));
      const hint = resolveSkillsForConductor("please look at src/foo.ts and summarize it");
      expect(hint).not.toContain("distilled-conductor_3");
      expect(hint).not.toContain("distilled-conductor_4");
    });

    test("caps at 3 skills even when more match", () => {
      for (const n of [1, 2, 3, 4, 5]) {
        saveSkillCandidate(promotedCandidate(`conductor_cap_${n}`));
      }
      const hint = resolveSkillsForConductor("please look at src/foo.ts and summarize it");
      const lines = hint.split("\n").filter(Boolean);
      expect(lines.length).toBeLessThanOrEqual(3);
    });

    test("hint format includes name, description, and task types", () => {
      saveSkillCandidate(promotedCandidate("conductor_format", {
        description: "Read before editing",
        trigger: { task_types: ["debug", "refactor"], requirements: ["workspace_read"], signals: [] },
      }));
      const hint = resolveSkillsForConductor("please look at src/foo.ts and summarize it");
      expect(hint).toContain("distilled-conductor_format");
      expect(hint).toContain("Read before editing");
      expect(hint).toContain("debug, refactor");
    });
  });

  describe("computeCandidatePerformance (D5 performance-since-promotion)", () => {
    function candidateAt(promotedAt: string | undefined): SkillCandidate {
      return {
        id: "perf_c1", name: "perf-c1", description: "x",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb"] },
        body: "x".repeat(600),
        source_run_ids: ["run_perf_1"], confidence: 0.9, status: "promoted",
        promoted_at: promotedAt,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
    }

    test("returns null when the candidate has no promoted_at", () => {
      const result = computeCandidatePerformance(candidateAt(undefined), () => [], new Date());
      expect(result).toBeNull();
    });

    test("computes before/after success rates and a positive delta on improvement", () => {
      const promotedAt = new Date("2026-06-01T00:00:00.000Z");
      const now = new Date("2026-06-05T00:00:00.000Z"); // 4 days after promotion
      const candidate = candidateAt(promotedAt.toISOString());

      const fetchRuns = (taskTypes: string[], startIso: string, endIso: string) => {
        expect(taskTypes).toEqual(["debug"]);
        const start = new Date(startIso).getTime();
        const end = new Date(endIso).getTime();
        // "before" window: 4 days before promotion -> 10 runs, 5 successes
        if (start < promotedAt.getTime() && end === promotedAt.getTime()) {
          return Array.from({ length: 10 }, (_, i) => ({ outcome: i < 5 ? "success" : "failed" }));
        }
        // "after" window: promotion -> now -> 4 runs, all successes
        if (start === promotedAt.getTime()) {
          return Array.from({ length: 4 }, () => ({ outcome: "success" }));
        }
        return [];
      };

      const result = computeCandidatePerformance(candidate, fetchRuns, now);
      expect(result).not.toBeNull();
      expect(result!.before).toEqual({ runs: 10, successes: 5, success_rate: 0.5 });
      expect(result!.after).toEqual({ runs: 4, successes: 4, success_rate: 1 });
      expect(result!.delta).toBeCloseTo(0.5);
    });

    test("delta is null when either window has zero runs", () => {
      const promotedAt = new Date("2026-06-01T00:00:00.000Z");
      const now = new Date("2026-06-02T00:00:00.000Z");
      const candidate = candidateAt(promotedAt.toISOString());
      const result = computeCandidatePerformance(candidate, () => [], now);
      expect(result!.before).toEqual({ runs: 0, successes: 0, success_rate: null });
      expect(result!.after).toEqual({ runs: 0, successes: 0, success_rate: null });
      expect(result!.delta).toBeNull();
    });

    test("before window duration equals elapsed time since promotion", () => {
      const promotedAt = new Date("2026-06-01T00:00:00.000Z");
      const now = new Date("2026-06-03T00:00:00.000Z"); // 2 days elapsed
      const candidate = candidateAt(promotedAt.toISOString());
      let capturedBeforeStart = "";
      const fetchRuns = (taskTypes: string[], startIso: string, endIso: string) => {
        if (new Date(endIso).getTime() === promotedAt.getTime()) capturedBeforeStart = startIso;
        return [];
      };
      computeCandidatePerformance(candidate, fetchRuns, now);
      const expectedStart = new Date("2026-05-30T00:00:00.000Z"); // promotedAt - 2 days
      expect(new Date(capturedBeforeStart).getTime()).toBe(expectedStart.getTime());
    });
  });
});