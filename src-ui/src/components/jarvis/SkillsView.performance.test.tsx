import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
import { SkillsView } from './SkillsView';

const BUN_URL = 'http://127.0.0.1:19877';
const PERFORMANCE_REGION = 'Skill performance since promotion';

const nativeSkill = {
  id: 'native', name: 'review', description: 'Native review', path: '', enabled: true,
  metadata: null, body: 'Review body', version: 1, improvement_score: 0,
  created_at: '', updated_at: '',
};
const promotedSkill = {
  ...nativeSkill, id: 'distilled', name: 'distilled-debug', enabled: false,
  body: '# Distilled body',
  metadata: JSON.stringify({ source: 'trajectory_distillation', candidate_id: 'candidate-1', status: 'promoted' }),
};
const promoted = {
  id: 'candidate-1', name: promotedSkill.name, description: '', body: '',
  trigger: { task_types: ['debug'], requirements: [], signals: [] }, source_run_ids: [],
  confidence: 0.8, status: 'promoted', eval_score: 0.9, promoted_at: '2026-09-01T00:00:00.000Z',
  created_at: '', updated_at: '',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const failure = (status: number, body: unknown = { error: 'private native detail' }) =>
  ({ ok: false, status, json: async () => body }) as unknown as Response;

function measured(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: promoted.id, promoted_at: promoted.promoted_at, task_types: ['debug'],
    before: { runs: 3, successes: 2, success_rate: 2 / 3 },
    after: { runs: 5, successes: 5, success_rate: 1 },
    delta: 1 / 3,
    ...overrides,
  };
}

const emptyWindows = { before: { runs: 0, successes: 0, success_rate: null }, after: { runs: 0, successes: 0, success_rate: null }, delta: null };

const fetchMock = vi.fn();
const performanceCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/performance'));
const candidateCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/skills/candidates'));
const region = () => within(screen.getByRole('group', { name: PERFORMANCE_REGION }));
const invokeCalls = (command: string) => invokeMock.mock.calls.filter(([cmd]) => cmd === command).length;

let performanceRead: () => Promise<Response>;
let snapshot: Record<string, unknown>;
let lifecycleVersion: number;

beforeEach(() => {
  performanceRead = async () => json(measured());
  snapshot = { ...promoted, lifecycle_version: 0 };
  lifecycleVersion = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith('/performance')) return performanceRead();
    if (target === `${BUN_URL}/skills/candidates`) return json({ candidates: [snapshot] });
    const action = /\/skills\/candidates\/[^/]+\/(promote|demote|reject|eval)$/.exec(target)?.[1];
    if (action && (init?.method ?? 'GET') === 'POST') {
      lifecycleVersion += 1;
      snapshot = {
        ...snapshot,
        status: action === 'promote' ? 'promoted' : 'candidate',
        lifecycle_version: lifecycleVersion,
        promoted_at: action === 'promote' ? promoted.promoted_at : undefined,
      };
      return json(snapshot);
    }
    return failure(404);
  });
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'jarvis_get_skills') return [];
    if (cmd === 'jarvis_get_tools') return [];
    if (cmd === 'list_skills') return [nativeSkill, promotedSkill];
    if (cmd === 'sync_distilled_skill_candidates') return 1;
    if (cmd === 'skill_revisions_list') return [];
    return undefined;
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function openPromotedDetail() {
  render(<SkillsView />);
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect skill: distilled-debug' }));
  await waitFor(() => expect(performanceCalls()).toHaveLength(1));
  return screen.getByRole('region', { name: 'Skill details: distilled-debug' });
}

