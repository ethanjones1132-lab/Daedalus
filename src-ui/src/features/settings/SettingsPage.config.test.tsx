import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPage from './SettingsPage';
import type { JarvisConfig } from '../../domain/types';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

/**
 * The Rust JarvisConfig carries fields the TypeScript type does not describe.
 * They only survive a save if the UI sends back the object it fetched.
 */
const baseConfig = {
  version: 'test', active_backend: 'ollama',
  ollama: { base_url: 'http://localhost:11434', model: 'test-model', auto_pull: false,
    health_check_interval_ms: 1000, options: { num_ctx: 4096, num_gpu: 0, num_thread: 1 }, keep_alive: '5m' },
  llama_cpp: { base_url: 'http://localhost:8080/v1', model: 'gemma-4', server_path: '', model_path: '', mtp_path: '',
    port: 8080, context_window: 16384, reasoning_budget: 1536 },
  openrouter: { base_url: 'https://openrouter.ai/api/v1', api_key: '', model: 'openrouter/free', site_url: '', site_name: '',
    fallbacks: [], enable_fallbacks: false, enable_paid_fallbacks: false, max_retries: 0, timeout_ms: 1000 },
  opencode_go: { base_url: '', api_key: '', first_token_timeout_ms: 45000 },
  opencode_zen: { base_url: '', api_key: '', first_token_timeout_ms: 45000 },
  claude_cli: { enabled: false, path: '', args: [], timeout_ms: 1000, cwd: '', auth_mode: 'proxy',
    delegate: { enabled: false, policy: 'escalation', permission_mode: '', allowed_tools: [], model: '', timeout_ms: 1000 } },
  tools: { enabled: false, require_approval: [], sandbox_mode: 'strict', allowlist: [], denylist: [],
    allowed_roots: [], grant_session_roots: false, bash_path: '', shell_timeout_max_ms: 120000 },
  reasoning: { enabled: false, show_trace_by_default: false, max_tokens: 100 },
  web_search: { provider: 'duckduckgo', brave_api_key: '', tavily_api_key: '' },
  companion: { enabled: false, name: '', species: '', rarity: '' },
  orchestrator: { enabled: true, max_stages: 4 }, system_prompt: 'Be useful.', temperature: 0, max_tokens: 100, top_p: 1,
  bridge_port: 19876, bridge_enabled: false, jarvis_path: '/home/jarvis', active_profile: '', api_sports_key: '',
  // Fields the TS type omits:
  mode: 'standard',
  prizepicks_prompt: 'unused',
  compaction: { enabled: true, threshold: 0.8 },
  profiles: [{ id: 'p1' }],
  agents_root: '/home/jarvis/agents',
};
const config = baseConfig as unknown as JarvisConfig;

const settingsTable: Record<string, string> = { system_prompt: 'Be useful.', theme: 'dark', bridge_port: '19876' };

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((name: string, args?: Record<string, unknown>) => {
    if (name === 'jarvis_get_config') return Promise.resolve(structuredClone(baseConfig));
    if (name === 'jarvis_save_config') return Promise.resolve(null);
    if (name === 'get_all_settings') return Promise.resolve({ ...settingsTable });
    if (name === 'set_setting') return Promise.resolve(args ? null : null);
    return Promise.resolve(null);
  });
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
});
afterEach(cleanup);

const calls = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command);
async function open() {
  render(<SettingsPage />);
  await screen.findByRole('heading', { name: 'Configuration' });
}
const savedConfig = () => (calls('jarvis_save_config')[0][1] as { config: Record<string, unknown> }).config;

