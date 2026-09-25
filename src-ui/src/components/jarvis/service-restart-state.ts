export type RestartPhase =
  | 'idle'
  | 'writing'
  | 'confirming'
  | 'confirmed'
  | 'noop'
  | 'write-failed'
  | 'read-failed'
  | 'read-mismatch';

export interface ServiceRestartState {
  key: string | null;
  phase: RestartPhase;
}

export type ServiceRestartEvent =
  | { type: 'start'; key: string }
  | { type: 'readback-start'; key: string }
  | { type: 'readback-confirmed'; key: string }
  | { type: 'command-false'; key: string }
  | { type: 'command-failed'; key: string }
  | { type: 'readback-failed'; key: string }
  | { type: 'readback-mismatch'; key: string }
  | { type: 'dismiss' };

export type ConfirmableRestartKey = 'ollama' | 'bun' | 'proxy';

export interface RestartHealthObservation {
  ollama?: { running?: boolean };
  bun_server?: { running?: boolean };
  claude_proxy?: { running?: boolean };
}

export function initialServiceRestartState(): ServiceRestartState {
  return { key: null, phase: 'idle' };
}

export function reduceServiceRestartState(
  state: ServiceRestartState,
  event: ServiceRestartEvent,
): ServiceRestartState {
  if (event.type === 'dismiss') return initialServiceRestartState();
  if (event.type === 'start') return { key: event.key, phase: 'writing' };
  if (state.key !== event.key) return state;

  switch (event.type) {
    case 'readback-start':
      return { ...state, phase: 'confirming' };
    case 'readback-confirmed':
      return { ...state, phase: 'confirmed' };
    case 'command-false':
      return { ...state, phase: 'noop' };
    case 'command-failed':
      return { ...state, phase: 'write-failed' };
    case 'readback-failed':
      return { ...state, phase: 'read-failed' };
    case 'readback-mismatch':
      return { ...state, phase: 'read-mismatch' };
  }
}

export function serviceRestartBusy(state: ServiceRestartState): boolean {
  return state.phase === 'writing' || state.phase === 'confirming';
}

export function restartServiceRunning(
  key: ConfirmableRestartKey,
  health: RestartHealthObservation,
): boolean {
  if (key === 'ollama') return health.ollama?.running === true;
  if (key === 'bun') return health.bun_server?.running === true;
  return health.claude_proxy?.running === true;
}
