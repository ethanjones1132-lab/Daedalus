import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import SkillsPage from './SkillsPage';
import { ToastProvider } from '../../design';

const BUN_URL = 'http://127.0.0.1:19877';

const needsSetup = {
  id: 'skill-docker', name: 'docker-ops', description: 'Run containers', path: '', enabled: false,
  metadata: JSON.stringify({
    category: 'operations', source: 'bundled', emoji: '🐳',
    requires: { bins: ['docker'], os: ['linux'] }, missing: { bins: ['docker'] },
  }),
  body: '# Docker ops', version: 1, improvement_score: 0, created_at: '', updated_at: '',
};
const ready = {
  ...needsSetup, id: 'skill-git', name: 'git-helper',
  metadata: JSON.stringify({ category: 'development', source: 'bundled', eligible: true }),
};
const unknownEligibility = { ...needsSetup, id: 'skill-plain', name: 'plain-skill', metadata: null };
const distilled = {
  ...needsSetup, id: 'skill-d', name: 'distilled-trace',
  metadata: JSON.stringify({ source: 'trajectory_distillation', candidate_id: 'cand-1', status: 'candidate' }),
};

const candidate = (over: Record<string, unknown> = {}) => ({
  id: 'cand-1', name: 'distilled-trace', description: 'Trace a failure', body: '',
  trigger: { task_types: ['debug'], requirements: [], signals: [] }, source_run_ids: [],
  confidence: 0.7, status: 'candidate', lifecycle_version: 0, eval_score: 0.9,
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-02T00:00:00Z', ...over,
});
const orphan = candidate({ id: 'cand-2', name: 'orphan-candidate', status: 'rejected', rejection_reason: 'eval_failed', eval_score: 0.3, updated_at: '2026-09-03T00:00:00Z' });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeMock.mockReset().mockImplementation(async (cmd: string) => {
    if (cmd === 'list_skills') return [needsSetup, ready, unknownEligibility, distilled];
    if (cmd === 'sync_distilled_skill_candidates') return 1;
    if (cmd === 'jarvis_get_skills' || cmd === 'jarvis_get_tools') return [];
    return undefined;
  });
  let current = candidate();
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${BUN_URL}/skills/candidates`) {
      return { ok: true, status: 200, json: async () => ({ candidates: [current, orphan] }) } as Response;
    }
    if (url === `${BUN_URL}/skills/candidates/cand-1/promote` && init?.method === 'POST') {
      current = candidate({ status: 'promoted', lifecycle_version: 1, promoted_at: '2026-09-04T00:00:00Z' });
      return { ok: true, status: 200, json: async () => current } as Response;
    }
    if (url.endsWith('/performance')) return { ok: true, status: 200, json: async () => null } as Response;
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () => render(<ToastProvider><SkillsPage /></ToastProvider>);

describe('Skills eligibility', () => {
  it('shows missing requirements as chips and only claims eligibility the metadata states', async () => {
    mount();
    const card = (await screen.findByRole('button', { name: 'Inspect skill: docker-ops' })).closest('li')!;
    expect(within(card).getByText('Needs setup')).toBeInTheDocument();
    const missing = within(card).getByRole('list', { name: 'Missing requirements' });
    expect(within(missing).getByText('docker')).toBeInTheDocument();
    const ok = screen.getByRole('button', { name: 'Inspect skill: git-helper' }).closest('li')!;
    expect(within(ok).getByText('Ready')).toBeInTheDocument();
    const unknown = screen.getByRole('button', { name: 'Inspect skill: plain-skill' }).closest('li')!;
    expect(within(unknown).queryByText('Ready')).not.toBeInTheDocument();
    expect(within(unknown).queryByText('Needs setup')).not.toBeInTheDocument();
  });

  it('lists declared and unmet requirements in the inspector', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: 'Inspect skill: docker-ops' }));
    const detail = within(screen.getByRole('region', { name: 'Skill details: docker-ops' }));
    expect(detail.getByText('Requirements')).toBeInTheDocument();
    expect(detail.getByTitle('Missing')).toHaveTextContent('docker');
    expect(detail.getByTitle('Satisfied')).toHaveTextContent('linux');
  });
});

describe('Skills Candidates tab', () => {
  it('lists every observed candidate with gates, and promotes through the same lifecycle flow', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole('button', { name: 'Inspect skill: docker-ops' });
    await user.click(screen.getByRole('tab', { name: /Candidates/ }));

    const row = within(await screen.findByRole('listitem', { name: 'Candidate: distilled-trace' }));
    expect(row.getByText('0.70')).toBeInTheDocument();
    expect(row.getByRole('meter', { name: /Eval score 90 of 100/ })).toBeInTheDocument();
    const orphanRow = within(screen.getByRole('listitem', { name: 'Candidate: orphan-candidate' }));
    expect(orphanRow.getByText(/Rejected: eval_failed/)).toBeInTheDocument();
    expect(orphanRow.queryByRole('button', { name: 'Open skill' })).not.toBeInTheDocument();

    fireEvent.click(row.getByRole('button', { name: 'Promote' }));
    await waitFor(() => expect(screen.getByText('Promoted distilled-trace')).toBeInTheDocument());
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/cand-1/promote') && init?.method === 'POST')).toHaveLength(1);
    await waitFor(() => expect(row.getByRole('button', { name: 'Demote' })).toBeEnabled());
  });

  it('opens the linked skill in the Installed inspector', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole('button', { name: 'Inspect skill: docker-ops' });
    await user.click(screen.getByRole('tab', { name: /Candidates/ }));
    const row = within(await screen.findByRole('listitem', { name: 'Candidate: distilled-trace' }));
    await user.click(row.getByRole('button', { name: 'Open skill' }));
    expect(await screen.findByRole('region', { name: 'Skill details: distilled-trace' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Installed/ })).toHaveAttribute('aria-selected', 'true');
  });
});
