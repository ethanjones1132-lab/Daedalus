import { describe, expect, it } from 'vitest';
import harnessApiSrc from '../features/workflows/harness-api.ts?raw';
import { harnessReducer, initialHarnessState, orderRuns, selectRunGreen, selectSensorGreen } from './harness-state';
import harnessStateSrc from './harness-state.ts?raw';
import type { HarnessRun } from '../features/workflows/harness-api';

const run = (id: string, created_at: string): HarnessRun => ({
  id, project_root: '/project', manifest_id: 'm', manifest_hash: 'hash', status: 'complete', created_at, rounds: [], events: [],
});

describe('harness state', () => {
  it('tracks selection, dirty edits, approval needs, and live rounds', () => {
    const selected = { manifest: { id: 'm' } as never, revision: 3, manifest_hash: 'h' };
    let state = harnessReducer(initialHarnessState, { type: 'manifest-selected', saved: selected });
    state = harnessReducer(state, { type: 'guides-edited', guides: { brief_template: 'new' } });
    state = harnessReducer(state, { type: 'approval-needed', sensorId: 'tests', needed: true });
    state = harnessReducer(state, { type: 'run-updated', run: { run_id: 'r', round: 2, counter_vector: { tests: 0 }, sensors: [{ sensor_id: 'tests', status: 'zero', counter: 0 }] } });
    expect(state.selected?.revision).toBe(3);
    expect(state.dirty.guides?.brief_template).toBe('new');
    expect(state.approvalNeeded.tests).toBe(true);
    expect(state.liveRun?.round).toBe(2);
  });

  it('surfaces stale revision conflicts without replacing selected data', () => {
    const selected = { manifest: { id: 'm' } as never, revision: 2, manifest_hash: 'old' };
    const state = harnessReducer({ ...initialHarnessState, selected }, { type: 'revision-conflict', expectedRevision: 2, currentRevision: 4 });
    expect(state.selected).toBe(selected);
    expect(state.conflict).toEqual({ expectedRevision: 2, currentRevision: 4 });
  });

  it('keeps unsaved guide edits when the manifest is refreshed after a conflict', () => {
    const selected = {
      manifest: { id: 'm', project_kind: 'typescript', template_family: 'typescript_node', guides: { rules: ['old'], brief_template: 'b', skills: [], references: [], banned_defaults: [] } } as never,
      revision: 3,
      manifest_hash: 'old',
    };
    let state = harnessReducer(initialHarnessState, { type: 'manifests-loaded', manifests: [selected] });
    state = harnessReducer(state, { type: 'manifest-selected', saved: selected });
    state = harnessReducer(state, { type: 'guides-edited', guides: { rules: ['mine'] } });
    state = harnessReducer(state, { type: 'revision-conflict', expectedRevision: 3 });
    const fresh = { ...selected, revision: 4, manifest_hash: 'new' };
    state = harnessReducer(state, { type: 'manifest-refreshed', saved: fresh });
    expect(state.conflict).toBeNull();
    expect(state.dirty.guides).toEqual({ rules: ['mine'] });
    expect(state.selected?.revision).toBe(4);
    expect(state.manifests[0].revision).toBe(4);
  });

  it('never reports not-applicable or unapproved sensors as green', () => {
    expect(selectSensorGreen({ sensor_id: 'x', status: 'zero', counter: 0, exit_code: 0 })).toBe(true);
    expect(selectSensorGreen({ sensor_id: 'x', status: 'zero', counter: 0 })).toBe(false);
    expect(selectSensorGreen({ sensor_id: 'x', status: 'not_applicable', counter: null, exit_code: 0 })).toBe(false);
    expect(selectSensorGreen({ sensor_id: 'x', status: 'unapproved', counter: null, exit_code: 0 })).toBe(false);
    expect(selectRunGreen({ run_id: 'r', round: 1, counter_vector: {}, sensors: [{ sensor_id: 'x', status: 'unapproved', counter: null, exit_code: 0 }] })).toBe(false);
    expect(selectRunGreen({ run_id: 'r', round: 1, counter_vector: {}, sensors: [{ sensor_id: 'x', status: 'not_applicable', counter: null, exit_code: 0 }] })).toBe(false);
  });

  it('does not pull the server harness into the UI typecheck', () => {
    const serverImport = 'server-jarvis/' + 'src/harness';
    expect(harnessStateSrc).not.toContain(serverImport);
    expect(harnessApiSrc).not.toContain(serverImport);
  });

  it('orders history newest-first with a stable id tie-break', () => {
    expect(orderRuns([run('a', '2026-01-01'), run('z', '2026-02-01'), run('b', '2026-02-01')]).map(item => item.id)).toEqual(['z', 'b', 'a']);
    const state = harnessReducer(initialHarnessState, { type: 'history-loaded', runs: [run('a', '2026-01-01'), run('z', '2026-02-01')] });
    expect(state.runHistory.map(item => item.id)).toEqual(['z', 'a']);
    expect(state.historyStatus).toBe('loaded');
  });

  it('keeps history loading, empty, and error states distinct and clears stale run details', () => {
    let state = harnessReducer(initialHarnessState, { type: 'history-loading' });
    expect(state.historyStatus).toBe('loading');
    state = harnessReducer(state, { type: 'history-loaded', runs: [] });
    expect(state.historyStatus).toBe('empty');
    state = harnessReducer(state, { type: 'history-loaded', runs: [run('one', '2026-01-01')] });
    state = harnessReducer(state, { type: 'history-run-selected', id: 'one' });
    state = harnessReducer(state, { type: 'history-run-loaded', run: run('one', '2026-01-01') });
    state = harnessReducer(state, { type: 'history-run-selected', id: 'missing' });
    state = harnessReducer(state, { type: 'history-run-error', id: 'missing', message: 'Not found' });
    expect(state.selectedHistoryRun).toBeNull();
    expect(state.selectedHistoryRunStatus).toBe('error');
    state = harnessReducer(state, { type: 'history-error', message: 'Unavailable' });
    expect(state.historyStatus).toBe('error');
    expect(state.runHistory).toEqual([]);
    expect(state.selectedHistoryRun).toBeNull();
  });
});
