import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import ControlCenterView from './ControlCenterView';

const { invokeMock, successMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), successMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('../ui', async (original) => ({ ...await original<typeof import('../ui')>(), useToast: () => ({ success: successMock, error: vi.fn() }) }));
vi.mock('./McpPanel', () => ({ default: () => <div>MCP configuration</div> }));

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const profiles = ['Alpha', 'Beta', 'Gamma'].map((name, index) => ({
  id: name.toLowerCase(), name, provider: 'ollama', model: 'local', api_base: '',
  max_tokens: 1024, temperature: 0.5, top_p: 1, is_active: index === 0, engine: 'local',
}));
const effective = { provider: 'effective-provider', model: 'effective-model', source: 'profile', applied_at: 'synthetic', restart_required: false };
const doctor = { checks: [{ name: 'Synthetic check', status: 'ok', detail: 'observed' }], summary: { total: 1, ok: 1, warn: 0, error: 0, overall: 'ok' }, timestamp: 'synthetic' };
const health = {
  ollama: { running: true, model: 'local', url: 'localhost' }, bun_server: { running: true, url: 'localhost' },
  bridge: { running: false, port: 1 }, claude_proxy: { running: true, port: 2 },
  disk: { total: '100G', used: '20G', available: '80G', use_percent: '20%' },
  memory: { total_mb: 1000, available_mb: 700, used_mb: 300, used_percent: 30 }, timestamp: 'synthetic',
};
const fixtures: Record<string, unknown> = { list_model_profiles: profiles, get_doctor_report: doctor, get_system_health: health };
const calls = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command);
const row = (name: string) => within(screen.getByText(name).closest('li')!);
const button = (name: string, action: string) => row(name).getByRole('button', { name: action });
async function openProfiles() {
  render(<ControlCenterView />);
  await screen.findByText('Alpha');
  fireEvent.click(screen.getByRole('button', { name: 'Profiles' }));
}
beforeEach(() => {
  invokeMock.mockReset(); successMock.mockReset();
  invokeMock.mockImplementation((command: string) => Promise.resolve(fixtures[command] ?? true));
});

