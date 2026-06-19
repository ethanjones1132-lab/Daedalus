// ═══════════════════════════════════════════════════════════════
// Learning Session Engine — Autonomous research job for Jarvis
// ═══════════════════════════════════════════════════════════════
//
// Pure library module: no tauri dependency. Provides the source quality
// gate, subtopic rotation, finding format, and file output for learning
// sessions. Tauri command wrappers live in commands/jarvis_commands.rs.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ── Source Quality Rules ─────────────────────────────────────

/// Credibility tier for a source. Only Tier 1 sources are retained.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum CredibilityTier {
    Tier1,
    Rejected,
}

/// Result of evaluating a URL against the quality gate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceEvaluation {
    pub url: String,
    pub tier: CredibilityTier,
    pub credibility_note: String,
}

/// Evaluate a URL against the source quality allowlist.
pub fn evaluate_source(url: &str) -> SourceEvaluation {
    let lo