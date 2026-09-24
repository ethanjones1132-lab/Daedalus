import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsView } from './SkillsView';
import { ToastProvider } from '../ui';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const BUN_URL = 'http://127.0.0.1:19877';

type Candidate = {
  id: string;
  name: string;
  description: string;
  trigger: { task_types: string[]; requirements: string[]; signals: string[] };
  body: string;
  source_run_ids: string[];
  confidence: number;
  status: 'candidate' | 'promoted' | 'rejected';
  lifecycle_version: number;
  eval_score: number;
  created_at: string;
  updated_at: string;
};

const alpha: Candidate = {
  id: 'candidate-alpha',
  name: 'distilled-alpha',
  description: 'Alpha candidate',
  trigger: { task_types: ['debug'], requirements: ['workspace_read'], signals: ['mutation_verb'] },
  body: 'alpha body',
  source_run_ids: ['run-alpha'],
  confidence: 0.9,
  status: 'candidate',
  lifecycle_version: 0,
  eval_score: 0.9,
  created_at: '2026-09-24T00:00:00.000Z',
  updated_at: '2026-09-24T00:00:00.000Z',
};

const beta: Candidate = {
  ...alpha,
  id: 'candidate-beta',
  name: 'distilled-beta',
  source_run_ids: ['run-beta'],
};

