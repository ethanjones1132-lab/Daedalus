import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import App from './App';
import { resetSharedBuildProvenanceStores, type BuildInfo } from './components/jarvis/build-provenance';
import type { JarvisConfig, JarvisStatus } from './components/jarvis/types';

// The two BuildBadge mounts (sidebar footer + header) must share one
// observation, and that observation must be re-checkable on window focus.
// Before this, each mount read `get_build_info` once on its own and never
// again, so a source tree that advanced after boot stayed visually clean.

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('./components/jarvis/HealthBanner', () => ({ default: () => null }));
vi.mock('./components/jarvis/MythosCompanionSprite', () => ({ MythosCompanionSprite: () => null }));
vi.mock('./components/jarvis/SystemStatusBar', () => ({ default: () => null }));

// Synthetic configuration only; credential fields are deliberately empty.
const config: JarvisConfig = {
  version: 'test', active_backend: 'ollama',
  ollama: { base_url: 'http://localhost:11434', model: 'provenance-test-model', auto_pull: false,
    health_check_interval_ms: 1000, options: { num_ctx: 4096, num_gpu: 0, num_thread: 1 } },
  openrouter: { base_url: '', api_key: '', model: '', site_url: '', site_name: '',
    fallbacks: [], enable_fallbacks: false, enable_paid_fallbacks: false, max_retries: 0, timeout_ms: 1000 },
  opencode_go: { base_url: '', api_key: '', first_token_timeout_ms: 1000 },
  opencode_zen: { base_url: '', api_key: '', first_token_timeout_ms: 1000 },
  claude_cli: { enabled: false, path: '', args: [], timeout_ms: 1000, cwd: '', auth_mode: 'proxy',
    delegate: { enabled: false, policy: 'escalation', permission_mode: '', allowed_tools: [], model: '', timeout_ms: 1000 } },
  tools: { enabled: false, require_approval: [], sandbox_mode: 'strict', allowlist: [], denylist: [],
    allowed_roots: [], grant_session_roots: false, bash_path: '', shell_timeout_max_ms: 1000 },
  reasoning: { enabled: false, show_trace_by_default: false, max_tokens: 100 },
  web_search: { provider: 'duckduckgo', brave_api_key: '', tavily_api_key: '' },
  companion: { enabled: false, name: '', species: '', rarity: '' },
  orchestrator: { enabled: false }, system_prompt: '', temperature: 0, max_tokens: 100, top_p: 1,
  bridge_port: 19876, bridge_enabled: false, jarvis_path: '', active_profile: '', api_sports_key: '',
};
const status: JarvisStatus = {
  ollama_running: true, model_available: true, bun_server_running: true,
  bun_server_url: 'http://localhost:19877', claude_proxy_running: false,
  bridge_active: false, bridge_port: 19876, bun_available: true,
  active_backend: 'ollama', model: 'provenance-test-model', openrouter_key_set: false,
};

function buildInfo(overrides: Partial<BuildInfo> = {}): BuildInfo {
  return {
    version: '0.6.0',
    git_sha: 'a1b2c3d4e5f6a7b8',
    git_short: 'a1b2c3d4e5',
    dirty: false,
    build_time: '2026-09-25T10:00:00Z',
    source_sha: 'a1b2c3d4e5f6a7b8',
    stale: false,
    ...overrides,
  };
}

function buildInfoCalls(): number {
  return vi.mocked(invoke).mock.calls.filter(call => call[0] === 'get_build_info').length;
}

beforeEach(() => {
  localStorage.clear();
  resetSharedBuildProvenanceStores();
  vi.stubGlobal('scrollTo', vi.fn());
  Element.prototype.scrollTo = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === 'jarvis_get_config') return config;
    if (command === 'jarvis_check_status') return status;
    if (command === 'get_build_info') return buildInfo();
    if (['jarvis_list_sessions', 'get_all_session_runs', 'list_sessions', 'list_model_profiles',
      'list_cron_jobs', 'list_pending_missed_jobs', 'get_action_registry_alerts'].includes(command)) return [];
    return null;
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  Reflect.deleteProperty(Element.prototype, 'scrollTo');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('App build provenance', () => {
  it('reads build provenance once for both mounted badges', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getAllByText(/v0\.6\.0/)).toHaveLength(2));
    expect(buildInfoCalls()).toBe(1);
  });

  it('shows the same verdict in both mounted badges', async () => {
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'get_build_info') return buildInfo({ source_sha: null });
      if (command === 'jarvis_get_config') return config;
      if (command === 'jarvis_check_status') return status;
      return [];
    });
    render(<App />);
    await waitFor(() => expect(screen.getAllByText(/unverifiable/i)).toHaveLength(2));
  });

  it('catches a source tree that advanced after boot on window focus', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getAllByText(/v0\.6\.0/)).toHaveLength(2));
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument();
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'get_build_info') return buildInfo({ source_sha: 'fresher01', stale: true });
      if (command === 'jarvis_get_config') return config;
      if (command === 'jarvis_check_status') return status;
      return [];
    });
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(screen.getAllByText(/stale/i)).toHaveLength(2));
    expect(buildInfoCalls()).toBe(2);
  });

  it('re-checks once, not once per badge, on window focus', async () => {
    render(<App />);
    await waitFor(() => expect(buildInfoCalls()).toBe(1));
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(buildInfoCalls()).toBe(2));
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(buildInfoCalls()).toBe(3));
  });
});
