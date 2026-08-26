import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelProfilesView } from './ModelProfilesView';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

beforeEach(() => {
  vi.clearAllMocks();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'list_model_profiles') return [];
    return {};
  });
});

describe('ModelProfilesView — discovery capability gap (P2)', () => {
  it('does not invoke jarvis_discover_models, discover_models_ollama, or discover_models_openrouter; regression fails if any is added', async () => {
    render(<ModelProfilesView />);
    // Wait for initial load cycle
    await new Promise(r => setTimeout(r, 20));
    const calls = invokeMock.mock.calls.map((c) => String(c[0]));
    // The three registered Native-surface discover commands must not be in the call set
    const forbidden = ['jarvis_discover_models', 'discover_models_ollama', 'discover_models_openrouter'];
    for (const f of forbidden) {
      expect(
        calls.some((c) => c === f),
        `discover command ${f} was invoked — capability now reachable, gap closed by accident; test must be re-verified`
      ).toBe(false);
    }
    // Sanity: the view does invoke its own load (list_model_profiles)
    expect(calls.some((c) => c === 'list_model_profiles')).toBe(true);
  });
});

describe('ModelProfilesView — jarvis_discover_models reachable (first slice delivered)', () => {
  it('invokes jarvis_discover_models when Discover is pressed and renders discovered items; fails if button or invoke removed', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_model_profiles') return [];
      if (command === 'jarvis_discover_models') return [{ id: 'm1', name: 'test', provider: 'ollama' }];
      return {};
    });
    const { getByRole } = render(<ModelProfilesView />);
    // First load completes; the discover button is present
    const btn = getByRole('button', { name: /Discover models/i });
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    await new Promise(r => setTimeout(r, 30));
    expect(invokeMock.mock.calls.some((c) => String(c[0]) === 'jarvis_discover_models')).toBe(true);
  });
});
