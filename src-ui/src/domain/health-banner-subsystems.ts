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

export type HealthSubsystemKey = 'bun' | 'bridge' | 'ollama' | 'llama_cpp' | 'model' | 'openrouter_key' | 'claude_proxy';

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
  llama_cpp: 'Gemma llama.cpp server',
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
    announcement: `${name} ${stateWord}${requirementClause}.`,
  };
}

export function projectHealthSubsystems(status: JarvisStatus | null): HealthSubsystems {
  const { backend, requirements } = projectServiceRequirements(status?.active_backend);
  const modelId = nonEmptyString(status?.model);
  // A local model is only ever measured by Ollama. For every other backend
  // Native reports `model_available` as `!is_ollama`, and under the Ollama
  // backend a stopped Ollama means the model was never asked about — so the row
  // is unprobed rather than loaded, or blamed for a server that is not up.
  const localBackend = backend === 'ollama' || backend === 'llama_cpp';
  const localServerRunning = backend === 'llama_cpp' ? status?.llama_cpp_running : status?.ollama_running;
  const modelProbeBlocked = !localBackend || localServerRunning !== true;
  const modelState: HealthSubsystemState = modelProbeBlocked ? 'unprobed' : flagState(status?.model_available);
  // A model name is only withheld when Ollama was measured down, because that
  // is the one case where naming the model would read as blaming it.
  const modelDetail = localBackend && localServerRunning === false ? null : modelId;
  const ollamaRequirement = backend === 'llama_cpp' ? 'not_required' : requirements.ollama;
  const gemmaRequirement: ServiceRequirement = backend === 'unknown' ? 'unknown' : backend === 'llama_cpp' ? 'required' : 'not_required';
  const rows: HealthSubsystemRow[] = [
    row('bun', 'process', flagState(status?.bun_server_running), requirements.bun, nonEmptyString(status?.bun_server_url)),
    row('bridge', 'process', flagState(status?.bridge_active), requirements.bridge, portDetail(status?.bridge_port)),
    row('ollama', 'process', flagState(status?.ollama_running), ollamaRequirement),
    row('llama_cpp', 'process', flagState(status?.llama_cpp_running), gemmaRequirement, ':8080'),
    // A local model is only ever required by the Ollama backend, so it shares
    // that requirement rather than inventing a second opinion about it.
    row('model', 'model', modelState, localBackend ? 'required' : requirements.ollama, modelDetail),
    row('openrouter_key', 'key', flagState(status?.openrouter_key_set), openrouterKeyRequirement(backend)),
    row('claude_proxy', 'process', flagState(status?.claude_proxy_running), requirements.proxy, ':19878'),
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
