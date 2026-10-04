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
  | "storage_unavailable";

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
