// ═══════════════════════════════════════════════════════════════
// Memory operator-control wire decoding and mutation state
// ═══════════════════════════════════════════════════════════════
//
// Phase 4.1. Mirrors the native scoped wire contracts in
// `src-tauri/src/jarvis/memory/{contracts,capture_contracts}.rs` and
// `server-jarvis/src/memory-contract.ts`. Decoders preserve nested scope,
// authority, provenance, classification, lifecycle, and revision fields.
// A missing response classification is compatible as `unknown`; a malformed
// supplied classification is an unavailable/error, never a silent success.

import type { MemoryEntry } from './memory-recall-state';

export type MemoryStatementKind = 'normative_constraint' | 'descriptive_fact' | 'unknown';

export const MEMORY_STATEMENT_KINDS: readonly MemoryStatementKind[] = [
  'normative_constraint',
  'descriptive_fact',
  'unknown',
];

export type WritableScopeKind = 'project' | 'agent' | 'user';

export type AuthorityKind =
  | 'manual'
  | 'user_statement'
  | 'verified_observation'
  | 'assistant_proposal'
  | 'legacy_unknown';

export interface ScopeSelector {
  kind: WritableScopeKind;
}

export type MemoryScopeKind = 'project' | 'agent' | 'user' | 'legacy_unscoped';

export interface MemoryScope {
  kind: MemoryScopeKind;
  agent_id: string;
  project_root: string | null;
}

export interface ScopedMemoryEntry {
  entry: MemoryEntry;
  scope: MemoryScope;
  authority_kind: AuthorityKind;
  statement_kind: MemoryStatementKind;
  source_run_id: string | null;
  verified_at: string | null;
  revision: number;
}

export interface ScopedMemoryRecall {
  memory: ScopedMemoryEntry;
  score: number;
  matched_terms: string[];
  stale: boolean;
}

export interface RecallPreview {
  scope: MemoryScope;
  store_revision: number;
  entries: ScopedMemoryRecall[];
}

export interface MutationResult {
  memory: ScopedMemoryEntry;
  store_revision: number;
  changed: boolean;
}

export interface CorrectionResult {
  previous: ScopedMemoryEntry;
  replacement: ScopedMemoryEntry;
  store_revision: number;
  changed: boolean;
}

export interface ForgetResult {
  memory: ScopedMemoryEntry;
  store_revision: number;
  changed: boolean;
  suppressed_message_ids: string[];
}

export interface MemoryDraft {
  title: string;
  content: string;
  tags: string[];
  category: string;
  expires_at: string | null;
  review_after: string | null;
}

/** Identity captured at submission so a late result cannot cross Session/scope. */
export interface MemoryControlTarget {
  session_id: string;
  selector: ScopeSelector;
  id: string;
  expected_revision: number;
}

export type MemoryMutationState =
  | { state: 'idle' }
  | { state: 'pending'; target: MemoryControlTarget | null; operation_id: string | null }
  | { state: 'confirmed'; result: MutationResult | CorrectionResult | ForgetResult }
  | { state: 'unavailable'; message: string };

export const IDLE_MUTATION_STATE: MemoryMutationState = { state: 'idle' };

const SCOPE_KINDS = new Set<string>(['project', 'agent', 'user', 'legacy_unscoped']);
const STATEMENT_KINDS = new Set<string>(MEMORY_STATEMENT_KINDS);
export const AUTHORITY_KINDS = new Set<string>([
  'manual',
  'user_statement',
  'verified_observation',
  'assistant_proposal',
  'legacy_unknown',
]);
const ENTRY_REQUIRED_STRINGS = [
  'id',
  'title',
  'content',
  'tags',
  'category',
  'created_at',
  'updated_at',
  'agent_id',
  'source',
  'source_message_ids',
  'status',
  'tier',
  'summary',
] as const;
const ENTRY_FINITE_NUMBERS = [
  'relevance_score',
  'confidence',
  'usage_count',
  'updated_at_ms',
] as const;
// Frozen nullable fields are serialized by the Rust contract as explicit
// `null` or a string; a missing field is malformed, not an implicit null.
const ENTRY_REQUIRED_NULLABLE_STRINGS = [
  'source_session_id',
  'last_used_at',
  'expires_at',
  'review_after',
  'supersedes_id',
  'metadata',
  'drive_file_id',
  'archived_at',
] as const;
const ENTRY_STRING_ARRAYS = ['tags', 'source_message_ids'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Present and either a string or an explicit null; missing is rejected. */
function isPresentNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

/** True only for a string that parses to a JSON array of strings. */
function isJsonStringArray(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string');
  } catch {
    return false;
  }
}

function decodeStatementKind(value: unknown): MemoryStatementKind {
  // Only a MISSING field is legacy-compatible as `unknown`. An explicit
  // `null` (or any other non-kind value) is malformed.
  if (value === undefined) return 'unknown';
  if (typeof value === 'string' && STATEMENT_KINDS.has(value)) {
    return value as MemoryStatementKind;
  }
  throw new Error('Invalid memory statement classification');
}

