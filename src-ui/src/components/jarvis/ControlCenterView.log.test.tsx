import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ControlCenterView from './ControlCenterView';
import { LOG_RAW_CONTENT_NOTICE } from './diagnostics-log-state';

// The section's four states, at the surface an operator opens it from. The read
// is HTTP to the Bun server, not a Tauri command, so these contracts drive
// `fetch` and leave the three native reads to the same fixture the sibling suites
// use — which is also how they prove the log read does not disturb them.

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('./McpPanel', () => ({ default: () => <div>MCP configuration</div> }));

const BUN_URL = 'http://127.0.0.1:19877';
const ISO = '2026-09-26T09:12:33.123Z';

const health = {
  ollama: { running: true, model: 'local', url: 'http://localhost:11434' },
  bun_server: { running: true, url: 'http://localhost:19877' },
  bridge: { running: true, port: 1 },
  claude_proxy: { running: true, port: 2 },
  disk: { total: '100G', used: '20G', available: '80G', use_percent: '20%' },
  memory: { total_mb: 1000, available_mb: 700, used_mb: 300, used_percent: 30 },
  timestamp: 'synthetic',
};
const doctor = {
  checks: [{ name: 'Synthetic check', status: 'ok', detail: 'Observed detail' }],
  summary: { total: 1, ok: 1, warn: 0, error: 0, overall: 'ok' },
  timestamp: 'synthetic',
};
const fixtures: Record<string, unknown> = {
  list_model_profiles: [],
  get_system_health: health,
  get_doctor_report: doctor,
};

function logLine(text: string, level: string | null = 'INFO') {
  return { text, timestamp: level === null ? null : ISO, level };
}

function tail(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    source: 'server-jarvis.self.log',
    format: 'self-log',
    limit: 200,
    truncated: false,
    lines: [logLine('earlier'), logLine('boom', 'ERROR')],
    ...overrides,
  };
}

const fetchMock = vi.fn();

function respondWith(body: unknown, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as unknown as Response);
}

const logCalls = () => fetchMock.mock.calls.filter(([url]) => String(url) === `${BUN_URL}/diagnostics/log`).length;

