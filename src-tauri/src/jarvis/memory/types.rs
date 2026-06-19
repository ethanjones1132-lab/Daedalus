//! Memory type definitions for the Jarvis memory subsystem.
//!
//! This module defines the core data structures used by the memory engine
//! for storing, recalling, and managing memories across hot/warm/cold tiers.

use serde::{Deserialize, Serialize};

/// Memory tier determines storage location and eviction policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MemoryTier {
    /// Hot: in-memory + SQLite, always available
    Hot,
    /// Warm: SQLite only, may be evicted to cold
    Warm,
    /// Cold: serialized to disk file, loaded on demand
    Cold,
}

impl Default for MemoryTier {
    fn default() -> Self {
        MemoryTier::Hot
    }
}

impl MemoryTier {
    /// Returns true if this tier is persisted in SQLite.
    pub fn is_sqlite(&self) -> bool {
        matches!(self, MemoryTier::Hot | MemoryTier::Warm)
    }

    /// Returns true if this tier is stored as a cold file.
    pub fn is_cold(&self) -> bool {
        matches!(self, MemoryTier::Cold)
    }
}

/// Memory type classification for scoring and filtering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MemoryType {
    User,
    Feedback,
    Project,
    Reference,
}

impl MemoryType {
    /// Bonus weight used in combined relevance scoring.
    pub fn bonus(&self) -> f64 {
        match self {
            MemoryType::User => 0.3,
            MemoryType::Feedback => 0.2,
            MemoryType::Project => 0.1,
            MemoryType::Reference => 0.05,
        }
    }
}

impl Default for MemoryType {
    fn default() -> Self {
        MemoryType::Reference
    }
}

/// A single memory record stored in the database.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRecord {
    pub id: String,
    pub content: String,
    pub memory_type: MemoryType,
    pub tier: MemoryTier,
    pub confidence: f64,
    pub usage_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub expires_at: Option<String>,
    pub review_after: Option<String>,
    pub superseded_by: Option<String>,
    pub drive_file_id: Option<String>,
}

/// Memory event audit trail entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEvent {
    pub id: String,
    pub memory_id: String,
    pub event_type: String,
    pub before_json: Option<String>,
    pub after_json: Option<String>,
    pub actor: String,
    pub confidence: f64,
    pub session_id: Option<String>,
    pub timestamp: String,
}

/// Batch memory maintenance run log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRun {
    pub id: String,
    pub run_type: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub memories_processed: i64,
    pub memories_promoted: i64,
    pub memories_demoted: i64,
    pub memories_expired: i64,
    pub status: String,
    pub error: Option<String>,
}

/// Combined scoring weights for memory recall.
#[derive(Debug, Clone)]
pub struct RecallWeights {
    pub age_weight: f64,
    pub type_weight: f64,
    pub relevance_weight: f64,
}

impl Default for RecallWeights {
    fn default() -> Self {
        RecallWeights {
            age_weight: 0.4,
            type_weight: 0.3,
            relevance_weight: 0.3,
        }
    }
}

/// Configuration for the memory engine.
#[derive(Debug, Clone)]
pub struct MemoryConfig {
    pub max_results: usize,
    pub staleness_days: i64,
    pub age_half_life_days: f64,
    pub auto_compact: bool,
    pub weights: RecallWeights,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        MemoryConfig {
            max_results: 10,
            staleness_days: 90,
            age_half_life_days: 30.0,
            auto_compact: true,
            weights: RecallWeights::default(),
        }
    }
}
