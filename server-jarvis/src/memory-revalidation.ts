// ─── Phase 4.3 fresh-source revalidation ─────────────────────────────────────
// Current-source evidence availability over the existing Tool runtime and
// evidence gate. This module is pure and has no durable side effects.
//
// Fresh evidence means a current, authorized, successful, content-bearing
// canonical read executed on THIS turn against the active project workspace. It
// is NOT a semantic truth verdict, a verified-observation capture, or a
// permission grant. Cache hits, listings/metadata, hashes alone, check output,
// model claims, or reads from another Session/turn never qualify.
//
// The policy is derived exclusively from authenticated prepared rows plus the
// canonical workspace; public `/chat/stream` fields can never set it.

import { resolveWorkspacePathIdentity } from "./orchestration/path-identity";
import { assessWorkspaceEvidence } from "./orchestration/evidence-sufficiency";
import { isDuplicateToolDeflection, type ToolCallRecord } from "./orchestration/stage-output";
import type {
  MemoryRevalidationPolicy,
  MemoryRevalidationResult,
  MemoryRuntimeEvidence,
  PreparedMemorySelection,
} from "./memory-contract";

/** Genuine file-content tools — the only ones that can satisfy a fresh read. */
const CONTENT_READ_TOOLS: ReadonlySet<string> = new Set(["read_file", "grep"]);

function notRequired(): MemoryRevalidationResult {
  return {
    state: "not_required",
    memory_ids: [],
    evidence_tool_call_ids: [],
    reason_code: null,
  };
}

function unavailable(
  memoryIds: readonly string[],
  reasonCode: string,
): MemoryRevalidationResult {
  return {
    state: "unavailable",
    memory_ids: [...memoryIds],
    evidence_tool_call_ids: [],
    reason_code: reasonCode,
  };
}

function canonicalWithinWorkspace(pathValue: string, workspace: string): boolean {
  const identity = resolveWorkspacePathIdentity(pathValue);
  const workspaceIdentity = resolveWorkspacePathIdentity(workspace);
  if (!identity || !workspaceIdentity) return false;
  return identity === workspaceIdentity || identity.startsWith(`${workspaceIdentity}/`);
}

/**
 * Build the per-turn policy from the authenticated prepared selection. A
 * project-scoped `descriptive_fact`/`unknown` statement is historical context
 * and requires a current source read before making today's workspace claims.
 * Normative constraints remain effective user requirements; explicit
 * user/Agent preferences do not require workspace reads.
 *
 * `requires_fresh_workspace_reads` is true whenever a relevant selection was
 * prepared, independent of whether a workspace is present. A missing/empty
 * workspace is handled by `assessMemoryRevalidation` as `unavailable` with
 * `workspace_unavailable`; it must never downgrade a required turn to
 * `not_required`.
 */
export function buildMemoryRevalidationPolicy(
  selected: readonly PreparedMemorySelection[],
  _workspace: string | null,
): MemoryRevalidationPolicy {
  const memoryIds: string[] = [];
  for (const selection of selected) {
    if (
      selection.scope.kind === "project" &&
      (selection.statement_kind === "descriptive_fact" || selection.statement_kind === "unknown")
    ) {
      memoryIds.push(selection.id);
    }
  }
  return {
    memory_ids: memoryIds,
    requires_fresh_workspace_reads: memoryIds.length > 0,
  };
}

/**
 * Derive the terminal policy from the prepared policy and the authenticated
 * applied-selected IDs. Revalidation covers only relevant project
 * descriptive/unknown selections that were ACTUALLY APPLIED this turn; a
 * prepared-but-budget-omitted selection never contributes. The result keeps the
 * prepared order and sets `requires_fresh_workspace_reads` strictly from the
 * applied subset, independent of workspace presence.
 */
export function appliedRevalidationPolicy(
  policy: MemoryRevalidationPolicy,
  appliedSelectedIds: readonly string[],
): MemoryRevalidationPolicy {
  const applied = new Set(appliedSelectedIds);
  const memoryIds = policy.memory_ids.filter((id) => applied.has(id));
  return {
    memory_ids: memoryIds,
    requires_fresh_workspace_reads: memoryIds.length > 0,
  };
}

/**
 * Assess whether a policy that requires fresh workspace reads was satisfied by
 * this turn's authenticated runtime evidence, using the existing
 * `assessWorkspaceEvidence` depth/kind semantics. Only current, successful,
 * content-bearing canonical reads tied to this turn/project can qualify.
 */
export function assessMemoryRevalidation(
  policy: MemoryRevalidationPolicy,
  currentCalls: readonly ToolCallRecord[],
  currentEvidence: readonly MemoryRuntimeEvidence[],
  request: string,
  workspace: string | null,
): MemoryRevalidationResult {
  if (!policy.requires_fresh_workspace_reads) return notRequired();
  const memoryIds = policy.memory_ids;
  if (typeof workspace !== "string" || workspace.length === 0) {
    return unavailable(memoryIds, "workspace_unavailable");
  }

  // Authenticated current-turn evidence refs. By construction these are only
  // observed from actual runtime executions on this turn; a cache hit or a
  // different turn/Session never produces a ref here.
  const qualifyingEvidence = currentEvidence.filter(
    (ref) =>
      ref.success &&
      CONTENT_READ_TOOLS.has(ref.tool_name) &&
      typeof ref.canonical_path === "string" &&
      ref.canonical_path.length > 0 &&
      canonicalWithinWorkspace(ref.canonical_path, workspace),
  );

  const attemptedReads = currentCalls.filter((call) => CONTENT_READ_TOOLS.has(call.name));
  const contentCalls = currentCalls.filter(
    (call) =>
      !call.is_error &&
      CONTENT_READ_TOOLS.has(call.name) &&
      call.output.trim().length > 0 &&
      !isDuplicateToolDeflection(call),
  );

  if (contentCalls.length === 0) {
    const denied =
      attemptedReads.some((call) => call.error_code === "policy_denied") ||
      (currentEvidence.some((ref) => !ref.success && CONTENT_READ_TOOLS.has(ref.tool_name)) &&
        attemptedReads.length > 0 &&
        attemptedReads.every((call) => call.is_error));
    if (denied) return unavailable(memoryIds, "read_denied");
    if (attemptedReads.length > 0) return unavailable(memoryIds, "source_missing");
    return unavailable(memoryIds, "no_current_read");
  }

  const assessment = assessWorkspaceEvidence(contentCalls, request, workspace);
  if (!assessment.sufficient) {
    return unavailable(memoryIds, "insufficient_current_evidence");
  }
  if (qualifyingEvidence.length === 0) {
    // Content was read this turn, but not through an authenticated runtime ref
    // (for example an untrusted external CLI path). Never reported as fresh.
    return unavailable(memoryIds, "evidence_unavailable");
  }

  return {
    state: "fresh_evidence",
    memory_ids: memoryIds,
    evidence_tool_call_ids: qualifyingEvidence.map((ref) => ref.tool_call_id),
    reason_code: null,
  };
}

/**
 * Report that this transport/turn cannot produce trusted current runtime refs
 * (for example an external CLI that runs its own tools). The turn keeps its
 * historical labels and reports an explicit source-unavailable status; it must
 * never widen permission or auto-capture a verified observation.
 */
export function unavailableForUntrustedTransport(
  policy: MemoryRevalidationPolicy,
): MemoryRevalidationResult {
  if (!policy.requires_fresh_workspace_reads) return notRequired();
  return unavailable(policy.memory_ids, "unsupported_cli_evidence");
}
