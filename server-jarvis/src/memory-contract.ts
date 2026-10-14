// ─── Scoped memory wire contracts ────────────────────────────────────────────
// Types-only mirror of the frozen Phase 1 Rust DTOs in
// `src-tauri/src/jarvis/memory/contracts.rs`. This module deliberately has no
// database access and no runtime side effects: Bun consumes these shapes from
// the Native surface and must never treat them as a second writable store.
//
// Keep field names and enum values in exact lockstep with the Rust side.

export type MemoryErrorCode =
  | "invalid_scope"
  | "invalid_path"
  | "workspace_unavailable"
  | "session_not_found"
  | "not_found"
  | "invalid_payload"
  | "invalid_provenance"
  | "revision_conflict"
  | "storage_unavailable"
  // Phase 2 additive turn-lifecycle error codes. Frozen spellings.
  | "turn_conflict"
  | "invalid_turn"
  | "invalidation_unavailable"
  // Phase 3 additive capture error codes. Frozen spellings.
  | "operation_conflict"
  | "invalid_acceptance"
  | "unsupported_verification"
  | "capture_unavailable";

export interface MemoryError {
  code: MemoryErrorCode;
  message: string;
}

export type MemoryScopeKind = "project" | "agent" | "user" | "legacy_unscoped";

export interface MemoryScope {
  kind: MemoryScopeKind;
  agent_id: string;
  project_root: string | null;
}

export type WritableScopeKind = "project" | "agent" | "user";

export interface ScopeSelector {
  kind: WritableScopeKind;
}

export interface MemoryDraft {
  title: string;
  content: string;
  tags: string[];
  category: string;
  expires_at: string | null;
  review_after: string | null;
}

export type AuthorityKind =
  | "manual"
  | "user_statement"
  | "verified_observation"
  | "assistant_proposal"
  | "legacy_unknown";

/**
 * Phase 4 additive conservative statement classification. Exactly three values,
 * snake_case, mirroring `MemoryStatementKind` in the Rust `contracts.rs`. Only
 * explicit constraint capture initializes `normative_constraint`; migrated rows
 * and ordinary capture stay `unknown`.
 */
export type MemoryStatementKind =
  | "normative_constraint"
  | "descriptive_fact"
  | "unknown";

export interface MemoryProvenance {
  authority_kind: AuthorityKind;
  source: string;
  source_session_id: string | null;
  source_message_ids: string[];
  source_run_id: string | null;
  verified_at: string | null;
}

/** Canonical durable memory row, mirroring the Rust `MemoryEntry`. */
export interface MemoryEntry {
  id: string;
  title: string;
  content: string;
  tags: string;
  category: string;
  created_at: string;
  updated_at: string;
  relevance_score: number;
  agent_id: string;
  source: string;
  source_session_id: string | null;
  source_message_ids: string;
  confidence: number;
  last_used_at: string | null;
  usage_count: number;
  expires_at: string | null;
  review_after: string | null;
  status: string;
  supersedes_id: string | null;
  metadata: string | null;
  tier: string;
  drive_file_id: string | null;
  summary: string;
  archived_at: string | null;
  updated_at_ms: number;
}

export interface ScopedMemoryEntry {
  entry: MemoryEntry;
  scope: MemoryScope;
  authority_kind: AuthorityKind;
  statement_kind: MemoryStatementKind;
  source_run_id: string | null;
  verified_at: string | null;
  revision: number;
}

export interface ScopedMemoryRecall {
  memory: ScopedMemoryEntry;
  score: number;
  matched_terms: string[];
  stale: boolean;
}

export interface RecallOptions {
  limit: number;
  include_user_scope: boolean;
}

export interface RecallPreview {
  scope: MemoryScope;
  store_revision: number;
  entries: ScopedMemoryRecall[];
}

export interface MutationResult {
  memory: ScopedMemoryEntry;
  store_revision: number;
  changed: boolean;
}

// ── Command request envelopes (single `request` DTO per Tauri command) ────────

export interface BindSessionWorkspaceRequest {
  session_id: string;
  workspace_root: string | null;
}

