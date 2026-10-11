import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HealthPage from './HealthPage';
import { resetSharedBuildProvenanceStores } from '../../domain/build-provenance';
import { cleanBuild, deferred, doctor, status, stubUnreachableBun } from './test-fixtures';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const health = {
  ollama: { running: true, model: 'local', url: 'http://localhost:11434' },
  bun_server: { running: false, url: 'http://localhost:3000' },
  bridge: { running: false, port: 1 }, claude_proxy: { running: true, port: 2 },
  disk: { total: '100G', used: '20G', available: '80G', use_percent: '20%' },
  memory: { total_mb: 1000, available_mb: 700, used_mb: 300, used_percent: 30 },
  supervisor: { bun_give_up: true, proxy_give_up: false, ollama_give_up: false }, timestamp: 'synthetic',
};
const fixtures: Record<string, unknown> = {
  jarvis_check_status: status,
  get_system_health: health,
  get_doctor_report: doctor,
  get_build_info: cleanBuild,
};
const calls = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command).length;
beforeEach(() => {
  stubUnreachableBun();
  resetSharedBuildProvenanceStores();
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string) => Promise.resolve(fixtures[command] ?? true));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function diagnostics() { fireEvent.click(screen.getByRole('tab', { name: 'Diagnostics' })); }

// The legacy case also opened the MCP tab here. MCP configuration now lives on
// its own page (MCP route, S7), so this asserts the Health page instead: the
// doctor report is published while another resource is still pending / failed.
it('publishes diagnostics independently of a pending/failed status read', async () => {
  const pending = deferred();
  invokeMock.mockImplementation((command: string) => command === 'jarvis_check_status' ? pending.promise : Promise.resolve(fixtures[command]));
  render(<HealthPage />);
  diagnostics();
  expect(await screen.findByText('Synthetic check')).toBeInTheDocument();
  expect(screen.getByText('auto-restart paused')).toBeInTheDocument();
  await act(async () => pending.reject(new Error('private native detail')));
  expect(screen.getByText('Synthetic check')).toBeInTheDocument();
  expect(screen.getByRole('alert', { name: 'Status observation' })).toBeInTheDocument();
  expect(screen.queryByText(/private native detail/)).not.toBeInTheDocument();
  // The Inference backend panel is on the Overview tab; a failed status read
  // must not read as "no backend" — it says it could not load.
  fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
  expect(screen.getByRole('heading', { name: 'Inference backend' })).toBeInTheDocument();
  expect(screen.queryByText('test-model')).not.toBeInTheDocument();
});

describe.each([
  ['Status', 'Retry status', 'jarvis_check_status'],
  ['System health', 'Retry System health', 'get_system_health'],
  ['Doctor report', 'Retry Doctor report', 'get_doctor_report'],
])('%s recovery', (label, retryName, command) => {
  it('distinguishes pending, failure and success with guarded resource-only Retry', async () => {
    const pending = deferred();
    const retry = deferred();
    invokeMock.mockImplementation((name: string) => name === command ? pending.promise : Promise.resolve(fixtures[name]));
    render(<HealthPage />);
    expect(screen.getByRole('status', { name: `${label} observation` })).toBeInTheDocument();
    expect(screen.queryByText('Synthetic check')).not.toBeInTheDocument();
    await act(async () => pending.reject(new Error('private native detail')));
    const alert = screen.getByRole('alert', { name: `${label} observation` });
    invokeMock.mockImplementation((name: string) => name === command ? retry.promise : Promise.resolve(fixtures[name]));
    const button = within(alert).getByRole('button', { name: retryName });
    fireEvent.click(button); fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(calls(command)).toBe(2);
    for (const other of Object.keys(fixtures).filter((name) => name !== command && name !== 'get_build_info')) expect(calls(other)).toBe(1);
    await act(async () => retry.resolve(fixtures[command]));
    expect(screen.queryByRole('alert', { name: `${label} observation` })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Restart Ollama' })).toBeInTheDocument();
    expect(screen.getByText('test-model')).toBeInTheDocument();
    diagnostics();
    expect(screen.getByText('Synthetic check')).toBeInTheDocument();
    expect(screen.getByText('30%')).toBeInTheDocument();
    expect(screen.queryByText(/private native detail/)).not.toBeInTheDocument();
  });
});

it('treats a missing native status as a recoverable failure', async () => {
  invokeMock.mockImplementation((name: string) => Promise.resolve(name === 'jarvis_check_status' ? null : fixtures[name]));
  render(<HealthPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load status');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry status' })).toBeEnabled();
});

it('retains stale diagnostics through a failed refresh and pending recovery', async () => {
  render(<HealthPage />);
  await screen.findByRole('button', { name: 'Restart Ollama' });
  invokeMock.mockRejectedValue(new Error('private native detail'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByRole('alert', { name: 'Doctor report observation' });
  expect(screen.getByRole('button', { name: 'Restart Ollama' })).toBeInTheDocument();
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
  render(<HealthPage />);
  await screen.findByRole('button', { name: 'Restart Bun server' }); diagnostics();
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

describe('Status panel', () => {
  it('retains Status data on refresh failure, marks it stale through retry, and clears the warning only on success', async () => {
    render(<HealthPage />);
    await screen.findByText('test-model');
    const refresh = deferred();
    invokeMock.mockImplementation((name: string) => name === 'jarvis_check_status' ? refresh.promise : Promise.resolve(fixtures[name]));
    const button = screen.getByRole('button', { name: 'Refresh status' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(calls('jarvis_check_status')).toBe(2);
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing status');
    expect(screen.getByText('test-model')).toBeInTheDocument();
    await act(async () => refresh.reject('private-native-detail'));
    expect(screen.getByRole('alert')).toHaveTextContent('Showing previously loaded status; it may be stale');
    expect(screen.getByRole('alert')).not.toHaveTextContent('private-native-detail');
    expect(screen.getByText('test-model')).toBeInTheDocument();
    expect(button).toBeEnabled();

    const retry = deferred();
    invokeMock.mockImplementation((name: string) => name === 'jarvis_check_status' ? retry.promise : Promise.resolve(fixtures[name]));
    fireEvent.click(screen.getByRole('button', { name: 'Retry status' }));
    expect(screen.getByRole('alert')).toHaveTextContent('may be stale');
    expect(screen.getByRole('button', { name: 'Retry status' })).toBeDisabled();
    expect(button).toBeDisabled();
    await act(async () => retry.resolve({ ...status, model: 'next-model' }));
    expect(await screen.findByText('next-model')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it('starts and stops the bridge, then re-reads status and health; a failure is announced without native detail', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<HealthPage />);
      await screen.findByText('test-model');
      fireEvent.click(screen.getByRole('button', { name: 'Start Bridge' }));
      await act(async () => {});
      expect(calls('jarvis_start_bridge')).toBe(1);
      expect(calls('jarvis_check_status')).toBe(2);
      expect(calls('get_system_health')).toBe(2);

      invokeMock.mockImplementation((name: string) => name === 'jarvis_stop_bridge' ? Promise.reject(new Error('private bridge detail')) : Promise.resolve(fixtures[name]));
      fireEvent.click(screen.getByRole('button', { name: 'Stop Bridge' }));
      const alert = await screen.findByRole('alert', { name: 'Bridge operation' });
      expect(alert).toHaveTextContent('Could not stop the bridge.');
      expect(alert).not.toHaveTextContent('private bridge detail');
      expect(calls('jarvis_stop_bridge')).toBe(1);
      expect(calls('jarvis_check_status')).toBe(2);
    } finally {
      errorLog.mockRestore();
    }
  });
});
