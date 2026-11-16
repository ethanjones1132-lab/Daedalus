// ── Tool Approval Registry ──────────────────────────────────────────────────
// Tracks in-flight tool-approval requests by call id so the streaming tool loop
// can pause on an "ask" policy decision and resume once the UI POSTs a decision
// back to `/tool/decision`. Pending requests auto-deny after a timeout so a
// disconnected client can never wedge a stream forever.
//
// Every request now writes a durable audit record (request_id, tool name,
// argument hash, expiry, policy source, resolution) so decisions can be reviewed
// and replayed across Bun restarts.

import { ApprovalStore, type ApprovalRecord } from "./approval-store";
import { registerAbortHandler } from "./stream-control";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface ApprovalRequestDetails {
  call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  policy_source: string;
  session_id?: string;
  surface?: string;
  signal?: AbortSignal;
}

interface PendingApproval {
  /** Durable audit row this pending entry settles. */
  audit_id: string;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

export interface ApprovalRegistryOptions {
  /** In-memory SQLite path for tests; defaults to CONFIG_DIR/server-state.db */
  dbPath?: string;
  defaultTimeoutMs?: number;
}

export interface ApprovalRegistry {
  /**
   * Register a pending approval for `details.call_id`. Returns a promise that
   * resolves to the user's decision (true = approve, false = reject).
   * Auto-resolves to `false` if no decision arrives within `timeoutMs`.
   */
  request(details: ApprovalRequestDetails, timeoutMs?: number): Promise<boolean>;
  /**
   * Resolve a pending approval. Returns `true` if a matching pending request
   * existed (and was resolved), `false` otherwise.
   */
  resolve(callId: string, approved: boolean): boolean;
  /** Count of currently-pending approvals. */
  pending(): number;
  /** Retrieve the most recent durable audit record for a call id. */
  getRecord(callId: string): ApprovalRecord | undefined;
}

export function createApprovalRegistry(opts: ApprovalRegistryOptions = {}): ApprovalRegistry {
  const store = new ApprovalStore({ dbPath: opts.dbPath });
  const pending = new Map<string, PendingApproval>();
  // Durable audit key currently associated with each call id. Call ids are
  // only unique within one stream turn; a later turn that legitimately reuses
  // (or replays) a call id gets a fresh audit row (`<call_id>#<n>`) instead of
  // colliding with the previous turn's row on the PRIMARY KEY. `resolve` and
  // `getRecord` address the row through this map, so callers keep using plain
  // call ids.
  const auditIds = new Map<string, string>();
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** Choose the durable row id for a new request, namespacing reused ids. */
  function auditKeyFor(callId: string): string {
    if (!store.get(callId)) return callId;
    let generation = 1;
    while (store.get(`${callId}#${generation}`)) generation += 1;
    return `${callId}#${generation}`;
  }

  function settle(callId: string, approved: boolean): boolean {
    const entry = pending.get(callId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    entry.cleanup();
    pending.delete(callId);
    entry.resolve(approved);
    return true;
  }

  function expiresAt(timeoutMs: number): string {
    return new Date(Date.now() + timeoutMs).toISOString();
  }

  return {
    request(details: ApprovalRequestDetails, timeoutMs: number = defaultTimeoutMs): Promise<boolean> {
      if (pending.has(details.call_id)) {
        // Re-requesting a still-pending call id is not expected. Keep it a
        // rejection rather than swallowing it: `execute()` owns the error
        // envelope that tells the model approval was unavailable.
        return Promise.reject(new Error(`Approval already pending for ${details.call_id}`));
      }
      // Storage failures (including a PRIMARY KEY conflict) also propagate as
      // throws; `execute()` converts them into an `approval_unavailable`
      // ToolResult so the turn continues instead of aborting.
      const auditId = auditKeyFor(details.call_id);
      store.create({
        request_id: auditId,
        tool_name: details.tool_name,
        arguments: details.arguments,
        policy_source: details.policy_source,
        session_id: details.session_id,
        surface: details.surface,
        expires_at: expiresAt(timeoutMs),
      });
      auditIds.set(details.call_id, auditId);
      if (details.signal?.aborted) {
        store.resolve(auditId, "expired");
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          store.resolve(auditId, "expired");
          settle(details.call_id, false);
        }, timeoutMs);
        const cleanupSignal = details.signal
          ? registerAbortHandler(details.signal, () => {
            store.resolve(auditId, "expired");
            settle(details.call_id, false);
          })
          : () => {};
        pending.set(details.call_id, { audit_id: auditId, resolve, timer, cleanup: cleanupSignal });
      });
    },
    resolve(callId: string, approved: boolean): boolean {
      const found = pending.has(callId);
      const resolution = approved ? "approved" : "rejected";
      // Always update the durable record, even if the pending entry was already
      // cleared by timeout, so the audit trail reflects the operator's intent.
      store.resolve(pending.get(callId)?.audit_id ?? auditIds.get(callId) ?? callId, resolution);
      return settle(callId, approved) || found;
    },
    pending(): number {
      return pending.size;
    },
    getRecord(callId: string): ApprovalRecord | undefined {
      return store.get(pending.get(callId)?.audit_id ?? auditIds.get(callId) ?? callId);
    },
  };
}
