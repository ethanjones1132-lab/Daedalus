import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationProvider, useNavigation } from '../../shell/navigation';
import ProjectStewardView, {
  goalMatchesSubmission,
  projectStewardEligibility,
  stewardBlockerGuidance,
} from './ProjectStewardView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const session = (over: Record<string, unknown> = {}) => ({
  id: 'ses-1',
  agent_id: 'jarvis',
  title: 'Project Session',
  archived: false,
  project_root: '/projects/one',
  ...over,
});
const agent = (over: Record<string, unknown> = {}) => ({ id: 'jarvis', enabled: true, ...over });
const projection = (over: Record<string, unknown> = {}) => ({
  slug: 'custom',
  status: 'valid',
  active: true,
  source_hash: 'abc',
  active_source_hash: 'abc',
  ...over,
});

function rows(sessions: unknown[], agents: unknown[], projections: unknown[]) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'list_sessions') return sessions;
    if (command === 'list_agents') return agents;
    if (command === 'list_agent_projections') return projections;
    return null;
  });
}

function mount(sessions: unknown[], agents: unknown[], projections: unknown[]) {
  rows(sessions, agents, projections);
  return render(<ProjectStewardView onOpenInChat={() => {}} />);
}

function Probe() {
  const { route, params } = useNavigation();
  return <div data-testid="route-probe">{`${route}:${params.sessionId ?? ''}:${params.expandControls ?? ''}`}</div>;
}

beforeEach(() => invokeMock.mockReset());
afterEach(cleanup);

describe('Project Steward eligibility predicates', () => {
  it('says the authority holds no Session, and discloses the first-Send binding', async () => {
    mount([], [], []);
    expect(await screen.findAllByText(/holds no persisted Session/)).not.toHaveLength(0);
    expect(screen.getAllByText(/workspace binding is saved on its first Send/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Open Chat with controls expanded' })).toBeInTheDocument();
  });

  it('reports archived Sessions as archived, not as a workspace problem', async () => {
    mount([session({ archived: true })], [agent()], []);
    expect(await screen.findAllByText(/Every persisted Session is archived/)).not.toHaveLength(0);
    expect(screen.queryByText(/no recorded project workspace/)).not.toBeInTheDocument();
  });

  it('reports the missing recorded workspace and says the directory is not revalidated', async () => {
    mount([session({ project_root: null })], [agent()], []);
    expect(await screen.findAllByText(/no recorded project workspace/)).not.toHaveLength(0);
    expect(screen.getAllByText(/does not revalidate the directory/).length).toBeGreaterThan(0);
  });

  it('reports a disabled Agent as the exact blocker', async () => {
    mount(
      [session({ agent_id: 'custom' })],
      [agent({ id: 'custom', enabled: false })],
      [projection()],
    );
    expect(await screen.findAllByText(/no enabled Agent whose record is confirmed/)).not.toHaveLength(0);
    expect(screen.queryByText(/projection is missing or stale/)).not.toBeInTheDocument();
  });

  it('reports a stale custom-Agent projection as the exact blocker', async () => {
    mount(
      [session({ agent_id: 'custom' })],
      [agent({ id: 'custom', enabled: true })],
      [projection({ source_hash: 'old' })],
    );
    expect(await screen.findAllByText(/projection is missing or stale/)).not.toHaveLength(0);
    expect(screen.getAllByText(/built-in Jarvis Agent does not/).length).toBeGreaterThan(0);
  });

  it('reports eligible-but-unselected with a distinct next step', async () => {
    mount(
      [session({ id: 'ses-1', title: 'One' }), session({ id: 'ses-2', title: 'Two', project_root: '/projects/two' })],
      [agent()],
      [],
    );
    await screen.findByRole('button', { name: /One/ });
    expect(screen.getByText(/2 eligible persisted Sessions are available; none is selected/)).toBeInTheDocument();
    expect(screen.getByText(/Select one eligible Session above/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Goal' })).toBeDisabled();
  });

  it('preselects the only eligible Session so the task is the remaining input', async () => {
    mount([session({ title: 'Only One' })], [agent()], []);
    await screen.findByRole('button', { name: /Only One/ });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Only One/ })).toHaveAttribute('aria-pressed', 'true'),
    );
  });

  it('keeps Create Goal disabled until an objective and a criterion exist', async () => {
    mount([session({ title: 'Ready Session' })], [agent()], []);
    const goal = await screen.findByRole('button', { name: 'Create Goal' });
    expect(goal).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Project Steward task'), { target: { value: 'Do the work' } });
    expect(goal).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Acceptance criterion 1'), { target: { value: 'Tests pass' } });
    expect(goal).toBeEnabled();
  });
});

