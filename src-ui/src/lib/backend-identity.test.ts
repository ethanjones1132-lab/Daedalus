import { describe, expect, it } from 'vitest';
import type { JarvisConfig } from '../domain/types';
import { backendDisplayName, backendLabels } from './backend-identity';

const config = (over: Record<string, unknown>): JarvisConfig =>
  ({
    active_backend: 'llama_cpp',
    ollama: { model: 'ollama-model' },
    llama_cpp: { model: 'local.gguf' },
    openrouter: { model: 'cloud-model' },
    claude_cli: { model: 'sonnet' },
    ...over,
  }) as unknown as JarvisConfig;

describe('backendDisplayName', () => {
  it('names the engine for each known backend', () => {
    expect(backendDisplayName('llama_cpp')).toBe('llama.cpp');
    expect(backendDisplayName('ollama')).toBe('Ollama');
    expect(backendDisplayName('openrouter')).toBe('OpenRouter');
    expect(backendDisplayName('claude_cli')).toBe('Claude CLI');
  });

  it('reports an unknown backend as unknown, never as Ollama', () => {
    for (const value of ['mystery', '', null, undefined, 42]) {
      expect(backendDisplayName(value)).toBe('unknown backend');
    }
  });
});

describe('backendLabels', () => {
  it('names the configured llama.cpp engine and its model', () => {
    expect(backendLabels(config({}))).toEqual({
      backendLabel: 'llama.cpp',
      modelLabel: 'local.gguf',
    });
  });

  it('names Ollama and the configured model', () => {
    expect(backendLabels(config({ active_backend: 'ollama' }))).toEqual({
      backendLabel: 'Ollama',
      modelLabel: 'ollama-model',
    });
  });

  it('keeps a blank model blank instead of inventing an alias', () => {
    expect(backendLabels(config({ llama_cpp: { model: '' } }))).toEqual({
      backendLabel: 'llama.cpp',
      modelLabel: '',
    });
    expect(backendLabels(config({ llama_cpp: {} }))).toEqual({
      backendLabel: 'llama.cpp',
      modelLabel: '',
    });
  });

  it('does not guess a backend from an unknown active_backend value', () => {
    expect(backendLabels(config({ active_backend: 'mystery' }))).toEqual({
      backendLabel: 'unknown backend',
      modelLabel: '',
    });
  });

  it('reports a null config as an unconfirmed backend, not Ollama', () => {
    expect(backendLabels(null)).toEqual({ backendLabel: 'unknown backend', modelLabel: '' });
  });
});
