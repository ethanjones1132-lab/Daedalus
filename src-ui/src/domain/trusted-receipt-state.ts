// ── Trusted execution/acceptance receipt decoding ───────────────────────────
//    Shared strict decoders for the authoritative native receipts returned by
//    `get_trusted_execution`, `list_trusted_executions`, and
//    `get_trusted_acceptance`. These records are the only evidence source the
//    UI may display: file-backed Action Registry `execution_evidence` /
//    `acceptance_evidence` is never read as proof. Every caller binds the
//    decoded record to an exact action/execution/manifest identity.

export const KNOWN_EXECUTION_STATUSES = [
  'claimed',
  'dispatched',
  'pending_acceptance',
  'waiting_for_user',
  'blocked',
  'failed',
  'cancelled',
  'partial',
  'ambiguous',
] as const;

export const KNOWN_ACCEPTANCE_STATUSES = [
  'accepted',
  'rejected',
  'blocked',
  'waiting_for_user',
  'failed',
  'cancelled',
  'partial',
  'ambiguous',
] as const;

const EXECUTION_STATUS_SET = new Set<string>(KNOWN_EXECUTION_STATUSES);
const ACCEPTANCE_STATUS_SET = new Set<string>(KNOWN_ACCEPTANCE_STATUSES);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64_PATTERN.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Rust `Option<String>` fields are serialized without `skip_serializing_if` on
 * the receipt DTOs, so they are always present as `null` or a string. A
 * missing/undefined field must fail closed rather than be treated as null.
 */
function isPresentNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * A required JSON field (Rust `serde_json::Value` / `Option<Value>` serialized
 * without `skip_serializing_if`) must be present; an explicit `null` is valid.
 */
function isPresentJson(value: unknown): boolean {
  return value !== undefined;
}

function isTrustedExecutionConflict(value: unknown): value is { kind: string; detail: string } {
  if (!isPlainObject(value)) return false;
  return isNonEmptyString(value.kind) && isNonEmptyString(value.detail);
}

/**
 * Bounded recursive JSON equality for receipt `evidence` payloads (serde_json
 * values). Arrays compare by length and order; objects compare by exact key set
 * and recursively-equal values; primitives by strict equality.
 */
