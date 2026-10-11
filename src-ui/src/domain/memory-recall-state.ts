export type Tier = 'hot' | 'warm' | 'cold';

export interface MemoryEntry {
  id: string;
  title: string;
  content: string;
  tags: string;
  category: string;
  created_at: string;
  updated_at: string;
  relevance_score: number;
  agent_id: string;
  source: string;
  source_session_id?: string | null;
  source_message_ids: string;
  confidence: number;
  last_used_at?: string | null;
  usage_count: number;
  expires_at?: string | null;
  review_after?: string | null;
  status: string;
  supersedes_id?: string | null;
  metadata?: string | null;
  tier?: Tier | string | null;
  drive_file_id?: string | null;
  summary?: string;
  archived_at?: string | null;
  updated_at_ms?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || value === undefined || typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (!isRecord(value)) return false;
  const requiredStrings = ['id', 'title', 'content', 'tags', 'category', 'created_at', 'updated_at', 'agent_id', 'source', 'source_message_ids', 'status'];
  if (!requiredStrings.every((key) => typeof value[key] === 'string')) return false;
  if (!isFiniteNumber(value.relevance_score) || !isFiniteNumber(value.confidence) || !isFiniteNumber(value.usage_count)) return false;
  if (!isNullableString(value.source_session_id) || !isNullableString(value.last_used_at)
    || !isNullableString(value.expires_at) || !isNullableString(value.review_after)
    || !isNullableString(value.supersedes_id) || !isNullableString(value.metadata)) return false;
  if (value.tier !== undefined && value.tier !== null && typeof value.tier !== 'string') return false;
  if (value.drive_file_id !== undefined && value.drive_file_id !== null && typeof value.drive_file_id !== 'string') return false;
  if (value.summary !== undefined && typeof value.summary !== 'string') return false;
  if (value.archived_at !== undefined && value.archived_at !== null && typeof value.archived_at !== 'string') return false;
  if (value.updated_at_ms !== undefined && !isFiniteNumber(value.updated_at_ms)) return false;
  return true;
}

function isRecall(value: unknown): value is { memory: MemoryEntry; score: number; matched_terms: string[] } {
  if (!isRecord(value) || !isMemoryEntry(value.memory) || !isFiniteNumber(value.score)) return false;
  return Array.isArray(value.matched_terms) && value.matched_terms.every((term) => typeof term === 'string');
}

export function decodeMemoryRecallResults(value: unknown): MemoryEntry[] {
  if (!Array.isArray(value) || !value.every(isRecall)) {
    throw new Error('Invalid memory recall response');
  }
  return value.map((result) => result.memory);
}

export function getMemoryTier(entry: Pick<MemoryEntry, 'tier'>): Tier | null {
  return entry.tier === 'hot' || entry.tier === 'warm' || entry.tier === 'cold' ? entry.tier : null;
}

export function filterMemoriesByTier(memories: readonly MemoryEntry[], tier: Tier | 'all'): MemoryEntry[] {
  if (tier === 'all') return [...memories];
  return memories.filter((memory) => getMemoryTier(memory) === tier);
}
