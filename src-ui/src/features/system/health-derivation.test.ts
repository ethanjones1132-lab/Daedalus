import { describe, expect, it } from 'vitest';
import { deriveHealthPresentation, markStalePresentation, STARTUP_GRACE_MS } from './health-derivation';
import type { JarvisStatus } from '../../domain/types';

const healthy: JarvisStatus = {
  ollama_running: false,
  model_available: false,
  bun_server_running: true,
  bun_server_url: 'http://127.0.0.1:19877',
  claude_proxy_running: false,
  bridge_active: true,
  bridge_port: 19876,
  bun_available: true,
  active_backend: 'llama_cpp',
  llama_cpp_running: true,
  model: 'qwen.gguf',
  openrouter_key_set: false,
};

describe('masthead bridge truthfulness', () => {
  it('never reads "All systems ready" while an enabled bridge is down', () => {
    const down = { ...healthy, bridge_active: false };
    const presentation = deriveHealthPresentation(down, null, STARTUP_GRACE_MS + 1);
    expect(presentation.level).toBe('warn');
    expect(presentation.summary).toContain('External Agent bridge');
    expect(presentation.summary).toContain('unaffected');
  });

  it('treats a disabled bridge as no fault at all', () => {
    const disabledDown = { ...healthy, bridge_active: false, bridge_enabled: false };
    expect(deriveHealthPresentation(disabledDown, null, 0)).toMatchObject({
      level: 'ok', label: 'Ready', summary: 'All systems ready',
    });
  });

  it('reads an omitted bridge flag as enabled, matching the gauge relay', () => {
    const { bridge_enabled: _omit, ...olderNative } = healthy;
    expect(deriveHealthPresentation({ ...olderNative, bridge_active: false }, null, 0).level).toBe('warn');
  });

  it('keeps a backend verdict above the bridge warning', () => {
    const backendAndBridgeDown = { ...healthy, bridge_active: false, llama_cpp_running: false };
    expect(deriveHealthPresentation(backendAndBridgeDown, null, 0).level).toBe('down');
  });
});

describe('stale health snapshot presentation', () => {
  it('strips the plain ready label and names the staleness', () => {
    const fresh = deriveHealthPresentation(healthy, null, 0);
    const stale = markStalePresentation(fresh);
    expect(stale.level).toBe('warn');
    expect(stale.label).toBe('Ready (stale)');
    expect(stale.summary).toContain('may be stale');
    expect(stale.summary.startsWith(fresh.summary));
  });

  it('keeps an existing fault level but still marks the observation stale', () => {
    const down = deriveHealthPresentation({ ...healthy, llama_cpp_running: false }, null, 0);
    const stale = markStalePresentation(down);
    expect(stale.level).toBe('down');
    expect(stale.label).toBe('Offline (stale)');
  });
});
