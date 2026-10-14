import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import {
  type JarvisSession, type JarvisMessage, type JarvisConfig,
  type AgentOption,
  type SessionMemorySelection,
  type ProjectStewardHandoff,
} from '../../domain/types';
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
  coerceMemoryRecallStatus,
  decodeMemoryStatusFrame,
  decodeMemoryTurnDiagnostic,
  decodeMemoryTurnPreparation,
  decodeNativeHistoryRows,
  formatMemoryTurnLabel,
  type MemoryRecallStatus,
  type MemoryTurnDiagnosticView,
} from '../../domain/memory-turn-state';
import {
  captureReceiptState,
  decodeCaptureReceipt,
  type CaptureReceipt,
  type CaptureStateView,
} from '../../domain/memory-capture-state';
import { decodeSessionContinuity, RESUME_OBJECTIVE_DIRECTIVE, type SessionContinuity } from '../../domain/memory-control-state';
import {
  activeRelayMemoryTurn,
  clearRelayMemoryTurn,
  isRegisteredRelayMemoryTurn,
} from '../../domain/relay-memory-correlation';
import {
  decideRunRecord,
  runRecordView,
  type RunRecordIntent,
  type RunRecordState,
  type SessionRunRead,
  type SessionRunWrite,
} from '../../domain/session-run-telemetry';
import type { MemorySourceMessage } from '../memory/MemoryTurnStatus';

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

/**
 * Decode the native `MemoryScope` read-back from `memory_bind_session_workspace`
 * or `jarvis_new_session`. A malformed/absent result is never treated as a
 * confirmed binding. Only the canonical native value is accepted; the UI never
 * fabricates `project_root`.
 */
function decodeBoundScope(value: unknown): { kind: string; agent_id: string; project_root: string | null } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== 'string' || typeof record.agent_id !== 'string') return null;
  if (record.project_root !== null && typeof record.project_root !== 'string') return null;
  return { kind: record.kind, agent_id: record.agent_id, project_root: record.project_root ?? null };
}

/**
 * Decode the `goal_get` readback into the selector/identity fields Project
 * Steward handoff validation needs. A malformed or absent result is never
 * treated as a match.
 */
interface GoalIdentity {
  id: string;
  objective: string;
  status: string;
  agent_id: string;
  project_root: string | null;
}

function decodeGoalIdentity(value: unknown): GoalIdentity | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const goalRaw = record.goal;
  if (typeof goalRaw !== 'object' || goalRaw === null || Array.isArray(goalRaw)) return null;
  const goal = goalRaw as Record<string, unknown>;
  if (typeof goal.id !== 'string' || typeof goal.objective !== 'string') return null;
  if (typeof goal.agent_id !== 'string') return null;
  if (goal.project_root !== null && typeof goal.project_root !== 'string') return null;
  return {
    id: goal.id,
    objective: goal.objective,
    status: typeof goal.status === 'string' ? goal.status : 'pending',
    agent_id: goal.agent_id,
    project_root: goal.project_root ?? null,
  };
}

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
  /**
   * Native-registered Goal run binding id for this turn, or null. This is a
   * correlation identity only: native verifies its own registration plus the
   * owned Bun child's consume receipt before associating a Goal. The UI never
   * supplies a Goal id as authority.
   */
  goalBindingId: string | null;
}

const recordTerminalRun = (payload: RunRecordPayload): Promise<SessionRunWrite> => {
  const base = {
    ...sessionInvokeArgs(payload.sessionId),
    runId: payload.runId,
    outcome: payload.outcome,
    selectedModel: payload.selectedModel,
    tokenCount: payload.tokenCount,
    toolCount: payload.toolCount,
    cancelledReason: payload.cancelledReason,
    partialOutput: payload.partialOutput,
  };
  // A Goal-linked turn uses the Goal-specific command so native can verify the
  // consumed binding receipt; an ordinary turn keeps the unchanged command.
  if (payload.goalBindingId) {
    return invoke('record_goal_terminal_run', {
      ...base,
      bindingId: payload.goalBindingId,
    }).then(
      () => ({ ok: true }) as SessionRunWrite,
      () => ({ ok: false }) as SessionRunWrite,
    );
  }
  return invoke('record_terminal_run', base).then(
    () => ({ ok: true }) as SessionRunWrite,
    () => ({ ok: false }) as SessionRunWrite,
  );
};

const readSessionRunsFor = async (sessionId: string): Promise<SessionRunRead> => {
  try {
    return { ok: true, value: await invoke<unknown>('get_session_runs', sessionInvokeArgs(sessionId)) };
  } catch {
    return { ok: false };
  }
};

const JARVIS_API_URL = 'http://127.0.0.1:19877';
const STREAM_INACTIVITY_TIMEOUT_MS = 90_000;
// Phase 2.4 — bound the UI's native memory finalization attempt (including the
// Tauri command wait and any native operation-gate backlog) so a stuck native
// task cannot postpone terminal publication indefinitely. Above the owned
// transport's own 1s connect / 3s total request bounds; on timeout the ordinary
// result is shown with a truthful pending notice. The finalizer is not retried.
const MEMORY_FINALIZE_TIMEOUT_MS = 5_000;

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


export const CURATED_SUGGESTIONS = ['Refine the previous answer', 'Walk me through the reasoning', 'Suggest next steps', 'Apply this to my code'];

interface SessionHistoryMessage { id: string; session_id: string; role: string; content: string; tokens: number; tool_calls: string | null; created_at: string; }