it('serializes activation and deletion through readback without optimistic active state', async () => {
  await openProfiles();
  const write = deferred(); const read = deferred();
  invokeMock.mockImplementation((command: string) => command === 'set_active_profile' ? write.promise : command === 'list_model_profiles' ? read.promise : Promise.resolve(fixtures[command]));
  fireEvent.click(button('Beta', 'Activate')); fireEvent.click(button('Gamma', 'Activate')); fireEvent.click(button('Alpha', 'Delete'));
  expect(calls('set_active_profile')).toEqual([['set_active_profile', { id: 'beta' }]]);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(row('Alpha').getByText('active')).toBeInTheDocument();
  expect(row('Beta').queryByText('active')).not.toBeInTheDocument();
  expect(screen.getByRole('status', { name: 'Profile operation' })).toHaveTextContent(/activating Beta/i);
  for (const control of screen.getAllByRole('button', { name: /^(Activate|Delete)$/ })) expect(control).toBeDisabled();
  expect(successMock).not.toHaveBeenCalled();
  await act(async () => write.resolve(effective));
  expect(successMock).toHaveBeenCalledWith('Activated Beta · effective-provider/effective-model');
  expect(screen.getByRole('status', { name: 'Profile operation' })).toHaveTextContent(/reconcil/i);
  expect(button('Gamma', 'Activate')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
  expect(screen.getByText('Synthetic check')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Restart Bun server' }));
  await act(async () => {});
  expect(calls('list_model_profiles')).toHaveLength(2);
  await act(async () => read.resolve(profiles.map((p) => ({ ...p, is_active: p.id === 'beta' }))));
  fireEvent.click(screen.getByRole('button', { name: 'Profiles' }));
  expect(row('Beta').getByText('active')).toBeInTheDocument();
  expect(button('Gamma', 'Activate')).toBeEnabled();
});

it.each(['activate', 'delete'])('retains confirmed rows after rejected %s and offers inline recovery', async (operation) => {
  await openProfiles(); const write = deferred();
  invokeMock.mockImplementation((command: string) => command === (operation === 'activate' ? 'set_active_profile' : 'delete_profile') ? write.promise : Promise.resolve(fixtures[command]));
  fireEvent.click(button('Beta', operation === 'activate' ? 'Activate' : 'Delete'));
  if (operation === 'delete') fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
  await act(async () => write.reject(new Error('private native detail')));
  expect(screen.getByRole('alert', { name: 'Profile operation' })).toHaveTextContent(/could not/i);
  expect(screen.queryByText(/private native detail/)).not.toBeInTheDocument();
  expect(row('Alpha').getByText('active')).toBeInTheDocument();
  expect(screen.getByText('Beta')).toBeInTheDocument();
  expect(successMock).not.toHaveBeenCalled();
  const retry = screen.getByRole('button', { name: /Retry (activation|deletion)/ });
  // Activation retries the already-rejected promise in this fixture; flush its catch.
  await act(async () => { fireEvent.click(retry); });
  if (operation === 'delete') {
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Delete profile "Beta"?');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(calls('delete_profile')).toHaveLength(1);
  } else expect(calls('set_active_profile')).toHaveLength(2);
});

it.each(['activate', 'delete'])('never repeats a successful %s when reconciliation fails', async (operation) => {
  await openProfiles(); const read = deferred();
  invokeMock.mockImplementation((command: string) => command === 'list_model_profiles' ? read.promise : Promise.resolve(command === 'set_active_profile' ? effective : fixtures[command] ?? true));
  fireEvent.click(button('Beta', operation === 'activate' ? 'Activate' : 'Delete'));
  if (operation === 'delete') {
    const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' });
    fireEvent.click(confirm); fireEvent.click(confirm);
  }
  await act(async () => {});
  expect(button('Gamma', 'Activate')).toBeDisabled();
  await act(async () => read.reject(new Error('private readback detail')));
  expect(screen.getByRole('alert', { name: 'Profile operation' })).toHaveTextContent(/succeeded.*reconcil/i);
  expect(button('Gamma', 'Activate')).toBeDisabled();
  const retryRead = deferred();
  invokeMock.mockImplementation((command: string) => command === 'list_model_profiles' ? retryRead.promise : Promise.resolve(fixtures[command]));
  const retry = screen.getByRole('button', { name: 'Retry profile reconciliation' });
  fireEvent.click(retry); fireEvent.click(retry);
  expect(retry).toBeDisabled();
  expect(calls(operation === 'activate' ? 'set_active_profile' : 'delete_profile')).toHaveLength(1);
  expect(calls('list_model_profiles')).toHaveLength(3);
  await act(async () => retryRead.resolve(operation === 'delete' ? profiles.filter((p) => p.id !== 'beta') : profiles.map((p) => ({ ...p, is_active: p.id === 'beta' }))));
  expect(screen.queryByRole('alert', { name: 'Profile operation' })).not.toBeInTheDocument();
  expect(button('Gamma', 'Activate')).toBeEnabled();
  if (operation === 'delete') expect(screen.queryByText('Beta')).not.toBeInTheDocument();
});

it.each(['success', 'failure'])('ignores obsolete list %s both during the write and after reconciliation', async (outcome) => {
  await openProfiles(); const old = deferred(); const write = deferred(); const read = deferred();
  invokeMock.mockImplementation((command: string) => command === 'list_model_profiles' ? old.promise : Promise.resolve(fixtures[command]));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  invokeMock.mockImplementation((command: string) => command === 'list_model_profiles' ? read.promise : command === 'set_active_profile' ? write.promise : Promise.resolve(fixtures[command]));
  fireEvent.click(button('Beta', 'Activate'));
  await act(async () => { if (outcome === 'success') old.resolve([]); else old.reject(new Error('obsolete')); });
  expect(screen.getByText('Alpha')).toBeInTheDocument();
  expect(screen.queryByRole('alert', { name: 'Profiles observation' })).not.toBeInTheDocument();
  await act(async () => write.resolve(effective));
  await act(async () => read.resolve(profiles.map((p) => ({ ...p, is_active: p.id === 'beta' }))));
  expect(row('Beta').getByText('active')).toBeInTheDocument();
});

it('guards a previously opened deletion confirmation when activation starts', async () => {
  await openProfiles(); const write = deferred();
  invokeMock.mockImplementation((command: string) => command === 'set_active_profile' ? write.promise : Promise.resolve(fixtures[command]));
  fireEvent.click(button('Gamma', 'Delete'));
  const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' });
  // Programmatic dispatch also exercises the handler guard, beyond modal focus containment.
  fireEvent.click(button('Beta', 'Activate')); fireEvent.click(confirm);
  expect(calls('delete_profile')).toHaveLength(0);
  expect(calls('set_active_profile')).toHaveLength(1);
});
