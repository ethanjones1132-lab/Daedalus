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

function isNullableString(value: unknown): value is string | null {
  return value === null || value === undefined || typeof value === 'string';
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
  conflict?: { kind: string; detail: string } | null;
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
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    isUuid(row.execution_id) &&
    isNonEmptyString(row.action_id) &&
    isNonEmptyString(row.manifest_id) &&
    typeof row.manifest_registry_version === 'number' &&
    Number.isInteger(row.manifest_registry_version) &&
    row.manifest_registry_version >= 1 &&
    isHex64(row.manifest_content_hash) &&
    typeof row.status === 'string' &&
    EXECUTION_STATUS_SET.has(row.status) &&
    isNullableString(row.terminal_reason) &&
    isNullableString(row.run_id) &&
    isNullableString(row.bun_run_id) &&
    isNullableString(row.runtime_started_at) &&
    isNullableString(row.runtime_finished_at) &&
    isNullableString(row.cancel_requested_at)
  );
}

function isTrustedAcceptanceCriterion(value: unknown): value is TrustedAcceptanceCriterionReceipt {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    isNonEmptyString(row.criterion_id) &&
    isNonEmptyString(row.tool) &&
    typeof row.check_index === 'number' &&
    Number.isInteger(row.check_index) &&
    isHex64(row.expected_sha256) &&
    (row.actual_sha256 === null ||
      row.actual_sha256 === undefined ||
      typeof row.actual_sha256 === 'string') &&
    typeof row.accepted === 'boolean'
  );
}

export function isTrustedAcceptanceReceipt(value: unknown): value is TrustedAcceptanceReceipt {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    isNonEmptyString(row.acceptance_key) &&
    isUuid(row.execution_id) &&
    isNonEmptyString(row.action_id) &&
    isNonEmptyString(row.manifest_id) &&
    isNonEmptyString(row.goal_id) &&
    typeof row.status === 'string' &&
    ACCEPTANCE_STATUS_SET.has(row.status) &&
    isNullableString(row.terminal_reason) &&
    isNullableString(row.bun_run_id) &&
    isNullableString(row.bun_instance_id) &&
    typeof row.confirmed === 'boolean' &&
    Array.isArray(row.criteria) &&
    row.criteria.every(isTrustedAcceptanceCriterion)
  );
}

export function isTrustedManifestSummary(value: unknown): value is TrustedManifestSummary {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    isNonEmptyString(row.manifest_id) &&
    typeof row.registry_version === 'number' &&
    Number.isInteger(row.registry_version) &&
    row.registry_version >= 1 &&
    typeof row.schema_version === 'number' &&
    Number.isInteger(row.schema_version) &&
    isHex64(row.content_hash) &&
    isNonEmptyString(row.agent_id) &&
    typeof row.project_root === 'string' &&
    (row.action_id === null ||
      row.action_id === undefined ||
      typeof row.action_id === 'string') &&
    isNonEmptyString(row.created_at) &&
    isNonEmptyString(row.updated_at)
  );
}

/** Sorted acceptance criterion keys declared by a registered manifest. */
export function manifestAcceptanceKeys(manifest: TrustedManifestSummary): string[] {
  const content = manifest.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return [];
  const acceptance = (content as Record<string, unknown>).acceptance;
  if (!acceptance || typeof acceptance !== 'object' || Array.isArray(acceptance)) return [];
  return Object.keys(acceptance as Record<string, unknown>).slice().sort();
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
