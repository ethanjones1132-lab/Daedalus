import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { decodeBulkSkillPromotionRequest, PromoteRequestInvalidError } from "./skill-promotion-request";
import { promoteCandidates } from "./intelligence/skill-promotion";
import { loadSkillCandidate } from "./intelligence/skill-store";
import type { SkillCandidate } from "./intelligence/skill-types";
import { computeSkillToolSequenceDigest, decodeSkillStageRuns } from "./intelligence/skill-source-evidence";
import { stagePromotionFixture } from "./test-utils/skill-promotion-fixture";

const hash = `sha256:${"a".repeat(64)}`;
function body(overrides: Record<string, unknown> = {}) {
  return { candidates: [{ candidate_id: "bulk-candidate", report_hash: hash, record_hash: hash, expected_version: 1, ...overrides }] };
}

describe("bulk skill promotion request decoder", () => {
  test("preserves canonical proof hashes and lifecycle version", () => {
    expect(decodeBulkSkillPromotionRequest(body())).toEqual([{
      candidateId: "bulk-candidate", reportHash: hash, decisionRecordHash: hash, expectedLifecycleVersion: 1,
    }]);
  });

  test("rejects bare or malformed hashes for both proof fields", () => {
    for (const field of ["report_hash", "record_hash"]) {
      for (const value of ["a".repeat(64), `sha256:${"A".repeat(64)}`, `sha256:${"a".repeat(63)}`, `sha256:${"g".repeat(64)}`, null, undefined]) {
        expect(() => decodeBulkSkillPromotionRequest(body({ [field]: value }))).toThrow(PromoteRequestInvalidError);
        expect(() => decodeBulkSkillPromotionRequest(body({ [field]: value }))).toThrow(field);
      }
    }
  });

  test("rejects empty lists, duplicate candidates, and invalid versions", () => {
    for (const value of [null, {}, { candidates: [] }, { candidates: [null] }, { candidates: [...body().candidates, ...body().candidates] }, body({ expected_version: -1 }), body({ expected_version: 1.5 }), body({ candidate_id: " " })]) {
      expect(() => decodeBulkSkillPromotionRequest(value)).toThrow(PromoteRequestInvalidError);
    }
  });
});

describe("decoded bulk requests bind to durable promotion proof", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jarvis-bulk-proof-"));
    (globalThis as any).__skillCandidatesDirOverride = root;
  });
  afterEach(() => {
    delete (globalThis as any).__skillCandidatesDirOverride;
    rmSync(root, { recursive: true, force: true });
  });
  const cfg = { enabled: true, min_confidence: 0.5, promotion_eval_delta: 0.02, max_candidates: 50, min_judge_score: 0.75 };
  const stage = { id: "stage-bulk", agent_run_id: "run-bulk", mode_id: "executor", turn_number: 1, was_successful: 1, had_error: 0, tool_calls_json: "[]" };
  function candidate(): SkillCandidate {
    const decoded = decodeSkillStageRuns([stage], "run-bulk");
    if (!decoded.ok) throw new Error("invalid stage fixture");
    return {
      id: "bulk-candidate", name: "bulk-candidate", description: "Read before editing",
      trigger: { task_types: ["debug"], requirements: ["workspace_read"], signals: ["read_verb"] },
      body: "## Conductor worker guidance\nRead before editing. ".repeat(12),
      source_run_ids: ["run-bulk"], confidence: 0.9, status: "candidate", eval_score: 1,
      tool_sequence_digest: computeSkillToolSequenceDigest(decoded.stages),
      created_at: "2026-10-14T00:00:00.000Z", updated_at: "2026-10-14T00:00:00.000Z",
    };
  }
  function snapshot() {
    return { version: 1, agent_run_id: "run-bulk", session_id: "session-bulk", task_type: "debug", run_outcome: "success", duration_ms: 100, routing: {}, instruction_variants: {}, stage_runs: [stage], model_attributions: [], user_request: "Read before editing", worker_instructions: {} };
  }

  test("canonical decoded proof reaches the judge and persists a verified promotion", async () => {
    const c = candidate();
    const proof = stagePromotionFixture(c, root);
    const requests = decodeBulkSkillPromotionRequest(body({ report_hash: proof.reportHash, record_hash: proof.decisionRecordHash, expected_version: proof.expectedLifecycleVersion }));
    let calls = 0;
    const model = async (messages: Array<{ role: string; content: string }>) => {
      calls++;
      const rubric = messages.find(message => message.role === "user")!.content.split("Rubric items")[1];
      return { content: JSON.stringify({ covered: [...rubric.matchAll(/^- (.+)$/gm)].map(match => match[1]), missed: [] }) };
    };
    const decisions = await promoteCandidates(requests, model, cfg, snapshot, { root });
    expect(decisions).toMatchObject([{ candidate_id: c.id, decision: "promote" }]);
    expect(loadSkillCandidate(c.id)).toMatchObject({ status: "promoted", lifecycle_version: 2 });
    expect(calls).toBe(1);
  });

  test("a well-formed altered hash reaches binding and is refused before the judge", async () => {
    const c = candidate();
    const proof = stagePromotionFixture(c, root);
    const requests = decodeBulkSkillPromotionRequest(body({ report_hash: proof.reportHash, record_hash: `sha256:${"0".repeat(64)}`, expected_version: proof.expectedLifecycleVersion }));
    let called = false;
    const decisions = await promoteCandidates(requests, async () => { called = true; return { content: "" }; }, cfg, snapshot, { root });
    expect(decisions).toMatchObject([{ candidate_id: c.id, decision: "blocked", reason: "candidate_binding_mismatch" }]);
    expect(loadSkillCandidate(c.id)).toMatchObject({ status: "staged", lifecycle_version: 1 });
    expect(called).toBe(false);
  });
});
