import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationProvider } from '../../shell/navigation';
import HarnessPage from './HarnessPage';
import { HarnessApiError, type HarnessRun, type SavedHarnessManifest } from './harness-api';

const { listManifests, listRuns, getRun, updateManifest, startRun, cancelRun } = vi.hoisted(() => ({
  listManifests: vi.fn(), listRuns: vi.fn(), getRun: vi.fn(), updateManifest: vi.fn(),
  startRun: vi.fn(), cancelRun: vi.fn(),
}));
vi.mock('./harness-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./harness-api')>();
  return { ...actual, harnessApi: { ...actual.harnessApi, listManifests, listRuns, getRun, updateManifest, startRun, cancelRun } };
});

const savedManifest: SavedHarnessManifest = {
  manifest: {
    schema_version: 1,
    id: 'manifest-1',
    project_root: 'C:/projects/one',
    project_kind: 'typescript',
    purpose: 'bug_fix',
    template_family: 'typescript_node',
    guides: { rules: [], brief_template: '', skills: [], references: [], banned_defaults: [] },
    maker_agent_id: 'maker',
    checker: { enabled: true, agent_id: 'checker', rubric: '' },
    sensors: [{
      id: 'tests', kind: 'command', command_id: 'tests', args: [], timeout_ms: 30000,
      zero_threshold: 0, failure_message: 'tests must be zero', required: true,
    }],
    loop: { max_rounds: 2, abort_on_no_progress: true },
    approval: { required_for_new_commands: true },
  },
  revision: 3,
  manifest_hash: 'hash-1',
};

const savedRun: HarnessRun = {
  id: 'run-1',
  project_root: 'C:/projects/one',
  manifest_id: 'manifest-1',
  manifest_hash: 'hash-1',
  status: 'failed',
  created_at: '2026-11-15T10:00:00.000Z',
  rounds: [{
    id: 'round-1', run_id: 'run-1', round_number: 1, counter_vector: { tests: 2 },
    created_at: '2026-11-15T10:01:00.000Z',
    sensor_results: [{
      id: 'result-1', run_id: 'run-1', round_id: 'round-1', sensor_id: 'tests',
      status: 'failed', counter: 2, exit_code: 1, stdout: 'test output', stdout_truncated: false,
      stderr: 'failure output', stderr_truncated: false, created_at: '2026-11-15T10:01:00.000Z',
    }],
  }],
  events: [{ id: 'event-1', run_id: 'run-1', event_type: 'stopped', payload: { stop_reason: 'max_rounds' }, created_at: '2026-11-15T10:02:00.000Z' }],
};

function mount() {
  return render(<NavigationProvider initial="harness"><HarnessPage /></NavigationProvider>);
}

afterEach(() => {
  cleanup();
  listManifests.mockReset();
  listRuns.mockReset();
  getRun.mockReset();
  updateManifest.mockReset();
  startRun.mockReset();
  cancelRun.mockReset();
});

beforeEach(() => {
  listRuns.mockResolvedValue([]);
});

