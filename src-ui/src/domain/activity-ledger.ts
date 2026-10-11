import type { ToolCallState } from './chat-state';
import type { ToolResultTruncationMetadata } from './sse-protocol';

export const ACTIVITY_TEXT_LIMIT = 240;
export const ACTIVITY_MAX_ITEMS = 80;

const STAGE_NAMES = new Set(['planner', 'executor', 'reviewer', 'rewriter', 'synthesizer']);
const TERMINAL_STAGE_STATUSES = new Set(['completed', 'done', 'failed', 'timed_out', 'cancelled', 'partial']);

export type ConductorDirectiveType =
  | 'continue'
  | 'abort_stage'
  | 'reroute'
  | 'inject_context'
  | 'mark_verified'
  | 'escalate_reviewer'
  | 'start_repair_chain'
  | 'block_item';

export type ActivityTerminalOutcome = 'success' | 'partial' | 'failed' | 'timed_out' | 'cancelled' | 'incomplete';
export type ActivityToolTerminalState = 'completed' | 'failed' | 'cancelled' | 'incomplete';

export interface ConductorDirectiveView {
  type: ConductorDirectiveType;
  label: string;
  detail: string;
  stage?: string;
}

export type ActivityToolCall = ToolCallState & { terminalState?: ActivityToolTerminalState };

export type ActivityItem =
  | { kind: 'stage'; id: string; stage: string }
  | { kind: 'plan'; id: string; stage: string; text: string }
  | { kind: 'tool'; id: string; call: ActivityToolCall }
  | {
      kind: 'tool_result';
      id: string;
      callId?: string;
      name: string;
      output: string;
      isError: boolean;
      contextTruncation?: ToolResultTruncationMetadata;
    }
  | { kind: 'directive'; id: string; stage?: string; directive: ConductorDirectiveView }
  | { kind: 'diagnostic'; id: string; text: string };

export type DirectiveDecodeResult =
  | { kind: 'valid'; key: string; directive: ConductorDirectiveView }
  | { kind: 'ignored'; reason: 'session_mismatch' }
  | { kind: 'invalid'; reason: 'malformed'; message: string };

export type ActivityLedgerEvent =
  | { kind: 'stage'; stage: unknown; status?: unknown; detail?: unknown; elapsedMs?: unknown }
  | { kind: 'agent_activity'; stage: unknown; text: unknown }
  | { kind: 'live_stage'; stage: unknown }
  | { kind: 'tool_use'; callId?: unknown; name: unknown; arguments: unknown }
  | {
      kind: 'tool_result';
      callId?: unknown;
      name: unknown;
      output: unknown;
      isError: unknown;
      contextTruncation?: ToolResultTruncationMetadata;
    }
  | { kind: 'directive'; key: string; directive: ConductorDirectiveView; stage?: string }
  | { kind: 'diagnostic'; text: unknown }
  | { kind: 'terminal'; outcome: ActivityTerminalOutcome };

export interface ActivityLedgerState {
  items: ActivityItem[];
  pipelineStage: string;
  seenDirectiveKeys: string[];
  terminalOutcome?: ActivityTerminalOutcome;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.replace(/\s+/g, ' ').trim().slice(0, ACTIVITY_TEXT_LIMIT);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stageName(value: unknown): value is string {
  return typeof value === 'string' && STAGE_NAMES.has(value);
}

function stageList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(stageName);
}

function invalidDirective(): DirectiveDecodeResult {
  return {
    kind: 'invalid',
    reason: 'malformed',
    message: 'Conductor directive was malformed or unsupported.',
  };
}

function directiveKey(directive: ConductorDirectiveView, frameStage?: string): string {
  return JSON.stringify([
    frameStage ?? '',
    directive.type,
    directive.label,
    directive.detail,
  ]);
}

function view(
  type: ConductorDirectiveType,
  label: string,
  detail: string,
  stage?: string,
): ConductorDirectiveView {
  return {
    type,
    label: text(label),
    detail: text(detail),
    ...(stage ? { stage } : {}),
  };
}

