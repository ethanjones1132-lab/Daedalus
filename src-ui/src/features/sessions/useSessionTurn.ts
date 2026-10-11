/*
 * useSessionTurn — the Session turn controller.
 *
 * This is the legacy ChatPanel logic (components/jarvis/JarvisView.tsx),
 * MOVED rather than rewritten: the SSE streaming pipeline, rAF token
 * coalescing, terminal-frame classification, the durable run record, tool
 * approvals, per-Session drafts, history loading and scroll pinning all keep
 * their original fencing (SendGate, SendInFlightGuard, request identity,
 * mounted/abort guards). Only presentation moved out, into the components
 * under ./ that render what this hook returns.
 */
import { useState, useEffect, useRef, useCallback, useLayoutEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import type { JarvisSession, JarvisMessage, JarvisConfig } from '../../domain/types';
import { sessionScroll } from '../../domain/session-scroll';
import {
  clearSubmittedSessionDraft,
  createSessionDraftStore,
  getSessionDraft,
  getSessionDraftSnapshot,
  restoreFailedSessionDraft,
  updateSessionDraft,
  type SessionDraftStore,
} from '../../domain/session-draft-state';
import {
  createUnknownFrameReporter,
  InactivityWatchdog,
  isTerminalStageStatus,
  isPassiveSseFrame,
  parseSseDataLine,
  readToolResultTruncation,
} from '../../domain/sse-protocol';
import {
  SendGate,
  SendInFlightGuard,
  appendAgentProgress,
  buildActivityFeed,
  buildTurnProgress,
  dedupeMessages,
  finalizeStreamingMessages,
  formatFallbackProgress,
  formatInferenceRoute,
  mergeToolResult,
  sanitizeAssistantDisplay,
  shouldSubmitComposerKey,
  type ActivityItem,
  type ToolCallState,
} from '../../domain/chat-state';
import {
  activityLedgerItems,
  createActivityLedger,
  decodeConductorDirectiveFrame,
  reduceActivityLedger,
  type ActivityLedgerEvent,
  type ActivityLedgerState,
} from '../../domain/activity-ledger';
import {
  acceptFirstTerminal,
  boundedPartialOutput,
  classifyStreamTermination,
  decodeResultFrame,
  STREAM_INCOMPLETE_CODE,
  STREAM_INCOMPLETE_MESSAGE,
  STREAM_TIMEOUT_CODES,
  type DecodedStreamTerminal,
  type StreamTerminalFrame,
  type StreamTerminalOutcome,
} from '../../domain/stream-lifecycle';
import {
  decideRunRecord,
  runRecordView,
  type RunRecordIntent,
  type RunRecordState,
  type SessionRunRead,
  type SessionRunWrite,
} from '../../domain/session-run-telemetry';

export type ToolApprovalRequest = {
  call_id: string;
  name: string;
  arguments: unknown;
  session_id: string;
};

const sameToolApproval = (left: ToolApprovalRequest | null, right: ToolApprovalRequest | null) =>
  left?.call_id === right?.call_id && left?.session_id === right?.session_id;

export const sessionInvokeArgs = (sessionId: string) => ({
  sessionId,
  session_id: sessionId,
});

// ── Durable run record (Task 4.1) ────────────────────────────────────
// `record_terminal_run` is Native's only writer for `session_runs` and
// `get_session_runs` its per-Session read. A turn's terminal frame used to be
// reported fire-and-forget, so a write Native rejected left the Session
// reading as one that never ran. These two helpers keep the write and the
// read-back on the existing command surface and report nothing but success or
// failure: native error text never leaves this boundary.

/** One terminal run, addressed by the Session it belongs to. */
export interface RunRecordPayload extends RunRecordIntent {
  selectedModel: string | null;
  tokenCount: number;
  toolCount: number;
  cancelledReason: string | null;
  partialOutput: string | null;
}

const recordTerminalRun = (payload: RunRecordPayload): Promise<SessionRunWrite> =>
  invoke('record_terminal_run', {
    ...sessionInvokeArgs(payload.sessionId),
    runId: payload.runId,
    outcome: payload.outcome,
    selectedModel: payload.selectedModel,
    tokenCount: payload.tokenCount,
    toolCount: payload.toolCount,
    cancelledReason: payload.cancelledReason,
    partialOutput: payload.partialOutput,
  }).then(
    () => ({ ok: true }) as SessionRunWrite,
    () => ({ ok: false }) as SessionRunWrite,
  );

const readSessionRunsFor = async (sessionId: string): Promise<SessionRunRead> => {
  try {
    return { ok: true, value: await invoke<unknown>('get_session_runs', sessionInvokeArgs(sessionId)) };
  } catch {
    return { ok: false };
  }
};

export const JARVIS_API_URL = 'http://127.0.0.1:19877';
const STREAM_INACTIVITY_TIMEOUT_MS = 90_000;

// Task 7 Part C (2026-07-03 incident 1d4727cf): the server's structured
// `error` frame carries a `code` (e.g. "first_token_timeout") that
// previously was logged and then discarded — `handleFrame` threw a plain
// `Error`, so by the time `handleSend`'s catch block ran there was no way
// to render a distinct error bubble or show the code as detail. This class
// carries the code through the throw/catch boundary.
class JarvisStreamError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'JarvisStreamError';
    this.code = code;
  }
}

// Helper: a single SSE-stream "SessionHistor§Message" shape, mirroring the
// SessionMessageOut returned by get_session_history.
interface SessionHistoryMessage {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tokens: number;
  tool_calls: string | null;
  created_at: string;
}

// Curated follow-up suggestion chips. The backend doesn't yet emit a per-turn
// recommendation, so we surface a small static set so the surface feels alive.
export const CURATED_SUGGESTIONS: string[] = [
  'Refine the previous answer',
  'Walk me through the reasoning',
  'Suggest next steps',
  'Apply this to my code',
];

export interface SessionTurnProps {
  activeSession: string | null;
  setActiveSession: (id: string | null) => void;
  config: JarvisConfig | null;
  backendLabel: string;
  modelLabel: string;
  onSessionCreated: () => void;
  onRunRecordSettled?: (state: RunRecordState | null) => void;
}

export interface ScopeNotice {
  paths: string[];
  rootListing: boolean;
  shell: string;
  network: string;
}

export interface RunMetrics {
  durationMs: number;
  tokens: number;
  tools: number;
  fallbackRetries: number;
  fallbackReason?: string;
  scopeCompliant?: boolean;
  provider?: string;
  model?: string;
  firstVisibleTokenMs?: number;
}