export interface ScopedSaveRequest {
  session_id: string;
  selector: ScopeSelector;
  draft: MemoryDraft;
  /** Optional Phase 4 classification. Absent defaults to `unknown`. */
  statement_kind?: MemoryStatementKind;
}

export interface ScopedReadRequest {
  session_id: string;
  selector: ScopeSelector;
  id: string;
}

export interface ScopedListRequest {
  session_id: string;
  selector: ScopeSelector;
  include_inactive: boolean;
}

export interface ScopedUpdateRequest {
  session_id: string;
  selector: ScopeSelector;
  id: string;
  expected_revision: number;
  draft: MemoryDraft;
  /** Optional Phase 4 classification. Absent preserves the prior kind. */
  statement_kind?: MemoryStatementKind;
}

export interface ScopedClassifyRequest {
  session_id: string;
  selector: ScopeSelector;
  id: string;
  expected_revision: number;
  statement_kind: MemoryStatementKind;
}

export interface ScopedDeleteRequest {
  session_id: string;
  selector: ScopeSelector;
  id: string;
  expected_revision: number;
  reason: string;
}

export interface ScopedRestoreRequest {
  session_id: string;
  selector: ScopeSelector;
  id: string;
  expected_revision: number;
}

export interface ScopedRecallPreviewRequest {
  session_id: string;
  query: string;
  options: RecallOptions;
}

export interface AdoptLegacyRequest {
  session_id: string;
  selector: ScopeSelector;
  id: string;
  expected_revision: number;
}

export const DEFAULT_RECALL_OPTIONS: RecallOptions = {
  limit: 5,
  include_user_scope: false,
};

// ── Phase 2 prepared turn wire contracts ─────────────────────────────────────
// Types-only mirror of `src-tauri/src/jarvis/memory/turn.rs`. Phase 2.1 owns
// these definitions; later phases consume them unchanged. Field names and enum
// values must stay in exact lockstep with the Rust side. No recalled text or
// rendered block is ever persisted; `PreparedMemoryTurn` is the ephemeral
// registration envelope only.

export type MemoryRecallStatus =
  | "ready"
  | "empty"
  | "unavailable"
  | "retrieval_failed"
  | "registration_failed"
  | "expired"
  | "invalidated"
  | "scope_mismatch"
  | "already_consumed"
  | "budget_omitted"
  | "applied";

export type MemoryTurnState =
  | "prepared"
  | "registered"
  | "started"
  | "terminal"
  | "invalidated"
  | "expired"
  | "unavailable"
  | "unterminated";

export type MemoryTurnTerminalStatus =
  | "completed"
  | "partial"
  | "cancelled"
  | "failed"
  | "unterminated";

export interface PrepareMemoryTurnRequest {
  session_id: string;
  turn_id: string;
  user_message_id: string;
  include_user_scope: boolean;
}

export interface MemoryTurnIdentityRequest {
  session_id: string;
  turn_id: string;
}

export interface MemoryTurnHistoryRequest {
  session_id: string;
  user_message_id: string;
}

export interface MemoryTurnPreparation {
  turn_id: string;
  preparation_id: string | null;
  status: MemoryRecallStatus;
}

export interface PreparedMemorySelection {
  id: string;
  revision: number;
  scope: MemoryScope;
  authority_kind: AuthorityKind;
  statement_kind: MemoryStatementKind;
  source_session_id: string | null;
  source_message_ids: string[];
  source_run_id: string | null;
  verified_at: string | null;
  stale: boolean;
}

export interface PreparedMemoryItem {
  selection: PreparedMemorySelection;
  text: string;
}

export interface PreparedMemoryTurn {
  schema_version: number;
  preparation_id: string;
  turn_id: string;
  session_id: string;
  message_hash: string;
  scope: MemoryScope;
  include_user_scope: boolean;
  effective_workspace: string | null;
  store_revision: number;
  selected: PreparedMemoryItem[];
  block: string;
  prepared_at: string;
  expires_at: string;
  app_instance_id: string;
  /**
   * Optional private Phase 3.4 continuity preview. Native-created only and
   * never a request field, so an HTTP-only caller cannot forge it. Absent for
   * an ordinary turn with no accepted active objective. Mirrors the Rust
   * `PreparedMemoryTurn.continuity`.
   */
  continuity?: ContinuityPreview;
}

