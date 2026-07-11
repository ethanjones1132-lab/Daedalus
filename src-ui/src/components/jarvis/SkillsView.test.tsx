import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';

// Mock the Tauri IPC layer, same pattern as useTheme.test.ts.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { SkillsView } from './SkillsView';
import { ToastProvider } from '../ui';

const BUN_URL = 'http://127.0.0.1:19877';

const bundledSkill = {
  id: 'skill_bundled_1',
  name: 'code-review',
  description: 'Review code changes',
  path: '',
  enabled: true,
  metadata: JSON.stringify({ category: 'development', source: 'bundled' }),
  body: '# Code review\n...',
  version: 2,
  improvement_score: 0,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
};

const distilledCandidateSkill = {
  id: 'skill_distilled_1',
  name: 'distilled-debug-abcdef',
  description: 'Distilled orchestration pattern for debug',
  path: '',
  enabled: false,
  metadata: JSON.stringify({
    category: 'distilled',
    source: 'trajectory_distillation',
    status: 'candidate',
    confidence: 0.72,
    candidate_id: 'skill_debug_abcdef01',
  }),
  body: '# Distilled: debug\n...',
  version: 1,
  improvement_score: 0,
  created_at: '2026-06-02T00:00:00.000Z',
  updated_at: '2026-06-02T00:00:00.000Z',
};

const candidateDetail = {
  id: 'skill_debug_abcdef01',
  name: 'distilled-debug-abcdef',
  description: 'Distilled orchestration pattern for debug',
  trigger: { task_types: ['debug'], requirements: ['workspace_read'], signals: ['path:file_ext'] },
  body: '# Distilled: debug\n...',
  source_run_ids: ['run_abcdef01'],
  source_session_id: 'sess_1',
  confidence: 0.72,
  status: 'candidate',
  // A candidate may have low distillation confidence and still be promotable
  // once the independent judge/eval gate has passed.
  eval_score: 0.82,
  eval_missed: false,
  rejection_reason: undefined,
  rejection_detail: undefined,
  promoted_at: undefined,
  created_at: '2026-06-02T00:00:00.000Z',
  updated_at: '2026-06-02T00:00:00.000Z',
};

function mockFetchJson(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

function setupFetchMock(overrides?: { onPromote?: () => void }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === `${BUN_URL}/skills/candidates` && method === 'GET') {
      return mockFetchJson({ candidates: [candidateDetail] });
    }
    if (url === `${BUN_URL}/skills/candidates/${candidateDetail.id}/promote` && method === 'POST') {
      overrides?.onPromote?.();
      return mockFetchJson({ id: candidateDetail.id, status: 'promoted', promoted_at: '2026-06-03T00:00:00.000Z' });
    }
    if (url === `${BUN_URL}/skills/candidates/${candidateDetail.id}/reject` && method === 'POST') {
      return mockFetchJson({ id: candidateDetail.id, status: 'rejected', rejection_reason: 'manual' });
    }
    return mockFetchJson({}, false);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderSkillsView() {
  return render(
    <ToastProvider>
      <SkillsView />
    </ToastProvider>,
  );
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'sync_distilled_skill_candidates') return 1;
    if (cmd === 'list_skills') return [bundledSkill, distilledCandidateSkill];
    return null;
  });
  setupFetchMock();
});

describe('SkillsView — distilled candidate actions (D5)', () => {
  it('shows the native Enable/Disable toggle for a bundled skill', async () => {
    renderSkillsView();
    const row = await screen.findByText('code-review');
    const card = row.closest('li')!;
    expect(within(card).getByText(/enable|disable/i)).toBeInTheDocument();
  });

  it('shows Promote/Reject actions instead of the native toggle for a candidate-status distilled skill', async () => {
    renderSkillsView();
    const row = await screen.findByText('distilled-debug-abcdef');
    const card = row.closest('li')!;
    expect(within(card).queryByText(/^enable$/i)).not.toBeInTheDocument();
    expect(within(card).queryByText(/^disable$/i)).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /promote/i })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /reject/i })).toBeInTheDocument();
  });

  it('clicking Promote posts to the Bun promote endpoint and refreshes the list', async () => {
    const onPromote = vi.fn();
    setupFetchMock({ onPromote });
    renderSkillsView();

    const row = await screen.findByText('distilled-debug-abcdef');
    const card = row.closest('li')!;
    fireEvent.click(within(card).getByRole('button', { name: /promote/i }));

    await waitFor(() => expect(onPromote).toHaveBeenCalledTimes(1));
    // Refresh re-invokes list_skills after the action.
    await waitFor(() => {
      expect(invokeMock.mock.calls.filter((c) => c[0] === 'list_skills').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('detail panel shows confidence and source session for a distilled candidate', async () => {
    renderSkillsView();

    const row = await screen.findByText('distilled-debug-abcdef');
    fireEvent.click(row);

    await waitFor(() => {
      expect(screen.getByText(/0\.72/)).toBeInTheDocument();
    });
    expect(screen.getByText(/sess_1/)).toBeInTheDocument();
  });
});
