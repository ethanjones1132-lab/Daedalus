import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import App from './App';
import type { BackendSession } from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('./components/jarvis/HealthBanner', () => ({ default: () => null }));
vi.mock('./components/jarvis/MythosCompanionSprite', () => ({ MythosCompanionSprite: () => null }));

const alpha: BackendSession = {
  id: 'session-alpha', agent_id: 'agent-alpha', title: 'Alpha', backend: 'ollama',
  model: 'test-model', context_tokens: 1000, total_tokens: 250,
  created_at: '2026-09-16T10:00:00Z', updated_at: '2026-09-16T11:00:00Z',
  archived: false, message_count: 7,
};
const beta: BackendSession = { ...alpha, id: 'session-beta', title: '', agent_id: 'agent-beta', archived: true };
let sessions: BackendSession[];

beforeEach(() => {
  sessions = [alpha, beta];
  localStorage.setItem('jarvis-current-view', 'sessions');
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'list_sessions') return sessions;
    if (['list_cron_jobs', 'list_pending_missed_jobs', 'get_action_registry_alerts'].includes(command)) return [];
    return null;
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });

// Fake only the polling interval so the 15s poll can be advanced manually.
// Fully fake timers hang these suites: framer-motion's animation loop and
// user-event scheduling both rely on real macrotask/RAF progress.
// Visibility of content inside framer enter animations is not deterministic
// in jsdom (ancestor opacity animates asynchronously), so the contracts below
// pin the disclosure state through the region's hidden attribute and content
// presence instead of animated ancestor visibility.
async function mount({ fake = false } = {}) {
  if (fake) vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  await act(async () => { render(<App />); });
  return fake ? userEvent.setup({ advanceTimers: vi.advanceTimersByTime }) : userEvent.setup();
}
function details(button: HTMLElement) {
  const id = button.getAttribute('aria-controls');
  expect(id).toBeTruthy();
  const region = document.getElementById(id!);
  expect(region).not.toBeNull();
  return region!;
}

describe('native Session detail disclosures', () => {
  it.each(['{Enter}', ' '])('toggles with %s and keeps keyboard focus on the disclosure', async (key) => {
    const user = await mount();
    const button = screen.getByRole('button', { name: 'Session details: Alpha' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(details(button)).toHaveAttribute('hidden');
    button.focus();
    await user.keyboard(key);
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(details(button)).not.toHaveAttribute('hidden');
    expect(within(details(button)).getByText('agent-alpha')).toBeInTheDocument();
    expect(within(details(button)).getByText('25.0%')).toBeInTheDocument();
    await user.keyboard(key);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(details(button)).toHaveAttribute('hidden');
    expect(button).toHaveFocus();
  });

  it('tabs between independent disclosures and preserves mouse activation without nested controls', async () => {
    const user = await mount();
    const first = screen.getByRole('button', { name: 'Session details: Alpha' });
    const second = screen.getByRole('button', { name: 'Session details: agent-beta' });
    expect(first.getAttribute('aria-controls')).not.toBe(second.getAttribute('aria-controls'));
    expect(first.querySelector('button, a, input, [tabindex]')).toBeNull();
    first.focus();
    await user.keyboard('{Enter}');
    await user.tab();
    expect(second).toHaveFocus();
    await user.keyboard(' ');
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(second).toHaveAttribute('aria-expanded', 'true');
    expect(details(second)).not.toHaveAttribute('hidden');
    expect(within(second).getByText('archived')).toBeInTheDocument();
    await user.click(first);
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(details(first)).toHaveAttribute('hidden');
    expect(second).toHaveAttribute('aria-expanded', 'true');
  });

  it('retains expansion and control associations by Session id after the existing poll refreshes rows', async () => {
    const user = await mount({ fake: true });
    const first = screen.getByRole('button', { name: 'Session details: Alpha' });
    const regionId = first.getAttribute('aria-controls');
    await user.click(first);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'list_sessions')).toEqual([['list_sessions']]);
    sessions = [beta, { ...alpha, message_count: 8 }];
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    const refreshed = screen.getByRole('button', { name: 'Session details: Alpha' });
    expect(refreshed).toHaveAttribute('aria-expanded', 'true');
    expect(refreshed).toHaveAttribute('aria-controls', regionId);
    expect(within(details(refreshed)).getByText('8')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Session details: agent-beta' })).toHaveAttribute('aria-expanded', 'false');
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'list_sessions')).toEqual([['list_sessions'], ['list_sessions']]);
  });
});
