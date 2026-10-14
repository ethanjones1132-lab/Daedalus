import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promoteSkillCandidate, type SkillPromotionProof } from "./skill-promotion";
import { loadSkillCandidate } from "./skill-store";
import type { SkillCandidate } from "./skill-types";
import { computeSkillToolSequenceDigest, decodeSkillStageRuns } from "./skill-source-evidence";
import { stagePromotionFixture } from "../test-utils/skill-promotion-fixture";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jarvis-promotion-proof-"));
  (globalThis as any).__skillCandidatesDirOverride = root;
});
afterEach(() => { delete (globalThis as any).__skillCandidatesDirOverride; rmSync(root, { recursive: true, force: true }); });
const cfg = { enabled: true, min_confidence: 0.5, promotion_eval_delta: 0.02, max_candidates: 50, min_judge_score: 0.75 };
const stage = { id: "stage-proof", agent_run_id: "run-proof", mode_id: "executor", turn_number: 1, was_successful: 1, had_error: 0, tool_calls_json: "[]" };
function candidate(): SkillCandidate {
  const decoded = decodeSkillStageRuns([stage], "run-proof");
  if (!decoded.ok) throw new Error("invalid stage fixture");
  return { id: "proof-fixture", name: "proof-fixture", description: "Read before editing", trigger: { task_types: ["debug"], requirements: ["workspace_read"], signals: ["read_verb"] }, body: "## Conductor worker guidance\nRead before editing. ".repeat(12), source_run_ids: ["run-proof"], confidence: 0.9, status: "candidate", tool_sequence_digest: computeSkillToolSequenceDigest(decoded.stages), created_at: "2026-10-14T00:00:00.000Z", updated_at: "2026-10-14T00:00:00.000Z" };
}
test("promotes only against the isolated durable accepted proof and retries without a judge", async () => {
  const c = candidate();
  const proof = stagePromotionFixture(c, root);
  let calls = 0;
  const model = async (messages: Array<{ role: string; content: string }>) => {
    calls++;
    const rubric = messages.find(m => m.role === "user")!.content.split("Rubric items")[1];
    return { content: JSON.stringify({ covered: [...rubric.matchAll(/^- (.+)$/gm)].map(m => m[1]), missed: [] }) };
  };
  const snapshot = () => ({ version: 1, agent_run_id: "run-proof", session_id: "session-proof", task_type: "debug", run_outcome: "success", duration_ms: 100, routing: {}, instruction_variants: {}, stage_runs: [stage], model_attributions: [], user_request: "Read before editing", worker_instructions: {} });
  const result = await promoteSkillCandidate(c.id, model, cfg, proof, snapshot, { root });
  expect(result.ok).toBe(true);
  expect(loadSkillCandidate(c.id)).toMatchObject({ status: "promoted", lifecycle_version: 2 });
  expect(calls).toBe(1);
  const retry = await promoteSkillCandidate(c.id, model, cfg, proof, snapshot, { root });
  expect(retry.ok).toBe(true);
  expect(calls).toBe(1);
});
test("missing proof fails closed without a model call", async () => {
  const c = candidate();
  stagePromotionFixture(c, root);
  let called = false;
  const result = await promoteSkillCandidate(c.id, async () => { called = true; return { content: "" }; }, cfg, undefined as unknown as SkillPromotionProof, () => null, { root });
  expect(result).toMatchObject({ ok: false, error: "evidence_required" });
  expect(called).toBe(false);
  expect(loadSkillCandidate(c.id)?.status).toBe("staged");
});

test("a passing score cannot replace missing durable proof", async () => {
  const c = { ...candidate(), eval_score: 1 };
  const proof = stagePromotionFixture(c, root);
  let called = false;
  const result = await promoteSkillCandidate(c.id, async () => { called = true; return { content: "" }; }, cfg,
    { ...proof, reportHash: `sha256:${"0".repeat(64)}` }, () => null, { root });
  expect(result).toMatchObject({ ok: false, error: "evidence_required" });
  expect(called).toBe(false);
  expect(loadSkillCandidate(c.id)?.status).toBe("staged");
});

test("a mismatched decision hash or lifecycle version is blocked before the judge", async () => {
  const c = candidate();
  const proof = stagePromotionFixture(c, root);
  let called = false;
  const model = async () => { called = true; return { content: "" }; };
  const tampered = await promoteSkillCandidate(c.id, model, cfg,
    { ...proof, decisionRecordHash: `sha256:${"0".repeat(64)}` }, () => null, { root });
  expect(tampered).toMatchObject({ ok: false, error: "candidate_binding_mismatch" });
  const stale = await promoteSkillCandidate(c.id, model, cfg,
    { ...proof, expectedLifecycleVersion: proof.expectedLifecycleVersion + 1 }, () => null, { root });
  expect(stale).toMatchObject({ ok: false, error: "stale_version" });
  expect(called).toBe(false);
  expect(loadSkillCandidate(c.id)).toMatchObject({ status: "staged", lifecycle_version: 1 });
});
