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

use crate::db::AppDataRoot;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

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
///
/// Digest provenance: `content_digest` is computed by the owned Bun runtime
/// over the exact retrieved `web_fetch` body (`sha256:<hex>`), and `reference`
/// binds that digest to the canonical URL. Native validates identity, host,
/// format, and reference consistency but does **not** recompute the body digest:
/// the private transport contract returns the digest and a bounded excerpt, not
/// the raw retrieved bytes. The digest therefore proves byte identity of the
/// Bun-claimed body only; it is not a native recomputation and does not prove
/// the source is true or reputable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
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

/// Terminal disposition of one research attempt. These describe execution and
/// evidence coverage only; none is a quality or acceptance judgment.
///
/// * `complete` — normal bounded completion with no rejected/failed source.
/// * `partial` — a time/resource cap or individual source rejection left usable
///   bound findings.
/// * `blocked` — a policy stop (`allow`/`ask`/`deny` resolved to `ask`/`deny`)
///   prevented retrieval; no approval bypass is attempted.
/// * `unavailable` — missing identity, transport, or readback evidence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LearningOutcome {
    Complete,
    Partial,
    Blocked,
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
#[serde(deny_unknown_fields)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RejectedSource {
    pub url: String,
    pub reason: String,
}

/// Typed bounded response from Bun's learning research service. Strict decoding:
/// an unexpected nested field is a contract violation, not something to ignore.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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

// ── Versioned native research receipt + contained persistence ──
//
// The receipt is the single durable, native-authored record of exactly one
// bounded research attempt. It is keyed by the native-generated request id
// (`record_id == request_id`) and binds the exact request, Session, successful
// Agent run, persisted Agent, canonical project root, trajectory/tool-sequence
// digest, Bun instance, timings, outcome, every finding, and every rejected
// source into one canonical hash. Reports live only under the canonical
// app-owned data directory in the contained `research-history` subdirectory;
// there is no caller-supplied output path.

/// Version of the persisted research receipt schema. Bump on any shape or hash
/// payload change so an older receipt is never silently reinterpreted.
pub const LEARNING_RESEARCH_RECEIPT_VERSION: u32 = 1;

/// Contained, app-owned research-history subdirectory name.
pub const RESEARCH_HISTORY_DIR: &str = "research-history";

/// Maximum characters of the bounded retrieved excerpt that native will accept
/// from the transport. Matches the owned runtime's excerpt bound; it exists so a
/// finding's excerpt cannot be an unbounded body carried through the DTO.
pub const EXCERPT_MAX_CHARS: usize = 1_500;

/// Native-authored, source-bound research receipt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LearningResearchReceipt {
    pub version: u32,
    /// Native-generated record identity and persistence key (`== request_id`).
    pub record_id: String,
    pub request_id: String,
    pub topic: String,
    pub subtopic: String,
    pub session_id: String,
    pub agent_run_id: String,
    pub agent_id: String,
    pub project_root: String,
    pub tool_sequence_digest: String,
    pub bun_instance_id: String,
    pub started_at: String,
    pub finished_at: String,
    pub outcome: LearningOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default)]
    pub findings: Vec<Finding>,
    #[serde(default)]
    pub rejected_sources: Vec<RejectedSource>,
    pub created_at: String,
    /// Canonical lowercase SHA-256 of every other field. Recomputed and
    /// compared on every read.
    pub receipt_hash: String,
}

/// Deterministic projection of a receipt used for hashing. Field order is the
/// declaration order so the serialized bytes are stable across processes.
#[derive(Serialize)]
struct ReceiptHashPayload<'a> {
    version: u32,
    record_id: &'a str,
    request_id: &'a str,
    topic: &'a str,
    subtopic: &'a str,
    session_id: &'a str,
    agent_run_id: &'a str,
    agent_id: &'a str,
    project_root: &'a str,
    tool_sequence_digest: &'a str,
    bun_instance_id: &'a str,
    started_at: &'a str,
    finished_at: &'a str,
    outcome: &'a LearningOutcome,
    reason: &'a Option<String>,
    findings: &'a [Finding],
    rejected_sources: &'a [RejectedSource],
    created_at: &'a str,
}

