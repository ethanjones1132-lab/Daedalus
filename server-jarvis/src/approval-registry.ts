// ── Tool Approval Registry ──────────────────────────────────────────────────
// Tracks in-flight tool-approval requests by call id so the streaming tool loop
// can pause on an "ask" policy decision and resume once the UI POSTs a decision
// back to `/tool/decision`. Pending requests auto-deny after a timeout so a
// disconnected client can never wedge a stream forever.

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface PendingApproval {
      resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ApprovalRegistry {
  /**
   * Register a pending approval for `callId`. Returns a promise that resolves
   * to the user's decision (true = approve, false = reject). Auto-resolves to
   * `false` if no decision arrives within `timeoutMs`.
   */
      request(callId: string, timeoutMs?: number): Promise<boolean>;
  /**
   * Resolve a pending approval. Returns `true` if a matching pending request
   * existed (and was resolved), `false` otherwise.
   */
  resolve(callId: string, approved: boolean): boolean;
  /** Count of currently-pending approvals. */
  pending(): number;
}

    export function createApprovalRegistry(): ApprovalRegistry {
  const pending = new Map<string, PendingApproval>();

  function settle(callId: string, approved: boolean): boolean {
    const entry = pending.get(callId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pending.delete(callId);
    entry.resolve(approved);
    return true;
      }

  return {
    request(callId: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(callId, false), timeoutMs);
        pending.set(callId, { resolve, timer });
      });
    },
    resolve(callId: string, approved: boolean): boolean {
          return settle(callId, approved);
    },
    pending(): number {
      return pending.size;
    },
  };
}
