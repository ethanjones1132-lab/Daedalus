import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';

// ── Types ──────────────────────────────────────────────────────

export type HermesState = 'cold' | 'starting' | 'ready' | 'draining' | 'crashed';

export interface HermesStatus {
  state: HermesState;
  reason?: string | null;
}

export interface HermesEvent {
  type: string;
  session_id: string | null;
  params: Record<string, unknown>;
}

export interface HermesMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  /** true while a token stream is still arriving for this message */
  streaming?: boolean;
  /** optional error attached to a failed message */
  error?: string;
}

export interface HermesInvokeArgs {
  method: string;
  params?: Record<string, unknown>;
  /** Long-running methods can opt out of the default per-request timeout. */
  timeout_ms?: number;
}

// ── Long-running method manifest ─────────────────────────────
//
// Hard-coded rather than fetched from a manifest at runtime. The CI
// invariant `src-tauri/tests/hermes_protocol_manifest.rs` keeps this
// list in sync with the YAML side.
//
// When the user fires one of these methods we don't try to cancel
// the previous one — we let it run to completion and the caller
// surfaces a "still running" hint instead.
const LONG_METHODS = new Set([
  'session.resume', 'session.compress', 'session.steer',
  'prompt.submit', 'prompt.background',
  'reload.mcp', 'cli.exec', 'command.dispatch', 'slash.exec',
  'voice.record', 'voice.tts', 'browser.manage',
  'skills.reload', 'shell.exec',
]);

export function isLongRunning(method: string): boolean {
  return LONG_METHODS.has(method);
}

// ── Low-level command surface ────────────────────────────────

export async function hermesStatus(): Promise<HermesStatus> {
  return invoke<HermesStatus>('hermes_status');
}

export async function hermesSpawn(): Promise<HermesStatus> {
  return invoke<HermesStatus>('hermes_spawn');
}

export async function hermesShutdown(): Promise<HermesStatus> {
  return invoke<HermesStatus>('hermes_shutdown');
}

export async function hermesRestart(): Promise<HermesStatus> {
  return invoke<HermesStatus>('hermes_restart');
}

export async function hermesInterrupt(): Promise<HermesStatus> {
  return invoke<HermesStatus>('hermes_interrupt');
}

export async function hermesInvoke<T = unknown>(args: HermesInvokeArgs): Promise<T> {
  return invoke<T>('hermes_invoke', { args });
}

// ── Event stream ─────────────────────────────────────────────

/**
 * Subscribe to the typed Hermes event stream. The Tauri backend emits
 * events under the channel name `hermes-event`. We unwrap the envelope
 * here so the rest of the app sees a clean `HermesEvent`.
 *
 * Returns an unlisten function — call it from a useEffect cleanup.
 */
export async function subscribeHermesEvents(
  handler: (ev: HermesEvent) => void,
): Promise<UnlistenFn> {
  return listen<{
    type: string;
    session_id: string | null;
    params: Record<string, unknown>;
  }>('hermes-event', (event) => {
    const p = event.payload;
    handler({
      type: p.type,
      session_id: p.session_id,
      params: p.params ?? {},
    });
  });
}

// ── React hook ───────────────────────────────────────────────

export interface UseHermesChat {
  messages: HermesMessage[];
  isStreaming: boolean;
  isReady: boolean;
  state: HermesState;
  reason: string | null;
  submit: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  clear: () => void;
}

/**
 * React hook that wires the Hermes bridge into a chat-style
 * conversation. The `submit` function fires a `prompt.submit` JSON-RPC
 * call; token deltas arrive on the event stream and are appended to
 * the assistant message as they come in.
 *
 * If the bridge is `cold` when `submit` is called we attempt a
 * transparent `hermes_spawn` and retry once.
 */