/// Lowercase, 64-character SHA-256 of the exact bytes. No trim or normalization.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{:02x}", byte);
    }
    out
}

/// True only for a strict lowercase SHA-256 hex value (exactly 64 characters).
fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// True only for a strict `sha256:<64 lowercase hex>` digest.
fn is_sha256_digest(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .map(is_sha256_hex)
        .unwrap_or(false)
}

/// True only for a record id that is a contained path component: nonempty and
/// limited to ASCII alphanumerics, `-`, and `_`. This forbids separators,
/// `..`, absolute paths, and any whitespace, so a receipt path can never escape
/// the app-owned research-history directory.
pub fn is_safe_record_id(record_id: &str) -> bool {
    !record_id.is_empty()
        && record_id.len() <= 128
        && record_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl LearningResearchReceipt {
    fn hash_payload(&self) -> ReceiptHashPayload<'_> {
        ReceiptHashPayload {
            version: self.version,
            record_id: &self.record_id,
            request_id: &self.request_id,
            topic: &self.topic,
            subtopic: &self.subtopic,
            session_id: &self.session_id,
            agent_run_id: &self.agent_run_id,
            agent_id: &self.agent_id,
            project_root: &self.project_root,
            tool_sequence_digest: &self.tool_sequence_digest,
            bun_instance_id: &self.bun_instance_id,
            started_at: &self.started_at,
            finished_at: &self.finished_at,
            outcome: &self.outcome,
            reason: &self.reason,
            findings: &self.findings,
            rejected_sources: &self.rejected_sources,
            created_at: &self.created_at,
        }
    }

    /// Recompute the canonical receipt hash from the exact persisted fields.
    pub fn compute_hash(&self) -> Result<String, String> {
        let bytes = serde_json::to_vec(&self.hash_payload())
            .map_err(|e| format!("research receipt could not be hashed: {e}"))?;
        Ok(sha256_hex(&bytes))
    }

    /// Return the receipt with `receipt_hash` set to the canonical value.
    pub fn finalize_hash(mut self) -> Result<Self, String> {
        self.receipt_hash = self.compute_hash()?;
        Ok(self)
    }

    /// Strictly validate the receipt as a freshly decoded object: version,
    /// contained record id, record/request identity, recomputed hash, and full
    /// internal semantics. A receipt whose hash was recomputed over invalid
    /// identity, digest, source, time, binding, or outcome fields still fails.
    pub fn verify(&self) -> Result<(), String> {
        if self.version != LEARNING_RESEARCH_RECEIPT_VERSION {
            return Err(format!(
                "research receipt version {} is not supported",
                self.version
            ));
        }
        if !is_safe_record_id(&self.record_id) {
            return Err("research receipt has an unsafe record id".to_string());
        }
        if self.record_id != self.request_id {
            return Err("research receipt record id does not match its request id".to_string());
        }
        if self.receipt_hash != self.compute_hash()? {
            return Err("research receipt hash does not match its contents".to_string());
        }
        self.verify_semantics()
    }

    /// Revalidate every non-hash field independently of the hash. This is the
    /// readback gate: identity, trajectory digest, timestamps, outcome/reason,
    /// and every finding/rejected-source binding must be internally consistent.
    pub fn verify_semantics(&self) -> Result<(), String> {
        for (label, value) in [
            ("record id", &self.record_id),
            ("request id", &self.request_id),
            ("session id", &self.session_id),
            ("agent run id", &self.agent_run_id),
            ("agent id", &self.agent_id),
            ("project root", &self.project_root),
            ("tool-sequence digest", &self.tool_sequence_digest),
            ("Bun instance id", &self.bun_instance_id),
        ] {
            if value.trim().is_empty() {
                return Err(format!("research receipt {label} is empty"));
            }
        }
        if !is_sha256_digest(&self.tool_sequence_digest) {
            return Err("research receipt tool-sequence digest is not a strict SHA-256 digest".to_string());
        }

        let started = chrono::DateTime::parse_from_rfc3339(self.started_at.trim())
            .map_err(|_| "research receipt start time is not RFC3339".to_string())?;
        let finished = chrono::DateTime::parse_from_rfc3339(self.finished_at.trim())
            .map_err(|_| "research receipt finish time is not RFC3339".to_string())?;
        if finished < started {
            return Err("research receipt finish time precedes its start time".to_string());
        }

        match self.outcome {
            LearningOutcome::Complete => {
                if self.findings.is_empty() {
                    return Err("a complete research receipt has no findings".to_string());
                }
                if !self.rejected_sources.is_empty() {
                    return Err(
                        "a complete research receipt carries rejected sources".to_string()
                    );
                }
            }
            LearningOutcome::Partial => {
                if self.findings.is_empty() {
                    return Err("a partial research receipt has no findings".to_string());
                }
            }
            LearningOutcome::Blocked => {
                if self.reason.as_deref().map(str::trim).unwrap_or("").is_empty() {
                    return Err("a blocked research receipt has no policy reason".to_string());
                }
            }
            LearningOutcome::Unavailable => {
                if !self.findings.is_empty() {
                    return Err("an unavailable research receipt carries findings".to_string());
                }
            }
        }

        for finding in &self.findings {
            self.verify_finding(finding)?;
        }
        for rejected in &self.rejected_sources {
            if rejected.reason.trim().is_empty() {
                return Err("a rejected source has no reason".to_string());
            }
        }
        Ok(())
    }

    /// Revalidate one finding against the receipt's own binding. `content_digest`
    /// remains a Bun-claimed digest: native never receives the raw fetched body,
    /// so it validates the digest format, host, and reference binding but does
    /// not recompute the body hash.
    fn verify_finding(&self, finding: &Finding) -> Result<(), String> {
        if finding.run_id != self.agent_run_id {
            return Err("a finding is not bound to the receipt run".to_string());
        }
        if finding.trajectory_digest != self.tool_sequence_digest {
            return Err("a finding does not carry the receipt trajectory digest".to_string());
        }
        if finding.bun_instance_id != self.bun_instance_id {
            return Err("a finding was produced by a different Bun instance".to_string());
        }
        if finding.tool_name != "web_fetch" {
            return Err("a finding was produced by an unexpected tool".to_string());
        }
        let call_suffix = finding
            .tool_call_id
            .strip_prefix("web_fetch-")
            .ok_or_else(|| "a finding has an unexpected tool call id".to_string())?;
        if call_suffix.is_empty() || uuid::Uuid::parse_str(call_suffix).is_err() {
            return Err("a finding has an invalid tool call id".to_string());
        }

        let evaluated = evaluate_source(&finding.source_url);
        if !matches!(evaluated.tier, CredibilityTier::Tier1) {
            return Err("a finding cites a source outside the Tier 1 allowlist".to_string());
        }
        let parsed = reqwest::Url::parse(&finding.source_url)
            .map_err(|_| "a finding cites a malformed source URL".to_string())?;
        let host = parsed
            .host_str()
            .map(|value| value.to_lowercase())
            .ok_or_else(|| "a finding cites a source URL with no host".to_string())?;
        if host != finding.source_host.to_lowercase() {
            return Err("a finding's source host does not match its URL".to_string());
        }

        let digest = finding
            .content_digest
            .strip_prefix("sha256:")
            .ok_or_else(|| "a finding has a non-SHA-256 content digest".to_string())?;
        if !is_sha256_hex(digest) {
            return Err("a finding has an invalid content digest".to_string());
        }
        if finding.reference != format!("{}#sha256={}", finding.source_url, digest) {
            return Err("a finding's reference is not bound to its URL and digest".to_string());
        }
        if finding.excerpt.trim().is_empty() {
            return Err("a finding has an empty retrieved excerpt".to_string());
        }
        if finding.excerpt.chars().count() > EXCERPT_MAX_CHARS {
            return Err("a finding's retrieved excerpt exceeds the bounded length".to_string());
        }
        chrono::DateTime::parse_from_rfc3339(finding.retrieved_at.trim())
            .map_err(|_| "a finding has a non-RFC3339 retrieval timestamp".to_string())?;
        Ok(())
    }
}

