// ═══════════════════════════════════════════════════════════════
// Native Capture Contracts — frozen Phase 3.1 wire DTOs
// ═══════════════════════════════════════════════════════════════
//
// Phase 3.1 owns these definitions. They are additive to the Phase 1
// `contracts.rs` and Phase 2 `turn.rs` DTOs and must stay in exact lockstep
// with `server-jarvis/src/memory-contract.ts`.
//
// Request DTOs deny unknown fields so no caller can smuggle Agent ownership,
// project roots, terminal outcomes, assistant evidence, recalled text, or
// arbitrary provenance through an extra field. A request that is not an exact
// match for the frozen command surface is rejected before a transaction is
// opened.

use serde::{Deserialize, Serialize};

use super::contracts::{MemoryDraft, MemoryScope, ScopeSelector, ScopedMemoryEntry};
use super::turn::MemoryTurnTerminalStatus;

/// Terminal disposition of one operation inside a capture receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureOperationStatus {
    Saved,
    Forgotten,
    Corrected,
    Pending,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CaptureOperationReceipt {
    pub operation_id: String,
    pub status: CaptureOperationStatus,
    pub memory_id: Option<String>,
    pub replacement_id: Option<String>,
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CaptureReceipt {
    pub turn_id: String,
    pub session_id: String,
    pub terminal_status: Option<MemoryTurnTerminalStatus>,
    pub operations: Vec<CaptureOperationReceipt>,
    pub store_revision: i64,
    pub continuity_revision: i64,
    pub saved_count: usize,
    pub pending_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorrectionResult {
    pub previous: ScopedMemoryEntry,
    pub replacement: ScopedMemoryEntry,
    pub store_revision: i64,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForgetResult {
    pub memory: ScopedMemoryEntry,
    pub store_revision: i64,
    pub changed: bool,
    pub suppressed_message_ids: Vec<String>,
}

/// Capability-only derived-context invalidation payload. Native namespaces
/// `operation_id` as `session/<session_id>/operation/<operation_id>` on the wire
/// so equal operator UUIDs in distinct Sessions never collide. It carries ids
/// only: never recalled text, scope paths, provenance, or a capability value.
/// The frozen DTO has EXACTLY these four fields, mirrored in
/// `server-jarvis/src/memory-contract.ts`. The resolved MemoryScope is internal
/// native routing metadata (see `NativeDerivedMutationPlan`) and is never sent
/// on the wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct MemoryDerivedInvalidation {
    pub operation_id: String,
    pub affected_session_ids: Vec<String>,
    pub memory_ids: Vec<String>,
    pub source_message_ids: Vec<String>,
}

/// INTERNAL native routing metadata. Never serialized to the wire: the public
/// frozen `MemoryDerivedInvalidation` keeps exactly four fields. Carries the
/// exact resolved scope of the affected records so the outbox can persist real
/// `scope_json` without polluting the capability DTO.
#[derive(Debug, Clone, PartialEq)]
pub struct NativeDerivedMutationPlan {
    pub invalidation: MemoryDerivedInvalidation,
    pub scope: Option<MemoryScope>,
}

impl NativeDerivedMutationPlan {
    pub fn from_invalidation(invalidation: MemoryDerivedInvalidation) -> Self {
        Self {
            invalidation,
            scope: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActiveObjective {
    pub text: String,
    pub source_message_id: String,
    pub source_turn_id: Option<String>,
    pub depends_on_memory_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionContinuity {
    pub session_id: String,
    pub active_objective: Option<ActiveObjective>,
    pub latest_turn_id: Option<String>,
    pub revision: i64,
}

// ── Command request envelopes (one `request` object per Tauri command) ───────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct CaptureTurnRequest {
    pub session_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct CaptureReceiptsRequest {
    pub session_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ScopedCorrectRequest {
    pub session_id: String,
    pub selector: ScopeSelector,
    pub id: String,
    pub expected_revision: i64,
    pub draft: MemoryDraft,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ScopedForgetRequest {
    pub session_id: String,
    pub selector: ScopeSelector,
    pub id: String,
    pub expected_revision: i64,
    pub reason: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct StageProposalRequest {
    pub session_id: String,
    pub turn_id: String,
    pub assistant_message_id: String,
    pub draft: MemoryDraft,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ContinuityReadRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ContinuitySetRequest {
    pub session_id: String,
    pub expected_revision: i64,
    pub source_message_id: String,
    pub objective: Option<String>,
    pub operation_id: String,
}