function decodeAuthorityKind(value: unknown): AuthorityKind {
  if (typeof value !== 'string' || !AUTHORITY_KINDS.has(value)) {
    throw new Error('Invalid scoped memory authority');
  }
  return value as AuthorityKind;
}

/**
 * Validate the full existing `MemoryEntry` DTO. Required strings (including
 * `tier`/`summary`), finite numeric counters (including `updated_at_ms`),
 * explicitly present nullable lifecycle/provenance strings, and valid
 * JSON-array-of-strings `tags`/`source_message_ids` are all checked. A missing
 * serialized field is malformed and becomes unavailable, not an implicit null.
 */
function decodeMemoryEntry(value: unknown): MemoryEntry {
  if (!isRecord(value)) throw new Error('Invalid memory entry');
  if (!ENTRY_REQUIRED_STRINGS.every((key) => typeof value[key] === 'string')) {
    throw new Error('Invalid memory entry identity fields');
  }
  if (!ENTRY_FINITE_NUMBERS.every((key) => isFiniteNumber(value[key]))) {
    throw new Error('Invalid memory entry numeric fields');
  }
  for (const key of ENTRY_REQUIRED_NULLABLE_STRINGS) {
    if (!isPresentNullableString(value[key])) {
      throw new Error(`Invalid memory entry nullable field ${key}`);
    }
  }
  for (const key of ENTRY_STRING_ARRAYS) {
    if (!isJsonStringArray(value[key])) {
      throw new Error(`Invalid memory entry string array ${key}`);
    }
  }
  return value as unknown as MemoryEntry;
}

function decodeScope(value: unknown): MemoryScope {
  if (!isRecord(value)) throw new Error('Invalid memory scope');
  if (typeof value.kind !== 'string' || !SCOPE_KINDS.has(value.kind)) {
    throw new Error('Invalid memory scope kind');
  }
  if (typeof value.agent_id !== 'string') {
    throw new Error('Invalid memory scope agent identity');
  }
  // `project_root` is part of the frozen wire shape: it must be explicitly
  // present and either a string or null. A missing field is malformed.
  if (!('project_root' in value)) {
    throw new Error('Invalid memory scope project root');
  }
  if (value.project_root !== null && typeof value.project_root !== 'string') {
    throw new Error('Invalid memory scope project root');
  }
  return {
    kind: value.kind as MemoryScopeKind,
    agent_id: value.agent_id,
    project_root: value.project_root as string | null,
  };
}

export function decodeScopedMemoryEntry(value: unknown): ScopedMemoryEntry {
  if (!isRecord(value)) throw new Error('Invalid scoped memory entry');
  if (!isFiniteNumber(value.revision)) throw new Error('Invalid scoped memory revision');
  // `source_run_id`/`verified_at` are serialized by the frozen contract as
  // explicit null or string; a missing field is malformed.
  if (
    !('source_run_id' in value) ||
    !isPresentNullableString(value.source_run_id) ||
    !('verified_at' in value) ||
    !isPresentNullableString(value.verified_at)
  ) {
    throw new Error('Invalid scoped memory provenance');
  }
  return {
    entry: decodeMemoryEntry(value.entry),
    scope: decodeScope(value.scope),
    authority_kind: decodeAuthorityKind(value.authority_kind),
    statement_kind: decodeStatementKind(value.statement_kind),
    source_run_id: value.source_run_id as string | null,
    verified_at: value.verified_at as string | null,
    revision: value.revision,
  };
}

export function decodeScopedMemoryEntries(value: unknown): ScopedMemoryEntry[] {
  if (!Array.isArray(value)) throw new Error('Invalid scoped memory list');
  return value.map(decodeScopedMemoryEntry);
}

/**
 * Legacy (unscoped) `memory_list` record: the frozen `MemoryEntry` fields plus
 * the authoritative SQL row revision. `revision` is a required positive integer;
 * a missing/invalid/nonpositive value is never guessed.
 */
export interface LegacyMemoryEntry {
  entry: MemoryEntry;
  revision: number;
}

/** Strict positive-integer revision decoder; anything else is unavailable. */
export function decodeLegacyRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Legacy memory revision unavailable');
  }
  return value;
}

export function decodeLegacyMemoryEntry(value: unknown): LegacyMemoryEntry {
  const entry = decodeMemoryEntry(value);
  if (!isRecord(value)) throw new Error('Invalid legacy memory entry');
  return { entry, revision: decodeLegacyRevision(value.revision) };
}

/**
 * Per-record legacy listing: a malformed or revision-less record is preserved
 * as `unavailable` and is never adoptable, instead of guessing a revision or
 * discarding the whole list.
 */
