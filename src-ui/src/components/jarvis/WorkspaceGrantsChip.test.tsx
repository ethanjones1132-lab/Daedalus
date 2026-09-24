import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import WorkspaceGrantsChip from './WorkspaceGrantsChip';

const SESSION = 'sess_test_123';
const OTHER_SESSION = 'sess_other';
const ROOT_A = 'C:\\Users\\ethan\\Projects\\demo-a';
const ROOT_B = 'C:\\Users\\ethan\\Projects\\demo-b';

function makeResponse(sessionId: string, grants: string[]) {
  return { session_id: sessionId, grants };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function getCalls() {
  return invokeMock.mock.calls.filter(([command]) => command === 'jarvis_get_session_grants');
}

function revokeCalls() {
  return invokeMock.mock.calls.filter(([command]) => command === 'jarvis_revoke_session_grant');
}

function renderChip(props: { sessionId: string; isStreaming?: boolean }) {
  return render(<WorkspaceGrantsChip sessionId={props.sessionId} isStreaming={props.isStreaming ?? false} />);
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args?: { sessionId?: string; root?: string }) => {
    if (command === 'jarvis_get_session_grants') return makeResponse(args?.sessionId ?? SESSION, []);
    if (command === 'jarvis_revoke_session_grant') return makeResponse(args?.sessionId ?? SESSION, []);
    return null;
  });
});

afterEach(cleanup);

