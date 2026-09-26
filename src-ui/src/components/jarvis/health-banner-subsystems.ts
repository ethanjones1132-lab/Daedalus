// ═══════════════════════════════════════════════════════════════
// ── health-banner-subsystems — honest subsystem rows for the strip
// ═══════════════════════════════════════════════════════════════
//
// The banner lists every subsystem the app depends on, so each row has to say
// two separate things: what was measured, and whether the active inference
// backend needs it at all. A stopped Ollama is a fault only under the Ollama
// backend, and a row that was never probed must never read as measured —
// Native reports `model_available` as `!is_ollama` for every non-Ollama
// backend (src-tauri/src/jarvis/runner.rs:1355,1386-1387), which is a constant
// rather than an observation.
//
// The required set comes from the one canonical projection in
// `system-telemetry-state`, so the two mounted health surfaces cannot disagree
// about which service the active backend needs.

import { projectServiceRequirements, REQUIREMENT_WORDS, listNames, type InferenceBackend, type ServiceRequirement } from './system-telemetry-state';
import type { JarvisStatus } from './types';

export type HealthSubsystemKey = 'bun' | 'bridge' | 'ollama' | 'model' | 'openrouter_key' | 'claude_proxy';

export type HealthSubsystemState = 'up' | 'down' | 'unknown' | 'unprobed';

export interface HealthSubsystemRow {
  key: HealthSubsystemKey;
  name: string;
  state: HealthSubsystemState;
  /** The same words a sighted operator reads, so state never depends on colour. */
  stateWord: string;
  requirement: ServiceRequirement;
  /** Printed next to the state word, so the required set is readable as text. */
  requirementLabel: string;
  requirementClause: string;
  detail: string | null;
  /**
   * True when the read behind this row failed, so the reading is the previous
   * observation rather than the current one. The reading is retained and stays
   * true to what it measured; what it stops being is a reading of right now.
   */
  stale: boolean;
  /** One sentence carrying the whole row, used as its accessible name. */
  announcement: string;
}

export interface HealthSubsystems {
  backend: InferenceBackend | 'unknown';
  rows: HealthSubsystemRow[];
  /** Only rows that are both measured down and required by the active backend. */
  faults: HealthSubsystemRow[];
}

type Unit = 'process' | 'model' | 'key';

const UNIT_WORDS: Record<Unit, Record<HealthSubsystemState, string>> = {
  process: { up: 'is running', down: 'is not running', unknown: 'state is unknown', unprobed: 'was not probed' },
  model: { up: 'is loaded', down: 'is not loaded', unknown: 'state is unknown', unprobed: 'was not probed' },
  key: { up: 'is set', down: 'is not set', unknown: 'state is unknown', unprobed: 'was not probed' },
};

const NAMES: Record<HealthSubsystemKey, string> = {
  bun: 'Bun server',
  bridge: 'Bridge',
  ollama: 'Ollama',
  model: 'Local model',
  openrouter_key: 'OpenRouter key',
  claude_proxy: 'Claude proxy',
};

/** A missing or non-boolean flag is an unknown state, never a stopped service. */
function flagState(value: unknown): HealthSubsystemState {
  return typeof value === 'boolean' ? (value ? 'up' : 'down') : 'unknown';
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function portDetail(port: unknown): string | null {
  return typeof port === 'number' && Number.isInteger(port) && port >= 0 ? `:${port}` : null;
}

function openrouterKeyRequirement(backend: InferenceBackend | 'unknown'): ServiceRequirement {
  if (backend === 'unknown') return 'unknown';
  return backend === 'openrouter' ? 'required' : 'not_required';
}

const REQUIREMENT_LABELS: Record<ServiceRequirement, string> = {
  required: 'required',
  not_required: 'not required',
  unknown: 'requirement unknown',
};

function row(
  key: HealthSubsystemKey,
  unit: Unit,
  state: HealthSubsystemState,
  requirement: ServiceRequirement,
  detail: string | null = null,
  stale = false,
): HealthSubsystemRow {
  const name = NAMES[key];
  const stateWord = UNIT_WORDS[unit][state];
  const requirementClause = REQUIREMENT_WORDS[requirement];
  return {
    key,
    name,
    state,
    stateWord,
    requirement,
    requirementLabel: REQUIREMENT_LABELS[requirement],
    requirementClause,
    detail,
    stale,
    // The same sentence the sibling telemetry bar uses for a retained reading, so
    // a stale row here and a stale chip there read identically.
    announcement: `${name} ${stateWord}${requirementClause}.${stale ? ' This is a previously observed state.' : ''}`,
  };
}

/**
 * `stale` is the caller's read state, not a property of the record: the same
 * snapshot is a current observation when the read confirmed it and a previous one
 * the moment a later read fails.
 */
export function projectHealthSubsystems(status: JarvisStatus | null, stale = false): HealthSubsystems {
  const { backend, requirements } = projectServiceRequirements(status?.active_backend);
  const modelId = nonEmptyString(status?.model);
  // A local model is only ever measured by Ollama. For every other backend
  // Native reports `model_available` as `!is_ollama`, and under the Ollama
  // backend a stopped Ollama means the model was never asked about — so the row
  // is unprobed rather than loaded, or blamed for a server that is not up.
  const modelProbeBlocked = backend !== 'ollama' || status?.ollama_running !== true;
  const modelState: HealthSubsystemState = modelProbeBlocked ? 'unprobed' : flagState(status?.model_available);
  // A model name is only withheld when Ollama was measured down, because that
  // is the one case where naming the model would read as blaming it.
  const modelDetail = backend === 'ollama' && status?.ollama_running === false ? null : modelId;
  const rows: HealthSubsystemRow[] = [
    row('bun', 'process', flagState(status?.bun_server_running), requirements.bun, nonEmptyString(status?.bun_server_url), stale),
    row('bridge', 'process', flagState(status?.bridge_active), requirements.bridge, portDetail(status?.bridge_port), stale),
    row('ollama', 'process', flagState(status?.ollama_running), requirements.ollama, null, stale),
    // A local model is only ever required by the Ollama backend, so it shares
    // that requirement rather than inventing a second opinion about it.
    row('model', 'model', modelState, requirements.ollama, modelDetail, stale),
    row('openrouter_key', 'key', flagState(status?.openrouter_key_set), openrouterKeyRequirement(backend), null, stale),
    row('claude_proxy', 'process', flagState(status?.claude_proxy_running), requirements.proxy, ':19878', stale),
  ];
  return { backend, rows, faults: rows.filter((entry) => entry.state === 'down' && entry.requirement === 'required') };
}

export function subsystemByKey(subsystems: HealthSubsystems, key: HealthSubsystemKey): HealthSubsystemRow | undefined {
  return subsystems.rows.find((entry) => entry.key === key);
}

/**
 * The recovery sentence. It is empty without a confirmed active backend: the
 * required set is unknown there, so no observation can certify recovery.
 */
export function recoverAnnouncement(subsystems: HealthSubsystems): string {
  if (subsystems.backend === 'unknown') return '';
  const unused = subsystems.rows.filter((entry) => entry.requirement === 'not_required').map((entry) => entry.name);
  const suffix = unused.length > 0 ? ` Not required by this backend: ${listNames(unused)}.` : '';
  return `Health recovered: all services required by the active inference backend (${subsystems.backend}) are running.${suffix}`;
}
