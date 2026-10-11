/** Mirrors the Rust `ModelProfile` the UI consumes. `api_key` is deliberately absent: it is never read or rendered. */
export interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  api_base: string;
  max_tokens: number;
  temperature: number;
  top_p: number;
  is_active: boolean;
  engine: string;
  created_at?: string;
}

export interface EffectiveRuntimeConfig {
  provider: string;
  model: string;
  source: string;
  applied_at: string;
  restart_required: boolean;
}

/** One entry of `jarvis_discover_models` (the Bun server's GET /models, proxied). */
export interface DiscoveredModel {
  id: string;
  name: string;
  provider: string;
  context_length?: number;
}
