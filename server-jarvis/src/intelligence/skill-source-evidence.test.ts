import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { distillSkillCandidate, distillFromTrajectorySnapshot } from "./skill-distiller";
import { runGroundingJudge, promoteSkillCandidate } from "./skill-promotion";
import { loadSkillCandidate, saveSkillCandidate } from "./skill-store";
import {
  computeSkillToolSequenceDigest,
  decodeSkillStageRuns,
  decodeSkillTrajectoryPayload,
} from "./skill-source-evidence";
import type { SkillCandidate } from "./skill-types";
import type { CallModelFn } from "../orchestration/coordinator";
import type { StageRun, TrajectorySnapshot } from "../self-tuning/store";

const config = {
  enabled: true,
  min_confidence: 0.5,
  promotion_eval_delta: 0.02,
  max_candidates: 50,
  min_judge_score: 0.75,
};

function stage(overrides: Partial<StageRun> = {}): StageRun {
  return {
    id: "stage-1",
    agent_run_id: "run-grounding",
    mode_id: "executor",
    turn_number: 1,
    was_successful: 1,
    had_error: 0,
    tool_calls_json: JSON.stringify([
      { name: "read_file", arguments: { path: "src/auth.ts" }, output: "secret output" },
      { name: "grep", arguments: { pattern: "auth" } },
    ]),
    ...overrides,
  };
}

function payload(runId = "run-grounding", stages: StageRun[] = [stage()], overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    agent_run_id: runId,
    session_id: "session-grounding",
    task_type: "debug",
    run_outcome: "success",
    duration_ms: 120,
    routing: {},
    instruction_variants: {},
    stage_runs: stages,
    model_attributions: [],
    user_request: "fix src/auth.ts",
    worker_instructions: { executor: "Read src/auth.ts before editing." },
    ...overrides,
  };
}

