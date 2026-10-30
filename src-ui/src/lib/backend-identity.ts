// ═══════════════════════════════════════════════════════════════
// ── backend-identity — one name for the configured Inference route
// ═══════════════════════════════════════════════════════════════
//
// The header, the empty-Session line, Settings, and the Inference hero all
// describe the same thing: the `active_backend` and model in `jarvis_get_config`.
// Each surface used to carry its own vocabulary, and the surfaces that named a
// product (rather than the engine) drifted away from the configured default —
// the audit's "header names a model that is neither the configured alias nor the
// running engine" signature.
//
// This module is the one formatter: it names the *engine* (`llama.cpp`,
// `Ollama`, `OpenRouter`, `Claude CLI`) and prints the configured model beside
// it, never a hard-coded product. A backend value this build does not know is
// reported as "unknown backend" — an unknown value must never masquerade as
// Ollama, which is a real, different engine.

import type { JarvisConfig } from '../domain/types';

/** Display name for an Inference backend id. Unknown ids are never guessed. */
export function backendDisplayName(id: unknown): string {
  switch (id) {
    case 'llama_cpp':
      return 'llama.cpp';
    case 'ollama':
      return 'Ollama';
    case 'openrouter':
      return 'OpenRouter';
    case 'claude_cli':
      return 'Claude CLI';
    default:
      return 'unknown backend';
  }
}

export interface BackendIdentity {
  backendLabel: string;
  modelLabel: string;
}

/**
 * Human label of the configured Inference backend and its model. Defensive
 * against a partial or malformed config payload: a surface must render even
 * when `jarvis_get_config` returns something unexpected, and an absent or
 * unparsable payload is reported as an unconfirmed backend, not as Ollama.
 */
export function backendLabels(config: JarvisConfig | null): BackendIdentity {
  if (!config) return { backendLabel: backendDisplayName(null), modelLabel: '' };
  const backend = config.active_backend;
  const rawModel =
    backend === 'ollama'
      ? config.ollama?.model
      : backend === 'llama_cpp'
        ? config.llama_cpp?.model
        : backend === 'claude_cli'
          ? (config.claude_cli?.model ?? '')
          : backend === 'openrouter'
            ? config.openrouter?.model
            : undefined;
  return {
    backendLabel: backendDisplayName(backend),
    modelLabel: typeof rawModel === 'string' ? rawModel : '',
  };
}
