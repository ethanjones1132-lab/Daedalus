// ═══════════════════════════════════════════════════════════════
// Scoped Memory Contracts — frozen store and wire DTOs
// ═══════════════════════════════════════════════════════════════
//
// Phase 1 owns these definitions. Later phases consume them rather than
// inventing competing representations. All serde enum values and field
// names use snake_case. Request DTOs deny unknown fields so callers
// cannot smuggle Agent ownership or provenance through extra fields.

use serde::{Deserialize, Serialize};

use super::engine::MemoryEntry;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryErrorCode {
    InvalidScope,
    InvalidPath,
    WorkspaceUnavailable,
    SessionNotFound,
    NotFound,
    InvalidPayload,
    InvalidProvenance,
    RevisionConflict,
    StorageUnavailable,
    // Phase 2 additive turn-lifecycle error codes. Frozen spellings.
    TurnConflict,
    InvalidTurn,
    InvalidationUnavailable,
    // Phase 3 additive capture error codes. Frozen spellings.
    OperationConflict,
    InvalidAcceptance,
    UnsupportedVerification,
    CaptureUnavailable,
}

/// Typed native memory error. Serialization never includes SQL, paths
/// unrelated to the selected scope, or submitted secret content.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryError {
    pub code: MemoryErrorCode,
    pub message: String,
}

impl std::fmt::Display for MemoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for MemoryError {}

impl MemoryError {
    pub fn new(code: MemoryErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid_scope(message: impl Into<String>) -> Self {
        Self::new(MemoryErrorCode::InvalidScope, message)
    }

    pub fn invalid_path(message: impl Into<String>) -> Self {
        Self::new(MemoryErrorCode::InvalidPath, message)
    }

    pub fn workspace_unavailable(message: impl Into<String>) -> Self {
        Self::new(MemoryErrorCode::WorkspaceUnavailable, message)
    }

    pub fn session_not_found(message: impl Into<String>) -> Self {
        Self::new(MemoryErrorCode::SessionNotFound, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(MemoryErrorCode::NotFound, message)
    }

    pub fn invalid_payload(message: impl Into<String>) -> Self {
        Self::new(MemoryErrorCode::InvalidPayload, message)
    }

    pub fn invalid_provenance(message: impl Into<String>) -> Self {
        Self::new(MemoryErrorCode::InvalidProvenance, message)
    }

    pub fn revision_conflict(message: impl Into<String>) -> Self {
        Self::new(MemoryErrorCode::RevisionConflict, message)
    }

    pub fn storage_unavailable(message: impl Into<String>) -> Self {
        Self::new(MemoryErrorCode::StorageUnavailable, message)
    }

    pub fn turn_conflict(message: impl Into<String>) -> Self {
        Self::new(MemoryErrorCode::TurnConflict, message)
    }

    pub fn invalid_turn(message: impl Into<String>) -> Self {
        Self::new(MemoryErrorCode::InvalidTurn, message)
    }

    pub fn invalidation_unavailable(message: impl Into<String>) -> Self {
        Self::new(MemoryErrorCode::InvalidationUnavailable, message)
    }

    pub fn operation_conflict(message: impl Into<String>) -> Self {
        Self::new(MemoryErrorCode::OperationConflict, message)
    }

    pub fn invalid_acceptance(message: impl Into<String>) -> Self {
        Self::new(MemoryErrorCode::InvalidAcceptance, message)
    }

    pub fn unsupported_verification(message: impl Into<String>) -> Self {
        Self::new(MemoryErrorCode::UnsupportedVerification, message)
    }

    pub fn capture_unavailable(message: impl Into<String>) -> Self {
        Self::new(MemoryErrorCode::CaptureUnavailable, message)
    }
}

impl From<rusqlite::Error> for MemoryError {
    fn from(err: rusqlite::Error) -> Self {
        // Never surface raw SQL through the wire contract; keep the detail
        // on stderr for native diagnostics only.
        eprintln!("[memory] sqlite error: {}", err);
        MemoryError::storage_unavailable("Memory storage is unavailable")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScopeKind {
    Project,
    Agent,
    User,
    LegacyUnscoped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryScope {
    pub kind: MemoryScopeKind,
    pub agent_id: String,
    pub project_root: Option<String>,
}

impl MemoryScope {
    pub fn project(agent_id: impl Into<String>, project_root: impl Into<String>) -> Self {
        Self {
            kind: MemoryScopeKind::Project,
            agent_id: agent_id.into(),
            project_root: Some(project_root.into()),
        }
    }

    pub fn agent(agent_id: impl Into<String>) -> Self {
        Self {
            kind: MemoryScopeKind::Agent,
            agent_id: agent_id.into(),
            project_root: None,
        }
    }

    pub fn user() -> Self {
        Self {
            kind: MemoryScopeKind::User,
            agent_id: String::new(),
            project_root: None,
        }
    }

    pub fn legacy_unscoped(agent_id: impl Into<String>) -> Self {
        Self {
            kind: MemoryScopeKind::LegacyUnscoped,
            agent_id: agent_id.into(),
            project_root: None,
        }
    }

    pub fn is_writable(&self) -> bool {
        !matches!(self.kind, MemoryScopeKind::LegacyUnscoped)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WritableScopeKind {
    Project,
    Agent,
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ScopeSelector {
    pub kind: WritableScopeKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct MemoryDraft {
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub category: String,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub review_after: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityKind {
    Manual,
    UserStatement,
    VerifiedObservation,
    AssistantProposal,
    LegacyUnknown,
}

/// Phase 4 additive statement classification. Conservative three-value enum:
/// only explicit constraint capture initializes `normative_constraint`; every
/// other capture and every migrated row is `unknown`. Serialized snake_case and
/// kept in exact lockstep with `server-jarvis/src/memory-contract.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryStatementKind {
    NormativeConstraint,
    DescriptiveFact,
    Unknown,
}

impl Default for MemoryStatementKind {
    fn default() -> Self {
        Self::Unknown
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct MemoryProvenance {
    pub authority_kind: AuthorityKind,
    pub source: String,
    #[serde(default)]
    pub source_session_id: Option<String>,
    #[serde(default)]
    pub source_message_ids: Vec<String>,
    #[serde(default)]
    pub source_run_id: Option<String>,
    #[serde(default)]
    pub verified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScopedMemoryEntry {
    pub entry: MemoryEntry,
    pub scope: MemoryScope,
    pub authority_kind: AuthorityKind,
    /// Conservative statement meaning. Older persisted payloads that predate
    /// Phase 4 decode as `unknown` rather than failing.
    #[serde(default)]
    pub statement_kind: MemoryStatementKind,
    pub source_run_id: Option<String>,
    pub verified_at: Option<String>,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScopedMemoryRecall {
    pub memory: ScopedMemoryEntry,
    pub score: f64,
    pub matched_terms: Vec<String>,
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RecallOptions {
    pub limit: usize,
    pub include_user_scope: bool,
}

impl Default for RecallOptions {
    fn default() -> Self {
        Self {
            limit: 5,
            include_user_scope: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecallPreview {
    pub scope: MemoryScope,
    pub store_revision: i64,
    pub entries: Vec<ScopedMemoryRecall>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MutationResult {
    pub memory: ScopedMemoryEntry,
    pub store_revision: i64,
    pub changed: bool,
}
