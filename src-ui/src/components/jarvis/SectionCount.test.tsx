// A section header's count is a claim about a read, and it has to answer for it.
//
// `SectionHeader` prints its count inside the heading as the view's own name —
// `Devices(0)` — whenever `typeof count === 'number'`, and that primitive gate is
// the only thing standing between a list that starts `[]` and a heading that
// reads as a measurement. Nine mounted surfaces passed `count={list.length}`
// from a header sitting above and independently of the read gate their own
// bodies implement, so a read still in flight and a read that had just failed
// both printed a confident `0`: the reading which most strongly says "there is
// nothing here", produced by a read that returned nothing, and indistinguishable
// from a genuinely empty install.
//
// Each case below drives the real surface and pins all three states of one read:
// nothing claimed while it is unanswered, nothing claimed once it has failed,
// and the real number once it has answered — including a real `0`, because the
// difference between a confirmed empty read and a failed one is the whole point.

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DevicesView from './DevicesView';
import HooksView from './HooksView';
import NodesView from './NodesView';
import ApprovalsView from './ApprovalsView';
import ChannelsView from './ChannelsView';
import CommitmentsView from './CommitmentsView';
import MemoryView from './MemoryView';
import { SkillsView } from './SkillsView';
import { ToastProvider } from '../ui';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function literal(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

const device = { id: 'd1', name: 'studio', device_type: 'desktop', status: 'online', last_seen: '' };
const hook = { id: 'h1', name: 'on-start', event: 'session.start', script: '', enabled: true, created_at: '' };
const node = { id: 'n1', name: 'relay', address: 'localhost:7000', status: 'unknown', latency_ms: null, last_ping: '', capabilities: [] };
const approval = { id: 'a', request_type: 'tool', description: 'Alpha request', agent_id: 'agent', created_at: '', status: 'pending', tool_name: null, tool_args: null };
const commitment = { id: 'c1', text: 'Ship the thing', status: 'open', due: null, created_at: '2026-09-16T00:00:00Z', completed_at: null, agent_id: null };
const channel = { id: 'ch1', name: 'Alpha channel', type: 'discord', enabled: true, config: { channel_id: '123', connected: false }, connected: false, last_used: null, created_at: '2026-09-16T00:00:00Z', updated_at: '2026-09-16T00:00:00Z' };
const memory = {
  id: 'm1', title: 'Alpha memory', content: 'Alpha memory content', tags: '[]', category: 'note',
  created_at: '2026-09-15T00:00:00Z', updated_at: '2026-09-16T00:00:00Z', relevance_score: 0.5,
  agent_id: 'agent-1', source: 'operator', source_session_id: 'session-1', source_message_ids: '[]',
  confidence: 0.9, last_used_at: null, tier: 'hot',
};
const skill = {
  id: 's1', name: 'Alpha skill', description: 'Alpha description', path: 'agents/a/alpha.md',
  enabled: true, metadata: null, body: 'body', version: 1, improvement_score: 0.4,
  created_at: '2026-09-16T00:00:00Z', updated_at: '2026-09-16T00:00:00Z',
};

/** Every command a surface issues that is not the list read under test. */
const QUIET: Record<string, unknown> = {
  sync_distilled_skill_candidates: 0,
  jarvis_get_skills: [],
  jarvis_get_tools: [],
  jarvis_get_tier_stats: { hot: 0, warm: 0, cold: 0 },
};

beforeEach(() => {
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command in QUIET) return Promise.resolve(QUIET[command]);
    throw new Error(`Unexpected command: ${command}`);
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ candidates: [] }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const CASES = [
  { View: HooksView, list: 'get_hooks', failure: 'Could not load hooks.', title: 'Hooks', row: hook, label: 'on-start' },
  { View: NodesView, list: 'get_nodes', failure: 'Could not load nodes.', title: 'Nodes', row: node, label: 'relay' },
  { View: DevicesView, list: 'get_devices', failure: 'Could not load devices.', title: 'Devices', row: device, label: 'studio' },
  { View: ApprovalsView, list: 'get_approvals', failure: 'Could not load approvals.', title: 'Approvals', row: approval, label: 'Alpha request' },
  { View: CommitmentsView, list: 'get_commitments', failure: 'Could not refresh commitments.', title: 'Commitments', row: commitment, label: 'Ship the thing' },
  { View: ChannelsView, list: 'list_channels', failure: 'Could not refresh channels.', title: 'Channels', row: channel, label: 'Alpha channel' },
  { View: MemoryView, list: 'list_recent_memories', failure: 'Could not load memories.', title: 'Memory', row: memory, label: 'Alpha memory' },
  { View: SkillsView, list: 'list_skills', failure: 'Could not load skills.', title: 'Skills', row: skill, label: 'Alpha skill' },
];

describe.each(CASES)('$title: the header count answers for the read beneath it', ({ View, list, failure, title, row, label }) => {
  function only(listResult: () => Promise<unknown>) {
    invokeMock.mockImplementation((command: string) => {
      if (command === list) return listResult();
      if (command in QUIET) return Promise.resolve(QUIET[command]);
      throw new Error(`Unexpected command: ${command}`);
    });
  }

  /** The heading's own text, so an absent count cannot hide inside a wrapper. */
  const heading = () => screen.getByRole('heading', { level: 2, name: new RegExp(`^${title}`) }).textContent ?? '';

  it('states no count while the read is unanswered', async () => {
    const read = deferred<unknown>();
    only(() => read.promise);
    render(<ToastProvider><View /></ToastProvider>);
    await act(async () => {});

    // A read in flight has returned nothing, so a number here would be a guess
    // wearing the app's own typography.
    expect(heading()).toBe(title);
    expect(invokeMock.mock.calls.filter(([command]) => command === list)).toHaveLength(1);
  });

  it('states no count once the read has failed, and says so in the body', async () => {
    const read = deferred<unknown>();
    only(() => read.promise);
    render(<ToastProvider><View /></ToastProvider>);
    await act(async () => { read.reject(new Error('synthetic private native detail')); });
    expect(heading()).toBe(title);
    expect(screen.getByText(literal(failure))).toBeInTheDocument();
  });

  it('states the real count once a read has confirmed it', async () => {
    only(() => Promise.resolve([row]));
    render(<ToastProvider><View /></ToastProvider>);
    expect(await screen.findByRole('heading', { level: 2, name: new RegExp(`^${title}\\(1\\)$`) })).toBeInTheDocument();
    // The row is on screen, so the number measures something real rather than
    // decorating the heading.
    expect((await screen.findAllByText(label)).length).toBeGreaterThan(0);
  });

  it('keeps a confirmed empty read a real zero rather than nothing', async () => {
    only(() => Promise.resolve([]));
    render(<ToastProvider><View /></ToastProvider>);
    // `(0)` and no parenthetical at all are different documents, and the
    // operator's reading of "there is nothing here" is only earned by the first.
    expect(await screen.findByRole('heading', { level: 2, name: new RegExp(`^${title}\\(0\\)$`) })).toBeInTheDocument();
  });
});
