import { createHash } from "node:crypto";
import type { TaskType } from "../orchestration/coordinator";
import type { StageRun, TrajectorySnapshot } from "../self-tuning/store";
import { decodeToolCallEvidence, type StoredToolCallEvidence } from "../eval/tool-evidence";

const TASK_TYPES = new Set<TaskType>([
  "code_review",
  "debug",
  "refactor",
  "general",
  "plan",
  "research",
  "test",
  "docs",
]);

const RUN_OUTCOMES = new Set(["success", "degraded", "failed"]);

export type SkillSourceEvidenceDecodeErrorCode =
  | "malformed_json"
  | "invalid_envelope"
  | "identity_mismatch"
  | "unsupported_version"
  | "invalid_task_type"
  | "invalid_outcome"
  | "invalid_stage_runs"
  | "invalid_stage"
  | "invalid_tool_evidence"
  | "invalid_worker_instructions"
  | "invalid_user_request";

export interface SkillToolSequenceEntry {
  id: string;
  mode_id: string;
  turn_number: number;
  tool_names: readonly string[];
}

export interface DecodedSkillStageEvidence extends SkillToolSequenceEntry {
  agent_run_id: string;
  was_successful: number;
  had_error: number;
  tool_calls: StoredToolCallEvidence[];
  stage: StageRun;
}

export interface DecodedSkillTrajectory {
  version: 1;
  agent_run_id: string;
  session_id: string;
  task_type: TaskType;
  run_outcome: "success" | "degraded" | "failed";
  worker_instructions: Record<string, string>;
  user_request: string;
  stage_runs: DecodedSkillStageEvidence[];
  tool_sequence_digest: string;
}

export type SkillSourceEvidenceDecodeResult =
  | { ok: true; trajectory: DecodedSkillTrajectory }
  | { ok: false; code: SkillSourceEvidenceDecodeErrorCode; stageIndex?: number };

export type SkillStageEvidenceDecodeResult =
  | { ok: true; stages: DecodedSkillStageEvidence[] }
  | { ok: false; code: SkillSourceEvidenceDecodeErrorCode; stageIndex?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalidStage(code: SkillSourceEvidenceDecodeErrorCode, stageIndex: number): SkillStageEvidenceDecodeResult {
  return { ok: false, code, stageIndex };
}

export function computeSkillToolSequenceDigest(stages: readonly SkillToolSequenceEntry[]): string {
  const canonical = stages.map((stage) => ({
    stage_id: stage.id,
    mode_id: stage.mode_id,
    turn_number: stage.turn_number,
    tool_names: [...stage.tool_names],
  }));
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

export function decodeSkillStageRuns(
  value: unknown,
  expectedAgentRunId?: string,
): SkillStageEvidenceDecodeResult {
  if (!Array.isArray(value)) return { ok: false, code: "invalid_stage_runs" };
  const stages: DecodedSkillStageEvidence[] = [];

  for (const [stageIndex, raw] of value.entries()) {
    if (!isRecord(raw)) return invalidStage("invalid_stage", stageIndex);
    if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.mode_id)) {
      return invalidStage("invalid_stage", stageIndex);
    }
    if (!isNonEmptyString(raw.agent_run_id)) return invalidStage("invalid_stage", stageIndex);
    if (expectedAgentRunId !== undefined && raw.agent_run_id !== expectedAgentRunId) {
      return invalidStage("identity_mismatch", stageIndex);
    }
    if (!Number.isSafeInteger(raw.turn_number) || (raw.turn_number as number) < 0) {
      return invalidStage("invalid_stage", stageIndex);
    }
    if (raw.was_successful !== 0 && raw.was_successful !== 1) {
      return invalidStage("invalid_stage", stageIndex);
    }
    if (raw.had_error !== 0 && raw.had_error !== 1) {
      return invalidStage("invalid_stage", stageIndex);
    }
    if (raw.tool_calls_json !== undefined && raw.tool_calls_json !== null && typeof raw.tool_calls_json !== "string") {
      return invalidStage("invalid_tool_evidence", stageIndex);
    }

    const toolResult = decodeToolCallEvidence(
      typeof raw.tool_calls_json === "string" ? raw.tool_calls_json : undefined,
    );
    if (!toolResult.ok) return invalidStage("invalid_tool_evidence", stageIndex);

    const toolCalls = toolResult.calls;
    const stage: StageRun = {
      id: raw.id,
      agent_run_id: raw.agent_run_id,
      mode_id: raw.mode_id,
      turn_number: raw.turn_number as number,
      was_successful: raw.was_successful as number,
      had_error: raw.had_error as number,
      ...(typeof raw.tool_calls_json === "string" ? { tool_calls_json: raw.tool_calls_json } : {}),
    };
    stages.push({
      id: stage.id,
      agent_run_id: stage.agent_run_id,
      mode_id: stage.mode_id,
      turn_number: stage.turn_number,
      was_successful: stage.was_successful,
      had_error: stage.had_error,
      tool_names: toolCalls.map((call) => call.name),
      tool_calls: toolCalls,
      stage,
    });
  }

  return { ok: true, stages };
}

