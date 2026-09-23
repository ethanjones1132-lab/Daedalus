import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JarvisView from './JarvisView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('./SystemStatusBar', () => ({ default: () => null }));

const baseSession = {
  id: 'session-alpha',
  name: 'Alpha',
  model: 'test-model',
  message_count: 2,
  created_at: '2026-09-23T00:00:00Z',
  backend: 'ollama',
};

let sessions: typeof baseSession[];

function sessionFor(index: number, name = `Session ${index}`) {
  return { ...baseSession, id: `session-${index}`, name };
}

function selectionButton(name: string) {
  return screen.getByRole('button', { name: `Select session ${name}` });
}

function recentButton(name: string) {
  return within(screen.getByTestId('jarvis-persistent-nav')).getByRole('button', { name });
}

async function mountSessions() {
  render(<JarvisView initialSubView="sessions" />);
  await screen.findByRole('button', { name: 'Select session Alpha' });
}

async function returnToSessions(user: ReturnType<typeof userEvent.setup>, firstName = 'Alpha') {
  await user.click(screen.getByRole('tab', { name: 'Sessions' }));
  await screen.findByRole('button', { name: `Select session ${firstName}` });
}

beforeEach(() => {
  sessions = [sessionFor(1, 'Alpha'), sessionFor(2, 'Beta'), sessionFor(3, 'Gamma')];
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'jarvis_list_sessions') return sessions;
    if (command === 'get_session_history' || command === 'get_all_session_runs') return [];
    return null;
  });
});

afterEach(cleanup);

describe('Jarvis Session selection', () => {
  it.each(['{Enter}', ' '])('selects a Session with %s and exposes one current state', async (key) => {
    const user = userEvent.setup();
    await mountSessions();

    const alpha = selectionButton('Alpha');
    expect(alpha.tagName).toBe('BUTTON');
    expect(alpha).toHaveAttribute('type', 'button');
    expect(alpha).toHaveAttribute('aria-pressed', 'false');

    alpha.focus();
    await user.keyboard(key);
    await returnToSessions(user);

    expect(selectionButton('Alpha')).toHaveAttribute('aria-pressed', 'true');
    expect(selectionButton('Beta')).toHaveAttribute('aria-pressed', 'false');
    expect(selectionButton('Gamma')).toHaveAttribute('aria-pressed', 'false');
  });

  it('preserves mouse selection through the row content', async () => {
    const user = userEvent.setup();
    await mountSessions();

    const beta = selectionButton('Beta');
    await user.click(within(beta).getByText('Beta'));
    await returnToSessions(user);

    expect(selectionButton('Beta')).toHaveAttribute('aria-pressed', 'true');
    expect(selectionButton('Alpha')).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps the sticky recent-session controls in the same current state', async () => {
    const user = userEvent.setup();
    await mountSessions();

    const betaChip = recentButton('Beta');
    expect(betaChip).toHaveAttribute('aria-pressed', 'false');
    await user.click(betaChip);
    await returnToSessions(user);

    expect(selectionButton('Beta')).toHaveAttribute('aria-pressed', 'true');
    expect(recentButton('Beta')).toHaveAttribute('aria-pressed', 'true');
    expect(recentButton('Alpha')).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps every Session keyboard reachable beyond the six recent chips', async () => {
    const user = userEvent.setup();
    sessions = Array.from({ length: 8 }, (_, index) => sessionFor(index + 1, `Session ${index + 1}`));
    render(<JarvisView initialSubView="sessions" />);

    const eighth = await screen.findByRole('button', { name: 'Select session Session 8' });
    expect(within(screen.getByTestId('jarvis-persistent-nav')).queryByRole('button', { name: 'Session 8' })).not.toBeInTheDocument();
    eighth.focus();
    await user.keyboard('{Enter}');
    await returnToSessions(user, 'Session 1');

    expect(selectionButton('Session 8')).toHaveAttribute('aria-pressed', 'true');
    expect(selectionButton('Session 1')).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps Delete as an independent sibling that cannot select its row', async () => {
    const user = userEvent.setup();
    await mountSessions();

    await user.click(selectionButton('Alpha'));
    await returnToSessions(user);
    const alpha = selectionButton('Alpha');
    const deleteBeta = screen.getByRole('button', { name: 'Delete session Beta' });
    expect(alpha.querySelector('button, a, input, select, textarea')).toBeNull();
    expect(alpha.contains(deleteBeta)).toBe(false);

    deleteBeta.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('jarvis_delete_session', { sessionId: 'session-2' }));

    expect(selectionButton('Alpha')).toHaveAttribute('aria-pressed', 'true');
    expect(selectionButton('Beta')).toHaveAttribute('aria-pressed', 'false');
  });
});