function candidate(overrides: Partial<SkillCandidate> = {}): SkillCandidate {
  const decoded = decodeSkillTrajectoryPayload(payload());
  if (!decoded.ok) throw new Error("fixture failed to decode");
  return {
    id: "skill-grounding",
    name: "distilled-debug",
    description: "grounded debug pattern",
    trigger: { task_types: ["debug"], requirements: ["full_execution"], signals: ["mutation_verb"] },
    body: "## Conductor worker guidance\nUse read_file on src/auth.ts. ".repeat(20),
    source_run_ids: ["run-grounding"],
    source_session_id: "session-grounding",
    confidence: 0.9,
    status: "candidate",
    tool_sequence_digest: decoded.trajectory.tool_sequence_digest,
    created_at: "2026-09-25T00:00:00.000Z",
    updated_at: "2026-09-25T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(stages: StageRun[] = [stage()], overrides: Record<string, unknown> = {}): TrajectorySnapshot {
  return {
    id: "trajectory-grounding",
    agent_run_id: "run-grounding",
    session_id: "session-grounding",
    snapshot_json: JSON.stringify(payload("run-grounding", stages, overrides)),
  };
}

describe("skill source evidence", () => {
  test("decodes ordered tool identities and computes a stable digest", () => {
    const first = decodeSkillStageRuns([stage()]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.stages[0].tool_names).toEqual(["read_file", "grep"]);
    const digest = computeSkillToolSequenceDigest(first.stages);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeSkillToolSequenceDigest(first.stages)).toBe(digest);

    const changed = decodeSkillStageRuns([stage({
      tool_calls_json: JSON.stringify([
        { name: "grep", arguments: { pattern: "auth" } },
        { name: "read_file", arguments: { path: "src/auth.ts" } },
      ]),
    })]);
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(computeSkillToolSequenceDigest(changed.stages)).not.toBe(digest);
  });

  test("rejects malformed stage and tool evidence", () => {
    for (const value of [
      null,
      {},
      [{ ...stage(), agent_run_id: "other-run" }],
      [{ ...stage(), turn_number: -1 }],
      [{ ...stage(), tool_calls_json: "{" }],
      [{ ...stage(), tool_calls_json: "{}" }],
      [{ ...stage(), tool_calls_json: JSON.stringify([{ name: "" }]) }],
    ]) {
      const result = decodeSkillStageRuns(value, "run-grounding");
      expect(result.ok).toBe(false);
    }
  });

  test("rejects mismatched or unknown trajectory fields", () => {
    expect(decodeSkillTrajectoryPayload(payload("other-run"), { agentRunId: "run-grounding" }).ok).toBe(false);
    expect(decodeSkillTrajectoryPayload(payload("run-grounding", [], { task_type: "unknown" })).ok).toBe(false);
    expect(decodeSkillTrajectoryPayload(payload("run-grounding", [], { run_outcome: "partial" })).ok).toBe(false);
    expect(decodeSkillTrajectoryPayload(payload("run-grounding", [], { version: 2 })).ok).toBe(false);
  });

  test("distillation persists the digest and fails closed on malformed direct evidence", () => {
    const valid = distillSkillCandidate({
      agentRunId: "run-grounding",
      sessionId: "session-grounding",
      taskType: "debug",
      userRequest: "fix src/auth.ts",
      stageRuns: [stage()],
      runOutcome: "success",
    }, config);
    expect(valid?.tool_sequence_digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const invalid = distillSkillCandidate({
      agentRunId: "run-grounding",
      sessionId: "session-grounding",
      taskType: "debug",
      userRequest: "fix src/auth.ts",
      stageRuns: [{ ...stage(), tool_calls_json: "not-json" }],
      runOutcome: "success",
    }, config);
    expect(invalid).toBeNull();
  });

  test("snapshot distillation rejects a stage bound to another run", () => {
    const valid = distillFromTrajectorySnapshot({ snapshot: snapshot(), config }, { persist: false });
    expect(valid?.tool_sequence_digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const mismatched = snapshot([stage({ agent_run_id: "other-run" })]);
    expect(distillFromTrajectorySnapshot({ snapshot: mismatched, config }, { persist: false })).toBeNull();
  });

  test("grounding judge exposes bounded tool and path evidence", async () => {
    let prompt = "";
    const callModel: CallModelFn = async (messages) => {
      prompt = messages.find((message) => message.role === "user")?.content ?? "";
      const rubric = prompt.split("Rubric items")[1] ?? "";
      const items = [...rubric.matchAll(/^- (.+)$/gm)].map((match) => match[1]);
      return { content: JSON.stringify({ covered: items, missed: [] }) };
    };
    const result = await runGroundingJudge(candidate(), callModel, () => payload());
    expect(result.ok).toBe(true);
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("src/auth.ts");
    expect(prompt).not.toContain("secret output");
  });

  test("grounding rejects unobserved tools and paths before the judge", async () => {
    let called = false;
    const callModel: CallModelFn = async () => {
      called = true;
      return { content: "{\"covered\":[],\"missed\":[]}" };
    };
    const unobserved = candidate({
      body: "## Conductor worker guidance\nUse unobserved_tool on src/auth.ts. ".repeat(20),
    });
    const result = await runGroundingJudge(unobserved, callModel, () => payload());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe("no_grounding_source");
    expect(called).toBe(false);
  });

  test("legacy candidates without a digest cannot be promoted", async () => {
    const legacy = candidate({ tool_sequence_digest: undefined });
    const result = await runGroundingJudge(legacy, async () => ({ content: "{\"covered\":[],\"missed\":[]}" }), () => payload());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe("no_grounding_source");
  });

  test("promotion records a grounding rejection for an unobserved claim", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-grounding-"));
    (globalThis as any).__skillCandidatesDirOverride = root;
    const c = candidate({
      id: "skill-grounding-rejected",
      body: "## Conductor worker guidance\nUse unobserved_tool on src/auth.ts. ".repeat(20),
    });
    saveSkillCandidate(c);
    let called = false;
    try {
      const result = await promoteSkillCandidate(c.id, async () => {
        called = true;
        return { content: "{\"covered\":[],\"missed\":[]}" };
      }, config, () => payload());
      expect(called).toBe(false);
      expect(result.ok).toBe(true);
      expect(result.candidate?.status).toBe("rejected");
      expect(loadSkillCandidate(c.id)?.rejection_reason).toBe("eval_failed");
    } finally {
      delete (globalThis as any).__skillCandidatesDirOverride;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
