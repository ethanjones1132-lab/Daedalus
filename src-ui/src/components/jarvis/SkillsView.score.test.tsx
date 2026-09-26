import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsView } from './SkillsView';
import { ToastProvider } from '../ui';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const BUN_URL = 'http://127.0.0.1:19877';

const CONFIDENCE_BASIS = 'The confidence in this record is not a readable score, so no score is shown.';
const EVAL_BASIS = 'The eval score in this record is not a readable score, so no score is shown.';
const IMPROVEMENT_BASIS =
  'The improvement score in this record is not a readable score, so no score is shown.';

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'candidate-alpha',
    name: 'distilled-alpha',
    description: 'Alpha candidate',
    trigger: { task_types: ['debug'], requirements: [], signals: [] },
    body: 'alpha body',
    source_run_ids: [],
    confidence: 0.87,
    status: 'candidate',
    lifecycle_version: 0,
    eval_score: 0.91,
    created_at: '2026-09-24T00:00:00.000Z',
    updated_at: '2026-09-24T00:00:00.000Z',
    ...overrides,
  };
}

function nativeSkill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'skill-alpha',
    name: 'distilled-alpha',
    description: 'Alpha candidate',
    path: '',
    enabled: false,
    metadata: JSON.stringify({
      source: 'trajectory_distillation',
      candidate_id: 'candidate-alpha',
      status: 'candidate',
    }),
    body: 'alpha body',
    version: 1,
    improvement_score: 2,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

let candidates: Array<Record<string, unknown>>;
let skills: Array<Record<string, unknown>>;
let fetchMock: ReturnType<typeof vi.fn>;

function row(name: string) {
  return within(screen.getByRole('button', { name: `Inspect skill: ${name}` }).closest('li')!);
}

function detail(name: string) {
  fireEvent.click(screen.getByRole('button', { name: `Inspect skill: ${name}` }));
  return within(screen.getByRole('region', { name: `Skill details: ${name}` }));
}

async function mount() {
  render(
    <ToastProvider>
      <SkillsView />
    </ToastProvider>,
  );
  await screen.findByRole('button', { name: 'Inspect skill: distilled-alpha' });
}

