import { readFileSync } from "node:fs";

export type CorpusSidecarKind = "eval" | "replan";
export type CorpusSidecarFormat = "versioned" | "legacy";

export type CorpusSidecarErrorCode =
  | "root_not_object"
  | "invalid_json"
  | "unreadable"
  | "unknown_schema"
  | "missing_schema"
  | "missing_metadata"
  | "invalid_timestamp"
  | "unexpected_field"
  | "missing_payload"
  | "invalid_payload"
  | "empty_run_id"
  | "invalid_run_id"
  | "invalid_value";

export class CorpusSidecarError extends Error {
  constructor(
    readonly code: CorpusSidecarErrorCode,
    entryIndex?: number,
  ) {
    super(entryIndex === undefined ? code : `${code}:entry_${entryIndex}`);
    this.name = "CorpusSidecarError";
  }
}

export interface SidecarMetadata {
  schemaVersion: 1;
  evaluator: string;
  evalSuite: string;
  generatedAt: string;
}

export interface DecodedEvalSidecar {
  kind: "eval";
  format: CorpusSidecarFormat;
  metadata: SidecarMetadata | null;
  values: ReadonlyMap<string, boolean>;
  providedRunIds: string[];
}

export interface DecodedReplanSidecar {
  kind: "replan";
  format: CorpusSidecarFormat;
  metadata: SidecarMetadata | null;
  values: ReadonlyMap<string, number>;
  providedRunIds: string[];
}

export interface SidecarCoverage {
  providedRunIds: string[];
  matchedRunIds: string[];
  unmatchedRunIds: string[];
  missingRunIds: string[];
  providedCount: number;
  matchedCount: number;
  unmatchedCount: number;
  missingCount: number;
  truncated: boolean;
}

const MAX_REPORTED_IDS = 20;
const ENVELOPE_FIELDS = new Set([
  "schema_version",
  "evaluator",
  "eval_suite",
  "generated_at",
  "results",
  "counts",
]);

function recordOrError(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CorpusSidecarError("root_not_object");
  }
  return value as Record<string, unknown>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isEnvelope(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => ENVELOPE_FIELDS.has(key));
}

function validateRunId(runId: string, entryIndex: number): void {
  if (runId.trim().length === 0) {
    throw new CorpusSidecarError("empty_run_id", entryIndex);
  }
  if (runId !== runId.trim()) {
    throw new CorpusSidecarError("invalid_run_id", entryIndex);
  }
}

function validateEnvelopeFields(record: Record<string, unknown>): void {
  if (record.schema_version !== 1) {
    throw new CorpusSidecarError(
      record.schema_version === undefined ? "missing_schema" : "unknown_schema",
    );
  }
  for (const field of ["evaluator", "eval_suite", "generated_at"]) {
    if (!isNonEmptyString(record[field])) {
      throw new CorpusSidecarError("missing_metadata");
    }
  }
  if (!Number.isFinite(Date.parse(record.generated_at as string))) {
    throw new CorpusSidecarError("invalid_timestamp");
  }
}

function validateKnownFields(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new CorpusSidecarError("unexpected_field");
    }
  }
}

function payloadOrError(record: Record<string, unknown>, field: "results" | "counts"): Record<string, unknown> {
  const payload = record[field];
  if (payload === undefined) {
    throw new CorpusSidecarError("missing_payload");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CorpusSidecarError("invalid_payload");
  }
  return payload as Record<string, unknown>;
}

function metadataFor(record: Record<string, unknown>): SidecarMetadata {
  validateEnvelopeFields(record);
  return {
    schemaVersion: 1,
    evaluator: record.evaluator as string,
    evalSuite: record.eval_suite as string,
    generatedAt: record.generated_at as string,
  };
}

