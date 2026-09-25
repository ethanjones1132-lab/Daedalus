import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ControlCenterView from './ControlCenterView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('./McpPanel', () => ({ default: () => <div>MCP configuration</div> }));

type ConfirmableKey = 'ollama' | 'bun' | 'proxy';

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const profiles = [{ id: 'alpha', name: 'Alpha', provider: 'ollama', model: 'local', api_base: '', max_tokens: 1024, temperature: 0.5, top_p: 1, is_active: true, engine: 'local' }];
const doctor = { checks: [{ name: 'Synthetic check', status: 'ok', detail: 'Observed detail' }], summary: { total: 1, ok: 1, warn: 0, error: 0, overall: 'ok' }, timestamp: 'synthetic' };
const fixtures: Record<string, unknown> = { list_model_profiles: profiles, get_system_health: healthFor('ollama', true), get_doctor_report: doctor };

function healthFor(key: ConfirmableKey, running: boolean, timestamp = 'synthetic') {
  const health = {
    ollama: { running: key === 'ollama' ? running : true, model: 'local', url: 'http://ollama.test' },
    bun_server: { running: key === 'bun' ? running : true, url: 'http://bun.test' },
    bridge: { running: true, port: 19876 },
    claude_proxy: { running: key === 'proxy' ? running : true, port: 19878 },
    disk: { total: '100G', used: '20G', available: '80G', use_percent: '20%' },
    memory: { total_mb: 1000, available_mb: 700, used_mb: 300, used_percent: 30 },
    supervisor: { bun_give_up: false, proxy_give_up: false, ollama_give_up: false },
    timestamp,
  };
  return health;
}

const commands = [
  ['Ollama', 'jarvis_restart_ollama', 'ollama'],
  ['Bun server', 'jarvis_restart_server', 'bun'],
  ['Claude proxy', 'jarvis_restart_proxy', 'proxy'],
] as const;

const calls = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command).length;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string) => Promise.resolve(fixtures[command] ?? true));
});

async function openDiagnostics(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
  await screen.findByRole('button', { name: `Restart ${name}` });
}

describe('Control Center service restarts', () => {
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

    render(<ControlCenterView />);
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

    render(<ControlCenterView />);
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

    render(<ControlCenterView />);
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

    render(<ControlCenterView />);
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

    render(<ControlCenterView />);
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

    render(<ControlCenterView />);
    await screen.findByText('Alpha');
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
