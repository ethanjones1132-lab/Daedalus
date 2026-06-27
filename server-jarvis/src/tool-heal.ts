// ─── Tool-error self-healing ─────────────────────────────────────────────────
// When a tool returns an error, classify it and append a targeted hint to the
// output the model sees, so its next attempt is better-informed instead of
// blindly retrying. Hints escalate after repeated failures of the same call to
// stop the model looping on a hopeless approach.
//
// The `Hint:` prefix is also recognized by the UI (ToolCallCard) and rendered
// as an actionable suggestion.

export type ToolErrorCategory =
  | "not_found"
  | "not_read"
  | "permission"
  | "timeout"
  | "parse"
  | "is_directory"
  | "unknown";

export function classifyToolError(output: string): ToolErrorCategory {
  const o = (output || "").toLowerCase();
  if (o.includes("has not been read yet")) return "not_read";
  if (o.includes("is a directory")) return "is_directory";
  if (o.includes("not found") || o.includes("no such file") || o.includes("enoent")) return "not_found";
  if (o.includes("permission denied") || o.includes("eacces") || o.includes("access denied")) return "permission";
  if (o.includes("timed out") || o.includes("timeout") || o.includes("etimedout")) return "timeout";
  if (o.includes("json") || o.includes("unexpected token") || o.includes("parse")) return "parse";
  return "unknown";
}

const BASE_HINTS: Record<ToolErrorCategory, string> = {
  not_found: "The path was not found. Use glob to locate the correct path before retrying.",
  not_read: "Call read_file on the path first, then retry the edit with the exact current content.",
  permission: "Permission was denied for that path. Try an alternative location instead of retrying.",
  timeout: "The operation timed out. Retry once with a narrower scope or smaller input.",
  parse: "The tool arguments were malformed. Re-emit the tool call with valid JSON arguments.",
  is_directory: "That path is a directory. Use list_directory to list it, or read_file on a specific file inside it.",
  unknown: "",
};

/**
 * A targeted, single-line hint for an error category. After `attempt` >= 2 the
 * hint escalates to discourage repeating the same failing approach.
 */
export function healingHint(category: ToolErrorCategory, attempt: number): string {
  const base = BASE_HINTS[category];
  if (!base) return "";
  if (attempt >= 2) {
    return `${base} This has failed ${attempt} times — try a different approach or report the limitation instead of repeating it.`;
  }
  return base;
}

/**
 * Append a `Hint:` line to an error tool output. No-ops for unknown errors or
 * outputs that already contain a hint.
 */
export function augmentErrorOutput(output: string, attempt: number): string {
  if (!output || output.includes("Hint:")) return output;
  const hint = healingHint(classifyToolError(output), attempt);
  if (!hint) return output;
  return `${output}\nHint: ${hint}`;
}

/** Stable signature for counting repeated failures of the "same" tool call. */
export function toolCallSignature(name: string, args: unknown): string {
  let argStr = "";
  try {
    argStr = JSON.stringify(args);
  } catch {
    argStr = String(args);
  }
  return `${name}:${argStr}`;
}
