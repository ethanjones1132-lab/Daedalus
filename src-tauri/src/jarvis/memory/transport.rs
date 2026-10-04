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

use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::contracts::MemoryError;
use super::turn::{
    self, mark_memory_turn_registered, mark_memory_turn_registration_failed,
    MemoryRecallStatus, MemoryTurnDiagnostic, MemoryTurnIdentityRequest, MemoryTurnPreparation,
    NativeMemoryRuntimeReceipt, PrepareMemoryTurnOutcome, PrepareMemoryTurnRequest,
    PreparedMemoryTurn,
};
use crate::db::AppDb;

/// Capability env var names. Exactly these spellings, only on the owned child.
pub const CAPABILITY_ENV: &str = "JARVIS_NATIVE_MEMORY_CAPABILITY";
pub const APP_INSTANCE_ENV: &str = "JARVIS_NATIVE_APP_INSTANCE_ID";

const CONNECT_TIMEOUT_MS: u64 = 1_000;
const REQUEST_TIMEOUT_SECS: u64 = 3;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

/// Registration response from the owned Bun registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistrationResult {
    pub preparation_id: String,
    pub bun_instance_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InvalidationRequest {
    app_instance_id: String,
    reason: String,
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
    generation: u64,
    current_bun_instance_id: Option<String>,
}

pub struct NativeMemoryTransport {
    capability: String,
    app_instance_id: String,
    client: OnceLock<reqwest::blocking::Client>,
    state: Mutex<TransportState>,
}

#[derive(Debug)]
enum HttpFailure {
    /// No owned capability server responded (401/503/network/other).
    Unavailable,
}