function decodeWorkerInstructions(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const entries: Record<string, string> = {};
  for (const [key, text] of Object.entries(value)) {
    if (!isNonEmptyString(key) || typeof text !== "string") return null;
    entries[key] = text;
  }
  return entries;
}

export function decodeSkillTrajectoryPayload(
  value: unknown,
  expected: { agentRunId?: string; sessionId?: string } = {},
): SkillSourceEvidenceDecodeResult {
  if (!isRecord(value)) return { ok: false, code: "invalid_envelope" };
  if (value.version !== 1) return { ok: false, code: "unsupported_version" };
  if (!isNonEmptyString(value.agent_run_id) || !isNonEmptyString(value.session_id)) {
    return { ok: false, code: "invalid_envelope" };
  }
  if (expected.agentRunId !== undefined && value.agent_run_id !== expected.agentRunId) {
    return { ok: false, code: "identity_mismatch" };
  }
  if (expected.sessionId !== undefined && value.session_id !== expected.sessionId) {
    return { ok: false, code: "identity_mismatch" };
  }
  if (typeof value.task_type !== "string" || !TASK_TYPES.has(value.task_type as TaskType)) {
    return { ok: false, code: "invalid_task_type" };
  }
  if (typeof value.run_outcome !== "string" || !RUN_OUTCOMES.has(value.run_outcome)) {
    return { ok: false, code: "invalid_outcome" };
  }
  if (typeof value.user_request !== "string") {
    return { ok: false, code: "invalid_user_request" };
  }
  const workerInstructions = decodeWorkerInstructions(value.worker_instructions);
  if (workerInstructions === null) return { ok: false, code: "invalid_worker_instructions" };
  const stages = decodeSkillStageRuns(value.stage_runs, value.agent_run_id as string);
  if (!stages.ok) return stages;
  const trajectory: DecodedSkillTrajectory = {
    version: 1,
    agent_run_id: value.agent_run_id,
    session_id: value.session_id,
    task_type: value.task_type as TaskType,
    run_outcome: value.run_outcome as "success" | "degraded" | "failed",
    worker_instructions: workerInstructions,
    user_request: value.user_request,
    stage_runs: stages.stages,
    tool_sequence_digest: computeSkillToolSequenceDigest(stages.stages),
  };
  return { ok: true, trajectory };
}

export function decodeSkillTrajectorySnapshot(snapshot: TrajectorySnapshot): SkillSourceEvidenceDecodeResult {
  if (!isNonEmptyString(snapshot.id) || !isNonEmptyString(snapshot.agent_run_id) || !isNonEmptyString(snapshot.session_id) || typeof snapshot.snapshot_json !== "string") {
    return { ok: false, code: "invalid_envelope" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(snapshot.snapshot_json);
  } catch {
    return { ok: false, code: "malformed_json" };
  }
  const decoded = decodeSkillTrajectoryPayload(payload, {
    agentRunId: snapshot.agent_run_id,
    sessionId: snapshot.session_id,
  });
  if (!decoded.ok) return decoded;
  return decoded;
}
