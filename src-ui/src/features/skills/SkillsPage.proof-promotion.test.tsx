import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SkillsPage from './SkillsPage';
import { ToastProvider } from '../../design';
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
const digest = `sha256:${'a'.repeat(64)}`;
const skill = { id: 'skill-1', name: 'distilled-proof', description: 'Verified candidate', path: '', enabled: false, metadata: JSON.stringify({ source: 'trajectory_distillation', candidate_id: 'candidate-1', status: 'staged' }), body: 'Use verified evidence.', version: 1, improvement_score: 0, created_at: '', updated_at: '' };
const candidate = { id: 'candidate-1', name: skill.name, description: '', trigger: { task_types: ['debug'], requirements: [], signals: [] }, body: skill.body, source_run_ids: ['run-1'], confidence: 0.9, status: 'staged', lifecycle_version: 2, created_at: '', updated_at: '' };
function evidence(promoted: boolean) {
  return { candidate_id: candidate.id, current_status: promoted ? 'promoted' : 'staged', current_version: promoted ? 3 : 2, count: 1, evaluations: [{ report_hash: digest, record_hash: digest, manifest_hash: digest, decision: 'accepted', generated_at: '2026-10-14T00:00:00Z', candidate: { id: candidate.id, content_digest: digest, artifact_digest: digest }, coverage: { planned_task_count: 1, seeds_per_task: 1, arms_per_block: 2, planned_block_count: 1, planned_outcome_count: 2, observed_outcome_count: 2, missing_outcome_count: 0 }, criteria: [], reasons: [], observed_status: 'staged', observed_version: 2, content_match: true, stale: promoted }] };
}
beforeEach(() => {
  invokeMock.mockReset().mockImplementation(async command => command === 'list_skills' ? [skill] : command === 'sync_distilled_skill_candidates' ? 1 : []);
});
describe('proof-backed candidate promotion through the redesigned surface', () => {
  it('guides into exact candidate review and confirms promotion only after fresh candidate and accepted-proof readback', async () => {
    let promoted = false;
    const posts: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/evaluation')) return new Response(JSON.stringify(evidence(promoted)));
      if (path.endsWith('/promote') && init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body))); promoted = true;
        return new Response(JSON.stringify({ id: candidate.id, status: 'promoted', lifecycle_version: 3 }));
      }
      if (path === '/skills/candidates') return new Response(JSON.stringify({ candidates: [{ ...candidate, status: promoted ? 'promoted' : 'staged', lifecycle_version: promoted ? 3 : 2 }] }));
      return new Response('{}', { status: 404 });
    }));
    render(<ToastProvider><SkillsPage /></ToastProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Promote' }));
    const detail = within(await screen.findByRole('region', { name: `Skill details: ${skill.name}` }));
    expect(screen.getByRole('tab', { name: 'Learning evaluation' })).toHaveAttribute('aria-selected', 'true');
    const promote = await detail.findByRole('button', { name: 'Promote' });
    expect(promote).toBeDisabled();
    expect(posts).toHaveLength(0);
    fireEvent.click(await detail.findByRole('radio', { name: 'accepted' }));
    expect(promote).toBeEnabled();
    fireEvent.click(promote);
    await waitFor(() => expect(posts).toEqual([{ report_hash: digest, record_hash: digest, expected_version: 2 }]));
    await screen.findByText('Promoted distilled-proof');
    expect(detail.getByText('Prior-state rollback evidence (stale)')).toBeInTheDocument();
  });
});
