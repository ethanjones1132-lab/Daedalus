// ═══════════════════════════════════════════════════════════════
// Native memory transport — owned-process authority + lifecycle
// ═══════════════════════════════════════════════════════════════
//
// Phase 2.2 owns the single private capability shared only with the Bun
// child this Tauri process started, the bounded blocking HTTP protocol
// used to register/sync/invalidate turns, and the native operation gate
// that serializes preparation against every semantic mutation.
//
// This module never holds the AppDb mutex across HTTP. It never trusts a
// TCP listener as proof of ownership: only the tracked child handle plus a
// capability-authenticated response establish an owned generation.

use std::io::Read;
use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::capture_contracts::{MemoryDerivedInvalidation, NativeDerivedMutationPlan};
use super::contracts::MemoryError;
use super::turn::{
    self, mark_memory_turn_registered, mark_memory_turn_registration_failed,
    MemoryRecallStatus, MemoryTurnDiagnostic, MemoryTurnIdentityRequest, MemoryTurnPreparation,
    NativeMemoryRuntimeReceipt, PrepareMemoryTurnOutcome, PrepareMemoryTurnRequest,
    PreparedMemoryTurn,
};
use super::{continuity, scoped};
use crate::db::AppDb;
use crate::process_lifecycle::BunOwnership;

/// Capability env var names. Exactly these spellings, only on the owned child.
pub const CAPABILITY_ENV: &str = "JARVIS_NATIVE_MEMORY_CAPABILITY";
pub const APP_INSTANCE_ENV: &str = "JARVIS_NATIVE_APP_INSTANCE_ID";

const CONNECT_TIMEOUT_MS: u64 = 1_000;
const REQUEST_TIMEOUT_SECS: u64 = 3;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
/// Margin added on top of the trusted whole-run deadline for the dedicated
/// trusted-execution request timeout.
const TRUSTED_EXECUTION_HTTP_MARGIN_MS: u64 = 60_000;

/// Registration response from the owned Bun registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistrationResult {
    pub preparation_id: String,
    pub bun_instance_id: String,
}

/// Wire shape of one native-authorized Goal run binding registered with the
/// owned Bun child. Distinct from the memory envelope: it is registered even
/// when no memory preparation exists, so Goal linkage never depends on memory
/// availability. Fields are association identity only; no permission, scope,
/// or recalled content crosses this boundary. `source_message_id`/`_hash` bind
/// the exact native saved user source row; `task_run_id` is the stable native
/// execution identity.
#[derive(Debug, Clone, Serialize)]
pub struct GoalRunBindingWire {
    pub binding_id: String,
    pub goal_id: String,
    pub session_id: String,
    pub agent_id: String,
    pub project_root: Option<String>,
    pub objective: String,
    pub criteria: Vec<String>,
    pub turn_id: String,
    pub source_message_id: String,
    pub source_message_hash: String,
    pub task_run_id: String,
    pub issued_at: String,
    pub expires_at: String,
}

/// Registration response for a Goal run binding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalBindingResult {
    pub binding_id: String,
    pub bun_instance_id: String,
}

/// Bounded, transcript-free checkpoint view fetched from the owned Bun child for
/// one Goal-owned TaskRun. Only structured status/IDs/stage/effect-state and
/// evidence *references* cross this boundary — never transcripts or memory text.
/// Field names mirror the Bun `GoalCheckpointView` wire (camelCase).
/// `accepted_output_evidence.pending` marks that trusted accepted-output evidence
/// belongs to Roadmap Priority #2 Part 4 and the completion gate remains open.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalCheckpointWire {
    pub goal_id: String,
    pub binding_id: String,
    pub session_id: String,
    pub task_run_id: String,
    pub objective: String,
    pub status: String,
    pub state: String,
    pub stage: Option<String>,
    pub attempt: i64,
    pub current_effect_id: Option<String>,
    #[serde(default)]
    pub effects: Vec<GoalCheckpointEffectWire>,
    pub interrupted: bool,
    #[serde(default)]
    pub ambiguous_effect_id: Option<String>,
    #[serde(default)]
    pub progress_evidence_refs: Vec<String>,
    #[serde(default)]
    pub accepted_output_evidence: GoalAcceptedOutputEvidenceWire,
    pub started_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalCheckpointEffectWire {
    pub effect_id: String,
    pub kind: String,
    pub outcome: String,
    #[serde(default)]
    pub r#ref: Option<String>,
}