export function decodeConductorDirectiveFrame(
  frame: unknown,
  expectedSessionId?: string,
): DirectiveDecodeResult {
  if (!isRecord(frame) || frame.type !== 'conductor_directive') return invalidDirective();
  if (typeof frame.session_id !== 'string' || !frame.session_id.trim()) return invalidDirective();
  if (expectedSessionId !== undefined && frame.session_id !== expectedSessionId) {
    return { kind: 'ignored', reason: 'session_mismatch' };
  }
  if (!stageName(frame.stage)) return invalidDirective();
  const frameStage = frame.stage;
  if (!isRecord(frame.directive)) return invalidDirective();
  const input = frame.directive;
  const type = input.type;
  let directive: ConductorDirectiveView | null = null;

  if (type === 'continue') {
    directive = view('continue', 'Continue', 'No stage change requested.', frameStage);
  } else if (type === 'abort_stage' && stageName(input.stage) && nonEmpty(input.reason)) {
    directive = view('abort_stage', `Abort ${input.stage}`, input.reason, frameStage);
  } else if (type === 'reroute' && stageList(input.newRemaining) && nonEmpty(input.reason)) {
    const next = input.newRemaining.join(' → ') || 'no stages';
    directive = view('reroute', 'Reroute', `${next} · ${input.reason}`, frameStage);
  } else if (type === 'inject_context' && stageName(input.forStage) && nonEmpty(input.note) && nonEmpty(input.reason)) {
    directive = view('inject_context', `Context injected for ${input.forStage}`, input.reason, frameStage);
  } else if (
    type === 'mark_verified'
    && nonEmpty(input.itemId)
    && nonEmpty(input.evidenceRef)
    && isRecord(input.grounding)
    && ['conductor_direct_diff', 'reviewer_mediated', 'runtime_check'].includes(String(input.gradingMode))
    && nonEmpty(input.reason)
  ) {
    const evidenceSummary = text(input.evidenceSummary, 'verification recorded');
    directive = view('mark_verified', `Mark verified ${text(input.itemId)}`, `${String(input.gradingMode)} · ${evidenceSummary}`, frameStage);
  } else if (
    type === 'escalate_reviewer'
    && nonEmpty(input.reason)
    && (input.itemId === undefined || nonEmpty(input.itemId))
    && (input.newRemaining === undefined || stageList(input.newRemaining))
  ) {
    const target = nonEmpty(input.itemId) ? ` ${text(input.itemId)}` : '';
    directive = view('escalate_reviewer', `Escalate${target} to reviewer`, input.reason, frameStage);
  } else if (
    type === 'start_repair_chain'
    && nonEmpty(input.reason)
    && stageList(input.newRemaining)
    && (input.itemId === undefined || nonEmpty(input.itemId))
    && (input.flaggedIssues === undefined || nonEmpty(input.flaggedIssues))
  ) {
    const item = nonEmpty(input.itemId) ? ` ${text(input.itemId)}` : '';
    directive = view('start_repair_chain', `Start repair chain${item}`, input.reason, frameStage);
  } else if (type === 'block_item' && nonEmpty(input.itemId) && nonEmpty(input.reason)) {
    directive = view('block_item', `Block ${text(input.itemId)}`, input.reason, frameStage);
  }

  if (!directive) return invalidDirective();
  return { kind: 'valid', key: directiveKey(directive, frameStage), directive };
}

export function createActivityLedger(): ActivityLedgerState {
  return {
    items: [],
    pipelineStage: '',
    seenDirectiveKeys: [],
  };
}

function appendBounded(items: ActivityItem[], item: ActivityItem): ActivityItem[] {
  return [...items, item].slice(-ACTIVITY_MAX_ITEMS);
}

function appendPlan(
  state: ActivityLedgerState,
  stage: string,
  value: string,
): ActivityLedgerState {
  const normalizedStage = text(stage, 'agent') || 'agent';
  const normalizedText = text(value);
  if (!normalizedText) return state;
  const id = `plan-${state.items.length}-${normalizedStage}-${normalizedText}`;
  if (state.items.some((item) => item.kind === 'plan' && item.id === id)) return state;
  return { ...state, items: appendBounded(state.items, { kind: 'plan', id, stage: normalizedStage, text: normalizedText }) };
}

function toolId(state: ActivityLedgerState, callId: unknown, name: string): string {
  return nonEmpty(callId) ? `tool-${callId}` : `tool-${state.items.length}-${name}`;
}

function updateToolResult(
  state: ActivityLedgerState,
  callId: unknown,
  name: string,
  output: string,
  isError: boolean,
  contextTruncation: ToolResultTruncationMetadata | undefined,
): ActivityLedgerState {
  let index = -1;
  if (nonEmpty(callId)) {
    index = state.items.findIndex((item) => item.kind === 'tool'
      && item.call.call_id === callId
      && item.call.result === undefined);
  } else {
    const reverseIndex = [...state.items].reverse().findIndex((item) => item.kind === 'tool'
      && item.call.name === name
      && item.call.result === undefined);
    if (reverseIndex >= 0) index = state.items.length - 1 - reverseIndex;
  }

  const nextItems = [...state.items];
  if (index >= 0) {
    const item = nextItems[index];
    if (item.kind === 'tool') {
      nextItems[index] = {
        ...item,
        call: {
          ...item.call,
          result: output,
          is_error: isError,
          matched: true,
          contextTruncation,
          terminalState: isError ? 'failed' : 'completed',
        },
      };
    }
  } else {
    nextItems.push({
      kind: 'tool',
      id: toolId(state, callId, name),
      call: {
        call_id: nonEmpty(callId) ? callId : undefined,
        name,
        arguments: null,
        result: output,
        is_error: isError,
        matched: false,
        contextTruncation,
        terminalState: isError ? 'failed' : 'completed',
      },
    });
  }

  nextItems.push({
    kind: 'tool_result',
    id: `tool-result-${state.items.length}-${nonEmpty(callId) ? callId : name}`,
    callId: nonEmpty(callId) ? callId : undefined,
    name,
    output,
    isError,
    contextTruncation,
  });
  return { ...state, items: nextItems.slice(-ACTIVITY_MAX_ITEMS) };
}