describe('HarnessPage picker route', () => {
  it('shows an honest empty state and does not present it as a successful run', async () => {
    listManifests.mockResolvedValue([]);
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project root' }), { target: { value: 'C:/projects/one' } });

    expect(await screen.findByText('No saved manifest for this project and purpose.')).toBeInTheDocument();
    expect(screen.getByText(/No check or harness run has been started from this page/)).toBeInTheDocument();
    expect(await screen.findByText('No harness run has been recorded for this project.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select a manifest' })).toBeDisabled();
    expect(screen.queryByText(/successful|passed|green/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('lists and selects a saved manifest for the chosen project and purpose', async () => {
    listManifests.mockResolvedValue([savedManifest]);
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project root' }), { target: { value: 'C:/projects/one' } });

    const manifest = await screen.findByRole('button', { name: /typescript · typescript_node/ });
    expect(manifest).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(manifest);
    expect(manifest).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/Start a harness run from the live run panel/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Rules' })).toBeInTheDocument();
  });

  it('lists saved runs with status, stop reason, revision and recorded times', async () => {
    listManifests.mockResolvedValue([savedManifest]);
    listRuns.mockResolvedValue([savedRun]);
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project root' }), { target: { value: 'C:/projects/one' } });

    const row = await screen.findByRole('button', { name: /failed/ });
    expect(row).toHaveTextContent('Stop reason: max_rounds');
    expect(row).toHaveTextContent('Manifest revision: 3');
    expect(row).toHaveTextContent('Started: 2026-11-15T10:00:00.000Z');
    expect(row).toHaveTextContent('Finished: 2026-11-15T10:02:00.000Z');
  });

  it('loads a selected run and renders its rounds and non-zero failed sensor results without success styling', async () => {
    listManifests.mockResolvedValue([savedManifest]);
    listRuns.mockResolvedValue([savedRun]);
    getRun.mockResolvedValue(savedRun);
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project root' }), { target: { value: 'C:/projects/one' } });
    fireEvent.click(await screen.findByRole('button', { name: /failed/ }));

    expect(getRun).toHaveBeenCalledWith('C:/projects/one', 'run-1');
    expect(await screen.findByText('Round 1 · Failed')).toBeInTheDocument();
    expect(screen.getByText('tests · failed')).toBeInTheDocument();
    expect(screen.getByText((_, node) => node?.tagName === 'P'
      && node.textContent === 'Result ID: result-1 · Value: 2 · Zero threshold: 0')).toBeInTheDocument();
    expect(screen.getByText('test output')).toBeInTheDocument();
    expect(screen.getByText('failure output')).toBeInTheDocument();
    expect(screen.queryByText(/passed|complete|green/i)).not.toBeInTheDocument();
  });

  it('shows run_not_found without stale selected-run details', async () => {
    listManifests.mockResolvedValue([savedManifest]);
    listRuns.mockResolvedValue([savedRun]);
    getRun.mockRejectedValue(new HarnessApiError('run_not_found', 404, 'http_error'));
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project root' }), { target: { value: 'C:/projects/one' } });
    fireEvent.click(await screen.findByRole('button', { name: /failed/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That harness run was not found for this project.');
    expect(screen.queryByText('Round 1 · Failed')).not.toBeInTheDocument();
    expect(screen.queryByText('tests · failed')).not.toBeInTheDocument();
  });

  it('keeps a failed lookup distinct from a valid empty manifest list', async () => {
    listManifests.mockRejectedValue(new Error('offline'));
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project root' }), { target: { value: 'C:/projects/one' } });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not read saved harness manifests.');
    expect(alert).toHaveTextContent('this is not an empty list.');
    // The authored sentence is the whole reason; whatever the rejecting layer said
    // may embed store or project detail and is never echoed to the operator.
    expect(alert).not.toHaveTextContent('offline');
    expect(screen.queryByText('No saved manifest for this project and purpose.')).not.toBeInTheDocument();
  });

  it('treats an unreadable manifest body as a failed read, not an empty list', async () => {
    listManifests.mockResolvedValue(null as unknown as SavedHarnessManifest[]);
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project root' }), { target: { value: 'C:/projects/one' } });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('this is not an empty list.');
    expect(screen.queryByText('No saved manifest for this project and purpose.')).not.toBeInTheDocument();
  });

  it('saves edited guide lines against the loaded revision and shows the returned revision', async () => {
    const saved = { ...savedManifest, revision: 4, manifest_hash: 'hash-2' };
    listManifests.mockResolvedValue([savedManifest]);
    updateManifest.mockResolvedValue(saved);
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project root' }), { target: { value: 'C:/projects/one' } });
    fireEvent.click(await screen.findByRole('button', { name: /typescript · typescript_node/ }));

    fireEvent.change(screen.getByRole('textbox', { name: 'Rules' }), { target: { value: 'a, b\n\nc d' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save guide edits' }));

    expect((await screen.findAllByText('Revision 4')).length).toBeGreaterThan(0);
    expect(updateManifest).toHaveBeenCalledWith(
      { ...savedManifest.manifest, guides: { ...savedManifest.manifest.guides, rules: ['a, b', 'c d'] } },
      3,
    );
    expect(screen.queryByText('Unsaved guide edits. Selecting another manifest or purpose discards them.')).not.toBeInTheDocument();
  });

  it('keeps edits visible and reports stale revisions as unsaved conflicts', async () => {
    listManifests.mockResolvedValue([savedManifest]);
    updateManifest.mockRejectedValue(new HarnessApiError('stale', 409, 'stale_revision'));
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project root' }), { target: { value: 'C:/projects/one' } });
    fireEvent.click(await screen.findByRole('button', { name: /typescript · typescript_node/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Rules' }), { target: { value: 'unsaved rule' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save guide edits' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This manifest changed since it was loaded.');
    expect(alert).toHaveTextContent('Your guide edits are unsaved');
    expect(screen.getByRole('textbox', { name: 'Rules' })).toHaveValue('unsaved rule');
    expect(screen.getByRole('button', { name: 'Reload manifest to compare' })).toBeInTheDocument();
    expect(screen.queryByText(/saved at revision|guides saved/i)).not.toBeInTheDocument();
  });

  it('keeps a typed blank line so a second entry can be started', async () => {
    listManifests.mockResolvedValue([savedManifest]);
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project root' }), { target: { value: 'C:/projects/one' } });
    fireEvent.click(await screen.findByRole('button', { name: /typescript · typescript_node/ }));

    const rules = screen.getByRole('textbox', { name: 'Rules' });
    fireEvent.change(rules, { target: { value: 'first\n' } });

    expect(rules).toHaveValue('first\n');
    fireEvent.change(rules, { target: { value: 'first\nsecond\n\n' } });
    expect(rules).toHaveValue('first\nsecond\n\n');
  });

  it('reloads after a stale conflict without discarding the edits, then saves against the new revision', async () => {
    const reloaded = { ...savedManifest, revision: 4, manifest_hash: 'hash-2' };
    listManifests.mockResolvedValueOnce([savedManifest]).mockResolvedValue([reloaded]);
    updateManifest.mockRejectedValueOnce(new HarnessApiError('stale', 409, 'stale_revision'))
      .mockResolvedValue({ ...reloaded, revision: 5 });
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project root' }), { target: { value: 'C:/projects/one' } });
    fireEvent.click(await screen.findByRole('button', { name: /typescript · typescript_node/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Rules' }), { target: { value: 'kept rule' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save guide edits' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Reload manifest to compare' }));

    expect((await screen.findAllByText('Revision 4')).length).toBeGreaterThan(0);
    expect(screen.getByRole('textbox', { name: 'Rules' })).toHaveValue('kept rule');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save guide edits' }));

    expect((await screen.findAllByText('Revision 5')).length).toBeGreaterThan(0);
    expect(updateManifest).toHaveBeenLastCalledWith(
      { ...savedManifest.manifest, guides: { ...savedManifest.manifest.guides, rules: ['kept rule'] } },
      4,
    );
  });
});

const runningRun: HarnessRun = {
  ...savedRun,
  id: 'run-live',
  status: 'running',
  rounds: [{
    ...savedRun.rounds[0],
    id: 'round-live',
    run_id: 'run-live',
    sensor_results: [{ ...savedRun.rounds[0].sensor_results[0], id: 'result-live', run_id: 'run-live', round_id: 'round-live' }],
  }],
  events: [],
};

async function selectManifestAndRoot() {
  fireEvent.change(screen.getByRole('textbox', { name: 'Project root' }), { target: { value: 'C:/projects/one' } });
  fireEvent.click(await screen.findByRole('button', { name: /typescript · typescript_node/ }));
}

describe('HarnessPage live run panel', () => {
  it('starts the selected manifest, shows the returned run id, and reads the run from its GET route', async () => {
    listManifests.mockResolvedValue([savedManifest]);
    startRun.mockResolvedValue({ run_id: 'run-live' });
    getRun.mockResolvedValue(runningRun);
    mount();
    await selectManifestAndRoot();

    fireEvent.click(screen.getByRole('button', { name: 'Start harness run' }));

    expect(await screen.findByText('run-live')).toBeInTheDocument();
    expect(startRun).toHaveBeenCalledWith({ projectRoot: 'C:/projects/one', manifestId: 'manifest-1' });
    expect(getRun).toHaveBeenCalledWith('C:/projects/one', 'run-live');
    // The rounds shown are the ones GET returned, not anything the panel made up.
    expect(await screen.findByText('Round 1 · Failed')).toBeInTheDocument();
    expect(screen.getByText('tests · failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeInTheDocument();
  });

  it('cancels an in-flight run and shows the cancelled stop reason the server returned', async () => {
    listManifests.mockResolvedValue([savedManifest]);
    startRun.mockResolvedValue({ run_id: 'run-live' });
    getRun.mockResolvedValue(runningRun);
    cancelRun.mockResolvedValue({ run_id: 'run-live', stop_reason: 'cancelled' });
    mount();
    await selectManifestAndRoot();

    fireEvent.click(screen.getByRole('button', { name: 'Start harness run' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));

    expect(cancelRun).toHaveBeenCalledWith('C:/projects/one', 'run-live');
    expect(await screen.findByText('Stop reason: cancelled')).toBeInTheDocument();
    expect(screen.getByText('The server accepted the cancel and the run settled.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start harness run' })).toBeInTheDocument();
  });

  it('renders the 503 execution refusal as its own state and never fabricates a run', async () => {
    listManifests.mockResolvedValue([savedManifest]);
    startRun.mockRejectedValue(new HarnessApiError('harness_execution_unavailable', 503, 'harness_execution_unavailable'));
    mount();
    await selectManifestAndRoot();

    fireEvent.click(screen.getByRole('button', { name: 'Start harness run' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This server cannot start a harness yet');
    expect(alert).toHaveTextContent('harness_execution_unavailable');
    expect(getRun).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Stop reason:/)).not.toBeInTheDocument();
    expect(screen.queryByText('Round 1 · Failed')).not.toBeInTheDocument();
  });

  it('renders 409 run_not_running as its own state without claiming a cancel', async () => {
    listManifests.mockResolvedValue([savedManifest]);
    startRun.mockResolvedValue({ run_id: 'run-live' });
    getRun.mockResolvedValue(runningRun);
    cancelRun.mockRejectedValue(new HarnessApiError('run_not_running', 409, 'run_not_running'));
    mount();
    await selectManifestAndRoot();

    fireEvent.click(screen.getByRole('button', { name: 'Start harness run' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));

    expect(await screen.findByText(/not running on this server/)).toBeInTheDocument();
    expect(screen.queryByText('The server accepted the cancel and the run settled.')).not.toBeInTheDocument();
    // The re-read still shows only the run's own evidence; no stop reason is invented.
    expect(getRun).toHaveBeenCalledWith('C:/projects/one', 'run-live');
    expect(screen.queryByText(/Stop reason:/)).not.toBeInTheDocument();
  });
});
