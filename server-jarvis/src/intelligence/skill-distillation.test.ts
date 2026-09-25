import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { distillSkillCandidate, distillFromTrajectorySnapshot } from "./skill-distiller";
import { redistillSnapshots } from "./redistill";
import { listSkillCandidates, loadSkillCandidate, pruneSkillCandidates, saveSkillCandidate, skillCandidatePath, updateSkillCandidateEval } from "./skill-store";
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
import { countTokens } from "../tokens";
import type { CallModelFn } from "../orchestration/coordinator";
import {
  computeSkillToolSequenceDigest,
  decodeSkillStageRuns,
} from "./skill-source-evidence";

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

  test("uses the inherited task requirement and refuses unaccepted task runs", () => {
    const candidate = distillSkillCandidate({
      agentRunId: "run_continue_1",
      sessionId: "sess_1",
      taskType: "research",
      userRequest: "continue",
      turnRequirement: "workspace_read",
      taskRunAccepted: false,
      stageRuns: [{
        id: "st_continue",
        agent_run_id: "run_continue_1",
        mode_id: "executor",
        turn_number: 2,
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

    expect(candidate).toBeNull();
    expect(listSkillCandidates("candidate")).toHaveLength(0);

    const accepted = distillSkillCandidate({
      agentRunId: "run_continue_2",
      sessionId: "sess_1",
      taskType: "research",
      userRequest: "continue",
      turnRequirement: "workspace_read",
      taskRunAccepted: true,
      stageRuns: [{
        id: "st_continue_2",
        agent_run_id: "run_continue_2",
        mode_id: "executor",
        turn_number: 2,
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
    expect(accepted?.trigger.requirements).toEqual(["workspace_read"]);
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

  test("bounds many matches with deterministic omission diagnostics", () => {
    const rows: SkillCandidate[] = [
      ["skill-newest", "newest", "2026-09-24T04:00:00.000Z", "newest guidance"],
      ["skill-middle", "middle", "2026-09-24T03:00:00.000Z", "middle guidance"],
      ["skill-older", "older", "2026-09-24T02:00:00.000Z", "older guidance"],
      ["skill-oldest", "oldest", "2026-09-24T01:00:00.000Z", "oldest guidance"],
    ].map(([id, name, updatedAt, body]) => ({
      id,
      name,
      description: `${name} description`,
      trigger: { task_types: ["debug"] as const, requirements: ["full_execution"] as const, signals: ["mutation_verb"] },
      body,
      source_run_ids: [`run-${id}`],
      confidence: 0.9,
      status: "promoted" as const,
      created_at: updatedAt,
      updated_at: updatedAt,
    }));
    for (const row of rows.slice().reverse()) saveSkillCandidate(row);

    const resolved = resolveSkillsForTurn(
      "fix the failing import in src/auth.ts",
      "debug",
      { maxSkills: 2, maxTokens: 200 },
    );

    expect(resolved.matched.map((skill) => skill.id)).toEqual(["skill-newest", "skill-middle"]);
    expect(resolved.totalMatched).toBe(4);
    expect(resolved.omitted.byReason.max_skills).toBe(2);
    expect(countTokens(resolved.promptBlock)).toBeLessThanOrEqual(200);
  });

  test("bounds omission samples while retaining the total omission count", () => {
    for (let index = 0; index < 8; index++) {
      const timestamp = `2026-09-24T00:00:${String(index).padStart(2, "0")}.000Z`;
      saveSkillCandidate({
        id: `skill-diagnostic-${index}`,
        name: `diagnostic-${index}`,
        description: "diagnostic",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb"] },
        body: "diagnostic guidance",
        source_run_ids: [`run-diagnostic-${index}`],
        confidence: 0.9,
        status: "promoted",
        created_at: timestamp,
        updated_at: timestamp,
      });
    }

    const resolved = resolveSkillsForTurn(
      "fix the failing import in src/auth.ts",
      "debug",
      { maxSkills: 1, maxTokens: 1_000 },
    );

    expect(resolved.totalMatched).toBe(8);
    expect(resolved.omitted.count).toBe(7);
    expect(resolved.omitted.samples).toHaveLength(5);
    expect(resolved.omitted.samples.every((sample) => sample.reason === "max_skills")).toBe(true);
  });

  test("keeps a selected skill whole instead of slicing its body", () => {
    const sentinel = "SKILL_BODY_END_SENTINEL";
    const row: SkillCandidate = {
      id: "skill-whole-body",
      name: "whole-body",
      description: "whole body",
      trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb"] },
      body: `SKILL_BODY_START\n${"x".repeat(2_100)}\n${sentinel}`,
      source_run_ids: ["run-whole"],
      source_session_id: "session-whole",
      confidence: 0.9,
      status: "promoted",
      created_at: "2026-09-24T00:00:00.000Z",
      updated_at: "2026-09-24T00:00:00.000Z",
    };
    saveSkillCandidate(row);

    const resolved = resolveSkillsForTurn(
      "fix the failing import in src/auth.ts",
      "debug",
      { maxTokens: 1_000 },
    );

    expect(resolved.matched.map((skill) => skill.id)).toEqual([row.id]);
    expect(resolved.matched[0].source_run_ids).toEqual(["run-whole"]);
    expect(resolved.matched[0].source_session_id).toBe("session-whole");
    expect(resolved.promptBlock).toContain(sentinel);
  });

  test("skips an oversized skill without blocking a smaller later match", () => {
    const rows: SkillCandidate[] = [
      {
        id: "skill-too-large",
        name: "too-large",
        description: "too large",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb"] },
        body: "x".repeat(5_000),
        source_run_ids: ["run-too-large"],
        confidence: 0.9,
        status: "promoted",
        created_at: "2026-09-24T01:00:00.000Z",
        updated_at: "2026-09-24T01:00:00.000Z",
      },
      {
        id: "skill-small",
        name: "small",
        description: "small",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb"] },
        body: "small guidance",
        source_run_ids: ["run-small"],
        confidence: 0.9,
        status: "promoted",
        created_at: "2026-09-24T00:00:00.000Z",
        updated_at: "2026-09-24T00:00:00.000Z",
      },
    ];
    for (const row of rows) saveSkillCandidate(row);

    const resolved = resolveSkillsForTurn(
      "fix the failing import in src/auth.ts",
      "debug",
      { maxTokens: 120 },
    );

    expect(resolved.matched.map((skill) => skill.id)).toEqual(["skill-small"]);
    expect(resolved.omitted.byReason.token_budget).toBe(1);
    expect(countTokens(resolved.promptBlock)).toBeLessThanOrEqual(120);
  });

  test("preserves a byte-stable empty result when no skill matches", () => {
    const resolved = resolveSkillsForTurn(
      "answer a general question",
      "debug",
      { maxSkills: 2, maxTokens: 100 },
    );

    expect(resolved).toMatchObject({
      matched: [],
      promptBlock: "",
      promptTokens: 0,
      totalMatched: 0,
    });
    expect(resolved.omitted.count).toBe(0);
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

  test("dry-run redistillation does not create or read through the candidate store", () => {
    const missingDir = join(tempRoot, "dry-run");
    (globalThis as any).__skillCandidatesDirOverride = missingDir;
    const snapshot: TrajectorySnapshot = {
      id: "traj_dry_run",
      agent_run_id: "run_dry_run",
      session_id: "sess_dry_run",
      snapshot_json: JSON.stringify({
        version: 1,
        agent_run_id: "run_dry_run",
        session_id: "sess_dry_run",
        task_type: "debug",
        run_outcome: "success",
        duration_ms: 100,
        routing: {},
        instruction_variants: {},
        stage_runs: [{ ...baseStageRun, agent_run_id: "run_dry_run" }],
        model_attributions: [],
        user_request: "fix the failing import",
      }),
    };
    const candidate = distillFromTrajectorySnapshot({
      snapshot,
      config: {
        enabled: true,
        min_confidence: 0.5,
        promotion_eval_delta: 0.02,
        max_candidates: 50,
      },
    }, { persist: false });
    expect(candidate).not.toBeNull();
    expect(existsSync(missingDir)).toBe(false);
    expect(readdirSync(tempRoot)).toHaveLength(0);
  });

  test("redistill dry-run uses the non-persisting path", () => {
    const missingDir = join(tempRoot, "redistill-dry-run");
    (globalThis as any).__skillCandidatesDirOverride = missingDir;
    const snapshot: TrajectorySnapshot = {
      id: "traj_redistill_dry_run",
      agent_run_id: "run_redistill_dry_run",
      session_id: "sess_redistill_dry_run",
      snapshot_json: JSON.stringify({
        version: 1,
        agent_run_id: "run_redistill_dry_run",
        session_id: "sess_redistill_dry_run",
        task_type: "debug",
        run_outcome: "success",
        duration_ms: 100,
        routing: {},
        instruction_variants: {},
        stage_runs: [{ ...baseStageRun, agent_run_id: "run_redistill_dry_run" }],
        model_attributions: [],
        user_request: "fix the failing import",
      }),
    };
    const results = redistillSnapshots([snapshot], {
      enabled: true,
      min_confidence: 0.5,
      promotion_eval_delta: 0.02,
      max_candidates: 50,
    }, true);
    expect(results[0].candidate).not.toBeNull();
    expect(existsSync(missingDir)).toBe(false);
  });

  test("rebuilding a promoted source preserves it and creates a separate candidate", () => {
    const config = {
      enabled: true,
      min_confidence: 0.5,
      promotion_eval_delta: 0.02,
      max_candidates: 50,
    };
    const input = {
      ...baseDistillInput,
      agentRunId: "run_rebuild_1",
      stageRuns: [{ ...baseStageRun, agent_run_id: "run_rebuild_1" }],
      runOutcome: "success" as const,
    };
    const original = distillSkillCandidate(input, config);
    expect(original).not.toBeNull();
    const promoted = {
      ...original!,
      status: "promoted" as const,
      promoted_at: "2026-09-23T00:00:00.000Z",
      eval_score: 1,
    };
    saveSkillCandidate(promoted);
    const originalPath = skillCandidatePath(original!.id);
    const originalBytes = readFileSync(originalPath, "utf-8");

    const rebuilt = distillSkillCandidate(input, config);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt!.id).not.toBe(original!.id);
    expect(rebuilt!.name).not.toBe(original!.name);
    expect(rebuilt!.status).toBe("candidate");
    expect(rebuilt!.source_run_ids).toEqual([input.agentRunId]);
    expect(readFileSync(originalPath, "utf-8")).toBe(originalBytes);
    expect(loadSkillCandidate(original!.id)?.status).toBe("promoted");

    const resolved = resolveSkillsForTurn("fix the failing import", "debug");
    expect(resolved.matched.some((skill) => skill.id === original!.id)).toBe(true);
    expect(resolved.matched.some((skill) => skill.id === rebuilt!.id)).toBe(false);
  });

  test("pruning removes only the oldest unreviewed candidates", () => {
    const rows: SkillCandidate[] = [
      {
        id: "prune_old_candidate",
        name: "prune-old-candidate",
        description: "old candidate",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb"] },
        body: "x".repeat(600),
        source_run_ids: ["run_old_candidate"],
        confidence: 0.9,
        status: "candidate",
        created_at: "2026-09-20T00:00:00.000Z",
        updated_at: "2026-09-20T00:00:00.000Z",
      },
      {
        id: "prune_new_candidate",
        name: "prune-new-candidate",
        description: "new candidate",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb"] },
        body: "x".repeat(600),
        source_run_ids: ["run_new_candidate"],
        confidence: 0.9,
        status: "candidate",
        created_at: "2026-09-22T00:00:00.000Z",
        updated_at: "2026-09-22T00:00:00.000Z",
      },
      {
        id: "prune_promoted",
        name: "prune-promoted",
        description: "promoted",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb"] },
        body: "x".repeat(600),
        source_run_ids: ["run_promoted"],
        confidence: 0.9,
        status: "promoted",
        created_at: "2026-09-21T00:00:00.000Z",
        updated_at: "2026-09-21T00:00:00.000Z",
      },
      {
        id: "prune_rejected",
        name: "prune-rejected",
        description: "rejected",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb"] },
        body: "x".repeat(600),
        source_run_ids: ["run_rejected"],
        confidence: 0.9,
        status: "rejected",
        created_at: "2026-09-21T00:00:00.000Z",
        updated_at: "2026-09-21T00:00:00.000Z",
      },
    ];
    for (const row of rows) saveSkillCandidate(row);

    expect(pruneSkillCandidates(1)).toBe(1);
    const remaining = new Set(listSkillCandidates().map((row) => row.id));
    expect(remaining.has("prune_old_candidate")).toBe(false);
    expect(remaining.has("prune_new_candidate")).toBe(true);
    expect(remaining.has("prune_promoted")).toBe(true);
    expect(remaining.has("prune_rejected")).toBe(true);
  });

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
      { ...baseDistillInput, agentRunId: "run_redistill_success_1", stageRuns: [{ ...baseStageRun, agent_run_id: "run_redistill_success_1" }], runOutcome: "success" },
      cfg,
    );
    const degradedCand = distillSkillCandidate(
      { ...baseDistillInput, agentRunId: "run_redistill_degraded_1", stageRuns: [{ ...baseStageRun, agent_run_id: "run_redistill_degraded_1" }], runOutcome: "degraded" },
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

    function groundingStage(runId: string) {
      return {
        id: `stage_${runId}`,
        agent_run_id: runId,
        mode_id: "executor",
        turn_number: 1,
        was_successful: 1,
        had_error: 0,
        tool_calls_json: JSON.stringify([{ name: "read_file", arguments: { path: "src/foo.ts" } }]),
      };
    }

    function groundingDigest(runId: string): string {
      const decoded = decodeSkillStageRuns([groundingStage(runId)], runId);
      if (!decoded.ok) throw new Error("grounding fixture failed to decode");
      return computeSkillToolSequenceDigest(decoded.stages);
    }

    function groundingSnapshot(runId: string) {
      return {
        version: 1,
        agent_run_id: runId,
        session_id: "session_grounding",
        task_type: "debug",
        run_outcome: "success",
        duration_ms: 100,
        routing: {},
        instruction_variants: {},
        stage_runs: [groundingStage(runId)],
        model_attributions: [],
        user_request: "Read the file first.",
        worker_instructions: { executor: "Read the file first." },
      };
    }

    function groundableCandidate(id: string): SkillCandidate {
      const runId = `run_for_${id}`;
      return {
        id, name: `rc-${id}`, description: "x",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb", "read_verb"] },
        body: "## Conductor worker guidance\nRead the file first. ".repeat(20),
        source_run_ids: [runId], source_session_id: "session_grounding", confidence: 0.9, status: "candidate",
        tool_sequence_digest: groundingDigest(runId),
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
    }

    function snapshotFetcherFor(runId: string, _snapshot: { worker_instructions?: Record<string, string>; user_request?: string } | null) {
      return (candidateRunId: string) => (candidateRunId === runId ? groundingSnapshot(runId) : null);
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

    test("contradictory judge verdict leaves the candidate untouched and reports evaluator invalidity", async () => {
      const c = groundableCandidate("rc_judge_contradictory");
      saveSkillCandidate(c);
      const fetcher = snapshotFetcherFor(`run_for_${c.id}`, { worker_instructions: { executor: "Read first." } });
      const contradictoryCallModel: CallModelFn = async (messages, options) => {
        const response = await passingCallModel()(messages, options);
        const parsed = JSON.parse(response.content) as { covered: string[]; missed: string[] };
        return {
          content: JSON.stringify({
            covered: [...parsed.covered, ...parsed.covered],
            missed: parsed.missed,
          }),
        };
      };

      const result = await promoteSkillCandidate(c.id, contradictoryCallModel, promotionCfg, fetcher);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("judge_invalid");
      expect(result.detail).toContain("invalid");
      const reloaded = loadSkillCandidate(c.id);
      expect(reloaded?.status).toBe("candidate");
      expect(reloaded?.eval_score).toBeUndefined();
      expect(reloaded?.rejection_reason).toBeUndefined();
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

    function groundingStage(runId: string) {
      return {
        id: `stage_${runId}`,
        agent_run_id: runId,
        mode_id: "executor",
        turn_number: 1,
        was_successful: 1,
        had_error: 0,
        tool_calls_json: JSON.stringify([{ name: "read_file", arguments: { path: "src/foo.ts" } }]),
      };
    }

    function groundingDigest(runId: string): string {
      const decoded = decodeSkillStageRuns([groundingStage(runId)], runId);
      if (!decoded.ok) throw new Error("grounding fixture failed to decode");
      return computeSkillToolSequenceDigest(decoded.stages);
    }

    function groundingSnapshot(runId: string) {
      return {
        version: 1,
        agent_run_id: runId,
        session_id: "session_grounding",
        task_type: "debug",
        run_outcome: "success",
        duration_ms: 100,
        routing: {},
        instruction_variants: {},
        stage_runs: [groundingStage(runId)],
        model_attributions: [],
        user_request: "Read the file first.",
        worker_instructions: { executor: "Read the file first." },
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
        source_session_id: "session_grounding",
        confidence: 0.9,
        status: "candidate",
        tool_sequence_digest: groundingDigest("run_for_candidate_2"),
        eval_score: 1.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      const fetcher = (runId: string) =>
        runId === "run_for_candidate_2" ? groundingSnapshot(runId) : null;
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

    function groundingStage(runId: string) {
      return {
        id: `stage_${runId}`,
        agent_run_id: runId,
        mode_id: "executor",
        turn_number: 1,
        was_successful: 1,
        had_error: 0,
        tool_calls_json: JSON.stringify([{ name: "read_file", arguments: { path: "src/foo.ts" } }]),
      };
    }

    function groundingDigest(runId: string): string {
      const decoded = decodeSkillStageRuns([groundingStage(runId)], runId);
      if (!decoded.ok) throw new Error("grounding fixture failed to decode");
      return computeSkillToolSequenceDigest(decoded.stages);
    }

    function groundingSnapshot(runId: string) {
      return {
        version: 1,
        agent_run_id: runId,
        session_id: "session_grounding",
        task_type: "debug",
        run_outcome: "success",
        duration_ms: 100,
        routing: {},
        instruction_variants: {},
        stage_runs: [groundingStage(runId)],
        model_attributions: [],
        user_request: "Read the file first.",
        worker_instructions: { executor: "Read the file first." },
      };
    }

    function candidate(id: string): SkillCandidate {
      const runId = `run_for_${id}`;
      return {
        id, name: `rc-${id}`, description: "x",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb"] },
        body: "## Conductor worker guidance\nRead the file first. ".repeat(20),
        source_run_ids: [runId], source_session_id: "session_grounding", confidence: 0.9, status: "candidate",
        tool_sequence_digest: groundingDigest(runId),
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
      const fetcher = (runId: string) => (runId === "run_for_rg3" ? groundingSnapshot(runId) : null);
      const result = await runGroundingJudge(c, passingCallModel(), fetcher);
      expect(result.ok).toBe(true);
      expect(result.ok && result.verdict.score).toBe(1);
    });

    test("invalid judge partition -> judge_invalid", async () => {
      const c = candidate("rg-invalid");
      const fetcher = (runId: string) => (runId === "run_for_rg-invalid" ? groundingSnapshot(runId) : null);
      const result = await runGroundingJudge(c, async (messages) => {
        const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
        const items = [...(userMsg.split("Rubric items")[1] ?? "").matchAll(/^- (.+)$/gm)].map((m) => m[1]);
        return {
          content: JSON.stringify({ covered: [...items, ...items], missed: [] }),
        };
      }, fetcher);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBe("judge_invalid");
    });

    test("judge call throwing -> judge_unavailable", async () => {
      const c = candidate("rg4");
      const fetcher = (runId: string) => (runId === "run_for_rg4" ? groundingSnapshot(runId) : null);
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

  // ---- 2026-07-15 cron: body-floor + suspicious-paths refinements ----
  // Two real production-rejection bugs identified in the F1-F6 plan's
  // "out of scope" backlog:
  //  1. 89 candidates rejected with body_length_out_of_range were
  //     157-391 chars (median 225, p90 305) — the 400 floor over-fitted
  //     to "must have substantial guidance" and rejected legitimate
  //     short user requests (e.g. "continue", "ok", "yes"). New floor
  //     is 150 (any meaningful body is at least the ~110-char template
  //     + some signal).
  //  2. 15 candidates rejected with suspicious_paths had 3+ legitimate
  //     C:\ project paths in their user-request context (the user
  //     really did name those paths; the model didn't invent them).
  //     New check only counts paths in the model-authored "guidance"
  //     section, before the `## Request context (abbreviated)` marker.

  describe("body-length sweet spot (2026-07-15 cron refinement)", () => {
    function inRangeCandidate(id: string, bodyLen: number): SkillCandidate {
      return {
        id, name: `bl-${id}`, description: "x",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb", "read_verb"] },
        body: "y".repeat(bodyLen),
        source_run_ids: ["run_bl"], confidence: 0.9, status: "candidate",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
    }

    test("body of 100 chars (below new floor) is rejected", () => {
      const v = evaluateSkillPromotion(inRangeCandidate("bl_too_short", 100), {
        enabled: true, min_confidence: 0.5, promotion_eval_delta: 0.02, max_candidates: 50,
      });
      expect(v.promote).toBe(false);
      expect(v.reason).toBe("body_length_out_of_range");
      expect(v.detail).toContain("100");
    });

    test("body of 200 chars (above new floor, below old floor) is no longer rejected", () => {
      // The 400-char floor used to reject 200-char bodies; the 150-char
      // floor accepts them. With baseline 0.5 and the +0.02 sweet-spot
      // bonus, the score is 0.9 + 0.02 = 0.92 → delta 0.42 ≫ 0.02
      // promotion_eval_delta, so this candidate promotes.
      const v = evaluateSkillPromotion(inRangeCandidate("bl_now_passes", 200), {
        enabled: true, min_confidence: 0.5, promotion_eval_delta: 0.02, max_candidates: 50,
      });
      expect(v.promote).toBe(true);
    });

    test("body of 150 chars (exactly at floor) passes", () => {
      // Boundary: <= 150 rejected, > 150 accepted. 151 is the smallest
      // body that clears.
      const v = evaluateSkillPromotion(inRangeCandidate("bl_at_floor", 151), {
        enabled: true, min_confidence: 0.5, promotion_eval_delta: 0.02, max_candidates: 50,
      });
      expect(v.promote).toBe(true);
    });

    test("body of 150 chars (exactly at floor) is rejected", () => {
      const v = evaluateSkillPromotion(inRangeCandidate("bl_at_floor_reject", 150), {
        enabled: true, min_confidence: 0.5, promotion_eval_delta: 0.02, max_candidates: 50,
      });
      expect(v.promote).toBe(false);
      expect(v.reason).toBe("body_length_out_of_range");
    });

    test("body of 4000 chars (exactly at ceiling) is rejected", () => {
      const v = evaluateSkillPromotion(inRangeCandidate("bl_at_ceiling", 4000), {
        enabled: true, min_confidence: 0.5, promotion_eval_delta: 0.02, max_candidates: 50,
      });
      expect(v.promote).toBe(false);
      expect(v.reason).toBe("body_length_out_of_range");
    });

    test("body of 3999 chars (just under ceiling) is accepted", () => {
      const v = evaluateSkillPromotion(inRangeCandidate("bl_under_ceiling", 3999), {
        enabled: true, min_confidence: 0.5, promotion_eval_delta: 0.02, max_candidates: 50,
      });
      expect(v.promote).toBe(true);
    });
  });

  describe("suspicious-paths: request-context exception (2026-07-15 cron refinement)", () => {
    // Build a candidate whose body has 3+ C:\ paths in the REQUEST
    // section (which is verbatim from the user) and zero paths in the
    // GUIDANCE section. Pre-fix this would be rejected (15 production
    // cases). Post-fix it must be accepted.
    function userRequestPathCandidate(id: string, userRequestPaths: string[]): SkillCandidate {
      const guidance = "## Conductor worker guidance\nReuse the existing project modules where possible.\n";
      const requestSection = "## Request context (abbreviated)\n" + userRequestPaths.join(" and ");
      return {
        id, name: `sp-${id}`, description: "x",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb", "read_verb"] },
        body: guidance + requestSection,
        source_run_ids: ["run_sp"], confidence: 0.9, status: "candidate",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
    }

    test("3+ paths in the user-request context are not flagged as suspicious", () => {
      // Build paths using String.raw so the runtime value has single
      // backslashes (matching what the distiller actually emits when a
      // user mentions a Windows path). 4 such paths in the request
      // context would be rejected pre-fix; the request-context exception
      // must accept them.
      const v = evaluateSkillPromotion(
        userRequestPathCandidate("sp_user_paths", [
          String.raw`C:\Projects\Versutus\src\foo.ts`,
          String.raw`C:\Projects\Versutus\src\bar.ts`,
          String.raw`C:\Projects\Versutus\src\baz.ts`,
          String.raw`C:\Projects\Versutus\README.md`,
        ]),
        { enabled: true, min_confidence: 0.5, promotion_eval_delta: 0.02, max_candidates: 50 },
      );
      expect(v.promote).toBe(true);
    });

    test("3+ paths in the model-authored guidance are still flagged", () => {
      // Same body shape, but the absolute paths are in the guidance section
      // (BEFORE the request-context marker). The model invented these
      // — they're not from the user — so they should still be flagged.
      // Construct the body with String.raw to avoid JS backslash
      // doubling (each \\ in the runtime string needs to be a single
      // backslash for the C:\ regex to match). Pad the body so it clears
      // the new 150-char floor — the test is about the suspicious-paths
      // gate, not the body-length gate.
      const pathLine = String.raw`Read C:\foo\bar.ts and C:\baz\qux.ts and C:\etc\hosts and C:\windows\system32. `;
      const guidancePrefix = "## Conductor worker guidance\nRefer to the existing project knowledge base for prior art and conventions. ";
      const body = guidancePrefix + pathLine + "## Request context (abbreviated)\nok";
      const c: SkillCandidate = {
        id: "sp_guided_paths", name: "sp-guided", description: "x",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb", "read_verb"] },
        body,
        source_run_ids: ["run_sp"], confidence: 0.9, status: "candidate",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      const v = evaluateSkillPromotion(c, {
        enabled: true, min_confidence: 0.5, promotion_eval_delta: 0.02, max_candidates: 50,
      });
      expect(v.promote).toBe(false);
      expect(v.reason).toBe("suspicious_paths");
    });

    test("mixed: paths in BOTH sections are still flagged if guidance has >2", () => {
      // Two paths in guidance + several in request — guidance is the
      // model-authored part, so it must be the binding constraint.
      // Construct paths with String.raw so the runtime value has
      // single backslashes (the regex anchors on C:\ exactly). Pad
      // the body so it clears the 150-char floor.
      const pathA = String.raw`C:\foo\a.ts`;
      const pathB = String.raw`C:\foo\b.ts`;
      const pathC = String.raw`C:\foo\c.ts`;
      const pathD = String.raw`C:\foo\d.ts`;
      const guidancePrefix = "## Conductor worker guidance\nRefer to the existing project knowledge base for prior art and conventions. ";
      const body = guidancePrefix + "Read " + pathA + " and " + pathB + ". ## Request context (abbreviated)\nuser mentioned " + pathC + " and " + pathD;
      const cand: SkillCandidate = {
        id: "sp_mixed", name: "sp-mixed", description: "x",
        trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb", "read_verb"] },
        body,
        source_run_ids: ["run_sp"], confidence: 0.9, status: "candidate",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      const v = evaluateSkillPromotion(cand, {
        enabled: true, min_confidence: 0.5, promotion_eval_delta: 0.02, max_candidates: 50,
      });
      expect(v.promote).toBe(true); // 2 paths in guidance is below the >2 threshold
    });
  });
});