function closeOpenTools(state: ActivityLedgerState, outcome: ActivityTerminalOutcome): ActivityLedgerState {
  const closure: Record<ActivityTerminalOutcome, { text: string; terminalState: ActivityToolTerminalState; isError: boolean }> = {
    success: { text: 'Turn ended before this tool returned.', terminalState: 'incomplete', isError: true },
    partial: { text: 'Turn ended partially before this tool returned.', terminalState: 'incomplete', isError: true },
    failed: { text: 'Turn failed before this tool returned.', terminalState: 'failed', isError: true },
    timed_out: { text: 'Turn timed out before this tool returned.', terminalState: 'incomplete', isError: true },
    cancelled: { text: 'Turn cancelled before this tool returned.', terminalState: 'cancelled', isError: false },
    incomplete: { text: 'Turn ended before this tool returned.', terminalState: 'incomplete', isError: true },
  };
  const close = closure[outcome];
  return {
    ...state,
    terminalOutcome: outcome,
    pipelineStage: '',
    items: state.items.map((item) => {
      if (item.kind !== 'tool' || item.call.result !== undefined) return item;
      return {
        ...item,
        call: {
          ...item.call,
          result: close.text,
          is_error: close.isError,
          matched: true,
          terminalState: close.terminalState,
        },
      };
    }),
  };
}

export function reduceActivityLedger(
  state: ActivityLedgerState,
  event: ActivityLedgerEvent,
): ActivityLedgerState {
  if (event.kind === 'terminal') return closeOpenTools(state, event.outcome);

  if (event.kind === 'directive') {
    if (state.seenDirectiveKeys.includes(event.key)) return state;
    return {
      ...state,
      seenDirectiveKeys: [...state.seenDirectiveKeys, event.key].slice(-ACTIVITY_MAX_ITEMS),
      items: appendBounded(state.items, {
        kind: 'directive',
        id: `directive-${state.items.length}-${event.key}`,
        stage: event.stage,
        directive: event.directive,
      }),
    };
  }

  if (event.kind === 'diagnostic') {
    const value = text(event.text, 'Conductor directive could not be decoded.');
    if (state.items.some((item) => item.kind === 'diagnostic' && item.text === value)) return state;
    return {
      ...state,
      items: appendBounded(state.items, { kind: 'diagnostic', id: `diagnostic-${state.items.length}`, text: value }),
    };
  }

  if (event.kind === 'stage') {
    const stage = text(event.stage, 'agent') || 'agent';
    const status = text(event.status).toLowerCase();
    const terminal = TERMINAL_STAGE_STATUSES.has(status);
    const detail = text(event.detail);
    const elapsed = Number(event.elapsedMs);
    const progress = detail.startsWith('tool:')
      ? `used ${detail.slice(5)}`
      : terminal
        ? `${status}${Number.isFinite(elapsed) ? ` in ${(elapsed / 1000).toFixed(1)}s` : ''}`
        : 'started';
    const withPlan = appendPlan({ ...state, pipelineStage: terminal ? '' : stage }, stage, progress);
    return withPlan;
  }

  if (event.kind === 'agent_activity') {
    return appendPlan(state, text(event.stage, 'agent'), text(event.text));
  }

  if (event.kind === 'live_stage') {
    const stage = text(event.stage);
    return state.pipelineStage === stage ? state : { ...state, pipelineStage: stage };
  }

  if (event.kind === 'tool_use') {
    const name = text(event.name, 'tool') || 'tool';
    const callId = nonEmpty(event.callId) ? event.callId : undefined;
    if (callId && state.items.some((item) => item.kind === 'tool' && item.call.call_id === callId)) return state;
    return {
      ...state,
      items: appendBounded(state.items, {
        kind: 'tool',
        id: toolId(state, callId, name),
        call: { call_id: callId, name, arguments: event.arguments },
      }),
    };
  }

  return updateToolResult(
    state,
    event.callId,
    text(event.name, 'tool') || 'tool',
    text(event.output),
    Boolean(event.isError),
    event.contextTruncation,
  );
}

export function activityLedgerItems(state: ActivityLedgerState): ActivityItem[] {
  const live = text(state.pipelineStage);
  if (!live || state.items.some((item) => (
    (item.kind === 'plan' || item.kind === 'stage') && text(item.stage).toLowerCase() === live.toLowerCase()
  ))) return state.items;
  const liveItem: ActivityItem = { kind: 'stage', id: `stage-live-${live.toLowerCase()}`, stage: live };
  return [...state.items, liveItem].slice(-ACTIVITY_MAX_ITEMS);
}
