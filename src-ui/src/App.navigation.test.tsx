import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import App from './App';
import type { JarvisConfig, JarvisStatus } from './components/jarvis/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('./components/jarvis/HealthBanner', () => ({ default: () => null }));
vi.mock('./components/jarvis/MythosCompanionSprite', () => ({ MythosCompanionSprite: () => null }));
vi.mock('./components/jarvis/SystemStatusBar', () => ({ default: () => null }));

// Synthetic configuration only; credential fields are deliberately empty.
const config: JarvisConfig = {
  version: 'test', active_backend: 'ollama',
  ollama: { base_url: 'http://localhost:11434', model: 'navigation-test-model', auto_pull: false,
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
  active_backend: 'ollama', model: 'navigation-test-model', openrouter_key_set: false,
};

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('scrollTo', vi.fn());
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'jarvis_get_config') return config;
    if (command === 'jarvis_check_status') return status;
    if (['jarvis_list_sessions', 'get_all_session_runs', 'list_sessions', 'list_model_profiles',
      'list_cron_jobs', 'list_pending_missed_jobs', 'get_action_registry_alerts'].includes(command)) return [];
    return null;
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const destinations = [
  { id: 'config', label: 'Config', heading: 'Configuration' },
  { id: 'health', label: 'Health', heading: 'Status' },
];
async function expectDestination(destination: typeof destinations[number]) {
  expect(await screen.findByRole('heading', { name: destination.heading, level: 2 })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: destination.label, level: 1 })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Control Center' })).not.toBeInTheDocument();
  expect(localStorage.getItem('jarvis-current-view')).toBe(destination.id);
  if (destination.id === 'config') {
    expect(screen.getByRole('button', { name: 'Save Config' })).toBeEnabled();
    expect(screen.getByPlaceholderText('e.g., qwen2.5-coder:7b')).toHaveValue('navigation-test-model');
  } else {
    expect(screen.getByText('navigation-test-model', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh status' })).toBeEnabled();
  }
}

describe('App Config and Health destinations', () => {
  it.each(destinations)('restores $label to its existing panel', async (destination) => {
    localStorage.setItem('jarvis-current-view', destination.id);
    await act(async () => { render(<App />); });
    await expectDestination(destination);
  });

  it('routes sequential sidebar navigation across Config, Health, Models, and Control', async () => {
    localStorage.setItem('jarvis-current-view', 'control');
    await act(async () => { render(<App />); });
    expect(screen.getByRole('heading', { name: 'Control Center' })).toBeInTheDocument();
    for (const destination of destinations) {
      fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: new RegExp(destination.label) }));
      await expectDestination(destination);
    }
    for (const label of ['Models', 'Control']) {
      fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: new RegExp(label) }));
      expect(await screen.findByRole('heading', { name: 'Control Center' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: label, level: 1 })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Configuration' })).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Status', level: 2 })).not.toBeInTheDocument();
    }
  });

  it.each(destinations)('opens $label through the command palette', async (destination) => {
    localStorage.setItem('jarvis-current-view', 'sessions');
    await act(async () => { render(<App />); });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = screen.getByRole('combobox', { name: 'Search views' });
    fireEvent.change(input, { target: { value: destination.label } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await expectDestination(destination);
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
  });
});