const nativeAlpha = {
  id: 'skill-alpha', name: 'distilled-alpha', description: 'Alpha candidate', path: '', enabled: false,
  metadata: JSON.stringify({ source: 'trajectory_distillation', candidate_id: alpha.id, status: 'candidate' }),
  body: 'alpha body', version: 1, improvement_score: 0, created_at: '', updated_at: '',
};
const nativeBeta = {
  ...nativeAlpha,
  id: 'skill-beta', name: 'distilled-beta', metadata: JSON.stringify({ source: 'trajectory_distillation', candidate_id: beta.id, status: 'candidate' }),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function response(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as Response;
}

let candidates: Record<string, Candidate>;
let readQueue: Array<Promise<Response>>;
let postQueue: Record<string, Array<Promise<Response>>>;
let fetchMock: ReturnType<typeof vi.fn>;

function actionUrl(id: string, action: string): string {
  return `${BUN_URL}/skills/candidates/${id}/${action}`;
}

function row(name: string) {
  return within(screen.getByRole('button', { name: `Inspect skill: ${name}` }).closest('li')!);
}

function inspect(name: string) {
  fireEvent.click(screen.getByRole('button', { name: `Inspect skill: ${name}` }));
  return within(screen.getByRole('region', { name: `Skill details: ${name}` }));
}

function posts(id: string, action: string) {
  return fetchMock.mock.calls.filter(([url, init]) => String(url) === actionUrl(id, action) && init?.method === 'POST');
}

async function mount() {
  render(
    <ToastProvider>
      <SkillsView />
    </ToastProvider>,
  );
  await screen.findByRole('button', { name: 'Inspect skill: distilled-alpha' });
  await screen.findByRole('button', { name: 'Inspect skill: distilled-beta' });
}

beforeEach(() => {
  candidates = {
    [alpha.id]: { ...alpha },
    [beta.id]: { ...beta },
  };
  readQueue = [];
  postQueue = {};
  invokeMock.mockReset().mockImplementation(async (command: string) => {
    if (command === 'list_skills') return [nativeAlpha, nativeBeta];
    if (command === 'sync_distilled_skill_candidates') return 1;
    if (command === 'jarvis_get_skills' || command === 'jarvis_get_tools') return [];
    if (command === 'skill_revisions_list') return [];
    return undefined;
  });
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${BUN_URL}/skills/candidates` && (!init?.method || init.method === 'GET')) {
      return Promise.resolve(readQueue.shift() ?? response({ candidates: Object.values(candidates) }));
    }
    const match = url.match(/\/skills\/candidates\/([^/]+)\/(promote|reject|demote|eval)$/);
    if (match && init?.method === 'POST') {
      const id = decodeURIComponent(match[1]);
      return postQueue[id]?.shift() ?? Promise.resolve(response({ id, status: 'candidate' }, false, 409));
    }
    return Promise.resolve(response({}, false, 404));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SkillsView distilled candidate lifecycle coordination', () => {
  it('issues one write from row and inspector, freezes both, and confirms the actual result', async () => {
    const write = deferred<Response>();
    postQueue[alpha.id] = [write.promise];
    await mount();
    const alphaRow = row('distilled-alpha');
    const detail = inspect('distilled-alpha');

    fireEvent.click(alphaRow.getByRole('button', { name: 'Promote' }));
    fireEvent.click(detail.getByRole('button', { name: 'Reject' }));
    expect(posts(alpha.id, 'promote')).toHaveLength(1);
    expect(posts(alpha.id, 'reject')).toHaveLength(0);
    for (const button of [alphaRow.getByRole('button', { name: 'Promote' }), alphaRow.getByRole('button', { name: 'Reject' }), detail.getByRole('button', { name: 'Promote' }), detail.getByRole('button', { name: 'Reject' })]) {
      expect(button).toBeDisabled();
    }

    candidates[alpha.id] = { ...candidates[alpha.id], status: 'rejected', lifecycle_version: 1 };
    await act(async () => write.resolve(response({ id: alpha.id, status: 'rejected', lifecycle_version: 1 })));
    await waitFor(() => expect(screen.getByText('Rejected distilled-alpha')).toBeInTheDocument());
    expect(posts(alpha.id, 'promote')).toHaveLength(1);
    expect(screen.queryByText('Promoted distilled-alpha')).not.toBeInTheDocument();
  });

  it('retains the confirmed candidate after a rejected write and retries the write', async () => {
    const first = deferred<Response>();
    const retry = deferred<Response>();
    postQueue[alpha.id] = [first.promise, retry.promise];
    await mount();
    const alphaRow = row('distilled-alpha');
    fireEvent.click(alphaRow.getByRole('button', { name: 'Reject' }));
    await act(async () => first.resolve(response({ error: 'invalid' }, false, 400)));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not update candidate lifecycle.'));
    expect(alphaRow.getByRole('button', { name: 'Reject' })).toBeEnabled();
    expect(candidates[alpha.id].status).toBe('candidate');

    fireEvent.click(alphaRow.getByRole('button', { name: 'Retry' }));
    expect(posts(alpha.id, 'reject')).toHaveLength(2);
    candidates[alpha.id] = { ...candidates[alpha.id], status: 'rejected', lifecycle_version: 1 };
    await act(async () => retry.resolve(response({ id: alpha.id, status: 'rejected', lifecycle_version: 1 })));
    await waitFor(() => expect(screen.getByText('Rejected distilled-alpha')).toBeInTheDocument());
  });

  it('uses a read-only retry after an accepted write cannot be confirmed', async () => {
    const write = deferred<Response>();
    const firstRead = deferred<Response>();
    const retryRead = deferred<Response>();
    postQueue[alpha.id] = [write.promise];
    await mount();
    readQueue.push(firstRead.promise, retryRead.promise);
    const alphaRow = row('distilled-alpha');
    fireEvent.click(alphaRow.getByRole('button', { name: 'Promote' }));
    candidates[alpha.id] = { ...candidates[alpha.id], status: 'promoted', lifecycle_version: 1 };
    await act(async () => write.resolve(response({ id: alpha.id, status: 'promoted', lifecycle_version: 1 })));
    await act(async () => firstRead.reject(new Error('private read detail')));
    await waitFor(() => expect(screen.getByRole('alert', { name: 'Candidate lifecycle: distilled-alpha' })).toHaveTextContent('lifecycle write completed'));
    expect(alphaRow.getByRole('button', { name: 'Promote' })).toBeDisabled();

    fireEvent.click(alphaRow.getByRole('button', { name: 'Retry' }));
    expect(posts(alpha.id, 'promote')).toHaveLength(1);
    await act(async () => retryRead.resolve(response({ candidates: Object.values(candidates) })));
    await waitFor(() => expect(screen.getByText('Promoted distilled-alpha')).toBeInTheDocument());
  });

  it('keeps independent candidate writes usable and reconciles their reads independently', async () => {
    const alphaWrite = deferred<Response>();
    const betaWrite = deferred<Response>();
    postQueue[alpha.id] = [alphaWrite.promise];
    postQueue[beta.id] = [betaWrite.promise];
    await mount();
    const alphaRow = row('distilled-alpha');
    const betaRow = row('distilled-beta');

    fireEvent.click(alphaRow.getByRole('button', { name: 'Promote' }));
    fireEvent.click(betaRow.getByRole('button', { name: 'Reject' }));
    expect(posts(alpha.id, 'promote')).toHaveLength(1);
    expect(posts(beta.id, 'reject')).toHaveLength(1);
    expect(alphaRow.getByRole('button', { name: 'Promote' })).toBeDisabled();
    expect(betaRow.getByRole('button', { name: 'Reject' })).toBeDisabled();

    candidates[beta.id] = { ...candidates[beta.id], status: 'rejected', lifecycle_version: 1 };
    await act(async () => betaWrite.resolve(response({ id: beta.id, status: 'rejected', lifecycle_version: 1 })));
    candidates[alpha.id] = { ...candidates[alpha.id], status: 'promoted', lifecycle_version: 1 };
    await act(async () => alphaWrite.resolve(response({ id: alpha.id, status: 'promoted', lifecycle_version: 1 })));
    await waitFor(() => {
      expect(screen.getByText('Promoted distilled-alpha')).toBeInTheDocument();
      expect(screen.getByText('Rejected distilled-beta')).toBeInTheDocument();
    });
  });
});