function diagnostics() {
  fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string) => Promise.resolve(fixtures[command]));
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => respondWith(tail()));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Server log section in Diagnostics', () => {
  it('states the raw-content exception and shows the lines the read confirmed', async () => {
    render(<ControlCenterView />);
    diagnostics();
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByText('earlier')).toBeInTheDocument();
    expect(screen.getByText(LOG_RAW_CONTENT_NOTICE)).toBeInTheDocument();
    // Oldest first, the order the file wrote them.
    const lines = screen.getAllByRole('listitem').map((node) => node.textContent);
    expect(lines.some((text) => text?.includes('earlier'))).toBe(true);
    expect(lines.findIndex((text) => text?.includes('earlier')))
      .toBeLessThan(lines.findIndex((text) => text?.includes('boom')));
  });

  it('counts the lines through the shared tally, and takes the count away when no read has answered', async () => {
    // A read that is still in flight, and a read that has failed with nothing on
    // screen, must both state no number at all. A `Server log(0)` above
    // `Could not load Server log.` is the reading that most strongly says there
    // is nothing in the log, produced by a read that never looked.
    fetchMock.mockImplementation(() => Promise.reject(new Error('log route is down')));
    render(<ControlCenterView />);
    diagnostics();
    expect(screen.getByRole('status', { name: 'Server log observation' })).toHaveTextContent('Loading Server log…');
    expect(screen.getByRole('heading', { name: 'Server log' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Server log(0)' })).not.toBeInTheDocument();
    expect(screen.getByText('Nothing confirmed from this log yet.')).toBeInTheDocument();
  });

  it('keeps the confirmed lines and the count through a failed refresh, marked stale', async () => {
    // A refresh that fails does not take away what a read already confirmed —
    // that is the rule every list on this surface already follows, and the log is
    // not exempt from it because its rows are text.
    render(<ControlCenterView />);
    diagnostics();
    await screen.findByText('boom');
    fetchMock.mockImplementation(() => respondWith({ ok: false, failure: 'unreadable' }, false, 500));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh log' }));
    const alert = await screen.findByRole('alert', { name: 'Server log observation' });
    expect(alert).toHaveTextContent(/stale/i);
    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Server log(2)' })).toBeInTheDocument();
  });

  it('states a bounded read as the newest N, and never calls it the whole file', async () => {
    render(<ControlCenterView />);
    fetchMock.mockImplementation(() => respondWith(tail({ truncated: true, limit: 2 })));
    diagnostics();
    await screen.findByText('boom');
    expect(
      screen.getByText('The newest 2 lines, oldest first. The file held more, and this read does not say how many more.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Every line the file held when this was read.')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Server log(2)' })).toBeInTheDocument();
  });

  it('calls an untruncated read the whole file, which is the one case that may', async () => {
    render(<ControlCenterView />);
    diagnostics();
    await screen.findByText('boom');
    expect(screen.getByText('Every line the file held when this was read.')).toBeInTheDocument();
  });

  it('reports a confirmed empty log as a real zero and says the file holds no lines', async () => {
    render(<ControlCenterView />);
    fetchMock.mockImplementation(() => respondWith(tail({ lines: [] })));
    diagnostics();
    await screen.findByRole('heading', { name: 'Server log(0)' });
    expect(screen.getByText('The log file exists and holds no lines yet.')).toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: 'Server log observation' })).not.toBeInTheDocument();
  });

  it('says nothing about the file when a bounded read brought back no whole line', async () => {
    // The read stopped before the first complete line, so it knows the file holds
    // at least one line and nothing about how many. Claiming the file is empty
    // here would be the exact failure this read exists to avoid, one step removed.
    render(<ControlCenterView />);
    fetchMock.mockImplementation(() => respondWith(tail({ truncated: true, lines: [] })));
    diagnostics();
    await screen.findByRole('heading', { name: 'Server log(0)' });
    expect(screen.queryByText('The log file exists and holds no lines yet.')).not.toBeInTheDocument();
    expect(
      screen.getByText('This read did not reach the start of the file, so it does not say how many lines the file holds.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: 'Server log observation' })).not.toBeInTheDocument();
  });

  it('answers a file that could not be opened as a failed read, never as an empty log', async () => {
    // The 404 is the server saying the file is not there. Rendering it as an
    // empty log would tell the operator the log has nothing in it, which is the
    // one claim a file that was never opened cannot support.
    fetchMock.mockImplementation(() => respondWith({ ok: false, failure: 'missing' }, false, 404));
    render(<ControlCenterView />);
    diagnostics();
    expect(await screen.findByRole('alert', { name: 'Server log observation' })).toBeInTheDocument();
    expect(screen.getByText('Could not load Server log.')).toBeInTheDocument();
    expect(screen.queryByText('The log file exists and holds no lines yet.')).not.toBeInTheDocument();
    expect(screen.getByText('Nothing confirmed from this log yet.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Server log(0)' })).not.toBeInTheDocument();
  });

  it('withholds the reason the log read failed, like every other read on this surface', async () => {
    render(<ControlCenterView />);
    diagnostics();
    await screen.findByText('boom');
    fetchMock.mockImplementation(() => Promise.reject(new Error('EACCES: /Users/someone/.openclaw/jarvis/logs/server-jarvis.self.log')));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh log' }));
    const alert = await screen.findByRole('alert', { name: 'Server log observation' });
    expect(alert).toHaveTextContent('Could not load Server log.');
    expect(document.body.textContent).not.toContain('EACCES');
    expect(document.body.textContent).not.toContain('.openclaw');
  });

  it('retries the log read on its own control and announces a pending read', async () => {
    render(<ControlCenterView />);
    diagnostics();
    await screen.findByText('boom');
    let release!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh log' }));
    expect(screen.getByRole('status', { name: 'Server log observation' })).toHaveTextContent('Refreshing Server log…');
    expect(screen.getByRole('button', { name: 'Refresh log' })).toBeDisabled();
    await act(async () => { release(await respondWith(tail({ lines: [logLine('after retry')] }))); });
    expect(screen.getByText('after retry')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Server log observation' })).not.toBeInTheDocument();
  });

  it('drops a line it cannot read and keeps the rest of the read', async () => {
    render(<ControlCenterView />);
    fetchMock.mockImplementation(() => respondWith(tail({ lines: [logLine('kept'), null, { text: 7 }, logLine('also kept')] })));
    diagnostics();
    await screen.findByText('kept');
    expect(screen.getByText('also kept')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Server log(2)' })).toBeInTheDocument();
  });

  it('reads the payload as text and never as markup', async () => {
    render(<ControlCenterView />);
    fetchMock.mockImplementation(() => respondWith(tail({
      lines: [{ text: '<img src=x onerror="window.__pwned=1">', timestamp: ISO, level: 'ERROR' }],
    })));
    diagnostics();
    const line = await screen.findByText('<img src=x onerror="window.__pwned=1">');
    expect(line.tagName).not.toBe('IMG');
    expect(document.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('invents no level for a line that has none', async () => {
    render(<ControlCenterView />);
    fetchMock.mockImplementation(() => respondWith(tail({ lines: [{ text: 'half a line', timestamp: null, level: null }] })));
    diagnostics();
    const line = await screen.findByText('half a line');
    const row = line.closest('li')!;
    expect(within(row).queryByText('INFO')).not.toBeInTheDocument();
    expect(within(row).queryByText('ERROR')).not.toBeInTheDocument();
    expect(row).toHaveTextContent('half a line');
  });

  it('keeps the log read out of the other three reads, and out of the page Refresh', async () => {
    // The section has its own Refresh and its own cadence. Folding this read into
    // the page's would make every profile write re-read the log.
    render(<ControlCenterView />);
    diagnostics();
    await screen.findByText('boom');
    expect(logCalls()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    expect(logCalls()).toBe(1);
  });

  it('reads the log once per visit to the tab and never on a timer', async () => {
    render(<ControlCenterView />);
    expect(logCalls()).toBe(0);
    diagnostics();
    await screen.findByText('boom');
    expect(logCalls()).toBe(1);
    // A second visit without a Refresh re-reads, because a log is the one read
    // whose answer changes on its own. What it must never do is poll.
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
    await waitFor(() => expect(logCalls()).toBe(2));
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith(BUN_URL))).toBe(true);
  });

  it('leaves the doctor and health sections exactly as they were', async () => {
    render(<ControlCenterView />);
    diagnostics();
    await screen.findByText('boom');
    expect(screen.getByText('Synthetic check')).toBeInTheDocument();
    expect(screen.getByText('30%')).toBeInTheDocument();
    expect(screen.getByText('Subsystems')).toBeInTheDocument();
    expect(screen.getByText('Doctor')).toBeInTheDocument();
    // The tab set is unchanged: a section is not a tab.
    for (const label of ['Overview', 'Profiles', 'Diagnostics', 'MCP']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('keeps its own two siblings on the same failure vocabulary', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('log route is down')));
    render(<ControlCenterView />);
    diagnostics();
    await screen.findByRole('alert', { name: 'Server log observation' });
    invokeMock.mockRejectedValue(new Error('private native detail'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    for (const label of ['System health', 'Doctor report', 'Server log']) {
      await waitFor(() => expect(screen.getByRole('alert', { name: `${label} observation` })).toBeInTheDocument());
      expect(screen.getByRole('button', { name: `Retry ${label}` })).toBeInTheDocument();
    }
    expect(document.body.textContent).not.toContain('private native detail');
  });
});
