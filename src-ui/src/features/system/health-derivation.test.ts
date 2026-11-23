import { describe, expect, it } from 'vitest';
import { deriveHealthPresentation, markStalePresentation, STARTUP_GRACE_MS } from './health-derivation';
import type { JarvisStatus } from '../../domain/types';
import type { BackendReadiness } from '../../lib/backend-readiness';

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
    // Inside the window that pair is Starting, never a bridge warning and never
    // Offline; past the window the stopped backend still outranks the bridge.
    expect(deriveHealthPresentation(backendAndBridgeDown, null, 0).level).toBe('starting');
    expect(deriveHealthPresentation(backendAndBridgeDown, null, STARTUP_GRACE_MS).level).toBe('down');
  });
});

describe('backend startup grace', () => {
  // A cold start polls immediately, before llama.cpp has loaded the model.
  const stoppedLlama: JarvisStatus = { ...healthy, llama_cpp_running: false };

  it.each([[0], [STARTUP_GRACE_MS - 1]])(
    'reads a stopped llama.cpp backend as Starting at %ims rather than Offline',
    (mountedForMs) => {
      const presentation = deriveHealthPresentation(stoppedLlama, null, mountedForMs);
      expect(presentation.level).toBe('starting');
      expect(presentation.level).not.toBe('down');
      expect(presentation.label).toBe('Starting');
      expect(presentation.summary).toContain('local model');
      expect(presentation.summary).toContain('still loading');
    },
  );

  it('reads Offline, naming the backend, once the grace window has passed', () => {
    expect(deriveHealthPresentation(stoppedLlama, null, STARTUP_GRACE_MS + 1)).toMatchObject({
      level: 'down',
      label: 'Offline',
      summary: 'Backend "llama_cpp" is unreachable',
    });
  });

  it('keeps the Bun-only grace copy when the backend itself is ready', () => {
    const noBun = { ...healthy, bun_server_running: false };
    expect(deriveHealthPresentation(noBun, null, STARTUP_GRACE_MS - 1)).toMatchObject({
      level: 'starting',
      label: 'Starting',
      summary: 'Starting Bun server — tools and skills are warming up',
    });
    expect(deriveHealthPresentation(noBun, null, STARTUP_GRACE_MS + 1).level).toBe('warn');
  });
});

describe('an unusable artifact is its own fault (DD-111)', () => {
  const unreachable: JarvisStatus = { ...healthy, llama_cpp_running: false };
  const missingServer: BackendReadiness = {
    state: 'missing_file',
    backend: 'llama_cpp',
    missing: [
      {
        key: 'llama_cpp.server_path',
        label: 'llama.cpp server_path',
        envVar: 'JARVIS_LLAMA_SERVER_PATH',
        reason: null,
        path: 'C:/tools/llama-server',
      },
    ],
  };

  it('reads Offline naming the setting and path, even inside the startup grace', () => {
    // The path is a filesystem fact, not a timing one: waiting cannot fix it,
    // so the band must never say the backend may still be starting.
    const presentation = deriveHealthPresentation(unreachable, null, 0, missingServer);

    expect(presentation.level).toBe('down');
    expect(presentation.label).toBe('Offline');
    expect(presentation.summary).toContain('cannot start');
    expect(presentation.summary).toContain('llama.cpp server_path');
    expect(presentation.summary).toContain('C:/tools/llama-server');
    expect(presentation.summary).not.toContain('still loading');
    expect(presentation.summary).not.toContain('starting up');
  });

  it('keeps the ordinary startup grace for a blank setting', () => {
    const blank: BackendReadiness = {
      state: 'missing_config',
      backend: 'llama_cpp',
      missing: [
        {
          key: 'llama_cpp.server_path',
          label: 'llama.cpp server_path',
          envVar: 'JARVIS_LLAMA_SERVER_PATH',
          reason: null,
          path: null,
        },
      ],
    };

    expect(deriveHealthPresentation(unreachable, null, 0, blank)).toMatchObject({
      level: 'starting',
      summary: 'The local model is still loading — the Inference backend is starting up',
    });
  });

  it('still reads Ready when the port already answers', () => {
    // Boot returns AlreadyListening before it looks at the files, so a serving
    // backend is usable whatever a stale readiness record says.
    expect(deriveHealthPresentation(healthy, null, 0, missingServer)).toMatchObject({
      level: 'ok',
      label: 'Ready',
      summary: 'All systems ready',
    });
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
    const down = deriveHealthPresentation(
      { ...healthy, llama_cpp_running: false },
      null,
      STARTUP_GRACE_MS + 1,
    );
    const stale = markStalePresentation(down);
    expect(stale.level).toBe('down');
    expect(stale.label).toBe('Offline (stale)');
  });
});
