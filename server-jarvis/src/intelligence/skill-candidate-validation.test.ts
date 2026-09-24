import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { handleSkillCandidateRequest } from "../skill-candidate-routes";
import {
  listSkillCandidates,
  loadSkillCandidate,
  skillCandidatePath,
} from "./skill-store";
import { resolveSkillsForConductor, resolveSkillsForTurn } from "./skill-resolver";
import { promoteSkillCandidate } from "./skill-promotion";
import { distillSkillCandidate } from "./skill-distiller";
import type { SkillCandidate } from "./skill-types";
import type { CallModelFn } from "../orchestration/coordinator";

const config = {
  enabled: true,
  min_confidence: 0.5,
  promotion_eval_delta: 0.02,
  max_candidates: 50,
  min_judge_score: 0.75,
};

let root = "";

function candidate(id = "candidate-1", overrides: Partial<SkillCandidate> = {}): SkillCandidate {
  return {
    id,
    name: `distilled-${id}`,
    description: "Synthetic candidate",
    trigger: { task_types: ["debug"], requirements: ["workspace_read"], signals: ["mutation_verb"] },
    body: "## Conductor worker guidance\nRead the failing test before editing. ".repeat(12),
    source_run_ids: [`run-${id}`],
    source_session_id: "session-1",
    confidence: 0.9,
    status: "candidate",
    created_at: "2026-09-24T00:00:00.000Z",
    updated_at: "2026-09-24T00:00:00.000Z",
    ...overrides,
  };
}

function writeRaw(id: string, value: unknown): string {
  const path = skillCandidatePath(id);
  mkdirSync(dirname(path), { recursive: true });
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  writeFileSync(path, raw, "utf-8");
  return raw;
}

function rawPath(id: string): string {
  return skillCandidatePath(id);
}

