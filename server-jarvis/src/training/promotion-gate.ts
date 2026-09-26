/** Offline-only quality gate for promoting a trained or distilled candidate.
 *
 * This module deliberately has no model, filesystem, network, or tool-runtime
 * dependencies. A caller must provide redacted corpus rows and replay results;
 * a candidate cannot become primary merely because a heuristic score looks good.
 *
 * Replay evidence and the expected-case manifest are decoded strictly before
 * anything is scored (see ./replay-evidence.ts): a missing, duplicated, or
 * unlisted case id, an absent score, or a score that is not a finite fraction
 * rejects the promotion rather than quietly shrinking the pass-rate denominator
 * or dropping a regression from the count. Corpus provenance stays a separate
 * check — a corpus row's own id is never evidence that a replay case ran.
 */

import {
  decodeReplayCoverageContract,
  decodeReplayEvidence,
  verifyReplayCoverage,
  ReplayEvidenceError,
  type ReplayCoverage,
  type ReplayCoverageContract,
  type ReplayEvidenceErrorCode,
  type ReplayResult,
} from "./replay-evidence";

export type { ReplayResult } from "./replay-evidence";

export interface PromotionCorpusRow {
  id?: string;
  agent_run_id?: string;
  session_id?: string;
  task_type?: string;
  user_request?: string;
  pipeline?: readonly string[];
  stage_runs?: readonly unknown[];
  model_attributions?: readonly unknown[];
  run_outcome?: string;
}

export interface PromotionGateInput {
  corpus: readonly PromotionCorpusRow[];
  /** Untrusted: decoded strictly before it can decide anything. */
  replay: unknown;
  /** Untrusted versioned expected-case manifest; required for an approval. */
  coverage_contract?: unknown;
  min_replay_pass_rate?: number;
  max_regression_count?: number;
  regression_tolerance?: number;
}

/** The specific reason one evidence set was refused, in the gate's own words.
 * Bounded: an entry index and at most one case id, never the report. */
export interface ReplayEvidenceDiagnostic {
  code: ReplayEvidenceErrorCode | "contract_absent" | "coverage_incomplete" | "decoder_fault";
  entry_index?: number;
  case_id?: string;
  expected_count?: number;
  provided_count?: number;
  missing_case_ids?: string[];
  unexpected_case_ids?: string[];
  truncated?: boolean;
}

export interface PromotionGateDecision {
  decision: "approve" | "reject";
  provenance_ok: boolean;
  replay_pass_rate: number;
  regression_count: number;
  reason: string;
  /** The coverage an approval (or a scoring rejection) was measured against. */
  replay_coverage?: ReplayCoverage;
  /** Present only when the evidence itself was refused. */
  replay_evidence?: ReplayEvidenceDiagnostic;
}

function hasProvenance(row: PromotionCorpusRow): boolean {
  return Boolean(
    row.id?.trim() &&
      row.agent_run_id?.trim() &&
      row.session_id?.trim() &&
      row.task_type?.trim() &&
      row.user_request?.trim() &&
      Array.isArray(row.pipeline) &&
      row.pipeline.length > 0 &&
      Array.isArray(row.stage_runs) &&
      Array.isArray(row.model_attributions) &&
      ["success", "degraded", "failed"].includes(row.run_outcome ?? ""),
  );
}

// The only evidence fault with its own reason: a report scored without its
// pinned A side is not a weak candidate, it is an unmeasured one.
const REASON_BY_EVIDENCE_CODE: Partial<Record<ReplayEvidenceDiagnostic["code"], string>> = {
  missing_baseline_score: "replay_missing_baseline",
};

interface ReplayAudit {
  rows?: ReplayResult[];
  coverage?: ReplayCoverage;
  refusal?: ReplayEvidenceDiagnostic;
}

function auditReplayEvidence(input: PromotionGateInput): ReplayAudit {
  let contract: ReplayCoverageContract;
  try {
    if (input.coverage_contract === undefined) {
      return {
        refusal: {
          code: "contract_absent",
          expected_count: 0,
          provided_count: Array.isArray(input.replay) ? input.replay.length : 0,
        },
      };
    }
    contract = decodeReplayCoverageContract(input.coverage_contract);
  } catch (error) {
    return { refusal: diagnosticFrom(error) };
  }

  let rows: ReplayResult[];
  try {
    rows = decodeReplayEvidence(input.replay);
  } catch (error) {
    return { refusal: diagnosticFrom(error) };
  }

  const coverage = verifyReplayCoverage(rows, contract);
  if (!coverage.complete) {
    return {
      coverage,
      refusal: {
        code: "coverage_incomplete",
        expected_count: coverage.expectedCount,
        provided_count: coverage.providedCount,
        missing_case_ids: coverage.missingCaseIds,
        unexpected_case_ids: coverage.unexpectedCaseIds,
        truncated: coverage.truncated,
      },
    };
  }
  return { rows, coverage };
}

function diagnosticFrom(error: unknown): ReplayEvidenceDiagnostic {
  if (error instanceof ReplayEvidenceError) {
    return {
      code: error.code,
      ...(error.entryIndex === undefined ? {} : { entry_index: error.entryIndex }),
      ...(error.caseId === undefined ? {} : { case_id: error.caseId }),
    };
  }
  // Only a decoder bug reaches here; refusing beats crashing a gate, and the
  // thrown value is never echoed.
  return { code: "decoder_fault" };
}

export function evaluatePromotionGate(input: PromotionGateInput): PromotionGateDecision {
  const provenanceOk = input.corpus.length > 0 && input.corpus.every(hasProvenance);
  if (!provenanceOk) {
    return {
      decision: "reject",
      provenance_ok: false,
      replay_pass_rate: 0,
      regression_count: 0,
      reason: "missing_provenance",
    };
  }

  if (Array.isArray(input.replay) && input.replay.length === 0) {
    return {
      decision: "reject",
      provenance_ok: true,
      replay_pass_rate: 0,
      regression_count: 0,
      reason: "replay_missing",
    };
  }

  const audit = auditReplayEvidence(input);
  if (audit.refusal) {
    return {
      decision: "reject",
      provenance_ok: true,
      replay_pass_rate: 0,
      regression_count: 0,
      reason: REASON_BY_EVIDENCE_CODE[audit.refusal.code] ?? "replay_invalid",
      ...(audit.coverage ? { replay_coverage: audit.coverage } : {}),
      replay_evidence: audit.refusal,
    };
  }

  const rows = audit.rows ?? [];
  const coverage = audit.coverage;

  const tolerance = Math.max(0, input.regression_tolerance ?? 0.05);
  const regressions = rows.filter((r) => r.candidate_score < r.baseline_score - tolerance).length;
  const passRate = rows.filter((r) => r.passed).length / rows.length;
  const minimumPassRate = Math.min(1, Math.max(0, input.min_replay_pass_rate ?? 0.8));
  const maxRegressions = Math.max(0, input.max_regression_count ?? 0);
  const reported = coverage ? { replay_coverage: coverage } : {};

  if (regressions > maxRegressions) {
    return {
      decision: "reject",
      provenance_ok: true,
      replay_pass_rate: passRate,
      regression_count: regressions,
      reason: "replay_regression",
      ...reported,
    };
  }
  if (passRate < minimumPassRate) {
    return {
      decision: "reject",
      provenance_ok: true,
      replay_pass_rate: passRate,
      regression_count: regressions,
      reason: "replay_failed",
      ...reported,
    };
  }
  return {
    decision: "approve",
    provenance_ok: true,
    replay_pass_rate: passRate,
    regression_count: regressions,
    reason: "quality_gate_passed",
    ...reported,
  };
}

