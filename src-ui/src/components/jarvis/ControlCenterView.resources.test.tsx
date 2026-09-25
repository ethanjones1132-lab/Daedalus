import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ControlCenterView from './ControlCenterView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('./McpPanel', () => ({ default: () => <div>MCP configuration</div> }));

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const profiles = [{ id: 'alpha', name: 'Alpha', provider: 'ollama', model: 'local', api_base: '', max_tokens: 1024, temperature: 0.5, top_p: 1, is_active: true, engine: 'local' }];
const health = {
  ollama: { running: true, model: 'local', url: 'http://localhost:11434' },
  bun_server: { running: false, url: 'http://localhost:3000' },
  bridge: { running: false, port: 1 }, claude_proxy: { running: true, port: 2 },
  disk: { total: '100G', used: '20G', available: '80G', use_percent: '20%' },
  memory: { total_mb: 1000, available_mb: 700, used_mb: 300, used_percent: 30 },
  supervisor: { bun_give_up: true, proxy_give_up: false, ollama_give_up: false }, timestamp: 'synthetic',
};
const doctor = { checks: [{ name: 'Synthetic check', status: 'ok', detail: 'Observed detail' }], summary: { total: 1, ok: 1, warn: 0, error: 0, overall: 'ok' }, timestamp: 'synthetic' };
const fixtures: Record<string, unknown> = { list_model_profiles: profiles, get_system_health: health, get_doctor_report: doctor };
const calls = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command).length;
beforeEach(() => { invokeMock.mockReset(); invokeMock.mockImplementation((command: string) => Promise.resolve(fixtures[command] ?? true)); });

function diagnostics() { fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' })); }

it('publishes diagnostics independently of pending/failed profiles and keeps MCP accessible', async () => {
  const pending = deferred();
  invokeMock.mockImplementation((command: string) => command === 'list_model_profiles' ? pending.promise : Promise.resolve(fixtures[command]));
  render(<ControlCenterView />);
  diagnostics();
  expect(await screen.findByText('Synthetic check')).toBeInTheDocument();
  expect(screen.getByText('auto-restart paused')).toBeInTheDocument();
  await act(async () => pending.reject(new Error('private native detail')));
  expect(screen.getByText('Synthetic check')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'MCP' }));
  expect(screen.getByText('MCP configuration')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Profiles' }));
  expect(screen.getByRole('alert', { name: 'Profiles observation' })).toBeInTheDocument();
  expect(screen.queryByText('No model profiles configured.')).not.toBeInTheDocument();
  expect(screen.queryByText(/private native detail/)).not.toBeInTheDocument();
});

describe.each([
  ['Profiles', 'list_model_profiles'], ['System health', 'get_system_health'], ['Doctor report', 'get_doctor_report'],
])('%s recovery', (label, command) => {
  it('distinguishes pending, failure and success with guarded resource-only Retry', async () => {
    const pending = deferred();
    const retry = deferred();
    invokeMock.mockImplementation((name: string) => name === command ? pending.promise : Promise.resolve(fixtures[name]));
    render(<ControlCenterView />);
    expect(screen.getByRole('status', { name: `${label} observation` })).toBeInTheDocument();
    expect(screen.queryByText('No active profile.')).not.toBeInTheDocument();
    await act(async () => pending.reject(new Error('private native detail')));
    const alert = screen.getByRole('alert', { name: `${label} observation` });
    invokeMock.mockImplementation((name: string) => name === command ? retry.promise : Promise.resolve(fixtures[name]));
    const button = within(alert).getByRole('button', { name: `Retry ${label}` });
    fireEvent.click(button); fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(calls(command)).toBe(2);
    for (const other of Object.keys(fixtures).filter((name) => name !== command)) expect(calls(other)).toBe(1);
    await act(async () => retry.resolve(fixtures[command]));
    expect(screen.queryByRole('alert', { name: `${label} observation` })).not.toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    diagnostics();
    expect(screen.getByText('Synthetic check')).toBeInTheDocument();
    expect(screen.getByText('30%')).toBeInTheDocument();
    expect(screen.queryByText(/private native detail/)).not.toBeInTheDocument();
  });
});

it('retains stale diagnostics and profiles through a failed refresh and pending recovery', async () => {
  render(<ControlCenterView />);
  await screen.findByText('Alpha');
  invokeMock.mockRejectedValue(new Error('private native detail'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByRole('alert', { name: 'Doctor report observation' });
  expect(screen.getByText('Alpha')).toBeInTheDocument();
  diagnostics();
  expect(screen.getByText('Synthetic check')).toBeInTheDocument();
  expect(screen.getByText('30%')).toBeInTheDocument();
  for (const label of ['System health', 'Doctor report']) expect(screen.getByRole('alert', { name: `${label} observation` })).toHaveTextContent(/stale/i);
  const pending = deferred(); invokeMock.mockReturnValue(pending.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Retry Doctor report' }));
  expect(screen.getByRole('button', { name: 'Retry Doctor report' })).toBeDisabled();
  expect(screen.getByRole('alert', { name: 'Doctor report observation' })).toHaveTextContent(/stale/i);
  await act(async () => pending.resolve({ ...doctor, checks: [] }));
  expect(screen.queryByText('Synthetic check')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert', { name: 'Doctor report observation' })).not.toBeInTheDocument();
});

it.each(['success', 'failure'])('ignores obsolete %s after a post-restart refresh', async (outcome) => {
  render(<ControlCenterView />);
  await screen.findByText('Alpha'); diagnostics();
  const old = deferred();
  invokeMock.mockImplementation((command: string) => command === 'get_doctor_report' ? old.promise : Promise.resolve(fixtures[command] ?? true));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
  invokeMock.mockImplementation((command: string) => Promise.resolve(
     command === 'get_doctor_report'
       ? { ...doctor, checks: [{ name: 'New observation', status: 'ok', detail: 'new' }] }
       : command === 'get_system_health'
         ? { ...health, bun_server: { ...health.bun_server, running: true } }
         : fixtures[command] ?? true,
   ));
  fireEvent.click(screen.getByRole('button', { name: 'Restart Bun server' }));
  await screen.findByText('New observation');
  await act(async () => { if (outcome === 'success') old.resolve(doctor); else old.reject(new Error('obsolete error')); });
  expect(screen.getByText('New observation')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(calls('get_doctor_report')).toBe(3);
});
