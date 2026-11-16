// ═══════════════════════════════════════════════════════════════
// ── backend-readiness — is a chat turn even attemptable?
// ═══════════════════════════════════════════════════════════════
//
// DD-060: Daedalus ships no model and no llama-server binary, so a fresh
// install has blank `llama_cpp.server_path`/`model_path`. The Native surface
// knew that, but only as a boot `eprintln!`, so the shell rendered as if a
// backend existed and the first chat produced an empty transcript.
//
// `get_backend_readiness` carries the Native derivation across IPC. This module
// is the one parser/normalizer for that payload: a surface must stay silent when
// the read fails or the payload is partial, and must never invent a setup
// problem — a fabricated "not configured" state is just as dishonest as the
// silent empty chat it replaces. The same holds in the other direction (DD-067):
// complete settings are not proof that the backend answers, so `not_listening`
// is a state the composer must respect rather than paper over.

export type BackendReadinessState = 'ready' | 'missing_config' | 'not_listening';

/** One blank setting that stops the active Inference backend from answering. */
export interface MissingSetting {
  /** Canonical settings key, e.g. `llama_cpp.server_path`. */
  key: string;
  /** How Settings labels the same field. */
  label: string;
  /** Environment variable that also satisfies the field, when one exists. */
  envVar: string | null;
}

export interface BackendReadiness {
  state: BackendReadinessState;
  /** The backend the derivation ran for (`llama_cpp`, `openrouter`, …). */
  backend: string;
  /** The blank settings — empty for every state except `missing_config`. */
  missing: MissingSetting[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function parseMissingSetting(raw: unknown): MissingSetting | null {
  if (!isRecord(raw)) return null;
  const key = nonBlankString(raw.key);
  if (!key) return null;
  return {
    key,
    label: nonBlankString(raw.label) ?? key,
    envVar: nonBlankString(raw.env_var),
  };
}

/**
 * Parse `get_backend_readiness`. Returns `null` for an unreadable payload so
 * callers can render nothing rather than guess.
 */
export function parseBackendReadiness(value: unknown): BackendReadiness | null {
  if (!isRecord(value)) return null;
  const state = value.state;
  if (state !== 'ready' && state !== 'missing_config' && state !== 'not_listening') return null;

  const missing: MissingSetting[] = [];
  if (Array.isArray(value.missing)) {
    for (const raw of value.missing) {
      const parsed = parseMissingSetting(raw);
      if (parsed) missing.push(parsed);
    }
  }

  return {
    state,
    backend: nonBlankString(value.backend) ?? '',
    missing,
  };
}

/** True when the derivation is usable and names at least one blank setting. */
export function needsBackendSetup(
  readiness: BackendReadiness | null,
): readiness is BackendReadiness {
  return Boolean(readiness && readiness.state === 'missing_config' && readiness.missing.length > 0);
}

/**
 * True when the settings are complete but nothing answers the backend's port
 * (DD-067): the local server may still be starting, or it has stopped. Unlike
 * {@link needsBackendSetup} there is no blank field to name, but a turn sent now
 * would still fail, so the composer must not offer Send.
 */
export function backendNotListening(readiness: BackendReadiness | null): boolean {
  return Boolean(readiness && readiness.state === 'not_listening');
}

/**
 * How a missing setting is named in prose: the Settings label, plus the
 * environment variable that also satisfies it when one exists.
 */
export function missingSettingText(setting: MissingSetting): string {
  return setting.envVar ? `${setting.label} (or ${setting.envVar})` : setting.label;
}

/** "a", "a and b", "a, b and c" — the setup state's list of missing fields. */
export function joinMissingSettings(missing: MissingSetting[]): string {
  const names = missing.map(missingSettingText);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
