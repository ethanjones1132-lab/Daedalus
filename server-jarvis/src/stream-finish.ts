// Stream finish-reason tracker (Phase 0 / T0.1)
//
// Providers emit `finish_reason` on the final SSE choice (stop | length |
// tool_calls | …). Historically we parsed that field into the SSE type but
// never read it — a provider closing the stream early resolved as a clean
// success, so truncated answers were labeled `outcome:"success"` and
// reinforced by the self-tuner.
//
// This module records the last observed finish_reason and settles it into a
// durable stop_reason for telemetry. Server-side cancel paths (deadline,
// watchdog, user cancel) are layered on top by the read-loop caller.

export type StreamFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "function_call"
  | string;

export type StreamStopReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "function_call"
  | "provider_cut"
  | "turn_deadline"
  | "stage_deadline"
  | "watchdog"
  | "cancelled"
  | "degenerate_stream"
  | "unknown";

export interface StreamFinishSettle {
  /** Last provider finish_reason observed on a choice, or null if never seen. */
  finish_reason: string | null;
  /** True when the stream ended without a clean completion. */
  truncated: boolean;
  /** Normalized stop reason for telemetry / reward mapping. */
  stop_reason: StreamStopReason;
}

export interface StreamFinishServerCancel {
  kind: "turn_deadline" | "stage_deadline" | "watchdog" | "cancelled" | "degenerate_stream";
}

export interface StreamFinishTracker {
  /** Record finish_reason from a parsed SSE choice (if present). */
  observe(choice: { finish_reason?: string | null } | null | undefined): void;
  /**
   * Settle the stream terminal. Pass serverCancel when the read loop aborted
   * for a server-side reason (deadline / watchdog / user cancel).
   *
   * When the stream ended cleanly (`done`) with no finish_reason and no
   * server cancel, settle as `provider_cut` + truncated (provider closed the
   * stream without declaring why). Missing finish_reason is only treated as
   * truncated when `treatMissingAsTruncated` is true (surfaceAsAnswer stages
   * initially — some providers omit it on non-answer stages).
   */
  settle(options?: {
    serverCancel?: StreamFinishServerCancel | null;
    treatMissingAsTruncated?: boolean;
  }): StreamFinishSettle;
  /** Last observed finish_reason (null if never seen). */
  lastFinishReason(): string | null;
}

const KNOWN_CLEAN: ReadonlySet<string> = new Set(["stop", "tool_calls", "function_call"]);
const KNOWN_TRUNCATED: ReadonlySet<string> = new Set(["length", "content_filter"]);

function mapFinishToStop(finish: string | null): StreamStopReason {
  if (finish === null) return "unknown";
  if (finish === "stop") return "stop";
  if (finish === "length") return "length";
  if (finish === "tool_calls") return "tool_calls";
  if (finish === "content_filter") return "content_filter";
  if (finish === "function_call") return "function_call";
  // Unknown provider finish_reason values: treat as opaque stop (not truncated)
  // unless the caller layers a server cancel on top.
  return "unknown";
}

export function createStreamFinishTracker(): StreamFinishTracker {
  let last: string | null = null;

  return {
    observe(choice) {
      if (!choice) return;
      const fr = choice.finish_reason;
      if (typeof fr === "string" && fr.length > 0) {
        last = fr;
      } else if (fr === null) {
        // Explicit null is common on intermediate deltas — ignore.
      }
    },

    lastFinishReason() {
      return last;
    },

    settle(options = {}) {
      const { serverCancel = null, treatMissingAsTruncated = true } = options;

      if (serverCancel) {
        return {
          finish_reason: last,
          truncated: true,
          stop_reason: serverCancel.kind,
        };
      }

      if (last === null) {
        // Stream ended done with no finish_reason and no server cancel.
        if (treatMissingAsTruncated) {
          return {
            finish_reason: null,
            truncated: true,
            stop_reason: "provider_cut",
          };
        }
        return {
          finish_reason: null,
          truncated: false,
          stop_reason: "unknown",
        };
      }

      if (KNOWN_TRUNCATED.has(last)) {
        return {
          finish_reason: last,
          truncated: true,
          stop_reason: mapFinishToStop(last),
        };
      }

      if (KNOWN_CLEAN.has(last)) {
        return {
          finish_reason: last,
          truncated: false,
          stop_reason: mapFinishToStop(last),
        };
      }

      // Unknown non-empty finish_reason: not truncated by default.
      return {
        finish_reason: last,
        truncated: false,
        stop_reason: "unknown",
      };
    },
  };
}

/**
 * Map a read-loop stop flag set into a server-cancel kind for settle().
 * Returns null when the stream was not cancelled by the server.
 */
export function serverCancelFromReadStop(
  stopReason:
    | "first_token_timeout"
    | "stream_idle_timeout"
    | "turn_cancelled"
    | "turn_deadline_exceeded"
    | "stage_deadline_exceeded"
    | "visible_progress_timeout"
    | "degenerate_stream"
    | null
    | undefined,
): StreamFinishServerCancel | null {
  if (!stopReason) return null;
  switch (stopReason) {
    case "turn_deadline_exceeded":
      return { kind: "turn_deadline" };
    case "stage_deadline_exceeded":
      return { kind: "stage_deadline" };
    case "turn_cancelled":
      return { kind: "cancelled" };
    case "degenerate_stream":
      return { kind: "degenerate_stream" };
    case "first_token_timeout":
    case "stream_idle_timeout":
    case "visible_progress_timeout":
      return { kind: "watchdog" };
    default:
      return null;
  }
}