describe('WorkspaceGrantsChip', () => {
  it('renders nothing without a selected Session', () => {
    const { container } = renderChip({ sessionId: '' });
    expect(container.firstChild).toBeNull();
    expect(getCalls()).toHaveLength(0);
  });

  it('renders nothing only after a successful empty response', async () => {
    const request = deferred<unknown>();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'jarvis_get_session_grants') return request.promise;
      return null;
    });
    const { container } = renderChip({ sessionId: SESSION });
    expect(await screen.findByRole('status', { name: 'Workspace grants loading' })).toBeInTheDocument();
    await act(async () => request.resolve(makeResponse(SESSION, [])));
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(getCalls()).toHaveLength(1);
  });

  it('shows a fixed read error and retries only the read', async () => {
    let calls = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'jarvis_get_session_grants') {
        calls += 1;
        if (calls === 1) throw new Error('private native detail');
        return makeResponse(SESSION, []);
      }
      return null;
    });

    renderChip({ sessionId: SESSION });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load workspace grants.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('private native detail');
    fireEvent.click(screen.getByRole('button', { name: 'Retry workspace grants' }));
    expect(screen.getByRole('status', { name: 'Workspace grants loading' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(calls).toBe(2);
    expect(revokeCalls()).toHaveLength(0);
  });

  it('rejects a malformed response instead of treating it as empty', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'jarvis_get_session_grants') return { session_id: SESSION };
      return null;
    });

    renderChip({ sessionId: SESSION });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load workspace grants.');
  });

  it('renders grants only from a matching Session response', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'jarvis_get_session_grants') return makeResponse(OTHER_SESSION, [ROOT_A]);
      return null;
    });

    renderChip({ sessionId: SESSION });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load workspace grants.');
    expect(screen.queryByText(ROOT_A)).not.toBeInTheDocument();
  });

  it('hides the previous Session controls while the next Session is pending', async () => {
    const beta = deferred<unknown>();
    invokeMock.mockImplementation(async (command: string, args?: { sessionId?: string }) => {
      if (command === 'jarvis_get_session_grants') {
        return args?.sessionId === SESSION ? makeResponse(SESSION, [ROOT_A]) : beta.promise;
      }
      return null;
    });

    const view = renderChip({ sessionId: SESSION });
    expect(await screen.findByText(ROOT_A)).toBeInTheDocument();
    view.rerender(<WorkspaceGrantsChip sessionId={OTHER_SESSION} isStreaming={false} />);
    expect(screen.queryByText(ROOT_A)).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Workspace grants loading' })).toBeInTheDocument();
    await act(async () => beta.resolve(makeResponse(OTHER_SESSION, [ROOT_B])));
    expect(screen.getByText(ROOT_B)).toBeInTheDocument();
  });

  it('ignores an obsolete response from the previous Session', async () => {
    const alpha = deferred<unknown>();
    const beta = deferred<unknown>();
    invokeMock.mockImplementation(async (command: string, args?: { sessionId?: string }) => {
      if (command === 'jarvis_get_session_grants') {
        return args?.sessionId === SESSION ? alpha.promise : beta.promise;
      }
      return null;
    });

    const view = renderChip({ sessionId: SESSION });
    await waitFor(() => expect(getCalls()).toHaveLength(1));
    view.rerender(<WorkspaceGrantsChip sessionId={OTHER_SESSION} isStreaming={false} />);
    await waitFor(() => expect(getCalls()).toHaveLength(2));
    await act(async () => alpha.resolve(makeResponse(SESSION, [ROOT_A])));
    expect(screen.queryByText(ROOT_A)).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Workspace grants loading' })).toBeInTheDocument();
    await act(async () => beta.resolve(makeResponse(OTHER_SESSION, [ROOT_B])));
    expect(screen.getByText(ROOT_B)).toBeInTheDocument();
  });

  it('retains known grants as stale after a failed refresh and recovers with a read', async () => {
    let reads = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'jarvis_get_session_grants') {
        reads += 1;
        if (reads === 2) throw new Error('refresh failed');
        return makeResponse(SESSION, [ROOT_A, ROOT_B]);
      }
      return null;
    });

    const view = renderChip({ sessionId: SESSION });
    expect(await screen.findByText(ROOT_A)).toBeInTheDocument();
    view.rerender(<WorkspaceGrantsChip sessionId={SESSION} isStreaming />);
    view.rerender(<WorkspaceGrantsChip sessionId={SESSION} isStreaming={false} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not refresh workspace grants.');
    expect(screen.getByText(ROOT_A)).toBeInTheDocument();
    expect(screen.getByText(ROOT_B)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry workspace grants' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(reads).toBe(3);
    expect(revokeCalls()).toHaveLength(0);
  });

  it('serializes repeated revoke input and publishes the authoritative remaining snapshot', async () => {
    const revoke = deferred<unknown>();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'jarvis_get_session_grants') return makeResponse(SESSION, [ROOT_A, ROOT_B]);
      if (command === 'jarvis_revoke_session_grant') return revoke.promise;
      return null;
    });

    renderChip({ sessionId: SESSION });
    const revokeButton = await screen.findByRole('button', { name: `Revoke grant for ${ROOT_A}` });
    fireEvent.click(revokeButton);
    fireEvent.click(revokeButton);
    expect(revokeCalls()).toHaveLength(1);
    expect(screen.getByRole('button', { name: `Revoke grant for ${ROOT_A}` })).toBeDisabled();
    expect(screen.getByText(ROOT_A)).toBeInTheDocument();
    await act(async () => revoke.resolve(makeResponse(SESSION, [ROOT_B])));
    expect(screen.queryByText(ROOT_A)).not.toBeInTheDocument();
    expect(screen.getByText(ROOT_B)).toBeInTheDocument();
  });

  it('retains a rejected revoke and makes recovery read-only', async () => {
    let reads = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'jarvis_get_session_grants') {
        reads += 1;
        return makeResponse(SESSION, [ROOT_A, ROOT_B]);
      }
      if (command === 'jarvis_revoke_session_grant') throw new Error('native revoke detail');
      return null;
    });

    renderChip({ sessionId: SESSION });
    fireEvent.click(await screen.findByRole('button', { name: `Revoke grant for ${ROOT_A}` }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not confirm workspace grant revoke.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('native revoke detail');
    expect(screen.getByText(ROOT_A)).toBeInTheDocument();
    expect(revokeCalls()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry workspace grants' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(revokeCalls()).toHaveLength(1);
  });

  it('retains the root after a mismatched revoke response and does not repeat the write', async () => {
    let reads = 0;
    invokeMock.mockImplementation(async (command: string, args?: { sessionId?: string }) => {
      if (command === 'jarvis_get_session_grants') {
        reads += 1;
        return makeResponse(args?.sessionId ?? SESSION, [ROOT_A, ROOT_B]);
      }
      if (command === 'jarvis_revoke_session_grant') return makeResponse(OTHER_SESSION, [ROOT_B]);
      return null;
    });

    renderChip({ sessionId: SESSION });
    fireEvent.click(await screen.findByRole('button', { name: `Revoke grant for ${ROOT_A}` }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not confirm workspace grant revoke.');
    expect(screen.getByText(ROOT_A)).toBeInTheDocument();
    expect(revokeCalls()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry workspace grants' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(revokeCalls()).toHaveLength(1);
  });

  it('does not allow revoke during an active Session turn', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'jarvis_get_session_grants') return makeResponse(SESSION, [ROOT_A]);
      return null;
    });
    renderChip({ sessionId: SESSION, isStreaming: true });
    expect(await screen.findByRole('button', { name: `Revoke grant for ${ROOT_A}` })).toBeDisabled();
  });

  it('refreshes once when streaming ends', async () => {
    const view = renderChip({ sessionId: SESSION, isStreaming: true });
    await waitFor(() => expect(getCalls()).toHaveLength(1));
    view.rerender(<WorkspaceGrantsChip sessionId={SESSION} isStreaming={false} />);
    await waitFor(() => expect(getCalls()).toHaveLength(2));
  });
});