/// The contained, app-owned research-history directory for an app data root.
/// Used only to render a display destination; receipt I/O never resolves a
/// path and always anchors to the retained app-data root handle.
pub fn research_history_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(RESEARCH_HISTORY_DIR)
}

/// Handle-relative, race-safe receipt I/O.
///
/// All receipt operations are resolved relative to the `research-history`
/// directory handle, which is opened relative to the app-data root handle
/// retained in `AppDb` (the directory inode that owns the open SQLite
/// database). Once the handle is open, swapping `research-history` (or the
/// receipt path) for a symlink cannot redirect a read or write: `openat`
/// resolves against the directory inode, and `O_NOFOLLOW` refuses a symlinked
/// final component. `openat`/`mkdirat` are declared via `extern "C"` and link
/// against the platform C library already present, so no dependency is added.
#[cfg(unix)]
mod receipt_io {
    use super::RESEARCH_HISTORY_DIR;
    use crate::db::AppDataRoot;
    use std::ffi::CString;
    use std::fs::File;
    use std::io::{Read as _, Write as _};
    use std::os::fd::{AsRawFd, FromRawFd, RawFd};
    use std::os::raw::{c_char, c_int};

    // `mode_t` matches the platform C type so the `mkdirat` prototype is exact
    // (Linux/Android: unsigned int; macOS/iOS: unsigned short).
    #[cfg(any(target_os = "linux", target_os = "android"))]
    type mode_t = u32;
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    type mode_t = u16;
    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    )))]
    type mode_t = u32;

    extern "C" {
        fn openat(dirfd: c_int, pathname: *const c_char, flags: c_int, ...) -> c_int;
        fn mkdirat(dirfd: c_int, pathname: *const c_char, mode: mode_t) -> c_int;
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    mod flags {
        use std::os::raw::c_int;
        pub const O_RDONLY: c_int = 0;
        pub const O_WRONLY: c_int = 1;
        pub const O_CREAT: c_int = 0o100;
        pub const O_EXCL: c_int = 0o200;
        pub const O_NOFOLLOW: c_int = 0o400000;
        pub const O_DIRECTORY: c_int = 0o200000;
        pub const O_CLOEXEC: c_int = 0o2000000;
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    mod flags {
        use std::os::raw::c_int;
        pub const O_RDONLY: c_int = 0;
        pub const O_WRONLY: c_int = 1;
        pub const O_CREAT: c_int = 0x0200;
        pub const O_EXCL: c_int = 0x0800;
        pub const O_NOFOLLOW: c_int = 0x0100;
        pub const O_DIRECTORY: c_int = 0x100000;
        pub const O_CLOEXEC: c_int = 0x1000000;
    }
    // Other Unix targets are not covered by verified constants; `SUPPORTED` is
    // false and every operation fails closed.
    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    )))]
    mod flags {
        use std::os::raw::c_int;
        pub const O_RDONLY: c_int = 0;
        pub const O_WRONLY: c_int = 1;
        pub const O_CREAT: c_int = 0;
        pub const O_EXCL: c_int = 0;
        pub const O_NOFOLLOW: c_int = 0;
        pub const O_DIRECTORY: c_int = 0;
        pub const O_CLOEXEC: c_int = 0;
    }

    const SUPPORTED: bool = cfg!(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    ));

    const UNSUPPORTED: &str =
        "handle-relative research receipt storage is unsupported on this platform";

    fn cpath(name: &str) -> Result<CString, String> {
        CString::new(name.as_bytes().to_vec())
            .map_err(|_| "research receipt name contains an interior NUL".to_string())
    }

    /// Outcome of opening the contained child directory relative to the retained
    /// app-data root fd.
    enum ChildOpen {
        Opened(ReceiptDir),
        Missing,
        Refused(String),
    }

    /// Open the contained `research-history` directory relative to the retained
    /// app-data root fd with `O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC`. A symlinked
    /// or non-directory target is refused; absence is reported distinctly so the
    /// caller can create it relative to the same fd.
    fn open_child(base_fd: RawFd, name: &CString) -> ChildOpen {
        let fd = unsafe {
            openat(
                base_fd,
                name.as_ptr(),
                flags::O_RDONLY | flags::O_DIRECTORY | flags::O_NOFOLLOW | flags::O_CLOEXEC,
            )
        };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::NotFound {
                return ChildOpen::Missing;
            }
            return ChildOpen::Refused(format!("research history directory is unavailable: {error}"));
        }
        let dir = unsafe { File::from_raw_fd(fd) };
        match dir.metadata() {
            Ok(meta) if meta.file_type().is_dir() => ChildOpen::Opened(ReceiptDir { dir }),
            Ok(_) => ChildOpen::Refused("research history path is not a directory".to_string()),
            Err(error) => {
                ChildOpen::Refused(format!("research history directory is unavailable: {error}"))
            }
        }
    }

    /// A verified `research-history` directory handle that anchors every receipt
    /// operation for its lifetime.
    pub struct ReceiptDir {
        dir: File,
    }

    impl ReceiptDir {
        /// Open the existing, contained directory relative to the retained app
        /// data root handle. A symlinked or non-directory target is refused.
        /// `Ok(None)` means the directory does not exist.
        pub fn open(root: &AppDataRoot) -> Result<Option<ReceiptDir>, String> {
            if !SUPPORTED || !root.is_supported() {
                return Err(UNSUPPORTED.to_string());
            }
            let name = cpath(RESEARCH_HISTORY_DIR)?;
            match open_child(root.raw_dir_fd(), &name) {
                ChildOpen::Opened(dir) => Ok(Some(dir)),
                ChildOpen::Missing => Ok(None),
                ChildOpen::Refused(reason) => Err(reason),
            }
        }

        /// Open (creating once) the contained directory relative to the retained
        /// app data root handle. `mkdirat` and `openat` both resolve against the
        /// retained fd, so the base handle is never released for a pathname
        /// operation and a symlink swapped in is refused by `O_NOFOLLOW`. The
        /// app data root already exists because the native DB lives there and the
        /// root anchor was bound to it at initialization.
        pub fn open_or_create(root: &AppDataRoot) -> Result<ReceiptDir, String> {
            if !SUPPORTED || !root.is_supported() {
                return Err(UNSUPPORTED.to_string());
            }
            let name = cpath(RESEARCH_HISTORY_DIR)?;
            let base_fd = root.raw_dir_fd();

            // Fast path: the directory already exists. Flush the retained
            // app-data root before relying on the existing entry.
            match open_child(base_fd, &name) {
                ChildOpen::Opened(dir) => {
                    root.sync_dir()?;
                    return Ok(dir);
                }
                ChildOpen::Refused(reason) => return Err(reason),
                ChildOpen::Missing => {}
            }

            // Create the child relative to the retained root handle.
            // `AlreadyExists` is the idempotent case (e.g. a concurrent creator
            // won the race).
            let made = unsafe { mkdirat(base_fd, name.as_ptr(), 0o700 as mode_t) };
            if made < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(format!("research history directory is unavailable: {error}"));
                }
            }

            // Open the child relative to the same retained root handle (no-follow
            // so a symlinked entry is never followed), then flush the retained
            // app-data root unconditionally so the entry is durable whether it was
            // just created or already existed.
            let dir = match open_child(base_fd, &name) {
                ChildOpen::Opened(dir) => dir,
                ChildOpen::Missing => {
                    return Err("research history directory could not be opened".to_string())
                }
                ChildOpen::Refused(reason) => return Err(reason),
            };
            root.sync_dir()?;
            Ok(dir)
        }

        fn file_name(record_id: &str) -> Result<CString, String> {
            cpath(&format!("{record_id}.json"))
        }

        /// Flush this `research-history` directory handle so a newly created
        /// receipt entry is durable. A failure must be surfaced so the caller
        /// does not claim persistence.
        pub fn sync_dir(&self) -> Result<(), String> {
            self.dir
                .sync_all()
                .map_err(|error| format!("research history directory sync failed: {error}"))
        }

        /// Read the exact receipt file relative to this directory handle.
        /// `Ok(None)` is absent; a symlink/non-regular target is refused.
        pub fn read(&self, record_id: &str) -> Result<Option<Vec<u8>>, String> {
            let name = Self::file_name(record_id)?;
            let fd = unsafe {
                openat(
                    self.dir.as_raw_fd(),
                    name.as_ptr(),
                    flags::O_RDONLY | flags::O_NOFOLLOW | flags::O_CLOEXEC,
                )
            };
            if fd < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::NotFound {
                    return Ok(None);
                }
                return Err(format!("research receipt read unavailable: {error}"));
            }
            let mut file = unsafe { File::from_raw_fd(fd) };
            let meta = file
                .metadata()
                .map_err(|error| format!("research receipt read unavailable: {error}"))?;
            if !meta.file_type().is_file() {
                return Err("research receipt handle is not a regular file".to_string());
            }
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .map_err(|error| format!("research receipt read unavailable: {error}"))?;
            Ok(Some(bytes))
        }

        /// Create the receipt file exactly once relative to this handle.
        /// `Ok(false)` means the path already exists (idempotency path); a
        /// symlinked target is refused rather than followed.
        pub fn write_new(&self, record_id: &str, bytes: &[u8]) -> Result<bool, String> {
            let name = Self::file_name(record_id)?;
            let fd = unsafe {
                openat(
                    self.dir.as_raw_fd(),
                    name.as_ptr(),
                    flags::O_WRONLY
                        | flags::O_CREAT
                        | flags::O_EXCL
                        | flags::O_NOFOLLOW
                        | flags::O_CLOEXEC,
                    0o600 as c_int,
                )
            };
            if fd < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    return Ok(false);
                }
                return Err(format!("research receipt could not be written: {error}"));
            }
            let mut file = unsafe { File::from_raw_fd(fd) };
            file.write_all(bytes)
                .map_err(|error| format!("research receipt could not be written: {error}"))?;
            // Flush the file before flushing the directory entry that names it.
            file.sync_all()
                .map_err(|error| format!("research receipt could not be flushed: {error}"))?;
            drop(file);
            self.sync_dir()?;
            Ok(true)
        }
    }
}

