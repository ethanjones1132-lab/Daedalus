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
  });
});
