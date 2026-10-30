import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ModelsPage from './ModelsPage';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const profile = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'Local profile',
  provider: 'llama_cpp',
  model: 'local.gguf',
  api_base: '',
  max_tokens: 4096,
  temperature: 0.7,
  top_p: 1,
  is_active: true,
  engine: 'native',
  ...over,
});

const config = (over: Record<string, unknown> = {}) => ({
  active_backend: 'llama_cpp',
  ollama: { model: 'ollama-model' },
  llama_cpp: { model: 'local.gguf' },
  openrouter: { model: 'cloud-model' },
  claude_cli: { model: 'sonnet' },
  ...over,
});

function mount(profiles: unknown[], cfg: unknown) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'list_model_profiles') return profiles;
    if (command === 'jarvis_get_config') return cfg;
    return [];
  });
  render(<ModelsPage />);
}

function hero() {
  return within(screen.getByRole('listitem', { name: 'Active profile' }));
}

afterEach(cleanup);

beforeEach(() => {
  invokeMock.mockReset();
});

describe('Inference hero: saved profile versus the configured route', () => {
  it('names the configured routing backend beside the saved profile', async () => {
    mount([profile()], config());
    await screen.findByRole('heading', { name: 'Local profile' });
    expect(hero().getByText('Routing backend')).toBeInTheDocument();
    expect(hero().getByText('llama.cpp')).toBeInTheDocument();
    // The saved model chip and the routing chip agree, so both print the alias.
    expect(hero().getAllByText('local.gguf')).toHaveLength(2);
    expect(hero().queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows a visible disagreement when Settings moved the backend away from the profile', async () => {
    mount([profile()], config({ active_backend: 'ollama' }));
    await screen.findByRole('heading', { name: 'Local profile' });
    expect(await hero().findByText(/does not match the configured routing backend/)).toBeInTheDocument();
    expect(hero().getByText('Ollama')).toBeInTheDocument();
    expect(hero().getByText('ollama-model')).toBeInTheDocument();
    // The profile row is untouched: it still shows the saved model.
    expect(hero().getByText('local.gguf')).toBeInTheDocument();
  });

  it('reports routing as unconfirmed rather than guessing when the config read fails', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_model_profiles') return [profile()];
      if (command === 'jarvis_get_config') throw new Error('private read detail');
      return [];
    });
    render(<ModelsPage />);
    await screen.findByRole('heading', { name: 'Local profile' });
    expect(await hero().findByText('Not confirmed in this view.')).toBeInTheDocument();
    expect(hero().queryByText('Ollama')).not.toBeInTheDocument();
    expect(hero().queryByRole('status')).not.toBeInTheDocument();
  });
});
