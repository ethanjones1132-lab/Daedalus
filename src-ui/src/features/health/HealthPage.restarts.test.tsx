import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import HealthPage from './HealthPage';
import { resetSharedBuildProvenanceStores } from '../../domain/build-provenance';
import { cleanBuild, deferred, doctor, healthFor, status, stubUnreachableBun } from './test-fixtures';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const fixtures: Record<string, unknown> = {
  jarvis_check_status: status,
  get_system_health: healthFor('ollama', true),
  get_doctor_report: doctor,
  get_build_info: cleanBuild,
};

const commands = [
  ['Ollama', 'jarvis_restart_ollama', 'ollama'],
  ['Bun server', 'jarvis_restart_server', 'bun'],
  ['Claude proxy', 'jarvis_restart_proxy', 'proxy'],
] as const;

const calls = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command).length;

beforeEach(() => {
  stubUnreachableBun();
  resetSharedBuildProvenanceStores();
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string) => Promise.resolve(fixtures[command] ?? true));
});

// The subsystem gauges (and their Restart controls) are always on the page now,
// so there is no Diagnostics tab to open first — only to wait for the gauge.
async function openDiagnostics(name: string) {
  await screen.findByRole('button', { name: `Restart ${name}` });
}

describe('Health page service restarts', () => {
  it.each(commands)('waits for a matching health read after a true %s result', async (name, command, key) => {
    const commandRequest = deferred();
    let commandResolved = false;
    const initialHealth = healthFor(key, false, 'before');
    const confirmedHealth = healthFor(key, true, 'after');
    invokeMock.mockImplementation((requested: string) => {
      if (requested === command) return commandRequest.promise;
      if (requested === 'get_system_health') return Promise.resolve(commandResolved ? confirmedHealth : initialHealth);
      return Promise.resolve(fixtures[requested] ?? true);
    });

    render(<HealthPage />);
    await openDiagnostics(name);
    const button = screen.getByRole('button', { name: `Restart ${name}` });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(calls(command)).toBe(1);
    expect(button).toBeDisabled();
    expect(screen.getByRole('status', { name: `Restart ${name}` })).toHaveTextContent('Restarting');

    commandResolved = true;
    await act(async () => commandRequest.resolve(true));
    await waitFor(() => expect(screen.getByRole('status', { name: `Restart ${name}` })).toHaveTextContent('restart confirmed'));
    expect(calls('get_system_health')).toBe(2);
    expect(screen.queryByText(new RegExp(`${name} restarted`, 'i'))).not.toBeInTheDocument();
  });

  it.each(commands)('reports a stable no-op for a false %s result without success', async (name, command) => {
    const commandRequest = deferred();
    invokeMock.mockImplementation((requested: string) => requested === command ? commandRequest.promise : Promise.resolve(fixtures[requested] ?? true));

    render(<HealthPage />);
    await openDiagnostics(name);
    const button = screen.getByRole('button', { name: `Restart ${name}` });
    fireEvent.click(button);
    await act(async () => commandRequest.resolve(false));

    await waitFor(() => expect(screen.getByRole('status', { name: `Restart ${name}` })).toHaveTextContent('not required'));
    expect(screen.getByRole('status', { name: `Restart ${name}` })).not.toHaveTextContent('restarted');
    expect(calls('get_system_health')).toBe(1);
  });

  it.each(commands)('redacts a rejected %s result and keeps the last health snapshot', async (name, command, key) => {
    const commandRequest = deferred();
    const initialHealth = healthFor(key, false, 'before');
    invokeMock.mockImplementation((requested: string) => {
      if (requested === command) return commandRequest.promise;
      if (requested === 'get_system_health') return Promise.resolve(initialHealth);
      return Promise.resolve(fixtures[requested] ?? true);
    });

    render(<HealthPage />);
    await openDiagnostics(name);
    fireEvent.click(screen.getByRole('button', { name: `Restart ${name}` }));
    await act(async () => commandRequest.reject(new Error('native secret must not render')));

    const alert = await screen.findByRole('alert', { name: `Restart ${name}` });
    expect(alert).toHaveTextContent(`Could not restart ${name}. Showing the last observed health snapshot.`);
    expect(alert).not.toHaveTextContent('native secret must not render');
    expect(within(alert).getByRole('button', { name: 'Retry restart' })).toBeEnabled();
    const detail = key === 'ollama' ? initialHealth.ollama.url : key === 'bun' ? initialHealth.bun_server.url : ':19878';
    expect(screen.getByText(detail)).toBeInTheDocument();
  });

  it('keeps a successful command unconfirmed until readback and retries only health after failure', async () => {
    const commandRequest = deferred();
    const readback = deferred();
    const initialHealth = healthFor('ollama', false, 'before');
    const confirmedHealth = healthFor('ollama', true, 'after');
    let readbackStarted = false;
    invokeMock.mockImplementation((requested: string) => {
      if (requested === 'jarvis_restart_ollama') return commandRequest.promise;
      if (requested === 'get_system_health') return readbackStarted ? readback.promise : Promise.resolve(initialHealth);
      return Promise.resolve(fixtures[requested] ?? true);
    });

    render(<HealthPage />);
    await openDiagnostics('Ollama');
    readbackStarted = true;
    fireEvent.click(screen.getByRole('button', { name: 'Restart Ollama' }));
    await act(async () => commandRequest.resolve(true));
    expect(screen.getByRole('status', { name: 'Restart Ollama' })).toHaveTextContent('Confirming');

    await act(async () => readback.reject(new Error('health read failed')));
    const alert = await screen.findByRole('alert', { name: 'Restart Ollama' });
    expect(alert).toHaveTextContent('health did not confirm');
    expect(alert).toHaveTextContent('stale');
    expect(screen.queryByText('Ollama restarted')).not.toBeInTheDocument();

    readbackStarted = false;
    invokeMock.mockImplementation((requested: string) => {
      if (requested === 'jarvis_restart_ollama') return Promise.resolve(true);
      if (requested === 'get_system_health') return Promise.resolve(confirmedHealth);
      return Promise.resolve(fixtures[requested] ?? true);
    });
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry health confirmation' }));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Restart Ollama' })).toHaveTextContent('restart confirmed'));
    expect(calls('jarvis_restart_ollama')).toBe(1);
  });

  it('does not announce success when the newest health read reports the service down', async () => {
    const downHealth = healthFor('proxy', false, 'after');
    invokeMock.mockImplementation((requested: string) => {
      if (requested === 'jarvis_restart_proxy') return Promise.resolve(true);
      if (requested === 'get_system_health') return Promise.resolve(downHealth);
      return Promise.resolve(fixtures[requested] ?? true);
    });

    render(<HealthPage />);
    await openDiagnostics('Claude proxy');
    fireEvent.click(screen.getByRole('button', { name: 'Restart Claude proxy' }));

    const alert = await screen.findByRole('alert', { name: 'Restart Claude proxy' });
    expect(alert).toHaveTextContent('health reported it not running');
    expect(alert).toHaveTextContent('stale');
    expect(screen.queryByText('Claude proxy restarted')).not.toBeInTheDocument();
    expect(screen.getByText(':19878')).toBeInTheDocument();
  });

  it('fences an older pre-write health completion', async () => {
    const oldRead = deferred();
    const initialHealth = healthFor('ollama', false, 'initial');
    const oldHealth = healthFor('ollama', false, 'old');
    const confirmedHealth = healthFor('ollama', true, 'confirmed');
    let oldReadActive = false;
    let restartStarted = false;
    invokeMock.mockImplementation((requested: string) => {
      if (requested === 'jarvis_restart_ollama') return Promise.resolve(true);
      if (requested === 'get_system_health') {
        if (oldReadActive && !restartStarted) return oldRead.promise;
        if (restartStarted) return Promise.resolve(confirmedHealth);
        return Promise.resolve(initialHealth);
      }
      return Promise.resolve(fixtures[requested] ?? true);
    });

    render(<HealthPage />);
    await openDiagnostics('Ollama');
    oldReadActive = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(calls('get_system_health')).toBe(2);

    restartStarted = true;
    fireEvent.click(screen.getByRole('button', { name: 'Restart Ollama' }));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Restart Ollama' })).toHaveTextContent('restart confirmed'));
    await act(async () => oldRead.resolve(oldHealth));

    expect(screen.getByRole('status', { name: 'Restart Ollama' })).toHaveTextContent('restart confirmed');
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument();
    expect(calls('get_system_health')).toBe(3);
  });
});
