import { describe, expect, it } from 'vitest';
import type { JarvisConfig, RoutingStage, StageTarget } from '../../domain/types';
import { moveFallback, setStageFallbacks, setStagePrimary } from './orchestration-draft';

const initial = {
  active_backend: 'llama_cpp',
  llama_cpp: { model: 'serving-alias.gguf' },
  orchestrator: {
    enabled: true,
    unknown_future_field: { keep: true },
    stage_models: { planner: { provider: 'ollama', model: 'old/model:tag' } },
    fallback_chains: { planner: [{ provider: 'ollama', model: 'fallback:one' }] },
  },
} as unknown as JarvisConfig;

describe('orchestration draft helpers', () => {
  it('writes Automatic as an explicit reset and preserves unknown config fields', () => {
    const reset = setStagePrimary(initial, 'planner', 'automatic');
    expect(reset.orchestrator.stage_models?.planner).toBe('automatic');
    expect(reset.orchestrator.unknown_future_field).toEqual({ keep: true });
  });

  it('preserves provider and full model IDs, including slashes and colons', () => {
    const target: StageTarget = { provider: 'ollama', model: 'org/model:tag' };
    const updated = setStagePrimary(initial, 'planner', target);
    expect(updated.orchestrator.stage_models?.planner).toEqual(target);
  });

  it('keeps an empty custom fallback chain empty and reorders targets without changing identity', () => {
    const empty = setStageFallbacks(initial, 'planner', []);
    expect(empty.orchestrator.fallback_chains?.planner).toEqual([]);
    const ordered = setStageFallbacks(initial, 'planner', [
      { provider: 'ollama', model: 'first/model:tag' },
      { provider: 'vllm', model: 'second/model' },
    ]);
    const reordered = moveFallback(ordered, 'planner', 0, 1);
    expect(reordered.orchestrator.fallback_chains?.planner).toEqual([
      { provider: 'vllm', model: 'second/model' },
      { provider: 'ollama', model: 'first/model:tag' },
    ]);
  });

  it('supports every declared stage key', () => {
    const stages: RoutingStage[] = ['coordinator', 'planner', 'executor', 'reviewer', 'rewriter', 'synthesizer'];
    for (const stage of stages) {
      expect(setStagePrimary(initial, stage, 'automatic').orchestrator.stage_models?.[stage]).toBe('automatic');
    }
  });
});