/// Strictly decode and verify one receipt from exact bytes.
#[cfg(unix)]
fn decode_receipt(bytes: &[u8]) -> Result<LearningResearchReceipt, String> {
    let receipt: LearningResearchReceipt = serde_json::from_slice(bytes)
        .map_err(|error| format!("research receipt could not be strictly decoded: {error}"))?;
    receipt.verify()?;
    Ok(receipt)
}

/// Strictly read one durable receipt. `Ok(None)` is a genuine absent record;
/// `Err` is a read, decode, or verification failure and must never be rendered
/// as an empty result.
///
/// Every read anchors to the retained app-data root handle (`root`) and reads
/// the receipt relative to it with `O_NOFOLLOW`, so the bytes come from a
/// verified regular file inside the directory that owns the open SQLite
/// database.
pub fn read_research_receipt(
    root: &AppDataRoot,
    record_id: &str,
) -> Result<Option<LearningResearchReceipt>, String> {
    if !is_safe_record_id(record_id) {
        return Err("research record id is not a safe contained identifier".to_string());
    }
    platform_read_research_receipt(root, record_id)
}

#[cfg(unix)]
fn platform_read_research_receipt(
    root: &AppDataRoot,
    record_id: &str,
) -> Result<Option<LearningResearchReceipt>, String> {
    let Some(dir) = receipt_io::ReceiptDir::open(root)? else {
        return Ok(None);
    };
    let Some(bytes) = dir.read(record_id)? else {
        return Ok(None);
    };
    decode_receipt(&bytes).map(Some)
}

