import type { DiscoveredModel } from './types';

/** One native discovery command per Inference backend source. */
export type DiscoverySource = 'ollama' | 'openrouter';

export const DISCOVERY_COMMANDS: Record<DiscoverySource, string> = {
  ollama: 'discover_models_ollama',
  openrouter: 'discover_models_openrouter',
};

export function isDiscoveredModel(value: unknown): value is DiscoveredModel {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.provider === 'string';
}

/**
 * Identity of a discovered row. The same model can arrive from more than one
 * source (the Bun proxy, a direct Ollama read, a direct OpenRouter read), so
 * provider plus id is the dedupe key.
 */
function discoveredModelKey(model: DiscoveredModel): string {
  return `${model.provider}/${model.id}`;
}

/** Union of what was already discovered and a new run's models, first occurrence wins. */
export function mergeDiscoveredModels(current: DiscoveredModel[], incoming: DiscoveredModel[]): DiscoveredModel[] {
  const seen = new Set(current.map(discoveredModelKey));
  const merged = [...current];
  for (const model of incoming) {
    const key = discoveredModelKey(model);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(model);
  }
  return merged;
}

/** Validate a native discovery payload; anything but an array of models is a failed read. */
export function decodeDiscoveredModels(payload: unknown): DiscoveredModel[] {
  if (!Array.isArray(payload)) throw new Error('Unexpected discovery payload');
  return payload.filter(isDiscoveredModel);
}
