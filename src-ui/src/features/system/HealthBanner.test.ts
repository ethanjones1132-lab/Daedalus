import { describe, expect, it } from 'vitest';
import { deriveHealthPresentation, STARTUP_GRACE_MS } from './HealthBanner';
import type { JarvisStatus } from '../../domain/types';

const healthyOpenRouter: JarvisStatus = {
  ollama_running: false,
  model_available: false,
  bun_server_running: true,
  bun_server_url: 'http://127.0.0.1:19877',
  claude_proxy_running: false,
  bridge_active: true,
  bridge_port: 19879,
  bun_available: true,
  active_backend: 'openrouter',
  model: 'openrouter/free',
  openrouter_key_set: true,
};

describe('HealthBanner startup presentation', () => {
  it('labels an initial Bun miss as starting during the bounded grace window', () => {
    expect(deriveHealthPresentation(
      { ...healthyOpenRouter, bun_server_running: false },
      null,
      STARTUP_GRACE_MS - 1,
    )).toMatchObject({
      level: 'starting',
      label: 'Starting',
      summary: 'Starting Bun server — tools and skills are warming up',
    });
  });

  it('becomes degraded only after the startup grace window expires', () => {
    expect(deriveHealthPresentation(
      { ...healthyOpenRouter, bun_server_running: false },
      null,
      STARTUP_GRACE_MS + 1,
    )).toMatchObject({ level: 'warn', label: 'Degraded' });
  });

  it('stays hidden when the active backend and Bun server are ready', () => {
    expect(deriveHealthPresentation(healthyOpenRouter, null, 0).level).toBe('ok');
  });
});

describe('HealthBanner unavailable observations', () => {
  it('does not infer backend failure from a failed observation, even during startup', () => {
    for (const openrouter_key_set of [true, false]) {
      expect(deriveHealthPresentation(
        { ...healthyOpenRouter, openrouter_key_set },
        'Status check failed',
        0,
      )).toMatchObject({
        level: 'unavailable', label: 'Unavailable', summary: 'Health observation is unavailable.',
      });
    }
  });
});

describe('HealthBanner partial native payload', () => {
  it('tolerates a missing bun_server_running section (partial jarvis_check_status)', () => {
    // Partial answer from native surface: active_backend present, rest undefined
    const partial = { active_backend: 'ollama' } as JarvisStatus;
    // Nothing is confirmed yet, so the first observation is Starting, not Offline.
    expect(deriveHealthPresentation(partial, null, 0).level).toBe('starting');
    const res = deriveHealthPresentation(partial, null, STARTUP_GRACE_MS + 1);
    expect(res.level).toBe('down');
    // Partial payload: backend identified, no crash; the verdict names it
    expect(res.summary).toContain('ollama');
  });
});

// llama.cpp is the DEFAULT Inference backend (CONTEXT.md). `backendOk` used to
// know only ollama / openrouter / claude_cli, so a healthy llama.cpp install
// read "Offline" forever.
describe('HealthBanner llama_cpp backend', () => {
  const llamaCpp: JarvisStatus = {
    ...healthyOpenRouter,
    active_backend: 'llama_cpp',
    openrouter_key_set: false,
    ollama_running: false,
    model_available: true, // Native's constant for every non-Ollama backend
    llama_cpp_running: true,
    model: 'gemma-4-26B-A4B-it-IQ2_M.gguf',
  };

  it('is ready when the llama.cpp server is running, regardless of Ollama or the OpenRouter key', () => {
    expect(deriveHealthPresentation(llamaCpp, null, 0)).toMatchObject({
      level: 'ok', label: 'Ready', summary: 'All systems ready',
    });
  });

  it('reads Starting, not Offline, while a stopped llama.cpp server may still be loading', () => {
    expect(deriveHealthPresentation({ ...llamaCpp, llama_cpp_running: false }, null, 0)).toMatchObject({
      level: 'starting',
      label: 'Starting',
      summary: 'The local model is still loading — the Inference backend is starting up',
    });
  });

  it('reads Offline, naming the backend, when the llama.cpp server is still stopped after the grace', () => {
    expect(deriveHealthPresentation(
      { ...llamaCpp, llama_cpp_running: false },
      null,
      STARTUP_GRACE_MS + 1,
    )).toMatchObject({
      level: 'down', label: 'Offline', summary: 'Backend "llama_cpp" is unreachable',
    });
  });

  it('never reads a missing llama_cpp_running flag as running', () => {
    const { llama_cpp_running: _omit, ...withoutFlag } = llamaCpp;
    expect(deriveHealthPresentation(withoutFlag as JarvisStatus, null, 0).level).toBe('starting');
    expect(deriveHealthPresentation(withoutFlag as JarvisStatus, null, STARTUP_GRACE_MS + 1).level).toBe('down');
  });

  it('still honours the Bun grace window under llama_cpp', () => {
    const noBun = { ...llamaCpp, bun_server_running: false };
    expect(deriveHealthPresentation(noBun, null, STARTUP_GRACE_MS - 1).level).toBe('starting');
    expect(deriveHealthPresentation(noBun, null, STARTUP_GRACE_MS + 1).level).toBe('warn');
  });
});
