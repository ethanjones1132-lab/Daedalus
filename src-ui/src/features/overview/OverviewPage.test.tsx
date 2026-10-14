import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import OverviewPage from './OverviewPage';
import { NavigationProvider, useNavigation } from '../../shell/navigation';
import type { BackendSession } from '../../types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
const session = (id: string, title: string, minsAgo: number, extra: Partial<BackendSession> = {}): BackendSession => ({
  id, agent_id: 'agent-x', title, backend: 'ollama', model: 'llama3', context_tokens: 0, total_tokens: 0,
  created_at: iso(minsAgo + 5), updated_at: iso(minsAgo), archived: false, message_count: 4, ...extra,
});
const health = {
  ollama: { running: true, model: 'llama3', url: '' }, bun_server: { running: true, url: 'http://127.0.0.1:19877' },
  bridge: { running: true, port: 19878 },
  disk: { total: '500G', used: '300G', available: '200G', use_percent: '60%' },
  memory: { total_mb: 16000, available_mb: 2000, used_mb: 14000, used_percent: 87 }, timestamp: '',
};
const sessions = [session('s-old', 'Old one', 3000), session('s-new', 'Newest', 5), session('s-mid', 'Middle', 600, { archived: true })];

function Probe() {
  const { route, params } = useNavigation();
  return <output aria-label="route">{route}:{params.sessionId ?? ''}</output>;
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'get_system_health') return health;
    if (command === 'list_agents') return [{ id: 'a', name: 'A', model: 'm', enabled: true }, { id: 'b', name: 'B', model: 'm', enabled: false }];
    if (command === 'list_sessions') return sessions;
    if (command === 'list_cron_jobs' || command === 'list_pending_missed_jobs') return [];
    return null;
  });
});
afterEach(() => cleanup());

describe('OverviewPage', () => {
  it('renders the verdict, one readout row, and Recent Sessions newest first', async () => {
    await act(async () => { render(<OverviewPage />); });
    expect(screen.getByText(/Bun server, Bridge and Ollama are running · 1 Agent enabled · 1 Session active in the last hour/)).toBeInTheDocument();
    // The duplicated second metric row is gone: each readout label appears once.
    expect(screen.getAllByText('Messages')).toHaveLength(1);
    expect(screen.getAllByText('Active · 1h')).toHaveLength(1);
    const rows = within(screen.getByRole('heading', { name: 'Recent Sessions' }).closest('section')!).getAllByRole('button', { name: /s-/ });
    expect(rows.map((r) => within(r).getByText(/Newest|Middle|Old one/).textContent)).toEqual(['Newest', 'Middle', 'Old one']);
  });

  it('shows memory and disk as text beside the dials', async () => {
    await act(async () => { render(<OverviewPage />); });
    expect(screen.getByText('87.0%')).toBeInTheDocument();
    expect(screen.getByText('60%')).toBeInTheDocument();
  });

  it('opens a Session in the Sessions page when its row is chosen', async () => {
    await act(async () => { render(<NavigationProvider initial="overview"><OverviewPage /><Probe /></NavigationProvider>); });
    fireEvent.click(screen.getByRole('button', { name: /Middle/ }));
    expect(screen.getByLabelText('route')).toHaveTextContent('sessions:s-mid');
  });

  it('says plainly when a service is offline', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'get_system_health') return { ...health, bridge: { running: false, port: 19878 } };
      if (command === 'list_agents') return [];
      if (command === 'list_sessions') return [];
      return command === 'list_cron_jobs' || command === 'list_pending_missed_jobs' ? [] : null;
    });
    await act(async () => { render(<OverviewPage />); });
    expect(screen.getByText(/Bun server and Ollama are running, Bridge is offline/)).toBeInTheDocument();
    expect(screen.getByText('offline')).toBeInTheDocument();
    expect(screen.getByText('No Sessions yet')).toBeInTheDocument();
  });
});
