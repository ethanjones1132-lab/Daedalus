// ═══════════════════════════════════════════════════════════════
// Streaming tool-call normalization
// ═══════════════════════════════════════════════════════════════
//
// During an OpenAI-compatible SSE stream the chat layer incrementally
// assembles each `choice.delta.tool_calls[i]` chunk into a slot in
// `activeToolCalls[]` (see `ensureActiveToolCall` in index.ts). When the
// stream ends, the resulting array can be in any of these states:
//
//   1. Fully formed: each slot has an `id`, a `name`, and a JSON-parseable
//      `arguments` string. This is the happy path — the executor dispatches
//      each call as-is.
//
//   2. Missing `name`: the model streamed `arguments` chunks but never sent
//      a `function.name` delta. The slot is useless — `runtime.execute` would
//      fail with "unknown tool". The agent-loop path already filters these
//      out with `validCalls.filter(call => call && call.name)`; the
//      orchestrator path previously did not, leaking undefined names to the
//      executor. The 2026-06-26 live diagnosis flagged this as Priority 3
//      ("executor/provider compatibility is unstable and produces
//      malformed-tool-message failures during fallback").
//
//   3. Non-JSON `arguments`: the model streamed something that doesn't parse
//      as a JSON object — usually a truncated string when the model ran out
//      of tokens, or a provider that emits escaped/partial JSON. The previous
//      code silently swallowed the parse error and called the tool with
//      `{}` — making the downstream failure look like a missing-args issue
//      rather than a model/provider bug. Silent here means "I can't tell
//      which model produced this garbage" when the operator investigates.
//
//   4. Missing `id`: the model sent `name` + `arguments` but no `id` delta.
//      The previous code synthesized `call_<random>` so the tool could still
//      be executed, but the random id leaks into the assistant history and
//      breaks correlation on the next turn.
//
// This module centralizes the "what does a fully-formed streamed tool call
// look like?" decision in one pure function so the same rules apply to both
// the orchestrator and agent-loop paths, and so the operator-visible warning
// format is consistent. It also makes the behavior unit-testable without
// standing up a fake SSE server.

import type { ToolCall } from "./tool-types";

/** A slot in `activeToolCalls` as assembled by `ensureActiveToolCall`. */
export interface RawStreamedToolCall {
  id?: string;
  name?: string;
  /** Concatenated `function.arguments` string deltas. May be empty, partial, or non-JSON. */
  arguments?: string;
}

/** Information about a tool call the model emitted that couldn't be safely executed. */
export interface ToolCallWarning {
  /** Stable category for log filters / dashboards. */
  kind: "missing_name" | "unparseable_arguments";
  /** 0-based index into the streamed `activeToolCalls` array. */
  index: number;
  /** Whatever partial info we did receive — never throws, never PII-laden. */
  partial: { name?: string; id?: string; argumentsPreview?: string };
  /** Human-readable, one-line description for the server log. */
  message: string;
}

export interface NormalizeResult {
  /** Tool calls safe to dispatch to the executor. Order matches the original stream. */
  calls: ToolCall[];
  /** Warnings describing entries that were dropped or coerced. Empty in the happy path. */
  warnings: ToolCallWarning[];
}

/**
 * Maximum number of characters of the unparseable `arguments` string to
 * include in a warning. Long enough to identify the shape ("{path:" alone
 * vs "{path:" + control char), short enough to keep log lines bounded when
 * a model streams a 5KB argument blob.
 */
const ARGUMENTS_PREVIEW_LIMIT = 120;

/**
 * Pure: turn a stream-assembled `activeToolCalls[]` into a list of
 * dispatchable `ToolCall`s, dropping or coercing malformed entries and
 * recording a `ToolCallWarning` for each one. The returned `warnings`
 * array preserves order so the caller can log them in stream order.
 *
 * Behavior:
 * - Slot has no `name` → dropped (caller already filters these; we
 *   surface the warning so the operator can see the model emitted one).
 * - Slot has a `name` but `arguments` is not a JSON object string → kept,
 *   coerced to `{}`, and a warning is recorded with a preview of the raw
 *   string so the failure is attributable to a specific model output.
 * - Slot has a `name` and a valid JSON-object string `arguments` → kept
 *   as-is. (Non-object JSON like `42` or `"foo"` is coerced to `{}` for
 *   the same reason.)
 * - Slot has a `name` and an empty `arguments` string → kept with `{}`
 *   (some providers emit zero-arg tool calls as `""` or `{}` already).
 * - Slot has no `id` → synthesized as `call_<short-uuid>`.
 */
export function normalizeStreamedToolCalls(
  activeToolCalls: ReadonlyArray<RawStreamedToolCall | undefined | null>,
  randomIdFactory: () => string = () => `call_${crypto.randomUUID().slice(0, 8)}`,
): NormalizeResult {
  const calls: ToolCall[] = [];
  const warnings: ToolCallWarning[] = [];

  activeToolCalls.forEach((tc, index) => {
    if (!tc) return;
    if (!tc.name || !tc.name.trim()) {
      warnings.push({
        kind: "missing_name",
        index,
        partial: { id: tc.id, argumentsPreview: previewOf(tc.arguments) },
        message:
          `Streamed tool_call at index ${index} has no function.name ` +
          `(id=${tc.id ?? "<none>"}, arguments preview=${previewOf(tc.arguments) ?? "<empty>"}); dropping.`,
      });
      return;
    }

    const name = tc.name;
    const id = tc.id && tc.id.trim() ? tc.id : randomIdFactory();
    const args = parseArgumentsOrCoerce(tc.arguments);

    calls.push({ id, name, arguments: args.value });
    if (args.warning) {
      warnings.push({
        kind: "unparseable_arguments",
        index,
        partial: { name, id, argumentsPreview: previewOf(tc.arguments) },
        message:
          `Streamed tool_call "${name}" (id=${id}) has unparseable arguments ` +
          `(preview=${previewOf(tc.arguments) ?? "<empty>"}); coercing to {}. ` +
          `Likely a truncated or non-JSON provider payload.`,
      });
    }
  });

  return { calls, warnings };
}

function parseArgumentsOrCoerce(raw: string | undefined): {
  value: Record<string, unknown>;
  warning: boolean;
} {
  if (raw === undefined || raw === null || raw === "") {
    return { value: {}, warning: false };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { value: parsed as Record<string, unknown>, warning: false };
    }
    // A scalar JSON value (number, string, array) isn't a valid `arguments`
    // shape for the tool runtime — the model emitted a malformed payload.
    return { value: {}, warning: true };
  } catch {
    return { value: {}, warning: true };
  }
}

function previewOf(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length <= ARGUMENTS_PREVIEW_LIMIT) return cleaned;
  return cleaned.slice(0, ARGUMENTS_PREVIEW_LIMIT) + "…";
}
