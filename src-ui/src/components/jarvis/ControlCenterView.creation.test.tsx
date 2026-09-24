import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../ui';
import ControlCenterView from './ControlCenterView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const profiles = [
  {
    id: 'alpha', name: 'Alpha', provider: 'ollama', model: 'local-model', api_base: '',
    max_tokens: 1024, temperature: 0.5, top_p: 1, is_active: true, engine: 'native',
  },
  {
    id: 'beta', name: 'Beta', provider: 'openrouter', model: 'vendor/beta', api_base: '',
    max_tokens: 2048, temperature: 0.4, top_p: 0.9, is_active: false, engine: 'native',
  },
];
const created = {
  id: 'created', name: 'Daily coding', provider: 'openrouter', model: 'vendor/model', api_base: 'https://openrouter.ai/api/v1',
  max_tokens: 2048, temperature: 0.25, top_p: 0.9, is_active: false, engine: 'native',
};
const health = {
  ollama: { running: true, model: 'local-model', url: 'http://localhost:11434' },
  bun_server: { running: true, url: 'http://localhost:19877' },
  bridge: { running: false, port: 19876 },
  claude_proxy: { running: false, port: 19878 },
  disk: { total: '100G', used: '20G', available: '80G', use_percent: '20%' },
  memory: { total_mb: 1000, available_mb: 700, used_mb: 300, used_percent: 30 },
  timestamp: '2026-09-24T00:00:00Z',
};
const doctor = {
  checks: [{ name: 'Synthetic check', status: 'ok', detail: 'observed' }],
  summary: { total: 1, ok: 1, warn: 0, error: 0, overall: 'ok' },
  timestamp: '2026-09-24T00:00:00Z',
};

function defaultCommand(command: string) {
  if (command === 'list_model_profiles') return Promise.resolve(profiles);
  if (command === 'get_system_health') return Promise.resolve(health);
  if (command === 'get_doctor_report') return Promise.resolve(doctor);
  throw new Error(`Unexpected command: ${command}`);
}

const createCalls = () => invokeMock.mock.calls.filter(([command]) => command === 'create_profile');
const nameInput = () => screen.getByRole('textbox', { name: 'Name' });
const backendInput = () => screen.getByRole('textbox', { name: 'Backend' });
const modelInput = () => screen.getByRole('textbox', { name: 'Model' });
const maxTokensInput = () => screen.getByRole('spinbutton', { name: 'Max tokens' });
const temperatureInput = () => screen.getByRole('spinbutton', { name: 'Temperature' });
const topPInput = () => screen.getByRole('spinbutton', { name: 'Top P' });
const engineInput = () => screen.getByRole('textbox', { name: 'Engine' });

async function openDraft() {
  render(<ToastProvider><ControlCenterView /></ToastProvider>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Profiles' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Profiles' }));
  fireEvent.click(screen.getByRole('button', { name: 'New profile' }));
}

function fillDraft() {
  fireEvent.change(nameInput(), { target: { value: 'Daily coding' } });
  fireEvent.change(backendInput(), { target: { value: 'openrouter' } });
  fireEvent.change(modelInput(), { target: { value: 'vendor/model' } });
  fireEvent.change(maxTokensInput(), { target: { value: '2048' } });
  fireEvent.change(temperatureInput(), { target: { value: '0.25' } });
  fireEvent.change(topPInput(), { target: { value: '0.9' } });
  fireEvent.change(engineInput(), { target: { value: 'native' } });
}

beforeEach(() => {
  invokeMock.mockReset().mockImplementation(defaultCommand);
});
afterEach(() => cleanup());