export interface MemoryRuntimeEvidence {
  tool_call_id: string;
  tool_name: string;
  canonical_path: string | null;
  output_sha256: string;
  observed_at: string;
  success: boolean;
}

// ── Phase 4.3 fresh-source revalidation wire contracts ───────────────────────
// Evidence-availability metadata only. `fresh_evidence` records that current
// source was freshly read this turn; it is NOT a semantic truth verdict, a
// verified-observation capture, or a permission grant. The policy is derived
// exclusively from authenticated prepared rows plus the canonical workspace;
// public `/chat/stream` fields can never set it.

export type MemoryRevalidationState =
  | "not_required"
  | "required"
  | "fresh_evidence"
  | "unavailable";

export interface MemoryRevalidationPolicy {
  memory_ids: string[];
  requires_fresh_workspace_reads: boolean;
}

export interface MemoryRevalidationResult {
  state: MemoryRevalidationState;
  memory_ids: string[];
  evidence_tool_call_ids: string[];
  reason_code: string | null;
}

/** The exact `not_required` result native persists for an ordinary turn. */
export const MEMORY_REVALIDATION_NOT_REQUIRED: MemoryRevalidationResult = {
  state: "not_required",
  memory_ids: [],
  evidence_tool_call_ids: [],
  reason_code: null,
};

/**
 * The exact reason vocabulary reported for an `unavailable` result. Native
 * normalizes any malformed receipt to `malformed_receipt`.
 */
export const MEMORY_REVALIDATION_REASON_CODES: ReadonlySet<string> = new Set<string>([
  "no_current_read",
  "insufficient_current_evidence",
  "evidence_unavailable",
  "workspace_unavailable",
  "read_denied",
  "source_missing",
  "unsupported_cli_evidence",
  "unsupported_evidence_path",
  "malformed_receipt",
]);

export interface PersistedMemoryTurn {
  turn_id: string;
  preparation_id: string | null;
  session_id: string;
  source_message_id: string;
  user_message: string;
  message_hash: string;
  scope: MemoryScope;
  include_user_scope: boolean;
  effective_workspace: string | null;
  store_revision: number;
  selected: PreparedMemorySelection[];
  applied_selected_ids: string[];
  app_instance_id: string;
  bun_instance_id: string | null;
  state: MemoryTurnState;
  recall_status: MemoryRecallStatus;
  error_code: string | null;
  prepared_at: string;
  expires_at: string;
  started_at: string | null;
  finished_at: string | null;
  terminal_status: MemoryTurnTerminalStatus | null;
  run_id: string | null;
  runtime_evidence: MemoryRuntimeEvidence[];
  /** Phase 4.3 current-source evidence availability. Metadata only. */
  revalidation: MemoryRevalidationResult;
}

export interface MemoryTurnDiagnostic {
  turn_id: string;
  session_id: string;
  scope: MemoryScope;
  store_revision: number;
  selected: PreparedMemorySelection[];
  applied_selected_ids: string[];
  state: MemoryTurnState;
  recall_status: MemoryRecallStatus;
  error_code: string | null;
  terminal_status: MemoryTurnTerminalStatus | null;
  /** Phase 4.3 current-source evidence availability. Metadata only. */
  revalidation: MemoryRevalidationResult;
}

export interface PromptHistoryMessage {
  id: string;
  role: string;
  content: string;
}

export const PREPARED_TURN_SCHEMA_VERSION = 1;

// ── Phase 3.1 capture wire contracts ─────────────────────────────────────────
// Types-only mirror of the frozen Rust DTOs in
// `src-tauri/src/jarvis/memory/capture_contracts.rs`. Phase 3.1 owns these
// definitions; later phases consume them unchanged. Field names and enum
// values must stay in exact lockstep with the Rust side. Request DTOs deny
// unknown fields on the Rust side, so a forged `agent_id`, `terminal_status`,
// or `verified_at` is rejected before any transaction opens.

