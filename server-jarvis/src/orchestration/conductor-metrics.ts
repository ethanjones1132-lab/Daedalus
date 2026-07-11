/** Track A: conductor KV / prefix reuse observability. */

export interface ConductorCacheRecord {
  ts: number;
  session_id: string;
  turn_number: number;
  model: string;
  latency_ms: number;
  ok: boolean;
  conductor_cache_hit: boolean;
  prefix_tokens_estimated: number;
  delta_tokens_estimated: number;
  prefix_tokens_recomputed: number;
  kv_generation: number;
}

export interface ConductorDirectiveRecord {
  ts: number;
  session_id: string;
  stage: string;
  directive_type: string;
  reason?: string;
  new_remaining?: string[];
  inject_for_stage?: string;
}

const RING_SIZE = 100;
const ring: ConductorCacheRecord[] = [];
let ringHead = 0;

const directiveRing: ConductorDirectiveRecord[] = [];
let directiveRingHead = 0;

export function recordConductorCache(rec: ConductorCacheRecord): void {
  ring[ringHead % RING_SIZE] = rec;
  ringHead += 1;
}

export function recordConductorDirective(rec: ConductorDirectiveRecord): void {
  directiveRing[directiveRingHead % RING_SIZE] = rec;
  directiveRingHead += 1;
}

export function conductorCacheSnapshot(): {
  window_size: number;
  cache_hit_rate: number;
  avg_prefix_recomputed: number;
  records: ConductorCacheRecord[];
  generated_at: number;
} {
  const records = ringHead < RING_SIZE ? ring.slice(0, ringHead) : [
    ...ring.slice(ringHead % RING_SIZE),
    ...ring.slice(0, ringHead % RING_SIZE),
  ];
  const hits = records.filter((r) => r.conductor_cache_hit).length;
  const prefixSum = records.reduce((s, r) => s + r.prefix_tokens_recomputed, 0);
  return {
    window_size: records.length,
    cache_hit_rate: records.length ? hits / records.length : 0,
    avg_prefix_recomputed: records.length ? prefixSum / records.length : 0,
    records: records.slice(-20),
    generated_at: Date.now(),
  };
}

export function conductorDirectiveSnapshot(): {
  window_size: number;
  by_type: Record<string, number>;
  records: ConductorDirectiveRecord[];
  generated_at: number;
} {
  const records = directiveRingHead < RING_SIZE
    ? directiveRing.slice(0, directiveRingHead)
    : [
        ...directiveRing.slice(directiveRingHead % RING_SIZE),
        ...directiveRing.slice(0, directiveRingHead % RING_SIZE),
      ];
  const byType: Record<string, number> = {};
  for (const rec of records) {
    byType[rec.directive_type] = (byType[rec.directive_type] ?? 0) + 1;
  }
  return {
    window_size: records.length,
    by_type: byType,
    records: records.slice(-20),
    generated_at: Date.now(),
  };
}

export function __resetConductorCacheMetricsForTests(): void {
  ring.length = 0;
  ringHead = 0;
}

export function __resetConductorDirectiveMetricsForTests(): void {
  directiveRing.length = 0;
  directiveRingHead = 0;
}

/** Rough token estimate (matches pipeline stage accounting). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}