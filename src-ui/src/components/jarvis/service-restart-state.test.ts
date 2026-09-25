import { describe, expect, it } from 'vitest';
import {
  initialServiceRestartState,
  reduceServiceRestartState,
  restartServiceRunning,
  serviceRestartBusy,
} from './service-restart-state';

describe('service restart state', () => {
  it('serializes terminal outcomes for one service', () => {
    let state = reduceServiceRestartState(initialServiceRestartState(), { type: 'start', key: 'ollama' });
    expect(state).toEqual({ key: 'ollama', phase: 'writing' });
    expect(serviceRestartBusy(state)).toBe(true);

    state = reduceServiceRestartState(state, { type: 'readback-start', key: 'ollama' });
    expect(state.phase).toBe('confirming');
    state = reduceServiceRestartState(state, { type: 'readback-confirmed', key: 'ollama' });
    expect(state.phase).toBe('confirmed');
    expect(serviceRestartBusy(state)).toBe(false);

    state = reduceServiceRestartState(state, { type: 'start', key: 'bun' });
    state = reduceServiceRestartState(state, { type: 'command-false', key: 'bun' });
    expect(state.phase).toBe('noop');
  });

  it('ignores completions from a replaced operation', () => {
    let state = reduceServiceRestartState(initialServiceRestartState(), { type: 'start', key: 'ollama' });
    state = reduceServiceRestartState(state, { type: 'start', key: 'proxy' });
    state = reduceServiceRestartState(state, { type: 'readback-confirmed', key: 'ollama' });
    expect(state).toEqual({ key: 'proxy', phase: 'writing' });
    state = reduceServiceRestartState(state, { type: 'command-failed', key: 'proxy' });
    expect(state.phase).toBe('write-failed');
  });

  it.each([
    ['ollama', { ollama: { running: true } }],
    ['bun', { bun_server: { running: true } }],
    ['proxy', { claude_proxy: { running: true } }],
  ] as const)('recognizes a confirmed %s observation', (key, health) => {
    expect(restartServiceRunning(key, health as never)).toBe(true);
  });
});
