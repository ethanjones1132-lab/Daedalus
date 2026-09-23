import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './JarvisView';

const { invokeMock, listenMock, listeners } = vi.hoisted(() => {
  const eventListeners = new Map<string, (event: { payload: unknown }) => void>();
  return {
    invokeMock: vi.fn(),
    listenMock: vi.fn(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
      eventListeners.set(eventName, handler);
      return () => {
        if (eventListeners.get(eventName) === handler) eventListeners.delete(eventName);
      };
    }),
    listeners: eventListeners,
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

const props = {
  activeSession: 'session-1',
  setActiveSession: vi.fn(),
  config: null,
  backendLabel: 'OpenRouter',
  modelLabel: 'test-model',
  onSessionCreated: vi.fn(),
};

type ApprovalPayload = {
  call_id: string;
  name: string;
  arguments: unknown;
  session_id: string;
};

const request: ApprovalPayload = {
  call_id: 'call-1234567890-abcdef',
  name: 'filesystem.write',
  arguments: {
    path: 'src/example.ts',
    edits: [{ find: 'before', replace: 'after' }],
  },
  session_id: 'session-1',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function decisionCalls() {
  return invokeMock.mock.calls.filter(([command]) => command === 'jarvis_tool_decision');
}

function ChatApprovalHarness() {
  const [showOpener, setShowOpener] = useState(true);
  return (
    <>
      {showOpener && <button type="button">Outside control</button>}
      <button type="button" onClick={() => setShowOpener(false)}>Remove outside control</button>
      <ChatPanel {...props} />
    </>
  );
}

async function renderPanel() {
  const view = render(<ChatApprovalHarness />);
  await waitFor(() => expect(listeners.has('jarvis://approval_request')).toBe(true));
  return view;
}

async function emitApproval(payload: Partial<ApprovalPayload> = {}, expectDialog = true) {
  const listener = listeners.get('jarvis://approval_request');
  expect(listener).toBeDefined();
  await act(async () => {
    listener?.({ payload: { ...request, ...payload } });
  });
  if (expectDialog) return screen.findByRole('dialog', { name: 'Tool approval required' });
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'get_session_history') return [];
    return true;
  });
  listeners.clear();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe('ChatPanel tool approval decisions', () => {
  it('filters approval events and renders the complete active request with deliberate initial focus', async () => {
    await renderPanel();
    await emitApproval({ session_id: 'session-2' }, false);
    await emitApproval({ session_id: undefined }, false);
    expect(screen.queryByRole('dialog', { name: 'Tool approval required' })).not.toBeInTheDocument();

    await emitApproval();
    expect(screen.getByText('filesystem.write')).toBeInTheDocument();
    expect(JSON.parse(screen.getByLabelText('Tool arguments').textContent || '')).toEqual(request.arguments);
    expect(screen.getByText(request.call_id.slice(0, 12))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('heading', { name: 'Tool Approval Required' }));
    expect(decisionCalls()).toHaveLength(0);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reject tool call' })).toHaveFocus());
  });

  it('contains focus in both directions and pulls escaped focus back', async () => {
    await renderPanel();
    await emitApproval();
    const reject = screen.getByRole('button', { name: 'Reject tool call' });
    const approve = screen.getByRole('button', { name: 'Approve tool call' });

    expect(fireEvent.keyDown(reject, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(approve).toHaveFocus();
    expect(fireEvent.keyDown(approve, { key: 'Tab' })).toBe(false);
    expect(reject).toHaveFocus();

    const outside = screen.getByRole('button', { name: 'Outside control' });
    outside.focus();
    expect(reject).toHaveFocus();
  });

  it.each([
    ['Reject', '{Enter}', 'deny'],
    ['Approve', '{Enter}', 'approve'],
    ['Reject', ' ', 'deny'],
    ['Approve', ' ', 'approve'],
  ] as const)('lets Enter and Space activate only the focused %s control', async (control, key, decision) => {
    const pending = deferred<void>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_session_history') return Promise.resolve([]);
      if (command === 'jarvis_tool_decision') return pending.promise;
      return Promise.resolve(true);
    });
    const user = userEvent.setup();
    await renderPanel();
    await emitApproval();
    screen.getByRole('button', { name: `${control} tool call` }).focus();

    await user.keyboard(key);
    const calls = decisionCalls();
    await act(async () => pending.resolve());
    expect(calls).toEqual([[
      'jarvis_tool_decision',
      {
        sessionId: 'session-1',
        session_id: 'session-1',
        toolCallId: request.call_id,
        tool_call_id: request.call_id,
        decision,
      },
    ]]);
  });

  it('serializes repeated decision input across every entry path while pending', async () => {
    const pending = deferred<void>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_session_history') return Promise.resolve([]);
      if (command === 'jarvis_tool_decision') return pending.promise;
      return Promise.resolve(true);
    });
    await renderPanel();
    await emitApproval();
    const dialog = screen.getByRole('dialog', { name: 'Tool approval required' });
    const reject = screen.getByRole('button', { name: 'Reject tool call' });
    const approve = screen.getByRole('button', { name: 'Approve tool call' });

    fireEvent.click(approve);
    fireEvent.click(approve);
    fireEvent.click(reject);
    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document, { key: ' ' });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(dialog);

    expect(screen.getByRole('status', { name: 'Tool approval decision pending' })).toHaveTextContent('Submitting tool approval decision.');
    expect(reject).toBeDisabled();
    expect(approve).toBeDisabled();
    const calls = decisionCalls();
    await act(async () => pending.resolve());
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ decision: 'approve', toolCallId: request.call_id });
  });

  it.each([
    ['Approve', 'approve'],
    ['Reject', 'deny'],
    ['Escape', 'deny'],
    ['Backdrop', 'deny'],
  ] as const)('restores the opener after %s closes the dialog', async (action, decision) => {
    await renderPanel();
    const outside = screen.getByRole('button', { name: 'Outside control' });
    outside.focus();
    await emitApproval();
    const dialog = screen.getByRole('dialog', { name: 'Tool approval required' });

    if (action === 'Approve') fireEvent.click(screen.getByRole('button', { name: 'Approve tool call' }));
    else if (action === 'Reject') fireEvent.click(screen.getByRole('button', { name: 'Reject tool call' }));
    else if (action === 'Escape') fireEvent.keyDown(screen.getByRole('button', { name: 'Reject tool call' }), { key: 'Escape' });
    else fireEvent.click(dialog);

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Tool approval required' })).not.toBeInTheDocument());
    await waitFor(() => expect(outside).toHaveFocus());
    expect(decisionCalls()).toHaveLength(1);
    expect(decisionCalls()[0][1]).toMatchObject({ decision });
  });

  it.each(['Escape', 'Backdrop'] as const)('issues one rejection for repeated %s input', async (action) => {
    const pending = deferred<void>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_session_history') return Promise.resolve([]);
      if (command === 'jarvis_tool_decision') return pending.promise;
      return Promise.resolve(true);
    });
    await renderPanel();
    await emitApproval();
    const reject = screen.getByRole('button', { name: 'Reject tool call' });
    const dialog = screen.getByRole('dialog', { name: 'Tool approval required' });

    if (action === 'Escape') {
      fireEvent.keyDown(reject, { key: 'Escape' });
      fireEvent.keyDown(reject, { key: 'Escape' });
    } else {
      fireEvent.click(dialog);
      fireEvent.click(dialog);
    }

    const calls = decisionCalls();
    await act(async () => pending.resolve());
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ decision: 'deny' });
  });

  it('falls back to the document when the captured opener disappears', async () => {
    await renderPanel();
    const opener = screen.getByRole('button', { name: 'Outside control' });
    opener.focus();
    const focus = vi.spyOn(opener, 'focus');
    await emitApproval();
    fireEvent.click(screen.getByRole('button', { name: 'Remove outside control' }));
    expect(opener.isConnected).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Approve tool call' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Tool approval required' })).not.toBeInTheDocument());
    await waitFor(() => expect(document.body).toHaveFocus());
    expect(focus).not.toHaveBeenCalled();
    expect(document.body).not.toHaveAttribute('tabindex');
  });

  it('retains a rejected request with redacted recovery and repeats only the same decision', async () => {
    const first = deferred<void>();
    const retry = deferred<void>();
    let decisionAttempt = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_session_history') return Promise.resolve([]);
      if (command === 'jarvis_tool_decision') {
        decisionAttempt += 1;
        return decisionAttempt === 1 ? first.promise : retry.promise;
      }
      return Promise.resolve(true);
    });
    await renderPanel();
    await emitApproval();
    fireEvent.click(screen.getByRole('button', { name: 'Reject tool call' }));
    await act(async () => first.reject(new Error('private native detail')));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Tool approval decision failed. Retry the same decision.');
    expect(alert).not.toHaveTextContent('private native detail');
    expect(screen.getByText('filesystem.write')).toBeInTheDocument();
    expect(JSON.parse(screen.getByLabelText('Tool arguments').textContent || '')).toEqual(request.arguments);

    const retryButton = screen.getByRole('button', { name: 'Retry tool decision' });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    const calls = decisionCalls();
    await act(async () => retry.resolve());
    expect(calls).toEqual([
      ['jarvis_tool_decision', {
        sessionId: 'session-1',
        session_id: 'session-1',
        toolCallId: request.call_id,
        tool_call_id: request.call_id,
        decision: 'deny',
      }],
      ['jarvis_tool_decision', {
        sessionId: 'session-1',
        session_id: 'session-1',
        toolCallId: request.call_id,
        tool_call_id: request.call_id,
        decision: 'deny',
      }],
    ]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Tool approval required' })).not.toBeInTheDocument());
  });
});
