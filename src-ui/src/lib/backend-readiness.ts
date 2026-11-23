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
// is a state the composer must respect rather than paper over. DD-111 adds a
// third fault: a configured path that is not a file (`missing_file`), which
// names the path so the composer and the health band cannot describe it as a
// backend that may still be starting.

import { backendDisplayName } from './backend-identity';

export type BackendReadinessState =
  | 'ready'
  | 'missing_config'
  | 'missing_file'
  | 'not_listening';

/** One setting (or program) that stops the active Inference backend from answering. */
export interface MissingSetting {
  /** Canonical settings key, e.g. `llama_cpp.server_path`. */
  key: string;
  /** How Settings labels the same field. */
  label: string;
  /** Environment variable that also satisfies the field, when one exists. */
  envVar: string | null;
  /**
   * DD-115: the item's own sentence when the field is not merely blank — the
   * program the backend resolves itself is absent or cannot run. It names the
   * program, so surfaces print it verbatim instead of "missing ollama".
   */
  reason: string | null;
  /**
   * DD-111: the configured artifact path that is not a file. A blank setting
   * has none; an unusable one names the exact path, so every surface prints the
   * same one.
   */
  path: string | null;
}

export interface BackendReadiness {
  state: BackendReadinessState;
  /** The backend the derivation ran for (`llama_cpp`, `openrouter`, …). */
  backend: string;
  /**
   * The missing settings or programs — empty for every state except
   * `missing_config` and `missing_file`.
   */
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
    reason: nonBlankString(raw.reason),
    path: nonBlankString(raw.path),
  };
}

/**
 * Parse `get_backend_readiness`. Returns `null` for an unreadable payload so
 * callers can render nothing rather than guess.
 */
export function parseBackendReadiness(value: unknown): BackendReadiness | null {
  if (!isRecord(value)) return null;
  const state = value.state;
  if (
    state !== 'ready' &&
    state !== 'missing_config' &&
    state !== 'missing_file' &&
    state !== 'not_listening'
  ) {
    return null;
  }

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

/** True when the derivation is usable and names at least one missing item. */
export function needsBackendSetup(
  readiness: BackendReadiness | null,
): readiness is BackendReadiness {
  return Boolean(
    readiness &&
      (readiness.state === 'missing_config' || readiness.state === 'missing_file') &&
      readiness.missing.length > 0,
  );
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
 * How a missing item is named in prose: the item's own sentence when Native
 * supplied one (DD-115, a program that was not found or cannot run), the
 * setting plus the exact path that is not a file (DD-111), otherwise the
 * Settings label plus the environment variable that also satisfies it.
 */
export function missingSettingText(setting: MissingSetting): string {
  if (setting.reason) return setting.reason;
  if (setting.path) {
    return `${setting.label} points to ${setting.path}, which is not a file`;
  }
  return setting.envVar ? `${setting.label} (or ${setting.envVar})` : setting.label;
}

/** True when an item speaks in its own sentence rather than a field name. */
export function hasOwnSentence(missing: MissingSetting[]): boolean {
  return missing.some((setting) => Boolean(setting.reason || setting.path));
}

/** "a", "a and b", "a, b and c" — the setup state's list of missing items. */
export function joinMissingSettings(missing: MissingSetting[]): string {
  const names = missing.map(missingSettingText);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The composer's disabled reason, derived from Native readiness so one place
 * decides it for every session surface.
 *
 * A program item already reads as a sentence ("ollama was not found — install
 * Ollama, add it to PATH, or set JARVIS_OLLAMA_BIN"), and so does an unusable
 * artifact ("llama.cpp server_path points to …, which is not a file"), so both
 * are printed as-is; folding them into "X is missing …" would produce "Ollama
 * is missing ollama was not found".
 */
export function backendBlockedReason(readiness: BackendReadiness | null): string | null {
  // Returned before the predicate below: its false branch removes
  // BackendReadiness from the union, so a later `readiness.state` read would be
  // typed `never` (the reviewer's compile fix; tsc -b is the check that fails
  // if this guard is removed).
  if (readiness === null) return null;
  // The state is read directly here: `needsBackendSetup` is a predicate whose
  // false branch would narrow `readiness` to `never`, making the port branch
  // below uncompilable (reviewer's compile fix; `tsc -b` is what catches a
  // regression).
  if (
    (readiness.state === 'missing_config' || readiness.state === 'missing_file') &&
    readiness.missing.length > 0
  ) {
    const missing = joinMissingSettings(readiness.missing);
    return hasOwnSentence(readiness.missing)
      ? `${missing}. Set it in Settings to chat.`
      : `${backendDisplayName(readiness.backend)} is missing ${missing}. Set it in Settings to chat.`;
  }
  if (readiness.state === 'not_listening') {
    return `${backendDisplayName(readiness.backend)} is configured, but nothing is answering its port yet — it may still be starting.`;
  }
  return null;
}