function routeRequest(id: string, action: string): Request {
  return new Request(`http://jarvis.test/skills/candidates/${id}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expected_version: 0 }),
  });
}

function routeDependencies(): {
  loadDistillationConfig: () => typeof config;
  makeCallModel: () => CallModelFn;
  fetchSnapshot: () => { worker_instructions: Record<string, string> };
} {
  return {
    loadDistillationConfig: () => config,
    makeCallModel: () => async () => ({ content: "{}" }),
    fetchSnapshot: () => ({ worker_instructions: { executor: "Read first." } }),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jarvis-skill-validation-"));
  (globalThis as { __skillCandidatesDirOverride?: string }).__skillCandidatesDirOverride = root;
});

afterEach(() => {
  delete (globalThis as { __skillCandidatesDirOverride?: string }).__skillCandidatesDirOverride;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("persisted skill candidate validation", () => {
  test("quarantines malformed records while accepting a legacy record at version zero", () => {
    const legacy = candidate("legacy");
    delete legacy.lifecycle_version;
    const rawValues: Array<[string, unknown]> = [
      ["null-record", null],
      ["array-record", []],
      ["malformed-json", "{not-json"],
      ["missing-id", { ...candidate("missing-id"), id: undefined }],
      ["missing-body", { ...candidate("missing-body"), body: undefined }],
      ["missing-trigger", { ...candidate("missing-trigger"), trigger: undefined }],
      ["missing-source-ids", { ...candidate("missing-source-ids"), source_run_ids: undefined }],
      ["missing-created-at", { ...candidate("missing-created-at"), created_at: undefined }],
      ["wrong-id", { ...candidate("wrong-id"), id: 7 }],
      ["wrong-name", { ...candidate("wrong-name"), name: null }],
      ["wrong-body", { ...candidate("wrong-body"), body: 42 }],
      ["wrong-trigger", { ...candidate("wrong-trigger"), trigger: null }],
      ["wrong-task-types", { ...candidate("wrong-task-types"), trigger: { task_types: "debug", requirements: [], signals: [] } }],
      ["wrong-source-ids", { ...candidate("wrong-source-ids"), source_run_ids: "run" }],
      ["wrong-source-session", { ...candidate("wrong-source-session"), source_session_id: 7 }],
      ["wrong-created-at", { ...candidate("wrong-created-at"), created_at: "not-a-timestamp" }],
      ["wrong-updated-at", { ...candidate("wrong-updated-at"), updated_at: null }],
      ["wrong-status", { ...candidate("wrong-status"), status: "published" }],
      ["wrong-confidence", { ...candidate("wrong-confidence"), confidence: "0.9" }],
      ["wrong-version", { ...candidate("wrong-version"), lifecycle_version: 1.5 }],
      ["null-version", { ...candidate("null-version"), lifecycle_version: null }],
      ["wrong-eval-score", { ...candidate("wrong-eval-score"), eval_score: "high" }],
      ["wrong-eval-missed", { ...candidate("wrong-eval-missed"), eval_missed: "missed" }],
      ["wrong-rejection-reason", { ...candidate("wrong-rejection-reason"), rejection_reason: "unknown" }],
      ["wrong-promoted-at", { ...candidate("wrong-promoted-at"), promoted_at: "not-a-timestamp" }],
      ["wrong-tool-digest", { ...candidate("wrong-tool-digest"), tool_sequence_digest: 7 }],
      ["legacy", legacy],
    ];

    for (const [id, value] of rawValues) writeRaw(id, value);

    expect(loadSkillCandidate("null-record")).toBeNull();
    expect(loadSkillCandidate("array-record")).toBeNull();
    expect(loadSkillCandidate("malformed-json")).toBeNull();
    expect(loadSkillCandidate("missing-id")).toBeNull();
    expect(loadSkillCandidate("missing-body")).toBeNull();
    expect(loadSkillCandidate("missing-trigger")).toBeNull();
    expect(loadSkillCandidate("missing-source-ids")).toBeNull();
    expect(loadSkillCandidate("missing-created-at")).toBeNull();
    expect(loadSkillCandidate("wrong-id")).toBeNull();
    expect(loadSkillCandidate("wrong-name")).toBeNull();
    expect(loadSkillCandidate("wrong-body")).toBeNull();
    expect(loadSkillCandidate("wrong-trigger")).toBeNull();
    expect(loadSkillCandidate("wrong-task-types")).toBeNull();
    expect(loadSkillCandidate("wrong-source-ids")).toBeNull();
    expect(loadSkillCandidate("wrong-source-session")).toBeNull();
    expect(loadSkillCandidate("wrong-created-at")).toBeNull();
    expect(loadSkillCandidate("wrong-updated-at")).toBeNull();
    expect(loadSkillCandidate("wrong-status")).toBeNull();
    expect(loadSkillCandidate("wrong-confidence")).toBeNull();
    expect(loadSkillCandidate("wrong-version")).toBeNull();
    expect(loadSkillCandidate("null-version")).toBeNull();
    expect(loadSkillCandidate("wrong-eval-score")).toBeNull();
    expect(loadSkillCandidate("wrong-eval-missed")).toBeNull();
    expect(loadSkillCandidate("wrong-rejection-reason")).toBeNull();
    expect(loadSkillCandidate("wrong-promoted-at")).toBeNull();
    expect(loadSkillCandidate("wrong-tool-digest")).toBeNull();
    expect(loadSkillCandidate("legacy")?.lifecycle_version).toBe(0);
    expect(listSkillCandidates().map((row) => row.id)).toEqual(["legacy"]);
  });

  test("does not expose corrupt promoted records to either resolver", () => {
    const trigger = { task_types: ["debug"], requirements: [], signals: [] } as SkillCandidate["trigger"];
    const valid = candidate("valid-promoted", { status: "promoted", trigger });
    writeRaw("valid-promoted", valid);
    writeRaw("bad-body", { ...candidate("bad-body", { status: "promoted", trigger }), body: 42 });
    writeRaw("bad-signals", {
      ...candidate("bad-signals", { status: "promoted" }),
      trigger: { task_types: ["debug"], requirements: [], signals: "mutation_verb" },
    });

    const turn = resolveSkillsForTurn("please inspect src/foo.ts and summarize it", "debug");
    expect(turn.matched.map((row) => row.id)).toEqual(["valid-promoted"]);
    expect(turn.promptBlock).not.toContain("bad-body");
    expect(turn.promptBlock).not.toContain("bad-signals");
    expect(() => resolveSkillsForConductor("please inspect the workspace")).not.toThrow();
    const hint = resolveSkillsForConductor("please inspect the workspace");
    expect(hint).toContain("distilled-valid-promoted");
    expect(hint).not.toContain("bad-body");
    expect(hint).not.toContain("bad-signals");
  });

  test("refuses a corrupt candidate before promotion and preserves its source file", async () => {
    const original = JSON.stringify({ ...candidate("bad-promotion", { status: "promoted" }), body: 42 });
    writeRaw("bad-promotion", original);
    let modelCalled = false;
    const model: CallModelFn = async () => {
      modelCalled = true;
      return { content: "{}" };
    };

    const result = await promoteSkillCandidate("bad-promotion", model, config, () => null);

    expect(result).toEqual({ ok: false, error: "invalid_candidate_record" });
    expect(modelCalled).toBe(false);
    expect(readFileSync(rawPath("bad-promotion"), "utf-8")).toBe(original);
  });

  test("rebuilds around a corrupt persisted candidate without overwriting it", () => {
    const id = "skill_debug_abcdefgh";
    const original = "{broken";
    writeRaw(id, original);

    const result = distillSkillCandidate({
      agentRunId: "run-raw-abcdefgh",
      sessionId: "session-raw",
      taskType: "debug",
      userRequest: "inspect the failing import",
      stageRuns: [{
        id: "stage-raw",
        agent_run_id: "run-raw-abcdefgh",
        mode_id: "executor",
        turn_number: 1,
        was_successful: 1,
        had_error: 0,
      }],
      runOutcome: "success",
    }, config);

    expect(result?.id).not.toBe(id);
    expect(readFileSync(rawPath(id), "utf-8")).toBe(original);
    expect(loadSkillCandidate(result!.id)).not.toBeNull();
  });

  test("returns a redacted invalid-record response without rewriting the file", async () => {
    const original = JSON.stringify({ ...candidate("bad-route"), body: { secret: "secret candidate body" } });
    writeRaw("bad-route", original);

    const response = await handleSkillCandidateRequest(routeRequest("bad-route", "reject"), routeDependencies());
    const body = await response?.json() as Record<string, unknown>;

    expect(response?.status).toBe(422);
    expect(body).toEqual({ error: "invalid_candidate_record", reason: "invalid_candidate_record" });
    expect(JSON.stringify(body)).not.toContain("secret candidate body");
    expect(readFileSync(rawPath("bad-route"), "utf-8")).toBe(original);
  });
});
