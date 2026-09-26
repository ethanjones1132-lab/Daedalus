// A Native read failure must not narrate the Native layer's own error string.
//
// The rule this file pins is already established in five sibling surfaces
// (`ApprovalsView`, `CommitmentsView`, `ChannelsView`, `MemoryView`, `JarvisView`):
// a rejected read renders one locally-authored sentence and the reason is
// withheld, because a native error string can embed store paths, configuration
// values and session detail — the repo says so in its own comments and did not
// apply it on these paths.
//
// Every contract below drives the real component, rejects the real command with
// an error carrying exactly the substrings an operator must never be shown, and
// asserts BOTH directions: the native text is absent from the DOM, and the fixed
// sentence plus the surface's own Retry are present. The confirmed half is
// pinned too — a read that succeeds still renders the list.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DevicesView from './DevicesView';
import HooksView from './HooksView';
import NodesView from './NodesView';
import McpPanel from './McpPanel';
import { SkillsView } from './SkillsView';
import { ToastProvider } from '../ui';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

/** Everything a Tauri/Native rejection is allowed to carry, and nothing may show it. */
const LEAK = 'Native store is locked: /Users/operator/.jarvis/daedalus.sqlite3 (SQLITE_BUSY)';
const LEAK_FRAGMENTS = ['SQLITE_BUSY', 'daedalus.sqlite3', '/Users/operator/.jarvis', 'Native store is locked'];

beforeEach(() => {
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command === 'sync_distilled_skill_candidates') return Promise.resolve(0);
    if (command === 'jarvis_get_skills' || command === 'jarvis_get_tools') return Promise.resolve([]);
    if (command === 'list_skills' || command === 'list_mcp_servers' || command === 'get_hooks' || command === 'get_nodes' || command === 'get_devices') {
      return Promise.resolve([]);
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ candidates: [] }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** The DOM must not carry any part of the rejection, in any element's copy. */
function expectNoNativeText() {
  const printed = document.body.textContent ?? '';
  for (const fragment of LEAK_FRAGMENTS) {
    expect(printed.includes(fragment), `the native rejection leaked into the surface: ${fragment}`).toBe(false);
  }
}

describe.each([
  {
    View: HooksView,
    list: 'get_hooks',
    sentence: 'Could not load hooks.',
    field: 'Hook name',
    button: 'Register',
    empty: 'No hooks registered yet.',
    stored: { id: 'h1', name: 'on-start', event: 'session.start', script: '', enabled: true, created_at: '' },
  },
  {
    View: NodesView,
    list: 'get_nodes',
    sentence: 'Could not load nodes.',
    field: 'Node name',
    button: 'Add',
    empty: 'No nodes registered yet.',
    stored: { id: 'n1', name: 'relay', address: 'localhost:7000', status: 'unknown', latency_ms: null, last_ping: '', capabilities: [] },
  },
  {
    View: DevicesView,
    list: 'get_devices',
    sentence: 'Could not load devices.',
    field: 'Device name',
    button: 'Add',
    empty: 'No devices paired yet.',
    stored: { id: 'd1', name: 'studio', device_type: 'desktop', status: 'online', last_seen: '' },
  },
])('$list: a failed read names the failure, not the Native error', ({ View, list, sentence, empty, stored }) => {
  it('withholds the native rejection and offers the same Retry, which re-issues the same read', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === list) return Promise.reject(new Error(LEAK));
      if (command === 'sync_distilled_skill_candidates') return Promise.resolve(0);
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<ToastProvider><View /></ToastProvider>);

    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expectNoNativeText();
    // A genuine empty read still says so; a failed one must not borrow its copy.
    expect(screen.queryByText(empty)).not.toBeInTheDocument();

    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    expect(invokeMock.mock.calls.filter(([c]) => c === list)).toHaveLength(2);
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expectNoNativeText();
  });

  it('still renders a confirmed list, and a confirmed empty read still says empty', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === list) return Promise.resolve([stored]);
      if (command === 'sync_distilled_skill_candidates') return Promise.resolve(0);
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<ToastProvider><View /></ToastProvider>);
    expect(await screen.findByText(stored.name)).toBeInTheDocument();
    expect(screen.queryByText(sentence)).not.toBeInTheDocument();

    cleanup();
    invokeMock.mockImplementation((command: string) => {
      if (command === list) return Promise.resolve([]);
      if (command === 'sync_distilled_skill_candidates') return Promise.resolve(0);
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<ToastProvider><View /></ToastProvider>);
    expect(await screen.findByText(empty)).toBeInTheDocument();
  });
});

describe('McpPanel: a failed .mcp.json read', () => {
  it('is announced on the same terms as its own save failure, and the Retry re-reads', async () => {
    let calls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_mcp_servers') {
        calls += 1;
        return Promise.reject(new Error(LEAK));
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<ToastProvider><McpPanel /></ToastProvider>);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toContain('Could not load .mcp.json.');
    expectNoNativeText();
    // The save failure on this surface is an announced alert; the read failure
    // was the only state here with no live region at all.
    expect(screen.getByText('Error')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(calls).toBe(2);
    expect((await screen.findByRole('alert')).textContent ?? '').toContain('Could not load .mcp.json.');
    expectNoNativeText();
  });

  it('still renders a confirmed server list', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_mcp_servers') {
        return Promise.resolve({ alpha: { command: 'alpha', args: [], env: {}, cwd: null, type: null } });
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<ToastProvider><McpPanel /></ToastProvider>);
    expect(await screen.findByText('alpha')).toBeInTheDocument();
    expect(screen.queryByText('Could not load .mcp.json.')).not.toBeInTheDocument();
  });
});

describe('SkillsView: a failed skill list read', () => {
  it('names the failure instead of the Native error, and the Retry re-reads', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_skills') return Promise.reject(new Error(LEAK));
      if (command === 'sync_distilled_skill_candidates') return Promise.resolve(0);
      if (command === 'jarvis_get_skills' || command === 'jarvis_get_tools') return Promise.resolve([]);
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<ToastProvider><SkillsView /></ToastProvider>);

    expect(await screen.findByText('Could not load skills.')).toBeInTheDocument();
    expectNoNativeText();
    expect(screen.queryByText('No skills match the current filter.')).not.toBeInTheDocument();

    // The Retry re-reads: `fetchSkills` syncs candidates before it lists, so the
    // second `list_skills` only lands after the first await settles.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(invokeMock.mock.calls.filter(([c]) => c === 'list_skills').length).toBeGreaterThanOrEqual(2);
    expect(await screen.findByText('Could not load skills.')).toBeInTheDocument();
    expectNoNativeText();
  });
});