export function deepJsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (!deepJsonEqual(a[index], b[index])) return false;
    }
    return true;
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!hasOwn(b, key)) return false;
      if (!deepJsonEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

export interface TrustedExecutionReceipt {
  execution_id: string;
  idempotency_key: string;
  action_id: string;
  manifest_id: string;
  manifest_registry_version: number;
  manifest_content_hash: string;
  manifest_schema_version: number;
  agent_id: string;
  project_root: string;
  status: string;
  terminal_reason: string | null;
  run_id: string | null;
  bun_run_id: string | null;
  evidence: unknown;
  started_at: string | null;
  settled_at: string | null;
  runtime_started_at: string | null;
  runtime_finished_at: string | null;
  cancel_requested_at: string | null;
  created_at: string;
  updated_at: string;
  conflict: { kind: string; detail: string } | null;
}

export interface TrustedAcceptanceCriterionReceipt {
  criterion_id: string;
  tool: string;
  check_index: number;
  expected_sha256: string;
  actual_sha256: string | null;
  accepted: boolean;
  evidence: unknown;
}

export interface TrustedAcceptanceReceipt {
  acceptance_key: string;
  execution_id: string;
  action_id: string;
  manifest_id: string;
  goal_id: string;
  status: string;
  terminal_reason: string | null;
  bun_run_id: string | null;
  bun_instance_id: string | null;
  evidence: unknown;
  runtime_started_at: string | null;
  runtime_finished_at: string | null;
  settled_at: string | null;
  created_at: string;
  updated_at: string;
  criteria: TrustedAcceptanceCriterionReceipt[];
  confirmed: boolean;
}

export interface TrustedManifestAcceptanceCheck {
  tool: string;
  arguments?: unknown;
  expect_sha256: string;
}

export interface TrustedManifestSummary {
  manifest_id: string;
  registry_version: number;
  schema_version: number;
  content_hash: string;
  content: unknown;
  agent_id: string;
  project_root: string;
  action_id: string | null;
  created_at: string;
  updated_at: string;
}

export function isTrustedExecutionReceipt(value: unknown): value is TrustedExecutionReceipt {
  if (!isPlainObject(value)) return false;
  const row = value;
  return (
    isUuid(row.execution_id) &&
    isNonEmptyString(row.idempotency_key) &&
    isNonEmptyString(row.action_id) &&
    isNonEmptyString(row.manifest_id) &&
    isInteger(row.manifest_registry_version) &&
    row.manifest_registry_version >= 1 &&
    isHex64(row.manifest_content_hash) &&
    isInteger(row.manifest_schema_version) &&
    row.manifest_schema_version >= 1 &&
    isNonEmptyString(row.agent_id) &&
    isNonEmptyString(row.project_root) &&
    typeof row.status === 'string' &&
    EXECUTION_STATUS_SET.has(row.status) &&
    isPresentNullableString(row.terminal_reason) &&
    isPresentNullableString(row.run_id) &&
    isPresentNullableString(row.bun_run_id) &&
    hasOwn(row, 'evidence') &&
    isPresentJson(row.evidence) &&
    isPresentNullableString(row.started_at) &&
    isPresentNullableString(row.settled_at) &&
    isPresentNullableString(row.runtime_started_at) &&
    isPresentNullableString(row.runtime_finished_at) &&
    isPresentNullableString(row.cancel_requested_at) &&
    isNonEmptyString(row.created_at) &&
    isNonEmptyString(row.updated_at) &&
    hasOwn(row, 'conflict') &&
    (row.conflict === null || isTrustedExecutionConflict(row.conflict))
  );
}

function isTrustedAcceptanceCriterion(value: unknown): value is TrustedAcceptanceCriterionReceipt {
  if (!isPlainObject(value)) return false;
  const row = value;
  return (
    isNonEmptyString(row.criterion_id) &&
    isNonEmptyString(row.tool) &&
    isInteger(row.check_index) &&
    row.check_index >= 0 &&
    isHex64(row.expected_sha256) &&
    (row.actual_sha256 === null || isHex64(row.actual_sha256)) &&
    typeof row.accepted === 'boolean' &&
    hasOwn(row, 'evidence') &&
    isPresentJson(row.evidence)
  );
}

export function isTrustedAcceptanceReceipt(value: unknown): value is TrustedAcceptanceReceipt {
  if (!isPlainObject(value)) return false;
  const row = value;
  if (
    !isNonEmptyString(row.acceptance_key) ||
    !isUuid(row.execution_id) ||
    !isNonEmptyString(row.action_id) ||
    !isNonEmptyString(row.manifest_id) ||
    !isNonEmptyString(row.goal_id) ||
    typeof row.status !== 'string' ||
    !ACCEPTANCE_STATUS_SET.has(row.status) ||
    !isPresentNullableString(row.terminal_reason) ||
    !isPresentNullableString(row.bun_run_id) ||
    !isPresentNullableString(row.bun_instance_id) ||
    !hasOwn(row, 'evidence') ||
    !isPresentJson(row.evidence) ||
    !isPresentNullableString(row.runtime_started_at) ||
    !isPresentNullableString(row.runtime_finished_at) ||
    !isPresentNullableString(row.settled_at) ||
    !isNonEmptyString(row.created_at) ||
    !isNonEmptyString(row.updated_at) ||
    typeof row.confirmed !== 'boolean' ||
    !Array.isArray(row.criteria)
  ) {
    return false;
  }
  const seen = new Set<string>();
  for (const criterion of row.criteria) {
    if (!isTrustedAcceptanceCriterion(criterion)) return false;
    const key = `${criterion.criterion_id}:${criterion.check_index}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

const TOOL_ARGUMENT_KEYS = new Set([
  'path',
  'pattern',
  'offset',
  'limit',
  'output_mode',
  'head_limit',
  'content',
  'old_string',
  'new_string',
]);
const STRING_ARGUMENT_KEYS = new Set([
  'path',
  'pattern',
  'output_mode',
  'content',
  'old_string',
  'new_string',
]);
const UINT_ARGUMENT_KEYS = new Set(['offset', 'limit', 'head_limit']);

/** Structurally validate one v1 bounded ToolRuntime argument map. */
function isBoundedArgumentsV1(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (!TOOL_ARGUMENT_KEYS.has(key)) return false;
    if (STRING_ARGUMENT_KEYS.has(key)) {
      if (typeof entry !== 'string') return false;
    } else if (UINT_ARGUMENT_KEYS.has(key)) {
      if (!isInteger(entry) || entry < 0) return false;
    } else {
      return false;
    }
  }
  return true;
}

/** Structurally validate one v1 acceptance check (`tool`, optional bounded
 *  `arguments`, and an exact lowercase-hex `expect_sha256`). */
function isAcceptanceCheckV1(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (key !== 'tool' && key !== 'arguments' && key !== 'expect_sha256') return false;
  }
  if (!isNonEmptyString(value.tool)) return false;
  if (!isHex64(value.expect_sha256)) return false;
  if (hasOwn(value, 'arguments')) {
    const args = value.arguments;
    if (args !== null && !isBoundedArgumentsV1(args)) return false;
  }
  return true;
}

/** Structurally validate the stored v1 manifest content: exact schema version,
 *  a non-empty execution list, and a non-empty criterion-keyed acceptance map
 *  whose keys are UUIDs and whose check lists are well-formed. */
function isManifestContentV1(value: unknown): value is {
  schema_version: number;
  execution: unknown[];
  acceptance: Record<string, unknown[]>;
} {
  if (!isPlainObject(value)) return false;
  if (value.schema_version !== 1) return false;
  const execution = value.execution;
  if (!Array.isArray(execution) || execution.length === 0) return false;
  const acceptance = value.acceptance;
  if (!isPlainObject(acceptance)) return false;
  const keys = Object.keys(acceptance);
  if (keys.length === 0) return false;
  for (const key of keys) {
    if (!isUuid(key)) return false;
    const checks = acceptance[key];
    if (!Array.isArray(checks) || checks.length === 0) return false;
    for (const check of checks) {
      if (!isAcceptanceCheckV1(check)) return false;
    }
  }
  return true;
}

export function isTrustedManifestSummary(value: unknown): value is TrustedManifestSummary {
  if (!isPlainObject(value)) return false;
  const row = value;
  return (
    isNonEmptyString(row.manifest_id) &&
    isInteger(row.registry_version) &&
    row.registry_version >= 1 &&
    isInteger(row.schema_version) &&
    row.schema_version === 1 &&
    isHex64(row.content_hash) &&
    hasOwn(row, 'content') &&
    isManifestContentV1(row.content) &&
    isNonEmptyString(row.agent_id) &&
    isNonEmptyString(row.project_root) &&
    (row.action_id === null || isNonEmptyString(row.action_id)) &&
    isNonEmptyString(row.created_at) &&
    isNonEmptyString(row.updated_at)
  );
}

/** Sorted acceptance criterion keys declared by a validated manifest. A
 *  malformed manifest never reaches here (the guard rejects it), so a returned
 *  empty list would only mean an impossible empty map. */
export function manifestAcceptanceKeys(manifest: TrustedManifestSummary): string[] {
  const content = manifest.content;
  if (!isManifestContentV1(content)) return [];
  return Object.keys(content.acceptance).slice().sort();
}

export interface TrustedAcceptanceExpectedCheck {
  criterion_id: string;
  check_index: number;
  tool: string;
  expected_sha256: string;
}

/**
 * Exact acceptance-check rows declared by a validated manifest, derived the same
 * way native persists receipt rows: criterion UUID keys sorted ascending, each
 * criterion's declared check order preserved, `check_index` starting at zero.
 * Callers compare these rows one-for-one against a native acceptance receipt.
 */
export function manifestAcceptanceChecks(
  manifest: TrustedManifestSummary,
): TrustedAcceptanceExpectedCheck[] {
  const content = manifest.content;
  if (!isManifestContentV1(content)) return [];
  const rows: TrustedAcceptanceExpectedCheck[] = [];
  for (const criterionId of Object.keys(content.acceptance).slice().sort()) {
    const checks = content.acceptance[criterionId];
    for (let index = 0; index < checks.length; index += 1) {
      const check = checks[index] as TrustedManifestAcceptanceCheck;
      rows.push({
        criterion_id: criterionId,
        check_index: index,
        tool: check.tool,
        expected_sha256: check.expect_sha256,
      });
    }
  }
  return rows;
}

/** Best-effort workspace-root normalization for display/filter only; native
 *  revalidates the canonical root. A mismatch fails closed (candidate hidden). */
export function normalizeRoot(root: string | null | undefined): string | null {
  if (typeof root !== 'string') return null;
  let value = root.trim();
  if (value.length === 0) return null;
  while (value.length > 1 && (value.endsWith('/') || value.endsWith('\\'))) {
    value = value.slice(0, -1);
  }
  return value;
}

export function executionStatusVariant(
  status: string,
): 'success' | 'info' | 'warn' | 'error' | 'default' {
  if (status === 'blocked' || status === 'failed') return 'error';
  if (
    status === 'ambiguous' ||
    status === 'waiting_for_user' ||
    status === 'partial' ||
    status === 'pending_acceptance'
  ) {
    return 'warn';
  }
  if (status === 'claimed' || status === 'dispatched') return 'info';
  if (status === 'completed') return 'success';
  return 'default';
}

export function acceptanceStatusVariant(
  status: string,
): 'success' | 'info' | 'warn' | 'error' | 'default' {
  if (status === 'accepted') return 'success';
  if (status === 'blocked' || status === 'failed' || status === 'rejected') return 'error';
  if (status === 'waiting_for_user' || status === 'partial' || status === 'ambiguous') {
    return 'warn';
  }
  return 'default';
}

/** Bounded, metadata-only execution-call evidence summary (no raw output). */
export function evidenceSummary(evidence: unknown): string | null {
  if (!Array.isArray(evidence) || evidence.length === 0) return null;
  const parts = evidence.slice(0, 8).map((item) => {
    const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const tool = typeof row.tool === 'string' ? row.tool : '?';
    const status = typeof row.status === 'string' ? row.status : '?';
    const hash = typeof row.output_sha256 === 'string' ? row.output_sha256.slice(0, 10) : '';
    const bytes = typeof row.output_bytes === 'number' ? `${row.output_bytes}B` : '';
    const suffix = [hash ? `${hash}…` : '', bytes].filter((v) => v.length > 0).join(' ');
    return `${tool}:${status}${suffix ? ` (${suffix})` : ''}`;
  });
  return `${evidence.length} call(s): ${parts.join(', ')}`;
}

/** Bounded metadata summary of one acceptance check's runtime evidence. */
export function criterionEvidenceSummary(evidence: unknown): string | null {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  const row = evidence as Record<string, unknown>;
  const bits: string[] = [];
  if (typeof row.output_sha256 === 'string') bits.push(`output ${row.output_sha256.slice(0, 12)}…`);
  if (typeof row.output_bytes === 'number') bits.push(`${row.output_bytes}B`);
  if (row.matched === true) bits.push('matched');
  if (row.matched === false) bits.push('not matched');
  if (typeof row.error_code === 'string' && row.error_code.length > 0) {
    bits.push(`error ${row.error_code}`);
  }
  if (typeof row.reason === 'string' && row.reason.trim().length > 0) bits.push(row.reason);
  return bits.length > 0 ? bits.join(' · ') : null;
}
