import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
import { SkillsView } from './SkillsView';

const nativeSkill = {
  id: 'native', name: 'review', description: 'Native review', path: '', enabled: true,
  metadata: null, body: 'Review body', version: 1, improvement_score: 0,
  created_at: '', updated_at: '',
};
const distilled = {
  ...nativeSkill, id: 'distilled', name: 'distilled-debug', enabled: false,
  metadata: JSON.stringify({ source: 'trajectory_distillation', candidate_id: 'candidate-1', status: 'candidate' }),
};
const candidate = {
  id: 'candidate-1', name: distilled.name, description: '', body: '',
  trigger: { task_types: [], requirements: [], signals: [] }, source_run_ids: [],
  confidence: 0.8, status: 'candidate', eval_score: 0.9, created_at: '', updated_at: '',
};
const revision = { id: 'rev-1', skill_id: 'native', version: 1, body_before: '', body_after: '', change_reason: 'test revision', created_at: '' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (candidates: unknown = [candidate]) => ({ ok: true, json: async () => ({ candidates }) }) as Response;
const fetchMock = vi.fn();
let skillsRead: () => Promise<unknown>;
let toolsRead: () => Promise<unknown>;
const calls = (command: string) => invokeMock.mock.calls.filter(([cmd]) => cmd === command).length;
const region = (name: string) => within(screen.getByRole('region', { name }));

beforeEach(() => {
  skillsRead = async () => [];
  toolsRead = async () => [];
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'jarvis_get_skills') return skillsRead();
    if (cmd === 'jarvis_get_tools') return toolsRead();
    if (cmd === 'list_skills') return [nativeSkill, distilled];
    if (cmd === 'sync_distilled_skill_candidates') return 1;
    if (cmd === 'skill_revisions_list') return [revision];
    if (cmd === 'skill_restore_revision') return true;
    return undefined;
  });
  fetchMock.mockReset().mockResolvedValue(response());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function restore() {
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect skill: review' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Revisions' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
  await waitFor(() => expect(calls('skill_restore_revision')).toBeGreaterThan(0));
}