describe('Settings config round trip', () => {
  it('sends back every fetched field, including ones the TypeScript type omits', async () => {
    await open();
    fireEvent.change(screen.getByRole('textbox', { name: 'System prompt text' }), { target: { value: 'Be terse.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle bridge' }));
    fireEvent.click(screen.getByRole('button', { name: /^Ollama/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g., qwen2.5-coder:7b'), { target: { value: 'edited-model' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));
    await screen.findByRole('button', { name: 'Saved' });

    expect(calls('jarvis_save_config')).toHaveLength(1);
    expect(savedConfig()).toEqual({
      ...baseConfig,
      system_prompt: 'Be terse.',
      bridge_enabled: true,
      ollama: { ...baseConfig.ollama, model: 'edited-model' },
    });
    // Unknown top-level and nested fields are present by value, not merely "equal enough".
    const sent = savedConfig();
    expect(sent.mode).toBe('standard');
    expect(sent.compaction).toEqual({ enabled: true, threshold: 0.8 });
    expect(sent.profiles).toEqual([{ id: 'p1' }]);
    expect(sent.agents_root).toBe('/home/jarvis/agents');
    expect((sent.ollama as Record<string, unknown>).keep_alive).toBe('5m');
    expect((sent.orchestrator as Record<string, unknown>).max_stages).toBe(4);
  });

  it('keeps unknown nested fields when a nested block is edited', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle orchestration runtime' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));
    await screen.findByRole('button', { name: 'Saved' });
    expect(savedConfig().orchestrator).toEqual({ enabled: false, max_stages: 4 });
  });
});

describe('Settings Inference backend selector', () => {
  it('offers all four Inference backends including Claude Code CLI', async () => {
    await open();
    const group = screen.getByRole('group', { name: 'Inference backend' });
    const names = within(group).getAllByRole('button').map((b) => b.textContent ?? '');
    expect(names).toHaveLength(4);
    for (const label of ['llama.cpp', 'Ollama', 'OpenRouter', 'Claude Code CLI']) {
      expect(names.some((n) => n.startsWith(label))).toBe(true);
    }
  });

  it('selecting Claude Code CLI saves active_backend and swaps the Model section', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: /^Claude Code CLI/ }));
    expect(screen.getByRole('button', { name: /^Claude Code CLI/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox', { name: 'Claude model' })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('e.g., qwen2.5-coder:7b')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));
    await screen.findByRole('button', { name: 'Saved' });
    expect(savedConfig().active_backend).toBe('claude_cli');
  });

  it('shows and saves the llama.cpp path fields when llama.cpp is selected', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: /^llama\.cpp/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'llama.cpp server_path' }), { target: { value: '/opt/llama/llama-server' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'llama.cpp model_path' }), { target: { value: '/models/gemma.gguf' } });
    expect(screen.getByRole('textbox', { name: 'llama.cpp mtp_path' })).toBeInTheDocument();
    expect(screen.getByText(/Server: http:\/\/localhost:8080\/v1 · context 16384 · reasoning budget 1536/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));
    await screen.findByRole('button', { name: 'Saved' });
    expect(savedConfig().llama_cpp).toEqual({ ...baseConfig.llama_cpp, server_path: '/opt/llama/llama-server', model_path: '/models/gemma.gguf' });
  });
});

describe('Settings save bar and fields', () => {
  it('shows the save bar only while dirty and discards back to the fetched config', async () => {
    await open();
    expect(screen.queryByRole('button', { name: 'Save Config' })).not.toBeInTheDocument();
    const prompt = screen.getByRole('textbox', { name: 'System prompt text' });
    fireEvent.change(prompt, { target: { value: 'Changed.' } });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(prompt).toHaveValue('Be useful.');
    expect(screen.queryByRole('button', { name: 'Save Config' })).not.toBeInTheDocument();
    expect(calls('jarvis_save_config')).toHaveLength(0);
  });

  it('does not treat an edit that is reverted by value as unsaved', async () => {
    await open();
    const prompt = screen.getByRole('textbox', { name: 'System prompt text' });
    fireEvent.change(prompt, { target: { value: 'Different.' } });
    fireEvent.change(prompt, { target: { value: 'Be useful.' } });
    expect(screen.queryByRole('button', { name: 'Save Config' })).not.toBeInTheDocument();
  });

  it('hides provider keys until Show keys is pressed', async () => {
    await open();
    const key = screen.getByLabelText('OpenRouter API key');
    expect(key).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Show provider API keys' }));
    expect(key).toHaveAttribute('type', 'text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide provider API keys' }));
    expect(key).toHaveAttribute('type', 'password');
  });

  it('clamps the OpenCode first-token timeout and the shell ceiling to 1000 ms', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('OpenCode Go (ms)'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Shell timeout ceiling (ms)'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));
    await screen.findByRole('button', { name: 'Saved' });
    expect((savedConfig().opencode_go as Record<string, unknown>).first_token_timeout_ms).toBe(1000);
    expect((savedConfig().tools as Record<string, unknown>).shell_timeout_max_ms).toBe(1000);
  });

  it('warns, without raising an alert, when Subscription auth is chosen', async () => {
    await open();
    expect(screen.queryByText(/spends your Claude subscription quota/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Subscription/ }));
    expect(screen.getByRole('note')).toHaveTextContent('spends your Claude subscription quota');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reveals the key field that belongs to the selected web search provider', async () => {
    await open();
    expect(screen.queryByLabelText('Brave API key')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Brave/ }));
    expect(screen.getByLabelText('Brave API key')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Tavily/ }));
    expect(screen.queryByLabelText('Brave API key')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Tavily API key')).toBeInTheDocument();
  });

  it('lists every section in the sticky index once the config has loaded', async () => {
    await open();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const labels = within(nav).getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual([
      'Inference backend', 'Provider keys', 'Model', 'Orchestration', 'Endpoints', 'System prompt',
      'Bridge', 'Web search', 'Shell', 'Claude CLI auth', 'Appearance', 'Advanced',
    ]);
  });
});

