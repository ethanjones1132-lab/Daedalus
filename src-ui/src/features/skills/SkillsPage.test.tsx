import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';

// Mock the Tauri IPC layer, same pattern as useTheme.test.ts.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import SkillsPage from './SkillsPage';
import { ToastProvider } from '../../design';

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
  rejection_reason: undefined as string | undefined,
  rejection_detail: undefined as string | undefined,
  promoted_at: undefined as string | undefined,
  created_at: '2026-06-02T00:00:00.000Z',
  updated_at: '2026-06-02T00:00:00.000Z',
};

function mockFetchJson(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

function setupFetchMock(overrides?: { onPromote?: () => void }) {
  let candidateSnapshot = { ...candidateDetail, lifecycle_version: 0 };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === `${BUN_URL}/skills/candidates` && method === 'GET') {
      return mockFetchJson({ candidates: [candidateSnapshot] });
    }
    if (url === `${BUN_URL}/skills/candidates/${candidateDetail.id}/promote` && method === 'POST') {
      overrides?.onPromote?.();
      candidateSnapshot = { ...candidateSnapshot, status: 'promoted', lifecycle_version: 1, promoted_at: '2026-06-03T00:00:00.000Z' };
      return mockFetchJson(candidateSnapshot);
    }
    if (url === `${BUN_URL}/skills/candidates/${candidateDetail.id}/reject` && method === 'POST') {
      candidateSnapshot = { ...candidateSnapshot, status: 'rejected', lifecycle_version: 1, rejection_reason: 'manual' };
      return mockFetchJson(candidateSnapshot);
    }
    return mockFetchJson({}, false);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderSkillsPage() {
  return render(
    <ToastProvider>
      <SkillsPage />
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

describe('SkillsPage — distilled candidate actions (D5)', () => {
  // First test in the file hits the 5s default vitest timeout under full-suite
  // load (it triggers a full SkillsPage render with two Tauri invokes +
  // HTTP fetch mock, ~7.7s observed when run with the full vitest corpus but
  // ~600ms in isolation). The other 3 D5 tests in this describe block pass
  // comfortably under budget and are left at the default. This is the same
  // wall-clock-budget-vs-real-work pattern the 1pm cron pass fixed for the
  // claude-delegate `verifies a claimed write` test (commit 47f3c78, 250→1000ms).
  it('shows the native Enable/Disable toggle for a bundled skill', async () => {
    renderSkillsPage();
    const row = await screen.findByText('code-review');
    const card = row.closest('li')!;
    expect(within(card).getByText(/enable|disable/i)).toBeInTheDocument();
  }, 20_000);

  it('shows Promote/Reject actions instead of the native toggle for a candidate-status distilled skill', async () => {
    renderSkillsPage();
    const row = await screen.findByText('distilled-debug-abcdef');
    const card = row.closest('li')!;
    expect(within(card).queryByText(/^enable$/i)).not.toBeInTheDocument();
    expect(within(card).queryByText(/^disable$/i)).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /promote/i })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /reject/i })).toBeInTheDocument();
  });

  it('clicking Promote opens proof review for the exact candidate without writing', async () => {
    const onPromote = vi.fn();
    setupFetchMock({ onPromote });
    renderSkillsPage();

    const row = await screen.findByText('distilled-debug-abcdef');
    const card = row.closest('li')!;
    fireEvent.click(within(card).getByRole('button', { name: /promote/i }));

    await screen.findByRole('region', { name: 'Skill details: distilled-debug-abcdef' });
    expect(screen.getByRole('tab', { name: 'Learning evaluation' })).toHaveAttribute('aria-selected', 'true');
    expect(onPromote).not.toHaveBeenCalled();
    // Refresh re-invokes list_skills after the action.
    await waitFor(() => {
      expect(invokeMock.mock.calls.filter((c) => c[0] === 'list_skills').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('detail panel shows confidence and source session for a distilled candidate', async () => {
    renderSkillsPage();

    const row = await screen.findByText('distilled-debug-abcdef');
    fireEvent.click(row);

    await waitFor(() => {
      expect(screen.getByText(/0\.72/)).toBeInTheDocument();
    });
    expect(screen.getByText(/sess_1/)).toBeInTheDocument();
  });

  // Regression test: jarvis_get_skills / jarvis_get_tools must be invoked (native
  // surface reachability). Fails if either call site is lost (guard verifies set).
  it('invokes jarvis_get_skills and jarvis_get_tools when SkillsPage loads', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'jarvis_get_skills') return [{ name: 'review' }];
      if (cmd === 'jarvis_get_tools') return [{ name: 'lint' }];
      if (cmd === 'list_skills') return [];
      if (cmd === 'sync_distilled_skill_candidates') return 0;
      return undefined;
    });
    renderSkillsPage();
    await waitFor(() => {
      expect(invokeMock.mock.calls.some((c: any[]) => c[0] === 'jarvis_get_skills')).toBe(true);
      expect(invokeMock.mock.calls.some((c: any[]) => c[0] === 'jarvis_get_tools')).toBe(true);
    });
  });
});