export function useHermesChat(sessionId: string): UseHermesChat {
  const [messages, setMessages] = useState<HermesMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [state, setState] = useState<HermesState>('cold');
  const [reason, setReason] = useState<string | null>(null);
  const assistantIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Initial status + subscribe to events
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    (async () => {
      try {
        const status = await hermesStatus();
        if (cancelled) return;
        setState(status.state);
        setReason(status.reason ?? null);
      } catch (e) {
        // Status probe is best-effort. The chat will surface a clear
        // error on first submit if the bridge is genuinely down.
        if (cancelled) return;
        setReason(String(e));
      }

      try {
        unlisten = await subscribeHermesEvents((ev) => {
          if (ev.session_id && ev.session_id !== sessionIdRef.current) return;
          handleHermesEvent(ev);
        });
      } catch (e) {
        if (!cancelled) setReason(String(e));
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) {
        try { unlisten(); } catch { /* swallow */ }
      }
    };
  }, []);

  const handleHermesEvent = useCallback((ev: HermesEvent) => {
    // State transitions from the bridge itself
    if (ev.type === 'gateway.ready') {
      setState('ready');
      setReason(null);
      return;
    }
    if (ev.type === 'gateway.crashed') {
      setState('crashed');
      setReason(String((ev.params as { reason?: string })?.reason ?? 'unknown'));
      return;
    }
    if (ev.type === 'gateway.draining') {
      setState('draining');
      return;
    }

    // Token / content deltas for the active assistant message
    if (ev.type === 'stream.token' || ev.type === 'message.delta') {
      const text = (ev.params as { text?: string; delta?: string })?.text
        ?? (ev.params as { text?: string; delta?: string })?.delta
        ?? '';
      if (!text) return;
      setMessages((prev) => {
        const id = assistantIdRef.current;
        if (!id) return prev;
        return prev.map((m) =>
          m.id === id ? { ...m, content: m.content + text } : m,
        );
      });
      return;
    }

    if (ev.type === 'stream.done' || ev.type === 'message.complete') {
      setIsStreaming(false);
      const id = assistantIdRef.current;
      assistantIdRef.current = null;
      if (id) {
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, streaming: false } : m)),
        );
      }
      return;
    }

    if (ev.type === 'stream.error' || ev.type === 'message.error') {
      const err = (ev.params as { error?: string; message?: string })?.error
        ?? (ev.params as { error?: string; message?: string })?.message
        ?? 'unknown error';
      setMessages((prev) => {
        const id = assistantIdRef.current;
        if (!id) {
          return [
            ...prev,
            {
              id: `${Date.now()}-err`,
              role: 'system',
              content: `Error: ${err}`,
              createdAt: Date.now(),
              error: err,
            },
          ];
        }
        return prev.map((m) =>
          m.id === id ? { ...m, error: err, streaming: false } : m,
        );
      });
      setIsStreaming(false);
      assistantIdRef.current = null;
      return;
    }
  }, []);

  const submit = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (isStreaming) return; // The user must wait or interrupt.

    // Make sure the bridge is up. If it's cold, try to spawn it once.
    if (state === 'cold') {
      try {
        await hermesSpawn();
        setState('starting');
      } catch (e) {
        setState('crashed');
        setReason(String(e));
        setMessages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-err`,
            role: 'system',
            content: `Bridge spawn failed: ${e}`,
            createdAt: Date.now(),
            error: String(e),
          },
        ]);
        return;
      }
    }

    const userMsg: HermesMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: trimmed,
      createdAt: Date.now(),
    };
    const assistantId = `a-${Date.now()}`;
    assistantIdRef.current = assistantId;
    const assistantMsg: HermesMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      streaming: true,
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setIsStreaming(true);

    try {
      await hermesInvoke({
        method: 'prompt.submit',
        params: { text: trimmed, session_id: sessionIdRef.current },
        timeout_ms: 300_000,
      });
    } catch (e) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, error: String(e), streaming: false } : m,
        ),
      );
      setIsStreaming(false);
      assistantIdRef.current = null;
    }
  }, [isStreaming, state]);

  const interrupt = useCallback(async () => {
    if (!isStreaming) return;
    try {
      await hermesInterrupt();
    } catch (e) {
      setReason(String(e));
    }
  }, [isStreaming]);

  const clear = useCallback(() => {
    if (isStreaming) return;
    setMessages([]);
    assistantIdRef.current = null;
  }, [isStreaming]);

  return {
    messages,
    isStreaming,
    isReady: state === 'ready',
    state,
    reason,
    submit,
    interrupt,
    clear,
  };
}