export type LegacyMemoryListing =
  | { status: 'available'; id: string; entry: MemoryEntry; revision: number }
  | { status: 'unavailable'; id: string; entry: MemoryEntry | null; reason: string };

export function decodeLegacyMemoryListings(value: unknown): LegacyMemoryListing[] {
  if (!Array.isArray(value)) throw new Error('Invalid legacy memory list');
  return value.map((raw, index) => {
    const fallbackId = `legacy-${index}`;
    if (!isRecord(raw)) {
      return { status: 'unavailable', id: fallbackId, entry: null, reason: 'Unreadable legacy record' };
    }
    const id = typeof raw.id === 'string' && raw.id ? raw.id : fallbackId;
    let entry: MemoryEntry;
    try {
      entry = decodeMemoryEntry(raw);
    } catch {
      return { status: 'unavailable', id, entry: null, reason: 'Unreadable legacy record' };
    }
    try {
      return { status: 'available', id, entry, revision: decodeLegacyRevision(raw.revision) };
    } catch {
      return { status: 'unavailable', id, entry, reason: 'Native revision unavailable' };
    }
  });
}

function decodeScopedRecall(value: unknown): ScopedMemoryRecall {
  if (!isRecord(value)) throw new Error('Invalid scoped recall');
  if (!isFiniteNumber(value.score)) throw new Error('Invalid scoped recall score');
  if (
    !Array.isArray(value.matched_terms) ||
    !value.matched_terms.every((term) => typeof term === 'string')
  ) {
    throw new Error('Invalid scoped recall matched terms');
  }
  if (typeof value.stale !== 'boolean') throw new Error('Invalid scoped recall staleness');
  return {
    memory: decodeScopedMemoryEntry(value.memory),
    score: value.score,
    matched_terms: value.matched_terms,
    stale: value.stale,
  };
}

export function decodeRecallPreview(value: unknown): RecallPreview {
  if (!isRecord(value)) throw new Error('Invalid recall preview');
  if (!isFiniteNumber(value.store_revision)) throw new Error('Invalid recall store revision');
  if (!Array.isArray(value.entries)) throw new Error('Invalid recall preview entries');
  return {
    scope: decodeScope(value.scope),
    store_revision: value.store_revision,
    entries: value.entries.map(decodeScopedRecall),
  };
}

export function decodeMutationResult(value: unknown): MutationResult {
  if (!isRecord(value)) throw new Error('Invalid mutation result');
  if (typeof value.changed !== 'boolean' || !isFiniteNumber(value.store_revision)) {
    throw new Error('Invalid mutation result metadata');
  }
  return {
    memory: decodeScopedMemoryEntry(value.memory),
    store_revision: value.store_revision,
    changed: value.changed,
  };
}

export function decodeCorrectionResult(value: unknown): CorrectionResult {
  if (!isRecord(value)) throw new Error('Invalid correction result');
  if (typeof value.changed !== 'boolean' || !isFiniteNumber(value.store_revision)) {
    throw new Error('Invalid correction result metadata');
  }
  return {
    previous: decodeScopedMemoryEntry(value.previous),
    replacement: decodeScopedMemoryEntry(value.replacement),
    store_revision: value.store_revision,
    changed: value.changed,
  };
}

export function decodeForgetResult(value: unknown): ForgetResult {
  if (!isRecord(value)) throw new Error('Invalid forget result');
  if (typeof value.changed !== 'boolean' || !isFiniteNumber(value.store_revision)) {
    throw new Error('Invalid forget result metadata');
  }
  if (
    !Array.isArray(value.suppressed_message_ids) ||
    !value.suppressed_message_ids.every((id) => typeof id === 'string')
  ) {
    throw new Error('Invalid forget suppression ids');
  }
  return {
    memory: decodeScopedMemoryEntry(value.memory),
    store_revision: value.store_revision,
    changed: value.changed,
    suppressed_message_ids: value.suppressed_message_ids,
  };
}

/** True only when a confirmed native result changed durable state. */
export function confirmedMutationChanged(
  result: MutationResult | CorrectionResult | ForgetResult,
): boolean {
  return result.changed === true;
}

export function memoryControlTarget(
  sessionId: string,
  selector: ScopeSelector,
  entry: Pick<ScopedMemoryEntry, 'entry' | 'revision'>,
): MemoryControlTarget {
  return {
    session_id: sessionId,
    selector,
    id: entry.entry.id,
    expected_revision: entry.revision,
  };
}

export function draftFromEntry(entry: ScopedMemoryEntry): MemoryDraft {
  return {
    title: entry.entry.title,
    content: entry.entry.content,
    tags: safeJsonStringArray(entry.entry.tags),
    category: entry.entry.category,
    expires_at: entry.entry.expires_at ?? null,
    review_after: entry.entry.review_after ?? null,
  };
}

export function safeJsonStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
