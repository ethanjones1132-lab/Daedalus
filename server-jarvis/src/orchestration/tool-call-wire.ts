// Assistant tool calls in conversation history, in the one shape every
// OpenAI-compatible server accepts: { id, type: "function", function: { name,
// arguments: "<JSON string>" } }.
//
// The orchestration pipeline (executor and rewriter loops) pushes its parsed
// calls back into history as { id, name, arguments: {object} }. Cloud
// providers tolerated that; llama.cpp's chat template does not. Measured
// 2026-11-07 on llama.cpp b11854: every executor/rewriter request after a tool
// call failed in 3-13 ms with HTTP 500 "Failed to parse messages: Missing tool
// call type", so local multi-step tool use could never progress past one call.
// The single-pass agent loop already built this shape; this makes the pipeline
// path match it on the wire, without changing the in-memory history.

type AnyRecord = Record<string, unknown>;

function argumentsString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "{}";
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

/** One tool call in wire shape, whatever internal shape it arrived in. */
export function toWireToolCall(call: unknown, index: number): AnyRecord | null {
  if (!call || typeof call !== "object") return null;
  const value = call as AnyRecord;
  const fn = value.function && typeof value.function === "object" ? value.function as AnyRecord : null;
  const name = typeof fn?.name === "string" ? fn.name : typeof value.name === "string" ? value.name : "";
  if (!name) return null;
  const id = typeof value.id === "string" && value.id ? value.id : `call_${index}`;
  return {
    id,
    type: "function",
    function: { name, arguments: argumentsString(fn ? fn.arguments : value.arguments) },
  };
}

/**
 * Return a request copy of `message` with wire-shape tool calls. Messages
 * without tool calls are returned unchanged (same object).
 */
export function withWireToolCalls<T extends AnyRecord>(message: T): T {
  if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) return message;
  const calls = (message.tool_calls as unknown[])
    .map((call, index) => toWireToolCall(call, index))
    .filter((call): call is AnyRecord => call !== null);
  if (calls.length === 0) {
    const { tool_calls: _dropped, ...rest } = message;
    return rest as T;
  }
  return { ...message, tool_calls: calls };
}
