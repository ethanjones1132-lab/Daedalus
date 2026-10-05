// ═══════════════════════════════════════════════════════════════
// Learning Session Engine — Autonomous research job for Jarvis
// ═══════════════════════════════════════════════════════════════
//
// Pure library module: no tauri dependency. Provides the source quality
// gate, subtopic rotation, finding format, the typed native→Bun research
// request/response contract, and file output for learning sessions. Tauri
// command wrappers live in commands/jarvis_commands.rs.
//
// The research itself is performed by the owned Bun ToolRuntime over its
// existing `web_search`/`web_fetch` tools and capability policy. This module
// never performs a direct network call and never invents a finding: the
// command forwards a typed request and surfaces the typed response, or an
// explicit unavailable outcome when the owned runtime cannot answer.

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

/// Tier 1 hosts, matched on the parsed hostname only (exact host or a
/// dot-delimited subdomain boundary). Never inspected against path/query text.
const TIER1_HOSTS: &[&str] = &[
    "arxiv.org",
    "github.com",
    "gitlab.com",
    "doi.org",
    "pubmed.ncbi.nlm.nih.gov",
    "ncbi.nlm.nih.gov",
    "ieee.org",
    "acm.org",
    "wikipedia.org",
];

/// Tier 1 host suffixes (TLDs), same boundary rule.
const TIER1_SUFFIXES: &[&str] = &[".edu", ".gov"];

/// Social and low-quality surfaces rejected by hostname, never by path text.
const REJECTED_HOSTS: &[&str] = &[
    "facebook.com",
    "twitter.com",
    "x.com",
    "instagram.com",
    "tiktok.com",
    "reddit.com",
    "pinterest.com",
    "w3schools.com",
];

/// Exact-host or dot-delimited subdomain match: `host == entry` or
/// `host` ends with `.{entry}`. `github.com.evil.com`, `notgithub.com`, and
/// `netflix.com` (vs `x.com`) all fail this test.
fn host_matches(host: &str, entry: &str) -> bool {
    host == entry || host.ends_with(&format!(".{entry}"))
}

/// Evaluate a URL against the source quality allowlist by parsing it and
/// matching only the hostname. Malformed URLs, non-HTTP(S) schemes, embedded
/// credentials, social/low-quality hosts, and lookalike suffixes are rejected
/// with a concrete reason. Path and query text are never examined.
pub fn evaluate_source(url: &str) -> SourceEvaluation {
    let reject = |note: String| SourceEvaluation {
        url: url.to_string(),
        tier: CredibilityTier::Rejected,
        credibility_note: note,
    };

    let parsed = match reqwest::Url::parse(url) {
        Ok(parsed) => parsed,
        Err(error) => return reject(format!("malformed URL: {error}")),
    };

    match parsed.scheme() {
        "http" | "https" => {}
        other => return reject(format!("unsupported scheme: {other}")),
    }

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return reject("URL contains credentials".to_string());
    }

    let host = match parsed.host_str() {
        Some(host) if !host.is_empty() => host.to_lowercase(),
        _ => return reject("URL has no host".to_string()),
    };

    for bad in REJECTED_HOSTS {
        if host_matches(&host, bad) {
            return reject(format!("social or low-quality surface: {bad}"));
        }
    }

    for good in TIER1_HOSTS {
        if host_matches(&host, good) {
            return SourceEvaluation {
                url: url.to_string(),
                tier: CredibilityTier::Tier1,
                credibility_note: format!("matches Tier 1 host: {good}"),
            };
        }
    }
    for suffix in TIER1_SUFFIXES {
        if host.ends_with(*suffix) {
            return SourceEvaluation {
                url: url.to_string(),
                tier: CredibilityTier::Tier1,
                credibility_note: format!("matches Tier 1 suffix: {suffix}"),
            };
        }
    }

    reject("domain not on Tier 1 allowlist".to_string())
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

/// A single research finding, written to a session's findings file. Every
/// field is derived from retrieved source content plus the exact runtime/tool
/// identities that produced it; nothing here is synthesised.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Finding {
    pub subtopic: String,
    pub source_url: String,
    pub source_host: String,
    pub retrieved_at: String,
    pub content_digest: String,
    pub excerpt: String,
    pub reference: String,
    pub tool_name: String,
    pub tool_call_id: String,
    pub run_id: String,
    /// Digest of the verified stored trajectory's ordered tool sequence,
    /// computed by the distiller's `skill-source-evidence` decoder.
    pub trajectory_digest: String,
    pub bun_instance_id: String,
}

// ── Native → Bun typed research contract ─────────────────────

/// Typed bounded request to Bun's learning research service. Every identity
/// field is a native-validated tuple member; the caller never supplies Agent,
/// workspace, snapshot JSON, permissions, or trajectory payload authority.
#[derive(Debug, Clone, Serialize)]
pub struct LearningResearchRequest {
    pub request_id: String,
    pub agent_run_id: String,
    pub session_id: String,
    pub agent_id: String,
    pub project_root: String,
    pub topic: String,
    pub subtopic: String,
    pub seed_urls: Vec<String>,
    pub max_sources: u32,
    pub timeout_ms: u64,
}

/// One exact completed Agent run offered as a selector value. Identifiers only.
///
/// Sourced from the native-written `session_runs` mirror (same `run_id` the Bun
/// pipeline emits as `agent_run_id`); native `agent_runs`/`stage_runs` are
/// created by native migration but never written by native (the Bun
/// SelfTuningStore owns that telemetry in its own DB), so `session_runs` is the
/// native-authoritative run record for the exact tuple.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearningRunChoice {
    pub agent_run_id: String,
    pub outcome: String,
    pub selected_model: Option<String>,
    pub finished_at: String,
}

/// One persisted Session with at least one eligible completed Agent run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearningSessionChoice {
    pub session_id: String,
    pub agent_id: String,
    pub title: String,
    pub project_root: Option<String>,
    pub runs: Vec<LearningRunChoice>,
}

/// Authoritative selector list returned by native. Read failure is an `Err` at
/// the command boundary and must not be rendered as an empty list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearningSourceChoices {
    pub sessions: Vec<LearningSessionChoice>,
}

/// Terminal disposition of one research attempt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LearningOutcome {
    Complete,
    Partial,
    Unavailable,
}

/// Evidence binding status for the finding set.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceBindingStatus {
    Bound,
    Unavailable,
}

/// Binding of the returned findings to the exact trajectory/run identity and
/// tool-sequence digest the distiller consumes. `Unavailable` carries a reason
/// and never any fabricated run/digest values.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceBinding {
    pub status: EvidenceBindingStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_sequence_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl EvidenceBinding {
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            status: EvidenceBindingStatus::Unavailable,
            agent_run_id: None,
            session_id: None,
            tool_sequence_digest: None,
            reason: Some(reason.into()),
        }
    }
}

/// One source the research service declined to use, with a concrete reason.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RejectedSource {
    pub url: String,
    pub reason: String,
}

/// Typed bounded response from Bun's learning research service.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearningResearchResponse {
    pub request_id: String,
    pub bun_instance_id: String,
    pub run_id: String,
    pub outcome: LearningOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default)]
    pub findings: Vec<Finding>,
    #[serde(default)]
    pub rejected_sources: Vec<RejectedSource>,
    pub evidence_binding: EvidenceBinding,
    pub started_at: String,
    pub finished_at: String,
}

/// Output path for a learning session, derived from the topic + start time.
pub fn output_path(out_dir: &std::path::Path, topic: &str) -> PathBuf {
    let stamp = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let safe: String = topic
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    out_dir.join(format!("learning-{safe}-{stamp}.md"))
}
