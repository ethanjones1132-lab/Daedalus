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

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface ApprovalRequestDetails {
  call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  policy_source: string;
  session_id?: string;
  surface?: string;
}

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
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
  /** Retrieve the durable audit record for a request id. */
  getRecord(callId: string): ApprovalRecord | undefined;
}

export function createApprovalRegistry(opts: ApprovalRegistryOptions = {}): ApprovalRegistry {
  const store = new ApprovalStore({ dbPath: opts.dbPath });
  const pending = new Map<string, PendingApproval>();
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  function settle(callId: string, approved: boolean): boolean {
    const entry = pending.get(callId);
    if (!entry) return false;
    clearTimeout(entry.timer);
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
        // Re-requesting the same call id is not expected; surface it clearly.
        return Promise.reject(new Error(`Approval already pending for ${details.call_id}`));
      }
      store.create({
        request_id: details.call_id,
        tool_name: details.tool_name,
        arguments: details.arguments,
        policy_source: details.policy_source,
        session_id: details.session_id,
        surface: details.surface,
        expires_at: expiresAt(timeoutMs),
      });
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          store.resolve(details.call_id, "expired");
          settle(details.call_id, false);
        }, timeoutMs);
        pending.set(details.call_id, { resolve, timer });
      });
    },
    resolve(callId: string, approved: boolean): boolean {
      const found = pending.has(callId);
      const resolution = approved ? "approved" : "rejected";
      // Always update the durable record, even if the pending entry was already
      // cleared by timeout, so the audit trail reflects the operator's intent.
      store.resolve(callId, resolution);
      return settle(callId, approved) || found;
    },
    pending(): number {
      return pending.size;
    },
    getRecord(callId: string): ApprovalRecord | undefined {
      return store.get(callId);
    },
  };
}
