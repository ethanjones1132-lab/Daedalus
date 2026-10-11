import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPage from './SettingsPage';
import type { JarvisConfig } from '../../domain/types';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Synthetic configuration only; all credential fields intentionally empty.
const config: JarvisConfig = {
  version: 'test', active_backend: 'ollama',
  ollama: { base_url: 'http://localhost:11434', model: 'test-model', auto_pull: false,
    health_check_interval_ms: 1000, options: { num_ctx: 4096, num_gpu: 0, num_thread: 1 } },
  llama_cpp: { base_url: 'http://localhost:8080/v1', model: 'gemma-4-26B-A4B-it-IQ2_M.gguf',
    server_path: '', model_path: '', mtp_path: '', port: 8080, context_window: 16384, reasoning_budget: 1536 },
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
const resources = [
  { view: 'config' as const, command: 'jarvis_get_config', data: config, heading: 'Configuration' },
];

beforeEach(() => { invokeMock.mockReset(); });
afterEach(cleanup);

function mockResource(command: string, response: () => Promise<unknown>) {
  invokeMock.mockImplementation((name: string) => {
    if (name === command) return response();
    if (name === 'jarvis_list_sessions' || name === 'get_all_session_runs') return Promise.resolve([]);
    return Promise.resolve(null);
  });
}
const callsFor = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command);

describe('Config save state', () => {
  async function openConfig(save: () => Promise<unknown>) {
    invokeMock.mockImplementation((name: string) => {
      if (name === 'jarvis_get_config') return Promise.resolve(config);
      if (name === 'jarvis_save_config') return save();
      return Promise.resolve([]);
    });
    render(<SettingsPage />);
    await screen.findByRole('heading', { name: 'Configuration' });
    return screen.getByPlaceholderText('e.g., qwen2.5-coder:7b');
  }

  it('guards pending submissions and confirms only the resolved, unchanged draft', async () => {
    const save = deferred<unknown>();
    const model = await openConfig(() => save.promise);
    fireEvent.change(model, { target: { value: 'edited-model' } });
    const button = screen.getByRole('button', { name: 'Save Config' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(callsFor('jarvis_save_config')).toEqual([
      ['jarvis_save_config', { config: { ...config, ollama: { ...config.ollama, model: 'edited-model' } } }],
    ]);
    expect(button).toBeDisabled();
    expect(model).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Saving config');
    expect(screen.queryByRole('button', { name: 'Saved' })).not.toBeInTheDocument();
    await act(async () => save.resolve(null));
    expect(screen.getByRole('status')).toHaveTextContent('Config saved');
    expect(screen.getByRole('button', { name: 'Saved' })).toBeEnabled();
    expect(model).toBeEnabled();
    expect(model).toHaveValue('edited-model');
    fireEvent.change(model, { target: { value: 'newer-model' } });
    expect(screen.queryByRole('button', { name: 'Saved' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('preserves rejected edits, redacts native errors, and retries the draft', async () => {
    const first = deferred<unknown>();
    const retry = deferred<unknown>();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const model = await openConfig(save);
      fireEvent.change(model, { target: { value: 'retained-model' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));
      await act(async () => first.reject(new Error('private-native-detail')));
      expect(screen.getByRole('alert')).toHaveTextContent('Could not save config');
      expect(screen.getByRole('alert')).toHaveTextContent('Retry');
      expect(screen.queryByText(/private-native-detail/)).not.toBeInTheDocument();
      expect(errorLog).not.toHaveBeenCalled();
      expect(model).toHaveValue('retained-model');
      expect(model).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Saved' })).not.toBeInTheDocument();
      const button = screen.getByRole('button', { name: 'Retry save config' });
      fireEvent.click(button);
      fireEvent.click(button);
      expect(save).toHaveBeenCalledTimes(2);
      expect(callsFor('jarvis_save_config')[1]).toEqual(callsFor('jarvis_save_config')[0]);
      await act(async () => retry.resolve(null));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Config saved');
      // Direct-setter controls must invalidate saved feedback too.
      fireEvent.click(screen.getByRole('button', { name: /Subscription/ }));
      expect(screen.queryByRole('button', { name: 'Saved' })).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    } finally {
      errorLog.mockRestore();
    }
  });
});

describe('Config and Status native resource states', () => {
  it.each(resources)('$view distinguishes pending, failure and successful retry without leaking error detail', async ({ view, command, data, heading }) => {
    const initial = deferred<unknown>();
    mockResource(command, () => initial.promise);
    render(<SettingsPage />);
    expect(screen.getByRole('status')).toHaveTextContent(`Loading ${view}`);
    expect(screen.queryByRole('heading', { name: heading })).not.toBeInTheDocument();

    await act(async () => initial.reject(new Error('private-native-detail')));
    expect(screen.getByRole('alert')).toHaveTextContent(`Could not load ${view}`);
    expect(screen.queryByText(/private-native-detail/)).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    const retry = deferred<unknown>();
    mockResource(command, () => retry.promise);
    const button = screen.getByRole('button', { name: `Retry ${view}` });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(callsFor(command)).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent(`Loading ${view}`);
    expect(screen.getByRole('button', { name: `Retry ${view}` })).toBeDisabled();
    await act(async () => retry.resolve(data));
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(callsFor(command)).toEqual([[command], [command]]);
  });

  it.each(resources)('$view treats a missing native result as a recoverable failure', async ({ view, command }) => {
    mockResource(command, () => Promise.resolve(null));
    render(<SettingsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(`Could not load ${view}`);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Retry ${view}` })).toBeEnabled();
  });
});
