import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HERMES_START_FAILED_REASON,
  HERMES_STOP_FAILED_REASON,
  HERMES_TURN_FAILED,
  HERMES_UNAVAILABLE_REASON,
  isHermesTurnEventForSession,
  normalizeHermesState,
  type HermesLifecycleState,
} from './hermes-state';

export type HermesState = HermesLifecycleState;

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
  streaming?: boolean;
  error?: string;
  cancelled?: boolean;
}

export interface HermesInvokeArgs {
  method: string;
  params?: Record<string, unknown>;
  timeout_ms?: number;
}

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

export interface UseHermesChat {
  messages: HermesMessage[];
  isStreaming: boolean;
  isReady: boolean;
  isStarting: boolean;
  isStopping: boolean;
  interruptError: string | null;
  state: HermesState;
  reason: string | null;
  submit: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  retry: () => Promise<void>;
  clear: () => void;
}

type TurnOutcome = 'complete' | 'error' | 'stopped';

export function useHermesChat(sessionId: string): UseHermesChat {
  const [messages, setMessages] = useState<HermesMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [interruptError, setInterruptError] = useState<string | null>(null);
  const [state, setState] = useState<HermesState>('cold');
  const [reason, setReason] = useState<string | null>(null);
  const stateRef = useRef<HermesState>('cold');
  const mountedRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  const previousSessionRef = useRef(sessionId);
  const assistantIdRef = useRef<string | null>(null);
  const turnSessionIdRef = useRef<string | null>(null);
  const isStreamingRef = useRef(false);
  const sendPendingRef = useRef(false);
  const startPendingRef = useRef(false);
  const retryPendingRef = useRef(false);
  const stopPendingRef = useRef(false);
  const subscriptionRef = useRef<UnlistenFn | null>(null);
  const subscriptionPromiseRef = useRef<Promise<boolean> | null>(null);
  const lifecycleEventVersionRef = useRef(0);
  const messageIdRef = useRef(0);
  sessionIdRef.current = sessionId;

  const setLifecycle = useCallback((next: HermesState, nextReason: string | null = null) => {
    stateRef.current = next;
    setState(next);
    setReason(nextReason);
  }, []);

  const markUnavailable = useCallback((nextReason = HERMES_UNAVAILABLE_REASON) => {
    setLifecycle('unavailable', nextReason);
  }, [setLifecycle]);

  const settleActiveTurn = useCallback((outcome: TurnOutcome) => {
    const id = assistantIdRef.current;
    isStreamingRef.current = false;
    setIsStreaming(false);
    assistantIdRef.current = null;
    turnSessionIdRef.current = null;
    if (!id) return;
    setMessages((prev) => prev.map((message) => {
      if (message.id !== id) return message;
      const next = { ...message, streaming: false };
      if (outcome === 'error') next.error = HERMES_TURN_FAILED;
      if (outcome === 'stopped') next.cancelled = true;
      return next;
    }));
  }, []);

  const handleHermesEvent = useCallback((ev: HermesEvent) => {
    if (ev.type === 'gateway.ready') {
      lifecycleEventVersionRef.current += 1;
      setLifecycle('ready');
      return;
    }
    if (ev.type === 'gateway.crashed') {
      lifecycleEventVersionRef.current += 1;
      markUnavailable();
      settleActiveTurn('error');
      return;
    }
    if (ev.type === 'gateway.draining') {
      lifecycleEventVersionRef.current += 1;
      setLifecycle('draining');
      return;
    }

    if (!isHermesTurnEventForSession(ev.session_id, sessionIdRef.current, turnSessionIdRef.current)) {
      return;
    }

    if (ev.type === 'stream.token' || ev.type === 'message.delta') {
      const params = ev.params as { text?: string; delta?: string };
      const text = params.text ?? params.delta ?? '';
      const id = assistantIdRef.current;
      if (!text || !id) return;
      setMessages((prev) => prev.map((message) => (
        message.id === id ? { ...message, content: message.content + text } : message
      )));
      return;
    }

    if (ev.type === 'stream.done' || ev.type === 'message.complete') {
      settleActiveTurn('complete');
      return;
    }

    if (ev.type === 'stream.error' || ev.type === 'message.error') {
      settleActiveTurn('error');
    }
  }, [markUnavailable, setLifecycle, settleActiveTurn]);

  const ensureSubscription = useCallback(async () => {
    if (subscriptionRef.current) return true;
    if (subscriptionPromiseRef.current) return subscriptionPromiseRef.current;
    const pending = (async () => {
      try {
        const unlisten = await subscribeHermesEvents(handleHermesEvent);
        if (!mountedRef.current) {
          unlisten();
          return false;
        }
        subscriptionRef.current = unlisten;
        return true;
      } catch {
        markUnavailable();
        return false;
      }
    })();
    subscriptionPromiseRef.current = pending;
    try {
      return await pending;
    } finally {
      if (subscriptionPromiseRef.current === pending) subscriptionPromiseRef.current = null;
    }
  }, [handleHermesEvent, markUnavailable]);

  const startBridge = useCallback(async () => {
    if (startPendingRef.current || isStreamingRef.current) return;
    startPendingRef.current = true;
    setIsStarting(true);
    setInterruptError(null);
    setLifecycle('starting');
    const eventVersion = lifecycleEventVersionRef.current;
    try {
      const next = await hermesSpawn();
      if (!mountedRef.current) return;
      if (eventVersion !== lifecycleEventVersionRef.current && stateRef.current === 'ready') return;
      const normalized = normalizeHermesState(next.state);
      if (normalized === 'ready') setLifecycle('ready');
      else if (normalized === 'starting') setLifecycle('starting');
      else markUnavailable(HERMES_START_FAILED_REASON);
    } catch {
      if (mountedRef.current) markUnavailable(HERMES_START_FAILED_REASON);
    } finally {
      startPendingRef.current = false;
      if (mountedRef.current) setIsStarting(false);
    }
  }, [markUnavailable, setLifecycle]);

  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;
    const run = async () => {
      const subscribed = await ensureSubscription();
      if (disposed || !subscribed) return;
      const eventVersion = lifecycleEventVersionRef.current;
      try {
        const next = await hermesStatus();
        if (disposed || eventVersion !== lifecycleEventVersionRef.current) return;
        const normalized = normalizeHermesState(next.state);
        if (normalized === 'unavailable') markUnavailable();
        else setLifecycle(normalized);
        if (normalized === 'cold') await startBridge();
      } catch {
        if (!disposed) markUnavailable();
      }
    };
    void run();
    return () => {
      disposed = true;
      mountedRef.current = false;
      const unlisten = subscriptionRef.current;
      subscriptionRef.current = null;
      if (unlisten) {
        try { unlisten(); } catch {}
      }
    };
  }, [ensureSubscription, markUnavailable, setLifecycle, startBridge]);

  useEffect(() => {
    const previous = previousSessionRef.current;
    previousSessionRef.current = sessionId;
    if (previous !== sessionId) {
      settleActiveTurn('stopped');
    }
  }, [sessionId, settleActiveTurn]);

  const retry = useCallback(async () => {
    if (retryPendingRef.current || isStreamingRef.current) return;
    retryPendingRef.current = true;
    setIsStarting(true);
    try {
      const subscribed = await ensureSubscription();
      if (subscribed) await startBridge();
    } finally {
      retryPendingRef.current = false;
      if (mountedRef.current && !startPendingRef.current) setIsStarting(false);
    }
  }, [ensureSubscription, startBridge]);

  const submit = useCallback(async (text: string) => {
    const trimmed = text.trim();
    const activeSession = sessionIdRef.current;
    if (!trimmed || !activeSession || sendPendingRef.current || isStreamingRef.current || stateRef.current !== 'ready') return;
    sendPendingRef.current = true;
    isStreamingRef.current = true;
    setIsStreaming(true);
    setInterruptError(null);
    const now = Date.now();
    const suffix = messageIdRef.current++;
    const userMessage: HermesMessage = {
      id: `u-${now}-${suffix}`,
      role: 'user',
      content: trimmed,
      createdAt: now,
    };
    const assistantId = `a-${now}-${suffix}`;
    assistantIdRef.current = assistantId;
    turnSessionIdRef.current = activeSession;
    const assistantMessage: HermesMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: now,
      streaming: true,
    };
    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    try {
      await hermesInvoke({
        method: 'prompt.submit',
        params: { text: trimmed, session_id: activeSession },
        timeout_ms: 300_000,
      });
    } catch {
      if (mountedRef.current) settleActiveTurn('error');
    } finally {
      sendPendingRef.current = false;
    }
  }, [settleActiveTurn]);

  const interrupt = useCallback(async () => {
    if (!isStreamingRef.current || stopPendingRef.current) return;
    stopPendingRef.current = true;
    setIsStopping(true);
    setInterruptError(null);
    const assistantId = assistantIdRef.current;
    try {
      const next = await hermesInterrupt();
      if (!mountedRef.current) return;
      if (assistantId && assistantIdRef.current === assistantId) settleActiveTurn('stopped');
      const normalized = normalizeHermesState(next.state);
      if (normalized === 'ready') setLifecycle('ready');
      else markUnavailable();
    } catch {
      if (mountedRef.current) setInterruptError(HERMES_STOP_FAILED_REASON);
    } finally {
      stopPendingRef.current = false;
      if (mountedRef.current) setIsStopping(false);
    }
  }, [markUnavailable, setLifecycle, settleActiveTurn]);

  const clear = useCallback(() => {
    if (isStreamingRef.current) return;
    setMessages([]);
    assistantIdRef.current = null;
    turnSessionIdRef.current = null;
  }, []);

  return {
    messages,
    isStreaming,
    isReady: state === 'ready',
    isStarting,
    isStopping,
    interruptError,
    state,
    reason,
    submit,
    interrupt,
    retry,
    clear,
  };
}