beforeEach(() => {
  candidates = [candidate()];
  skills = [nativeSkill()];
  invokeMock.mockReset().mockImplementation(async (command: string) => {
    if (command === 'list_skills') return skills;
    if (command === 'sync_distilled_skill_candidates') return 1;
    if (command === 'jarvis_get_skills' || command === 'jarvis_get_tools') return [];
    if (command === 'skill_revisions_list') return [];
    return undefined;
  });
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${BUN_URL}/skills/candidates`) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ candidates }),
      } as unknown as Response);
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('an unreadable candidate score costs its own field', () => {
  it('keeps the whole Skills route when the record carries no confidence', async () => {
    candidates = [candidate({ confidence: null })];
    await mount();

    // The surface the throw used to take down is still here: search, the row,
    // and the lifecycle action that does not depend on the score.
    expect(screen.getByPlaceholderText('Search skills…')).toBeInTheDocument();
    expect(row('distilled-alpha').getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.queryByText('This view stopped unexpectedly. Daedalus is still running.')).toBeNull();
  });

  it('says which field it could not read, and prints no confidence number', async () => {
    candidates = [candidate({ confidence: null })];
    await mount();
    const view = detail('distilled-alpha');

    expect(view.getByText(CONFIDENCE_BASIS)).toBeInTheDocument();
    expect(view.getByText('Confidence')).toBeInTheDocument();
    expect(view.queryByText('0.87')).toBeNull();
    expect(view.getByText('Not available')).toBeInTheDocument();
  });

  it('says which field it could not read when an eval score is present but not a score', async () => {
    candidates = [candidate({ eval_score: null })];
    await mount();
    const view = detail('distilled-alpha');

    expect(view.getByText(EVAL_BASIS)).toBeInTheDocument();
    expect(view.queryByText('0.91')).toBeNull();
    // A score this build cannot read is not a passing judge decision.
    expect(view.getByRole('button', { name: 'Promote' })).toBeDisabled();
  });

  it('keeps the eval-score omission rule when the candidate simply has no eval yet', async () => {
    const withoutEval = candidate();
    delete (withoutEval as Record<string, unknown>).eval_score;
    candidates = [withoutEval];
    await mount();
    const view = detail('distilled-alpha');

    expect(view.queryByText(EVAL_BASIS)).toBeNull();
    expect(view.queryByText('Eval score')).toBeNull();
    expect(view.getByText('0.87')).toBeInTheDocument();
  });
});

describe('an unreadable improvement count costs its own field', () => {
  it('says which field it could not read instead of dropping the row', async () => {
    skills = [nativeSkill({ improvement_score: null })];
    await mount();

    const card = row('distilled-alpha');
    expect(card.getByText(IMPROVEMENT_BASIS)).toBeInTheDocument();
    expect(card.getByText('score Not available')).toBeInTheDocument();
    // The row is still a skill row, and it prints no number it cannot support.
    expect(card.getByText('v1')).toBeInTheDocument();
    expect(card.getByText('distilled-alpha')).toBeInTheDocument();
    expect(card.queryByText(/score [\d-]/)).toBeNull();
  });

  it('does not dress a genuine zero up as a fault', async () => {
    skills = [nativeSkill({ improvement_score: 0 })];
    await mount();

    const card = row('distilled-alpha');
    expect(card.queryByText(IMPROVEMENT_BASIS)).toBeNull();
    expect(card.queryByText('Not available')).toBeNull();
    expect(card.queryByText(/^score/)).toBeNull();
    // A never-improved skill is still a readable skill.
    expect(card.getByText('distilled-alpha')).toBeInTheDocument();
  });
});

describe('a readable score still shows what the record measured', () => {
  it('renders both scores with their existing formatting', async () => {
    await mount();
    const view = detail('distilled-alpha');

    expect(view.getByText('0.87')).toBeInTheDocument();
    expect(view.getByText('0.91')).toBeInTheDocument();
    expect(view.getByText('Confidence')).toBeInTheDocument();
    expect(view.getByText('Eval score')).toBeInTheDocument();
    expect(view.queryByText('Not available')).toBeNull();
  });

  it('still lets a passing candidate be promoted and rejected', async () => {
    await mount();
    const card = row('distilled-alpha');
    const promote = card.getByRole('button', { name: 'Promote' });
    const reject = card.getByRole('button', { name: 'Reject' });
    expect(promote).toBeEnabled();
    expect(reject).toBeEnabled();

    fireEvent.click(promote);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === `${BUN_URL}/skills/candidates/candidate-alpha/promote` &&
            (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true);
    });
  });

  it('still renders the improvement count the way it always has', async () => {
    skills = [nativeSkill({ improvement_score: 2 })];
    await mount();
    expect(row('distilled-alpha').getByText('score 2.00')).toBeInTheDocument();
  });

  it('keeps a below-threshold eval score visible and unpromotable', async () => {
    candidates = [candidate({ eval_score: 0.4 })];
    await mount();

    const view = detail('distilled-alpha');
    expect(view.getByText('0.40')).toBeInTheDocument();
    const promote = view.getByRole('button', { name: 'Promote' });
    expect(promote).toBeDisabled();
    expect(promote).toHaveAttribute(
      'title',
      'Run eval first — promotion requires a passing judge decision (≥0.75)',
    );
  });

  it('keeps the ≥0.75 colour threshold on a readable eval score', async () => {
    await mount();
    expect(detail('distilled-alpha').getByText('0.91').className).toContain('emerald');
    fireEvent.click(screen.getByRole('button', { name: 'Inspect skill: distilled-alpha' }));
    cleanup();
    candidates = [candidate({ eval_score: 0.4 })];
    await mount();
    expect(detail('distilled-alpha').getByText('0.40').className).toContain('amber');
  });
});
