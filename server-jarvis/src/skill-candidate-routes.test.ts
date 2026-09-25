import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleSkillCandidateRequest } from "./skill-candidate-routes";
import { loadSkillCandidate, saveSkillCandidate } from "./intelligence/skill-store";
import type { SkillCandidate } from "./intelligence/skill-types";
import type { CallModelFn } from "./orchestration/coordinator";
import { computeSkillToolSequenceDigest, decodeSkillStageRuns } from "./intelligence/skill-source-evidence";

const config = {
  enabled: true,
  min_confidence: 0.5,
  promotion_eval_delta: 0.02,
  max_candidates: 50,
  min_judge_score: 0.75,
};

let root = "";

function groundingStage(runId: string) {
  return {
    id: `stage_${runId}`,
    agent_run_id: runId,
    mode_id: "executor",
    turn_number: 1,
    was_successful: 1,
    had_error: 0,
    tool_calls_json: JSON.stringify([{ name: "read_file", arguments: { path: "src/failing.ts" } }]),
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
    session_id: "session-1",
    task_type: "debug",
    run_outcome: "success",
    duration_ms: 100,
    routing: {},
    instruction_variants: {},
    stage_runs: [groundingStage(runId)],
    model_attributions: [],
    user_request: "Read the failing test before editing.",
    worker_instructions: { executor: "Read the failing test." },
  };
}

function candidate(id = "candidate-1", overrides: Partial<SkillCandidate> = {}): SkillCandidate {
  const runId = `run-${id}`;
  return {
    id,
    name: `distilled-${id}`,
    description: "Synthetic distilled candidate",
    trigger: { task_types: ["debug"], requirements: ["workspace_read"], signals: ["mutation_verb"] },
    body: "## Conductor worker guidance\nRead the failing test before editing. ".repeat(12),
    source_run_ids: [runId],
    source_session_id: "session-1",
    confidence: 0.9,
    status: "candidate",
    tool_sequence_digest: groundingDigest(runId),
    eval_score: 0.8,
    created_at: "2026-09-24T00:00:00.000Z",
    updated_at: "2026-09-24T00:00:00.000Z",
    ...overrides,
  };
}

function request(id: string, action: string, body?: Record<string, unknown>): Request {
  return new Request(`http://jarvis.test/skills/candidates/${id}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

function passingModel(): CallModelFn {
  return async (messages) => {
    const user = messages.find((message) => message.role === "user")?.content ?? "";
    const rubric = user.split("Rubric items")[1] ?? "";
    const items = [...rubric.matchAll(/^- (.+)$/gm)].map((match) => match[1]);
    return { content: JSON.stringify({ covered: items, missed: [] }) };
  };
}

function dependencies(model: CallModelFn = passingModel()) {
  return {
    loadDistillationConfig: () => config,
    makeCallModel: () => model,
    fetchSnapshot: (runId: string) => groundingSnapshot(runId),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jarvis-skill-routes-"));
  (globalThis as { __skillCandidatesDirOverride?: string }).__skillCandidatesDirOverride = root;
});

afterEach(() => {
  delete (globalThis as { __skillCandidatesDirOverride?: string }).__skillCandidatesDirOverride;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("skill candidate lifecycle routes", () => {
  test("applies one expected-version eval transition and returns the authoritative version", async () => {
    saveSkillCandidate(candidate());

    const response = await handleSkillCandidateRequest(request("candidate-1", "eval", { expected_version: 0 }), dependencies());
    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    const body = await response?.json() as Record<string, unknown>;
    expect(body).toMatchObject({ id: "candidate-1", status: "candidate", lifecycle_version: 1 });
    expect(loadSkillCandidate("candidate-1")?.lifecycle_version).toBe(1);
  });

  test("rejects a repeated write using a stale version without changing the record", async () => {
    saveSkillCandidate(candidate());

    const first = await handleSkillCandidateRequest(request("candidate-1", "reject", { expected_version: 0 }), dependencies());
    expect(first?.status).toBe(200);
    expect(await first?.json()).toMatchObject({ status: "rejected", lifecycle_version: 1 });

    const second = await handleSkillCandidateRequest(request("candidate-1", "reject", { expected_version: 0 }), dependencies());
    expect(second?.status).toBe(409);
    expect(await second?.json()).toMatchObject({ error: "stale_version", current_status: "rejected", current_version: 1 });
    expect(loadSkillCandidate("candidate-1")).toMatchObject({ status: "rejected", lifecycle_version: 1 });
  });

  test("fences a delayed promotion against a competing reject", async () => {
    const row = candidate();
    saveSkillCandidate(row);
    let releaseJudge!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { releaseJudge = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const delayedModel: CallModelFn = async (messages, options) => {
      markStarted();
      await gate;
      return passingModel()(messages, options);
    };

    const promotion = handleSkillCandidateRequest(
      request("candidate-1", "promote", { expected_version: 0 }),
      dependencies(delayedModel),
    );
    await started;
    const rejection = await handleSkillCandidateRequest(
      request("candidate-1", "reject", { expected_version: 0 }),
      dependencies(),
    );
    expect(rejection?.status).toBe(200);
    releaseJudge();
    const result = await promotion;

    expect(result?.status).toBe(409);
    expect(await result?.json()).toMatchObject({ error: "stale_version", current_status: "rejected" });
    expect(loadSkillCandidate("candidate-1")).toMatchObject({ status: "rejected", lifecycle_version: 1 });
  });

  test("rejects malformed expected versions before invoking a judge", async () => {
    saveSkillCandidate(candidate());
    let called = false;
    const model: CallModelFn = async (messages, options) => {
      called = true;
      return passingModel()(messages, options);
    };

    const response = await handleSkillCandidateRequest(
      request("candidate-1", "promote", { expected_version: 1.5 }),
      dependencies(model),
    );
    expect(response?.status).toBe(400);
    expect(called).toBe(false);
    expect(loadSkillCandidate("candidate-1")?.lifecycle_version).toBe(0);
  });
});
