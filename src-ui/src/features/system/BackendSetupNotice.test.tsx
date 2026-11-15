import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BackendSetupNotice from './BackendSetupNotice';
import { NavigationProvider, useNavigation } from '../../shell/navigation';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

// The wire shape of Native's `get_backend_readiness` (snake_case): a fresh
// install has blank llama.cpp artifact paths and everything else filled.
const missingArtifactPaths = {
  state: 'missing_config',
  backend: 'llama_cpp',
  missing: [
    { key: 'llama_cpp.server_path', label: 'llama.cpp server_path', env_var: 'JARVIS_LLAMA_SERVER_PATH' },
    { key: 'llama_cpp.model_path', label: 'llama.cpp model_path', env_var: 'JARVIS_LLAMA_MODEL_PATH' },
  ],
};

const ready = { state: 'ready', backend: 'llama_cpp', missing: [] };

function RouteProbe() {
  const { route } = useNavigation();
  return <span data-testid="route">{route}</span>;
}

const harness = (refreshKey: number) => (
  <NavigationProvider initial="sessions">
    <BackendSetupNotice refreshKey={refreshKey} />
    <RouteProbe />
  </NavigationProvider>
);

const mount = async (refreshKey = 0) => {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(harness(refreshKey));
  });
  return result;
};

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
});

afterEach(() => cleanup());

describe('first-run backend setup state (DD-060)', () => {
  it('names the blank setting and where it is edited', async () => {
    invokeMock.mockResolvedValue(missingArtifactPaths);

    await mount();

    const notice = await screen.findByTestId('backend-setup-notice');
    // The field Settings labels and the env var that also satisfies it — not a
    // generic "backend unavailable", and not a silent empty chat.
    expect(notice).toHaveTextContent('llama.cpp server_path');
    expect(notice).toHaveTextContent('JARVIS_LLAMA_SERVER_PATH');
    expect(notice).toHaveTextContent('llama.cpp model_path');
    expect(notice).toHaveTextContent('JARVIS_LLAMA_MODEL_PATH');
    expect(notice).toHaveTextContent('chat stays blocked');
    expect(invokeMock).toHaveBeenCalledWith('get_backend_readiness');
  });

  it('links to the Settings surface where the field is edited', async () => {
    invokeMock.mockResolvedValue(missingArtifactPaths);

    await mount();

    const notice = await screen.findByTestId('backend-setup-notice');
    fireEvent.click(within(notice).getByRole('button', { name: 'Open Settings' }));

    expect(screen.getByTestId('route')).toHaveTextContent('settings');
  });

  it('dismisses once the config is filled in', async () => {
    invokeMock.mockResolvedValueOnce(missingArtifactPaths);

    const { rerender } = await mount(0);
    expect(await screen.findByTestId('backend-setup-notice')).toBeInTheDocument();

    // Back from Settings: the navigation nonce bumps, the read now reports a
    // configured backend, and the gate stops claiming a setup problem.
    invokeMock.mockResolvedValueOnce(ready);
    await act(async () => {
      rerender(harness(1));
    });

    await waitFor(() => expect(screen.queryByTestId('backend-setup-notice')).not.toBeInTheDocument());
    expect(screen.getByTestId('route')).toHaveTextContent('sessions');
  });

  it('stays silent when the backend is ready', async () => {
    invokeMock.mockResolvedValue(ready);

    await mount();

    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(screen.queryByTestId('backend-setup-notice')).not.toBeInTheDocument();
  });

  it('never fabricates a setup problem from an unreadable answer', async () => {
    invokeMock.mockRejectedValue(new Error('native unavailable'));

    await mount();

    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(screen.queryByTestId('backend-setup-notice')).not.toBeInTheDocument();
  });
});
