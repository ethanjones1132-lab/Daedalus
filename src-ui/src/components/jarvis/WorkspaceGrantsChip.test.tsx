import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Mock the Tauri IPC layer with a hoisted mock so we can stage invoke
// responses per test. Same pattern as SkillsView.test.tsx.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import WorkspaceGrantsChip from './WorkspaceGrantsChip';

const SESSION = 'sess_test_123';
const ROOT_A = 'C:\\Users\\ethan\\Projects\\demo-a';
const ROOT_B = 'C:\\Users\\ethan\\Projects\\demo-b';

function makeResponse(sessionId: string, grants: string[]) {
  return { session_id: sessionId, grants };
}

beforeEach(() => {
  invokeMock.mockReset();
  // Default: no grants. Tests override per-case.
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'jarvis_get_session_grants') return makeResponse(SESSION, []);
    if (cmd === 'jarvis_revoke_session_grant') return null;
    return null;
  });
});

function renderChip(props: { sessionId: string; isStreaming?: boolean }) {
  return render(<WorkspaceGrantsChip sessionId={props.sessionId} isStreaming={props.isStreaming ?? false} />);
}

describe('WorkspaceGrantsChip (session-scoped grant visibility + revoke)', () => {
  // ── 1. null state — no chip rendered ──
  it('renders nothing when sessionId is empty', () => {
    const { container } = renderChip({ sessionId: '' });
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the server returns an empty grants list', async () => {
    const { container } = renderChip({ sessionId: SESSION });
    // Wait for the mount effect's invoke to resolve.
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('jarvis_get_session_grants', { sessionId: SESSION }));
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the server response has grants === undefined', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'jarvis_get_session_grants') return { session_id: SESSION };
      return null;
    });
    const { container } = renderChip({ sessionId: SESSION });
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  // ── 2. error tolerance — chip disappears instead of crashing ──
  it('silently swallows jarvis_get_session_grants errors and renders null', async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error('IPC bridge disconnected');
    });
    const { container } = renderChip({ sessionId: SESSION });
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    // The catch path sets grants to []; the chip is gated on grants.length > 0.
    expect(container.firstChild).toBeNull();
  });

  // ── 3. happy path — one grant renders as a chip ──
  it('renders one chip per grant with the absolute path as visible text', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'jarvis_get_session_grants') return makeResponse(SESSION, [ROOT_A]);
      return null;
    });
    renderChip({ sessionId: SESSION });
    const container = await screen.findByLabelText('Session-granted filesystem roots');
    expect(container).toBeInTheDocument();
    expect(container.textContent).toContain(ROOT_A);
  });

  it('renders multiple grants as multiple chips in the order the server returned them', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'jarvis_get_session_grants') return makeResponse(SESSION, [ROOT_A, ROOT_B]);
      return null;
    });
    renderChip({ sessionId: SESSION });
    const container = await screen.findByLabelText('Session-granted filesystem roots');
    // Both roots must be present.
    expect(container.textContent).toContain(ROOT_A);
    expect(container.textContent).toContain(ROOT_B);
    // The header is always present.
    expect(container.textContent?.toLowerCase()).toContain('workspace grants');
  });

  // ── 4. revoke — optimistic removal, IPC, then refresh ──
  it('removes a grant chip optimistically and invokes jarvis_revoke_session_grant with the root', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'jarvis_get_session_grants') return makeResponse(SESSION, [ROOT_A, ROOT_B]);
      if (cmd === 'jarvis_revoke_session_grant') return null;
      return null;
    });
    renderChip({ sessionId: SESSION });
    const revokeA = await screen.findByLabelText(`Revoke grant for ${ROOT_A}`);
    fireEvent.click(revokeA);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('jarvis_revoke_session_grant', { sessionId: SESSION, root: ROOT_A }));
    // Optimistic: ROOT_A chip is gone immediately, ROOT_B remains.
    await waitFor(() => expect(screen.queryByText(ROOT_A)).toBeNull());
    expect(screen.getByText(ROOT_B)).toBeInTheDocument();
  });

  it('re-syncs from the server when revoke IPC fails (catches and refreshes)', async () => {
    // The first call returns both grants. After the user clicks revoke A,
    // the revoke IPC throws. The chip's catch handler re-calls
    // jarvis_get_session_grants, which we re-stage to return BOTH grants
    // again (simulating the server never actually deleted it).
    let revokeAttempted = false;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'jarvis_get_session_grants') return makeResponse(SESSION, [ROOT_A, ROOT_B]);
      if (cmd === 'jarvis_revoke_session_grant') {
        revokeAttempted = true;
        throw new Error('revoke failed');
      }
      return null;
    });
    renderChip({ sessionId: SESSION });
    const revokeA = await screen.findByLabelText(`Revoke grant for ${ROOT_A}`);
    fireEvent.click(revokeA);
    // After the failure, the chip re-fetches the grants list.
    await waitFor(() => expect(revokeAttempted).toBe(true));
    // The re-fetch brings ROOT_A back.
    await waitFor(() => expect(screen.getByText(ROOT_A)).toBeInTheDocument());
    // And the IPC was called again (initial + post-failure refresh).
    const getCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'jarvis_get_session_grants');
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });

  // ── 5. session-change refresh — new sessionId re-fetches ──
  it('re-fetches grants when sessionId changes', async () => {
    const { rerender } = renderChip({ sessionId: SESSION });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('jarvis_get_session_grants', { sessionId: SESSION }));
    const priorCallCount = invokeMock.mock.calls.length;
    // Switch to a different session.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'jarvis_get_session_grants') return makeResponse('sess_other', []);
      return null;
    });
    rerender(<WorkspaceGrantsChip sessionId="sess_other" isStreaming={false} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('jarvis_get_session_grants', { sessionId: 'sess_other' }));
    expect(invokeMock.mock.calls.length).toBeGreaterThan(priorCallCount);
  });

  it('re-fetches grants when isStreaming flips back to false (a turn just finished)', async () => {
    const { rerender } = renderChip({ sessionId: SESSION, isStreaming: true });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('jarvis_get_session_grants', { sessionId: SESSION }));
    const beforeStreamEndCount = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'jarvis_get_session_grants',
    ).length;
    // Flip to isStreaming=false → the "stream just finished" effect fires.
    rerender(<WorkspaceGrantsChip sessionId={SESSION} isStreaming={false} />);
    await waitFor(() => {
      const after = invokeMock.mock.calls.filter(([cmd]) => cmd === 'jarvis_get_session_grants').length;
      expect(after).toBeGreaterThan(beforeStreamEndCount);
    });
  });
});
