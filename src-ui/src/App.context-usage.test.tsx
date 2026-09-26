import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import App from './App';
import type { BackendSession } from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('./components/jarvis/HealthBanner', () => ({ default: () => null }));
vi.mock('./components/jarvis/MythosCompanionSprite', () => ({ default: () => null, MythosCompanionSprite: () => null }));

const alpha: BackendSession = {
  id: 'session-alpha', agent_id: 'agent-alpha', title: 'Alpha', backend: 'ollama',
  model: 'test-model', context_tokens: 1000, total_tokens: 250,
  created_at: '2026-09-16T10:00:00Z', updated_at: '2026-09-16T11:00:00Z',
  archived: false, message_count: 7,
};

type DriftedSession = Omit<BackendSession, 'context_tokens' | 'total_tokens'> &
  Partial<Pick<BackendSession, 'context_tokens' | 'total_tokens'>> &
  Record<string, unknown>;

/** Sentinel so a fixture can express a key the record did not return at all. */
const ABSENT = Symbol('absent');

function drifted(overrides: Record<string, unknown>): DriftedSession {
  const next = { ...alpha, ...overrides } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === ABSENT) delete next[key];
  }
  return next as DriftedSession;
}

beforeEach(() => {
  localStorage.setItem('jarvis-current-view', 'sessions');
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'list_sessions') return sessions;
    if (['list_cron_jobs', 'list_pending_missed_jobs', 'get_action_registry_alerts'].includes(command)) return [];
    return null;
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });

let sessions: DriftedSession[];

async function mount() {
  await act(async () => { render(<App />); });
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Session details: Alpha' }));
  return user;
}

// The disclosure region is pinned through its hidden attribute and content
// presence, as the sibling Sessions suites do: framer's enter animation makes
// ancestor opacity non-deterministic in jsdom.
function panel() {
  const button = screen.getByRole('button', { name: 'Session details: Alpha' });
  const region = document.getElementById(button.getAttribute('aria-controls')!);
  expect(region).not.toBeNull();
  expect(region).not.toHaveAttribute('hidden');
  return region!;
}

describe('Session context usage — a measured ratio still reads as a measurement', () => {
  it('renders the real percentage and a bar for a genuine ratio', async () => {
    sessions = [drifted({ total_tokens: 873, context_tokens: 1000 })];
    await mount();
    const detail = panel();
    expect(within(detail).getByText('87.3%')).toBeInTheDocument();
    const bar = within(detail).getByRole('progressbar', { name: /Alpha/ });
    expect(bar).toHaveAttribute('aria-valuenow', '87.3');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(within(detail).getByText('Context Usage')).toBeInTheDocument();
  });

  it('keeps the existing colour thresholds on the measured value', async () => {
    sessions = [drifted({ total_tokens: 800, context_tokens: 1000 })];
    await mount();
    expect(within(panel()).getByText('80.0%')).toHaveClass('text-error');
  });

  it('names the Session on the bar, so the number is available without colour', async () => {
    sessions = [drifted({})];
    await mount();
    expect(within(panel()).getByRole('progressbar', { name: 'Context usage for Alpha' })).toBeInTheDocument();
  });
});

describe('Session context usage — a ratio above the recorded window', () => {
  it('prints the real ratio and says it is over rather than printing 100.0%', async () => {
    sessions = [drifted({ total_tokens: 1264, context_tokens: 1000 })];
    await mount();
    const detail = panel();
    expect(within(detail).getByText('126.4%')).toBeInTheDocument();
    expect(within(detail).queryByText('100.0%')).not.toBeInTheDocument();
    expect(detail).toHaveTextContent(/over rather than full/);
  });

  it('gives the over claim as the bar’s accessible value, not a clamped 100', async () => {
    sessions = [drifted({ total_tokens: 1264, context_tokens: 1000 })];
    await mount();
    const bar = within(panel()).getByRole('progressbar', { name: /Alpha/ });
    expect(bar.getAttribute('aria-valuetext')).toContain('126.4%');
  });
});

describe('Session context usage — a record that cannot be measured', () => {
  it.each([
    ['a zero context window', { total_tokens: 500, context_tokens: 0 }],
    ['an absent context window', { total_tokens: 500, context_tokens: null }],
    ['an unreadable token total', { total_tokens: Number.NaN, context_tokens: 1000 }],
    ['a negative token total', { total_tokens: -500, context_tokens: 1000 }],
    ['a missing total key', { total_tokens: ABSENT, context_tokens: 1000 }],
    ['a non-numeric context window', { total_tokens: 500, context_tokens: '1000' }],
  ])('reads %s as not available, with its basis and no bar at all', async (_label, overrides) => {
    sessions = [drifted(overrides)];
    await mount();
    const detail = panel();
    expect(within(detail).getByText('Context Usage')).toBeInTheDocument();
    expect(within(detail).getByText('Not available')).toBeInTheDocument();
    expect(detail).toHaveTextContent(/usage cannot be measured/);
    expect(within(detail).queryByRole('progressbar')).not.toBeInTheDocument();
    expect(detail.textContent).not.toContain('NaN');
  });

  it('does not print a percentage or an empty bar that reads as zero', async () => {
    sessions = [drifted({ total_tokens: 500, context_tokens: 0 })];
    await mount();
    const detail = panel();
    // Pinned together with the label, so this cannot pass by the row being absent.
    expect(within(detail).getByText('Context Usage')).toBeInTheDocument();
    expect(detail.textContent).not.toMatch(/\d+\.\d%/);
    expect(within(detail).queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('keeps the row renderable so a drifted record cannot take the route down', async () => {
    sessions = [drifted({ total_tokens: Number.NaN, context_tokens: Number.NaN })];
    await mount();
    expect(within(panel()).getByText('Session ID')).toBeInTheDocument();
    expect(screen.queryByText('This view stopped unexpectedly. Daedalus is still running.')).not.toBeInTheDocument();
  });

  it('prints an unreadable token count as absent, not as the literal NaN', async () => {
    sessions = [drifted({ total_tokens: Number.NaN, context_tokens: 1000 })];
    await mount();
    const detail = panel();
    expect(within(detail).getByText('- / 1.0K')).toBeInTheDocument();
    expect(detail.textContent).not.toContain('NaN');
  });
});
