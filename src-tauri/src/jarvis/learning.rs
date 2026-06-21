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
    let lower = url.to_lowercase();

    // Reject obvious non-research surfaces first.
    let rejected_substrings = [
        "facebook.com", "twitter.com", "x.com", "instagram.com",
        "tiktok.com", "reddit.com", "pinterest.com",
        "w3schools.com",
    ];
    for bad in rejected_substrings {
        if lower.contains(bad) {
            return SourceEvaluation {
                url: url.to_string(),
                tier: CredibilityTier::Rejected,
                credibility_note: format!("social or low-quality surface: {bad}"),
            };
        }
    }

    // Tier 1 surfaces — well-sourced, primary or peer-reviewed.
    let tier1_substrings = [
        ".edu", ".gov", "arxiv.org", "github.com", "gitlab.com",
        "doi.org", "pubmed.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov",
        "ieee.org", "acm.org", "wikipedia.org",
    ];
    for good in tier1_substrings {
        if lower.contains(good) {
            return SourceEvaluation {
                url: url.to_string(),
                tier: CredibilityTier::Tier1,
                credibility_note: format!("matches Tier 1 surface: {good}"),
            };
        }
    }

    // Default — needs manual review; reject to keep the corpus clean.
    SourceEvaluation {
        url: url.to_string(),
        tier: CredibilityTier::Rejected,
        credibility_note: "domain not on Tier 1 allowlist".to_string(),
    }
}

/// Subtopic rotation — picks the next focus area for a learning session
/// based on the previous ones. State is intentionally in-memory; the caller
/// is expected to persist a JSON rotation log alongside the session output.
pub fn next_subtopic(previous: &[String]) -> &'static str {
    let candidates = [
        "core_architecture",
        "implementation_patterns",
        "failure_modes",
        "optimization_techniques",
        "ecosystem_integration",
        "testing_strategy",
        "observability_and_metrics",
    ];
    for c in candidates {
        if !previous.iter().any(|p| p == c) {
            return c;
        }
    }
    "review_and_consolidate"
}

/// A single research finding, written to a session's findings file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Finding {
    pub subtopic: String,
    pub source_url: String,
    pub summary: String,
    pub captured_at: String,
}

/// Output path for a learning session, derived from the topic + start time.
pub fn output_path(out_dir: &std::path::Path, topic: &str) -> PathBuf {
    let stamp = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let safe: String = topic
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    out_dir.join(format!("learning-{safe}-{stamp}.md"))
}