/// Non-Unix platforms fail closed (see `platform_persist_research_receipt`).
#[cfg(not(unix))]
fn platform_read_research_receipt(
    _root: &AppDataRoot,
    _record_id: &str,
) -> Result<Option<LearningResearchReceipt>, String> {
    Err(
        "handle-relative research receipt storage is unavailable on this platform; refusing to \
         read without containment guarantees"
            .to_string(),
    )
}

/// Persist one receipt under the contained, app-owned research-history
/// directory and prove the write by exact readback.
///
/// All operations resolve against the retained app-data root handle (`root`)
/// that owns the open SQLite database, so swapping `research-history` for a
/// symlink after verification cannot redirect the write. The write is
/// create-once and is reconciled only by an exact equal receipt; success is
/// returned only after the exact bytes are read back through the same retained
/// directory authority, strictly decoded, hash-verified, and compared
/// field-for-field.
pub fn persist_research_receipt(
    root: &AppDataRoot,
    receipt: LearningResearchReceipt,
) -> Result<(LearningResearchReceipt, PathBuf), String> {
    let receipt = receipt.finalize_hash()?;
    if receipt.record_id != receipt.request_id {
        return Err("research receipt record id does not match its request id".to_string());
    }
    if !is_safe_record_id(&receipt.record_id) {
        return Err("research record id is not a safe contained identifier".to_string());
    }
    platform_persist_research_receipt(root, receipt)
}