export interface SessionTurnProps {
  activeSession: string | null;
  setActiveSession: (id: string | null) => void;
  config: JarvisConfig | null;
  backendLabel: string;
  modelLabel: string;
  onSessionCreated: () => void;
  onRunRecordSettled?: (state: RunRecordState | null) => void;
  sessions?: JarvisSession[];
  onSessionsChanged?: () => void;
  projectStewardHandoff?: ProjectStewardHandoff | null;
  onProjectStewardHandoffApplied?: () => void;
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

export function useSessionTurn({ activeSession, setActiveSession, config, backendLabel, modelLabel, onSessionCreated, onRunRecordSettled, sessions = [], onSessionsChanged = () => {}, projectStewardHandoff = null, onProjectStewardHandoffApplied }: SessionTurnProps) {
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

  // Phase 2.4 — per-turn native memory diagnostics. The transient status comes
  // from `memory_status`/`memory_applied` SSE frames; the native diagnostic
  // read-back after terminal sync is the authority. No recalled text or
  // capability ever reaches the UI.
  const [memoryLiveStatus, setMemoryLiveStatus] = useState<MemoryRecallStatus | null>(null);
  const [memoryDiagnostic, setMemoryDiagnostic] = useState<MemoryTurnDiagnosticView | null>(null);
  const [memoryHistoryWarning, setMemoryHistoryWarning] = useState<string | null>(null);
  const [memoryFinalizationNotice, setMemoryFinalizationNotice] = useState<string | null>(null);
  // Phase 3.3 — honest capture status for the current turn. A `saved` state is
  // shown ONLY when a committed native receipt reports saved_count > 0; an
  // error/blocked-only receipt is `failed`. Assistant prose never acknowledges
  // a save.
  const [memoryCaptureState, setMemoryCaptureState] = useState<CaptureStateView | null>(null);
  // Phase 4.4 — full committed receipt and confirmed objective for the turn
  // status panel. The receipt is authoritative only when decoded and identity
  // checked; the objective comes only from a native continuity read.
  const [memoryReceipt, setMemoryReceipt] = useState<CaptureReceipt | null>(null);
  const [memoryContinuity, setMemoryContinuity] = useState<SessionContinuity | null>(null);
  const [memoryContinuityError, setMemoryContinuityError] = useState<string | null>(null);
  const [memoryContinuityPending, setMemoryContinuityPending] = useState(false);
  const [memoryTurnReadError, setMemoryTurnReadError] = useState<string | null>(null);
  // Monotonic token: every Session/turn read (and every Session/turn change)
  // bumps it so a late response from a previous identity is discarded.
  const memoryReadSeqRef = useRef(0);
  // Stable indirection so the finalizer/listener callbacks can request a
  // post-turn read without joining their dependency arrays.
  const refreshMemoryTurnRef = useRef<((sid: string, turnId: string | null) => void) | null>(null);
  // Exact pending explicit continuity operation, captured once at first
  // attempt. `key` is the logical target (Session id + source message id +
  // objective payload) and never includes the revision. An ambiguous set
  // (committed but the response was lost/rejected) keeps this tuple so an
  // unchanged-target retry replays the SAME operation id and expected revision,
  // even if a read-back refreshed the displayed revision. A changed
  // source/objective starts a new operation against the current authoritative
  // continuity. Cleared only on a confirmed decoded native set response.
  const continuityOperationRef = useRef<{
    key: string;
    request: {
      session_id: string;
      expected_revision: number;
      source_message_id: string;
      objective: string | null;
      operation_id: string;
    };
  } | null>(null);
  // Explicit per-turn user-wide opt-in. Default false; cleared whenever the
  // selected Session (and therefore Agent scope) changes so it can never carry
  // silently into a different Session/Agent.
  const [includeUserScope, setIncludeUserScope] = useState(false);
  // Phase 4.2 Session identity. The Agent applies to a Session created on the
  // next send; the project binding is applied to an existing Session through
  // the native command. Both are never inferred from user prose.
  const [sessionAgents, setSessionAgents] = useState<AgentOption[]>([]);
  const [pendingAgentId, setPendingAgentId] = useState('main');
  const [pendingProjectRoot, setPendingProjectRoot] = useState<string | null>(null);
  // A Session created for a first send whose workspace binding then failed.
  // It is reused on retry so a rejected bind never creates a second Session.
  const pendingNewSessionRef = useRef<string | null>(null);
  // Render-visible mirror of `pendingNewSessionRef`. It exists only so the
  // identity controls can lock the Agent selector while that created-but-
  // unbound Session is awaiting retry; the ref stays the value `handleSend`
  // reads. Cleared whenever the pending identity is consumed or abandoned.
  const [pendingNativeSessionId, setPendingNativeSessionId] = useState<string | null>(null);
  // Agent the pending native Session was actually created with, so a retry can
  // never reuse it on behalf of a different displayed Agent selection.
  const pendingNewSessionAgentRef = useRef('main');
  // The owning relay memory turn currently displayed. Used to drop stale
  // warnings/diagnostics when a different relay submission becomes active.
  const memoryOwnerRef = useRef<{ sessionId: string; turnId: string } | null>(null);
  // Phase 3.3 — relay-only aggregate of streamed answer text, held OUTSIDE
  // React state. It backs the legacy (no turn id / unregistered) idle relay
  // terminal persistence path: the native relay owns the append for registered
  // turns, but a legacy terminal must still durably persist its answer from an
  // explicit coordinator rather than from inside a `setMessages` updater.
  const relayAssistantAggregateRef = useRef('');
  // Monotonic conversation epoch. Bumped on every new submission and Session
  // change so an asynchronous legacy relay append can prove it still belongs to
  // the exact turn/session that started it and never rewrites a newer bubble.
  const conversationEpochRef = useRef(0);
  // Registered relay turns whose terminal has already been consumed. Late
  // memory-status/diagnostic/capture events for a settled `{session_id, turn_id}`
  // are rejected so they cannot repaint a finished turn. Bounded: cleared on the
  // owning submission/Session change; keys are only the live registration.
  const settledRelayOwnersRef = useRef<Set<string>>(new Set());

  // Phase 4.4 — one-shot native read of the confirmed objective plus, when a
  // turn identity is known (or the continuity names the latest turn), that
  // turn's authoritative diagnostic and committed capture receipt. Read-only:
  // it never performs capture or exposes recalled text. Every await re-checks a
  // monotonic token and the captured Session so a late response from a switched
  // Session/turn is discarded.
  const refreshMemoryTurn = useCallback(async (sid: string, turnId: string | null) => {
    const seq = ++memoryReadSeqRef.current;
    setMemoryContinuityPending(true);
    setMemoryContinuityError(null);
    setMemoryTurnReadError(null);
    let continuity: SessionContinuity | null = null;
    let continuityFailed = false;
    try {
      continuity = decodeSessionContinuity(await invoke('memory_continuity_read', {
        request: { session_id: sid },
      }));
    } catch {
      continuityFailed = true;
    }
    if (seq !== memoryReadSeqRef.current || !mountedRef.current || activeSessionRef.current !== sid) return;
    setMemoryContinuity(continuity);
    setMemoryContinuityError(continuityFailed ? 'Memory continuity unavailable for this Session.' : null);
    setMemoryContinuityPending(false);

    const readTurn = turnId ?? continuity?.latest_turn_id ?? null;
    if (!readTurn) return;
    let rawDiagnostic: unknown = null;
    let rawReceipt: unknown = null;
    let readFailed = false;
    try {
      rawDiagnostic = await invoke('memory_turn_diagnostic', {
        request: { session_id: sid, turn_id: readTurn },
      });
    } catch {
      readFailed = true;
    }
    try {
      rawReceipt = await invoke('memory_capture_receipts', {
        request: { session_id: sid, turn_id: readTurn },
      });
    } catch {
      readFailed = true;
    }
    if (seq !== memoryReadSeqRef.current || !mountedRef.current || activeSessionRef.current !== sid) return;
    if (readFailed) {
      setMemoryTurnReadError('Memory turn detail unavailable.');
      return;
    }
    try {
      const view = decodeMemoryTurnDiagnostic(rawDiagnostic);
      if (view.turnId === readTurn && view.sessionId === sid) setMemoryDiagnostic(view);
    } catch {
      setMemoryTurnReadError('Memory turn detail unavailable.');
    }
    // A null receipt means unavailable (no committed receipt read), never a
    // confirmed zero-save result. Only the full receipt is updated here: the
    // compact capture status/label is owned by the finalizer/relay handler so a
    // pending or failed capture signal is never clobbered by this read.
    const receipt = decodeCaptureReceipt(rawReceipt);
    if (receipt && receipt.turn_id === readTurn && receipt.session_id === sid) {
      setMemoryReceipt(receipt);
    } else {
      setMemoryReceipt(null);
    }
  }, []);

  useEffect(() => {
    refreshMemoryTurnRef.current = refreshMemoryTurn;
  }, [refreshMemoryTurn]);

  useEffect(() => {
    // A Session change invalidates the previous turn's memory surface and any
    // relay correlation: no old warning/diagnostic may survive it. It also
    // abandons any orphan pending-Session identity from a failed first bind.
    pendingNewSessionRef.current = null;
    pendingNewSessionAgentRef.current = 'main';
    setPendingNativeSessionId(null);
    setIncludeUserScope(false);
    setMemoryLiveStatus(null);
    setMemoryDiagnostic(null);
    setMemoryHistoryWarning(null);
    setMemoryFinalizationNotice(null);
    setMemoryCaptureState(null);
    setMemoryReceipt(null);
    setMemoryContinuity(null);
    setMemoryContinuityError(null);
    setMemoryContinuityPending(false);
    setMemoryTurnReadError(null);
    memoryOwnerRef.current = null;
    relayAssistantAggregateRef.current = '';
    settledRelayOwnersRef.current.clear();
    conversationEpochRef.current += 1;
    // Invalidate any in-flight read from the previous identity, then read the
    // reopened Session's confirmed objective/latest turn once.
    memoryReadSeqRef.current += 1;
    clearRelayMemoryTurn();
    if (activeSession) void refreshMemoryTurn(activeSession, null);
  }, [activeSession, refreshMemoryTurn]);

  // The user-wide opt-in is local to the selected Session/Agent and must never
  // carry silently across an Agent change. It also defaults off on mount and
  // after an app restart because it is never persisted.
  useEffect(() => {
    setIncludeUserScope(false);
  }, [pendingAgentId]);

  // Enabled native Agents for the New Session identity selector. A failed or
  // malformed read leaves the selector at the safe `main` default rather than
  // inventing an Agent.
  useEffect(() => {
    let cancelled = false;
    invoke<unknown>('list_agents')
      .then((rows) => {
        if (cancelled || !Array.isArray(rows)) return;
        const next: AgentOption[] = [];
        for (const row of rows) {
          if (typeof row !== 'object' || row === null) continue;
          const record = row as Record<string, unknown>;
          if (typeof record.id !== 'string' || typeof record.enabled !== 'boolean') continue;
          next.push({
            id: record.id,
            name: typeof record.name === 'string' ? record.name : undefined,
            enabled: record.enabled,
          });
        }
        setSessionAgents(next);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Roadmap Priority #2 Part 2 — Goal-linked chat. The selected Goal id is a
  // SUGGESTION to native only; native validates the Goal's Session/Agent/scope
  // binding and registers a bounded one-shot binding before the run. The UI
  // never infers scope from the Goal text and never fabricates a Goal link.
  const [goalOptions, setGoalOptions] = useState<Array<{ id: string; objective: string; status: string }>>([]);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  // The native binding id actually registered for the CURRENT turn, captured at
  // stream start. The terminal run record uses ONLY this value, so a Goal
  // selected mid-turn cannot be attributed to an earlier turn.
  const linkedGoalBindingIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<unknown>('goal_list')
      .then((rows) => {
        if (cancelled || !Array.isArray(rows)) return;
        const next: Array<{ id: string; objective: string; status: string }> = [];
        for (const row of rows) {
          if (typeof row !== 'object' || row === null) continue;
          const record = row as Record<string, unknown>;
          if (typeof record.id !== 'string' || typeof record.objective !== 'string') continue;
          const status = typeof record.status === 'string' ? record.status : 'pending';
          if (status === 'completed' || status === 'failed' || status === 'cancelled') continue;
          next.push({ id: record.id, objective: record.objective, status });
        }
        setGoalOptions(next);
        setSelectedGoalId((prev) => (prev && next.some((g) => g.id === prev) ? prev : null));
      })
      .catch(() => {});
    return () => { cancelled = true; };
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

  // Project Steward handoff application. JarvisView has already re-read and
  // validated the Session/Goal identity; here we select the exact Goal (ensuring
  // its option exists) and pre-fill the exact user task for the active Session.
  // The ordinary composer and explicit Send are unchanged — nothing is sent.
  useEffect(() => {
    if (!projectStewardHandoff) return;
    if (activeSession !== projectStewardHandoff.session_id) return;
    let cancelled = false;
    void (async () => {
      try {
        const raw = await invoke<unknown>('goal_get', { id: projectStewardHandoff.goal_id });
        const goal = decodeGoalIdentity(raw);
        if (!cancelled && goal && goal.id === projectStewardHandoff.goal_id) {
          setGoalOptions((prev) =>
            prev.some((option) => option.id === goal.id)
              ? prev
              : [...prev, { id: goal.id, objective: goal.objective, status: goal.status }],
          );
        }
      } catch {
        // The composer still receives the exact handoff task; the Goal id is
        // selected and native re-validates it before any run is linked.
      }
      if (cancelled) return;
      setSelectedGoalId(projectStewardHandoff.goal_id);
      setInput(projectStewardHandoff.task_draft, projectStewardHandoff.session_id);
      onProjectStewardHandoffApplied?.();
    })();
    return () => {
      cancelled = true;
    };
  }, [projectStewardHandoff, activeSession, setInput, onProjectStewardHandoffApplied]);

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

  const finalizeAssistantMessage = useCallback((_sid?: string, terminal?: DecodedStreamTerminal) => {
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
    setMessages(prev => {
      const withTokens = applyTokenChunk(prev, pending);
      const messageOutcome: StreamTerminalOutcome | undefined = terminal
        && terminal.outcome !== 'success'
        && terminal.outcome !== 'cancelled'
        ? terminal.outcome
        : undefined;
      return finalizeStreamingMessages(withTokens, messageOutcome, terminal?.code);
    });
    onSessionCreatedRef.current();
  }, [applyTokenChunk, clearPendingApproval, takePendingTokens]);

  // Reduced-motion respect — we use it to disable token fade-in / shimmer.
  const prefersReducedMotion = useRef(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    prefersReducedMotion.current = mq.matches;
    const handler = (e: MediaQueryListEvent) => { prefersReducedMotion.current = e.matches; };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

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
    const historyEpoch = conversationEpochRef.current;
    invoke<SessionHistoryMessage[]>('get_session_history', sessionInvokeArgs(activeSession))
      .then((rows) => {
        if (cancelled || historyEpoch !== conversationEpochRef.current) return;
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
      // Native-relay aggregate, independent of React state, for the legacy
      // no-turn-id terminal persistence path.
      relayAssistantAggregateRef.current += text;
      appendAssistantText(text);
    }));

    // A relay terminal event that carries a `turn_id` is memory-correlated and
    // must match the exact registered relay submission; otherwise a late
    // done/error from an old relay turn could finalize a newer direct turn.
    // Legacy events without a `turn_id` are accepted only while no direct
    // submission and no registered relay turn owns the Session. The
    // synchronous `sendInFlightRef` guard is required too, because `handleSend`
    // acquires it before awaiting initial Session creation (when
    // `streamAbortRef` is still null and no Session is selected yet), so a
    // legacy event could otherwise mutate a pending direct submission; idle
    // legacy behavior is preserved.
    const relayTerminalIsCorrelated = (sessionId: unknown, turnId: unknown): boolean => {
      if (turnId === undefined || turnId === null) {
        return activeRelayMemoryTurn() === null
          && streamAbortRef.current === null
          && !sendInFlightRef.current.isInFlight();
      }
      return isRegisteredRelayMemoryTurn(sessionId, turnId);
    };

    // Terminal-settlement guard. Once a registered relay terminal is consumed,
    // late memory-status/diagnostic/capture events for the same exact
    // `{session_id, turn_id}` are rejected so they cannot repaint a finished
    // turn. A capture event legitimately arrives BEFORE the terminal and is
    // accepted then frozen. Settlement is bounded: the only registered tuple is
    // the live submission, and the set is cleared on the owning submission /
    // Session change.
    const relayOwnerKey = (sid: string, turnId: string): string => `${sid}\u0000${turnId}`;
    const isRelayOwnerSettled = (sid: unknown, turnId: unknown): boolean => (
      typeof sid === 'string'
      && typeof turnId === 'string'
      && settledRelayOwnersRef.current.has(relayOwnerKey(sid, turnId))
    );
    const markRelayOwnerSettled = (sid: string, turnId: string): void => {
      const settled = settledRelayOwnersRef.current;
      if (settled.size > 32) settled.clear();
      settled.add(relayOwnerKey(sid, turnId));
    };

    // Transcript only: pin the native-owned assistant DB row id onto the local
    // visible bubble so a later history reload dedupes it. Never factual
    // verification.
    const reconcileRelayAssistantId = (sid: string, dbId: string | null): void => {
      if (!dbId || !mountedRef.current || !matchesStreamSession(sid)) return;
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant') {
          return [...prev.slice(0, -1), { ...last, id: dbId }];
        }
        return prev;
      });
    };

    // Legacy idle relay terminal (no turn id, unregistered): the UI still owns
    // the assistant append. The owner epoch + local assistant id are captured
    // BEFORE the await; a completion that lands after a Session/new-turn change
    // makes no UI writes, and the exact originating bubble is reconciled by its
    // stable local id. Registered turns are native-owned and never reach this.
    const persistLegacyRelayAssistant = (sid: string): void => {
      const aggregate = relayAssistantAggregateRef.current;
      relayAssistantAggregateRef.current = '';
      const content = sanitizeAssistantDisplay(aggregate).trim();
      if (!content || !sid) return;
      const ownerEpoch = conversationEpochRef.current;
      const localAssistantId = crypto.randomUUID();
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && !last.id) {
          return [...prev.slice(0, -1), { ...last, id: localAssistantId }];
        }
        return prev;
      });
      void invoke<string>('append_message', {
        ...sessionInvokeArgs(sid),
        role: 'assistant',
        content,
      }).then((dbId) => {
        if (conversationEpochRef.current !== ownerEpoch || !matchesStreamSession(sid)) return;
        if (typeof dbId === 'string' && dbId) {
          setMessages(prev => prev.map((m) => (
            m.id === localAssistantId ? { ...m, id: dbId } : m
          )));
        }
      }).catch((e: any) => {
        if (conversationEpochRef.current !== ownerEpoch || !matchesStreamSession(sid)) return;
        console.error('Failed to persist assistant message:', e);
        setError('Append failed: ' + (e?.message || String(e)));
      });
    };

    track(listen<{
      session_id: string;
      turn_id?: string;
      assistant_message_id?: unknown;
      native_owns_append?: unknown;
    }>('jarvis://done', (event) => {
      const p = event.payload;
      if (!matchesStreamSession(p.session_id)) return;
      if (!relayTerminalIsCorrelated(p.session_id, p.turn_id)) return;
      if (typeof p.turn_id === 'string') markRelayOwnerSettled(p.session_id, p.turn_id);
      dispatchActivity({ kind: 'terminal', outcome: 'success' });
      finalizeAssistantMessage(p.session_id);
      const dbId = typeof p.assistant_message_id === 'string' && p.assistant_message_id.length > 0
        ? p.assistant_message_id
        : null;
      const nativeOwned = p.native_owns_append === true
        || (typeof p.turn_id === 'string' && isRegisteredRelayMemoryTurn(p.session_id, p.turn_id));
      if (!nativeOwned && dbId === null) {
        persistLegacyRelayAssistant(p.session_id);
      } else {
        // Native owns the append (or already persisted): clear the relay
        // aggregate so it cannot leak into a later legacy terminal, and pin
        // the returned row id onto the local bubble. Never a UI duplicate.
        relayAssistantAggregateRef.current = '';
        reconcileRelayAssistantId(p.session_id, dbId);
      }
    }));

    // NOTE (Task 7 / 2026-07-03 incident 1d4727cf): this `jarvis_send_message`
    // / `jarvis://*` Tauri-event path is wired but not currently invoked by
    // the chat UI — `handleSend` uses the direct-fetch `streamFromJarvisApi`
    // path below instead, which has the primary error/cancelled handling.
    // Hardened here too for defense-in-depth in case something re-enables
    // this path. The Rust `SseFrameOutcome::Error` variant only carries a
    // message string, not a `code` (unlike the fetch path's raw JSON
    // frames) — reported as a gap below rather than changing Rust.
    track(listen<{
      error: string;
      session_id: string;
      code?: string;
      turn_id?: string;
      assistant_message_id?: unknown;
    }>('jarvis://error', (event) => {
      const p = event.payload;
      if (!matchesStreamSession(p.session_id)) return;
      if (!relayTerminalIsCorrelated(p.session_id, p.turn_id)) return;
      if (typeof p.turn_id === 'string') markRelayOwnerSettled(p.session_id, p.turn_id);
      const dbId = typeof p.assistant_message_id === 'string' && p.assistant_message_id.length > 0
        ? p.assistant_message_id
        : null;
      const pending = takePendingTokens();
      setIsStreaming(false);
      setPipelineStage('');
      dispatchActivity({ kind: 'terminal', outcome: 'failed' });
      setRecursionDepth(null);
      clearPendingApproval();
      setError(p.error);
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
            content: partial ? last.content : p.error,
            isStreaming: false,
            isError: true,
            errorCode: p.code,
          }];
        }
        return withTokens;
      });
      // A native-owned relay may have persisted the successful answer as an
      // unassociated row (source conflict); reconcile its id, never append.
      relayAssistantAggregateRef.current = '';
      reconcileRelayAssistantId(p.session_id, dbId);
    }));

    // Rust's SseRelay maps a `cancelled` SSE frame straight to `jarvis://done`
    // (see runner.rs `SseFrameOutcome::Cancelled`) — there is no distinct
    // `jarvis://cancelled` Tauri event today, so this listener is a no-op
    // registration for forward-compatibility / documentation of the gap
    // rather than dead code masking a real handler. If a future Rust change
    // adds a genuine `jarvis://cancelled` emit, this starts working without
    // further UI changes.
    track(listen<{ session_id: string; turn_id?: string }>('jarvis://cancelled', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      if (!relayTerminalIsCorrelated(event.payload.session_id, event.payload.turn_id)) return;
      if (typeof event.payload.turn_id === 'string') {
        markRelayOwnerSettled(event.payload.session_id, event.payload.turn_id);
      }
      relayAssistantAggregateRef.current = '';
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

    // Phase 2.4 — relay memory metadata. Accepted ONLY for the exact
    // `{session_id, turn_id}` registered by the owning submission before it
    // invoked the relay (see `relay-memory-correlation`). Events cannot
    // establish their own identity, so a delayed older relay event can never
    // bind or overwrite a newer turn. Metadata only; durable counts come from
    // the native diagnostic projection. Typed warning codes are surfaced
    // visibly and persist until the next submission/Session change.
    const applyRelayWarning = (code: unknown): void => {
      if (code === 'history_unavailable') {
        setMemoryHistoryWarning('Relay memory history unavailable for this turn.');
      } else if (code === 'memory_finalization_failed') {
        setMemoryFinalizationNotice('Relay memory finalization failed; showing the ordinary result.');
      } else if (code === 'memory_finalization_pending') {
        setMemoryFinalizationNotice('Relay memory finalization is pending; showing the ordinary result.');
      }
    };
    // Bind the owning relay submission. On a different owner, drop the previous
    // turn's warning/diagnostic so nothing stale survives a submission change.
    const bindRelayMemoryOwner = (sid: string, turnId: string): void => {
      const owner = memoryOwnerRef.current;
      if (owner && owner.sessionId === sid && owner.turnId === turnId) return;
      setMemoryDiagnostic(null);
      setMemoryHistoryWarning(null);
      setMemoryFinalizationNotice(null);
      setMemoryCaptureState(null);
      memoryOwnerRef.current = { sessionId: sid, turnId };
    };
    track(listen<{
      session_id?: string;
      turn_id?: string;
      status?: unknown;
      selected_ids?: unknown;
      store_revision?: unknown;
      code?: unknown;
    }>('jarvis://memory-status', (event) => {
      const p = event.payload;
      if (!matchesStreamSession(p.session_id)) return;
      if (!isRegisteredRelayMemoryTurn(p.session_id, p.turn_id)) return;
      if (isRelayOwnerSettled(p.session_id, p.turn_id)) return;
      bindRelayMemoryOwner(p.session_id as string, p.turn_id as string);
      applyRelayWarning(p.code);
      const decoded = decodeMemoryStatusFrame(p);
      if (decoded) setMemoryLiveStatus(decoded.status);
    }));
    track(listen<Record<string, unknown> & { session_id?: string; turn_id?: string }>(
      'jarvis://memory-diagnostic',
      (event) => {
        const p = event.payload;
        if (!matchesStreamSession(p.session_id)) return;
        if (!isRegisteredRelayMemoryTurn(p.session_id, p.turn_id)) return;
        if (isRelayOwnerSettled(p.session_id, p.turn_id)) return;
        bindRelayMemoryOwner(p.session_id as string, p.turn_id as string);
        try {
          const view = decodeMemoryTurnDiagnostic(p);
          if (view.turnId === p.turn_id && view.sessionId === p.session_id) {
            setMemoryDiagnostic(view);
          }
        } catch (e) {
          console.warn('[Jarvis] relay memory diagnostic was malformed:', e);
        }
      },
    ));
    // Phase 3.3 — honest relay capture status. A committed receipt is decoded
    // and projected with `captureReceiptState`; a metadata-only error code is
    // `failed` unless it is the bounded `capture_pending` timeout, which stays
    // pending. A committed receipt survives a separated sync/append failure.
    // Assistant prose never acknowledges a save.
    track(listen<{
      session_id?: string;
      turn_id?: string;
      receipt?: unknown;
      error_code?: unknown;
      sync_failed?: unknown;
      append_failed?: unknown;
    }>(
      'jarvis://memory-capture',
      (event) => {
        const p = event.payload;
        if (!matchesStreamSession(p.session_id)) return;
        if (!isRegisteredRelayMemoryTurn(p.session_id, p.turn_id)) return;
        if (isRelayOwnerSettled(p.session_id, p.turn_id)) return;
        bindRelayMemoryOwner(p.session_id as string, p.turn_id as string);
        // Decode and bind the receipt to the exact correlation tuple; a missing
        // or mismatched receipt must never become Saved.
        const decoded = decodeCaptureReceipt(p.receipt);
        const receipt = decoded
          && decoded.turn_id === p.turn_id
          && decoded.session_id === p.session_id
          ? decoded
          : null;
        const errorCode = typeof p.error_code === 'string' ? p.error_code : null;
        setMemoryCaptureState(captureReceiptState(receipt, errorCode));
        setMemoryReceipt(receipt);
        // Read the authoritative full diagnostic/objective for this exact relay
        // turn (read-only; the relay event itself is metadata only).
        if (typeof p.session_id === 'string' && typeof p.turn_id === 'string') {
          refreshMemoryTurnRef.current?.(p.session_id, p.turn_id);
        }
        // Native reports sync/append failures independently from capture; they
        // never fail a committed receipt but stay observable.
        if (p.sync_failed === true) {
          setMemoryFinalizationNotice('Relay memory sync unavailable; showing the ordinary result.');
        } else if (p.append_failed === true) {
          setMemoryFinalizationNotice('Relay assistant transcript not saved; showing the ordinary result.');
        }
      },
    ));

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
    const t = setTimeout(() => {
      if (!pendingApprovalRef.current && (document.activeElement === document.body || document.activeElement === inputRef.current)) inputRef.current?.focus();
    }, 50);
    return () => clearTimeout(t);
  }, [activeSession]);

  const streamFromJarvisApi = useCallback(async (
    sid: string,
    userMsg: string,
    sendGeneration: number,
    onAccepted: () => void,
    clientMessageId: string,
    assistantClientMessageId: string,
    includeUserScope: boolean,
    goalId: string | null,
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

    // Submission guard: Session/generation/controller ownership PLUS an
    // explicit abort/Stop. Used after each awaited setup operation and before
    // starting inference, so a Stop during append/prepare/history cannot race
    // `/chat/cancel` and then still launch a fetch. The display guard
    // (`requestIsCurrent`) is intentionally separate so a legitimate
    // cancellation terminal can still render for the current turn.
    const submissionAlive = () => (
      requestIsCurrent() && !controller.signal.aborted && !stopRequestedRef.current
    );
    const stopIfStale = () => {
      if (submissionAlive()) return;
      if (!controller.signal.aborted) controller.abort('Stale Session turn');
      throw new DOMException('Stale Session turn', 'AbortError');
    };

    // One stable turn identity for this submitted turn, held across every
    // frame and the terminal native sync. It is distinct from the opaque
    // native preparation id returned by `memory_prepare_turn`.
    const turnId = crypto.randomUUID();
    setMemoryLiveStatus(null);
    setMemoryDiagnostic(null);
    setMemoryHistoryWarning(null);
    setMemoryFinalizationNotice(null);
    setMemoryCaptureState(null);

    let userMessageId: string | null = null;
    let inactivityTimedOut = false;
    let terminal: DecodedStreamTerminal | null = null;

    // The final assistant text this direct turn should persist, and whether the
    // observed terminal permits persistence. Updated by the terminal frame
    // handlers below the finalizer's definition, so the finalizer reads the
    // latest values from this mutable holder. The appended DB id is returned as
    // worker data (never written to React state from the worker).
    const assistantPersist: { text: string; allowed: boolean; done: boolean } = {
      text: '',
      allowed: false,
      done: false,
    };

    // One memoized finalization per local turn, shared by every exit path.
    // Direct UI owns the direct assistant append; the whole sequential
    // append -> sync -> capture attempt shares ONE 5-second race. The worker
    // returns DATA ONLY — it never calls setState or emits. The single winner
    // is published once after the race under the original Session/generation/
    // controller tuple, and the tuple is marked settled so a late worker result
    // (or a timeout) can never repaint. Capture is attempted from the persisted
    // immutable user turn even when append or sync fails, and a committed saved
    // receipt stays Saved even when sync failed.
    let finalizePromise: Promise<boolean> | null = null;
    let finalizeSettled = false;
    const finalizeMemoryTurn = (): Promise<boolean> => {
      if (finalizePromise) return finalizePromise;
      finalizePromise = (async (): Promise<boolean> => {
        if (!userMessageId) return true;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
          timeoutHandle = setTimeout(() => resolve({ kind: 'timeout' }), MEMORY_FINALIZE_TIMEOUT_MS);
        });

        // 1. Direct assistant append, awaited first, with the original turn id.
        // Runs only when the observed terminal permits persistence and nonempty
        // sanitized text exists. 2. Sync. 3. Capture. Each step is independently
        // caught so a failed append or sync still dispatches capture from the
        // immutable saved user source.
        const worker = (async (): Promise<{
          kind: 'settled';
          diagnostic: unknown;
          receipt: unknown;
          appendDbId: string | null;
          appendFailed: boolean;
          syncFailed: boolean;
          captureFailed: boolean;
        }> => {
          let appendDbId: string | null = null;
          let appendFailed = false;
          if (assistantPersist.allowed && !assistantPersist.done) {
            assistantPersist.done = true;
            const text = sanitizeAssistantDisplay(assistantPersist.text).trim();
            if (text) {
              try {
                const dbId = await invoke<string>('append_message', {
                  ...sessionInvokeArgs(sid),
                  role: 'assistant',
                  content: text,
                  memory_turn_id: turnId,
                  memoryTurnId: turnId,
                });
                appendDbId = typeof dbId === 'string' && dbId ? dbId : null;
              } catch (e) {
                appendFailed = true;
                console.error('Failed to persist assistant message:', e);
              }
            }
          }

          let diagnostic: unknown = null;
          let syncFailed = false;
          try {
            diagnostic = await invoke<unknown>('memory_sync_turn', {
              request: { session_id: sid, turn_id: turnId },
            });
          } catch {
            syncFailed = true;
          }

          let receipt: unknown = null;
          let captureFailed = false;
          try {
            receipt = await invoke<unknown>('memory_capture_turn', {
              request: { session_id: sid, turn_id: turnId },
            });
          } catch (e) {
            captureFailed = true;
            console.warn('[Jarvis] memory capture failed:', e);
          }
          return {
            kind: 'settled',
            diagnostic,
            receipt,
            appendDbId,
            appendFailed,
            syncFailed,
            captureFailed,
          };
        })();

        const outcome = await Promise.race([worker, timeout]);
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        if (finalizeSettled) return false;
        finalizeSettled = true;

        if (outcome.kind === 'timeout') {
          if (requestIsCurrent()) {
            setMemoryCaptureState(captureReceiptState(null, 'capture_pending'));
            setMemoryFinalizationNotice('Memory finalization is pending; showing the ordinary result.');
          }
          return false;
        }

        // Publish the one winner under the original tuple checks. A late worker
        // result after a timeout or Session switch is discarded here.
        if (!requestIsCurrent()) return false;

        // Reconcile the actual persisted assistant DB id onto the exact
        // originating local assistant bubble. Only this timely winner reaches
        // here, and only under the original Session/generation/controller guard;
        // a late timeout worker's legitimate DB append is never repainted, and a
        // new turn/Session bubble is never rewritten.
        if (outcome.appendDbId && assistantClientMessageId) {
          const persistedId = outcome.appendDbId;
          setMessages(prev => prev.map((m) => (
            m.id === assistantClientMessageId ? { ...m, id: persistedId } : m
          )));
        }

        // Receipt: decoded and projected independently of sync/append. It must
        // match the immutable original {session_id, turn_id}; a missing or
        // mismatched receipt is not Saved.
        let receipt: CaptureReceipt | null = null;
        if (!outcome.captureFailed) {
          const decoded = decodeCaptureReceipt(outcome.receipt);
          if (decoded && decoded.turn_id === turnId && decoded.session_id === sid) {
            receipt = decoded;
          }
        }
        setMemoryCaptureState(captureReceiptState(receipt, receipt === null ? 'capture_unavailable' : null));
        setMemoryReceipt(receipt);

        // Diagnostic: decoded separately and identity-checked. A sync failure
        // is observable metadata and never fails a committed capture receipt.
        let diagnosticOk = false;
        if (!outcome.syncFailed) {
          try {
            const view = decodeMemoryTurnDiagnostic(outcome.diagnostic);
            if (view.turnId === turnId && view.sessionId === sid) {
              setMemoryDiagnostic(view);
              diagnosticOk = true;
            }
          } catch (e) {
            console.warn('[Jarvis] memory diagnostic read-back failed:', e);
          }
        }
        if (!diagnosticOk) {
          setMemoryFinalizationNotice(
            outcome.syncFailed
              ? 'Memory sync unavailable; showing the ordinary result.'
              : 'Memory status unavailable for this turn.',
          );
        } else if (outcome.appendFailed) {
          setMemoryFinalizationNotice('Assistant transcript not saved; showing the ordinary result.');
        }
        // Read the confirmed objective for this exact Session/turn. This is a
        // read-only native refresh; it never captures or mutates state.
        refreshMemoryTurnRef.current?.(sid, turnId);
        return diagnosticOk;
      })();
      return finalizePromise;
    };

    // ── Persisted-turn lifecycle ──────────────────────────────────────────
    // A saved source row is a precondition for any inference. The complete
    // append→prepare→history→fetch→read lifecycle is wrapped so a saved turn is
    // finalized exactly once even on setup/HTTP/body/EOF/abort failure.
    try {
      // 1. Persist the user row FIRST. Native preparation must reference the
      // exact persisted row id, never the optimistic UI id. `append_message`
      // returns the DB row id (sessions.rs `insert_message_row`); swapping the
      // client-generated id for it lets a later history-reload dedupe this as
      // the SAME message instance (2026-07-03 incident 1d4727cf).
      try {
        const dbId = await invoke<string>('append_message', {
          ...sessionInvokeArgs(sid),
          role: 'user',
          content: userMsg,
        });
        if (typeof dbId !== 'string' || !dbId) {
          throw new Error('the server did not return a saved message id');
        }
        userMessageId = dbId;
        if (requestIsCurrent()) {
          setMessages(prev => prev.map((m) => (m.id === clientMessageId ? { ...m, id: dbId } : m)));
        }
      } catch (e: any) {
        stopIfStale();
        console.error('Failed to persist user message:', e);
        // No saved row -> no inference. Throw a truthful persistence failure to
        // the existing draft-recovery path; never claim the optimistic bubble
        // is saved.
        throw new Error('Could not save your message: ' + (e?.message || String(e)));
      }

      // 2. Prepare native recall and load native prompt history. References
      // only; no memory text crosses the webview. A failed preparation still
      // runs ordinary inference with a typed status and no preparation
      // reference. A failed/unreadable history read sends empty prior history
      // with a visible warning rather than a stale UI cache.
      //
      // NB: there is deliberately NO stale guard between the saved user append
      // and `memory_prepare_turn`. Even after a Session switch/abort, the newly
      // saved immutable user source must be prepared/bound so the bounded
      // finalizer can capture it with the ORIGINAL turn identity. The stale
      // guard after preparation stops before history/fetch, so no inference is
      // launched for a stale submission.
      let memoryPreparationId: string | null = null;
      let initialMemoryStatus: MemoryRecallStatus = 'unavailable';
      let history: Array<{ role: string; content: string }> = [];
      try {
        const prepared = decodeMemoryTurnPreparation(await invoke('memory_prepare_turn', {
          request: {
            session_id: sid,
            turn_id: turnId,
            user_message_id: userMessageId,
            include_user_scope: includeUserScope,
          },
        }));
        if (prepared.turn_id !== turnId) {
          throw new Error('memory preparation identity mismatch');
        }
        initialMemoryStatus = prepared.status;
        memoryPreparationId = prepared.preparation_id;
      } catch (e) {
        console.warn('[Jarvis] memory preparation failed:', e);
        initialMemoryStatus = coerceMemoryRecallStatus(e);
        memoryPreparationId = null;
      }
      stopIfStale();
      try {
        const nativeHistory = await invoke<unknown>(
          'memory_turn_history',
          { request: { session_id: sid, user_message_id: userMessageId } },
        );
        const rows = decodeNativeHistoryRows(nativeHistory);
        if (rows) {
          history = rows;
        } else if (requestIsCurrent()) {
          setMemoryHistoryWarning('Memory history was unreadable; sending this turn without prior context.');
        }
      } catch (e) {
        console.warn('[Jarvis] native memory history failed:', e);
        if (requestIsCurrent()) setMemoryHistoryWarning('Memory history unavailable for this turn.');
      }
      stopIfStale();

      // Roadmap Priority #2 Part 2 — Goal linkage. Native validates the
      // selected Goal's Session/Agent/canonical-project binding, loads the
      // exact saved user source row already used by `memory_prepare_turn`
      // (`userMessageId`), and registers a bounded one-shot binding for this
      // exact turn. This is INDEPENDENT of memory preparation: a Goal-linked run
      // proceeds even when memory is unavailable. A rejected/unsupported Goal is
      // not silently downgraded — the turn runs goal-less and the UI drops the
      // selection. The UI never supplies a Goal id or hash as authority, and
      // only the returned native binding id is later used for the terminal
      // proof.
      linkedGoalBindingIdRef.current = null;
      if (goalId && userMessageId) {
        try {
          const preparation = await invoke<{
            goal_id?: string;
            turn_id?: string;
            registered?: boolean;
            binding_id?: string;
          }>('goal_prepare_run', {
            goalId,
            sessionId: sid,
            turnId,
            sourceMessageId: userMessageId,
          });
          if (
            preparation
            && preparation.registered === true
            && preparation.goal_id === goalId
            && preparation.turn_id === turnId
            && typeof preparation.binding_id === 'string'
            && preparation.binding_id.length > 0
          ) {
            linkedGoalBindingIdRef.current = preparation.binding_id;
          } else if (requestIsCurrent()) {
            setSelectedGoalId((prev) => (prev === goalId ? null : prev));
          }
        } catch {
          if (requestIsCurrent()) {
            setSelectedGoalId((prev) => (prev === goalId ? null : prev));
          }
        }
      }
      stopIfStale();

      const response = await fetch(`${JARVIS_API_URL}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMsg,
          session_id: sid,
          history,
          turn_id: turnId,
          memory_status: initialMemoryStatus,
          ...(memoryPreparationId ? { memory_preparation_id: memoryPreparationId } : {}),
          // Exact persisted user source row already bound by
          // `goal_prepare_run`, carried only for a registered Goal turn so the
          // server can match it against the native binding. Identity only; the
          // server never treats it as authority and ordinary turns omit it.
          ...(linkedGoalBindingIdRef.current && userMessageId
            ? { source_message_id: userMessageId }
            : {}),
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
      stopIfStale();
      onAccepted();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamedVisibleText = false;
    let streamedRawText = '';
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
        goalBindingId: linkedGoalBindingIdRef.current,
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

    const handleFrame = async (frame: any): Promise<void> => {
      if (!requestIsCurrent()) return;
      if (!frame || typeof frame !== 'object') return;
      // Phase 2.4 — transient memory diagnostics. Never authority: the native
      // diagnostic read-back after terminal sync is. Stale turn/Session frames
      // are ignored so a late completion cannot repaint another turn.
      if (frame.type === 'memory_status') {
        const decoded = decodeMemoryStatusFrame(frame);
        if (!decoded || decoded.turn_id !== turnId) return;
        setMemoryLiveStatus(decoded.status);
        return;
      }
      if (frame.type === 'memory_applied') {
        // Metadata only. Applied IDs shown to the operator come from the
        // native diagnostic, never from an unsigned SSE frame.
        return;
      }
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
        if (terminalFrame !== null) return;
        const decision = decodeResultFrame(frame);
        // Record the direct assistant text this turn may persist (and whether
        // the terminal permits it) BEFORE the bounded finalizer runs. A
        // non-success hard error persists nothing.
        assistantPersist.text = streamedRawText;
        assistantPersist.allowed = !decision.hardError;
        if (!streamedVisibleText && decision.text && !decision.hardError) {
          // The orchestrator aggregate never streamed as deltas: hold it as the
          // turn's assistant text in the same accumulator used for persistence.
          streamedRawText += decision.text;
          assistantPersist.text = streamedRawText;
          appendAssistantText(decision.text);
        }
        // Phase 2.4 — finalize the native turn before any local terminal
        // publication (activity, outcome, run-record write). Re-check current
        // ownership after the await so a Session switch during the bounded wait
        // cannot repaint another Session.
        await finalizeMemoryTurn();
        if (!requestIsCurrent()) return;
        if (!acceptTerminal(decision)) return;
        dispatchActivity({ kind: 'terminal', outcome: decision.outcome });
        activityTerminalDispatched = true;
        if (decision.hardError) {
          const message = decision.text || String(frame.error || 'Jarvis returned a non-success result.');
          throw new JarvisStreamError(message, decision.code);
        }
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
        await finalizeMemoryTurn();
        if (!requestIsCurrent()) return;
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
        await finalizeMemoryTurn();
        if (!requestIsCurrent()) return;
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
              await handleFrame(frame);
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
        // Finalize before the EOF/abort terminal publication and run write.
        await finalizeMemoryTurn();
        if (!requestIsCurrent()) return;
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
      // Phase 2.4 — finalize the native turn BEFORE any local terminal
      // publication or run-record write. This is memoized, so terminal-frame
      // branches that already finalized are a no-op here.
      await finalizeMemoryTurn();
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
    } finally {
      // Safety net for setup/HTTP/body failures that occur before the read
      // loop starts. The same memoized finalizer runs, so a saved turn is
      // finalized exactly once on every exit path, including stale/aborted
      // submissions.
      await finalizeMemoryTurn();
    }
    if (inactivityTimedOut) {
      throw new Error(`Jarvis stream was inactive for ${STREAM_INACTIVITY_TIMEOUT_MS / 1000} seconds.`);
    }

    if (requestIsCurrent()) finalizeAssistantMessage(sid, terminal ?? undefined);
    if (streamAbortRef.current === controller) streamAbortRef.current = null;
  }, [appendAssistantText, applyTokenChunk, clearPendingApproval, dispatchActivity, finalizeAssistantMessage, matchesStreamSession, presentApprovalRequest, takePendingTokens]);

  // Phase 4.2 — bind a canonical workspace through the native command and
  // confirm the native read-back. A rejected/malformed result is never a
  // confirmed binding. The native canonicalizer owns path validation; the UI
  // never parses workspace scope from user prose or grant chips.
  const bindWorkspaceForSession = useCallback(async (sid: string, root: string): Promise<boolean> => {
    try {
      const scope = await invoke<unknown>('memory_bind_session_workspace', {
        request: { session_id: sid, workspace_root: root },
      });
      const decoded = decodeBoundScope(scope);
      return decoded !== null && decoded.kind === 'project' && typeof decoded.project_root === 'string' && decoded.project_root.length > 0;
    } catch {
      return false;
    }
  }, []);

  const handleSelectAgent = useCallback((agentId: string) => {
    // Agent selection applies to a future Session only; an existing Session's
    // Agent ownership is immutable. While a created-but-unbound Session is
    // pending retry its Agent is fixed: honoring a change here would let the
    // retry reuse a native Session owned by a different Agent. The visible
    // control is locked in this state; this guard is the authoritative block.
    if (pendingNewSessionRef.current) return;
    setPendingAgentId(agentId);
    setIncludeUserScope(false);
  }, []);

  const handleBindWorkspace = useCallback(async (root: string | null) => {
    const sid = activeSession;
    if (!sid) {
      // Pending New Session: hold the choice; it is applied on first send.
      setPendingProjectRoot(root);
      return;
    }
    if (isStreaming) return;
    try {
      const scope = await invoke<unknown>('memory_bind_session_workspace', {
        request: { session_id: sid, workspace_root: root },
      });
      const decoded = decodeBoundScope(scope);
      const expectedKind = root === null ? 'agent' : 'project';
      if (!decoded || decoded.kind !== expectedKind) {
        throw new Error('invalid binding read-back');
      }
      onSessionsChanged();
    } catch {
      setError('Could not update the Session workspace binding. The previous binding is unchanged.');
    }
  }, [activeSession, isStreaming, onSessionsChanged]);

  // Phase 4.4 — explicit objective set/clear. A new operation is validated
  // natively against the exact persisted user source, the expected continuity
  // revision, and the exact substring rule; success is confirmed only from the
  // decoded native `SessionContinuity` response for the captured Session. On a
  // lost or rejected set response the mutation is ambiguous — it may have
  // committed — so the UI does a read-only current-state refresh and keeps the
  // exact original request tuple so an unchanged-target retry replays the same
  // operation id and expected revision (native replay is idempotent).
  const handleSetObjective = useCallback(async (input: {
    source_message_id: string;
    objective: string | null;
  }) => {
    const sid = activeSession;
    if (!sid || isStreaming) return;
    const continuity = memoryContinuity;
    if (!continuity || continuity.session_id !== sid) {
      setMemoryContinuityError('Objective state unavailable.');
      return;
    }
    // Reuse the captured tuple ONLY for the unchanged logical target. A changed
    // source/objective (or Session) starts a new operation whose expected
    // revision is the current authoritative continuity revision.
    const targetKey = JSON.stringify([sid, input.source_message_id, input.objective]);
    let request = continuityOperationRef.current?.key === targetKey
      ? continuityOperationRef.current.request
      : null;
    if (!request) {
      request = {
        session_id: sid,
        expected_revision: continuity.revision,
        source_message_id: input.source_message_id,
        objective: input.objective,
        operation_id: crypto.randomUUID(),
      };
      continuityOperationRef.current = { key: targetKey, request };
    }
    const seq = ++memoryReadSeqRef.current;
    setMemoryContinuityPending(true);
    setMemoryContinuityError(null);
    try {
      const raw = await invoke<unknown>('memory_continuity_set', { request });
      const decoded = decodeSessionContinuity(raw);
      if (decoded.session_id !== sid) throw new Error('continuity identity mismatch');
      if (seq !== memoryReadSeqRef.current || !mountedRef.current || activeSessionRef.current !== sid) return;
      setMemoryContinuity(decoded);
      setMemoryContinuityError(null);
      setMemoryContinuityPending(false);
      continuityOperationRef.current = null;
    } catch {
      if (seq !== memoryReadSeqRef.current || !mountedRef.current || activeSessionRef.current !== sid) return;
      // Ambiguous: a native commit may have landed before the response was
      // lost/rejected. Refresh the CURRENT continuity for the captured Session
      // as a display-only read; a continuity read carries no operation identity,
      // so it never confirms this operation. The exact pending request tuple is
      // retained for an unchanged-target retry.
      let refreshed: SessionContinuity | null = null;
      try {
        refreshed = decodeSessionContinuity(await invoke('memory_continuity_read', {
          request: { session_id: sid },
        }));
      } catch {
        refreshed = null;
      }
      if (seq !== memoryReadSeqRef.current || !mountedRef.current || activeSessionRef.current !== sid) return;
      if (refreshed && refreshed.session_id === sid) setMemoryContinuity(refreshed);
      setMemoryContinuityError(
        'Could not confirm the active objective update — it may or may not have been saved. Retry to replay this exact request, or change the source/objective to start a new one.',
      );
      setMemoryContinuityPending(false);
    }
  }, [activeSession, isStreaming, memoryContinuity]);

  const handleSend = useCallback(async (overrideText?: unknown) => {
    // Phase 4.4 — Resume passes the exact continuation directive as an explicit
    // override; every other caller passes no argument (a DOM event is ignored).
    // An override never clears or restores the operator's own composer draft.
    const override = typeof overrideText === 'string' && overrideText.trim().length > 0
      ? overrideText.trim()
      : null;
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
    const userMsg = override ?? submittedDraft.text.trim();
    if (!userMsg || isStreaming) {
      sendInFlightRef.current.finish();
      return;
    }
    const sendGeneration = sendGateRef.current.tryAcquire();
    if (sendGeneration === null) {
      sendInFlightRef.current.finish();
      return;
    }
    stopRequestedRef.current = false;
    discardPendingTokens();
    setError(null);
    // Phase 2.4 — clear the previous turn's memory surface. The native history
    // is read inside `streamFromJarvisApi`, never from the UI cache.
    setMemoryLiveStatus(null);
    setMemoryDiagnostic(null);
    setMemoryHistoryWarning(null);
    setMemoryFinalizationNotice(null);
    setMemoryCaptureState(null);
    setMemoryReceipt(null);
    setMemoryContinuity(null);
    setMemoryContinuityError(null);
    setMemoryContinuityPending(false);
    setMemoryTurnReadError(null);
    // Invalidate any in-flight read from a previous turn/identity.
    memoryReadSeqRef.current += 1;
    // A new submission invalidates any prior relay correlation so a late relay
    // event from a previous turn cannot bind to this one.
    clearRelayMemoryTurn();
    relayAssistantAggregateRef.current = '';
    settledRelayOwnersRef.current.clear();
    conversationEpochRef.current += 1;
    memoryOwnerRef.current = null;
    linkedGoalBindingIdRef.current = null;
    // Consume the per-turn user-wide opt-in: this turn snapshots the explicit
    // choice, then the control resets to the Session default (false) so it can
    // never silently carry across an Agent change within the same Session.
    const includeUserScopeForTurn = includeUserScope;
    setIncludeUserScope(false);
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
    // Stable local identity for the optimistic assistant bubble. The direct
    // finalizer reconciles the actual persisted DB id onto exactly this id.
    const assistantClientMessageId = crypto.randomUUID();
    setMessages(prev => [
      ...prev,
      { id: clientMessageId, role: 'user', content: userMsg },
      { id: assistantClientMessageId, role: 'assistant', content: '', isStreaming: true },
    ]);

    let effectiveSessionId = activeSession || sessionId;
    try {
      if (!effectiveSessionId) {
        // Create the native Session once. A Session whose workspace bind then
        // fails is reused on retry rather than re-created.
        const selectedAgentId = pendingAgentId && pendingAgentId !== 'main' ? pendingAgentId : 'main';
        let newSessionId = pendingNewSessionRef.current;
        if (newSessionId && pendingNewSessionAgentRef.current !== selectedAgentId) {
          // The pending native Session was created for a different Agent than
          // the displayed selection. Never reuse it for the wrong Agent:
          // abandon the orphan identity so a fresh Session is created below.
          newSessionId = null;
          pendingNewSessionRef.current = null;
          setPendingNativeSessionId(null);
        }
        if (!newSessionId) {
          const newSession = await invoke<JarvisSession>('jarvis_new_session', {
            name: userMsg.slice(0, 60),
            ...(selectedAgentId !== 'main' ? { agentId: selectedAgentId } : {}),
          });
          newSessionId = newSession.id;
          pendingNewSessionRef.current = newSession.id;
          pendingNewSessionAgentRef.current = selectedAgentId;
          setPendingNativeSessionId(newSession.id);
          onSessionCreated();
        }
        if (!mountedRef.current || !sendGateRef.current.isCurrent(sendGeneration)) return;
        if (!newSessionId) {
          throw new Error('Could not create a Session for this message.');
        }
        // A selected project must bind BEFORE the user row is appended and
        // before preparation/fetch. A binding failure preserves the draft and
        // never launches inference.
        if (pendingProjectRoot) {
          const bound = await bindWorkspaceForSession(newSessionId, pendingProjectRoot);
          if (!bound) {
            if (mountedRef.current && sendGateRef.current.isCurrent(sendGeneration)) {
              setIsStreaming(false);
              setError('Could not bind the selected workspace to the new Session. The Session was created but no message was sent; choose a valid absolute directory and retry.');
              setMessages(prev => prev.filter(m => m.id !== clientMessageId && m.id !== assistantClientMessageId));
              if (!override) {
                publishDraftStore(restoreFailedSessionDraft(draftStoreRef.current, submittedDraft));
              }
            }
            return;
          }
        }
        effectiveSessionId = newSessionId;
        // Suppress the history-load effect that setActiveSession is about to
        // trigger — otherwise it overwrites the optimistic messages above with
        // the empty history of this brand-new session.
        suppressHistoryLoadRef.current = newSessionId;
        setSessionId(newSessionId);
        sessionIdRef.current = newSessionId;
        activeSessionRef.current = newSessionId;
        setActiveSession(newSessionId);
        pendingNewSessionRef.current = null;
        pendingNewSessionAgentRef.current = 'main';
        setPendingNativeSessionId(null);
        onSessionsChanged();
      }

      const goalForTurn = selectedGoalId;
      await streamFromJarvisApi(effectiveSessionId, userMsg, sendGeneration, () => {
        if (!override) {
          publishDraftStore(clearSubmittedSessionDraft(draftStoreRef.current, submittedDraft));
        }
      }, clientMessageId, assistantClientMessageId, includeUserScopeForTurn, goalForTurn);
    } catch (e) {
      if (!mountedRef.current) return;
      if (!sendGateRef.current.isCurrent(sendGeneration)) {
        if (!override) {
          publishDraftStore(restoreFailedSessionDraft(draftStoreRef.current, submittedDraft));
        }
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
       if (!override) {
         publishDraftStore(restoreFailedSessionDraft(draftStoreRef.current, submittedDraft));
       }
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
  }, [isStreaming, messages, activeSession, sessionId, onSessionCreated, onSessionsChanged, setActiveSession, clearRunRecord, streamFromJarvisApi, discardPendingTokens, takePendingTokens, applyTokenChunk, publishDraftStore, resetActivityLedger, includeUserScope, pendingAgentId, pendingProjectRoot, selectedGoalId, bindWorkspaceForSession]);

  // Phase 4.4 — Resume is an explicit control that sends the exact native
  // resume directive through the ordinary turn transport. It never fabricates
  // an objective and never touches the operator's own composer draft.
  const handleResumeObjective = useCallback(() => {
    if (
      isStreaming
      || !activeSession
      || !memoryContinuity
      || memoryContinuity.session_id !== activeSession
      || !memoryContinuity.active_objective
    ) return;
    void handleSend(RESUME_OBJECTIVE_DIRECTIVE);
  }, [isStreaming, activeSession, memoryContinuity, handleSend]);

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
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
    // Explicit abandon path for a created-but-unbound Session: clearing the
    // pending identity here (while `activeSession` may already be null, so the
    // Session-change effect cannot fire) releases the Agent lock so the next
    // New Session may choose a different Agent.
    pendingNewSessionRef.current = null;
    pendingNewSessionAgentRef.current = 'main';
    setPendingNativeSessionId(null);
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
  // Concrete, honest memory-turn status. Counts come only from the native
  // diagnostic; while the turn is live a transient status may be shown without
  // counts.
  const memoryStatusLabel = formatMemoryTurnLabel(memoryLiveStatus, memoryDiagnostic);

  // Phase 4.2 Session memory identity. For an existing Session the Agent and
  // binding come from the persisted native row; a New Session uses the local
  // pending selection until first send creates and binds the native Session.
  const currentSession = activeSession
    ? sessions.find((session) => session.id === activeSession) ?? null
    : null;
  const sessionSelection: SessionMemorySelection = {
    session_id: activeSession,
    agent_id: currentSession?.agent_id ?? (pendingAgentId || 'main'),
    project_root: currentSession ? currentSession.project_root ?? null : pendingProjectRoot,
    include_user_scope: includeUserScope,
  };

  // Phase 4.4 — persisted user rows only (real DB ids), used solely as an
  // explicit objective source for the native setter; never a fabricated id.
  const persistedUserMessages = useMemo<MemorySourceMessage[]>(
    () => messages
      .filter((message) => message.role === 'user' && typeof message.id === 'string' && message.id.length > 0)
      .map((message) => ({ id: message.id as string, content: message.content })),
    [messages],
  );
  // Guard against the single render frame after a Session switch where the
  // passive reset effect has not yet run: never pair a new Session id with a
  // previous Session's turn snapshot, receipt, or objective.
  const memoryDiagnosticForSession =
    activeSession && memoryDiagnostic && memoryDiagnostic.sessionId === activeSession
      ? memoryDiagnostic
      : null;
  const memoryReceiptForSession =
    activeSession && memoryReceipt && memoryReceipt.session_id === activeSession
      ? memoryReceipt
      : null;
  const memoryContinuityForSession =
    activeSession && memoryContinuity && memoryContinuity.session_id === activeSession
      ? memoryContinuity
      : null;
  const memoryTurnId =
    memoryDiagnosticForSession?.turnId
    ?? memoryReceiptForSession?.turn_id
    ?? memoryContinuityForSession?.latest_turn_id
    ?? null;

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
    sessionSelection, sessionAgents, pendingNativeSessionId,
    handleSelectAgent, handleBindWorkspace, setIncludeUserScope,
    goalOptions, selectedGoalId, setSelectedGoalId,
    memoryStatusLabel, memoryCaptureState, memoryHistoryWarning, memoryFinalizationNotice,
    memoryDiagnosticForSession, memoryReceiptForSession, memoryContinuityForSession,
    memoryContinuityError, memoryContinuityPending, memoryTurnReadError, memoryTurnId,
    persistedUserMessages, refreshMemoryTurn, handleSetObjective, handleResumeObjective,
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
