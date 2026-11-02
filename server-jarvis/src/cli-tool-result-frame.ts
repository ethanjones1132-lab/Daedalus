// CLI tool_result frame (DD-044 / DD-T2)
//
// The Claude CLI surface emits its own `tool_result` record for every executor
// tool call. The UI matches a result to the tool card by `call_id` alone, so a
// frame that carries only `id` leaves the card pending forever. The native
// Tool runtime path already writes `call_id`; the CLI path did not.
//
// This module is the single place that shapes the CLI frame: it names the call
// the card opened (both `id` and `call_id` are the CLI tool use id) and keeps
// the result payload untouched. When the CLI gives no tool use id, neither
// field is synthesized — an absent id stays absent rather than becoming a
// fabricated call the UI could never match.

export interface CliToolResultFrame {
  type: "tool_result";
  /** Legacy field, retained for frames that still carry only `id`. */
  id?: string;
  /** Canonical field the UI matches against the open tool card. */
  call_id?: string;
  output?: unknown;
  is_error?: boolean;
  session_id: string;
}

export interface CliToolResultFrameInput {
  /** `tool_use_id` from the Claude CLI `tool_result` event. */
  toolUseId?: string | null;
  /** `tool_output` from the Claude CLI `tool_result` event. */
  output?: unknown;
  /** `is_error` from the Claude CLI `tool_result` event. */
  isError?: boolean;
  sessionId: string;
}

function usableToolUseId(toolUseId: string | null | undefined): string | null {
  if (typeof toolUseId !== "string") return null;
  const trimmed = toolUseId.trim();
  if (trimmed.length === 0) return null;
  return toolUseId;
}

/**
 * Build the `tool_result` payload the server writes for a Claude CLI tool turn.
 * Pure: same input, same frame. `call_id` always equals `id`.
 */
export function buildCliToolResultFrame(
  input: CliToolResultFrameInput,
): CliToolResultFrame {
  const toolUseId = usableToolUseId(input.toolUseId);

  return {
    type: "tool_result",
    // Only name a call when the CLI named one; never invent an id.
    ...(toolUseId !== null ? { id: toolUseId, call_id: toolUseId } : {}),
    output: input.output,
    is_error: input.isError,
    session_id: input.sessionId,
  };
}