describe('SkillsView optional observations', () => {
  it('keeps native rows usable while all optional reads remain pending', async () => {
    const pending = deferred<never>();
    skillsRead = () => pending.promise;
    toolsRead = () => pending.promise;
    fetchMock.mockReturnValue(pending.promise);
    render(<SkillsView />);
    expect(await screen.findByRole('button', { name: 'Inspect skill: review' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(calls('disable_skill')).toBe(1));
    for (const name of ['Runtime skills', 'Runtime tools', 'Skill candidates']) {
      expect(region(name).getByRole('status')).toHaveTextContent(/loading/i);
      expect(region(name).queryByText(/^No /)).not.toBeInTheDocument();
    }
    const row = screen.getByRole('button', { name: 'Inspect skill: distilled-debug' }).closest('li')!;
    expect(within(row).queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(within(row).getByText('Lifecycle observation unavailable.')).toBeInTheDocument();
  });

  it('recovers only a failed capability read without replaying sync or other reads', async () => {
    skillsRead = async () => { throw new Error('private native detail'); };
    render(<SkillsView />);
    await screen.findByRole('button', { name: 'Inspect skill: review' });
    await waitFor(() => expect(region('Runtime skills').getByRole('alert')).toHaveTextContent('Could not load runtime skills.'));
    expect(region('Runtime tools').getByText('No runtime tools observed.')).toBeInTheDocument();
    expect(screen.queryByText(/private native detail/)).not.toBeInTheDocument();
    const syncCount = calls('sync_distilled_skill_candidates');
    const pending = deferred<unknown>();
    skillsRead = () => pending.promise;
    const retry = region('Runtime skills').getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(retry).toBeDisabled();
    expect(calls('jarvis_get_skills')).toBe(2);
    await act(async () => pending.resolve([{ name: 'runtime-review' }]));
    expect(region('Runtime skills').getByText('runtime-review')).toBeInTheDocument();
    expect(region('Runtime skills').queryByRole('alert')).not.toBeInTheDocument();
    expect(calls('sync_distilled_skill_candidates')).toBe(syncCount);
    expect(calls('list_skills')).toBe(1);
    expect(calls('jarvis_get_tools')).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['network', 'http', 'json', 'shape'])('distinguishes %s candidate failure from empty and recovers by GET alone', async (failure) => {
    fetchMock.mockImplementationOnce(async () => {
      if (failure === 'network') throw new Error('private detail');
      if (failure === 'http') return { ok: false, json: async () => ({}) };
      if (failure === 'json') return { ok: true, json: async () => { throw new Error('invalid json'); } };
      return response(null);
    });
    render(<SkillsView />);
    await screen.findByRole('button', { name: 'Inspect skill: distilled-debug' });
    await waitFor(() => expect(region('Skill candidates').getByRole('alert')).toHaveTextContent('Could not load skill candidates.'));
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    fetchMock.mockResolvedValue(response([]));
    fireEvent.click(region('Skill candidates').getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(region('Skill candidates').getByText('No skill candidates observed.')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(calls('sync_distilled_skill_candidates')).toBe(1);
    expect(calls('list_skills')).toBe(1);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('retains stale capability and candidate details but disables lifecycle actions through recovery', async () => {
    toolsRead = async () => [{ name: 'old-tool' }];
    render(<SkillsView />);
    await screen.findByRole('button', { name: 'Promote' });
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    toolsRead = async () => { throw new Error('private detail'); };
    await restore();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect skill: distilled-debug' }));
    for (const name of ['Promote', 'Reject', 'Run eval']) {
      screen.getAllByRole('button', { name }).forEach((button) => expect(button).toBeDisabled());
    }
    await act(async () => pending.reject(new Error('private detail')));
    expect(region('Runtime tools').getByRole('alert')).toHaveTextContent(/stale/i);
    expect(region('Runtime tools').getByText('old-tool')).toBeInTheDocument();
    expect(region('Skill candidates').getByRole('alert')).toHaveTextContent(/stale/i);
    expect(screen.getByText('0.80')).toBeInTheDocument();
    const retry = deferred<Response>();
    fetchMock.mockReturnValueOnce(retry.promise);
    fireEvent.click(region('Skill candidates').getByRole('button', { name: 'Retry' }));
    expect(region('Skill candidates').getByRole('button', { name: 'Retry' })).toBeDisabled();
    screen.getAllByRole('button', { name: 'Reject' }).forEach((button) => {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    });
    await act(async () => retry.resolve(response()));
    screen.getAllByRole('button', { name: 'Reject' }).forEach((button) => expect(button).toBeEnabled());
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    expect(calls('sync_distilled_skill_candidates')).toBe(2);
  });

  it.each(['resolve', 'reject'])('ignores an obsolete optional %s after post-restore refresh', async (settlement) => {
    const oldSkills = deferred<unknown>();
    const oldCandidates = deferred<Response>();
    skillsRead = () => oldSkills.promise;
    fetchMock.mockReturnValueOnce(oldCandidates.promise);
    render(<SkillsView />);
    await screen.findByRole('button', { name: 'Inspect skill: review' });
    skillsRead = async () => [{ name: 'new-runtime' }];
    fetchMock.mockResolvedValue(response([]));
    await restore();
    await waitFor(() => expect(region('Runtime skills').getByText('new-runtime')).toBeInTheDocument());
    await act(async () => {
      if (settlement === 'resolve') {
        oldSkills.resolve([{ name: 'obsolete-runtime' }]);
        oldCandidates.resolve(response());
      } else {
        oldSkills.reject(new Error('obsolete failure'));
        oldCandidates.reject(new Error('obsolete failure'));
      }
    });
    expect(region('Runtime skills').getByText('new-runtime')).toBeInTheDocument();
    expect(region('Runtime skills').queryByRole('alert')).not.toBeInTheDocument();
    expect(region('Skill candidates').getByText('No skill candidates observed.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.queryByText('obsolete-runtime')).not.toBeInTheDocument();
  });
});
