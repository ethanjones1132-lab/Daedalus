// ─── Relay memory-turn correlation ──────────────────────────────────────────
// Phase 2.4. The native `jarvis_send_message` relay runs asynchronously and
// emits `jarvis://memory-status` / `jarvis://memory-diagnostic` / terminal
// events carrying a caller-supplied `turn_id`. Those events cannot establish
// their own owning submission identity (a delayed older event would otherwise
// bind a newer submission), so the UI accepts relay memory metadata ONLY when
// the event's exact `{session_id, turn_id}` was registered by the owning
// submission BEFORE it invoked the relay.
//
// `submitRelayMemoryTurn` is the executable register-before-invoke adapter:
// it mints a UUID, registers the exact nonempty Session/turn, then invokes the
// native `jarvis_send_message` with that same `turn_id`. Callers no longer have
// to manually sequence two unrelated APIs. On invocation failure it clears ONLY
// its own still-current registration (a newer registration is left intact) and
// rethrows. The native relay still prepares the turn against its own persisted
// row; a caller-supplied turn id is never trusted as memory authority.
//
// The direct SSE transport remains the UI default; this adapter is a narrow,
// opt-in relay submission helper and is not a transport chooser.

import { invoke } from '@tauri-apps/api/core';

export interface RelayMemoryRegistration {
  sessionId: string;
  turnId: string;
}

let activeRegistration: RelayMemoryRegistration | null = null;

export function registerRelayMemoryTurn(sessionId: string, turnId: string): void {
  activeRegistration = { sessionId, turnId };
}

export function clearRelayMemoryTurn(): void {
  activeRegistration = null;
}

export function isRegisteredRelayMemoryTurn(sessionId: unknown, turnId: unknown): boolean {
  return (
    activeRegistration !== null
    && typeof sessionId === 'string'
    && typeof turnId === 'string'
    && activeRegistration.sessionId === sessionId
    && activeRegistration.turnId === turnId
  );
}

export function activeRelayMemoryTurn(): RelayMemoryRegistration | null {
  return activeRegistration;
}

/**
 * Submit one memory-correlated relay turn. Mints a stable turn id, registers
 * the exact nonempty `{sessionId, turnId}` correlation BEFORE invoking the
 * native relay with that id, and returns the tuple so the caller can display
 * or clear it. A rejected invocation clears only this submission's still-current
 * registration (never a newer one) and rethrows.
 */
export async function submitRelayMemoryTurn(
  sessionId: string,
  message: string,
): Promise<RelayMemoryRegistration> {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new Error('A persisted Session is required for a relay memory turn.');
  }
  const turnId = crypto.randomUUID();
  registerRelayMemoryTurn(sessionId, turnId);
  try {
    // Both spellings are sent for compatibility with the existing native
    // command argument conventions (see `sessionInvokeArgs`).
    await invoke('jarvis_send_message', {
      sessionId,
      session_id: sessionId,
      message,
      turnId,
      turn_id: turnId,
    });
  } catch (error) {
    const current = activeRegistration;
    if (current && current.sessionId === sessionId && current.turnId === turnId) {
      clearRelayMemoryTurn();
    }
    throw error;
  }
  return { sessionId, turnId };
}