/// Part 4 accepted-output marker. Always pending/unverified while trusted
/// acceptance is unimplemented.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalAcceptedOutputEvidenceWire {
    #[serde(default)]
    pub pending: bool,
    #[serde(default)]
    pub unverified: bool,
    #[serde(default)]
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct DerivedWirePayload {
    operation_id: String,
    affected_session_ids: Vec<String>,
    memory_ids: Vec<String>,
    source_message_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct InvalidationRequest {
    app_instance_id: String,
    reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    derived: Option<DerivedWirePayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InvalidationResponse {
    invalidated_count: i64,
    bun_instance_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AckRequest {
    turn_id: String,
}

/// Mutable owned-generation state, guarded by one mutex that also acts as the
/// native operation gate. Preparation, sync, invalidation and every semantic
/// mutation serialize through it, so no registration can race a commit.
#[derive(Default)]
struct TransportState {
    /// The owned generation whose registration response we accepted, and the
    /// bun instance id it reported. `None` means registration is ambiguous
    /// (never attempted, or the response was lost).
    bound_generation: Option<u64>,
    bound_bun_instance_id: Option<String>,
}

pub struct NativeMemoryTransport {
    capability: String,
    app_instance_id: String,
    client: OnceLock<Option<reqwest::blocking::Client>>,
    state: Mutex<TransportState>,
}

#[derive(Debug)]
enum HttpFailure {
    /// No owned capability server responded (401/503/network/other), or the
    /// client could not be constructed with the required timeouts.
    Unavailable,
}

impl NativeMemoryTransport {
    fn new() -> Self {
        // Two concatenated UUID v4 values, no separators: an unguessable
        // app-lifetime secret. Never persisted, never exposed to the UI.
        let capability = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        Self {
            capability,
            app_instance_id: Uuid::new_v4().to_string(),
            client: OnceLock::new(),
            state: Mutex::new(TransportState::default()),
        }
    }

    pub fn app_instance_id(&self) -> &str {
        &self.app_instance_id
    }

    /// The capability value to inject into the owned child environment.
    /// Only `lib.rs` reads this, and only for the owned spawn.
    pub fn capability(&self) -> &str {
        &self.capability
    }

    /// A bounded blocking client. Build failure (or a build inside an async
    /// context) is reported as unavailable and no HTTP is attempted; there is
    /// no untimed fallback client.
    fn client(&self) -> Result<&reqwest::blocking::Client, HttpFailure> {
        self.client
            .get_or_init(|| {
                reqwest::blocking::Client::builder()
                    .connect_timeout(std::time::Duration::from_millis(CONNECT_TIMEOUT_MS))
                    .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
                    .build()
                    .ok()
            })
            .as_ref()
            .ok_or(HttpFailure::Unavailable)
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, TransportState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn base_url() -> String {
        crate::wsl::get_cached_bun_url()
            .map(|url| url.trim_end_matches('/').to_string())
            .unwrap_or_else(|| format!("http://127.0.0.1:{}", crate::BUN_SERVER_PORT))
    }

    fn post_json(
        &self,
        path: &str,
        body: &impl Serialize,
        expected_status: u16,
    ) -> Result<String, HttpFailure> {
        let url = format!("{}{}", Self::base_url(), path);
        let response = self
            .client()?
            .post(url)
            .bearer_auth(&self.capability)
            .json(body)
            .send()
            .map_err(|_| HttpFailure::Unavailable)?;
        if response.status().as_u16() != expected_status {
            return Err(HttpFailure::Unavailable);
        }
        Self::read_bounded(response)
    }

    /// Like `post_json`, but with a per-request timeout override. The shared
    /// client's default 3s timeout would otherwise cut off any legitimate
    /// trusted execution that runs longer than a few seconds. Response byte caps
    /// and status checks are identical.
    fn post_json_with_timeout(
        &self,
        path: &str,
        body: &impl Serialize,
        expected_status: u16,
        timeout: std::time::Duration,
    ) -> Result<String, HttpFailure> {
        let url = format!("{}{}", Self::base_url(), path);
        let response = self
            .client()?
            .post(url)
            .bearer_auth(&self.capability)
            .timeout(timeout)
            .json(body)
            .send()
            .map_err(|_| HttpFailure::Unavailable)?;
        if response.status().as_u16() != expected_status {
            return Err(HttpFailure::Unavailable);
        }
        Self::read_bounded(response)
    }

    fn get_json(&self, path: &str, expected_status: u16) -> Result<String, HttpFailure> {
        let url = format!("{}{}", Self::base_url(), path);
        let response = self
            .client()?
            .get(url)
            .bearer_auth(&self.capability)
            .send()
            .map_err(|_| HttpFailure::Unavailable)?;
        if response.status().as_u16() != expected_status {
            return Err(HttpFailure::Unavailable);
        }
        Self::read_bounded(response)
    }

    /// Read at most `MAX_RESPONSE_BYTES`; a larger body is rejected without
    /// first buffering the whole response.
    fn read_bounded(response: reqwest::blocking::Response) -> Result<String, HttpFailure> {
        let mut buffer = Vec::new();
        let limit = (MAX_RESPONSE_BYTES as u64) + 1;
        response
            .take(limit)
            .read_to_end(&mut buffer)
            .map_err(|_| HttpFailure::Unavailable)?;
        if buffer.len() > MAX_RESPONSE_BYTES {
            return Err(HttpFailure::Unavailable);
        }
        String::from_utf8(buffer).map_err(|_| HttpFailure::Unavailable)
    }

    /// Register one prepared envelope with the live owned registry. Requires an
    /// actual owned live child and detects replacement across HTTP using the
    /// atomic generation. The response is the only evidence that the current
    /// owned child accepted the turn.
    fn register_envelope(
        &self,
        state: &mut TransportState,
        envelope: &PreparedMemoryTurn,
    ) -> Result<RegistrationResult, HttpFailure> {
        if !matches!(crate::process_lifecycle::bun_ownership(), BunOwnership::Live) {
            return Err(HttpFailure::Unavailable);
        }
        let generation = crate::process_lifecycle::bun_generation();
        let body = self.post_json("/internal/memory/preparations", envelope, 200)?;
        let parsed: RegistrationResult =
            serde_json::from_str(&body).map_err(|_| HttpFailure::Unavailable)?;
        if parsed.preparation_id != envelope.preparation_id {
            return Err(HttpFailure::Unavailable);
        }
        // Reject a response whose owned child was replaced while in flight.
        if crate::process_lifecycle::bun_generation() != generation
            || !matches!(crate::process_lifecycle::bun_ownership(), BunOwnership::Live)
        {
            return Err(HttpFailure::Unavailable);
        }
        state.bound_generation = Some(generation);
        state.bound_bun_instance_id = Some(parsed.bun_instance_id.clone());
        Ok(parsed)
    }

    /// Ask the live owned registry to drop every unconsumed envelope AND, when a
    /// derived payload is supplied, synchronously evict memory-derived prompt
    /// state for the affected Sessions in the same authenticated round trip.
    ///
    /// Returns whether an actual live owned child ACKed. A confirmed
    /// `None`/`Exited` generation permits the native mutation but reports
    /// `false`: durable Bun cleanup remains pending (the outbox row must not be
    /// acknowledged), and a later live drain must succeed before the next
    /// preparation/history read.
    ///
    /// Ownership handling: EVERY current live owned child must ACK the current
    /// generation, including when the previously-bound generation was replaced.
    /// We clear obsolete bound metadata and authenticate against the actual new
    /// child; an unknown ownership state fails closed. A healthy live child is
    /// never killed to manufacture success.
    fn invalidate_registry(
        &self,
        state: &mut TransportState,
        reason: &str,
        derived: Option<(&str, &MemoryDerivedInvalidation)>,
    ) -> Result<bool, HttpFailure> {
        // `derived` is `(wire_operation_key, invalidation)`. The key is already
        // native-namespaced by the original initiating Session exactly once, so
        // the initial cleanup and every later drain send the same key.
        match crate::process_lifecycle::bun_ownership() {
            BunOwnership::None | BunOwnership::Exited => return Ok(false),
            BunOwnership::Unknown => return Err(HttpFailure::Unavailable),
            BunOwnership::Live => {}
        }

        let generation = crate::process_lifecycle::bun_generation();
        // A replaced/unbound generation must still authenticate against the
        // actual current live child; clear any obsolete bound identity first.
        if state.bound_generation != Some(generation) {
            state.bound_generation = None;
            state.bound_bun_instance_id = None;
        }

        let derived_payload = derived.map(|(wire_key, invalidation)| DerivedWirePayload {
            operation_id: wire_key.to_string(),
            affected_session_ids: invalidation.affected_session_ids.clone(),
            memory_ids: invalidation.memory_ids.clone(),
            source_message_ids: invalidation.source_message_ids.clone(),
        });

        let request = InvalidationRequest {
            app_instance_id: self.app_instance_id.clone(),
            reason: reason.to_string(),
            derived: derived_payload,
        };
        let body = self.post_json("/internal/memory/invalidate", &request, 200)?;
        let parsed: InvalidationResponse =
            serde_json::from_str(&body).map_err(|_| HttpFailure::Unavailable)?;
        // When a generation is bound, the ACK must come from that generation's
        // registry; an invalid or mismatched ACK must never clear the gate.
        if let Some(bound_id) = state.bound_bun_instance_id.as_deref() {
            if parsed.bun_instance_id != bound_id {
                return Err(HttpFailure::Unavailable);
            }
        }
        state.bound_generation = Some(generation);
        state.bound_bun_instance_id = Some(parsed.bun_instance_id);
        Ok(true)
    }

    /// Register one native-authorized Goal run binding with the live owned
    /// registry over the same private capability as the memory routes. This is
    /// an independent one-shot: it never depends on memory preparation, and a
    /// non-live/unknown owned child fails closed (returns `Ok(None)`) so the
    /// turn proceeds as an ordinary goal-less turn with no Goal linkage.
    ///
    /// The response is the only evidence the current owned child accepted the
    /// binding; the generation is re-checked after the HTTP round trip and a
    /// replaced child is treated as unavailable.
    fn register_goal_binding(
        &self,
        state: &mut TransportState,
        binding: &GoalRunBindingWire,
    ) -> Result<Option<GoalBindingResult>, HttpFailure> {
        if !matches!(crate::process_lifecycle::bun_ownership(), BunOwnership::Live) {
            return Ok(None);
        }
        let generation = crate::process_lifecycle::bun_generation();
        let body = self.post_json("/internal/goals/run-bindings", binding, 200)?;
        let parsed: GoalBindingResult =
            serde_json::from_str(&body).map_err(|_| HttpFailure::Unavailable)?;
        if parsed.binding_id != binding.binding_id {
            return Err(HttpFailure::Unavailable);
        }
        if crate::process_lifecycle::bun_generation() != generation
            || !matches!(crate::process_lifecycle::bun_ownership(), BunOwnership::Live)
        {
            return Err(HttpFailure::Unavailable);
        }
        state.bound_generation = Some(generation);
        state.bound_bun_instance_id = Some(parsed.bun_instance_id.clone());
        Ok(Some(parsed))
    }

    /// Fetch the authenticated consume receipt for one Goal run binding from the
    /// live owned child. Returns `Ok(None)` when no receipt exists (not yet
    /// consumed, unknown, or a non-live/unavailable child); the terminal writer
    /// then leaves the run goal-less. The raw response is validated by the
    /// caller against the native registration row.
    fn fetch_goal_receipt(
        &self,
        binding_id: &str,
    ) -> Result<Option<crate::commands::goals::GoalRunReceipt>, HttpFailure> {
        if !matches!(crate::process_lifecycle::bun_ownership(), BunOwnership::Live) {
            return Ok(None);
        }
        let path = format!("/internal/goals/run-bindings/{}/receipt", binding_id);
        match self.get_json(&path, 200) {
            Ok(body) => serde_json::from_str::<crate::commands::goals::GoalRunReceipt>(&body)
                .map(Some)
                .map_err(|_| HttpFailure::Unavailable),
            Err(_) => Ok(None),
        }
    }

    /// Fetch the bounded, transcript-free checkpoint view for one Goal-owned
    /// TaskRun. Returns `Ok(None)` when the run is unknown or the child is
    /// non-live; the caller then exposes no evidence refs rather than a
    /// fabricated facade.
    fn fetch_goal_checkpoint(
        &self,
        session_id: &str,
        goal_id: &str,
        binding_id: &str,
        task_run_id: &str,
    ) -> Result<Option<GoalCheckpointWire>, HttpFailure> {
        if !matches!(crate::process_lifecycle::bun_ownership(), BunOwnership::Live) {
            return Ok(None);
        }
        let path = format!(
            "/internal/goals/checkpoint?session_id={}&goal_id={}&binding_id={}&task_run_id={}",
            urlencode(session_id),
            urlencode(goal_id),
            urlencode(binding_id),
            urlencode(task_run_id),
        );
        match self.get_json(&path, 200) {
            Ok(body) => serde_json::from_str::<GoalCheckpointWire>(&body)
                .map(Some)
                .map_err(|_| HttpFailure::Unavailable),
            Err(_) => Ok(None),
        }
    }

    fn fetch_receipt(
        &self,
        preparation_id: &str,
    ) -> Result<Option<NativeMemoryRuntimeReceipt>, HttpFailure> {
        let path = format!("/internal/memory/turns/{}", preparation_id);
        match self.get_json(&path, 200) {
            Ok(body) => serde_json::from_str::<NativeMemoryRuntimeReceipt>(&body)
                .map(Some)
                .map_err(|_| HttpFailure::Unavailable),
            Err(_) => Ok(None),
        }
    }

    fn ack_receipt(&self, preparation_id: &str, turn_id: &str) -> Result<(), HttpFailure> {
        let path = format!("/internal/memory/turns/{}/ack", preparation_id);
        self.post_json(
            &path,
            &AckRequest {
                turn_id: turn_id.to_string(),
            },
            200,
        )
        .map(|_| ())
    }
}

/// Process-lifetime owned transport. Initialized lazily; the same instance is
/// reused across boot, manual restart and supervisor restarts.
pub fn native_memory_transport() -> &'static NativeMemoryTransport {
    static TRANSPORT: OnceLock<NativeMemoryTransport> = OnceLock::new();
    TRANSPORT.get_or_init(NativeMemoryTransport::new)
}

/// Dispatch one native-approved trusted manifest execution to the live owned
/// Bun child over the private authenticated capability path. Returns `Ok(None)`
/// when no owned child is live (nothing was dispatched); `Err` means the round
/// trip failed after the request may have been dispatched, so the caller must
/// treat the outcome as ambiguous and never replay.
pub fn execute_trusted_manifest(
    transport: &NativeMemoryTransport,
    request: &crate::commands::trusted_execution::TrustedExecutionRequestWire,
) -> Result<Option<crate::commands::trusted_execution::TrustedExecutionResponseWire>, String> {
    // Do NOT hold the shared TransportState mutex across the (potentially
    // minutes-long) HTTP request: that mutex also gates other native transport
    // operations. Capture the generation before the request, revalidate it after,
    // and only then briefly update the bound metadata.
    if !matches!(crate::process_lifecycle::bun_ownership(), BunOwnership::Live) {
        return Ok(None);
    }
    let generation = crate::process_lifecycle::bun_generation();
    let timeout = std::time::Duration::from_millis(
        crate::commands::trusted_execution::WHOLE_RUN_TIMEOUT_MS
            + TRUSTED_EXECUTION_HTTP_MARGIN_MS,
    );
    let body = transport
        .post_json_with_timeout("/internal/trusted/execute", request, 200, timeout)
        .map_err(|_| "trusted execution transport unavailable".to_string())?;
    let parsed: crate::commands::trusted_execution::TrustedExecutionResponseWire =
        serde_json::from_str(&body)
            .map_err(|_| "trusted execution response could not be read".to_string())?;
    if parsed.execution_id != request.execution_id {
        return Err("trusted execution response identity mismatch".to_string());
    }
    if crate::process_lifecycle::bun_generation() != generation
        || !matches!(crate::process_lifecycle::bun_ownership(), BunOwnership::Live)
    {
        return Err("owned Bun child was replaced during trusted execution".to_string());
    }
    {
        let mut state = transport.lock_state();
        state.bound_generation = Some(generation);
        state.bound_bun_instance_id = Some(parsed.bun_instance_id.clone());
    }
    Ok(Some(parsed))
}

/// Dispatch one native-derived trusted acceptance check batch to the live owned
/// Bun child over the same private authenticated capability path. Returns
/// `Ok(None)` when no owned child is live; `Err` means the round trip failed
/// after the request may have been dispatched (the caller must treat the
/// acceptance attempt as ambiguous and never claim success).
pub fn execute_trusted_acceptance(
    transport: &NativeMemoryTransport,
    request: &crate::commands::trusted_acceptance::TrustedAcceptanceRequestWire,
) -> Result<Option<crate::commands::trusted_acceptance::TrustedAcceptanceResponseWire>, String> {
    if !matches!(crate::process_lifecycle::bun_ownership(), BunOwnership::Live) {
        return Ok(None);
    }
    let generation = crate::process_lifecycle::bun_generation();
    let timeout = std::time::Duration::from_millis(
        crate::commands::trusted_execution::WHOLE_RUN_TIMEOUT_MS
            + TRUSTED_EXECUTION_HTTP_MARGIN_MS,
    );
    let body = transport
        .post_json_with_timeout("/internal/trusted/acceptance", request, 200, timeout)
        .map_err(|_| "trusted acceptance transport unavailable".to_string())?;
    let parsed: crate::commands::trusted_acceptance::TrustedAcceptanceResponseWire =
        serde_json::from_str(&body)
            .map_err(|_| "trusted acceptance response could not be read".to_string())?;
    if parsed.acceptance_id != request.acceptance_id {
        return Err("trusted acceptance response identity mismatch".to_string());
    }
    if crate::process_lifecycle::bun_generation() != generation
        || !matches!(crate::process_lifecycle::bun_ownership(), BunOwnership::Live)
    {
        return Err("owned Bun child was replaced during trusted acceptance".to_string());
    }
    {
        let mut state = transport.lock_state();
        state.bound_generation = Some(generation);
        state.bound_bun_instance_id = Some(parsed.bun_instance_id.clone());
    }
    Ok(Some(parsed))
}

/// Request cancellation of one in-flight trusted execution by exact execution
/// id. Returns whether the live owned child reported that it aborted the real
/// AbortSignal for that operation. Writes nothing.
pub fn cancel_trusted_execution(
    transport: &NativeMemoryTransport,
    execution_id: &str,
) -> Result<bool, String> {
    #[derive(Serialize)]
    struct CancelRequest<'a> {
        execution_id: &'a str,
    }
    #[derive(Deserialize)]
    struct CancelResponse {
        cancelled: bool,
    }
    if !matches!(crate::process_lifecycle::bun_ownership(), BunOwnership::Live) {
        return Ok(false);
    }
    let body = transport
        .post_json(
            "/internal/trusted/cancel",
            &CancelRequest { execution_id },
            200,
        )
        .map_err(|_| "trusted cancel transport unavailable".to_string())?;
    let parsed: CancelResponse =
        serde_json::from_str(&body).map_err(|_| "trusted cancel response could not be read".to_string())?;
    Ok(parsed.cancelled)
}

/// Prepare a native turn and register its bounded envelope with the owned Bun
/// process. Holds the shared operation gate across retrieval and registration
/// so a mutation cannot interleave; the AppDb mutex is released across HTTP.
pub fn prepare_memory_turn(
    db: &AppDb,
    transport: &NativeMemoryTransport,
    request: PrepareMemoryTurnRequest,
    now: DateTime<Utc>,
) -> Result<MemoryTurnPreparation, MemoryError> {
    // Hold the operation mutex across drain + snapshot + register so a mutation
    // cannot interleave between pending-cleanup and the new registration. The
    // internal drain does not re-lock; there is no nested gate. A drain failure
    // (live owned child that cannot ACK durable cleanup) fails closed with a
    // typed unavailable error rather than serving stale derived context.
    let mut state = transport.lock_state();
    drain_pending_locked(db, transport, &mut state, now)
        .map_err(|_| map_invalidation_error())?;

    let preparation_id = Uuid::new_v4().to_string();
    let outcome = {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        turn::prepare_memory_turn_record(
            &conn,
            &request,
            &preparation_id,
            transport.app_instance_id(),
            now,
        )?
    };

    let envelope = match outcome {
        PrepareMemoryTurnOutcome::Existing { preparation } => return Ok(preparation),
        PrepareMemoryTurnOutcome::New { envelope } => envelope,
    };

    // Re-read the persisted status: the frozen `New` variant carries no status,
    // and a retrieval failure must never be registered.
    let persisted = {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        turn::read_memory_turn(&conn, &request.session_id, &request.turn_id)?
    };

    if matches!(persisted.recall_status, MemoryRecallStatus::RetrievalFailed)
        || !matches!(persisted.state, turn::MemoryTurnState::Prepared)
    {
        return Ok(MemoryTurnPreparation {
            turn_id: request.turn_id,
            preparation_id: None,
            status: persisted.recall_status,
        });
    }

    // A budget-omitted envelope has no injectable content; do not register an
    // empty carrier that would never be consumed.
    if matches!(persisted.recall_status, MemoryRecallStatus::BudgetOmitted) {
        return Ok(MemoryTurnPreparation {
            turn_id: request.turn_id,
            preparation_id: None,
            status: MemoryRecallStatus::BudgetOmitted,
        });
    }

    match transport.register_envelope(&mut state, &envelope) {
        Ok(result) => {
            let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
            mark_memory_turn_registered(
                &conn,
                &request.session_id,
                &request.turn_id,
                &envelope.preparation_id,
                &result.bun_instance_id,
                now,
            )
        }
        Err(_) => {
            let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
            mark_memory_turn_registration_failed(
                &conn,
                &request.session_id,
                &request.turn_id,
                &envelope.preparation_id,
                "memory_unavailable",
                now,
            )
        }
    }
}

/// Native-validate and register one Goal-to-Session/turn binding with the owned
/// Bun child. The Goal authority in `commands::goals` resolves the current
/// Goal/Agent/canonical-project binding against the exact persisted Session and
/// the exact native saved user source row (id + canonical UTF-8 SHA-256) and
/// mints the stable TaskRun identity. That native binding is persisted only
/// after the owned child confirms it, so the terminal writer has a durable row
/// to verify the Bun consume receipt against. Registration is a bounded
/// one-shot over the same private capability as memory; a non-live/unknown child
/// or a rejected registration yields `registered: false` and the turn proceeds
/// goal-less. Memory availability is never consulted here.
pub fn register_goal_run_binding(
    db: &AppDb,
    transport: &NativeMemoryTransport,
    goal_id: &str,
    session_id: &str,
    turn_id: &str,
    source_message_id: &str,
) -> Result<crate::commands::goals::GoalRunPreparation, MemoryError> {
    let binding = {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        crate::commands::goals::resolve_goal_run_binding(
            &conn,
            goal_id,
            session_id,
            turn_id,
            source_message_id,
        )
        .map_err(MemoryError::storage_unavailable)?
    };
    let wire = GoalRunBindingWire {
        binding_id: binding.binding_id.clone(),
        goal_id: binding.goal_id.clone(),
        session_id: binding.session_id.clone(),
        agent_id: binding.agent_id.clone(),
        project_root: binding.project_root.clone(),
        objective: binding.objective.clone(),
        criteria: binding.criteria.clone(),
        turn_id: binding.turn_id.clone(),
        source_message_id: binding.source_message_id.clone(),
        source_message_hash: binding.source_message_hash.clone(),
        task_run_id: binding.task_run_id.clone(),
        issued_at: binding.issued_at.clone(),
        expires_at: binding.expires_at.clone(),
    };

    let mut state = transport.lock_state();
    let result = transport.register_goal_binding(&mut state, &wire);

    let (registered, bun_instance_id) = match result {
        Ok(Some(parsed)) => (true, Some(parsed.bun_instance_id)),
        _ => (false, None),
    };

    // Persist the native registration record only after the owned child
    // confirmed it. A persistence failure fails closed (no Goal linkage) rather
    // than leaving a registered binding the terminal writer cannot verify.
    if registered {
        if let Some(bun_instance_id) = bun_instance_id.as_deref() {
            let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
            crate::commands::goals::record_goal_run_binding(&conn, &binding, bun_instance_id)
                .map_err(MemoryError::storage_unavailable)?;
        }
    }

    Ok(crate::commands::goals::GoalRunPreparation {
        goal_id: binding.goal_id,
        turn_id: binding.turn_id,
        registered,
        binding_id: if registered {
            Some(binding.binding_id)
        } else {
            None
        },
        task_run_id: if registered {
            Some(binding.task_run_id)
        } else {
            None
        },
        source_message_id: if registered {
            Some(binding.source_message_id)
        } else {
            None
        },
    })
}

/// Verify a Goal-linked terminal run against the native registration row and
/// the owned child's consume receipt, then return the authorized Goal id. A
/// non-live child, missing receipt, or any mismatch fails closed with `None`
/// (the run stays goal-less) rather than fabricating a Goal association. Takes a
/// raw connection so the SSE relay thread (which holds only the DB path) can
/// verify before opening its terminal write.
pub fn resolve_goal_terminal_authority(
    conn: &Connection,
    transport: &NativeMemoryTransport,
    binding_id: &str,
    run_id: &str,
) -> Result<Option<String>, MemoryError> {
    let receipt = transport
        .fetch_goal_receipt(binding_id)
        .map_err(|_| MemoryError::storage_unavailable("Goal run receipt unavailable"))?;
    let Some(receipt) = receipt else {
        return Ok(None);
    };
    match crate::commands::goals::verify_goal_terminal_receipt(conn, binding_id, run_id, &receipt) {
        Ok(goal_id) => Ok(Some(goal_id)),
        Err(_) => Ok(None),
    }
}

/// Minimal percent-encoding for query values (unreserved characters kept).
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

/// Authorized durable read of one Goal-owned TaskRun checkpoint over the private
/// capability. `binding_id`/`task_run_id` come from the native registration row
/// (never from the client). Returns `None` when the child is non-live or the run
/// is unknown; a caller never receives a fabricated/empty evidence facade.
pub fn read_goal_checkpoint(
    transport: &NativeMemoryTransport,
    session_id: &str,
    goal_id: &str,
    binding_id: &str,
    task_run_id: &str,
) -> Option<GoalCheckpointWire> {
    transport
        .fetch_goal_checkpoint(session_id, goal_id, binding_id, task_run_id)
        .ok()
        .flatten()
}

/// A receipt may be acknowledged only after it durably represents a terminal
/// outcome or an authoritative validation-end (no start, no terminal). A
/// started-but-nonterminal receipt may still accumulate model/tool
/// observations and must stay replayable.
fn receipt_can_ack(receipt: &NativeMemoryRuntimeReceipt) -> bool {
    receipt.terminal_status.is_some() || receipt.started_at.is_none()
}

/// Fetch an authenticated receipt for one turn, verify the current app
/// instance and owned generation in addition to the immutable tuple, persist
/// applied/terminal metadata idempotently, then ACK only after durability.
///
/// Missing receipts and generation loss are recorded truthfully:
/// `started` -> `unterminated`/`evidence_unavailable`, never-started
/// `registered` after TTL or generation loss -> `expired`. A turn that was
/// never consumed stays untouched.
pub fn sync_memory_turn(
    db: &AppDb,
    transport: &NativeMemoryTransport,
    request: MemoryTurnIdentityRequest,
    now: DateTime<Utc>,
) -> Result<MemoryTurnDiagnostic, MemoryError> {
    let state = transport.lock_state();

    let persisted = {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        turn::read_memory_turn(&conn, &request.session_id, &request.turn_id)?
    };

    let preparation_id = match persisted.preparation_id.as_deref() {
        Some(id)
            if matches!(
                persisted.state,
                turn::MemoryTurnState::Registered
                    | turn::MemoryTurnState::Started
                    | turn::MemoryTurnState::Terminal
                    | turn::MemoryTurnState::Invalidated
            ) =>
        {
            id.to_string()
        }
        _ => return Ok(turn::memory_turn_diagnostic(&persisted)),
    };

    let current_generation = crate::process_lifecycle::bun_generation();

    let receipt = transport.fetch_receipt(&preparation_id).ok().flatten();

    let generation_lost = match &receipt {
        Some(receipt) => {
            let app_matches = receipt.app_instance_id == transport.app_instance_id();
            let generation_matches = state
                .bound_generation
                .map(|bound| bound == current_generation)
                .unwrap_or(true);
            let bun_matches = state
                .bound_bun_instance_id
                .as_deref()
                .map(|bound| bound == receipt.bun_instance_id)
                .unwrap_or(true);
            !(app_matches && generation_matches && bun_matches)
        }
        None => true,
    };

    if generation_lost {
        // Preserve an already durable terminal; otherwise record truth. A
        // missing/unavailable receipt must not leave a ready/registered turn.
        if matches!(persisted.state, turn::MemoryTurnState::Terminal) {
            return Ok(turn::memory_turn_diagnostic(&persisted));
        }
        // Only an actually-started turn (`started` state or a durable
        // `started_at`) may be recorded as `unterminated`. A never-started
        // preparation — including an `invalidated` unconsumed row — must NOT be
        // promoted to unterminated; it retains its terminal NULL (or expires
        // when it was registered/prepared).
        let was_started = matches!(persisted.state, turn::MemoryTurnState::Started)
            || persisted.started_at.is_some();
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        return if was_started {
            turn::mark_turn_unterminated(&conn, &request.session_id, &request.turn_id)
        } else if matches!(
            persisted.state,
            turn::MemoryTurnState::Registered
                | turn::MemoryTurnState::Prepared
                | turn::MemoryTurnState::Invalidated
        ) {
            turn::mark_turn_expired(&conn, &request.session_id, &request.turn_id)
        } else {
            Ok(turn::memory_turn_diagnostic(&persisted))
        };
    }

    let receipt = receipt.expect("receipt present when generation is stable");
    let diagnostic = {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        turn::apply_memory_turn_receipt(
            &conn,
            &request.session_id,
            &request.turn_id,
            &receipt,
            now,
        )?
    };

    // Only after durable persistence; a started/nonterminal receipt is left in
    // place so a later sync can pick up terminal metadata. A bounded ACK
    // failure stays retryable (the receipt remains) and is observable, and it
    // never changes the caller's terminal inference outcome.
    if receipt_can_ack(&receipt) {
        if transport
            .ack_receipt(&preparation_id, &request.turn_id)
            .is_err()
        {
            eprintln!(
                "[memory] turn receipt ack failed preparation={} turn={} (retryable)",
                preparation_id, request.turn_id
            );
        }
    }
    Ok(diagnostic)
}

/// Conservatively invalidate every unconsumed preparation and mark the native
/// pending rows invalidated. Used by the mutation gate and exposed for
/// diagnostics.
pub fn invalidate_unconsumed_memory_turns(
    db: &AppDb,
    transport: &NativeMemoryTransport,
    reason: &str,
    now: DateTime<Utc>,
) -> Result<(), MemoryError> {
    let mut state = transport.lock_state();
    transport
        .invalidate_registry(&mut state, reason, None)
        .map_err(|_| {
            MemoryError::invalidation_unavailable("Memory registry did not acknowledge invalidation")
        })?;
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    turn::mark_pending_turns_invalidated(&conn, now)?;
    Ok(())
}

/// Frozen Phase 2 mutation gate. Retains its original signature for
/// non-semantic compatibility uses: it invalidates unconsumed preparations and
/// marks native pending rows invalidated before running the mutation, but it
/// carries no derived payload. Semantic knowledge/scope mutators must NOT use
/// this as a `derived:None` bypass; they must provide affected ids through
/// [`run_derived_mutation_gate`].
pub fn with_memory_mutation_gate<T>(
    db: &AppDb,
    transport: &NativeMemoryTransport,
    reason: &str,
    now: DateTime<Utc>,
    mutation: impl FnOnce(&Connection) -> Result<T, MemoryError>,
) -> Result<T, MemoryError> {
    let mut state = transport.lock_state();
    transport
        .invalidate_registry(&mut state, reason, None)
        .map_err(|_| map_invalidation_error())?;
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    turn::mark_pending_turns_invalidated(&conn, now)?;
    mutation(&conn)
}

/// Shared private coordinator for the derived-state mutation gate. `state` is
/// the already-acquired operation mutex; no wrapper may re-acquire it.
///
/// Lock order: operation mutex -> single authenticated `/invalidate` ACK (both
/// the unconsumed-preparation invalidation and the derived cleanup; all
/// network, no AppDb mutex) -> AppDb mutex -> pending rows invalidated ->
/// atomic outbox + mutation.
///
/// When a live owned child ACKed the derived cleanup, the outbox acknowledgement
/// is written INSIDE the mutation savepoint so an acknowledgement failure rolls
/// back the memory/suppression/ledger/receipt writes too. When no live child
/// ACKed (confirmed exited/replaced generation), the mutation commits and the
/// outbox row stays pending: the next live drain must succeed before any
/// preparation/history read. An unknown ownership state fails closed.
fn finish_plan_locked<T>(
    db: &AppDb,
    transport: &NativeMemoryTransport,
    state: &mut TransportState,
    originating_session_id: &str,
    plan: NativeDerivedMutationPlan,
    now: DateTime<Utc>,
    mutation: impl FnOnce(&Connection, &NativeDerivedMutationPlan) -> Result<T, MemoryError>,
) -> Result<T, MemoryError> {
    // An empty affected-Session set is legitimate (for example an Agent or
    // legacy mutation with no consumer Sessions). There is nothing to evict in
    // Bun derived state, so no derived cleanup payload is sent and no outbox row
    // is persisted (never a fictitious Session). The authenticated registry
    // round trip still invalidates unconsumed preparations.
    let has_consumers = !plan.invalidation.affected_session_ids.is_empty();
    let wire_key = wire_operation_id(originating_session_id, &plan.invalidation.operation_id);
    let acked = if has_consumers {
        transport
            .invalidate_registry(
                state,
                "memory_derived_mutation",
                Some((wire_key.as_str(), &plan.invalidation)),
            )
            .map_err(|_| map_invalidation_error())?
    } else {
        transport
            .invalidate_registry(state, "memory_derived_mutation", None)
            .map_err(|_| map_invalidation_error())?
    };

    // Network is complete; now acquire the AppDb mutex and run the mutation.
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    turn::mark_pending_turns_invalidated(&conn, now)?;

    let operation_id = plan.invalidation.operation_id.clone();
    scoped::with_memory_savepoint(&conn, |conn| {
        if has_consumers {
            record_outbox_row(conn, originating_session_id, &plan, now)?;
        }
        continuity::sanitize_legacy_session_summary(
            conn,
            &plan.invalidation.affected_session_ids,
            now,
        )?;
        let result = mutation(conn, &plan)?;
        // A live ACK means cleanup is durable: acknowledge the outbox row in the
        // same savepoint as the mutation so a failure rolls back both.
        if has_consumers && acked {
            acknowledge_outbox_row(conn, originating_session_id, &operation_id, now)?;
        }
        Ok(result)
    })
}

/// One operation-gate-scoped derived mutation. Takes the operation mutex once,
/// resolves/revalidates the full native metadata (including the internal scope)
/// under a brief AppDb snapshot, and either returns an exact canonical replay
/// (no HTTP, no invalidation) or ACKs cleanup and runs the mutation. `resolve`
/// and `mutation` both run while the operation mutex is held, so no other
/// Session can interleave a consume or mutation.
fn plan_derived_mutation<T, P, F>(
    db: &AppDb,
    transport: &NativeMemoryTransport,
    initiating_session_id: &str,
    now: DateTime<Utc>,
    resolve: P,
    mutation: F,
) -> Result<T, MemoryError>
where
    P: FnOnce(&Connection) -> Result<DerivedGatePlan<T>, MemoryError>,
    F: FnOnce(&Connection, &NativeDerivedMutationPlan) -> Result<T, MemoryError>,
{
    let mut state = transport.lock_state();
    let outcome = {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        resolve(&conn)?
    };
    match outcome {
        DerivedGatePlan::Replay(result) => Ok(result),
        DerivedGatePlan::Invalidate(plan) => {
            let originating_session_id = if initiating_session_id.is_empty() {
                plan.invalidation
                    .affected_session_ids
                    .first()
                    .cloned()
                    .unwrap_or_default()
            } else {
                initiating_session_id.to_string()
            };
            finish_plan_locked(
                db,
                transport,
                &mut state,
                &originating_session_id,
                plan,
                now,
                mutation,
            )
        }
    }
}

/// Build the capability-namespaced wire operation id from the original
/// initiating Session and the native (untrusted) operation id. The operation id
/// is ALWAYS namespaced exactly once: a public manual/caller operation id must
/// never control the namespace (a value beginning with `session/` must not
/// bypass the prefix and collide with another Session). The SAME deterministic
/// key is rebuilt for the initial cleanup and every later drain, so repeated
/// sends are idempotent. An empty initiating Session uses the explicit
/// `global` audit namespace; production callers that reach the outbox always
/// carry a real consumer Session.
fn wire_operation_id(session_id: &str, operation_id: &str) -> String {
    let namespace = if session_id.is_empty() { "global" } else { session_id };
    format!("session/{}/operation/{}", namespace, operation_id)
}

fn map_invalidation_error() -> MemoryError {
    MemoryError::invalidation_unavailable("Memory registry did not acknowledge invalidation")
}

/// Persist one outbox row keyed on the ORIGINAL initiating Session. The table
/// has no Session FK so the row survives that Session's deletion.
fn record_outbox_row(
    conn: &Connection,
    originating_session_id: &str,
    plan: &NativeDerivedMutationPlan,
    now: DateTime<Utc>,
) -> Result<(), MemoryError> {
    continuity::record_memory_derived_invalidation(
        conn,
        originating_session_id,
        &plan.invalidation,
        plan.scope.as_ref(),
        now,
    )
}

/// Acknowledge the outbox row under the original initiating Session only after
/// a confirmed live ACK. Written inside the mutation savepoint so a failure
/// rolls back the mutation too.
fn acknowledge_outbox_row(
    conn: &Connection,
    originating_session_id: &str,
    operation_id: &str,
    now: DateTime<Utc>,
) -> Result<(), MemoryError> {
    continuity::acknowledge_memory_derived_invalidation(
        conn,
        originating_session_id,
        operation_id,
        now,
    )
}

/// The Phase 3.2 derived-state mutation gate. The supplied four-field
/// `MemoryDerivedInvalidation` is the frozen public contract; the resolved
/// scope is inferred internally under the operation gate. The initiating
/// Session is the first affected Session and namespaces the wire key.
pub fn with_memory_derived_mutation_gate<T>(
    db: &AppDb,
    transport: &NativeMemoryTransport,
    invalidation: &MemoryDerivedInvalidation,
    now: DateTime<Utc>,
    mutation: impl FnOnce(&Connection) -> Result<T, MemoryError>,
) -> Result<T, MemoryError> {
    plan_derived_mutation(
        db,
        transport,
        invalidation
            .affected_session_ids
            .first()
            .map(String::as_str)
            .unwrap_or(""),
        now,
        |_conn| {
            Ok(DerivedGatePlan::Invalidate(
                NativeDerivedMutationPlan::from_invalidation(invalidation.clone()),
            ))
        },
        move |conn, _plan| mutation(conn),
    )
}

/// One operation-gate-scoped derived mutation. Takes the operation mutex once,
/// resolves/revalidates the full native metadata (including the internal scope)
/// under a brief AppDb snapshot, releases the AppDb lock for HTTP, then runs the
/// mutation under the savepoint. `resolve` and `mutation` both run while the
/// operation mutex is held, so no other Session can interleave a consume or
/// mutation.
///
/// `mutation` receives the internal plan so it can re-validate its target
/// against the exact scope that was cleaned and reject a scope/rebind race.
pub fn run_derived_mutation_gate<T>(
    db: &AppDb,
    transport: &NativeMemoryTransport,
    initiating_session_id: &str,
    resolve: impl FnOnce(&Connection) -> Result<NativeDerivedMutationPlan, MemoryError>,
    mutation: impl FnOnce(&Connection, &NativeDerivedMutationPlan) -> Result<T, MemoryError>,
) -> Result<T, MemoryError> {
    plan_derived_mutation(
        db,
        transport,
        initiating_session_id,
        Utc::now(),
        move |conn| resolve(conn).map(DerivedGatePlan::Invalidate),
        mutation,
    )
}

/// Like [`run_derived_mutation_gate`] but the resolver may return an exact
/// canonical replay result. On a replay the gate performs NO HTTP cleanup and
/// NO invalidation and returns the persisted result directly (an exact retry
/// must not re-invalidate). Otherwise it behaves as the derived gate, and the
/// mutation rechecks the operation identity inside the savepoint to close races.
pub fn run_derived_mutation_gate_with_replay<T>(
    db: &AppDb,
    transport: &NativeMemoryTransport,
    initiating_session_id: &str,
    resolve: impl FnOnce(&Connection) -> Result<DerivedGatePlan<T>, MemoryError>,
    mutation: impl FnOnce(&Connection, &NativeDerivedMutationPlan) -> Result<T, MemoryError>,
) -> Result<T, MemoryError> {
    plan_derived_mutation(
        db,
        transport,
        initiating_session_id,
        Utc::now(),
        resolve,
        mutation,
    )
}

/// Outcome of a manual-operation resolver that may short-circuit on replay.
pub enum DerivedGatePlan<T> {
    Replay(T),
    Invalidate(NativeDerivedMutationPlan),
}

/// Internal non-locking drain used by callers that already hold the operation
/// mutex (preparation/history reads). Sends each pending cleanup using the
/// stored original initiating Session to rebuild the exact wire key, then
/// persists the acknowledgement under a brief AppDb lock. A no-live-child send
/// returns `false`; the row stays pending.
fn drain_pending_locked(
    db: &AppDb,
    transport: &NativeMemoryTransport,
    state: &mut TransportState,
    now: DateTime<Utc>,
) -> Result<(), MemoryError> {
    let pending = {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        continuity::pending_memory_derived_invalidations(&conn)?
    };
    for row in pending {
        // The stored session_id is the ORIGINAL initiating Session; the wire
        // key is rebuilt identically every drain so retries are idempotent.
        let originating_session_id = row.session_id.clone();
        let wire_key = wire_operation_id(&originating_session_id, &row.invalidation.operation_id);
        let acked = transport
            .invalidate_registry(
                state,
                "memory_derived_drain",
                Some((wire_key.as_str(), &row.invalidation)),
            )
            .map_err(|_| {
                MemoryError::invalidation_unavailable(
                    "Memory derived state did not acknowledge pending cleanup",
                )
            })?;
        if acked {
            let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
            acknowledge_outbox_row(
                &conn,
                &originating_session_id,
                &row.invalidation.operation_id,
                now,
            )?;
        }
    }
    Ok(())
}

/// Drain pending derived-invalidation outbox rows before serving a new
/// preparation or history read. Holds the operation mutex once. A cleanup
/// failure (or a live child that cannot ACK) yields typed failure instead of
/// serving stale derived context; a confirmed-exited/replaced generation leaves
/// the row pending.
pub fn drain_memory_derived_invalidations(
    db: &AppDb,
    transport: &NativeMemoryTransport,
    now: DateTime<Utc>,
) -> Result<(), MemoryError> {
    let mut state = transport.lock_state();
    drain_pending_locked(db, transport, &mut state, now)
}

/// Read suppression-aware model history while holding the operation mutex
/// across pending-cleanup drain and the history snapshot.
pub fn read_memory_turn_history(
    db: &AppDb,
    transport: &NativeMemoryTransport,
    session_id: &str,
    before_message_id: &str,
    now: DateTime<Utc>,
) -> Result<Vec<turn::PromptHistoryMessage>, MemoryError> {
    let mut state = transport.lock_state();
    drain_pending_locked(db, transport, &mut state, now)?;
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    turn::history_for_memory_turn(&conn, session_id, before_message_id)
}

/// A model-facing, suppression-aware transcript snapshot taken under the
/// operation gate, together with the revisions needed to detect a memory
/// mutation that commits during a subsequent model call. Callers must re-read
/// the same revisions before publishing derived output and must refuse to
/// publish when either changed. `session_binding_revision` additionally covers
/// a pure Session workspace rebind (which can change the effective memory scope
/// without touching the global store revision); suppression generation is
/// already included in `store_revision` via the `memory_prompt_suppressions`
/// triggers.
pub struct MemoryContextSnapshot {
    pub messages: Vec<turn::PromptHistoryMessage>,
    pub store_revision: i64,
    pub continuity_revision: i64,
    pub session_binding_revision: i64,
}

/// Take a sanitized Session transcript snapshot under the operation gate:
/// drain pending derived cleanup, then read the suppression-aware transcript so
/// the model never sees a forgotten/corrected source. The AppDb lock is held
/// only for the snapshot; the caller runs its model call after this returns.
pub fn snapshot_sanitized_session_messages(
    db: &AppDb,
    transport: &NativeMemoryTransport,
    session_id: &str,
    now: DateTime<Utc>,
) -> Result<MemoryContextSnapshot, MemoryError> {
    let mut state = transport.lock_state();
    drain_pending_locked(db, transport, &mut state, now)?;
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let messages = turn::sanitized_session_messages(&conn, session_id)?;
    let store_revision = scoped::memory_store_revision(&conn)?;
    let continuity_revision = continuity::read_session_continuity(&conn, session_id)?.revision;
    let session_binding_revision = continuity::session_binding_revision(&conn, session_id)?;
    Ok(MemoryContextSnapshot {
        messages,
        store_revision,
        continuity_revision,
        session_binding_revision,
    })
}

/// Re-read the revision triple a [`MemoryContextSnapshot`] captured. A change
/// means a memory mutation — or a Session workspace rebind — committed during
/// the model call, so derived output built from the earlier snapshot must not be
/// published.
pub fn memory_context_revisions(
    db: &AppDb,
    session_id: &str,
) -> Result<(i64, i64, i64), MemoryError> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let store_revision = scoped::memory_store_revision(&conn)?;
    let continuity_revision = continuity::read_session_continuity(&conn, session_id)?.revision;
    let session_binding_revision = continuity::session_binding_revision(&conn, session_id)?;
    Ok((store_revision, continuity_revision, session_binding_revision))
}

/// Build the capability/instance environment for an owned spawn. Never logs
/// either value.
pub fn owned_memory_env() -> (&'static str, String, &'static str, String) {
    let transport = native_memory_transport();
    (
        CAPABILITY_ENV,
        transport.capability().to_string(),
        APP_INSTANCE_ENV,
        transport.app_instance_id().to_string(),
    )
}

/// Startup recovery. After a native restart no Bun registry survives, so any
/// pending preparation is stale and any started-but-unsynced turn is
/// unterminated. Durable opaque IDs are retained; public references stay null.
pub fn recover_pending_memory_turns(db: &AppDb, now: DateTime<Utc>) -> Result<usize, MemoryError> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    turn::recover_pending_memory_turns(&conn, now)
}