describe('promoted-skill performance read', () => {
  it('shows a read in flight as pending rather than as an absent panel', async () => {
    const pending = deferred<Response>();
    performanceRead = () => pending.promise;
    await openPromotedDetail();
    expect(region().getByRole('status')).toHaveTextContent('Reading performance since promotion');
    expect(region().queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Distilled body')).toBeInTheDocument();
    await act(async () => pending.resolve(json(measured())));
  });

  it.each([
    ['transport', async () => { throw new Error('private transport detail'); }, 'Could not reach'],
    ['404', async () => failure(404), 'no longer on record'],
    ['409', async () => failure(409), 'not recorded as promoted'],
    ['422', async () => failure(422), 'candidate record could not be read'],
    ['500', async () => failure(500), 'read was rejected'],
  ])('announces a %s failure as unavailable instead of hiding the panel', async (_label, read, expected) => {
    performanceRead = read;
    await openPromotedDetail();
    const view = region();
    expect(view.getByText('Since promotion')).toBeInTheDocument();
    expect(view.getByRole('alert')).toHaveTextContent(expected);
    expect(screen.queryByText(/private (transport|native) detail/)).not.toBeInTheDocument();
    expect(screen.getByText('Distilled body')).toBeInTheDocument();
  });

  it('keeps a malformed 200 body from throwing out of the detail panel', async () => {
    performanceRead = async () => json({ error: 'wrong_status' });
    await openPromotedDetail();
    expect(region().getByRole('alert')).toHaveTextContent('could not be understood');
    expect(screen.getByText('Distilled body')).toBeInTheDocument();
  });

  it('renders the measured rates, the delta, and the counts that produced them', async () => {
    await openPromotedDetail();
    const view = region();
    expect(view.getByText('Since promotion')).toBeInTheDocument();
    expect(view.getByText(/^67% → 100%$/)).toBeInTheDocument();
    expect(view.getByText('+33%')).toBeInTheDocument();
    expect(view.getByText('2 of 3 runs before promotion, 5 of 5 after.')).toBeInTheDocument();
    expect(view.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reads a confirmed read with no runs as no measurement yet, with its counts', async () => {
    performanceRead = async () => json(measured(emptyWindows));
    await openPromotedDetail();
    expect(region().getByText('No measurement yet — 0 of 0 runs before promotion, 0 of 0 after.')).toBeInTheDocument();
    expect(region().queryByRole('alert')).not.toBeInTheDocument();
    expect(region().queryByText(/%/)).not.toBeInTheDocument();
  });

  it('reads the server-serialised null body as no measurement yet', async () => {
    performanceRead = async () => json(null);
    await openPromotedDetail();
    expect(region().getByText(/No measurement yet/)).toHaveTextContent(/promoted-at/);
    expect(region().queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retries only this read once, then shows the confirmed measurement', async () => {
    performanceRead = async () => failure(500);
    await openPromotedDetail();
    const candidatesBefore = candidateCalls().length;
    const listBefore = invokeCalls('list_skills');
    const retry = deferred<Response>();
    performanceRead = () => retry.promise;
    const button = region().getByRole('button', { name: 'Retry' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(performanceCalls()).toHaveLength(2);
    await act(async () => retry.resolve(json(measured())));
    await waitFor(() => expect(region().queryByRole('alert')).not.toBeInTheDocument());
    expect(region().getByText(/^67% → 100%$/)).toBeInTheDocument();
    expect(candidateCalls()).toHaveLength(candidatesBefore);
    expect(invokeCalls('list_skills')).toBe(listBefore);
  });

  it('re-reads and re-confirms the window when the panel is opened again', async () => {
    await openPromotedDetail();
    expect(region().getByText(/^67% → 100%$/)).toBeInTheDocument();
    expect(performanceCalls()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    performanceRead = async () => json(measured({ after: { runs: 5, successes: 2, success_rate: 0.4 }, delta: 0.4 - 2 / 3 }));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect skill: distilled-debug' }));
    await waitFor(() => expect(performanceCalls()).toHaveLength(2));
    await waitFor(() => expect(region().getByText(/^67% → 40%$/)).toBeInTheDocument());
    expect(region().getByText('-27%')).toBeInTheDocument();
    expect(region().queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ignores a read whose candidate is no longer promoted, and shows no performance at all', async () => {
    snapshot = { ...promoted, status: 'candidate', lifecycle_version: 0, promoted_at: undefined };
    render(<SkillsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect skill: distilled-debug' }));
    const panel = within(screen.getByRole('region', { name: 'Skill details: distilled-debug' }));
    expect(performanceCalls()).toHaveLength(0);
    expect(screen.queryByRole('group', { name: PERFORMANCE_REGION })).not.toBeInTheDocument();

    const late = deferred<Response>();
    performanceRead = () => late.promise;
    fireEvent.click(panel.getByRole('button', { name: 'Promote' }));
    await waitFor(() => expect(performanceCalls()).toHaveLength(1));
    expect(screen.getByRole('group', { name: PERFORMANCE_REGION })).toBeInTheDocument();
    await waitFor(() => expect(panel.getByRole('button', { name: 'Demote' })).toBeEnabled());

    fireEvent.click(panel.getByRole('button', { name: 'Demote' }));
    await waitFor(() => expect(panel.getByRole('button', { name: 'Promote' })).toBeInTheDocument());
    expect(screen.queryByRole('group', { name: PERFORMANCE_REGION })).not.toBeInTheDocument();
    await act(async () => late.resolve(json(measured())));
    expect(screen.queryByRole('group', { name: PERFORMANCE_REGION })).not.toBeInTheDocument();
    expect(screen.getByText('Distilled body')).toBeInTheDocument();
  });
});