impl NativeMemoryTransport {
    fn new() -> Self {
        // Two concatenated UUID v4 values, no separators: an unguessable
        // app-lifetime secret. Never persisted, never exposed to the UI.
        let capability = format!(
            "{}{}",
            Uuid::new_v4().simple(),
            Uuid::new_v4().simple()
        );
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

    fn client(&self) -> &reqwest::blocking::Client {
        self.client.get_or_init(|| {
            reqwest::blocking::Client::builder()
                .connect_timeout(std::time::Duration::from_millis(CONNECT_TIMEOUT_MS))
                .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
                .build()
                .unwrap_or_else(|_| reqwest::blocking::Client::new())
        })
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, TransportState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Called by the owned spawn path after a successful spawn. A new tracked
    /// child is a new generation: any prior `bun_instance_id` no longer
    /// describes a live registry.
    pub fn note_owned_spawn(&self) {
        let mut state = self.lock_state();
        state.generation = state.generation.wrapping_add(1);
        state.current_bun_instance_id = None;
    }

    /// Clear the owned generation when the tracked child is stopped. The
    /// reloaded registry is empty, so no pending envelope can survive.
    pub fn note_owned_stop(&self) {
        let mut state = self.lock_state();
        state.generation = state.generation.wrapping_add(1);
        state.current_bun_instance_id = None;
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
            .client()
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

    fn get_json(&self, path: &str, expected_status: u16) -> Result<String, HttpFailure> {
        let url = format!("{}{}", Self::base_url(), path);
        let response = self
            .client()
            .get(url)
            .bearer_auth(&self.capability)
            .send()
            .map_err(|_| HttpFailure::Unavailable)?;
        if response.status().as_u16() != expected_status {
            return Err(HttpFailure::Unavailable);
        }
        Self::read_bounded(response)
    }

    fn read_bounded(response: reqwest::blocking::Response) -> Result<String, HttpFailure> {
        let bytes = response.bytes().map_err(|_| HttpFailure::Unavailable)?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(HttpFailure::Unavailable);
        }
        String::from_utf8(bytes.to_vec()).map_err(|_| HttpFailure::Unavailable)
    }

    /// Register one prepared envelope with the live owned registry. On success
    /// the response is the only evidence that the current owned child accepted
    /// the turn; the `bun_instance_id` is recorded for this generation.
    fn register_envelope(
        &self,
        state: &mut TransportState,
        envelope: &PreparedMemoryTurn,
    ) -> Result<RegistrationResult, HttpFailure> {
        let generation = state.generation;
        let body = self.post_json("/internal/memory/preparations", envelope, 200)?;
        let parsed: RegistrationResult =
            serde_json::from_str(&body).map_err(|_| HttpFailure::Unavailable)?;
        if parsed.preparation_id != envelope.preparation_id {
            return Err(HttpFailure::Unavailable);
        }
        // Only bind the generation if the owned child did not change while the
        // request was in flight.
        if state.generation == generation {
            state.current_bun_instance_id = Some(parsed.bun_instance_id.clone());
        }
        Ok(parsed)
    }

    /// Ask the live owned registry to drop every unconsumed envelope. Returns
    /// `Ok(())` when the registry acknowledged, when there is no registered
    /// envelope in the current generation, or when the tracked child is
    /// confirmed gone/replaced. A live owned child that cannot acknowledge is
    /// `Unavailable` and must block the mutation.
    fn invalidate_registry(
        &self,
        state: &TransportState,
        reason: &str,
    ) -> Result<(), HttpFailure> {
        if !crate::process_lifecycle::bun_server_is_alive() {
            // Confirmed exited/replaced: the old registry is gone.
            return Ok(());
        }
        if state.current_bun_instance_id.is_none() {
            // No successful registration exists for this generation, so no
            // unconsumed envelope can be live in the owned child.
            return Ok(());
        }
        let request = InvalidationRequest {
            app_instance_id: self.app_instance_id.clone(),
            reason: reason.to_string(),
        };
        self.post_json("/internal/memory/invalidate", &request, 200)
            .map(|_| ())
    }

    fn fetch_receipt(&self, preparation_id: &str) -> Result<Option<NativeMemoryRuntimeReceipt>, HttpFailure> {
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
        self.post_json(&path, &AckRequest { turn_id: turn_id.to_string() }, 200)
            .map(|_| ())
    }
}

/// Process-lifetime owned transport. Initialized lazily; the same instance is
/// reused across boot, manual restart and supervisor restarts.
pub fn native_memory_transport() -> &'static NativeMemoryTransport {
    static TRANSPORT: OnceLock<NativeMemoryTransport> = OnceLock::new();
    TRANSPORT.get_or_init(NativeMemoryTransport::new)
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
    let mut state = transport.lock_state();

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

    if matches!(
        persisted.recall_status,
        MemoryRecallStatus::RetrievalFailed
    ) || !matches!(persisted.state, turn::MemoryTurnState::Prepared)
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

/// Fetch an authenticated receipt for one turn, validate the exact immutable
/// tuple against the durable row, persist applied/terminal metadata
/// idempotently, then ACK the registry entry. ACK happens only after native
/// persistence succeeds.
pub fn sync_memory_turn(
    db: &AppDb,
    transport: &NativeMemoryTransport,
    request: MemoryTurnIdentityRequest,
    now: DateTime<Utc>,
) -> Result<MemoryTurnDiagnostic, MemoryError> {
    let _state = transport.lock_state();

    let persisted = {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        turn::read_memory_turn(&conn, &request.session_id, &request.turn_id)?
    };

    let preparation_id = match persisted.preparation_id.as_deref() {
        Some(id) if matches!(persisted.state, turn::MemoryTurnState::Registered | turn::MemoryTurnState::Started | turn::MemoryTurnState::Terminal) => {
            id.to_string()
        }
        _ => return Ok(turn::memory_turn_diagnostic(&persisted)),
    };

    let receipt = match transport.fetch_receipt(&preparation_id) {
        Ok(Some(receipt)) => receipt,
        // No authenticated receipt: leave the durable row untouched and report
        // its current diagnostic; never invent success.
        Ok(None) | Err(_) => return Ok(turn::memory_turn_diagnostic(&persisted)),
    };

    let diagnostic = {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        turn::apply_memory_turn_receipt(&conn, &request.session_id, &request.turn_id, &receipt, now)?
    };

    // Only after native persistence: drop the ephemeral Bun receipt. A failed
    // ACK is retryable and leaves the receipt in place.
    let _ = transport.ack_receipt(&preparation_id, &request.turn_id);
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
    let state = transport.lock_state();
    transport
        .invalidate_registry(&state, reason)
        .map_err(|_| MemoryError::invalidation_unavailable("Memory registry did not acknowledge invalidation"))?;
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    turn::mark_pending_turns_invalidated(&conn, now)?;
    Ok(())
}

/// The single native operation gate for every semantic memory/Session-binding
/// mutation. Lock order: operation gate -> HTTP invalidate (no AppDb mutex) ->
/// AppDb mutex -> mutation callback. A live owned registry that cannot
/// acknowledge blocks the callback; a confirmed exited/replaced generation
/// permits the mutation.
pub fn with_memory_mutation_gate<T>(
    db: &AppDb,
    transport: &NativeMemoryTransport,
    reason: &str,
    now: DateTime<Utc>,
    mutation: impl FnOnce(&Connection) -> Result<T, MemoryError>,
) -> Result<T, MemoryError> {
    let state = transport.lock_state();

    transport
        .invalidate_registry(&state, reason)
        .map_err(|_| {
            MemoryError::invalidation_unavailable(
                "Memory registry did not acknowledge invalidation",
            )
        })?;

    // Network is complete; now acquire the AppDb mutex and run the mutation.
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    turn::mark_pending_turns_invalidated(&conn, now)?;
    mutation(&conn)
}

/// Build the capability/instance environment for an owned spawn and stage the
/// WSLENV forwarding flags. Never logs either value.
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
