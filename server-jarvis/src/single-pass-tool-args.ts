// ═══════════════════════════════════════════════════════════════
// ── Single-pass tool-call argument classification ──
// ═══════════════════════════════════════════════════════════════
// DD-047: the Ollama/OpenRouter single-pass loop used to catch a failed
// `JSON.parse` of the streamed tool arguments and carry on with `parsedArgs =
// {}`. The empty object was then handed to `ToolRuntime.execute`, so a
// truncated or otherwise unparseable tool call still ran (with no inputs), was
// counted as tool work, reached the `verifiedWebSearchDone` assignment for a
// sniffed `web_search` name, and was stored as a normal successful action.
//
// This module owns the one classification the production loop uses:
//
//   • a missing or empty arguments string means no arguments (`{}`), which is
//     the existing `JSON.parse(arguments || "{}")` behaviour;
//   • a non-empty string that parses to a JSON object is a usable tool call;
//   • any other non-empty string is a rejected call. The caller must not
//     execute it, count it, or mark verified work from it.
//
// A parsed primitive/array is rejected too: tool arguments are a JSON object,
// and spreading a primitive would silently execute an empty call again.

/** Shown when the streamed arguments are not JSON at all (e.g. truncated). */
export const TOOL_ARGUMENTS_NOT_JSON_ERROR =
  "Tool call rejected: its arguments were not valid JSON, so the tool did not run.";

/** Shown when the arguments parse but are not a JSON object. */
export const TOOL_ARGUMENTS_NOT_OBJECT_ERROR =
  "Tool call rejected: its arguments must be a JSON object, so the tool did not run.";

export type SinglePassToolArgs =
  | {
      ok: true;
      /** Arguments to hand to `ToolRuntime.execute`; `{}` for an empty call. */
      args: Record<string, unknown>;
    }
  | {
      ok: false;
      /** Error text for the streamed tool result and the tool history entry. */
      error: string;
      /** The raw streamed string, kept for the warning log only. */
      raw: string;
    };

/**
 * Classify one streamed tool call's `function.arguments` before execution.
 *
 * The caller treats `ok: false` as a rejected call: nothing executes, no
 * execution is counted, and no verified-search flag is set. Only the failure
 * text becomes the tool result.
 */
export function classifySinglePassToolArgs(
  raw: string | null | undefined,
): SinglePassToolArgs {
  const text = typeof raw === "string" ? raw : "";

  // Missing or empty arguments are the normal "no arguments" call.
  if (text.length === 0) {
    return { ok: true, args: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: TOOL_ARGUMENTS_NOT_JSON_ERROR, raw: text };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: TOOL_ARGUMENTS_NOT_OBJECT_ERROR, raw: text };
  }

  return { ok: true, args: parsed as Record<string, unknown> };
}