export function useSessionTurn({
  activeSession, setActiveSession, config, backendLabel, modelLabel, onSessionCreated, onRunRecordSettled,
}: SessionTurnProps) {

  const [messages, setMessages] = useState<JarvisMessage[]>([]);
  const [draftStore, setDraftStore] = useState<SessionDraftStore>(() => createSessionDraftStore());
  const draftStoreRef = useRef<SessionDraftStore>(draftStore);
  const input = getSessionDraft(draftStore, activeSession).text;
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string>('');
  const selectedSessionId = activeSession ?? '';
  const [error, setError] = useState<string | null>(null);
  // Orchestrator pipeline progress: e.g. "planner", "executor", "reviewer"
  const [pipelineStage, setPipelineStage] = useState<string>('');
  // Recursive-critique info: set when recursive topology is in a critique/re-enter cycle
  const [recursionDepth, setRecursionDepth] = useState<number | null>(null);
  // Reasoning/CoT text accumulated while streaming (cleared on done)
  const [reasoningText, setReasoningText] = useState<string>('');
  const [showReasoning, setShowReasoning] = useState(false);
  // Intermediate agent activity per stage (planner/executor/reviewer/rewriter)
  const [agentSteps, setAgentSteps] = useState<{ stage: string; text: string }[]>([]);
  // Legacy "Agents" accordion state: progress now lives in the Activity feed,
  // but the resets below are kept verbatim.
  const [, setShowAgents] = useState(true);

  // Phase 1.1 — pending tool approval surfaced from `jarvis://approval_request`.
  const [pendingApproval, setPendingApproval] = useState<ToolApprovalRequest | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalPending, setApprovalPending] = useState(false);
  const [approvalRetryDecision, setApprovalRetryDecision] = useState<boolean | null>(null);
  const pendingApprovalRef = useRef<ToolApprovalRequest | null>(null);
  const approvalInFlightRef = useRef<{
    callId: string;
    sessionId: string;
    approved: boolean;
  } | null>(null);
  const seenApprovalKeysRef = useRef<Set<string>>(new Set());

  // Phase 3.1 — inline tool-call cards built from `tool_use` / `tool_result`.
  const [toolCalls, setToolCalls] = useState<ToolCallState[]>([]);
  const [activityLedger, setActivityLedger] = useState<ActivityLedgerState>(() => createActivityLedger());
  const dispatchActivity = useCallback((event: ActivityLedgerEvent) => {
    setActivityLedger((current) => reduceActivityLedger(current, event));
  }, []);
  const resetActivityLedger = useCallback(() => {
    setActivityLedger(createActivityLedger());
  }, []);

  // Phase 3.3 — token / cost tally for the current turn.
  const [turnCost, setTurnCost] = useState<{ tokens: number; costUsd: number } | null>(null);
  const [turnElapsedMs, setTurnElapsedMs] = useState(0);
  const turnStartedAtRef = useRef<number | null>(null);
  // Last agent_run_id that we accumulated into `sessionStats`. We use this
  // to make the per-turn accumulation idempotent: the `orchestration_metrics`
  // frame is the natural "turn done" signal, but a re-stream or
  // re-sent metrics frame must not double-count the same turn's tokens in
  // the session pill. Cleared on session switch.
  const lastAccumulatedRunIdRef = useRef<string | undefined>(undefined);
  const [scopeNotice, setScopeNotice] = useState<{
    paths: string[];
    rootListing: boolean;
    shell: string;
    network: string;
  } | null>(null);
  const [runMetrics, setRunMetrics] = useState<{
    durationMs: number;
    tokens: number;
    tools: number;
    fallbackRetries: number;
    fallbackReason?: string;
    scopeCompliant?: boolean;
    provider?: string;
    model?: string;
    firstVisibleTokenMs?: number;
  } | null>(null);

  // Per-session cumulative rollup for the chat header Session Stats pill.
  // Accumulates the `runMetrics.tokens` from every completed turn in the
  // active session; resets to 0 on session switch (`+ New Chat` or session
  // picker) and on every load. The pill is hidden while `turnCount === 0`
  // (no completed turns yet) so a brand-new session doesn't show "0 tok".
  // The completion check is `turnCount` rather than `tokens > 0` so that
  // an extremely cheap turn that round-trips 0 tokens still surfaces the
  // "1 turn" line in the stats pill.
  const [sessionStats, setSessionStats] = useState<{ tokens: number; turnCount: number }>({ tokens: 0, turnCount: 0 });

  // Loading-state for Session history fetch (Phase 2.3).
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [historyRetry, setHistoryRetry] = useState(0);

  // Scroll-aware autoscroll (Phase 2.5). When the user scrolls up we pause
  // automatic anchoring so the chat isn't yanked away mid-read. A floating
  // "jump to latest" button re-engages the anchor.
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [userPinnedToBottom, setUserPinnedToBottom] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Stable refs for values the stream handlers need without re-subscribing
  // listeners mid-turn (see memory/jarvis-tauri-listen-race.md).
  const activeSessionRef = useRef(activeSession);
  const mountedRef = useRef(true);
  const sessionIdRef = useRef(sessionId);
  const onSessionCreatedRef = useRef(onSessionCreated);
  const streamAbortRef = useRef<AbortController | null>(null);
  const sendGateRef = useRef(new SendGate());
  // 2026-07-13 live incident (session 7254c3ae): a rapid second Enter-press
  // bypassed the React-state `isStreaming` guard because setState is
  // async/batched. The server-side ActiveStreamRegistry then silently
  // superseded the in-flight turn. This ref-backed synchronous guard
  // closes the race on the client side; see SendInFlightGuard.
  const sendInFlightRef = useRef(new SendInFlightGuard());
  const stopRequestedRef = useRef(false);
  // Whether any response text frame has landed this Session turn. Ref-backed
  // so the pure `buildTurnProgress` view-model can distinguish "receiving
  // response text" from unverified stage work without a dedicated state
  // waterfall; reset at send, finalize, error, cancel, and session switch.
  const turnHadResponseTextRef = useRef(false);
  const clearPendingApproval = useCallback(() => {
    pendingApprovalRef.current = null;
    setPendingApproval(null);
    setApprovalError(null);
    setApprovalRetryDecision(null);
  }, []);

  const publishDraftStore = useCallback((nextStore: SessionDraftStore) => {
    if (nextStore === draftStoreRef.current) return;
    draftStoreRef.current = nextStore;
    setDraftStore(nextStore);
  }, []);

  const setInput = useCallback((
    next: string | ((current: string) => string),
    sessionId: string | null = activeSession,
  ) => {
    const currentStore = draftStoreRef.current;
    const currentText = getSessionDraft(currentStore, sessionId).text;
    const nextText = typeof next === 'function' ? next(currentText) : next;
    publishDraftStore(updateSessionDraft(currentStore, sessionId, nextText));
  }, [activeSession, publishDraftStore]);

  const presentApprovalRequest = useCallback((request: ToolApprovalRequest | null | undefined) => {
    if (!request || !request.session_id || !request.call_id || !request.name) return false;
    const key = JSON.stringify([request.session_id, request.call_id]);
    if (seenApprovalKeysRef.current.has(key)) return false;
    seenApprovalKeysRef.current.add(key);
    pendingApprovalRef.current = request;
    setPendingApproval(request);
    setApprovalError(null);
    setApprovalRetryDecision(null);
    setApprovalPending(approvalInFlightRef.current !== null);
    return true;
  }, []);

  useLayoutEffect(() => { activeSessionRef.current = activeSession; }, [activeSession]);
  useEffect(() => {
    if (!isStreaming || turnStartedAtRef.current === null) return;
    const tick = () => setTurnElapsedMs(Date.now() - (turnStartedAtRef.current ?? Date.now()));
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [isStreaming]);
  useLayoutEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { onSessionCreatedRef.current = onSessionCreated; }, [onSessionCreated]);
  useEffect(() => { onRunRecordSettledRef.current = onRunRecordSettled; }, [onRunRecordSettled]);

  // ── Durable run record ────────────────────────────────────────────
  // A terminal frame is the UI's observation, not a durable record. The
  // record only exists once Native's read-back reports this `run_id` for this
  // Session, so every state below is derived from the write plus that
  // read-back (`decideRunRecord`) and is published to the owner so the
  // Session list can mark an unconfirmed run.
  const [runRecord, setRunRecord] = useState<RunRecordState | null>(null);
  const runRecordRef = useRef<RunRecordState | null>(null);
  const runRecordPayload = useRef<RunRecordPayload | null>(null);
  const runRecordToken = useRef(0);
  const onRunRecordSettledRef = useRef(onRunRecordSettled);

  const publishRunRecord = useCallback((next: RunRecordState | null) => {
    runRecordRef.current = next;
    if (mountedRef.current) setRunRecord(next);
    onRunRecordSettledRef.current?.(next);
  }, []);

  const confirmRunRecord = useCallback(async (payload: RunRecordPayload, options?: { readOnly?: boolean }) => {
    const token = ++runRecordToken.current;
    runRecordPayload.current = payload;
    const intent: RunRecordIntent = {
      sessionId: payload.sessionId,
      runId: payload.runId,
      outcome: payload.outcome,
    };
    publishRunRecord({ intent, phase: 'writing' });
    // A read-only retry is for a write Native already accepted: it re-reads
    // instead of writing again, so settling an unreadable record can never
    // overwrite the stored row.
    const write = options?.readOnly
      ? ({ ok: true } as SessionRunWrite)
      : await recordTerminalRun(payload);
    if (token !== runRecordToken.current || !mountedRef.current) return;
    if (write.ok) publishRunRecord({ intent, phase: 'confirming' });
    // A rejected write is never confirmed by a read: it is reported as-is.
    const read = write.ok
      ? await readSessionRunsFor(payload.sessionId)
      : ({ ok: false } as SessionRunRead);
    if (token !== runRecordToken.current || !mountedRef.current) return;
    const verdict = decideRunRecord(intent, write, read);
    publishRunRecord({ intent, ...verdict });
    if (verdict.phase === 'confirmed') {
      // The terminal frame landed before this write, so the list reload that
      // `finalizeAssistantMessage` triggered can have read the table too
      // early. Re-read it so the row shows the run Native actually stored.
      onSessionCreatedRef.current();
    }
  }, [publishRunRecord]);

  const retryRunRecord = useCallback(() => {
    const payload = runRecordPayload.current;
    if (!payload) return;
    const readOnly = runRecordView(runRecordRef.current)?.phase === 'unreadable';
    void confirmRunRecord(payload, { readOnly });
  }, [confirmRunRecord]);

  // A new turn invalidates the previous turn's confirmation, and with it any
  // read-back still in flight for that turn.
  const clearRunRecord = useCallback(() => {
    runRecordToken.current += 1;
    publishRunRecord(null);
  }, [publishRunRecord]);

  const matchesStreamSession = useCallback((sid: string | undefined) => {
    if (!mountedRef.current) return false;
    const current = activeSessionRef.current;
    if (current === null) return sid === undefined || sid === '';
    if (!sid) return false;
    return sid === current;
  }, []);

  // M6 — coalesce token deltas into one setMessages per animation frame so
  // high-frequency SSE token events don't thrash React with N re-renders
  // per second. Buffer into a ref; rAF (or immediate sync flush on finalize
  // / error / cancel / session switch) applies the concatenated chunk.
  const pendingTokenRef = useRef('');
  const tokenRafRef = useRef<number | null>(null);

  const cancelTokenRaf = useCallback(() => {
    if (tokenRafRef.current !== null) {
      cancelAnimationFrame(tokenRafRef.current);
      tokenRafRef.current = null;
    }
  }, []);

  /** Drain the token buffer; cancel any scheduled rAF. Returns the text. */
  const takePendingTokens = useCallback(() => {
    cancelTokenRaf();
    const text = pendingTokenRef.current;
    pendingTokenRef.current = '';
    return text;
  }, [cancelTokenRaf]);

  /** Append a text chunk onto the streaming assistant bubble (pure). */
  const applyTokenChunk = useCallback((prev: JarvisMessage[], text: string): JarvisMessage[] => {
    if (!text) return prev;
    const last = prev[prev.length - 1];
    if (last && last.role === 'assistant' && last.isStreaming) {
      return [...prev.slice(0, -1), { ...last, content: last.content + text }];
    }
    return [...prev, { role: 'assistant', content: text, isStreaming: true }];
  }, []);

  /** Apply any buffered tokens into messages state (rAF path). */
  const flushPendingTokens = useCallback(() => {
    tokenRafRef.current = null;
    if (!mountedRef.current) {
      pendingTokenRef.current = '';
      return;
    }
    const text = pendingTokenRef.current;
    if (!text) return;
    pendingTokenRef.current = '';
     setError(null);
     setPipelineStage('');
     dispatchActivity({ kind: 'live_stage', stage: '' });
     turnHadResponseTextRef.current = true;
    setMessages(prev => applyTokenChunk(prev, text));
  }, [applyTokenChunk, dispatchActivity]);

  /** Drop buffered tokens + cancel rAF (session wipe / new chat). */
  const discardPendingTokens = useCallback(() => {
    cancelTokenRaf();
    pendingTokenRef.current = '';
  }, [cancelTokenRaf]);

  const appendAssistantText = useCallback((text: string) => {
    if (!mountedRef.current || !text) return;
    pendingTokenRef.current += text;
    if (tokenRafRef.current !== null) return;
    tokenRafRef.current = requestAnimationFrame(() => {
      flushPendingTokens();
    });
  }, [flushPendingTokens]);

  const finalizeAssistantMessage = useCallback((sid?: string, terminal?: DecodedStreamTerminal) => {
    if (!mountedRef.current) return;
    // Drain rAF buffer inside the same setMessages as finalize so React
    // batching cannot drop the last ~16ms of streamed text.
    const pending = takePendingTokens();
    setIsStreaming(false);
    setPipelineStage('');
    setRecursionDepth(null);
    clearPendingApproval();
    setUserPinnedToBottom(true);
    turnHadResponseTextRef.current = false;
    const effectiveSid = sid || activeSessionRef.current || sessionIdRef.current;
    setMessages(prev => {
      const withTokens = applyTokenChunk(prev, pending);
      const last = withTokens[withTokens.length - 1];
      const messageOutcome: StreamTerminalOutcome | undefined = terminal
        && terminal.outcome !== 'success'
        && terminal.outcome !== 'cancelled'
        ? terminal.outcome
        : undefined;
      const finalizedMessages = finalizeStreamingMessages(withTokens, messageOutcome, terminal?.code);
      const finalized = finalizedMessages[finalizedMessages.length - 1];
      if (last?.role === 'assistant' && last.isStreaming) {
        const shouldPersist = !terminal || terminal.outcome === 'success';
        if (shouldPersist && effectiveSid && finalized?.role === 'assistant' && finalized.content.trim()) {
          invoke('append_message', {
            ...sessionInvokeArgs(effectiveSid),
            role: 'assistant',
            content: finalized.content,
          }).catch((e: any) => { console.error('Failed to persist assistant message:', e); setError('Append failed: ' + (e?.message || String(e))); });
        }
        return finalizedMessages;
      }
      return withTokens;
    });
    onSessionCreatedRef.current();
  }, [applyTokenChunk, clearPendingApproval, takePendingTokens]);

  // Reduced motion is honoured by the design system's CSS (`.d-caret`,
  // `.d-skeleton`, `.d-wire` and every animation are neutralised under
  // `prefers-reduced-motion`), so the controller no longer tracks it.

  // Scroll-position watcher. We declare "pinned" as: at most 80px above the
  // bottom. Anything further up means the user is reading — pause autoscroll.
  // Only an UPWARD scroll means the operator is reading: our own smooth
  // scroll toward the bottom emits scroll events while still >80px away
  // (tokens keep landing), and those must not unpin the transcript.
  const lastScrollTopRef = useRef(0);
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const movedUp = el.scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    if (distanceFromBottom < 80) setUserPinnedToBottom(true);
    else if (movedUp) setUserPinnedToBottom(false);
  }, []);

  const scrollToBottom = useCallback((behavior: 'smooth' | 'auto' = 'smooth') => {
    // jsdom (and very old engines) have no scrollIntoView; never let a missing
    // layout engine break the Session surface.
    messagesEndRef.current?.scrollIntoView?.({ behavior });
  }, []);

  // Throttled scroll during streaming: tokens arrive at 20-50 Hz, but
  // smooth-scrolling on every character feels laggy and costs layout work.
  // 100ms ≈ 10 fps — smooth enough to follow the cursor, cheap enough to not
  // thrash the main thread.
  useEffect(() => {
    if (!isStreaming || !userPinnedToBottom) return;
    const t = setTimeout(() => scrollToBottom('smooth'), 100);
    return () => clearTimeout(t);
  }, [messages, isStreaming, userPinnedToBottom, scrollToBottom]);

  // Non-streaming reflow: snap immediately when messages change (history load).
  useEffect(() => {
    if (isStreaming) return;
    if (userPinnedToBottom) scrollToBottom('auto');
  }, [messages, isStreaming, userPinnedToBottom, scrollToBottom]);

  // Phase 2.3 — load session history from SQLite when the user switches to a
  // different session. Without this the user sees an empty chat for a session
  // that has prior messages. Was the #1 audit bug.
  const prevActiveSessionRef = useRef<string | null>(activeSession);
  // When handleSend creates a session for the very first message, it sets this
  // to the new id and optimistically renders the user + streaming-assistant
  // messages. The history-load effect below would otherwise immediately fetch
  // the (still-empty) history and overwrite them — the "my message vanished"
  // bug. We skip the load exactly once for that freshly-created session.
  const suppressHistoryLoadRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevActiveSessionRef.current;
    setHistoryError(false);
    if (suppressHistoryLoadRef.current && suppressHistoryLoadRef.current === activeSession) {
      // Freshly created by handleSend: preserve its optimistic turn and make
      // this Session the new comparison baseline without invalidating the send.
      prevActiveSessionRef.current = activeSession;
      suppressHistoryLoadRef.current = null;
      sessionScroll.save(activeSession || '', { offset: scrollContainerRef.current?.scrollTop ?? 0, pinnedToBottom: userPinnedToBottom });
      setLoadingHistory(false);
      return;
    }
    prevActiveSessionRef.current = activeSession;
    if (prev !== activeSession) {
      seenApprovalKeysRef.current.clear();
      if (prev) invoke('cancel_chat_stream', sessionInvokeArgs(prev)).catch(() => {});
      streamAbortRef.current?.abort('Session switched');
      streamAbortRef.current = null;
      sendGateRef.current.invalidate();
      stopRequestedRef.current = false;
      discardPendingTokens();
      setMessages([]);
      setIsStreaming(false);
      setPipelineStage('');
      setRecursionDepth(null);
      setReasoningText('');
      setShowReasoning(false);
      setAgentSteps([]);
      setShowAgents(true);
      setToolCalls([]);
      resetActivityLedger();
      setTurnCost(null);
      setScopeNotice(null);
      setRunMetrics(null);
      setTurnElapsedMs(0);
      turnStartedAtRef.current = null;
      clearPendingApproval();
      setApprovalError(null);
      setError(null);
      turnHadResponseTextRef.current = false;
      // Reset the per-session rollup so the Session Stats pill starts
      // empty for the new session. The accumulation-ref is cleared in
      // lockstep so a re-sent metrics frame from a previous stream
      // can't bridge the gap.
      setSessionStats({ tokens: 0, turnCount: 0 });
      lastAccumulatedRunIdRef.current = undefined;
    }
    if (!activeSession) {
      setLoadingHistory(false);
      discardPendingTokens();
      setMessages([]);
      setSessionId('');
      setToolCalls([]);
      resetActivityLedger();
      setTurnCost(null);
      setScopeNotice(null);
      setRunMetrics(null);
      setTurnElapsedMs(0);
      turnStartedAtRef.current = null;
      setError(null);
      setPipelineStage('');
      setReasoningText('');
      setAgentSteps([]);
      setIsStreaming(false);
      return;
    }
    let cancelled = false;
    setLoadingHistory(true);
    invoke<SessionHistoryMessage[]>('get_session_history', sessionInvokeArgs(activeSession))
      .then((rows) => {
        if (cancelled) return;
        // Map the DB row id into JarvisMessage.id (Task 7 / incident 1d4727cf)
        // so a message that was already shown optimistically — and is now
        // reappearing via this history reload — carries the same identity
        // and can be deduped instead of rendering as a second bubble.
        setMessages(dedupeMessages(rows.map(r => ({
          id: r.id,
          role: (r.role === 'user' || r.role === 'assistant' || r.role === 'tool' || r.role === 'system') ? r.role : 'assistant',
          content: r.content,
          timestamp: r.created_at,
        }))));
        // Restore scroll offset for this session on reload (Jarvis scroll-state).
        const saved = sessionScroll.load(activeSession || '');
        if (saved && scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = saved.offset;
          setUserPinnedToBottom(saved.pinnedToBottom);
        }
        // Jump to the bottom without animation on initial history load.
        requestAnimationFrame(() => {
          if (!cancelled) {
            setUserPinnedToBottom(true);
            scrollToBottom('auto');
          }
        });
      })
      .catch(() => {
        if (!cancelled) setHistoryError(true);
      })
      .finally(() => {
        if (!cancelled) {
          sessionScroll.save(activeSession || '', { offset: scrollContainerRef.current?.scrollTop ?? 0, pinnedToBottom: userPinnedToBottom });
          setLoadingHistory(false);
        }
      });
    return () => { cancelled = true; };
  }, [activeSession, clearPendingApproval, historyRetry, scrollToBottom, discardPendingTokens]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sendGateRef.current.invalidate();
      sendInFlightRef.current.finish();
      const controller = streamAbortRef.current;
      streamAbortRef.current = null;
      controller?.abort('Passive view teardown');
      discardPendingTokens();
    };
  }, [discardPendingTokens]);

  // Register jarvis:// listeners once on mount. Async listen() + deps that
  // change during streaming causes a re-subscribe storm (jarvis-tauri-listen-race).
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let disposed = false;
    const track = (p: Promise<() => void>) => {
      p.then((f) => {
        if (disposed) f();
        else unsubs.push(f);
      });
    };

    track(listen<{ text: string; session_id: string }>('jarvis://token', (event) => {
      const { text, session_id } = event.payload;
      if (!text || !matchesStreamSession(session_id)) return;
      appendAssistantText(text);
    }));

    track(listen<{ session_id: string }>('jarvis://done', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      dispatchActivity({ kind: 'terminal', outcome: 'success' });
      finalizeAssistantMessage(event.payload.session_id);
    }));

    // NOTE (Task 7 / 2026-07-03 incident 1d4727cf): this `jarvis_send_message`
    // / `jarvis://*` Tauri-event path is wired but not currently invoked by
    // the chat UI — `handleSend` uses the direct-fetch `streamFromJarvisApi`
    // path below instead, which has the primary error/cancelled handling.
    // Hardened here too for defense-in-depth in case something re-enables
    // this path. The Rust `SseFrameOutcome::Error` variant only carries a
    // message string, not a `code` (unlike the fetch path's raw JSON
    // frames) — reported as a gap below rather than changing Rust.
    track(listen<{ error: string; session_id: string; code?: string }>('jarvis://error', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      const pending = takePendingTokens();
      setIsStreaming(false);
      setPipelineStage('');
      dispatchActivity({ kind: 'terminal', outcome: 'failed' });
      setRecursionDepth(null);
      clearPendingApproval();
      setError(event.payload.error);
      setUserPinnedToBottom(true);
      setMessages(prev => {
        const withTokens = applyTokenChunk(prev, pending);
        const last = withTokens[withTokens.length - 1];
        if (last && last.isStreaming) {
          // If nothing streamed before the error (e.g. a turn-fatal auth
          // failure), turn the bubble into a designed error bubble showing
          // the message text (instead of silently dropping it, which left
          // the user with only their own message + the easy-to-miss banner).
          const partial = last.content.trim();
          return [...withTokens.slice(0, -1), {
            ...last,
            content: partial ? last.content : event.payload.error,
            isStreaming: false,
            isError: true,
            errorCode: event.payload.code,
          }];
        }
        return withTokens;
      });
    }));

    // Rust's SseRelay maps a `cancelled` SSE frame straight to `jarvis://done`
    // (see runner.rs `SseFrameOutcome::Cancelled`) — there is no distinct
    // `jarvis://cancelled` Tauri event today, so this listener is a no-op
    // registration for forward-compatibility / documentation of the gap
    // rather than dead code masking a real handler. If a future Rust change
    // adds a genuine `jarvis://cancelled` emit, this starts working without
    // further UI changes.
    track(listen<{ session_id: string }>('jarvis://cancelled', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      const pending = takePendingTokens();
      setIsStreaming(false);
      setPipelineStage('');
      dispatchActivity({ kind: 'terminal', outcome: 'cancelled' });
      setRecursionDepth(null);
      setError(null);
      setMessages(prev => {
        const withTokens = applyTokenChunk(prev, pending);
        const last = withTokens[withTokens.length - 1];
        if (last?.role === 'assistant' && last.isStreaming) {
          const content = sanitizeAssistantDisplay(last.content);
          if (!content) return withTokens.slice(0, -1);
          return [...withTokens.slice(0, -1), { ...last, content, isStreaming: false, isCancelled: true }];
        }
        return withTokens;
      });
    }));

    track(listen<{ stage: string; status: string; agent: string; session_id?: string }>('jarvis://stage', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      const { stage, status } = event.payload;
      setPipelineStage(isTerminalStageStatus(status) ? '' : stage);
      setAgentSteps(prev => appendAgentProgress(prev, {
        stage,
        text: isTerminalStageStatus(status) ? status : 'started',
        source: 'stage',
      }));
      dispatchActivity({ kind: 'stage', stage, status });
    }));

    track(listen<{ depth: number; status: string; reenter_stage?: string; critique?: string; session_id?: string }>('jarvis://recursion', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      const { depth, status } = event.payload;
      // Show depth only while an active recursive critique cycle is running
      setRecursionDepth(status === 'done' || status === 'max_depth' ? null : depth);
    }));

    track(listen<{ text: string; session_id?: string }>('jarvis://reasoning', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      setReasoningText(prev => prev + event.payload.text);
    }));

    track(listen<{ trace: unknown; session_id?: string }>('jarvis://reasoning_complete', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      const trace = event.payload.trace as { steps?: Array<{ content?: string }> } | null;
      if (trace?.steps?.length) {
        const joined = trace.steps.map((s) => s.content ?? '').filter(Boolean).join('\n');
        if (joined) setReasoningText(joined);
      }
      setShowReasoning(true);
    }));

    track(listen<{ stage: string; text: string; session_id?: string }>('jarvis://agent_activity', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      const { stage, text } = event.payload;
      if (stage === 'coordinator') {
        setPipelineStage('coordinator');
        dispatchActivity({ kind: 'live_stage', stage });
        return;
      }
      const filtered = appendAgentProgress([], { stage, text, source: 'activity' });
      const step = filtered[0];
      if (step) dispatchActivity({ kind: 'agent_activity', stage: step.stage, text: step.text });
      setAgentSteps(prev => appendAgentProgress(prev, { stage, text, source: 'activity' }));
    }));

    track(listen<{
      call_id: string;
      name: string;
      arguments: unknown;
      session_id: string;
    }>('jarvis://approval_request', (event) => {
      const p = event.payload;
      if (!matchesStreamSession(p.session_id)) return;
      presentApprovalRequest({
        call_id: p.call_id,
        name: p.name,
        arguments: p.arguments,
        session_id: p.session_id,
      });
    }));

    track(listen<{ call_id?: string; name: string; arguments: unknown; session_id?: string }>('jarvis://tool_call', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      const call = {
        call_id: event.payload.call_id,
        name: event.payload.name,
        arguments: event.payload.arguments,
      };
      setToolCalls(prev => [...prev, call]);
      dispatchActivity({ kind: 'tool_use', callId: call.call_id, name: call.name, arguments: call.arguments });
    }));

    track(listen<{
      call_id: string;
      name: string;
      output: string;
      is_error: boolean;
      session_id?: string;
    }>('jarvis://tool_result', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      const { call_id, name, output, is_error } = event.payload;
      setToolCalls(prev => mergeToolResult(prev, {
        callId: call_id,
        name,
        output,
        isError: is_error,
      }));
      dispatchActivity({
        kind: 'tool_result',
        callId: call_id,
        name,
        output,
        isError: is_error,
      });
    }));

    track(listen<{ tokens: number; cost_usd: number; session_id?: string }>('jarvis://cost', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      setTurnCost({ tokens: event.payload.tokens, costUsd: event.payload.cost_usd });
    }));

    return () => {
      disposed = true;
      unsubs.forEach((f) => f());
    };
  }, [appendAssistantText, applyTokenChunk, clearPendingApproval, confirmRunRecord, dispatchActivity, finalizeAssistantMessage, matchesStreamSession, presentApprovalRequest, takePendingTokens]);

  // True autosize composer (Phase 2.4). The previous rows=⟨line-count⟩ approach
  // overflowed for single-line wrapped text.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [input]);

  // Autofocus + focus-after-send + focus-after-session-switch.
  useEffect(() => {
    // Never steal focus the operator moved deliberately in the meantime
    // (e.g. onto another control, which a tool approval dialog then records
    // as its opener): only autofocus when focus is still where it was.
    const focusedAtSwitch = document.activeElement;
    const t = setTimeout(() => {
      if (pendingApprovalRef.current) return;
      if (document.activeElement !== focusedAtSwitch) return;
      inputRef.current?.focus();
    }, 50);
    return () => clearTimeout(t);
  }, [activeSession]);

  const streamFromJarvisApi = useCallback(async (
    sid: string,
    userMsg: string,
    history: Array<{ role: string; content: string }>,
    sendGeneration: number,
    onAccepted: () => void,
    clientMessageId: string,
  ) => {
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    const requestIsCurrent = () => (
      mountedRef.current
      && sendGateRef.current.isCurrent(sendGeneration)
      && matchesStreamSession(sid)
      && streamAbortRef.current === controller
    );

    // `append_message` returns the DB row id (sessions.rs `insert_message_row`).
    // Swap the client-generated id for the persisted one so a later
    // history-reload (which maps DB row ids into JarvisMessage.id) recognizes
    // this as the SAME message instance and dedupes it, instead of showing it
    // twice — the 2026-07-03 incident 1d4727cf "two YOU bubbles" bug.
    invoke<string>('append_message', {
      ...sessionInvokeArgs(sid),
      role: 'user',
      content: userMsg,
    }).then((dbId) => {
      if (!requestIsCurrent()) return;
      if (typeof dbId !== 'string' || !dbId) return;
      setMessages(prev => prev.map((m) => (m.id === clientMessageId ? { ...m, id: dbId } : m)));
    }).catch((e: any) => {
      if (!requestIsCurrent()) return;
      console.error('Failed to persist user message:', e);
      setError('Append failed: ' + (e?.message || String(e)));
    });

    const response = await fetch(`${JARVIS_API_URL}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: userMsg,
        session_id: sid,
        history,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Jarvis server returned ${response.status}: ${body}`);
    }
    if (!response.body) {
      throw new Error('Jarvis server returned no response stream.');
    }
    if (!requestIsCurrent()) {
      controller.abort('Stale Session turn');
      throw new DOMException('Stale Session turn', 'AbortError');
    }
    onAccepted();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamedVisibleText = false;
    let streamedRawText = '';
    let inactivityTimedOut = false;
    // Task 4.1: mirror the Rust relay's TerminalRunAccumulator (jarvis/
    // runner.rs). This direct-fetch path bypasses that relay, so the UI
    // reports the terminal outcome it observed via the `record_terminal_run`
    // Tauri command once the stream ends — otherwise session_runs stays
    // empty and a force-stopped turn leaves no durable trace.
    const runAcc: {
      runId?: string;
      outcome?: 'success' | 'partial' | 'failed' | 'timed_out' | 'cancelled';
      selectedModel?: string;
      tokenCount: number;
      toolCount: number;
      cancelledReason?: string;
      partialOutput?: string;
    } = { tokenCount: 0, toolCount: 0 };
     let terminalFrame: StreamTerminalFrame = null;
     let terminal: DecodedStreamTerminal | null = null;
     let activityTerminalDispatched = false;
    const persistTerminalRun = () => {
      if (!requestIsCurrent() || !runAcc.outcome) return;
      // A force-stop can land before the pipeline ever emitted agent_run_id
      // (the incident's exact case) — synthesize an id so the cancellation
      // is still durably recorded. run_id is the idempotency key, so a
      // client-generated id is safe, and a retry re-uses the same one.
      const runId = runAcc.runId ?? `run_client_${crypto.randomUUID()}`;
      void confirmRunRecord({
        sessionId: sid,
        runId,
        outcome: runAcc.outcome,
        selectedModel: runAcc.selectedModel ?? null,
        tokenCount: runAcc.tokenCount,
        toolCount: runAcc.toolCount,
        cancelledReason: runAcc.cancelledReason ?? null,
        partialOutput: runAcc.partialOutput ?? null,
      });
    };
    const acceptTerminal = (next: DecodedStreamTerminal): boolean => {
      const accepted = acceptFirstTerminal(terminal, next);
      if (!accepted || accepted === terminal) return false;
      terminal = accepted;
      terminalFrame = accepted.frame;
      runAcc.outcome = accepted.outcome;
      if (accepted.outcome === 'partial' || accepted.outcome === 'timed_out') {
        runAcc.partialOutput = boundedPartialOutput(accepted.text || streamedRawText);
      }
      return true;
    };
    const reportUnknownFrame = createUnknownFrameReporter();
    const inactivityWatchdog = new InactivityWatchdog(
      STREAM_INACTIVITY_TIMEOUT_MS,
      () => {
        if (terminal) return;
        inactivityTimedOut = true;
        controller.abort('Jarvis stream inactivity timeout');
        reader.cancel('Jarvis stream inactivity timeout').catch(() => {});
      },
    );

    const handleFrame = (frame: any) => {
      if (!requestIsCurrent()) return;
      if (!frame || typeof frame !== 'object') return;
      if (frame.type === 'stream_event' && frame.delta?.text) {
        const text = String(frame.delta.text);
        streamedRawText += text;
        streamedVisibleText = /\S/.test(sanitizeAssistantDisplay(streamedRawText));
        appendAssistantText(text);
        return;
      }
      if (frame.type === 'agent_activity' && frame.text) {
        const stage = String(frame.stage || 'agent');
        if (stage === 'coordinator') {
          setPipelineStage('coordinator');
          dispatchActivity({ kind: 'live_stage', stage });
          return;
        }
        const activityText = String(frame.text);
        const filtered = appendAgentProgress([], { stage, text: activityText, source: 'activity' });
        const step = filtered[0];
        if (step) dispatchActivity({ kind: 'agent_activity', stage: step.stage, text: step.text });
        setAgentSteps(prev => appendAgentProgress(prev, {
          stage,
          text: activityText,
          source: 'activity',
        }));
        return;
      }
      if (frame.type === 'orchestrator_stage') {
        const stage = String(frame.stage || 'agent');
        const terminal = isTerminalStageStatus(frame.status);
        setPipelineStage(terminal ? '' : stage);
        const detail = typeof frame.detail === 'string' ? frame.detail : '';
        const elapsed = Number(frame.elapsed_ms);
        const progressText = detail.startsWith('tool:')
          ? `used ${detail.slice(5)}`
          : terminal
            ? `${String(frame.status)}${Number.isFinite(elapsed) ? ` in ${(elapsed / 1000).toFixed(1)}s` : ''}`
            : 'started';
        setAgentSteps(prev => appendAgentProgress(prev, {
          stage,
          text: progressText,
          source: detail.startsWith('tool:') ? 'tool' : 'stage',
        }));
        dispatchActivity({ kind: 'stage', stage, status: frame.status, detail: frame.detail, elapsedMs: frame.elapsed_ms });
        return;
      }
      if (frame.type === 'orchestrator_recursion') {
        const status = String(frame.status || '');
        setRecursionDepth(status === 'done' || status === 'max_depth' ? null : Number(frame.depth || 0));
        return;
      }
      if (frame.type === 'reasoning_step' || frame.type === 'reasoning_chunk') {
        const text = frame.content ?? frame.text ?? frame.delta?.text ?? frame.step?.content;
        if (text) setReasoningText(prev => prev + String(text));
        return;
      }
      if (frame.type === 'reasoning_complete') {
        setShowReasoning(true);
        return;
      }
      if (frame.type === 'tool_approval_request') {
        const frameSessionId = frame.session_id;
        const callId = frame.call_id;
        const name = frame.name;
        if (typeof frameSessionId !== 'string'
          || frameSessionId !== sid
          || typeof callId !== 'string'
          || !callId.trim()
          || typeof name !== 'string'
          || !name.trim()) return;
        presentApprovalRequest({
          call_id: callId,
          name,
          arguments: frame.arguments,
          session_id: frameSessionId,
        });
        return;
      }
      if (frame.type === 'tool_use') {
        runAcc.toolCount += 1;
        const call = {
          call_id: frame.id || frame.call_id,
          name: frame.name || frame.tool_name || 'unknown',
          arguments: frame.arguments ?? frame.input ?? null,
        };
        setToolCalls(prev => [...prev, call]);
        dispatchActivity({ kind: 'tool_use', callId: call.call_id, name: call.name, arguments: call.arguments });
        return;
      }
      if (frame.type === 'tool_result') {
        const callId = frame.call_id;
        const name = frame.name || 'tool';
        const output = String(frame.output ?? frame.result ?? '');
        const isError = Boolean(frame.is_error || frame.status === 'error');
        const contextTruncation = readToolResultTruncation(frame);
        setToolCalls(prev => mergeToolResult(prev, {
          callId,
          name,
          output,
          isError,
          contextTruncation: contextTruncation ?? undefined,
        }));
        dispatchActivity({
          kind: 'tool_result',
          callId,
          name,
          output,
          isError,
          contextTruncation: contextTruncation ?? undefined,
        });
        return;
      }
      if (frame.type === 'conductor_directive') {
        const decoded = decodeConductorDirectiveFrame(frame, sid);
        if (decoded.kind === 'ignored') return;
        if (decoded.kind === 'valid') {
          dispatchActivity({ kind: 'directive', key: decoded.key, directive: decoded.directive, stage: decoded.directive.stage });
        } else {
          dispatchActivity({ kind: 'diagnostic', text: decoded.message });
        }
        return;
      }
      if (frame.type === 'cost_info') {
        runAcc.selectedModel = typeof frame.model === 'string' ? frame.model : runAcc.selectedModel;
        runAcc.tokenCount = Number(frame.total_tokens ?? frame.tokens ?? 0) || runAcc.tokenCount;
        setTurnCost({
          tokens: Number(frame.total_tokens ?? frame.tokens ?? 0),
          costUsd: Number(frame.cost_usd ?? 0),
        });
        return;
      }
      if (frame.type === 'scope_notice') {
        setScopeNotice({
          paths: Array.isArray(frame.allowed_paths) ? frame.allowed_paths.map(String) : [],
          rootListing: Boolean(frame.allow_root_listing),
          shell: String(frame.shell || 'unchanged'),
          network: String(frame.network || 'unchanged'),
        });
        return;
      }
      if (frame.type === 'orchestration_metrics') {
        const durationMs = Math.max(0, Number(frame.duration_ms ?? 0));
        const tokens = Math.max(0, Number(frame.tokens_total ?? 0));
        const tools = Math.max(0, Number(frame.tool_calls ?? 0));
        runAcc.tokenCount = tokens || runAcc.tokenCount;
        runAcc.toolCount = tools || runAcc.toolCount;
        setTurnElapsedMs(durationMs);
        setRunMetrics({
          durationMs,
          tokens,
          tools,
          fallbackRetries: Math.max(0, Number(frame.fallback_retries ?? 0)),
          fallbackReason: typeof frame.fallback_reason === 'string' ? frame.fallback_reason : undefined,
          scopeCompliant: typeof frame.scope_compliant === 'boolean' ? frame.scope_compliant : undefined,
          provider: typeof frame.actual_provider === 'string' ? frame.actual_provider : undefined,
          model: typeof frame.actual_model === 'string' ? frame.actual_model : undefined,
          firstVisibleTokenMs: Number.isFinite(Number(frame.first_visible_token_ms))
            ? Math.max(0, Number(frame.first_visible_token_ms))
            : undefined,
        });
        // Per-session cumulative rollup: accumulate this turn's tokens onto
        // the session total, but only the first time we see this runId. The
        // server emits the metrics frame once per turn, but a re-stream or a
        // downstream re-send would otherwise double-count the same turn.
        // The `runAcc.runId` is set by the `agent_run_id` frame earlier in
        // the same stream — if it never arrived, we silently skip (the pill
        // will only count turns that had a complete run identity, which
        // matches what gets durably recorded via `record_terminal_run`).
        if (runAcc.runId && runAcc.runId !== lastAccumulatedRunIdRef.current) {
          lastAccumulatedRunIdRef.current = runAcc.runId;
          setSessionStats(prev => ({ tokens: prev.tokens + tokens, turnCount: prev.turnCount + 1 }));
        }
        if (Array.isArray(frame.executed_tools)) {
          const ledgerCalls: ToolCallState[] = frame.executed_tools.map((value: unknown, index: number) => {
            const entry = value && typeof value === 'object' ? value as Record<string, unknown> : {};
            const ok = entry.ok !== false;
            return {
              call_id: `ledger-${index}`,
              name: String(entry.name || 'tool'),
              arguments: typeof entry.path === 'string' ? { path: entry.path } : {},
              result: ok ? 'Succeeded · recorded in executed-tool ledger' : `Failed · ${String(entry.error_code || 'tool error')}`,
              is_error: !ok,
              matched: true,
            };
          });
          setToolCalls(prev => prev.length > 0 ? prev : ledgerCalls);
        }
        if (tokens > 0) setTurnCost(prev => ({ tokens, costUsd: prev?.costUsd ?? 0 }));
        return;
      }
      if (frame.type === 'fallback_notice') {
        const fallbackStage = formatFallbackProgress(frame);
        setPipelineStage(fallbackStage);
        dispatchActivity({ kind: 'live_stage', stage: fallbackStage });
        return;
      }
      // Task 4.1: agent_run_id is otherwise passive but carries the durable
      // run identity — capture before the passive filter swallows it.
      if (frame.type === 'agent_run_id' && typeof frame.agent_run_id === 'string') {
        runAcc.runId = frame.agent_run_id;
        return;
      }
      if (isPassiveSseFrame(frame.type)) return;
      if (frame.type === 'result') {
        const decision = decodeResultFrame(frame);
        if (!acceptTerminal(decision)) return;
        dispatchActivity({ kind: 'terminal', outcome: decision.outcome });
        activityTerminalDispatched = true;
        if (decision.hardError) {
          const message = decision.text || String(frame.error || 'Jarvis returned a non-success result.');
          throw new JarvisStreamError(message, decision.code);
        }
        if (!streamedVisibleText && decision.text) appendAssistantText(decision.text);
        return;
      }
      if (frame.type === 'error') {
        const code = typeof frame.code === 'string' ? frame.code : undefined;
        const decision: DecodedStreamTerminal = {
          frame: 'error',
          outcome: code && STREAM_TIMEOUT_CODES.has(code) ? 'timed_out' : 'failed',
          code,
          text: '',
          hardError: true,
        };
        if (!acceptTerminal(decision)) return;
        dispatchActivity({ kind: 'terminal', outcome: decision.outcome });
        activityTerminalDispatched = true;
        if (code) {
          // eslint-disable-next-line no-console
          console.warn(`[Jarvis] stream error code=${code}: ${frame.error}`);
        }
        throw new JarvisStreamError(String(frame.error || 'Jarvis stream failed.'), code);
      }
      if (frame.type === 'cancelled') {
        const decision: DecodedStreamTerminal = {
          frame: 'cancelled',
          outcome: 'cancelled',
          code: 'cancelled',
          text: '',
          hardError: false,
        };
        if (!acceptTerminal(decision)) return;
        dispatchActivity({ kind: 'terminal', outcome: decision.outcome });
        activityTerminalDispatched = true;
        // P0-B (2026-07-02): `cancelled` is now reserved for genuine user
        // / `/chat/cancel` aborts (the server-side fix prevents a hung
        // model from emitting this). Previously the UI had no handler for
        // it — the frame was silently dropped, the read loop ended, and
        // `finalizeAssistantMessage` left an empty assistant bubble
        // visible. Now we mark the stream as intentionally stopped, clear
        // the streaming indicator, and surface a non-error "(stopped)"
        // notice so the user knows the turn ended because they asked.
        //
        // Task 7 Part C: finalize into a muted `isCancelled` bubble (rather
        // than a plain finalized assistant message) if partial text
        // streamed, or drop the empty stub entirely if nothing did —
        // `isStreaming` always ends false either way, so there's no
        // forever-spinner.
        // 2026-07-13 finding: this used to hardcode 'user_stop' regardless
        // of cause, so a resend racing an in-flight turn (ActiveStreamRegistry
        // superseding it) recorded identically to a deliberate Stop click.
        // The server now classifies the real reason (index.ts's
        // classifyAbortReason); fall back to 'user_stop' only if an older
        // server build omits the field.
        runAcc.cancelledReason = typeof frame.reason === 'string' ? frame.reason : 'user_stop';
        clearPendingApproval();
        const pending = takePendingTokens();
        setIsStreaming(false);
        stopRequestedRef.current = false;
        setError(null);
        setMessages(prev => {
          const withTokens = applyTokenChunk(prev, pending);
          const last = withTokens[withTokens.length - 1];
          if (last?.role === 'assistant' && last.isStreaming) {
            const content = sanitizeAssistantDisplay(last.content);
            if (!content) return withTokens.slice(0, -1);
            return [...withTokens.slice(0, -1), { ...last, content, isStreaming: false, isCancelled: true }];
          }
          return finalizeStreamingMessages(withTokens);
        });
        return;
      }
      // P0-I (2026-07-02): unknown / unhandled frame types used to be
      // silently dropped. Log them once per type so operator / dev can
      // spot contract drift between the server emitter and the UI
      // handler chain. (P0-B fix relies on this: any future regression
      // that re-introduces a "hung model emits cancelled" path will
      // surface here as a `cancelled` log if a handler is later added.)
      if (typeof frame.type === 'string') {
        reportUnknownFrame(frame.type);
      }
    };

    inactivityWatchdog.start();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const eventText of events) {
          for (const line of eventText.split('\n')) {
            // Task 7 Part C: `parseSseDataLine` throws `SseProtocolError` for
            // a malformed/typeless frame. That used to propagate out of this
            // whole loop via the outer try/catch below — one bad frame ended
            // the entire turn with a scary error, even though the stream
            // itself was fine. Warn + skip that single line instead; only
            // genuine terminal failures thrown from handleFrame (e.g. an
            // `error` SSE frame) should still end the turn.
            let frame: ReturnType<typeof parseSseDataLine>;
            try {
              frame = parseSseDataLine(line);
            } catch (parseError) {
              console.warn('[Jarvis] skipping malformed SSE frame:', parseError);
              continue;
            }
            if (frame) {
              inactivityWatchdog.touch();
              handleFrame(frame);
            }
          }
        }
      }
      const termination = classifyStreamTermination({
        terminalFrame,
        terminalOutcome: runAcc.outcome ?? null,
        inactivityTimedOut,
        aborted: controller.signal.aborted,
        stopRequested: stopRequestedRef.current,
      });
      if (termination === 'unterminated') {
        runAcc.outcome = 'failed';
        runAcc.partialOutput = boundedPartialOutput(streamedRawText);
        dispatchActivity({ kind: 'terminal', outcome: 'failed' });
        activityTerminalDispatched = true;
        throw new JarvisStreamError(STREAM_INCOMPLETE_MESSAGE, STREAM_INCOMPLETE_CODE);
      }
    } catch (error) {
      if (inactivityTimedOut) {
        throw new Error(`Jarvis stream was inactive for ${STREAM_INACTIVITY_TIMEOUT_MS / 1000} seconds.`);
      }
      throw error;
    } finally {
      inactivityWatchdog.stop();
      // Task 4.1: durably record the terminal outcome on every exit path.
      // Stream ends without a terminal frame: an inactivity timeout is
      // timed_out; a client-side abort (user Stop that raced ahead of the
      // server's `cancelled` frame, or component teardown) is cancelled.
      if (requestIsCurrent() && !runAcc.outcome) {
        if (inactivityTimedOut) {
          runAcc.outcome = 'timed_out';
        } else if (controller.signal.aborted || stopRequestedRef.current) {
          runAcc.outcome = 'cancelled';
          runAcc.cancelledReason = 'client_abort';
        }
        if (!activityTerminalDispatched) {
          dispatchActivity({ kind: 'terminal', outcome: runAcc.outcome ?? 'failed' });
          activityTerminalDispatched = true;
        }
      }
      persistTerminalRun();
    }
    if (inactivityTimedOut) {
      throw new Error(`Jarvis stream was inactive for ${STREAM_INACTIVITY_TIMEOUT_MS / 1000} seconds.`);
    }

    if (requestIsCurrent()) finalizeAssistantMessage(sid, terminal ?? undefined);
    if (streamAbortRef.current === controller) streamAbortRef.current = null;
  }, [appendAssistantText, applyTokenChunk, clearPendingApproval, dispatchActivity, finalizeAssistantMessage, matchesStreamSession, presentApprovalRequest, takePendingTokens]);

  const handleSend = useCallback(async () => {
    // 2026-07-13 live incident (session 7254c3ae): the `isStreaming` React
    // state guard below misses rapid double-Enter presses because setState
    // is async/batched — a second handleSend in the same tick sees the
    // pre-flip value. The server-side ActiveStreamRegistry then silently
    // supersedes the in-flight turn. Check the synchronous in-flight guard
    // FIRST so the race is closed on the client.
    if (!sendInFlightRef.current.begin()) {
      const blocks = sendInFlightRef.current.blocksRecorded();
      console.warn(`[Jarvis UI] send blocked: stream in flight (blocks=${blocks})`);
      setError('A turn is still streaming — please wait for it to finish before sending again.');
      return;
    }
    const submittedDraft = getSessionDraftSnapshot(draftStoreRef.current, activeSession);
    if (!submittedDraft.text.trim() || isStreaming) {
      sendInFlightRef.current.finish();
      return;
    }
    const sendGeneration = sendGateRef.current.tryAcquire();
    if (sendGeneration === null) {
      sendInFlightRef.current.finish();
      return;
    }
    stopRequestedRef.current = false;
    const userMsg = submittedDraft.text.trim();
    const history = messages
      .filter((msg) => !msg.isStreaming && msg.content.trim())
      .map((msg) => ({ role: msg.role, content: msg.content }));
    discardPendingTokens();
    setError(null);
    setIsStreaming(true);
    turnStartedAtRef.current = Date.now();
    setTurnElapsedMs(0);
    setPipelineStage('');
    turnHadResponseTextRef.current = false;
    setRecursionDepth(null);
    setReasoningText('');
    setShowReasoning(false);
    setAgentSteps([]);
    setShowAgents(true);
    setToolCalls([]);
    resetActivityLedger();
    clearRunRecord();
    setTurnCost(null);
    setScopeNotice(null);
    setRunMetrics(null);
    setUserPinnedToBottom(true);
    // Client-side identity for the optimistic user bubble (Task 7 / incident
    // 1d4727cf). Upgraded to the DB row id once `append_message` resolves
    // (see streamFromJarvisApi) so dedupeMessages recognizes the reload-from-
    // history copy as the same instance rather than rendering it twice.
    const clientMessageId = crypto.randomUUID();
    setMessages(prev => [
      ...prev,
      { id: clientMessageId, role: 'user', content: userMsg },
      { role: 'assistant', content: '', isStreaming: true },
    ]);

    let effectiveSessionId = activeSession || sessionId;
    try {
      if (!effectiveSessionId) {
        const newSession = await invoke<JarvisSession>('jarvis_new_session', {
          name: userMsg.slice(0, 60),
        });
        if (!mountedRef.current || !sendGateRef.current.isCurrent(sendGeneration)) return;
        effectiveSessionId = newSession.id;
        // Suppress the history-load effect that setActiveSession is about to
        // trigger — otherwise it overwrites the optimistic messages above with
        // the empty history of this brand-new session.
         suppressHistoryLoadRef.current = newSession.id;
         setSessionId(newSession.id);
         sessionIdRef.current = newSession.id;
         activeSessionRef.current = newSession.id;
         setActiveSession(newSession.id);
        onSessionCreated();
      }

      await streamFromJarvisApi(effectiveSessionId, userMsg, history, sendGeneration, () => {
        publishDraftStore(clearSubmittedSessionDraft(draftStoreRef.current, submittedDraft));
      }, clientMessageId);
    } catch (e) {
      if (!mountedRef.current) return;
      if (!sendGateRef.current.isCurrent(sendGeneration)) {
        publishDraftStore(restoreFailedSessionDraft(draftStoreRef.current, submittedDraft));
        return;
      }
      streamAbortRef.current = null;
      clearPendingApproval();
      const pending = takePendingTokens();
      setIsStreaming(false);
      if (stopRequestedRef.current) {
        stopRequestedRef.current = false;
        setError(null);
        setMessages(prev => finalizeStreamingMessages(applyTokenChunk(prev, pending)));
        return;
      }
      // Task 7 Part C (incident 1d4727cf): finalize the streaming bubble into
      // a designed error bubble — friendly text, `errorCode` as small muted
      // detail — instead of leaving a plain assistant-looking message and
      // relying solely on the (dismissable, easy-to-miss) banner below.
      const errorMessage = String(e instanceof Error ? e.message : e);
       const errorCode = e instanceof JarvisStreamError ? e.code : undefined;
       setError(errorMessage);
       publishDraftStore(restoreFailedSessionDraft(draftStoreRef.current, submittedDraft));
       setMessages(prev => {
        const withTokens = applyTokenChunk(prev, pending);
        const last = withTokens[withTokens.length - 1];
        if (last?.role === 'assistant' && last.isStreaming) {
          const partial = last.content.trim();
          return [...withTokens.slice(0, -1), {
            ...last,
            content: partial ? last.content : errorMessage,
            isStreaming: false,
            isError: true,
            errorCode,
          }];
        }
        return withTokens;
      });
    } finally {
      sendGateRef.current.release(sendGeneration);
      // Mirror the React `isStreaming` state into the synchronous guard so
      // the next handleSend call can proceed normally. The `isCurrent`/
      // `invalidate` dance in sendGateRef handles stale completions, but
      // the in-flight guard is the simpler "is anything in flight right
      // now" check that needs a single finish() on every exit.
      sendInFlightRef.current.finish();
    }
  }, [isStreaming, messages, activeSession, sessionId, onSessionCreated, setActiveSession, clearRunRecord, streamFromJarvisApi, discardPendingTokens, takePendingTokens, applyTokenChunk, publishDraftStore, resetActivityLedger]);

  // Phase 1.3 — real Stop. POST /chat/cancel on the Bun server; SseRelay now
  // treats the resulting `cancelled` frame as terminal, so isStreaming flips.
  const handleStop = useCallback(async () => {
    const sid = activeSession || sessionId;
    if (!sid) {
      setIsStreaming(false);
      return;
    }
    stopRequestedRef.current = true;
    clearPendingApproval();
    const controller = streamAbortRef.current;
    setReasoningText('');
    setShowReasoning(false);
    fetch(`${JARVIS_API_URL}/chat/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sid }),
    }).catch(() => {});
    try {
      const cancelled = await invoke<boolean>('cancel_chat_stream', sessionInvokeArgs(sid));
      if (cancelled) {
        controller?.abort('Explicit Stop confirmed');
      } else {
        controller?.abort('Explicit Stop was not confirmed');
        setIsStreaming(false);
      }
    } catch (e) {
      console.error('Failed to cancel stream:', e);
      controller?.abort('Explicit Stop request failed');
      setIsStreaming(false);
    }
  }, [activeSession, clearPendingApproval, sessionId]);

  // Phase 1.1 — approve / deny the pending tool call and forward the decision
  // to the Bun server. Surface any POST error so the user can retry.
  const handleApproval = useCallback(async (approved: boolean) => {
    const request = pendingApprovalRef.current;
    if (!request || approvalInFlightRef.current) return;
    const inFlight = {
      callId: request.call_id,
      sessionId: request.session_id,
      approved,
    };
    approvalInFlightRef.current = inFlight;
    setApprovalPending(true);
    try {
      await invoke('jarvis_tool_decision', {
        ...sessionInvokeArgs(request.session_id),
        toolCallId: request.call_id,
        tool_call_id: request.call_id,
        decision: approved ? 'approve' : 'deny',
      });
      if (sameToolApproval(pendingApprovalRef.current, request)) clearPendingApproval();
    } catch {
      if (sameToolApproval(pendingApprovalRef.current, request)) {
        setApprovalError('Tool approval decision failed. Retry the same decision.');
        setApprovalRetryDecision(approved);
      }
    } finally {
      if (approvalInFlightRef.current === inFlight) {
        approvalInFlightRef.current = null;
        setApprovalPending(false);
      }
    }
  }, [clearPendingApproval]);

  const handleKeyDown = (e: ReactKeyboardEvent) => {
    // Enter sends; Shift+Enter / Ctrl+Enter / Cmd+Enter → newline.
    if (shouldSubmitComposerKey({
      key: e.key,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      isComposing: e.nativeEvent.isComposing,
    })) {
      e.preventDefault();
      handleSend();
      return;
    }
    // Esc → stop the stream during streaming, otherwise blur.
    if (e.key === 'Escape' && isStreaming) {
      e.preventDefault();
      handleStop();
      return;
    }
    // Cmd/Ctrl+K → new chat.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      handleNewChat();
    }
  };

  const handleNewChat = () => {
    const sid = activeSession || sessionId;
    if (isStreaming && sid) {
      invoke('cancel_chat_stream', sessionInvokeArgs(sid)).catch(() => {});
    }
    streamAbortRef.current?.abort('New Session');
    streamAbortRef.current = null;
    sendGateRef.current.invalidate();
    stopRequestedRef.current = false;
    discardPendingTokens();
    setIsStreaming(false);
    setMessages([]);
    setSessionId('');
    setActiveSession(null);
    activeSessionRef.current = null;
    sessionIdRef.current = '';
    setError(null);
    setPipelineStage('');
    setRecursionDepth(null);
    setReasoningText('');
    setShowReasoning(false);
     setAgentSteps([]);
     setToolCalls([]);
     resetActivityLedger();
     setTurnCost(null);
    setScopeNotice(null);
    setRunMetrics(null);
    setTurnElapsedMs(0);
    turnStartedAtRef.current = null;
    setSessionStats({ tokens: 0, turnCount: 0 });
    lastAccumulatedRunIdRef.current = undefined;
    clearPendingApproval();
    setUserPinnedToBottom(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const onSuggestionClick = (s: string) => {
    setInput(s);
    inputRef.current?.focus();
  };

  const lastAssistant = messages[messages.length - 1];
  // In-flight Session turn progress (M4 sibling): pure view-model output from
  // observed runtime telemetry only. Rendered as a plain status row, so stage
  // progress stays readable before the first token and after the collapsible
  // Activity feed is collapsed — never a bare unexplained spinner.
  const turnProgress = buildTurnProgress({
    isStreaming,
    pipelineStage,
    agentSteps,
    hasResponseText: turnHadResponseTextRef.current,
    approvalName: pendingApproval?.name,
  });
  const streamStatusText = turnProgress?.text;
  // One fixed sentence per run-record phase, derived only from what Native's
  // read-back reported (see `runRecordView`).
  const runRecordSummary = runRecordView(runRecord);
  const runRecordInFlight = runRecord?.phase === 'writing' || runRecord?.phase === 'confirming';
  const showSkeleton =
    isStreaming &&
    !loadingHistory &&
    (messages.length === 0 ||
      !lastAssistant ||
      lastAssistant.role !== 'assistant' ||
      !sanitizeAssistantDisplay(lastAssistant.content));

  const lastAssistantFinished =
    messages.length > 0 &&
    messages[messages.length - 1].role === 'assistant' &&
    !messages[messages.length - 1].isStreaming &&
    !isStreaming;

  const displayedProvider = runMetrics?.provider
    ? formatInferenceRoute(runMetrics.provider)
    : backendLabel;
  const displayedModel = runMetrics?.model ?? modelLabel;
  const displayedRoute = runMetrics?.provider || runMetrics?.model
    ? formatInferenceRoute(runMetrics.provider, runMetrics.model)
    : formatInferenceRoute(config?.active_backend, modelLabel);

  // M4 — unified activity feed (activity ledger, falling back to the legacy
  // agentSteps + toolCalls + pipelineStage feed when the ledger is empty, and
  // appending legacy tool cards when the ledger has none). Unchanged from the
  // legacy render path; only computed here instead of inline in JSX.
  const ledgerFeed = activityLedgerItems(activityLedger);
  const legacyFeed = buildActivityFeed(agentSteps, toolCalls, pipelineStage || undefined);
  const activityFeed: ActivityItem[] = ledgerFeed.length === 0
    ? legacyFeed
    : ledgerFeed.some((item) => item.kind === 'tool' || item.kind === 'tool_result')
      ? ledgerFeed
      : [...ledgerFeed, ...legacyFeed.filter((item) => item.kind === 'tool')];

  const sentCount = messages.filter(m => m.role === 'user').length;

  return {
    // transcript
    messages,
    loadingHistory,
    historyError,
    retryHistory: () => setHistoryRetry(value => value + 1),
    showSkeleton,
    streamStatusText,
    lastAssistantFinished,
    error,
    // scroll
    scrollContainerRef,
    messagesEndRef,
    handleScroll,
    userPinnedToBottom,
    jumpToLatest: () => { setUserPinnedToBottom(true); scrollToBottom('smooth'); },
    // composer
    inputRef,
    input,
    setInput: (value: string) => setInput(value),
    handleKeyDown,
    handleSend,
    handleStop,
    handleNewChat,
    onSuggestionClick,
    isStreaming,
    turnElapsedMs,
    turnCost,
    sentCount,
    // turn telemetry
    turnProgress,
    runRecordSummary,
    runRecordInFlight,
    retryRunRecord,
    activityFeed,
    recursionDepth,
    runMetrics,
    scopeNotice,
    reasoningText,
    showReasoning,
    setShowReasoning,
    sessionStats,
    selectedSessionId,
    // route
    displayedProvider,
    displayedModel,
    displayedRoute,
    // approvals
    pendingApproval,
    approvalError,
    approvalPending,
    approvalRetryDecision,
    handleApproval,
  };
}

export type SessionTurn = ReturnType<typeof useSessionTurn>;