describe('Control Center model profile creation', () => {
  it('validates the draft and submits one exact flat request while fields are frozen', async () => {
    await openDraft();
    const create = screen.getByRole('button', { name: 'Create profile' });
    fireEvent.click(create);
    expect(screen.getByRole('alert', { name: 'Profile creation' })).toHaveTextContent('Name, backend, and model are required.');
    expect(createCalls()).toHaveLength(0);

    fillDraft();
    const request = deferred<typeof created>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'create_profile') return request.promise;
      if (command === 'list_model_profiles') return Promise.resolve([...profiles, created]);
      return defaultCommand(command);
    });
    fireEvent.click(create);
    fireEvent.click(create);

    expect(createCalls()).toEqual([[
      'create_profile',
      {
        name: 'Daily coding',
        backend: 'openrouter',
        model: 'vendor/model',
        temperature: 0.25,
        maxTokens: 2048,
        topP: 0.9,
        engine: 'native',
      },
    ]]);
    expect(screen.getByRole('status', { name: 'Profile creation' })).toHaveTextContent('Creating profile');
    expect(create).toBeDisabled();
    expect(nameInput()).toBeDisabled();
    expect(backendInput()).toBeDisabled();
    expect(modelInput()).toBeDisabled();
    expect(maxTokensInput()).toBeDisabled();
    expect(temperatureInput()).toBeDisabled();
    expect(topPInput()).toBeDisabled();
    expect(engineInput()).toBeDisabled();
    expect(screen.queryByText('Created "Daily coding"')).not.toBeInTheDocument();

    await act(async () => { request.resolve(created); });
    expect(await screen.findByText('Created "Daily coding"')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    expect(screen.getByText('Daily coding')).toBeInTheDocument();
  });

  it('retains a rejected draft and serializes its guarded retry', async () => {
    await openDraft();
    fillDraft();
    const first = deferred<typeof created>();
    invokeMock.mockImplementation((command: string) => command === 'create_profile' ? first.promise : defaultCommand(command));
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));
    await act(async () => { first.reject(new Error('synthetic private native detail')); });

    expect(screen.getByRole('alert', { name: 'Profile creation' })).toHaveTextContent('Could not create profile. Your draft has been kept.');
    expect(screen.queryByText(/synthetic private native detail/)).not.toBeInTheDocument();
    expect(nameInput()).toHaveValue('Daily coding');
    expect(backendInput()).toHaveValue('openrouter');
    expect(modelInput()).toHaveValue('vendor/model');
    expect(maxTokensInput()).toHaveValue(2048);
    expect(temperatureInput()).toHaveValue(0.25);
    expect(topPInput()).toHaveValue(0.9);
    expect(engineInput()).toHaveValue('native');

    const second = deferred<typeof created>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'create_profile') return second.promise;
      if (command === 'list_model_profiles') return Promise.resolve([...profiles, created]);
      return defaultCommand(command);
    });
    const retry = screen.getByRole('button', { name: 'Retry profile creation' });
    fireEvent.click(retry);
    const pendingRetry = screen.getByRole('button', { name: 'Retry profile creation' });
    fireEvent.click(pendingRetry);
    expect(createCalls()).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Retry profile creation' })).toBeDisabled();
    expect(screen.getByRole('status', { name: 'Profile creation' })).toHaveTextContent('Creating profile');

    await act(async () => { second.resolve(created); });
    expect(await screen.findByText('Created "Daily coding"')).toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: 'Profile creation' })).not.toBeInTheDocument();
  });

  it('treats a missing readback row as reconciliation failure and retries only the list', async () => {
    await openDraft();
    fillDraft();
    const request = deferred<typeof created>();
    const readback = deferred<typeof profiles>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'create_profile') return request.promise;
      if (command === 'list_model_profiles') return readback.promise;
      return defaultCommand(command);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));
    await act(async () => { request.resolve(created); });
    await act(async () => { readback.resolve([]); });

    expect(screen.getByRole('alert', { name: 'Profile reconciliation' })).toHaveTextContent('Profile created, but the profile list did not confirm it. Retry reloads the list only.');
    expect(createCalls()).toHaveLength(1);
    expect(screen.queryByText('Created "Daily coding"')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();

    const retryRead = deferred<typeof profiles>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_model_profiles') return retryRead.promise;
      return defaultCommand(command);
    });
    const retry = screen.getByRole('button', { name: 'Retry profile list' });
    fireEvent.click(retry);
    const pendingRetry = screen.getByRole('button', { name: 'Retry profile list' });
    fireEvent.click(pendingRetry);
    expect(createCalls()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Retry profile list' })).toBeDisabled();
    expect(screen.getByRole('status', { name: 'Profile creation' })).toHaveTextContent('Refreshing profile list');

    await act(async () => { retryRead.resolve([...profiles, created]); });
    expect(await screen.findByText('Created "Daily coding"')).toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: 'Profile reconciliation' })).not.toBeInTheDocument();
  });
});
