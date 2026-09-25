export type ToolCallEvidenceErrorCode =
  | "malformed_json"
  | "invalid_root"
  | "invalid_entry"
  | "missing_tool_name"
  | "invalid_error_flag"
  | "invalid_arguments";

export interface StoredToolCallEvidence {
  name: string;
  arguments?: Record<string, unknown>;
  is_error: boolean;
  output?: unknown;
}

export type ToolCallEvidenceDecodeResult =
  | { ok: true; calls: StoredToolCallEvidence[] }
  | {
      ok: false;
      code: ToolCallEvidenceErrorCode;
      entryIndex?: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeToolCallEvidence(
  raw: string | null | undefined,
): ToolCallEvidenceDecodeResult {
  if (raw === null || raw === undefined) return { ok: true, calls: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "malformed_json" };
  }
  if (!Array.isArray(parsed)) return { ok: false, code: "invalid_root" };

  const calls: StoredToolCallEvidence[] = [];
  for (const [entryIndex, entry] of parsed.entries()) {
    if (!isRecord(entry)) return { ok: false, code: "invalid_entry", entryIndex };
    if (typeof entry.name !== "string" || entry.name.trim().length === 0) {
      return { ok: false, code: "missing_tool_name", entryIndex };
    }
    if (entry.is_error !== undefined && typeof entry.is_error !== "boolean") {
      return { ok: false, code: "invalid_error_flag", entryIndex };
    }
    if (entry.arguments !== undefined && !isRecord(entry.arguments)) {
      return { ok: false, code: "invalid_arguments", entryIndex };
    }
    calls.push({
      name: entry.name,
      arguments: entry.arguments as Record<string, unknown> | undefined,
      is_error: entry.is_error === true,
      output: entry.output,
    });
  }
  return { ok: true, calls };
}