function sortedRunIds(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

export function decodeEvalSidecar(value: unknown): DecodedEvalSidecar {
  const record = recordOrError(value);
  const versioned = isEnvelope(record);
  if (versioned) {
    validateKnownFields(
      record,
      new Set(["schema_version", "evaluator", "eval_suite", "generated_at", "results"]),
    );
    const metadata = metadataFor(record);
    const payload = payloadOrError(record, "results");
    const values = new Map<string, boolean>();
    Object.entries(payload).forEach(([runId, result], entryIndex) => {
      validateRunId(runId, entryIndex);
      if (typeof result !== "boolean") {
        throw new CorpusSidecarError("invalid_value", entryIndex);
      }
      values.set(runId, result);
    });
    return {
      kind: "eval",
      format: "versioned",
      metadata,
      values,
      providedRunIds: sortedRunIds(values.keys()),
    };
  }

  const values = new Map<string, boolean>();
  Object.entries(record).forEach(([runId, result], entryIndex) => {
    validateRunId(runId, entryIndex);
    if (typeof result !== "boolean") {
      throw new CorpusSidecarError("invalid_value", entryIndex);
    }
    values.set(runId, result);
  });
  return {
    kind: "eval",
    format: "legacy",
    metadata: null,
    values,
    providedRunIds: sortedRunIds(values.keys()),
  };
}

export function decodeReplanSidecar(value: unknown): DecodedReplanSidecar {
  const record = recordOrError(value);
  const versioned = isEnvelope(record);
  if (versioned) {
    validateKnownFields(
      record,
      new Set(["schema_version", "evaluator", "eval_suite", "generated_at", "counts"]),
    );
    const metadata = metadataFor(record);
    const payload = payloadOrError(record, "counts");
    const values = new Map<string, number>();
    Object.entries(payload).forEach(([runId, count], entryIndex) => {
      validateRunId(runId, entryIndex);
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
        throw new CorpusSidecarError("invalid_value", entryIndex);
      }
      values.set(runId, count);
    });
    return {
      kind: "replan",
      format: "versioned",
      metadata,
      values,
      providedRunIds: sortedRunIds(values.keys()),
    };
  }

  const values = new Map<string, number>();
  Object.entries(record).forEach(([runId, count], entryIndex) => {
    validateRunId(runId, entryIndex);
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new CorpusSidecarError("invalid_value", entryIndex);
    }
    values.set(runId, count);
  });
  return {
    kind: "replan",
    format: "legacy",
    metadata: null,
    values,
    providedRunIds: sortedRunIds(values.keys()),
  };
}

function readParsedSidecar(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new CorpusSidecarError("unreadable");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new CorpusSidecarError("invalid_json");
  }
}

export function loadEvalSidecar(path: string): DecodedEvalSidecar {
  return decodeEvalSidecar(readParsedSidecar(path));
}

export function loadReplanSidecar(path: string): DecodedReplanSidecar {
  return decodeReplanSidecar(readParsedSidecar(path));
}

export function summarizeSidecarCoverage(
  providedRunIds: Iterable<string>,
  corpusRunIds: Iterable<string>,
): SidecarCoverage {
  const provided = sortedRunIds(providedRunIds);
  const corpus = new Set(corpusRunIds);
  const providedSet = new Set(provided);
  const matched = provided.filter((runId) => corpus.has(runId));
  const unmatched = provided.filter((runId) => !corpus.has(runId));
  const missing = [...corpus].filter((runId) => !providedSet.has(runId)).sort();
  return {
    providedRunIds: provided.slice(0, MAX_REPORTED_IDS),
    matchedRunIds: matched.slice(0, MAX_REPORTED_IDS),
    unmatchedRunIds: unmatched.slice(0, MAX_REPORTED_IDS),
    missingRunIds: missing.slice(0, MAX_REPORTED_IDS),
    providedCount: provided.length,
    matchedCount: matched.length,
    unmatchedCount: unmatched.length,
    missingCount: missing.length,
    truncated:
      provided.length > MAX_REPORTED_IDS ||
      matched.length > MAX_REPORTED_IDS ||
      unmatched.length > MAX_REPORTED_IDS ||
      missing.length > MAX_REPORTED_IDS,
  };
}
