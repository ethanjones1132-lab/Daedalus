import { describe, expect, it } from 'vitest';
import {
  decodeMemoryRecallResults,
  filterMemoriesByTier,
  getMemoryTier,
} from './memory-recall-state';

const nativeEntry = (overrides: Record<string, unknown> = {}) => ({
  id: 'memory-1',
  title: 'Native title',
  content: 'Native content',
  tags: '["one","two"]',
  category: 'project',
  created_at: '2026-09-20T10:00:00Z',
  updated_at: '2026-09-21T10:00:00Z',
  relevance_score: 0.4,
  agent_id: 'agent-1',
  source: 'operator',
  source_session_id: 'session-1',
  source_message_ids: '["message-1"]',
  confidence: 0.8,
  last_used_at: null,
  usage_count: 2,
  expires_at: null,
  review_after: null,
  status: 'active',
  supersedes_id: null,
  metadata: JSON.stringify({ tier: 'cold', private_note: 'not rendered' }),
  tier: 'warm',
  drive_file_id: null,
  summary: 'Native summary',
  archived_at: null,
  updated_at_ms: 123456,
  ...overrides,
});

const recall = (memory: Record<string, unknown> = nativeEntry()) => ({
  memory,
  score: 0.92,
  matched_terms: ['native'],
});

describe('memory recall decoding', () => {
  it('decodes the Native recall envelope without replacing the memory relevance score', () => {
    const memory = nativeEntry();

    expect(decodeMemoryRecallResults([recall(memory)])).toEqual([memory]);
  });

  it('accepts a successful empty recall result', () => {
    expect(decodeMemoryRecallResults([])).toEqual([]);
  });

  it.each([
    null,
    {},
    [nativeEntry()],
    [{}],
    [{ ...recall(), memory: null }],
    [{ ...recall(), score: 'high' }],
    [{ ...recall(), matched_terms: ['ok', 2] }],
    [{ ...recall(), memory: { ...nativeEntry(), id: 42 } }],
  ])('rejects malformed recall data instead of claiming an empty result: %j', (value) => {
    expect(() => decodeMemoryRecallResults(value)).toThrow('Invalid memory recall response');
  });
});

describe('memory tier decoding', () => {
  it('uses the explicit Native tier and ignores contradictory metadata', () => {
    expect(getMemoryTier(nativeEntry({ tier: 'cold', metadata: JSON.stringify({ tier: 'hot' }) }))).toBe('cold');
  });

  it.each(['hot', 'warm', 'cold'] as const)('recognizes the explicit %s tier', (tier) => {
    expect(getMemoryTier(nativeEntry({ tier }))).toBe(tier);
  });

  it('does not classify missing or unknown tiers as hot', () => {
    expect(getMemoryTier(nativeEntry({ tier: undefined }))).toBeNull();
    expect(getMemoryTier(nativeEntry({ tier: 'archive' }))).toBeNull();
  });

  it('filters only entries with the requested explicit tier', () => {
    const memories = [
      nativeEntry({ id: 'hot', tier: 'hot' }),
      nativeEntry({ id: 'warm', tier: 'warm' }),
      nativeEntry({ id: 'unknown', tier: 'archive' }),
      nativeEntry({ id: 'missing', tier: undefined }),
    ];

    expect(filterMemoriesByTier(memories, 'hot').map((memory) => memory.id)).toEqual(['hot']);
    expect(filterMemoriesByTier(memories, 'warm').map((memory) => memory.id)).toEqual(['warm']);
    expect(filterMemoriesByTier(memories, 'cold')).toEqual([]);
    expect(filterMemoriesByTier(memories, 'all')).toEqual(memories);
  });
});
