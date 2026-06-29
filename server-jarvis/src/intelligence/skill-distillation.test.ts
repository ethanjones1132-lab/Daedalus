import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { distillSkillCandidate } from "./skill-distiller";
import { listSkillCandidates, saveSkillCandidate } from "./skill-store";
import { resolveSkillsForTurn } from "./skill-resolver";
import { evaluateSkillPromotion, runSkillPromotionPass } from "./skill-promotion";
import type { SkillCandidate } from "./skill-types";

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

    const verdict = evaluateSkillPromotion(listSkillCandidates("candidate")[0]!, {
      enabled: true,
      min_confidence: 0.5,
      promotion_eval_delta: 0.02,
      max_candidates: 50,
    });
    expect(verdict.promote).toBe(true);

    const promoted = runSkillPromotionPass({
      enabled: true,
      min_confidence: 0.5,
      promotion_eval_delta: 0.02,
      max_candidates: 50,
    });
    expect(promoted.length).toBeGreaterThan(0);
    expect(listSkillCandidates("promoted").length).toBeGreaterThan(0);
  });
});