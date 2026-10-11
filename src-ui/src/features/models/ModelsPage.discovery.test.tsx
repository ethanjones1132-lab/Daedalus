import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ModelsPage from './ModelsPage';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'list_model_profiles') return [];
    return {};
  });
});
afterEach(cleanup);

const names = () => invokeMock.mock.calls.map((c) => String(c[0]));

describe('ModelsPage — model discovery (ported from ModelProfilesView)', () => {
  it('does not invoke jarvis_discover_models, discover_models_ollama, or discover_models_openrouter on load', async () => {
    render(<ModelsPage />);
    await new Promise((r) => setTimeout(r, 20));
    for (const forbidden of ['jarvis_discover_models', 'discover_models_ollama', 'discover_models_openrouter']) {
      expect(
        names().some((c) => c === forbidden),
        `discover command ${forbidden} was invoked on load; discovery must be an explicit action`,
      ).toBe(false);
    }
    // Sanity: the page does invoke its own load (list_model_profiles)
    expect(names().some((c) => c === 'list_model_profiles')).toBe(true);
  });

  it('invokes jarvis_discover_models when Discover is pressed and renders discovered items; fails if button or invoke removed', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_model_profiles') return [];
      if (command === 'jarvis_discover_models') return [{ id: 'm1', name: 'test', provider: 'ollama' }];
      return {};
    });
    render(<ModelsPage />);
    const btn = screen.getByRole('button', { name: /Discover models/i });
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 30));
    expect(names().some((c) => c === 'jarvis_discover_models')).toBe(true);
    const panel = await screen.findByRole('region', { name: 'Discovered models' });
    expect(within(panel).getByText('test')).toBeInTheDocument();
    expect(within(panel).getByText('m1')).toBeInTheDocument();
  });

  it('opens the create dialog prefilled from a discovered model', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_model_profiles') return [];
      if (command === 'jarvis_discover_models') return [{ id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder', provider: 'openrouter' }];
      return {};
    });
    render(<ModelsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Discover models/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Create profile from this model/ }));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Qwen3 Coder');
    expect(screen.getByRole('textbox', { name: 'Backend' })).toHaveValue('openrouter');
    expect(screen.getByRole('textbox', { name: 'Model' })).toHaveValue('qwen/qwen3-coder:free');
  });

  it('says so, with a retry, when discovery fails instead of showing nothing', async () => {
    const first = deferred<unknown>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_model_profiles') return Promise.resolve([]);
      if (command === 'jarvis_discover_models') return first.promise;
      return Promise.resolve({});
    });
    render(<ModelsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Discover models/i }));
    expect(await screen.findByRole('status', { name: 'Model discovery' })).toHaveTextContent('Discovering models');
    await act(async () => first.reject(new Error('private endpoint detail')));
    const alert = screen.getByRole('alert', { name: 'Model discovery' });
    expect(alert).toHaveTextContent('Could not discover models');
    expect(screen.queryByText(/private endpoint detail/)).not.toBeInTheDocument();

    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_model_profiles') return Promise.resolve([]);
      if (command === 'jarvis_discover_models') return Promise.resolve([{ id: 'm2', name: 'Recovered', provider: 'ollama' }]);
      return Promise.resolve({});
    });
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry discovery' }));
    expect(await screen.findByText('Recovered')).toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: 'Model discovery' })).not.toBeInTheDocument();
  });

  it('shows a successful but empty discovery as empty', async () => {
    invokeMock.mockImplementation(async (command: string) => (command === 'jarvis_discover_models' ? [] : command === 'list_model_profiles' ? [] : {}));
    render(<ModelsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Discover models/i }));
    expect(await screen.findByText('No models discovered.')).toBeInTheDocument();
  });
});