export type CaptureOperationStatus =
  | "saved"
  | "forgotten"
  | "corrected"
  | "pending"
  | "blocked";

export interface CaptureOperationReceipt {
  operation_id: string;
  status: CaptureOperationStatus;
  memory_id: string | null;
  replacement_id: string | null;
  reason_code: string | null;
}

export interface CaptureReceipt {
  turn_id: string;
  session_id: string;
  terminal_status: MemoryTurnTerminalStatus | null;
  operations: CaptureOperationReceipt[];
  store_revision: number;
  continuity_revision: number;
  saved_count: number;
  pending_count: number;
}

export interface CorrectionResult {
  previous: ScopedMemoryEntry;
  replacement: ScopedMemoryEntry;
  store_revision: number;
  changed: boolean;
}

export interface ForgetResult {
  memory: ScopedMemoryEntry;
  store_revision: number;
  changed: boolean;
  suppressed_message_ids: string[];
}

export interface ActiveObjective {
  text: string;
  source_message_id: string;
  source_turn_id: string | null;
  depends_on_memory_ids: string[];
}

export interface SessionContinuity {
  session_id: string;
  active_objective: ActiveObjective | null;
  latest_turn_id: string | null;
  revision: number;
}

/**
 * Exact whole-message objective control mode. `preserve` is the default for
 * every ordinary question, correction, cancellation or assistant suggestion;
 * only an exact `Objective: <text>`, `Clear active objective`, or
 * `Continue active objective` message changes the typed objective. Mirrors the
 * Rust `ContinuityMode`.
 */
export type ContinuityMode = "preserve" | "resume" | "replace" | "clear";

/**
 * Optional private Phase 3.4 continuity preview carried in the Phase 2 prepared
 * envelope. Native-created metadata only. `snapshot` is the effective
 * (previewed) typed continuity for the current turn; `mode` names the exact
 * action Bun must apply to TaskRun state. Mirrors the Rust `ContinuityPreview`.
 */
export interface ContinuityPreview {
  snapshot: SessionContinuity;
  mode: ContinuityMode;
}

export interface CaptureTurnRequest {
  session_id: string;
  turn_id: string;
}

export interface CaptureReceiptsRequest {
  session_id: string;
  turn_id: string;
}

export interface ScopedCorrectRequest {
  session_id: string;
  selector: ScopeSelector;
  id: string;
  expected_revision: number;
  draft: MemoryDraft;
  operation_id: string;
  /** Optional Phase 4 replacement classification. Absent preserves prior kind. */
  statement_kind?: MemoryStatementKind;
}

export interface ScopedForgetRequest {
  session_id: string;
  selector: ScopeSelector;
  id: string;
  expected_revision: number;
  reason: string;
  operation_id: string;
}

export interface StageProposalRequest {
  session_id: string;
  turn_id: string;
  assistant_message_id: string;
  draft: MemoryDraft;
  operation_id: string;
}

export interface ContinuityReadRequest {
  session_id: string;
}

export interface ContinuitySetRequest {
  session_id: string;
  expected_revision: number;
  source_message_id: string;
  objective: string | null;
  operation_id: string;
}

// ── Phase 3.2 derived-state invalidation wire contract ───────────────────────
// Capability-only mirror of the frozen Rust DTO in
// `src-tauri/src/jarvis/memory/capture_contracts.rs` and the private native
// `derived` field on `/internal/memory/invalidate`. `operation_id` is
// native-namespaced (`session/<session_id>/operation/<operation_id>`). EXACTLY
// these four fields; it carries ids only: never recalled text, scope, or a
// capability value. The resolved scope is native-internal routing metadata.

export interface MemoryDerivedInvalidation {
  operation_id: string;
  affected_session_ids: string[];
  memory_ids: string[];
  source_message_ids: string[];
}