describe('Settings appearance', () => {
  it('switches the theme between Ink and Vellum and persists it', async () => {
    await open();
    const group = screen.getByRole('group', { name: 'Theme' });
    expect(within(group).getByRole('button', { name: /Ink/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(group).getByRole('button', { name: /Vellum/ }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(within(group).getByRole('button', { name: /Vellum/ })).toHaveAttribute('aria-pressed', 'true');
    expect(calls('set_setting')).toContainEqual(['set_setting', { key: 'theme', value: 'light' }]);
  });
});

describe('Settings advanced (raw settings table)', () => {
  it('reads nothing until the section is opened, then lists keys sorted and filterable', async () => {
    await open();
    expect(calls('get_all_settings')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Raw settings table' }));
    expect(await screen.findByLabelText('bridge_port')).toHaveValue('19876');
    const keys = screen.getAllByRole('textbox').filter((el) => el.id.startsWith('setting-')).map((el) => el.id);
    expect(keys).toEqual(['setting-bridge_port', 'setting-system_prompt', 'setting-theme']);
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter settings' }), { target: { value: 'nomatch' } });
    expect(screen.getByText('No settings match "nomatch".')).toBeInTheDocument();
  });

  it('saves one key at a time through set_setting and rejects keys outside the whitelist', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Raw settings table' }));
    const port = await screen.findByLabelText('bridge_port');
    fireEvent.change(port, { target: { value: '20000' } });
    expect(screen.getByText('1 unsaved change — click Save on each row to persist')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save bridge_port' }));
    await waitFor(() => expect(calls('set_setting')).toContainEqual(['set_setting', { key: 'bridge_port', value: '20000' }]));
    await waitFor(() => expect(screen.queryByText(/unsaved change/)).not.toBeInTheDocument());

    // `theme` belongs to Appearance: listed, but read-only and never written from here.
    const theme = screen.getByLabelText('theme');
    expect(theme).toHaveAttribute('readonly');
    fireEvent.change(theme, { target: { value: 'light' } });
    expect(calls('set_setting').some(([, a]) => (a as { key: string }).key === 'theme')).toBe(false);
  });

  it('shows a failed read as a failure with a retry, not as an empty table', async () => {
    invokeMock.mockImplementation((name: string) => {
      if (name === 'jarvis_get_config') return Promise.resolve(structuredClone(baseConfig));
      if (name === 'get_all_settings') return Promise.reject(new Error('private detail'));
      return Promise.resolve(null);
    });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Raw settings table' }));
    expect(await screen.findByRole('alert', { name: 'Raw settings' })).toHaveTextContent('Could not load the raw settings table.');
    expect(screen.queryByText(/private detail/)).not.toBeInTheDocument();
    expect(screen.queryByText('No settings stored yet.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry settings' })).toBeEnabled();
  });
});

void config;