/// Unix persistence: anchor to a verified `research-history` directory handle
/// opened relative to the retained app data root handle, then create-once and
/// read back through that same handle.
#[cfg(unix)]
fn platform_persist_research_receipt(
    root: &AppDataRoot,
    receipt: LearningResearchReceipt,
) -> Result<(LearningResearchReceipt, PathBuf), String> {
    let bytes = serde_json::to_vec_pretty(&receipt)
        .map_err(|error| format!("research receipt could not be encoded: {error}"))?;
    let dir = receipt_io::ReceiptDir::open_or_create(root)?;
    // Display-only destination path; receipt I/O never uses it.
    let display_path =
        research_history_dir(root.display_path()).join(format!("{}.json", receipt.record_id));

    // `write_new` creates exclusively relative to the directory handle; a
    // pre-existing (including symlinked) path is reported, never followed.
    if !dir.write_new(&receipt.record_id, &bytes)? {
        let existing_bytes = dir.read(&receipt.record_id)?.ok_or_else(|| {
            "an existing research receipt disappeared during reconciliation".to_string()
        })?;
        let existing = decode_receipt(&existing_bytes)?;
        if existing != receipt {
            return Err(
                "a different research receipt already exists for this record id".to_string(),
            );
        }
        // Exact idempotent reconciliation: flush the directory handle before
        // claiming the receipt is durable.
        dir.sync_dir()?;
        return Ok((existing, display_path));
    }

    // Exact durable readback through the same retained directory authority.
    let readback_bytes = dir
        .read(&receipt.record_id)?
        .ok_or_else(|| "research receipt was not readable immediately after write".to_string())?;
    let readback = decode_receipt(&readback_bytes)?;
    if readback != receipt {
        return Err("research receipt readback did not match the written record".to_string());
    }
    Ok((readback, display_path))
}

/// Non-Unix platforms cannot retain a directory handle that binds the database
/// root (a full-pathname reparse flag does not protect parent components), so
/// they fail closed rather than claim containment or fall back to path-only
/// storage.
#[cfg(not(unix))]
fn platform_persist_research_receipt(
    _root: &AppDataRoot,
    _receipt: LearningResearchReceipt,
) -> Result<(LearningResearchReceipt, PathBuf), String> {
    Err(
        "handle-relative research receipt storage is unavailable on this platform; refusing to \
         write without containment guarantees"
            .to_string(),
    )
}
