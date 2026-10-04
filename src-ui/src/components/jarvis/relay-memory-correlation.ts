// ─── Relay memory-turn correlation ──────────────────────────────────────────
// Phase 2.4. The native `jarvis_send_message` relay runs asynchronously and
// emits `jarvis://memory-status` / `jarvis://memory-diagnostic` / terminal
// events carrying a caller-supplied `turn_id`. Those events cannot establish
// their own owning submission identity (a delayed older event would otherwise
// bind a newer submission), so the UI accepts relay memory metadata ONLY when
// the event's exact `{session_id, turn_id}` was registered by the owning
// submission BEFORE it invoked the relay.
//
// This module is the concrete correlation seam: the relay invoker calls
// `registerRelayMemoryTurn(sessionId, turnId)` before invoking
// `jarvis_send_message` with that same `turn_id`; the UI calls
// `isRegisteredRelayMemoryTurn(event.session_id, event.turn_id)` before
// accepting any relay memory metadata. Registering a new turn replaces the
// previous one, and `clearRelayMemoryTurn()` is called on every new submission
// and Session change, so a delayed older event can never bind a newer turn.
//
// Native still prepares the turn against its own saved row; a client-supplied
// turn id is never trusted as memory authority.

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
