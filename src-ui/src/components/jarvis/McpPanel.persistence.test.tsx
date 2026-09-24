import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import McpPanel from './McpPanel';
import { ToastProvider } from '../ui';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const existing = { command: 'npx', args: ['-y', 'demo'], env: {}, disabled: false };
const saved = vi.fn();

beforeEach(() => {
  saved.mockReset();
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command === 'list_mcp_servers') return Promise.resolve({ existing: { ...existing } });
    if (command === 'save_mcp_servers') return saved();
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(cleanup);

async function renderLoaded() {
  render(<McpPanel />);
  await screen.findByPlaceholderText('server name (e.g. filesystem)');
}

describe('MCP persistence drafts and serialization', () => {
  it('freezes every mutation control and reports success only after resolution', async () => {
    const pending = deferred<void>();
    saved.mockReturnValueOnce(pending.promise);
    render(<ToastProvider><McpPanel /></ToastProvider>);
    await screen.findByPlaceholderText('npx');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    for (const input of screen.getAllByRole('textbox')) expect(input).toBeDisabled();
    const enabled = screen.getByRole('button', { name: 'Enabled' });
    const remove = screen.getByRole('button', { name: 'Remove' });
    expect(enabled).toBeDisabled();
    expect(remove).toBeDisabled();
    fireEvent.click(enabled);
    fireEvent.click(remove);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('MCP servers saved')).not.toBeInTheDocument();
    expect(saved).toHaveBeenCalledTimes(1);

    await act(async () => { pending.resolve(undefined); });
    expect(screen.getByText('MCP servers saved')).toBeInTheDocument();
    expect(enabled).toBeEnabled();
    expect(remove).toBeEnabled();
  });

  it('retries the edited retained draft without losing untouched entry fields', async () => {
    const first = deferred<void>();
    const retry = deferred<void>();
    const entry = { ...existing, cwd: '/synthetic/workspace', type: 'stdio', env: { DEMO: 'fixture' } };
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_mcp_servers') return Promise.resolve({ existing: entry });
      if (command === 'save_mcp_servers') return saved();
      throw new Error(`Unexpected command: ${command}`);
    });
    saved.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => { first.reject(new Error('synthetic rejection')); });
    fireEvent.change(screen.getByPlaceholderText('npx'), { target: { value: 'bun' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(invokeMock.mock.calls.filter(([c]) => c === 'save_mcp_servers')[1]).toEqual([
      'save_mcp_servers', { servers: { existing: { ...entry, command: 'bun' } } },
    ]);
    await act(async () => { retry.resolve(undefined); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('serializes saves and freezes the draft until persistence resolves', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    saved.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await renderLoaded();

    const nameInput = screen.getByPlaceholderText('server name (e.g. filesystem)');
    fireEvent.change(nameInput, { target: { value: 'new-server' } });
    const command = screen.getByPlaceholderText('npx');
    fireEvent.change(command, { target: { value: 'node' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(saved).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls.filter(([c]) => c === 'save_mcp_servers')).toEqual([
      ['save_mcp_servers', { servers: { existing: { ...existing, command: 'node' } } }],
    ]);
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(command).toBeDisabled();

    // Enter must not bypass the frozen form while a save is in flight.
    fireEvent.keyDown(nameInput, { key: 'Enter' });
    expect(saved).toHaveBeenCalledTimes(1);
    expect(nameInput).toHaveValue('new-server');
    expect(screen.queryByText('new-server')).not.toBeInTheDocument();

    await act(async () => { first.resolve(undefined); });
    expect(command).toHaveValue('node');
    expect(command).toBeEnabled();

    fireEvent.change(command, { target: { value: 'bun' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saved).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls.filter(([c]) => c === 'save_mcp_servers')[1]).toEqual([
      'save_mcp_servers',
      { servers: { existing: { ...existing, command: 'bun' } } },
    ]);
    await act(async () => { second.resolve(undefined); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not queue a second persistence when adding while a save is pending', async () => {
    const first = deferred<void>();
    saved.mockReturnValueOnce(first.promise);
    await renderLoaded();

    fireEvent.change(screen.getByPlaceholderText('server name (e.g. filesystem)'), {
      target: { value: 'new-server' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(saved).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls.filter(([c]) => c === 'save_mcp_servers')[0]).toEqual([
      'save_mcp_servers',
      { servers: { existing: { ...existing }, 'new-server': { args: [], env: {}, disabled: false } } },
    ]);
    expect(screen.getByText('new-server')).toBeInTheDocument();

    // Enter and a repeat Add click during pending must not start another save.
    fireEvent.keyDown(screen.getByPlaceholderText('server name (e.g. filesystem)'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(saved).toHaveBeenCalledTimes(1);

    await act(async () => { first.resolve(undefined); });
    expect(screen.getByText('new-server')).toBeInTheDocument();
  });

  it('preserves a failed add as an unsaved draft and retries without exposing native error detail', async () => {
    const first = deferred<void>();
    const retry = deferred<void>();
    saved.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    await renderLoaded();

    fireEvent.change(screen.getByPlaceholderText('server name (e.g. filesystem)'), {
      target: { value: 'new-server' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await act(async () => { first.reject(new Error('boom: .mcp.json api_key=sk-leaked')); });

    expect(screen.getByRole('alert')).toHaveTextContent('Could not save .mcp.json');
    expect(screen.getByRole('alert')).toHaveTextContent('not yet saved');
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sk-leaked/)).not.toBeInTheDocument();
    expect(screen.getByText('new-server')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
    expect(saved).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls.filter(([c]) => c === 'save_mcp_servers')[1]).toEqual([
      'save_mcp_servers',
      { servers: { existing: { ...existing }, 'new-server': { args: [], env: {}, disabled: false } } },
    ]);
    await act(async () => { retry.resolve(undefined); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('new-server')).toBeInTheDocument();
  });

  it('keeps a rejected removal as an explicit unsaved draft until a retry persists it', async () => {
    const first = deferred<void>();
    const retry = deferred<void>();
    saved.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));

    expect(saved).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls.filter(([c]) => c === 'save_mcp_servers')[0]).toEqual([
      'save_mcp_servers',
      { servers: {} },
    ]);

    await act(async () => { first.reject(new Error('write failed')); });
    expect(screen.getByRole('alert')).toHaveTextContent('not yet saved');
    expect(screen.queryByText('existing')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => { retry.resolve(undefined); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('existing')).not.toBeInTheDocument();
  });

  it('preserves exact argument boundaries through loading, editing, and saving', async () => {
    const save = deferred<void>();
    const entry = { ...existing, args: ['--root', 'C:\\Program Files\\repo'] };
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_mcp_servers') return Promise.resolve({ existing: entry });
      if (command === 'save_mcp_servers') return saved();
      throw new Error(`Unexpected command: ${command}`);
    });
    saved.mockReturnValueOnce(save.promise);
    await renderLoaded();

    const args = screen.getByLabelText('Args (JSON array)');
    expect(args).toHaveValue('["--root","C:\\\\Program Files\\\\repo"]');
    fireEvent.change(args, {
      target: { value: '["--root","D:\\\\Jarvis Data\\\\repo","--label=\\\"quoted value\\\""]' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(invokeMock.mock.calls.filter(([command]) => command === 'save_mcp_servers')[0]).toEqual([
      'save_mcp_servers',
      {
        servers: {
          existing: { ...entry, args: ['--root', 'D:\\Jarvis Data\\repo', '--label="quoted value"'] },
        },
      },
    ]);
    await act(async () => { save.resolve(undefined); });
  });

  it('retains invalid argument JSON and blocks persistence until it is corrected', async () => {
    await renderLoaded();

    const args = screen.getByLabelText('Args (JSON array)');
    fireEvent.change(args, { target: { value: '["--root",' } });

    expect(args).toHaveValue('["--root",');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter args as a JSON array of strings.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(saved).not.toHaveBeenCalled();

    fireEvent.change(args, { target: { value: '["--root","C:\\\\Program Files\\\\repo"]' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});
