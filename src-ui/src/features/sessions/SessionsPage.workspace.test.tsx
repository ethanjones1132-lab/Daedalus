import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionsPage from './SessionsPage';
import { ChatPanel, INSPECTOR_STORAGE_KEY } from './ChatPanel';
import { NavigationProvider, useNavigation } from '../../shell/navigation';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const sessions = ['Alpha', 'Beta'].map((name) => ({
  id: name, name, model: 'test-model', message_count: 1, created_at: '2026-09-25T00:00:00Z', backend: 'ollama',
}));

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args?: { sessionId?: string }) => {
    if (command === 'jarvis_list_sessions') return sessions;
    if (command === 'get_all_session_runs' || command === 'get_session_history' || command === 'list_sessions') return [];
    if (command === 'jarvis_get_session_grants') return { session_id: args?.sessionId, grants: [] };
    return null;
  });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

const panelProps = {
  activeSession: null,
  setActiveSession: vi.fn(),
  config: null,
  backendLabel: 'Ollama',
  modelLabel: 'gemma',
  onSessionCreated: vi.fn(),
};

describe('Sessions workspace chrome', () => {
  it('toggles the Inspector and remembers the choice', async () => {
    const first = render(<ChatPanel {...panelProps} />);
    expect(screen.getByRole('complementary', { name: 'Session inspector' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Hide inspector' }));
    expect(screen.queryByRole('complementary', { name: 'Session inspector' })).not.toBeInTheDocument();
    expect(localStorage.getItem(INSPECTOR_STORAGE_KEY)).toBe('0');
    first.unmount();

    render(<ChatPanel {...panelProps} />);
    expect(screen.queryByRole('complementary', { name: 'Session inspector' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show inspector' }));
    expect(screen.getByRole('complementary', { name: 'Session inspector' })).toBeInTheDocument();
    expect(localStorage.getItem(INSPECTOR_STORAGE_KEY)).toBe('1');
  });

  it('marks the composer as the owner of ⌘K and starts a new Session from it', async () => {
    const setActiveSession = vi.fn();
    render(<ChatPanel {...panelProps} activeSession="Alpha" setActiveSession={setActiveSession} />);
    const composer = await screen.findByLabelText('Chat input');
    expect(composer.closest('[data-owns-mod-k]')).not.toBeNull();
    fireEvent.change(composer, { target: { value: 'kept draft' } });
    fireEvent.keyDown(composer, { key: 'k', metaKey: true });
    expect(setActiveSession).toHaveBeenCalledWith(null);
  });

  it('selects the Session named by a navigation intent', async () => {
    function Opener() {
      const { navigate } = useNavigation();
      return (
        <button type="button" onClick={() => navigate('sessions', { sessionId: 'Beta' })}>
          Open Beta elsewhere
        </button>
      );
    }
    render(
      <NavigationProvider initial="sessions">
        <Opener />
        <SessionsPage />
      </NavigationProvider>,
    );
    await screen.findByRole('button', { name: 'Select session Beta' });
    fireEvent.click(screen.getByRole('button', { name: 'Open Beta elsewhere' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select session Beta' })).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('get_session_history', { sessionId: 'Beta', session_id: 'Beta' }));
    expect(screen.getByRole('heading', { name: 'Beta' })).toBeInTheDocument();
  });

  it('collapses the Session index to a rail and restores it', async () => {
    render(<SessionsPage />);
    await screen.findByRole('button', { name: 'Select session Alpha' });
    fireEvent.click(screen.getByRole('button', { name: 'Hide session index' }));
    expect(screen.queryByRole('button', { name: 'Select session Alpha' })).not.toBeInTheDocument();
    const rail = screen.getByRole('navigation', { name: 'Session index' });
    expect(within(rail).getByRole('button', { name: 'New session' })).toBeInTheDocument();
    fireEvent.click(within(rail).getByRole('button', { name: 'Show session index' }));
    expect(screen.getByRole('button', { name: 'Select session Alpha' })).toBeInTheDocument();
  });

  it('opens Feeds over the live Session without unmounting it, and returns', async () => {
    render(<SessionsPage />);
    await screen.findByRole('button', { name: 'Select session Alpha' });
    fireEvent.click(screen.getByRole('button', { name: 'Select session Alpha' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Feeds' }));
    });
    expect(screen.getByRole('region', { name: 'Read-only Session feed' })).toHaveTextContent('Select a session to view its chat feed');
    // The live Session stays mounted underneath (its stream is never torn down).
    expect(screen.getByLabelText('Chat input')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Session' }));
    expect(screen.queryByRole('region', { name: 'Read-only Session feed' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select session Alpha' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('unpins the transcript only when the operator scrolls up, never on a downward auto-scroll', async () => {
    render(<ChatPanel {...panelProps} />);
    const log = screen.getByRole('log', { name: 'Jarvis chat transcript' });
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 500 });
    const scrollTo = (top: number) => {
      log.scrollTop = top;
      fireEvent.scroll(log);
    };
    // Smooth auto-scroll toward the bottom while still >80px away: stays pinned.
    scrollTo(900);
    scrollTo(1200);
    expect(screen.queryByRole('button', { name: 'Jump to latest message' })).not.toBeInTheDocument();
    // The operator scrolls up to read: unpinned, the jump pill appears.
    scrollTo(700);
    const jump = screen.getByRole('button', { name: 'Jump to latest message' });
    // Reaching the bottom re-pins.
    scrollTo(1450);
    expect(jump).not.toBeInTheDocument();
  });
});
