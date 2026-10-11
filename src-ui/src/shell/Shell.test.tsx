import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { VIEW_STORAGE_KEY } from './navigation';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockRejectedValue(new Error('native unavailable in test'));
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('application shell', () => {
  it('constrains the routed view to the viewport so nested panes own scrolling', async () => {
    render(<App />);
    const surface = screen.getByRole('main', { name: 'Application workspace' });
    const viewport = screen.getByTestId('main-surface-viewport');
    expect(surface).toHaveClass('min-h-0', 'flex-1');
    expect(viewport).toHaveClass('h-full', 'min-h-0');
  });

  it('marks the current route with aria-current and persists navigation', async () => {
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Surfaces' });
    expect(within(nav).getByRole('button', { name: 'Sessions' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(within(nav).getByRole('button', { name: 'Cron' }));
    expect(within(nav).getByRole('button', { name: 'Cron' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('button', { name: 'Sessions' })).not.toHaveAttribute('aria-current');
    expect(localStorage.getItem(VIEW_STORAGE_KEY)).toBe('cron');
  });

  it('restores a persisted legacy view id through its alias', () => {
    localStorage.setItem(VIEW_STORAGE_KEY, 'action-registry');
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Surfaces' });
    expect(within(nav).getByRole('button', { name: 'Actions' })).toHaveAttribute('aria-current', 'page');
  });

  it('toggles the command palette with Ctrl+K and navigates from it', async () => {
    render(<App />);
    act(() => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });
    const input = await screen.findByLabelText('Search views');
    fireEvent.change(input, { target: { value: 'memory' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument());
    const nav = screen.getByRole('navigation', { name: 'Surfaces' });
    expect(within(nav).getByRole('button', { name: 'Memory' })).toHaveAttribute('aria-current', 'page');
  });

  it('leaves Ctrl+K to an element that owns it (the Session composer)', () => {
    render(
      <>
        <App />
        <div data-owns-mod-k>
          <textarea aria-label="owner" />
        </div>
      </>,
    );
    const owner = screen.getByLabelText('owner');
    owner.focus();
    fireEvent.keyDown(owner, { key: 'k', ctrlKey: true });
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
  });

  it('collapses the rail and keeps every surface reachable by name', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
    const nav = screen.getByRole('navigation', { name: 'Surfaces' });
    expect(within(nav).getByRole('button', { name: 'Health' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toBeInTheDocument();
  });
});