describe('Project Steward deep link to Chat', () => {
  it('opens Chat with the controls expanded and no Session when none is eligible', async () => {
    rows([], [], []);
    render(
      <NavigationProvider initial="project-steward">
        <Probe />
        <ProjectStewardView onOpenInChat={() => {}} />
      </NavigationProvider>,
    );
    await screen.findByRole('button', { name: 'Open Chat with controls expanded' });
    fireEvent.click(screen.getByRole('button', { name: 'Open Chat with controls expanded' }));
    expect(screen.getByTestId('route-probe')).toHaveTextContent('sessions::1');
  });

  it('preselects the exact Session when exactly one is eligible', async () => {
    rows([session({ id: 'ses-only', title: 'Only One' })], [agent()], []);
    render(
      <NavigationProvider initial="project-steward">
        <Probe />
        <ProjectStewardView onOpenInChat={() => {}} />
      </NavigationProvider>,
    );
    await screen.findByRole('button', { name: 'Open Chat' });
    fireEvent.click(screen.getByRole('button', { name: 'Open Chat' }));
    expect(screen.getByTestId('route-probe')).toHaveTextContent('sessions:ses-only:1');
  });
});

describe('stewardBlockerGuidance', () => {
  it('names the native binder for the workspace and never says validated', () => {
    const copy = stewardBlockerGuidance(
      'no-recorded-workspace',
      { archived: 0, workspace: 2, agent: 0, projection: 0 },
      0,
    );
    expect(copy.detail).toContain('memory_bind_session_workspace');
    expect(copy.detail).not.toMatch(/validated/i);
  });

  it('pluralizes and counts the observed Sessions', () => {
    expect(
      stewardBlockerGuidance('no-enabled-agent', { archived: 0, workspace: 0, agent: 1, projection: 0 }, 0)
        .detail,
    ).toContain('1 non-archived Session has no enabled Agent');
  });
});

describe('projectStewardEligibility', () => {
  it('attributes each Session to its first failing predicate and reports counts', () => {
    const sessions = [
      session({ id: 'ok' }),
      session({ id: 'archived', archived: true }),
      session({ id: 'no-root', project_root: null }),
      session({ id: 'disabled', agent_id: 'disabled-agent' }),
      session({ id: 'stale', agent_id: 'stale-agent' }),
    ];
    const agentsById = new Map([
      ['jarvis', { id: 'jarvis', enabled: true }],
      ['disabled-agent', { id: 'disabled-agent', enabled: false }],
      ['stale-agent', { id: 'stale-agent', enabled: true }],
    ]);
    const projectionsBySlug = new Map([
      ['stale-agent', { slug: 'stale-agent', status: 'valid', active: true, source_hash: 'old', active_source_hash: 'new' }],
    ]);
    const result = projectStewardEligibility(sessions, agentsById, projectionsBySlug, null);
    expect(result.counts).toEqual({ archived: 1, workspace: 1, agent: 1, projection: 1 });
    expect(result.eligible.map((row) => row.id)).toEqual(['ok']);
    expect(result.blocker).toBe('none-selected');
  });

  it('reports the most common blocker for a mixed, entirely blocked set', () => {
    const result = projectStewardEligibility(
      [
        session({ id: 'a', project_root: null }),
        session({ id: 'b', project_root: null }),
        session({ id: 'c', archived: true }),
      ],
      new Map([['jarvis', { id: 'jarvis', enabled: true }]]),
      new Map(),
      null,
    );
    expect(result.blocker).toBe('no-recorded-workspace');
  });
});

describe('goalMatchesSubmission', () => {
  const target = session();
  const detail = {
    goal: { id: 'g1', objective: 'Do the thing', status: 'pending', agent_id: 'jarvis', project_root: '/projects/one' },
    criteria: [
      { id: 'c2', goal_id: 'g1', ordinal: 2, text: 'second', authority: 'manual', created_at: '' },
      { id: 'c1', goal_id: 'g1', ordinal: 1, text: 'first', authority: 'manual', created_at: '' },
    ],
  };

  it('accepts an exact Goal/criteria/Agent/root readback', () => {
    expect(goalMatchesSubmission(detail, 'g1', 'Do the thing', ['first', 'second'], target)).toBe(true);
  });

  it('rejects a different Goal, objective, Agent, root, or criterion set', () => {
    expect(goalMatchesSubmission(detail, 'g2', 'Do the thing', ['first', 'second'], target)).toBe(false);
    expect(goalMatchesSubmission(detail, 'g1', 'Do another thing', ['first', 'second'], target)).toBe(false);
    expect(goalMatchesSubmission(detail, 'g1', 'Do the thing', ['first', 'second'], session({ agent_id: 'custom' }))).toBe(false);
    expect(goalMatchesSubmission(detail, 'g1', 'Do the thing', ['first', 'second'], session({ project_root: '/elsewhere' }))).toBe(false);
    expect(goalMatchesSubmission(detail, 'g1', 'Do the thing', ['first'], target)).toBe(false);
    expect(goalMatchesSubmission(detail, 'g1', 'Do the thing', ['second', 'first'], target)).toBe(false);
  });

  it('rejects a terminal Goal', () => {
    const done = { ...detail, goal: { ...detail.goal, status: 'completed' } };
    expect(goalMatchesSubmission(done, 'g1', 'Do the thing', ['first', 'second'], target)).toBe(false);
  });
});
