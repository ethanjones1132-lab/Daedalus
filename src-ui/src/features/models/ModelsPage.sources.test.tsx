import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ModelsPage from './ModelsPage';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const CONFIG = {
  ollama: { base_url: 'http://localhost:11434' },
  openrouter: { api_key: 'or-test' },
};

const llama = { id: 'llama3', name: 'Llama 3', provider: 'ollama' };
const mistral = { id: 'mistral', name: 'Mistral', provider: 'ollama' };
const qwen = { id: 'qwen/qwen3', name: 'Qwen3', provider: 'openrouter' };

const calls = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command);
const listItems = (panel: HTMLElement) => within(panel).getAllByRole('listitem');

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'list_model_profiles') return [];
    if (command === 'jarvis_get_config') return CONFIG;
    return {};
  });
});
afterEach(cleanup);

describe('ModelsPage — per-source model discovery', () => {
  it('invokes each source command exactly once per press with its documented argument', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_model_profiles') return [];
      if (command === 'jarvis_get_config') return CONFIG;
      if (command === 'discover_models_ollama') return [llama];
      if (command === 'discover_models_openrouter') return [qwen];
      return {};
    });
    render(<ModelsPage />);

    const openrouter = screen.getByRole('button', { name: 'Discover from OpenRouter' });
    await waitFor(() => expect(openrouter).toBeEnabled());

    const ollama = screen.getByRole('button', { name: 'Discover from Ollama' });
    // A second press while the first read is in flight must not queue another call.
    fireEvent.click(ollama);
    fireEvent.click(ollama);
    await waitFor(() => expect(calls('discover_models_ollama')).toHaveLength(1));
    expect(calls('discover_models_ollama')[0]).toEqual([
      'discover_models_ollama',
      { baseUrl: 'http://localhost:11434' },
    ]);

    fireEvent.click(openrouter);
    await waitFor(() => expect(calls('discover_models_openrouter')).toHaveLength(1));
    expect(calls('discover_models_openrouter')[0]).toEqual([
      'discover_models_openrouter',
      { apiKey: 'or-test' },
    ]);

    // Each press touched only its own command; the Bun proxy was not involved.
    expect(calls('discover_models_ollama')).toHaveLength(1);
    expect(calls('jarvis_discover_models')).toHaveLength(0);
  });

  it('merges results from every source into one list without duplicate rows', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_model_profiles') return [];
      if (command === 'jarvis_get_config') return CONFIG;
      if (command === 'jarvis_discover_models') return [llama];
      if (command === 'discover_models_ollama') return [llama, mistral];
      if (command === 'discover_models_openrouter') return [qwen];
      return {};
    });
    render(<ModelsPage />);

    fireEvent.click(screen.getByRole('button', { name: /Discover models/i }));
    const panel = await screen.findByRole('region', { name: 'Discovered models' });
    await within(panel).findByText('Llama 3');

    fireEvent.click(screen.getByRole('button', { name: 'Discover from Ollama' }));
    await within(panel).findByText('Mistral');

    const openrouter = screen.getByRole('button', { name: 'Discover from OpenRouter' });
    await waitFor(() => expect(openrouter).toBeEnabled());
    fireEvent.click(openrouter);
    await within(panel).findByText('Qwen3');

    // proxy llama3 + Ollama llama3/mistral + OpenRouter qwen3 → three unique rows.
    expect(listItems(panel)).toHaveLength(3);
    expect(within(panel).getAllByText('Llama 3')).toHaveLength(1);
    expect(within(panel).getAllByText('llama3')).toHaveLength(1);
  });

  it('reports a rejected source inline and leaves the rest of the list intact', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_model_profiles') return Promise.resolve([]);
      if (command === 'jarvis_get_config') return Promise.resolve(CONFIG);
      if (command === 'discover_models_ollama') return Promise.resolve([llama]);
      if (command === 'discover_models_openrouter') {
        return Promise.reject(new Error(`private upstream detail for ${CONFIG.openrouter.api_key}`));
      }
      return Promise.resolve({});
    });
    render(<ModelsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Discover from Ollama' }));
    const panel = await screen.findByRole('region', { name: 'Discovered models' });
    await within(panel).findByText('Llama 3');

    const openrouter = screen.getByRole('button', { name: 'Discover from OpenRouter' });
    await waitFor(() => expect(openrouter).toBeEnabled());
    fireEvent.click(openrouter);

    const alert = await screen.findByRole('alert', { name: 'OpenRouter discovery' });
    expect(alert).toHaveTextContent('Could not discover models from OpenRouter');
    expect(screen.queryByText(/private upstream detail/)).not.toBeInTheDocument();
    expect(screen.queryByText(/or-test/)).not.toBeInTheDocument();
    // The page-level (Bun proxy) discovery is untouched by a source failure.
    expect(screen.queryByRole('alert', { name: 'Model discovery' })).not.toBeInTheDocument();
    expect(within(panel).getByText('Llama 3')).toBeInTheDocument();

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_model_profiles') return [];
      if (command === 'jarvis_get_config') return CONFIG;
      if (command === 'discover_models_openrouter') return [qwen];
      return {};
    });
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry OpenRouter discovery' }));

    await within(panel).findByText('Qwen3');
    expect(screen.queryByRole('alert', { name: 'OpenRouter discovery' })).not.toBeInTheDocument();
    expect(within(panel).getByText('Llama 3')).toBeInTheDocument();
  });

  it('disables OpenRouter discovery with a visible reason when no key is configured', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_model_profiles') return [];
      if (command === 'jarvis_get_config') return { ollama: { base_url: '' }, openrouter: { api_key: '' } };
      return {};
    });
    render(<ModelsPage />);

    expect(await screen.findByText('Add an OpenRouter API key in Settings to discover OpenRouter models.')).toBeInTheDocument();
    const openrouter = screen.getByRole('button', { name: 'Discover from OpenRouter' });
    expect(openrouter).toBeDisabled();
    const reason = document.getElementById(openrouter.getAttribute('aria-describedby') ?? '');
    expect(reason).toHaveTextContent('Add an OpenRouter API key in Settings to discover OpenRouter models.');
    fireEvent.click(openrouter);
    await act(async () => {});
    expect(calls('discover_models_openrouter')).toHaveLength(0);
    // Ollama discovery never depends on the OpenRouter key.
    expect(screen.getByRole('button', { name: 'Discover from Ollama' })).toBeEnabled();
  });

  it('keeps OpenRouter discovery disabled when the Settings key cannot be read', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_model_profiles') return [];
      if (command === 'jarvis_get_config') throw new Error('config unavailable');
      return {};
    });
    render(<ModelsPage />);

    expect(
      await screen.findByText('Could not read the OpenRouter key from Settings. Reload to try again.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discover from OpenRouter' })).toBeDisabled();
  });

  it('invokes no discover command on load, even with a key configured', async () => {
    render(<ModelsPage />);
    await waitFor(() => expect(calls('jarvis_get_config')).toHaveLength(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    for (const command of ['jarvis_discover_models', 'discover_models_ollama', 'discover_models_openrouter']) {
      expect(calls(command), `${command} must only run from an explicit action`).toHaveLength(0);
    }
  });
});
