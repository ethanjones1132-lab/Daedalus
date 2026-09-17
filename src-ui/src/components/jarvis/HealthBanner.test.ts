import { describe, expect, it } from 'vitest';
import { deriveHealthPresentation, STARTUP_GRACE_MS } from './HealthBanner';
import type { JarvisStatus } from './types';

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
    const res = deriveHealthPresentation(partial, null, 0);
    expect(res.level).toBe('down');
    // Partial payload: backend identified, no crash; guard delivers degraded summary
    expect(res.summary).toContain('ollama');
  });
});
