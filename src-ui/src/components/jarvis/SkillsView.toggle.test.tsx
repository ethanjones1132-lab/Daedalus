import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const alpha = {
  id: 'a', name: 'code-review', description: 'Review code', path: '', enabled: false,
  metadata: null, body: '# Review', version: 2, improvement_score: 0,
  created_at: '2026-06-01', updated_at: '2026-06-01',
};
const beta = { ...alpha, id: 'b', name: 'test-writer', enabled: true };
const revision = {
  id: 'rev-a', skill_id: 'a', version: 1, body_before: '', body_after: '# Review',
  change_reason: 'Synthetic revision', created_at: '2026-06-01',
};
let read: () => Promise<typeof alpha[]>;
let write: (command: string, name: string) => Promise<void>;

beforeEach(() => {
  read = async () => [alpha, beta];
  write = async () => undefined;
  invokeMock.mockReset().mockImplementation((command: string, args?: { name?: string }) => {
    if (command === 'list_skills') return read();
    if (command === 'enable_skill' || command === 'disable_skill') return write(command, args!.name!);
    if (command === 'sync_distilled_skill_candidates') return Promise.resolve(0);
    if (command === 'skill_revisions_list') return Promise.resolve([revision]);
    if (command === 'skill_restore_revision') return Promise.resolve(true);
    if (command === 'jarvis_get_skills' || command === 'jarvis_get_tools') return Promise.resolve([]);
    throw new Error(`Unexpected command: ${command}`);
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ candidates: [] }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function mount() {
  render(<ToastProvider><SkillsView /></ToastProvider>);
  await screen.findByRole('button', { name: 'Inspect skill: code-review' });
}
function row(name = 'code-review') {
  return within(screen.getByRole('button', { name: `Inspect skill: ${name}` }).closest('li')!);
}
function inspect(name = 'code-review') {
  fireEvent.click(screen.getByRole('button', { name: `Inspect skill: ${name}` }));
  return within(screen.getByRole('region', { name: `Skill details: ${name}` }));
}
function calls() {
  return invokeMock.mock.calls.filter(([c]) => c === 'enable_skill' || c === 'disable_skill');
}
async function showRevisions() {
  const detail = inspect();
  fireEvent.click(detail.getByRole('tab', { name: 'Revisions' }));
  await detail.findByRole('button', { name: 'Restore' });
  return detail;
}

describe('SkillsView native toggle coordination', () => {
  it.each(['list', 'inspector'])('serializes both surfaces after a %s submission and confirms only on void resolution', async (source) => {
    const pending = deferred<void>();
    write = () => pending.promise;
    await mount();
    const detail = inspect();
    const listButton = row().getByRole('button', { name: 'Enable' });
    const detailButton = detail.getByRole('button', { name: 'Enable' });
    fireEvent.click(source === 'list' ? listButton : detailButton);
    fireEvent.click(listButton);
    fireEvent.click(detailButton);
    expect(calls()).toEqual([['enable_skill', { name: 'code-review' }]]);
    expect(listButton).toBeDisabled();
    expect(detailButton).toBeDisabled();
    expect(listButton).toHaveTextContent('Enabling');
    expect(screen.getByText('1 enabled')).toBeInTheDocument();
    expect(screen.queryByText('Enabled code-review')).not.toBeInTheDocument();
    await act(async () => { pending.resolve(); });
    expect(row().getByRole('button', { name: 'Disable' })).toBeEnabled();
    expect(detail.getByRole('button', { name: 'Disable' })).toBeEnabled();
    expect(screen.getByText('2 enabled')).toBeInTheDocument();
    expect(screen.getByText('Enabled code-review')).toBeInTheDocument();
    // Opposite direction is permitted only after settlement.
    fireEvent.click(detail.getByRole('button', { name: 'Disable' }));
    await act(async () => {});
    expect(calls()[1]).toEqual(['disable_skill', { name: 'code-review' }]);
  });

  it.each([false, true])('retains confirmed enabled=%s on rejection and retries from either surface', async (enabled) => {
    read = async () => [{ ...alpha, enabled }];
    const first = deferred<void>();
    const retry = deferred<void>();
    write = () => first.promise;
    await mount();
    const detail = inspect();
    fireEvent.click(detail.getByRole('button', { name: enabled ? 'Disable' : 'Enable' }));
    await act(async () => { first.reject(new Error('synthetic private native detail')); });
    expect(row().getByRole('alert')).toHaveTextContent('Could not update skill enablement. Showing last confirmed state');
    expect(detail.getByRole('alert')).toHaveTextContent(enabled ? 'enabled.' : 'disabled.');
    expect(screen.queryByText(/synthetic private native detail/)).not.toBeInTheDocument();
    expect(screen.getByText(`${enabled ? 1 : 0} enabled`)).toBeInTheDocument();
    write = () => retry.promise;
    fireEvent.click(row().getByRole('button', { name: 'Retry' }));
    expect(detail.getByRole('button', { name: 'Retry' })).toBeDisabled();
    fireEvent.click(detail.getByRole('button', { name: 'Retry' }));
    expect(calls()).toEqual(Array(2).fill([enabled ? 'disable_skill' : 'enable_skill', { name: 'code-review' }]));
    await act(async () => { retry.resolve(); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(`${enabled ? 0 : 1} enabled`)).toBeInTheDocument();
  });

  it('keeps filtered membership confirmed while independent skills settle', async () => {
    const a = deferred<void>();
    const b = deferred<void>();
    write = (_, name) => name === alpha.name ? a.promise : b.promise;
    await mount();
    fireEvent.click(row().getByRole('button', { name: 'Enable' }));
    fireEvent.click(inspect(beta.name).getByRole('button', { name: 'Disable' }));
    expect(calls()).toHaveLength(2);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'enabled' } });
    expect(screen.queryByRole('button', { name: 'Inspect skill: code-review' })).not.toBeInTheDocument();
    expect(row(beta.name).getByRole('button', { name: /Disabling/ })).toBeDisabled();
    await act(async () => { a.resolve(); });
    expect(row().getByRole('button', { name: 'Disable' })).toBeEnabled();
    expect(screen.getByText('2 enabled')).toBeInTheDocument();
    await act(async () => { b.resolve(); });
    expect(screen.queryByRole('button', { name: 'Inspect skill: test-writer' })).not.toBeInTheDocument();
    expect(screen.getByText('1 enabled')).toBeInTheDocument();
  });

  it('does not publish a concurrent read of an in-flight write before it resolves', async () => {
    const mutation = deferred<void>();
    write = () => mutation.promise;
    await mount();
    const detail = await showRevisions();
    fireEvent.click(detail.getByRole('button', { name: 'Enable' }));
    read = async () => [{ ...alpha, enabled: true }, beta];
    fireEvent.click(detail.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(row().getByRole('button', { name: /Enabling/ })).toBeDisabled());
    expect(screen.getByText('1 enabled')).toBeInTheDocument();
    expect(detail.getByRole('button', { name: /Enabling/ })).toBeDisabled();
    await act(async () => { mutation.resolve(); });
    expect(screen.getByText('2 enabled')).toBeInTheDocument();
  });

  it('ignores an obsolete read after a newer read has released toggle protection', async () => {
    const mutation = deferred<void>();
    const stale = deferred<typeof alpha[]>();
    write = () => mutation.promise;
    await mount();
    const detail = await showRevisions();
    fireEvent.click(detail.getByRole('button', { name: 'Enable' }));
    read = () => stale.promise;
    fireEvent.click(detail.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(invokeMock.mock.calls.filter(([c]) => c === 'list_skills')).toHaveLength(2));
    await act(async () => { mutation.resolve(); });
    read = async () => [{ ...alpha, enabled: true }, beta];
    fireEvent.click(detail.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(row().getByRole('button', { name: 'Disable' })).toBeEnabled());
    await act(async () => { stale.resolve([alpha, beta]); });
    expect(row().getByRole('button', { name: 'Disable' })).toBeEnabled();
    expect(screen.getByText('2 enabled')).toBeInTheDocument();
  });

  it('protects confirmed enablement from a real overlapping post-restore read, then honors a fresh read', async () => {
    const mutation = deferred<void>();
    const stale = deferred<typeof alpha[]>();
    write = () => mutation.promise;
    await mount();
    const detail = await showRevisions();
    fireEvent.click(detail.getByRole('button', { name: 'Enable' }));
    read = () => stale.promise;
    fireEvent.click(detail.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(invokeMock.mock.calls.filter(([c]) => c === 'list_skills')).toHaveLength(2));
    await act(async () => { mutation.resolve(); });
    await act(async () => { stale.resolve([alpha, beta]); });
    expect(screen.getByText('2 enabled')).toBeInTheDocument();
    expect(row().getByRole('button', { name: 'Disable' })).toBeEnabled();
    read = async () => [alpha, beta];
    fireEvent.click(detail.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(row().getByRole('button', { name: 'Enable' })).toBeEnabled());
    expect(screen.getByText('1 enabled')).toBeInTheDocument();
  });
});
