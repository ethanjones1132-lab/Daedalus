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
