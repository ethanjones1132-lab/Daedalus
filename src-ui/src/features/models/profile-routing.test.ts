import { describe, expect, it } from 'vitest';
import type { JarvisConfig } from '../../domain/types';
import { projectRoutingIdentity, projectedProfileBackend } from './profile-routing';
import type { ModelProfile } from './types';

const config = (over: Record<string, unknown> = {}): JarvisConfig =>
  ({
    active_backend: 'llama_cpp',
    ollama: { model: 'ollama-model' },
    llama_cpp: { model: 'local.gguf', base_url: 'http://127.0.0.1:8080/v1' },
    openrouter: { model: 'cloud-model' },
    claude_cli: { model: 'sonnet' },
    ...over,
  }) as unknown as JarvisConfig;

const profile = (over: Partial<ModelProfile> = {}): ModelProfile => ({
  id: 'p1',
  name: 'Local',
  provider: 'llama_cpp',
  model: 'local.gguf',
  api_base: '',
  max_tokens: 4096,
  temperature: 0.7,
  top_p: 1,
  is_active: true,
  engine: 'native',
  ...over,
});

describe('projectedProfileBackend', () => {
  it('projects a CLI profile by its engine, like the Rust writer does', () => {
    expect(projectedProfileBackend(profile({ engine: 'claude_cli', provider: 'openrouter' }))).toBe('claude_cli');
    expect(projectedProfileBackend(profile())).toBe('llama_cpp');
  });
});

describe('projectRoutingIdentity', () => {
  it('reports agreement when the saved profile matches the configured route', () => {
    expect(projectRoutingIdentity(config(), profile())).toEqual({
      observed: true,
      backendLabel: 'llama.cpp',
      modelLabel: 'local.gguf',
      disagrees: false,
    });
  });

  it('reports disagreement when Settings moved the backend away from the profile', () => {
    const identity = projectRoutingIdentity(config({ active_backend: 'ollama' }), profile());
    expect(identity.backendLabel).toBe('Ollama');
    expect(identity.disagrees).toBe(true);
  });

  it('reports disagreement when only the model differs', () => {
    expect(projectRoutingIdentity(config({ llama_cpp: { model: 'other.gguf' } }), profile()).disagrees).toBe(true);
  });

  it('compares a CLI profile against the CLI engine, not its provider column', () => {
    const cliProfile = profile({ engine: 'claude_cli', provider: 'openrouter', model: 'sonnet' });
    expect(projectRoutingIdentity(config({ active_backend: 'claude_cli' }), cliProfile).disagrees).toBe(false);
  });

  it('claims no routing backend when none was observed, and calls no profile wrong', () => {
    expect(projectRoutingIdentity(null, profile())).toEqual({
      observed: false,
      backendLabel: 'unknown backend',
      modelLabel: '',
      disagrees: false,
    });
  });

  it('never calls an unknown active_backend Ollama, and flags the disagreement', () => {
    const identity = projectRoutingIdentity(config({ active_backend: 'mystery' }), profile());
    expect(identity.backendLabel).toBe('unknown backend');
    expect(identity.disagrees).toBe(true);
  });

  it('does not blame a profile when there is none', () => {
    expect(projectRoutingIdentity(config(), null).disagrees).toBe(false);
  });
});
